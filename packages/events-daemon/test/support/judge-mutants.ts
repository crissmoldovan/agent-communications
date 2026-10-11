import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeMutation {
  readonly id: string;
  readonly source: string;
  readonly before: string;
  readonly after: string;
  readonly test: string;
  readonly testName: string;
}

export const PHASE_E_GATE_MUTATIONS: readonly JudgeMutation[] = [
  {
    id: 'e3-b3-contract-version',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: "export const B3_CONTROL_V1_SCHEMA_VERSION = 'b3-control-v1' as const;",
    after: "export const B3_CONTROL_V1_SCHEMA_VERSION = 'stubbed-b3-control-v1' as const;",
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-b3-unavailable-variants',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: "  { code: 'E2_REQUIRED', phase: 'E2' },",
    after: "  { code: 'E2_REQUIRED', phase: 'E' },",
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-b3-vector-schema-validation',
    source: 'packages/events-daemon/src/operations/b3-contract.ts',
    before: '!isB3DesktopControlOperation(request.operation) ||\n    !isRecord(request.args)',
    after: 'false',
    test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
    testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
  },
  {
    id: 'e3-scope-account-source',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: '      if (value === "\'source-owned\'") {',
    after: '  if (false) {',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName:
      'E3 scope: static guards reject hollow manifests, missing runners, unsealed network tests and test-local models',
  },
  {
    id: 'e3-scope-synthetic-work',
    source: 'scripts/verify-events-phase-e-tests.mjs',
    before: '      } else if (value === "\'synthetic-test\'") {',
    after: '      } else if (false) {',
    test: 'packages/events-daemon/test/judge-scope.test.ts',
    testName:
      'E3 scope: static guards reject hollow manifests, missing runners, unsealed network tests and test-local models',
  },
];

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')}$`;
}

function namedTapFailure(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^not ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'mu').test(output);
}

function namedTapPass(output: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^ok \\d+ - ${escaped}(?:\\s|$)([^\\n]*)`, 'mu').test(output);
}

function tapSummary(output: string, label: 'tests' | 'pass' | 'fail', value: number): boolean {
  return new RegExp(`^# ${label} ${value}\\s*$`, 'mu').test(output);
}

/**
 * Copy only the module/test closure used by the named E3 cases.  Test paths retain their repository shape so the
 * verifiers see the copied B3 contract and fixtures rather than the source checkout.
 */
async function copyMutationClosure(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const copiedPackage = join(root, 'packages', 'events-daemon');
  await Promise.all([
    mkdir(copiedPackage, { recursive: true }),
    mkdir(join(root, 'scripts'), { recursive: true }),
    mkdir(join(root, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(packageRoot, 'src'), join(copiedPackage, 'src'), { recursive: true }),
    cp(join(packageRoot, 'test'), join(copiedPackage, 'test'), { recursive: true }),
    cp(join(packageRoot, 'package.json'), join(copiedPackage, 'package.json')),
    cp(join(repositoryRoot, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
    cp(
      join(repositoryRoot, 'scripts', 'verify-events-phase-e-prerequisites.mjs'),
      join(root, 'scripts', 'verify-events-phase-e-prerequisites.mjs'),
    ),
    cp(
      join(repositoryRoot, 'scripts', 'verify-events-phase-e-tests.mjs'),
      join(root, 'scripts', 'verify-events-phase-e-tests.mjs'),
    ),
    cp(join(repositoryRoot, 'test', 'helpers'), join(root, 'test', 'helpers'), { recursive: true }),
  ]);
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(join(packageRoot, 'node_modules'), join(copiedPackage, 'node_modules'), 'dir').catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

/** Runs exactly one named test in a copied production closure and accepts only one TAP failure. */
export async function expectJudgeMutationToFail(mutation: JudgeMutation): Promise<void> {
  const mutationRoot = join(mutantsRoot, mutation.id);
  const root = join(mutationRoot, 'tree');
  try {
    await rm(mutationRoot, { recursive: true, force: true });
    await copyMutationClosure(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(occurrences(original, mutation.before), 1, `${mutation.id}: mutation source matches exactly once`);
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const args = [
      '--import',
      join(root, 'test/helpers/loopback-seal-preload.mjs'),
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, mutation.test),
    ];
    const baseline = await runStrictMutationChild({ command: process.execPath, args, cwd: root, env: environment });
    if (baseline.output.includes('EPERM')) throw new Error(`${mutation.id}: baseline is blocked by EPERM`);
    if (
      baseline.code !== 0 ||
      !namedTapPass(baseline.output, mutation.testName) ||
      !tapSummary(baseline.output, 'tests', 1) ||
      !tapSummary(baseline.output, 'pass', 1) ||
      !tapSummary(baseline.output, 'fail', 0)
    )
      throw new Error(`${mutation.id}: unmutated named test did not pass\n${baseline.output.slice(-2000)}`);

    await writeFile(
      target,
      `${original.replace(mutation.before, mutation.after)}\n${target.endsWith('.ts') ? `(globalThis as { readonly [key: symbol]: unknown })` : 'globalThis'}[Symbol.for('agentcomms.e3-mutant.loaded')]?.(${JSON.stringify(mutation.id)});\n`,
    );
    const observer = join(root, 'e3-mutant-observer.mjs');
    await writeFile(
      observer,
      "globalThis[Symbol.for('agentcomms.e3-mutant.loaded')] = (id) => process.stdout.write('E3_MUTANT_LOADED:' + id + '\\n');\n",
    );
    const result = await runStrictMutationChild({
      command: process.execPath,
      args: ['--import', observer, ...args],
      cwd: root,
      env: environment,
    });
    assert.ok(
      result.output.includes(`E3_MUTANT_LOADED:${mutation.id}`),
      `${mutation.id}: the copied mutant source was not loaded\n${result.output}`,
    );
    assert.notEqual(result.code, 0, `${mutation.id}: ${mutation.testName} unexpectedly accepted its mutant`);
    assert.ok(
      namedTapFailure(result.output, mutation.testName),
      `${mutation.id}: named test did not fail\n${result.output}`,
    );
    assert.ok(tapSummary(result.output, 'tests', 1), `${mutation.id}: more than one test ran\n${result.output}`);
    assert.ok(
      tapSummary(result.output, 'fail', 1),
      `${mutation.id}: named test did not fail exactly once\n${result.output}`,
    );
  } finally {
    await rm(mutationRoot, { recursive: true, force: true });
  }
}
