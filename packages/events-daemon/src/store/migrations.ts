import type { DatabaseSync } from 'node:sqlite';
import { SCHEMA_V1_STATEMENTS } from './schema-v1.ts';

export interface EventMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
}

export interface MigrationHooks {
  readonly beforeStatement?:
    | ((context: { readonly migration: EventMigration; readonly statementIndex: number }) => void)
    | undefined;
}

export const EVENT_MIGRATIONS: readonly EventMigration[] = [
  { version: 1, name: 'event-authority-v1', statements: SCHEMA_V1_STATEMENTS },
  {
    version: 2,
    name: 'event-lifecycle-pause-v1',
    statements: [
      'ALTER TABLE event_settings ADD COLUMN paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1))',
      "UPDATE meta SET value = '2' WHERE key = 'schema_version'",
    ],
  },
  {
    version: 3,
    name: 'event-subscriber-versions-v1',
    statements: [
      `CREATE TABLE subscriber_versions (
        id TEXT PRIMARY KEY,
        subscriber_id TEXT NOT NULL,
        version INTEGER NOT NULL CHECK (version > 0),
        document TEXT NOT NULL,
        digest TEXT NOT NULL,
        revoked_at INTEGER,
        UNIQUE (subscriber_id, version)
      ) STRICT`,
      "UPDATE meta SET value = '3' WHERE key = 'schema_version'",
    ],
  },
  {
    version: 4,
    name: 'event-activation-approval-link-v1',
    statements: [
      'ALTER TABLE activation_intents ADD COLUMN approval_id TEXT',
      'CREATE UNIQUE INDEX activation_intents_approval_id ON activation_intents(approval_id) WHERE approval_id IS NOT NULL',
      "UPDATE meta SET value = '4' WHERE key = 'schema_version'",
    ],
  },
  {
    version: 5,
    name: 'event-source-stage-rule-debts-v1',
    statements: [
      `CREATE TABLE source_stage_rule_debts (
        stage_id TEXT NOT NULL REFERENCES source_scan_state(id) ON DELETE CASCADE,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        PRIMARY KEY (stage_id, rule_id, rule_version)
      ) STRICT`,
      "UPDATE meta SET value = '5' WHERE key = 'schema_version'",
    ],
  },
];

function initialiseLedger(database: DatabaseSync): void {
  database.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    applied_at INTEGER NOT NULL
  ) STRICT`);
}

/** Applies ordered daemon-owned migrations, one BEGIN IMMEDIATE transaction per version. */
export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly EventMigration[] = EVENT_MIGRATIONS,
  hooks: MigrationHooks = {},
): void {
  initialiseLedger(database);
  const applied = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error('event migrations must have consecutive versions starting at 1');
    const recorded = applied.find((entry) => entry.version === migration.version);
    if (recorded) {
      if (recorded.name !== migration.name)
        throw new Error(`event migration ${migration.version} does not match its ledger name`);
      continue;
    }
    database.exec('BEGIN IMMEDIATE');
    try {
      migration.statements.forEach((statement, statementIndex) => {
        hooks.beforeStatement?.({ migration, statementIndex });
        database.exec(statement);
      });
      database
        .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
        .run(migration.version, migration.name, Date.now());
      database.exec('COMMIT');
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }
}
