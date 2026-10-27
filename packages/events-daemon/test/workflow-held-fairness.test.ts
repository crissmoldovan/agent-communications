import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { StepKind } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { eventPaths } from '../src/runtime/paths.ts';
import type { StepContext, StepExecutor, StepResult } from '../src/runtime/workflow/contracts.ts';
import { ACCOUNT, type LaneHarness, RULE, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The security review of 0.36.0 (M6): held runs start in turn, each workflow's oldest first, as its own limits allow.
 * One workflow's backlog — held runs its own `concurrentRuns` keeps waiting, which a sender can build, since a held run
 * is never dropped — never hides another workflow's held run that its limits would start. A real owner, a fake mailbox,
 * and a stand-in wait that keeps a started run live.
 */

const HOUR = 3_600_000;
const BACKLOG = 'a-workflow';

const limits = (overrides: Record<string, number> = {}) => ({
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
  ...overrides,
});

function standIn(kind: StepKind, run: (ctx: StepContext) => StepResult | Promise<StepResult>): StepExecutor {
  return { kind, run: async (ctx) => run(ctx), resume: async (ctx) => run(ctx) };
}

/** A wait that holds for an hour: a run that stays live while the test looks. */
const holdForAnHour = standIn('wait', (ctx) => ({ kind: 'wait', wait: 'time', key: null, wakeAt: ctx.now() + HOUR }));

const waitStep = { kind: 'wait', for: { time: { afterMs: HOUR } }, timeoutMs: 2 * HOUR, next: {} };

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  await harness.control.request('rule-create', { document });
  await harness.approve(document.version as number);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

const flowRule = (flow: Record<string, unknown>): Record<string, unknown> => ({
  ...rule(1, []),
  flow: { flowVersion: 1, limits: limits(), ...flow },
});

/** Writes runs straight into the owner's store, as a burst of mail would leave them: no decision rows behind them. */
function writeRuns(stateDir: string, write: (database: DatabaseSync) => void): void {
  const database = new DatabaseSync(eventPaths(stateDir).database, { enableForeignKeyConstraints: false });
  try {
    write(database);
  } finally {
    database.close();
  }
}

/** A run id of index `n`: `wfr_` and 26 characters. */
function runId(n: number): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let text = '';
  let value = n;
  for (let index = 0; index < 26; index += 1) {
    text = alphabet[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `wfr_${text}`;
}

function statesOf(harness: LaneHarness, ruleId: string): Record<string, number> {
  const rows = readDatabase(harness.stateDir, (database) =>
    database
      .prepare('SELECT state, COUNT(*) AS count FROM workflow_runs WHERE rule_id = ? GROUP BY state ORDER BY state')
      .all(ruleId),
  ) as Array<{ state: string; count: number }>;
  return Object.fromEntries(rows.map((row) => [row.state, row.count]));
}

test('M6: a workflow’s held backlog of 120 never holds back another workflow’s run, which starts on the next tick', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      // Workflow B, approved, the one the mail matches: two runs at a time.
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      // Workflow A, one run at a time: one live and 120 held behind it, all older than B's run.
      await harness.control.request('rule-create', {
        document: {
          ...flowRule({ start: 'pause', limits: limits({ concurrentRuns: 1 }), steps: { pause: waitStep } }),
          ruleId: BACKLOG,
        },
      });
      const { switch_generation: generation } = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT switch_generation FROM event_settings WHERE singleton = 1').get(),
      ) as { switch_generation: number };
      const now = Date.now();
      writeRuns(harness.stateDir, (database) => {
        const insert = database.prepare(
          `INSERT INTO workflow_runs
             (id, decision_id, rule_id, rule_version, account_id, event_id, state, started_at, updated_at, expires_at,
              switch_generation, encrypted_record)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let index = 0; index <= 120; index += 1)
          insert.run(
            runId(index + 1),
            `decision-backlog-${index}`,
            BACKLOG,
            ACCOUNT,
            `event-backlog-${index}`,
            index === 0 ? 'waiting' : 'held',
            now - 60_000 + index,
            now - 60_000 + index,
            now + HOUR * 24,
            generation,
            index === 0 ? null : Buffer.from([0]),
          );
      });
      harness.mailbox.send('for workflow B');
      await harness.tick();
      assert.deepEqual(statesOf(harness, RULE), { held: 1 }, 'the match made B one held run');
      await harness.tick();
      assert.deepEqual(statesOf(harness, RULE), { waiting: 1 }, 'B’s run started on the next tick, past A’s backlog');
      assert.deepEqual(statesOf(harness, BACKLOG), { held: 120, waiting: 1 }, 'and A’s backlog still waits its turn');
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});

test('M6: within one workflow held runs still start oldest first, as many as its limits allow', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({ start: 'pause', limits: limits({ concurrentRuns: 2 }), steps: { pause: waitStep } }),
      );
      for (const subject of ['first', 'second', 'third', 'fourth']) {
        harness.mailbox.send(subject);
        await harness.tick();
      }
      await harness.tick();
      const rows = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT state FROM workflow_runs ORDER BY started_at, id').all(),
      ) as Array<{ state: string }>;
      assert.deepEqual(
        rows.map((row) => row.state),
        ['waiting', 'waiting', 'held', 'held'],
      );
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});
