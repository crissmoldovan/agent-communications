import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { commitDecisionOutbox } from '../src/runtime/decisions.ts';
import type { PreparedDelivery } from '../src/runtime/deliveries.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

async function fixture() {
  const stateDir = await shortTempDir('events-outbox-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 4 WHERE singleton = 1');
  store.database
    .prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-1', ?, 'com.agentcomms.gmail.message.received.v1', 1, 'account-1', 'dedupe', 1, 1, 1)`,
    )
    .run(store.installationId);
  store.database
    .prepare(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES ('event-1', 'rule-1', 1, 10_000, X'00')`,
    )
    .run();
  return { stateDir, store };
}

function input(deliveries: readonly PreparedDelivery[]) {
  return {
    id: 'decision-1',
    eventId: 'event-1',
    accountId: 'account-1',
    ruleId: 'rule-1',
    ruleVersion: 1,
    outcome: 'matched' as const,
    metadataExpiresAt: 20_000,
    switchGeneration: 4,
    deliveries,
  };
}

const delivery: PreparedDelivery = {
  id: 'delivery-1',
  targetKey: 'dryrun:target-1:1',
  target: { targetId: 'target-1', version: 1, kind: 'dry-run', retentionMs: 60_000 },
  encryptedRecord: Buffer.from('encrypted'),
  expiresAt: 60_000,
};

test('EVAL-B1: an outbox failure rolls back its decision, every delivery, and its projection purge together', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    assert.throws(
      () =>
        commitDecisionOutbox(setup.store, input([delivery]), (point) => {
          if (point === 'after-delivery') throw new Error('simulated abrupt stop');
        }),
      /simulated abrupt stop/,
    );
    for (const table of ['decisions', 'deliveries'] as const) {
      assert.equal(
        (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
        `the rolled-back outbox has no ${table}`,
      );
    }
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      1,
      'the projection stays available for a safe retry',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('EVAL-B1: the complete delivery set and projection purge commit with their sole decision', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    commitDecisionOutbox(setup.store, input([delivery]));
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count,
      1,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
