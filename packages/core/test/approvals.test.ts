import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import {
  type ApprovalRecord,
  ApprovalStore,
  type ChangeBinding,
  changeDigest,
  type Expectation,
  publicView,
} from '../src/approvals.ts';
import { CommsError } from '../src/errors.ts';
import { APPROVAL_ID_PATTERN } from '../src/ids.ts';
import { tempDir } from './helpers/temp.ts';

const INBOX = 'ibx_AAAAAAAAAAAAAAAA';
const OTHER_INBOX = 'ibx_BBBBBBBBBBBBBBBB';
const EXPECT: Expectation = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };
const LIVE_DRAFT = { draftMessageId: 'msg-v1', digest: 'digest-A' };

function clock(start = Date.parse('2026-09-18T10:00:00.000Z')) {
  let t = start;
  return { now: () => new Date(t), advance: (ms: number) => (t += ms) };
}

async function setup(policy: 'chat' | 'confirm' = 'chat', escalated = false) {
  const time = clock();
  const store = new ApprovalStore(tempDir(), { now: time.now });
  const record = await store.create({
    inboxId: INBOX,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    digest: 'digest-A',
    policy,
    requiredPolicy: escalated ? 'confirm' : policy,
    riskFlags: escalated ? ['tainted-recipient'] : [],
    expect: EXPECT,
  });
  return { store, record, time };
}

const live = (overrides: Partial<Parameters<ApprovalStore['claimForSend']>[1]> = {}) => ({
  inboxId: INBOX,
  inboxSub: 'sub-1',
  ...LIVE_DRAFT,
  policy: 'chat' as const,
  expect: EXPECT,
  ...overrides,
});

function isRefusal(pattern: RegExp, code?: string) {
  return (e: unknown) =>
    e instanceof CommsError && (code === undefined || e.code === code) && e.exitCode === 10 && pattern.test(e.message);
}

async function humanApproves(store: ApprovalStore, id: string, draft = LIVE_DRAFT) {
  const challenge = await store.issueChallenge(id);
  return store.approve(id, 'terminal', draft, challenge.toLowerCase());
}

test('a new record is pending, has no challenge until one is issued, and expires after ten minutes', async () => {
  const { store, record, time } = await setup();
  assert.match(record.approvalId, APPROVAL_ID_PATTERN);
  assert.equal(record.challengeHash, undefined);
  assert.equal(record.state, 'pending');
  time.advance(10 * 60 * 1000);
  assert.equal((await store.get(record.approvalId))?.state, 'expired');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/expired/, 'APPROVAL_EXPIRED'));
});

test('chat: the matching draft is claimed once, then completed; later claims are refused', async () => {
  const { store, record } = await setup();
  assert.equal((await store.claimForSend(record.approvalId, live())).state, 'sending');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/is sending/));
  assert.equal((await store.complete(record.approvalId, { sentMessageId: 'sent-1' })).state, 'used');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/is used/));
});

test('parallel claims from many stores ("processes"): exactly one wins', async () => {
  const { store, record, time } = await setup();
  const stateDir = store.directory.replace(/[/\\]approvals$/, '');
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      new ApprovalStore(stateDir, { now: time.now }).claimForSend(record.approvalId, live()),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('a display name around the same address is not a different recipient', async () => {
  const { store, record } = await setup();
  // The provider returns what it parsed; the caller gave bare addresses. Same people, so the approval still holds.
  const claimed = await store.claimForSend(
    record.approvalId,
    live({ expect: { ...EXPECT, to: EXPECT.to.map((address) => `Sam Lee <${address}>`) } }),
  );
  assert.equal(claimed.state, 'sending');
});

test('integrity failures void the record for good; each carries its specific code', async () => {
  const cases: [string, Partial<ReturnType<typeof live>>, RegExp, string][] = [
    ['A→B→A swap restores content, not the message id', { draftMessageId: 'msg-v3' }, /edited after/, 'APPROVAL_VOID'],
    ['content changed', { digest: 'digest-B' }, /content changed/, 'APPROVAL_VOID'],
    ['other inbox', { inboxId: OTHER_INBOX }, /different inbox/, 'APPROVAL_VOID'],
    ['other account', { inboxSub: 'sub-2' }, /different account/, 'APPROVAL_VOID'],
    ['no account named at all', { inboxSub: undefined }, /could not be confirmed/, 'APPROVAL_VOID'],
    ['recipients differ', { expect: { ...EXPECT, bcc: ['x@evil.test'] } }, /do not match/, 'APPROVAL_VOID'],
    ['policy tightened to never', { policy: 'never' }, /policy: never/, 'POLICY_NEVER'],
  ];
  for (const [name, overrides, message, code] of cases) {
    const { store, record } = await setup();
    await assert.rejects(store.claimForSend(record.approvalId, live(overrides)), isRefusal(message, code), name);
    assert.equal(((await store.get(record.approvalId)) as ApprovalRecord).state, 'revoked', `${name}: voided`);
    await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/voided/, 'APPROVAL_VOID'), name);
  }
});

