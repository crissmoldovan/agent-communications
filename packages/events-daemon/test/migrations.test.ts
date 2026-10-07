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

test('SEC-B1: every statement in the real v1 authority migration is atomic with its ledger entry', () => {
  const migration = EVENT_MIGRATIONS[0];
  assert.ok(migration);
  for (const failingStatement of migration.statements.keys()) {
    const database = new DatabaseSync(':memory:');
    try {
      assert.throws(
        () =>
          applyMigrations(database, EVENT_MIGRATIONS, {
            beforeStatement({ statementIndex }) {
              if (statementIndex === failingStatement) throw new Error('injected v1 migration failure');
            },
          }),
        /injected v1 migration failure/,
      );
      const meta = database
        .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'meta'")
        .get() as { count: number };
      const ledger = database.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number };
      assert.equal(meta.count, 0, `statement ${failingStatement}`);
      assert.equal(ledger.count, 0, `statement ${failingStatement}`);
    } finally {
      database.close();
    }
  }
});

test('SEC-B1: every event migration starts with an immediate writer transaction', async () => {
  const source = await readFile(new URL('../src/store/migrations.ts', import.meta.url), 'utf8');
  assert.match(source, /database\.exec\('BEGIN IMMEDIATE'\)/);
});
