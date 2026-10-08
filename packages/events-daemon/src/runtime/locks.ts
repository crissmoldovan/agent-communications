import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';

export interface EventOwnerLock {
  release(): Promise<void>;
}

/** Claims the daemon's one-owner lock without following a symlink on POSIX. */
export async function acquireEventOwnerLock(path: string): Promise<EventOwnerLock | null> {
  const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
  try {
    const handle = await open(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
    return {
      async release(): Promise<void> {
        await handle.close();
        await rm(path, { force: true });
      },
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }
}
