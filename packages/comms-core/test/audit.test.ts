import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { AuditLog, recipientDomains } from '../src/audit.ts';
import { tempDir } from './helpers/temp.ts';

test('records land in a monthly owner-only JSONL file and read back newest last', async () => {
  const state = tempDir();
  const log = new AuditLog(state);
  await log.append({ at: '2026-08-31T23:59:00.000Z', inbox: 'work', operation: 'draft.create', outcome: 'ok' });
  await log.append({ at: '2026-09-01T00:00:01.000Z', inbox: 'home', operation: 'modify', outcome: 'ok' });
  await log.append({
    at: '2026-09-02T10:00:00.000Z',
    inbox: 'work',
    operation: 'send.execute',
    outcome: 'refused',
    reason: 'digest changed',
  });

  assert.deepEqual(readdirSync(join(state, 'audit')).sort(), ['2026-08.jsonl', '2026-09.jsonl']);
  if (process.platform !== 'win32') assert.equal(statSync(join(state, 'audit', '2026-09.jsonl')).mode & 0o777, 0o600);

  const all = await log.tail();
  assert.deepEqual(
    all.map((r) => r.operation),
    ['draft.create', 'modify', 'send.execute'],
  );
  const work = await log.tail({ inbox: 'work' });
  assert.deepEqual(
    work.map((r) => r.at),
    ['2026-08-31T23:59:00.000Z', '2026-09-02T10:00:00.000Z'],
  );
  const recent = await log.tail({ since: '2026-09-01T00:00:00.000Z' });
  assert.equal(recent.length, 2);
  assert.equal((await log.tail({ limit: 1 }))[0]?.operation, 'send.execute');
});

test('tail on a missing log is empty and a corrupt line is skipped', async () => {
  const state = tempDir();
  const log = new AuditLog(state);
  assert.deepEqual(await log.tail(), []);
  await log.append({ at: '2026-09-02T10:00:00.000Z', inbox: 'a', operation: 'x', outcome: 'ok' });
  const file = join(state, 'audit', '2026-09.jsonl');
  const { appendFileSync } = await import('node:fs');
  appendFileSync(file, 'not json\n');
  assert.equal((await log.tail()).length, 1);
  assert.ok(readFileSync(file, 'utf8').includes('not json'));
});

test('recipientDomains keeps only lower-cased unique domains', () => {
  assert.deepEqual(recipientDomains(['A@Example.COM', 'b@example.com', 'c@other.test', 'no-at-sign']), [
    'example.com',
    'other.test',
  ]);
});
