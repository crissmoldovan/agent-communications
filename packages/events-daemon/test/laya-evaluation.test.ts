import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { type SecretStore, TaintStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { canonicalJudge, layaEnablementInputsFor, registerLayaEnablementInputs } from '../src/domain/judges.ts';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { JudgeCoordinator } from '../src/runtime/judge-coordinator.ts';
import { JudgeTestControl } from '../src/runtime/judge-test.ts';
import { LAYA_NOUL_TEMPLATE_ID } from '../src/runtime/laya/templates.ts';
import { createLayaWorkerBoundaryForTest } from '../src/runtime/laya/worker-boundary-probe.ts';
import { WorkerFrameParser } from '../src/runtime/laya/worker-protocol.ts';
import {
  type LayaWorkerArtifacts,
  LayaWorkerSupervisor,
  registerLayaJudgeExecutor,
} from '../src/runtime/laya/worker-supervisor.ts';
import { type EventTaintRecorder, recordEventTaint } from '../src/runtime/untrusted.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { LAYA, type LayaRig, layaRig, macPlatform, syntheticLaya } from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

assertLoopbackSeal();

const standin = fileURLToPath(new URL('./support/laya-worker-standin.ts', import.meta.url));
const NOW = 1_800_000_000_000;
const ACCOUNT_A = 'ibx_E2T8LAYAA';
const ACCOUNT_B = 'ibx_E2T8LAYAB';

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref);
  }
  invalidate(): void {}
}

const target = { targetId: 'target-e2-t8', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };

function layaJudge(manifestId: string) {
  return {
    judgeId: 'judge-laya-t8',
    version: 1,
    kind: LAYA,
    provider: LAYA,
    model: manifestId,
    promptTemplate: LAYA_NOUL_TEMPLATE_ID,
  };
}

function ruleFor(manifestId: string, condition: unknown) {
  return {
    ruleId: 'rule-laya-t8',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT_A, ACCOUNT_B],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition,
    agentic: {
      judge: layaJudge(manifestId),
      question: 'Does this synthetic message ask for a reply?',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match' as const,
      callsPerRollingHour: 10,
      inputTokensPerRolling30Days: 100_000,
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
      ingestMs: 60_000,
      holdMs: 60_000,
      deliveryMs: 60_000,
      dryrunMs: 60_000,
      sseReplayMs: 60_000,
      deadLetterMs: 60_000,
      decisionMetadataMs: 60_000,
    },
  };
}

const fence = async () => ({
  approvalId: 'approval',
  authorizationActivationId: 'activation',
  usedAt: 'now',
  switchGeneration: 7,
});

interface Written {
  readonly frame: Readonly<Record<string, unknown>>;
  /** The durable reservation state at the instant the frame was written. */
  readonly reservation: string | null;
}

interface Evaluation {
  readonly rig: LayaRig;
  readonly supervisor: LayaWorkerSupervisor;
  readonly evaluator: EventEvaluator;
  readonly judgeTest: JudgeTestControl;
  readonly children: ChildProcessWithoutNullStreams[];
  readonly written: Written[];
  readonly attempts: number[];
  admit(account?: string): Promise<'terminal' | 'pending'>;
  count(table: string): number;
  reservation(): Record<string, unknown> | null;
  close(): Promise<void>;
}

function eventFor(account: string) {
  return {
    ...gmailMessageReceivedV1.examples[1],
    id: account === ACCOUNT_A ? 'e2t8aaaaaaaaaaaaaaaaaaaaaaaaaaaa' : 'e2t8bbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    account: { name: 'Synthetic', id: account, channel: 'gmail' as const },
    subject: 'sender@example.test asks for a reply',
    from: { address: 'sender@example.test', name: 'Synthetic Sender' },
  };
}

/**
 * The owner's own composition over E's real paths: the E2 rig's approved, installed and verified Laya (its sealed
 * origin served the tiny model), E's judge, budget, rule and ingest rows, E's evaluator and coordinator, and one Laya
 * supervisor whose child is Task 7's frame-compatible stand-in behind the real proof.
 */
