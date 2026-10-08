import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { applyMigrations, EVENT_MIGRATIONS, type EventMigration } from '../src/store/migrations.ts';

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
