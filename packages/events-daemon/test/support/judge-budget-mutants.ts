import assert from 'node:assert/strict';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runStrictMutationChild } from './strict-mutation-child.ts';

export interface JudgeBudgetMutation {
  readonly id: string;
  readonly before: string;
  readonly after: string;
  /** A coupled edit models one guard that spans a fast state gate and its conditional durable transition. */
  readonly also?: { readonly before: string; readonly after: string } | undefined;
  readonly testName: string;
  readonly killingAssertion?: string | undefined;
}

/** Every Task-5 ledger guard is deleted in a copied production tree and killed only by its named oracle. */
const judgeBudgetMutations: readonly JudgeBudgetMutation[] = [
  {
    id: 'e5-rolling-includes-reserved',
    before: "const ROLLING_STATES = \"('reserved', 'in-flight', 'settled')\";",
    after: "const ROLLING_STATES = \"('in-flight', 'settled')\";",
    testName: 'E5 budget: rolling call and token windows include reserved, in-flight, and settled but never released',
  },
  {
    id: 'e5-rolling-includes-in-flight',
    before: "const ROLLING_STATES = \"('reserved', 'in-flight', 'settled')\";",
    after: "const ROLLING_STATES = \"('reserved', 'settled')\";",
    testName: 'E5 budget: rolling call and token windows include reserved, in-flight, and settled but never released',
  },
  {
    id: 'e5-concurrency-excludes-settled',
    before: `WHERE \${where} AND state IN \${CONCURRENCY_STATES} AND concurrency_owned = 1`,
    after: `WHERE (\${where} AND state IN \${CONCURRENCY_STATES} AND concurrency_owned = 1) OR state = 'settled'`,
    testName: 'E5 budget: concurrency counts only reserved and in-flight work',
    killingAssertion: 'the approved concurrent-call ceiling is exhausted',
  },
  {
    id: 'e5-stable-rule-key',
    before: "const rule = usage(database, 'rule_id = ?', [input.scope.ruleId], input.now);",
    after: "const rule = usage(database, 'rule_id = ? AND rule_version = 999999', [input.scope.ruleId], input.now);",
    testName: 'E5 budget: a stable rule ledger key does not include its immutable version',
  },
  {
    id: 'e5-input-max-before-io',
    before: 'if (estimate > maxInputTokens)',
    after: 'if (false)',
    testName:
      'E5 budget: final-envelope UTF-8 bytes are reserved before I/O and over-limit input never reaches transport',
  },
  {
    id: 'e5-byte-estimate',
    before: 'return Buffer.byteLength(finalEnvelope);',
    after: 'return 0;',
    testName:
      'E5 budget: final-envelope UTF-8 bytes are reserved before I/O and over-limit input never reaches transport',
  },
  {
    id: 'e5-no-active-singleton',
    before: "if (active === undefined) refusal('NO_ACTIVE_BUDGET', 'no approved judge budget is active');",
    after: "if (false) refusal('NO_ACTIVE_BUDGET', 'no approved judge budget is active');",
    testName: 'E5 budget: no active singleton refuses before a transport can begin',
  },
  {
    id: 'e5-unparsed-outcome-never-refunds',
    before:
      "const actual =\n    input.result === 'completed' && safeNonNegativeInteger(input.actualInputTokens) ? input.actualInputTokens : null;",
    after: 'const actual = safeNonNegativeInteger(input.actualInputTokens) ? input.actualInputTokens : null;',
    also: {
      before: ': { result: input.result };',
      after:
        ': { result: input.result, actualInputTokens: (input as { readonly actualInputTokens?: unknown }).actualInputTokens as number };',
    },
    testName: 'E5 budget: only a parsed successful answer may replace the estimate',
  },
  {
    id: 'e5-omitted-result-never-defaults-completed',
    before:
      "const settlement: JudgeSettlement =\n    input.result === 'completed'\n      ? { result: input.result, actualInputTokens: input.actualInputTokens }\n      : { result: input.result };",
    after: "const settlement = { result: input.result ?? 'completed', actualInputTokens: input.actualInputTokens };",
    testName: 'E5 budget: only a parsed successful answer may replace the estimate',
  },
  {
    id: 'e5-terminal-decision-is-no-match',
    before: "SELECT ?, i.event_id, i.account_id, ?, ?, 'no-match', ?, ?",
    after: "SELECT ?, i.event_id, i.account_id, ?, ?, 'hold', ?, ?",
    testName: 'E5 budget: only a parsed successful answer may replace the estimate',
  },
  {
    id: 'e5-terminal-projection-purge',
    before: 'DELETE FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = ?',
    after: 'DELETE FROM ingest_rules WHERE 1 = 0 AND event_id = ? AND rule_id = ? AND rule_version = ?',
    testName: 'E5 budget: only a parsed successful answer may replace the estimate',
  },
  {
    id: 'e5-single-transport-entry',
    before: "if (row === null || row.state !== 'reserved') return false;",
    after: 'if (row === null) return false;',
    also: {
      before:
        "SET state = 'in-flight', in_flight_at = ?\n           WHERE id = ? AND state = 'reserved' AND concurrency_owned = 1",
      after:
        "SET state = 'in-flight', in_flight_at = ?\n           WHERE id = ? AND state IN ('reserved', 'in-flight') AND concurrency_owned = 1",
    },
    testName: 'E5 budget: one reservation crosses the pre-I/O transport gate at most once',
  },
  {
    id: 'e5-concurrency-release',
    before: "SET state = 'settled', actual_input_tokens = ?, concurrency_owned = 0, settled_at = ?",
    after: "SET state = 'settled', actual_input_tokens = ?, concurrency_owned = 1, settled_at = ?",
    testName: 'E5 budget: concurrency counts only reserved and in-flight work',
  },
  {
    id: 'e5-double-settle',
    before: "WHERE id = ? AND state = 'in-flight' AND concurrency_owned = 1",
    after: "WHERE id = ? AND state IN ('in-flight', 'settled') AND (concurrency_owned = 1 OR state = 'settled')",
    testName: 'E5 budget: a settled reservation cannot be charged or terminalised a second time',
  },
];

