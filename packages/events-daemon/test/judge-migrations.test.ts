import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { JUDGE_KINDS } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { beginJudgeTransport } from '../src/runtime/judge-budget.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';
import { JUDGE_MIGRATION_FIXTURES, migrationsThrough } from './fixtures/judge-migrations.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

type JudgeMigrationMutation =
  | 'omit-hold-created-at'
  | 'remove-claim-decision-key'
  | 'remove-work-id-key'
  | 'remove-state-check'
  | 'remove-work-scope-check'
  | 'remove-source-required-check'
  | 'drift-judge-kind-vocabulary'
  | 'omit-source-scope-index'
  | 'remove-claim-decision-binding'
  | 'loosen-claim-expiry'
  | 'remove-claim-token-length'
  | 'remove-test-charge-work-id-key';

const JUDGE_MIGRATION_MUTATIONS: Record<JudgeMigrationMutation, (statement: string) => string | undefined> = {
  'omit-hold-created-at': (statement) =>
    statement === 'ALTER TABLE decisions ADD COLUMN hold_created_at INTEGER' ? undefined : statement,
  'remove-claim-decision-key': (statement) =>
    statement.replace('decision_id TEXT PRIMARY KEY,', 'decision_id TEXT NOT NULL,'),
  'remove-work-id-key': (statement) => statement.replace('work_id TEXT NOT NULL UNIQUE,', 'work_id TEXT NOT NULL,'),
  'remove-state-check': (statement) =>
    statement.replace(
      `state TEXT NOT NULL CHECK (state IN ('reserved', 'in-flight', 'settled', 'released')),
`,
      `state TEXT NOT NULL,
`,
    ),
  'remove-work-scope-check': (statement) =>
    statement.startsWith('CREATE TABLE judge_budget_reservations')
      ? statement.replace(
          `    FOREIGN KEY (judge_id, judge_version) REFERENCES judge_versions(judge_id, version),
    CHECK (
      (work_scope = 'source-owned'
        AND source IS NOT NULL
        AND source IN ('gmail', 'slack', 'resend', 'whatsapp')
        AND account_id IS NOT NULL
        AND event_id IS NOT NULL
        AND rule_id IS NOT NULL
        AND rule_version IS NOT NULL
        AND test_work_id IS NULL
        AND provider IS NOT NULL)
      OR
      (work_scope = 'synthetic-test'
        AND source IS NULL
        AND account_id IS NULL
        AND event_id IS NULL
        AND rule_id IS NULL
        AND rule_version IS NULL
        AND test_work_id IS NOT NULL
        AND provider IS NULL)
    )
  ) STRICT`,
          `    FOREIGN KEY (judge_id, judge_version) REFERENCES judge_versions(judge_id, version)
  ) STRICT`,
        )
      : statement,
  'remove-source-required-check': (statement) =>
    statement.startsWith('CREATE TABLE judge_budget_reservations')
      ? statement.replace('        AND source IS NOT NULL\n', '')
      : statement,
  'drift-judge-kind-vocabulary': (statement) =>
    statement.startsWith('CREATE TABLE judge_budget_reservations')
      ? statement.replace("'local-endpoint'", "'drifted-kind'")
      : statement,
  'omit-source-scope-index': (statement) =>
    statement.includes('CREATE UNIQUE INDEX judge_budget_reservations_source_scope') ? undefined : statement,
  'remove-claim-decision-binding': (statement) =>
    statement.replace(
      `    FOREIGN KEY (decision_id, account_id, rule_id, rule_version)
      REFERENCES decisions(id, account_id, rule_id, rule_version) ON DELETE CASCADE,
`,
      '',
    ),
  'loosen-claim-expiry': (statement) =>
    statement.replace('CHECK (lease_expires_at > claimed_at)', 'CHECK (lease_expires_at >= claimed_at)'),
  'remove-claim-token-length': (statement) =>
    statement.replace(
      'claim_token BLOB NOT NULL UNIQUE CHECK (length(claim_token) = 32)',
      'claim_token BLOB NOT NULL UNIQUE',
    ),
  'remove-test-charge-work-id-key': (statement) =>
    statement.startsWith('CREATE TABLE judge_test_charges')
      ? statement.replace('work_id TEXT NOT NULL UNIQUE,', 'work_id TEXT NOT NULL,')
      : statement,
};

