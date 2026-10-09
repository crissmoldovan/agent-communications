import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { allocateDeliveryOrderSequence, claimDelivery, completeDeliveryClaim } from '../src/runtime/delivery-claim.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('B2-T5: rule and target replacements share one stable order through recovery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-claim-order-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `UPDATE event_settings SET enabled = 1, switch_generation = 0;
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES
         ('rule-order@1', 'rule-order', 1, '{"deliveryRateCap":20}', 'digest', 'superseded', 'approval', 'activation', 1),
         ('rule-order@2', 'rule-order', 2, '{"deliveryRateCap":20}', 'digest', 'active', 'approval', 'activation', 2);
       INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES
         ('target-order@1', 'target-order', 1, '{}', 'digest'),
         ('target-order@2', 'target-order', 2, '{}', 'digest');
       INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES
         ('event-order-1', 'installation', 'example.event', 1, 'account-order', 'dedupe-1', 1, 1, 1),
         ('event-order-2', 'installation', 'example.event', 1, 'account-order', 'dedupe-2', 2, 2, 2);
       INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES
         ('decision-order-1', 'event-order-1', 'account-order', 'rule-order', 1, 'matched', 999999, 'retained'),
         ('decision-order-2', 'event-order-2', 'account-order', 'rule-order', 2, 'matched', 999999, 'retained');`,
    );
    const firstSequence = allocateDeliveryOrderSequence(store.database, {
      ruleId: 'rule-order',
      accountId: 'account-order',
      targetId: 'target-order',
    });
    const secondSequence = allocateDeliveryOrderSequence(store.database, {
      ruleId: 'rule-order',
      accountId: 'account-order',
      targetId: 'target-order',
    });
    assert.deepEqual([firstSequence, secondSequence], [0, 1]);
    store.database.exec(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation, ordering_sequence)
       VALUES
         ('older', 'decision-order-1', 'account-order', 'rule-order', 1, 'webhook:target-order:1',
          'target-order', 1, X'01', 999999, 'queued', 0, ${firstSequence}),
         ('later', 'decision-order-2', 'account-order', 'rule-order', 2, 'webhook:target-order:2',
          'target-order', 2, X'01', 999999, 'queued', 0, ${secondSequence});`,
    );
    const options = (deliveryId: string, now: number, attempt: string, token: string) => ({
      store,
      deliveryId,
      now,
      leaseMs: 10,
      newAttemptId: () => attempt,
      newLeaseToken: () => token,
      assertAccountLive: async () => undefined,
    });
    const older = await claimDelivery(options('older', 100, 'attempt-old-1', 'token-old-1'));
    assert.equal(older.kind, 'claimed');
    assert.deepEqual(await claimDelivery(options('later', 101, 'attempt-later', 'token-later')), {
      kind: 'waiting-order',
    });
    const recovered = await claimDelivery(options('older', 111, 'attempt-old-2', 'token-old-2'));
    assert.equal(recovered.kind, 'claimed');
    assert.equal(recovered.claim.orderingSequence, firstSequence, 'recovery preserves the first sequence');
    assert.notEqual(recovered.claim.leaseToken, older.claim.leaseToken, 'recovery fences the stale owner');
    assert.equal(
      completeDeliveryClaim(
        store,
        { ...recovered.claim, leaseToken: 'fake-lease-forged' },
        { state: 'delivered', clearRecord: true },
      ),
      false,
      'the current attempt id alone cannot settle a lease',
    );
    assert.equal(
      completeDeliveryClaim(
        store,
        { ...recovered.claim, attemptId: 'attempt-forged' },
        { state: 'delivered', clearRecord: true },
      ),
      false,
      'the current lease token alone cannot settle a lease',
    );
    assert.equal(
      completeDeliveryClaim(store, older.claim, { state: 'delivered', clearRecord: true }),
      false,
      'a former owner cannot settle the recovered lease',
    );
    assert.deepEqual(await claimDelivery(options('later', 112, 'attempt-later', 'token-later')), {
      kind: 'waiting-order',
    });
    assert.equal(completeDeliveryClaim(store, recovered.claim, { state: 'delivered', clearRecord: true }), true);
    const later = await claimDelivery(options('later', 113, 'attempt-later', 'token-later'));
    assert.equal(later.kind, 'claimed');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
