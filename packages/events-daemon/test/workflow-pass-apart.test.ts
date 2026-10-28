import assert from 'node:assert/strict';
import { mkdir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import type { DesktopOrigin, Notifier } from '@agentcomms/core';
import type { StepKind } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type { StepContext, StepExecutor, StepResult } from '../src/runtime/workflow/contracts.ts';
import type { RunCancelResultV1 } from '../src/runtime/workflow/run-show.ts';
import { runCli, webhookSubscriber } from './support/events-owner.ts';
import { FakeRelay } from './support/fake-relay.ts';
import {
  ACCOUNT,
  DAY,
  type LaneHarness,
  lane,
  RULE,
  readDatabase,
  rule,
  withLaneOwner,
} from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * 0.37.0 §1 and §4: the workflow engine's pass runs apart from the owner's tick. A slow step — a find whose relay has not
 * answered, a worktree, a judge — holds back neither the sources' polls nor any delivery, and steps of different runs
 * run side by side, four at most, never two of one run. A pass holds the owner's shared writer lease for its whole
 * length, so a key rotation waits for it, and a pass that starts while a rotation waits waits in turn. And `runs cancel
 * --interrupt` asks the relay at once; only the cleanup waits for the pass.
 *
 * A real owner with a fake mailbox, stand-ins for the slow steps, a stand-in home and secret store, and a fake relay.
 * Where a test says so, the owner runs on its own quick timer, as on the person's Mac, and the test ticks nothing.
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

const contains = (word: string): Record<string, unknown> => ({
  path: '/subject',
  op: 'contains',
  value: word,
  caseSensitive: false,
});

const flowRule = (
  flow: Record<string, unknown>,
  options: { readonly condition?: Record<string, unknown>; readonly limits?: Record<string, number> } = {},
): Record<string, unknown> => ({
  ...rule(1, [], options.condition),
  flow: { flowVersion: 1, limits: limits(options.limits), ...flow },
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

/** Approves one workflow's version, as the person does at a terminal. */
async function approve(harness: LaneHarness, ruleId: string, version = 1): Promise<void> {
  const planned = (await harness.control.request('rule-enable', { ruleId, version })) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: planned.approvalId })) as string;
  await harness.control.request('approve', { approvalId: planned.approvalId, answer: challenge });
}

/** Switches collection on, as the person does once. */
async function enableAll(harness: LaneHarness): Promise<void> {
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  await harness.control.request('rule-create', { document });
  await approve(harness, document.ruleId as string, document.version as number);
  await enableAll(harness);
}

/**
 * A step that waits at a gate of its own until the test opens it, as a find step waits on a relay that has not
 * answered: which steps came in, which are inside now, and the most inside at once — of all runs, and of one run.
 */
function gated(
  kind: StepKind,
  result: StepResult,
  finish?: (ctx: StepContext) => Promise<void>,
): {
  readonly executor: StepExecutor;
  readonly entered: string[];
  readonly inside: ReadonlySet<string>;
  most(): number;
  mostOfOneRun(): number;
  open(key: string): void;
  openAll(): void;
} {
  const entered: string[] = [];
  const inside = new Set<string>();
  const gates = new Map<string, () => void>();
  let most = 0;
  let mostOfOneRun = 0;
  let opened = false;
  const step = async (ctx: StepContext): Promise<StepResult> => {
    const key = `${ctx.run.id}/${ctx.stepId}`;
    entered.push(key);
    inside.add(key);
    most = Math.max(most, inside.size);
    mostOfOneRun = Math.max(mostOfOneRun, [...inside].filter((entry) => entry.startsWith(`${ctx.run.id}/`)).length);
    try {
      if (!opened) await new Promise<void>((resolve) => gates.set(key, resolve));
      return result;
    } finally {
      inside.delete(key);
    }
  };
  return {
    executor: { kind, run: step, resume: step, ...(finish === undefined ? {} : { finish }) },
    entered,
    inside,
    most: () => most,
    mostOfOneRun: () => mostOfOneRun,
    open(key) {
      gates.get(key)?.();
      gates.delete(key);
    },
    openAll() {
      opened = true;
      for (const open of gates.values()) open();
      gates.clear();
    },
  };
}

