import assert from 'node:assert/strict';
import { readFile, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { canonicalJson, type DesktopOrigin, type Notifier, sha256Hex } from '@agentcomms/core';
import { catalogueEntry, describeFlow, type FlowDocumentV1, type StepKind } from '@agentcomms/events';
// @ts-expect-error Repository tooling is executable Node ESM without a declaration surface.
import { readB3GuardManifests, verifyB3GuardCoverage } from '../../../scripts/verify-b3-guard-coverage.mjs';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { type EventsCliStreams, run } from '../src/cli/program.ts';
import { canonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { renderB3ApprovalPreviewV1 } from '../src/operations/b3-contract.ts';
import { createRetainedRuleTestControl } from '../src/runtime/b3-retained-control.ts';
import { EventProjectionStore } from '../src/runtime/projections.ts';
import { RelayClient, readRelayToken } from '../src/runtime/relay-client.ts';
import { composeWorkflows } from '../src/runtime/workflow/compose.ts';
import type { StepContext, StepExecutor, StepResult, WakeReason } from '../src/runtime/workflow/contracts.ts';
import type { FlowTestResultV1, RuleCheckResultV1 } from '../src/runtime/workflow/flow-test.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { FakeRelay } from './support/fake-relay.ts';
import {
  ACCOUNT,
  DAVID,
  DAY,
  dryRun,
  type LaneHarness,
  RULE,
  readDatabase,
  rule,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { OWNER_EXAMPLE } from './support/step-context.ts';

assertLoopbackSeal();

/*
 * B7 (workflows plan): trying a workflow before it runs (spec §7.7). `workflow check` writes nothing; `workflow test`
 * walks the graph over a catalogue example with the outcomes asked for, saying each effect it would have had, with no
 * I/O; `workflow test-retained` lets route and find answer for real on a recent message and starts nothing; a shadow
 * version records a dry run for each effect and times its waits out at once; `workflow show --version` gives one
 * version; and a flow's approval preview lists describeFlow's numbered lines. A real owner, a fake mailbox, stand-ins for
 * the kinds other tracks add, a fake relay, and a stand-in home and secret store.
 */

const HOUR = 3_600_000;
const EXAMPLE = 'gmail.message.received@1:1';

const limits = () => ({
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
});

function standIn(
  kind: StepKind,
  run: (ctx: StepContext) => StepResult | Promise<StepResult>,
  resume: (ctx: StepContext, wake: WakeReason) => StepResult | Promise<StepResult> = run,
): StepExecutor {
  return { kind, run: async (ctx) => run(ctx), resume: async (ctx, wake) => resume(ctx, wake) };
}

async function enable(harness: LaneHarness, document: Record<string, unknown>): Promise<void> {
  for (const target of document.targets as Record<string, unknown>[])
    await harness.control.request('target-add', { document: target });
  await harness.control.request('rule-create', { document });
  await harness.approve(document.version as number);
  const enabled = (await harness.control.request('enable-all')) as { approvalId: string };
  const challenge = (await harness.control.request('approve-challenge', { approvalId: enabled.approvalId })) as string;
  await harness.control.request('approve', { approvalId: enabled.approvalId, answer: challenge });
}

/** The owner example (spec §4.4) on the fake mailbox: its targets and flow, its message's text its subject. */
function ownerExample(): Record<string, unknown> & { flow: FlowDocumentV1 } {
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
    flow: example.flow as FlowDocumentV1,
  };
}

/** What the person's database holds that a check or a test must never write. */
function written(harness: LaneHarness): Record<string, number> {
  return readDatabase(harness.stateDir, (database) =>
    Object.fromEntries(
      ['rule_versions', 'target_versions', 'workflow_runs', 'deliveries', 'workflow_events', 'dryrun_log'].map(
        (table) => [
          table,
          (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
        ],
      ),
    ),
  );
}

const ATTESTED = async (): Promise<DesktopOrigin> => ({
  ok: true,
  build: 'release',
  identifier: 'com.cueplusplus.agentcomms',
});

async function cli(
  stateDir: string,
  args: readonly string[],
  stdinText = '',
): Promise<{ readonly code: number; readonly stdout: string; readonly stderr: string }> {
  const stdin = new PassThrough();
  stdin.end(stdinText);
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
  return { code, stdout: out, stderr: err };
}

async function json<T>(stateDir: string, args: readonly string[], stdinText = ''): Promise<T> {
  const result = await cli(stateDir, args, stdinText);
  assert.equal(result.code, 0, result.stderr);
  return JSON.parse(result.stdout) as T;
}

function texts(parts: readonly { readonly text: string }[]): string {
  return parts.map((part) => part.text).join('');
}

test('B7: workflow check answers ok for the owner example and lists FLOW_CYCLE for a cycle, writing nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const before = written(harness);
    const example = ownerExample();
    assert.deepEqual(
      await json<RuleCheckResultV1>(harness.stateDir, ['workflow', 'check', '-'], JSON.stringify(example)),
      {
        ok: true,
        problems: [],
      },
    );
    const cycle = ownerExample();
    (cycle.flow.steps as unknown as Record<string, Record<string, unknown>>).tell = {
      kind: 'notify',
      text: 'round again',
      next: { sent: 'route' },
    };
    const found = await json<RuleCheckResultV1>(harness.stateDir, ['workflow', 'check', '-'], JSON.stringify(cycle));
    assert.equal(found.ok, false);
    assert.ok(
      found.problems.some((problem) => problem.code === 'FLOW_CYCLE' && problem.stepId !== null),
      JSON.stringify(found),
    );
    const extra = await json<RuleCheckResultV1>(harness.stateDir, [
      'workflow',
      'check',
      JSON.stringify({ ...example, colour: 'red' }),
    ]);
    assert.equal(extra.ok, false);
    assert.equal(extra.problems[0]?.code, 'VERSION_DOCUMENT_INVALID');
    assert.match(extra.problems[0]?.message ?? '', /has no field colour/u);
    // An agent checks a document as the person does: the same answer over MCP.
    const window = await harness.window(DAVID);
    assert.deepEqual(structured(await tool(window, 'events_rule_check', { document: cycle })), found);
    assert.deepEqual(written(harness), before, 'a check writes nothing');
  });
});

