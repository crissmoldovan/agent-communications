import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { TYPESAFE_SYSTEM_ONE_ENDPOINT } from '../src/domain/judges.ts';
import { JUDGE_KINDS } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { beginJudgeTransport, reserveJudgeWork } from '../src/runtime/judge-budget.ts';
import { JudgePurgeParticipant, registerJudgeWorkPurgeListener } from '../src/runtime/judge-purge.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { purgeRevokedRuleWork } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { LAYA, type LayaRig, layaRig, treeListing } from './support/laya-artifacts.ts';
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
