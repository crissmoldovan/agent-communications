import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * An empty configuration directory of the test's own, under `root`. An owner started without one reads the
 * developer's real configuration, and its accounts then appear in what the test sees.
 *
 * Kept out of `short-temp.ts`, which the adversarial corpus verifier reads as one of its closed sources.
 */
export async function emptyConfigDir(root: string): Promise<string> {
  const dir = join(root, 'config');
  await mkdir(dir, { recursive: true });
  return dir;
}
