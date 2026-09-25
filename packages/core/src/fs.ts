import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, readlink, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

export const DIR_MODE = 0o700;
export const FILE_MODE = 0o600;

/** Creates a directory (and parents) readable only by the current user. Tightens an existing one. */
export async function ensurePrivateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: DIR_MODE });
  if (process.platform !== 'win32') {
    const info = await stat(path);
    if ((info.mode & 0o077) !== 0) await chmod(path, DIR_MODE);
  }
}

/**
 * Writes a file atomically with owner-only permissions: a temp file in the same directory, fsync, rename. A reader
 * never sees a half-written file, and a crash leaves either the old content or the new.
 */
export async function writeFileAtomic(
  path: string,
  data: string | Uint8Array,
  mode: number = FILE_MODE,
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  await replaceAtomically(path, data, mode);
}

/**
 * Replaces a file that belongs to another program, leaving everything around it as that program had it.
 *
 * `writeFileAtomic` is for this package's own files: it makes the directory owner-only and the file 0600, and it
 * renames over whatever is at the path. Pointed at an MCP client's config it did three things nobody asked for.
 * A config kept in a dotfiles repository and linked into place became a plain file, so the repository never saw
 * the new entry and the next sync undid it; the client's own directory went from 755 to 700; and the file lost
 * its mode. So this writes to the file a link names (following each link in turn, which also reaches the target
 * of a link whose file does not exist yet), keeps that file's mode, and creates only the directories that are
 * missing. Still a temporary file and a rename, so a reader sees the old content or the new and never half.
 */
export async function replaceFileInPlace(path: string, data: string | Uint8Array): Promise<void> {
  let target = path;
  for (let hops = 0; ; hops += 1) {
    let info: Awaited<ReturnType<typeof lstat>>;
    try {
      info = await lstat(target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (!info.isSymbolicLink()) break;
    if (hops >= 40) throw new Error(`${path} is a chain of links that does not end`);
    target = resolve(dirname(target), await readlink(target));
  }
  let mode = FILE_MODE;
  try {
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await mkdir(dirname(target), { recursive: true });
  await replaceAtomically(target, data, mode);
}

/** A temporary file beside `path`, flushed, given its mode and renamed over it. */
async function replaceAtomically(path: string, data: string | Uint8Array, mode: number): Promise<void> {
  const directory = dirname(path);
  const temp = join(directory, `.${randomBytes(6).toString('hex')}.tmp`);
  const handle = await open(temp, 'wx', mode);
  try {
    await handle.writeFile(data);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    if (process.platform !== 'win32') await chmod(temp, mode);
    await renameWithRetry(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

/** On Windows a rename onto a file another process has open (or a scanner is reading) fails briefly; retry ~1 s. */
async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EBUSY' || code === 'EACCES')) throw error;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
}

/**
 * Appends one line to a file created with owner-only permissions. Used for append-only logs.
 *
 * `durable` flushes it to disk before returning, for a line that has to survive whatever is written next: a record
 * made before a change is only a record of it if a power cut cannot keep the change and lose the line.
 */
export async function appendPrivateLine(
  path: string,
  line: string,
  options: { durable?: boolean } = {},
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const handle = await open(path, 'a', FILE_MODE);
  try {
    await handle.appendFile(line.endsWith('\n') ? line : `${line}\n`);
    if (options.durable) await handle.sync();
  } finally {
    await handle.close();
  }
  // The file's bytes are on disk; its name may not be. A log created this month — or a directory created on a fresh
  // install — exists only as a directory entry until that directory is synced too, and a crash could keep what was
  // written next while losing the file this line went into.
  if (options.durable) {
    await syncDirectory(dirname(path));
    await syncDirectory(dirname(dirname(path)));
  }
}

/**
 * Flushes a directory's entries to disk, so a file just created or renamed in it survives a crash.
 *
 * POSIX only: Windows cannot open a directory for this, and NTFS journals its metadata instead.
 */
export async function syncDirectory(path: string): Promise<void> {
  if (process.platform === 'win32') return;
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** True when a path exists and is readable or writable by someone other than its owner (POSIX only). */
export async function isGroupOrWorldAccessible(path: string): Promise<boolean> {
  if (process.platform === 'win32') return false;
  const info = await stat(path);
  return (info.mode & 0o077) !== 0;
}
