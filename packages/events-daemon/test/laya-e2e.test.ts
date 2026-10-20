import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CommsError, emptyConfig } from '@agentcomms/core';
import { assertLoopbackSeal, loopbackSealAttempts } from '../../../test/helpers/loopback-seal-preload.mjs';
import { run } from '../src/cli/program.ts';
import { EventControlClient } from '../src/control/client.ts';
import { LAYA_NOUL_TEMPLATE_ID } from '../src/runtime/laya/templates.ts';
import { createLayaWorkerBoundaryForTest } from '../src/runtime/laya/worker-boundary-probe.ts';
import { WorkerFrameParser } from '../src/runtime/laya/worker-protocol.ts';
import type { LayaWorkerStart } from '../src/runtime/laya/worker-supervisor.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { selectEventSecretStore } from '../src/store/event-secrets.ts';
import {
  LAYA,
  type LayaArtifactOrigin,
  layaArtifactOrigin,
  macPlatform,
  modelPath,
  type SyntheticLaya,
  syntheticLaya,
  treeListing,
} from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/**
 * E2 CI round 1: every test here that starts or awaits a child, a listener, an owner or a worker has a bound of its own.
 * `node --test` has none, and Node 24 keeps a test whose awaited promise never settles pending for ever (Node 22
 * cancels it once the event loop drains): a hang must fail in minutes, not at the job limit hours later.
 */
const CHILD_TEST_TIMEOUT_MS = 120_000;
const refusedNetwork = loopbackSealAttempts();

/*
 * E2 Task 13: Laya end to end, through the real event owner (`startEventOwner`) and its authenticated control
 * operations — the same requests the CLI, MCP and desktop app send — never a composition of the daemon made here.
 *
 * - **As shipped** (`E2 end to end held path`): the daemon's own assets, with the fail-closed placeholder lock. A Laya
 *   judge and a rule naming it are configuration; every way to run Laya refuses with `E2_EXTERNAL_REFERENCE_BLOCKED`,
 *   no Laya row, intent or directory exists, and a restart changes none of it.
 * - **As a future release would run it** (`E2 end to end: …`): the owner's Laya test seams only — strict-parsed
 *   synthetic reviewed bytes, a macOS host whose content-free sandbox probe passes, the sealed origin the production
 *   fetcher dials, and Task 7's frame-compatible stand-in child behind the real boundary proof. Never the real model,
 *   runtime or sandbox, and never a test-only daemon: E's prefilter, taint, reservation, gate, settlement, no-match and
 *   hold, the manager's install and verification and the supervisor's worker lifecycle are all the owner's own.
 */

const ACCOUNT = 'ibx_LAYAENDTOENDAAAA';
const SHIPPED_MANIFEST = 'laya-en-onnx-68f27dfe';
const STANDIN = fileURLToPath(new URL('./support/laya-worker-standin.ts', import.meta.url));
const MATCHING = 'Reply needed: synthetic Laya end-to-end message';
const FILTERED = 'Newsletter: synthetic message the prefilter drops';

type Store = Awaited<ReturnType<typeof openEventDatabase>>;
type Owner = Awaited<ReturnType<typeof startEventOwner>>;

/** What Task 7's stand-in does once its proof passes, read at each start: a later start may behave differently. */
interface Behaviour {
  probe: string;
  serve: string;
  extra: string[];
}

interface WrittenFrame {
  readonly frame: Readonly<Record<string, unknown>>;
  /** The durable reservation state at the instant the frame was written to the child. */
  readonly reservation: string | null;
}

const target = { targetId: 'target-laya-e2e', version: 1, kind: 'dry-run' as const, retentionMs: 3_600_000 };

function layaJudge(model: string) {
  return {
    judgeId: 'judge-laya-e2e',
    version: 1,
    kind: LAYA,
    provider: LAYA,
    model,
    promptTemplate: LAYA_NOUL_TEMPLATE_ID,
  };
}

