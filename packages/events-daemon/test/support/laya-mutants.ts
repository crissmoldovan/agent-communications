import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';

export interface LayaMutation {
  readonly id: string;
  readonly kind: 'production';
  readonly owner: string;
  /** A repository-relative production source path. */
  readonly source: string;
  readonly testFile: string;
  readonly testName: string;
  readonly testPattern: string;
  readonly before: string;
  readonly after: string;
}

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const casesRoot = join(repositoryRoot, 'packages/events-daemon/test/fixtures/laya/cases');

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

/** Loads production mutations from the owning immutable task fragment, never a parallel registry. */
export async function loadLayaMutations(task = 3): Promise<readonly LayaMutation[]> {
  const fragmentPath = join(casesRoot, `task-${task}.json`);
  const fragment: unknown = JSON.parse(await readFile(fragmentPath, 'utf8'));
  if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
    throw new Error(`task-${task}.json must be an object`);
  }
  const mutations = (fragment as { readonly mutations?: unknown }).mutations;
  if (!Array.isArray(mutations)) throw new Error(`task-${task}.json must declare mutations`);

  return mutations.flatMap((row, index) => {
    if (row === null || typeof row !== 'object' || Array.isArray(row)) {
      throw new Error(`task-${task}.json mutation ${index} must be an object`);
    }
    const mutation = row as Record<string, unknown>;
    if (mutation.kind !== 'production') return [];
    const testName = requiredString(mutation.testName, `task-${task}.json mutation ${index}.testName`);
    const testPattern = requiredString(mutation.testPattern, `task-${task}.json mutation ${index}.testPattern`);
    if (testPattern !== testName) {
      throw new Error(`task-${task}.json mutation ${index}.testPattern must equal testName`);
    }
    return [
      {
        id: requiredString(mutation.id, `task-${task}.json mutation ${index}.id`),
        kind: 'production' as const,
        owner: requiredString(mutation.owner, `task-${task}.json mutation ${index}.owner`),
        source: requiredString(mutation.source, `task-${task}.json mutation ${index}.source`),
        testFile: requiredString(mutation.testFile, `task-${task}.json mutation ${index}.testFile`),
        testName,
        testPattern,
        before: requiredString(mutation.before, `task-${task}.json mutation ${index}.before`),
        after: requiredString(mutation.after, `task-${task}.json mutation ${index}.after`),
      },
    ];
  });
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function copyFixtureTree(root: string): Promise<void> {
  const files = [
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'docs/RELEASING.md',
    '.blocks/post-clone.sh',
    '.claude/skills/release/SKILL.md',
    '.claude/skills/review-pr/SKILL.md',
    '.github/workflows/release.yml',
    'scripts/verify-events-phase-e2-tests.mjs',
    'scripts/verify-laya-ci-install.mjs',
    'scripts/release-ci.mjs',
    'packages/events-daemon/package.json',
    'packages/events-daemon/test/laya-mutations.test.ts',
    'packages/events-daemon/test/laya-scope.test.ts',
    'packages/events-daemon/test/support/laya-mutants.ts',
    'packages/events-daemon/test/fixtures/laya/cases/schema-v1.json',
    'packages/events-daemon/test/fixtures/laya/cases/task-3.json',
    'test/helpers/loopback-seal-preload.mjs',
  ];
  for (const file of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(repositoryRoot, file), destination);
  }
}

/** Copies one production module, makes one exact destructive edit, and runs only its named sealed oracle. */
export async function expectLayaMutationToFail(mutation: LayaMutation): Promise<number> {
  const root = await mkdtemp(join(tmpdir(), `events-e2-mutant-${mutation.id}-`));
  try {
    await copyFixtureTree(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(repositoryRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const result = await new Promise<{ readonly code: number | null; readonly output: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          '--import',
          join(root, 'test/helpers/loopback-seal-preload.mjs'),
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--test',
          '--test-name-pattern',
          exactTestName(mutation.testName),
          join(root, mutation.testFile),
        ],
        { cwd: root, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
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
    assert.notEqual(
      result.code,
      0,
      `${mutation.id}: ${mutation.testName} unexpectedly accepted mutant ${mutation.source}:${changedLine}\n${result.output}`,
    );
    // A copy that crashes before its oracle runs also exits non-zero; only the named test, run and failed, kills it.
    assert.match(
      result.output,
      /^# tests 1$/m,
      `${mutation.id}: exactly its named test ran\n${result.output.slice(-2000)}`,
    );
    assert.match(result.output, /^# fail 1$/m, `${mutation.id}: its named test failed\n${result.output.slice(-2000)}`);
    return changedLine;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
