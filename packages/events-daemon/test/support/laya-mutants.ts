import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { WINDOWS_SKIP_REASON } from './short-temp.ts';
import { runStrictMutationChild, type StrictMutationChildResult } from './strict-mutation-child.ts';

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

/** A hung child is a runner failure, never mutant evidence; the bound only has to outlast one named oracle. */
const MUTATION_CHILD_TIMEOUT_MS = 120_000;
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
  await linkInstalledModules(root);
}

/**
 * A copied tree has no install of its own. Without these links every workspace or third-party import fails to load,
 * and node:test reports a file that fails to load as one failed test: a crash would then "kill" every mutant. Only the
 * oracle's mutable daemon source/test closure is copied; the installed modules and the sibling workspace packages keep
 * the ordinary package-manager layout, so copied source and scripts resolve the same reviewed toolchain.
 */
async function linkInstalledModules(root: string): Promise<void> {
  for (const directory of ['', 'packages/events-daemon']) {
    const installed = join(repositoryRoot, directory, 'node_modules');
    // A nested runner's own source tree links these too, so follow a link to the installed directory.
    const modules = await stat(installed).catch(() => undefined);
    if (!modules?.isDirectory())
      throw new Error(`the mutation runner needs the installed ${directory || 'root'} modules`);
    const destination = join(root, directory, 'node_modules');
    await mkdir(dirname(destination), { recursive: true });
    // 'dir' links on every platform, as the other mutation trees here: pnpm's workspace links do not resolve through
    // a Windows junction.
    await symlink(installed, destination, 'dir');
  }
  for (const packageName of ['core', 'events', 'gmail', 'resend', 'slack', 'whatsapp']) {
    await symlink(join(repositoryRoot, 'packages', packageName), join(root, 'packages', packageName), 'dir');
  }
}

function escapeExpression(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Only the declared test, by its exact name, may produce the TAP result; a load failure is reported under the file. */
function namedTapResult(output: string, state: 'ok' | 'not ok', name: string): boolean {
  return new RegExp(`^${state} \\d+ - ${escapeExpression(name)}(?:\\s|$)`, 'mu').test(output);
}

function tapCount(output: string, label: 'tests' | 'pass' | 'fail'): number | undefined {
  const values = [...output.matchAll(new RegExp(`^# ${label} (\\d+)\\s*$`, 'gmu'))].map((match) => Number(match[1]));
  return values.length === 1 ? values[0] : undefined;
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

/** What each unmutated copy's named oracle showed, for its caller: a proven pass, or an accepted Windows skip. */
const namedBaselines = new WeakMap<LayaMutation, { readonly output: string; readonly platformSkipped: boolean }>();

/**
 * The unmutated copy must pass exactly its named test, or a later failure would not be evidence about the mutant. The
 * one other baseline accepted is a skip on Windows with B1-G's exact reason: that row is accounted for, never credited.
 */
function assertNamedBaselinePasses(mutation: LayaMutation, result: StrictMutationChildResult): void {
  const tail = result.output.slice(-2000);
  if (hasTapSkip(result.output)) {
    assert.equal(
      isAllowedLayaMutationPlatformSkip(mutation, { platform: process.platform, baselineOutput: result.output }),
      true,
      `${mutation.id}: the unmutated copy reported an unapproved platform skip\n${tail}`,
    );
    namedBaselines.set(mutation, { output: result.output, platformSkipped: true });
    return;
  }
  assert.equal(result.code, 0, `${mutation.id}: the unmutated copy did not pass ${mutation.testName}\n${tail}`);
  assert.equal(
    namedTapResult(result.output, 'ok', mutation.testName),
    true,
    `${mutation.id}: the unmutated copy did not report its named test as passing\n${tail}`,
  );
  assert.equal(tapCount(result.output, 'tests'), 1, `${mutation.id}: the baseline ran exactly its named test\n${tail}`);
  assert.equal(tapCount(result.output, 'pass'), 1, `${mutation.id}: the baseline passed exactly once\n${tail}`);
  assert.equal(tapCount(result.output, 'fail'), 0, `${mutation.id}: the baseline reported no failure\n${tail}`);
  namedBaselines.set(mutation, { output: result.output, platformSkipped: false });
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
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${relative(repositoryRoot, target)}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const child = {
      command: process.execPath,
      args: [
        '--import',
        join(root, 'test/helpers/loopback-seal-preload.mjs'),
        '--experimental-strip-types',
        '--disable-warning=ExperimentalWarning',
        '--test',
        // The strict kill rule reads TAP's summary; Node 24 defaults to the spec reporter when piped.
        '--test-reporter=tap',
        '--test-name-pattern',
        exactTestName(mutation.testName),
        join(root, mutation.testFile),
      ],
      cwd: root,
      env: environment,
      timeoutMs: MUTATION_CHILD_TIMEOUT_MS,
    };
    namedBaselines.delete(mutation);
    assertNamedBaselinePasses(mutation, await runStrictMutationChild(child));
    // Recorded by the proof above; it is missing only if that proof was removed, which the runner self-tests refuse.
    const baseline = namedBaselines.get(mutation) ?? { output: '', platformSkipped: false };
    if (baseline.platformSkipped) {
      return { changedLine: null, baselineOutput: baseline.output, mutantOutput: null, platformSkipped: true };
    }
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const result = await runStrictMutationChild(child);
    assert.notEqual(
      result.code,
      0,
      `${mutation.id}: ${mutation.testName} unexpectedly accepted mutant ${mutation.source}:${changedLine}\n${result.output}`,
    );
    // A copy that crashes before its oracle runs also exits non-zero, and node:test reports that under the file's
    // name: only the named test, run and failed, kills a mutant.
    assert.equal(
      namedTapResult(result.output, 'not ok', mutation.testName),
      true,
      `${mutation.id}: its named test, not the file, failed\n${result.output.slice(-2000)}`,
    );
    assert.equal(
      tapCount(result.output, 'tests'),
      1,
      `${mutation.id}: exactly its named test ran\n${result.output.slice(-2000)}`,
    );
    assert.equal(
      tapCount(result.output, 'fail'),
      1,
      `${mutation.id}: its named test failed\n${result.output.slice(-2000)}`,
    );
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