test('expect comparison ignores order and case but not content', async () => {
  const { store, record } = await setup();
  const reordered = { ...EXPECT, to: ['SAM@partner.test'] };
  assert.equal((await store.claimForSend(record.approvalId, live({ expect: reordered }))).state, 'sending');
});

test('confirm: a claim before approval is refused without voiding; after a human approves, it succeeds', async () => {
  const { store, record } = await setup('confirm');
  await assert.rejects(
    store.claimForSend(record.approvalId, live({ policy: 'confirm' })),
    isRefusal(/outside the chat/, 'APPROVAL_PENDING'),
  );
  assert.equal((await store.get(record.approvalId))?.state, 'pending', 'still approvable');
  const approved = await humanApproves(store, record.approvalId);
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedDigest, 'digest-A');
  assert.equal(approved.challengeHash, undefined, 'the challenge is spent');
  assert.equal((await store.claimForSend(record.approvalId, live({ policy: 'confirm' }))).state, 'sending');
});

test('a claim waiting for a person says what the product making it tells it to, and no product by default', async () => {
  // The store is shared by every product and the command that approves is not: its own default named
  // `agent-gmail approve`, so a Slack post held for approval sent the agent to a command that could not approve it.
  const { store, record } = await setup('confirm');
  const hint = async (options?: Parameters<ApprovalStore['claimForSend']>[2]) => {
    try {
      await store.claimForSend(record.approvalId, live({ policy: 'confirm' }), options);
    } catch (error) {
      assert.ok(error instanceof CommsError && error.code === 'APPROVAL_PENDING');
      return error.hint ?? '';
    }
    assert.fail('the claim should wait for a person');
  };
  assert.equal(
    await hint({ pendingHint: 'Run the product’s own approve command.' }),
    'Run the product’s own approve command.',
  );
  const neutral = await hint();
  assert.match(neutral, /approve/);
  assert.doesNotMatch(neutral, /gmail|slack/i, 'a default that names a product is wrong for every other one');
  assert.equal((await store.get(record.approvalId))?.state, 'pending', 'and asking twice changed nothing');
});

test('an escalated chat send needs a human approval; a looser live policy never relaxes it', async () => {
  const { store, record } = await setup('chat', true);
  assert.equal(record.requiredPolicy, 'confirm');
  await assert.rejects(
    store.claimForSend(record.approvalId, live()),
    isRefusal(/outside the chat/, 'APPROVAL_PENDING'),
  );
  await humanApproves(store, record.approvalId);
  assert.equal((await store.claimForSend(record.approvalId, live())).state, 'sending');
});

test('a record that requires "never" is refused, whatever the live policy says', async () => {
  // The gap this closes: the effective policy was only compared against `confirm`, so a record carrying
  // `requiredPolicy: never` — a policy that was tightened after the preview, or an escalation that decided this
  // must not go at all — fell straight through to being claimed from `pending`.
  const time = clock();
  const store = new ApprovalStore(tempDir(), { now: time.now });
  const record = await store.create({
    inboxId: INBOX,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    digest: 'digest-A',
    policy: 'chat',
    requiredPolicy: 'never',
    riskFlags: ['policy-tightened'],
    expect: EXPECT,
  });
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/turned off/, 'POLICY_NEVER'));
  assert.equal((await store.get(record.approvalId))?.state, 'revoked');

  // And a human approval does not rescue it either: `never` means never.
  const second = await store.create({
    inboxId: INBOX,
    inboxSub: 'sub-1',
    draftId: 'r-draft-2',
    draftMessageId: 'msg-v1',
    digest: 'digest-A',
    policy: 'chat',
    requiredPolicy: 'never',
    riskFlags: [],
    expect: EXPECT,
  });
  await humanApproves(store, second.approvalId);
  await assert.rejects(store.claimForSend(second.approvalId, live()), isRefusal(/turned off/, 'POLICY_NEVER'));
});