async function evaluation(
  options: {
    readonly serve?: string;
    readonly extra?: readonly string[];
    readonly requestDeadlineMs?: number;
    readonly condition?: unknown;
    readonly budget?: boolean;
    readonly availability?: LayaWorkerArtifacts['availability'];
    /** Task 7's stand-in probe behaviour; `all-denied` passes the proof. */
    readonly probe?: string;
    /** Awaited at each worker start, before its proof: a test pauses the start there (E2 Task 12). */
    readonly beforeStart?: () => Promise<void>;
  } = {},
): Promise<Evaluation> {
  const laya = await syntheticLaya();
  const platform = macPlatform();
  const rig = await layaRig({ laya, platform });
  const database = rig.store.database;
  const unregisterInputs = registerLayaEnablementInputs(database, {
    layaAssetSource: laya.assets,
    layaPlatformProbe: platform,
  });
  await rig.enable();
  await rig.manager.ensureInstalled();
  assert.equal(rig.manager.status().state, 'ready', 'the approved model installed and verified');

  database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
  await selectEventSecretStore(database, 'file');
  const secrets = await openEventSecretStore({
    database,
    paths: rig.store.paths,
    configDir: join(rig.root, 'config'),
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(database, secrets, testWriterQuiescer());
  const versions = new ImmutableVersions(database);
  versions.createTarget(target);
  versions.createJudge(layaJudge(laya.manifestId));
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 2 },
    providers: [{ provider: LAYA, callsPerRollingHour: 10, inputTokensPerRolling30Days: 100_000, concurrency: 1 }],
  });
  versions.createRule(ruleFor(laya.manifestId, options.condition ?? { path: '/subject', op: 'exists' }));
  if (options.budget !== false)
    database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, 'budget-t8', ${NOW})`,
    );
  database.exec(
    `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-laya-t8', 1, 'rule-t8', ${NOW}); UPDATE rule_versions SET state = 'active', approval_id = 'approval', authorization_activation_id = 'activation', activated_at = ${NOW} WHERE rule_id = 'rule-laya-t8' AND version = 1;`,
  );
  for (const account of [ACCOUNT_A, ACCOUNT_B]) {
    const event = eventFor(account);
    (
      database.prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ) as unknown as { run(...values: unknown[]): void }
    ).run(event.id, rig.store.installationId, event.type, account, `t8-${account}`, NOW, NOW, NOW);
  }

  const children: ChildProcessWithoutNullStreams[] = [];
  const written: Written[] = [];
  const attempts: number[] = [];
  const manager = rig.manager;
  const artifacts: LayaWorkerArtifacts =
    options.availability === undefined
      ? manager
      : {
          availability: options.availability,
          workerSelection: () => manager.workerSelection(),
          verifyForWorkerStart: () => manager.verifyForWorkerStart(),
          recordWorkerFailure: (selection, code) => manager.recordWorkerFailure(selection, code),
          trackWork: (id) => manager.trackWork(id),
          attachWorker: (worker) => manager.attachWorker(worker),
        };
  const supervisor = new LayaWorkerSupervisor({
    artifacts,
    ...(options.requestDeadlineMs === undefined ? {} : { requestDeadlineMs: options.requestDeadlineMs }),
    startWorker: async ({ dataDirectory, signal }) => {
      attempts.push(attempts.length + 1);
      await options.beforeStart?.();
      const result = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory,
        workerEntry: standin,
        signal,
        spawn: (_command, _args, spawnOptions) =>
          spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              standin,
              '--standin',
              options.probe ?? 'all-denied',
              '--serve',
              options.serve ?? 'answer',
              ...(options.extra ?? []),
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
              const row = database.prepare('SELECT state FROM judge_budget_reservations').get() as
                | { state: string }
                | undefined;
              written.push({ frame, reservation: row?.state ?? null });
            }
          return write(chunk, ...rest);
        }) as typeof result.child.stdin.write;
      }
      return result;
    },
  });
  const unregisterExecutor = registerLayaJudgeExecutor(database, supervisor);
  const taintStore = new TaintStore(join(rig.root, 'taint'), () => new Date(NOW));
  const taint: EventTaintRecorder = {
    async record(input) {
      await recordEventTaint(taintStore, { ownAddresses: [], internalDomains: [] }, input);
    },
  };
  let sequence = 0;
  const coordinator = new JudgeCoordinator({
    store: rig.store,
    now: () => NOW,
    newId: () => `laya-reservation-${++sequence}`,
    taint,
  });
  const evaluator = new EventEvaluator({
    store: rig.store,
    cipher,
    now: () => NOW,
    newId: () => `laya-decision-${++sequence}`,
    fence,
    taint,
    judgeCoordinator: coordinator,
  });
  const judgeTest = new JudgeTestControl({
    store: rig.store,
    taint,
    now: () => NOW,
    newId: () => `laya-test-${++sequence}`,
  });
  return {
    rig,
    supervisor,
    evaluator,
    judgeTest,
    children,
    written,
    attempts,
    admit: (account = ACCOUNT_A) => {
      const event = eventFor(account);
      return evaluator.admit({ event, eventId: event.id, ruleId: 'rule-laya-t8', ruleVersion: 1, stagedAt: NOW });
    },
    count: (table) => (database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count,
    reservation: () => {
      const row = database
        .prepare(
          'SELECT state, provider, judge_kind, estimated_input_tokens, actual_input_tokens, concurrency_owned FROM judge_budget_reservations',
        )
        .get();
      return row === undefined ? null : { ...row };
    },
    async close() {
      await supervisor.close();
      unregisterExecutor();
      unregisterInputs();
      await rig.close();
    },
  };
}

