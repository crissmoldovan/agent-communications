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
      'e12-target-remove-purge',
      'e12-subscriber-remove-purge',
      'e12-judge-remove-purge',
      'e12-account-remove-readd-purge',
      'e12-whatsapp-hide-purge',
      'e12-rule-disable-purge',
      'e12-disable-all-purge',
      'e12-account-rule-revoke',
      'e12-derived-parent-revoke',
      'e12-account-source-purge',
      'e12-judge-key-generation-fence',
      'e12-judge-kind-literal-guard',
      'e12-audit-matrix',
      'e12-static-network-path',
      'e12-purge-caller-registry',
      'e12-corpus-dependency-closure',
      'e12-held-purge-race',
      'e12-hold-claim-expiry-call',
      'e12-hold-api-expiry-call',
      'e12-hold-resolution-expiry-call',
      'e-review-judge-input-envelope',
      'e-review-event-taint-platform',
      'e-review-kind-disable-work-closure',
      'e-review-kind-disable-keeps-rule-authority',
      'e-review-preio-release-commit',
      'e-review-response-owner-recovery',
      'e-review-valid-mcp-kind-disable-parity',
      'e-review-b3-capability-row-removal',
      'e-review-b3-capability-operation',
    ],
    'the strict gate mutation runner owns the exact immutable mutation inventory',
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
    'a strict mutation runner rejects a mutant that its named test did not kill',
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
    'every strict mutation ran once and in manifest order',
  );
  assert.ok(
    verdicts.every((verdict) => verdict.killed),
    'every strict mutation was killed by its named assertion',
  );
});
