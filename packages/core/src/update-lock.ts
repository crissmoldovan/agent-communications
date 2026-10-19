import { join } from 'node:path';
import { CommsError, toCommsError } from './errors.ts';
import { withFileLock } from './lock.ts';

/**
 * The machine's one update lock (design 2026-10-16 U5; plan, Review focus 1 and 3): a background run, a person's
 * update (`comms_update`, `agentcomms update`), a rollback and a person's prune (`comms_server_prune`, `mcp prune`)
 * each hold it for as long as they install, switch or prune, so none of them ever overlaps another — two of them would
 * switch the same pointers and prune runtimes the other had just installed, or was still checking.
 *
 * An install can take minutes, so the holder renews it, and a lock left by a process that died is taken over once it
 * has gone unrenewed for ten minutes. Nobody waits for it long: a background run that finds it held stops and runs
 * again the next day, and a person's update is refused at once — before an approval is prepared, where it can be — so
 * no conversation sits behind an install.
 */
export const UPDATE_LOCK_FILE = '.update.lock';

export function updateLockPath(stateDir: string): string {
  return join(stateDir, UPDATE_LOCK_FILE);
}

const HOLD = { staleMs: 10 * 60_000, renewMs: 60_000 } as const;

/** Runs `fn` holding the update lock, waiting at most `waitMs` for it; LOCK_TIMEOUT when another holds it. */
export async function withUpdateLock<T>(stateDir: string, fn: () => Promise<T>, waitMs = 1_000): Promise<T> {
  return withFileLock(updateLockPath(stateDir), fn, { timeoutMs: waitMs, ...HOLD });
}

/** What a person ran that the update lock refused: said in the refusal's "run the … again". */
export type PersonLockHolder = 'update' | 'rollback' | 'prune';

/**
 * A person's update, rollback or prune, holding the update lock: refused, changing nothing, while a background run —
 * or another person's update — holds it. The refusal says what is under way and when to try again.
 */
export async function withPersonUpdateLock<T>(
  stateDir: string,
  fn: () => Promise<T>,
  what: PersonLockHolder = 'update',
): Promise<T> {
  try {
    return await withUpdateLock(stateDir, fn);
  } catch (error) {
    const refused = toCommsError(error);
    if (refused.code !== 'LOCK_TIMEOUT' || !refused.message.includes(UPDATE_LOCK_FILE)) throw error;
    throw new CommsError(
      'LOCK_TIMEOUT',
      'nothing was changed: a background update run is under way on this machine, or another update is',
      {
        hint: `It installs, checks and switches in a few minutes, and the two never overlap. Run the ${what} again in a few minutes; the doctor and comms_audit_tail say what the run did.`,
      },
    );
  }
}

/** Refuses at once, changing nothing, while the update lock is held: the check a person's update makes as it plans. */
export async function refuseWhileUpdating(stateDir: string, what: PersonLockHolder = 'update'): Promise<void> {
  await withPersonUpdateLock(stateDir, async () => undefined, what);
}
