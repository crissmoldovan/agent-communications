import assert from 'node:assert/strict';
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { CommsError, type DesktopOrigin } from '@agentcomms/core';
import type { StepKind } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import type { StepContext, StepExecutor, StepResult, WakeReason } from '../src/runtime/workflow/contracts.ts';
import type { RunCancelResultV1, RunShowResultV1, RunsListResultV1 } from '../src/runtime/workflow/run-show.ts';
import { FakeRelay } from './support/fake-relay.ts';
import {
  ACCOUNT,
  ALIAS,
  DAY,
  type LaneHarness,
  RULE,
  readDatabase,
  rule,
  withLaneOwner,
} from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';

assertLoopbackSeal();

/*
 * B6 (workflows plan): a workflow's runs, the person's view of each — `runs list`, `runs show` and `runs cancel` — through
 * the CLI the person and the app run, against a real owner with a fake mailbox, stand-ins for the step kinds other tracks
 * add, a fake relay for a turn to interrupt, and a stand-in home and secret store. None of them is an MCP tool, and each
 * refuses the MCP server's process, an agent's shell and a process the app did not start. A run keeps its version's
 * graph after the workflow is edited; and a run its authority's end cancels still finishes the steps it ran.
 */

const HOUR = 3_600_000;
const PERSON = 'person-setup:terminal';

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

function standIn(
  kind: StepKind,
  run: (ctx: StepContext) => StepResult | Promise<StepResult>,
  resume: (ctx: StepContext, wake: WakeReason) => StepResult | Promise<StepResult> = run,
): StepExecutor {
  return { kind, run: async (ctx) => run(ctx), resume: async (ctx, wake) => resume(ctx, wake) };
}

/** A wait that holds for an hour: a run that stays live while the test looks. */
const holdForAnHour = standIn(
  'wait',
  (ctx) => ({ kind: 'wait', wait: 'time', key: null, wakeAt: ctx.now() + HOUR }),
  () => ({ kind: 'settled', outcome: 'elapsed', output: { for: 'time', reported: null } }),
);

const waitStep = { kind: 'wait', for: { time: { afterMs: HOUR } }, timeoutMs: 2 * HOUR, next: {} };

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  for (const target of document.targets as Record<string, unknown>[])
    await harness.control.request('target-add', { document: target });
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

async function send(harness: LaneHarness, subject: string): Promise<void> {
  harness.mailbox.send(subject);
  await harness.tick();
}

function runIds(harness: LaneHarness): readonly string[] {
  return (
    readDatabase(harness.stateDir, (database) =>
      database.prepare('SELECT id FROM workflow_runs ORDER BY started_at, id').all(),
    ) as Array<{ id: string }>
  ).map((row) => row.id);
}

/**
 * Writes to the owner's database directly, as nothing the person can do would: a row a later track writes, or — with
 * `unbound` — old runs whose decisions retention has long since purged.
 */
function writeDatabase(stateDir: string, write: (database: DatabaseSync) => void, unbound = false): void {
  const database = new DatabaseSync(eventPaths(stateDir).database, { enableForeignKeyConstraints: !unbound });
  try {
    write(database);
  } finally {
    database.close();
  }
}

/** The release app, attested as the process that started the CLI (core's `desktopAppOrigin`, injected). */
const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});
const NOT_THE_APP = async (): Promise<DesktopOrigin> => ({ ok: false, reason: 'not-started-by-the-app' });

async function cli(
  stateDir: string,
  args: readonly string[],
  options: { readonly env?: NodeJS.ProcessEnv; readonly origin?: () => Promise<DesktopOrigin> } = {},
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
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
  const code = await run(['--state-dir', stateDir, '--json', ...args], {
    streams,
    env: options.env ?? {},
    desktopOrigin: options.origin ?? ATTESTED,
  });
  await new Promise((resolve) => setImmediate(resolve));
  return { code, stdout: out, stderr: err };
}

async function json<T>(stateDir: string, args: readonly string[]): Promise<T> {
  const result = await cli(stateDir, args);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}

/** A run id of index `n`, for rows written straight into the table: `wfr_` and 26 characters. */
function fakeRunId(n: number): string {
  const alphabet = '0123456789abcdefghjkmnpqrstvwxyz';
  let text = '';
  let value = n;
  for (let index = 0; index < 26; index += 1) {
    text = alphabet[value % 32] + text;
    value = Math.floor(value / 32);
  }
  return `wfr_${text}`;
}