function ruleNaming(judge: ReturnType<typeof layaJudge>, onUncertain: 'no-match' | 'hold') {
  return {
    ruleId: 'rule-laya-e2e',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    // E's deterministic prefilter: only a subject that starts this way reaches the judge.
    condition: { path: '/subject', op: 'startsWith', value: 'Reply needed', caseSensitive: false },
    agentic: {
      judge,
      question: 'Does this synthetic message ask for a reply?',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain,
      callsPerRollingHour: 20,
      inputTokensPerRolling30Days: 1_000_000,
      concurrency: 1,
      maxInputTokens: 10_000,
      maxOutputTokens: 64,
    },
    mapping: { subject: { $path: '/subject' } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention: {
      ingestMs: 3_600_000,
      holdMs: 3_600_000,
      deliveryMs: 3_600_000,
      dryrunMs: 3_600_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 3_600_000,
    },
  };
}

const budget = {
  budgetId: 'judge-budget',
  version: 1,
  global: { callsPerRollingHour: 20, inputTokensPerRolling30Days: 1_000_000, concurrency: 1 },
  providers: [{ provider: LAYA, callsPerRollingHour: 20, inputTokensPerRolling30Days: 1_000_000, concurrency: 1 }],
};

/** A control refusal with one stable reason, as the CLI and MCP show it: the code and, for Laya, the reason named. */
function refusedWith(reason: string) {
  return (error: unknown) =>
    error instanceof CommsError &&
    error.code === 'BAD_DATA' &&
    (error.details as { reason?: unknown } | undefined)?.reason === reason &&
    error.message.includes(reason);
}

async function waitUntil(condition: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

function exited(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

/** One synthetic Gmail mailbox: each message added after an activation's baseline is a new history entry. */
class SyntheticMailbox {
  readonly #entries: { readonly id: number; readonly messageId: string; readonly subject: string }[] = [];
  #history = 100;

  add(subject: string): string {
    this.#history += 1;
    const messageId = `message-laya-e2e-${this.#history}`;
    this.#entries.push({ id: this.#history, messageId, subject });
    return messageId;
  }

  source() {
    return {
      inboxId: ACCOUNT,
      getProfile: async () => ({ historyId: String(this.#history) }),
      listHistory: async ({ historyId }: { readonly historyId: string }) => {
        const after = this.#entries.filter((entry) => entry.id > Number(historyId));
        return {
          historyId: String(this.#history),
          nextPageToken: undefined,
          history: after.map((entry) => ({
            id: String(entry.id),
            messagesAdded: [{ message: { id: entry.messageId, threadId: `thread-${entry.messageId}` } }],
            labelsAdded: [],
            labelsRemoved: [],
          })),
        };
      },
      getMessageMetadata: async (messageId: string) => {
        const entry = this.#entries.find((candidate) => candidate.messageId === messageId);
        if (entry === undefined) throw new Error(`no synthetic message ${messageId}`);
        return {
          id: entry.messageId,
          threadId: `thread-${entry.messageId}`,
          labelIds: ['INBOX'],
          internalDate: String(Date.now()),
          payload: {
            headers: [
              { name: 'Subject', value: entry.subject },
              { name: 'From', value: 'Synthetic Sender <sender@example.test>' },
            ],
          },
        };
      },
    };
  }
}

interface Rig {
  readonly root: string;
  readonly stateDir: string;
  readonly configDir: string;
  readonly dataDir: string;
  readonly artifactRoot: string;
  readonly mailbox: SyntheticMailbox;
  readonly laya: SyntheticLaya | undefined;
  readonly origin: LayaArtifactOrigin | undefined;
  readonly behaviour: Behaviour;
  /** Every child the stand-in seam started, in order: each passed the real boundary proof first. */
  readonly children: ChildProcessWithoutNullStreams[];
  readonly starts: number[];
  /** Each start's fresh owner-only worker directory, as the supervisor made it. */
  readonly directories: string[];
  readonly written: WrittenFrame[];
  owner: Owner | undefined;
  store: Store | undefined;
  control: EventControlClient;
  start(): Promise<void>;
  restart(): Promise<void>;
  tick(times?: number): Promise<void>;
  /** A count over the owner's own database, read while it runs. */
  count(table: string, where?: string): number;
  reservations(): readonly Record<string, unknown>[];
  modelStatus(): Promise<Record<string, unknown>>;
  waitForModel(state: string): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}

/**
 * The real owner over one temporary state, config and data directory, a configured synthetic Gmail inbox and, when
 * `laya` is given, the owner's Laya test seams. Without it the owner reads the daemon's shipped assets, as a release
 * does.
 */
async function laya(options: { readonly laya?: SyntheticLaya; readonly origin?: LayaArtifactOrigin } = {}) {
  const root = await shortTempDir('events-e2-t13-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  const dataDir = join(root, 'data');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: ACCOUNT,
    provider: 'gmail',
    email: 'laya-e2e@example.test',
    identity: 'oidc',
    client: 'client-laya-e2e',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT}`,
    internalDomains: [],
    createdAt: '2026-10-20T00:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  // Approving a rule writes event secrets; a headless runner has no keychain, so the file backend is chosen first.
  const selected = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(selected.database, 'file');
  } finally {
    selected.close();
  }
  const mailbox = new SyntheticMailbox();
  const synthetic = options.laya;
  const origin = synthetic === undefined ? undefined : (options.origin ?? layaArtifactOrigin(synthetic));
  const behaviour: Behaviour = { probe: 'all-denied', serve: 'answer', extra: ['--value-json', '0.8125'] };
  const children: ChildProcessWithoutNullStreams[] = [];
  const starts: number[] = [];
  const directories: string[] = [];
  const written: WrittenFrame[] = [];
  let clients = 0;

  const rig: Rig = {
    root,
    stateDir,
    configDir,
    dataDir,
    artifactRoot: join(dataDir, 'events', LAYA),
    mailbox,
    laya: synthetic,
    origin,
    behaviour,
    children,
    starts,
    directories,
    written,
    owner: undefined,
    store: undefined,
    control: new EventControlClient({ stateDir, clientName: 'events-e2-t13' }),
    async start() {
      /** Task 7's stand-in behind the real proof: the same seam Task 8's supervisor tests use. */
      const startWorker: LayaWorkerStart = async ({ dataDirectory, signal }) => {
        starts.push(starts.length + 1);
        directories.push(dataDirectory);
        const current = { ...behaviour, extra: [...behaviour.extra] };
        const result = await createLayaWorkerBoundaryForTest({
          platform: 'darwin',
          dataDirectory,
          workerEntry: STANDIN,
          signal,
          spawn: (_command, _args, spawnOptions) =>
            spawn(
              process.execPath,
              [
                '--experimental-strip-types',
                STANDIN,
                '--standin',
                current.probe,
                '--serve',
                current.serve,
                ...current.extra,
              ],
              spawnOptions,
            ) as ChildProcessWithoutNullStreams,
        });
        if (result.ok) {
          children.push(result.child);
          const parser = new WorkerFrameParser();
          const write = result.child.stdin.write.bind(result.child.stdin) as (c: unknown, ...r: unknown[]) => boolean;
          result.child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
            if (Buffer.isBuffer(chunk))
              for (const frame of parser.push(chunk)) {
                const row = rig.store?.database
                  .prepare("SELECT state FROM judge_budget_reservations WHERE state = 'in-flight'")
                  .get() as { state: string } | undefined;
                written.push({ frame, reservation: row?.state ?? null });
              }
            return write(chunk, ...rest);
          }) as typeof result.child.stdin.write;
        }
        return result;
      };
      rig.owner = await startEventOwner({
        stateDir,
        configDir,
        dataDir,
        tickMs: 60_000,
        // Ticks are driven by hand; a short poll interval makes the inbox due again on the next one.
        pollIntervalMs: 1,
        gmailSourceFor: async () => mailbox.source() as never,
        // The owner's own SQLite authority, kept so this test can read what the owner wrote while it runs.
        openDatabase: async (input) => {
          const store = await openEventDatabase(input);
          rig.store = store;
          return store;
        },
        ...(synthetic === undefined || origin === undefined
          ? {}
          : {
              laya: {
                assets: synthetic.assets,
                platform: macPlatform(),
                network: origin.network,
                freeBytes: async () => Number.MAX_SAFE_INTEGER,
                startWorker,
              },
            }),
      });
      clients += 1;
      rig.control = new EventControlClient({ stateDir, clientName: `events-e2-t13-${clients}` });
    },
    async restart() {
      await rig.owner?.stop();
      rig.owner = undefined;
      rig.store = undefined;
      await rig.start();
    },
    async tick(times = 4) {
      for (let index = 0; index < times; index += 1) await rig.owner?.tick();
    },
    count(table, where = '1 = 1') {
      const database = rig.store?.database;
      if (database === undefined) throw new Error('the owner is not running');
      return (database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${where}`).get() as { count: number })
        .count;
    },
    reservations() {
      const database = rig.store?.database;
      if (database === undefined) throw new Error('the owner is not running');
      return (
        database
          .prepare(
            'SELECT state, provider, judge_kind, work_scope, estimated_input_tokens, actual_input_tokens, concurrency_owned FROM judge_budget_reservations ORDER BY rowid',
          )
          .all() as Record<string, unknown>[]
      ).map((row) => ({ ...row }));
    },
    async modelStatus() {
      return (await rig.control.request('judgeModelStatus')) as Record<string, unknown>;
    },
    async waitForModel(state) {
      let status = await rig.modelStatus();
      const deadline = Date.now() + 10_000;
      while (status.state !== state) {
        if (Date.now() > deadline) throw new Error(`Laya never reached ${state}: ${JSON.stringify(status)}`);
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        status = await rig.modelStatus();
      }
      return status;
    },
    async close() {
      await rig.owner?.stop();
      rig.owner = undefined;
      rig.store = undefined;
      for (const child of children) if (!exited(child)) child.kill('SIGKILL');
      await rm(root, { recursive: true, force: true });
    },
  };
  await rig.start();
  return rig;
}

/** A person's terminal approval through the owner's control protocol: the challenge, then the answer. */
async function approve(control: EventControlClient, prepared: unknown, what: string): Promise<void> {
  const approvalId = (prepared as { readonly approvalId?: unknown }).approvalId;
  assert.equal(typeof approvalId, 'string', `${what} prepares an approval: ${JSON.stringify(prepared)}`);
  const answer = await control.request('approve-challenge', { approvalId });
  const completed = (await control.request('approve', { approvalId, answer })) as { readonly status?: unknown };
  assert.equal(completed.status, 'completed', `${what} completes through the owner's control protocol`);
}

/** `judge kind enable laya`, approved at the terminal, and the approved install verified to `ready`. */
async function enableLaya(rig: Rig): Promise<void> {
  await approve(rig.control, await rig.control.request('enableJudgeKind', { kind: LAYA }), 'the Laya enablement');
  await rig.waitForModel('ready');
}

/** The synthetic rule naming the Laya judge, made active through E's approvals, with collection switched on. */
async function activateRule(rig: Rig, onUncertain: 'no-match' | 'hold'): Promise<void> {
  const judge = layaJudge(rig.laya?.manifestId ?? SHIPPED_MANIFEST);
  await rig.control.request('target-add', { document: target });
  await rig.control.request('addJudge', { document: judge });
  await approve(rig.control, await rig.control.request('updateBudget', { document: budget }), 'the judge budget');
  await rig.control.request('rule-create', { document: ruleNaming(judge, onUncertain) });
  await approve(
    rig.control,
    await rig.control.request('rule-enable', { ruleId: 'rule-laya-e2e', version: 1 }),
    'the rule activation',
  );
  await approve(rig.control, await rig.control.request('enable-all'), 'collection');
}

function requests(rig: Rig): readonly Readonly<Record<string, unknown>>[] {
  return rig.written.map((entry) => entry.frame).filter((frame) => frame.type === 'request');
}

async function cli(argv: readonly string[], stateDir: string) {
  const streams = { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() };
  let stdout = '';
  let stderr = '';
  streams.stdout.setEncoding('utf8').on('data', (chunk) => (stdout += String(chunk)));
  streams.stderr.setEncoding('utf8').on('data', (chunk) => (stderr += String(chunk)));
  const code = await run(['--state-dir', stateDir, '--json', ...argv], { streams, env: {} });
  return { code, stdout, stderr };
}

// ------------------------------------------------------------------------------------------------ as shipped

test('E2 end to end held path: with the shipped placeholder lock a Laya rule is configuration, every way to run it refuses, and a restart changes nothing', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  refusedNetwork.length = 0;
  const rig = await laya();
  try {
    const judge = layaJudge(SHIPPED_MANIFEST);
    await rig.control.request('target-add', { document: target });
    await rig.control.request('addJudge', { document: judge });
    const created = (await rig.control.request('rule-create', { document: ruleNaming(judge, 'no-match') })) as {
      readonly id: string;
      readonly state: unknown;
    };
    assert.deepEqual(
      { id: created.id, state: created.state },
      { id: 'rule-laya-e2e@1', state: null },
      'the rule is kept, inert',
    );
    const refusals = async (when: string) => {
      await assert.rejects(
        rig.control.request('rule-enable', { ruleId: 'rule-laya-e2e', version: 1 }),
        refusedWith('E2_EXTERNAL_REFERENCE_BLOCKED'),
        `${when}: rule enable names the release's closed reason`,
      );
      assert.deepEqual(
        await rig.control.request('judgeTest', { judgeId: 'judge-laya-e2e', version: 1 }),
        { kind: 'refused', judgeId: 'judge-laya-e2e', version: 1, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
        `${when}: judge test names the release's closed reason`,
      );
      assert.deepEqual(
        await rig.control.request('enableJudgeKind', { kind: LAYA }),
        { kind: 'unavailable', code: 'E2_EXTERNAL_REFERENCE_BLOCKED', phase: 'E2' },
        `${when}: the kind enablement is refused before any approval exists`,
      );
      const terminal = await cli(['judge', 'kind', 'enable', LAYA], rig.stateDir);
      assert.equal(terminal.code, 0, terminal.stderr);
      assert.deepEqual(
        JSON.parse(terminal.stdout),
        { kind: 'unavailable', code: 'E2_EXTERNAL_REFERENCE_BLOCKED', phase: 'E2' },
        `${when}: the person's terminal shows the same reason`,
      );
      const kinds = (await rig.control.request('judgeKindsList')) as readonly { readonly kind: string }[];
      assert.deepEqual(
        kinds.find((entry) => entry.kind === LAYA),
        {
          kind: LAYA,
          state: 'unavailable',
          code: 'E2_EXTERNAL_REFERENCE_BLOCKED',
        },
      );
      const status = await rig.modelStatus();
      assert.deepEqual(
        { state: status.state, manifestId: status.manifestId, reason: status.reason, lock: status.runtimeLockDigest },
        { state: 'unavailable', manifestId: SHIPPED_MANIFEST, reason: 'E2_EXTERNAL_REFERENCE_BLOCKED', lock: null },
        `${when}: judge model status says why`,
      );
      // A Gmail message the rule's prefilter would pass: the inert rule evaluates nothing, so nothing reaches a judge.
      rig.mailbox.add(MATCHING);
      await rig.tick();
      assert.deepEqual(
        {
          intents: rig.count('activation_intents'),
          layaKinds: rig.count('judge_kind_versions', "kind = 'laya'"),
          pointers: rig.count('active_versions'),
          models: rig.count('laya_models'),
          reservations: rig.count('judge_budget_reservations'),
          decisions: rig.count('decisions'),
          deliveries: rig.count('deliveries'),
          judges: rig.count('judge_versions'),
          rules: rig.count('rule_versions'),
        },
        {
          intents: 0,
          layaKinds: 0,
          pointers: 0,
          models: 0,
          reservations: 0,
          decisions: 0,
          deliveries: 0,
          judges: 1,
          rules: 1,
        },
        `${when}: configuration only — no Laya enablement, intent, pointer, model row or judge work`,
      );
      assert.equal(await treeListing(rig.artifactRoot), null, `${when}: no Laya runtime, model or directory exists`);
    };
    await refusals('as started');
    await rig.restart();
    await refusals('after a restart');
    assert.deepEqual(refusedNetwork, [], 'the shipped owner made no network attempt');
  } finally {
    await rig.close();
  }
});

// ------------------------------------------------------------------------------------------------ as a future release

test('E2 end to end: an approved Laya enablement installs only after its claim, and a synthetic rule matches through E into its target', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  refusedNetwork.length = 0;
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    const origin = rig.origin as LayaArtifactOrigin;
    const synthetic = rig.laya as SyntheticLaya;
    const prepared = await rig.control.request('enableJudgeKind', { kind: LAYA });
    assert.deepEqual(origin.requests, [], 'nothing is fetched while the enablement only waits for its person');
    assert.equal(await treeListing(rig.artifactRoot), null, 'and no Laya directory exists');
    await approve(rig.control, prepared, 'the Laya enablement');
    const ready = await rig.waitForModel('ready');
    assert.equal(ready.manifestId, synthetic.manifestId);
    assert.deepEqual(
      [...origin.requests].sort(),
      [
        ...[...synthetic.archives.keys()],
        ...synthetic.modelFiles.map((file) => modelPath(synthetic, file.path)),
      ].sort(),
      'the claim fetched exactly the lock’s archives and the manifest’s files, once each',
    );
    assert.equal(rig.starts.length, 0, 'an enabled, ready Laya starts no worker before a call');

    await activateRule(rig, 'no-match');
    // The synthetic judge test: the fixed synthetic input, through the same worker path, under its own reservation.
    rig.behaviour.extra = ['--value-json', '0.8125', '--tokens', '41'];
    const tested = (await rig.control.request('judgeTest', { judgeId: 'judge-laya-e2e', version: 1 })) as Record<
      string,
      unknown
    >;
    assert.equal(tested.kind, 'completed', JSON.stringify(tested));
    assert.equal(tested.value, 0.8125);
    assert.equal(rig.starts.length, 1, 'the judge test started the one worker, lazily');

    rig.mailbox.add(FILTERED);
    rig.mailbox.add(MATCHING);
    await rig.tick();
    const frames = requests(rig);
    assert.equal(frames.length, 2, 'the judge test’s frame and one evaluation frame: the prefilter dropped the other');
    const evaluation = rig.written.filter((entry) => entry.frame.type === 'request')[1];
    assert.equal(
      evaluation?.reservation,
      'in-flight',
      'E moved the reservation in flight before the frame was written',
    );
    assert.equal(evaluation?.frame.templateId, LAYA_NOUL_TEMPLATE_ID);
    const state = String(evaluation?.frame.state);
    assert.match(state, /untrusted-content/u, 'the worker receives E’s enveloped input');
    assert.ok(state.includes(MATCHING), 'only the rule’s one selected input');
    assert.equal(state.includes(FILTERED), false, 'and nothing of the message the prefilter dropped');
    assert.doesNotMatch(
      JSON.stringify(evaluation?.frame),
      new RegExp(`${ACCOUNT}|message-laya-e2e|rule-laya-e2e|target-laya-e2e|judge-laya-e2e`, 'u'),
      'no account, message, rule, target or judge identity reaches the worker',
    );
    const body = Buffer.byteLength(
      JSON.stringify({
        templateId: evaluation?.frame.templateId,
        instructions: evaluation?.frame.instructions,
        state: evaluation?.frame.state,
      }),
    );
    assert.deepEqual(
      rig.reservations().map((row) => ({
        state: row.state,
        scope: row.work_scope,
        provider: row.provider,
        kind: row.judge_kind,
        actual: row.actual_input_tokens,
        concurrency: row.concurrency_owned,
      })),
      [
        // D10: a judge test charges the global ceilings and no per-provider one.
        { state: 'settled', scope: 'synthetic-test', provider: null, kind: LAYA, actual: 41, concurrency: 0 },
        { state: 'settled', scope: 'source-owned', provider: LAYA, kind: LAYA, actual: 41, concurrency: 0 },
      ],
      'E settled both calls with the worker’s own token count and freed their concurrency',
    );
    assert.equal(
      rig.reservations()[1]?.estimated_input_tokens,
      body,
      'E reserved against the exact frame payload the worker received',
    );
    const decisions = rig.store?.database.prepare('SELECT outcome FROM decisions ORDER BY rowid').all() as {
      outcome: string;
    }[];
    assert.deepEqual(
      decisions.map((row) => row.outcome),
      ['no-match', 'matched'],
      'the prefilter’s deterministic no-match, with no judge call, then the match E derived from 0.8125 and its threshold',
    );
    const delivered = (await rig.control.request('dryrun-list')) as readonly unknown[];
    assert.equal(delivered.length, 1, 'the match reached the rule’s dry-run target');
    assert.equal(rig.starts.length, 1, 'both calls used the one proven worker');

    await rig.restart();
    assert.equal((await rig.modelStatus()).state, 'ready', 'a restart keeps the verified install ready');
    assert.equal(((await rig.control.request('dryrun-list')) as readonly unknown[]).length, 1, 'and the delivery');
    await rig.tick();
    assert.equal(requests(rig).length, 2, 'the restarted owner does not judge the terminal event again');
    assert.equal(rig.starts.length, 1, 'and starts no worker until a call needs one');
    assert.deepEqual(refusedNetwork, [], 'the sealed owner made no non-loopback network attempt');
  } finally {
    await rig.close();
  }
});

test('E2 end to end: a Laya value in the uncertain band is held, survives a restart, and the kind disable purges it and keeps the verified trees', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    const origin = rig.origin as LayaArtifactOrigin;
    const synthetic = rig.laya as SyntheticLaya;
    await enableLaya(rig);
    await activateRule(rig, 'hold');
    rig.behaviour.extra = ['--value-json', '0.45'];
    rig.mailbox.add(MATCHING);
    await rig.tick();
    const held = (await rig.control.request('heldList')) as { readonly decisions: readonly unknown[] };
    assert.equal(held.decisions.length, 1, '0.45 under a 0.5 threshold is E’s uncertain band: one held decision');
    assert.equal(((await rig.control.request('deliveriesList')) as readonly unknown[]).length, 0, 'and no delivery');

    await rig.restart();
    const kept = (await rig.control.request('heldList')) as { readonly decisions: readonly unknown[] };
    assert.equal(kept.decisions.length, 1, 'the hold survives a restart');
    const requested = origin.requests.length;

    await rig.control.request('disableJudgeKind', { kind: LAYA });
    const purged = (await rig.control.request('heldList')) as { readonly decisions: readonly unknown[] };
    assert.equal(purged.decisions.length, 0, 'the kind disable purged the hold bound to its judge, with no approval');
    const kinds = (await rig.control.request('judgeKindsList')) as readonly { readonly kind: string }[];
    assert.deepEqual(
      kinds.find((entry) => entry.kind === LAYA),
      { kind: LAYA, state: 'disabled', version: null },
    );
    assert.notEqual(
      await treeListing(join(rig.artifactRoot, 'models', synthetic.manifestId)),
      null,
      'the verified model survives the disable',
    );
    assert.equal(rig.count('rule_versions', "state = 'active'"), 1, 'the rule version is not revoked');
    assert.equal(rig.count('judge_versions', 'revoked_at IS NULL'), 1, 'nor the judge version');

    await enableLaya(rig);
    assert.equal(origin.requests.length, requested, 're-enabling the same entry reuses its verified trees');
    await assert.rejects(
      rig.control.request('removeJudgeModel'),
      (error: unknown) =>
        error instanceof CommsError && (error.details as { reason?: unknown } | undefined)?.reason === 'LAYA_ENABLED',
      'the model cannot be removed while Laya is enabled',
    );
    await rig.control.request('disableJudgeKind', { kind: LAYA });
    await rig.control.request('removeJudgeModel');
    assert.equal(
      await treeListing(join(rig.artifactRoot, 'models', synthetic.manifestId)),
      null,
      'judge model remove deletes the verified model',
    );
    await rig.restart();
    assert.equal(await treeListing(join(rig.artifactRoot, 'models', synthetic.manifestId)), null);
    assert.equal((await rig.modelStatus()).state, 'idle', 'and a restart finds nothing to resume');
  } finally {
    await rig.close();
  }
});

