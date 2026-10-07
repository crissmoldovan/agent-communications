import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'events-daemon', 'dist', 'cli.mjs');

test(`the built held service command runs on Node ${process.versions.node} with Node SQLite`, () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: agent-events/);

  const status = spawnSync(process.execPath, [CLI, '--json', 'status'], { encoding: 'utf8' });
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stdout, '{"owner":"not-running"}\n');
});
