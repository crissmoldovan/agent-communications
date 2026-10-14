import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeAdversarialMutation {
  readonly id: string;
  readonly source: string;
  readonly before: string;
  readonly after: string;
  readonly test: string;
  readonly testName: string;
  readonly killingAssertion: string;
}

/** Task 11's production and manifest regressions each have one executable corpus or integrity oracle. */
export const JUDGE_ADVERSARIAL_MUTATIONS: readonly JudgeAdversarialMutation[] = [
  {
    id: 'e11-provider-match-authority',
    source: 'packages/events-daemon/src/runtime/judge-adapters.ts',
    before: `if (!exactObject(answer, ['type', 'noul']) || answer.type !== 'noul') return refusal('MALFORMED_RESPONSE');
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.usage, ['input_tokens', 'output_tokens'])) return refusal('MALFORMED_RESPONSE');
  if (!nonNegativeInteger(parsed.usage.input_tokens) || !nonNegativeInteger(parsed.usage.output_tokens))
    return refusal('MALFORMED_RESPONSE');
  if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  const usage = knownNoulUsage(parsed.usage, input.maxOutputTokens);
  if (usage === null) return refusal('MALFORMED_RESPONSE');
  return { kind: 'answer', value: answer.noul, valueLabel: 'probability', usage };`,
    after: `if (
    (!exactObject(answer, ['type', 'noul']) && !exactObject(answer, ['type', 'noul', 'match'])) ||
    answer.type !== 'noul'
  )
    return refusal('MALFORMED_RESPONSE');
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.usage, ['input_tokens', 'output_tokens'])) return refusal('MALFORMED_RESPONSE');
  if (!nonNegativeInteger(parsed.usage.input_tokens) || !nonNegativeInteger(parsed.usage.output_tokens))
    return refusal('MALFORMED_RESPONSE');
  if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  const usage = knownNoulUsage(parsed.usage, input.maxOutputTokens);
  if (usage === null) return refusal('MALFORMED_RESPONSE');
  return { kind: 'answer', value: answer.match === true ? 1 : answer.noul, valueLabel: 'probability', usage };`,
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'provider-match-low-score-refusal: durable decision outcome',
  },
  {
    id: 'e11-envelope-provenance',
    source: 'packages/events-daemon/src/runtime/judge-coordinator.ts',
    before: 'inputs: inputs.map((pointer) => ({ pointer, value: { $path: pointer } })),',
    after:
      "inputs: inputs.map((pointer) => ({ pointer, value: pointer === '/from' ? '[synthetic-redacted]' : { $path: pointer } })),",
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'exact-input-provenance: copied object provenance remains in the exact input envelope',
  },
  {
    id: 'e11-range-token-cap',
    source: 'packages/events-daemon/src/runtime/judge-adapters.ts',
    before:
      "if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)",
    after: "if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul))",
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'range-score-refusal: durable decision outcome',
  },
  {
    id: 'e11-wrong-type-score',
    source: 'packages/events-daemon/src/runtime/judge-adapters.ts',
    before: `if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');`,
    after: `const coercedNoul = Number(answer.noul);
  if (!Number.isFinite(coercedNoul) || coercedNoul < 0 || coercedNoul > 1)
    return refusal('MALFORMED_RESPONSE');
  answer.noul = coercedNoul;`,
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'wrong-type-score-refusal: provider response acceptance',
  },
  {
    id: 'e11-host-drift-before-byte',
    source: 'packages/events-daemon/src/runtime/judge-budget.ts',
    before: '    assertJudgeReservationStillInFlight({',
    after: '    ((_: unknown): void => undefined)({',
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'host-drift-write-fence-refusal: sealed network journal write count',
  },
  {
    id: 'e11-journal-exactness',
    source: 'packages/events-daemon/src/runtime/judge-transport.ts',
    before: 'socket.write(request);',
    after: "socket.write(Buffer.concat([request, Buffer.from(' ')]));",
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'provider-match-is-not-authority: every sealed journal request byte is fixture-pinned and exact',
  },
  {
    id: 'e11-refusal-content-free',
    source: 'packages/events-daemon/src/runtime/judge-adapters.ts',
    before: `if (!exactObject(answer, ['type', 'noul']) || answer.type !== 'noul') return refusal('MALFORMED_RESPONSE');
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.usage, ['input_tokens', 'output_tokens'])) return refusal('MALFORMED_RESPONSE');
  if (!nonNegativeInteger(parsed.usage.input_tokens) || !nonNegativeInteger(parsed.usage.output_tokens))
    return refusal('MALFORMED_RESPONSE');
  if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  const usage = knownNoulUsage(parsed.usage, input.maxOutputTokens);
  if (usage === null) return refusal('MALFORMED_RESPONSE');
  return { kind: 'answer', value: answer.noul, valueLabel: 'probability', usage };`,
    after: `if (
    (!exactObject(answer, ['type', 'noul']) && !exactObject(answer, ['type', 'noul', 'tool'])) ||
    answer.type !== 'noul'
  )
    return refusal('MALFORMED_RESPONSE');
  if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');
  if (!exactObject(parsed.usage, ['input_tokens', 'output_tokens'])) return refusal('MALFORMED_RESPONSE');
  if (!nonNegativeInteger(parsed.usage.input_tokens) || !nonNegativeInteger(parsed.usage.output_tokens))
    return refusal('MALFORMED_RESPONSE');
  if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');
  const usage = knownNoulUsage(parsed.usage, input.maxOutputTokens);
  if (usage === null) return refusal('MALFORMED_RESPONSE');
  return {
    kind: 'answer',
    value: answer.noul,
    valueLabel: (answer.tool === 'synthetic-tool' ? answer.tool : 'probability') as 'probability',
    usage,
  };`,
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'provider-tool-refusal: refusal retains no encrypted provider metadata',
  },
  {
    id: 'e11-late-hold-response',
    source: 'packages/events-daemon/src/runtime/expiry.ts',
    before: `for (const work of expiringJudgeWork)
        judgePurge.event({
          source: work.source,
          accountId: work.account_id,
          eventId: work.event_id,
          ruleId: work.rule_id,
          ruleVersion: work.rule_version,
        });`,
    after: `void judgePurge;
      void expiringJudgeWork;`,
    test: 'packages/events-daemon/test/judge-adversarial-corpus.test.ts',
    testName:
      'E11 adversarial corpus: every synthetic row asserts its sealed transport boundary and fixture-pinned journal bytes',
    killingAssertion: 'late-response-after-expiry: durable decision outcome',
  },
  {
    id: 'e11-corpus-integrity-allowlist',
    source: 'scripts/verify-events-adversarial-corpus.mjs',
    before: `return (
    allowedAddress(normalised, allowLoopback) || SYNTHETIC_HOST_SUFFIXES.some((suffix) => normalised.endsWith(suffix))
  );`,
    after: 'return true;',
    test: 'packages/events-daemon/test/judge-corpus-integrity.test.ts',
    testName:
      'E11 adversarial corpus integrity: an unrecognised host, key-shaped token, and captured-provider response each fail the allowlist scan',
    killingAssertion: 'a non-allowlisted literal URL is refused',
  },
  {
    id: 'e11-response-fixture-pinning',
    source: 'scripts/verify-events-adversarial-corpus.mjs',
    before: `assert.deepEqual(
    Object.keys(responses).sort(),
    [...expectedKinds].sort(),
    \`\${file}: scripted response inventory is exact\`,
  );`,
    after: `void responses;
  void expectedKinds;
  void file;`,
    test: 'packages/events-daemon/test/judge-corpus-integrity.test.ts',
    testName: 'E11 adversarial corpus integrity: a missing scripted response fails the exact response inventory',
    killingAssertion: 'a missing scripted response is refused',
  },
  {
    id: 'e11-corpus-manifest-pairing',
    source: 'packages/events-daemon/test/fixtures/judges/case-manifest.json',
    before: `,
    {
      "id": "e11-corpus-manifest-pairing",
      "task": "E11",
      "coverage": ["e11-corpus-manifest-pairing"],
      "productionEntry": "scripts/verify-events-phase-e-tests.mjs",
      "test": "packages/events-daemon/test/judge-corpus-integrity.test.ts",
      "mutation": {
        "id": "e11-corpus-manifest-pairing",
        "test": "E11 adversarial corpus integrity: every row, digest, journal and shared manifest pairing is synthetic and exact"
      },
      "strictRunner": "judge-adversarial-mutants"
    }`,
    after: '',
    test: 'packages/events-daemon/test/judge-corpus-integrity.test.ts',
    testName:
      'E11 adversarial corpus integrity: every row, digest, journal and shared manifest pairing is synthetic and exact',
    killingAssertion: 'all eleven Task 11 destructive mutations have shared-manifest owners',
  },
];

