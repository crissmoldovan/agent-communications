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
