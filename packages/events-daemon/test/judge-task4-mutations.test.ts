import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
// @ts-expect-error The verifier is a repository executable with no declaration file.
import * as phaseEVerifier from '../../../scripts/verify-events-phase-e-tests.mjs';
import { expectJudgeTask4MutationToFail, JUDGE_TASK4_MUTATIONS } from './support/judge-task4-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

const { verifyPhaseEJudgeSource, verifyPhaseETestManifest } = phaseEVerifier;

test('E4 mutation: every kind, budget and purge guard has one exact copied-tree mutation', () => {
  assert.deepEqual(
    JUDGE_TASK4_MUTATIONS.map((mutation) => mutation.id),
    [
      'e4-no-pointer-at-prepare',
      'e4-final-pointer-drift',
      'e4-claim-pointer-drift',
      'e4-disabled-judge-add',
      'e4-kind-disable-recovery',
      'e4-laya-before-intent',
      'e4-budget-digest-prepare',
      'e4-kind-digest-prepare',
      'e4-budget-digest-claim',
      'e4-kind-digest-claim',
      'e4-budget-digest-finalise',
      'e4-kind-digest-finalise',
      'e4-budget-digest-live-reservation',
      'e4-kind-digest-live-reservation',
      'e4-first-enablement-disable',
      'e4-absent-kind-disable-generation',
      'e4-expiry-rule-version',
      'e4-tightening-rule-version',
      'e4-unscoped-kind-static-guard',
      'e4-primary-key-exemption',
      'e4-required-guard-rows',
    ],
  );
});

test('E4 mutation: each named production case is green unmutated and fails exactly once under its guard mutant', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const mutation of JUDGE_TASK4_MUTATIONS) {
    await expectJudgeTask4MutationToFail(mutation);
    context.diagnostic(`${mutation.id}: ${mutation.testName}`);
  }
});

test('E4 mutation: verifier static scope and required Task-4 guard rows refuse drift', async () => {
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/unscoped-kind.ts',
      source: 'const statement = `SELECT id FROM judge_budget_reservations WHERE judge_kind = ?`;',
    }),
    [
      'src/runtime/unscoped-kind.ts: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates',
    ],
  );
  const root = process.env.PHASE_E_ORIGINAL_ROOT ?? join(import.meta.dirname, '../../..');
  const problems = await verifyPhaseETestManifest({
    root,
    manifest: { version: 1, guards: [], mutations: [], cases: [] },
  });
  assert.ok(
    problems.includes('required Phase-E guard row is absent: e4-laya-before-intent'),
    `removing a Task-4 required row must refuse: ${problems.join('; ')}`,
  );
});

test('E4 verifier: the primary-key exemption permits one bound equality and rejects broadening clauses', () => {
  const problem =
    'src/runtime/primary-key-bypass.ts: judge work SQL selected by kind, judge, rule, or no selector must bind a literal work_scope with its scope predicates';
  for (const source of [
    'const statement = `DELETE FROM judge_budget_reservations WHERE id = ? OR 1 = 1`;',
    'const statement = `DELETE FROM judge_budget_reservations WHERE id = ? OR id = ?`;',
    'const statement = `DELETE FROM judge_budget_reservations WHERE id = 1`;',
    'const statement = `DELETE FROM judge_budget_reservations WHERE id > ?`;',
    'const statement = `DELETE FROM judge_budget_reservations WHERE id IN (SELECT id FROM judge_budget_reservations)`;',
  ]) {
    assert.deepEqual(verifyPhaseEJudgeSource({ file: 'src/runtime/primary-key-bypass.ts', source }), [problem]);
  }
  assert.deepEqual(
    verifyPhaseEJudgeSource({
      file: 'src/runtime/primary-key-exact.ts',
      source: 'const statement = `DELETE FROM judge_budget_reservations WHERE id = ? AND state = ?`;',
    }),
    [],
  );
});
