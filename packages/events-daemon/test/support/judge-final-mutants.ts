import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeFinalMutation {
  readonly id: string;
  readonly source: string;
  readonly before: string;
  readonly after: string;
  readonly test: string;
  readonly testName: string;
  readonly killingAssertion: string;
}

/** Task 13's final ship gates, each removed once and owned by one exact production-path assertion. */
export const JUDGE_FINAL_MUTATIONS: readonly JudgeFinalMutation[] = [
  {
    id: 'e13-required-release-gate',
    source: 'scripts/release.mjs',
    before: "await requirePhaseEGate('Phase-E prerequisite gate', verifyPhaseEPrerequisites);",
    after: 'void verifyPhaseEPrerequisites;',
    test: 'packages/events-daemon/test/judge-final-release.test.ts',
    testName: 'E13 final release: verify and direct release retain both Phase-E gates',
    killingAssertion: 'no release tool runs before the gate refuses',
  },
  {
    id: 'e13-b3-capability-row',
    source: 'capabilities.json',
    before: 'events-daemon.judge-key.rotate',
    after: 'events-daemon.judge-key.removed-by-e13-mutant',
    test: 'packages/events-daemon/test/judge-final-release.test.ts',
    testName: 'E13 final release: the positive B3 tree passes and B3 drift refuses verify and release before preflight',
    killingAssertion: 'the integrated positive B3 tree satisfies the Phase-E prerequisite gate without a Phase-C join',
  },
  {
    id: 'e13-doctor-hold-clock',
    source: 'packages/events-daemon/src/runtime/b3-doctor-projection.ts',
    before: 'oldestCreatedAt: holdClocks.oldest_created_at,',
    after: '',
    test: 'packages/events-daemon/test/judge-final-e2e.test.ts',
    testName:
      'E13 final doctor reports kind, budget, reservations, hold clocks, a missing key and typed Laya unavailability',
    killingAssertion: 'doctor exposes the content-free hold count and retention clock',
  },
  {
    id: 'e13-laya-typed-unavailable',
    source: 'packages/events-daemon/src/runtime/b3-doctor-projection.ts',
    // Task 12's fix names the kind through the canonical registry constant; the mutant still drops the typed code.
    before: "      return { kind: JUDGE_KIND_LAYA, state: 'unavailable' as const, code: 'E2_REQUIRED' as const };",
    after: "      return { kind: JUDGE_KIND_LAYA, state: 'unavailable' as const };",
    test: 'packages/events-daemon/test/judge-final-e2e.test.ts',
    testName:
      'E13 final doctor reports kind, budget, reservations, hold clocks, a missing key and typed Laya unavailability',
    killingAssertion: 'doctor exposes the exact kind pointer state and typed Laya E2 boundary',
  },
  {
    id: 'e13-kind-enablement-approval',
    source: 'packages/events-daemon/src/domain/versions.ts',
    before: "    return this.insert('judge_kind_versions', 'judge-kind', document.kind, document.version, document);",
    after: `    const created = this.insert('judge_kind_versions', 'judge-kind', document.kind, document.version, document);
    this.#database
      .prepare(
        "INSERT OR REPLACE INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', ?, ?, NULL, 1)",
      )
      .run(document.kind, document.version);
    return created;`,
    test: 'packages/events-daemon/test/judge-final-e2e.test.ts',
    testName:
      'E13 release gate: every judge kind remains unusable until a person-approved enablement creates its pointer',
    killingAssertion: 'cannot be used before an approved enablement writes its active pointer',
  },
  {
    id: 'e13-owner-judge-wiring',
    source: 'packages/events-daemon/src/runtime/scheduler.ts',
    before: '      admit: (occurrence) => evaluator.admitGmailOccurrence(occurrence),',
    after: "      admit: async () => 'terminal',",
    test: 'packages/events-daemon/test/judge-final-e2e.test.ts',
    testName:
      'E13 final owner E2E: Gmail source reaches a local judge match through control approvals and owner restart',
    killingAssertion: 'the owner-level match reaches the production judge coordinator exactly once',
  },
];

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function namedTap(output: string, state: 'ok' | 'not ok', name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${state} \\d+ - ${escaped}(?:\\s|$)`, 'mu').test(output);
}

function tapSummary(output: string, label: 'tests' | 'pass' | 'fail', value: number): boolean {
  return new RegExp(`^# ${label} ${value}\\s*$`, 'mu').test(output);
}

