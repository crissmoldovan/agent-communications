import assert from 'node:assert/strict';
import type { Socket } from 'node:net';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopOrigin, Notifier } from '@agentcomms/core';
import type { FlowDocumentV1, StepKind } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type {
  RunView,
  StepContext,
  StepExecutor,
  StepResult,
  StepTransition,
} from '../src/runtime/workflow/contracts.ts';
import type { RunCancelResultV1 } from '../src/runtime/workflow/run-show.ts';
import { endRunInTransaction } from '../src/runtime/workflow/runs.ts';
import { runCli, sseSubscriber, webhookSubscriber } from './support/events-owner.ts';
import { ACCOUNT, DAY, type LaneHarness, RULE, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { freePort, issueCreated, type LiveEventsHarness, openSse, withLiveEvents } from './support/live-events.ts';
import { startLoopbackReceiver } from './support/loopback-receiver.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * The security review of 0.36.0 (M7, L1, L2): how a run ends.
 * - `runs cancel` applies at once, in its own transaction, though the engine's pass is inside one of the run's steps;
 *   that step settles nothing further, and only its cleanup waits for the pass (M7).
 * - A cancelled run's event being sent is stopped, and a live subscriber's frames of it are not replayed (L1).
 * - A run that ends at its 64th executed step cancels its deliveries still waiting, and a step a limit holds is not
 *   counted again each time it wakes (L2).
 * A real owner with a fake mailbox, stand-ins for the step kinds, a stand-in home and secret store; webhooks reach only
 * a loopback receiver.
 */

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

const findStep = (next: Record<string, string> = {}) => ({
  kind: 'find-session',
  in: { folder: '/example/home/work/x' },
  provider: 'claude',
  next,
});

const FOUND: StepResult = {
  kind: 'settled',
  outcome: 'idle',
  output: { session: 'sess_stand-in', provider: 'claude' },
};

/** The release app, attested as the process that started the CLI. */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

/** `agent-events --json <args>` as the person runs it, from the app; its JSON, or a thrown failure. */
async function person<T>(stateDir: string, args: readonly string[]): Promise<T> {
  const stdin = new PassThrough();
  stdin.end('');
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let out = '';
  let err = '';
  stdout.on('data', (chunk) => {
    out += String(chunk);
  });
  stderr.on('data', (chunk) => {
    err += String(chunk);
  });
  const streams: EventsCliStreams = { stdin, stdout, stderr };
  const code = await run(['--state-dir', stateDir, '--json', ...args], { streams, env: {}, desktopOrigin: ATTESTED });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(code, 0, err);
  return JSON.parse(out) as T;
}

interface RunSeen {
  readonly id: string;
  readonly decision_id: string;
  readonly state: string;
  readonly end_code: string | null;
  readonly executed_steps: number;
}

function onlyRun(harness: LaneHarness): RunSeen {
  const rows = readDatabase(harness.stateDir, (database) =>
    database.prepare('SELECT id, decision_id, state, end_code, executed_steps FROM workflow_runs').all(),
  ) as unknown as RunSeen[];
  assert.equal(rows.length, 1);
  return rows[0] as RunSeen;
}

function stepsOf(harness: LaneHarness, runId: string): Record<string, { state: string; attempts: number }> {
  const rows = readDatabase(harness.stateDir, (database) =>
    database
      .prepare('SELECT step_id, state, attempts FROM workflow_steps WHERE run_id = ? ORDER BY step_id')
      .all(runId),
  ) as Array<{ step_id: string; state: string; attempts: number }>;
  return Object.fromEntries(rows.map((row) => [row.step_id, { state: row.state, attempts: row.attempts }]));
}

test('M7: runs cancel ends the run at once while the pass is inside its step, and that step’s next never runs', {
  skip: WINDOWS_SKIP,
}, async () => {
  const order: string[] = [];
  const notifier: Notifier = async () => {
    order.push('notice raised');
    return { raised: true };
  };
  let entered: () => void = () => {};
  const inside = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let open: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    open = resolve;
  });
  const find = standIn('find-session', async () => {
    entered();
    await gate;
    return FOUND;
  });
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'find',
          steps: { find: findStep({ idle: 'tell' }), tell: { kind: 'notify', text: 'found it', next: {} } },
        }),
      );
      harness.mailbox.send('find me a session');
      await harness.tick();
      // The pass that starts the run goes into its find step, and stays there until the gate opens.
      const passing = harness.tick();
      try {
        await inside;
        const { id: runId } = onlyRun(harness);
        const cancelling = person<RunCancelResultV1>(harness.stateDir, ['runs', 'cancel', runId]).then((result) => {
          order.push('cancel answered');
          return result;
        });
        await Promise.race([cancelling, delay(5_000)]);
        order.push('gate opened');
        open();
        await passing;
        const cancelled = await cancelling;
        assert.deepEqual(order, ['cancel answered', 'gate opened'], 'the cancel answered before the step finished');
        assert.deepEqual(cancelled, {
          runId,
          state: 'cancelled',
          cancelledDeliveries: 0,
          cancelledEvents: 0,
          interrupted: false,
        });
        const ended = onlyRun(harness);
        assert.deepEqual([ended.state, ended.end_code], ['cancelled', 'CANCELLED_BY_PERSON']);
        assert.deepEqual(stepsOf(harness, runId), { find: { state: 'cancelled', attempts: 1 } }, 'tell was never made');
        await harness.tick();
        assert.deepEqual(order, ['cancel answered', 'gate opened'], 'and no notice was raised after it');
      } finally {
        open();
        await passing.catch(() => undefined);
      }
    },
    { workflows: { parts: [{ executors: [find] }], notifier } },
  );
});

