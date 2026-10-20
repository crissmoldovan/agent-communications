import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { registerLayaEnablementInputs, TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../src/domain/judges.ts';
import { JUDGE_KINDS } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { beginJudgeTransport, reserveJudgeWork } from '../src/runtime/judge-budget.ts';
import { JudgePurgeParticipant, registerJudgeWorkPurgeListener } from '../src/runtime/judge-purge.ts';
import { recoverJudgeWork } from '../src/runtime/judge-recovery.ts';
import { LAYA_NOUL_TEMPLATE_ID } from '../src/runtime/laya/templates.ts';
import { createLayaWorkerBoundaryForTest } from '../src/runtime/laya/worker-boundary-probe.ts';
import { LayaWorkerSupervisor } from '../src/runtime/laya/worker-supervisor.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { purgeRevokedRuleWork, shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { LAYA, type LayaRig, layaRig, macPlatform, syntheticLaya, treeListing } from './support/laya-artifacts.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const NOW = 1_800_000_000_000;
const ACCOUNT_A = 'ibx_E2T6PURGEAAAAAA';
const ACCOUNT_B = 'ibx_E2T6PURGEBBBBBB';
const judge = {
  judgeId: 'judge-e2-t6-purge',
  version: 1,
  kind: JUDGE_KINDS[0],
  provider: JUDGE_KINDS[0],
  model: 'jev-1.13.0' as const,
  endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT as typeof TYPESAFE_SYSTEM_ONE_ENDPOINT,
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};
const limits = { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 3, maxInputTokens: 128 };
const target = { targetId: 'target-e2-t6-purge', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };

function rule(ruleId: string, accountId: string): CanonicalFullRuleDocument {
  return {
    ruleId,
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [accountId],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    agentic: {
      judge,
      question: 'synthetic E2 Task 6 purge fixture',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match',
      ...limits,
      maxOutputTokens: 32,
    },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 1,
    retention: {
      ingestMs: 1_000,
      holdMs: 1_000,
      deliveryMs: 1_000,
      dryrunMs: 1_000,
      sseReplayMs: 1_000,
      deadLetterMs: 1_000,
      decisionMetadataMs: 1_000,
    },
  } as CanonicalFullRuleDocument;
}

/** E's own reservation path: an in-flight judge request for one exact rule, account and event. */
function inFlight(rig: LayaRig, input: { id: string; ruleId: string; accountId: string; eventId: string }): void {
  rig.store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    )
    .run(input.eventId, rig.store.installationId, input.accountId, input.eventId, NOW, NOW, NOW);
  rig.store.database
    .prepare(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES (?, ?, 1, ?, X'01')`,
    )
    .run(input.eventId, input.ruleId, NOW + 10_000);
  reserveJudgeWork({
    store: rig.store,
    id: input.id,
    workId: `work:${input.id}`,
    scope: {
      scope: 'source-owned',
      source: 'gmail',
      accountId: input.accountId,
      eventId: input.eventId,
      ruleId: input.ruleId,
      ruleVersion: 1,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    },
    judge,
    limits,
    finalEnvelope: Buffer.from(input.id),
    switchGeneration: 0,
    now: NOW,
  });
  beginJudgeTransport({ store: rig.store, reservationId: input.id, now: NOW });
}

async function seededRig(): Promise<LayaRig> {
  const rig = await layaRig();
  await rig.enable();
  await rig.manager.ensureInstalled();
  assert.equal(rig.manager.status().state, 'ready');
  const versions = new ImmutableVersions(rig.store.database);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeKind({
    id: `judge-kind:${JUDGE_KINDS[0]}`,
    kind: JUDGE_KINDS[0],
    version: 1,
    endpoint: judge.endpoint,
  });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 3 },
    providers: [
      { provider: JUDGE_KINDS[0], callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 3 },
    ],
  });
  for (const [ruleId, accountId] of [
    ['rule-e2-t6-a', ACCOUNT_A],
    ['rule-e2-t6-b', ACCOUNT_B],
  ] as const) {
    versions.createRule(rule(ruleId, accountId));
    rig.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, NULL, 1)",
      )
      .run(ruleId);
    rig.store.database
      .prepare(
        `UPDATE rule_versions SET state = 'active', approval_id = 'approval-e2-t6', authorization_activation_id = ?,
           activated_at = 1 WHERE rule_id = ? AND version = 1`,
      )
      .run(`activation-${ruleId}`, ruleId);
  }
  rig.store.database
    .prepare(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', ?, 1, NULL, 1)`,
    )
    .run(JUDGE_KINDS[0]);
  rig.store.database.exec(
    'UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1',
  );
  inFlight(rig, { id: 'work-a', ruleId: 'rule-e2-t6-a', accountId: ACCOUNT_A, eventId: 'event-e2-t6-a' });
  inFlight(rig, { id: 'work-b1', ruleId: 'rule-e2-t6-b', accountId: ACCOUNT_B, eventId: 'event-e2-t6-b1' });
  inFlight(rig, { id: 'work-b2', ruleId: 'rule-e2-t6-b', accountId: ACCOUNT_B, eventId: 'event-e2-t6-b2' });
  return rig;
}

