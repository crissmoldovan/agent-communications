import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { claimDelivery, completeDeliveryClaim } from '../src/runtime/delivery-claim.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT_ID = 'account-claim';
const RULE_ID = 'rule-claim';
const TARGET_ID = 'target-claim';

async function fixture() {
  const stateDir = await shortTempDir('events-b2-claim-cap-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec(
    `UPDATE event_settings SET enabled = 1, switch_generation = 0;
     INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES ('rule-claim@1', '${RULE_ID}', 1, '{"deliveryRateCap":1}', 'digest', 'active', 'approval', 'activation', 1);
     INSERT INTO target_versions (id, target_id, version, document, digest)
     VALUES ('target-claim@1', '${TARGET_ID}', 1, '{}', 'digest');
     INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-claim', 'installation', 'example.event', 1, '${ACCOUNT_ID}', 'dedupe-claim', 1, 1, 1);
     INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-claim', 'event-claim', '${ACCOUNT_ID}', '${RULE_ID}', 1, 'matched', 999999, 'retained');`,
  );
  const insert = (id: string, sequence: number) => {
    store.database
      .prepare(
        `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, 'installation', 'example.event', 1, ?, ?, 1, 1, 1)`,
      )
      .run(`event-${id}`, ACCOUNT_ID, `dedupe-${id}`);
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'matched', 999999, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT_ID, RULE_ID);
    store.database
      .prepare(
        `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation, ordering_sequence)
         VALUES (?, ?, ?, ?, 1, 'dryrun:${TARGET_ID}:1', ?, 1, X'01', 9999999, 'queued', 0, ?)`,
      )
      .run(id, `decision-${id}`, ACCOUNT_ID, RULE_ID, TARGET_ID, sequence);
  };
  insert('first', 0);
  insert('second', 1);
  return { stateDir, store };
}

test('B2-T5: cap and reset-barrier blocks create no attempt, lease, charge, append, or ciphertext mutation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let store = setup.store;
  try {
    store.database
      .prepare("INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state) VALUES (1, ?, 1, 'closed')")
      .run(TARGET_ID);
    const blocked = await claimDelivery({
      store,
      deliveryId: 'first',
      now: 100,
      leaseMs: 50,
      newAttemptId: () => 'attempt-1',
      newLeaseToken: () => 'token-1',
      assertAccountLive: async () => undefined,
    });
    assert.deepEqual(blocked, { kind: 'waiting-reset' });
    const unchanged = store.database
      .prepare(
        "SELECT state, attempts, attempt_id, lease_token, lease_until, encrypted_record FROM deliveries WHERE id = 'first'",
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...unchanged, encrypted_record: Buffer.from(unchanged.encrypted_record as Uint8Array) },
      {
        state: 'queued',
        attempts: 0,
        attempt_id: null,
        lease_token: null,
        lease_until: null,
        encrypted_record: Buffer.from([1]),
      },
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM dryrun_log').get() as { count: number }).count,
      0,
      'a blocked claim does not begin an append',
    );

    // The state survives restart and every not-open state is a barrier, not a best-effort advisory.
    store.close();
    store = await openEventDatabase({ stateDir: setup.stateDir });
    store.database.exec("UPDATE reset_barriers SET state = 'degraded' WHERE reset_epoch = 1");
    assert.deepEqual(
      await claimDelivery({
        store,
        deliveryId: 'first',
        now: 100,
        leaseMs: 50,
        newAttemptId: () => 'attempt-degraded',
        newLeaseToken: () => 'token-degraded',
        assertAccountLive: async () => undefined,
      }),
      { kind: 'waiting-reset' },
    );

    store.database.exec("UPDATE reset_barriers SET state = 'open' WHERE reset_epoch = 1");
    const claimed = await claimDelivery({
      store,
      deliveryId: 'first',
      now: 100,
      leaseMs: 50,
      newAttemptId: () => 'attempt-1',
      newLeaseToken: () => 'token-1',
      assertAccountLive: async () => undefined,
    });
    assert.equal(claimed.kind, 'claimed');
    if (claimed.kind === 'claimed')
      assert.equal(completeDeliveryClaim(store, claimed.claim, { state: 'delivered', clearRecord: true }), true);
    const capBlocked = await claimDelivery({
      store,
      deliveryId: 'second',
      now: 3_600_099,
      leaseMs: 50,
      newAttemptId: () => 'attempt-2',
      newLeaseToken: () => 'token-2',
      assertAccountLive: async () => undefined,
    });
    assert.deepEqual(capBlocked, { kind: 'waiting-cap' });
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT state, attempts, attempt_id, lease_token, lease_until FROM deliveries WHERE id = 'second'")
          .get() as Record<string, unknown>),
      },
      { state: 'queued', attempts: 0, attempt_id: null, lease_token: null, lease_until: null },
    );
    const capEdge = await claimDelivery({
      store,
      deliveryId: 'second',
      now: 3_600_100,
      leaseMs: 50,
      newAttemptId: () => 'attempt-2-edge',
      newLeaseToken: () => 'token-2-edge',
      assertAccountLive: async () => undefined,
    });
    assert.equal(capEdge.kind, 'claimed', 'a charge exactly one cap window ago no longer blocks the next claim');
  } finally {
    store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
