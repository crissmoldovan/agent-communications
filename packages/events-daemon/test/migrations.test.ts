import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { encodeAad } from '../src/store/aad.ts';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';
import { RECORD_LAYOUTS } from '../src/store/records.ts';

test('SEC-B1: an interruption at every migration statement leaves neither its schema nor its ledger version committed', () => {
  const migration: EventMigration = {
    version: 1,
    name: 'atomic-test',
    statements: [
      'CREATE TABLE atomic_fixture (id TEXT PRIMARY KEY) STRICT',
      "INSERT INTO atomic_fixture (id) VALUES ('one')",
    ],
  };
  for (const failingStatement of migration.statements.keys()) {
    const database = new DatabaseSync(':memory:');
    try {
      assert.throws(
        () =>
          applyMigrations(database, [migration], {
            beforeStatement({ statementIndex }) {
              if (statementIndex === failingStatement) throw new Error('injected migration failure');
            },
          }),
        /injected migration failure/,
      );
      const fixture = database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'atomic_fixture'")
        .get() as { count: number } | undefined;
      const ledger = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as
        | { count: number }
        | undefined;
      assert.ok(fixture);
      assert.ok(ledger);
      assert.equal(fixture.count, 0, `statement ${failingStatement}`);
      assert.equal(ledger.count, 0, `statement ${failingStatement}`);
    } finally {
      database.close();
    }
  }
});

test('SEC-B1: every statement in each real authority migration is atomic with its ledger entry', () => {
  for (const migration of EVENT_MIGRATIONS) {
    for (const failingStatement of migration.statements.keys()) {
      const database = new DatabaseSync(':memory:');
      try {
        applyMigrations(
          database,
          EVENT_MIGRATIONS.filter((candidate) => candidate.version < migration.version),
        );
        assert.throws(
          () =>
            applyMigrations(database, EVENT_MIGRATIONS, {
              beforeStatement(context) {
                if (context.migration.version === migration.version && context.statementIndex === failingStatement) {
                  throw new Error('injected event migration failure');
                }
              },
            }),
          /injected event migration failure/,
        );
        const ledger = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
        assert.equal(
          ledger.count,
          migration.version - 1,
          `migration ${migration.version}, statement ${failingStatement}`,
        );
      } finally {
        database.close();
      }
    }
  }
});

test('SEC-B1: every event migration starts with an immediate writer transaction', async () => {
  const source = await readFile(new URL('../src/store/migrations.ts', import.meta.url), 'utf8');
  assert.match(source, /database\.exec\('BEGIN IMMEDIATE'\)/);
});

test('B2-T3: the forward secret-generation migration preserves B1 and binds each opaque reference to its exact slot AAD', () => {
  const database = new DatabaseSync(':memory:');
  try {
    const b1 = EVENT_MIGRATIONS.filter((migration) => migration.version <= 5);
    applyMigrations(database, b1);
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      '5',
    );
    applyMigrations(
      database,
      EVENT_MIGRATIONS.filter((migration) => migration.version <= 6),
    );
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      '6',
    );
    const columns = database
      .prepare("SELECT name, type, pk FROM pragma_table_info('event_secret_generations')")
      .all() as Array<{
      name: string;
      type: string;
      pk: number;
    }>;
    assert.deepEqual(
      columns
        .filter((column) => column.pk > 0)
        .sort((left, right) => left.pk - right.pk)
        .map((column) => column.name),
      ['owner_kind', 'owner_id', 'owner_version', 'purpose', 'generation'],
    );
    assert.equal(columns.find((column) => column.name === 'encrypted_ref')?.type, 'BLOB');
    assert.ok(
      RECORD_LAYOUTS.some(
        (layout) =>
          layout.table === 'event_secret_generations' &&
          layout.column === 'encryptedReference' &&
          layout.sqlColumn === 'encrypted_ref',
      ),
    );
    const url = encodeAad('event_secret_generations', 'encryptedReference', [
      { type: 'text', value: 'target' },
      { type: 'text', value: 'target-1' },
      { type: 'integer', value: 1 },
      { type: 'text', value: 'secret-url' },
      { type: 'integer', value: 1 },
    ]);
    const signingCurrent = encodeAad('event_secret_generations', 'encryptedReference', [
      { type: 'text', value: 'target' },
      { type: 'text', value: 'target-1' },
      { type: 'integer', value: 1 },
      { type: 'text', value: 'webhook-signing' },
      { type: 'integer', value: 2 },
    ]);
    const signingPrevious = encodeAad('event_secret_generations', 'encryptedReference', [
      { type: 'text', value: 'target' },
      { type: 'text', value: 'target-1' },
      { type: 'integer', value: 1 },
      { type: 'text', value: 'webhook-signing' },
      { type: 'integer', value: 1 },
    ]);
    const bearerCurrent = encodeAad('event_secret_generations', 'encryptedReference', [
      { type: 'text', value: 'subscriber' },
      { type: 'text', value: 'subscriber-1' },
      { type: 'integer', value: 1 },
      { type: 'text', value: 'sse-bearer' },
      { type: 'integer', value: 2 },
    ]);
    const bearerPrevious = encodeAad('event_secret_generations', 'encryptedReference', [
      { type: 'text', value: 'subscriber' },
      { type: 'text', value: 'subscriber-1' },
      { type: 'integer', value: 1 },
      { type: 'text', value: 'sse-bearer' },
      { type: 'integer', value: 1 },
    ]);
    for (const value of [signingCurrent, signingPrevious, bearerCurrent, bearerPrevious])
      assert.notDeepEqual(value, url);
  } finally {
    database.close();
  }
});

