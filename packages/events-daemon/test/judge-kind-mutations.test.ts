import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeKindMutationToFail, JUDGE_KIND_MUTATIONS } from './support/judge-kind-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E1: every prepare, claim and finalise disabled-kind guard has one exact destructive mutation', () => {
  assert.deepEqual(
    JUDGE_KIND_MUTATIONS.map((mutation) => mutation.id),
    [
      'e1-prepare-disabled-kind',
      'e1-claim-before-core-disabled-kind',
      'e1-local-claim-transaction-disabled-kind',
      'e1-finalise-transaction-disabled-kind',
    ],
  );
});

test('E1: each disabled-kind guard mutation fails its named production-path test', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const mutation of JUDGE_KIND_MUTATIONS) {
    const changedLine = await expectJudgeKindMutationToFail(mutation);
    context.diagnostic(`${mutation.id}: src/${mutation.file}:${changedLine} -> ${mutation.testName}`);
  }
});
