import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { SEND_EPOCH_REASON } from '../src/approval-outcome.ts';
import { asV2 } from '../src/approval-stored.ts';
import { type ApprovalChannel, type ApprovalRecord, ApprovalStore, type Expectation } from '../src/approvals.ts';
import type { Config, InboxConfig, SendPolicy } from '../src/config.ts';
import { SEND_POLICY_HOOKS } from '../src/config-hooks.ts';
import { type Core, openCore } from '../src/core.ts';
import { CommsError } from '../src/errors.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { withFileLock } from '../src/lock.ts';
import { applySendPolicyChange, type FenceReport, sendEpochOf, sweepFencedOwners } from '../src/send-epoch.ts';
import { liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';

/*
 * `never` fences every earlier approval (CUE-404 Task 8; design 2026-10-05 §D1, "`never` revokes; loosening revives
 * nothing" and "Order between a claim and a `never` change").
 *
 * The epoch a record carries is compared with the live one under the record's lock, at every claim and approval; the
 * change to `never` raises it in its own atomic write, then — the config lock let go — sweeps the records it fenced.
 * The barrier tests stop each side at the moment that matters: a claim or an approval holding its record lock with
 * the configuration read, and a change to `never` between its commit and its sweep.
 */

const OWNER = 'ibx_AAAAAAAAAAAAAAAA';
const PATH = 'inboxes.acme/gmail.sendPolicy';
const EXPECT: Expectation = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };
const LIVE = {
  inboxId: OWNER,
  inboxSub: 'sub-1',
  draftMessageId: 'msg-v1',
  contentDigest: 'a'.repeat(64),
  expect: EXPECT,
};
const DRAFT = { draftMessageId: 'msg-v1', contentDigest: 'a'.repeat(64) };

/** A promise and the hand that settles it. */
function gate<T = void>() {
  let open!: (value: T) => void;
  const opened = new Promise<T>((settle) => {
    open = settle;
  });
  return { open, opened };
}

/** A machine whose mailbox `acme/gmail` sends under `policy`, version 3, with a core over it. */
async function machine(policy: SendPolicy = 'chat') {
  const home = tempDir('comms-fence-');
  const config = liveConfig(home, { inboxes: { 'acme/gmail': { id: OWNER, sendPolicy: policy } } });
  const env = { HOME: home, USERPROFILE: home, AGENT_COMMS_CONFIG_DIR: config.dir, AGENT_COMMS_UPDATE_CHECK: 'off' };
  const core = openCore({ env, caller: CORE_CALLER });
  /** The call that would reach the provider, made only after a successful claim. */
  const provider = { calls: 0 };
  return { home, config, core, provider };
}

/** A send prepared now, carrying the epoch its prepare read (or the one given), under the live policy. */
async function prepare(core: Core, options: { epoch?: number; policy?: SendPolicy } = {}): Promise<ApprovalRecord> {
  const config = await core.config.load();
  const policy = options.policy ?? (config.inboxes['acme/gmail']?.sendPolicy as SendPolicy);
  return core.approvals.create({
    channel: 'gmail',
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: options.epoch ?? sendEpochOf(config, OWNER),
    policy,
    requiredPolicy: policy,
    riskFlags: [],
    expect: EXPECT,
  });
}

const setPolicy =
  (to: SendPolicy) =>
  (config: Config): Config => ({
    ...config,
    inboxes: { ...config.inboxes, 'acme/gmail': { ...(config.inboxes['acme/gmail'] as InboxConfig), sendPolicy: to } },
  });

/** The change to `never`, as every send-policy writer makes it. */
function toNever(core: Core, hooks: { afterCommit?: () => Promise<void> | void } = {}) {
  return applySendPolicyChange(core, setPolicy('never'), { [SEND_POLICY_HOOKS]: hooks });
}

/** Loosening back to `to`, with the consent a person's approval gives. */
function loosen(core: Core, to: SendPolicy) {
  return core.config.update(setPolicy(to), { consent: { kind: 'loosening-consent', paths: [PATH] } });
}

/** A claim, and the provider call that follows it only when it succeeds. */
async function claimAndSend(store: ApprovalStore, provider: { calls: number }, approvalId: string) {
  const claimed = await store.claimForSend(approvalId, LIVE);
  provider.calls += 1;
  return claimed;
}

async function approveBy(store: ApprovalStore, approvalId: string, via: ApprovalChannel) {
  const code = await store.issueChallenge(approvalId);
  return store.approve(approvalId, via, DRAFT, code);
}

const stateNow = async (core: Core, id: string) => asV2(await core.approvals.get(id));
const refusedWith = (code: string, message?: RegExp) => (e: unknown) =>
  e instanceof CommsError && e.code === code && (message === undefined || message.test(e.message));

