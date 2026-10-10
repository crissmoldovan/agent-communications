import { JUDGE_KINDS } from '../domain/lifecycle.ts';

const JUDGE_KIND_SQL_VALUES = JUDGE_KINDS.map((kind) => `'${kind.replaceAll("'", "''")}'`).join(', ');

export const SCHEMA_V1_STATEMENTS: readonly string[] = [
  `CREATE TABLE meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT`,
  `INSERT INTO meta (key, value) VALUES ('schema_version', '1'), ('reset_epoch', '0')`,
  `CREATE TABLE event_settings (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    switch_generation INTEGER NOT NULL CHECK (switch_generation >= 0),
    changed_at INTEGER NOT NULL,
    activation_id TEXT
  ) STRICT`,
  `INSERT INTO event_settings (singleton, enabled, switch_generation, changed_at) VALUES (1, 0, 0, 0)`,
  `CREATE TABLE event_secret_masters (
    key_id TEXT PRIMARY KEY,
    secret_ref TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    retired_at INTEGER
  ) STRICT`,
  `CREATE TABLE nonce_counters (
    key_id TEXT NOT NULL REFERENCES event_secret_masters(key_id),
    table_name TEXT NOT NULL,
    invocations INTEGER NOT NULL CHECK (invocations >= 0),
    PRIMARY KEY (key_id, table_name)
  ) STRICT`,
  `CREATE TABLE rule_versions (
    id TEXT PRIMARY KEY,
    rule_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    state TEXT CHECK (state IN ('active', 'superseded', 'revoked')),
    approval_id TEXT,
    authorization_activation_id TEXT,
    activated_at INTEGER,
    superseded_at INTEGER,
    revoked_at INTEGER,
    UNIQUE (rule_id, version),
    CHECK (
      (state IS NULL AND approval_id IS NULL AND authorization_activation_id IS NULL AND activated_at IS NULL AND superseded_at IS NULL AND revoked_at IS NULL)
      OR (state IS NOT NULL AND approval_id IS NOT NULL AND authorization_activation_id IS NOT NULL AND activated_at IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE target_versions (
    id TEXT PRIMARY KEY,
    target_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    revoked_at INTEGER,
    UNIQUE (target_id, version)
  ) STRICT`,
  `CREATE TABLE judge_versions (
    id TEXT PRIMARY KEY,
    judge_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    revoked_at INTEGER,
    UNIQUE (judge_id, version)
  ) STRICT`,
  `CREATE TABLE judge_budget_versions (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL UNIQUE CHECK (version > 0),
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    revoked_at INTEGER
  ) STRICT`,
  `CREATE TABLE judge_kind_versions (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN (${JUDGE_KIND_SQL_VALUES})),
    version INTEGER NOT NULL CHECK (version > 0),
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    revoked_at INTEGER,
    UNIQUE (kind, version)
  ) STRICT`,
  `CREATE TABLE active_versions (
    kind TEXT NOT NULL CHECK (kind IN ('rule', 'judge-budget', 'judge-kind')),
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    current_cutover_id TEXT,
    activated_at INTEGER NOT NULL,
    PRIMARY KEY (kind, object_id)
  ) STRICT`,
  `CREATE TABLE derived_authorizations (
    version_id TEXT PRIMARY KEY REFERENCES rule_versions(id),
    parent_approval_id TEXT NOT NULL,
    parent_version_id TEXT NOT NULL REFERENCES rule_versions(id),
    edit_kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE object_revocations (
    kind TEXT NOT NULL CHECK (kind IN ('target', 'judge')),
    object_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version > 0),
    revoked_at INTEGER NOT NULL,
    PRIMARY KEY (kind, object_id, version)
  ) STRICT`,
  `CREATE TABLE activation_intents (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    document TEXT NOT NULL,
    digest TEXT NOT NULL,
    effect TEXT NOT NULL,
    replacement_of_version TEXT REFERENCES rule_versions(id),
    required_points TEXT NOT NULL,
    acquisition_scopes TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'pending-completion', 'completed', 'failed', 'cancelled')),
    claimed_at INTEGER,
    completion_deadline INTEGER,
    failure_code TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE UNIQUE INDEX one_pending_replacement_per_rule
    ON activation_intents(replacement_of_version)
    WHERE replacement_of_version IS NOT NULL AND status IN ('pending', 'pending-completion')`,
  `CREATE TABLE activations (
    id TEXT PRIMARY KEY,
    intent_id TEXT NOT NULL REFERENCES activation_intents(id),
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE revocations (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    version INTEGER,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE rule_activation_points (
    activation_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position_scope TEXT NOT NULL,
    encrypted_position BLOB NOT NULL,
    inherited_from_version_id TEXT REFERENCES rule_versions(id),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (activation_id, rule_id, rule_version, account_id, position_scope)
  ) STRICT`,
  `CREATE TABLE activation_baselines (
    intent_id TEXT NOT NULL REFERENCES activation_intents(id),
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position_scope TEXT NOT NULL,
    encrypted_position BLOB NOT NULL,
    response_at INTEGER NOT NULL,
    PRIMARY KEY (intent_id, source, account_id, position_scope)
  ) STRICT`,
  `CREATE TABLE replacement_drains (
    intent_id TEXT NOT NULL REFERENCES activation_intents(id),
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    position_scope TEXT NOT NULL,
    old_in_scope INTEGER NOT NULL CHECK (old_in_scope IN (0, 1)),
    new_in_scope INTEGER NOT NULL CHECK (new_in_scope IN (0, 1)),
    drained_at INTEGER,
    PRIMARY KEY (intent_id, source, account_id, position_scope)
  ) STRICT`,
  `CREATE TABLE cursors (
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    cursor_scope TEXT NOT NULL,
    cursor TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (source, account_id, cursor_scope)
  ) STRICT`,
  `CREATE TABLE source_scan_state (
    id TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    cursor_scope TEXT NOT NULL,
    staged_at INTEGER,
    stage_expires_at INTEGER,
    encrypted_record BLOB NOT NULL,
    updated_at INTEGER NOT NULL,
    CHECK ((staged_at IS NULL AND stage_expires_at IS NULL) OR (staged_at IS NOT NULL AND stage_expires_at IS NOT NULL))
  ) STRICT`,
  `CREATE TABLE source_occurrence_resolutions (
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('vanished', 'unresolvable', 'retention-expired')),
    resolved_at INTEGER NOT NULL,
    error_code TEXT,
    PRIMARY KEY (source, account_id, occurrence_key)
  ) STRICT`,
  `CREATE TABLE source_projection_resolutions (
    source TEXT NOT NULL,
    account_id TEXT NOT NULL,
    occurrence_key TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    materialization_key TEXT NOT NULL,
    outcome TEXT NOT NULL CHECK (outcome IN ('vanished', 'unresolvable', 'retention-expired')),
    resolved_at INTEGER NOT NULL,
    error_code TEXT,
    PRIMARY KEY (source, account_id, occurrence_key, rule_id, rule_version, materialization_key)
  ) STRICT`,
  `CREATE TABLE ingest (
    event_id TEXT PRIMARY KEY,
    installation_id TEXT NOT NULL,
    type TEXT NOT NULL,
    version INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    dedupe_key TEXT NOT NULL,
    occurred_at INTEGER NOT NULL,
    observed_at INTEGER NOT NULL,
    staged_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE ingest_rules (
    event_id TEXT NOT NULL REFERENCES ingest(event_id),
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    decision_deadline INTEGER NOT NULL,
    encrypted_projection BLOB NOT NULL,
    PRIMARY KEY (event_id, rule_id, rule_version)
  ) STRICT`,
  `CREATE TABLE decisions (
    id TEXT PRIMARY KEY,
    event_id TEXT NOT NULL REFERENCES ingest(event_id),
    account_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    outcome TEXT NOT NULL,
    hold_expires_at INTEGER,
    hold_bound_by TEXT CHECK (hold_bound_by IN ('hold-window', 'ingest-retention')),
    metadata_expires_at INTEGER NOT NULL,
    metadata_state TEXT NOT NULL,
    purged_at INTEGER,
    encrypted_record BLOB,
    UNIQUE (event_id, rule_id, rule_version)
  ) STRICT`,
  `CREATE TABLE deliveries (
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
    UNIQUE (decision_id, target_key),
    -- Only work that may still disclose holds its payload; a terminal delivery's record is purged (D12, D8).
    CHECK (encrypted_record IS NOT NULL OR state NOT IN ('queued', 'retryable', 'disclosing'))
  ) STRICT`,
  `CREATE TABLE dryrun_log (
    delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    event_id TEXT NOT NULL REFERENCES ingest(event_id),
    account_id TEXT NOT NULL,
    encrypted_record BLOB NOT NULL,
    delivered_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    CHECK (expires_at > delivered_at),
    CHECK (expires_at - delivered_at <= 86400000)
  ) STRICT`,
  `CREATE TABLE worker_leases (
    work_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    switch_generation INTEGER NOT NULL,
    lease_until INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE work_attempts (
    id TEXT PRIMARY KEY,
    work_id TEXT NOT NULL,
    switch_generation INTEGER NOT NULL,
    code TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE delivery_cap_charges (
    delivery_id TEXT PRIMARY KEY REFERENCES deliveries(id),
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL,
    charged_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE reset_barriers (
    reset_epoch INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('open', 'closed', 'degraded')),
    reset_delivery_id TEXT,
    degraded_at INTEGER,
    PRIMARY KEY (reset_epoch, target_id, target_version)
  ) STRICT`,
  `CREATE TABLE reset_notices (
    id TEXT PRIMARY KEY,
    reset_epoch INTEGER NOT NULL,
    target_id TEXT NOT NULL,
    target_version INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE account_revocations (
    account_id TEXT PRIMARY KEY,
    revoked_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE operational_records (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT`,
];