function exited(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return child !== undefined && (child.exitCode !== null || child.signalCode !== null);
}

async function waitUntil(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test('E2 Laya evaluation uses coordinator answer', { skip: WINDOWS_SKIP }, async () => {
  const run = await evaluation({ extra: ['--value-json', '0.8125', '--tokens', '41'] });
  try {
    assert.equal(await run.admit(), 'terminal');
    assert.equal(run.attempts.length, 1, 'one worker, started lazily by the first call');
    const requests = run.written.filter((entry) => entry.frame.type === 'request');
    assert.equal(requests.length, 1, 'exactly one framed request');
    const [request] = requests;
    assert.equal(request?.reservation, 'in-flight', 'E moved the reservation in flight before the frame was written');
    assert.equal(request?.frame.templateId, LAYA_NOUL_TEMPLATE_ID);
    assert.match(String(request?.frame.state), /untrusted-content/u, 'the worker gets E’s enveloped input');
    assert.doesNotMatch(
      JSON.stringify(request?.frame),
      new RegExp(`${ACCOUNT_A}|e2t8aaaa|target-e2-t8|rule-laya-t8`, 'u'),
    );
    const body = Buffer.byteLength(
      JSON.stringify({
        templateId: request?.frame.templateId,
        instructions: request?.frame.instructions,
        state: request?.frame.state,
      }),
    );
    assert.deepEqual(run.reservation(), {
      state: 'settled',
      provider: LAYA,
      judge_kind: LAYA,
      estimated_input_tokens: body,
      actual_input_tokens: 41,
      concurrency_owned: 0,
    });
    const decision = run.rig.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string };
    assert.equal(decision.outcome, 'matched', 'E derived the match from the unchanged 0.8125 and its threshold');
    assert.equal(run.count('deliveries'), 1);
  } finally {
    await run.close();
  }
});