/** Waits until `ready` holds, looking every 10 ms, for at most `ms`; fails with `what` if it never does. */
async function until(ready: () => boolean | Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await ready())) {
    if (Date.now() > deadline) assert.fail(`never: ${what}`);
    await delay(10);
  }
}

function runStates(harness: LaneHarness): readonly string[] {
  return (
    readDatabase(harness.stateDir, (database) =>
      database.prepare('SELECT state FROM workflow_runs ORDER BY started_at, id').all(),
    ) as Array<{ state: string }>
  ).map((row) => row.state);
}

function decisions(harness: LaneHarness, outcome: string): number {
  return (
    readDatabase(harness.stateDir, (database) =>
      database.prepare('SELECT COUNT(*) AS count FROM decisions WHERE outcome = ?').get(outcome),
    ) as { count: number }
  ).count;
}

test('0.37 §1: a find step whose relay has not answered holds back neither the owner’s ticks nor another mail’s delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const find = gated('find-session', FOUND);
  const workflows = { parts: [{ executors: [find.executor] }] };
  await withLaneOwner(
    async (harness) => {
      // Two workflows on the mailbox: one whose find step waits on the relay, and one that puts a mail in a lane.
      await harness.control.request('target-add', { document: lane(1) });
      await harness.control.request('rule-create', {
        document: flowRule({ start: 'find', steps: { find: findStep() } }, { condition: contains('find') }),
      });
      await harness.control.request('rule-create', {
        document: { ...rule(1, [lane(1)], contains('plain')), ruleId: 'plain-by-mail' },
      });
      await approve(harness, RULE);
      await approve(harness, 'plain-by-mail');
      await enableAll(harness);
      // From here the owner runs on its own quick timer, as on the person's Mac: the test ticks nothing.
      await harness.restart({ tickMs: 50, workflows });
      try {
        harness.mailbox.send('find me a session');
        await until(() => find.inside.size === 1, 'the find step is waiting on its relay');
        // A mail that arrives meanwhile is polled, decided and delivered to its lane while the step still waits.
        harness.mailbox.send('plain news');
        await until(async () => (await harness.openCount()) === 1, 'the plain mail reaches its lane', 5_000);
        assert.equal(find.inside.size, 1, 'and the find step is still waiting');
        assert.deepEqual(runStates(harness), ['running']);
        find.openAll();
        await until(() => runStates(harness)[0] === 'done', 'the run ends once the relay answers');
      } finally {
        find.openAll();
      }
    },
    { workflows },
  );
});

test('0.37 §1: six runs at a slow step — four run at once, then the other two, while the owner’s ticks go on', {
  skip: WINDOWS_SKIP,
}, async () => {
  const slow = gated('find-session', FOUND);
  const workflows = { parts: [{ executors: [slow.executor] }] };
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule(
          { start: 'find', steps: { find: findStep() } },
          { condition: contains('slow'), limits: { concurrentRuns: 6 } },
        ),
      );
      await harness.restart({ tickMs: 50, workflows });
      try {
        for (let index = 1; index <= 6; index += 1) harness.mailbox.send(`slow mail ${index}`);
        await until(() => slow.entered.length === 4, 'four runs are inside their slow step');
        await delay(300);
        assert.equal(slow.inside.size, 4, 'four at once, and no fifth');
        assert.equal(slow.entered.length, 4);
        // The owner's ticks return while the four run: a later mail is polled and decided.
        harness.mailbox.send('unrelated news');
        await until(() => decisions(harness, 'no-match') === 1, 'a later mail is decided while the four run', 5_000);
        assert.equal(slow.inside.size, 4, 'and the four are still inside');
        const first = [...slow.entered];
        for (const key of first) slow.open(key);
        await until(() => slow.entered.length === 6, 'the other two run once the first four are done');
        assert.equal(slow.most(), 4, 'never more than four at once');
        assert.deepEqual(slow.entered.slice(0, 4), first);
        slow.openAll();
        await until(
          () => runStates(harness).length === 6 && runStates(harness).every((state) => state === 'done'),
          'all six end',
        );
      } finally {
        slow.openAll();
      }
    },
    { workflows },
  );
});