export const JUDGE_BUDGET_MUTATIONS: readonly (JudgeBudgetMutation & { readonly killingAssertion: string })[] =
  judgeBudgetMutations.map((mutation): JudgeBudgetMutation & { readonly killingAssertion: string } => ({
    ...mutation,
    killingAssertion: mutation.killingAssertion ?? 'ERR_ASSERTION',
  }));

const packageRoot = join(import.meta.dirname, '..', '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function rewriteCopiedCrossPackageImports(root: string): Promise<void> {
  const copiedTests = join(root, 'test');
  const originalTests = join(packageRoot, 'test');
  const rewrite = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const copied = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewrite(copied);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const original = join(originalTests, relative(copiedTests, copied));
      const source = await readFile(copied, 'utf8');
      const rewritten = source.replace(
        /(\b(?:from|import)\s*(?:\()?\s*)(['"])([^'"]+)\2/gu,
        (match, prefix: string, quote: string, specifier: string) => {
          if (!specifier.startsWith('.')) return match;
          const target = resolve(dirname(original), specifier);
          if (!relative(packageRoot, target).startsWith('..')) return match;
          return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
        },
      );
      if (rewritten !== source) await writeFile(copied, rewritten, 'utf8');
    }
  };
  await rewrite(copiedTests);
}

function assertExactlyOneNamedMutationFailure(
  mutation: JudgeBudgetMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.notEqual(
    result.code,
    0,
    `${mutation.id}: ${mutation.testName} unexpectedly accepted its mutant\n${result.output}`,
  );
  const summary = (name: 'tests' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: child emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: the child ran more than its named test\n${result.output}`);
  assert.equal(summary('fail'), 1, `${mutation.id}: the named test did not fail\n${result.output}`);
  assert.deepEqual(
    [...result.output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]),
    [mutation.testName],
  );
  assert.deepEqual(
    [...result.output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]),
    [mutation.testName],
  );
  assert.equal(
    result.output.includes(mutation.killingAssertion ?? ''),
    true,
    `${mutation.id}: its named guard assertion did not kill the mutant\n${result.output}`,
  );
}

function assertExactlyOneNamedMutationPass(
  mutation: JudgeBudgetMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.equal(result.code, 0, `${mutation.id}: unmutated named test did not pass\n${result.output}`);
  const summary = (name: 'tests' | 'pass' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: baseline emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: baseline ran more than one named test\n${result.output}`);
  assert.equal(summary('pass'), 1, `${mutation.id}: baseline did not pass exactly once\n${result.output}`);
  assert.equal(summary('fail'), 0, `${mutation.id}: baseline reported a failure\n${result.output}`);
}

/** Runs exactly one named production-path test against one destructive edit of the copied ledger source. */
export async function expectJudgeBudgetMutationToFail(mutation: JudgeBudgetMutation): Promise<number> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    await rewriteCopiedCrossPackageImports(root);
    const target = join(root, 'src/runtime/judge-budget.ts');
    const original = await readFile(target, 'utf8');
    const changes = [
      { before: mutation.before, after: mutation.after },
      ...(mutation.also === undefined ? [] : [mutation.also]),
    ];
    let changed = original;
    for (const change of changes) {
      assert.equal(occurrences(changed, change.before), 1, `${mutation.id}: guarded source must match exactly once`);
      changed = changed.replace(change.before, change.after);
    }
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const { NODE_TEST_CONTEXT: _parentTestContext, ...environment } = process.env;
    const args = [
      '--import',
      pathToFileURL(join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      // The strict kill rule reads TAP's summary; Node 24 defaults to the spec reporter when piped.
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, 'test/judge-budgets.test.ts'),
    ];
    const baseline = await runStrictMutationChild({ command: process.execPath, args, cwd: root, env: environment });
    assertExactlyOneNamedMutationPass(mutation, baseline);
    await writeFile(target, changed, 'utf8');
    const result = await runStrictMutationChild({ command: process.execPath, args, cwd: root, env: environment });
    assertExactlyOneNamedMutationFailure(mutation, result);
    return changedLine;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
