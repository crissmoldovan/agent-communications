import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

/** How long one holder keeps the lock: so many milliseconds, or until a promise settles, however it settles. */
export type Hold = number | PromiseLike<unknown>;

/** `holdLock` under way: it settles once the last hold is over and the lock file is gone; `taken` once the first began. */
export type HeldLock = Promise<void> & {
  /** Settles once the first holder has the lock: from then on nobody else can take it until the holds are over. */
  readonly taken: Promise<void>;
};

/** What `open` reports while someone else has the file: EEXIST, or what Windows says instead (as `lock.ts` reads it). */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY']);

/** How long `holdLock` waits to take the lock itself before it gives up: whoever had it is a test's own process. */
const TAKE_WITHIN_MS = 10_000;

/**
 * Holds `lockPath` as `withFileLock` writes it (`{ pid, at, token }`), one fresh token per hold, back to back, then
 * removes it.
 *
 * Each hold after the first is a new holder taking over at once: its token is written over the last one in place, so
 * the file is never absent between two holders and no waiter can slip in between. A waiter sees a hand-over as the
 * new token, which is how `withFileLock` tells one holder from the next. A hold that is a number lasts that many
 * milliseconds; one that is a promise lasts until it settles, for a hold that must outlast work of unknown length.
 *
 * It takes the lock as a caller would — waiting while another process, or a server's own refresh, has it — and
 * `taken` says when it has. Each body is written at the moment its hold begins, so none is ever old enough to count as
 * abandoned.
 */
export function holdLock(lockPath: string, holds: readonly Hold[]): HeldLock {
  let tookIt: () => void = () => undefined;
  let couldNot: (error: unknown) => void = () => undefined;
  const taken = new Promise<void>((resolve, reject) => {
    tookIt = resolve;
    couldNot = reject;
  });
  const body = () => {
    const token = randomBytes(12).toString('hex');
    return { token, text: JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }) };
  };
  const run = async (): Promise<void> => {
    await mkdir(dirname(lockPath), { recursive: true });
    let holder = body();
    const giveUpAt = Date.now() + TAKE_WITHIN_MS;
    for (;;) {
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        try {
          await handle.writeFile(holder.text);
        } finally {
          await handle.close();
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code ?? '';
        if (!CONTENDED.has(code) || Date.now() > giveUpAt) throw error;
        await sleep(10);
        holder = body();
      }
    }
    tookIt();
    try {
      for (const [index, hold] of holds.entries()) {
        if (index > 0) {
          holder = body();
          await writeFile(lockPath, holder.text, { mode: 0o600 });
        }
        if (typeof hold === 'number') await sleep(hold);
        else await Promise.resolve(hold).catch(() => undefined);
      }
    } finally {
      // Only a lock that is still this one's last holder's is removed, as `withFileLock` removes only its own.
      const left = await readFile(lockPath, 'utf8').catch(() => '');
      if (left === holder.text) await rm(lockPath, { force: true });
    }
  };
  const done = run();
  done.catch(couldNot);
  // A caller that awaits only the holds still hears why the lock could not be taken: from them, not unhandled here.
  taken.catch(() => undefined);
  return Object.assign(done, { taken });
}