test('B6: runs list is newest first, at most 200, filtered by --workflow and --state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const time = clock();
  await withLaneOwner(
    async (harness) => {
      await enable(
        harness,
        flowRule({ start: 'pause', limits: limits({ concurrentRuns: 1 }), steps: { pause: waitStep } }),
      );
      for (const subject of ['first', 'second', 'third']) {
        await send(harness, subject);
        time.advance(1_000);
      }
      await harness.tick();
      const [first, second, third] = runIds(harness);
      const listed = await json<RunsListResultV1>(harness.stateDir, ['runs', 'list']);
      assert.deepEqual(
        listed.runs.map((entry) => entry.runId),
        [third, second, first],
        'newest first',
      );
      assert.deepEqual(
        listed.runs.map((entry) => entry.state),
        ['held', 'held', 'waiting'],
      );
      const [newest, , oldest] = listed.runs;
      assert.deepEqual(oldest?.waiting && { ...oldest.waiting, since: 0 }, {
        stepId: 'pause',
        kind: 'time',
        since: 0,
        ahead: null,
        needsYouInClaudeStream: false,
      });
      assert.equal(newest?.waiting?.kind, 'limit', 'a held run waits on its limit, at its start step');
      assert.equal(newest?.ruleId, RULE);
      assert.equal(newest?.ruleVersion, 1);
      assert.equal(newest?.endCode, null);
      assert.equal(newest?.shadow, false);
      assert.equal(newest?.depth, 0);
      assert.equal(newest?.parentRunId, null);

      const held = await json<RunsListResultV1>(harness.stateDir, ['runs', 'list', '--state', 'held']);
      assert.deepEqual(
        held.runs.map((entry) => entry.runId),
        [third, second],
      );
      const waiting = await json<RunsListResultV1>(harness.stateDir, [
        'runs',
        'list',
        '--workflow',
        RULE,
        '--state',
        'waiting',
      ]);
      assert.deepEqual(
        waiting.runs.map((entry) => entry.runId),
        [first],
      );
      assert.deepEqual(
        (await json<RunsListResultV1>(harness.stateDir, ['runs', 'list', '--workflow', 'other'])).runs,
        [],
      );
      const unknown = await cli(harness.stateDir, ['runs', 'list', '--state', 'sleeping']);
      assert.equal(unknown.code, 64, unknown.stderr);

      // Older runs than the list can hold: the newest 200 are given, these three first.
      const decision = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT decision_id FROM workflow_runs WHERE id = ?').get(first as string),
      ) as { decision_id: string };
      writeDatabase(
        harness.stateDir,
        (database) => {
          const insert = database.prepare(
            `INSERT INTO workflow_runs (id, decision_id, rule_id, rule_version, account_id, event_id, state, started_at,
                                      updated_at, expires_at, switch_generation, end_code)
           VALUES (?, ?, ?, 1, ?, ?, 'done', ?, ?, ?, 1, NULL)`,
          );
          for (let index = 0; index < 205; index += 1)
            insert.run(
              fakeRunId(index),
              `${decision.decision_id}-old-${index}`,
              RULE,
              ACCOUNT,
              `old-${index}`,
              index,
              index,
              index + DAY,
            );
        },
        true,
      );
      const capped = await json<RunsListResultV1>(harness.stateDir, ['runs', 'list']);
      assert.equal(capped.runs.length, 200);
      assert.deepEqual(
        capped.runs.slice(0, 3).map((entry) => entry.runId),
        [third, second, first],
      );
      assert.equal(capped.runs.at(-1)?.runId, fakeRunId(8), 'the oldest five are left out');
    },
    { now: time.now, workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});

