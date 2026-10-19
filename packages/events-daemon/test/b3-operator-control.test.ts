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

test('E9 operator control creates immutable subscriber and judge versions while retaining the E2 model seam', {
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
        digest: '590c35f84a86811a1e1fbd2b7856d27e84a5a758d430c9c2b7f51f7be4d74ec9',
        state: null,
      });
      assert.deepEqual(await control.handle({ operation: 'subscribersList', args: {} }), [
        {
          subscriberId: 'subscriber-control',
          version: 1,
          digest: '590c35f84a86811a1e1fbd2b7856d27e84a5a758d430c9c2b7f51f7be4d74ec9',
          revokedAt: null,
        },
      ]);

      const judge = {
        judgeId: 'judge-control',
        version: 1,
        kind: 'local-endpoint',
        provider: 'ollama',
        model: 'test',
        endpoint: 'http://127.0.0.1:11434/v1/systemone',
        approvedAddressSet: ['127.0.0.1'],
        promptTemplate: 'test',
        protocol: 'noul',
      };
      const createdJudge = await control.handle({ operation: 'addJudge', args: { document: judge } });
      assert.deepEqual(createdJudge, {
        id: 'judge-control@1',
        kind: 'judge',
        objectId: 'judge-control',
        version: 1,
        document: judge,
        digest: 'dd44bd6868bbb6e4874fd35f5a605062f048cebc561d48d0ad4c00f9758194e6',
        state: null,
      });
      assert.deepEqual(await control.handle({ operation: 'judgesList', args: {} }), [
        {
          judgeId: 'judge-control',
          version: 1,
          kind: 'local-endpoint',
          provider: 'ollama',
          model: 'test',
          revokedAt: null,
        },
      ]);
      const beforeE2 = store.database
        .prepare(
          `SELECT (SELECT count(*) FROM judge_versions) AS judges,
                  (SELECT count(*) FROM judge_budget_versions) AS budgets,
                  (SELECT count(*) FROM judge_kind_versions) AS kinds,
                  (SELECT count(*) FROM active_versions WHERE kind IN ('judge-budget', 'judge-kind')) AS pointers,
                  (SELECT count(*) FROM activation_intents) AS approvals`,
        )
        .get();
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
        beforeE2,
        'every E2 refusal leaves the existing live E state untouched',
      );
      const preparedKinds: unknown[] = [];
      const mcpKindControl = new B3OperatorControl({
        store,
        ports: { quiescer: new WriterQuiescer() },
        activations: {
          prepareJudgeBudget: async () => {
            throw new Error('not used by this control path');
          },
          prepareJudgeKind: async (input) => {
            preparedKinds.push(input);
            return {
              intentId: 'pending-mcp-kind-enable',
              approvalId: 'approval-mcp-kind-enable',
              binding: {} as never,
              kind: 'judge-kind',
            } as never;
          },
          cancelForJudgeKindInTransaction: () => 0,
          cancelForRevocationInTransaction: () => 0,
        },
      });
      assert.deepEqual(
        await mcpKindControl.handle({ operation: 'enableJudgeKind', args: { kind: 'typesafe' } }),
        {
          intentId: 'pending-mcp-kind-enable',
          approvalId: 'approval-mcp-kind-enable',
          binding: {},
          kind: 'judge-kind',
        },
        'the MCP-capable operator path creates only a pending activation',
      );
      assert.deepEqual(preparedKinds, [{ kind: 'typesafe', version: 1 }]);
      assert.equal(
        store.database
          .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = 'typesafe'")
          .get(),
        undefined,
        'MCP kind enable never leaves an active pointer before the approval finaliser',
      );
      assert.deepEqual(await control.handle({ operation: 'heldList', args: {} }), { kind: 'held-list', decisions: [] });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
