import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { WINDOWS_SKIP_REASON } from './short-temp.ts';

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

export interface LayaMutationExecution {
  readonly changedLine: number | null;
  /** The exact named oracle's TAP output before the source mutation. */
  readonly baselineOutput: string;
  /** The exact named oracle's TAP output after the source mutation. */
  readonly mutantOutput: string | null;
  readonly platformSkipped: boolean;
}

export interface LayaMutationPlatformSkip {
  readonly platform: NodeJS.Platform;
  readonly baselineOutput: string;
}

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const casesRoot = join(repositoryRoot, 'packages/events-daemon/test/fixtures/laya/cases');

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} must be a non-empty string`);
  return value;
}

async function taskFragments(): Promise<readonly { readonly task: number; readonly path: string }[]> {
  const fragments: { readonly task: number; readonly path: string }[] = [];
  for (const name of await readdir(casesRoot)) {
    const matched = /^task-([1-9]\d*)\.json$/.exec(name);
    if (matched === null) continue;
    fragments.push({ task: Number(matched[1]), path: join(casesRoot, name) });
  }
  return fragments.sort((left, right) => left.task - right.task);
}

/** Loads every task-owned production mutation, never a parallel registry. */
export async function loadLayaMutations(): Promise<readonly LayaMutation[]> {
  const result: LayaMutation[] = [];
  for (const { task, path: fragmentPath } of await taskFragments()) {
    const fragment: unknown = JSON.parse(await readFile(fragmentPath, 'utf8'));
    if (fragment === null || typeof fragment !== 'object' || Array.isArray(fragment)) {
      throw new Error(`task-${task}.json must be an object`);
    }
    const mutations = (fragment as { readonly mutations?: unknown }).mutations;
    if (!Array.isArray(mutations)) throw new Error(`task-${task}.json must declare mutations`);

    result.push(
      ...mutations.flatMap((row, index) => {
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
      }),
    );
  }
  return result;
}

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function copyFile(root: string, file: string): Promise<void> {
  const destination = join(root, file);
  await mkdir(dirname(destination), { recursive: true });
  await cp(join(repositoryRoot, file), destination);
}

function localImports(source: string): readonly string[] {
  const imports = new Set<string>();
  for (const match of source.matchAll(/(?:from\s*|import\s*\()(['"])(\.[^'"]+)\1/g)) {
    const specifier = match[2];
    if (specifier !== undefined) imports.add(specifier);
  }
  return [...imports];
}

async function copyDependencyClosure(root: string, entry: string): Promise<void> {
  const pending = [entry];
  const copied = new Set<string>();
  while (pending.length > 0) {
    const file = pending.pop();
    if (file === undefined || copied.has(file)) continue;
    copied.add(file);
    const source = await readFile(join(repositoryRoot, file), 'utf8');
    await copyFile(root, file);
    for (const specifier of localImports(source)) {
      const target = relative(repositoryRoot, resolve(dirname(join(repositoryRoot, file)), specifier));
      if (target.startsWith('..')) throw new Error(`local import escapes the repository: ${file} -> ${specifier}`);
      pending.push(target);
    }
  }
}

async function copyFixtureTree(root: string, mutation: LayaMutation): Promise<void> {
  const files = [
    'package.json',
    'README.md',
    'CONTRIBUTING.md',
    'docs/RELEASING.md',
    'docs/superpowers/evidence/2026-10-10-e2-external-sources.md',
    '.blocks/post-clone.sh',
    '.claude/skills/release/SKILL.md',
    '.claude/skills/review-pr/SKILL.md',
    '.github/workflows/release.yml',
    'scripts/verify-events-phase-e2-tests.mjs',
    'scripts/verify-laya-ci-install.mjs',
    'scripts/release-ci.mjs',
    'scripts/laya-runtime-lock.mjs',
    'pnpm-lock.yaml',
    'packages/events-daemon/package.json',
    'packages/events-daemon/laya-enablement-disclosures.json',
    'packages/events-daemon/laya-manifest.json',
    'packages/events-daemon/laya-runtime.json',
    'packages/events-laya-runtime/package.json',
    'packages/events-daemon/test/laya-scope.test.ts',
    'packages/events-daemon/test/fixtures/laya/lock-expected.json',
    'packages/events-daemon/test/fixtures/laya/disclosures-tiny-v1.json',
    'packages/events-daemon/test/fixtures/laya/manifest-tiny-v1.json',
    'packages/events-daemon/test/fixtures/laya/lock-input/runtime-a-1.0.0.tgz',
    'packages/events-daemon/test/fixtures/laya/lock-input/runtime-b-1.0.0.tgz',
    'packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx',
    'packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya.onnx.data',
    'packages/events-daemon/test/fixtures/laya/model-tiny-v1/laya_config.json',
    'packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer.json',
    'packages/events-daemon/test/fixtures/laya/model-tiny-v1/tokenizer/tokenizer_config.json',
    'packages/events-daemon/src/runtime/laya/worker-main.ts',
    'packages/events-daemon/test/support/laya-worker-standin.ts',
    'test/helpers/loopback-seal-preload.mjs',
  ];
  for (const file of files) await copyFile(root, file);
  for (const name of await readdir(casesRoot))
    await copyFile(root, `packages/events-daemon/test/fixtures/laya/cases/${name}`);
  await copyDependencyClosure(root, mutation.source);
  await copyDependencyClosure(root, mutation.testFile);
  // The oracle's mutable daemon source/test closure is copied above. Its immutable workspace dependency graph keeps
  // the ordinary package-manager layout, so copied source and scripts resolve the same reviewed toolchain. These are
  // 'dir' links on every platform: pnpm's workspace links do not resolve through a Windows junction.
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(
    join(repositoryRoot, 'packages/events-daemon/node_modules'),
    join(root, 'packages/events-daemon/node_modules'),
    'dir',
  );
  for (const packageName of ['core', 'events', 'gmail', 'resend', 'slack', 'whatsapp']) {
    await symlink(join(repositoryRoot, 'packages', packageName), join(root, 'packages', packageName), 'dir');
  }
}

async function runNamedOracle(
  root: string,
  mutation: LayaMutation,
): Promise<{ readonly code: number | null; readonly output: string }> {
  const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        join(root, 'test/helpers/loopback-seal-preload.mjs'),
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        // The strict rule reads TAP's summary; Node 24 defaults to the spec reporter when piped.
        '--test-reporter=tap',
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
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasTapSkip(output: string): boolean {
  return /^# skipped [1-9]\d*$/m.test(output);
}

/** A Windows exemption is credit only for the exact named test and the shared B1-G reason. */
export function isAllowedLayaMutationPlatformSkip(mutation: LayaMutation, skip: LayaMutationPlatformSkip): boolean {
  if (skip.platform !== 'win32') return false;
  const test = escapeExpression(mutation.testName);
  const reason = escapeExpression(WINDOWS_SKIP_REASON);
  return (
    new RegExp(`^ok 1 - ${test} # SKIP ${reason}$`, 'm').test(skip.baselineOutput) &&
    (skip.baselineOutput.match(/# SKIP /g) ?? []).length === 1 &&
    /^# tests 1$/m.test(skip.baselineOutput) &&
    /^# pass 0$/m.test(skip.baselineOutput) &&
    /^# fail 0$/m.test(skip.baselineOutput) &&
    /^# cancelled 0$/m.test(skip.baselineOutput) &&
    /^# skipped 1$/m.test(skip.baselineOutput) &&
    /^# todo 0$/m.test(skip.baselineOutput)
  );
}

