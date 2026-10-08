import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { isWhitelistedTightening } from './disclosure-fence.ts';

export type TighteningKind =
  | 'remove-target'
  | 'remove-output-field'
  | 'lower-rate-cap'
  | 'shorten-retention'
  | 'narrow-source-options';

const TIGHTENING_KINDS: readonly TighteningKind[] = [
  'remove-target',
  'remove-output-field',
  'lower-rate-cap',
  'shorten-retention',
  'narrow-source-options',
];

interface BaselinePosition {
  readonly historyId: string;
}

interface DrainRow {
  readonly intent_id: string;
  readonly replacement_of_version: string;
  readonly encrypted_position: Uint8Array;
}

function ruleVersionId(ruleId: string, version: number): string {
  return `${ruleId}@${version}`;
}

function historyId(value: string, field: string): bigint {
  if (!/^[0-9]+$/u.test(value)) throw new CommsError('BAD_DATA', `${field} is not an unsigned Gmail history id`);
  return BigInt(value);
}

function position(value: unknown): BaselinePosition {
  if (
    typeof value !== 'object' ||
    value === null ||
    !Object.hasOwn(value, 'historyId') ||
    typeof (value as { historyId?: unknown }).historyId !== 'string'
  ) {
    throw new CommsError('BAD_DATA', 'a replacement baseline has no Gmail history id');
  }
  return value as BaselinePosition;
}

/** Returns the one syntactic whitelist edit a pair of canonical versions represents, if any. */
export function tighteningKind(
  parent: CanonicalFullRuleDocument,
  child: CanonicalFullRuleDocument,
): TighteningKind | null {
  return TIGHTENING_KINDS.find((kind) => isWhitelistedTightening(parent, child, kind)) ?? null;
}

/**
 * The production fence used by GmailSourceWorker while an exact replacement remains pending. Baselines stay encrypted
 * in activation_baselines; this helper consumes them through the supplied record decryptor and never adds a plaintext
 * cursor to replacement_drains.
 */
export class GmailReplacementDrains {
  readonly #database: DatabaseSync;
  readonly #decryptBaseline: (record: Uint8Array) => Promise<unknown>;
  readonly #now: () => number;

  constructor(options: {
    readonly database: DatabaseSync;
    readonly decryptBaseline: (record: Uint8Array) => Promise<unknown>;
    readonly now?: (() => number) | undefined;
  }) {
    this.#database = options.database;
    this.#decryptBaseline = options.decryptBaseline;
    this.#now = options.now ?? Date.now;
  }