/** A store over the core's state, whose configuration read under the record lock pauses where the test says. */
function pausedStore(core: Core, read: { open: () => void }, release: Promise<void>) {
  return new ApprovalStore(core.paths.stateDir, {
    loadConfig: async () => {
      const config = await core.config.load();
      read.open();
      await release;
      return config;
    },
  });
}

/** Holds a record's lock, as a claim part-way through would, until `release`. */
async function holdRecordLock(core: Core, approvalId: string) {
  const held = gate();
  const release = gate();
  const done = withFileLock(join(core.approvals.directory, `${approvalId}.json.lock`), async () => {
    held.open();
    await release.opened;
  });
  await held.opened;
  return {
    release: async () => {
      release.open();
      await done;
    },
  };
}

// ── The two orders, for a claim ─────────────────────────────────────────────────────────────────────────────────

test('a claim that read epoch N, then a commit of N+1 before it writes sending: the claim proceeds, and the change lists it as already being sent', async () => {
  const { core, provider } = await machine();
  const record = await prepare(core);
  const read = gate();
  const release = gate();
  const claimant = pausedStore(core, read, release.opened);
  const claiming = claimAndSend(claimant, provider, record.approvalId);
  await read.opened;
  // The claim holds the record lock, its configuration read: the change to never commits now, and sweeps after.
  const committed = gate();
  const changing = toNever(core, { afterCommit: () => committed.open() });
  await committed.opened;
  assert.equal(sendEpochOf(await core.config.load(), OWNER), 1, 'N+1 committed while the claim held its lock');
  release.open();
  assert.equal((await claiming).record.state, 'sending', 'admitted before the change: it proceeds');
  assert.equal(provider.calls, 1);
  const { fenced } = await changing;
  assert.deepEqual(fenced.alreadySending, [record.approvalId], 'and the change says it was already being sent');
  assert.deepEqual(fenced.revoked, []);
});

test('a commit of N+1 before the claim takes its lock: the claim revokes, and the provider is never called', async () => {
  const { core, provider } = await machine();
  const record = await prepare(core);
  // The claim is on its way and waiting for the lock; the change to never commits first.
  const lock = await holdRecordLock(core, record.approvalId);
  const claiming = claimAndSend(core.approvals, provider, record.approvalId);
  await sleep(100);
  // Let go once the change has committed — and the sweep waits for the claim, so the claim decides for itself.
  const changing = toNever(core, {
    afterCommit: async () => {
      await lock.release();
      await claiming.catch(() => undefined);
    },
  });
  await assert.rejects(claiming, refusedWith('POLICY_NEVER'));
  await changing;
  assert.equal(provider.calls, 0, 'no provider call follows it');
  assert.equal((await stateNow(core, record.approvalId))?.state, 'revoked');
  // Loosened again, it stays revoked: it was prepared before the never.
  await loosen(core, 'chat');
  await assert.rejects(claimAndSend(core.approvals, provider, record.approvalId), refusedWith('APPROVAL_VOID'));
  assert.equal(provider.calls, 0);
});

// ── The two orders, for an approval at a terminal and in a form ────────────────────────────────────────────────

test('an approval that read epoch N, then a commit of N+1: it is approved, and the sweep revokes it', async () => {
  for (const via of ['terminal', 'elicitation'] as const) {
    const { core } = await machine('confirm');
    const record = await prepare(core);
    const code = await core.approvals.issueChallenge(record.approvalId);
    const read = gate();
    const release = gate();
    const approving = pausedStore(core, read, release.opened).approve(record.approvalId, via, DRAFT, code);
    await read.opened;
    const committed = gate();
    const changing = toNever(core, { afterCommit: () => committed.open() });
    await committed.opened;
    release.open();
    assert.equal((await approving).state, 'approved', `${via}: admitted before the change`);
    const { fenced } = await changing;
    assert.deepEqual(fenced.revoked, [record.approvalId], `${via}: the sweep reached it`);
    const after = await stateNow(core, record.approvalId);
    assert.equal(after?.state, 'revoked');
    assert.equal(after?.reason, SEND_EPOCH_REASON);
  }
});

test('a commit of N+1 before an approval takes its lock: the approval revokes, and approved is never written', async () => {
  for (const via of ['terminal', 'elicitation'] as const) {
    const { core } = await machine('confirm');
    const record = await prepare(core);
    const code = await core.approvals.issueChallenge(record.approvalId);
    const lock = await holdRecordLock(core, record.approvalId);
    const approving = core.approvals.approve(record.approvalId, via, DRAFT, code);
    await sleep(100);
    const changing = toNever(core, {
      afterCommit: async () => {
        await lock.release();
        await approving.catch(() => undefined);
      },
    });
    await assert.rejects(approving, refusedWith('POLICY_NEVER'), via);
    await changing;
    const after = await stateNow(core, record.approvalId);
    assert.equal(after?.state, 'revoked', via);
    assert.equal(after?.approvedAt, undefined, `${via}: never approved`);
    assert.equal(after?.approvedVia, undefined);
  }
});

