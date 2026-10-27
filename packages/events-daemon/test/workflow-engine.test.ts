import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import type { Notifier } from '@agentcomms/core';
import type { StepKind } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { eventPaths } from '../src/runtime/paths.ts';
import type {
  StepContext,
  StepExecutor,
  StepResult,
  StepTransition,
  WakeReason,
  WorkflowComposition,
} from '../src/runtime/workflow/contracts.ts';
import { ALIAS, type LaneHarness, RULE, readDatabase, rule, withLaneOwner } from './support/lane-harness.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';

assertLoopbackSeal();

/*
 * B2 (workflows plan): the engine inside a real owner — a fake mailbox, stand-ins for the step kinds other tracks add,
 * a recording notifier and sink, and a clock the test moves. A match of a workflow with a flow makes one run; its
 * steps are claimed and settled once, through their arrows; a split runs every branch; a settle skips what it closed;
 * limits hold a run or a step and never drop it; a run's deadline expires it; and the end of its authority cancels it.
 */

const HOUR = 3_600_000;

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

function clock(): { readonly now: () => number; advance(ms: number): void } {
  let offset = 0;
  return {
    now: () => Date.now() + offset,
    advance(ms) {
      offset += ms;
    },
  };
}

type Notice = Parameters<Notifier>[0];

function recordingNotifier(answer: { raised: boolean } = { raised: true }): {
  readonly notices: Notice[];
  readonly notifier: Notifier;
} {
  const notices: Notice[] = [];
  return {
    notices,
    notifier: async (notice) => {
      notices.push(notice);
      return answer.raised ? { raised: true } : { raised: false, reason: 'a test notifier' };
    },
  };
}

/** A stand-in for a kind another track adds: `run` answers, `resume` answers a wake. */
function standIn(
  kind: StepKind,
  run: (ctx: StepContext) => StepResult | Promise<StepResult>,
  resume: (ctx: StepContext, wake: WakeReason) => StepResult | Promise<StepResult> = run,
): StepExecutor {
  return { kind, run: async (ctx) => run(ctx), resume: async (ctx, wake) => resume(ctx, wake) };
}

/** A sink that records every transition, in the order the engine commits them, inside its transactions. */
function recordingSink(): { readonly transitions: StepTransition[]; readonly part: WorkflowComposition } {
  const transitions: StepTransition[] = [];
  return {
    transitions,
    part: {
      executors: [],
      sink: {
        prepare: async (batch) => ({ rows: batch }),
        commitInTransaction: (_database, prepared) => {
          transitions.push(...(prepared.rows as StepTransition[]));
        },
      },
    },
  };
}

/** A wait that holds for an hour, then elapses: a run that stays live while the test looks. */
const holdForAnHour = standIn(
  'wait',
  (ctx) => ({ kind: 'wait', wait: 'time', key: null, wakeAt: ctx.now() + HOUR }),
  () => ({ kind: 'settled', outcome: 'elapsed', output: { for: 'time', reported: null } }),
);

const waitStep = { kind: 'wait', for: { time: { afterMs: HOUR } }, timeoutMs: 2 * HOUR, next: {} };

/** Creates the workflow `document` with its targets, approves it and switches collection on, as the person does. */
async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  for (const target of document.targets as Record<string, unknown>[])
    await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document });
  await harness.approve(document.version as number);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

const flowRule = (flow: Record<string, unknown>, condition?: Record<string, unknown>): Record<string, unknown> => ({
  ...rule(1, [], condition),
  flow: { flowVersion: 1, limits: limits(), ...flow },
});

interface RunRowSeen {
  readonly id: string;
  readonly decision_id: string;
  readonly state: string;
  readonly end_code: string | null;
  readonly executed_steps: number;
  readonly sealed: number;
  readonly started_at: number;
}

function runs(harness: LaneHarness): readonly RunRowSeen[] {
  return readDatabase(
    harness.stateDir,
    (database) =>
      database
        .prepare(
          `SELECT id, decision_id, state, end_code, executed_steps, started_at,
                  CASE WHEN encrypted_record IS NULL THEN 0 ELSE 1 END AS sealed
             FROM workflow_runs ORDER BY started_at, id`,
        )
        .all() as unknown as RunRowSeen[],
  );
}

