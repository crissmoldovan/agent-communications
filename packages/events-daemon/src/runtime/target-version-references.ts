import type { DatabaseSync } from 'node:sqlite';

export interface TargetVersionReference {
  readonly targetId: string;
  readonly targetVersion: number;
  readonly ruleId: string;
  readonly ruleVersion: number;
}

function activeReferenceId(reference: TargetVersionReference): string {
  return `active:${reference.ruleId}:${reference.ruleVersion}:${reference.targetId}:${reference.targetVersion}`;
}

function retainedReferenceId(reference: TargetVersionReference & { readonly deliveryId: string }): string {
  return `retained:${reference.deliveryId}:${reference.targetId}:${reference.targetVersion}`;
}

/** Adds the exact target versions an active rule document authorises. The caller owns its pointer transaction. */
export function addActiveRuleTargetReferences(
  database: DatabaseSync,
  input: {
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly targets: readonly Pick<TargetVersionReference, 'targetId' | 'targetVersion'>[];
    readonly createdAt: number;
  },
): void {
  const insert = database.prepare(
    `INSERT OR IGNORE INTO target_version_references
     (id, reference_kind, target_id, target_version, rule_id, rule_version, delivery_id, created_at)
     VALUES (?, 'active-rule', ?, ?, ?, ?, NULL, ?)`,
  );
  for (const target of input.targets) {
    const reference = { ...target, ruleId: input.ruleId, ruleVersion: input.ruleVersion };
    insert.run(
      activeReferenceId(reference),
      target.targetId,
      target.targetVersion,
      input.ruleId,
      input.ruleVersion,
      input.createdAt,
    );
  }
}

export function removeActiveRuleTargetReferences(database: DatabaseSync, ruleId: string, ruleVersion: number): void {
  database
    .prepare(
      "DELETE FROM target_version_references WHERE reference_kind = 'active-rule' AND rule_id = ? AND rule_version = ?",
    )
    .run(ruleId, ruleVersion);
}

