import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);
const checker = new URL('../scripts/verify-desktop-mutations.mjs', import.meta.url);
const manifest = new URL('../apps/desktop/test/mutations/manifest.json', import.meta.url);

test('every desktop mutation has a paired production-path test', async () => {
  const result = spawnSync(process.execPath, [checker.pathname], { cwd: root, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
});

test('an unpaired mutation is rejected', async (t) => {
  const temp = await mkdtemp(join(tmpdir(), 'desktop-manifest-'));
  t.after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(temp, { recursive: true, force: true });
  });
  const document = JSON.parse(await readFile(manifest, 'utf8'));
  document.cases.push({ ...document.cases[0], id: 'unpaired-desktop-case' });
  const altered = join(temp, 'manifest.json');
  await writeFile(altered, JSON.stringify(document));
  const result = spawnSync(process.execPath, [checker.pathname, '--manifest', altered], {
    cwd: root,
    encoding: 'utf8',
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unpaired-desktop-case/);
});

test('a named desktop test without its own marker is rejected', async (t) => {
  const workspaceTest = new URL('../apps/desktop/test/workspace.test.mjs', import.meta.url);
  const original = await readFile(workspaceTest, 'utf8');
  t.after(async () => {
    await writeFile(workspaceTest, original);
  });
  await writeFile(workspaceTest, `${original}\n\ntest('unpaired desktop guard', () => {\n  assert.ok(true);\n});\n`);
  const result = spawnSync(process.execPath, [checker.pathname], { cwd: root, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /unpaired desktop guard: named test has no mutation marker/);
});

test('the private-workspace mutation makes its named test fail', () => {
  const output = execFileSync(
    process.execPath,
    ['apps/desktop/test/mutations/run.mjs', '--case', 'desktop-workspace-private'],
    {
      cwd: root,
      encoding: 'utf8',
    },
  );
  assert.match(output, /mutation desktop-workspace-private failed its named test/);
});