test('E2 Laya evaluation: no worker for a false prefilter, a disabled kind, unavailable Laya or no budget', {
  skip: WINDOWS_SKIP,
}, async () => {
  const prefilter = await evaluation({
    condition: { path: '/subject', op: 'equals', value: 'never', caseSensitive: false },
  });
  try {
    assert.equal(await prefilter.admit(), 'terminal');
    assert.equal(prefilter.count('judge_budget_reservations'), 0);
    assert.equal(prefilter.attempts.length, 0);
  } finally {
    await prefilter.close();
  }
  const disabled = await evaluation();
  try {
    await disabled.rig.disable();
    assert.equal(await disabled.admit(), 'terminal');
    assert.equal(disabled.count('judge_budget_reservations'), 0);
    assert.equal(disabled.attempts.length, 0);
  } finally {
    await disabled.close();
  }
  const unavailable = await evaluation({
    availability: () => ({ available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' }),
  });
  try {
    assert.equal(await unavailable.admit(), 'terminal');
    assert.equal(unavailable.count('judge_budget_reservations'), 0);
    assert.equal(unavailable.attempts.length, 0, 'the placeholder lock spawns nothing');
  } finally {
    await unavailable.close();
  }
  const unbudgeted = await evaluation({ budget: false });
  try {
    assert.equal(await unbudgeted.admit(), 'terminal');
    assert.equal(unbudgeted.count('judge_budget_reservations'), 0);
    assert.equal(unbudgeted.attempts.length, 0);
  } finally {
    await unbudgeted.close();
  }
});

test('E2 Laya evaluation: a timeout, crash or malformed answer is no-match and charges the estimate', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [serve, extra] of [
    ['hang', []],
    ['crash', []],
    ['answer', ['--value-json', '1.5']],
    ['token-limit', []],
  ] as const) {
    const run = await evaluation({ serve, extra, requestDeadlineMs: 400 });
    try {
      assert.equal(await run.admit(), 'terminal', serve);
      const reservation = run.reservation();
      assert.equal(reservation?.state, 'settled', `${serve}: E settled the in-flight call`);
      assert.equal(reservation?.actual_input_tokens, null, `${serve}: the estimate is charged, never refunded`);
      const decision = run.rig.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string };
      assert.equal(decision.outcome, 'no-match', `${serve}: D5 records no-match`);
      assert.equal(run.count('deliveries'), 0);
    } finally {
      await run.close();
    }
  }
});