/** Every mutation the runner was required to execute ran, and nothing else did. Task 5's fragment anchors this text. */
function assertExactlyExecuted(mutations: readonly LayaMutation[], executed: ReadonlySet<string>): void {
  const missing = mutations.find((mutation) => !executed.has(mutation.id));
  if (missing !== undefined) throw new Error(`registered production mutant was never executed: ${missing.id}`);
  assert.equal(executed.size, mutations.length, 'runner executed an unregistered production mutant');
}

/** Refuses a runner that loads a registered production mutation but does not run its exact oracle. */
export function assertEveryLayaMutationExecuted(
  mutations: readonly LayaMutation[],
  executed: ReadonlySet<string>,
  platformSkipped: ReadonlyMap<string, LayaMutationPlatformSkip> = new Map(),
): void {
  for (const [id, skip] of platformSkipped) {
    const mutation = mutations.find((candidate) => candidate.id === id);
    if (mutation === undefined) throw new Error(`runner platform-skipped an unregistered production mutant: ${id}`);
    if (executed.has(id)) throw new Error(`registered production mutant was both platform-skipped and executed: ${id}`);
    if (!isAllowedLayaMutationPlatformSkip(mutation, skip)) {
      throw new Error(`registered production mutant has an unapproved platform skip: ${id}`);
    }
  }
  // A Windows-skipped row is accounted for above; every other registered row must have run.
  assertExactlyExecuted(
    mutations.filter((mutation) => !platformSkipped.has(mutation.id)),
    executed,
  );
}