function judgeMigrationsWithMutation(mutation: JudgeMigrationMutation): readonly EventMigration[] {
  const mutate = JUDGE_MIGRATION_MUTATIONS[mutation];
  return EVENT_MIGRATIONS.filter((migration) => migration.version <= 17).map((migration) => {
    if (migration.name !== 'event-judge-hold-durability-v1') return migration;
    return {
      ...migration,
      statements: migration.statements.flatMap((statement) => {
        const mutated = mutate(statement);
        return mutated === undefined ? [] : [mutated];
      }),
    };
  });
}

function judgeMigration(): EventMigration {
  const migration = EVENT_MIGRATIONS.find((candidate) => candidate.name === 'event-judge-hold-durability-v1');
  assert.ok(migration, 'the Phase E durable judge migration is registered');
  return migration;
}

function ledgerDetachmentMigration(): EventMigration {
  const migration = EVENT_MIGRATIONS.find(
    (candidate) => candidate.name === 'event-judge-ledger-projection-detachment-v1',
  );
  assert.ok(migration, 'the Task 5 ledger detachment migration is registered');
  return migration;
}

test('E4 schema: an absent-kind disable has a durable monotonically increasing generation fence', () => {
  const migration = EVENT_MIGRATIONS.find((candidate) => candidate.name === 'event-judge-kind-disable-generations-v1');
  assert.ok(migration, 'the Task 4 disable-generation migration is registered');
  assert.equal(migration.version, 19);
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database);
    assert.match(tableSql(database, 'judge_kind_disable_generations'), /kind TEXT PRIMARY KEY/u);
    assert.match(
      tableSql(database, 'judge_kind_disable_generations'),
      /generation INTEGER NOT NULL CHECK \(generation >= 0\)/u,
    );
  } finally {
    database.close();
  }
});

test('E5 schema: every fresh and upgraded judge-kind CHECK admits exactly JUDGE_KINDS', async () => {
  const source = await readFile(new URL('../src/store/schema-v1.ts', import.meta.url), 'utf8');
  assert.match(source, /import \{ JUDGE_KINDS \} from '..\/domain\/lifecycle\.ts';/u);
  assert.match(
    source,
    /const JUDGE_KIND_SQL_VALUES = JUDGE_KINDS\.map\(\(kind\) => `'\$\{kind\.replaceAll\("'", "''"\)\}'`\)\.join\(', '\);/u,
    'the schema must not freeze a second judge-kind vocabulary',
  );
  assert.match(
    source,
    /CREATE TABLE judge_kind_versions \([\s\S]*?kind TEXT NOT NULL CHECK \(kind IN \(\$\{JUDGE_KIND_SQL_VALUES\}\)\)/u,
    'judge_kind_versions must derive its CHECK from the shared vocabulary',
  );

  for (const build of [
    {
      name: 'fresh',
      apply(database: DatabaseSync) {
        applyMigrations(database);
      },
    },
    {
      name: 'upgraded',
      apply(database: DatabaseSync) {
        applyMigrations(database, migrationsThrough(16));
        applyMigrations(database);
      },
    },
  ]) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      build.apply(database);
      assertJudgeVersionKinds(database);
    } finally {
      database.close();
    }
  }
});

function tableSql(database: DatabaseSync, table: string): string {
  const row = database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as
    | { sql: string }
    | undefined;
  assert.ok(row, `${table} exists`);
  return row.sql;
}

function indexNames(database: DatabaseSync, table: string): readonly string[] {
  return (database.prepare(`PRAGMA index_list('${table}')`).all() as Array<{ name: string }>).map(
    (index) => index.name,
  );
}

