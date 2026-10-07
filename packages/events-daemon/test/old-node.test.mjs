import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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
  // Until the owner command lands (Task 6 makes this a run, status, stop round trip), prove the SQLite the daemon
  // uses on this exact Node: a file database, WAL, STRICT tables and BEGIN IMMEDIATE.
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'agent-events-old-node-'));
  try {
    const database = new DatabaseSync(join(dir, 'events.sqlite'));
    assert.equal(database.prepare('PRAGMA journal_mode = WAL').get().journal_mode, 'wal');
    database.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, value BLOB NOT NULL) STRICT');
    database.exec('BEGIN IMMEDIATE');
    database.prepare('INSERT INTO probe (id, value) VALUES (?, ?)').run(1, new Uint8Array([1, 2, 3]));
    database.exec('COMMIT');
    assert.deepEqual([...database.prepare('SELECT value FROM probe WHERE id = 1').get().value], [1, 2, 3]);
    database.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