test('E2 end to end: a crashed worker is no-match with its estimate charged, and the next call starts a freshly proved child', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    await enableLaya(rig);
    await activateRule(rig, 'no-match');
    rig.behaviour.serve = 'crash';
    rig.mailbox.add(MATCHING);
    await rig.tick();
    await waitUntil(() => exited(rig.children[0]), 5_000, 'the crashed worker');
    const [crashed] = rig.reservations();
    assert.deepEqual(
      { state: crashed?.state, actual: crashed?.actual_input_tokens },
      { state: 'settled', actual: null },
      'E settled the post-I/O call pessimistically: the estimate is charged',
    );
    assert.equal(rig.count('deliveries'), 0, 'a crash is no-match');

    rig.behaviour.serve = 'answer';
    rig.behaviour.extra = ['--value-json', '0.9'];
    rig.mailbox.add(`${MATCHING} (second)`);
    await rig.tick();
    assert.equal(rig.starts.length, 2, 'the next call started a new child, proved again from the beginning');
    assert.equal(exited(rig.children[1]), false);
    assert.equal(((await rig.control.request('dryrun-list')) as readonly unknown[]).length, 1);
    assert.equal((await rig.modelStatus()).state, 'ready', 'a crash records nothing against the verified install');
  } finally {
    await rig.close();
  }
});

