import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ENCRYPTED_EVENT_COLUMNS } from '../src/store/aad.ts';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';
import { RECORD_LAYOUTS } from '../src/store/records.ts';

function columns(database: DatabaseSync, table: string): readonly string[] {
  return (database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function rows(database: DatabaseSync, table: string): unknown {
  return database.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all();
}

/** A v23 database with ordinary work whose children reference `deliveries` by foreign key. */
function v23WithWork(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(
    database,
    EVENT_MIGRATIONS.filter((migration) => migration.version <= 23),
  );
  database.exec(
    `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-q', 'installation', 'gmail.message.received', 1, 'ibx_QUEUEMIGRATION0', 'dedupe-q', 1, 1, 1);
     INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-q', 'event-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'matched', 999, 'retained');
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        encrypted_record, expires_at, state, switch_generation, ordering_sequence)
     VALUES
       ('delivery-dry', 'decision-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'dryrun:t:1', 't', 1, 'dry-run',
        NULL, 999, 'delivered', 3, 0),
       ('delivery-hook', 'decision-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'webhook:w:1', 'w', 1, 'webhook',
        X'0102', 999, 'queued', 3, 0);
     INSERT INTO dryrun_log
       (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
        delivered_at, expires_at)
     VALUES ('delivery-dry', 'rule-q', 1, 't', 1, 'event-q', 'ibx_QUEUEMIGRATION0', X'03', 1, 2);
     INSERT INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at)
     VALUES ('delivery-dry', 'rule-q', 1, 1);`,
  );
  return database;
}

test('QUEUE-A: v24 rebuilds deliveries to admit the queue kind, keeping every row, column and child reference', () => {
  const database = v23WithWork();
  try {
    const beforeColumns = columns(database, 'deliveries');
    const before = {
      deliveries: rows(database, 'deliveries'),
      dryrun: rows(database, 'dryrun_log'),
      charges: rows(database, 'delivery_cap_charges'),
    };
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO deliveries
               (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
                encrypted_record, expires_at, state, switch_generation)
             VALUES ('delivery-q', 'decision-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'queue:q:1', 'q', 1, 'queue',
                     X'04', 999, 'queued', 3)`,
          )
          .run(),
      /CHECK constraint failed/,
      'v23 cannot hold a queue delivery',
    );

    applyMigrations(database);

    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      String(EVENT_MIGRATIONS.at(-1)?.version),
    );
    assert.equal(EVENT_MIGRATIONS.find((migration) => migration.name === 'event-action-queue-v1')?.version, 24);
    // Migration 31 (0.33.0, the Linear target) rebuilds the table again and appends a Linear delivery's issue columns.
    const LINEAR_COLUMNS = { linear_issue_id: null, linear_identifier: null, linear_url: null };
    assert.deepEqual(
      columns(database, 'deliveries'),
      [...beforeColumns, ...Object.keys(LINEAR_COLUMNS)],
      'the rebuilt table keeps its column order',
    );
    assert.deepEqual(
      rows(database, 'deliveries'),
      (before.deliveries as readonly object[]).map((row) => Object.assign(Object.create(null), row, LINEAR_COLUMNS)),
    );
    assert.deepEqual(rows(database, 'dryrun_log'), before.dryrun);
    assert.deepEqual(rows(database, 'delivery_cap_charges'), before.charges);
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(
      (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys,
      1,
      'the migration leaves foreign keys enforced as it found them',
    );
    assert.ok(
      database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'deliveries_stable_order'").get(),
      'the stable-order index is recreated',
    );
    database
      .prepare(
        `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
            encrypted_record, expires_at, state, switch_generation)
         VALUES ('delivery-q', 'decision-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'queue:q:1', 'q', 1, 'queue',
                 X'04', 999, 'queued', 3)`,
      )
      .run();
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO deliveries
               (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
                encrypted_record, expires_at, state, switch_generation)
             VALUES ('delivery-x', 'decision-q', 'ibx_QUEUEMIGRATION0', 'rule-q', 1, 'x:q:1', 'q', 1, 'broker',
                     X'04', 999, 'queued', 3)`,
          )
          .run(),
      /CHECK constraint failed/,
      'the kind stays a closed set',
    );
    // A child still names its delivery: removing a referenced delivery is refused as it was before.
    assert.throws(
      () => database.prepare("DELETE FROM deliveries WHERE id = 'delivery-dry'").run(),
      /FOREIGN KEY constraint failed/,
    );
  } finally {
    database.close();
  }
});

test('QUEUE-A: v24 adds the content-free-keyed queue_items table with one encrypted column under its primary key', () => {
  const database = v23WithWork();
  try {
    applyMigrations(database);
    assert.deepEqual(columns(database, 'queue_items'), [
      'id',
      'delivery_id',
      'decision_id',
      'event_id',
      'rule_id',
      'rule_version',
      'target_id',
      'target_version',
      'account_id',
      'channel',
      'whatsapp_message_id',
      'state',
      'state_at',
      'arrived_at',
      'appended_at',
      'retention_ms',
      'expires_at',
      'row_expires_at',
      'released',
      'encrypted_record',
    ]);
    assert.ok(
      RECORD_LAYOUTS.some((layout) => layout.table === 'queue_items' && layout.sqlColumn === 'encrypted_record'),
    );
    assert.equal(ENCRYPTED_EVENT_COLUMNS['queue_items.encryptedRecord'], 1);
    const insert = (id: string, overrides: Record<string, unknown> = {}) => {
      const row = {
        id,
        delivery_id: 'delivery-hook',
        state: 'open',
        appended_at: 10,
        retention_ms: 86_400_000,
        expires_at: 10 + 86_400_000,
        row_expires_at: 10 + 2 * 86_400_000,
        channel: 'gmail',
        ...overrides,
      };
      database
        .prepare(
          `INSERT INTO queue_items
             (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id,
              channel, state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at, released,
              encrypted_record)
           VALUES (?, ?, 'decision-q', 'event-q', 'rule-q', 1, 'w', 1, 'ibx_QUEUEMIGRATION0', ?, ?, 10, 5, ?, ?, ?, ?, 0,
                   X'05')`,
        )
        .run(
          row.id,
          row.delivery_id,
          row.channel,
          row.state,
          row.appended_at,
          row.retention_ms,
          row.expires_at,
          row.row_expires_at,
        );
    };
    insert('qi_00000000000000000000000000');
    for (const [id, overrides] of [
      ['not-an-item-id', {}],
      ['qi_00000000000000000000000001', { state: 'archived' }],
      ['qi_00000000000000000000000002', { channel: 'email' }],
      ['qi_00000000000000000000000003', { retention_ms: 31 * 86_400_000, expires_at: 10 + 31 * 86_400_000 }],
      ['qi_00000000000000000000000004', { expires_at: 5 }],
      ['qi_00000000000000000000000005', { row_expires_at: 100 }],
    ] as const)
      assert.throws(() => insert(id, overrides), /constraint failed/, id);
    assert.throws(
      () => insert('qi_00000000000000000000000006'),
      /UNIQUE constraint failed/,
      'one delivery appends at most one item',
    );
  } finally {
    database.close();
  }
});