/** Copies one production module, proves its oracle first, then makes one exact destructive edit. */
export async function expectLayaMutationToFail(mutation: LayaMutation): Promise<LayaMutationExecution> {
  const root = await mkdtemp(join(tmpdir(), `events-e2-mutant-${mutation.id}-`));
  try {
    await copyFixtureTree(root, mutation);
    const baseline = await runNamedOracle(root, mutation);
    const platformSkip = { platform: process.platform, baselineOutput: baseline.output } as const;
    if (hasTapSkip(baseline.output)) {
      if (isAllowedLayaMutationPlatformSkip(mutation, platformSkip)) {
        return { changedLine: null, baselineOutput: baseline.output, mutantOutput: null, platformSkipped: true };
      }
      throw new Error(`${mutation.id}: unapproved platform skip in copied-tree baseline\n${baseline.output}`);
    }
    assert.equal(
      baseline.code,
      0,
      `${mutation.id}: unmutated copied-tree oracle must pass before a mutation can be credited\n${baseline.output}`,
    );
    assert.match(
      baseline.output,
      /^# tests 1$/m,
      `${mutation.id}: unmutated copied tree must run exactly its named test\n${baseline.output.slice(-2000)}`,
    );
    assert.match(
      baseline.output,
      /^# pass 1$/m,
      `${mutation.id}: unmutated copied-tree oracle must pass\n${baseline.output.slice(-2000)}`,
    );
    assert.match(
      baseline.output,
      /^# fail 0$/m,
      `${mutation.id}: unmutated copied-tree oracle must not fail\n${baseline.output.slice(-2000)}`,
    );
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(repositoryRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const result = await runNamedOracle(root, mutation);
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
    return { changedLine, baselineOutput: baseline.output, mutantOutput: result.output, platformSkipped: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** Runs every task fragment's production mutations and confirms none was skipped. */
export async function expectEveryLayaMutationToFail(): Promise<
  readonly ({ readonly mutation: LayaMutation } & LayaMutationExecution)[]
> {
  const mutations = await loadLayaMutations();
  const executed = new Set<string>();
  const platformSkipped = new Map<string, LayaMutationPlatformSkip>();
  const results: ({ readonly mutation: LayaMutation } & LayaMutationExecution)[] = [];
  for (const mutation of mutations) {
    const execution = await expectLayaMutationToFail(mutation);
    if (execution.platformSkipped) {
      platformSkipped.set(mutation.id, { platform: process.platform, baselineOutput: execution.baselineOutput });
    } else {
      executed.add(mutation.id);
    }
    results.push({ mutation, ...execution });
  }
  assertEveryLayaMutationExecuted(mutations, executed, platformSkipped);
  return results;
}
