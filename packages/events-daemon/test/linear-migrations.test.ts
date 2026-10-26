import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { providerSecretOwner } from '../src/store/event-secrets.ts';
import { applyMigrations, EVENT_MIGRATIONS } from '../src/store/migrations.ts';

/**
 * The Linear target's migrations (0.33.0 design §3.4). Migration 30 gives the provider key ledger a slot for Linear, the
 * person's Linear API key, beside TypeSafe's, OpenRouter's and Anthropic's, and keeps every generation it held; migration
 * 31 lets a delivery be a Linear one and record its issue.
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

test('0.33 E3: migration 30 adds a Linear key slot, keeps every generation, and still refuses any other provider', () => {
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
    assert.throws(() => insertProviderSlot(database, 'linear'), /CHECK constraint failed/u, 'no Linear slot before 30');

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

test('0.33 E3: migration 31 lets a delivery add a Linear issue and record which, content-free, keeping every row', () => {
  const database = migratedTo('event-linear-target-v1');
  try {
    database.exec(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-l', 'installation', 'gmail.message.received', 1, 'ibx_LINEARMIGRATION0', 'dedupe-l', 1, 1, 1);
       INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-l', 'event-l', 'ibx_LINEARMIGRATION0', 'rule-l', 1, 'matched', 999, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation)
       VALUES ('delivery-q', 'decision-l', 'ibx_LINEARMIGRATION0', 'rule-l', 1, 'queue:q:1', 'q', 1, 'queue', X'01', 999,
               'queued', 1);
       INSERT INTO queue_items
         (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id, channel,
          state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at)
       VALUES ('qi_00000000000000000000000000', 'delivery-q', 'decision-l', 'event-l', 'rule-l', 1, 'q', 1,
               'ibx_LINEARMIGRATION0', 'gmail', 'open', 1, 1, 1, 86400000, 2, 3);`,
    );
    const insertLinear = (id: string, issue: readonly [string | null, string | null, string | null], kind = 'linear') =>
      database
        .prepare(
          `INSERT INTO deliveries
             (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
              encrypted_record, expires_at, state, switch_generation, linear_issue_id, linear_identifier, linear_url)
           VALUES (?, 'decision-l', 'ibx_LINEARMIGRATION0', 'rule-l', 1, ?, 'l', 1, ?, NULL, 999, 'delivered', 1, ?, ?, ?)`,
        )
        .run(id, `${kind}:${id}:1`, kind, ...issue);
    assert.throws(() => database.exec('SELECT linear_issue_id FROM deliveries'), /no such column/u);

    applyMigrations(database);
    assert.deepEqual(
      { ...(database.prepare("SELECT id, target_kind FROM deliveries WHERE id = 'delivery-q'").get() as object) },
      { id: 'delivery-q', target_kind: 'queue' },
      'the queue delivery and its item are kept',
    );
    const ISSUE = '6b1f0e2a-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
    insertLinear('linear-1', [ISSUE, 'CUE-123', 'https://linear.app/acme/issue/CUE-123']);
    insertLinear('linear-2', [null, null, null]);
    for (const [what, issue, kind] of [
      ['an issue id without its identifier', [ISSUE, null, null], 'linear'],
      ['an identifier that is not one', [ISSUE, 'the subject', 'https://linear.app/acme/issue/CUE-1'], 'linear'],
      ['an address off linear.app', [ISSUE, 'CUE-1', 'https://evil.example/CUE-1'], 'linear'],
      ['an issue on a webhook delivery', [ISSUE, 'CUE-1', 'https://linear.app/acme/issue/CUE-1'], 'webhook'],
    ] as const)
      assert.throws(() => insertLinear(`bad-${what}`, issue, kind), /CHECK constraint failed/u, what);
    assert.deepEqual(
      database.prepare('PRAGMA foreign_key_check').all(),
      [],
      'every reference to a delivery still holds after the rebuild',
    );
  } finally {
    database.close();
  }
});