test('E2 purge kills only its in-flight Laya work', { skip: WINDOWS_SKIP }, async () => {
  const run = await evaluation({ serve: 'hang', requestDeadlineMs: 30_000 });
  try {
    const admitted = run.admit(ACCOUNT_A);
    await waitUntil(() => run.written.some((entry) => entry.frame.type === 'request'), 10_000, 'the request');
    // Another account's removal settles none of this request's work, so it stops nothing.
    run.rig.store.immediate(() =>
      purgeRemovedAccountWork(run.rig.store.database, { source: 'gmail', accountId: ACCOUNT_B }, NOW),
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.equal(exited(run.children[0]), false, 'the in-flight worker survives an unrelated purge');
    assert.equal(run.reservation()?.state, 'in-flight');
    run.rig.store.immediate(() =>
      purgeRemovedAccountWork(run.rig.store.database, { source: 'gmail', accountId: ACCOUNT_A }, NOW),
    );
    await waitUntil(() => exited(run.children[0]), 5_000, 'the purged request’s worker to be killed');
    await admitted.catch(() => undefined);
    assert.equal(run.reservation()?.state, 'settled', 'E’s purge, not the worker, settled the reservation');
    assert.equal(run.rig.manager.status().state, 'ready', 'no verified tree was touched');
  } finally {
    await run.close();
  }
});

test('E2 Laya evaluation: a kind disable stops the idle worker', { skip: WINDOWS_SKIP }, async () => {
  const run = await evaluation();
  try {
    assert.equal(await run.admit(), 'terminal');
    assert.equal(exited(run.children[0]), false);
    await run.rig.disable();
    await waitUntil(() => exited(run.children[0]), 5_000, 'the disabled kind’s worker to exit');
  } finally {
    await run.close();
  }
});

test('E2 no worker before approved synthetic call', { skip: WINDOWS_SKIP }, async () => {
  const run = await evaluation({ extra: ['--value-json', '0.25', '--tokens', '19'] });
  try {
    const database = run.rig.store.database;
    const unreferenced = await run.judgeTest.test({ judgeId: 'judge-laya-t8', version: 2 });
    assert.equal(unreferenced.kind, 'refused');
    assert.equal(run.attempts.length, 0, 'no worker for a judge version no active rule references');
    const approved = await run.judgeTest.test({ judgeId: 'judge-laya-t8', version: 1 });
    assert.equal(approved.kind, 'completed');
    if (approved.kind === 'completed') assert.equal(approved.value, 0.25);
    assert.equal(run.attempts.length, 1);
    const reservation = database
      .prepare(
        "SELECT state, actual_input_tokens, work_scope FROM judge_budget_reservations WHERE work_scope = 'synthetic-test' AND test_work_id IS NOT NULL",
      )
      .get() as { state: string; actual_input_tokens: number; work_scope: string };
    assert.deepEqual({ ...reservation }, { state: 'settled', actual_input_tokens: 19, work_scope: 'synthetic-test' });
    await run.rig.disable();
    const disabledTest = await run.judgeTest.test({ judgeId: 'judge-laya-t8', version: 1 });
    assert.equal(disabledTest.kind, 'refused', 'a disabled kind’s judge is not tested');
    assert.equal(run.attempts.length, 1, 'and starts no worker');
  } finally {
    await run.close();
  }
});

test('E2 Laya judge document: one exact shape, and none where Laya is not offered', {
  skip: WINDOWS_SKIP,
}, async () => {
  const document = layaJudge('laya-en-onnx-tiny-v1');
  assert.deepEqual(canonicalJudge(document), document);
  for (const changed of [
    { ...document, provider: 'typesafe' },
    { ...document, promptTemplate: 'laya-free-text-v1' },
    { ...document, endpoint: 'http://127.0.0.1/v1/systemone' },
    { ...document, model: '' },
  ])
    assert.throws(() => canonicalJudge(changed), EventDomainError, JSON.stringify(changed));

  const stateDir = await shortTempDir('laya-t8-doc-');
  const { openEventDatabase } = await import('../src/store/database.ts');
  const store = await openEventDatabase({ stateDir });
  try {
    // This database registers no fixture bytes: the shipped placeholder lock decides, as in production.
    assert.deepEqual(layaEnablementInputsFor(store.database), {});
    const blocked = (error: unknown) =>
      error instanceof EventDomainError && error.code === 'E2_EXTERNAL_REFERENCE_BLOCKED';
    assert.throws(() => new ImmutableVersions(store.database).createJudge(document), blocked);
    assert.throws(
      () =>
        new ImmutableVersions(store.database).createRule(
          ruleFor('laya-en-onnx-tiny-v1', { path: '/subject', op: 'exists' }),
        ),
      blocked,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM judge_versions').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
    const { rm } = await import('node:fs/promises');
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E2 Laya judge document: B3 v1’s judge inventory carries no Laya row', { skip: WINDOWS_SKIP }, async () => {
  const run = await evaluation();
  try {
    const operator = new B3OperatorControl({
      store: run.rig.store,
      ports: { quiescer: new WriterQuiescer() } as never,
      now: () => NOW,
    });
    assert.equal(run.count('judge_versions'), 1, 'the Laya judge exists');
    assert.deepEqual(operator.judgesList(), []);
  } finally {
    await run.close();
  }
});

test('E2 Laya evaluation: a failed proof leaves Laya failed with boundary-failed, and no second child starts', {
  skip: WINDOWS_SKIP,
}, async () => {
  const run = await evaluation({ probe: 'tcp' });
  try {
    assert.equal(await run.admit(ACCOUNT_A), 'terminal', 'no request reached a worker: E released it as no-match');
    assert.equal(run.reservation()?.state, 'released');
    const decision = run.rig.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string };
    assert.equal(decision.outcome, 'no-match', 'a failed boundary never holds the source scope behind it');
    assert.equal(run.attempts.length, 1);
    assert.equal(run.written.length, 0, 'the escaped child received no load');
    const status = run.rig.manager.status();
    assert.equal(status.state, 'failed');
    assert.equal(status.failureCode, 'boundary-failed');
    assert.equal(await run.admit(ACCOUNT_B), 'terminal');
    assert.equal(run.attempts.length, 1, 'a failed boundary starts no further child until its person acts');
  } finally {
    await run.close();
  }
});

test('E2 Laya evaluation: a worker failure is recorded only for the selection its trees were verified for', {
  skip: WINDOWS_SKIP,
}, async () => {
  const run = await evaluation();
  try {
    const stale = run.rig.manager.workerSelection();
    assert.ok(stale !== null);
    await run.rig.disable();
    await run.rig.enable();
    await run.rig.manager.ensureInstalled();
    assert.equal(run.rig.manager.status().state, 'ready');
    run.rig.manager.recordWorkerFailure(stale, 'boundary-failed');
    assert.equal(run.rig.manager.status().state, 'ready', 'a failure from a superseded selection records nothing');
    const current = run.rig.manager.workerSelection();
    assert.ok(current !== null);
    run.rig.manager.recordWorkerFailure(current, 'runtime-failed');
    assert.equal(run.rig.manager.status().failureCode, 'runtime-failed');
  } finally {
    await run.close();
  }
});

test('E2 Laya judge test: where Laya is not offered it is refused with Laya’s own reason, before any reservation or worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  const run = await evaluation({ availability: () => ({ available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' }) });
  try {
    // An active rule names the judge, so E grants the synthetic test; only the executor's own check refuses it.
    assert.deepEqual(await run.judgeTest.test({ judgeId: 'judge-laya-t8', version: 1 }), {
      kind: 'refused',
      judgeId: 'judge-laya-t8',
      version: 1,
      code: 'E2_EXTERNAL_REFERENCE_BLOCKED',
    });
    assert.equal(run.count('judge_budget_reservations'), 0, 'nothing was reserved');
    assert.equal(run.attempts.length, 0, 'no worker was started');
  } finally {
    await run.close();
  }
});

