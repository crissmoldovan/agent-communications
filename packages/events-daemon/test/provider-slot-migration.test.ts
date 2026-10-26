import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { EVENT_SECRET_PROVIDERS } from '../src/domain/providers.ts';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

/*
 * 0.33.0 (design §3.3): Analyse's model runs on OpenRouter or on Anthropic's own Messages API, so Anthropic gains a key
 * slot beside TypeSafe's and OpenRouter's. Migration 29 rebuilds the slot table with the wider CHECK and keeps every row.
 */

const slot = (provider: string, generation = 1) => [
  'provider',
  provider,
  1,
  'provider-key',
  generation,
  `owner-${provider}`,
  `secret-${provider}`,
  Buffer.from('sealed-reference'),
  'current',
  null,
  1,
];

function insert(database: DatabaseSync, values: readonly unknown[]): void {
  database
    .prepare(
      `INSERT INTO event_secret_generations
         (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
          lifecycle, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(...(values as never[]));
}

test('PROVIDER-SLOT: migration 29 gives Anthropic a key slot and keeps every slot it had', () => {
  const migration = EVENT_MIGRATIONS.find((candidate) => candidate.version === 29);
  assert.equal(migration?.name, 'event-secret-provider-slot-anthropic-v1');
  const database = new DatabaseSync(':memory:');
  try {
    database.exec('PRAGMA foreign_keys = ON');
    applyMigrations(
      database,
      EVENT_MIGRATIONS.filter((candidate) => candidate.version <= 28),
    );
    insert(database, slot('openrouter'));
    assert.throws(
      () => insert(database, slot('anthropic')),
      /CHECK constraint failed/u,
      'before 29, no Anthropic slot',
    );

    applyMigrations(database);
    assert.equal(
      (database.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      String(EVENT_MIGRATIONS.at(-1)?.version),
    );
    assert.deepEqual(
      database
        .prepare(
          "SELECT owner_id, secret_digest, lifecycle FROM event_secret_generations WHERE owner_kind = 'provider'",
        )
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ owner_id: 'openrouter', secret_digest: 'secret-openrouter', lifecycle: 'current' }],
      'the slot it had is copied as it was',
    );
    insert(database, slot('anthropic'));
    assert.throws(() => insert(database, slot('someone-else')), /CHECK constraint failed/u, 'no other provider');
    assert.throws(
      () => insert(database, slot('anthropic', 2)),
      /UNIQUE constraint failed/u,
      'one current generation per slot, as before',
    );
    for (const provider of EVENT_SECRET_PROVIDERS)
      assert.ok(
        migration?.statements.some((statement) => statement.includes(`'${provider}'`)),
        `migration 29 admits ${provider}, a provider this release keeps keys for`,
      );
  } finally {
    database.close();
  }
});