test('B7: workflow test --outcome find=busy takes the busy path; every effect says would; no I/O', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    const before = written(harness);
    const document = JSON.stringify(ownerExample());
    const tried = await json<FlowTestResultV1>(
      harness.stateDir,
      ['workflow', 'test', '-', EXAMPLE, '--outcome', 'find=busy'],
      document,
    );
    assert.equal(tried.ruleId, RULE);
    assert.deepEqual(tried.path, ['route', 'found', 'issue', 'find', 'free', 'give', 'wait', 'tell']);
    const step = (id: string) => tried.steps.find((entry) => entry.stepId === id);
    assert.equal(step('find')?.outcome, 'busy');
    assert.match(texts(step('find')?.would ?? []), /^Answers, as asked, busy$/u);
    assert.match(texts(step('route')?.would ?? []), /^Answers, as its first outcome, chosen: acme-site$/u);
    for (const id of ['found', 'issue', 'give', 'tell'])
      assert.match(texts(step(id)?.would ?? []), /^Would have /u, `${id} says what it would have done`);
    // The prompt and the issue as they would have been written: the sender's words inside the envelope, or quoted.
    assert.match(step('give')?.prompt ?? '', /id="workflow-test">\nSubject\n<\/untrusted-content boundary="/u);
    assert.equal(step('issue')?.issue?.title, 'Sender asks about acme-site');
    assert.match(step('issue')?.issue?.description ?? '', /From outside: written by the sender/u);
    assert.deepEqual(written(harness), before, 'a test makes no run, no delivery and no event');
    // The same over MCP, where it holds no real content either.
    const window = await harness.window(DAVID);
    const overMcp = structured(
      await tool(window, 'events_rule_test', {
        document: JSON.parse(document),
        catalogue: { type: 'gmail.message.received', version: 1, exampleIndex: 1 },
        outcomes: { find: 'busy' },
      }),
    ) as unknown as FlowTestResultV1;
    assert.deepEqual(overMcp.path, tried.path);
    const wrong = await cli(
      harness.stateDir,
      ['workflow', 'test', '-', EXAMPLE, '--outcome', 'find=sideways'],
      document,
    );
    assert.equal(wrong.code, 64, wrong.stderr);
    const nowhere = await cli(
      harness.stateDir,
      ['workflow', 'test', '-', EXAMPLE, '--outcome', 'nowhere=yes'],
      document,
    );
    assert.equal(nowhere.code, 64, nowhere.stderr);
  });
});