/**
 * Forward-only Phase E storage.  This lives beside the v1 declaration so a fresh install and an upgrade share one
 * exact shape, while migration 1 itself remains byte-for-byte historical.
 */
export const PHASE_E_DURABLE_SCHEMA_STATEMENTS: readonly string[] = [
  'ALTER TABLE decisions ADD COLUMN hold_created_at INTEGER',
  'CREATE UNIQUE INDEX decisions_hold_claim_identity ON decisions(id, account_id, rule_id, rule_version)',
  'CREATE UNIQUE INDEX ingest_event_account_identity ON ingest(event_id, account_id)',
  `CREATE TABLE hold_resolution_claims (
    decision_id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL,
    rule_id TEXT NOT NULL,
    rule_version INTEGER NOT NULL CHECK (rule_version > 0),
    claim_token BLOB NOT NULL UNIQUE CHECK (length(claim_token) = 32),
    claimed_at INTEGER NOT NULL,
    lease_expires_at INTEGER NOT NULL,
    FOREIGN KEY (decision_id, account_id, rule_id, rule_version)
      REFERENCES decisions(id, account_id, rule_id, rule_version) ON DELETE CASCADE,
    CHECK (lease_expires_at > claimed_at)
  ) STRICT`,
  'CREATE INDEX hold_resolution_claims_lease_expiry ON hold_resolution_claims(lease_expires_at)',
  `CREATE TABLE judge_budget_reservations (
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
    FOREIGN KEY (event_id, account_id) REFERENCES ingest(event_id, account_id),
    FOREIGN KEY (event_id, rule_id, rule_version) REFERENCES ingest_rules(event_id, rule_id, rule_version),
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
  `CREATE TABLE judge_test_charges (
    judge_id TEXT NOT NULL,
    judge_version INTEGER NOT NULL CHECK (judge_version > 0),
    charged_at INTEGER NOT NULL,
    work_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (judge_id, judge_version, work_id),
    FOREIGN KEY (judge_id, judge_version) REFERENCES judge_versions(judge_id, version)
  ) STRICT`,
  'CREATE INDEX judge_test_charges_rolling ON judge_test_charges(judge_id, judge_version, charged_at)',
];
