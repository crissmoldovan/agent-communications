import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A temporary state root short enough for a Unix control socket: macOS allows 103 bytes and its per-user temporary
 * directory alone is about 48, so an owner started under it is one deep path from refusing (B1-G). `/tmp` is sticky
 * and owned by root, which the socket-directory check accepts.
 */
export function shortTempDir(prefix: string): Promise<string> {
  return mkdtemp(join(process.platform === 'win32' ? tmpdir() : '/tmp', prefix));
}

/** The event service refuses on Windows in B1 (B1-G); tests that start an owner or open its database skip there. */
export const WINDOWS_SKIP: string | false =
  process.platform === 'win32' && 'B1-G: the local event service does not run on Windows in this release';
