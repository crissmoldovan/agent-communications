import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  type ApprovalOutcome,
  approvalOutcome,
  type LiveGate,
  liveGateOf,
  NEVER_NOTICE,
  NO_CONFIGURATION,
  type OutcomeAction,
  OWNER_REMOVED_REASON,
  SEND_EPOCH_REASON,
} from '../src/approval-outcome.ts';
import { asV2, type StoredApproval } from '../src/approval-stored.ts';
import { type ApprovalRecord, ApprovalStore, changeDigest, type Expectation } from '../src/approvals.ts';
import { parseConfig } from '../src/config.ts';
import { CommsError } from '../src/errors.ts';
import { type LiveConfigState, liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';
import { ACCOUNT, CHANGE_BINDING, OWNER, T0, v2Record } from './helpers/v2-records.ts';

/*
 * One locked classification of every record into an outcome (CUE-404 Task 5; design 2026-10-05 §D2).
 *
 * The first half is the classifier alone: a record, a live gate, an action — every row of D2's table that core can
 * produce without a provider. The second is the store, where the classification happens under the record's lock,
 * from one configuration read there, after ownership and kind.
 */

const NOW = new Date(T0 + 2 * 60_000);
const v2 = (record: ApprovalRecord): StoredApproval => ({ form: 'v2', record });
const PRESENT = (over: Partial<LiveGate> = {}): LiveGate => ({
  owner: 'present',
  sendPolicy: 'chat',
  changePolicy: 'chat',
  sendEpoch: 0,
  ...over,
});
const classify = (record: ApprovalRecord, live: LiveGate | null, action: OutcomeAction = 'inspect'): ApprovalOutcome =>
  approvalOutcome(v2(record), { action, live, now: NOW });

// ── The classifier ──────────────────────────────────────────────────────────────────────────────────────────────

test('a pending send is claimable on the chat route while the live policy is chat — and only then', () => {
  const chat = v2Record({ kind: 'send', state: 'pending', route: 'chat' });
  const confirm = v2Record({ kind: 'send', state: 'pending', route: 'confirm' });
  assert.equal(classify(chat, PRESENT()).claimable, true);
  assert.equal(classify(chat, PRESENT({ sendPolicy: 'confirm' })).claimable, false, 'tightened: it waits');
  assert.equal(classify(confirm, PRESENT()).claimable, false, 'a confirm route never claims directly, loosened or not');
  assert.equal(classify(confirm, PRESENT({ sendPolicy: 'confirm' })).claimable, false);
  for (const record of [chat, confirm]) {
    const outcome = classify(record, PRESENT());
    assert.equal(outcome.state, 'pending');
    assert.equal(outcome.error, undefined);
    assert.equal(outcome.approval.route, record.route);
    assert.equal(outcome.approval.expiresAt, record.expiresAt);
  }
});

test('an approved send or change is claimable whatever the route, while the policy is not never', () => {
  for (const kind of ['send', 'change'] as const) {
    const approved = v2Record({ kind, state: 'approved', route: 'confirm', via: 'terminal' });
    for (const policy of ['chat', 'confirm'] as const) {
      const outcome = classify(approved, PRESENT({ sendPolicy: policy, changePolicy: policy }));
      assert.equal(outcome.state, 'approved', kind);
      assert.equal(outcome.claimable, true, `${kind} under ${policy}`);
      assert.equal(outcome.approval.approvedAt, approved.approvedAt);
      assert.equal(outcome.approval.usableUntil, approved.usableUntil);
    }
  }
});

test('under a live never a pending or approved send keeps its state and cannot be claimed; a claim or an approval revokes it', () => {
  const records = [
    v2Record({ kind: 'send', state: 'pending', route: 'chat' }),
    v2Record({ kind: 'send', state: 'approved', route: 'confirm', via: 'terminal' }),
  ];
  for (const record of records) {
    // Seen: its real state, with what any use would do.
    for (const action of ['inspect', 'wait'] as const) {
      const seen = classify(record, PRESENT({ sendPolicy: 'never', sendEpoch: 1 }), action);
      assert.equal(seen.state, record.state, `${record.state}, ${action}`);
      assert.equal(seen.claimable, false);
      assert.equal(seen.reason, NEVER_NOTICE);
      assert.equal(seen.revokes, false, 'a look writes nothing');
      assert.equal(seen.error, undefined);
    }
    // Used: revoked, and POLICY_NEVER — before the stale epoch the change to never also left behind.
    for (const action of ['claim', 'approve'] as const) {
      const used = classify(record, PRESENT({ sendPolicy: 'never', sendEpoch: 1 }), action);
      assert.equal(used.revokes, true, `${record.state}, ${action}`);
      assert.equal(used.state, 'revoked');
      assert.equal(used.record?.revokedAt, NOW.toISOString());
      assert.equal(used.error?.code, 'POLICY_NEVER');
      assert.equal(used.error?.message, 'nothing was sent: sending is turned off for this mailbox (policy: never)');
    }
    // The owner named by its kind, from the channel that prepared the record (CUE-404): never "this inbox" for an
    // account that is no mailbox.
    for (const [channel, owner] of [
      ['gmail', 'mailbox'],
      ['slack', 'workspace'],
      ['resend', 'account'],
      ['whatsapp', 'account'],
    ] as const) {
      const theirs = classify({ ...record, channel }, PRESENT({ sendPolicy: 'never', sendEpoch: 1 }), 'claim');
      assert.equal(theirs.error?.message, `nothing was sent: sending is turned off for this ${owner} (policy: never)`);
      assert.equal(theirs.record?.reason, `sending is turned off for this ${owner} (policy: never)`, 'and revoked so');
    }
  }
  // `requiredPolicy: never` under a live chat: the same.
  const required = { ...v2Record({ kind: 'send', state: 'pending' }), requiredPolicy: 'never' as const };
  assert.equal(classify(required, PRESENT()).claimable, false);
  assert.equal(classify(required, PRESENT(), 'claim').error?.code, 'POLICY_NEVER');
});

test('a send whose stored epoch is behind the live one reads revoked, whatever the policy is now', () => {
  for (const state of ['pending', 'approved'] as const) {
    const record = v2Record({ kind: 'send', state, via: state === 'approved' ? 'terminal' : undefined });
    for (const sendPolicy of ['chat', 'confirm'] as const) {
      const seen = classify(record, PRESENT({ sendPolicy, sendEpoch: 1 }));
      assert.equal(seen.state, 'revoked', `${state} under ${sendPolicy}`);
      assert.equal(seen.reason, SEND_EPOCH_REASON);
      assert.equal(seen.claimable, false);
      assert.equal(seen.revokes, true, 'derived, for the next action to write');
      const claimed = classify(record, PRESENT({ sendPolicy, sendEpoch: 1 }), 'claim');
      assert.equal(claimed.error?.code, 'APPROVAL_VOID');
      assert.match(claimed.error?.message ?? '', /sending was turned off since this was prepared \(policy: never\)/);
    }
  }
  // An epoch is the send's alone: a change carries none, and is not fenced by one.
  const change = v2Record({ kind: 'change', state: 'pending' });
  assert.equal(classify(change, PRESENT({ sendEpoch: 3 })).claimable, true);
});

test('an owner-scope record whose owner is gone: pending and approved read revoked, every other state keeps its own — all ownerRemoved, nothing assumed', () => {
  const removed: LiveGate = { owner: 'removed' };
  for (const [record, state] of [
    [v2Record({ kind: 'send', state: 'pending' }), 'revoked'],
    [v2Record({ kind: 'send', state: 'approved', route: 'confirm', via: 'terminal' }), 'revoked'],
    [v2Record({ kind: 'send', state: 'used' }), 'used'],
    [v2Record({ kind: 'send', state: 'sending' }), 'sending'],
    [v2Record({ kind: 'send', state: 'failed' }), 'failed'],
    [v2Record({ kind: 'change', state: 'pending', scope: 'owner' }), 'revoked'],
    [v2Record({ kind: 'download', state: 'pending' }), 'revoked'],
  ] as const) {
    const outcome = classify(record, removed);
    assert.equal(outcome.state, state, `${record.kind} ${record.state}`);
    assert.equal(outcome.ownerRemoved, true);
    assert.equal(outcome.approval.ownerRemoved, true);
    assert.equal(outcome.claimable, false);
    if (state === 'revoked') assert.equal(outcome.reason, OWNER_REMOVED_REASON);
  }
});

test('a prospective or global change is never owner-removed: its claim follows the live change policy alone', () => {
  for (const scope of ['prospective', 'global'] as const) {
    const record = v2Record({ kind: 'change', state: 'pending', scope });
    const config = parseConfig(JSON.stringify({ version: 3, naming: 2 }));
    const gate = liveGateOf(config, record);
    // The standing epoch is the whole configuration's, so every gate carries it (design 2026-10-19-standing-approvals).
    assert.deepEqual(gate, { owner: 'none', changePolicy: 'chat', standingEpoch: 0 }, scope);
    const outcome = classify(record, gate);
    assert.equal(outcome.ownerRemoved, undefined, scope);
    assert.equal(outcome.claimable, true);
    assert.equal(classify(record, { owner: 'none', changePolicy: 'confirm' }).claimable, false, `${scope}, confirm`);
  }
});

test('liveGateOf finds the owner by its id, in either map, and assumes nothing of one that is gone', () => {
  const config = parseConfig(
    JSON.stringify({
      version: 3,
      naming: 2,
      inboxes: {
        'acme/gmail': {
          id: OWNER,
          provider: 'gmail',
          email: 'jo@acme.test',
          identity: 'oidc',
          client: 'desktop',
          tier: 'send',
          secretRef: 'r',
          createdAt: '2026-09-01T00:00:00.000Z',
          sendPolicy: 'confirm',
        },
      },
      accounts: {
        'acme/slack': {
          id: ACCOUNT,
          platform: 'slack',
          workspace: 'T',
          userId: 'U',
          tier: 'send',
          secretRef: 'r',
          createdAt: '2026-09-01T00:00:00.000Z',
          changePolicy: 'confirm',
        },
      },
      defaults: { sendPolicy: 'never' },
      sendEpochs: { [ACCOUNT]: 4 },
    }),
  );
  assert.deepEqual(liveGateOf(config, v2Record({ kind: 'send', state: 'pending' })), {
    owner: 'present',
    sendPolicy: 'confirm',
    changePolicy: 'chat',
    sendEpoch: 0,
    standingEpoch: 0,
  });
  const slack = { ...v2Record({ kind: 'send', state: 'pending' }), channel: 'slack', inboxId: ACCOUNT };
  assert.deepEqual(liveGateOf(config, slack), {
    owner: 'present',
    sendPolicy: 'never',
    changePolicy: 'confirm',
    sendEpoch: 4,
    standingEpoch: 0,
  });
  // A change is governed by the strictest policy over everything it touches.
  assert.equal(liveGateOf(config, v2Record({ kind: 'change', state: 'pending' })).changePolicy, 'confirm');
  const gone = { ...v2Record({ kind: 'send', state: 'pending' }), inboxId: 'ibx_ZZZZZZZZZZZZZZZZ' };
  // No default policy and no send epoch 0 for an owner that is gone; the standing epoch is nobody's own.
  assert.deepEqual(liveGateOf(config, gone), { owner: 'removed', standingEpoch: 0 }, 'no default policy, no epoch 0');
});

test('without a configuration nothing is claimable or owner-removed, and a claim or an approval is refused with CONFIG', () => {
  const record = v2Record({ kind: 'send', state: 'pending', route: 'chat' });
  const seen = classify(record, null);
  assert.equal(seen.claimable, false);
  assert.equal(seen.ownerRemoved, undefined);
  assert.equal(seen.error, undefined);
  for (const action of ['claim', 'approve'] as const) {
    const refused = classify(record, null, action);
    assert.equal(refused.error?.code, 'CONFIG', action);
    assert.match(refused.error?.message ?? '', new RegExp(NO_CONFIGURATION));
    assert.equal(refused.revokes, false);
  }
});

test('a download’s question: claimable pending while its own and the live change policy are chat; answered until it expires', () => {
  const chat = v2Record({ kind: 'download', state: 'pending' });
  const confirm = v2Record({ kind: 'download', state: 'pending', via: undefined });
  const asked = { ...confirm, requiredPolicy: 'confirm' as const, policy: 'confirm' as const };
  assert.equal(classify(chat, PRESENT()).claimable, true, 'pending, chat: answered in the chat now');
  assert.equal(classify(chat, PRESENT({ changePolicy: 'confirm' })).claimable, false, 'live confirm');
  assert.equal(approvalOutcome(v2(asked), { action: 'inspect', live: PRESENT(), now: NOW }).claimable, false);
  const answered = v2Record({ kind: 'download', state: 'approved', via: 'terminal' });
  const outcome = classify(answered, PRESENT({ changePolicy: 'confirm' }));
  assert.equal(outcome.state, 'answered');
  assert.equal(outcome.claimable, true);
  assert.equal(outcome.approval.usableUntil, undefined, 'a question has no window of its own');
  for (const state of ['used', 'expired', 'revoked'] as const) {
    const done = classify(v2Record({ kind: 'download', state }), PRESENT());
    assert.equal(done.claimable, false, state);
    assert.equal(done.state, state === 'used' ? 'answered' : state);
  }
});

test('APPROVAL_REQUIRED never describes approved, expired, used, failed, sending, unknown, corrupt or revoked', async () => {
  const records: [string, StoredApproval][] = [
    ['expired', v2(v2Record({ kind: 'send', state: 'expired' }))],
    ['used', v2(v2Record({ kind: 'send', state: 'used' }))],
    ['failed', v2(v2Record({ kind: 'send', state: 'failed' }))],
    ['sending', v2(v2Record({ kind: 'send', state: 'sending' }))],
    ['unknown', v2(v2Record({ kind: 'send', state: 'unknown' }))],
    ['revoked', v2(v2Record({ kind: 'send', state: 'revoked' }))],
    ['used change', v2(v2Record({ kind: 'change', state: 'used' }))],
    [
      'corrupt',
      {
        form: 'corrupt',
        approvalId: `ap_${'0'.repeat(25)}C`,
        reason: 'binding-mismatch',
        attribution: 'unverifiable',
        safe: null,
      },
    ],
  ];
  for (const [name, stored] of records) {
    for (const action of ['claim', 'approve', 'wait', 'inspect'] as const) {
      const outcome = approvalOutcome(stored, { action, live: PRESENT(), now: NOW });
      assert.notEqual(outcome.error?.code, 'APPROVAL_REQUIRED', `${name}, ${action}`);
      assert.equal(outcome.claimable, false, `${name}, ${action}`);
    }
  }
  // Sending is somebody else's call under way: wait for it, never prepare it again.
  const sending = classify(v2Record({ kind: 'send', state: 'sending' }), PRESENT(), 'claim');
  assert.equal(sending.error?.code, 'APPROVAL_PENDING');
  assert.match(sending.error?.hint ?? '', /Do not prepare it again/);
  // And an approved record asked to be approved again is not told it lacks an approval.
  const { store, record } = await sendStore('confirm');
  const code = await store.issueChallenge(record.approvalId);
  await store.approve(record.approvalId, 'terminal', LIVE, code);
  for (const again of [
    () => store.issueChallenge(record.approvalId),
    () => store.approve(record.approvalId, 'terminal', LIVE, code),
  ]) {
    await assert.rejects(
      again(),
      (e: unknown) => e instanceof CommsError && e.code !== 'APPROVAL_REQUIRED' && /approved already/.test(e.message),
    );
  }
});

// ── The store: one locked classification, from one configuration read ───────────────────────────────────────────

const EXPECT: Expectation = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };
const LIVE = { draftMessageId: 'msg-v1', contentDigest: 'a'.repeat(64) };
const SLACK = 'acc_SSSSSSSSSSSSSSSS';
const RESEND = 'acc_RRRRRRRRRRRRRRRR';

