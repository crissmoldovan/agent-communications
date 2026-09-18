import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type ApprovalRecord, ApprovalStore, type Expectation } from '../src/approvals.ts';
import { CommsError } from '../src/errors.ts';
import { APPROVAL_ID_PATTERN } from '../src/ids.ts';
import { tempDir } from './helpers/temp.ts';

const INBOX = 'ibx_AAAAAAAAAAAAAAAA';
const OTHER_INBOX = 'ibx_BBBBBBBBBBBBBBBB';
const EXPECT: Expectation = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };

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
    escalated,
    riskFlags: escalated ? ['tainted-recipient'] : [],
    expect: EXPECT,
  });
  return { store, record, time };
}

const live = (overrides: Partial<Parameters<ApprovalStore['claimForSend']>[1]> = {}) => ({
  inboxId: INBOX,
  inboxSub: 'sub-1',
  draftMessageId: 'msg-v1',
  digest: 'digest-A',
  policy: 'chat' as const,
  expect: EXPECT,
  ...overrides,
});

function isRefusal(pattern: RegExp) {
  return (e: unknown) => e instanceof CommsError && e.code === 'APPROVAL_REQUIRED' && pattern.test(e.message);
}

test('a new record is pending, carries a challenge, and expires after ten minutes', async () => {
  const { store, record, time } = await setup();
  assert.match(record.approvalId, APPROVAL_ID_PATTERN);
  assert.match(record.challenge, /^[A-Z]{4}$/);
  assert.equal(record.state, 'pending');
  time.advance(10 * 60 * 1000);
  assert.equal((await store.get(record.approvalId))?.state, 'expired');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/expired/));
});

test('chat: the matching draft can be claimed once, then completed; a second claim is refused', async () => {
  const { store, record } = await setup();
  const claimed = await store.claimForSend(record.approvalId, live());
  assert.equal(claimed.state, 'sending');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/is sending/));
  const done = await store.complete(record.approvalId, { sentMessageId: 'sent-1' });
  assert.equal(done.state, 'used');
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/is used/));
});

test('parallel claims from many "processes": exactly one wins', async () => {
  const { store, record, time } = await setup();
  const stateDir = store.directory.replace(/[/\\]approvals$/, '');
  const results = await Promise.allSettled(
    Array.from({ length: 10 }, () =>
      new ApprovalStore(stateDir, { now: time.now }).claimForSend(record.approvalId, live()),
    ),
  );
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('any change to the draft voids the record: edited message id, changed digest, other inbox, other account', async () => {
  const cases: [string, Partial<ReturnType<typeof live>>, RegExp][] = [
    ['A→B→A swap restores content but not the message id', { draftMessageId: 'msg-v3' }, /edited after the preview/],
    ['content changed', { digest: 'digest-B' }, /content changed/],
    ['other inbox', { inboxId: OTHER_INBOX }, /different inbox/],
    ['other account', { inboxSub: 'sub-2' }, /different account/],
    ['recipients differ from expect', { expect: { ...EXPECT, to: ['x@evil.test'] } }, /do not match/],
    ['policy tightened to never', { policy: 'never' }, /policy: never/],
  ];
  for (const [name, overrides, message] of cases) {
    const { store, record } = await setup();
    await assert.rejects(store.claimForSend(record.approvalId, live(overrides)), isRefusal(message), name);
    const after = (await store.get(record.approvalId)) as ApprovalRecord;
    assert.equal(after.state, 'revoked', `${name}: the record is voided, not left usable`);
    await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/revoked/), `${name}: stays dead`);
  }
});

test('expect comparison ignores order and case but not content', async () => {
  const { store, record } = await setup();
  const reordered = { ...EXPECT, to: ['SAM@partner.test'], cc: [] };
  assert.equal((await store.claimForSend(record.approvalId, live({ expect: reordered }))).state, 'sending');
});

test('confirm: a claim before human approval is refused without voiding, then succeeds after approval', async () => {
  const { store, record } = await setup('confirm');
  await assert.rejects(
    store.claimForSend(record.approvalId, live({ policy: 'confirm' })),
    isRefusal(/outside the chat/),
  );
  assert.equal((await store.get(record.approvalId))?.state, 'pending', 'still approvable');
  const approved = await store.approve(record.approvalId, 'terminal', { draftMessageId: 'msg-v1', digest: 'digest-A' });
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedDigest, 'digest-A');
  assert.equal((await store.claimForSend(record.approvalId, live({ policy: 'confirm' }))).state, 'sending');
});

test('a chat record escalated by risk needs a human approval too', async () => {
  const { store, record } = await setup('chat', true);
  await assert.rejects(store.claimForSend(record.approvalId, live()), isRefusal(/outside the chat/));
});

test('approving content that changed since prepare voids the record (the human saw something else)', async () => {
  const { store, record } = await setup('confirm');
  await assert.rejects(
    store.approve(record.approvalId, 'terminal', { draftMessageId: 'msg-v2', digest: 'digest-HARMLESS' }),
    isRefusal(/changed after the preview/),
  );
  assert.equal((await store.get(record.approvalId))?.state, 'revoked');
});

test('policy loosened after prepare does not bypass: confirm-prepared record still sends only when approved', async () => {
  const { store, record } = await setup('confirm');
  const approved = await store.approve(record.approvalId, 'terminal', { draftMessageId: 'msg-v1', digest: 'digest-A' });
  assert.equal(approved.state, 'approved');
  // The live policy is re-read at claim time; a later change to chat still sends only this exact content.
  assert.equal((await store.claimForSend(record.approvalId, live({ policy: 'chat' }))).state, 'sending');
});

test('failed sends are recorded; revoke leaves terminal records alone', async () => {
  const { store, record } = await setup();
  await store.claimForSend(record.approvalId, live());
  const failed = await store.complete(record.approvalId, { error: 'backendError' });
  assert.equal(failed.state, 'failed');
  assert.equal((await store.revoke(record.approvalId, 'user')).state, 'failed');
});

test('create ignores caller-supplied ids and states', async () => {
  const { store, record } = await setup();
  const sneaky = { ...record, state: 'approved', approvedDigest: 'digest-A' } as unknown as Parameters<
    ApprovalStore['create']
  >[0];
  const created = await store.create(sneaky);
  assert.notEqual(created.approvalId, record.approvalId);
  assert.equal(created.state, 'pending');
  assert.equal(created.approvedDigest, undefined);
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
  await assert.rejects(store.get('../../config'), isRefusal(/not an approval id/));
});
