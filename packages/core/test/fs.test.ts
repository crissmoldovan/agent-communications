import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { appendPrivateLine, ensurePrivateDir, isGroupOrWorldAccessible, writeFileAtomic } from '../src/fs.ts';
import { tempDir } from './helpers/temp.ts';

const posix = process.platform !== 'win32';

test('writeFileAtomic creates owner-only files in owner-only directories and leaves no temp files', async () => {
  const root = tempDir();
  const target = join(root, 'nested', 'config.json');
  await writeFileAtomic(target, '{"a":1}');
  await writeFileAtomic(target, '{"a":2}');
  assert.equal(readFileSync(target, 'utf8'), '{"a":2}');
  assert.deepEqual(readdirSync(join(root, 'nested')), ['config.json']);
  if (posix) {
    assert.equal(statSync(target).mode & 0o777, 0o600);
    assert.equal(statSync(join(root, 'nested')).mode & 0o777, 0o700);
    assert.equal(await isGroupOrWorldAccessible(target), false);
  }
});

test('ensurePrivateDir tightens an existing loose directory', { skip: !posix }, async () => {
  const root = tempDir();
  const dir = join(root, 'loose');
  const { mkdirSync, chmodSync } = await import('node:fs');
  mkdirSync(dir);
  chmodSync(dir, 0o755);
  await ensurePrivateDir(dir);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
});

test('appendPrivateLine appends newline-terminated lines to an owner-only file', async () => {
  const root = tempDir();
  const log = join(root, 'audit', '2026-09.jsonl');
  await appendPrivateLine(log, '{"n":1}');
  await appendPrivateLine(log, '{"n":2}\n');
  assert.equal(readFileSync(log, 'utf8'), '{"n":1}\n{"n":2}\n');
  if (posix) assert.equal(statSync(log).mode & 0o777, 0o600);
});

test('a durable append syncs the file, its directory and the one above it; a plain one syncs nothing', async () => {
  // A record written before a change is only a record of it if it survives a crash the change survives. The file's
  // bytes need a sync, and so does its name: a log created this month, in a directory created on a fresh install,
  // exists only as directory entries until those directories are synced too.
  const { open } = await import('node:fs/promises');
  const { mock } = await import('node:test');
  const probe = await open(fileURLToPath(import.meta.url), 'r');
  const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  const sync = mock.method(proto, 'sync');
  try {
    const fresh = join(tempDir(), 'audit', '2026-09.jsonl');
    await appendPrivateLine(fresh, '{"a":1}', { durable: true });
    assert.equal(sync.mock.callCount(), process.platform === 'win32' ? 1 : 3);
    assert.equal(readFileSync(fresh, 'utf8'), '{"a":1}\n');

    sync.mock.resetCalls();
    await appendPrivateLine(fresh, '{"b":2}');
    assert.equal(sync.mock.callCount(), 0);
  } finally {
    sync.mock.restore();
  }
});
