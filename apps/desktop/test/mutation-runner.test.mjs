import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = new URL('../../../', import.meta.url);
const manifest = new URL('./mutations/manifest.json', import.meta.url);
const runner = new URL('./mutations/run.mjs', import.meta.url);

// desktop-mutation: desktop-mutation-runner-declared-name
test('mutation runner executes exactly the declared test name', async (t) => {
  const original = await readFile(manifest, 'utf8');
  const temp = await mkdtemp(join(tmpdir(), 'desktop-manifest-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { recursive: true, force: true });
  });

  const document = JSON.parse(original);
  const item = document.cases.find(({ id }) => id === 'desktop-ui-command-surface');
  const file = item.test.file;
  item.test = {
    kind: 'node',
    file,
    name: 'runner must execute this declared test name',
  };
  const altered = join(temp, 'manifest.json');
  await writeFile(altered, JSON.stringify(document));

  const result = spawnSync(process.execPath, [fileURLToPath(runner), '--manifest', altered, '--case', item.id], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /named test is not green/);
});

// desktop-mutation: desktop-mutation-runner-single-test-count
test('mutation runner requires the complete one-test TAP summary for Node kills', async () => {
  const source = await readFile(runner, 'utf8');
  assert.match(source, /\^# tests 1\$/u, 'the baseline must reject a missing or extra Node test');
  assert.match(source, /\^# pass \$\{expected\.pass\}/u, 'the runner must inspect the TAP pass count');
  assert.match(source, /\^# fail \$\{expected\.fail\}/u, 'the runner must inspect the TAP failure count');
  assert.match(source, /nodeSummary\(baseline\.stdout, \{ pass: 1, fail: 0 \}\)/u);
  assert.match(source, /nodeSummary\(result\.stdout, \{ pass: 0, fail: 1 \}\)/u);
});