function clock(start = T0) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

/** `acme/gmail`, `acme/slack` and `acme/resend`, with `acme/gmail` sending under `policy`. */
function owners(policy: 'chat' | 'confirm' | 'never' = 'chat', over: Partial<LiveConfigState> = {}): LiveConfigState {
  return {
    inboxes: { 'acme/gmail': { id: OWNER, sendPolicy: policy } },
    accounts: { 'acme/slack': { id: SLACK }, 'acme/resend': { id: RESEND, platform: 'resend' } },
    ...over,
  };
}

async function sendStore(policy: 'chat' | 'confirm' = 'chat') {
  const dir = tempDir();
  const time = clock();
  const config = liveConfig(dir, owners(policy));
  const store = new ApprovalStore(dir, { now: time.now, loadConfig: config.loadConfig });
  const record = await store.create({
    channel: 'gmail',
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy,
    requiredPolicy: policy,
    riskFlags: [],
    expect: EXPECT,
  });
  return { dir, time, config, store, record };
}

const claimLive = (inboxId = OWNER) => ({ inboxId, inboxSub: 'sub-1', ...LIVE, expect: EXPECT });
const bytesOf = (store: ApprovalStore, approvalId: string) =>
  readFileSync(join(store.directory, `${approvalId}.json`), 'utf8');

