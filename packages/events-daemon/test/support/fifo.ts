import { closeSync, constants, openSync, writeSync } from 'node:fs';

/**
 * Lets go of whatever is reading a FIFO — the owner, if it is stuck on one — by writing a byte into it, and never
 * waits. Opened O_NONBLOCK, a FIFO nobody has open to read refuses at once (ENXIO), where a plain write would block its
 * process until a reader came: from a test, forever. Says whether anything was reading.
 */
export function releaseFifoReader(path: string): boolean {
  let fd: number;
  try {
    fd = openSync(path, constants.O_WRONLY | constants.O_NONBLOCK);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENXIO') return false;
    throw error;
  }
  try {
    writeSync(fd, 'x');
  } catch (error) {
    // A full pipe still has its reader: the byte is not needed to wake it.
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
  } finally {
    closeSync(fd);
  }
  return true;
}