test('M7: a step claimed just before the cancel lands is not executed', { skip: WINDOWS_SKIP }, async () => {
  let harnessOf: LaneHarness | undefined;
  let found = 0;
  const notices: string[] = [];
  const notifier: Notifier = async (notice) => {
    notices.push(notice.body);
    return { raised: true };
  };
  // The cancel lands while the engine fences the find step's claim: between its claim and its executor.
  const find = standIn('find-session', () => {
    found += 1;
    return FOUND;
  });
  let cancelled = false;
  await withLaneOwner(
    async (harness) => {
      harnessOf = harness;
      await enable(
        harness,
        flowRule({
          start: 'find',
          steps: { find: findStep({ idle: 'tell' }), tell: { kind: 'notify', text: 'found it', next: {} } },
        }),
      );
      harness.mailbox.send('find me a session');
      await harness.tick();
      await harness.tick();
      assert.equal(cancelled, true, 'the cancel ran after the claim');
      assert.equal(found, 0, 'the claimed step was never executed');
      assert.deepEqual(notices, []);
      assert.equal(onlyRun(harness).state, 'cancelled');
    },
    {
      workflows: {
        parts: [{ executors: [find] }],
        notifier,
        failpoint: (point) => {
          if (point !== 'after-claim' || cancelled || harnessOf === undefined) return;
          cancelled = true;
          const { id } = onlyRun(harnessOf);
          withDatabase(harnessOf.stateDir, (database) =>
            endRunInTransaction(database, {
              runId: id,
              state: 'cancelled',
              code: 'CANCELLED_BY_PERSON',
              now: Date.now(),
            }),
          );
        },
      },
    },
  );
});

/** A write on a second connection to the owner's store, in its own immediate transaction, as another writer's. */
function withDatabase<T>(stateDir: string, write: (database: DatabaseSync) => T): T {
  const database = new DatabaseSync(eventPaths(stateDir).database);
  try {
    database.exec('PRAGMA busy_timeout = 5000');
    return inTransaction(database, () => write(database));
  } finally {
    database.close();
  }
}

