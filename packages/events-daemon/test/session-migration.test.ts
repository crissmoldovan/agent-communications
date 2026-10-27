import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

/**
 * Migration 32 (0.33.0 design §3.5): deliveries admit the session kind, the busy queue and the chosen sessions are
 * content-free and go with their delivery, and a lane's binding follows a session target that finds by the lane.
 */

const SESSION = 'sess_0f8fad5b-d9cb-469f-a165-70867728950e';

function columns(database: DatabaseSync, table: string): readonly string[] {
  return (database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

function v31WithWork(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  applyMigrations(
    database,
    EVENT_MIGRATIONS.filter((migration) => migration.version <= 31),
  );
  database.exec(
    `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-s', 'installation', 'gmail.message.received', 1, 'ibx_SESSIONMIGRATE0', 'dedupe-s', 1, 1, 1);
     INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-s', 'event-s', 'ibx_SESSIONMIGRATE0', 'rule-s', 1, 'matched', 999, 'retained');
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        encrypted_record, expires_at, state, switch_generation, ordering_sequence)
     VALUES ('delivery-queue', 'decision-s', 'ibx_SESSIONMIGRATE0', 'rule-s', 1, 'queue:q:1', 'q', 1, 'queue',
             X'0102', 999, 'queued', 3, 0);`,
  );
  return database;
}

const insertSessionDelivery = (database: DatabaseSync, id: string) =>
  database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          target_representation, encrypted_record, expires_at, state, switch_generation)
       VALUES (?, 'decision-s', 'ibx_SESSIONMIGRATE0', 'rule-s', 1, ?, 's', 1, 'session', 'enveloped', X'04', 999,
               'queued', 3)`,
    )
    .run(id, `session:s:1:${id}`);

test('SESSION-M1: v32 rebuilds deliveries to admit the session kind, keeping every row and column', () => {
  const database = v31WithWork();
  try {
    const beforeColumns = columns(database, 'deliveries');
    const before = database.prepare('SELECT * FROM deliveries ORDER BY rowid').all();
    assert.throws(() => insertSessionDelivery(database, 'delivery-early'), /CHECK constraint failed/u);
    applyMigrations(database);
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      String(EVENT_MIGRATIONS.at(-1)?.version),
    );
    assert.equal(EVENT_MIGRATIONS.find((migration) => migration.name === 'agent-session-target-v1')?.version, 32);
    // Migration 34 (0.36.0, workflows) rebuilds the table once more and appends a flow delivery's run and step.
    const FLOW_COLUMNS = { run_id: null, step_id: null };
    assert.deepEqual(columns(database, 'deliveries'), [...beforeColumns, ...Object.keys(FLOW_COLUMNS)]);
    assert.deepEqual(
      database.prepare('SELECT * FROM deliveries ORDER BY rowid').all(),
      (before as readonly object[]).map((row) => Object.assign(Object.create(null), row, FLOW_COLUMNS)),
    );
    insertSessionDelivery(database, 'delivery-session');
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
    // Every column of the new tables is an id, a number or a time: nothing a sender wrote.
    assert.deepEqual(columns(database, 'session_queue'), [
      'delivery_id',
      'relay_session_id',
      'rule_id',
      'rule_version',
      'target_id',
      'target_version',
      'queued_at',
      'released_at',
    ]);
    assert.deepEqual(columns(database, 'session_deliveries'), [
      'delivery_id',
      'relay_session_id',
      'started',
      'run_id',
      'chosen_at',
    ]);
  } finally {
    database.close();
  }
});

test('SESSION-M2: a busy-queue row goes with its delivery, whichever way the delivery stops being tried', () => {
  const database = v31WithWork();
  try {
    applyMigrations(database);
    for (const [id, state] of [
      ['d-delivered', 'delivered'],
      ['d-cancelled', 'cancelled'],
      ['d-expired', 'retention-expired'],
      ['d-disabled', 'in-flight-at-disable'],
      ['d-waiting', 'retryable'],
    ] as const) {
      insertSessionDelivery(database, id);
      database
        .prepare(
          `INSERT INTO session_queue (delivery_id, relay_session_id, rule_id, rule_version, target_id, target_version,
                                      queued_at) VALUES (?, ?, 'rule-s', 1, 's', 1, 5)`,
        )
        .run(id, SESSION);
      database
        .prepare(
          `UPDATE deliveries SET state = ?, encrypted_record = CASE WHEN ? IN ('retryable') THEN encrypted_record END
           WHERE id = ?`,
        )
        .run(state, state, id);
    }
    assert.deepEqual(
      (database.prepare('SELECT delivery_id FROM session_queue').all() as Array<{ delivery_id: string }>).map(
        (row) => row.delivery_id,
      ),
      ['d-waiting'],
      'only the delivery that may still be tried keeps its place',
    );
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO session_queue (delivery_id, relay_session_id, rule_id, rule_version, target_id,
                                        target_version, queued_at) VALUES ('x', 'not-a-session', 'r', 1, 't', 1, 1)`,
          )
          .run(),
      /CHECK constraint failed/u,
    );
  } finally {
    database.close();
  }
});

test('SESSION-M3: a lane binding follows a session target that finds its session by the lane', () => {
  const database = v31WithWork();
  try {
    applyMigrations(database);
    const sessionTarget = JSON.stringify({ targetId: 's', version: 1, kind: 'session', find: { lane: 'david' } });
    const plain = JSON.stringify({ targetId: 'd', version: 1, kind: 'dry-run', retentionMs: 1 });
    database.exec(
      `INSERT INTO rule_versions (id, rule_id, version, digest, document)
       VALUES ('rv-1', 'rule-s', 1, 'digest-1', '{"targets":[${sessionTarget}]}'),
              ('rv-2', 'rule-s', 2, 'digest-2', '{"targets":[${plain}]}');
       INSERT INTO active_versions (kind, object_id, version, activated_at) VALUES ('rule', 'rule-s', 1, 1);
       INSERT INTO lane_bindings (lane, binding_id, activity_key, since) VALUES ('david', 'b1', '0123456789abcdef', 1);`,
    );
    database.exec("UPDATE active_versions SET version = 1 WHERE kind = 'rule' AND object_id = 'rule-s'");
    assert.equal(
      (database.prepare('SELECT COUNT(*) AS count FROM lane_bindings').get() as { count: number }).count,
      1,
      "a session target's lane keeps its binding",
    );
    database.exec("UPDATE active_versions SET version = 2 WHERE kind = 'rule' AND object_id = 'rule-s'");
    assert.equal(
      (database.prepare('SELECT COUNT(*) AS count FROM lane_bindings').get() as { count: number }).count,
      0,
      'the binding ends when no active rule carries the lane',
    );
  } finally {
    database.close();
  }
});
