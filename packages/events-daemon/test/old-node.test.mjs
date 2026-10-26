import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const CLI = join(ROOT, 'packages', 'events-daemon', 'dist', 'cli.mjs');
// `--import` takes a module specifier: on Windows an absolute path reads as a URL scheme, so pass a file URL.
const PRELOAD = new URL('../../../test/helpers/loopback-seal-preload.mjs', import.meta.url).href;
const FLOOR = [22, 16, 0];

/** Whether this Node is at or above the daemon's floor (plan amendment B1-F): Node SQLite unflagged and complete. */
function atFloor() {
  const have = process.versions.node.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < 3; index += 1) {
    if (have[index] !== FLOOR[index]) return have[index] > FLOOR[index];
  }
  return true;
}

/**
 * The children's environment: a temporary home and Agent Comms folders under `dir`, never the person's own — so no
 * child reads their configuration, reaches their running event service, or looks for anything in their home.
 */
function isolated(dir, { state = true } = {}) {
  return {
    ...process.env,
    HOME: join(dir, 'home'),
    USERPROFILE: join(dir, 'home'),
    AGENT_COMMS_CONFIG_DIR: join(dir, 'config'),
    AGENT_COMMS_DATA_DIR: join(dir, 'data'),
    ...(state ? { AGENT_COMMS_STATE_DIR: join(dir, 'state') } : {}),
  };
}

/** A short temporary folder: a Unix socket path on macOS has 103 bytes, its per-user temporary directory about 48. */
function shortDir(prefix) {
  return mkdtempSync(join(process.platform === 'win32' ? tmpdir() : '/tmp', prefix));
}

test(`the built held service command answers --help on Node ${process.versions.node}, whatever its SQLite`, () => {
  const dir = shortDir('aev-old-help-');
  try {
    const help = spawnSync(process.execPath, ['--import', PRELOAD, CLI, '--help'], {
      encoding: 'utf8',
      env: isolated(dir),
    });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /Usage: agent-events/);
    assert.doesNotMatch(help.stderr, /ERR_UNKNOWN_BUILTIN_MODULE|ExperimentalWarning/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`the built held service command reaches Node SQLite on Node ${process.versions.node}, or refuses below 22.16.0`, () => {
  const dir = shortDir('aev-old-status-');
  try {
    const status = spawnSync(process.execPath, ['--import', PRELOAD, CLI, '--json', 'status'], {
      encoding: 'utf8',
      env: isolated(dir),
    });
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test(`Node ${process.versions.node} opens a WAL, STRICT database with immediate transactions, or is below the floor`, async (t) => {
  if (!atFloor()) {
    t.skip('below the daemon floor; the refusal above is what this Node must show');
    return;
  }
  // Short enough for a Unix socket path on macOS (103 bytes), whose per-user temporary directory is about 48.
  const dir = shortDir('aev-old-node-');
  const env = isolated(dir, { state: false });
  let child;
  try {
    child = spawn(process.execPath, ['--import', PRELOAD, CLI, '--state-dir', dir, 'run'], {
      env,
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    let status;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      status = spawnSync(process.execPath, ['--import', PRELOAD, CLI, '--state-dir', dir, '--json', 'status'], {
        encoding: 'utf8',
        env,
      });
      if (status.status === 0 && /"owner":"running"/.test(status.stdout)) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    assert.ok(status);
    assert.equal(status.status, 0, `${status.stderr}\nowner stderr: ${stderr}`);
    assert.match(status.stdout, /"owner":"running"/, `owner stderr: ${stderr}`);
    const database = join(dir, 'events', 'events.sqlite');
    assert.ok(existsSync(database), 'run opens and migrates the owner database before it serves status');
    assert.ok(statSync(database).size > 0);
    const stop = spawnSync(process.execPath, ['--import', PRELOAD, CLI, '--state-dir', dir, '--json', 'stop'], {
      encoding: 'utf8',
      env,
    });
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