/** The owner example (spec §4.4) on the fake mailbox, its other kinds stood in for. */
function ownerExample(): Record<string, unknown> {
  const example = structuredClone(OWNER_EXAMPLE) as unknown as Record<string, unknown>;
  return {
    ...rule(1, example.targets as Record<string, unknown>[]),
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

const WORKTREE = '/example/home/work/acme-site-wt/ac-acme-1';
const SESSION = 'sess_6f9d2c1e-3b4a-4c5d-8e7f-0a1b2c3d4e5f';

/** No session to find, so the run makes a worktree, starts a session there, gives it the message and waits for it. */
const throughAWorktree: readonly StepExecutor[] = [
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
  standIn('raise', () => ({
    kind: 'settled',
    outcome: 'raised',
    output: { event: 'wfe_stand-in', name: 'project-found' },
  })),
  standIn('deliver', (ctx) => ({
    kind: 'settled',
    outcome: 'done',
    output:
      ctx.stepId === 'issue'
        ? { delivery: 'd-issue', issue: { id: 'i-1', identifier: 'ACME-1', url: 'https://linear.app/x/issue/ACME-1' } }
        : { delivery: `d-${ctx.stepId}`, session: SESSION, turn: null, ahead: 0 },
  })),
  standIn('find-session', () => ({ kind: 'settled', outcome: 'none', output: { session: null, provider: 'claude' } })),
  standIn('worktree', () => ({
    kind: 'settled',
    outcome: 'made',
    output: { branch: 'ac/acme-1', path: WORKTREE, refusal: null },
  })),
  standIn('start-session', () => ({
    kind: 'settled',
    outcome: 'started',
    output: { session: SESSION, provider: 'claude', mode: 'manual', refusal: null },
  })),
  holdForAnHour,
];

test('B6: runs show names its version and that version’s steps, with paths for the person', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      const example = ownerExample();
      await enable(harness, example);
      await send(harness, 'Please change the banner');
      await harness.tick();
      const [runId] = runIds(harness);
      // The workflow is edited while its run waits: a new version with other steps, as the designer saves one.
      await harness.control.request('rule-update', {
        document: {
          ...rule(2, []),
          flow: {
            flowVersion: 1,
            limits: limits(),
            start: 'shout',
            steps: { shout: { kind: 'notify', text: 'something came', next: {} } },
          },
        },
      });
      const shown = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId as string]);
      assert.equal(shown.runId, runId);
      assert.equal(shown.ruleId, RULE);
      assert.equal(shown.ruleVersion, 1, 'the run names the version it started on');
      assert.equal(shown.state, 'waiting');
      const flow = (example.flow as { steps: Record<string, { kind: string }> }).steps;
      for (const step of shown.steps) assert.equal(step.kind, flow[step.stepId]?.kind, `${step.stepId} is v1's`);
      assert.ok(!shown.steps.some((step) => step.stepId === 'shout'), 'no step of the new version is shown');
      assert.deepEqual(shown.path, ['route', 'found', 'issue', 'find', 'another', 'tree', 'start', 'give']);
      assert.deepEqual(
        shown.steps.map((step) => step.stepId).slice(0, 2),
        ['route', 'found'],
        "in the version's printed order",
      );
      const tree = shown.steps.find((step) => step.stepId === 'tree');
      assert.deepEqual(
        tree?.output,
        { branch: 'ac/acme-1', path: WORKTREE, refusal: null },
        'the person sees the path',
      );
      assert.equal(tree?.state, 'done');
      assert.equal(tree?.outcome, 'made');
      assert.equal(tree?.attempts, 1);
      const wait = shown.steps.find((step) => step.stepId === 'wait');
      assert.equal(wait?.state, 'waiting');
      assert.equal(wait?.wait?.kind, 'time');
      assert.equal(shown.waiting?.stepId, 'wait');
      assert.deepEqual(
        shown.steps.filter((step) => step.state === 'skipped').map((step) => step.stepId),
        ['free'],
        'a busy session’s wait is past reach once find said none; the rest can still be reached',
      );
      assert.equal(shown.notRaised, 0);
      assert.deepEqual(shown.events, []);
      // The list carries no step's output, so no folder: those are for `runs show`, the person's one view of them.
      const listed = await cli(harness.stateDir, ['runs', 'list']);
      assert.equal(listed.code, 0, listed.stderr);
      assert.doesNotMatch(listed.stdout, /acme-site-wt/u);
      const missing = await cli(harness.stateDir, ['runs', 'show', fakeRunId(1)]);
      assert.equal(missing.code, 66, missing.stderr);
      const malformed = await cli(harness.stateDir, ['runs', 'show', 'run_1']);
      assert.equal(malformed.code, 64, malformed.stderr);
    },
    { workflows: { parts: [{ executors: throughAWorktree }] } },
  );
});