/** A hung Laya call in flight, one E purge through the owner's control, and what that purge must leave behind. */
async function purgesInFlightWork(name: string, purge: (rig: Rig) => Promise<unknown>): Promise<void> {
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    await enableLaya(rig);
    await activateRule(rig, 'no-match');
    rig.behaviour.serve = 'hang';
    rig.mailbox.add(MATCHING);
    const ticking = rig.tick(1);
    await waitUntil(() => requests(rig).length === 1, 10_000, 'the request frame');
    assert.equal(rig.reservations()[0]?.state, 'in-flight');
    await purge(rig);
    await waitUntil(() => exited(rig.children[0]), 5_000, `${name} to kill the hung worker`);
    await ticking;
    const [reservation] = rig.reservations();
    assert.deepEqual(
      { state: reservation?.state, concurrency: reservation?.concurrency_owned },
      { state: 'settled', concurrency: 0 },
      `${name}: E's purge settled the in-flight call and freed its concurrency`,
    );
    assert.equal(rig.count('deliveries'), 0, `${name}: nothing is delivered`);
    assert.notEqual(
      await treeListing(join(rig.artifactRoot, 'models', (rig.laya as SyntheticLaya).manifestId)),
      null,
      `${name}: no verified tree is touched`,
    );
    await rig.restart();
    await rig.tick();
    assert.equal(rig.starts.length, 1, `${name}: a restart revives no purged work`);
  } finally {
    await rig.close();
  }
}

