import assert from 'node:assert/strict';
import { lstat, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { RuntimeInstallFile } from '../src/runtime/laya/runtime-installer.ts';
import { archiveChunks, runtimeFile, writeUstarFixture } from './support/laya-ustar.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

async function installerModule() {
  return import('../src/runtime/laya/runtime-installer.ts');
}

async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'events-laya-installer-'));
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function installOnePackage(
  directory: string,
  options: {
    readonly archiveData?: string;
    readonly files?: readonly RuntimeInstallFile[];
    readonly executable?: boolean;
  } = {},
) {
  const data = options.archiveData ?? 'tiny runtime';
  const archive = await writeUstarFixture(directory, 'tiny.tgz', [
    { path: 'package/index.mjs', data, mode: options.executable ? 0o755 : 0o644 },
  ]);
  const files = options.files ?? [
    {
      ...runtimeFile('node_modules/@tiny/runtime/index.mjs', data, options.executable),
      packageName: '@tiny/runtime',
    },
  ];
  const packages = [{ packageName: '@tiny/runtime', source: archiveChunks(archive) }];
  const { installRuntime } = await installerModule();
  return installRuntime({ runtimeDirectory: join(directory, 'runtime'), lockDigest: 'a'.repeat(64), packages, files });
}

test('E2 runtime installer: promotes one complete verified partial tree by rename', async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installOnePackage(directory);
    assert.equal(installed.root, join(directory, 'runtime', 'a'.repeat(64)));
    assert.equal(await readFile(join(installed.root, 'node_modules/@tiny/runtime/index.mjs'), 'utf8'), 'tiny runtime');
    await assert.rejects(() => lstat(`${installed.root}.partial`), { code: 'ENOENT' });
  });
});

test('E2 runtime installer: never promotes a partial tree with a missing listed file', async () => {
  await withTemporaryDirectory(async (directory) => {
    const files = [
      { ...runtimeFile('node_modules/@tiny/runtime/index.mjs', 'tiny runtime'), packageName: '@tiny/runtime' },
      { ...runtimeFile('node_modules/@tiny/runtime/missing.mjs', 'missing'), packageName: '@tiny/runtime' },
    ];
    const { LayaRuntimeInstallError } = await installerModule();
    await assert.rejects(
      () => installOnePackage(directory, { files }),
      (error: unknown) => error instanceof LayaRuntimeInstallError && error.code === 'RUNTIME_INCOMPLETE',
    );
    await assert.rejects(() => lstat(join(directory, 'runtime', 'a'.repeat(64))), { code: 'ENOENT' });
  });
});

test('E2 runtime installer: leaves no final tree when a later package fails verification', async () => {
  await withTemporaryDirectory(async (directory) => {
    const first = await writeUstarFixture(directory, 'first.tgz', [{ path: 'package/index.mjs', data: 'first' }]);
    const second = await writeUstarFixture(directory, 'second.tgz', [{ path: 'package/index.mjs', data: 'second' }]);
    const files = [
      { ...runtimeFile('node_modules/first/index.mjs', 'first'), packageName: 'first' },
      { ...runtimeFile('node_modules/second/missing.mjs', 'missing'), packageName: 'second' },
    ];
    const packages = [
      { packageName: 'first', source: archiveChunks(first) },
      { packageName: 'second', source: archiveChunks(second) },
    ];
    const runtimeDirectory = join(directory, 'runtime');
    const { installRuntime, LayaRuntimeInstallError } = await installerModule();
    await assert.rejects(
      () => installRuntime({ runtimeDirectory, lockDigest: 'b'.repeat(64), packages, files }),
      (error: unknown) => error instanceof LayaRuntimeInstallError && error.code === 'RUNTIME_INCOMPLETE',
    );
    await assert.rejects(() => lstat(join(runtimeDirectory, 'b'.repeat(64))), { code: 'ENOENT' });
  });
});

test('E2 runtime installer: writes owner-only files and directories', { skip: WINDOWS_SKIP }, async () => {
  await withTemporaryDirectory(async (directory) => {
    const installed = await installOnePackage(directory);
    const file = join(installed.root, 'node_modules/@tiny/runtime/index.mjs');
    assert.equal((await stat(installed.root)).mode & 0o077, 0);
    assert.equal((await stat(join(installed.root, 'node_modules/@tiny/runtime'))).mode & 0o077, 0);
    assert.equal((await stat(file)).mode & 0o077, 0);
    assert.equal((await stat(file)).mode & 0o111, 0);
  });
});
