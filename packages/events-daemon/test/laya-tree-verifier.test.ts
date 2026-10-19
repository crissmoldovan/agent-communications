import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { RuntimeInstallFile } from '../src/runtime/laya/runtime-installer.ts';
import { archiveChunks, runtimeFile, writeUstarFixture } from './support/laya-ustar.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

async function installerModule() {
  return import('../src/runtime/laya/runtime-installer.ts');
}

async function verifierModule() {
  return import('../src/runtime/laya/tree-verifier.ts');
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'events-laya-tree-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function installedTree(
  directory: string,
  executable = false,
): Promise<{ readonly root: string; readonly files: readonly RuntimeInstallFile[] }> {
  const data = 'verified runtime';
  const archive = await writeUstarFixture(directory, 'runtime.tgz', [
    { path: 'package/index.mjs', data, mode: executable ? 0o755 : 0o644 },
  ]);
  const files = [{ ...runtimeFile('node_modules/tiny/index.mjs', data, executable), packageName: 'tiny' }];
  const { installRuntime } = await installerModule();
  const installed = await installRuntime({
    runtimeDirectory: join(directory, 'runtime'),
    lockDigest: 'c'.repeat(64),
    packages: [{ packageName: 'tiny', source: archiveChunks(archive) }],
    files,
  });
  return { root: installed.root, files };
}

test('E2 tree verifier: accepts the exact installed runtime tree', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), { ok: true });
  });
});

test('E2 tree verifier: refuses case-folded expected files before reading the tree', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { verifyRuntimeTree } = await verifierModule();
    assert.deepEqual(
      await verifyRuntimeTree({
        root: join(directory, 'unread-tree'),
        files: [runtimeFile('Foo.mjs', 'first'), runtimeFile('foo.mjs', 'second')],
      }),
      { ok: false, code: 'TREE_EXPECTED' },
    );
  });
});

test('E2 tree verifier: refuses non-NFC expected files before reading the tree', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { verifyRuntimeTree } = await verifierModule();
    assert.deepEqual(
      await verifyRuntimeTree({
        root: join(directory, 'unread-tree'),
        files: [runtimeFile('caf\u00e9.mjs', 'first'), runtimeFile('cafe\u0301.mjs', 'second')],
      }),
      { ok: false, code: 'TREE_EXPECTED' },
    );
  });
});

test('E2 tree verifier: refuses colliding expected directory prefixes before reading the tree', async () => {
  await withTemporaryDirectory(async (directory) => {
    const { verifyRuntimeTree } = await verifierModule();
    assert.deepEqual(
      await verifyRuntimeTree({
        root: join(directory, 'unread-tree'),
        files: [runtimeFile('Foo/a.mjs', 'first'), runtimeFile('foo/b.mjs', 'second')],
      }),
      { ok: false, code: 'TREE_EXPECTED' },
    );
  });
});

test('E2 tree verifier: reports a missing expected file without a path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    await unlink(join(installed.root, 'node_modules/tiny/index.mjs'));
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), {
      ok: false,
      code: 'TREE_MISSING',
    });
  });
});

test('E2 tree verifier: reports an extra installed file without a path', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    await writeFile(join(installed.root, 'extra.mjs'), 'extra');
    let result: Awaited<ReturnType<typeof verifyRuntimeTree>> | undefined;
    await assert.doesNotReject(async () => {
      result = await verifyRuntimeTree({ root: installed.root, files: installed.files });
    });
    assert.deepEqual(result, {
      ok: false,
      code: 'TREE_EXTRA',
    });
  });
});

test('E2 tree verifier: reports a symlink hidden in an installed tree', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    const file = join(installed.root, 'node_modules/tiny/index.mjs');
    await unlink(file);
    await symlink('../tiny/index.mjs', file);
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), {
      ok: false,
      code: 'TREE_TYPE',
    });
  });
});

test('E2 tree verifier: reports an altered file after an earlier verification', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), { ok: true });
    await writeFile(join(installed.root, 'node_modules/tiny/index.mjs'), 'altered contents');
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), {
      ok: false,
      code: 'TREE_HASH',
    });
  });
});

test('E2 tree verifier: reports a resized installed file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory);
    const { verifyRuntimeTree } = await verifierModule();
    await writeFile(join(installed.root, 'node_modules/tiny/index.mjs'), 'short');
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), {
      ok: false,
      code: 'TREE_SIZE',
    });
  });
});

test('E2 tree verifier: reports a changed executable bit', { skip: WINDOWS_SKIP }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installedTree(directory, true);
    const { verifyRuntimeTree } = await verifierModule();
    await chmod(join(installed.root, 'node_modules/tiny/index.mjs'), 0o600);
    assert.deepEqual(await verifyRuntimeTree({ root: installed.root, files: installed.files }), {
      ok: false,
      code: 'TREE_EXECUTABLE',
    });
  });
});
