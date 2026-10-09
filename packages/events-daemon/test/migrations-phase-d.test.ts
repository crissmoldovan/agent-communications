import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const D_TABLES = [
  'slack_reply_drains',
  'resend_status_state',
  'whatsapp_visibility',
  'whatsapp_snapshot_heads',
  'whatsapp_snapshot_keys',
  'whatsapp_occurrences',
  'whatsapp_rule_admissions',
] as const;

function phaseDMigration(): EventMigration {
  const migration = EVENT_MIGRATIONS.find((candidate) => candidate.name === 'event-multisource-authority-v1');
  assert.ok(migration, 'the D authority migration is registered');
  assert.equal(migration.name, 'event-multisource-authority-v1');
  return migration;
}

function b2FirstMigrations(): readonly EventMigration[] {
  return EVENT_MIGRATIONS.filter((candidate) => candidate.version <= 9);
}

function columnNames(database: DatabaseSync, table: string): readonly string[] {
  return (database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function tableSql(database: DatabaseSync, table: string): string {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  assert.ok(row, `${table} exists`);
  return row.sql;
}

function schema(
  database: DatabaseSync,
  table: string,
): readonly { readonly type: string; readonly name: string; readonly sql: string }[] {
  return database
    .prepare('SELECT type, name, sql FROM sqlite_master WHERE tbl_name = ? ORDER BY type, name')
    .all(table) as Array<{ type: string; name: string; sql: string }>;
}

function finalB2Fixture(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(database, b2FirstMigrations());
  database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('gmail-before-d', 'install-before-d', 'gmail.message.received', 1, 'ibx_before_d', 'dedupe-before-d', 1, 1, 1)`,
    )
    .run();
  return database;
}

function insertB2StreamRow(database: DatabaseSync): void {
  database.exec(
    `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('stream-decision', 'gmail-before-d', 'ibx_before_d', 'stream-rule', 1, 'matched', 1000, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation)
       VALUES ('stream-delivery', 'stream-decision', 'ibx_before_d', 'stream-rule', 1,
               'sse:stream-target:1:stream-subscriber:1', 'stream-target', 1, X'01020304', 1000, 'delivered', 7);
       INSERT INTO stream_log
         (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
          event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
          expires_at, switch_generation)
       VALUES ('stream-preserved', 'stream-delivery', 'stream-rule', 1, 'stream-target', 1, 'stream-subscriber', 1,
               'gmail-before-d', 'ibx_before_d', NULL, NULL, X'01020304', 1, 1000, 7)`,
  );
}

test('D9: the next free migration upgrades the final B1 fixture once, keeps prior rows readable, and declares only D-owned state', {
  skip: WINDOWS_SKIP,
}, () => {
  const dMigration = phaseDMigration();
  assert.equal(dMigration.version, 10, 'D owns the B2-first next free migration version');
  assert.doesNotMatch(
    dMigration.statements.join('\n'),
    /\bstream_log\b/u,
    'D v10 declares D-owned state only and leaves B2 stream schema to B2',
  );
  const database = finalB2Fixture();
  try {
    applyMigrations(database, [...b2FirstMigrations(), dMigration]);
    const gmailBeforeD = database
      .prepare('SELECT event_id, account_id FROM ingest WHERE event_id = ?')
      .get('gmail-before-d') as {
      event_id: string;
      account_id: string;
    };
    assert.deepEqual(
      { event_id: gmailBeforeD.event_id, account_id: gmailBeforeD.account_id },
      { event_id: 'gmail-before-d', account_id: 'ibx_before_d' },
      'a prior Gmail record remains readable',
    );
    const migrationLedger = (
      database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
        name: string;
      }>
    ).map(({ version, name }) => ({ version, name }));
    assert.deepEqual(
      migrationLedger,
      [...b2FirstMigrations(), dMigration].map((migration) => ({ version: migration.version, name: migration.name })),
    );
    for (const table of D_TABLES) assert.match(tableSql(database, table), /STRICT$/);

    assert.deepEqual(columnNames(database, 'slack_reply_drains'), [
      'intent_id',
      'account_id',
      'conversation_id',
      'thread_ts',
      'cursor',
      'covered_through',
      'drained_at',
    ]);
    assert.deepEqual(columnNames(database, 'resend_status_state'), [
      'account_id',
      'email_id',
      'last_event',
      'observed_at',
      'expires_at',
    ]);
    assert.deepEqual(columnNames(database, 'whatsapp_visibility'), [
      'account_id',
      'version',
      'lists_digest',
      'changed_at',
    ]);
    assert.deepEqual(columnNames(database, 'whatsapp_snapshot_heads'), [
      'account_id',
      'committed_generation',
      'visibility_version',
    ]);
    assert.deepEqual(columnNames(database, 'whatsapp_snapshot_keys'), [
      'account_id',
      'generation',
      'visibility_version',
      'chat_jid',
      'sender_jid_raw',
      'stanza_id',
    ]);
    assert.deepEqual(columnNames(database, 'whatsapp_occurrences'), [
      'account_id',
      'message_id',
      'first_seen_generation',
      'first_seen_at',
      'visibility_version',
      'staged_payload_ref',
      'stage_expires_at',
      'event_id',
    ]);
    assert.deepEqual(columnNames(database, 'whatsapp_rule_admissions'), [
      'account_id',
      'message_id',
      'rule_id',
      'rule_version',
      'admission',
      'activation_id',
      'visibility_version',
      'admitted_at',
    ]);
    assert.deepEqual(columnNames(database, 'ingest_rules').slice(-2), [
      'whatsapp_visibility_version',
      'whatsapp_message_id',
    ]);
    assert.equal(columnNames(database, 'decisions').at(-1), 'whatsapp_message_id');
    assert.deepEqual(columnNames(database, 'deliveries').slice(-2), [
      'whatsapp_visibility_version',
      'whatsapp_message_id',
    ]);
    assert.equal(columnNames(database, 'dryrun_log').at(-1), 'whatsapp_message_id');

    assert.match(
      tableSql(database, 'whatsapp_snapshot_keys'),
      /CHECK \(chat_jid <> '' AND sender_jid_raw <> '' AND stanza_id <> ''\)/,
    );
    assert.match(tableSql(database, 'whatsapp_occurrences'), /CHECK \(message_id <> ''\)/);
    assert.match(
      tableSql(database, 'whatsapp_occurrences'),
      /CHECK \(\(staged_payload_ref IS NULL AND stage_expires_at IS NULL\) OR \(staged_payload_ref IS NOT NULL AND stage_expires_at IS NOT NULL\)\)/,
    );
    assert.match(
      tableSql(database, 'whatsapp_rule_admissions'),
      /CHECK \(admission IN \('baseline', 'admitted', 'suppressed', 'expired'\)\)/,
    );
    assert.match(tableSql(database, 'resend_status_state'), /CHECK \(expires_at > observed_at\)/);
    assert.ok(
      schema(database, 'resend_status_state').some(
        (entry) => entry.type === 'index' && entry.name === 'resend_status_state_expires_at',
      ),
      'the seven-day Resend status expiry has its own index',
    );
    assert.deepEqual(
      database.prepare('PRAGMA foreign_key_check').all(),
      [],
      'the final-D fixture has no dangling D-owned foreign keys',
    );

    const beforeSecondOpen = migrationLedger;
    applyMigrations(database, [...b2FirstMigrations(), dMigration]);
    const afterSecondOpen = (
      database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
        version: number;
        name: string;
      }>
    ).map(({ version, name }) => ({ version, name }));
    assert.deepEqual(afterSecondOpen, beforeSecondOpen);
  } finally {
    database.close();
  }
});

test('D9: a raw WhatsApp snapshot key is unique within its account generation', {
  skip: WINDOWS_SKIP,
}, () => {
  const database = finalB2Fixture();
  try {
    applyMigrations(database, [...b2FirstMigrations(), phaseDMigration()]);
    database
      .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, 1)')
      .run('whatsapp-keys', 'a'.repeat(64));
    const insert = database.prepare(
      `INSERT INTO whatsapp_snapshot_keys
       (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
       VALUES ('whatsapp-keys', 1, 1, 'chat@example.test', 'sender@example.test', 'stanza-1')`,
    );
    insert.run();
    assert.throws(() => insert.run(), /UNIQUE constraint failed/);
  } finally {
    database.close();
  }
});

test('D11: a rebased D migration adds the WhatsApp parent without reading, rebuilding, or changing a B2-first stream row', {
  skip: WINDOWS_SKIP,
}, () => {
  const dMigration = phaseDMigration();
  const database = finalB2Fixture();
  try {
    insertB2StreamRow(database);
    const beforeSchema = schema(database, 'stream_log');
    const beforeRecord = database
      .prepare('SELECT encrypted_record FROM stream_log WHERE id = ?')
      .get('stream-preserved') as {
      encrypted_record: Uint8Array;
    };
    applyMigrations(database, [...b2FirstMigrations(), dMigration]);

    assert.ok(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'whatsapp_occurrences'").get(),
    );
    assert.deepEqual(schema(database, 'stream_log'), beforeSchema, "D v10 never reads or rewrites B2's stream table");
    const afterRecord = database
      .prepare('SELECT encrypted_record FROM stream_log WHERE id = ?')
      .get('stream-preserved') as {
      encrypted_record: Uint8Array;
    };
    assert.deepEqual(Buffer.from(afterRecord.encrypted_record), Buffer.from(beforeRecord.encrypted_record));
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});