function seedJudgeAuthority(database: DatabaseSync): void {
  database.exec(`INSERT INTO rule_versions (id, rule_id, version, document, digest)
      VALUES ('judge-migration-rule@1', 'judge-migration-rule', 1, '{}', 'rule-digest');
    INSERT INTO judge_versions (id, judge_id, version, document, digest)
      VALUES ('judge-migration-judge@1', 'judge-migration-judge', 1, '{}', 'judge-digest');
    INSERT INTO judge_budget_versions (id, version, document, digest)
      VALUES ('judge-migration-budget@1', 1, '{}', 'budget-digest');
    INSERT INTO ingest
      (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
      VALUES ('judge-migration-event-a', 'installation', 'gmail.message.received', 1, 'account-a', 'dedupe-a', 1, 1, 1),
             ('judge-migration-event-b', 'installation', 'gmail.message.received', 1, 'account-b', 'dedupe-b', 1, 1, 1),
             ('judge-migration-event-c', 'installation', 'gmail.message.received', 1, 'account-c', 'dedupe-c', 1, 1, 1),
             ('judge-migration-event-d', 'installation', 'gmail.message.received', 1, 'account-d', 'dedupe-d', 1, 1, 1);
    INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
      VALUES ('judge-migration-event-a', 'judge-migration-rule', 1, 99, X'01'),
             ('judge-migration-event-b', 'judge-migration-rule', 1, 99, X'02'),
             ('judge-migration-event-c', 'judge-migration-rule', 1, 99, X'03'),
             ('judge-migration-event-d', 'judge-migration-rule', 1, 99, X'04');
    INSERT INTO decisions
      (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
      VALUES ('judge-migration-decision', 'judge-migration-event-a', 'account-a', 'judge-migration-rule', 1, 'hold', 99, 'retained')`);
}

function insertSourceReservation(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly workId: string;
    readonly accountId: string;
    readonly eventId: string;
    readonly state?: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO judge_budget_reservations
         (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
          judge_kind, budget_version, provider, global_ledger_key, state, estimated_input_tokens, concurrency_owned,
          reserved_at, switch_generation)
       VALUES (?, ?, 'source-owned', 'gmail', ?, ?, 'judge-migration-rule', 1, 'judge-migration-judge', 1,
               'typesafe', 1, 'typesafe', 'installation', ?, 10, 1, 1, 0)`,
    )
    .run(input.id, input.workId, input.accountId, input.eventId, input.state ?? 'reserved');
}

function insertSyntheticReservation(
  database: DatabaseSync,
  input: {
    readonly id: string;
    readonly workId: string;
    readonly testWorkId: string;
    readonly judgeKind: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO judge_budget_reservations
         (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
          judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
          concurrency_owned, reserved_at, switch_generation)
       VALUES (?, ?, 'synthetic-test', NULL, NULL, NULL, NULL, NULL, 'judge-migration-judge', 1,
               ?, ?, 1, NULL, 'installation', 'reserved', 10, 1, 1, 0)`,
    )
    .run(input.id, input.workId, input.judgeKind, input.testWorkId);
}