test('0.37 §1: two steps of one run never run at once, though the pass runs steps of different runs side by side', {
  skip: WINDOWS_SKIP,
}, async () => {
  const slow = gated('find-session', FOUND);
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({
          start: 'both',
          steps: {
            both: { kind: 'split', branches: ['left', 'right'] },
            left: findStep(),
            right: findStep(),
          },
        }),
      );
      harness.mailbox.send('one');
      harness.mailbox.send('two');
      await harness.tick();
      // The owner's own tick seam waits for the pass: it is let go of here, step by step.
      const passing = harness.tick();
      try {
        await until(() => slow.inside.size >= 2, 'each run is inside one of its branches');
        await delay(300);
        assert.equal(slow.inside.size, 2, 'one step of each run, and no more');
        assert.deepEqual(
          slow.entered.map((key) => key.split('/')[1]),
          ['left', 'left'],
          'each run’s first branch, in its order',
        );
        const [left] = slow.entered as [string];
        slow.open(left);
        await until(() => slow.entered.length === 3, 'that run’s next branch runs once its first is done');
        assert.equal(slow.entered[2], `${left.split('/')[0]}/right`);
        slow.openAll();
        await passing;
      } finally {
        slow.openAll();
        await passing.catch(() => undefined);
      }
      assert.equal(slow.most(), 2, 'steps of the two runs ran side by side');
      assert.equal(slow.mostOfOneRun(), 1, 'two steps of one run never did');
      assert.deepEqual(runStates(harness), ['done', 'done']);
    },
    { workflows: { parts: [{ executors: [slow.executor] }] } },
  );
});

test('0.37 §1: a key rotation waits for a running pass, and a pass that starts while it waits waits for it in turn', {
  skip: WINDOWS_SKIP,
}, async () => {
  const find = gated('find-session', FOUND);
  let stateDir = '';
  // The record keys the owner holds, as the tell step's notice finds them.
  const keys = () =>
    (
      readDatabase(stateDir, (database) =>
        database.prepare('SELECT key_id FROM event_secret_masters WHERE retired_at IS NULL ORDER BY key_id').all(),
      ) as Array<{ key_id: string }>
    ).map((row) => row.key_id);
  const seen: Array<readonly string[]> = [];
  const notifier: Notifier = async () => {
    seen.push(keys());
    return { raised: true };
  };
  // The pass claims no new step once its (shortened) budget is spent: tell is left to the next pass.
  const workflows = { parts: [{ executors: [find.executor] }], notifier, passBudgetMs: 100 };
  await withLaneOwner(
    async (harness) => {
      stateDir = harness.stateDir;
      // A webhook subscriber's signing secret: rotating it rotates the owner's record key, under the exclusive lease.
      await harness.control.request('addSubscriber', { document: webhookSubscriber({}) });
      const made = await runCli(harness.stateDir, ['subscriber', 'secret', 'create', 'crm-hook', '--version', '1'], {
        tty: true,
        json: false,
      });
      assert.equal(made.code, 0, made.err);
      await enable(
        harness,
        flowRule({
          start: 'find',
          steps: { find: findStep({ idle: 'tell' }), tell: { kind: 'notify', text: 'found it', next: {} } },
        }),
      );
      await harness.restart({ tickMs: 50, workflows });
      try {
        harness.mailbox.send('find me a session');
        await until(() => find.inside.size === 1, 'the pass is inside the find step');
        // Ticks go on meanwhile, each pumping the engine: the pass in flight is not started twice.
        await delay(200);
        const before = keys();
        const order: string[] = [];
        const rotating = runCli(harness.stateDir, ['subscriber', 'secret', 'rotate', 'crm-hook', '--version', '1'], {
          tty: true,
          json: false,
        }).then((result) => {
          order.push('rotated');
          return result;
        });
        await Promise.race([rotating, delay(500)]);
        assert.equal(order.length, 0, 'the rotation waits for the pass in flight');
        order.push('gate opened');
        find.openAll();
        const rotated = await rotating;
        assert.equal(rotated.code, 0, rotated.err);
        assert.deepEqual(order, ['gate opened', 'rotated']);
        await until(() => seen.length === 1, 'the next pass runs the tell step');
        assert.notDeepEqual(keys(), before, 'the rotation made a new record key');
        assert.deepEqual(seen[0], keys(), 'the pass that ran tell started after the rotation, and waited for it');
        await until(() => runStates(harness)[0] === 'done', 'the run ends');
      } finally {
        find.openAll();
      }
    },
    { workflows },
  );
});

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

