import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ensureEventPaths, ensureOwnerOnlyFile, eventPaths } from '../src/runtime/paths.ts';
import { encodeAad } from '../src/store/aad.ts';
import { openEventDatabase, recordedVersionReadOnly } from '../src/store/database.ts';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';
import { RECORD_LAYOUTS } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

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

test('SEC-B1: an older binary refuses a database with a migration version it does not know', {
  skip: WINDOWS_SKIP,
}, () => {
  const database = new DatabaseSync(':memory:');
  const knownMigrations: readonly EventMigration[] = [
    {
      version: 1,
      name: 'known-schema-v1',
      statements: ['CREATE TABLE known_schema (id TEXT PRIMARY KEY) STRICT'],
    },
  ];
  try {
    applyMigrations(database, knownMigrations);
    database
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(2, 'newer-schema-v2', 2);

    assert.throws(
      () => applyMigrations(database, knownMigrations),
      {
        name: 'Error',
        message:
          "event database schema version 2 is newer than this release's schema version 1; only the newer release that migrated it can open it",
      },
      'the older binary names both schema versions without opening the newer database',
    );
  } finally {
    database.close();
  }
});

test('SEC-B1: the opener refuses a database a newer agent-events migrated, writing nothing to it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-newer-schema-');
  try {
    const paths = await ensureEventPaths(eventPaths(stateDir));
    await ensureOwnerOnlyFile(paths.database);
    const known = EVENT_MIGRATIONS.length;
    // As a newer release could leave it: a ledger one version ahead, and a journal mode this opener would set otherwise.
    const newer = new DatabaseSync(paths.database);
    newer.exec('PRAGMA journal_mode = DELETE');
    newer.exec(
      'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT',
    );
    newer
      .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
      .run(known + 1, 'from-a-newer-agent-events', 1);
    newer.close();
    const before = await readFile(paths.database);

    await assert.rejects(
      openEventDatabase({ stateDir }),
      {
        message: `event database schema version ${known + 1} is newer than this release's schema version ${known}; only the newer release that migrated it can open it`,
      },
      'the opener refuses the newer database, naming both versions and nothing in it',
    );
    assert.deepEqual(
      await readFile(paths.database),
      before,
      'the refused database is byte for byte as it was: no journal mode set, no table created, no row written',
    );
    assert.equal(existsSync(`${paths.database}-wal`), false, 'and no write-ahead log was started for it');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

/** A newer release's database as a crash leaves it: its ledger committed to the write-ahead log, never checkpointed. */
async function crashAfterWritingNewerLedger(path: string, version: number): Promise<void> {
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(${JSON.stringify(path)});
database.exec('PRAGMA journal_mode = WAL');
database.exec('PRAGMA wal_autocheckpoint = 0');
database.exec('CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT');
database.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)').run(${version}, 'from-a-newer-agent-events', 1);
process.stdout.write('ready\\n');
setInterval(() => undefined, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  await new Promise<void>((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('ready')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`the newer release's stand-in exited before writing (${code})`)));
  });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  child.kill('SIGKILL');
  await exited;
}

