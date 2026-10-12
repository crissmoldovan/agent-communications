import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeHoldMutationToFail, JUDGE_HOLD_MUTATIONS } from './support/judge-hold-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E8 mutation: every hold deadline, claim, expiry, recheck and purge invariant has one strict oracle', () => {
  assert.deepEqual(
    JUDGE_HOLD_MUTATIONS.map((mutation) => mutation.id),
    [
      'e8-sqlite-hold-clock',
      'e8-ingest-tie',
      'e8-lease-recovery',
      'e8-expiry-before-control',
      'e8-decision-bound-token',
      'e8-final-resolution-recheck',
      'e8-account-purge-claim',
      'e8-evaluator-db-clock',
      'e8-hold-write-expiry',
      'e8-held-whatsapp-live-fence',
      'e8-held-whatsapp-journal-version',
      'e8-legacy-hold-ingest-cap',
      'e8-legacy-hold-repeated-tightening',
      'e8-held-final-live-account-fence',
    ],
  );
});

test('E8 mutation: each held-work mutant fails exactly once in its named production-path test', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const mutation of JUDGE_HOLD_MUTATIONS) {
    await expectJudgeHoldMutationToFail(mutation);
    context.diagnostic(`${mutation.id}: ${mutation.testName}`);
  }
});
