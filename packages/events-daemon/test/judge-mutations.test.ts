import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeMutationToFail, PHASE_E_GATE_MUTATIONS } from './support/judge-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E3 mutation: every prerequisite and scope mutation has exactly one named production-path owner', () => {
  assert.deepEqual(
    PHASE_E_GATE_MUTATIONS.map((mutation) => mutation.id),
    [
      'e3-b3-contract-version',
      'e3-b3-unavailable-variants',
      'e3-b3-vector-schema-validation',
      'e3-scope-account-source',
      'e3-scope-synthetic-work',
      'e7-deterministic-first',
      'e7-taint-before-reserve',
      'e7-exact-input-provenance',
      'e7-settlement-token',
      'e7-pause-fence',
      'e7-full-request-estimate',
      'e7-single-decision-owner',
      'e7-deterministic-shared-route',
      'e7-evaluator-writer-lease',
      'e9-fixed-synthetic-judge-input',
      'e9-judge-key-rotate-current-generation',
      'e9-mcp-kind-enable-no-active-pointer',
      'e9-pending-rule-judge-origin',
    ],
  );
});

test('E3 mutation: the strict runner rejects a mutant whose named test passes', async () => {
  await assert.rejects(
    expectJudgeMutationToFail({
      id: 'e3-self-passing-mutant',
      source: 'packages/events-daemon/src/runtime/phase-e-prerequisites.ts',
      before: 'export const PHASE_E_PREREQUISITE_VERSION = 1;',
      after: 'export const PHASE_E_PREREQUISITE_VERSION = 1;',
      test: 'packages/events-daemon/test/judge-b3-prerequisites.test.ts',
      testName: 'E3: phase-E prerequisites consume the real E parser and judge-kind registry with B3 data-only inputs',
    }),
    /unexpectedly accepted its mutant/u,
  );
});

test('E3 mutation: each prerequisite and scope guard fails exactly once in its named production-path test', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const verdicts: { id: string; killed: boolean }[] = [];
  for (const mutation of PHASE_E_GATE_MUTATIONS) {
    await expectJudgeMutationToFail(mutation);
    verdicts.push({ id: mutation.id, killed: true });
    context.diagnostic(`${mutation.id}: ${mutation.testName}`);
  }
  assert.deepEqual(
    verdicts.map((verdict) => verdict.id),
    PHASE_E_GATE_MUTATIONS.map((mutation) => mutation.id),
  );
  assert.ok(verdicts.every((verdict) => verdict.killed));
});