test('a store opened without a config loader never makes a record claimable', async () => {
  const dir = tempDir();
  const store = new ApprovalStore(dir, { now: clock().now });
  const record = await store.create({
    channel: 'gmail',
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: EXPECT,
  });
  assert.equal(record.route, 'chat');
  const { outcome } = await store.inspect(record.approvalId, { kind: 'send' });
  assert.equal(outcome.state, 'pending');
  assert.equal(outcome.claimable, false);
  assert.equal(outcome.ownerRemoved, undefined, 'no configuration is not an owner removed');
  const before = bytesOf(store, record.approvalId);
  await assert.rejects(
    store.claimForSend(record.approvalId, claimLive()),
    (e: unknown) => e instanceof CommsError && e.code === 'CONFIG' && /opened without a configuration/.test(e.message),
  );
  await assert.rejects(
    store.issueChallenge(record.approvalId),
    (e: unknown) => e instanceof CommsError && e.code === 'CONFIG',
  );
  assert.equal(bytesOf(store, record.approvalId), before, 'nothing was written');
  assert.equal(existsSync(join(store.directory, `${record.approvalId}.claim`)), false);
});

test('a claim loads the config exactly once', async () => {
  const { dir, config, record, time } = await sendStore('confirm');
  const lock = join(dir, 'approvals', `${record.approvalId}.json.lock`);
  let loads = 0;
  const store = new ApprovalStore(dir, {
    now: time.now,
    loadConfig: async () => {
      loads += 1;
      // After the record's lock is taken: the configuration it classifies by is read inside it.
      assert.ok(existsSync(lock), 'the config is read with the record lock held');
      return config.store.load();
    },
  });
  const code = await store.issueChallenge(record.approvalId);
  loads = 0;
  await store.approve(record.approvalId, 'terminal', LIVE, code);
  assert.equal(loads, 1, 'one terminal approval, one read');
  loads = 0;
  assert.equal((await store.claimForSend(record.approvalId, claimLive())).record.state, 'sending');
  assert.equal(loads, 1, 'one claim, one read');
});