async function verifiedTrees(rig: LayaRig): Promise<readonly (readonly string[] | null)[]> {
  const digest = rig.manager.status().runtimeLockDigest as string;
  return Promise.all([
    treeListing(join(rig.artifactRoot, 'runtime', digest)),
    treeListing(join(rig.artifactRoot, 'models', rig.laya.manifestId)),
  ]);
}

test('E2 laya purge: an E purge stops only the tracked work whose reservation it terminalised', {
  skip: WINDOWS_SKIP,
}, async () => {
  const rig = await seededRig();
  try {
    const trees = await verifiedTrees(rig);
    assert.ok(
      trees.every((tree) => tree !== null && tree.length > 0),
      'Laya has verified trees',
    );
    // Task 8's supervisor registers each in-flight worker request by its E reservation.
    const a = rig.manager.trackWork('work-a');
    const b1 = rig.manager.trackWork('work-b1');
    const b2 = rig.manager.trackWork('work-b2');

    rig.store.immediate(() =>
      purgeRemovedAccountWork(rig.store.database, { source: 'gmail', accountId: ACCOUNT_A }, NOW + 1),
    );
    assert.deepEqual(
      [a.signal.aborted, b1.signal.aborted, b2.signal.aborted],
      [true, false, false],
      'removing account A stops only account A’s request',
    );
    assert.deepEqual(await verifiedTrees(rig), trees, 'an account purge leaves the installation-wide trees');

    rig.store.immediate(() => purgeRevokedRuleWork(rig.store.database, 'rule-e2-t6-b', [1], NOW + 2));
    assert.deepEqual(
      [b1.signal.aborted, b2.signal.aborted],
      [true, true],
      'revoking rule B stops both of its requests',
    );
    assert.deepEqual(await verifiedTrees(rig), trees, 'a rule purge leaves the installation-wide trees');

    const late = rig.manager.trackWork('work-a');
    await new EventLifecycle(rig.store, () => NOW + 3).disableAll();
    assert.equal(late.signal.aborted, true, 'disable-all stops tracked work whose reservation is no longer live');
    assert.deepEqual(await verifiedTrees(rig), trees, 'disable-all leaves the installation-wide trees');
    assert.equal(rig.manager.status().state, 'ready', 'Laya itself stays enabled and ready');
  } finally {
    await rig.close();
  }
});

