import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeFinalMutationToFail, JUDGE_FINAL_MUTATIONS } from './support/judge-final-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E13 final mutations: every final ship gate has one exact destructive mutation', () => {
  assert.deepEqual(
    JUDGE_FINAL_MUTATIONS.map((mutation) => mutation.id),
    [
      'e13-required-release-gate',
      'e13-b3-capability-row',
      'e13-doctor-hold-clock',
      'e13-laya-typed-unavailable',
      'e13-kind-enablement-approval',
      'e13-owner-judge-wiring',
    ],
    'Task 13 owns every final gate mutation in append order',
  );
});

test('E13 final mutations: every copied-tree mutant is killed by its one named final assertion', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const mutation of JUDGE_FINAL_MUTATIONS) {
    await expectJudgeFinalMutationToFail(mutation);
    context.diagnostic(`${mutation.id}: ${mutation.testName} -> ${mutation.killingAssertion}`);
  }
});
