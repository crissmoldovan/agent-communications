import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { providerSecretOwner } from '../src/store/event-secrets.ts';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

/**
 * The Linear target's migrations (0.33.0 design §3.4). Migration 29 gives the provider key ledger a slot for Linear, the
 * person's Linear API key, beside TypeSafe's and OpenRouter's, and keeps every generation it held.
 */

function migratedTo(name: string): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  const found = EVENT_MIGRATIONS.find((migration) => migration.name === name);
  assert.ok(found, `the ${name} migration exists`);
  applyMigrations(
    database,
    EVENT_MIGRATIONS.filter((migration) => migration.version < found.version),
  );
  return database;
}

const insertProviderSlot = (database: DatabaseSync, provider: string) => {
  const owner = providerSecretOwner(provider as 'linear');
  database
    .prepare(
      `INSERT INTO event_secret_generations
         (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
          lifecycle, created_at)
       VALUES ('provider', ?, 1, 'provider-key', 1, ?, ?, X'01', 'current', 1)`,
    )
    .run(provider, owner.digest, 'a'.repeat(64));
};

test('0.33 E3: migration 29 adds a Linear key slot, keeps every generation, and still refuses any other provider', () => {
  const database = migratedTo('event-secret-linear-slot-v1');
  try {
    insertProviderSlot(database, 'openrouter');
    database
      .prepare(
        `INSERT INTO event_secret_generations
           (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
            lifecycle, created_at)
         VALUES ('judge', 'jev', 1, 'judge-key', 1, ?, ?, X'02', 'current', 2)`,
      )
      .run('b'.repeat(64), 'c'.repeat(64));
    assert.throws(() => insertProviderSlot(database, 'linear'), /CHECK constraint failed/u, 'no Linear slot before 29');

    applyMigrations(database);
    assert.deepEqual(
      database
        .prepare('SELECT owner_kind, owner_id, purpose, lifecycle FROM event_secret_generations ORDER BY created_at')
        .all()
        .map((row) => ({ ...row })),
      [
        { owner_kind: 'provider', owner_id: 'openrouter', purpose: 'provider-key', lifecycle: 'current' },
        { owner_kind: 'judge', owner_id: 'jev', purpose: 'judge-key', lifecycle: 'current' },
      ],
    );
    insertProviderSlot(database, 'linear');
    assert.throws(() => insertProviderSlot(database, 'linear'), /UNIQUE constraint failed/u, 'one current Linear key');
    assert.throws(
      () =>
        database
          .prepare(
            `INSERT INTO event_secret_generations
               (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
                lifecycle, created_at)
             VALUES ('provider', 'someone-else', 1, 'provider-key', 1, 'd', 'e', X'03', 'current', 3)`,
          )
          .run(),
      /CHECK constraint failed/u,
      'a provider with no slot is refused',
    );
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      String(EVENT_MIGRATIONS.at(-1)?.version),
    );
  } finally {
    database.close();
  }
});