test('E2 laya purge: every JudgePurgeParticipant purge tells the database’s work listener', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e2-t6-participant-');
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  const told: string[] = [];
  let current = '';
  const unregister = registerJudgeWorkPurgeListener(store.database, { onWorkPurged: () => told.push(current) });
  try {
    const participant = new JudgePurgeParticipant({ database: store.database, now: () => NOW });
    const calls: Record<string, () => unknown> = {
      all: () => participant.all(),
      kind: () => participant.kind(LAYA),
      judge: () => participant.judge({ judgeId: 'judge-none', versions: [1] }),
      account: () => participant.account({ source: 'gmail', accountId: ACCOUNT_A }),
      event: () => participant.event({ source: 'gmail', accountId: ACCOUNT_A, eventId: 'event-none' }),
      retainedProjection: () =>
        participant.retainedProjection({ accountId: ACCOUNT_A, eventId: 'event-none', ruleId: 'rule', ruleVersion: 1 }),
      rule: () => participant.rule({ ruleId: 'rule-none', versions: [1] }),
    };
    const methods = Object.getOwnPropertyNames(JudgePurgeParticipant.prototype).filter(
      (name) => name !== 'constructor',
    );
    assert.deepEqual(methods.sort(), Object.keys(calls).sort(), 'a new purge method needs its listener proof here');
    for (const [name, call] of Object.entries(calls)) {
      current = name;
      store.immediate(() => call());
    }
    for (const name of Object.keys(calls)) assert.ok(told.includes(name), `${name} tells the work listener`);
    assert.throws(
      () => registerJudgeWorkPurgeListener(store.database, { onWorkPurged: () => undefined }),
      /already registered/u,
      'one owner composes one listener per database',
    );
  } finally {
    unregister();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------------------------------------ E2 Task 12

/*
 * Step 3: every E purge caller, over two same-looking accounts, the same account id under two more sources, and one
 * real in-flight Laya request through the supervisor and its proven stand-in worker. Each caller must stop exactly
 * the work whose own reservation it terminalised (the supervisor kills the worker for its request), touch no
 * verified tree, and leave nothing a restart would find: no live reservation, child, partial tree or tracked work.
 */

const T12_A = 'ibx_E2T12SCOPEAAAAA';
/** One character from A: a purge keyed on a prefix, a name or a case-folded id would reach it. */
const T12_A_LIKE = 'ibx_E2T12SCOPEAAAAB';
const T12_B = 'ibx_E2T12SCOPEBBBBB';
const standin = fileURLToPath(new URL('./support/laya-worker-standin.ts', import.meta.url));
const typesafeJudge = { ...judge, judgeId: 'judge-e2-t12-typesafe' };
const t12Limits = {
  callsPerRollingHour: 20,
  inputTokensPerRolling30Days: 100_000,
  concurrency: 1,
  maxInputTokens: 10_000,
};

type T12Source = 'gmail' | 'slack' | 'whatsapp';

/** Laya runs one request at a time (E's provider ceiling); the typesafe stand-ins share their rules. */
function limitsFor(ruleJudge: unknown) {
  return { ...t12Limits, concurrency: (ruleJudge as { kind?: unknown }).kind === LAYA ? 1 : 4 };
}
const SOURCE_SHAPE: Record<T12Source, { readonly options: unknown; readonly type: string; readonly path: string }> = {
  gmail: {
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    type: 'gmail.message.received',
    path: '/subject',
  },
  slack: { options: { channel: 'slack', conversations: ['C-e2t12'] }, type: 'slack.message.posted', path: '/text' },
  whatsapp: {
    options: { channel: 'whatsapp', chats: 'all-allowed' },
    type: 'whatsapp.message.received',
    path: '/text',
  },
};

function t12Rule(ruleId: string, source: T12Source, accountIds: readonly string[], ruleJudge: unknown) {
  const shape = SOURCE_SHAPE[source];
  return {
    ...rule(ruleId, accountIds[0] as string),
    source: { channel: source, accountIds: [...accountIds], options: shape.options },
    event: { type: shape.type, version: 1 },
    condition: { path: shape.path, op: 'exists' },
    agentic: {
      ...rule(ruleId, accountIds[0] as string).agentic,
      judge: ruleJudge,
      inputs: [shape.path],
      ...limitsFor(ruleJudge),
    },
  } as CanonicalFullRuleDocument;
}

/** Each scope's work: its stable source, account, event and rule, and the reservation E holds for it. */
const T12_WORK = [
  { id: 'laya-g-a', source: 'gmail', accountId: T12_A, eventId: 'event-t12-g-a-laya', ruleId: 'rule-t12-laya' },
  { id: 'ts-g-a', source: 'gmail', accountId: T12_A, eventId: 'event-t12-g-a-1', ruleId: 'rule-t12-r1' },
  { id: 'ts-g-al', source: 'gmail', accountId: T12_A_LIKE, eventId: 'event-t12-g-al-1', ruleId: 'rule-t12-r1' },
  { id: 'ts-g-b', source: 'gmail', accountId: T12_B, eventId: 'event-t12-g-b-1', ruleId: 'rule-t12-r2' },
  { id: 'ts-s-a', source: 'slack', accountId: T12_A, eventId: 'event-t12-s-a-1', ruleId: 'rule-t12-r3' },
  { id: 'ts-w-a', source: 'whatsapp', accountId: T12_A, eventId: 'event-t12-w-a-1', ruleId: 'rule-t12-r4' },
] as const;
type T12WorkId = (typeof T12_WORK)[number]['id'];

interface T12Scopes {
  readonly rig: LayaRig;
  readonly root: string;
  readonly operator: B3OperatorControl;
  readonly tracked: ReadonlyMap<T12WorkId, AbortSignal>;
  /** The real Laya request's outcome, once its worker is gone. */
  readonly laya: Promise<unknown>;
  readonly worker: () => ChildProcessWithoutNullStreams | undefined;
  readonly supervisor: LayaWorkerSupervisor;
  state(id: T12WorkId): string;
  /** Set once a test has stopped and closed this owner's store to restart over the same directories. */
  restarted: boolean;
  close(): Promise<void>;
}

async function t12Scopes(): Promise<T12Scopes> {
  const root = await shortTempDir('events-e2-t12-scope-');
  const laya = await syntheticLaya();
  const platform = macPlatform();
  const rig = await layaRig({ laya, platform, root });
  const database = rig.store.database;
  const unregisterInputs = registerLayaEnablementInputs(database, {
    layaAssetSource: laya.assets,
    layaPlatformProbe: platform,
  });
  await rig.enable();
  await rig.manager.ensureInstalled();
  assert.equal(rig.manager.status().state, 'ready');
  const layaJudge = {
    judgeId: 'judge-e2-t12-laya',
    version: 1,
    kind: LAYA,
    provider: LAYA,
    model: laya.manifestId,
    promptTemplate: LAYA_NOUL_TEMPLATE_ID,
  };
  const versions = new ImmutableVersions(database);
  versions.createTarget(target);
  versions.createJudge(typesafeJudge);
  versions.createJudge(layaJudge);
  versions.createJudgeKind({
    id: `judge-kind:${JUDGE_KINDS[0]}`,
    kind: JUDGE_KINDS[0],
    version: 1,
    endpoint: judge.endpoint,
  });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { callsPerRollingHour: 100, inputTokensPerRolling30Days: 1_000_000, concurrency: 10 },
    providers: [
      { provider: LAYA, callsPerRollingHour: 100, inputTokensPerRolling30Days: 1_000_000, concurrency: 1 },
      { provider: JUDGE_KINDS[0], callsPerRollingHour: 100, inputTokensPerRolling30Days: 1_000_000, concurrency: 8 },
    ],
  });
  const rules = [
    t12Rule('rule-t12-laya', 'gmail', [T12_A], layaJudge),
    t12Rule('rule-t12-r1', 'gmail', [T12_A, T12_A_LIKE], typesafeJudge),
    t12Rule('rule-t12-r2', 'gmail', [T12_B], typesafeJudge),
    t12Rule('rule-t12-r3', 'slack', [T12_A], typesafeJudge),
    t12Rule('rule-t12-r4', 'whatsapp', [T12_A], typesafeJudge),
  ];
  for (const document of rules) {
    versions.createRule(document);
    database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, NULL, 1)",
      )
      .run(document.ruleId);
    database
      .prepare(
        `UPDATE rule_versions SET state = 'active', approval_id = 'approval-e2-t12', authorization_activation_id = ?,
           activated_at = 1 WHERE rule_id = ? AND version = 1`,
      )
      .run(`activation-${document.ruleId}`, document.ruleId);
  }
  database
    .prepare(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', ?, 1, NULL, 1)`,
    )
    .run(JUDGE_KINDS[0]);
  database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1');
  database
    .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, ?)')
    .run(T12_A, 'a'.repeat(64), NOW);
  for (const work of T12_WORK) {
    database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        work.eventId,
        rig.store.installationId,
        SOURCE_SHAPE[work.source].type,
        work.accountId,
        work.eventId,
        NOW,
        NOW,
        NOW,
      );
    const message = work.source === 'whatsapp' ? `["wa-msg","chat-t12","sender-t12","${work.id}"]` : null;
    database
      .prepare(
        `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection,
           whatsapp_visibility_version, whatsapp_message_id)
         VALUES (?, ?, 1, ?, X'01', ?, ?)`,
      )
      .run(work.eventId, work.ruleId, NOW + 600_000, message === null ? null : 1, message);
    if (message !== null)
      database
        .prepare(
          `INSERT INTO whatsapp_occurrences (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, event_id)
           VALUES (?, ?, 1, ?, 1, ?)`,
        )
        .run(work.accountId, message, NOW, work.eventId);
  }
  const reserve = (work: (typeof T12_WORK)[number], ruleJudge: typeof judge | typeof layaJudge, envelope: Buffer) =>
    reserveJudgeWork({
      store: rig.store,
      id: work.id,
      workId: `work:${work.id}`,
      scope: {
        scope: 'source-owned',
        source: work.source,
        accountId: work.accountId,
        eventId: work.eventId,
        ruleId: work.ruleId,
        ruleVersion: 1,
        judgeId: ruleJudge.judgeId,
        judgeVersion: ruleJudge.version,
      },
      judge: ruleJudge as never,
      limits: limitsFor(ruleJudge),
      finalEnvelope: envelope,
      switchGeneration: 0,
      now: NOW,
    });
  const tracked = new Map<T12WorkId, AbortSignal>();
  // Every other scope's in-flight work, registered with the manager as the supervisor registers its own.
  for (const work of T12_WORK.slice(1)) {
    reserve(work, typesafeJudge, Buffer.from(work.id));
    beginJudgeTransport({ store: rig.store, reservationId: work.id, now: NOW });
    tracked.set(work.id, rig.manager.trackWork(work.id).signal);
  }
  // The one real Laya request: E reserves exactly its frame payload and the supervisor writes it to a proven worker,
  // which never answers, so it is in flight when the purge comes.
  let child: ChildProcessWithoutNullStreams | undefined;
  const supervisor = new LayaWorkerSupervisor({
    artifacts: rig.manager,
    requestDeadlineMs: 60_000,
    startWorker: async ({ dataDirectory, signal }) => {
      const result = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory,
        workerEntry: standin,
        signal,
        spawn: (_command, _args, spawnOptions) =>
          spawn(
            process.execPath,
            ['--experimental-strip-types', standin, '--standin', 'all-denied', '--serve', 'hang'],
            spawnOptions,
          ) as ChildProcessWithoutNullStreams,
      });
      if (result.ok) child = result.child;
      return result;
    },
  });
  const prepared = supervisor.prepare({ judge: layaJudge, state: '{"synthetic":"state"}', instructions: 'Does it?' });
  assert.ok(prepared.ok, 'this release offers the synthetic entry');
  const [layaWork] = T12_WORK;
  reserve(layaWork, layaJudge, prepared.request.body);
  let written = false;
  const outcome = supervisor.execute(prepared.request, {
    reservationId: layaWork.id,
    finalGate: () => {
      beginJudgeTransport({ store: rig.store, reservationId: layaWork.id, now: NOW });
      written = true;
    },
  });
  const deadline = Date.now() + 10_000;
  while (!written) {
    if (Date.now() > deadline) throw new Error('the Laya request was never written');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  const operator = new B3OperatorControl({
    store: rig.store,
    ports: { quiescer: new WriterQuiescer() } as never,
    activations: rig.activations,
    laya: rig.manager,
    now: () => NOW + 1,
  });
  const setup: T12Scopes = {
    rig,
    root,
    operator,
    tracked,
    laya: outcome,
    worker: () => child,
    supervisor,
    state: (id) =>
      (database.prepare('SELECT state FROM judge_budget_reservations WHERE id = ?').get(id) as { state: string }).state,
    restarted: false,
    async close() {
      await supervisor.close();
      unregisterInputs();
      // A restart has already stopped the manager and closed this store; only the directory is left to remove.
      if (!setup.restarted) await rig.close();
      await rm(root, { recursive: true, force: true });
    },
  };
  return setup;
}

