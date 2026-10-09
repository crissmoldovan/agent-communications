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
  {
    version: 6,
    name: 'event-network-secret-generations-v1',
    statements: [
      `CREATE TABLE event_secret_generations (
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('target', 'subscriber')),
        owner_id TEXT NOT NULL,
        owner_version INTEGER NOT NULL CHECK (owner_version > 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('secret-url', 'webhook-signing', 'sse-bearer')),
        generation INTEGER NOT NULL CHECK (generation > 0),
        owner_digest TEXT NOT NULL,
        secret_digest TEXT NOT NULL,
        encrypted_ref BLOB NOT NULL,
        lifecycle TEXT NOT NULL CHECK (lifecycle IN ('current', 'overlap', 'retired')),
        expires_at INTEGER,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (owner_kind, owner_id, owner_version, purpose, generation),
        CHECK (
          (owner_kind = 'target' AND purpose IN ('secret-url', 'webhook-signing'))
          OR (owner_kind = 'subscriber' AND purpose = 'sse-bearer')
        )
      ) STRICT`,
      `CREATE UNIQUE INDEX event_secret_generations_current
       ON event_secret_generations(owner_kind, owner_id, owner_version, purpose)
       WHERE lifecycle = 'current'`,
      "UPDATE meta SET value = '6' WHERE key = 'schema_version'",
    ],
  },
  {
    version: 7,
    name: 'event-network-outboxes-and-target-references-v1',
    statements: [
      "ALTER TABLE deliveries ADD COLUMN target_kind TEXT NOT NULL DEFAULT 'dry-run' CHECK (target_kind IN ('dry-run', 'webhook', 'sse'))",
      "ALTER TABLE deliveries ADD COLUMN target_representation TEXT NOT NULL DEFAULT 'plain' CHECK (target_representation IN ('plain', 'enveloped'))",
      'ALTER TABLE deliveries ADD COLUMN subscriber_id TEXT',
      'ALTER TABLE deliveries ADD COLUMN subscriber_version INTEGER',
      'ALTER TABLE deliveries ADD COLUMN attempt_id TEXT',
      'ALTER TABLE deliveries ADD COLUMN lease_token TEXT',
      'ALTER TABLE deliveries ADD COLUMN ordering_sequence INTEGER NOT NULL DEFAULT 0 CHECK (ordering_sequence >= 0)',
      'ALTER TABLE deliveries ADD COLUMN dead_lettered_at INTEGER',
      'ALTER TABLE deliveries ADD COLUMN dead_letter_expires_at INTEGER',
      `CREATE TABLE system_reset_outbox (
        id TEXT PRIMARY KEY,
        reset_epoch INTEGER NOT NULL CHECK (reset_epoch > 0),
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL CHECK (target_version > 0),
        encrypted_record BLOB,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        attempt_limit INTEGER NOT NULL CHECK (attempt_limit = 20),
        next_at INTEGER,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'retryable', 'disclosing', 'delivered', 'dead-lettered', 'cancelled', 'retention-expired', 'content-unreadable')),
        switch_generation INTEGER NOT NULL DEFAULT 0,
        attempt_id TEXT,
        lease_token TEXT,
        lease_until INTEGER,
        last_error_code TEXT,
        last_status INTEGER,
        created_at INTEGER NOT NULL,
        UNIQUE (reset_epoch, target_id, target_version),
        CHECK (expires_at = created_at + 86400000),
        CHECK (encrypted_record IS NOT NULL OR state NOT IN ('queued', 'retryable', 'disclosing'))
      ) STRICT`,
      'ALTER TABLE reset_barriers ADD COLUMN system_outbox_id TEXT REFERENCES system_reset_outbox(id)',
      `CREATE TABLE target_version_references (
        id TEXT PRIMARY KEY,
        reference_kind TEXT NOT NULL CHECK (reference_kind IN ('active-rule', 'retained-delivery')),
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL CHECK (target_version > 0),
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL CHECK (rule_version > 0),
        delivery_id TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (reference_kind, target_id, target_version, rule_id, rule_version, delivery_id),
        CHECK (
          (reference_kind = 'active-rule' AND delivery_id IS NULL)
          OR (reference_kind = 'retained-delivery' AND delivery_id IS NOT NULL)
        )
      ) STRICT`,
      `CREATE TABLE delivery_order_counters (
        rule_id TEXT NOT NULL,
        account_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        next_sequence INTEGER NOT NULL CHECK (next_sequence >= 0),
        PRIMARY KEY (rule_id, account_id, target_id)
      ) STRICT`,
      `INSERT OR IGNORE INTO target_version_references
       (id, reference_kind, target_id, target_version, rule_id, rule_version, delivery_id, created_at)
       SELECT 'active:' || rule_id || ':' || version || ':' || json_extract(target.value, '$.targetId') || ':' || json_extract(target.value, '$.version'),
              'active-rule', json_extract(target.value, '$.targetId'), json_extract(target.value, '$.version'),
              rule_id, version, NULL, COALESCE(activated_at, 0)
       FROM rule_versions, json_each(rule_versions.document, '$.targets') AS target
       WHERE state = 'active'`,
      `INSERT OR IGNORE INTO target_version_references
       (id, reference_kind, target_id, target_version, rule_id, rule_version, delivery_id, created_at)
       SELECT 'retained:' || id || ':' || target_id || ':' || target_version,
              'retained-delivery', target_id, target_version, rule_id, rule_version, id, 0
       FROM deliveries
       WHERE encrypted_record IS NOT NULL
         AND state IN ('queued', 'retryable', 'disclosing', 'dead-lettered')`,
      'CREATE INDEX deliveries_target_order ON deliveries(target_id, target_version, ordering_sequence)',
      'CREATE INDEX target_version_references_target ON target_version_references(target_id, target_version)',
      'CREATE INDEX target_version_references_rule ON target_version_references(rule_id, rule_version)',
      "UPDATE meta SET value = '7' WHERE key = 'schema_version'",
    ],
  },
  {
    version: 8,
    name: 'event-delivery-stable-order-v1',
    statements: [
      `UPDATE deliveries
       SET ordering_sequence = (
         SELECT count(*)
         FROM deliveries AS earlier
         WHERE earlier.rule_id = deliveries.rule_id
           AND earlier.account_id = deliveries.account_id
           AND earlier.target_id = deliveries.target_id
           AND earlier.rowid < deliveries.rowid
       )`,
      `INSERT INTO delivery_order_counters (rule_id, account_id, target_id, next_sequence)
       SELECT rule_id, account_id, target_id, max(ordering_sequence) + 1
       FROM deliveries
       GROUP BY rule_id, account_id, target_id
       ON CONFLICT(rule_id, account_id, target_id)
       DO UPDATE SET next_sequence = MAX(delivery_order_counters.next_sequence, excluded.next_sequence)`,
      'DROP INDEX deliveries_target_order',
      `CREATE INDEX deliveries_stable_order
       ON deliveries(rule_id, account_id, target_id, ordering_sequence, state, lease_until)`,
      "UPDATE meta SET value = '8' WHERE key = 'schema_version'",
    ],
  },
  {
    // B2 lands before Phase D on this branch.  This migration intentionally has no occurrence-parent foreign key:
    // the D-owned parent table does not exist yet.  A later B2 convergence migration rebuilds this table after D.
    version: 9,
    name: 'event-sse-stream-log-v1',
    statements: [
      `CREATE TABLE stream_log (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        subscriber_id TEXT NOT NULL,
        subscriber_version INTEGER NOT NULL,
        event_id TEXT NOT NULL REFERENCES ingest(event_id),
        account_id TEXT NOT NULL,
        whatsapp_message_id TEXT,
        whatsapp_visibility_version INTEGER,
        encrypted_record BLOB NOT NULL,
        delivered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        switch_generation INTEGER NOT NULL,
        CHECK (expires_at > delivered_at),
        CHECK (expires_at - delivered_at <= 604800000),
        CHECK (
          (whatsapp_message_id IS NULL AND whatsapp_visibility_version IS NULL)
          OR (whatsapp_message_id IS NOT NULL AND whatsapp_visibility_version IS NOT NULL)
        )
      ) STRICT`,
      'CREATE INDEX stream_log_account_whatsapp_message ON stream_log(account_id, whatsapp_message_id)',
      'CREATE INDEX stream_log_replay ON stream_log(subscriber_id, subscriber_version, delivered_at, id)',
      "UPDATE meta SET value = '9' WHERE key = 'schema_version'",
    ],
  },
  {
    // Phase D lands after B2 (D-11, B2-first order), so D's own unapplied migration takes the next free number;
    // B2's v6–v9 stay exactly as recorded. B2's later convergence migration adds stream_log's occurrence key.
    version: 10,
    name: 'event-multisource-authority-v1',
    statements: [
      `CREATE TABLE slack_reply_drains (
        intent_id TEXT NOT NULL REFERENCES activation_intents(id),
        account_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL CHECK (conversation_id <> ''),
        thread_ts TEXT NOT NULL CHECK (thread_ts <> ''),
        cursor TEXT,
        covered_through TEXT NOT NULL CHECK (covered_through <> ''),
        drained_at INTEGER,
        PRIMARY KEY (intent_id, account_id, conversation_id, thread_ts)
      ) STRICT`,
      `CREATE TABLE resend_status_state (
        account_id TEXT NOT NULL,
        email_id TEXT NOT NULL CHECK (email_id <> ''),
        last_event TEXT NOT NULL CHECK (last_event IN ('scheduled', 'sent', 'delivered', 'delivery_delayed', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'suppressed', 'canceled', 'queued')),
        observed_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, email_id),
        CHECK (expires_at > observed_at),
        CHECK (expires_at - observed_at <= 604800000)
      ) STRICT`,
      'CREATE INDEX resend_status_state_expires_at ON resend_status_state(expires_at)',
      `CREATE TABLE whatsapp_visibility (
        account_id TEXT PRIMARY KEY,
        version INTEGER NOT NULL CHECK (version > 0),
        lists_digest TEXT NOT NULL CHECK (length(lists_digest) = 64 AND lists_digest NOT GLOB '*[^0-9a-f]*'),
        changed_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE TABLE whatsapp_snapshot_heads (
        account_id TEXT PRIMARY KEY REFERENCES whatsapp_visibility(account_id),
        committed_generation INTEGER NOT NULL CHECK (committed_generation > 0),
        visibility_version INTEGER NOT NULL CHECK (visibility_version > 0)
      ) STRICT`,
      `CREATE TABLE whatsapp_snapshot_keys (
        account_id TEXT NOT NULL REFERENCES whatsapp_visibility(account_id),
        generation INTEGER NOT NULL CHECK (generation > 0),
        visibility_version INTEGER NOT NULL CHECK (visibility_version > 0),
        chat_jid TEXT NOT NULL,
        sender_jid_raw TEXT NOT NULL,
        stanza_id TEXT NOT NULL,
        PRIMARY KEY (account_id, generation, chat_jid, sender_jid_raw, stanza_id),
        CHECK (chat_jid <> '' AND sender_jid_raw <> '' AND stanza_id <> '')
      ) STRICT`,
      `CREATE TABLE whatsapp_occurrences (
        account_id TEXT NOT NULL REFERENCES whatsapp_visibility(account_id),
        message_id TEXT NOT NULL,
        first_seen_generation INTEGER NOT NULL CHECK (first_seen_generation > 0),
        first_seen_at INTEGER NOT NULL,
        visibility_version INTEGER NOT NULL CHECK (visibility_version > 0),
        staged_payload_ref TEXT,
        stage_expires_at INTEGER,
        event_id TEXT REFERENCES ingest(event_id),
        PRIMARY KEY (account_id, message_id),
        CHECK (message_id <> ''),
        CHECK ((staged_payload_ref IS NULL AND stage_expires_at IS NULL) OR (staged_payload_ref IS NOT NULL AND stage_expires_at IS NOT NULL))
      ) STRICT`,
      `CREATE TABLE whatsapp_rule_admissions (
        account_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL CHECK (rule_version > 0),
        admission TEXT NOT NULL CHECK (admission IN ('baseline', 'admitted', 'suppressed', 'expired')),
        activation_id TEXT NOT NULL,
        visibility_version INTEGER NOT NULL CHECK (visibility_version > 0),
        admitted_at INTEGER NOT NULL,
        PRIMARY KEY (account_id, message_id, rule_id, rule_version),
        FOREIGN KEY (account_id, message_id) REFERENCES whatsapp_occurrences(account_id, message_id) ON DELETE CASCADE,
        FOREIGN KEY (rule_id, rule_version) REFERENCES rule_versions(rule_id, version)
      ) STRICT`,
      'CREATE INDEX whatsapp_rule_admissions_rule_version ON whatsapp_rule_admissions(rule_id, rule_version)',
      'ALTER TABLE ingest_rules ADD COLUMN whatsapp_visibility_version INTEGER',
      'ALTER TABLE ingest_rules ADD COLUMN whatsapp_message_id TEXT',
      'ALTER TABLE decisions ADD COLUMN whatsapp_message_id TEXT',
      'ALTER TABLE deliveries ADD COLUMN whatsapp_visibility_version INTEGER',
      'ALTER TABLE deliveries ADD COLUMN whatsapp_message_id TEXT',
      'ALTER TABLE dryrun_log ADD COLUMN whatsapp_message_id TEXT',
      "UPDATE meta SET value = '10' WHERE key = 'schema_version'",
    ],
  },
  {
    // B2 owns this post-D convergence migration (D-11, B2-first order).  v9 and D's v10 are immutable: this
    // replacement is the first point at which the D-owned occurrence parent can be named safely.
    version: 11,
    name: 'event-sse-stream-log-whatsapp-occurrence-v1',
    statements: [
      `CREATE TABLE stream_log_v11 (
        id TEXT PRIMARY KEY,
        delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        subscriber_id TEXT NOT NULL,
        subscriber_version INTEGER NOT NULL,
        event_id TEXT NOT NULL REFERENCES ingest(event_id),
        account_id TEXT NOT NULL,
        whatsapp_message_id TEXT,
        whatsapp_visibility_version INTEGER,
        encrypted_record BLOB NOT NULL,
        delivered_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL,
        switch_generation INTEGER NOT NULL,
        CHECK (expires_at > delivered_at),
        CHECK (expires_at - delivered_at <= 604800000),
        CHECK (
          (whatsapp_message_id IS NULL AND whatsapp_visibility_version IS NULL)
          OR (whatsapp_message_id IS NOT NULL AND whatsapp_visibility_version IS NOT NULL)
        ),
        FOREIGN KEY (account_id, whatsapp_message_id)
          REFERENCES whatsapp_occurrences(account_id, message_id)
      ) STRICT`,
      `INSERT INTO stream_log_v11
       (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
        event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
        expires_at, switch_generation)
       SELECT id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
              event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
              expires_at, switch_generation
         FROM stream_log`,
      'DROP TABLE stream_log',
      'ALTER TABLE stream_log_v11 RENAME TO stream_log',
      'CREATE INDEX stream_log_account_whatsapp_message ON stream_log(account_id, whatsapp_message_id)',
      'CREATE INDEX stream_log_replay ON stream_log(subscriber_id, subscriber_version, delivered_at, id)',
      "UPDATE meta SET value = '11' WHERE key = 'schema_version'",
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