test(
  'E2 end to end: the Laya kind disable kills the in-flight Laya worker, settles its reservation and keeps the verified trees',
  {
    skip: WINDOWS_SKIP,
    timeout: CHILD_TEST_TIMEOUT_MS,
  },
  () => purgesInFlightWork('the Laya kind disable', (rig) => rig.control.request('disableJudgeKind', { kind: LAYA })),
);

test(
  'E2 end to end: disable-all kills the in-flight Laya worker, settles its reservation and keeps the verified trees',
  {
    skip: WINDOWS_SKIP,
    timeout: CHILD_TEST_TIMEOUT_MS,
  },
  () => purgesInFlightWork('disable-all', (rig) => rig.control.request('disable-all')),
);

test(
  'E2 end to end: the rule’s disable kills the in-flight Laya worker, settles its reservation and keeps the verified trees',
  {
    skip: WINDOWS_SKIP,
    timeout: CHILD_TEST_TIMEOUT_MS,
  },
  () =>
    purgesInFlightWork('the rule’s disable', (rig) => rig.control.request('rule-disable', { ruleId: 'rule-laya-e2e' })),
);

test(
  'E2 end to end: the judge’s removal kills the in-flight Laya worker, settles its reservation and keeps the verified trees',
  {
    skip: WINDOWS_SKIP,
    timeout: CHILD_TEST_TIMEOUT_MS,
  },
  () =>
    purgesInFlightWork('the judge’s removal', (rig) =>
      rig.control.request('removeJudge', { judgeId: 'judge-laya-e2e' }),
    ),
);

