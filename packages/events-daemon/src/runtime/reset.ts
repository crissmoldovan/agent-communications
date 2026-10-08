import { randomUUID } from 'node:crypto';
import type { EventDatabase } from '../store/database.ts';

export interface LocalResetBarrier {
  readonly resetEpoch: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly noticeId: string;
}

/**
 * Closes a target's durable local reset barrier and persists its content-free notice in the same immediate
 * transaction.  Dispatchers cannot append ordinary content until `openLocalResetBarrier` observes that notice.
 */
export function closeLocalResetBarrier(
  store: EventDatabase,
  input: Omit<LocalResetBarrier, 'resetEpoch'> & {
    readonly resetEpoch?: number | undefined;
    readonly now?: number | undefined;
  },
): LocalResetBarrier {
  return store.immediate(() => {
    const current = store.database.prepare("SELECT value FROM meta WHERE key = 'reset_epoch'").get() as
      | { value: string }
      | undefined;
    const resetEpoch = input.resetEpoch ?? Number(current?.value ?? '0') + 1;
    const noticeId = input.noticeId;
    const now = input.now ?? Date.now();
    store.database
      .prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('reset_epoch', ?)")
      .run(String(resetEpoch));
    store.database
      .prepare(
        `INSERT INTO reset_notices (id, reset_epoch, target_id, target_version, created_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
      )
      .run(noticeId, resetEpoch, input.targetId, input.targetVersion, now);
    store.database
      .prepare(
        `INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, reset_delivery_id)
         VALUES (?, ?, ?, 'closed', ?)
         ON CONFLICT(reset_epoch, target_id, target_version) DO UPDATE SET state = 'closed', reset_delivery_id = excluded.reset_delivery_id`,
      )
      .run(resetEpoch, input.targetId, input.targetVersion, noticeId);
    return { resetEpoch, targetId: input.targetId, targetVersion: input.targetVersion, noticeId };
  });
}

/** Opens only the exact closed barrier whose content-free reset notice was persisted first. */
export function openLocalResetBarrier(store: EventDatabase, barrier: LocalResetBarrier): void {
  store.immediate(() => {
    const notice = store.database
      .prepare(
        'SELECT 1 AS present FROM reset_notices WHERE id = ? AND reset_epoch = ? AND target_id = ? AND target_version = ?',
      )
      .get(barrier.noticeId, barrier.resetEpoch, barrier.targetId, barrier.targetVersion);
    if (!notice) throw new Error('local reset notice is missing');
    store.database
      .prepare(
        `UPDATE reset_barriers SET state = 'open' WHERE reset_epoch = ? AND target_id = ? AND target_version = ?
         AND state = 'closed' AND reset_delivery_id = ?`,
      )
      .run(barrier.resetEpoch, barrier.targetId, barrier.targetVersion, barrier.noticeId);
  });
}

/** A convenience for an owner detecting a local reset; generated IDs are never sender-controlled. */
export function newLocalResetBarrier(store: EventDatabase, targetId: string, targetVersion: number): LocalResetBarrier {
  return closeLocalResetBarrier(store, { targetId, targetVersion, noticeId: randomUUID() });
}