test('B7: workflow test shows each event it would raise, with its data', { skip: WINDOWS_SKIP }, async () => {
  await withLaneOwner(async (harness) => {
    const tried = await json<FlowTestResultV1>(
      harness.stateDir,
      ['workflow', 'test', '-', EXAMPLE],
      JSON.stringify(ownerExample()),
    );
    const types = tried.steps.flatMap((step) => step.events.map((event) => `${step.stepId} ${event.type}`));
    for (const expected of [
      'route acme.client-asks.route.matched',
      'found acme.client-asks.found.project-found',
      'issue acme.client-asks.issue.created',
      'give acme.client-asks.give.given',
    ])
      assert.ok(types.includes(expected), `${expected} in ${JSON.stringify(types)}`);
    assert.ok(types.at(-1)?.endsWith('acme.client-asks.run.finished'), 'the run would end finished, its last word');
    const created = tried.steps
      .find((step) => step.stepId === 'issue')
      ?.events.find((event) => event.type.endsWith('.created'))?.data as Record<string, unknown> | undefined;
    assert.deepEqual(created?.workflow, { id: RULE, version: 1, namespace: 'acme', name: 'client-asks' });
    assert.equal((created?.step as { id?: string } | undefined)?.id, 'issue');
    assert.equal(created?.outcome, 'done');
    assert.ok(created !== undefined && !Object.hasOwn(created, 'fields'), 'an automatic event carries no sender text');
    assert.doesNotMatch(JSON.stringify(tried.steps.map((step) => step.events)), /Subject|Sender/u);
  });
});

