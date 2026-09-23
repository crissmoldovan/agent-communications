import { randomBytes } from 'node:crypto';
import { link, open, readFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { CommsError } from './errors.ts';
import { ensurePrivateDir } from './fs.ts';

export interface LockOptions {
  /** Give up after this long. */
  timeoutMs?: number;
  /** A lock whose recorded time is older than this is assumed abandoned by a crashed process. */
  staleMs?: number;
  /**
   * Renew the lock this often while `fn` runs, so a holder that is still working is never judged abandoned.
   *
   * Opt-in, for locks held across work of unbounded length. Staleness was judged from a time written once, at
   * acquisition, so a live holder that ran past `staleMs` could be taken over mid-operation — for the credentials
   * lock, a migration with enough credentials and a slow enough keychain, recreating the very race the lock
   * exists to prevent.
   */
  renewMs?: number;
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

/**
 * An unreadable or half-written lock counts as stale only through its age — and when the body cannot be read, that
 * age has to come from the file itself.
 *
 * `withFileLock` creates the lock file and writes its body in two separate awaits with no fsync between them, so a
 * SIGKILL, an OOM kill or a power cut in between leaves a zero-byte lock on disk. Reading "no body" as "not stale"
 * meant that file wedged config, the approval ledger and the send ledger permanently, for every process, with no
 * way out but finding and deleting it by hand. A corrupt timestamp inside an otherwise readable body is the same
 * trap wearing a different hat: `Date.now() - NaN > staleMs` is false, forever.
 */
async function isStale(path: string, body: LockBody | null, staleMs: number): Promise<boolean> {
  let touched: number;
  try {
    touched = (await stat(path)).mtimeMs;
  } catch {
    // The lock is gone; whoever is waiting will simply create their own.
    return false;
  }
  /*
   * The fresher of the declared time and the file's own modification time.
   *
   * A renewing holder touches the file rather than rewriting it: a rewrite would have to check the token and then
   * write, and a takeover landing between the two would have this holder overwrite a new holder's token. Touching
   * a file that has since been replaced only keeps the new holder's lock fresh, which is harmless. So a renewal
   * shows up as the modification time, and that has to count.
   */
  const declared = body ? new Date(body.at).getTime() : Number.NaN;
  const freshest = Number.isFinite(declared) ? Math.max(declared, touched) : touched;
  return Date.now() - freshest > staleMs;
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
  if (!(await isStale(aside, moved, staleMs))) {
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
      if (code === 'EEXIST' && (await isStale(lockPath, await readLock(lockPath), staleMs))) {
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
  const renewal = options.renewMs
    ? setInterval(() => {
        const now = new Date();
        void utimes(lockPath, now, now).catch(() => undefined);
      }, options.renewMs)
    : undefined;
  renewal?.unref?.();
  try {
    return await fn();
  } finally {
    if (renewal) clearInterval(renewal);
    // Only remove the lock if it is still ours (a very slow holder could have been taken over as stale).
    const current = await readLock(lockPath);
    if (current?.token === token) await rm(lockPath, { force: true });
  }
}

/**
 * The lock every operation that rewrites stored credentials in bulk must hold.
 *
 * Next to the configuration rather than in the state directory, because it guards the same thing the config lock
 * does from a different angle: which backend holds which credential. The config lock serialises writes to the
 * file; this serialises the operations that move secrets *between* backends around those writes, which take far
 * longer than a config write and must not interleave with each other.
 *
 * Two opposite migrations were the case that forced it. One copied into a backend while the other was cleaning
 * the same backend out, and the result was a credential in neither — the active backend empty, and the one it
 * had been copied from emptied too.
 *
 * **S3's token refresh must take this lock too**, before it is wired to anything. A refresh rewrites a credential
 * under the same reference, which a migration's own checks cannot see; holding this lock is what serialises the
 * two. Recorded in the Slack design spec next to the phase table.
 */
export function credentialsLockPath(configDir: string): string {
  return join(configDir, '.credentials.lock');
}

/**
 * Runs `fn` holding the credentials lock, renewed for as long as `fn` runs.
 *
 * Renewed rather than given a long stale window. What runs under this has no upper bound on its length — a
 * migration of many credentials, each waiting on the keychain — so any fixed window is one a live holder can
 * outlast. With renewal the window only has to cover a holder that has actually died, which is also why it can be
 * short: a crashed migration stops blocking the next one in two minutes rather than ten.
 *
 * A short timeout by default, because a second caller arriving while one is running should be told so promptly
 * rather than queue behind a prompt nobody is answering. A caller that is not a person — a token refresh behind
 * another workspace's refresh, whose holder is waiting on a network call rather than on anybody — may wait longer.
 */
export function withCredentialsLock<T>(
  configDir: string,
  fn: () => Promise<T>,
  options: { timeoutMs?: number } = {},
): Promise<T> {
  return withFileLock(credentialsLockPath(configDir), fn, {
    staleMs: 2 * 60_000,
    renewMs: 20_000,
    timeoutMs: options.timeoutMs ?? 5_000,
  });
}
