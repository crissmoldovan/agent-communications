import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeTask5MutationToFail, JUDGE_TASK5_MUTATIONS } from './support/judge-task5-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E5 mutation: owner-start and v1 vocabulary regressions each have one strict oracle', () => {
  assert.deepEqual(
    JUDGE_TASK5_MUTATIONS.map((mutation) => mutation.id),
    [
      'e2-durable-schema',
      'e5-owner-start-recovery',
      'e5-v1-literal-judge-kinds',
      'e5-released-retry-new-attempt',
      'e5-released-terminal-transition',
      'e5-inflight-never-releases',
      'e5-inflight-at-physical-io',
    ],
    'the strict Task-5 runner owns every schema, recovery and attempt-state mutation',
  );
});

test('E5 mutation: owner-start and v1 vocabulary regressions die in their one named test', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const verdicts: { id: string; killed: boolean }[] = [];
  for (const mutation of JUDGE_TASK5_MUTATIONS) {
    await expectJudgeTask5MutationToFail(mutation);
    verdicts.push({ id: mutation.id, killed: true });
    context.diagnostic(`${mutation.id}: ${mutation.testName}`);
  }
  assert.deepEqual(
    verdicts.map((verdict) => verdict.id),
    JUDGE_TASK5_MUTATIONS.map((mutation) => mutation.id),
  );
  assert.ok(verdicts.every((verdict) => verdict.killed));
});