const JUDGE_ADVERSARIAL_MUTATION_TIMEOUT_MS = 180_000;

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

function summary(output: string, label: 'tests' | 'pass' | 'fail'): number {
  const matches = [...output.matchAll(new RegExp(`^# ${label} (\\d+)$`, 'gmu'))];
  assert.equal(matches.length, 1, `strict child emitted one TAP ${label} summary\n${output}`);
  return Number(matches[0]?.[1]);
}

async function copyClosure(root: string): Promise<void> {
  const copiedPackage = join(root, 'packages', 'events-daemon');
  await mkdir(copiedPackage, { recursive: true });
  await Promise.all([
    cp(join(packageRoot, 'src'), join(copiedPackage, 'src'), { recursive: true }),
    cp(join(packageRoot, 'test'), join(copiedPackage, 'test'), { recursive: true }),
    cp(join(packageRoot, 'package.json'), join(copiedPackage, 'package.json')),
    cp(join(packageRoot, 'tsconfig.json'), join(copiedPackage, 'tsconfig.json')),
    cp(join(repositoryRoot, 'scripts'), join(root, 'scripts'), { recursive: true }),
    cp(join(repositoryRoot, 'test', 'helpers'), join(root, 'test', 'helpers'), { recursive: true }),
    cp(join(repositoryRoot, 'capabilities.json'), join(root, 'capabilities.json')),
    cp(join(repositoryRoot, 'package.json'), join(root, 'package.json')),
    cp(join(repositoryRoot, 'tsconfig.base.json'), join(root, 'tsconfig.base.json')),
  ]);
  await symlink(join(repositoryRoot, 'node_modules'), join(root, 'node_modules'), 'dir');
  await symlink(join(packageRoot, 'node_modules'), join(copiedPackage, 'node_modules'), 'dir').catch((error) => {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  });
}

