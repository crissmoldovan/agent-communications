import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const taskFragmentPath = 'packages/events-daemon/test/fixtures/laya/cases/task-2.json';
const evidencePath = 'docs/superpowers/evidence/2026-10-10-e2-external-sources.md';

interface ExternalSource {
  readonly id: string;
  readonly immutable: string;
}

interface E2VerifierModule {
  readonly verifyExternalSources?: (
    root: string,
    fragment: { readonly file: string; readonly externalSources: readonly ExternalSource[] },
  ) => void;
}

function noncanonicalSha512Sri(integrity: string): string {
  const prefix = 'sha512-';
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  assert.ok(integrity.startsWith(prefix));
  const payload = integrity.slice(prefix.length);
  const final = payload.at(-3);
  assert.ok(final);
  const index = alphabet.indexOf(final);
  assert.ok(index >= 0 && index % 16 === 0, 'a sha512 SRI payload has canonical final padding bits');
  return `${prefix}${payload.slice(0, -3)}${alphabet[index + 1]}==`;
}

async function runChecker(): Promise<{ readonly code: number | null; readonly output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        'scripts/verify-events-phase-e2-tests.mjs',
      ],
      { cwd: repositoryRoot, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let output = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      output += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, output }));
  });
}

test('laya scope: completed checker accepts the Task 3 proof fragment', async () => {
  const result = await runChecker();
  assert.equal(result.code, 0, result.output);
});

test('laya scope: the checker keeps the Laya kind vocabulary owned by lifecycle', async () => {
  const result = await runChecker();
  assert.equal(result.code, 0, result.output);
});

test('laya scope: the checker refuses a copied noncanonical external-source SRI', async () => {
  // @ts-expect-error The E2 checker is JavaScript and deliberately has no TypeScript declaration.
  const verifier = (await import('../../../scripts/verify-events-phase-e2-tests.mjs')) as E2VerifierModule;
  const verifyExternalSources = verifier.verifyExternalSources;
  assert.equal(typeof verifyExternalSources, 'function');
  if (typeof verifyExternalSources !== 'function') return;

  const task = JSON.parse(await readFile(join(repositoryRoot, taskFragmentPath), 'utf8')) as {
    readonly externalSources: readonly ExternalSource[];
  };
  const original = task.externalSources.find((source) => source.id === 'npm-receptron-laya-0.1.2');
  assert.ok(original);
  const noncanonical = noncanonicalSha512Sri(original.immutable);
  assert.deepEqual(
    Buffer.from(noncanonical.slice('sha512-'.length), 'base64'),
    Buffer.from(original.immutable.slice('sha512-'.length), 'base64'),
  );

  for (const immutable of [noncanonical, `sha256-${original.immutable.slice('sha512-'.length)}`]) {
    const root = await mkdtemp(join(tmpdir(), 'events-e2-external-source-'));
    try {
      const copiedSources = task.externalSources.map((source) =>
        source.id === original.id ? { ...source, immutable } : source,
      );
      const copiedFragment = { ...task, externalSources: copiedSources };
      const copiedFragmentPath = join(root, taskFragmentPath);
      const copiedEvidencePath = join(root, evidencePath);
      await mkdir(dirname(copiedFragmentPath), { recursive: true });
      await mkdir(dirname(copiedEvidencePath), { recursive: true });
      await writeFile(copiedFragmentPath, `${JSON.stringify(copiedFragment, null, 2)}\n`, 'utf8');
      const evidence = await readFile(join(repositoryRoot, evidencePath), 'utf8');
      assert.ok(evidence.includes(original.immutable));
      await writeFile(copiedEvidencePath, evidence.replace(original.immutable, immutable), 'utf8');

      const copied = JSON.parse(await readFile(copiedFragmentPath, 'utf8')) as {
        readonly externalSources: readonly ExternalSource[];
      };
      assert.throws(
        () => verifyExternalSources(root, { file: taskFragmentPath, externalSources: copied.externalSources }),
        /E2_EXTERNAL_REFERENCE_BLOCKED/,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});
