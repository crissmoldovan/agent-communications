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
    // Not stale after all: restore it unless a new holder already exists.
    await link(aside, lockPath).catch(() => undefined);
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
  await ensurePrivateDir(dirname(lockPath));
  for (;;) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      await handle.writeFile(JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token }));
      await handle.close();
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      if (isStale(await readLock(lockPath), staleMs)) {
        await takeOverStale(lockPath, staleMs);
        continue;
      }
      if (Date.now() > deadline) {
        throw new CommsError('LOCK_TIMEOUT', `another agent-communications process is holding ${lockPath}`, {
          hint: 'Retry in a moment. If it persists and no other process is running, delete the lock file.',
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
