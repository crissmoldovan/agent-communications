import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

/**
 * 0.32.0 (owner feedback §3.5): every delivery started with `next_at = 0`, and the dry-run, queue and SSE dispatchers left
 * it there when they delivered, so the app showed "next try 1 January 1970". The dispatchers now clear it; this
 * migration clears it on the rows they left behind. Only a row that may still be tried keeps its time.
 */

const MIGRATION = 'event-delivery-next-at-terminal-v1';

const STATES = [
  ['queued', 0],
  ['retryable', 1_700_000_000_000],
  ['disclosing', 0],
  ['delivered', 0],
  ['dead-lettered', 0],
  ['retention-expired', 0],
  ['cancelled', 0],
  ['content-unreadable', 0],
  ['in-flight-at-disable', 0],
  ['in-flight-at-account-removal', 0],
] as const;

function before(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const found = EVENT_MIGRATIONS.find((migration) => migration.name === MIGRATION);
  assert.ok(found, `the ${MIGRATION} migration exists`);
  applyMigrations(
    database,
    EVENT_MIGRATIONS.filter((migration) => migration.version < found.version),
  );
  database.exec(
    `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-n', 'installation', 'gmail.message.received', 1, 'ibx_NEXTATMIGRATION0', 'dedupe-n', 1, 1, 1);
     INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-n', 'event-n', 'ibx_NEXTATMIGRATION0', 'rule-n', 1, 'matched', 999, 'retained');`,
  );
  const insert = database.prepare(
    `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        encrypted_record, next_at, expires_at, state, switch_generation)
     VALUES (?, 'decision-n', 'ibx_NEXTATMIGRATION0', 'rule-n', 1, ?, 't', 1, 'dry-run', ?, ?, 999, ?, 1)`,
  );
  for (const [state, nextAt] of STATES) {
    const payload = state === 'queued' || state === 'retryable' || state === 'disclosing' ? Buffer.from('x') : null;
    insert.run(`delivery-${state}`, `dryrun:t:${state}`, payload, nextAt, state);
  }
  return database;
}

test('0.32 B1: the migration clears next_at on every row that will not be tried again, and keeps it on the rest', () => {
  const database = before();
  try {
    applyMigrations(database);
    const rows = Object.fromEntries(
      (
        database.prepare('SELECT state, next_at FROM deliveries ORDER BY rowid').all() as Array<{
          state: string;
          next_at: number | null;
        }>
      ).map((row) => [row.state, row.next_at]),
    );
    assert.deepEqual(rows, {
      queued: 0,
      retryable: 1_700_000_000_000,
      disclosing: null,
      delivered: null,
      'dead-lettered': null,
      'retention-expired': null,
      cancelled: null,
      'content-unreadable': null,
      'in-flight-at-disable': null,
      'in-flight-at-account-removal': null,
    });
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      String(EVENT_MIGRATIONS.at(-1)?.version),
    );
  } finally {
    database.close();
  }
});
