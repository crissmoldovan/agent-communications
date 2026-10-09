import type { DatabaseSync } from 'node:sqlite';
import type { EventDatabase } from '../store/database.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface DeliveryOrderIdentity {
  readonly ruleId: string;
  readonly accountId: string;
  readonly targetId: string;
}

export interface ClaimedDelivery extends DeliveryOrderIdentity {
  readonly id: string;
  readonly decisionId: string;
  readonly ruleVersion: number;
  readonly targetVersion: number;
  readonly encryptedRecord: Uint8Array;
  readonly expiresAt: number;
  readonly switchGeneration: number;
  readonly orderingSequence: number;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly leaseUntil: number;
}

export interface DeliveryClaimPreflight extends DeliveryOrderIdentity {
  readonly id: string;
  readonly ruleVersion: number;
  readonly targetVersion: number;
  readonly switchGeneration: number;
}

export type DeliveryClaimResult =
  | { readonly kind: 'claimed'; readonly claim: ClaimedDelivery }
  | {
      readonly kind:
        | 'waiting-cap'
        | 'waiting-reset'
        | 'waiting-order'
        | 'paused'
        | 'busy'
        | 'missing'
        | 'terminal'
        | 'expired';
    };

interface DeliveryClaimRow {
  readonly id: string;
  readonly decision_id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly encrypted_record: Uint8Array | null;
  readonly expires_at: number;
  readonly state: string;
  readonly switch_generation: number;
  readonly lease_until: number | null;
  readonly attempt_id: string | null;
  readonly lease_token: string | null;
  readonly ordering_sequence: number;
}

/** Allocates the one sequence shared by all immutable versions of a stable delivery identity. */
export function allocateDeliveryOrderSequence(database: DatabaseSync, identity: DeliveryOrderIdentity): number {
  const current = database
    .prepare(
      `SELECT next_sequence FROM delivery_order_counters
       WHERE rule_id = ? AND account_id = ? AND target_id = ?`,
    )
    .get(identity.ruleId, identity.accountId, identity.targetId) as { next_sequence: number } | undefined;
  if (current === undefined) {
    database
      .prepare(
        `INSERT INTO delivery_order_counters (rule_id, account_id, target_id, next_sequence)
         VALUES (?, ?, ?, 1)`,
      )
      .run(identity.ruleId, identity.accountId, identity.targetId);
    return 0;
  }
  database
    .prepare(
      `UPDATE delivery_order_counters SET next_sequence = next_sequence + 1
       WHERE rule_id = ? AND account_id = ? AND target_id = ? AND next_sequence = ?`,
    )
    .run(identity.ruleId, identity.accountId, identity.targetId, current.next_sequence);
  return current.next_sequence;
}

/**
 * The single ordinary-delivery eligibility transition. The account check is deliberately immediately before the
 * transaction: configuration loading can await, while every mutable authority fact is re-read synchronously inside
 * the transaction that charges and leases the exact row.
 */
export async function claimDelivery(input: {
  readonly store: EventDatabase;
  readonly deliveryId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly newAttemptId: () => string;
  readonly newLeaseToken: () => string;
  readonly assertAccountLive?: ((accountId: string) => Promise<void>) | undefined;
  readonly preflight?: ((delivery: DeliveryClaimPreflight) => Promise<void>) | undefined;
}): Promise<DeliveryClaimResult> {
  const candidate = deliveryById(input.store.database, input.deliveryId);
  if (candidate !== undefined) {
    await input.assertAccountLive?.(candidate.account_id);
    await input.preflight?.({
      id: candidate.id,
      accountId: candidate.account_id,
      ruleId: candidate.rule_id,
      ruleVersion: candidate.rule_version,
      targetId: candidate.target_id,
      targetVersion: candidate.target_version,
      switchGeneration: candidate.switch_generation,
    });
  }
  return input.store.immediate(() => claimDeliveryInTransaction(input));
}