function steps(harness: LaneHarness, runId: string): Record<string, { state: string; outcome: string | null }> {
  return Object.fromEntries(
    (
      readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT step_id, state, outcome FROM workflow_steps WHERE run_id = ?').all(runId),
      ) as Array<{ step_id: string; state: string; outcome: string | null }>
    ).map((row) => [row.step_id, { state: row.state, outcome: row.outcome }]),
  );
}

/** Sends a mail and ticks once: the owner polls it and decides it. */
async function send(harness: LaneHarness, subject: string): Promise<void> {
  harness.mailbox.send(subject);
  await harness.tick();
}

test('B2: a match of a flow workflow makes one run and no delivery, in the decision’s transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const time = clock();
  const { notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({ start: 'tell', steps: { tell: { kind: 'notify', text: 'a mail came', next: {} } } }),
      );
      await send(harness, 'Invoice 42');
      const [run, ...others] = runs(harness);
      assert.equal(others.length, 0);
      assert.equal(run?.state, 'held');
      assert.equal(run?.sealed, 1, 'the mapped values are sealed in the run');
      const decision = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT id, outcome FROM decisions').get(),
      ) as { id: string; outcome: string };
      assert.deepEqual({ ...decision }, { id: run?.decision_id, outcome: 'matched' });
      assert.equal(
        (
          readDatabase(harness.stateDir, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM deliveries').get(),
          ) as { count: number }
        ).count,
        0,
      );
      assert.match(run?.id ?? '', /^wfr_[0-9a-hjkmnp-tv-z]{26}$/u);
    },
    { now: time.now, workflows: { notifier } },
  );
});

test('B2: a no-match makes no run', { skip: WINDOWS_SKIP }, async () => {
  const { notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule(
          { start: 'tell', steps: { tell: { kind: 'notify', text: 'an invoice', next: {} } } },
          { path: '/subject', op: 'contains', value: 'invoice', caseSensitive: false },
        ),
      );
      await send(harness, 'Lunch on Friday');
      await harness.tick();
      assert.deepEqual(runs(harness), []);
      const decision = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT outcome FROM decisions').get(),
      ) as { outcome: string };
      assert.equal(decision.outcome, 'no-match');
    },
    { workflows: { notifier } },
  );
});

test('B2: condition yes and no follow their arrows; an outcome with no arrow ends that branch', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { notices, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'check',
          steps: {
            check: {
              kind: 'condition',
              when: { path: '/fields/subject', op: 'contains', value: 'urgent', caseSensitive: false },
              next: { yes: 'shout' },
            },
            shout: { kind: 'notify', text: 'An urgent mail, run {{run}}', next: {} },
          },
        }),
      );
      await send(harness, 'URGENT: the site is down');
      await harness.tick();
      await send(harness, 'calm news');
      await harness.tick();
      const [urgent, calm] = runs(harness);
      assert.deepEqual(steps(harness, urgent?.id ?? ''), {
        check: { state: 'done', outcome: 'yes' },
        shout: { state: 'done', outcome: 'sent' },
      });
      assert.deepEqual(steps(harness, calm?.id ?? ''), {
        check: { state: 'done', outcome: 'no' },
        shout: { state: 'skipped', outcome: null },
      });
      assert.equal(urgent?.state, 'done');
      assert.equal(calm?.state, 'done');
      assert.equal(urgent?.sealed, 0, 'a run that ends purges its record');
      assert.equal(notices.length, 1);
      assert.equal(notices[0]?.body, `Workflow ${RULE}: An urgent mail, run ${urgent?.id}`);
    },
    { workflows: { notifier } },
  );
});

test('B2: split runs every branch; the run is done when all are', { skip: WINDOWS_SKIP }, async () => {
  const { notices, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'both',
          steps: {
            both: { kind: 'split', branches: ['left', 'right'] },
            left: { kind: 'notify', text: 'left', next: {} },
            right: { kind: 'notify', text: 'right', next: { sent: 'after' } },
            after: { kind: 'notify', text: 'after right', next: {} },
          },
        }),
      );
      await send(harness, 'Two ways');
      await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'done');
      assert.deepEqual(notices.map((notice) => notice.body).sort(), [
        `Workflow ${RULE}: after right`,
        `Workflow ${RULE}: left`,
        `Workflow ${RULE}: right`,
      ]);
      assert.equal(steps(harness, run?.id ?? '').both?.outcome, 'split');
    },
    { workflows: { notifier } },
  );
});