test('E2 end to end: a stop during the download resumes the install at the next start, and a disable during it deletes the partial', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const synthetic = await syntheticLaya();
  const origin = layaArtifactOrigin(synthetic);
  const rig = await laya({ laya: synthetic, origin });
  try {
    const data = modelPath(synthetic, 'laya.onnx.data');
    const first = origin.gate(data);
    await approve(rig.control, await rig.control.request('enableJudgeKind', { kind: LAYA }), 'the Laya enablement');
    await first.reached;
    assert.equal((await rig.modelStatus()).state, 'downloading');
    const stopping = rig.restart();
    first.release();
    await stopping;
    // The clean stop deleted its partial; the start resumed the approved, unfinished install from the first byte.
    await rig.waitForModel('ready');
    assert.equal(
      origin.requests.filter((path) => path === data).length,
      2,
      'the interrupted file was requested again by the restarted owner',
    );

    await rig.control.request('disableJudgeKind', { kind: LAYA });
    await rig.control.request('removeJudgeModel');
    const second = origin.gate(data);
    await approve(rig.control, await rig.control.request('enableJudgeKind', { kind: LAYA }), 'the second enablement');
    await second.reached;
    await rig.control.request('disableJudgeKind', { kind: LAYA });
    second.release();
    const listing = (await treeListing(rig.artifactRoot)) ?? [];
    assert.deepEqual(
      listing.filter((path) => /\.partial|staging/u.test(path)),
      [],
      'a disable mid-download deletes the partial and staging trees',
    );
    assert.equal((await rig.modelStatus()).state, 'idle');
    await rig.restart();
    assert.equal((await rig.modelStatus()).state, 'idle', 'a disabled kind resumes nothing after a restart');
  } finally {
    await rig.close();
  }
});

