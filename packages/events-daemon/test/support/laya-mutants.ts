import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { WINDOWS_SKIP_REASON } from './short-temp.ts';
import { runStrictMutationChild, type StrictMutationChildResult } from './strict-mutation-child.ts';

/**
 * Where a registered mutation's named oracle runs, each under the same strict rule (only the named test, run and
 * failed, kills; its unmutated copy must pass it alone):
 * - `node`: a `node:test` file, by `--test-name-pattern`, with TAP read back. The default, and every fragment before
 *   Task 11's.
 * - `vitest`: one of the desktop app's Vitest files (E2 Task 11), by `vitest run -t`, with its JSON report read back.
 *   Its name is the test's path as Vitest matches `-t` against it: each `describe` title, then the test's, joined by
 *   ` > `.
 * - `cargo`: one of the desktop app's Rust unit tests (E2 Task 11), by `cargo test --lib <path> -- --exact`, with its
 *   summary read back. `pnpm verify` builds no Rust, so `desktop.yml` runs this leg (`run-laya-mutants.ts --leg cargo`).
 */
export const LAYA_MUTATION_LEGS: readonly ['node', 'vitest', 'cargo'] = Object.freeze([
  'node',
  'vitest',
  'cargo',
] as const);
export type LayaMutationLeg = (typeof LAYA_MUTATION_LEGS)[number];
/** The legs the daemon suite's runner executes, inside `pnpm verify`; `desktop.yml` executes the rest. */
export const VERIFY_MUTATION_LEGS: readonly LayaMutationLeg[] = Object.freeze(['node', 'vitest'] as const);
/** The only command that executes the legs `pnpm verify` does not: `desktop.yml` must run it as written. */
export const CARGO_LEG_COMMAND =
  'node --experimental-strip-types --disable-warning=ExperimentalWarning packages/events-daemon/test/support/run-laya-mutants.ts --leg cargo';

/** A fragment's `leg`, or `node` when it names none; anything else is refused, so no registered mutation is unrun. */
export function layaMutationLeg(value: unknown, what: string): LayaMutationLeg {
  if (value === undefined) return 'node';
  if (typeof value === 'string' && (LAYA_MUTATION_LEGS as readonly string[]).includes(value))
    return value as LayaMutationLeg;
  throw new Error(`${what} must be one of ${LAYA_MUTATION_LEGS.join(', ')}`);
}

export interface LayaMutation {
  readonly id: string;
  readonly kind: 'production';
  readonly leg: LayaMutationLeg;
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
  /** The exact named oracle's output before the source mutation: TAP on the node leg, the child's own on the others. */
  readonly baselineOutput: string;
  /** The exact named oracle's output after the source mutation, in the same form. */
  readonly mutantOutput: string | null;
  readonly platformSkipped: boolean;
}

export interface LayaMutationPlatformSkip {
  readonly platform: NodeJS.Platform;
  readonly baselineOutput: string;
}

/** A hung child is a runner failure, never mutant evidence; the bound only has to outlast one named oracle. */
const MUTATION_CHILD_TIMEOUT_MS = 120_000;
/** A cargo child first builds the copied crate (its dependencies are shared, already built): a slower bound. */
const CARGO_CHILD_TIMEOUT_MS = 1_200_000;
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
            leg: layaMutationLeg(mutation.leg, `task-${task}.json mutation ${index}.leg`),
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
  // A test spawns these entries rather than importing them, so their own relative imports are copied too: the shipped
  // worker's probe, protocol, runtime adapter and templates, and the stand-in's protocol.
  for (const entry of [
    'packages/events-daemon/src/runtime/laya/worker-main.ts',
    'packages/events-daemon/test/support/laya-worker-standin.ts',
  ])
    await copyDependencyClosure(root, entry);
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

/** Copies one production module, proves its named oracle first, then makes one exact destructive edit, in its leg. */
export async function expectLayaMutationToFail(mutation: LayaMutation): Promise<LayaMutationExecution> {
  switch (mutation.leg) {
    case 'node':
      return expectNodeMutationToFail(mutation);
    case 'vitest':
      return expectVitestMutationToFail(mutation);
    case 'cargo':
      return expectCargoMutationToFail(mutation);
  }
}

