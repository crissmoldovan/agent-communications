import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommsError } from './errors.ts';
import { ensurePrivateDir } from './fs.ts';

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock whose recorded time is older than this is assumed abandoned by a crashed process. */
  staleMs?: number;
}

/**
 * Opening `wx` failed because someone else holds the path — retry, rather than failing the command.
 *
 * EPERM and EBUSY are how Windows reports what EEXIST reports elsewhere: the file is there, or the holder is deleting
 * it as we open it. EACCES is deliberately not here — that is a permissions problem, and waiting five seconds to
 * announce that another process holds the lock would be both slower and untrue.
 */
const CONTENDED = new Set(['EEXIST', 'EPERM', 'EBUSY']);

interface LockBody {
  pid: number;
  at: string;
  token: string;
}

async function readLock(path: string): Promise<LockBody | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as LockBody;
  } catch {
    return null;
  }
}

function isStale(body: LockBody | null, staleMs: number): boolean {
  // An unreadable or half-written lock counts as stale only through its age, which a fresh one cannot have.
  if (!body) return false;
  return Date.now() - new Date(body.at).getTime() > staleMs;
}

/**
 * Takes over an abandoned lock safely: move it aside atomically (only one waiter's rename can succeed), re-check that
 * what was moved really is stale, and if it was someone's live lock after all, put it back.
 */
async function takeOverStale(lockPath: string, staleMs: number): Promise<void> {
  const aside = `${lockPath}.stale-${randomBytes(6).toString('hex')}`;
  try {
    await rename(lockPath, aside);
  } catch {
    return; // someone else moved it first
  }
  const moved = await readLock(aside);
  if (!isStale(moved, staleMs)) {
    // Not stale after all: put it back. `link` leaves the copy in place to clean up, but some file systems (overlay
    // mounts in containers) have no hard links, so fall back to renaming it back — losing the holder's lock would
    // leave no mutual exclusion at all.
    try {
      await link(aside, lockPath);
    } catch {
      // Write the holder's lock back by hand rather than leaving the path unlocked. `wx`, never a rename: a rename
      // replaces whatever is there, and between the move and now another waiter may have taken the lock legitimately.
      // Overwriting that would hand the same lock to two holders, which is worse than the case this is repairing.
      try {
        const handle = await open(lockPath, 'wx', 0o600);
        await handle.writeFile(JSON.stringify(moved));
        await handle.close();
      } catch {
        // A new holder exists, or the path is unusable; either way there is nothing left to restore.
      }
    }
  }
  await rm(aside, { force: true });
}

/**
 * Runs `fn` while holding an exclusive lock file. The CLI and several MCP server processes share config, approvals and
 * counters; every read-modify-write of those goes through here so no update is lost. Keep critical sections to file
 * I/O: do network work first, then re-check preconditions under the lock. (Single-use sends do not rely on this lock
 * alone: see the O_EXCL claim marker in the approval store.)
 */
export async function withFileLock<T>(lockPath: string, fn: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const staleMs = options.staleMs ?? 30_000;
  const deadline = Date.now() + timeoutMs;
  const token = randomBytes(12).toString('hex');
  let lastCode = 'EEXIST';
  await ensurePrivateDir(dirname(lockPath));
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
      await handle.close();
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!CONTENDED.has(code ?? '')) throw error;
      lastCode = code ?? lastCode;
      // Only EEXIST tells us the file is really there and can be read; under the Windows codes there is nothing to
      // read yet, so back off and look again rather than deciding it is abandoned.
      if (code === 'EEXIST' && isStale(await readLock(lockPath), staleMs)) {
        await takeOverStale(lockPath, staleMs);
        continue;
      }
      if (Date.now() > deadline) {
        throw new CommsError('LOCK_TIMEOUT', `another agent-communications process is holding ${lockPath}`, {
          hint:
            `Retry in a moment. If it persists and no other process is running, delete the lock file.` +
            (lastCode === 'EEXIST' ? '' : ` (last error: ${lastCode})`),
        });
      }
      await sleep(25 + Math.floor(Math.random() * 50));
    }
  }
  try {
    return await fn();
  } finally {
    // Only remove the lock if it is still ours (a very slow holder could have been taken over as stale).
    const current = await readLock(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}