test('a nonexistent, foreign, wrong-kind or other-channel id is one NOT_FOUND, byte for byte, before anything of the record is classified or written', async () => {
  const { store, record, time, config } = await sendStore();
  const change = await store.createChange({ channel: 'slack', change: CHANGE_BINDING, policy: 'chat' });
  // Past its deadline, and its owner gone: anything that classified it would write `expired` or `revoked`.
  time.advance(20 * 60_000);
  config.write(owners('chat', { inboxes: {} }));
  const before = bytesOf(store, record.approvalId);
  const envelope = async (attempt: Promise<unknown>) => {
    try {
      await attempt;
    } catch (error) {
      assert.ok(error instanceof CommsError);
      return JSON.stringify({
        code: error.code,
        message: error.message.replace(/ap_\w+/g, 'ap_ID'),
        hint: error.hint,
        details: error.details,
      });
    }
    assert.fail('refused');
  };
  const missing = `ap_${'0'.repeat(26)}`;
  const nothing = await envelope(store.claimForSend(missing, claimLive(SLACK)));
  assert.equal(await envelope(store.claimForSend(record.approvalId, claimLive(SLACK))), nothing, 'foreign');
  assert.equal(await envelope(store.claimForSend(change.approvalId, claimLive(SLACK))), nothing, 'wrong kind');
  assert.equal(
    await envelope(store.inspect(record.approvalId, { kind: 'send', owner: SLACK })),
    nothing,
    'pinned away',
  );
  // A Gmail send, given to another channel's terminal approval — pinned to its channel, not to one owner (CUE-404).
  for (const action of ['approve', 'inspect'] as const) {
    assert.equal(
      await envelope(store.inspect(record.approvalId, { kind: 'send', channel: 'slack' }, { action })),
      nothing,
      `another channel, ${action}`,
    );
  }
  assert.equal(
    await envelope(
      store.revoke(record.approvalId, 'no', { disposition: 'person', expect: { kind: 'send', owner: SLACK } }),
    ),
    nothing,
    'revoke, pinned away',
  );
  assert.deepEqual(JSON.parse(nothing).details, { approval: null });
  assert.equal(JSON.parse(nothing).code, 'NOT_FOUND');
  assert.equal(bytesOf(store, record.approvalId), before, 'nothing of it was classified or written');
});