/** Copies one production module, proves its named sealed oracle first, then makes one exact destructive edit. */
async function expectNodeMutationToFail(mutation: LayaMutation): Promise<LayaMutationExecution> {
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

/** The desktop app's folders a copy never takes: what its tools install, build or write. */
const DESKTOP_SKIPPED = new Set(['node_modules', 'dist', 'target', 'gen', 'test-results', 'playwright-report']);

/**
 * The desktop app, without what its tools install or write, and the events daemon's contract it reads, below `root`.
 * `dist/` is the one exception the cargo leg asks for: Tauri's context embeds the built UI, so a crate without it does
 * not build. Its installed modules are linked, as the node leg's are.
 */
async function copyDesktopTree(root: string, options: { readonly dist: boolean }): Promise<string> {
  const app = join(repositoryRoot, 'apps/desktop');
  const copied = join(root, 'apps/desktop');
  await cp(app, copied, {
    recursive: true,
    filter: (source) =>
      relative(app, source)
        .split(/[\\/]/u)
        .every((part) => !DESKTOP_SKIPPED.has(part)),
  });
  if (options.dist) await cp(join(app, 'dist'), join(copied, 'dist'), { recursive: true });
  await copyFile(root, 'packages/events-daemon/test/fixtures/judges/desktop-contract-v1.json');
  return copied;
}

async function linkDesktopModules(root: string): Promise<void> {
  for (const directory of ['', 'apps/desktop']) {
    const installed = join(repositoryRoot, directory, 'node_modules');
    const modules = await stat(installed).catch(() => undefined);
    if (!modules?.isDirectory()) throw new Error(`the Vitest leg needs the installed ${directory || 'root'} modules`);
    await symlink(installed, join(root, directory, 'node_modules'), 'dir');
  }
}

/** One assertion of Vitest's JSON report. */
interface VitestAssertion {
  readonly ancestorTitles: readonly string[];
  readonly title: string;
  readonly status: string;
}

/** A test's path as Vitest matches `-t` against it (its report's `fullName` joins the same titles with spaces). */
const vitestPath = (assertion: VitestAssertion): string => [...assertion.ancestorTitles, assertion.title].join(' > ');

/** What one Vitest run reported: every test that ran (passed or failed), and how many files failed to run. */
async function vitestReport(
  mutation: LayaMutation,
  path: string,
): Promise<{ readonly ran: readonly VitestAssertion[]; readonly failedFiles: number }> {
  const text = await readFile(path, 'utf8').catch(() => undefined);
  if (text === undefined) throw new Error(`${mutation.id}: Vitest wrote no report, so nothing is evidence`);
  const report = JSON.parse(text) as {
    readonly testResults?: readonly {
      readonly status?: string;
      readonly assertionResults?: readonly VitestAssertion[];
    }[];
  };
  const files = report.testResults ?? [];
  return {
    ran: files
      .flatMap((file) => file.assertionResults ?? [])
      .filter((assertion) => assertion.status === 'passed' || assertion.status === 'failed'),
    failedFiles: files.filter((file) => file.status === 'failed' && (file.assertionResults ?? []).length === 0).length,
  };
}

/**
 * The Vitest leg: the desktop app copied, one exact edit, and only the named test run (`-t` anchored to its full name).
 * Its JSON report, not the exit code, decides: the unmutated copy ran exactly that test and it passed; the mutant ran
 * exactly that test and it failed. A file that fails to load reports no test at all, so it is never a kill.
 */
async function expectVitestMutationToFail(mutation: LayaMutation): Promise<LayaMutationExecution> {
  const root = await mkdtemp(join(tmpdir(), `events-e2-vitest-${mutation.id}-`));
  try {
    const app = await copyDesktopTree(root, { dist: false });
    await linkDesktopModules(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${mutation.source}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const report = join(root, 'vitest-report.json');
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const run = async () => {
      await rm(report, { force: true });
      const result = await runStrictMutationChild({
        command: process.execPath,
        args: [
          join(app, 'node_modules', 'vitest', 'vitest.mjs'),
          'run',
          relative(join(repositoryRoot, 'apps/desktop'), join(repositoryRoot, mutation.testFile)),
          '-t',
          exactTestName(mutation.testName),
          '--reporter=json',
          `--outputFile=${report}`,
        ],
        cwd: app,
        env: environment,
        timeoutMs: MUTATION_CHILD_TIMEOUT_MS,
      });
      return { result, ...(await vitestReport(mutation, report)) };
    };
    const baseline = await run();
    const tail = (output: string) => output.slice(-2000);
    assert.equal(
      baseline.result.code,
      0,
      `${mutation.id}: the unmutated copy did not pass ${mutation.testName}\n${tail(baseline.result.output)}`,
    );
    assert.deepEqual(
      baseline.ran.map((assertion) => [vitestPath(assertion), assertion.status]),
      [[mutation.testName, 'passed']],
      `${mutation.id}: the unmutated copy did not run exactly its named test, and pass it\n${tail(baseline.result.output)}`,
    );
    assert.equal(baseline.failedFiles, 0, `${mutation.id}: the baseline reported no file failure`);
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const mutant = await run();
    assert.notEqual(
      mutant.result.code,
      0,
      `${mutation.id}: ${mutation.testName} unexpectedly accepted mutant ${mutation.source}:${changedLine}\n${tail(mutant.result.output)}`,
    );
    assert.deepEqual(
      mutant.ran.map((assertion) => [vitestPath(assertion), assertion.status]),
      [[mutation.testName, 'failed']],
      `${mutation.id}: its named test, not the file, failed\n${tail(mutant.result.output)}`,
    );
    return {
      changedLine,
      baselineOutput: baseline.result.output,
      mutantOutput: mutant.result.output,
      platformSkipped: false,
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/** What `cargo test` printed for the lib's unit tests: the named test's result line and the summary. */
function cargoResult(
  output: string,
  name: string,
): { readonly verdict: string | null; readonly summary: string | null } {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const verdicts = [...output.matchAll(new RegExp(`^test ${escaped} \\.\\.\\. (ok|FAILED)$`, 'gmu'))].map(
    (match) => match[1],
  );
  const summaries = [...output.matchAll(/^test result: (?:ok|FAILED)\. (\d+ passed; \d+ failed); /gmu)].map(
    (match) => match[1],
  );
  const running = [...output.matchAll(/^running (\d+) tests?$/gmu)].map((match) => match[1]);
  return {
    verdict: verdicts.length === 1 && running.length === 1 && running[0] === '1' ? (verdicts[0] ?? null) : null,
    summary: summaries.length === 1 ? (summaries[0] ?? null) : null,
  };
}

/**
 * The cargo leg: the desktop app's crate copied (its built UI with it, which Tauri's context embeds), one exact edit,
 * and only the named unit test run (`cargo test --lib <module path> -- --exact`), its dependencies taken from the
 * checkout's own target folder. The unmutated copy must run exactly that test and pass it; the mutant must build, run
 * exactly that test and fail it. A copy that does not build runs no test, so it is never a kill.
 */
async function expectCargoMutationToFail(mutation: LayaMutation): Promise<LayaMutationExecution> {
  const root = await mkdtemp(join(tmpdir(), `events-e2-cargo-${mutation.id}-`));
  try {
    const app = await copyDesktopTree(root, { dist: true });
    const crate = join(app, 'src-tauri');
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(
      occurrences(original, mutation.before),
      1,
      `${mutation.id}: guarded production text must match exactly once in ${mutation.source}`,
    );
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const run = () =>
      runStrictMutationChild({
        command: 'cargo',
        args: ['test', '--locked', '--offline', '--lib', mutation.testName, '--', '--exact'],
        cwd: crate,
        env: { ...process.env, CARGO_TARGET_DIR: join(repositoryRoot, 'apps/desktop/src-tauri/target') },
        timeoutMs: CARGO_CHILD_TIMEOUT_MS,
      });
    const tail = (output: string) => output.slice(-3000);
    const baseline = await run();
    assert.equal(
      baseline.code,
      0,
      `${mutation.id}: the unmutated copy did not pass ${mutation.testName}\n${tail(baseline.output)}`,
    );
    assert.deepEqual(
      cargoResult(baseline.output, mutation.testName),
      { verdict: 'ok', summary: '1 passed; 0 failed' },
      `${mutation.id}: the unmutated copy did not run exactly its named test, and pass it\n${tail(baseline.output)}`,
    );
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const mutant = await run();
    assert.notEqual(
      mutant.code,
      0,
      `${mutation.id}: ${mutation.testName} unexpectedly accepted mutant ${mutation.source}:${changedLine}\n${tail(mutant.output)}`,
    );
    assert.deepEqual(
      cargoResult(mutant.output, mutation.testName),
      { verdict: 'FAILED', summary: '0 passed; 1 failed' },
      `${mutation.id}: its named test, not the build, failed\n${tail(mutant.output)}`,
    );
    return { changedLine, baselineOutput: baseline.output, mutantOutput: mutant.output, platformSkipped: false };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

/**
 * Runs every task fragment's production mutations in `legs` (by default the legs `pnpm verify` runs) and confirms
 * none was skipped there; every registered mutation names a leg, and the other legs' runner confirms its own.
 */
export async function expectEveryLayaMutationToFail(
  options: { readonly legs?: readonly LayaMutationLeg[] } = {},
): Promise<readonly ({ readonly mutation: LayaMutation } & LayaMutationExecution)[]> {
  const legs = options.legs ?? VERIFY_MUTATION_LEGS;
  const mutations = (await loadLayaMutations()).filter((mutation) => legs.includes(mutation.leg));
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