test('B7: test-retained runs route and find for real and starts nothing', { skip: WINDOWS_SKIP }, async () => {
  const root = await realpath(await shortTempDir('aev-try-relay-'));
  const relay = await new FakeRelay({ allowedRoots: [root] }).start();
  const home = await relay.writeHome(root);
  const client = new RelayClient({ url: relay.url, token: await readRelayToken(home) });
  const calls: string[] = [];
  const route = standIn('route', (ctx) => {
    calls.push(`route ${ctx.run.id}`);
    return {
      kind: 'settled',
      outcome: 'chosen',
      output: {
        project: 'acme-site',
        projectName: 'acme-site',
        reason: 'hint:sender-domain',
        score: null,
        profileHash: 'x',
      },
    };
  });
  const find = standIn('find-session', async (ctx) => {
    // The session that took this conversation is looked for by the message's own ids (W36), from the retained message.
    calls.push(`find ${ctx.run.id} ${JSON.stringify((await ctx.message?.()) ?? null)}`);
    await client.sessions();
    return { kind: 'settled', outcome: 'none', output: { session: null, provider: 'claude' } };
  });
  const start = standIn('start-session', async (ctx) => {
    calls.push(`start ${ctx.run.id}`);
    const made = await client.createSession({ provider: 'claude', cwd: root, requestedMode: 'manual', title: 'never' });
    return {
      kind: 'settled',
      outcome: 'started',
      output: { session: made.id, provider: 'claude', mode: 'manual', refusal: null },
    };
  });
  const example = ownerExample();
  const routeStep: Record<string, unknown> = {
    ...(example.flow.steps.route as unknown as Record<string, unknown>),
    next: { chosen: 'find' },
  };
  delete routeStep.emit;
  const stateDir = join(root, 'state');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = canonicalFullRuleDocument({
      ...example,
      targets: [],
      retention: rule(1, []).retention,
      flow: {
        flowVersion: 1,
        limits: limits(),
        start: 'route',
        steps: {
          route: routeStep,
          find: { kind: 'find-session', in: { thread: true }, provider: 'claude', next: { none: 'begin' } },
          begin: { kind: 'start-session', in: { project: 'route' }, provider: 'claude', mode: 'manual', next: {} },
        },
      },
    });
    // The retained projection a held message keeps, as the owner would have kept it; its cipher is a stand-in.
    const cipher = {
      async encrypt(_location: unknown, bytes: Uint8Array) {
        return Buffer.from(bytes);
      },
      async decrypt(_location: unknown, bytes: Uint8Array) {
        return Buffer.from(bytes);
      },
    };
    const event = {
      ...(catalogueEntry('gmail.message.received', 1) as unknown as { value: { examples: Record<string, unknown>[] } })
        .value.examples[1],
      subject: 'Please change the banner',
    };
    const stored = canonicalJson(document as never);
    store.database.exec('UPDATE event_settings SET enabled = 1 WHERE singleton = 1');
    store.database
      .prepare(`INSERT INTO rule_versions
        (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
        VALUES (?, ?, 1, ?, ?, 'active', 'approval', 'activation', 1)`)
      .run(`${RULE}@1`, RULE, stored, sha256Hex(stored));
    store.database
      .prepare(`INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-retained', ?, 'gmail.message.received', 1, ?, 'dedupe', 1, 1, 1)`)
      .run(store.installationId, ACCOUNT);
    store.database
      .prepare(`INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
        VALUES ('event-retained', ?, 1, ?, ?)`)
      .run(RULE, Date.now() + DAY, Buffer.from(JSON.stringify({ event })));
    const engine = composeWorkflows(
      {
        store,
        cipher: cipher as never,
        approvals: { get: async () => undefined } as never,
        config: { load: async () => ({}) } as never,
        notifier: async () => ({ raised: false, reason: 'a test' }),
      },
      [{ executors: [route, find, start] }],
    );
    const control = createRetainedRuleTestControl({
      store,
      projections: new EventProjectionStore({ store, cipher: cipher as never }),
      accountLive: async () => {},
      flow: (input) => engine.tryRetained(input),
    });
    const tried = (await control.test({ eventId: 'event-retained', ruleId: RULE, ruleVersion: 1 })) as FlowTestResultV1;
    assert.deepEqual(tried.path, ['route', 'find', 'begin']);
    assert.match(texts(tried.steps[0]?.would ?? []), /^Answers chosen: acme-site$/u, 'route answered for real');
    assert.match(texts(tried.steps[1]?.would ?? []), /^Answers none$/u, 'find answered for real');
    assert.match(texts(tried.steps[2]?.would ?? []), /^Would have started a Claude Code session /u);
    assert.deepEqual(calls, [
      'route wfr_00000000000000000000000000',
      'find wfr_00000000000000000000000000 {"id":"message-1","thread":"thread-1"}',
    ]);
    assert.ok(relay.requests.some((request) => request.method === 'GET' && request.path === '/v1/sessions'));
    assert.ok(
      !relay.requests.some((request) => request.method === 'POST' && request.path === '/v1/sessions'),
      'no session is started',
    );
    assert.equal(relay.sessions.length, 0);
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM workflow_runs').get() as { count: number }).count,
      0,
      'no run is made',
    );
  } finally {
    store.close();
    await relay.stop();
    await rm(root, { recursive: true, force: true });
  }
});

type Notice = Parameters<Notifier>[0];