function assertReservationScopeDiscriminator(database: DatabaseSync): void {
  insertSyntheticReservation(database, {
    id: 'scope-valid-synthetic',
    workId: 'scope-valid-synthetic-work',
    testWorkId: 'scope-valid-synthetic-test-work',
    judgeKind: 'typesafe',
  });
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO judge_budget_reservations
             (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
              judge_kind, budget_version, provider, global_ledger_key, state, estimated_input_tokens, concurrency_owned,
              reserved_at, switch_generation)
           VALUES ('scope-source-null', 'scope-source-null-work', 'source-owned', NULL, 'account-c',
                   'judge-migration-event-c', 'judge-migration-rule', 1, 'judge-migration-judge', 1, 'typesafe', 1,
                   'typesafe', 'installation', 'reserved', 10, 1, 1, 0)`,
        )
        .run(),
    /CHECK constraint failed/u,
  );
  assert.throws(
    () =>
      database
        .prepare(
          `INSERT INTO judge_budget_reservations
             (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
              judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
              concurrency_owned, reserved_at, switch_generation)
           VALUES ('scope-synthetic-source', 'scope-synthetic-source-work', 'synthetic-test', 'gmail', NULL, NULL,
                   NULL, NULL, 'judge-migration-judge', 1, 'typesafe', 'scope-synthetic-source-test-work', 1, NULL,
                   'installation', 'reserved', 10, 1, 1, 0)`,
        )
        .run(),
    /CHECK constraint failed/u,
  );
}

function assertReservationJudgeKinds(database: DatabaseSync): void {
  for (const judgeKind of JUDGE_KINDS) {
    insertSyntheticReservation(database, {
      id: `kind-${judgeKind}`,
      workId: `kind-work-${judgeKind}`,
      testWorkId: `kind-test-work-${judgeKind}`,
      judgeKind,
    });
  }
  assert.throws(
    () =>
      insertSyntheticReservation(database, {
        id: 'kind-unknown',
        workId: 'kind-work-unknown',
        testWorkId: 'kind-test-work-unknown',
        judgeKind: 'unknown',
      }),
    /CHECK constraint failed/u,
  );
}

function assertJudgeVersionKinds(database: DatabaseSync): void {
  const insert = database.prepare(
    'INSERT INTO judge_kind_versions (id, kind, version, document, digest) VALUES (?, ?, 1, ?, ?)',
  );
  for (const judgeKind of JUDGE_KINDS)
    insert.run(`judge-kind-${judgeKind}@1`, judgeKind, JSON.stringify({ kind: judgeKind }), `digest-${judgeKind}`);
  assert.throws(
    () => insert.run('judge-kind-unknown@1', 'unknown', '{}', 'digest-unknown'),
    /CHECK constraint failed/u,
  );
}

test('E2: v17/v18 upgrades every B1, B2, and D fixture through B3 once without changing encrypted bytes', () => {
  const migration = judgeMigration();
  assert.equal(migration.version, 17, 'Task 2 owns the next integrated migration after B3 14–16');
  for (const fixture of JUDGE_MIGRATION_FIXTURES) {
    const database = new DatabaseSync(':memory:');
    try {
      database.exec('PRAGMA foreign_keys = ON');
      applyMigrations(database, migrationsThrough(fixture.throughVersion));
      fixture.seed(database);
      const before = Buffer.from(fixture.readCiphertext(database));

      applyMigrations(database, migrationsThrough(16));
      assert.equal(
        (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
        '16',
        `${fixture.name} reaches B3 before Phase E`,
      );
      applyMigrations(database, migrationsThrough(17));
      assert.equal(
        (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
        '17',
        `${fixture.name} reaches E durability before ledger detachment`,
      );
      applyMigrations(database);
      assert.equal(
        (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
        String(EVENT_MIGRATIONS.at(-1)?.version),
        fixture.name,
      );
      assert.deepEqual(
        Buffer.from(fixture.readCiphertext(database)),
        before,
        `${fixture.name} ciphertext is byte-stable`,
      );
      assert.deepEqual(
        database.prepare('PRAGMA foreign_key_check').all(),
        [],
        `${fixture.name} has valid foreign keys`,
      );

      applyMigrations(database);
      assert.equal(
        (
          database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get() as {
            count: number;
          }
        ).count,
        1,
        `${fixture.name} reopens idempotently`,
      );
    } finally {
      database.close();
    }
  }
});

test('E5: v18 keeps source-owned ledger audit rows when their projection is terminally purged', () => {
  const migration = ledgerDetachmentMigration();
  assert.equal(migration.version, 18, "Task 5 owns E's ledger detachment migration after durability");
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, migrationsThrough(17));
    seedJudgeAuthority(database);
    insertSourceReservation(database, {
      id: 'projection-detached-reservation',
      workId: 'projection-detached-work',
      accountId: 'account-a',
      eventId: 'judge-migration-event-a',
      state: 'settled',
    });

    applyMigrations(database);
    database
      .prepare(
        `DELETE FROM ingest_rules
         WHERE event_id = 'judge-migration-event-a' AND rule_id = 'judge-migration-rule' AND rule_version = 1`,
      )
      .run();

    assert.deepEqual(
      (
        database
          .prepare('SELECT id, account_id, event_id, rule_id, state FROM judge_budget_reservations')
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({ ...row })),
      [
        {
          id: 'projection-detached-reservation',
          account_id: 'account-a',
          event_id: 'judge-migration-event-a',
          rule_id: 'judge-migration-rule',
          state: 'settled',
        },
      ],
    );
    assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    database.close();
  }
});

test('E12 v21: account revocations gain source scope while legacy rows remain wildcard fences', {
  skip: WINDOWS_SKIP,
}, () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database, migrationsThrough(20));
    database
      .prepare('INSERT INTO account_revocations (account_id, revoked_at) VALUES (?, ?)')
      .run('same-looking-account', 7);

    applyMigrations(database);

    assert.deepEqual(
      {
        ...(database
          .prepare('SELECT source, account_id, revoked_at FROM account_revocations WHERE account_id = ?')
          .get('same-looking-account') as Record<string, unknown>),
      },
      { source: null, account_id: 'same-looking-account', revoked_at: 7 },
      'v21 preserves an old account-only revocation as a source-less fail-closed row',
    );
    database
      .prepare('INSERT INTO account_revocations (source, account_id, revoked_at) VALUES (?, ?, ?)')
      .run('gmail', 'same-looking-account', 8);
    assert.equal(
      (
        database
          .prepare('SELECT COUNT(*) AS count FROM account_revocations WHERE account_id = ?')
          .get('same-looking-account') as { count: number }
      ).count,
      2,
      'the migrated ledger can retain legacy wildcard and new exact source/account revocations together',
    );
  } finally {
    database.close();
  }
});

test('E2: v17 reserves DB-clock hold creation and a decision-bound random-token lease', () => {
  judgeMigration();
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    seedJudgeAuthority(database);

    const decisions = tableSql(database, 'decisions');
    assert.match(decisions, /hold_created_at INTEGER/u);
    const claims = tableSql(database, 'hold_resolution_claims');
    assert.match(claims, /decision_id TEXT PRIMARY KEY/u);
    assert.match(
      claims,
      /FOREIGN KEY \(decision_id, account_id, rule_id, rule_version\)\s+REFERENCES decisions\(id, account_id, rule_id, rule_version\)/u,
    );
    assert.match(claims, /claim_token BLOB NOT NULL UNIQUE CHECK \(length\(claim_token\) = 32\)/u);
    assert.match(claims, /CHECK \(lease_expires_at > claimed_at\)/u);

    const insertClaim = database.prepare(
      `INSERT INTO hold_resolution_claims
         (decision_id, account_id, rule_id, rule_version, claim_token, claimed_at, lease_expires_at)
       VALUES (?, 'account-a', 'judge-migration-rule', 1, ?, 10, ?)`,
    );
    assert.throws(() => insertClaim.run('missing-decision', Buffer.alloc(32), 11), /FOREIGN KEY constraint failed/u);
    assert.throws(() => insertClaim.run('judge-migration-decision', Buffer.alloc(31), 11), /CHECK constraint failed/u);
    assert.throws(() => insertClaim.run('judge-migration-decision', Buffer.alloc(32), 10), /CHECK constraint failed/u);
    insertClaim.run('judge-migration-decision', Buffer.alloc(32), 11);
    assert.throws(
      () => insertClaim.run('judge-migration-decision', Buffer.alloc(32, 1), 12),
      /UNIQUE constraint failed/u,
    );
  } finally {
    database.close();
  }
});

test('E2: v17 rejects invalid reservation state and duplicate source or work identities', () => {
  judgeMigration();
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    seedJudgeAuthority(database);

    insertSourceReservation(database, {
      id: 'reservation-a',
      workId: 'work-a',
      accountId: 'account-a',
      eventId: 'judge-migration-event-a',
    });
    insertSourceReservation(database, {
      id: 'reservation-b',
      workId: 'work-b',
      accountId: 'account-b',
      eventId: 'judge-migration-event-b',
    });
    assert.throws(
      () =>
        insertSourceReservation(database, {
          id: 'reservation-invalid-state',
          workId: 'work-invalid-state',
          accountId: 'account-c',
          eventId: 'judge-migration-event-c',
          state: 'unknown',
        }),
      /CHECK constraint failed/u,
    );
    assert.throws(
      () =>
        insertSourceReservation(database, {
          id: 'reservation-duplicate-scope',
          workId: 'work-duplicate-scope',
          accountId: 'account-a',
          eventId: 'judge-migration-event-a',
        }),
      /UNIQUE constraint failed/u,
    );
    assert.throws(
      () =>
        insertSourceReservation(database, {
          id: 'reservation-duplicate-work',
          workId: 'work-a',
          accountId: 'account-d',
          eventId: 'judge-migration-event-d',
        }),
      /UNIQUE constraint failed/u,
    );
    database
      .prepare(
        `INSERT INTO judge_test_charges (judge_id, judge_version, charged_at, work_id)
         VALUES ('judge-migration-judge', 1, 1, 'judge-test-work')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO judge_versions (id, judge_id, version, document, digest)
         VALUES ('judge-migration-second-judge@1', 'judge-migration-second-judge', 1, '{}', 'second-judge-digest')`,
      )
      .run();
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO judge_test_charges (judge_id, judge_version, charged_at, work_id)
             VALUES ('judge-migration-second-judge', 1, 1, 'judge-test-work')`,
          )
          .run(),
      /UNIQUE constraint failed/u,
    );
  } finally {
    database.close();
  }
});