test('approving content that changed since prepare voids the record (the human would see something else)', async () => {
  const { store, record } = await setup('confirm');
  const challenge = await store.issueChallenge(record.approvalId);
  await assert.rejects(
    store.approve(record.approvalId, 'terminal', { draftMessageId: 'msg-v2', digest: 'digest-HARMLESS' }, challenge),
    isRefusal(/changed after the preview/, 'APPROVAL_VOID'),
  );
  assert.equal((await store.get(record.approvalId))?.state, 'revoked');
});

test('challenges: case-insensitive, never exposed, three wrong answers void the record', async () => {
  const { store, record } = await setup('confirm');
  const challenge = await store.issueChallenge(record.approvalId);
  assert.match(challenge, /^[A-Z]{4}$/);
  const stored = (await store.get(record.approvalId)) as ApprovalRecord;
  assert.ok(stored.challengeHash && !stored.challengeHash.includes(challenge));
  assert.equal('challengeHash' in publicView(stored), false, 'listings never carry the challenge hash');
  const wrong = challenge === 'AAAA' ? 'BBBB' : 'AAAA';
  const approve = (answer: string) => store.approve(record.approvalId, 'terminal', LIVE_DRAFT, answer);
  await assert.rejects(approve(wrong), isRefusal(/did not match/, 'APPROVAL_REQUIRED'));
  await assert.rejects(approve(wrong), isRefusal(/did not match/, 'APPROVAL_REQUIRED'));
  await assert.rejects(approve(wrong), isRefusal(/too many wrong/, 'APPROVAL_VOID'));
  assert.equal((await store.get(record.approvalId))?.state, 'revoked');
  await assert.rejects(approve(challenge), isRefusal(/voided/, 'APPROVAL_VOID'));
});

test('approving without an issued challenge is refused', async () => {
  const { store, record } = await setup('confirm');
  await assert.rejects(
    store.approve(record.approvalId, 'terminal', LIVE_DRAFT, 'ABCD'),
    isRefusal(/no challenge was issued/),
  );
});

test('a send left in "sending" by a dead process reads as unknown and can still record its outcome', async () => {
  const { store, record, time } = await setup();
  await store.claimForSend(record.approvalId, live());
  time.advance(5 * 60 * 1000);
  assert.equal((await store.get(record.approvalId))?.state, 'unknown');
  assert.equal((await store.complete(record.approvalId, { sentMessageId: 's1' })).state, 'used');
});

