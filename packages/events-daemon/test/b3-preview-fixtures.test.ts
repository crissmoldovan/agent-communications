import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderB3ApprovalPreviewV1 } from '../src/operations/b3-contract.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures/b3-approval-preview-v1');

test('B3 terminal approval renderer consumes every shared language-neutral preview fixture', async () => {
  const names = (await readdir(FIXTURES)).filter((name) => name.endsWith('.json')).sort();
  assert.ok(names.length > 0, 'the shared preview fixture set is not optional');
  for (const name of names) {
    const fixture = JSON.parse(await readFile(join(FIXTURES, name), 'utf8')) as {
      readonly result: unknown;
      readonly expected: unknown;
    };
    assert.deepEqual(renderB3ApprovalPreviewV1(fixture.result), fixture.expected, name);
  }
});
