import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('E9 keeps B3 v1 unavailable fixtures isolated while the live producer starts disabled and Laya stays E2', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-e-phase-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      const before = store.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM judge_versions) AS judges,
             (SELECT count(*) FROM judge_budget_versions) AS budgets,
             (SELECT count(*) FROM judge_kind_versions) AS kinds,
             (SELECT count(*) FROM active_versions) AS pointers,
             (SELECT count(*) FROM activation_intents) AS approvals`,
        )
        .get();

      assert.deepEqual(await control.handle({ operation: 'judgesList', args: {} }), []);
      assert.deepEqual(await control.handle({ operation: 'budgetShow', args: {} }), {
        activeVersion: null,
        versions: [],
      });
      assert.deepEqual(await control.handle({ operation: 'judgeKindsList', args: {} }), [
        { kind: 'typesafe', state: 'disabled', version: null },
        { kind: 'laya', state: 'unavailable', code: 'E2_REQUIRED' },
        { kind: 'local-endpoint', state: 'disabled', version: null },
      ]);
      for (const operation of [
        'enableJudgeKind',
        'disableJudgeKind',
        'judgeModelStatus',
        'removeJudgeModel',
      ] as const) {
        assert.deepEqual(
          await control.handle({ operation, args: { kind: 'laya' } }),
          { kind: 'unavailable', code: 'E2_REQUIRED', phase: 'E2' },
          operation,
        );
      }
      assert.deepEqual(await control.handle({ operation: 'heldList', args: {} }), { kind: 'held-list', decisions: [] });
      assert.deepEqual(
        store.database
          .prepare(
            `SELECT
               (SELECT count(*) FROM judge_versions) AS judges,
               (SELECT count(*) FROM judge_budget_versions) AS budgets,
               (SELECT count(*) FROM judge_kind_versions) AS kinds,
               (SELECT count(*) FROM active_versions) AS pointers,
               (SELECT count(*) FROM activation_intents) AS approvals`,
          )
          .get(),
        before,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pre-E judge operations return only the E_REQUIRED unavailable result', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-e-required-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      assert.deepEqual(await control.handle({ operation: 'judgesList', args: {} }), []);
      assert.deepEqual(await control.handle({ operation: 'budgetShow', args: {} }), {
        activeVersion: null,
        versions: [],
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 E/E2 operators are content-free unavailable results with no producer state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-e2-dispatch-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      const before = store.database
        .prepare(
          `SELECT
             (SELECT count(*) FROM judge_versions) AS judges,
             (SELECT count(*) FROM judge_budget_versions) AS budgets,
             (SELECT count(*) FROM judge_kind_versions) AS kinds,
             (SELECT count(*) FROM active_versions) AS pointers,
             (SELECT count(*) FROM activation_intents) AS approvals`,
        )
        .get();
      for (const operation of ['enableJudgeKind', 'disableJudgeKind'] as const)
        assert.deepEqual(await control.handle({ operation, args: { kind: 'laya' } }), {
          kind: 'unavailable',
          code: 'E2_REQUIRED',
          phase: 'E2',
        });
      assert.deepEqual(await control.handle({ operation: 'judgeModelStatus', args: {} }), {
        kind: 'unavailable',
        code: 'E2_REQUIRED',
        phase: 'E2',
      });
      assert.deepEqual(await control.handle({ operation: 'removeJudgeModel', args: {} }), {
        kind: 'unavailable',
        code: 'E2_REQUIRED',
        phase: 'E2',
      });
      assert.deepEqual(
        store.database
          .prepare(
            `SELECT
               (SELECT count(*) FROM judge_versions) AS judges,
               (SELECT count(*) FROM judge_budget_versions) AS budgets,
               (SELECT count(*) FROM judge_kind_versions) AS kinds,
               (SELECT count(*) FROM active_versions) AS pointers,
               (SELECT count(*) FROM activation_intents) AS approvals`,
          )
          .get(),
        before,
        'the E2 dispatch seam creates neither immutable configuration nor a pointer or activation',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 pre-E2 model operations return only the E2_REQUIRED unavailable result', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-e2-required-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      assert.deepEqual(await control.handle({ operation: 'judgeModelStatus', args: {} }), {
        kind: 'unavailable',
        code: 'E2_REQUIRED',
        phase: 'E2',
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E9 held decision fails closed until the owner composes the Task 8 resolver', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-held-decide-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      await assert.rejects(
        () =>
          control.handle({ operation: 'decideHeld', args: { decisionId: 'synthetic-decision', decision: 'accept' } }),
        /held resolution has not been composed/u,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 held decision remains unavailable while the held list is typed empty', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-b3-held-dispatch-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const control = new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } });
      assert.deepEqual(await control.handle({ operation: 'heldList', args: {} }), { kind: 'held-list', decisions: [] });
      await assert.rejects(
        () =>
          control.handle({ operation: 'decideHeld', args: { decisionId: 'synthetic-decision', decision: 'accept' } }),
        /held resolution has not been composed/u,
        'the live operator dispatch refuses instead of invoking the legacy unavailable helper',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
