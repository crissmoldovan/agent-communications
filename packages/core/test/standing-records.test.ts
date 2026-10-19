import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { APPROVAL_LIFETIMES, type BindingFields, bindingDigestOf } from '../src/approval-binding.ts';
import { CHANGE_POLICY_TIGHTENED_REASON, OWNER_REMOVED_REASON, SEND_EPOCH_REASON } from '../src/approval-outcome.ts';
import { asV2 } from '../src/approval-stored.ts';
import { validateV2 } from '../src/approval-validate.ts';
import type { ApprovalRecord, ApprovalStore, Expectation } from '../src/approvals.ts';
import { type AccountConfig, standingEpochOf } from '../src/config.ts';
import { openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { applySendPolicyChange, sendEpochOf } from '../src/send-epoch.ts';
import {
  checkedContents,
  checkedLimits,
  type ExactPlace,
  raiseStandingEpoch,
  type StandingBinding,
  standingDigest,
} from '../src/standing.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * The standing record and its one-shot children (design 2026-10-19-standing-approvals, S8, S9): a record of its own
 * kind, approved only with the code typed at a terminal whatever the change policy, lasting the days its limits say;
 * and each use a child send, approved when it is made, bound to its standing approval and both epochs, claimed once.
 */

const ACME = 'acc_AAAAAAAAAAAAAAAA';
const DAY = 86_400_000;
const ROOM: ExactPlace = {
  id: 'C0ROOM',
  name: 'support',
  members: 12,
  shared: { extShared: false, pendingExtShared: false, externalMembers: false },
};

function binding(
  over: Partial<StandingBinding> = {},
  limits: Parameters<typeof checkedLimits>[0] = {},
): StandingBinding {
  const { contents, warnings } = checkedContents({ reactions: ['eyes', 'memo'], replies: ['Got it, I will look'] });
  return {
    summary: 'acknowledge in #support',
    target: { kind: 'account', name: 'acme/slack', id: ACME },
    contents,
    places: { kind: 'exact', places: [ROOM] },
    limits: checkedLimits(limits),
    proposedBy: 'agent',
    warnings,
    ...over,
  };
}

/** A version-3 machine whose Slack account `acme/slack` posts under `sendPolicy`, every change policy `chat`. */
function machine(options: { sendPolicy?: 'chat' | 'confirm' | 'never'; now?: () => Date } = {}) {
  const home = tempDir('comms-standing-');
  const config = liveConfig(home, {
    accounts: { 'acme/slack': { id: ACME, sendPolicy: options.sendPolicy ?? 'chat' } },
  });
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: config.dir, AGENT_COMMS_UPDATE_CHECK: 'off' };
  const core = openCore({ env, caller: CORE_CALLER, ...(options.now === undefined ? {} : { now: options.now }) });
  return { home, config, core };
}

type Core = ReturnType<typeof openCore>;

/** A standing record prepared now, with the epochs the configuration holds. */
async function prepared(core: Core, over: Partial<StandingBinding> = {}, limits = {}): Promise<ApprovalRecord> {
  const config = await core.config.load();
  return core.approvals.createStanding({
    binding: binding(over, limits),
    inboxSub: 'U_ME',
    sendEpoch: sendEpochOf(config, ACME),
    standingEpoch: standingEpochOf(config),
  });
}

/** The person types the code at a terminal. */
async function approvedAtTerminal(core: Core, record: ApprovalRecord): Promise<ApprovalRecord> {
  const code = await core.approvals.issueChallenge(record.approvalId, 'standing');
  const live = { draftMessageId: record.contentDigest, contentDigest: record.contentDigest };
  return core.approvals.approve(record.approvalId, 'terminal', live, code, 'standing');
}

const EXPECT: Expectation = { to: ['C0ROOM'], cc: [], bcc: [], subject: ':eyes: on 1760000000.000100' };

/** One use's child, minted directly from an approved standing record. */
async function child(core: Core, standing: ApprovalRecord, over: { standingEpoch?: number } = {}) {
  const config = await core.config.load();
  return core.approvals.createStandingChild({
    standingId: standing.approvalId,
    standingEpoch: over.standingEpoch ?? (standing.standingEpoch as number),
    inboxId: ACME,
    inboxSub: 'U_ME',
    draftId: 'reaction:C0ROOM:1760000000.000100',
    draftMessageId: 'd'.repeat(64),
    contentDigest: 'd'.repeat(64),
    sendEpoch: sendEpochOf(config, ACME),
    riskFlags: ['AS_AGENT', 'REACTS_AS_APP'],
    expect: EXPECT,
  });
}