test('the O_EXCL claim marker refuses a second claim even if the record file were reset', async () => {
  const { store, record } = await setup();
  await store.claimForSend(record.approvalId, live());
  const path = join(store.directory, `${record.approvalId}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), state: 'pending' }));
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/already claimed/, 'APPROVAL_VOID'));
});

test('failed sends are recorded; revoke leaves finished records alone', async () => {
  const { store, record } = await setup();
  await store.claimForSend(record.approvalId, live());
  assert.equal((await store.complete(record.approvalId, { error: 'backendError' })).state, 'failed');
  assert.equal((await store.revoke(record.approvalId, 'user')).state, 'failed');
});

test('create ignores caller-supplied ids, states and challenges', async () => {
  const { store, record } = await setup();
  const sneaky = {
    ...record,
    state: 'approved',
    approvedDigest: 'digest-A',
    challengeHash: 'x',
  } as unknown as Parameters<ApprovalStore['create']>[0];
  const created = await store.create(sneaky);
  assert.notEqual(created.approvalId, record.approvalId);
  assert.equal(created.state, 'pending');
  assert.equal(created.approvedDigest, undefined);
  assert.equal(created.challengeHash, undefined);
  assert.equal((await store.get(record.approvalId))?.state, 'pending', 'the original is untouched');
});

test('list filters by inbox and state; malformed ids are refused before touching the file system', async () => {
  const { store, record } = await setup();
  const second = await store.create({ ...record, inboxId: OTHER_INBOX });
  await store.revoke(second.approvalId, 'user');
  assert.deepEqual(
    (await store.list({ inboxId: INBOX })).map((r) => r.approvalId),
    [record.approvalId],
  );
  assert.equal((await store.list({ states: ['revoked'] })).length, 1);
  await assert.rejects(store.get('../../config'), (e: unknown) => e instanceof CommsError && e.code === 'USAGE');
});

/** A change approval in the same store: `acme/slack` widened from read to send. */
const CHANGE: ChangeBinding = {
  summary: 'Let acme/slack post',
  target: { kind: 'account', name: 'acme/slack', id: 'acc_AAAAAAAAAAAAAAAA' },
  loosened: [{ path: 'accounts.acme/slack.mode', before: 'read', after: 'send', id: 'acc_AAAAAAAAAAAAAAAA' }],
  effects: ['signs in to Slack again'],
};

test('a change approval is never spent as a send, nor a send approval as a change — and trying harms neither', async () => {
  const { store, record: send } = await setup();
  const change = await store.createChange({ change: CHANGE, policy: 'chat' });
  assert.equal(change.kind, 'change');
  assert.equal(send.kind, undefined, 'a send record is written exactly as it was before changes had approvals');

  const wrongKind = (pattern: RegExp) => (e: unknown) =>
    e instanceof CommsError && e.code === 'USAGE' && pattern.test(e.message);
  const asSend = /nothing was sent: approval ap_\w+ is for a configuration change, not a send/;
  const asChange = /nothing was changed: approval ap_\w+ is for a send, not a configuration change/;

  // Every door a send uses refuses a change's approval: the challenge, the typed approval and the claim.
  await assert.rejects(store.issueChallenge(change.approvalId), wrongKind(asSend), 'issueChallenge');
  await assert.rejects(store.approve(change.approvalId, 'terminal', LIVE_DRAFT, 'ABCD'), wrongKind(asSend), 'approve');
  await assert.rejects(store.claimForSend(change.approvalId, live()), wrongKind(asSend), 'claimForSend');
  // And the doors a change uses refuse a send's.
  await assert.rejects(store.issueChallenge(send.approvalId, 'change'), wrongKind(asChange), 'issueChallenge change');
  await assert.rejects(
    store.approve(send.approvalId, 'terminal', LIVE_DRAFT, 'ABCD', 'change'),
    wrongKind(asChange),
    'approve change',
  );
  await assert.rejects(
    store.claimForChange(send.approvalId, { change: CHANGE, policy: 'chat' }),
    wrongKind(asChange),
    'claimForChange',
  );

  // Neither was voided or consumed by the attempts: each still works for what it is.
  assert.equal((await store.get(send.approvalId))?.state, 'pending');
  assert.equal((await store.get(change.approvalId))?.state, 'pending');
  assert.equal((await store.claimForSend(send.approvalId, live())).state, 'sending');
  assert.equal((await store.claimForChange(change.approvalId, { change: CHANGE, policy: 'chat' })).state, 'used');
});

test('a change approval is claimed once, even if its record file were reset', async () => {
  const { store } = await setup();
  const change = await store.createChange({ change: CHANGE, policy: 'chat' });
  const claim = () => store.claimForChange(change.approvalId, { change: CHANGE, policy: 'chat' });
  assert.equal((await claim()).state, 'used');
  await assert.rejects(
    claim(),
    (e: unknown) => e instanceof CommsError && /nothing was changed: the approval is used/.test(e.message),
  );
  const path = join(store.directory, `${change.approvalId}.json`);
  writeFileSync(path, JSON.stringify({ ...JSON.parse(readFileSync(path, 'utf8')), state: 'pending' }));
  await assert.rejects(claim(), isRefusal(/nothing was changed: this approval was already claimed/, 'APPROVAL_VOID'));
});

test('a change approval is bound to a digest the store computes, of the change it stores', async () => {
  const { store } = await setup();
  const change = await store.createChange({ change: CHANGE, policy: 'confirm' });
  assert.equal(change.digest, changeDigest(CHANGE));
  assert.equal(change.draftMessageId, change.digest, 'the digest stands in for a draft revision, as a reaction’s does');
  assert.equal(change.inboxId, 'acc_AAAAAAAAAAAAAAAA');
  assert.equal(change.requiredPolicy, 'confirm');
  // The order the classifier lists loosenings in does not matter; the values, the account and the effects do.
  const two = {
    ...CHANGE,
    loosened: [...CHANGE.loosened, { path: 'defaults.sendPolicy', before: 'confirm', after: 'chat' }],
  };
  assert.equal(changeDigest(two), changeDigest({ ...two, loosened: [...two.loosened].reverse() }));
  assert.notEqual(changeDigest(CHANGE), changeDigest({ ...CHANGE, effects: [] }));
  assert.notEqual(
    changeDigest(CHANGE),
    changeDigest({ ...CHANGE, target: { kind: 'account', name: 'acme/slack', id: 'acc_BBBBBBBBBBBBBBBB' } }),
  );
  const reworded: ChangeBinding = { ...CHANGE, summary: 'worded differently' };
  assert.equal(changeDigest(CHANGE), changeDigest(reworded), 'the summary is not bound');
});