test('E2: v17 rejects malformed source-owned and synthetic-test reservation scopes', () => {
  judgeMigration();
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    seedJudgeAuthority(database);
    assertReservationScopeDiscriminator(database);
  } finally {
    database.close();
  }
});

test('E2: v17 reservation judge kinds match the lifecycle vocabulary', () => {
  judgeMigration();
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database);
    seedJudgeAuthority(database);
    assertReservationJudgeKinds(database);
  } finally {
    database.close();
  }
});

test('E2: v17 declares rolling and account/source scope indexes without plaintext judge request or response storage', () => {
  judgeMigration();
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database);
    const indexes = indexNames(database, 'judge_budget_reservations');
    for (const name of [
      'judge_budget_reservations_rule_rolling',
      'judge_budget_reservations_provider_rolling',
      'judge_budget_reservations_global_rolling',
      'judge_budget_reservations_source_scope',
      'judge_budget_reservations_synthetic_scope',
      'judge_budget_reservations_kind_scope',
    ]) {
      assert.ok(indexes.includes(name), `${name} is present`);
    }
    assert.ok(indexNames(database, 'hold_resolution_claims').includes('hold_resolution_claims_lease_expiry'));
    assert.ok(indexNames(database, 'judge_test_charges').includes('judge_test_charges_rolling'));

    const judgeSchema = ['judge_budget_reservations', 'hold_resolution_claims', 'judge_test_charges']
      .map((table) => tableSql(database, table))
      .join('\n');
    assert.doesNotMatch(judgeSchema, /\b(?:request|response|prompt)\b/iu);
  } finally {
    database.close();
  }
});

