#!/usr/bin/env node
/** The only cold-store install probe. Ordinary verify runs its offline self-test. */
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = fileURLToPath(new URL('..', import.meta.url));
const runtimeName = '@agentcomms/events-laya-runtime';
export const NORMAL_INSTALL_ARGS = ['install', '--frozen-lockfile', '--filter', `!${runtimeName}`];
export const RUNTIME_DIRECT_PACKAGES = ['@receptron/laya', 'onnxruntime-node', '@huggingface/tokenizers'];

async function storeFiles(directory) {
  const names = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) names.push(...(await storeFiles(path)));
    else if (entry.isFile()) names.push(path);
  }
  return names;
}

/**
 * Those three packages are the private importer's only roots. If none occurs in
 * the fresh store, no member of its resolved closure can have been acquired.
 */
export async function assertNoRuntimeClosure(store) {
  const files = await storeFiles(store);
  for (const file of files) {
    const bytes = await readFile(file);
    for (const name of RUNTIME_DIRECT_PACKAGES) {
      if (bytes.includes(Buffer.from(name)))
        throw new Error(`cold pnpm store acquired forbidden runtime package ${name}`);
    }
  }
}

/**
 * pnpm 11 reinstalls before a script when it judges node_modules stale, and that install is unfiltered: it would bring
 * the runtime closure into an ordinary checkout. The workspace must tell pnpm to stop instead.
 */
export async function assertNoAutomaticInstall(root = repositoryRoot) {
  const workspace = await readFile(join(root, 'pnpm-workspace.yaml'), 'utf8');
  if (!/^verifyDepsBeforeRun: error$/mu.test(workspace))
    throw new Error(
      'pnpm-workspace.yaml must set verifyDepsBeforeRun: error, or pnpm reinstalls unfiltered before scripts',
    );
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' });
    child.once('error', reject);
    child.once('close', (code) => (code === 0 ? resolve(undefined) : reject(new Error(`${command} exited ${code}`))));
  });
}

export async function selfTest() {
  await assertNoAutomaticInstall();
  const unguarded = await mkdtemp(join(tmpdir(), 'agentcomms-laya-workspace-self-test-'));
  try {
    const workspace = await readFile(join(repositoryRoot, 'pnpm-workspace.yaml'), 'utf8');
    await writeFile(join(unguarded, 'pnpm-workspace.yaml'), workspace.replace(/^verifyDepsBeforeRun: error\n/mu, ''));
    await assertNoAutomaticInstall(unguarded).then(
      () => {
        throw new Error('the workspace guard accepted a workspace that lets pnpm reinstall unfiltered');
      },
      () => undefined,
    );
  } finally {
    await rm(unguarded, { recursive: true, force: true });
  }
  const store = await mkdtemp(join(tmpdir(), 'agentcomms-laya-cold-store-self-test-'));
  try {
    if (NORMAL_INSTALL_ARGS.join(' ') !== `install --frozen-lockfile --filter !${runtimeName}`) {
      throw new Error('normal install arguments changed');
    }
    await assertNoRuntimeClosure(store);
    await writeFile(join(store, 'forbidden-index'), RUNTIME_DIRECT_PACKAGES[0]);
    await assertNoRuntimeClosure(store).then(
      () => {
        throw new Error('cold-store scanner accepted a forbidden runtime package');
      },
      () => undefined,
    );
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

export async function verifyColdStoreInstall() {
  const store = await mkdtemp(join(tmpdir(), 'agentcomms-laya-cold-store-'));
  try {
    await run('pnpm', [...NORMAL_INSTALL_ARGS, '--store-dir', store], repositoryRoot);
    await assertNoRuntimeClosure(store);
  } finally {
    await rm(store, { recursive: true, force: true });
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const selfTestOnly = process.argv.slice(2);
  if (selfTestOnly.length === 1 && selfTestOnly[0] === '--self-test') await selfTest();
  else if (selfTestOnly.length === 0) await verifyColdStoreInstall();
  else throw new Error('usage: verify-laya-ci-install.mjs [--self-test]');
}
