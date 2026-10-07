// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status } from '@agentcomms/events-daemon';

assert.deepEqual(await status(), { owner: 'not-running' });
const dist = dirname(fileURLToPath(import.meta.resolve('@agentcomms/events-daemon')));
const cli = join(dist, 'cli.mjs');
const help = execFileSync(process.execPath, [cli, '--help'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const result = execFileSync(process.execPath, [cli, '--json', 'status'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe'],
});
assert.match(help, /Usage: agent-events/);
assert.equal(result, '{"owner":"not-running"}\n');
console.log('events-daemon consumer check: package import and held status command OK');