  /** True only for a post-P occurrence that the old version must leave encrypted in source staging until the swap. */
  async shouldWithhold(input: {
    readonly accountId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly historyRecordId: string;
  }): Promise<boolean> {
    const oldVersion = ruleVersionId(input.ruleId, input.ruleVersion);
    const occurrence = historyId(input.historyRecordId, 'a Gmail history record id');
    for (const drain of this.#drains(input.accountId)) {
      if (drain.replacement_of_version !== oldVersion) continue;
      const baseline = position(await this.#decryptBaseline(drain.encrypted_position));
      if (occurrence > historyId(baseline.historyId, 'a replacement baseline history id')) return true;
    }
    return false;
  }

  /**
   * A newly active version starts strictly after the position recorded for its own cut-over. This is an acquisition
   * predicate, not an authority check: GmailSourceWorker still calls assertDisclosable before it admits anything.
   */
  async isAfterActivePoint(input: {
    readonly accountId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly historyRecordId: string;
  }): Promise<boolean> {
    const row = this.#database
      .prepare(
        `SELECT rule_activation_points.encrypted_position
         FROM active_versions
         JOIN rule_activation_points
           ON rule_activation_points.activation_id = active_versions.current_cutover_id
          AND rule_activation_points.rule_id = active_versions.object_id
          AND rule_activation_points.rule_version = active_versions.version
          AND rule_activation_points.source = 'gmail'
          AND rule_activation_points.account_id = ?
          AND rule_activation_points.position_scope = 'mailbox'
         WHERE active_versions.kind = 'rule'
           AND active_versions.object_id = ?
           AND active_versions.version = ?`,
      )
      .get(input.accountId, input.ruleId, input.ruleVersion) as { encrypted_position: Uint8Array } | undefined;
    if (row === undefined) return true;
    const baseline = position(await this.#decryptBaseline(row.encrypted_position));
    return (
      historyId(input.historyRecordId, 'a Gmail history record id') >
      historyId(baseline.historyId, 'a replacement baseline history id')
    );
  }

  /** The real page worker calls this only after it durably terminalises each old-version occurrence through the page. */
  async markPageDrained(input: { readonly accountId: string; readonly historyId: string }): Promise<void> {
    const covered = historyId(input.historyId, 'a Gmail page history id');
    const complete: string[] = [];
    for (const drain of this.#drains(input.accountId)) {
      const baseline = position(await this.#decryptBaseline(drain.encrypted_position));
      if (covered >= historyId(baseline.historyId, 'a replacement baseline history id')) complete.push(drain.intent_id);
    }
    if (complete.length === 0) return;
    const now = this.#now();
    for (const intentId of complete) {
      this.#database
        .prepare('UPDATE replacement_drains SET drained_at = ? WHERE intent_id = ? AND drained_at IS NULL')
        .run(now, intentId);
    }
  }

  #drains(accountId: string): readonly DrainRow[] {
    return this.#database
      .prepare(
        `SELECT replacement_drains.intent_id, activation_intents.replacement_of_version, activation_baselines.encrypted_position
         FROM replacement_drains
         JOIN activation_intents ON activation_intents.id = replacement_drains.intent_id
         JOIN activation_baselines
           ON activation_baselines.intent_id = replacement_drains.intent_id
          AND activation_baselines.source = replacement_drains.source
          AND activation_baselines.account_id = replacement_drains.account_id
          AND activation_baselines.position_scope = replacement_drains.position_scope
         WHERE replacement_drains.source = 'gmail'
           AND replacement_drains.account_id = ?
           AND replacement_drains.position_scope = 'mailbox'
           AND replacement_drains.drained_at IS NULL
           AND activation_intents.status = 'pending-completion'
           AND activation_intents.replacement_of_version IS NOT NULL`,
      )
      .all(accountId) as unknown as DrainRow[];
  }
}

/** Refuses finalisation until the source worker has written every drain completion in durable state. */
export function assertReplacementDrained(database: DatabaseSync, intentId: string): void {
  const row = database
    .prepare('SELECT COUNT(*) AS remaining FROM replacement_drains WHERE intent_id = ? AND drained_at IS NULL')
    .get(intentId) as { remaining: number } | undefined;
  if ((row?.remaining ?? 0) > 0) {
    throw new CommsError('TRANSIENT', 'the Gmail replacement is still draining its old cursor range', {
      details: { reason: 'REPLACEMENT_DRAINING', intentId },
    });
  }
}

/** Content-free intent states suitable for status and doctor output. */
export function replacementIntentSummary(database: DatabaseSync): readonly {
  status: string;
  failureCode: string | null;
  count: number;
}[] {
  return (
    database
      .prepare(
        `SELECT status, failure_code, COUNT(*) AS count
       FROM activation_intents
       WHERE status IN ('pending', 'pending-completion', 'failed', 'cancelled')
       GROUP BY status, failure_code
       ORDER BY status, failure_code`,
      )
      .all() as Array<{ status: string; failure_code: string | null; count: number }>
  ).map((row) => ({
    status: row.status,
    failureCode: row.failure_code,
    count: row.count,
  }));
}

/**
 * A revocation removes work that can still disclose under the revoked rule versions — and only those: a superseded
 * or active version of the same rule that is not revoked keeps its own validly authorised work. Content-free history
 * is retained. The caller owns the surrounding BEGIN IMMEDIATE, so lifecycle, pointer and purge are observed together.
 */
export function purgeRevokedRuleWork(database: DatabaseSync, ruleId: string, versions: readonly number[]): void {
  for (const version of versions) {
    database.prepare('DELETE FROM dryrun_log WHERE rule_id = ? AND rule_version = ?').run(ruleId, version);
    database.prepare('DELETE FROM ingest_rules WHERE rule_id = ? AND rule_version = ?').run(ruleId, version);
    database
      .prepare(
        `UPDATE deliveries
         SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL
         WHERE rule_id = ? AND rule_version = ? AND state IN ('queued', 'retryable')`,
      )
      .run(ruleId, version);
    // A network operation that already owns a record cannot be recalled. The version becomes unable to start any
    // more, and its retained bytes are purged as the global/account revocation paths do.
    database
      .prepare(
        `UPDATE deliveries
         SET state = 'in-flight-at-disable', encrypted_record = NULL, lease_until = NULL
         WHERE rule_id = ? AND rule_version = ? AND state = 'disclosing'`,
      )
      .run(ruleId, version);
    database
      .prepare(
        "UPDATE deliveries SET encrypted_record = NULL WHERE rule_id = ? AND rule_version = ? AND state = 'dead-lettered'",
      )
      .run(ruleId, version);
    // A raw staged page is shared until no other rule version still owes it; only a sole debt is purged here.
    database
      .prepare(
        `DELETE FROM source_scan_state
         WHERE id IN (
           SELECT debt.stage_id
           FROM source_stage_rule_debts AS debt
           WHERE debt.rule_id = ? AND debt.rule_version = ?
             AND NOT EXISTS (
               SELECT 1
               FROM source_stage_rule_debts AS other
               WHERE other.stage_id = debt.stage_id
                 AND (other.rule_id <> debt.rule_id OR other.rule_version <> debt.rule_version)
             )
         )`,
      )
      .run(ruleId, version);
    database.prepare('DELETE FROM source_stage_rule_debts WHERE rule_id = ? AND rule_version = ?').run(ruleId, version);
  }
}

interface StoredRuleRetention {
  readonly version: number;
  readonly document: string;
}

function storedRetention(document: string): CanonicalFullRuleDocument['retention'] {
  return (JSON.parse(document) as CanonicalFullRuleDocument).retention;
}

/**
 * Retention shortening is deliberately monotonic. Where B1 has a persisted creation clock, each deadline moves only
 * to the child-version bound; already terminal content is reduced to content-free state in this same transaction.
 */
export function shortenRuleRetentionDeadlines(input: {
  readonly database: DatabaseSync;
  readonly ruleId: string;
  readonly child: CanonicalFullRuleDocument;
  readonly now: number;
}): void {
  const { database, ruleId, child, now } = input;
  database
    .prepare(
      `UPDATE source_scan_state
       SET stage_expires_at = MIN(stage_expires_at, staged_at + ?)
       WHERE id IN (SELECT stage_id FROM source_stage_rule_debts WHERE rule_id = ?)`,
    )
    .run(child.retention.ingestMs, ruleId);
  database
    .prepare(
      `UPDATE ingest_rules
       SET decision_deadline = MIN(
         decision_deadline,
         (SELECT staged_at + ? FROM ingest WHERE ingest.event_id = ingest_rules.event_id)
       )
       WHERE rule_id = ?`,
    )
    .run(child.retention.ingestMs, ruleId);
  database
    .prepare(
      `UPDATE decisions
       SET hold_expires_at = CASE
             WHEN hold_expires_at IS NULL THEN NULL
             ELSE MIN(hold_expires_at, (SELECT staged_at + ? FROM ingest WHERE ingest.event_id = decisions.event_id))
           END,
           metadata_expires_at = MIN(
             metadata_expires_at,
             (SELECT staged_at + ? FROM ingest WHERE ingest.event_id = decisions.event_id)
           )
       WHERE rule_id = ?`,
    )
    .run(child.retention.holdMs, child.retention.decisionMetadataMs, ruleId);
  const retainedVersions = database
    .prepare('SELECT version, document FROM rule_versions WHERE rule_id = ?')
    .all(ruleId) as unknown as StoredRuleRetention[];
  const originalRetention = new Map(
    retainedVersions.map((row) => [row.version, storedRetention(row.document)] as const),
  );
  const deliveries = database
    .prepare('SELECT id, rule_version, expires_at, state FROM deliveries WHERE rule_id = ?')
    .all(ruleId) as Array<{ id: string; rule_version: number; expires_at: number; state: string }>;
  for (const delivery of deliveries) {
    const prior = originalRetention.get(delivery.rule_version);
    if (!prior) continue;
    const createdAt = delivery.expires_at - prior.deliveryMs;
    const expiresAt = Math.min(delivery.expires_at, createdAt + child.retention.deliveryMs);
    if (expiresAt <= now && ['queued', 'retryable'].includes(delivery.state)) {
      database
        .prepare(
          "UPDATE deliveries SET expires_at = ?, state = 'retention-expired', encrypted_record = NULL, lease_until = NULL WHERE id = ?",
        )
        .run(expiresAt, delivery.id);
    } else {
      database.prepare('UPDATE deliveries SET expires_at = ? WHERE id = ?').run(expiresAt, delivery.id);
    }
  }
  const dryruns = database
    .prepare('SELECT delivery_id, rule_version, delivered_at, expires_at FROM dryrun_log WHERE rule_id = ?')
    .all(ruleId) as Array<{ delivery_id: string; rule_version: number; delivered_at: number; expires_at: number }>;
  for (const dryrun of dryruns) {
    const expiresAt = Math.min(dryrun.expires_at, dryrun.delivered_at + child.retention.dryrunMs);
    if (expiresAt <= now) database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(dryrun.delivery_id);
    else
      database.prepare('UPDATE dryrun_log SET expires_at = ? WHERE delivery_id = ?').run(expiresAt, dryrun.delivery_id);
  }
  database
    .prepare(
      'UPDATE decisions SET encrypted_record = NULL, purged_at = ? WHERE rule_id = ? AND metadata_expires_at <= ?',
    )
    .run(now, ruleId, now);
}

/**
 * Commits one no-approval rule narrowing as an immutable derived authorisation. The lineage edge, copied point set,
 * pointer, and lifecycle transition share a transaction, so a crash can expose all of them or none of them.
 */
export function applyDerivedTightening(input: {
  readonly database: DatabaseSync;
  readonly parent: CanonicalFullRuleDocument;
  readonly child: CanonicalFullRuleDocument;
  readonly now: number;
}): { readonly editKind: TighteningKind; readonly versionId: string } {
  const editKind = tighteningKind(input.parent, input.child);
  if (editKind === null) throw new CommsError('APPROVAL_VOID', 'the requested rule edit is not an allowed tightening');
  const database = input.database;
  const parentId = ruleVersionId(input.parent.ruleId, input.parent.version);
  const childId = ruleVersionId(input.child.ruleId, input.child.version);
  database.exec('BEGIN IMMEDIATE');
  try {
    const parent = database.prepare('SELECT state, approval_id FROM rule_versions WHERE id = ?').get(parentId) as
      | { state: string | null; approval_id: string | null }
      | undefined;
    const child = database.prepare('SELECT state FROM rule_versions WHERE id = ?').get(childId) as
      | { state: string | null }
      | undefined;
    const pointer = database
      .prepare("SELECT version, current_cutover_id FROM active_versions WHERE kind = 'rule' AND object_id = ?")
      .get(input.parent.ruleId) as { version: number; current_cutover_id: string | null } | undefined;
    if (parent?.state !== 'active' || !parent.approval_id || !child || child.state !== null || !pointer) {
      throw new CommsError(
        'APPROVAL_VOID',
        'the parent and child rule versions are not eligible for a derived tightening',
      );
    }
    if (pointer.version !== input.parent.version || pointer.current_cutover_id === null) {
      throw new CommsError('APPROVAL_VOID', 'the active rule pointer no longer names the tightening parent');
    }
    const points = database
      .prepare(
        `SELECT source, account_id, position_scope, encrypted_position
         FROM rule_activation_points
         WHERE activation_id = ? AND rule_id = ? AND rule_version = ?`,
      )
      .all(pointer.current_cutover_id, input.parent.ruleId, input.parent.version) as Array<{
      source: string;
      account_id: string;
      position_scope: string;
      encrypted_position: Uint8Array;
    }>;
    database
      .prepare(
        `INSERT INTO derived_authorizations (version_id, parent_approval_id, parent_version_id, edit_kind, created_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run(childId, parent.approval_id, parentId, editKind, input.now);
    database
      .prepare(
        `UPDATE rule_versions
         SET state = 'active', approval_id = ?, authorization_activation_id = ?, activated_at = ?
         WHERE id = ? AND state IS NULL`,
      )
      .run(parent.approval_id, childId, input.now, childId);
    for (const point of points) {
      database
        .prepare(
          `INSERT INTO rule_activation_points
           (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, inherited_from_version_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          childId,
          input.child.ruleId,
          input.child.version,
          point.source,
          point.account_id,
          point.position_scope,
          point.encrypted_position,
          parentId,
          input.now,
        );
    }
    if (editKind === 'shorten-retention') {
      shortenRuleRetentionDeadlines({
        database,
        ruleId: input.parent.ruleId,
        child: input.child,
        now: input.now,
      });
    }
    purgeRevokedRuleWork(database, input.parent.ruleId, [input.parent.version]);
    database
      .prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE id = ? AND state = 'active'")
      .run(input.now, parentId);
    database
      .prepare(
        "UPDATE active_versions SET version = ?, current_cutover_id = ?, activated_at = ? WHERE kind = 'rule' AND object_id = ?",
      )
      .run(input.child.version, childId, input.now, input.child.ruleId);
    database.exec('COMMIT');
    return { editKind, versionId: childId };
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}