/** What a claim of the child presents: the fields it was minted with. */
function liveOf(record: ApprovalRecord) {
  return {
    inboxId: ACME,
    inboxSub: 'U_ME',
    draftMessageId: record.draftMessageId,
    contentDigest: record.contentDigest,
    expect: EXPECT,
  };
}

const refusedWith = (code: string, reason?: RegExp) => (error: unknown) => {
  assert.ok(error instanceof CommsError, String(error));
  assert.equal(error.code, code, error.message);
  if (reason !== undefined) assert.match(error.message, reason);
  return true;
};

test('a standing record is confirm under a chat change policy', async () => {
  const { core } = machine();
  assert.equal((await core.config.load()).defaults.changePolicy ?? 'chat', 'chat');
  const record = await prepared(core);
  assert.equal(record.kind, 'standing');
  assert.equal(record.channel, 'slack');
  assert.equal(record.state, 'pending');
  assert.equal(record.route, 'confirm');
  assert.equal(record.requiredPolicy, 'confirm');
  assert.equal(record.pendingMs, APPROVAL_LIFETIMES.confirm);
  assert.equal(record.approvedMs, 7 * DAY);
  assert.equal(record.inboxId, ACME);
  assert.equal(record.contentDigest, standingDigest(record.standing as StandingBinding));
  assert.equal(record.sendEpoch, 0);
  assert.equal(record.standingEpoch, 0);
  assert.equal(record.standingId, undefined, 'only a child names a standing approval');
  // Nothing claims one, and nothing waits to be claimed: it is used only through its children.
  const { outcome } = await core.approvals.inspect(record.approvalId);
  assert.equal(outcome.claimable, false);
  assert.equal(outcome.approval.kind, 'standing');
});

test('a binding the store cannot vouch for is refused before anything is written', async () => {
  const { core } = machine();
  const config = await core.config.load();
  const base = { inboxSub: 'U_ME', sendEpoch: sendEpochOf(config, ACME), standingEpoch: standingEpochOf(config) };
  const custom = binding();
  custom.contents = [{ kind: 'reaction', text: 'partyparrot', digest: 'a'.repeat(64) }];
  const tooLong = binding({}, {});
  tooLong.limits = { ...tooLong.limits, expiresDays: 31 };
  const notAccount = binding({ target: { kind: 'account', name: 'acme/slack', id: 'ibx_AAAAAAAAAAAAAAAA' } });
  const noPlace = binding({ places: { kind: 'exact', places: [] } });
  for (const bad of [custom, tooLong, notAccount, noPlace]) {
    await assert.rejects(core.approvals.createStanding({ ...base, binding: bad }), refusedWith('BAD_DATA'));
  }
  assert.deepEqual(await core.approvals.list(), []);
});

test('approved with elicitation it is void, and approved at the terminal it lasts its days', async () => {
  const { core } = machine();
  const viaForm = await prepared(core);
  const code = await core.approvals.issueChallenge(viaForm.approvalId, 'standing');
  const live = { draftMessageId: viaForm.contentDigest, contentDigest: viaForm.contentDigest };
  await assert.rejects(
    core.approvals.approve(viaForm.approvalId, 'elicitation', live, code, 'standing'),
    refusedWith('APPROVAL_VOID', /not approved at a terminal/),
  );
  assert.equal(asV2(await core.approvals.get(viaForm.approvalId))?.state, 'revoked');

  const atTerminal = await approvedAtTerminal(core, await prepared(core, {}, { expiresDays: 12 }));
  assert.equal(atTerminal.state, 'approved');
  assert.equal(atTerminal.approvedVia, 'terminal');
  assert.equal(Date.parse(atTerminal.usableUntil as string) - Date.parse(atTerminal.approvedAt as string), 12 * DAY);
  assert.equal(atTerminal.approvedBindingDigest, atTerminal.bindingDigest);

  // A wrong code three times voids it, as any approval's.
  const guessed = await prepared(core);
  await core.approvals.issueChallenge(guessed.approvalId, 'standing');
  const guessLive = { draftMessageId: guessed.contentDigest, contentDigest: guessed.contentDigest };
  for (const attempt of [1, 2, 3]) {
    await assert.rejects(
      core.approvals.approve(guessed.approvalId, 'terminal', guessLive, 'zzzz', 'standing'),
      refusedWith(attempt < 3 ? 'APPROVAL_REQUIRED' : 'APPROVAL_VOID'),
    );
  }
});