test("SEC-B1: a newer release's database is refused through a read-only connection, its write-ahead log left as it was", {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-newer-wal-');
  try {
    const paths = await ensureEventPaths(eventPaths(stateDir));
    await ensureOwnerOnlyFile(paths.database);
    const known = EVENT_MIGRATIONS.length;
    await crashAfterWritingNewerLedger(paths.database, known + 1);
    const wal = `${paths.database}-wal`;
    assert.equal(existsSync(wal), true, 'the stand-in left its ledger in the write-ahead log');
    const [databaseBefore, walBefore] = await Promise.all([readFile(paths.database), readFile(wal)]);

    await assert.rejects(
      openEventDatabase({ stateDir }),
      {
        message: `event database schema version ${known + 1} is newer than this release's schema version ${known}; only the newer release that migrated it can open it`,
      },
      'the opener refuses the newer database, naming both versions',
    );
    // A writable connection closing last would checkpoint the log into the database and delete it.
    assert.deepEqual(await readFile(paths.database), databaseBefore, 'the database file was not checkpointed into');
    assert.deepEqual(await readFile(wal), walBefore, 'and its write-ahead log is still there, unchanged');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

/** A newer release's database in rollback-journal mode: its ledger one version ahead, and rows to rewrite. */
function seedNewerDeleteModeDatabase(path: string, version: number): void {
  const newer = new DatabaseSync(path);
  newer.exec('PRAGMA journal_mode = DELETE');
  newer.exec(
    'CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at INTEGER NOT NULL) STRICT',
  );
  newer
    .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
    .run(version, 'from-a-newer-agent-events', 1);
  newer.exec('CREATE TABLE filler (x TEXT)');
  for (let row = 0; row < 50; row += 1) newer.prepare('INSERT INTO filler (x) VALUES (?)').run('x'.repeat(2_000));
  newer.close();
}

/** Another process on the database: it runs `script` against it, says `ready`, and lives until it is killed. */
async function anotherProcess(path: string, script: string) {
  const child = spawn(
    process.execPath,
    [
      '--disable-warning=ExperimentalWarning',
      '-e',
      `const { DatabaseSync } = require('node:sqlite');
const database = new DatabaseSync(${JSON.stringify(path)});
${script}
setInterval(() => undefined, 1000);`,
    ],
    { stdio: ['ignore', 'pipe', 'inherit'] },
  );
  const said: string[] = [];
  const heard = (word: string) =>
    new Promise<void>((resolve, reject) => {
      if (said.includes(word)) return resolve();
      child.stdout.on('data', (chunk) => {
        said.push(...String(chunk).split('\n'));
        if (said.includes(word)) resolve();
      });
      child.once('exit', (code) => reject(new Error(`the other process exited before saying ${word} (${code})`)));
    });
  return {
    heard,
    async kill() {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    },
  };
}

test('SEC-B1: the read-only schema check waits out a lock another process holds briefly', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-probe-lock-');
  const known = EVENT_MIGRATIONS.length;
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureOwnerOnlyFile(paths.database);
  seedNewerDeleteModeDatabase(paths.database, known + 1);
  const holder = await anotherProcess(
    paths.database,
    `database.exec('BEGIN EXCLUSIVE');
process.stdout.write('ready\\n');
setTimeout(() => { database.exec('ROLLBACK'); process.stdout.write('released\\n'); }, 300);`,
  );
  try {
    await holder.heard('ready');
    const { DatabaseSync: Database } = await import('node:sqlite');
    assert.equal(
      recordedVersionReadOnly(Database, paths.database),
      known + 1,
      'the read-only check reads the version once the lock is released, rather than opening the database for writing',
    );
  } finally {
    await holder.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: a lock held past the wait refuses the open without a writable connection', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-probe-busy-');
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureOwnerOnlyFile(paths.database);
  seedNewerDeleteModeDatabase(paths.database, EVENT_MIGRATIONS.length + 1);
  const holder = await anotherProcess(
    paths.database,
    `database.exec('BEGIN EXCLUSIVE');
process.stdout.write('ready\\n');`,
  );
  try {
    await holder.heard('ready');
    const { DatabaseSync: Database } = await import('node:sqlite');
    assert.throws(
      () => recordedVersionReadOnly(Database, paths.database, 100),
      (error: { errcode?: number }) => error.errcode === 5,
      'a database still locked after the wait is refused as busy, never opened for writing instead',
    );
  } finally {
    await holder.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: only a database SQLite must first recover is left to the writable open, which then refuses it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-probe-hot-');
  const known = EVENT_MIGRATIONS.length;
  const paths = await ensureEventPaths(eventPaths(stateDir));
  await ensureOwnerOnlyFile(paths.database);
  seedNewerDeleteModeDatabase(paths.database, known + 1);
  // A crash in the middle of the newer release's transaction leaves a hot journal behind.
  const writer = await anotherProcess(
    paths.database,
    `database.exec('PRAGMA cache_size = 1');
database.exec('BEGIN');
database.exec('UPDATE filler SET x = upper(x)');
process.stdout.write('ready\\n');`,
  );
  try {
    await writer.heard('ready');
    await writer.kill();
    const journal = `${paths.database}-journal`;
    assert.equal(existsSync(journal), true, 'the crash left a hot journal');
    const { DatabaseSync: Database } = await import('node:sqlite');
    assert.equal(
      recordedVersionReadOnly(Database, paths.database),
      null,
      'a read-only connection cannot finish the interrupted transaction, so it hands the check on',
    );
    assert.equal(existsSync(journal), true, 'and leaves the journal for the recovery to read');
    await assert.rejects(
      openEventDatabase({ stateDir }),
      {
        message: `event database schema version ${known + 1} is newer than this release's schema version ${known}; only the newer release that migrated it can open it`,
      },
      'the writable open lets SQLite recover, then refuses the newer database before agent-events writes to it',
    );
  } finally {
    await writer.kill();
    await rm(stateDir, { recursive: true, force: true });
  }
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
      '28',
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
    const targetTestChargeColumns = database
      .prepare("SELECT name, type, pk FROM pragma_table_info('target_test_charges')")
      .all() as Array<{ name: string; type: string; pk: number }>;
    assert.deepEqual(
      targetTestChargeColumns.map((column) => column.name),
      ['id', 'target_id', 'charged_at'],
    );
    assert.equal(targetTestChargeColumns.find((column) => column.name === 'id')?.pk, 1);
    assert.deepEqual(
      database
        .prepare("SELECT name FROM pragma_index_info('target_test_charges_target_window')")
        .all()
        .map((row) => ({ ...(row as { name: string }) })),
      [{ name: 'target_id' }, { name: 'charged_at' }],
    );
  } finally {
    database.close();
  }
});
