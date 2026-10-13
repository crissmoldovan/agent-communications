import assert from 'node:assert/strict';
import { test } from 'node:test';
import { expectJudgeKindMutationToFail, JUDGE_KIND_MUTATIONS } from './support/judge-kind-mutants.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('E1: every prepare, claim and finalise disabled-kind guard has one exact destructive mutation', () => {
  assert.deepEqual(
    JUDGE_KIND_MUTATIONS.map((mutation) => mutation.id),
    [
      'e1-canonical-documents',
      'e1-prepare-disabled-kind',
      'e1-claim-before-core-disabled-kind',
      'e1-local-claim-transaction-disabled-kind',
      'e1-finalise-transaction-disabled-kind',
    ],
  );
});

// The runner now proves each named test green in the copied tree first, and those named tests open the database, so
// they skip on Windows (WINDOWS_SKIP): there is no baseline to prove there, as for the destructive runner below.
test('E1: the mutation runner rejects copied-tree import crashes and mutants whose named test passes', {
  skip: WINDOWS_SKIP,
}, async () => {
  await assert.rejects(
    expectJudgeKindMutationToFail({
      id: 'e1-self-import-crash',
      file: 'domain/versions.ts',
      before: "import type { DatabaseSync } from 'node:sqlite';",
      after: "import './missing-e1-self-test.ts';\nimport type { DatabaseSync } from 'node:sqlite';",
      testFile: 'version-lifecycle.test.ts',
      testName: 'E1: only a rule activation that names an agentic judge refuses its disabled kind with the stable code',
    }),
    /a different test ran/u,
  );
  await assert.rejects(
    expectJudgeKindMutationToFail({
      id: 'e1-self-passing-mutant',
      file: 'domain/versions.ts',
      before: "export type ActiveVersionKind = 'rule' | 'judge-budget' | 'judge-kind';",
      after: "export type ActiveVersionKind = 'rule' | 'judge-budget' | 'judge-kind';",
      testFile: 'version-lifecycle.test.ts',
      testName: 'E1: only a rule activation that names an agentic judge refuses its disabled kind with the stable code',
    }),
    /unexpectedly accepted its mutant/u,
  );
});

test('E1: each disabled-kind guard mutation fails its named production-path test', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  const verdicts: { id: string; killed: boolean }[] = [];
  for (const mutation of JUDGE_KIND_MUTATIONS) {
    const changedLine = await expectJudgeKindMutationToFail(mutation);
    verdicts.push({ id: mutation.id, killed: true });
    context.diagnostic(`${mutation.id}: src/${mutation.file}:${changedLine} -> ${mutation.testName}`);
  }
  assert.deepEqual(
    verdicts.map((verdict) => verdict.id),
    JUDGE_KIND_MUTATIONS.map((mutation) => mutation.id),
  );
  assert.ok(verdicts.every((verdict) => verdict.killed));
});