test('B6: runs cancel cancels waiting deliveries and undelivered events, drops waits, purges, and says how many', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(
    async (harness) => {
      await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
      await send(harness, 'cancel me');
      await harness.tick();
      const [runId] = runIds(harness) as [string];
      const { decision_id: decisionId } = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT decision_id FROM workflow_runs WHERE id = ?').get(runId),
      ) as { decision_id: string };
      // What later tracks write for a run: a delivery still waiting, and an event raised and not yet delivered.
      const eventId = 'wfe_0123456789abcdefghjkmnpqrs';
      writeDatabase(harness.stateDir, (database) => {
        database
          .prepare(
            `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id,
                                     target_version, encrypted_record, expires_at, state, switch_generation, run_id, step_id)
             VALUES ('del-waiting', ?, ?, ?, 1, 'dry-run:dry-david:1#pause', 'dry-david', 1, X'00', ?, 'queued', 1, ?, 'pause')`,
          )
          .run(decisionId, ACCOUNT, RULE, Date.now() + DAY, runId);
        database
          .prepare(
            `INSERT INTO workflow_events (id, run_id, step_id, rule_id, rule_version, account_id, type, schema, sequence,
                                          raised_at, expires_at, state, encrypted_record)
             VALUES (?, ?, 'pause', ?, 1, ?, 'acme.waits.pause.waiting', 'step.wait', 1, ?, ?, 'open', X'00')`,
          )
          .run(eventId, runId, RULE, ACCOUNT, Date.now(), Date.now() + DAY);
        database
          .prepare(
            `INSERT INTO event_deliveries (event_id, subscriber_id, subscriber_version, kind, state, ordering_sequence)
             VALUES (?, 'watcher', 1, 'sse', 'queued', 1)`,
          )
          .run(eventId);
      });
      const before = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId]);
      assert.deepEqual(before.events, [
        {
          eventId,
          type: 'acme.waits.pause.waiting',
          raisedAt: before.events[0]?.raisedAt,
          state: 'open',
          deliveries: [{ subscriberId: 'watcher', subscriberVersion: 1, state: 'queued' }],
        },
      ]);
      const cancelled = await json<RunCancelResultV1>(harness.stateDir, ['runs', 'cancel', runId]);
      assert.deepEqual(cancelled, {
        runId,
        state: 'cancelled',
        cancelledDeliveries: 1,
        cancelledEvents: 1,
        interrupted: false,
      });
      const after = readDatabase(harness.stateDir, (database) => ({
        run: database
          .prepare(
            'SELECT state, end_code, CASE WHEN encrypted_record IS NULL THEN 0 ELSE 1 END AS sealed FROM workflow_runs WHERE id = ?',
          )
          .get(runId),
        waits: database.prepare('SELECT COUNT(*) AS count FROM workflow_waits WHERE run_id = ?').get(runId),
        delivery: database
          .prepare(
            "SELECT state, CASE WHEN encrypted_record IS NULL THEN 0 ELSE 1 END AS sealed FROM deliveries WHERE id = 'del-waiting'",
          )
          .get(),
        event: database.prepare('SELECT state, encrypted_record FROM workflow_events WHERE id = ?').get(eventId),
        eventDelivery: database.prepare('SELECT state FROM event_deliveries WHERE event_id = ?').get(eventId),
      }));
      assert.deepEqual(
        { ...(after.run as object) },
        { state: 'cancelled', end_code: 'CANCELLED_BY_PERSON', sealed: 0 },
      );
      assert.equal((after.waits as { count: number }).count, 0);
      assert.deepEqual({ ...(after.delivery as object) }, { state: 'cancelled', sealed: 0 });
      assert.deepEqual({ ...(after.event as object) }, { state: 'cancelled', encrypted_record: null });
      assert.deepEqual({ ...(after.eventDelivery as object) }, { state: 'cancelled' });
      const shown = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId]);
      assert.equal(shown.state, 'cancelled');
      assert.equal(shown.endCode, 'CANCELLED_BY_PERSON');
      assert.equal(shown.waiting, null);
      assert.deepEqual(
        shown.steps.map((step) => [step.stepId, step.state]),
        [['pause', 'cancelled']],
      );
      const again = await cli(harness.stateDir, ['runs', 'cancel', runId]);
      assert.equal(again.code, 66, 'a run that has ended cannot be cancelled again');
      assert.match(again.stderr, /no run that is still going has this id/u);
    },
    { workflows: { parts: [{ executors: [holdForAnHour] }] } },
  );
});