/** A retained delivery is an exact-version reference independent of the mutable current pointer. */
export function addRetainedDeliveryTargetReference(
  database: DatabaseSync,
  input: TargetVersionReference & { readonly deliveryId: string; readonly createdAt: number },
): void {
  database
    .prepare(
      `INSERT OR IGNORE INTO target_version_references
       (id, reference_kind, target_id, target_version, rule_id, rule_version, delivery_id, created_at)
       VALUES (?, 'retained-delivery', ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      retainedReferenceId(input),
      input.targetId,
      input.targetVersion,
      input.ruleId,
      input.ruleVersion,
      input.deliveryId,
      input.createdAt,
    );
}

export function removeRetainedDeliveryTargetReference(
  database: DatabaseSync,
  deliveryId: string,
): readonly Pick<TargetVersionReference, 'targetId' | 'targetVersion'>[] {
  const targets = database
    .prepare(
      `SELECT target_id, target_version FROM target_version_references
       WHERE reference_kind = 'retained-delivery' AND delivery_id = ?`,
    )
    .all(deliveryId)
    .map((row) => {
      const value = row as { target_id: string; target_version: number };
      return { targetId: value.target_id, targetVersion: value.target_version };
    });
  database
    .prepare("DELETE FROM target_version_references WHERE reference_kind = 'retained-delivery' AND delivery_id = ?")
    .run(deliveryId);
  return targets;
}

/** Removes every exact reference the revoked rule version owned and returns its affected target versions. */
export function removeRuleVersionTargetReferences(
  database: DatabaseSync,
  ruleId: string,
  ruleVersion: number,
): readonly Pick<TargetVersionReference, 'targetId' | 'targetVersion'>[] {
  const targets = database
    .prepare(
      `SELECT DISTINCT target_id, target_version FROM target_version_references
       WHERE rule_id = ? AND rule_version = ? ORDER BY target_id, target_version`,
    )
    .all(ruleId, ruleVersion)
    .map((row) => {
      const value = row as { target_id: string; target_version: number };
      return { targetId: value.target_id, targetVersion: value.target_version };
    });
  database
    .prepare('DELETE FROM target_version_references WHERE rule_id = ? AND rule_version = ?')
    .run(ruleId, ruleVersion);
  return targets;
}

export function activeRuleTargetReferences(
  database: DatabaseSync,
  ruleId: string,
  ruleVersion: number,
): readonly TargetVersionReference[] {
  return database
    .prepare(
      `SELECT target_id, target_version, rule_id, rule_version
       FROM target_version_references
       WHERE reference_kind = 'active-rule' AND rule_id = ? AND rule_version = ?
       ORDER BY target_id, target_version`,
    )
    .all(ruleId, ruleVersion)
    .map((row) => {
      const value = row as { target_id: string; target_version: number; rule_id: string; rule_version: number };
      return {
        targetId: value.target_id,
        targetVersion: value.target_version,
        ruleId: value.rule_id,
        ruleVersion: value.rule_version,
      };
    });
}

export function retainedDeliveryTargetReferences(
  database: DatabaseSync,
  deliveryId: string,
): readonly TargetVersionReference[] {
  return database
    .prepare(
      `SELECT target_id, target_version, rule_id, rule_version
       FROM target_version_references
       WHERE reference_kind = 'retained-delivery' AND delivery_id = ?
       ORDER BY target_id, target_version`,
    )
    .all(deliveryId)
    .map((row) => {
      const value = row as { target_id: string; target_version: number; rule_id: string; rule_version: number };
      return {
        targetId: value.target_id,
        targetVersion: value.target_version,
        ruleId: value.rule_id,
        ruleVersion: value.rule_version,
      };
    });
}

export interface SystemTargetReferenceQuery {
  readonly resetEpoch: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly now: number;
}

/**
 * D7's exact-version query. A current pointer never substitutes for a reference: an active rule and a still-live
 * superseded delivery have separate rows and are tested against their own immutable versions.
 */
export function hasLiveSystemTargetReference(database: DatabaseSync, input: SystemTargetReferenceQuery): boolean {
  const row = database
    .prepare(
      `SELECT 1 AS present
       FROM target_version_references AS reference
       JOIN target_versions AS target
         ON target.target_id = reference.target_id AND target.version = reference.target_version
       JOIN rule_versions AS rule
         ON rule.rule_id = reference.rule_id AND rule.version = reference.rule_version
       LEFT JOIN deliveries AS delivery ON delivery.id = reference.delivery_id
       WHERE reference.target_id = ? AND reference.target_version = ?
         AND target.revoked_at IS NULL
         AND NOT EXISTS (
           SELECT 1 FROM object_revocations AS revoked
           WHERE revoked.kind = 'target' AND revoked.object_id = target.target_id AND revoked.version = target.version
         )
         AND (
           (reference.reference_kind = 'active-rule' AND rule.state = 'active')
           OR (
             reference.reference_kind = 'retained-delivery'
             AND rule.state IN ('active', 'superseded')
             AND delivery.encrypted_record IS NOT NULL
             AND delivery.state IN ('queued', 'retryable', 'disclosing', 'dead-lettered')
             AND COALESCE(delivery.dead_letter_expires_at, delivery.expires_at) > ?
           )
         )
       LIMIT 1`,
    )
    .get(input.targetId, input.targetVersion, input.now);
  return row !== undefined;
}

/**
 * Atomically removes a no-longer-authorised reset barrier and its private system outbox. B1-only local barriers do
 * not have a system row and are intentionally left alone.
 */
export function purgeUnreferencedSystemTarget(database: DatabaseSync, input: SystemTargetReferenceQuery): boolean {
  if (hasLiveSystemTargetReference(database, input)) return false;
  const rows = database
    .prepare(
      `SELECT system_outbox_id FROM reset_barriers
       WHERE reset_epoch = ? AND target_id = ? AND target_version = ? AND system_outbox_id IS NOT NULL`,
    )
    .all(input.resetEpoch, input.targetId, input.targetVersion) as Array<{ system_outbox_id: string }>;
  if (rows.length === 0) return false;
  database
    .prepare(
      `DELETE FROM reset_barriers
       WHERE reset_epoch = ? AND target_id = ? AND target_version = ? AND system_outbox_id IS NOT NULL`,
    )
    .run(input.resetEpoch, input.targetId, input.targetVersion);
  const deleteOutbox = database.prepare('DELETE FROM system_reset_outbox WHERE id = ?');
  for (const row of rows) deleteOutbox.run(row.system_outbox_id);
  return true;
}

/** Rechecks every reset epoch for this version after a terminal purge or revocation removed references. */
export function purgeUnreferencedSystemTargets(
  database: DatabaseSync,
  input: { readonly targetId: string; readonly targetVersion: number; readonly now: number },
): void {
  const barriers = database
    .prepare(
      `SELECT reset_epoch FROM reset_barriers
       WHERE target_id = ? AND target_version = ? AND system_outbox_id IS NOT NULL`,
    )
    .all(input.targetId, input.targetVersion) as Array<{ reset_epoch: number }>;
  for (const barrier of barriers) {
    purgeUnreferencedSystemTarget(database, { ...input, resetEpoch: barrier.reset_epoch });
  }
}