/** The owner example (spec §4.4) on the fake mailbox: its targets and flow, its other kinds stood in for. */
function ownerExample(): Record<string, unknown> {
  const example = structuredClone(OWNER_EXAMPLE) as unknown as Record<string, unknown> & {
    flow: { steps: Record<string, Record<string, unknown>> };
  };
  // The route step is stood in for; it chooses by hints alone here, so its judge version need not be stored.
  const { judge: _judge, ...route } = example.flow.steps.route as Record<string, unknown>;
  example.flow.steps.route = { ...route, by: ['hints'] };
  return {
    ...rule(1, example.targets as Record<string, unknown>[]),
    // The session target can leave a match in the Queue, whose item names its sender (action queue Q4).
    mapping: {
      from: { $path: '/from' },
      subject: { $path: '/subject' },
      text: { $path: '/subject' },
      author: { name: { $path: '/from/name' } },
    },
    retention: example.retention,
    flow: example.flow,
  };
}

const ownerStandIns: readonly StepExecutor[] = [
  standIn('route', () => ({
    kind: 'settled',
    outcome: 'chosen',
    output: {
      project: 'acme-site',
      projectName: 'acme-site',
      reason: 'hint:sender-domain',
      score: null,
      profileHash: 'x',
    },
  })),
  standIn('deliver', (ctx) => ({
    kind: 'settled',
    outcome: 'done',
    output:
      ctx.stepId === 'issue'
        ? { delivery: 'd-issue', issue: { id: 'i-1', identifier: 'ACME-1', url: 'https://linear.app/x/issue/ACME-1' } }
        : { delivery: `d-${ctx.stepId}` },
  })),
  standIn('find-session', () => ({
    kind: 'settled',
    outcome: 'idle',
    output: { session: 'sess_stand-in', provider: 'claude' },
  })),
  standIn('wait', () => ({ kind: 'settled', outcome: 'done', output: { for: 'turn-end', reported: 'done' } })),
];

test('B2: every transition goes through the sink, in order, inside the settle; a settle marks the steps it closed skipped', {
  skip: WINDOWS_SKIP,
}, async () => {
  const sink = recordingSink();
  const { notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      // The route step's candidates are the person's projects now (W12): the example's two, folders and all.
      const write = new DatabaseSync(eventPaths(harness.stateDir).database);
      try {
        for (const name of ['acme-site', 'billing']) {
          write
            .prepare('INSERT INTO projects (id, name, repo, created_at, updated_at) VALUES (?, ?, ?, 1, 1)')
            .run(name, name, `github.com/acme/${name}`);
          write
            .prepare("INSERT INTO project_folders (folder, project_id, kind) VALUES (?, ?, 'checkout')")
            .run(`/example/home/work/${name}`, name);
        }
      } finally {
        write.close();
      }
      await enable(harness, ownerExample());
      await send(harness, 'Please change the banner');
      await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'done', JSON.stringify(steps(harness, run?.id ?? '')));
      const seen = sink.transitions.map((transition) => `${transition.stepId ?? 'run'}:${transition.transition}`);
      assert.deepEqual(seen.slice(0, 4), ['run:run-started', 'route:started', 'route:succeeded', 'found:started']);
      const afterFind = seen.indexOf('find:succeeded');
      assert.deepEqual(seen.slice(afterFind + 1, afterFind + 5), [
        'free:skipped',
        'another:skipped',
        'tree:skipped',
        'start:skipped',
      ]);
      assert.equal(seen.at(-1), 'run:run-finished');
      assert.ok(seen.includes('tell:skipped'));
      // Each event carries where the run is: the path so far, and the step's place in the printed order.
      const issue = sink.transitions.find(
        (transition) => transition.stepId === 'issue' && transition.transition === 'succeeded',
      );
      assert.deepEqual(issue?.path, ['route', 'found', 'issue']);
      assert.equal(issue?.index, 3);
      assert.equal(issue?.outcome, 'done');
      const skipped = Object.entries(steps(harness, run?.id ?? ''))
        .filter(([, step]) => step.state === 'skipped')
        .map(([id]) => id)
        .sort();
      assert.deepEqual(skipped, ['another', 'free', 'start', 'tell', 'tree']);
    },
    { workflows: { notifier, parts: [sink.part, { executors: ownerStandIns }] } },
  );
});

