import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const created: string[] = [];
process.once('exit', () => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** A fresh temp directory, removed when the test process exits. */
export function tempDir(prefix = 'comms-core-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}
