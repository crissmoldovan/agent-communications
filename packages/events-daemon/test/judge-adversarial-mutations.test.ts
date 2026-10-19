import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  expectJudgeAdversarialMutationToFail,
  JUDGE_ADVERSARIAL_MUTATIONS,
} from './support/judge-adversarial-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E11 adversarial mutation: the corpus has one destructive mutation for each required trust-boundary regression', () => {
  assert.deepEqual(
    JUDGE_ADVERSARIAL_MUTATIONS.map((mutation) => mutation.id),
    [
      'e11-provider-match-authority',
      'e11-envelope-provenance',
      'e11-range-token-cap',
      'e11-wrong-type-score',
      'e11-host-drift-before-byte',
      'e11-journal-exactness',
      'e11-refusal-content-free',
      'e11-late-hold-response',
      'e11-corpus-integrity-allowlist',
      'e11-response-fixture-pinning',
      'e11-corpus-manifest-pairing',
    ],
    'Task 11 mutation inventory is exact and ordered',
  );
});

test('E11 adversarial mutation: every copied-tree mutant is killed exactly once by its named corpus or integrity assertion', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const mutation of JUDGE_ADVERSARIAL_MUTATIONS) {
    await expectJudgeAdversarialMutationToFail(mutation);
    context.diagnostic(`${mutation.id}: ${mutation.testName}`);
  }
});