function inTransaction<T>(database: DatabaseSync, work: () => T): T {
  database.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    database.exec('COMMIT');
    return result;
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

/** A loopback webhook receiver that answers 200 and counts what reached it. */
async function receiver(): Promise<{ readonly url: string; readonly received: () => number; close(): Promise<void> }> {
  let received = 0;
  const server = await startLoopbackReceiver((socket: Socket) => {
    let buffer = '';
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('latin1');
      if (!buffer.includes('\r\n\r\n')) return;
      received += 1;
      socket.end('HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  return {
    url: `http://127.0.0.1:${server.port}/hooks/events`,
    received: () => received,
    close: () => server.close(),
  };
}

function eventState(harness: LiveEventsHarness, eventId: string) {
  return {
    event: (
      harness.database.prepare('SELECT state FROM workflow_events WHERE id = ?').get(eventId) as { state: string }
    ).state,
    delivery: {
      ...(harness.database
        .prepare('SELECT state, last_error_code FROM event_deliveries WHERE event_id = ?')
        .get(eventId) as { state: string; last_error_code: string | null }),
    },
    frames: (
      harness.database.prepare('SELECT COUNT(*) AS count FROM event_stream_log WHERE event_id = ?').get(eventId) as {
        count: number;
      }
    ).count,
  };
}

function runOf(harness: LiveEventsHarness, eventId: string): string {
  return (
    harness.database.prepare('SELECT run_id FROM workflow_events WHERE id = ?').get(eventId) as { run_id: string }
  ).run_id;
}

/** Cancels a run as `runs cancel` and every ending of authority do, on the test's own connection. */
function cancelRun(harness: LiveEventsHarness, runId: string): void {
  inTransaction(harness.database, () =>
    endRunInTransaction(harness.database, { runId, state: 'cancelled', code: 'CANCELLED_BY_PERSON', now: Date.now() }),
  );
}

for (const kind of ['sse', 'webhook'] as const)
  test(`L1: a run cancelled while its event is being sent to a ${kind} subscriber sends nothing`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const hook = await receiver();
    const port = await freePort();
    let cancelDuring: ((eventId: string) => void) | undefined;
    try {
      await withLiveEvents(
        [
          {
            document:
              kind === 'sse' ? sseSubscriber({ port, patterns: ['acme.*.*.*'] }) : webhookSubscriber({ url: hook.url }),
          },
        ],
        async (harness) => {
          if (kind === 'webhook') {
            const made = await runCli(
              harness.stateDir,
              ['subscriber', 'secret', 'create', 'crm-hook', '--version', '1'],
              {
                tty: true,
                json: false,
              },
            );
            assert.equal(made.code, 0, made.err);
          }
          let cancelled = false;
          cancelDuring = (eventId) => {
            if (cancelled) return;
            cancelled = true;
            cancelRun(harness, runOf(harness, eventId));
          };
          const [eventId] = (await harness.raise((runView, workflow) => [
            issueCreated(runView, workflow, Date.now()),
          ])) as [string];
          await harness.tick();
          assert.equal(cancelled, true, 'the cancel landed after the claim and the fence');
          assert.deepEqual(eventState(harness, eventId), {
            event: 'cancelled',
            delivery: { state: 'cancelled', last_error_code: 'CANCELLED_BY_PERSON' },
            frames: 0,
          });
          assert.equal(hook.received(), 0, 'nothing reached the webhook');
        },
        {
          eventDispatchTestPoint: async (point, claim) => {
            if (point === 'after-fence') cancelDuring?.(claim.eventId);
          },
        },
      );
    } finally {
      await hook.close();
    }
  });

/** The run's own `cancelled` event, as `runs cancel` raises it after ending the run, for a flow that ticks it. */
function runCancelled(
  runView: RunView,
  workflow: CanonicalFullRuleDocument & { flow: FlowDocumentV1 },
): StepTransition {
  const events = workflow.flow.events;
  assert.ok(events, 'the example flow names its events');
  return {
    run: runView,
    rule: { ...workflow, flow: { ...workflow.flow, events: { ...events, run: ['cancelled'] } } },
    stepId: null,
    transition: 'run-cancelled',
    outcome: null,
    output: { steps: 1, endCode: 'CANCELLED_BY_PERSON' },
    attempt: 0,
    index: 0,
    path: [],
    durationMs: null,
    error: 'CANCELLED_BY_PERSON',
    nextAt: null,
    wait: null,
    at: Date.now(),
  };
}

test('L1: after a cancel a live subscriber replays none of the run’s frames, only the run’s own cancelled event', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) }], async (harness) => {
    const raise = async () =>
      ((await harness.raise((runView, workflow) => [issueCreated(runView, workflow, Date.now())])) as [string])[0];
    const cancelledByCancel = await raise();
    const runCancelledByHand = await raise();
    const eventCancelledByHand = await raise();
    await harness.tick();
    for (const eventId of [cancelledByCancel, runCancelledByHand, eventCancelledByHand])
      assert.equal(eventState(harness, eventId).frames, 1, 'delivered into the log, with no stream open');
    // The person cancels the first run: its delivered frames go with it.
    cancelRun(harness, runOf(harness, cancelledByCancel));
    assert.equal(eventState(harness, cancelledByCancel).frames, 0, 'a cancelled run’s frames are deleted');
    // A frame whose run is cancelled, or whose event is, is never replayed, whatever is left in the log.
    harness.database
      .prepare(
        "UPDATE workflow_runs SET state = 'cancelled', end_code = 'CANCELLED_BY_PERSON', encrypted_record = NULL WHERE id = ?",
      )
      .run(runOf(harness, runCancelledByHand));
    harness.database
      .prepare("UPDATE workflow_events SET state = 'cancelled', encrypted_record = NULL WHERE id = ?")
      .run(eventCancelledByHand);
    // The run's own `cancelled` event, raised after its run ended, still goes out and replays.
    const [cancelledEvent] = (await harness.raise((runView, workflow) => [runCancelled(runView, workflow)])) as [
      string,
    ];
    harness.database
      .prepare("UPDATE workflow_runs SET state = 'cancelled', end_code = 'CANCELLED_BY_PERSON' WHERE id = ?")
      .run(runOf(harness, cancelledEvent));
    await harness.tick();
    assert.equal(eventState(harness, cancelledEvent).delivery.state, 'delivered');
    const stream = await openSse({
      port,
      subscriberId: 'events-dashboard',
      token: harness.tokens.get('events-dashboard') ?? '',
    });
    try {
      await stream.waitFor(1);
      await delay(300);
      assert.deepEqual(
        stream.frames().map((frame) => [frame.id, frame.event]),
        [[cancelledEvent, 'acme.client-asks.run.cancelled']],
      );
    } finally {
      stream.close();
    }
  });
});