test('lock order: a claim holds no config lock while it reads, and a change to never holds no record lock while it commits or sweeps', async () => {
  const { core, config, provider } = await machine();
  const record = await prepare(core);
  const configLock = join(config.dir, '.config.lock');
  // A claim holding its record lock, configuration read: a config write still goes through.
  const read = gate();
  const release = gate();
  const claiming = claimAndSend(pausedStore(core, read, release.opened), provider, record.approvalId);
  await read.opened;
  await core.config.update((current) => ({ ...current, defaults: { ...current.defaults, timezone: 'UTC' } }));
  release.open();
  await claiming;
  // A change to never: inside its commit, a record lock is free; inside the sweep, the config lock is free.
  const second = await prepare(core);
  let recordLockFree: boolean | undefined;
  let configLockFreeInSweep: boolean | undefined;
  const revoke = core.approvals.revoke.bind(core.approvals);
  core.approvals.revoke = async (...args) => {
    configLockFreeInSweep = !existsSync(configLock);
    return revoke(...args);
  };
  await applySendPolicyChange(core, async (current) => {
    // The config lock is held here: a record's lock can still be taken, so the writer holds none. Awaited, not raced
    // against a clock: the writer is held up in here, so a record lock it held would never come free, and the look
    // would end in LOCK_TIMEOUT however fast the machine; a free one is taken however slow.
    recordLockFree = await core.approvals.inspect(second.approvalId).then(
      () => true,
      () => false,
    );
    return setPolicy('never')(current);
  });
  assert.equal(recordLockFree, true, 'no record lock is held under the config lock');
  assert.equal(configLockFreeInSweep, true, 'no config lock is held while the sweep takes a record lock');
});

// ── After the fence: loosening revives nothing ──────────────────────────────────────────────────────────────────

/** The sweep made to fail on every record, as a write that cannot be made would. */
function failingSweep(core: Core) {
  const revoke = core.approvals.revoke.bind(core.approvals);
  core.approvals.revoke = async () => {
    throw new CommsError('LOCK_TIMEOUT', 'another process is holding the approval');
  };
  return () => {
    core.approvals.revoke = revoke;
  };
}

test('a sweep that failed, then never → chat or never → confirm: claim and approval each revoke on the stale epoch', async () => {
  for (const back of ['chat', 'confirm'] as const) {
    const { core, provider } = await machine('confirm');
    const pending = await prepare(core);
    const approved = await prepare(core);
    await approveBy(core.approvals, approved.approvalId, 'terminal');
    const restore = failingSweep(core);
    const { fenced } = await toNever(core);
    restore();
    assert.deepEqual(new Set(fenced.couldNotRevoke), new Set([pending.approvalId, approved.approvalId]));
    await loosen(core, back);
    const stale = refusedWith('APPROVAL_VOID', /sending was turned off since this was prepared \(policy: never\)/);
    await assert.rejects(claimAndSend(core.approvals, provider, approved.approvalId), stale, `${back}: claim`);
    await assert.rejects(approveBy(core.approvals, pending.approvalId, 'terminal'), stale, `${back}: approval`);
    for (const id of [pending.approvalId, approved.approvalId]) {
      const after = await stateNow(core, id);
      assert.equal(after?.state, 'revoked', back);
      assert.equal(after?.reason, SEND_EPOCH_REASON);
    }
    assert.equal(provider.calls, 0);
  }
});

test('a prepare that read epoch N and wrote its record after N+1 and its sweep: after loosening, its claim revokes', async () => {
  const { core, provider } = await machine();
  // The prepare read the configuration — chat, epoch 0 — before the change to never; it writes after the sweep.
  const readEpoch = sendEpochOf(await core.config.load(), OWNER);
  const { fenced } = await toNever(core);
  assert.deepEqual(fenced.revoked, [], 'nothing to sweep yet');
  const late = await prepare(core, { epoch: readEpoch, policy: 'chat' });
  await loosen(core, 'chat');
  await assert.rejects(
    claimAndSend(core.approvals, provider, late.approvalId),
    refusedWith('APPROVAL_VOID', /sending was turned off since this was prepared/),
  );
  assert.equal(provider.calls, 0);
});

