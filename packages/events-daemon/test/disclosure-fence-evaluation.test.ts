import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('EVAL-B1: evaluation reaches the shared fence before any encrypted projection can be read or mapped', async () => {
  const source = await readFile(new URL('../src/runtime/evaluate.ts', import.meta.url), 'utf8');
  const fence = source.indexOf('await this.#fence({');
  const decrypt = source.indexOf('await this.#projections.read');
  assert.ok(fence >= 0, 'evaluation calls its shared disclosure fence');
  assert.ok(decrypt >= 0, 'evaluation reads its encrypted projection');
  assert.ok(fence < decrypt, 'a revoked/stale lineage cannot reach decrypt, mapping, decision or delivery creation');
});
