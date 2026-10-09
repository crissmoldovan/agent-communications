import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

test('B2-T8: the B2-first stream migration is standalone, nullable, indexed, and usable before the D occurrence parent exists', () => {
  const migration = EVENT_MIGRATIONS.at(-1);
  assert.ok(migration);
  assert.equal(migration.version, 9);
  assert.equal(migration.name, 'event-sse-stream-log-v1');
  const sql = migration.statements.join('\n');
  assert.match(sql, /CREATE TABLE stream_log/);
  assert.match(sql, /whatsapp_message_id TEXT/);
  assert.match(sql, /whatsapp_visibility_version INTEGER/);
  assert.match(sql, /whatsapp_message_id IS NULL AND whatsapp_visibility_version IS NULL/);
  assert.match(sql, /whatsapp_message_id IS NOT NULL AND whatsapp_visibility_version IS NOT NULL/);
  assert.match(sql, /CREATE INDEX stream_log_account_whatsapp_message/);
  assert.doesNotMatch(sql, /REFERENCES whatsapp_occurrences/);

  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    const parent = database
      .prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_occurrences'")
      .get() as { count: number };
    assert.equal(parent.count, 0, 'the B2-first path does not create a D-owned placeholder');
    database.exec(`INSERT INTO ingest
      (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
      VALUES ('event-1', 'installation-1', 'example.event', 1, 'account-1', 'dedupe-1', 1, 1, 1);
      INSERT INTO decisions
      (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
      VALUES ('decision-1', 'event-1', 'account-1', 'rule-1', 1, 'matched', 999, 'retained');
      INSERT INTO deliveries
      (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
       encrypted_record, expires_at, state, switch_generation)
      VALUES ('delivery-1', 'decision-1', 'account-1', 'rule-1', 1, 'sse:target-1:1:subscriber-1:1',
              'target-1', 1, X'01', 999, 'delivered', 7);`);
    database
      .prepare(
        `INSERT INTO stream_log
         (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
          event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at, expires_at,
          switch_generation)
         VALUES ('stream-1', 'delivery-1', 'rule-1', 1, 'target-1', 1, 'subscriber-1', 1,
                 'event-1', 'account-1', NULL, NULL, X'01', 100, 200, 7)`,
      )
      .run();
    assert.equal(
      (
        database.prepare("SELECT encrypted_record FROM stream_log WHERE id = 'stream-1'").get() as {
          encrypted_record: Uint8Array;
        }
      ).encrypted_record[0],
      1,
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO stream_log
             (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
              event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at, expires_at,
              switch_generation)
             VALUES ('stream-invalid', 'delivery-2', 'rule-1', 1, 'target-1', 1, 'subscriber-1', 1,
                     'event-2', 'account-1', 'message-1', NULL, X'01', 100, 200, 7)`,
          )
          .run(),
      /CHECK constraint failed/,
    );
  } finally {
    database.close();
  }
});

test(
  'B2-T8: D-dependent direct-FK and convergence migration vectors are explicitly skipped until D supplies its immutable fixture',
  {
    skip: 'Phase D has not landed on this branch',
  },
  () => undefined,
);
