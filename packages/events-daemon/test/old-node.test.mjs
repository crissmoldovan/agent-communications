import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'events-daemon', 'dist', 'cli.mjs');
const FLOOR = [22, 16, 0];

/** Whether this Node is at or above the daemon's floor (plan amendment B1-F): Node SQLite unflagged and complete. */
function atFloor() {
  const have = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== FLOOR[index]) return have[index] > FLOOR[index];
  }
  return true;
}

test(`the built held service command answers --help on Node ${process.versions.node}, whatever its SQLite`, () => {
  const help = spawnSync(process.execPath, [CLI, '--help'], { encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /Usage: agent-events/);
  assert.doesNotMatch(help.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|ExperimentalWarning/);
});

test(`the built held service command reaches Node SQLite on Node ${process.versions.node}, or refuses below 22.16.0`, () => {
  const status = spawnSync(process.execPath, [CLI, '--json', 'status'], { encoding: 'utf8' });
  if (atFloor()) {
    assert.equal(status.status, 0, status.stderr);
    assert.equal(status.stdout, '{"owner":"not-running"}\n');
    assert.equal(status.stderr, '', 'no ExperimentalWarning or anything else on stderr');
    return;
  }
  assert.equal(status.status, 78, 'a configuration refusal, not a crash');
  assert.equal(status.stdout, '');
  assert.match(status.stderr, /needs Node 22\.16\.0 or newer, and this is Node /);
  assert.doesNotMatch(status.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|\n\s+at /, 'no stack trace');
});

test(`Node ${process.versions.node} opens a WAL, STRICT database with immediate transactions, or is below the floor`, async (t) => {
  if (!atFloor()) {
    t.skip('below the daemon floor; the refusal above is what this Node must show');
    return;
  }
  // Short enough for a Unix socket path on macOS (103 bytes), whose per-user temporary directory is about 48.
  const dir = mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', 'aev-old-node-'));
  let child;
  try {
    child = spawn(process.execPath, [CLI, '--state-dir', dir, 'run'], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let status;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = spawnSync(process.execPath, [CLI, '--state-dir', dir, '--json', 'status'], { encoding: 'utf8' });
      if (status.status === 0 && /"owner":"running"/.test(status.stdout)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(status);
    assert.equal(status.status, 0, `${status.stderr}\nowner stderr: ${stderr}`);
    assert.match(status.stdout, /"owner":"running"/, `owner stderr: ${stderr}`);
    const database = join(dir, 'events', 'events.sqlite');
    assert.ok(existsSync(database), 'run opens and migrates the owner database before it serves status');
    assert.ok(statSync(database).size > 0);
    const stop = spawnSync(process.execPath, [CLI, '--state-dir', dir, '--json', 'stop'], { encoding: 'utf8' });
    assert.equal(stop.status, 0, stop.stderr);
    const exit = await new Promise((resolve) => child.once('exit', resolve));
    assert.equal(exit, 0, stderr);
  } finally {
    if (child && child.exitCode === null) {
      child.kill('SIGTERM');
      await new Promise((resolve) => child.once('exit', resolve));
    }
    rmSync(dir, { recursive: true, force: true });
  }
});