test('E2: a fresh daemon database keeps secure-delete enabled across a reopen', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-judge-migration-'));
  try {
    const first = await openEventDatabase({ stateDir });
    try {
      assert.equal(
        (first.database.prepare('PRAGMA secure_delete').get() as { secure_delete: number }).secure_delete,
        1,
      );
      assert.equal(
        (first.database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string })
          .value,
        String(EVENT_MIGRATIONS.at(-1)?.version),
      );
    } finally {
      first.close();
    }
    const reopened = await openEventDatabase({ stateDir });
    try {
      assert.equal(
        (
          reopened.database.prepare('SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 23').get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E2 mutation: omitting hold creation storage is caught by the hold claim shape', () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database, judgeMigrationsWithMutation('omit-hold-created-at'));
    assert.throws(() => assert.match(tableSql(database, 'decisions'), /hold_created_at INTEGER/u), /hold_created_at/u);
  } finally {
    database.close();
  }
});

test('E2 mutation: removing the decision claim key is caught by the hold claim shape', () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database, judgeMigrationsWithMutation('remove-claim-decision-key'));
    assert.throws(
      () => assert.match(tableSql(database, 'hold_resolution_claims'), /decision_id TEXT PRIMARY KEY/u),
      /decision_id TEXT PRIMARY KEY/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: removing work-id uniqueness is caught by the reservation identity case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-work-id-key'));
    seedJudgeAuthority(database);
    insertSourceReservation(database, {
      id: 'mutation-reservation-a',
      workId: 'mutation-work',
      accountId: 'account-a',
      eventId: 'judge-migration-event-a',
    });
    assert.throws(
      () =>
        assert.throws(
          () =>
            insertSourceReservation(database, {
              id: 'mutation-reservation-b',
              workId: 'mutation-work',
              accountId: 'account-b',
              eventId: 'judge-migration-event-b',
            }),
          /UNIQUE constraint failed/u,
        ),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: removing the reservation state check is caught by the reservation state case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-state-check'));
    seedJudgeAuthority(database);
    assert.throws(
      () =>
        assert.throws(
          () =>
            insertSourceReservation(database, {
              id: 'mutation-reservation-state',
              workId: 'mutation-state-work',
              accountId: 'account-c',
              eventId: 'judge-migration-event-c',
              state: 'unknown',
            }),
          /CHECK constraint failed/u,
        ),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: removing the source/synthetic scope discriminator is caught by the reservation scope case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-work-scope-check'));
    seedJudgeAuthority(database);
    assert.throws(() => assertReservationScopeDiscriminator(database), /Missing expected exception/u);
  } finally {
    database.close();
  }
});

test('E2 mutation: allowing a source-owned null source is caught by the reservation scope case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-source-required-check'));
    seedJudgeAuthority(database);
    assert.throws(() => assertReservationScopeDiscriminator(database), /Missing expected exception/u);
  } finally {
    database.close();
  }
});