test('B7: a shadow version records a dry run for each effect and raise, and its waits time out at once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const notices: Notice[] = [];
  const notifier: Notifier = async (notice) => {
    notices.push(notice);
    return { raised: true };
  };
  const look = standIn('find-session', () => ({
    kind: 'settled',
    outcome: 'none',
    output: { session: null, provider: 'claude' },
  }));
  const never = (kind: StepKind) =>
    standIn(kind, () => {
      throw new Error(`a shadow never runs a ${kind} step`);
    });
  const document = {
    ...rule(1, [dryRun]),
    flow: {
      flowVersion: 1,
      shadow: true,
      limits: limits(),
      events: { namespace: 'acme', workflow: 'shadowed' },
      start: 'look',
      steps: {
        look: {
          kind: 'find-session',
          in: { folder: '/example/home/work/x' },
          provider: 'claude',
          next: { none: 'tell' },
        },
        tell: { kind: 'notify', text: 'a shadow saw a mail', next: { sent: 'found' } },
        found: { kind: 'raise', name: 'seen', next: { raised: 'pause' } },
        pause: { kind: 'wait', for: { time: { afterMs: HOUR } }, timeoutMs: 2 * HOUR, next: { 'timed-out': 'begin' } },
        begin: {
          kind: 'start-session',
          in: { folder: '/example/home/work/x' },
          provider: 'claude',
          mode: 'manual',
          next: { started: 'out' },
        },
        out: { kind: 'deliver', target: { targetId: 'dry-david', version: 1 }, emit: ['succeeded'], next: {} },
      },
    },
  };
  await withLaneOwner(
    async (harness) => {
      await enable(harness, document);
      harness.mailbox.send('A shadow run');
      await harness.tick();
      await harness.tick();
      const [run] = readDatabase(harness.stateDir, (database) =>
        database.prepare('SELECT id, state FROM workflow_runs').all(),
      ) as Array<{ id: string; state: string }>;
      assert.equal(run?.state, 'done');
      const outcomes = Object.fromEntries(
        (
          readDatabase(harness.stateDir, (database) =>
            database.prepare('SELECT step_id, outcome FROM workflow_steps WHERE run_id = ?').all(run?.id as string),
          ) as Array<{ step_id: string; outcome: string }>
        ).map((row) => [row.step_id, row.outcome]),
      );
      assert.deepEqual(outcomes, {
        look: 'none',
        tell: 'sent',
        found: 'raised',
        pause: 'timed-out',
        begin: 'started',
        out: 'done',
      });
      assert.deepEqual(notices, [], 'no notice is raised');
      const kept = written(harness);
      assert.equal(kept.workflow_events, 0, 'no event is raised');
      const records = readDatabase(harness.stateDir, (database) =>
        database
          .prepare(
            `SELECT d.id, d.step_id, d.state, d.target_kind, l.expires_at - l.delivered_at AS kept
               FROM deliveries AS d JOIN dryrun_log AS l ON l.delivery_id = d.id WHERE d.run_id = ? ORDER BY d.step_id`,
          )
          .all(run?.id as string),
      ) as Array<{ id: string; step_id: string; state: string; target_kind: string; kept: number }>;
      assert.deepEqual(
        records.map((record) => [record.step_id, record.state, record.target_kind, record.kept]),
        [
          ['begin', 'delivered', 'dry-run', 86_400_000],
          ['found', 'delivered', 'dry-run', 86_400_000],
          ['out', 'delivered', 'dry-run', 86_400_000],
          ['tell', 'delivered', 'dry-run', 86_400_000],
        ],
        'a dry-run record for each effect and the raise, kept 24 hours, and none for the wait',
      );
      assert.equal(kept.deliveries, 4, 'nothing was delivered to the dry-run target itself');
      const shown = await json<{ record: { would: { text: string }[]; stepId: string } }>(harness.stateDir, [
        'dryrun',
        'show',
        records.find((record) => record.step_id === 'tell')?.id as string,
      ]);
      assert.equal(shown.record.stepId, 'tell');
      assert.match(texts(shown.record.would), /^Would have shown the notice a shadow saw a mail$/u);
    },
    { workflows: { notifier, parts: [{ executors: [look, never('start-session')] }] } },
  );
});