test('E2 end to end: a failed boundary proof leaves Laya failed across a restart until its person disables and re-enables it', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    await enableLaya(rig);
    await activateRule(rig, 'no-match');
    rig.behaviour.probe = 'tcp';
    rig.mailbox.add(MATCHING);
    await rig.tick();
    assert.equal(rig.starts.length, 1);
    assert.equal(rig.written.length, 0, 'the escaped child received no load and no request');
    const failed = await rig.modelStatus();
    assert.deepEqual({ state: failed.state, code: failed.failureCode }, { state: 'failed', code: 'boundary-failed' });
    assert.equal(rig.reservations()[0]?.state, 'released', 'nothing reached a worker: E released the reservation');
    assert.equal(rig.count('deliveries'), 0);

    await rig.restart();
    rig.behaviour.probe = 'all-denied';
    rig.mailbox.add(`${MATCHING} (after restart)`);
    await rig.tick();
    assert.equal((await rig.modelStatus()).failureCode, 'boundary-failed', 'the failure persists across a restart');
    assert.equal(rig.starts.length, 1, 'and no further child starts until the person acts');

    await rig.control.request('disableJudgeKind', { kind: LAYA });
    await enableLaya(rig);
    rig.mailbox.add(`${MATCHING} (re-enabled)`);
    await rig.tick();
    assert.equal(rig.starts.length, 2, 'the re-enabled Laya proves a new child');
    assert.equal(((await rig.control.request('dryrun-list')) as readonly unknown[]).length, 1);
  } finally {
    await rig.close();
  }
});

test('E2 end to end: the owner’s stop kills its idle Laya worker and leaves no worker directory behind', {
  skip: WINDOWS_SKIP,
  timeout: CHILD_TEST_TIMEOUT_MS,
}, async () => {
  const rig = await laya({ laya: await syntheticLaya() });
  try {
    await enableLaya(rig);
    await activateRule(rig, 'no-match');
    rig.mailbox.add(MATCHING);
    await rig.tick();
    assert.equal(rig.starts.length, 1);
    assert.equal(exited(rig.children[0]), false, 'the answered worker waits, idle');
    await rig.owner?.stop();
    rig.owner = undefined;
    rig.store = undefined;
    await waitUntil(() => exited(rig.children[0]), 5_000, 'the stopped owner’s worker to exit');
    await assert.rejects(stat(rig.directories[0] ?? ''), { code: 'ENOENT' }, 'its owner-only directory is removed');
  } finally {
    await rig.close();
  }
});