test('E2 mutation: drifting reservation judge kinds is caught by the lifecycle vocabulary case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('drift-judge-kind-vocabulary'));
    seedJudgeAuthority(database);
    assert.throws(() => assertReservationJudgeKinds(database), /CHECK constraint failed/u);
  } finally {
    database.close();
  }
});

test('E2 mutation: omitting the account/source scope index is caught by the index case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    applyMigrations(database, judgeMigrationsWithMutation('omit-source-scope-index'));
    assert.throws(
      () =>
        assert.ok(
          indexNames(database, 'judge_budget_reservations').includes('judge_budget_reservations_source_scope'),
          'judge_budget_reservations_source_scope is present',
        ),
      /judge_budget_reservations_source_scope is present/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: removing the decision binding is caught by the non-decision claim case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-claim-decision-binding'));
    seedJudgeAuthority(database);
    const insertClaim = database.prepare(
      `INSERT INTO hold_resolution_claims
         (decision_id, account_id, rule_id, rule_version, claim_token, claimed_at, lease_expires_at)
       VALUES ('missing-decision', 'account-a', 'judge-migration-rule', 1, X'0000000000000000000000000000000000000000000000000000000000000000', 10, 11)`,
    );
    assert.throws(
      () => assert.throws(() => insertClaim.run(), /FOREIGN KEY constraint failed/u),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: loosening the DB expiry is caught by the lease boundary case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('loosen-claim-expiry'));
    seedJudgeAuthority(database);
    const insertClaim = database.prepare(
      `INSERT INTO hold_resolution_claims
         (decision_id, account_id, rule_id, rule_version, claim_token, claimed_at, lease_expires_at)
       VALUES ('judge-migration-decision', 'account-a', 'judge-migration-rule', 1, X'0000000000000000000000000000000000000000000000000000000000000000', 10, 10)`,
    );
    assert.throws(
      () => assert.throws(() => insertClaim.run(), /CHECK constraint failed/u),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: shortening the claim token is caught by the random-token shape case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-claim-token-length'));
    seedJudgeAuthority(database);
    const insertClaim = database.prepare(
      `INSERT INTO hold_resolution_claims
         (decision_id, account_id, rule_id, rule_version, claim_token, claimed_at, lease_expires_at)
       VALUES ('judge-migration-decision', 'account-a', 'judge-migration-rule', 1, ?, 10, 11)`,
    );
    assert.throws(
      () => assert.throws(() => insertClaim.run(Buffer.alloc(31)), /CHECK constraint failed/u),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E2 mutation: removing judge-test work-id uniqueness is caught by the charge identity case', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, judgeMigrationsWithMutation('remove-test-charge-work-id-key'));
    seedJudgeAuthority(database);
    database
      .prepare(
        `INSERT INTO judge_test_charges (judge_id, judge_version, charged_at, work_id)
         VALUES ('judge-migration-judge', 1, 1, 'mutation-test-charge-work')`,
      )
      .run();
    database
      .prepare(
        `INSERT INTO judge_versions (id, judge_id, version, document, digest)
         VALUES ('mutation-judge@1', 'mutation-judge', 1, '{}', 'mutation-judge-digest')`,
      )
      .run();
    assert.throws(
      () =>
        assert.throws(
          () =>
            database
              .prepare(
                `INSERT INTO judge_test_charges (judge_id, judge_version, charged_at, work_id)
                 VALUES ('mutation-judge', 1, 1, 'mutation-test-charge-work')`,
              )
              .run(),
          /UNIQUE constraint failed/u,
        ),
      /Missing expected exception/u,
    );
  } finally {
    database.close();
  }
});

test('E9 v20: an upgraded v19 synthetic reservation with no new authority binding fails closed at its next gate', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, migrationsThrough(19));
    const versions = new ImmutableVersions(database);
    const judge = {
      judgeId: 'judge-v20-upgrade',
      version: 1,
      kind: 'local-endpoint' as const,
      provider: 'ollama',
      model: 'v20-upgrade-model',
      endpoint: 'http://127.0.0.1:11434/v1/systemone',
      approvedAddressSet: ['127.0.0.1'],
      promptTemplate: 'v20-upgrade',
      protocol: 'noul' as const,
    };
    versions.createJudge(judge);
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 20_000, concurrency: 1 },
      providers: [],
    });
    versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
    database.exec(`
      INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
      VALUES ('judge-budget', 'judge-budget', 1, 'judge-budget@1', 1),
             ('judge-kind', 'local-endpoint', 1, 'judge-kind:local-endpoint@1', 1);
      INSERT INTO judge_budget_reservations
        (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
         judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
         concurrency_owned, reserved_at, switch_generation)
      VALUES
        ('v19-synthetic-reservation', 'v19-synthetic-work', 'synthetic-test', NULL, NULL, NULL, NULL, NULL,
         'judge-v20-upgrade', 1, 'local-endpoint', 'v19-test-work', 1, NULL, 'installation', 'reserved', 1, 1, 1, 0);
    `);
    applyMigrations(database);
    assert.deepEqual(
      {
        ...(database
          .prepare(
            `SELECT test_authority_rule_id, test_authority_rule_version, test_authority_activation_id,
                  test_authority_approval_id, test_authority_challenge_hash, test_authority_challenge_origin,
                  test_authority_challenge_expires_at
             FROM judge_budget_reservations WHERE id = 'v19-synthetic-reservation'`,
          )
          .get() as object),
      },
      {
        test_authority_rule_id: null,
        test_authority_rule_version: null,
        test_authority_activation_id: null,
        test_authority_approval_id: null,
        test_authority_challenge_hash: null,
        test_authority_challenge_origin: null,
        test_authority_challenge_expires_at: null,
      },
      'v20 leaves legacy synthetic work unbound so its next gate cannot mistake it for authorised work',
    );
    const store = {
      database,
      immediate<T>(work: () => T): T {
        database.exec('BEGIN IMMEDIATE');
        try {
          const result = work();
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      },
    } as EventDatabase;
    let networkAttempts = 0;
    assert.throws(() => {
      const gate = beginJudgeTransport({ store, reservationId: 'v19-synthetic-reservation', now: 2 });
      if (gate) networkAttempts += 1;
    }, /synthetic judge test authority is unavailable/u);
    assert.equal(networkAttempts, 0, 'the migration-era reservation is refused before a transport attempt');
  } finally {
    database.close();
  }
});

