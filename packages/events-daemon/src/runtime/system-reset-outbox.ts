import type { EventDatabase } from '../store/database.ts';
import { hasLiveSystemTargetReference } from './target-version-references.ts';

export const SYSTEM_RESET_ATTEMPT_LIMIT = 20;
export const SYSTEM_RESET_RETENTION_MS = 86_400_000;

export interface SystemResetOutboxInput {
  readonly id: string;
  readonly resetEpoch: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly encryptedRecord: Uint8Array;
  readonly createdAt: number;
  readonly switchGeneration?: number | undefined;
}

export interface SystemResetControlData {
  readonly resetEpoch: number;
  readonly newInstallationId: string;
  readonly previousInstallationId?: string | undefined;
  readonly reasonCode: string;
  readonly eventIdsRestart: true;
}

export interface ClaimedSystemReset {
  readonly id: string;
  readonly resetEpoch: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly leaseUntil: number;
}

export type SystemResetClaimResult =
  | { readonly kind: 'claimed'; readonly claim: ClaimedSystemReset }
  | { readonly kind: 'busy' | 'missing' | 'terminal' | 'expired' };

/** D6's reset data is deliberately closed: sender content and ordinary delivery metadata cannot enter it. */
export function systemResetControlData(input: Omit<SystemResetControlData, 'eventIdsRestart'>): SystemResetControlData {
  return {
    resetEpoch: input.resetEpoch,
    newInstallationId: input.newInstallationId,
    ...(input.previousInstallationId === undefined ? {} : { previousInstallationId: input.previousInstallationId }),
    reasonCode: input.reasonCode,
    eventIdsRestart: true,
  };
}

/**
 * Persists reset delivery work outside the ordinary decision/delivery/cap pipeline. The B1 local notice remains a
 * distinct link on its barrier: reset work has no sender identity and never receives an ordinary rate-cap charge.
 */
export function createSystemResetOutbox(store: EventDatabase, input: SystemResetOutboxInput): void {
  if (!Number.isSafeInteger(input.resetEpoch) || input.resetEpoch < 1) throw new Error('reset epoch must be positive');
  if (!Number.isSafeInteger(input.targetVersion) || input.targetVersion < 1)
    throw new Error('target version must be positive');
  if (!Number.isSafeInteger(input.createdAt)) throw new Error('reset creation time must be an integer');
  store.immediate(() => {
    if (
      !hasLiveSystemTargetReference(store.database, {
        resetEpoch: input.resetEpoch,
        targetId: input.targetId,
        targetVersion: input.targetVersion,
        now: input.createdAt,
      })
    ) {
      throw new Error('the reset target has no live exact target reference');
    }
    store.database
      .prepare(
        `INSERT INTO system_reset_outbox
         (id, reset_epoch, target_id, target_version, encrypted_record, attempt_limit, next_at, expires_at, state,
          switch_generation, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?)
         ON CONFLICT(reset_epoch, target_id, target_version) DO NOTHING`,
      )
      .run(
        input.id,
        input.resetEpoch,
        input.targetId,
        input.targetVersion,
        input.encryptedRecord,
        SYSTEM_RESET_ATTEMPT_LIMIT,
        input.createdAt,
        input.createdAt + SYSTEM_RESET_RETENTION_MS,
        input.switchGeneration ?? 0,
        input.createdAt,
      );
    const persisted = store.database
      .prepare(
        `SELECT id FROM system_reset_outbox
         WHERE reset_epoch = ? AND target_id = ? AND target_version = ?`,
      )
      .get(input.resetEpoch, input.targetId, input.targetVersion) as { id: string } | undefined;
    if (persisted?.id !== input.id) throw new Error('the reset epoch already has a different system outbox identity');
    store.database
      .prepare(
        `INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, system_outbox_id)
         VALUES (?, ?, ?, 'closed', ?)
         ON CONFLICT(reset_epoch, target_id, target_version)
         DO UPDATE SET system_outbox_id = excluded.system_outbox_id`,
      )
      .run(input.resetEpoch, input.targetId, input.targetVersion, input.id);
  });
}

