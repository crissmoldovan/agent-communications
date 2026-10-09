import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';

function migration(name: string): EventMigration {
  const found = EVENT_MIGRATIONS.find((candidate) => candidate.name === name);
  assert.ok(found, `${name} is registered`);
  return found;
}

function through(version: number): readonly EventMigration[] {
  return EVENT_MIGRATIONS.filter((candidate) => candidate.version <= version);
}

function seedDelivery(
  database: DatabaseSync,
  id: string,
  input: Readonly<{
    accountId: string;
    messageId: string | null;
    visibilityVersion: number | null;
    record: Uint8Array;
  }>,
): void {
  database.exec(`INSERT INTO ingest
    (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
    VALUES ('event-${id}', 'installation-${id}', 'example.event', 1, '${input.accountId}', 'dedupe-${id}', 1, 1, 1);
    INSERT INTO decisions
    (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
    VALUES ('decision-${id}', 'event-${id}', '${input.accountId}', 'rule-${id}', 1, 'matched', 999, 'retained');
    INSERT INTO deliveries
    (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
     encrypted_record, expires_at, state, switch_generation)
    VALUES ('delivery-${id}', 'decision-${id}', '${input.accountId}', 'rule-${id}', 1,
            'sse:target-${id}:1:subscriber-${id}:1', 'target-${id}', 1, X'01', 999, 'delivered', 7);`);
  database
    .prepare(
      `INSERT INTO stream_log
       (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
        event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
        expires_at, switch_generation)
       VALUES (?, ?, ?, 1, ?, 1, ?, 1, ?, ?, ?, ?, ?, 100, 200, 7)`,
    )
    .run(
      `stream-${id}`,
      `delivery-${id}`,
      `rule-${id}`,
      `target-${id}`,
      `subscriber-${id}`,
      `event-${id}`,
      input.accountId,
      input.messageId,
      input.visibilityVersion,
      input.record,
    );
}

test('B2-T8: v9 remains standalone and v11 converges a real v10 stream table without changing encrypted rows', () => {
  const standalone = migration('event-sse-stream-log-v1');
  const d = migration('event-multisource-authority-v1');
  const convergence = migration('event-sse-stream-log-whatsapp-occurrence-v1');
  assert.equal(standalone.version, 9);
  assert.equal(d.version, 10);
  assert.equal(convergence.version, 11);
  const v9Sql = standalone.statements.join('\n');
  assert.match(v9Sql, /CREATE TABLE stream_log/u);
  assert.match(v9Sql, /whatsapp_message_id TEXT/u);
  assert.match(v9Sql, /whatsapp_visibility_version INTEGER/u);
  assert.match(v9Sql, /CREATE INDEX stream_log_account_whatsapp_message/u);
  assert.doesNotMatch(v9Sql, /REFERENCES whatsapp_occurrences/u);

  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, through(9));
    seedDelivery(database, 'plain-before-d', {
      accountId: 'account-plain',
      messageId: null,
      visibilityVersion: null,
      record: Buffer.from([1, 2, 3, 4]),
    });
    const before = Buffer.from(
      (
        database.prepare("SELECT encrypted_record FROM stream_log WHERE id = 'stream-plain-before-d'").get() as {
          encrypted_record: Uint8Array;
        }
      ).encrypted_record,
    );

    applyMigrations(database, through(10));
    database
      .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, 1)')
      .run('account-whatsapp', 'a'.repeat(64));
    database
      .prepare(
        `INSERT INTO whatsapp_occurrences
         (account_id, message_id, first_seen_generation, first_seen_at, visibility_version)
         VALUES ('account-whatsapp', 'message-present', 1, 1, 1)`,
      )
      .run();

    applyMigrations(database, through(11));
    const streamSql = (
      database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'stream_log'").get() as {
        sql: string;
      }
    ).sql;
    assert.match(
      streamSql,
      /FOREIGN KEY \(account_id, whatsapp_message_id\)\s+REFERENCES whatsapp_occurrences\(account_id, message_id\)/u,
    );
    assert.match(streamSql, /whatsapp_message_id IS NULL AND whatsapp_visibility_version IS NULL/u);
    assert.ok(
      database
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'stream_log_account_whatsapp_message'")
        .get(),
      'the visibility purge index survives the rebuild',
    );
    assert.deepEqual(
      Buffer.from(
        (
          database.prepare("SELECT encrypted_record FROM stream_log WHERE id = 'stream-plain-before-d'").get() as {
            encrypted_record: Uint8Array;
          }
        ).encrypted_record,
      ),
      before,
      'the v10 encrypted stream row survives v11 byte-for-byte',
    );

    assert.throws(
      () =>
        seedDelivery(database, 'missing-parent', {
          accountId: 'account-whatsapp',
          messageId: 'message-missing',
          visibilityVersion: 1,
          record: Buffer.from([8]),
        }),
      /FOREIGN KEY constraint failed/u,
    );
    seedDelivery(database, 'present-parent', {
      accountId: 'account-whatsapp',
      messageId: 'message-present',
      visibilityVersion: 1,
      record: Buffer.from([9]),
    });
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});
