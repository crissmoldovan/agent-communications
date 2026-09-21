import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import { lstat, open } from 'node:fs/promises';

/**
 * Reading a file somebody else chose the name of.
 *
 * Two places here read a client JSON off disk: the scanner that lists what is sitting in the download directory,
 * and `client add`, which reads the one path a person typed. Both were `readFile` on a path, and `readFile` on a
 * path will read whatever is at the end of it — a FIFO that blocks until a writer appears, a device that never
 * ends, a directory, or a symlink pointing at something else entirely. A download directory is a place other
 * software writes to, so "a file matching `client_secret*.json`" is not a thing this process chose.
 *
 * So both go through one bounded read instead. It opens once and answers from that handle, which also closes the
 * gap between `stat(path)` and `readFile(path)` — two lookups that can land on two different files, and the file
 * in question is a client secret.
 */

/** A real client JSON is a few hundred bytes. This is generous, and it is what stops `/dev/zero` being read. */
export const MAX_CLIENT_BYTES: number = 64 * 1024;

/** Why a path produced no text. Each caller says something different about it, so none of them is an error here. */
export type SmallFileProblem =
  /** No such file, no permission, or a symlink where one was refused. */
  | 'missing'
  /** A directory, a socket, a FIFO, a device — anything that is not a regular file. */
  | 'not-a-file'
  /** A regular file far larger than the thing being looked for. */
  | 'too-large';

export type SmallFileResult =
  | { ok: true; text: string; modifiedAt: Date; modifiedMs: number }
  | { ok: false; problem: 'missing' | 'not-a-file' }
  // A file that exists and was simply too big to read still has a date, and a caller listing it for a person to
  // choose from needs that date as much as it needs the ones it could read.
  | { ok: false; problem: 'too-large'; modifiedAt: Date; modifiedMs: number };

export interface ReadSmallFileOptions {
  /**
   * Whether a symlink at `path` is followed.
   *
   * `false` for a path this code found by scanning a directory: a symlink wearing the name of a client file is
   * something another process put there, and following it is the substitution the whole open-once dance exists
   * to refuse. `true` for a path a person typed, where the symlink is their own and refusing it would only be
   * confusing. Enforced on every platform: with `O_NOFOLLOW` where it exists, and with an `lstat` everywhere,
   * because a guard that only runs on some platforms is one nobody notices is missing on the others.
   */
  follow: boolean;
  /** Anything larger is reported as `too-large` rather than read. */
  maxBytes?: number;
}

/** One bounded read: open once, check the shape, check the size, then take the text off the same handle. */
export async function readSmallFile(path: string, options: ReadSmallFileOptions): Promise<SmallFileResult> {
  const maxBytes = options.maxBytes ?? MAX_CLIENT_BYTES;
  // `O_NONBLOCK` so a FIFO opens rather than hanging here waiting for a writer that may never come. Neither flag
  // exists on Windows, where the constants are absent and this is an ordinary open.
  const flags = constants.O_RDONLY | (options.follow ? 0 : (constants.O_NOFOLLOW ?? 0)) | (constants.O_NONBLOCK ?? 0);

  /*
   * Refusing a symlink, on every platform, in both of the ways available.
   *
   * `O_NOFOLLOW` does it inside the open, with no window between deciding and acting — but it does not exist on
   * Windows, where `?? 0` quietly meant *no check at all*. The guard read as universal and was not, and only a
   * Windows CI run said so.
   *
   * So the `lstat` runs everywhere rather than only where the flag is missing. Making it conditional would put
   * the Windows behaviour on a branch that never executes on the machine this is written on, which is how the
   * hole got there in the first place. Unconditional costs one `stat` per candidate — at most forty, once — and
   * every platform then runs the same code.
   *
   * On its own `lstat` is the weaker check: two calls, so something could swap the file in between. Where the
   * flag exists it closes that window; where it does not, an attacker has to win a race rather than walk through
   * an open door, and planting a symlink on Windows needs Developer Mode or elevation to begin with.
   */
  if (!options.follow) {
    try {
      if ((await lstat(path)).isSymbolicLink()) return { ok: false, problem: 'missing' };
    } catch {
      return { ok: false, problem: 'missing' };
    }
  }

  let handle: FileHandle;
  try {
    handle = await open(path, flags);
  } catch {
    return { ok: false, problem: 'missing' };
  }
  try {
    const info = await handle.stat();
    // Checked after the open, not before it: `O_NONBLOCK` means a FIFO opens successfully, so the shape is only
    // knowable from the handle.
    if (!info.isFile()) return { ok: false, problem: 'not-a-file' };
    if (info.size > maxBytes)
      return { ok: false, problem: 'too-large', modifiedAt: info.mtime, modifiedMs: info.mtimeMs };
    return { ok: true, text: await handle.readFile('utf8'), modifiedAt: info.mtime, modifiedMs: info.mtimeMs };
  } catch {
    return { ok: false, problem: 'missing' };
  } finally {
    await handle.close();
  }
}