/** Reset delivery is cap-free, but its lease belongs to one exact attempt just as an ordinary delivery's does. */
export function claimSystemResetOutbox(input: {
  readonly store: EventDatabase;
  readonly outboxId: string;
  readonly now: number;
  readonly leaseMs: number;
  readonly newAttemptId: () => string;
  readonly newLeaseToken: () => string;
}): SystemResetClaimResult {
  return input.store.immediate(() => {
    const row = input.store.database
      .prepare(
        `SELECT id, reset_epoch, target_id, target_version, attempts, attempt_limit, expires_at, state, lease_until
         FROM system_reset_outbox WHERE id = ?`,
      )
      .get(input.outboxId) as
      | {
          id: string;
          reset_epoch: number;
          target_id: string;
          target_version: number;
          attempts: number;
          attempt_limit: number;
          expires_at: number;
          state: string;
          lease_until: number | null;
        }
      | undefined;
    if (row === undefined) return { kind: 'missing' };
    if (row.expires_at <= input.now) {
      input.store.database
        .prepare(
          `UPDATE system_reset_outbox
           SET state = 'dead-lettered', encrypted_record = NULL, lease_until = NULL
           WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
        )
        .run(row.id);
      return { kind: 'expired' };
    }
    if (!['queued', 'retryable', 'disclosing'].includes(row.state)) return { kind: 'terminal' };
    const barrier = input.store.database
      .prepare(
        `SELECT state, system_outbox_id FROM reset_barriers
         WHERE reset_epoch = ? AND target_id = ? AND target_version = ?`,
      )
      .get(row.reset_epoch, row.target_id, row.target_version) as
      | { state: string; system_outbox_id: string | null }
      | undefined;
    if (barrier?.system_outbox_id !== row.id || barrier.state === 'open') return { kind: 'terminal' };
    if (row.state === 'disclosing' && (row.lease_until ?? 0) > input.now) return { kind: 'busy' };
    if (
      !hasLiveSystemTargetReference(input.store.database, {
        resetEpoch: row.reset_epoch,
        targetId: row.target_id,
        targetVersion: row.target_version,
        now: input.now,
      })
    ) {
      input.store.database
        .prepare(
          `UPDATE system_reset_outbox SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL
           WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
        )
        .run(row.id);
      return { kind: 'terminal' };
    }
    if (row.attempts >= row.attempt_limit) {
      input.store.database
        .prepare(
          `UPDATE system_reset_outbox SET state = 'dead-lettered', lease_until = NULL
           WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
        )
        .run(row.id);
      return { kind: 'terminal' };
    }
    const attemptId = input.newAttemptId();
    const leaseToken = input.newLeaseToken();
    const leaseUntil = input.now + input.leaseMs;
    const changed = input.store.database
      .prepare(
        `UPDATE system_reset_outbox
         SET state = 'disclosing', attempts = attempts + 1, attempt_id = ?, lease_token = ?, lease_until = ?
         WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
      )
      .run(attemptId, leaseToken, leaseUntil, row.id).changes;
    if (changed !== 1) return { kind: 'terminal' };
    return {
      kind: 'claimed',
      claim: {
        id: row.id,
        resetEpoch: row.reset_epoch,
        targetId: row.target_id,
        targetVersion: row.target_version,
        attemptId,
        leaseToken,
        leaseUntil,
      },
    };
  });
}

/** A completion names the exact reset attempt and opens its barrier only when that attempt still owns the row. */
export function completeSystemResetClaim(
  store: EventDatabase,
  claim: ClaimedSystemReset,
  input: { readonly state: 'delivered' | 'retryable' | 'cancelled' | 'dead-lettered' },
): boolean {
  return store.immediate(() => {
    const changed = store.database
      .prepare(
        `UPDATE system_reset_outbox
         SET state = ?, lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(input.state, claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
    if (changed !== 1) return false;
    if (input.state === 'delivered') {
      store.database
        .prepare(
          `UPDATE reset_barriers SET state = 'open'
           WHERE reset_epoch = ? AND target_id = ? AND target_version = ? AND system_outbox_id = ?`,
        )
        .run(claim.resetEpoch, claim.targetId, claim.targetVersion, claim.id);
    }
    return true;
  });
}