test('removed-account Slack post, file and reaction records and a Resend record are classified with no provider at all', async () => {
  const dir = tempDir();
  const time = clock();
  const config = liveConfig(dir, owners());
  const store = new ApprovalStore(dir, { now: time.now, loadConfig: config.loadConfig });
  const make = (channel: string, inboxId: string, draftId: string) =>
    store.create({
      channel,
      inboxId,
      inboxSub: 'U_ME',
      draftId,
      draftMessageId: channel === 'resend' ? 'b'.repeat(64) : 'rev-1',
      contentDigest: 'b'.repeat(64),
      sendEpoch: 0,
      policy: 'chat',
      requiredPolicy: 'chat',
      riskFlags: [],
      expect: { to: ['#engineering'], cc: [], bcc: [], subject: '' },
    });
  const records = {
    post: await make('slack', SLACK, `dft_${'A'.repeat(22)}`),
    file: await make('slack', SLACK, `dft_${'B'.repeat(22)}`),
    reaction: await make('slack', SLACK, 'reaction:C1:1700000000.000100'),
    resend: await make('resend', RESEND, 'rsd_draft_1'),
  };
  // Both accounts removed. Nothing here can reach Slack or Resend: the store and the configuration are all there is.
  config.write(owners('chat', { accounts: {} }));
  for (const [name, record] of Object.entries(records)) {
    const before = bytesOf(store, record.approvalId);
    const { outcome } = await store.inspect(record.approvalId);
    assert.equal(outcome.state, 'revoked', name);
    assert.equal(outcome.reason, OWNER_REMOVED_REASON, name);
    assert.equal(outcome.ownerRemoved, true, name);
    assert.equal(outcome.claimable, false, name);
    assert.equal(outcome.approval.channel, record.channel, `${name}: shown with its stored channel`);
    assert.equal(bytesOf(store, record.approvalId), before, `${name}: a look writes nothing`);
  }
});