test('0.37 §4: runs cancel --interrupt answers at once, interrupted, while the pass is gated; only the cleanup waits', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await realpath(await shortTempDir('aev-pass-interrupt-'));
  const folder = join(root, 'acme');
  await mkdir(folder);
  const relay = await new FakeRelay({ allowedRoots: [root] }).start();
  const home = await relay.writeHome(root);
  const order: string[] = [];
  const find = gated('find-session', FOUND, async (ctx) => {
    order.push(`cleanup of ${ctx.stepId}`);
  });
  try {
    await withLaneOwner(
      async (harness) => {
        const control = new EventControlClient({ stateDir: harness.stateDir, clientName: 'person-setup:terminal' });
        await control.request('integration-set', { integration: 'agent-sessions', relayHome: home });
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
          await until(() => find.inside.size === 1, 'the pass is inside the find step');
          const [{ id: runId, decision_id: decisionId }] = readDatabase(harness.stateDir, (database) =>
            database.prepare('SELECT id, decision_id FROM workflow_runs').all(),
          ) as Array<{ id: string; decision_id: string }> as [{ id: string; decision_id: string }];
          // The run gave a session a turn that is still going, as B4 writes it when it delivers.
          const session = relay.addSession({ cwd: folder });
          const turn = relay.startRunElsewhere(session.id);
          const database = new DatabaseSync(eventPaths(harness.stateDir).database);
          try {
            database
              .prepare(
                `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id,
                                         target_version, expires_at, state, switch_generation, target_kind, run_id, step_id)
                 VALUES (?, ?, ?, ?, 1, 'session:acme-session:1#find', 'acme-session', 1, ?, 'delivered', 1, 'session', ?, 'find')`,
              )
              .run(`del-${runId}`, decisionId, ACCOUNT, RULE, Date.now() + DAY, runId);
            database
              .prepare(
                `INSERT INTO session_deliveries (delivery_id, relay_session_id, started, run_id, chosen_at)
                 VALUES (?, ?, 1, ?, ?)`,
              )
              .run(`del-${runId}`, session.id, turn.id, Date.now());
          } finally {
            database.close();
          }
          const cancelling = person<RunCancelResultV1>(harness.stateDir, ['runs', 'cancel', runId, '--interrupt']).then(
            (result) => {
              order.push('cancel answered');
              return result;
            },
          );
          await Promise.race([cancelling, delay(5_000)]);
          order.push('gate opened');
          find.openAll();
          await passing;
          const cancelled = await cancelling;
          assert.deepEqual(cancelled, {
            runId,
            state: 'cancelled',
            cancelledDeliveries: 0,
            cancelledEvents: 0,
            interrupted: true,
          });
          assert.deepEqual(
            relay.requests
              .filter((request) => request.path.endsWith('/interrupt'))
              .map((request) => [request.method, request.path, request.authorised]),
            [['POST', `/v1/runs/${turn.id}/interrupt`, true]],
          );
          assert.equal(relay.runs.find((entry) => entry.id === turn.id)?.status, 'interrupted');
          assert.deepEqual(
            order,
            ['cancel answered', 'gate opened', 'cleanup of find'],
            'the interrupt was asked before the gate opened; the cleanup ran after it',
          );
        } finally {
          find.openAll();
          await passing.catch(() => undefined);
        }
      },
      {
        agentSessions: { homeDirectory: join(root, 'no-home'), reconcileMs: 60_000 },
        workflows: { parts: [{ executors: [find.executor] }] },
      },
    );
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
});
