import type { DatabaseSync } from 'node:sqlite';
import { JUDGE_KINDS } from '../domain/lifecycle.ts';
import { PHASE_E_DURABLE_SCHEMA_STATEMENTS, SCHEMA_V1_STATEMENTS } from './schema-v1.ts';

const JUDGE_KIND_SQL_VALUES = JUDGE_KINDS.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(', ');

export interface EventMigration {
  readonly version: number;
  readonly name: string;
  readonly statements: readonly string[];
  /**
   * SQLite's documented way to change a parent table's constraints: rebuild it with foreign keys off for the
   * transaction, check every reference with `foreign_key_check` before the commit, then turn them back on.
   */
  readonly rebuildsParentTable?: true;
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
  {
    // D-C: an account's status observer keeps an ordering witness independent of a rollback-prone wall clock.
    version: 12,
    name: 'resend-status-high-water-v1',
    statements: [
      `CREATE TABLE resend_status_high_water (
        account_id TEXT PRIMARY KEY,
        high_water_at TEXT NOT NULL CHECK (high_water_at <> ''),
        scan_generation INTEGER NOT NULL CHECK (scan_generation > 0),
        updated_at INTEGER NOT NULL
      ) STRICT`,
      "UPDATE meta SET value = '12' WHERE key = 'schema_version'",
    ],
  },
  {
    // Committee decision (review round 12): a unit a list widening reveals is owed only rows after the apply instant.
    version: 13,
    name: 'event-whatsapp-visible-units-v1',
    statements: [
      `CREATE TABLE whatsapp_visible_units (
        account_id TEXT NOT NULL REFERENCES whatsapp_visibility(account_id),
        unit_key TEXT NOT NULL CHECK (unit_key <> ''),
        visible_since INTEGER,
        PRIMARY KEY (account_id, unit_key)
      ) STRICT`,
      "UPDATE meta SET value = '13' WHERE key = 'schema_version'",
    ],
  },
  {
    // B3 adds the hosted-judge credential slot without weakening the immutable owner/generation primary key.
    version: 14,
    name: 'event-secret-judge-slot-v1',
    statements: [
      'DROP INDEX event_secret_generations_current',
      `CREATE TABLE event_secret_generations_v14 (
        owner_kind TEXT NOT NULL CHECK (owner_kind IN ('target', 'subscriber', 'judge')),
        owner_id TEXT NOT NULL,
        owner_version INTEGER NOT NULL CHECK (owner_version > 0),
        purpose TEXT NOT NULL CHECK (purpose IN ('secret-url', 'webhook-signing', 'sse-bearer', 'judge-key')),
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
          OR (owner_kind = 'judge' AND purpose = 'judge-key')
        )
      ) STRICT`,
      `INSERT INTO event_secret_generations_v14
       SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
              encrypted_ref, lifecycle, expires_at, created_at
         FROM event_secret_generations`,
      'DROP TABLE event_secret_generations',
      'ALTER TABLE event_secret_generations_v14 RENAME TO event_secret_generations',
      `CREATE UNIQUE INDEX event_secret_generations_current
       ON event_secret_generations(owner_kind, owner_id, owner_version, purpose)
       WHERE lifecycle = 'current'`,
      "UPDATE meta SET value = '14' WHERE key = 'schema_version'",
    ],
  },
  {
    // D7 charges a target test before its synthetic transport, once per target across every immutable version.
    version: 15,
    name: 'target-test-charges-v1',
    statements: [
      `CREATE TABLE target_test_charges (
        id INTEGER PRIMARY KEY,
        target_id TEXT NOT NULL CHECK (target_id <> ''),
        charged_at INTEGER NOT NULL
      ) STRICT`,
      `CREATE INDEX target_test_charges_target_window
       ON target_test_charges(target_id, charged_at)`,
      "UPDATE meta SET value = '15' WHERE key = 'schema_version'",
    ],
  },
  {
    // Every issued B3 disclosure challenge has one durable origin row. A view row has its short deadline; a terminal
    // row has none. The row starts as `issuing` before core receives the new challenge, so an interruption (or a lost
    // row) can never be mistaken for an unrestricted terminal challenge.
    version: 16,
    name: 'activation-view-challenges-v1',
    statements: [
      `CREATE TABLE activation_view_challenges (
        approval_id TEXT PRIMARY KEY,
        state TEXT NOT NULL CHECK (state IN ('issuing', 'active', 'expired')),
        origin TEXT NOT NULL CHECK (origin IN ('view', 'terminal')),
        challenge_hash TEXT,
        expires_at INTEGER,
        updated_at INTEGER NOT NULL,
        CHECK (
          (state = 'issuing' AND challenge_hash IS NULL AND expires_at IS NULL)
          OR (state = 'active' AND challenge_hash IS NOT NULL AND origin = 'terminal' AND expires_at IS NULL)
          OR (state = 'active' AND challenge_hash IS NOT NULL AND origin = 'view' AND expires_at IS NOT NULL)
          OR (state = 'expired' AND challenge_hash IS NOT NULL AND origin = 'view' AND expires_at IS NOT NULL)
        )
      ) STRICT`,
      "UPDATE meta SET value = '16' WHERE key = 'schema_version'",
    ],
  },
  {
    // Phase E owns the next integrated number after B3's 14–16. Earlier migrations are recorded history and remain
    // untouched.
    version: 17,
    name: 'event-judge-hold-durability-v1',
    statements: [...PHASE_E_DURABLE_SCHEMA_STATEMENTS, "UPDATE meta SET value = '17' WHERE key = 'schema_version'"],
  },
  {
    // Source projections and ingest records are purgeable. The durable, content-free ledger must outlive either so
    // settled rolling-window audit rows can coexist with the atomic terminal projection purge (E-4/E-5).
    version: 18,
    name: 'event-judge-ledger-projection-detachment-v1',
    statements: [
      `CREATE TABLE judge_budget_reservations_v18 (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL UNIQUE,
        work_scope TEXT NOT NULL CHECK (work_scope IN ('source-owned', 'synthetic-test')),
        source TEXT,
        account_id TEXT,
        event_id TEXT,
        rule_id TEXT,
        rule_version INTEGER CHECK (rule_version > 0),
        judge_id TEXT NOT NULL,
        judge_version INTEGER NOT NULL CHECK (judge_version > 0),
        judge_kind TEXT NOT NULL CHECK (judge_kind IN (${JUDGE_KIND_SQL_VALUES})),
        test_work_id TEXT,
        budget_version INTEGER NOT NULL REFERENCES judge_budget_versions(version),
        provider TEXT,
        global_ledger_key TEXT NOT NULL CHECK (global_ledger_key = 'installation'),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'in-flight', 'settled', 'released')),
        estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
        actual_input_tokens INTEGER CHECK (actual_input_tokens >= 0),
        concurrency_owned INTEGER NOT NULL CHECK (concurrency_owned IN (0, 1)),
        reserved_at INTEGER NOT NULL,
        in_flight_at INTEGER,
        settled_at INTEGER,
        released_at INTEGER,
        switch_generation INTEGER NOT NULL CHECK (switch_generation >= 0),
        FOREIGN KEY (rule_id, rule_version) REFERENCES rule_versions(rule_id, version),
        FOREIGN KEY (judge_id, judge_version) REFERENCES judge_versions(judge_id, version),
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
      `INSERT INTO judge_budget_reservations_v18
       (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
        judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
        actual_input_tokens, concurrency_owned, reserved_at, in_flight_at, settled_at, released_at, switch_generation)
       SELECT id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
              judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
              actual_input_tokens, concurrency_owned, reserved_at, in_flight_at, settled_at, released_at, switch_generation
       FROM judge_budget_reservations`,
      'DROP TABLE judge_budget_reservations',
      'ALTER TABLE judge_budget_reservations_v18 RENAME TO judge_budget_reservations',
      `CREATE UNIQUE INDEX judge_budget_reservations_synthetic_work_identity
        ON judge_budget_reservations(test_work_id)
        WHERE work_scope = 'synthetic-test'`,
      `CREATE INDEX judge_budget_reservations_rule_rolling
        ON judge_budget_reservations(rule_id, reserved_at)
        WHERE work_scope = 'source-owned'`,
      `CREATE INDEX judge_budget_reservations_provider_rolling
        ON judge_budget_reservations(provider, reserved_at)
        WHERE provider IS NOT NULL`,
      `CREATE INDEX judge_budget_reservations_global_rolling
        ON judge_budget_reservations(global_ledger_key, reserved_at)`,
      `CREATE UNIQUE INDEX judge_budget_reservations_source_scope
        ON judge_budget_reservations(source, account_id, event_id, rule_id, rule_version)
        WHERE work_scope = 'source-owned'`,
      `CREATE INDEX judge_budget_reservations_synthetic_scope
        ON judge_budget_reservations(test_work_id, judge_id, judge_version)
        WHERE work_scope = 'synthetic-test'`,
      `CREATE INDEX judge_budget_reservations_kind_scope
        ON judge_budget_reservations(judge_kind, work_scope, state)`,
      "UPDATE meta SET value = '18' WHERE key = 'schema_version'",
    ],
  },
  {
    // A disable must beat a prepare that yielded before it could persist an activation intent. The per-kind fence is
    // content-free and advances even when the kind pointer is already absent.
    version: 19,
    name: 'event-judge-kind-disable-generations-v1',
    statements: [
      `CREATE TABLE judge_kind_disable_generations (
        kind TEXT PRIMARY KEY CHECK (kind IN (${JUDGE_KIND_SQL_VALUES})),
        generation INTEGER NOT NULL CHECK (generation >= 0),
        disabled_at INTEGER NOT NULL
      ) STRICT`,
      "UPDATE meta SET value = '19' WHERE key = 'schema_version'",
    ],
  },
  {
    // A synthetic test is charged globally, but it is never authority-free: persist the exact active rule (or the
    // pending-approval activation) so every post-await transport fence can prove it is still authorised.
    version: 20,
    name: 'event-judge-test-authority-binding-v1',
    statements: [
      'ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_rule_id TEXT',
      'ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_rule_version INTEGER CHECK (test_authority_rule_version > 0)',
      'ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_activation_id TEXT',
      'ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_approval_id TEXT',
      "ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_challenge_hash TEXT CHECK (test_authority_challenge_hash IS NULL OR (length(test_authority_challenge_hash) = 64 AND test_authority_challenge_hash NOT GLOB '*[^0-9a-f]*'))",
      "ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_challenge_origin TEXT CHECK (test_authority_challenge_origin IN ('terminal', 'view'))",
      'ALTER TABLE judge_budget_reservations ADD COLUMN test_authority_challenge_expires_at INTEGER',
      `CREATE INDEX judge_budget_reservations_synthetic_authority
        ON judge_budget_reservations(test_authority_rule_id, test_authority_rule_version, test_authority_activation_id,
          test_authority_approval_id, test_authority_challenge_hash)
        WHERE work_scope = 'synthetic-test'`,
      "UPDATE meta SET value = '20' WHERE key = 'schema_version'",
    ],
  },
  {
    // Account ids are provider-owned identifiers. A revocation therefore fences the exact discriminated source and
    // account pair; migrated source-less rows remain a conservative wildcard for every source.
    version: 21,
    name: 'event-account-revocation-source-scope-v1',
    statements: [
      `CREATE TABLE account_revocations_v21 (
        source TEXT CHECK (source IS NULL OR source IN ('gmail', 'slack', 'resend', 'whatsapp')),
        account_id TEXT NOT NULL,
        revoked_at INTEGER NOT NULL,
        UNIQUE (source, account_id)
      ) STRICT`,
      `INSERT INTO account_revocations_v21 (source, account_id, revoked_at)
       SELECT NULL, account_id, revoked_at FROM account_revocations`,
      'DROP TABLE account_revocations',
      'ALTER TABLE account_revocations_v21 RENAME TO account_revocations',
      'CREATE INDEX account_revocations_account_source ON account_revocations(account_id, source)',
      "UPDATE meta SET value = '21' WHERE key = 'schema_version'",
    ],
  },
  {
    // Reservation rows are physical attempts. Terminal attempts remain immutable history; one partial unique index
    // fences only the live attempt for a logical work id, so a pre-I/O retry inserts a new row without resetting its
    // predecessor or its rolling-ledger identity.
    version: 22,
    name: 'event-judge-budget-attempts-v1',
    statements: [
      `CREATE TABLE judge_budget_reservations_v22 (
        id TEXT PRIMARY KEY,
        work_id TEXT NOT NULL,
        work_scope TEXT NOT NULL CHECK (work_scope IN ('source-owned', 'synthetic-test')),
        source TEXT,
        account_id TEXT,
        event_id TEXT,
        rule_id TEXT,
        rule_version INTEGER CHECK (rule_version > 0),
        judge_id TEXT NOT NULL,
        judge_version INTEGER NOT NULL CHECK (judge_version > 0),
        judge_kind TEXT NOT NULL CHECK (judge_kind IN (${JUDGE_KIND_SQL_VALUES})),
        test_work_id TEXT,
        budget_version INTEGER NOT NULL REFERENCES judge_budget_versions(version),
        provider TEXT,
        global_ledger_key TEXT NOT NULL CHECK (global_ledger_key = 'installation'),
        state TEXT NOT NULL CHECK (state IN ('reserved', 'in-flight', 'settled', 'released')),
        estimated_input_tokens INTEGER NOT NULL CHECK (estimated_input_tokens >= 0),
        actual_input_tokens INTEGER CHECK (actual_input_tokens >= 0),
        concurrency_owned INTEGER NOT NULL CHECK (concurrency_owned IN (0, 1)),
        reserved_at INTEGER NOT NULL,
        in_flight_at INTEGER,
        settled_at INTEGER,
        released_at INTEGER,
        switch_generation INTEGER NOT NULL CHECK (switch_generation >= 0),
        test_authority_rule_id TEXT,
        test_authority_rule_version INTEGER CHECK (test_authority_rule_version > 0),
        test_authority_activation_id TEXT,
        test_authority_approval_id TEXT,
        test_authority_challenge_hash TEXT CHECK (
          test_authority_challenge_hash IS NULL
          OR (length(test_authority_challenge_hash) = 64
            AND test_authority_challenge_hash NOT GLOB '*[^0-9a-f]*')
        ),
        test_authority_challenge_origin TEXT CHECK (test_authority_challenge_origin IN ('terminal', 'view')),
        test_authority_challenge_expires_at INTEGER,
        FOREIGN KEY (rule_id, rule_version) REFERENCES rule_versions(rule_id, version),
        FOREIGN KEY (judge_id, judge_version) REFERENCES judge_versions(judge_id, version),
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
      `INSERT INTO judge_budget_reservations_v22
       (id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
        judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
        actual_input_tokens, concurrency_owned, reserved_at, in_flight_at, settled_at, released_at, switch_generation,
        test_authority_rule_id, test_authority_rule_version, test_authority_activation_id, test_authority_approval_id,
        test_authority_challenge_hash, test_authority_challenge_origin, test_authority_challenge_expires_at)
       SELECT id, work_id, work_scope, source, account_id, event_id, rule_id, rule_version, judge_id, judge_version,
              judge_kind, test_work_id, budget_version, provider, global_ledger_key, state, estimated_input_tokens,
              actual_input_tokens, concurrency_owned, reserved_at, in_flight_at, settled_at, released_at,
              switch_generation, test_authority_rule_id, test_authority_rule_version, test_authority_activation_id,
              test_authority_approval_id, test_authority_challenge_hash, test_authority_challenge_origin,
              test_authority_challenge_expires_at
       FROM judge_budget_reservations`,
      'DROP TABLE judge_budget_reservations',
      'ALTER TABLE judge_budget_reservations_v22 RENAME TO judge_budget_reservations',
      `CREATE UNIQUE INDEX judge_budget_reservations_live_work_identity
        ON judge_budget_reservations(work_id)
        WHERE state IN ('reserved', 'in-flight')`,
      `CREATE INDEX judge_budget_reservations_rule_rolling
        ON judge_budget_reservations(rule_id, reserved_at)
        WHERE work_scope = 'source-owned'`,
      `CREATE INDEX judge_budget_reservations_provider_rolling
        ON judge_budget_reservations(provider, reserved_at)
        WHERE provider IS NOT NULL`,
      `CREATE INDEX judge_budget_reservations_global_rolling
        ON judge_budget_reservations(global_ledger_key, reserved_at)`,
      `CREATE UNIQUE INDEX judge_budget_reservations_source_scope
        ON judge_budget_reservations(source, account_id, event_id, rule_id, rule_version)
        WHERE work_scope = 'source-owned' AND state IN ('reserved', 'in-flight')`,
      `CREATE INDEX judge_budget_reservations_synthetic_scope
        ON judge_budget_reservations(test_work_id, judge_id, judge_version, state)
        WHERE work_scope = 'synthetic-test'`,
      `CREATE INDEX judge_budget_reservations_kind_scope
        ON judge_budget_reservations(judge_kind, work_scope, state)`,
      `CREATE INDEX judge_budget_reservations_synthetic_authority
        ON judge_budget_reservations(test_authority_rule_id, test_authority_rule_version, test_authority_activation_id,
          test_authority_approval_id, test_authority_challenge_hash)
        WHERE work_scope = 'synthetic-test'`,
      `CREATE TRIGGER judge_budget_reservations_state_machine
       BEFORE UPDATE OF state ON judge_budget_reservations
       WHEN NEW.state <> OLD.state AND NOT (
         (OLD.state = 'reserved' AND NEW.state IN ('in-flight', 'released'))
         OR (OLD.state = 'in-flight' AND NEW.state = 'settled')
       )
       BEGIN
         SELECT RAISE(ABORT, 'invalid judge reservation state transition');
       END`,
      "UPDATE meta SET value = '22' WHERE key = 'schema_version'",
    ],
  },
  {
    // E2 keeps model lifecycle state separate from the sole kind-enablement pointer.  It records no tree location
    // or model material: the pointer remains the authority and this table is only content-free progress state.
    version: 23,
    name: 'event-laya-model-state-v1',
    statements: [
      `CREATE TABLE laya_models (
        manifest_id TEXT PRIMARY KEY CHECK (manifest_id <> ''),
        state TEXT NOT NULL CHECK (state IN ('installing', 'downloading', 'ready', 'failed', 'removed')),
        bytes_verified INTEGER NOT NULL CHECK (bytes_verified >= 0),
        verified_at INTEGER,
        failure_code TEXT,
        updated_at INTEGER NOT NULL CHECK (updated_at >= 0)
      ) STRICT`,
      "UPDATE meta SET value = '23' WHERE key = 'schema_version'",
    ],
  },
  {
    // The action queue (0.30.0): a delivery may target a local queue, and each match appends one encrypted item. The
    // deliveries kind check is a closed set, so the table is rebuilt with its exact columns, in order, to admit it.
    version: 24,
    name: 'event-action-queue-v1',
    rebuildsParentTable: true,
    statements: [
      `CREATE TABLE deliveries_v24 (
        id TEXT PRIMARY KEY,
        decision_id TEXT NOT NULL REFERENCES decisions(id),
        account_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL,
        target_key TEXT NOT NULL,
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL,
        encrypted_record BLOB,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        cap_charged_at INTEGER,
        next_at INTEGER,
        expires_at INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('queued', 'retryable', 'disclosing', 'delivered', 'dead-lettered', 'retention-expired', 'cancelled', 'content-unreadable', 'in-flight-at-disable', 'in-flight-at-account-removal')),
        switch_generation INTEGER NOT NULL,
        lease_until INTEGER,
        last_error_code TEXT,
        last_status INTEGER,
        target_kind TEXT NOT NULL DEFAULT 'dry-run' CHECK (target_kind IN ('dry-run', 'webhook', 'sse', 'queue')),
        target_representation TEXT NOT NULL DEFAULT 'plain' CHECK (target_representation IN ('plain', 'enveloped')),
        subscriber_id TEXT,
        subscriber_version INTEGER,
        attempt_id TEXT,
        lease_token TEXT,
        ordering_sequence INTEGER NOT NULL DEFAULT 0 CHECK (ordering_sequence >= 0),
        dead_lettered_at INTEGER,
        dead_letter_expires_at INTEGER,
        whatsapp_visibility_version INTEGER,
        whatsapp_message_id TEXT,
        UNIQUE (decision_id, target_key),
        -- Only work that may still disclose holds its payload; a terminal delivery's record is purged (D12, D8).
        CHECK (encrypted_record IS NOT NULL OR state NOT IN ('queued', 'retryable', 'disclosing'))
      ) STRICT`,
      `INSERT INTO deliveries_v24
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record,
        attempts, cap_charged_at, next_at, expires_at, state, switch_generation, lease_until, last_error_code,
        last_status, target_kind, target_representation, subscriber_id, subscriber_version, attempt_id, lease_token,
        ordering_sequence, dead_lettered_at, dead_letter_expires_at, whatsapp_visibility_version, whatsapp_message_id)
       SELECT id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
              encrypted_record, attempts, cap_charged_at, next_at, expires_at, state, switch_generation, lease_until,
              last_error_code, last_status, target_kind, target_representation, subscriber_id, subscriber_version,
              attempt_id, lease_token, ordering_sequence, dead_lettered_at, dead_letter_expires_at,
              whatsapp_visibility_version, whatsapp_message_id
         FROM deliveries ORDER BY rowid`,
      'DROP TABLE deliveries',
      'ALTER TABLE deliveries_v24 RENAME TO deliveries',
      `CREATE INDEX deliveries_stable_order
       ON deliveries(rule_id, account_id, target_id, ordering_sequence, state, lease_until)`,
      // One item per queue delivery. Its content (`encrypted_record`) goes at `expires_at`, whatever its state; the
      // content-free row (rule, state, times) stays one retention more, for the counts, then goes too (Q2, §4.3).
      `CREATE TABLE queue_items (
        id TEXT PRIMARY KEY CHECK (
          length(id) = 29 AND substr(id, 1, 3) = 'qi_' AND substr(id, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
        ),
        delivery_id TEXT NOT NULL UNIQUE REFERENCES deliveries(id),
        decision_id TEXT NOT NULL,
        event_id TEXT NOT NULL,
        rule_id TEXT NOT NULL,
        rule_version INTEGER NOT NULL CHECK (rule_version > 0),
        target_id TEXT NOT NULL,
        target_version INTEGER NOT NULL CHECK (target_version > 0),
        account_id TEXT NOT NULL,
        channel TEXT NOT NULL CHECK (channel IN ('gmail', 'slack', 'resend', 'whatsapp')),
        whatsapp_message_id TEXT,
        state TEXT NOT NULL CHECK (state IN ('open', 'done', 'dismissed')),
        state_at INTEGER NOT NULL,
        arrived_at INTEGER NOT NULL,
        appended_at INTEGER NOT NULL,
        retention_ms INTEGER NOT NULL CHECK (retention_ms >= 86400000 AND retention_ms <= 2592000000),
        expires_at INTEGER NOT NULL,
        row_expires_at INTEGER NOT NULL,
        released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
        encrypted_record BLOB,
        CHECK (expires_at > appended_at AND expires_at - appended_at <= retention_ms),
        CHECK (row_expires_at >= expires_at AND row_expires_at - expires_at <= retention_ms),
        CHECK ((channel = 'whatsapp') = (whatsapp_message_id IS NOT NULL))
      ) STRICT`,
      'CREATE INDEX queue_items_rule_version ON queue_items(rule_id, rule_version)',
      'CREATE INDEX queue_items_state_arrived ON queue_items(state, arrived_at, id)',
      'CREATE INDEX queue_items_account_whatsapp_message ON queue_items(account_id, whatsapp_message_id)',
      'CREATE INDEX queue_items_expiry ON queue_items(expires_at) WHERE encrypted_record IS NOT NULL',
      'CREATE INDEX queue_items_row_expiry ON queue_items(row_expires_at)',
      "UPDATE meta SET value = '24' WHERE key = 'schema_version'",
    ],
  },
  {
    // Routing's lanes (routing design 2026-10-25, §6 B1, B3, B5). A binding is keyed by the lane's name and holds the
    // window the person bound to it, and since when; a window is bound to one lane at most (the two UNIQUE ids). The
    // windows the event service's MCP server has reported are kept so the person can bind one by either of its ids.
    // A binding ends when no active rule's queue target carries its lane any more — the triggers run on every rule
    // pointer change, whichever path makes it — and with disable-all, which revokes everything.
    version: 25,
    name: 'routing-lane-bindings-v1',
    statements: [
      `CREATE TABLE lane_bindings (
        lane TEXT PRIMARY KEY CHECK (length(lane) BETWEEN 1 AND 40 AND lane NOT GLOB '*[^a-z0-9-]*'),
        binding_id TEXT NOT NULL UNIQUE,
        session_id TEXT UNIQUE CHECK (session_id IS NULL OR length(session_id) = 36),
        activity_key TEXT UNIQUE CHECK (
          activity_key IS NULL OR (length(activity_key) = 16 AND activity_key NOT GLOB '*[^0-9a-f]*')
        ),
        folder TEXT,
        client_name TEXT,
        client_version TEXT,
        since INTEGER NOT NULL,
        CHECK (session_id IS NOT NULL OR activity_key IS NOT NULL),
        CHECK (client_name IS NOT NULL OR client_version IS NULL)
      ) STRICT`,
      `CREATE TABLE lane_windows (
        activity_key TEXT PRIMARY KEY CHECK (length(activity_key) = 16 AND activity_key NOT GLOB '*[^0-9a-f]*'),
        session_id TEXT CHECK (session_id IS NULL OR length(session_id) = 36),
        grouped INTEGER NOT NULL CHECK (grouped IN (0, 1)),
        folder TEXT,
        client_name TEXT,
        client_version TEXT,
        last_seen_at INTEGER NOT NULL,
        CHECK (client_name IS NOT NULL OR client_version IS NULL)
      ) STRICT`,
      'CREATE INDEX lane_windows_session ON lane_windows(session_id, last_seen_at) WHERE session_id IS NOT NULL',
      'CREATE INDEX lane_windows_seen ON lane_windows(last_seen_at)',
      ...(['UPDATE', 'DELETE'] as const).map(
        (change) => `CREATE TRIGGER lane_bindings_follow_rule_pointer_${change.toLowerCase()}
        AFTER ${change} ON active_versions WHEN OLD.kind = 'rule'
        BEGIN
          DELETE FROM lane_bindings WHERE lane NOT IN (
            SELECT json_extract(target.value, '$.lane.name')
              FROM active_versions AS pointer
              JOIN rule_versions AS stored ON stored.rule_id = pointer.object_id AND stored.version = pointer.version
              JOIN json_each(stored.document, '$.targets') AS target
             WHERE pointer.kind = 'rule'
               AND json_extract(target.value, '$.kind') = 'queue'
               AND json_extract(target.value, '$.lane.name') IS NOT NULL
          );
        END`,
      ),
      `CREATE TRIGGER lane_bindings_end_with_disable_all
        AFTER UPDATE OF enabled ON event_settings WHEN OLD.enabled = 1 AND NEW.enabled = 0
        BEGIN
          DELETE FROM lane_bindings;
        END`,
      "UPDATE meta SET value = '25' WHERE key = 'schema_version'",
    ],
  },
  {
    // A queue item's history (0.32.0 spec §3.6): a window woken for it, a window reading it, and Done, Dismiss and
    // Reopen, each with who did it — an agent window by its activity session key, or the person (no key). Ids and times
    // only. It goes with its item: the trigger runs on every delete of an item row, whichever path purges it (expiry,
    // revocation, account removal, queue clear). Never read over MCP, and never written to core's activity log.
    version: 26,
    name: 'event-queue-item-history-v1',
    statements: [
      `CREATE TABLE queue_item_history (
        item_id TEXT NOT NULL CHECK (
          length(item_id) = 29 AND substr(item_id, 1, 3) = 'qi_' AND substr(item_id, 4) NOT GLOB '*[^0-9A-HJKMNP-TV-Z]*'
        ),
        at INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('woken', 'read', 'done', 'dismissed', 'reopened')),
        actor TEXT NOT NULL CHECK (actor IN ('person', 'window')),
        window_key TEXT CHECK (
          window_key IS NULL OR (length(window_key) = 16 AND window_key NOT GLOB '*[^0-9a-f]*')
        ),
        CHECK ((actor = 'window') = (window_key IS NOT NULL)),
        CHECK (actor = 'window' OR kind NOT IN ('woken', 'read'))
      ) STRICT`,
      'CREATE INDEX queue_item_history_item ON queue_item_history(item_id, at)',
      `CREATE TRIGGER queue_item_history_goes_with_its_item
        AFTER DELETE ON queue_items
        BEGIN
          DELETE FROM queue_item_history WHERE item_id = OLD.id;
        END`,
      "UPDATE meta SET value = '26' WHERE key = 'schema_version'",
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

/** The highest schema version a database's ledger records, or 0 when it has no ledger yet. It only reads. */
export function recordedSchemaVersion(database: DatabaseSync): number {
  const ledger = database
    .prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (ledger === undefined) return 0;
  const recorded = database.prepare('SELECT MAX(version) AS version FROM schema_migrations').get() as {
    version: number | null;
  };
  return recorded.version ?? 0;
}

/** Refuses a recorded schema version newer than this binary's, naming both and nothing else. */
export function refuseNewerVersion(
  databaseVersion: number,
  migrations: readonly EventMigration[] = EVENT_MIGRATIONS,
): void {
  const binaryVersion = migrations.at(-1)?.version ?? 0;
  if (databaseVersion > binaryVersion)
    throw new Error(
      `event database schema version ${databaseVersion} is newer than this release's schema version ${binaryVersion}; only the newer release that migrated it can open it`,
    );
}

/**
 * Refuses a database a newer agent-events has migrated, by reading its ledger and nothing else: no table is created and
 * nothing is written, so it runs before the opener sets a journal mode or this file creates its ledger. A database
 * with no ledger yet is new, and passes.
 */
export function refuseNewerSchema(
  database: DatabaseSync,
  migrations: readonly EventMigration[] = EVENT_MIGRATIONS,
): void {
  refuseNewerVersion(recordedSchemaVersion(database), migrations);
}

/** Applies ordered daemon-owned migrations, one BEGIN IMMEDIATE transaction per version. */
export function applyMigrations(
  database: DatabaseSync,
  migrations: readonly EventMigration[] = EVENT_MIGRATIONS,
  hooks: MigrationHooks = {},
): void {
  refuseNewerSchema(database, migrations);
  initialiseLedger(database);
  for (const [index, migration] of migrations.entries()) {
    if (migration.version !== index + 1)
      throw new Error('event migrations must have consecutive versions starting at 1');
  }
  const applied = database.prepare('SELECT version, name FROM schema_migrations ORDER BY version').all() as Array<{
    version: number;
    name: string;
  }>;
  refuseNewerVersion(applied.at(-1)?.version ?? 0, migrations);
  for (const migration of migrations) {
    const recorded = applied.find((entry) => entry.version === migration.version);
    if (recorded) {
      if (recorded.name !== migration.name)
        throw new Error(`event migration ${migration.version} does not match its ledger name`);
      continue;
    }
    // PRAGMA foreign_keys is a no-op inside a transaction, so a parent-table rebuild switches it before BEGIN.
    const foreignKeys = migration.rebuildsParentTable
      ? (database.prepare('PRAGMA foreign_keys').get() as { foreign_keys: number }).foreign_keys
      : undefined;
    if (foreignKeys !== undefined) database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec('BEGIN IMMEDIATE');
      try {
        migration.statements.forEach((statement, statementIndex) => {
          hooks.beforeStatement?.({ migration, statementIndex });
          database.exec(statement);
        });
        if (foreignKeys !== undefined && database.prepare('PRAGMA foreign_key_check').all().length > 0)
          throw new Error(`event migration ${migration.version} would leave a foreign key without its row`);
        database
          .prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)')
          .run(migration.version, migration.name, Date.now());
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
    } finally {
      if (foreignKeys !== undefined) database.exec(`PRAGMA foreign_keys = ${foreignKeys === 1 ? 'ON' : 'OFF'}`);
    }
  }
}