test('a Slack record is found by the account id it stores, whatever the account is called now', async () => {
  const dir = tempDir();
  const time = clock();
  const config = liveConfig(dir, owners());
  const store = new ApprovalStore(dir, { now: time.now, loadConfig: config.loadConfig });
  const post = await store.create({
    channel: 'slack',
    inboxId: SLACK,
    inboxSub: 'U_ME',
    draftId: `dft_${'A'.repeat(22)}`,
    draftMessageId: 'rev-1',
    contentDigest: 'b'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: { to: ['#engineering'], cc: [], bcc: [], subject: '' },
  });
  // Renamed: the same id under another name. Then tightened, under that name.
  config.write(owners('chat', { accounts: { 'acme/slack-ops': { id: SLACK } } }));
  const renamed = await store.inspect(post.approvalId, { kind: 'send', owner: SLACK });
  assert.equal(renamed.outcome.claimable, true);
  assert.equal(renamed.outcome.ownerRemoved, undefined);
  config.write(owners('chat', { accounts: { 'acme/slack-ops': { id: SLACK, sendPolicy: 'confirm' } } }));
  assert.equal((await store.inspect(post.approvalId)).outcome.claimable, false, 'its policy is the account’s, by id');
  config.write(owners('chat', { accounts: { 'acme/slack-ops': { id: SLACK } } }));
  const claimed = await store.claimForSend(post.approvalId, {
    inboxId: SLACK,
    inboxSub: 'U_ME',
    draftMessageId: 'rev-1',
    contentDigest: 'b'.repeat(64),
    expect: { to: ['#engineering'], cc: [], bcc: [], subject: '' },
  });
  assert.equal(claimed.record.state, 'sending');
});