function workerExited(child: ChildProcessWithoutNullStreams | undefined): boolean {
  return child === undefined || child.exitCode !== null || child.signalCode !== null;
}

/**
 * The caller ran: exactly `stopped` lost its work, by E's own terminalisation; every other scope kept its live
 * reservation and its tracked work; no verified tree moved. Then a restart over the same state and data finds no live
 * reservation for any stopped scope, no worker, no partial or staging tree, and Laya where the caller left it.
 */
async function assertExactPurge(
  setup: T12Scopes,
  stopped: readonly T12WorkId[],
  label: string,
  expectedState: 'ready' | 'idle' = 'ready',
): Promise<void> {
  const trees = await verifiedTrees(setup.rig);
  for (const work of T12_WORK) {
    const expected = stopped.includes(work.id);
    if (work.id === 'laya-g-a') {
      if (expected) {
        // Bounded: a request no purge reached would otherwise wait out its own 60-second deadline.
        const purged = await Promise.race([
          setup.laya,
          new Promise((resolve) => setTimeout(() => resolve('still in flight'), 5_000).unref()),
        ]);
        assert.deepEqual(
          purged,
          { kind: 'refused', code: 'laya-purged', preIo: false },
          `${label}: the Laya request was purged`,
        );
        const deadline = Date.now() + 5_000;
        while (!workerExited(setup.worker()) && Date.now() < deadline)
          await new Promise((resolve) => setTimeout(resolve, 10));
        assert.equal(workerExited(setup.worker()), true, `${label}: its worker was killed`);
      } else {
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(workerExited(setup.worker()), false, `${label}: the Laya request's worker is untouched`);
      }
    } else {
      assert.equal(
        setup.tracked.get(work.id)?.aborted,
        expected,
        `${label}: ${work.id} ${expected ? 'stopped' : 'kept'}`,
      );
    }
    const state = setup.state(work.id);
    if (expected) assert.ok(state === 'settled' || state === 'released', `${label}: E terminalised ${work.id}`);
    else assert.equal(state, 'in-flight', `${label}: ${work.id} keeps its live reservation`);
  }
  assert.deepEqual(await verifiedTrees(setup.rig), trees, `${label}: no purge touches the installation-wide trees`);
  assert.equal(setup.rig.manager.status().state, expectedState, `${label}: Laya is ${expectedState}`);

  // Restart: the owner's own stop order, then a new manager and E's start-up recovery over the same directories.
  const stateDir = join(setup.root, 'state');
  const treePaths = [
    join(setup.rig.artifactRoot, 'runtime', setup.rig.manager.status().runtimeLockDigest as string),
    join(setup.rig.artifactRoot, 'models', setup.rig.laya.manifestId),
  ];
  await setup.supervisor.close();
  await setup.rig.manager.stop();
  setup.rig.store.close();
  setup.restarted = true;
  assert.equal(workerExited(setup.worker()), true, `${label}: no worker survives the owner's stop`);
  const store = await openEventDatabase({ stateDir });
  try {
    store.immediate(() => recoverJudgeWork({ database: store.database, now: NOW + 2 }));
    const live = store.database
      .prepare("SELECT id FROM judge_budget_reservations WHERE state IN ('reserved', 'in-flight') ORDER BY id")
      .all()
      .map((row) => (row as { id: string }).id);
    for (const id of stopped) assert.equal(live.includes(id), false, `${label}: ${id} stays terminal after a restart`);
    const unverified: string[] = [];
    for (const directory of ['runtime', 'models'])
      for (const entry of (await treeListing(join(setup.rig.artifactRoot, directory))) ?? []) {
        const top = entry.split('/')[0] ?? '';
        if (top.endsWith('.partial') || top.endsWith('.staging')) unverified.push(top);
      }
    assert.deepEqual(unverified, [], `${label}: no partial or staging tree is left`);
    assert.deepEqual(
      await Promise.all(treePaths.map((path) => treeListing(path))),
      trees,
      `${label}: the trees survive a restart`,
    );
  } finally {
    store.close();
  }
}

