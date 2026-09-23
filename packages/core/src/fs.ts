import { randomBytes } from 'node:crypto';
import { chmod, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

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
  const directory = dirname(path);
  await ensurePrivateDir(directory);
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
