import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

async function runtimeLockModule() {
  return import('../../../scripts/laya-runtime-lock.mjs');
}

async function packageJson(relative) {
  return JSON.parse(await readFile(join(repositoryRoot, relative), 'utf8'));
}

test('E2 runtime package: dependency-only manifest pins the reviewed runtime roots', async () => {
  const { assertPrivateRuntimePackage } = await runtimeLockModule();
  const manifest = await packageJson('packages/events-laya-runtime/package.json');
  assert.deepEqual(assertPrivateRuntimePackage(manifest), {
    '@huggingface/tokenizers': '0.2.0',
    '@receptron/laya': '0.1.2',
    'onnxruntime-node': '1.30.0',
  });
});

test('E2 runtime package: daemon package ships reviewed assets without importing the runtime', async () => {
  const { assertDaemonRuntimeBoundary } = await runtimeLockModule();
  const manifest = await packageJson('packages/events-daemon/package.json');
  assert.doesNotThrow(() => assertDaemonRuntimeBoundary(manifest));
  assert.deepEqual(
    manifest.files.filter((entry) => entry.startsWith('laya-')),
    ['laya-enablement-disclosures.json', 'laya-manifest.json', 'laya-runtime.json'],
  );
});