async function withT12Scopes(run: (setup: T12Scopes) => Promise<void>): Promise<void> {
  const setup = await t12Scopes();
  try {
    await run(setup);
  } finally {
    await setup.close();
  }
}

test('E2 laya purge scope: removing a Gmail account stops only that account’s work, not a same-looking id or the same id elsewhere', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    setup.rig.store.immediate(() =>
      purgeRemovedAccountWork(setup.rig.store.database, { source: 'gmail', accountId: T12_A }, NOW + 1),
    );
    await assertExactPurge(setup, ['laya-g-a', 'ts-g-a'], 'account removal');
  });
});

test('E2 laya purge scope: revoking the Laya rule stops only its own request', { skip: WINDOWS_SKIP }, async () => {
  await withT12Scopes(async (setup) => {
    setup.rig.store.immediate(() => purgeRevokedRuleWork(setup.rig.store.database, 'rule-t12-laya', [1], NOW + 1));
    await assertExactPurge(setup, ['laya-g-a'], 'Laya rule revocation');
  });
});

test('E2 laya purge scope: revoking another rule leaves the in-flight Laya request alone', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    setup.rig.store.immediate(() => purgeRevokedRuleWork(setup.rig.store.database, 'rule-t12-r1', [1], NOW + 1));
    await assertExactPurge(setup, ['ts-g-a', 'ts-g-al'], 'another rule’s revocation');
  });
});

