import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeBudgetMutationToFail, JUDGE_BUDGET_MUTATIONS } from './support/judge-budget-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E5 budget mutation: every ledger guard has one destructive mutation and one exact named oracle', () => {
  assert.deepEqual(
    JUDGE_BUDGET_MUTATIONS.map((mutation) => mutation.id),
    [
      'e5-rolling-includes-reserved',
      'e5-rolling-includes-in-flight',
      'e5-concurrency-excludes-settled',
      'e5-stable-rule-key',
      'e5-input-max-before-io',
      'e5-byte-estimate',
      'e5-no-active-singleton',
      'e5-unparsed-outcome-never-refunds',
      'e5-omitted-result-never-defaults-completed',
      'e5-terminal-decision-is-no-match',
      'e5-terminal-projection-purge',
      'e5-single-transport-entry',
      'e5-concurrency-release',
      'e5-double-settle',
    ],
  );
});

test('E5 budget mutation: each guard dies only when its named production-path test fails', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const verdicts: { id: string; killed: boolean }[] = [];
  for (const mutation of JUDGE_BUDGET_MUTATIONS) {
    const changedLine = await expectJudgeBudgetMutationToFail(mutation);
    verdicts.push({ id: mutation.id, killed: true });
    context.diagnostic(`${mutation.id}: src/runtime/judge-budget.ts:${changedLine} -> ${mutation.testName}`);
  }
  assert.deepEqual(
    verdicts.map((verdict) => verdict.id),
    JUDGE_BUDGET_MUTATIONS.map((mutation) => mutation.id),
  );
  assert.ok(verdicts.every((verdict) => verdict.killed));
});
