import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const checker = new URL('../scripts/verify-desktop-mutations.mjs', import.meta.url);
const manifest = new URL('../apps/desktop/test/mutations/manifest.json', import.meta.url);
const rootMutationTests = new URL('./desktop-mutations.test.mjs', import.meta.url);

// desktop-mutation: desktop-root-mutation-structural-only
test('root desktop mutation verification is structural only', async () => {
  const source = await readFile(checker, 'utf8');
  assert.doesNotMatch(source, /apps\/desktop\/test\/mutations\/run\.mjs/);
  assert.doesNotMatch(await readFile(rootMutationTests, 'utf8'), /apps\/desktop\/test\/mutations\/run\.mjs/);
  const document = JSON.parse(await readFile(manifest, 'utf8'));
  for (const item of document.cases.filter((entry) => entry.test.includes('/e2e/'))) {
    assert.equal(item.execution, 'desktop-e2e', `${item.id} must be marked for desktop-only execution`);
  }
  const result = spawnSync(process.execPath, [checker.pathname], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});