export function claimDeliveryInTransaction(input: {
  readonly store: EventDatabase;
  readonly deliveryId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly newAttemptId: () => string;
  readonly newLeaseToken: () => string;
}): DeliveryClaimResult {
  const database = input.store.database;
  const row = deliveryById(database, input.deliveryId);
  if (row === undefined) return { kind: 'missing' };
  if (!hasLiveDeliveryLineage(database, row)) return { kind: 'terminal' };
  if (row.expires_at <= input.now) {
    expireDeliveryInTransaction(database, row, input.now);
    return { kind: 'expired' };
  }
  if (!['queued', 'retryable', 'disclosing'].includes(row.state) || row.encrypted_record === null)
    return { kind: 'terminal' };
  const setting = database
    .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
  if (setting?.enabled !== 1 || setting.switch_generation !== row.switch_generation) return { kind: 'terminal' };
  if (setting.paused === 1) return { kind: 'paused' };
  if (row.state === 'disclosing' && (row.lease_until ?? 0) > input.now) return { kind: 'busy' };
  if (hasEarlierDelivery(database, row)) return { kind: 'waiting-order' };
  if (barrierIsClosed(database, row)) return { kind: 'waiting-reset' };

  const alreadyCharged = database
    .prepare('SELECT 1 AS present FROM delivery_cap_charges WHERE delivery_id = ?')
    .get(row.id);
  if (alreadyCharged === undefined) {
    const cap = deliveryRateCap(database, row);
    const since = input.now - 60 * 60 * 1000;
    const charges = database
      .prepare('SELECT count(*) AS count FROM delivery_cap_charges WHERE rule_id = ? AND charged_at > ?')
      .get(row.rule_id, since) as { count: number };
    if (charges.count >= cap) return { kind: 'waiting-cap' };
    database
      .prepare('INSERT INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at) VALUES (?, ?, ?, ?)')
      .run(row.id, row.rule_id, row.rule_version, input.now);
  }

  const attemptId = input.newAttemptId();
  const leaseToken = input.newLeaseToken();
  const leaseUntil = input.now + input.leaseMs;
  const updated = database
    .prepare(
      `UPDATE deliveries
       SET state = 'disclosing', attempts = attempts + 1, attempt_id = ?, lease_token = ?, lease_until = ?,
           cap_charged_at = COALESCE(cap_charged_at, ?)
       WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
    )
    .run(attemptId, leaseToken, leaseUntil, input.now, row.id);
  if (updated.changes !== 1) return { kind: 'terminal' };
  return {
    kind: 'claimed',
    claim: {
      id: row.id,
      decisionId: row.decision_id,
      accountId: row.account_id,
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      targetId: row.target_id,
      targetVersion: row.target_version,
      encryptedRecord: row.encrypted_record,
      expiresAt: row.expires_at,
      switchGeneration: row.switch_generation,
      orderingSequence: row.ordering_sequence,
      attemptId,
      leaseToken,
      leaseUntil,
    },
  };
}

/** Releases only the exact leased attempt; a former owner cannot release a newer recovery lease. */
export function releaseDeliveryClaim(store: EventDatabase, claim: ClaimedDelivery): boolean {
  return store.immediate(() => releaseDeliveryClaimInTransaction(store.database, claim));
}

export function releaseDeliveryClaimInTransaction(database: DatabaseSync, claim: ClaimedDelivery): boolean {
  return (
    database
      .prepare(
        `UPDATE deliveries SET state = 'queued', lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes === 1
  );
}

export function isCurrentDeliveryClaim(database: DatabaseSync, claim: ClaimedDelivery): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM deliveries
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .get(claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil) !== undefined
  );
}

/** Content-free test and recovery seam for a terminal outcome that must not let a stale attempt win. */
export function completeDeliveryClaim(
  store: EventDatabase,
  claim: ClaimedDelivery,
  input: {
    readonly state: 'delivered' | 'retryable' | 'cancelled' | 'retention-expired';
    readonly clearRecord: boolean;
  },
): boolean {
  return store.immediate(() => completeDeliveryClaimInTransaction(store.database, claim, input));
}