test('B7: workflow show --version 2 returns that version alone', { skip: WINDOWS_SKIP }, async () => {
  await withLaneOwner(async (harness) => {
    await harness.control.request('target-add', { document: dryRun });
    await harness.control.request('rule-create', { document: rule(1, [dryRun]) });
    await harness.control.request('rule-update', { document: rule(2, [dryRun]) });
    const both = await json<{ document: { version: number } }[]>(harness.stateDir, ['workflow', 'show', RULE]);
    assert.deepEqual(
      both.map((entry) => entry.document.version),
      [1, 2],
    );
    const second = await json<{ document: { version: number } }[]>(harness.stateDir, [
      'workflow',
      'show',
      RULE,
      '--version',
      '2',
    ]);
    assert.deepEqual(
      second.map((entry) => entry.document.version),
      [2],
    );
    const missing = await cli(harness.stateDir, ['workflow', 'show', RULE, '--version', '3']);
    assert.equal(missing.code, 66, missing.stderr);
    const window = await harness.window(DAVID);
    const overMcp = structured(await tool(window, 'events_rule_show', { ruleId: RULE, version: 1 })) as unknown as {
      document: { version: number };
    }[];
    assert.deepEqual(
      overMcp.map((entry) => entry.document.version),
      [1],
    );
  });
});

test('B7: the approval preview of a flow lists describeFlow’s numbered lines', { skip: WINDOWS_SKIP }, async () => {
  await withLaneOwner(async (harness) => {
    const example = ownerExample();
    for (const target of example.targets as Record<string, unknown>[])
      await harness.control.request('target-add', { document: target });
    await harness.control.request('rule-create', { document: example });
    const planned = (await harness.control.request('rule-enable', { ruleId: RULE, version: 1 })) as {
      approvalId: string;
      binding: { digest: string };
    };
    const view = await harness.control.request('approvalView', {
      approvalId: planned.approvalId,
      digest: planned.binding.digest,
    });
    const terminal = renderB3ApprovalPreviewV1(view).terminal.split('\n');
    const expected = describeFlow(example as unknown as Parameters<typeof describeFlow>[0]);
    assert.ok(expected.length > 3);
    const plainWords = terminal.findIndex((line) => line.startsWith('In plain words'));
    assert.notEqual(plainWords, -1);
    const numbered = terminal.slice(plainWords + 1, plainWords + 1 + expected.length);
    assert.deepEqual(
      numbered.map((line) => Number(/^(\d+)\. /u.exec(line)?.[1])),
      expected.map((line) => line.number),
      "the flow's numbered lines follow the workflow's plain words, one per line",
    );
    const issueLine = expected.find((line) => line.stepIds[0] === 'issue');
    assert.ok(issueLine !== undefined);
    assert.match(
      numbered[issueLine.number - 1] ?? '',
      /create an issue in Linear, team ACME, titled "\{\{author\.name\}\} asks about \{\{steps\.route\.project\}\}"/u,
      "the issue's line says what it makes, its template one literal the author cannot close",
    );
  });
});

test('B7: B3 surface anchors still match exactly once', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  assert.deepEqual(await verifyB3GuardCoverage({ root }), []);
  const touched = [
    'packages/events-daemon/src/cli/program.ts',
    'packages/events-daemon/src/mcp/server.ts',
    'packages/events-daemon/src/operations/b3-contract.ts',
    'packages/events-daemon/src/runtime/b3-retained-control.ts',
  ];
  for (const manifest of (await readB3GuardManifests(root)) as {
    cases: { case: string; productionEntry: string; mutation: { from: string } }[];
  }[])
    for (const entry of manifest.cases) {
      if (!touched.includes(entry.productionEntry)) continue;
      const source = await readFile(join(root, entry.productionEntry), 'utf8');
      assert.equal(source.split(entry.mutation.from).length - 1, 1, `${entry.case} is anchored once`);
    }
});