test('E2 laya purge scope: removing the Laya judge stops only the work that names it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    await setup.operator.handle({ operation: 'removeJudge', args: { judgeId: 'judge-e2-t12-laya' } });
    await assertExactPurge(setup, ['laya-g-a'], 'Laya judge removal');
  });
});

test('E2 laya purge scope: disabling the Laya kind stops only Laya work and keeps its verified trees', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    await setup.rig.disable();
    await assertExactPurge(setup, ['laya-g-a'], 'Laya kind disable', 'idle');
  });
});

test('E2 laya purge scope: disable-all stops every scope’s work and leaves Laya enabled and ready', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    await new EventLifecycle(setup.rig.store, () => NOW + 1).disableAll();
    await assertExactPurge(
      setup,
      T12_WORK.map((work) => work.id),
      'disable-all',
    );
  });
});

test('E2 laya purge scope: an expired decision deadline stops only that event’s Laya request', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    setup.rig.store.database
      .prepare('UPDATE ingest_rules SET decision_deadline = ? WHERE event_id = ? AND rule_id = ?')
      .run(NOW, 'event-t12-g-a-laya', 'rule-t12-laya');
    new EventExpiry(setup.rig.store, () => NOW).sweep();
    await assertExactPurge(setup, ['laya-g-a'], 'expiry');
  });
});