test('pending and approved sends through chat → never → chat and confirm → never → confirm: revoked by the change, unusable after loosening', async () => {
  for (const policy of ['chat', 'confirm'] as const) {
    const { core, provider } = await machine(policy);
    const pending = await prepare(core);
    const approved = await prepare(core);
    await approveBy(core.approvals, approved.approvalId, 'terminal');
    const { fenced } = await toNever(core);
    assert.deepEqual(new Set(fenced.revoked), new Set([pending.approvalId, approved.approvalId]), policy);
    assert.deepEqual([fenced.alreadySending, fenced.couldNotRevoke], [[], []]);
    await loosen(core, policy);
    for (const id of [pending.approvalId, approved.approvalId]) {
      await assert.rejects(
        claimAndSend(core.approvals, provider, id),
        refusedWith('APPROVAL_VOID'),
        `${policy}: claim`,
      );
      await assert.rejects(
        approveBy(core.approvals, id, 'terminal'),
        refusedWith('APPROVAL_VOID'),
        `${policy}: approve`,
      );
    }
    assert.equal(provider.calls, 0);
    // Only a newly prepared approval can send.
    const fresh = await prepare(core);
    if (policy === 'confirm') await approveBy(core.approvals, fresh.approvalId, 'terminal');
    assert.equal((await claimAndSend(core.approvals, provider, fresh.approvalId)).record.state, 'sending');
  }
});

test('a revocation the change reported as failed: the next claim or approval revokes it, with POLICY_NEVER', async () => {
  const { core, provider } = await machine('confirm');
  const claimed = await prepare(core);
  await approveBy(core.approvals, claimed.approvalId, 'terminal');
  const approving = await prepare(core);
  const restore = failingSweep(core);
  const { fenced } = await toNever(core);
  restore();
  assert.equal(fenced.couldNotRevoke.length, 2);
  await assert.rejects(claimAndSend(core.approvals, provider, claimed.approvalId), refusedWith('POLICY_NEVER'));
  await assert.rejects(approveBy(core.approvals, approving.approvalId, 'elicitation'), refusedWith('POLICY_NEVER'));
  for (const id of [claimed.approvalId, approving.approvalId])
    assert.equal((await stateNow(core, id))?.state, 'revoked');
  assert.equal(provider.calls, 0);
});

test('a terminal or form approval under never revokes, and never writes approved', async () => {
  for (const via of ['terminal', 'elicitation'] as const) {
    const { core, config } = await machine('confirm');
    const record = await prepare(core);
    const code = await core.approvals.issueChallenge(record.approvalId);
    // Turned to never by a hand edit, with no epoch and no sweep: the live policy alone revokes it.
    config.write({ inboxes: { 'acme/gmail': { id: OWNER, sendPolicy: 'never' } } });
    await assert.rejects(core.approvals.approve(record.approvalId, via, DRAFT, code), refusedWith('POLICY_NEVER'), via);
    const after = await stateNow(core, record.approvalId);
    assert.equal(after?.state, 'revoked');
    assert.equal(after?.approvedAt, undefined);
  }
});

test('a record that requires never, under a live chat, revokes at its claim', async () => {
  const { core, provider } = await machine('chat');
  const record = await core.approvals.create({
    channel: 'gmail',
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'never',
    riskFlags: ['policy-tightened'],
    expect: EXPECT,
  });
  await assert.rejects(claimAndSend(core.approvals, provider, record.approvalId), refusedWith('POLICY_NEVER'));
  assert.equal((await stateNow(core, record.approvalId))?.state, 'revoked');
  assert.equal(provider.calls, 0);
});

test('an approved send whose live policy becomes never is not claimable, and its claim returns POLICY_NEVER', async () => {
  const { core, config, provider } = await machine('confirm');
  const record = await prepare(core);
  await approveBy(core.approvals, record.approvalId, 'terminal');
  assert.equal((await core.approvals.inspect(record.approvalId)).outcome.claimable, true);
  config.write({ inboxes: { 'acme/gmail': { id: OWNER, sendPolicy: 'never' } } });
  const { outcome } = await core.approvals.inspect(record.approvalId);
  assert.equal(outcome.state, 'approved', 'its real state');
  assert.equal(outcome.claimable, false);
  assert.match(outcome.reason ?? '', /sending is turned off \(policy: never\); any use revokes it/);
  await assert.rejects(claimAndSend(core.approvals, provider, record.approvalId), refusedWith('POLICY_NEVER'));
  assert.equal(provider.calls, 0);
});

test('the sweep reports nothing for owners it did not fence, and every list in its report holds ids only', async () => {
  const { core } = await machine();
  const record = await prepare(core);
  const nothing: FenceReport = await sweepFencedOwners(core, []);
  assert.deepEqual(nothing, { revoked: [], alreadySending: [], couldNotRevoke: [] });
  const other = await sweepFencedOwners(core, ['ibx_ZZZZZZZZZZZZZZZZ']);
  assert.deepEqual(other, { revoked: [], alreadySending: [], couldNotRevoke: [] });
  assert.equal((await stateNow(core, record.approvalId))?.state, 'pending');
});