test('B6: runs cancel --interrupt interrupts the turn through the relay; without it the turn runs on', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await realpath(await shortTempDir('aev-runs-relay-'));
  const folder = join(root, 'acme');
  await mkdir(folder);
  const relay = await new FakeRelay({ allowedRoots: [root] }).start();
  const home = await relay.writeHome(root);
  try {
    await withLaneOwner(
      async (harness) => {
        const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
        await person.request('integration-set', { integration: 'agent-sessions', relayHome: home });
        await enable(harness, flowRule({ start: 'pause', steps: { pause: waitStep } }));
        await send(harness, 'one');
        await send(harness, 'two');
        await harness.tick();
        const [quiet, loud] = runIds(harness) as [string, string];
        // Each run gave a session a turn that is still going (B4 writes these rows when it delivers).
        const turns = new Map<string, string>();
        for (const runId of [quiet, loud]) {
          const session = relay.addSession({ cwd: folder });
          const turn = relay.startRunElsewhere(session.id);
          turns.set(runId, turn.id);
          const { decision_id: decisionId } = readDatabase(harness.stateDir, (database) =>
            database.prepare('SELECT decision_id FROM workflow_runs WHERE id = ?').get(runId),
          ) as { decision_id: string };
          writeDatabase(harness.stateDir, (database) => {
            database
              .prepare(
                `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id,
                                         target_version, expires_at, state, switch_generation, target_kind, run_id, step_id)
                 VALUES (?, ?, ?, ?, 1, 'session:acme-session:1#pause', 'acme-session', 1, ?, 'delivered', 1, 'session', ?, 'pause')`,
              )
              .run(`del-${runId}`, decisionId, ACCOUNT, RULE, Date.now() + DAY, runId);
            database
              .prepare(
                `INSERT INTO session_deliveries (delivery_id, relay_session_id, started, run_id, chosen_at)
                 VALUES (?, ?, 1, ?, ?)`,
              )
              .run(`del-${runId}`, session.id, turn.id, Date.now());
          });
        }
        const interrupts = () => relay.requests.filter((request) => request.path.endsWith('/interrupt'));
        const ranOn = await json<RunCancelResultV1>(harness.stateDir, ['runs', 'cancel', quiet]);
        assert.equal(ranOn.interrupted, false);
        assert.deepEqual(interrupts(), [], 'without --interrupt nothing is asked of the relay');
        assert.equal(relay.runs.find((turn) => turn.id === turns.get(quiet))?.status, 'running', 'the turn runs on');
        const stopped = await json<RunCancelResultV1>(harness.stateDir, ['runs', 'cancel', loud, '--interrupt']);
        assert.equal(stopped.state, 'cancelled');
        assert.equal(stopped.interrupted, true);
        assert.deepEqual(
          interrupts().map((request) => [request.method, request.path, request.authorised]),
          [['POST', `/v1/runs/${turns.get(loud)}/interrupt`, true]],
        );
        assert.equal(relay.runs.find((turn) => turn.id === turns.get(loud))?.status, 'interrupted');
        assert.equal(relay.runs.find((turn) => turn.id === turns.get(quiet))?.status, 'running');
      },
      {
        agentSessions: { homeDirectory: join(root, 'no-home'), reconcileMs: 60_000 },
        workflows: { parts: [{ executors: [holdForAnHour] }] },
      },
    );
  } finally {
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
});

const RUN = 'wfr_0123456789abcdefghjkmnpqrs';