test('B2: 64 executed steps end the run failed with STEP_LIMIT', { skip: WINDOWS_SKIP }, async () => {
  const sink = recordingSink();
  let tries = 0;
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'look',
          steps: {
            look: { kind: 'find-session', in: { folder: '/example/home/work/x' }, provider: 'claude', next: {} },
          },
        }),
      );
      await send(harness, 'Again and again');
      for (let index = 0; index < 8 && runs(harness)[0]?.state !== 'failed'; index += 1) await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'failed');
      assert.equal(run?.end_code, 'STEP_LIMIT');
      assert.equal(run?.executed_steps, 64);
      assert.equal(tries, 64);
      assert.equal(steps(harness, run?.id ?? '').look?.state, 'cancelled');
      assert.equal(sink.transitions.at(-1)?.transition, 'run-failed');
    },
    {
      workflows: {
        parts: [
          sink.part,
          {
            executors: [
              standIn('find-session', (ctx) => {
                tries += 1;
                return { kind: 'retry', at: ctx.now(), code: 'RELAY_DOWN' };
              }),
            ],
          },
        ],
      },
    },
  );
});

test('B2: past concurrentRuns a run is held and starts in order, oldest first', { skip: WINDOWS_SKIP }, async () => {
  const time = clock();
  const sink = recordingSink();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({ start: 'pause', limits: limits({ concurrentRuns: 1 }), steps: { pause: waitStep } }),
      );
      await send(harness, 'first');
      await send(harness, 'second');
      await send(harness, 'third');
      await harness.tick();
      const [first, second, third] = runs(harness);
      assert.deepEqual(
        [first?.state, second?.state, third?.state],
        ['waiting', 'held', 'held'],
        'one at a time; the others wait their turn',
      );
      const held = sink.transitions.filter((transition) => transition.transition === 'run-held');
      assert.deepEqual(
        held.map((transition) => transition.run.id),
        [second?.id, third?.id],
        'each held run is announced held once',
      );
      time.advance(HOUR + 1);
      await harness.tick();
      const after = runs(harness);
      assert.deepEqual(
        after.map((run) => run.state),
        ['done', 'waiting', 'held'],
        'the oldest held run starts when the first ends',
      );
      assert.equal(sink.transitions.filter((transition) => transition.transition === 'run-held').length, 2);
    },
    { now: time.now, workflows: { parts: [sink.part, { executors: [holdForAnHour] }] } },
  );
});

test('B2: runsPerHour 1: the second run waits for the window, never dropped', { skip: WINDOWS_SKIP }, async () => {
  const time = clock();
  const { notices, notifier } = recordingNotifier();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'tell',
          limits: limits({ runsPerHour: 1 }),
          steps: { tell: { kind: 'notify', text: 'one an hour', next: {} } },
        }),
      );
      await send(harness, 'first');
      await send(harness, 'second');
      await harness.tick();
      assert.deepEqual(
        runs(harness).map((run) => run.state),
        ['done', 'held'],
      );
      const waiting = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT kind, wake_at FROM workflow_waits').all(),
      ) as Array<{ kind: string; wake_at: number }>;
      assert.equal(waiting.length, 1);
      assert.equal(waiting[0]?.kind, 'limit');
      time.advance(HOUR / 2);
      await harness.tick();
      assert.equal(runs(harness)[1]?.state, 'held', 'still inside the hour');
      time.advance(HOUR / 2 + 1);
      await harness.tick();
      assert.deepEqual(
        runs(harness).map((run) => run.state),
        ['done', 'done'],
      );
      assert.equal(notices.length, 2);
    },
    { now: time.now, workflows: { notifier } },
  );
});