async function copyMutationTree(root: string): Promise<void> {
  const copiedPackage = join(root, 'packages/events-daemon');
  const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';
  await Promise.all([
    mkdir(copiedPackage, { recursive: true }),
    mkdir(join(root, 'packages/events'), { recursive: true }),
    mkdir(join(root, 'packages/gmail/test/support'), { recursive: true }),
    mkdir(join(root, 'test'), { recursive: true }),
  ]);
  await Promise.all([
    cp(join(packageRoot, 'src'), join(copiedPackage, 'src'), { recursive: true }),
    cp(join(packageRoot, 'test'), join(copiedPackage, 'test'), { recursive: true }),
    cp(join(packageRoot, 'package.json'), join(copiedPackage, 'package.json')),
    cp(join(repositoryRoot, 'packages/events/package.json'), join(root, 'packages/events/package.json')),
    cp(join(repositoryRoot, 'packages/gmail/src'), join(root, 'packages/gmail/src'), { recursive: true }),
    cp(
      join(repositoryRoot, 'packages/gmail/test/support/fake-google.ts'),
      join(root, 'packages/gmail/test/support/fake-google.ts'),
    ),
    cp(join(repositoryRoot, 'packages/gmail/package.json'), join(root, 'packages/gmail/package.json')),
    cp(join(repositoryRoot, 'scripts'), join(root, 'scripts'), { recursive: true }),
    cp(join(repositoryRoot, 'test/helpers'), join(root, 'test/helpers'), { recursive: true }),
    cp(join(repositoryRoot, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
    cp(join(repositoryRoot, 'pnpm-lock.yaml'), join(root, 'pnpm-lock.yaml')),
  ]);
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), directoryLinkType);
  await symlink(join(packageRoot, 'node_modules'), join(copiedPackage, 'node_modules'), directoryLinkType);
  await symlink(
    join(repositoryRoot, 'packages/gmail/node_modules'),
    join(root, 'packages/gmail/node_modules'),
    directoryLinkType,
  );
}

function assertOneNamedResult(
  mutation: JudgeFinalMutation,
  result: { readonly code: number | null; readonly output: string },
  expected: 'pass' | 'fail',
): void {
  const passing = expected === 'pass';
  assert.equal(
    result.code === 0,
    passing,
    `${mutation.id}: ${passing ? 'baseline did not pass' : 'mutant unexpectedly passed'}\n${result.output}`,
  );
  assert.equal(
    namedTap(result.output, passing ? 'ok' : 'not ok', mutation.testName),
    true,
    `${mutation.id}: a different test produced the TAP result\n${result.output}`,
  );
  assert.equal(tapSummary(result.output, 'tests', 1), true, `${mutation.id}: exactly one named test must run`);
  assert.equal(tapSummary(result.output, 'pass', passing ? 1 : 0), true, `${mutation.id}: TAP pass count is exact`);
  assert.equal(tapSummary(result.output, 'fail', passing ? 0 : 1), true, `${mutation.id}: TAP fail count is exact`);
  if (!passing)
    assert.equal(
      result.output.includes(mutation.killingAssertion),
      true,
      `${mutation.id}: the named killing assertion did not reject the mutant\n${result.output}`,
    );
}

/** Copies every named-test input, proves that baseline, applies one edit, then accepts only its exact TAP failure. */
export async function expectJudgeFinalMutationToFail(mutation: JudgeFinalMutation): Promise<void> {
  const mutationRoot = join(mutantsRoot, mutation.id);
  const root = join(mutationRoot, 'tree');
  try {
    await rm(mutationRoot, { recursive: true, force: true });
    await copyMutationTree(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(occurrences(original, mutation.before), 1, `${mutation.id}: mutation source matches exactly once`);
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const args = [
      '--import',
      pathToFileURL(join(root, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, mutation.test),
    ];
    const baseline = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 60_000,
    });
    assertOneNamedResult(mutation, baseline, 'pass');

    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const result = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 60_000,
    });
    assertOneNamedResult(mutation, result, 'fail');
  } finally {
    await rm(mutationRoot, { recursive: true, force: true });
  }
}