test('pending, approved and used records whose owner is removed: shown so, revoked by the first action, and never owned again', async () => {
  for (const [channel, ownerId, owner] of [
    ['gmail', OWNER, { inboxes: {} }],
    ['slack', SLACK, { accounts: { 'acme/resend': { id: RESEND, platform: 'resend' } } }],
    ['resend', RESEND, { accounts: { 'acme/slack': { id: SLACK } } }],
  ] as const) {
    const dir = tempDir();
    const time = clock();
    const config = liveConfig(dir, owners('confirm'));
    const store = new ApprovalStore(dir, { now: time.now, loadConfig: config.loadConfig });
    const make = () =>
      store.create({
        channel,
        inboxId: ownerId,
        inboxSub: 'sub-1',
        draftId: 'r-draft-1',
        draftMessageId: 'msg-v1',
        contentDigest: 'a'.repeat(64),
        sendEpoch: 0,
        policy: 'confirm',
        requiredPolicy: 'confirm',
        riskFlags: [],
        expect: EXPECT,
      });
    const pending = await make();
    const approved = await make();
    await store.approve(approved.approvalId, 'terminal', LIVE, await store.issueChallenge(approved.approvalId));
    const used = await make();
    await store.approve(used.approvalId, 'terminal', LIVE, await store.issueChallenge(used.approvalId));
    const { claimToken } = await store.claimForSend(used.approvalId, claimLive(ownerId));
    await store.complete(used.approvalId, claimToken, { sentMessageId: 'sent-1' });

    config.write(owners('confirm', owner));
    for (const [record, state] of [
      [pending, 'revoked'],
      [approved, 'revoked'],
      [used, 'used'],
    ] as const) {
      const before = bytesOf(store, record.approvalId);
      const { outcome } = await store.inspect(record.approvalId);
      assert.deepEqual(
        [outcome.state, outcome.claimable, outcome.ownerRemoved],
        [state, false, true],
        `${channel} ${record.approvalId}`,
      );
      assert.equal(
        bytesOf(store, record.approvalId),
        before,
        `${channel}: no default policy or epoch applied, nothing written`,
      );
    }
    // The first locked action persists the revocation.
    await assert.rejects(
      store.claimForSend(pending.approvalId, claimLive(ownerId)),
      (e: unknown) =>
        e instanceof CommsError && e.code === 'APPROVAL_VOID' && /mailbox or account was removed/.test(e.message),
    );
    await store.revoke(approved.approvalId, 'cancelled', { disposition: 'person' });
    for (const record of [pending, approved]) {
      const written = asV2(await store.get(record.approvalId));
      assert.equal(written?.state, 'revoked', channel);
      assert.equal(written?.reason, OWNER_REMOVED_REASON, channel);
    }
    assert.equal(asV2(await store.get(used.approvalId))?.state, 'used', `${channel}: used stays used`);
    // Re-added under the same name: a new id, which owns none of them.
    const fresh = channel === 'gmail' ? 'ibx_NNNNNNNNNNNNNNNN' : 'acc_NNNNNNNNNNNNNNNN';
    config.write(
      owners(
        'chat',
        channel === 'gmail'
          ? { inboxes: { 'acme/gmail': { id: fresh } } }
          : {
              accounts: {
                'acme/slack': { id: channel === 'slack' ? fresh : SLACK },
                'acme/resend': { id: channel === 'resend' ? fresh : RESEND, platform: 'resend' },
              },
            },
      ),
    );
    for (const record of [pending, approved, used]) {
      const { outcome } = await store.inspect(record.approvalId);
      assert.equal(outcome.claimable, false, `${channel}: re-added`);
      assert.equal(outcome.ownerRemoved, true);
      await assert.rejects(
        store.claimForSend(record.approvalId, claimLive(fresh)),
        (e: unknown) => e instanceof CommsError && e.code === 'NOT_FOUND',
      );
    }
  }
});

test('wrong codes one and two leave the record pending; the third revokes it', async () => {
  const { store, record } = await sendStore('confirm');
  const code = await store.issueChallenge(record.approvalId);
  const wrong = code === 'AAAA' ? 'BBBB' : 'AAAA';
  for (const attempt of [1, 2]) {
    await assert.rejects(
      store.approve(record.approvalId, 'terminal', LIVE, wrong),
      (e: unknown) => e instanceof CommsError && e.code === 'APPROVAL_REQUIRED',
    );
    const now = asV2(await store.get(record.approvalId));
    assert.equal(now?.state, 'pending', `after wrong code ${attempt}`);
    assert.equal(now?.challengeAttempts, attempt);
  }
  await assert.rejects(
    store.approve(record.approvalId, 'terminal', LIVE, wrong),
    (e: unknown) => e instanceof CommsError && e.code === 'APPROVAL_VOID' && /too many wrong answers/.test(e.message),
  );
  assert.equal(asV2(await store.get(record.approvalId))?.state, 'revoked');
});