test('L2: a run that ends at STEP_LIMIT cancels its deliveries still waiting and purges their records', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'look', steps: { look: findStep() } }));
      harness.mailbox.send('again and again');
      await harness.tick();
      const { id: runId, decision_id: decisionId } = onlyRun(harness);
      // Two deliveries the run made that still wait — one queued, one for its retry — not due before the run ends.
      withDatabase(harness.stateDir, (database) => {
        for (const [id, state] of [
          ['del-queued', 'queued'],
          ['del-retry', 'retryable'],
        ] as const)
          database
            .prepare(
              `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id,
                                       target_version, encrypted_record, expires_at, state, next_at, switch_generation,
                                       run_id, step_id)
               VALUES (?, ?, ?, ?, 1, ?, 'dry-david', 1, X'00', ?, ?, ?, 1, ?, 'look')`,
            )
            .run(
              id,
              decisionId,
              ACCOUNT,
              RULE,
              `dry-run:dry-david:1#${id}`,
              Date.now() + DAY,
              state,
              Date.now() + DAY,
              runId,
            );
      });
      for (let index = 0; index < 8 && onlyRun(harness).state !== 'failed'; index += 1) await harness.tick();
      const ended = onlyRun(harness);
      assert.deepEqual([ended.state, ended.end_code, ended.executed_steps], ['failed', 'STEP_LIMIT', 64]);
      const deliveries = readDatabase(harness.stateDir, (database) =>
        database
          .prepare(
            `SELECT id, state, last_error_code, CASE WHEN encrypted_record IS NULL THEN 0 ELSE 1 END AS sealed
               FROM deliveries WHERE run_id = ? ORDER BY id`,
          )
          .all(runId),
      ) as Array<Record<string, unknown>>;
      assert.deepEqual(
        deliveries.map((row) => ({ ...row })),
        [
          { id: 'del-queued', state: 'cancelled', last_error_code: 'STEP_LIMIT', sealed: 0 },
          { id: 'del-retry', state: 'cancelled', last_error_code: 'STEP_LIMIT', sealed: 0 },
        ],
      );
    },
    {
      workflows: {
        parts: [
          { executors: [standIn('find-session', (ctx) => ({ kind: 'retry', at: ctx.now(), code: 'RELAY_DOWN' }))] },
        ],
      },
    },
  );
});

test('L2: a step a limit holds is not counted again each time it wakes, so the limit never ends the run', {
  skip: WINDOWS_SKIP,
}, async () => {
  let tries = 0;
  // A session start the hour's limit holds 70 times over before it fits: each wake is the same step going on.
  const held = standIn('find-session', (ctx) => {
    tries += 1;
    return tries <= 70 ? { kind: 'wait', wait: 'limit', key: null, wakeAt: ctx.now() } : FOUND;
  });
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'look', steps: { look: findStep() } }));
      harness.mailbox.send('wait for the window');
      await harness.tick();
      for (let index = 0; index < 10 && !['done', 'failed'].includes(onlyRun(harness).state); index += 1)
        await harness.tick();
      const ended = onlyRun(harness);
      assert.deepEqual([ended.state, ended.end_code], ['done', null], 'the limit held the step; it never dropped it');
      assert.equal(ended.executed_steps, 1, 'one executed step: its wakes on the limit are not counted');
      assert.deepEqual(stepsOf(harness, ended.id), { look: { state: 'done', attempts: 71 } });
    },
    { workflows: { parts: [{ executors: [held] }] } },
  );
});