test('E2 race: a budget swapped while a Laya worker starts lets no request reach the worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  let reached!: () => void;
  let release!: () => void;
  const paused = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const run = await evaluation({
    extra: ['--value-json', '0.9', '--tokens', '20'],
    beforeStart: async () => {
      reached();
      await released;
    },
  });
  try {
    const admitted = run.admit();
    // E has reserved the request against budget version 1; the worker's start is paused before its proof.
    await paused;
    assert.equal(run.reservation()?.state, 'reserved');
    const versions = new ImmutableVersions(run.rig.store.database);
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 2,
      global: { callsPerRollingHour: 5, inputTokensPerRolling30Days: 50_000, concurrency: 2 },
      providers: [{ provider: LAYA, callsPerRollingHour: 5, inputTokensPerRolling30Days: 50_000, concurrency: 1 }],
    });
    // The person approves a new budget through E's own activation; its pointer swaps at once.
    const prepared = await run.rig.activations.prepareJudgeBudget({ version: 2 });
    const answer = await run.rig.activations.issueChallenge(prepared.approvalId);
    await run.rig.activations.approve({ approvalId: prepared.approvalId, answer });
    release();
    assert.equal(await admitted, 'terminal');
    assert.deepEqual(
      run.written.filter((entry) => entry.frame.type === 'request'),
      [],
      'E’s final gate refused the stale reservation, so no request frame was written',
    );
    assert.equal(run.reservation()?.state, 'released', 'nothing reached the worker: E released the reservation');
    const decision = run.rig.store.database.prepare('SELECT outcome FROM decisions').get() as { outcome: string };
    assert.equal(decision.outcome, 'no-match', 'D5 records no-match');
    assert.equal(run.count('deliveries'), 0);
  } finally {
    release();
    await run.close();
  }
});