test('a changed draft, changed recipients or account, or a drifted plan voids at claim', async () => {
  for (const [name, live] of [
    ['draft', { ...claimLive(), draftMessageId: 'msg-v2' }],
    ['recipients', { ...claimLive(), expect: { ...EXPECT, cc: ['x@evil.test'] as string[] } }],
    ['account', { ...claimLive(), inboxSub: 'sub-2' }],
  ] as const) {
    const { store, record } = await sendStore();
    await assert.rejects(
      store.claimForSend(record.approvalId, live),
      (e: unknown) => e instanceof CommsError && e.code === 'APPROVAL_VOID',
      name,
    );
    assert.equal(asV2(await store.get(record.approvalId))?.state, 'revoked', name);
  }
  const { store } = await sendStore();
  const change = await store.createChange({ channel: 'slack', change: CHANGE_BINDING, policy: 'chat' });
  const drifted = { ...CHANGE_BINDING, effects: ['signs in to Slack again', 'and something else'] };
  assert.notEqual(changeDigest(drifted), change.contentDigest);
  await assert.rejects(
    store.claimForChange(change.approvalId, { change: drifted, policy: 'chat' }),
    (e: unknown) => e instanceof CommsError && e.code === 'APPROVAL_VOID',
  );
  assert.equal(asV2(await store.get(change.approvalId))?.state, 'revoked');
});

// ── Revoke against claim, in two processes ──────────────────────────────────────────────────────────────────────

const CHILD = fileURLToPath(new URL('./fixtures/approval-child.ts', import.meta.url));

async function child(): Promise<{
  ask: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  const proc: ChildProcess = fork(CHILD, [], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  let ready!: () => void;
  const started = new Promise<void>((settle) => {
    ready = settle;
  });
  proc.on('message', (message: Record<string, unknown>) => {
    if (message.op === 'ready') return ready();
    const settle = waiting.get(String(message.id));
    waiting.delete(String(message.id));
    settle?.(message);
  });
  await started;
  let next = 0;
  return {
    ask: (message) => {
      next += 1;
      const id = String(next);
      return new Promise((settle) => {
        waiting.set(id, settle);
        proc.send({ ...message, id });
      });
    },
    close: () => proc.kill(),
  };
}

test('revoke against claim in two processes: one locked winner, and the record says which', async () => {
  const other = await child();
  try {
    const outcomes = { claim: 0, revoke: 0 };
    for (let round = 0; round < 12; round += 1) {
      const { dir, store, record, config } = await sendStore();
      // This process revokes as the other claims, both at once.
      const [claimed, revoked] = await Promise.all([
        other.ask({
          op: 'claim',
          stateDir: dir,
          configDir: config.dir,
          approvalId: record.approvalId,
          now: T0,
          live: claimLive(),
        }),
        store.revoke(record.approvalId, 'cancelled by the person', { disposition: 'person' }),
      ]);
      const final = asV2(await store.get(record.approvalId));
      if (claimed.ok === true) {
        // The claim took the lock first: the revoke found it sending and left it so.
        outcomes.claim += 1;
        assert.equal(final?.state, 'sending', `round ${round}`);
        assert.equal(asV2(revoked)?.state, 'sending');
        assert.ok(existsSync(join(dir, 'approvals', `${record.approvalId}.claim`)));
      } else {
        // The revoke took it first: the claim was refused, and nothing was claimed.
        outcomes.revoke += 1;
        assert.equal(claimed.code, 'APPROVAL_VOID', `round ${round}`);
        assert.equal(final?.state, 'revoked');
        assert.equal(existsSync(join(dir, 'approvals', `${record.approvalId}.claim`)), false);
      }
    }
    assert.equal(outcomes.claim + outcomes.revoke, 12);
  } finally {
    other.close();
  }
});
