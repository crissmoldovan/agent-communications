import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const subscriber = {
  subscriberId: 'subscriber-control',
  version: 1,
  kind: 'sse',
  authority: { host: '127.0.0.1', port: 43101 },
  origins: ['https://console.invalid'],
  retentionMs: 60_000,
};

test('B3 operator control creates immutable subscriber versions and keeps every pre-E producer unavailable', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-operator-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({
        store,
        ports: { quiescer: new WriterQuiescer() },
      });
      const created = await control.handle({ operation: 'addSubscriber', args: { document: subscriber } });
      assert.deepEqual(created, {
        id: 'subscriber-control@1',
        kind: 'subscriber',
        objectId: 'subscriber-control',
        version: 1,
        document: subscriber,
        digest: (created as { digest: string }).digest,
        state: null,
      });
      assert.deepEqual(await control.handle({ operation: 'subscribersList', args: {} }), [
        {
          subscriberId: 'subscriber-control',
          version: 1,
          digest: (created as { digest: string }).digest,
          revokedAt: null,
        },
      ]);

      const before = store.database
        .prepare(
          `SELECT (SELECT count(*) FROM judge_versions) AS judges,
                  (SELECT count(*) FROM judge_budget_versions) AS budgets,
                  (SELECT count(*) FROM judge_kind_versions) AS kinds,
                  (SELECT count(*) FROM active_versions WHERE kind IN ('judge-budget', 'judge-kind')) AS pointers,
                  (SELECT count(*) FROM activation_intents) AS approvals`,
        )
        .get();
      for (const operation of [
        'judgesList',
        'addJudge',
        'updateJudge',
        'removeJudge',
        'judgeTest',
        'budgetShow',
        'updateBudget',
        'judgeKindsList',
        'enableJudgeKind',
        'disableJudgeKind',
      ] as const) {
        assert.deepEqual(
          await control.handle({ operation, args: operation.includes('Kind') ? { kind: 'typesafe' } : {} }),
          { kind: 'unavailable', code: 'E_REQUIRED', phase: 'E' },
          `${operation} is a callable owner request but makes no Phase-E producer`,
        );
      }
      for (const operation of [
        'enableJudgeKind',
        'disableJudgeKind',
        'judgeModelStatus',
        'removeJudgeModel',
      ] as const) {
        assert.deepEqual(
          await control.handle({ operation, args: operation.includes('JudgeKind') ? { kind: 'laya' } : {} }),
          { kind: 'unavailable', code: 'E2_REQUIRED', phase: 'E2' },
          `${operation} stays unavailable through Phase E2`,
        );
      }
      assert.deepEqual(await control.handle({ operation: 'heldList', args: {} }), {
        kind: 'held-list',
        decisions: [],
      });
      assert.deepEqual(
        await control.handle({ operation: 'decideHeld', args: { decisionId: 'held-1', decision: 'accept' } }),
        {
          kind: 'unavailable',
          code: 'HOLDS_UNAVAILABLE',
          phase: 'E',
        },
      );
      assert.deepEqual(
        store.database
          .prepare(
            `SELECT (SELECT count(*) FROM judge_versions) AS judges,
                    (SELECT count(*) FROM judge_budget_versions) AS budgets,
                    (SELECT count(*) FROM judge_kind_versions) AS kinds,
                    (SELECT count(*) FROM active_versions WHERE kind IN ('judge-budget', 'judge-kind')) AS pointers,
                    (SELECT count(*) FROM activation_intents) AS approvals`,
          )
          .get(),
        before,
        'unavailable operations create neither immutable configuration nor an approval/pointer',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