for (const command of [
  ['runs', 'list'],
  ['runs', 'show', RUN],
  ['runs', 'cancel', RUN],
])
  test(`B6: ${command.join(' ')} exits 10 inside the MCP marker and an agent's shell`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const stateDir = await shortTempDir('aev-runs-cli-');
    try {
      const inside = await cli(stateDir, command, { env: { AGENTCOMMS_MCP_SERVER: 'events' } });
      assert.equal(inside.code, 10, inside.stderr);
      assert.match(inside.stderr, /a workflow's runs are for a person, at a terminal or in the app/u);
      for (const marker of ['CLAUDECODE', 'CODEX_SANDBOX', 'CURSOR_AGENT']) {
        const agent = await cli(stateDir, command, { env: { [marker]: '1' } });
        assert.equal(agent.code, 10, `${marker}: ${agent.stderr}`);
        assert.match(agent.stderr, /only a person can/u);
      }
      // On macOS a process the app did not start, and that is no terminal, is refused too.
      const piped = await cli(stateDir, command, { origin: NOT_THE_APP });
      assert.equal(piped.code, 10, piped.stderr);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });

test('B6: the owner takes a run wire only from the person, never from a window or another client', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const refused = (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED';
    for (const [operation, args] of [
      ['runs-list', {}],
      ['run-show', { runId: RUN }],
      ['run-cancel', { runId: RUN, interrupt: false }],
    ] as const) {
      await assert.rejects(harness.control.request(operation, args), refused, `${operation} from another client`);
      const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
      await assert.rejects(
        person.request(operation, { ...args, caller: { windowId: 'w' } }),
        refused,
        `${operation} from a window`,
      );
    }
    const person = new EventControlClient({ stateDir: harness.stateDir, clientName: PERSON });
    assert.deepEqual(await person.request('runs-list', {}), { runs: [] });
    await assert.rejects(
      person.request('runs-list', { colour: 'red' }),
      (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
    );
  });
});

/** A find-session stand-in that settles `none` and records each finish, with the run's state at that moment. */
function finishing(stateDir: () => string, finished: Array<readonly [string, string, string]>): StepExecutor {
  return {
    kind: 'find-session',
    run: async () => ({ kind: 'settled', outcome: 'none', output: { session: null, provider: 'claude' } }),
    resume: async () => ({ kind: 'settled', outcome: 'none', output: { session: null, provider: 'claude' } }),
    finish: async (ctx, runState) => {
      const row = readDatabase(stateDir(), (database) =>
        database.prepare('SELECT state FROM workflow_runs WHERE id = ?').get(ctx.run.id),
      ) as { state: string };
      finished.push([ctx.stepId, runState, row.state]);
      throw new Error('a finish that fails changes nothing');
    },
  };
}

const lookThenPause = flowRule({
  start: 'look',
  steps: {
    look: { kind: 'find-session', in: { folder: '/example/home/work/x' }, provider: 'claude', next: { none: 'pause' } },
    pause: waitStep,
  },
});

for (const [name, end, code] of [
  [
    'a revocation',
    async (harness: LaneHarness) => harness.control.request('rule-disable', { ruleId: RULE }),
    'AUTHORIZATION_REVOKED',
  ],
  ['disable-all', async (harness: LaneHarness) => harness.control.request('disable-all'), 'DISABLED_ALL'],
  [
    "the account's removal",
    async (harness: LaneHarness) => {
      const configFile = join(dirname(harness.stateDir), 'config', 'config.json');
      const config = JSON.parse(await readFile(configFile, 'utf8')) as { inboxes: Record<string, unknown> };
      delete config.inboxes[ALIAS];
      await writeFile(configFile, `${JSON.stringify(config)}\n`);
    },
    'ACCOUNT_REMOVED',
  ],
] as const)
  test(`B6: a run that ${name} cancels still finishes each step it ran, after the cancel commits`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const finished: Array<readonly [string, string, string]> = [];
    let stateDir = '';
    await withLaneOwner(
      async (harness) => {
        stateDir = harness.stateDir;
        await enable(harness, lookThenPause);
        await send(harness, 'one');
        await harness.tick();
        const [runId] = runIds(harness) as [string];
        assert.equal((await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId])).state, 'waiting');
        await end(harness);
        await harness.tick();
        const shown = await json<RunShowResultV1>(harness.stateDir, ['runs', 'show', runId]);
        assert.equal(shown.state, 'cancelled', 'the cancel stands, though the finish failed');
        assert.equal(shown.endCode, code);
        assert.deepEqual(finished, [['look', 'cancelled', 'cancelled']], 'once, after the cancel committed');
        await harness.tick();
        assert.equal(finished.length, 1, 'and never again');
      },
      { workflows: { parts: [{ executors: [finishing(() => stateDir, finished), holdForAnHour] }] } },
    );
  });
