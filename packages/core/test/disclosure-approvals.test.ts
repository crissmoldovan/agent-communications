import assert from 'node:assert/strict';
import { test } from 'node:test';
import { publicApproval } from '../src/approval-outcome.ts';
import { ApprovalStore, type DisclosureBinding } from '../src/approvals.ts';
import { CommsError } from '../src/errors.ts';
import { tempDir } from './helpers/temp.ts';

const DIGEST = 'd'.repeat(64);
const BINDING: DisclosureBinding = {
  digest: DIGEST,
  activationIntentId: 'act_01HZZZZZZZZZZZZZZZZZZZZZZZ',
  activationKind: 'rule',
  versions: [
    { kind: 'rule', id: 'rule_invoices', version: 2 },
    { kind: 'target', id: 'target_dryrun', version: 1 },
  ],
};

function clock(start = Date.parse('2026-10-07T10:00:00.000Z')) {
  let value = start;
  return { now: () => new Date(value), advance: (milliseconds: number) => (value += milliseconds) };
}

function refusal(code: string, words: RegExp) {
  return (error: unknown) => error instanceof CommsError && error.code === code && words.test(error.message);
}

test('a disclosure approval is pending, has only its disclosure binding, and rejects a non-canonical version list', async () => {
  const time = clock();
  const store = new ApprovalStore(tempDir(), { now: time.now });
  const record = await store.createDisclosure(BINDING);

  assert.equal(record.kind, 'disclosure');
  assert.equal(record.state, 'pending');
  assert.deepEqual(record.disclosure, BINDING);
  assert.equal('channel' in record, false);
  assert.equal('inboxId' in record, false);
  assert.equal('draftId' in record, false);
  assert.equal('contentDigest' in record, false);
  assert.equal('expect' in record, false);

  await assert.rejects(
    store.createDisclosure({ ...BINDING, versions: [...BINDING.versions].reverse() }),
    refusal('BAD_DATA', /canonical/),
  );
});

test('a disclosure is approved only by a terminal or trusted app challenge, then claimed once with its persisted usedAt', async () => {
  const time = clock();
  const directory = tempDir();
  const store = new ApprovalStore(directory, { now: time.now });
  const pending = await store.createDisclosure(BINDING);

  await assert.rejects(store.claimForDisclosure(pending.approvalId, BINDING), refusal('APPROVAL_PENDING', /pending/));
  assert.equal((await store.get(pending.approvalId))?.form, 'v2');
  await assert.rejects(
    store.issueChallenge(pending.approvalId, 'disclosure'),
    refusal('APPROVAL_REQUIRED', /trusted terminal or app/),
  );
  await assert.rejects(
    store.approve(
      pending.approvalId,
      'terminal',
      { draftMessageId: 'not-a-disclosure', contentDigest: DIGEST },
      '0000',
      'disclosure',
    ),
    refusal('APPROVAL_REQUIRED', /trusted terminal or app/),
  );
  const challenge = await store.issueDisclosureChallenge(pending.approvalId);
  await assert.rejects(
    store.approveDisclosure(pending.approvalId, BINDING, challenge, 'mcp' as never),
    refusal('APPROVAL_REQUIRED', /terminal or the trusted app/),
  );

  const approved = await store.approveDisclosure(pending.approvalId, BINDING, challenge, 'app');
  assert.equal(approved.state, 'approved');
  assert.equal(approved.approvedDigest, BINDING.digest);
  assert.equal(approved.approvedVia, 'app');

  time.advance(1_000);
  const claimed = await store.claimForDisclosure(pending.approvalId, BINDING);
  assert.equal(claimed.state, 'used');
  assert.equal(claimed.usedAt, '2026-10-07T10:00:01.000Z');

  time.advance(1_000);
  const recovered = new ApprovalStore(directory, { now: time.now });
  const read = await recovered.get(pending.approvalId);
  assert.equal(read?.form, 'v2');
  if (read?.form === 'v2') assert.equal(read.record.usedAt, claimed.usedAt);
  await assert.rejects(
    recovered.claimForDisclosure(pending.approvalId, BINDING),
    refusal('APPROVAL_VOID', /used already/),
  );
});

test('a disclosure binding drift voids the record and concurrent claims use it exactly once', async () => {
  const time = clock();
  const directory = tempDir();
  const store = new ApprovalStore(directory, { now: time.now });
  const pending = await store.createDisclosure(BINDING);
  const challenge = await store.issueDisclosureChallenge(pending.approvalId);
  await assert.rejects(
    store.approveDisclosure(pending.approvalId, { ...BINDING, digest: 'e'.repeat(64) }, challenge, 'terminal'),
    refusal('APPROVAL_VOID', /binding changed/),
  );

  const next = await store.createDisclosure({ ...BINDING, activationIntentId: 'act_01HYYYYYYYYYYYYYYYYYYYYYYY' });
  const nextBinding = { ...BINDING, activationIntentId: next.disclosure.activationIntentId };
  const nextChallenge = await store.issueDisclosureChallenge(next.approvalId);
  await store.approveDisclosure(next.approvalId, nextBinding, nextChallenge, 'terminal');
  const claims = await Promise.allSettled(
    Array.from({ length: 8 }, () =>
      new ApprovalStore(directory, { now: time.now }).claimForDisclosure(next.approvalId, nextBinding),
    ),
  );
  assert.equal(claims.filter((claim) => claim.status === 'fulfilled').length, 1);
});

test('public views and generic revoke retain the disclosure discriminator without exposing its binding', async () => {
  const store = new ApprovalStore(tempDir());
  const pending = await store.createDisclosure(BINDING);
  await assert.rejects(store.inspect(pending.approvalId, { kind: 'send' }), refusal('NOT_FOUND', /no approval/));
  const inspected = await store.inspect(pending.approvalId, { kind: 'disclosure' });
  const shown = publicApproval(inspected.stored, inspected.outcome);
  assert.equal(shown.kind, 'disclosure');
  assert.equal('disclosure' in shown, false);
  assert.equal('inboxId' in shown, false);
  const revoked = await store.revoke(pending.approvalId, 'the activation was cancelled', {
    disposition: 'person',
    expect: { kind: 'disclosure' },
  });
  assert.equal(revoked.form, 'v2');
  if (revoked.form === 'v2') assert.equal(revoked.record.state, 'revoked');
});