test('E5 migration: upgraded attempt rows reject released-to-reserved and in-flight-to-released transitions', () => {
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(database, migrationsThrough(21));
    seedJudgeAuthority(database);
    insertSourceReservation(database, {
      id: 'legacy-released-attempt',
      workId: 'legacy-released-work',
      accountId: 'account-a',
      eventId: 'judge-migration-event-a',
      state: 'released',
    });
    insertSourceReservation(database, {
      id: 'legacy-in-flight-attempt',
      workId: 'legacy-in-flight-work',
      accountId: 'account-b',
      eventId: 'judge-migration-event-b',
      state: 'in-flight',
    });

    applyMigrations(database);

    assert.throws(
      () =>
        database
          .prepare("UPDATE judge_budget_reservations SET state = 'reserved' WHERE id = 'legacy-released-attempt'")
          .run(),
      /invalid judge reservation state transition/u,
      'an upgraded released attempt remains terminal',
    );
    assert.throws(
      () =>
        database
          .prepare("UPDATE judge_budget_reservations SET state = 'released' WHERE id = 'legacy-in-flight-attempt'")
          .run(),
      /invalid judge reservation state transition/u,
      'an upgraded in-flight attempt can settle but can never release',
    );
    assert.deepEqual(
      database
        .prepare(
          `SELECT id, state FROM judge_budget_reservations
            WHERE id IN ('legacy-released-attempt', 'legacy-in-flight-attempt')
            ORDER BY id`,
        )
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        { id: 'legacy-in-flight-attempt', state: 'in-flight' },
        { id: 'legacy-released-attempt', state: 'released' },
      ],
      'both failed legacy transitions leave their rows unchanged',
    );
  } finally {
    database.close();
  }
});