function assertNamedFailure(
  mutation: JudgeAdversarialMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.notEqual(result.code, 0, `${mutation.id}: named oracle unexpectedly accepted its mutant\n${result.output}`);
  assert.equal(summary(result.output, 'tests'), 1, `${mutation.id}: child ran only its named test`);
  assert.equal(summary(result.output, 'fail'), 1, `${mutation.id}: named oracle failed exactly once`);
  const escaped = mutation.testName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  assert.deepEqual(
    [...result.output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]),
    [mutation.testName],
    `${mutation.id}: a different test ran`,
  );
  assert.match(
    result.output,
    new RegExp(`^not ok \\d+ - ${escaped}(?:\\s|$)`, 'mu'),
    `${mutation.id}: its own assertion killed it`,
  );
  assert.equal(
    result.output.includes(mutation.killingAssertion),
    true,
    `${mutation.id}: its named guard assertion killed the mutant\n${result.output}`,
  );
}

/** Runs the same copied tree first unmutated, then with exactly one source or manifest edit. */
export async function expectJudgeAdversarialMutationToFail(mutation: JudgeAdversarialMutation): Promise<void> {
  const root = join(mutantsRoot, mutation.id, 'tree');
  try {
    await rm(join(mutantsRoot, mutation.id), { recursive: true, force: true });
    await copyClosure(root);
    const target = join(root, mutation.source);
    const original = await readFile(target, 'utf8');
    assert.equal(occurrences(original, mutation.before), 1, `${mutation.id}: source matches once in copied closure`);
    const environment: NodeJS.ProcessEnv = {};
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
      timeoutMs: JUDGE_ADVERSARIAL_MUTATION_TIMEOUT_MS,
    });
    if (baseline.output.includes('EPERM')) throw new Error(`${mutation.id}: baseline is blocked by EPERM`);
    assert.equal(baseline.code, 0, `${mutation.id}: unmutated named test passes\n${baseline.output}`);
    assert.equal(summary(baseline.output, 'tests'), 1, `${mutation.id}: baseline runs only its named test`);
    assert.equal(summary(baseline.output, 'pass'), 1, `${mutation.id}: baseline test passes`);
    assert.equal(summary(baseline.output, 'fail'), 0, `${mutation.id}: baseline has no failure`);
    await writeFile(target, original.replace(mutation.before, mutation.after));
    const mutant = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: JUDGE_ADVERSARIAL_MUTATION_TIMEOUT_MS,
    });
    assertNamedFailure(mutation, mutant);
  } finally {
    await rm(join(mutantsRoot, mutation.id), { recursive: true, force: true });
  }
}