test('an approval of another kind, or a claim of any, does not reach a standing record', async () => {
  const { core } = machine();
  const record = await prepared(core);
  const live = { draftMessageId: record.contentDigest, contentDigest: record.contentDigest };
  // Under the chat change policy a change is claimed on a yes in the chat; a standing record is never one.
  await assert.rejects(
    core.approvals.claimForChange(record.approvalId, {
      change: { summary: 's', target: null, loosened: [], effects: [] },
      policy: 'chat',
    }),
    refusedWith('NOT_FOUND'),
  );
  await assert.rejects(core.approvals.issueChallenge(record.approvalId, 'change'), refusedWith('NOT_FOUND'));
  await assert.rejects(
    core.approvals.approve(record.approvalId, 'terminal', live, 'x', 'send'),
    refusedWith('NOT_FOUND'),
  );
  await assert.rejects(
    core.approvals.claimForSend(record.approvalId, { ...live, inboxId: ACME, inboxSub: 'U_ME', expect: EXPECT }),
    refusedWith('NOT_FOUND'),
  );
  assert.equal(asV2(await core.approvals.get(record.approvalId))?.state, 'pending');
});

/** `record` as stored, changed by `edit` and sealed again: its binding recomputed, as a careful forger would. */
function resealed(store: ApprovalStore, record: ApprovalRecord, edit: (raw: Record<string, unknown>) => void) {
  const path = join(store.directory, `${record.approvalId}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  edit(raw);
  const bindingDigest = bindingDigestOf(raw as unknown as BindingFields);
  const sealed = {
    ...raw,
    bindingDigest,
    ...(raw.approvedBindingDigest === undefined ? {} : { approvedBindingDigest: bindingDigest }),
  };
  return validateV2(sealed as unknown as ApprovalRecord, record.approvalId);
}

test('a 30-day standing record passes validation, and one with any other lifetime fails it', async () => {
  const { core } = machine();
  const record = await approvedAtTerminal(core, await prepared(core, {}, { expiresDays: 30 }));
  assert.equal(record.approvedMs, 30 * DAY);
  assert.deepEqual(validateV2(record, record.approvalId), { ok: true });
  assert.deepEqual(
    resealed(core.approvals, record, () => {}),
    { ok: true },
    'sealing it again changes nothing',
  );

  const lifetime = { ok: false, reason: 'lifetime-mismatch', attribution: 'verified' };
  const withApprovedMs = (ms: number) => (raw: Record<string, unknown>) => {
    raw.approvedMs = ms;
    raw.usableUntil = new Date(Date.parse(raw.approvedAt as string) + ms).toISOString();
  };
  assert.deepEqual(resealed(core.approvals, record, withApprovedMs(29 * DAY)), lifetime, 'not its expiry');
  assert.deepEqual(resealed(core.approvals, record, withApprovedMs(31 * DAY)), lifetime, 'longer than 30 days');
  assert.deepEqual(resealed(core.approvals, record, withApprovedMs(30 * DAY + 1)), lifetime, 'not whole days');
  assert.deepEqual(resealed(core.approvals, record, withApprovedMs(APPROVAL_LIFETIMES.approved)), lifetime);
  for (const route of ['chat', 'standing', undefined]) {
    assert.deepEqual(
      resealed(core.approvals, record, (raw) => {
        raw.route = route;
      }),
      lifetime,
      `route ${route}`,
    );
  }
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.pendingMs = APPROVAL_LIFETIMES.chat;
      raw.expiresAt = new Date(Date.parse(raw.createdAt as string) + APPROVAL_LIFETIMES.chat).toISOString();
    }),
    lifetime,
    'pending on the chat route',
  );
  // Approved any way but at a terminal is evidence no standing record may carry.
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.approvedVia = 'elicitation';
    }),
    { ok: false, reason: 'evidence-invalid', attribution: 'verified' },
  );
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.approvedVia = 'standing';
    }),
    { ok: false, reason: 'evidence-invalid', attribution: 'verified' },
  );
  // Its epochs are whole numbers of 0 or more, both of them.
  for (const [field, value] of [
    ['standingEpoch', undefined],
    ['standingEpoch', -1],
    ['sendEpoch', undefined],
    ['standingEpoch', 1.5],
  ] as const) {
    assert.deepEqual(
      resealed(core.approvals, record, (raw) => {
        raw[field] = value;
      }),
      { ok: false, reason: 'identity-contradiction', attribution: 'verified' },
      `${field} ${value}`,
    );
  }
  // A narrowing it holds narrows; one that would widen it is not one it can hold.
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.narrowed = { limits: { perThread: 1 } };
    }),
    { ok: true },
  );
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.narrowed = { limits: { perHour: 30 } };
    }),
    { ok: false, reason: 'narrowing-invalid', attribution: 'verified' },
  );
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.narrowed = { keep: ['f'.repeat(64)] };
    }),
    { ok: false, reason: 'narrowing-invalid', attribution: 'verified' },
  );
});

test("a child's lifetime is its own, and it is never pending", async () => {
  const { core } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  const minted = await child(core, standing);
  assert.deepEqual(validateV2(minted, minted.approvalId), { ok: true });
  assert.equal(minted.pendingMs, APPROVAL_LIFETIMES.standingChild);
  assert.equal(minted.approvedMs, APPROVAL_LIFETIMES.standingChild);
  assert.equal(APPROVAL_LIFETIMES.standingChild, 120_000);
  const lifetime = { ok: false, reason: 'lifetime-mismatch', attribution: 'verified' };
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.approvedMs = APPROVAL_LIFETIMES.approved;
      raw.usableUntil = new Date(Date.parse(raw.approvedAt as string) + APPROVAL_LIFETIMES.approved).toISOString();
    }),
    lifetime,
  );
  // Moved to another route it is no child, and an ordinary send never carries a child's epoch and standing id.
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.route = 'chat';
    }),
    { ok: false, reason: 'identity-contradiction', attribution: 'verified' },
    'a child on another route',
  );
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.route = 'chat';
      delete raw.standingId;
      delete raw.standingEpoch;
      raw.approvedVia = 'terminal';
    }),
    lifetime,
    'and as an ordinary send, its lifetime is not one',
  );
  // Never pending, approved the moment it was made, by its standing approval and nothing else.
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.state = 'pending';
      delete raw.approvedAt;
      delete raw.usableUntil;
      delete raw.approvedVia;
      delete raw.approvedBindingDigest;
    }),
    { ok: false, reason: 'state-impossible', attribution: 'verified' },
  );
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.approvedAt = new Date(Date.parse(raw.createdAt as string) + 1).toISOString();
      raw.usableUntil = new Date(Date.parse(raw.approvedAt as string) + APPROVAL_LIFETIMES.standingChild).toISOString();
    }),
    { ok: false, reason: 'timestamp-misordered', attribution: 'verified' },
  );
  for (const via of ['terminal', 'elicitation', undefined]) {
    assert.deepEqual(
      resealed(core.approvals, minted, (raw) => {
        raw.approvedVia = via;
      }),
      { ok: false, reason: via === undefined ? 'evidence-missing' : 'evidence-invalid', attribution: 'verified' },
      `approved via ${via}`,
    );
  }
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      delete raw.standingId;
    }),
    { ok: false, reason: 'identity-contradiction', attribution: 'verified' },
    'a child names its standing approval',
  );
  // And `standing` evidence, or a standing id, on an ordinary send is a forgery.
  const ordinary = await core.approvals.create({
    channel: 'slack',
    inboxId: ACME,
    inboxSub: 'U_ME',
    draftId: 'sd_post',
    draftMessageId: 'rev-1',
    contentDigest: 'b'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: EXPECT,
  });
  assert.deepEqual(
    resealed(core.approvals, ordinary, (raw) => {
      raw.standingId = standing.approvalId;
    }),
    { ok: false, reason: 'identity-contradiction', attribution: 'verified' },
  );
  assert.deepEqual(
    resealed(core.approvals, ordinary, (raw) => {
      raw.state = 'approved';
      raw.approvedVia = 'standing';
      raw.approvedAt = raw.createdAt;
      raw.usableUntil = new Date(Date.parse(raw.createdAt as string) + APPROVAL_LIFETIMES.approved).toISOString();
      raw.approvedBindingDigest = 'x';
    }),
    { ok: false, reason: 'evidence-invalid', attribution: 'verified' },
  );
});

test('ensurePruned keeps an approved standing record for its 30 days, then 90 more', async () => {
  let now = Date.parse('2026-10-01T09:00:00.000Z');
  const { core } = machine({ now: () => new Date(now) });
  const record = await approvedAtTerminal(core, await prepared(core, {}, { expiresDays: 30 }));
  const step = async (ms: number) => {
    now += ms;
    return core.approvals.ensurePruned();
  };
  const stateNow = async () => {
    const stored = await core.approvals.get(record.approvalId);
    return stored === null ? null : asV2(stored)?.state;
  };
  assert.equal((await step(29 * DAY)).attempted, true);
  assert.equal(await stateNow(), 'approved', 'active for its 30 days');
  await step(DAY + 60_000);
  assert.equal(await stateNow(), 'expired', 'then expired, and kept');
  await step(88 * DAY);
  assert.equal(await stateNow(), 'expired', 'kept for 90 days after it ended');
  await step(2 * DAY);
  assert.equal(await stateNow(), null, 'then gone');
  assert.equal(existsSync(join(core.approvals.directory, `${record.approvalId}.json`)), false);
  const retained = (await core.audit.tail()).find((line) => line.operation === 'approval.retained');
  assert.equal(retained?.retained?.kind, 'standing');
});

test('a child is approved at creation, claims once, and a second claim is APPROVAL_VOID', async () => {
  const { core } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  const minted = await child(core, standing);
  assert.equal(minted.kind, 'send');
  assert.equal(minted.route, 'standing');
  assert.equal(minted.state, 'approved');
  assert.equal(minted.approvedVia, 'standing');
  assert.equal(minted.approvedAt, minted.createdAt);
  assert.equal(minted.standingId, standing.approvalId);
  assert.equal(minted.standingEpoch, 0);
  assert.equal(minted.sendEpoch, 0);
  assert.equal(minted.channel, 'slack');
  assert.deepEqual(minted.riskFlags, ['AS_AGENT', 'REACTS_AS_APP']);
  // A child is never asked for: no code, no second approval.
  await assert.rejects(
    core.approvals.issueChallenge(minted.approvalId, 'send'),
    refusedWith('USAGE', /approved already/),
  );

  const claim = await core.approvals.claimForSend(minted.approvalId, liveOf(minted));
  assert.equal(claim.record.state, 'sending');
  // While it is being sent, nobody else may claim it.
  await assert.rejects(core.approvals.claimForSend(minted.approvalId, liveOf(minted)), refusedWith('APPROVAL_PENDING'));
  await core.approvals.complete(minted.approvalId, claim.claimToken, { sentMessageId: '1760000000.000200' });
  await assert.rejects(
    core.approvals.claimForSend(minted.approvalId, liveOf(minted)),
    refusedWith('APPROVAL_VOID', /used already/),
  );

  // And the file system's O_EXCL marker holds even if the record were put back to approved behind the store's back.
  const again = await child(core, standing);
  await core.approvals.claimForSend(again.approvalId, liveOf(again));
  const path = join(core.approvals.directory, `${again.approvalId}.json`);
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  delete raw.sendingAt;
  writeFileSync(path, JSON.stringify({ ...raw, state: 'approved' }));
  await assert.rejects(
    core.approvals.claimForSend(again.approvalId, liveOf(again)),
    refusedWith('APPROVAL_VOID', /already claimed by another process/),
  );
});

test('a child claims under a confirm send policy with no code', async () => {
  const { core } = machine({ sendPolicy: 'confirm' });
  const standing = await approvedAtTerminal(core, await prepared(core));
  const minted = await child(core, standing);
  const { outcome } = await core.approvals.inspect(minted.approvalId);
  assert.equal(outcome.claimable, true);
  const claim = await core.approvals.claimForSend(minted.approvalId, liveOf(minted));
  assert.equal(claim.record.state, 'sending');
});

test('a child is minted only for an approved standing record, bound to its epochs', async () => {
  const { core } = machine();
  const pending = await prepared(core);
  await assert.rejects(child(core, pending), refusedWith('APPROVAL_PENDING'));
  const standing = await approvedAtTerminal(core, await prepared(core));
  await assert.rejects(child(core, standing, { standingEpoch: 1 }), refusedWith('APPROVAL_VOID'));
  await assert.rejects(
    core.approvals.createStandingChild({
      standingId: 'ap_00000000000000000000000000',
      standingEpoch: 0,
      inboxId: ACME,
      inboxSub: 'U_ME',
      draftId: 'd',
      draftMessageId: 'd'.repeat(64),
      contentDigest: 'd'.repeat(64),
      sendEpoch: 0,
      riskFlags: [],
      expect: EXPECT,
    }),
    refusedWith('NOT_FOUND'),
  );
  await core.approvals.revoke(standing.approvalId, 'ended by the person', { disposition: 'person' });
  await assert.rejects(child(core, standing), refusedWith('APPROVAL_VOID'));
});

test('a raised standing epoch revokes the standing record and its unclaimed child', async () => {
  const { core } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  const minted = await child(core, standing);
  await raiseStandingEpoch(core);
  await assert.rejects(
    core.approvals.claimForSend(minted.approvalId, liveOf(minted)),
    refusedWith('APPROVAL_VOID', /standing approvals were ended since this was approved/),
  );
  assert.equal(asV2(await core.approvals.get(minted.approvalId))?.state, 'revoked');
  await assert.rejects(
    core.approvals.withStanding(standing.approvalId, ACME, async (_record, outcome) => {
      if (outcome.error) throw outcome.error;
      return outcome;
    }),
    refusedWith('APPROVAL_VOID', /standing approvals were ended since this was approved/),
  );
  assert.equal(asV2(await core.approvals.get(standing.approvalId))?.state, 'revoked');
  // A pending one is ended the same way: it cannot be approved into a standing approval any more.
  const waiting = await prepared(core, {});
  await raiseStandingEpoch(core);
  await assert.rejects(core.approvals.issueChallenge(waiting.approvalId, 'standing'), refusedWith('APPROVAL_VOID'));
});

test('tightening the change policy ends them too: the epoch is the same one', async () => {
  const { core } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  await core.config.update((config) => {
    (config.accounts['acme/slack'] as AccountConfig).changePolicy = 'confirm';
    return config;
  });
  const { outcome } = await core.approvals.inspect(standing.approvalId, {}, { action: 'claim' });
  assert.equal(outcome.state, 'revoked');
});

test('a change policy tightened by a release that knows no standing epoch ends them, at a look and a mint', async () => {
  // 0.22 writes the configuration with no standing epoch: the policy moves to confirm, and the epoch stays at 0.
  const { core, config } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  assert.equal(standing.approvedChangePolicy, 'chat', 'it binds the change policy it was approved under');
  const later = await approvedAtTerminal(core, await prepared(core));
  config.write({ accounts: { 'acme/slack': { id: ACME, sendPolicy: 'chat', changePolicy: 'confirm' } } });
  assert.equal(standingEpochOf(await core.config.load()), standing.standingEpoch, 'the epoch never moved');

  const { outcome } = await core.approvals.inspect(standing.approvalId);
  assert.equal(outcome.state, 'revoked', 'a look shows it ended');
  assert.equal(outcome.reason, CHANGE_POLICY_TIGHTENED_REASON);
  await assert.rejects(
    core.approvals.withStanding(standing.approvalId, ACME, async (_record, found) => {
      if (found.error) throw found.error;
    }),
    refusedWith('APPROVAL_VOID', new RegExp(CHANGE_POLICY_TIGHTENED_REASON)),
  );
  await assert.rejects(child(core, later), refusedWith('APPROVAL_VOID', new RegExp(CHANGE_POLICY_TIGHTENED_REASON)));
  // A list is a look, and even a look writes this ending down: the policy, unlike an epoch, can be loosened again.
  const listed = await core.approvals.inspectAll();
  assert.ok(listed.some(({ outcome: seen }) => seen.reason === CHANGE_POLICY_TIGHTENED_REASON));
  // Loosening it again revives nothing: each was written down as ended.
  config.write({ accounts: { 'acme/slack': { id: ACME, sendPolicy: 'chat', changePolicy: 'chat' } } });
  assert.equal(asV2(await core.approvals.get(standing.approvalId))?.state, 'revoked');
  assert.equal(asV2(await core.approvals.get(later.approvalId))?.state, 'revoked');
  // Approved under confirm, a confirm changes nothing.
  config.write({ accounts: { 'acme/slack': { id: ACME, sendPolicy: 'chat', changePolicy: 'confirm' } } });
  const strict = await approvedAtTerminal(core, await prepared(core));
  assert.equal(strict.approvedChangePolicy, 'confirm');
  assert.equal((await core.approvals.inspect(strict.approvalId)).outcome.state, 'approved');
});

test('the change policy it was approved under is an approved standing record’s evidence, and nothing else’s', async () => {
  const { core } = machine();
  const record = await approvedAtTerminal(core, await prepared(core));
  const invalid = (reason: string) => ({ ok: false, reason, attribution: 'verified' });
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      delete raw.approvedChangePolicy;
    }),
    invalid('evidence-missing'),
    'an approved standing record without it',
  );
  assert.deepEqual(
    resealed(core.approvals, record, (raw) => {
      raw.approvedChangePolicy = 'never';
    }),
    invalid('evidence-missing'),
    'a policy that is none',
  );
  const pending = await prepared(core);
  assert.deepEqual(
    resealed(core.approvals, pending, (raw) => {
      raw.approvedChangePolicy = 'confirm';
    }),
    invalid('evidence-contradictory'),
    'on one not yet approved',
  );
  const minted = await child(core, record);
  assert.deepEqual(
    resealed(core.approvals, minted, (raw) => {
      raw.approvedChangePolicy = 'confirm';
    }),
    invalid('evidence-contradictory'),
    'on a child',
  );
});

test('never revokes it, and loosening again revives nothing', async () => {
  const { core } = machine();
  const touched = await approvedAtTerminal(core, await prepared(core));
  const untouched = await approvedAtTerminal(core, await prepared(core));
  const minted = await child(core, touched);
  const setPolicy = (to: 'chat' | 'never') =>
    applySendPolicyChange(
      core,
      (config) => {
        (config.accounts['acme/slack'] as AccountConfig).sendPolicy = to;
        return config;
      },
      to === 'chat' ? { consent: { kind: 'loosening-consent', paths: ['accounts.acme/slack.sendPolicy'] } } : {},
    );
  await setPolicy('never');
  await assert.rejects(
    core.approvals.withStanding(touched.approvalId, ACME, async (_record, outcome) => {
      if (outcome.error) throw outcome.error;
    }),
    refusedWith('POLICY_NEVER'),
  );
  // The change to never swept the child, a send, as it sweeps every send of the account it fenced.
  await assert.rejects(
    core.approvals.claimForSend(minted.approvalId, liveOf(minted)),
    refusedWith('APPROVAL_VOID', /sending was turned off/),
  );
  await setPolicy('chat');
  for (const record of [touched, untouched]) {
    await assert.rejects(
      core.approvals.withStanding(record.approvalId, ACME, async (_record, outcome) => {
        if (outcome.error) throw outcome.error;
      }),
      refusedWith('APPROVAL_VOID'),
    );
    const stored = asV2(await core.approvals.get(record.approvalId));
    assert.equal(stored?.state, 'revoked');
  }
  assert.equal(asV2(await core.approvals.get(untouched.approvalId))?.reason, SEND_EPOCH_REASON);
});

test('removing the account revokes it', async () => {
  const { core, config } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core));
  config.write({ accounts: {} });
  await assert.rejects(
    core.approvals.withStanding(standing.approvalId, ACME, async (_record, outcome) => {
      if (outcome.error) throw outcome.error;
    }),
    refusedWith('APPROVAL_VOID', new RegExp(OWNER_REMOVED_REASON)),
  );
  // And another owner never finds it.
  await assert.rejects(
    core.approvals.withStanding(standing.approvalId, 'acc_BBBBBBBBBBBBBBBB', async () => undefined),
    refusedWith('NOT_FOUND'),
  );
});

test('narrowStanding applies at once, and refuses a widening', async () => {
  const { core } = machine();
  const standing = await approvedAtTerminal(core, await prepared(core, {}, { perThread: 2, perHour: 10 }));
  const [eyes] = standing.standing?.contents ?? [];
  const narrowed = await core.approvals.narrowStanding(standing.approvalId, ACME, {
    keep: [eyes?.digest as string],
    limits: { perHour: 4, expiresDays: 3 },
  });
  assert.equal(narrowed.state, 'approved', 'it stays approved: nothing was asked');
  assert.deepEqual(narrowed.narrowed?.keep, [eyes?.digest]);
  assert.equal(narrowed.narrowed?.limits?.perHour, 4);
  assert.equal(narrowed.bindingDigest, standing.bindingDigest, 'the approval is bound to what the person approved');
  assert.deepEqual(validateV2(narrowed, narrowed.approvalId), { ok: true });
  // The narrowed expiry ends it when it comes.
  assert.equal(
    Date.parse((await core.approvals.inspect(standing.approvalId)).outcome.approval.usableUntil as string),
    Date.parse(standing.usableUntil as string),
  );

  for (const widening of [
    { limits: { perHour: 5 } },
    { limits: { perThread: 3 } },
    { limits: { expiresDays: 8 } },
    { keep: [standing.standing?.contents[2]?.digest as string] },
  ]) {
    await assert.rejects(
      core.approvals.narrowStanding(standing.approvalId, ACME, widening),
      refusedWith('USAGE'),
      JSON.stringify(widening),
    );
  }
  // A narrowing outside the table is refused too, as it would be at creation.
  await assert.rejects(
    core.approvals.narrowStanding(standing.approvalId, ACME, { limits: { perHour: 0 } }),
    refusedWith('BAD_DATA'),
  );
  // Narrower again is fine, and each narrowing is of what is in force.
  const again = await core.approvals.narrowStanding(standing.approvalId, ACME, { limits: { perHour: 2 } });
  assert.equal(again.narrowed?.limits?.perHour, 2);
  assert.deepEqual(again.narrowed?.keep, [eyes?.digest]);
  // An ended one is not narrowed.
  await core.approvals.revoke(standing.approvalId, 'ended', { disposition: 'person' });
  await assert.rejects(
    core.approvals.narrowStanding(standing.approvalId, ACME, { limits: { perHour: 1 } }),
    refusedWith('APPROVAL_VOID'),
  );
});

test('a narrowed expiry ends a standing record at its own time', async () => {
  let now = Date.parse('2026-10-01T09:00:00.000Z');
  const { core } = machine({ now: () => new Date(now) });
  const standing = await approvedAtTerminal(core, await prepared(core, {}, { expiresDays: 7 }));
  await core.approvals.narrowStanding(standing.approvalId, ACME, { limits: { expiresDays: 2 } });
  now += 2 * DAY - 1;
  assert.equal((await core.approvals.inspect(standing.approvalId)).outcome.state, 'approved');
  now += 1;
  const { outcome } = await core.approvals.inspect(standing.approvalId);
  assert.equal(outcome.state, 'expired');
  assert.equal(outcome.approval.expiredAt, new Date(Date.parse(standing.approvedAt as string) + 2 * DAY).toISOString());
});

/*
 * Every existing record digests as before: four of `approval-binding.test.ts`'s golden vectors, recomputed here with
 * the fields that carry a standing approval's epoch and id absent. The binding test holds every vector; these say the
 * standing work did not move the ones a standing record sits beside.
 */
test('every existing record digests as before', () => {
  const id = (c: string) => `ap_${'0'.repeat(25)}${c}`;
  const send: BindingFields = {
    approvalId: id('S'),
    kind: 'send',
    channel: 'slack',
    ownerScope: 'owner',
    inboxId: 'acc_AAAAAAAAAAAAAAAA',
    inboxSub: 'U0POSTER',
    draftId: 'sd_post',
    draftMessageId: 'rev-3',
    expect: { to: ['C0ROOM'], cc: [], bcc: [], subject: 'reaches 12' },
    contentDigest: 'b'.repeat(64),
    route: 'chat',
    pendingMs: 600_000,
    approvedMs: 86_400_000,
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
  };
  assert.equal(bindingDigestOf(send), 'cb24fad382f4b8dd1a31c71e4ebc8c2b1f7d9ecd51c81e84c52c224764441eb0');
  const gmail: BindingFields = {
    approvalId: id('G'),
    kind: 'send',
    channel: 'gmail',
    ownerScope: 'owner',
    inboxId: 'ibx_AAAAAAAAAAAAAAAA',
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    expect: { to: ['sam@partner.test'], cc: ['kim@partner.test'], bcc: [], subject: 'Re: plan' },
    contentDigest: 'a'.repeat(64),
    route: 'confirm',
    pendingMs: 1_800_000,
    approvedMs: 86_400_000,
    sendEpoch: 3,
    policy: 'chat',
    requiredPolicy: 'confirm',
  };
  assert.equal(bindingDigestOf(gmail), 'cc3d98535c129926f06d157d0821b6a7375892593b8eb57f5dde5e8e2c2fbfe5');
  const change: BindingFields = {
    approvalId: id('C'),
    kind: 'change',
    channel: 'slack',
    ownerScope: 'owner',
    inboxId: 'acc_AAAAAAAAAAAAAAAA',
    draftId: 'change',
    draftMessageId: 'f'.repeat(64),
    expect: { to: [], cc: [], bcc: [], subject: 'Let acme/slack post' },
    contentDigest: 'f'.repeat(64),
    route: 'chat',
    pendingMs: 600_000,
    approvedMs: 86_400_000,
    policy: 'chat',
    requiredPolicy: 'chat',
  };
  assert.equal(bindingDigestOf(change), '4f2775bb92638eec6171d7ef4df8224da06878c56f7d32b3a1420d9aef7a8dcf');
  const download: BindingFields = {
    approvalId: id('D'),
    kind: 'download',
    channel: 'gmail',
    ownerScope: 'owner',
    inboxId: 'ibx_AAAAAAAAAAAAAAAA',
    draftId: 'download',
    draftMessageId: '1'.repeat(64),
    expect: { to: [], cc: [], bcc: [], subject: 'where to save 2 files from acme/gmail' },
    contentDigest: '1'.repeat(64),
    pendingMs: 1_800_000,
    policy: 'confirm',
    requiredPolicy: 'confirm',
    download: { folders: { downloads: '/srv/sam/Downloads', current: '/srv/sam/work' } },
  };
  assert.equal(bindingDigestOf(download), '8f021bf173ae36f6df25df5aa7cd3d15c0def0f7183a557631093ba9892170f7');
  // A child's epoch and id are bound: the same send with them is another binding.
  const asChild: BindingFields = {
    ...send,
    route: 'standing',
    pendingMs: 120_000,
    approvedMs: 120_000,
    standingEpoch: 0,
    standingId: id('P'),
  };
  assert.notEqual(bindingDigestOf(asChild), bindingDigestOf({ ...asChild, standingEpoch: 1 }));
  assert.notEqual(bindingDigestOf(asChild), bindingDigestOf({ ...asChild, standingId: id('Q') }));
});