test('B2-T4: v7 preserves a B1-only reset barrier and gives system-reset ciphertext one exact AAD location', () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(
      database,
      EVENT_MIGRATIONS.filter((migration) => migration.version <= 6),
    );
    database.exec(
      `INSERT INTO reset_notices (id, reset_epoch, target_id, target_version, created_at)
       VALUES ('b1-reset', 2, 'target-migration', 1, 1);
       INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, reset_delivery_id)
       VALUES (2, 'target-migration', 1, 'closed', 'b1-reset');`,
    );
    applyMigrations(
      database,
      EVENT_MIGRATIONS.filter((migration) => migration.version <= 7),
    );
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      '7',
    );
    assert.deepEqual(
      {
        ...(database
          .prepare(
            'SELECT reset_delivery_id, system_outbox_id FROM reset_barriers WHERE reset_epoch = 2 AND target_id = ?',
          )
          .get('target-migration') as { reset_delivery_id: string; system_outbox_id: string | null }),
      },
      { reset_delivery_id: 'b1-reset', system_outbox_id: null },
    );
    const columns = database
      .prepare("SELECT name, type, pk FROM pragma_table_info('system_reset_outbox')")
      .all() as Array<{ name: string; type: string; pk: number }>;
    assert.deepEqual(
      columns.filter((column) => column.pk > 0).map((column) => column.name),
      ['id'],
    );
    assert.equal(columns.find((column) => column.name === 'encrypted_record')?.type, 'BLOB');
    assert.ok(
      RECORD_LAYOUTS.some(
        (layout) =>
          layout.table === 'system_reset_outbox' &&
          layout.column === 'encryptedRecord' &&
          layout.sqlColumn === 'encrypted_record',
      ),
    );
    assert.ok(
      encodeAad('system_reset_outbox', 'encryptedRecord', [{ type: 'text', value: 'system-reset-migration' }])
        .byteLength > 0,
    );
    assert.throws(() => encodeAad('system_reset_outbox', 'encryptedRecord', []), /needs 1 primary-key components/);
  } finally {
    database.close();
  }
});

test('B2-T5: v8 backfills one stable rule/account/target order across replacement versions', () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(
      database,
      EVENT_MIGRATIONS.filter((migration) => migration.version <= 7),
    );
    database.exec(
      `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES
         ('rule-migration@1', 'rule-migration', 1, '{}', 'digest', 'superseded', 'approval', 'activation', 1),
         ('rule-migration@2', 'rule-migration', 2, '{}', 'digest', 'active', 'approval', 'activation', 2);
       INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES
         ('target-migration@1', 'target-migration', 1, '{}', 'digest'),
         ('target-migration@2', 'target-migration', 2, '{}', 'digest');
       INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES
         ('event-migration-1', 'installation', 'example.event', 1, 'account-migration', 'dedupe-1', 1, 1, 1),
         ('event-migration-2', 'installation', 'example.event', 1, 'account-migration', 'dedupe-2', 2, 2, 2);
       INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES
         ('decision-migration-1', 'event-migration-1', 'account-migration', 'rule-migration', 1, 'matched', 999, 'retained'),
         ('decision-migration-2', 'event-migration-2', 'account-migration', 'rule-migration', 2, 'matched', 999, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation, ordering_sequence)
       VALUES
         ('delivery-migration-1', 'decision-migration-1', 'account-migration', 'rule-migration', 1,
          'webhook:target-migration:1', 'target-migration', 1, X'01', 999, 'queued', 0, 0),
         ('delivery-migration-2', 'decision-migration-2', 'account-migration', 'rule-migration', 2,
          'webhook:target-migration:2', 'target-migration', 2, X'01', 999, 'queued', 0, 0);`,
    );
    applyMigrations(database);
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      '11',
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT id, ordering_sequence FROM deliveries
           WHERE target_id = 'target-migration' ORDER BY ordering_sequence`,
        )
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        { id: 'delivery-migration-1', ordering_sequence: 0 },
        { id: 'delivery-migration-2', ordering_sequence: 1 },
      ],
    );
    assert.deepEqual(
      {
        ...(database
          .prepare(
            `SELECT next_sequence FROM delivery_order_counters
             WHERE rule_id = 'rule-migration' AND account_id = 'account-migration' AND target_id = 'target-migration'`,
          )
          .get() as { next_sequence: number }),
      },
      { next_sequence: 2 },
    );
  } finally {
    database.close();
  }
});