export function completeDeliveryClaimInTransaction(
  database: DatabaseSync,
  claim: ClaimedDelivery,
  input: {
    readonly state: 'delivered' | 'retryable' | 'cancelled' | 'retention-expired';
    readonly clearRecord: boolean;
  },
): boolean {
  const result = database
    .prepare(
      `UPDATE deliveries
       SET state = ?, encrypted_record = CASE WHEN ? THEN NULL ELSE encrypted_record END, lease_until = NULL
       WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
    )
    .run(input.state, input.clearRecord ? 1 : 0, claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil);
  if (result.changes === 1 && input.clearRecord) {
    const targets = removeRetainedDeliveryTargetReference(database, claim.id);
    for (const target of targets) {
      purgeUnreferencedSystemTargets(database, { ...target, now: Date.now() });
    }
  }
  return result.changes === 1;
}

function deliveryById(database: DatabaseSync, id: string): DeliveryClaimRow | undefined {
  return database
    .prepare(
      `SELECT id, decision_id, account_id, rule_id, rule_version, target_id, target_version, encrypted_record,
              expires_at, state, switch_generation, lease_until, attempt_id, lease_token, ordering_sequence
       FROM deliveries WHERE id = ?`,
    )
    .get(id) as DeliveryClaimRow | undefined;
}

export function hasLiveDeliveryLineage(
  database: DatabaseSync,
  row: Pick<DeliveryClaimRow, 'rule_id' | 'rule_version' | 'target_id' | 'target_version'>,
): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present
         FROM rule_versions AS rule
         JOIN target_versions AS target ON target.target_id = ? AND target.version = ?
         WHERE rule.rule_id = ? AND rule.version = ?
           AND rule.state IN ('active', 'superseded') AND rule.revoked_at IS NULL AND target.revoked_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM object_revocations
             WHERE kind = 'rule' AND object_id = rule.rule_id AND version = rule.version
           )
           AND NOT EXISTS (
             SELECT 1 FROM object_revocations
             WHERE kind = 'target' AND object_id = target.target_id AND version = target.version
           )`,
      )
      .get(row.target_id, row.target_version, row.rule_id, row.rule_version) !== undefined
  );
}

function hasEarlierDelivery(database: DatabaseSync, row: DeliveryClaimRow): boolean {
  return (
    database
      .prepare(
        `SELECT 1 AS present FROM deliveries
         WHERE rule_id = ? AND account_id = ? AND target_id = ? AND ordering_sequence < ?
           AND state IN ('queued', 'retryable', 'disclosing')
         LIMIT 1`,
      )
      .get(row.rule_id, row.account_id, row.target_id, row.ordering_sequence) !== undefined
  );
}

function barrierIsClosed(database: DatabaseSync, row: DeliveryClaimRow): boolean {
  const barrier = database
    .prepare(
      `SELECT state FROM reset_barriers
       WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1`,
    )
    .get(row.target_id, row.target_version) as { state: string } | undefined;
  return barrier !== undefined && barrier.state !== 'open';
}

function deliveryRateCap(database: DatabaseSync, row: DeliveryClaimRow): number {
  const stored = database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(row.rule_id, row.rule_version) as { document: string } | undefined;
  if (stored === undefined) throw new Error('a claim has no exact rule version');
  const value = (JSON.parse(stored.document) as { deliveryRateCap?: unknown }).deliveryRateCap;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('a claim rule has no valid delivery rate cap');
  return value;
}

function expireDeliveryInTransaction(database: DatabaseSync, row: DeliveryClaimRow, now: number): void {
  const changed = database
    .prepare(
      `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL
       WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing') AND expires_at <= ?`,
    )
    .run(row.id, now).changes;
  if (changed !== 1) return;
  const targets = removeRetainedDeliveryTargetReference(database, row.id);
  for (const target of targets) purgeUnreferencedSystemTargets(database, { ...target, now });
}