test('B2: at expires_at the run is expired, its steps cancelled and its sealed record purged', {
  skip: WINDOWS_SKIP,
}, async () => {
  const time = clock();
  const sink = recordingSink();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'pause',
          limits: limits({ runMs: 60_000 }),
          steps: { pause: { ...waitStep, for: { time: { afterMs: 30_000 } }, timeoutMs: 60_000 } },
        }),
      );
      await send(harness, 'soon gone');
      await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'waiting');
      const wake = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT wake_at FROM workflow_waits').get(),
      ) as { wake_at: number };
      assert.ok(wake.wake_at <= (run?.started_at ?? 0) + 60_000, 'a wait wakes within the run’s deadline');
      time.advance(61_000);
      await harness.tick();
      const [expired] = runs(harness);
      assert.equal(expired?.state, 'expired');
      assert.equal(expired?.end_code, 'RUN_EXPIRED');
      assert.equal(expired?.sealed, 0);
      assert.equal(steps(harness, expired?.id ?? '').pause?.state, 'cancelled');
      assert.equal(
        (
          readDatabase(harness.stateDir, (database) =>
            database.prepare('SELECT COUNT(*) AS count FROM workflow_waits').get(),
          ) as { count: number }
        ).count,
        0,
      );
      assert.equal(sink.transitions.at(-1)?.transition, 'run-expired');
    },
    { now: time.now, workflows: { parts: [sink.part, { executors: [holdForAnHour] }] } },
  );
});

test('B2: notify raises once per step per run, never fails the run', { skip: WINDOWS_SKIP }, async () => {
  const { notices, notifier } = recordingNotifier({ raised: false });
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({ start: 'tell', steps: { tell: { kind: 'notify', text: 'no screen', next: {} } } }),
      );
      await send(harness, 'unseen');
      await harness.tick();
      await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'done');
      assert.equal(notices.length, 1, 'raised once');
      const output = readDatabase(harness.stateDir, (database) =>
        database.prepare("SELECT output FROM workflow_steps WHERE step_id = 'tell'").get(),
      ) as { output: string };
      assert.deepEqual(JSON.parse(output.output), { raised: false });
    },
    { workflows: { notifier } },
  );
});

test('B2: a revoked version cancels its runs, at its revocation and at the next claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  const time = clock();
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      await send(harness, 'one');
      await harness.tick();
      // A version whose authority is gone some other way is refused by the fence at its next claim.
      const write = new DatabaseSync(eventPaths(harness.stateDir).database);
      try {
        write.prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = 1 WHERE rule_id = ?").run(RULE);
      } finally {
        write.close();
      }
      time.advance(HOUR + 1);
      await harness.tick();
      const [fenced] = runs(harness);
      assert.equal(fenced?.state, 'cancelled');
      assert.equal(fenced?.end_code, 'RULE_REVOKED');
      assert.equal(fenced?.sealed, 0);
    },
    { now: time.now, workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      await send(harness, 'two');
      await harness.tick();
      assert.equal(runs(harness)[0]?.state, 'waiting');
      await harness.control.request('rule-disable', { ruleId: RULE });
      const [revoked] = runs(harness);
      assert.equal(revoked?.state, 'cancelled');
      assert.equal(revoked?.end_code, 'AUTHORIZATION_REVOKED');
      assert.equal(revoked?.sealed, 0);
      assert.equal(steps(harness, revoked?.id ?? '').pause?.state, 'cancelled');
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});

test('B2: removing the run’s account, and disable-all, cancel its runs', { skip: WINDOWS_SKIP }, async () => {
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      await send(harness, 'one');
      await harness.tick();
      assert.equal(runs(harness)[0]?.state, 'waiting');
      await harness.control.request('disable-all');
      const [run] = runs(harness);
      assert.equal(run?.state, 'cancelled');
      assert.equal(run?.end_code, 'DISABLED_ALL');
      assert.equal(run?.sealed, 0);
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      await send(harness, 'two');
      await harness.tick();
      assert.equal(runs(harness)[0]?.state, 'waiting');
      const configFile = join(dirname(harness.stateDir), 'config', 'config.json');
      const config = JSON.parse(await readFile(configFile, 'utf8')) as { inboxes: Record<string, unknown> };
      delete config.inboxes[ALIAS];
      await writeFile(configFile, `${JSON.stringify(config)}\n`);
      await harness.tick();
      const [run] = runs(harness);
      assert.equal(run?.state, 'cancelled');
      assert.equal(run?.end_code, 'ACCOUNT_REMOVED');
      assert.equal(run?.sealed, 0);
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});
