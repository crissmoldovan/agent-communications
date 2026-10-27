import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Notifier } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { StepExecutor } from '../src/runtime/workflow/contracts.ts';
import type { WorkflowFailpoint } from '../src/runtime/workflow/engine.ts';
import { type LaneHarness, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * B2's crash proof (workflows design §12, as test/cutover-failpoints.test.ts proves a cut-over's): a crash after a
 * step's claim, after its effect, or just before its settle commits. A restart claims the step again once its lease
 * has lapsed, and the step settles exactly once — one `settle_seq` — whatever the crash left. What an effect does again
 * is its executor's to make idempotent (§7.4); a notice, recorded by its claim before it is raised, is never raised
 * twice.
 */

const LEASE_LAPSED = 31_000;

const limits = {
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
};

function crashOnce(at: WorkflowFailpoint): { readonly failpoint: (point: WorkflowFailpoint) => void; fired: boolean } {
  const state = {
    fired: false,
    failpoint(point: WorkflowFailpoint) {
      if (point !== at || state.fired) return;
      state.fired = true;
      throw new Error(`a crash at ${point}`);
    },
  };
  return state;
}

async function enable(harness: LaneHarness, flow: Record<string, unknown>): Promise<void> {
  await harness.control.request('rule-create', { document: { ...rule(1, []), flow } });
  await harness.approve(1);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

function stepRows(
  harness: LaneHarness,
): Array<{ step_id: string; state: string; attempts: number; settle_seq: number | null }> {
  return readDatabase(harness.stateDir, (database) =>
    database.prepare('SELECT step_id, state, attempts, settle_seq FROM workflow_steps ORDER BY step_id').all(),
  ) as Array<{ step_id: string; state: string; attempts: number; settle_seq: number | null }>;
}

function runState(harness: LaneHarness): string | undefined {
  return (
    readDatabase(harness.stateDir, (database) => database.prepare('SELECT state FROM workflow_runs').get()) as
      | { state: string }
      | undefined
  )?.state;
}

for (const [point, effectsAfter] of [
  ['after-claim', 1],
  ['after-effect', 2],
  ['before-settle-commit', 2],
] as const)
  test(`B2: a crash ${point.replaceAll('-', ' ')}: a restart re-claims, and the step settles once`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    let offset = 0;
    const now = () => Date.now() + offset;
    let effects = 0;
    const act: StepExecutor = {
      kind: 'find-session',
      run: async () => {
        effects += 1;
        return { kind: 'settled', outcome: 'idle', output: { session: 'sess_stand-in', provider: 'claude' } };
      },
      resume: async () => ({ kind: 'failed', code: 'NOT_A_WAIT' }),
    };
    const crash = crashOnce(point);
    await withLaneOwner(
      async (harness) => {
        await enable(harness, {
          flowVersion: 1,
          start: 'act',
          limits,
          steps: {
            act: { kind: 'find-session', in: { folder: '/example/home/work/x' }, provider: 'claude', next: {} },
          },
        });
        harness.mailbox.send('crash me');
        await harness.tick();
        await harness.tick();
        assert.equal(crash.fired, true, 'the crash happened');
        assert.notEqual(runState(harness), 'done', 'nothing settled before the crash');
        assert.equal(stepRows(harness)[0]?.settle_seq, null);
        // The process is gone; another starts on the same state once the claim's lease has lapsed.
        offset += LEASE_LAPSED;
        await harness.restart({ now, workflows: { parts: [{ executors: [act] }] } });
        await harness.tick();
        assert.equal(runState(harness), 'done');
        const [row, ...others] = stepRows(harness);
        assert.equal(others.length, 0);
        assert.equal(row?.state, 'done');
        assert.equal(row?.settle_seq, 1, 'settled once');
        assert.equal(row?.attempts, 2, 'claimed again after the crash');
        assert.equal(effects, effectsAfter);
        await harness.tick();
        assert.equal(stepRows(harness)[0]?.settle_seq, 1, 'and never again');
      },
      { now, workflows: { parts: [{ executors: [act] }], failpoint: crash.failpoint } },
    );
  });

test('B2: a notice raised before a crash is not raised again after the restart', { skip: WINDOWS_SKIP }, async () => {
  let offset = 0;
  const now = () => Date.now() + offset;
  const notices: string[] = [];
  const notifier: Notifier = async (notice) => {
    notices.push(notice.body);
    return { raised: true };
  };
  const crash = crashOnce('after-effect');
  await withLaneOwner(
    async (harness) => {
      await enable(harness, {
        flowVersion: 1,
        start: 'tell',
        limits,
        steps: { tell: { kind: 'notify', text: 'once', next: {} } },
      });
      harness.mailbox.send('tell me once');
      await harness.tick();
      await harness.tick();
      assert.equal(crash.fired, true);
      assert.equal(notices.length, 1);
      offset += LEASE_LAPSED;
      await harness.restart({ now, workflows: { notifier } });
      await harness.tick();
      assert.equal(runState(harness), 'done');
      assert.equal(notices.length, 1, 'once per step per run');
      assert.equal(stepRows(harness)[0]?.settle_seq, 1);
    },
    { now, workflows: { notifier, failpoint: crash.failpoint } },
  );
});