test('E2 laya purge scope: a tightened retention stops only the expired projection’s work', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    setup.rig.store.database
      .prepare('UPDATE ingest_rules SET decision_deadline = ? WHERE event_id = ? AND rule_id = ?')
      .run(NOW, 'event-t12-g-a-1', 'rule-t12-r1');
    setup.rig.store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: setup.rig.store.database,
        ruleId: 'rule-t12-r1',
        child: t12Rule('rule-t12-r1', 'gmail', [T12_A, T12_A_LIKE], typesafeJudge),
        now: NOW,
      }),
    );
    await assertExactPurge(setup, ['ts-g-a'], 'retention tightening');
  });
});

test('E2 laya purge scope: hiding a WhatsApp message stops only that event’s work', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    const fence = new WhatsAppVisibilityFence({
      store: setup.rig.store,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: 'b'.repeat(64), seesMessage: () => false }),
      now: () => NOW + 1,
    });
    await fence.withCurrentVisibility({ accountId: T12_A }, () => undefined);
    await assertExactPurge(setup, ['ts-w-a'], 'WhatsApp hide');
  });
});

/** The Laya rule's version inert again (no activation), while its request is still in flight. */
function makeLayaRuleInert(setup: T12Scopes): void {
  setup.rig.store.database
    .prepare(
      `UPDATE rule_versions SET state = NULL, approval_id = NULL, authorization_activation_id = NULL, activated_at = NULL
        WHERE rule_id = 'rule-t12-laya'`,
    )
    .run();
}

test('E2 laya purge scope: removing the Laya judge stops its work even where no active rule names it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    // Removal also revokes every active rule naming the judge, whose purge would stop the request too. With its rule
    // inert, only the judge's own purge can reach the work: as for a pending rule's synthetic test.
    makeLayaRuleInert(setup);
    await setup.operator.handle({ operation: 'removeJudge', args: { judgeId: 'judge-e2-t12-laya' } });
    await assertExactPurge(setup, ['laya-g-a'], 'Laya judge removal, rule inert');
  });
});

test('E2 laya purge scope: disabling the Laya kind stops its work even where no active rule names it', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withT12Scopes(async (setup) => {
    // The kind disable also purges every active rule naming a Laya judge. With the rule inert, only the kind's own
    // purge can reach the request.
    makeLayaRuleInert(setup);
    await setup.rig.disable();
    await assertExactPurge(setup, ['laya-g-a'], 'Laya kind disable, rule inert', 'idle');
  });
});
