import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import type { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { commitDecisionOutbox } from '../src/runtime/decisions.ts';
import { claimDelivery, completeDeliveryClaim } from '../src/runtime/delivery-claim.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { claimHeldDecision } from '../src/runtime/holds.ts';
import {
  assertJudgeReservationStillInFlight,
  beginJudgeTransport,
  reserveJudgeTest,
  reserveJudgeWork,
} from '../src/runtime/judge-budget.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { recoverJudgeWork } from '../src/runtime/judge-recovery.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { createB2RetainedContentParticipants } from '../src/runtime/phase-d-b2-retention.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { applyDerivedTightening } from '../src/runtime/replacements.ts';
import { disableRule, removeTarget } from '../src/runtime/revocations.ts';
import { SseDispatcher } from '../src/runtime/sse-dispatcher.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * The lasting handles a test may leak — sockets, pipes, timers, child processes, servers. One-shot requests (a file
 * system read, a DNS lookup, a pending write) can be in flight at either snapshot without anything having leaked, so
 * they are left out of the before/after comparison.
 */
function lastingResources(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((name) => !/Req|^WriteWrap$|^ShutdownWrap$/u.test(name))
    .sort();
}

const NOW = 1_800_000_000_000;
const accountId = 'ibx_E4PURGEAAAAAAAA';
const target = { targetId: 'target-e4-purge', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const subscriber = {
  subscriberId: 'subscriber-e12-purge',
  version: 1,
  kind: 'sse' as const,
  authority: { host: '127.0.0.1' as const, port: 43_101 },
  origins: ['https://console.invalid'],
  retentionMs: 60_000,
};
const sseTarget = {
  targetId: 'target-e12-sse',
  version: 1,
  kind: 'sse' as const,
  subscriberId: subscriber.subscriberId,
  subscriberVersion: subscriber.version,
  representation: 'plain' as const,
};
const judge = {
  judgeId: 'judge-e4-purge',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe' as const,
  model: 'jev-1.13.0' as const,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};
const limits = { callsPerRollingHour: 10, inputTokensPerRolling30Days: 10_000, concurrency: 2, maxInputTokens: 128 };
const budgetLimits = {
  callsPerRollingHour: limits.callsPerRollingHour,
  inputTokensPerRolling30Days: limits.inputTokensPerRolling30Days,
  concurrency: limits.concurrency,
};

function agenticRule(input: {
  readonly ruleId: string;
  readonly version: number;
  readonly ingestMs?: number | undefined;
}): CanonicalFullRuleDocument {
  const retentionMs = input.ingestMs ?? 1_000;
  return {
    ruleId: input.ruleId,
    version: input.version,
    source: {
      channel: 'gmail' as const,
      accountIds: [accountId],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received' as const, version: 1 },
    condition: { path: '/subject', op: 'exists' as const },
    agentic: {
      judge,
      question: 'synthetic E4 rule-bound purge fixture',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match' as const,
      ...limits,
      maxOutputTokens: 32,
    },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 1,
    retention: {
      ingestMs: retentionMs,
      holdMs: retentionMs,
      deliveryMs: retentionMs,
      dryrunMs: retentionMs,
      sseReplayMs: retentionMs,
      deadLetterMs: retentionMs,
      decisionMetadataMs: retentionMs,
    },
  };
}

function insertRuleBoundReservation(input: {
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly id: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
}): void {
  reserveJudgeWork({
    store: input.store,
    id: input.id,
    workId: `work:${input.id}`,
    scope: {
      scope: 'source-owned',
      source: 'gmail',
      accountId,
      eventId: 'event-e4-rule-bound',
      ruleId: input.ruleId,
      ruleVersion: input.ruleVersion,
      judgeId: judge.judgeId,
      judgeVersion: 1,
    },
    judge,
    limits,
    finalEnvelope: Buffer.from(input.id),
    switchGeneration: 0,
    now: NOW,
  });
  beginJudgeTransport({ store: input.store, reservationId: input.id, now: NOW });
}

function assertLiveRuleB(store: Awaited<ReturnType<typeof openEventDatabase>>, label: string): void {
  assert.deepEqual(
    {
      ...(store.database
        .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
        .get('work-b') as Record<string, unknown>),
    },
    { state: 'in-flight', concurrency_owned: 1 },
    `${label}: rule B remains live`,
  );
  assert.equal(
    (
      store.database
        .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ? AND rule_id = ? AND rule_version = 1')
        .get('event-e4-rule-bound', 'rule-e4-b') as { count: number }
    ).count,
    1,
    `${label}: rule B projection remains live`,
  );
}

async function purgeFixture(input: { readonly label: string; readonly source?: 'gmail' | 'whatsapp' }): Promise<{
  readonly root: string;
  readonly store: Awaited<ReturnType<typeof openEventDatabase>>;
  readonly eventId: string;
  readonly reservationId: string;
  readonly ruleId: string;
  readonly close: () => void;
}> {
  const root = await shortTempDir(`events-e12-${input.label}-`);
  const store = await openEventDatabase({ stateDir: root });
  const source = input.source ?? 'gmail';
  const eventId = `event-e12-${input.label}`;
  const lifecycleEventIds = [eventId, ...['hold', 'queued', 'retryable', 'logged'].map((kind) => `${eventId}-${kind}`)];
  const reservationId = `reservation-e12-${input.label}`;
  const ruleId = `rule-e12-${input.label}`;
  const versions = new ImmutableVersions(store.database);
  const rule = agenticRule({ ruleId, version: 1 });
  if (source === 'whatsapp') {
    Object.assign(rule, {
      source: {
        channel: 'whatsapp',
        accountIds: [accountId],
        options: { channel: 'whatsapp', chats: 'all-allowed' },
      },
      event: { type: 'whatsapp.message.received', version: 1 },
      condition: { path: '/text', op: 'exists' },
    });
    assert.ok(rule.agentic, 'the purge fixture remains agentic');
    Object.assign(rule.agentic, { inputs: ['/text'] });
  }
  versions.createTarget(target);
  versions.createSubscriber(subscriber);
  versions.createTarget(sseTarget);
  versions.createJudge(judge);
  versions.createJudgeKind({
    id: 'judge-kind:typesafe',
    kind: 'typesafe',
    version: 1,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
  });
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: { ...budgetLimits, concurrency: 3 },
    providers: [{ provider: 'typesafe', ...budgetLimits }],
  });
  Object.assign(rule, { targets: [target, sseTarget], subscribers: [subscriber], deliveryRateCap: 10 });
  versions.createRule(rule);
  store.database.exec(
    `UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
     INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1),
              ('rule', '${ruleId}', 1, NULL, 1);
     UPDATE rule_versions SET state = 'active', approval_id = 'approval-e12',
       authorization_activation_id = 'activation-e12', activated_at = 1
       WHERE rule_id = '${ruleId}' AND version = 1;`,
  );
  if (source === 'whatsapp')
    store.database
      .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, ?)')
      .run(accountId, 'a'.repeat(64), NOW);
  for (const [index, lifecycleEventId] of lifecycleEventIds.entries()) {
    store.database
      .prepare(
        `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      )
      .run(
        lifecycleEventId,
        store.installationId,
        `${source}.message.received`,
        accountId,
        lifecycleEventId,
        NOW,
        NOW,
        NOW,
      );
    const messageId =
      source === 'whatsapp' ? canonicalJson(['wa-msg', `chat-${index}`, `sender-${index}`, `id-${index}`]) : null;
    store.database
      .prepare(
        `INSERT INTO ingest_rules
         (event_id, rule_id, rule_version, decision_deadline, encrypted_projection,
          whatsapp_visibility_version, whatsapp_message_id)
         VALUES (?, ?, 1, ?, X'01', ?, ?)`,
      )
      .run(lifecycleEventId, ruleId, NOW + 10_000, source === 'whatsapp' ? 1 : null, messageId);
    if (messageId !== null)
      store.database
        .prepare(
          `INSERT INTO whatsapp_occurrences
           (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, event_id)
           VALUES (?, ?, 1, ?, 1, ?)`,
        )
        .run(accountId, messageId, NOW, lifecycleEventId);
  }
  reserveJudgeWork({
    store,
    id: reservationId,
    workId: `work:${reservationId}`,
    scope: {
      scope: 'source-owned',
      source,
      accountId,
      eventId: `${eventId}-queued`,
      ruleId,
      ruleVersion: 1,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    },
    judge,
    limits,
    finalEnvelope: Buffer.from(input.label),
    switchGeneration: 0,
    now: NOW,
  });
  beginJudgeTransport({ store, reservationId, now: NOW });
  reserveJudgeWork({
    store,
    id: `${reservationId}-reserved`,
    workId: `work:${reservationId}-reserved`,
    scope: {
      scope: 'source-owned',
      source,
      accountId,
      eventId,
      ruleId,
      ruleVersion: 1,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    },
    judge,
    limits,
    finalEnvelope: Buffer.from(`${input.label}-reserved`),
    switchGeneration: 0,
    now: NOW,
  });
  const holdDecisionId = `decision-e12-${input.label}-hold`;
  const holdEventId = lifecycleEventIds[1];
  if (holdEventId === undefined) throw new Error('the held lifecycle fixture event is missing');
  commitDecisionOutbox(store, {
    id: holdDecisionId,
    eventId: holdEventId,
    accountId,
    ruleId,
    ruleVersion: 1,
    outcome: 'hold',
    metadataExpiresAt: NOW + 10_000,
    switchGeneration: 0,
    ...(source === 'whatsapp'
      ? { whatsapp: { messageId: canonicalJson(['wa-msg', 'chat-1', 'sender-1', 'id-1']), visibilityVersion: 1 } }
      : {}),
    deliveries: [],
    encryptedMetadata: Buffer.from([2]),
    retainProjection: true,
    hold: { holdMs: 10_000, ingestMs: 10_000 },
  });
  assert.equal(
    claimHeldDecision({ store, decisionId: holdDecisionId, leaseMs: 5_000, claimToken: new Uint8Array(32).fill(7) })
      .kind,
    'claimed',
    `${input.label}: the production claim path seeds one held resolver lease`,
  );
  const record = Buffer.from(
    JSON.stringify({ cloudEventBytes: '{"data":"synthetic"}', untrusted: [], representation: 'plain' }),
  );
  const delivery = (id: string, kind: 'dry-run' | 'sse') => ({
    id,
    targetKey:
      kind === 'dry-run'
        ? `dryrun:${target.targetId}:${target.version}`
        : `sse:${sseTarget.targetId}:${sseTarget.version}:${subscriber.subscriberId}:${subscriber.version}`,
    target:
      kind === 'dry-run'
        ? {
            kind: 'dry-run' as const,
            targetId: target.targetId,
            targetVersion: target.version,
            representation: 'plain' as const,
          }
        : {
            kind: 'sse' as const,
            targetId: sseTarget.targetId,
            targetVersion: sseTarget.version,
            subscriberId: subscriber.subscriberId,
            subscriberVersion: subscriber.version,
            representation: 'plain' as const,
          },
    representation: 'plain' as const,
    cloudEventBytes: '{"data":"synthetic"}',
    encryptedRecord: record,
    expiresAt: NOW + 10_000,
  });
  const commitMatched = (
    kind: 'queued' | 'retryable' | 'logged',
    deliveries: readonly ReturnType<typeof delivery>[],
  ) => {
    const index = kind === 'queued' ? 2 : kind === 'retryable' ? 3 : 4;
    const lifecycleEventId = lifecycleEventIds[index];
    if (lifecycleEventId === undefined) throw new Error(`${kind}: the lifecycle fixture event is missing`);
    commitDecisionOutbox(store, {
      id: `decision-e12-${input.label}-${kind}`,
      eventId: lifecycleEventId,
      accountId,
      ruleId,
      ruleVersion: 1,
      outcome: 'matched',
      metadataExpiresAt: NOW + 10_000,
      switchGeneration: 0,
      ...(source === 'whatsapp'
        ? {
            whatsapp: {
              messageId: canonicalJson(['wa-msg', `chat-${index}`, `sender-${index}`, `id-${index}`]),
              visibilityVersion: 1,
            },
          }
        : {}),
      deliveries,
      encryptedMetadata: Buffer.from([3]),
    });
  };
  const dryrunDelivery = delivery(`delivery-e12-${input.label}-dryrun`, 'dry-run');
  const streamDelivery = delivery(`delivery-e12-${input.label}-sse`, 'sse');
  commitMatched('logged', [dryrunDelivery, streamDelivery]);
  const cipher = {
    async encrypt(_location: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
    async decrypt(_location: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
  };
  const config = {
    load: async () =>
      source === 'whatsapp'
        ? { inboxes: {}, accounts: { synthetic: { id: accountId, platform: 'whatsapp' } } }
        : { inboxes: { synthetic: { id: accountId, provider: 'gmail' } }, accounts: {} },
  };
  const visibilityFence =
    source === 'whatsapp'
      ? createPhaseDWhatsAppOwnerComposition({
          database: store,
          now: () => NOW,
          eventOperations: {
            withCurrentEventVisibility: async (_input, work) =>
              work({ version: 1, digest: 'a'.repeat(64), seesMessage: () => true }),
          },
          createRetainedContentParticipants: createB2RetainedContentParticipants,
        }).visibilityFence
      : undefined;
  const dryrun = new DryRunDispatcher({
    store,
    cipher,
    approvals: { get: async () => null },
    config: config as never,
    now: () => NOW,
    fence: async () => undefined,
    ...(visibilityFence === undefined ? {} : { whatsappVisibilityFence: visibilityFence }),
  });
  assert.deepEqual(
    await dryrun.dispatch(dryrunDelivery.id),
    { state: 'delivered', deliveryId: dryrunDelivery.id },
    `${input.label}: the production dry-run dispatcher seeds retained local content`,
  );
  const sse = new SseDispatcher({
    store,
    cipher,
    approvals: { get: async () => null },
    config: config as never,
    now: () => NOW,
    fence: async () => undefined,
    ...(visibilityFence === undefined
      ? {}
      : { visibilityGate: visibilityFence, hasConcreteWhatsAppVisibilityFence: true }),
  });
  assert.deepEqual(
    await sse.dispatch(streamDelivery.id),
    { state: 'delivered', deliveryId: streamDelivery.id },
    `${input.label}: the production SSE dispatcher seeds retained replay content`,
  );
  const retryableDelivery = delivery(`delivery-e12-${input.label}-retryable`, 'dry-run');
  commitMatched('retryable', [retryableDelivery]);
  const claimed = await claimDelivery({
    store,
    deliveryId: retryableDelivery.id,
    now: NOW,
    leaseMs: 5_000,
    newAttemptId: () => `attempt-e12-${input.label}`,
    newLeaseToken: () => `lease-e12-${input.label}`,
    assertAccountLive: async () => undefined,
    preflight: async () => undefined,
  });
  assert.equal(claimed.kind, 'claimed', `${input.label}: the production delivery claim path seeds retryable work`);
  if (claimed.kind !== 'claimed') throw new Error(`${input.label}: retryable delivery was not claimed`);
  assert.equal(
    completeDeliveryClaim(store, claimed.claim, { state: 'retryable', clearRecord: false }),
    true,
    `${input.label}: the production delivery transition seeds retryable work`,
  );
  const queuedDelivery = delivery(`delivery-e12-${input.label}-queued`, 'dry-run');
  commitMatched('queued', [queuedDelivery]);
  let open = true;
  return {
    root,
    store,
    eventId,
    reservationId,
    ruleId,
    close: () => {
      if (!open) return;
      open = false;
      store.close();
    },
  };
}

function assertPurgedSurfaceInStore(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  setup: Awaited<ReturnType<typeof purgeFixture>>,
  label: string,
): void {
  assert.deepEqual(
    {
      ...(store.database
        .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
        .get(setup.reservationId) as Record<string, unknown>),
    },
    { state: 'settled', concurrency_owned: 0 },
    `${label}: the real purge caller settles in-flight judge work`,
  );
  assert.deepEqual(
    {
      ...(store.database
        .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
        .get(`${setup.reservationId}-reserved`) as Record<string, unknown>),
    },
    { state: 'released', concurrency_owned: 0 },
    `${label}: the real purge caller releases reserved judge work`,
  );
  assert.equal(
    (
      store.database
        .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ? AND rule_id = ?')
        .get(setup.eventId, setup.ruleId) as { count: number }
    ).count,
    0,
    `${label}: the real purge caller removes the encrypted projection`,
  );
  assert.deepEqual(
    {
      ...(store.database
        .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
        .get(`decision-e12-${setup.ruleId.slice('rule-e12-'.length)}-hold`) as Record<string, unknown>),
    },
    { outcome: 'cancelled', encrypted_record: null },
    `${label}: held content is terminalised and erased`,
  );
  assert.equal(
    (store.database.prepare('SELECT COUNT(*) AS count FROM hold_resolution_claims').get() as { count: number }).count,
    0,
    `${label}: the held resolver claim is consumed by purge`,
  );
  assert.equal(
    (
      store.database
        .prepare('SELECT COUNT(*) AS count FROM decisions WHERE rule_id = ? AND encrypted_record IS NOT NULL')
        .get(setup.ruleId) as { count: number }
    ).count,
    0,
    `${label}: every affected held and matched decision ciphertext is erased`,
  );
  assert.deepEqual(
    (
      store.database
        .prepare(
          "SELECT state, encrypted_record FROM deliveries WHERE state IN ('queued', 'retryable', 'cancelled') ORDER BY id",
        )
        .all() as Array<Record<string, unknown>>
    ).map((row) => ({ ...row })),
    [
      { state: 'cancelled', encrypted_record: null },
      { state: 'cancelled', encrypted_record: null },
    ],
    `${label}: queued and retryable payloads are cancelled and erased`,
  );
  assert.equal(
    (store.database.prepare('SELECT COUNT(*) AS count FROM dryrun_log').get() as { count: number }).count,
    0,
    `${label}: dry-run retained content is purged`,
  );
  assert.equal(
    (store.database.prepare('SELECT COUNT(*) AS count FROM stream_log').get() as { count: number }).count,
    0,
    `${label}: SSE retained content is purged`,
  );
}

async function assertPurgedSurface(setup: Awaited<ReturnType<typeof purgeFixture>>, label: string): Promise<void> {
  assertPurgedSurfaceInStore(setup.store, setup, label);
  setup.close();
  const reopened = await openEventDatabase({ stateDir: setup.root });
  try {
    assertPurgedSurfaceInStore(reopened, setup, `${label} after restart`);
    assert.deepEqual(
      reopened.immediate(() => recoverJudgeWork({ database: reopened.database, now: NOW + 2 })),
      { released: 0, settled: 0 },
      `${label}: startup recovery finds no stale work to resurrect`,
    );
    assertPurgedSurfaceInStore(reopened, setup, `${label} after startup recovery`);
  } finally {
    reopened.close();
  }
}

async function withPurgeClosure(
  input: Parameters<typeof purgeFixture>[0] & { readonly assertionLabel: string },
  action: (setup: Awaited<ReturnType<typeof purgeFixture>>) => Promise<void> | void,
): Promise<void> {
  const resourcesBefore = lastingResources();
  const setup = await purgeFixture(input);
  try {
    await action(setup);
    await assertPurgedSurface(setup, input.assertionLabel);
  } finally {
    setup.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    `${input.assertionLabel}: the lifecycle purge and restart probe closes every database and asynchronous handle`,
  );
}

test('E12 purge closure: target remove uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'target', assertionLabel: 'target remove' }, async (setup) => {
    await removeTarget(setup.store, { cancelForRevocation: async () => undefined }, target.targetId);
  });
});

test('E12 purge closure: subscriber remove uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'subscriber', assertionLabel: 'subscriber remove' }, async (setup) => {
    const control = new B3OperatorControl({
      store: setup.store,
      ports: {
        quiescer: { withShared: async (work: () => unknown) => work() },
        closeSubscriberStreams: () => undefined,
      } as never,
      now: () => NOW + 1,
    });
    await control.handle({ operation: 'removeSubscriber', args: { subscriberId: subscriber.subscriberId } });
  });
});

test('E12 purge closure: judge remove uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'judge', assertionLabel: 'judge remove' }, async (setup) => {
    const syntheticAuthority = agenticRule({ ruleId: 'rule-e12-judge-synthetic-authority', version: 1 });
    new ImmutableVersions(setup.store.database).createRule(syntheticAuthority);
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, NULL, ?)",
      )
      .run(syntheticAuthority.ruleId, NOW);
    setup.store.database
      .prepare(
        "UPDATE rule_versions SET state = 'active', approval_id = ?, authorization_activation_id = ?, activated_at = ? WHERE rule_id = ? AND version = 1",
      )
      .run('approval-e12-judge-synthetic', 'activation-e12-judge-synthetic', NOW, syntheticAuthority.ruleId);
    reserveJudgeTest({
      store: setup.store,
      id: 'reservation-e12-judge-synthetic',
      workId: 'work:reservation-e12-judge-synthetic',
      testWorkId: 'test-work-e12-judge-synthetic',
      judge,
      finalEnvelope: Buffer.from('synthetic-judge-remove'),
      switchGeneration: 0,
      now: NOW,
      authority: { ruleId: syntheticAuthority.ruleId, ruleVersion: 1 },
    });
    beginJudgeTransport({
      store: setup.store,
      reservationId: 'reservation-e12-judge-synthetic',
      now: NOW,
    });
    setup.store.database
      .prepare("UPDATE rule_versions SET state = 'revoked', revoked_at = ? WHERE rule_id = ? AND version = 1")
      .run(NOW, syntheticAuthority.ruleId);
    setup.store.database
      .prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = 1")
      .run(syntheticAuthority.ruleId);
    const control = new B3OperatorControl({
      store: setup.store,
      ports: { quiescer: { withShared: async (work: () => unknown) => work() } } as never,
      activations: { cancelForRevocation: async () => undefined, cancelForRevocationInTransaction: () => 0 } as never,
      now: () => NOW + 1,
    });
    await control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } });
    assert.equal(
      (
        setup.store.database
          .prepare('SELECT state FROM judge_budget_reservations WHERE id = ?')
          .get('reservation-e12-judge-synthetic') as { state: string }
      ).state,
      'settled',
      'judge remove enumerates and settles exact synthetic-test work independently of bound rules',
    );
  });
});

test('E12 purge closure: rule disable uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'rule-disable', assertionLabel: 'rule disable' }, async (setup) => {
    await disableRule(setup.store, { cancelForRevocation: async () => undefined }, setup.ruleId);
  });
});

test('E12 purge closure: disable all uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'disable-all', assertionLabel: 'disable all' }, async (setup) => {
    await new EventLifecycle(setup.store, () => NOW + 1).disableAll();
  });
});

test('E12 purge closure: account remove and re-add use the production participant', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withPurgeClosure({ label: 'account', assertionLabel: 'account remove' }, (setup) => {
    const row = setup.store.database
      .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = 1')
      .get(setup.ruleId) as { document: string };
    const document = JSON.parse(row.document) as { source: { accountIds: string[] } };
    document.source.accountIds.push('ibx_E12OTHERACCOUNT');
    setup.store.database
      .prepare('UPDATE rule_versions SET document = ? WHERE rule_id = ? AND version = 1')
      .run(canonicalJson(document), setup.ruleId);
    purgeRemovedAccountWork(setup.store.database, { source: 'gmail', accountId }, NOW + 1);
    assert.equal(
      (
        setup.store.database
          .prepare('SELECT COUNT(*) AS count FROM account_revocations WHERE account_id = ?')
          .get(accountId) as { count: number }
      ).count,
      1,
      'account remove/re-add keeps a durable revocation marker for the stale identity',
    );
  });
});

test('E12 account scope: removing Gmail preserves same-id Slack work and its final reservation authority', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e12-cross-source-account-');
  const store = await openEventDatabase({ stateDir: root });
  const sharedAccountId = 'shared-account-e12';
  const gmailRule = agenticRule({ ruleId: 'rule-e12-shared-gmail', version: 1 });
  const slackRule = agenticRule({ ruleId: 'rule-e12-shared-slack', version: 1 });
  Object.assign(gmailRule.source, { accountIds: [sharedAccountId] });
  Object.assign(slackRule, {
    source: {
      channel: 'slack',
      accountIds: [sharedAccountId],
      options: { channel: 'slack', conversations: ['C-e12-cross-source'] },
    },
    event: { type: 'slack.message.posted', version: 1 },
    condition: { path: '/text', op: 'exists' },
  });
  assert.ok(slackRule.agentic, 'the cross-source Slack fixture remains agentic');
  Object.assign(slackRule.agentic, { inputs: ['/text'] });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: budgetLimits,
      providers: [{ provider: 'typesafe', ...budgetLimits }],
    });
    versions.createRule(gmailRule);
    versions.createRule(slackRule);
    store.database.exec(
      `UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
       INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES
         ('judge-budget', 'judge-budget', 1, NULL, 1),
         ('judge-kind', 'typesafe', 1, NULL, 1),
         ('rule', 'rule-e12-shared-gmail', 1, NULL, 1),
         ('rule', 'rule-e12-shared-slack', 1, NULL, 1);
       UPDATE rule_versions SET state = 'active', approval_id = 'approval-e12-cross-source',
         authorization_activation_id = 'activation-e12-cross-source', activated_at = 1
         WHERE rule_id IN ('rule-e12-shared-gmail', 'rule-e12-shared-slack');`,
    );
    const insertIngest = store.database.prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    );
    insertIngest.run(
      'event-e12-shared-gmail',
      store.installationId,
      'gmail.message.received',
      sharedAccountId,
      'gmail-dedupe',
      NOW,
      NOW,
      NOW,
    );
    insertIngest.run(
      'event-e12-shared-slack',
      store.installationId,
      'slack.message.posted',
      sharedAccountId,
      'slack-dedupe',
      NOW,
      NOW,
      NOW,
    );
    const insertProjection = store.database.prepare(
      `INSERT INTO ingest_rules
       (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES (?, ?, 1, ?, ?)`,
    );
    insertProjection.run('event-e12-shared-gmail', gmailRule.ruleId, NOW + 10_000, Buffer.from('gmail'));
    insertProjection.run('event-e12-shared-slack', slackRule.ruleId, NOW + 10_000, Buffer.from('slack'));
    const insertDecision = store.database.prepare(
      `INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record)
       VALUES (?, ?, ?, ?, 1, 'matched', ?, 'retained', ?)`,
    );
    insertDecision.run(
      'decision-e12-shared-gmail',
      'event-e12-shared-gmail',
      sharedAccountId,
      gmailRule.ruleId,
      NOW + 10_000,
      Buffer.from('gmail'),
    );
    insertDecision.run(
      'decision-e12-shared-slack',
      'event-e12-shared-slack',
      sharedAccountId,
      slackRule.ruleId,
      NOW + 10_000,
      Buffer.from('slack'),
    );
    const insertDelivery = store.database.prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
        encrypted_record, next_at, expires_at, state, switch_generation, target_kind, target_representation,
        ordering_sequence)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, ?, ?, 'queued', 0, 'dry-run', 'plain', 0)`,
    );
    insertDelivery.run(
      'delivery-e12-shared-gmail',
      'decision-e12-shared-gmail',
      sharedAccountId,
      gmailRule.ruleId,
      'gmail-target',
      target.targetId,
      Buffer.from('gmail'),
      NOW,
      NOW + 10_000,
    );
    insertDelivery.run(
      'delivery-e12-shared-slack',
      'decision-e12-shared-slack',
      sharedAccountId,
      slackRule.ruleId,
      'slack-target',
      target.targetId,
      Buffer.from('slack'),
      NOW,
      NOW + 10_000,
    );
    reserveJudgeWork({
      store,
      id: 'reservation-e12-shared-slack',
      workId: 'work:reservation-e12-shared-slack',
      scope: {
        scope: 'source-owned',
        source: 'slack',
        accountId: sharedAccountId,
        eventId: 'event-e12-shared-slack',
        ruleId: slackRule.ruleId,
        ruleVersion: 1,
        judgeId: judge.judgeId,
        judgeVersion: judge.version,
      },
      judge,
      limits,
      finalEnvelope: Buffer.from('synthetic-cross-source'),
      switchGeneration: 0,
      now: NOW,
    });
    assert.equal(
      beginJudgeTransport({ store, reservationId: 'reservation-e12-shared-slack', now: NOW }),
      true,
      'the Slack reservation reaches the production final-fence state before Gmail removal',
    );

    store.immediate(() =>
      purgeRemovedAccountWork(store.database, { source: 'gmail', accountId: sharedAccountId }, NOW + 1),
    );

    assert.doesNotThrow(
      () =>
        assertJudgeReservationStillInFlight({
          store,
          reservationId: 'reservation-e12-shared-slack',
          now: NOW + 2,
        }),
      'removing Gmail leaves the same-id Slack reservation authorised at the final fence',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
          .get('reservation-e12-shared-slack') as Record<string, unknown>),
      },
      { state: 'in-flight', concurrency_owned: 1 },
      'removing Gmail leaves the same-id Slack reservation state and concurrency ownership untouched',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, encrypted_record IS NOT NULL AS retained FROM deliveries WHERE id = ?')
          .get('delivery-e12-shared-slack') as Record<string, unknown>),
      },
      { state: 'queued', retained: 1 },
      'removing Gmail leaves the same-id Slack delivery queued with its retained record',
    );
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ?')
          .get('event-e12-shared-slack') as { count: number }
      ).count,
      1,
      'removing Gmail leaves the same-id Slack projection untouched',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E12 purge closure: single-account rule revoke uses the production participant', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withPurgeClosure({ label: 'account-single-rule', assertionLabel: 'single-account rule revoke' }, (setup) => {
    reserveJudgeTest({
      store: setup.store,
      id: 'reservation-e12-account-single-synthetic',
      workId: 'work:reservation-e12-account-single-synthetic',
      testWorkId: 'test-work-e12-account-single-synthetic',
      judge,
      finalEnvelope: Buffer.from('synthetic-account-single-rule'),
      switchGeneration: 0,
      now: NOW,
      authority: { ruleId: setup.ruleId, ruleVersion: 1 },
    });
    beginJudgeTransport({
      store: setup.store,
      reservationId: 'reservation-e12-account-single-synthetic',
      now: NOW,
    });
    purgeRemovedAccountWork(setup.store.database, { source: 'gmail', accountId }, NOW + 1);
    assert.equal(
      (
        setup.store.database
          .prepare('SELECT state FROM judge_budget_reservations WHERE id = ?')
          .get('reservation-e12-account-single-synthetic') as { state: string }
      ).state,
      'settled',
      'single-account rule revoke settles synthetic work bound to the revoked rule',
    );
  });
});

test('E12 purge closure: WhatsApp hide uses the production participant', { skip: WINDOWS_SKIP }, async () => {
  await withPurgeClosure({ label: 'whatsapp', source: 'whatsapp', assertionLabel: 'WhatsApp hide' }, async (setup) => {
    const { visibilityFence } = createPhaseDWhatsAppOwnerComposition({
      database: setup.store,
      now: () => NOW + 1,
      eventOperations: {
        withCurrentEventVisibility: async (_input, work) =>
          work({ version: 1, digest: 'b'.repeat(64), seesMessage: () => false }),
      },
      createRetainedContentParticipants: createB2RetainedContentParticipants,
    });
    await visibilityFence.withCurrentVisibility({ accountId }, () => undefined);
  });
});

test('E4 purge closure: kind disable settles in-flight and releases reserved work through the one recovery helper', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e4-purge-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: {
        callsPerRollingHour: limits.callsPerRollingHour,
        inputTokensPerRolling30Days: limits.inputTokensPerRolling30Days,
        concurrency: limits.concurrency,
      },
      providers: [
        {
          provider: 'typesafe',
          callsPerRollingHour: limits.callsPerRollingHour,
          inputTokensPerRolling30Days: limits.inputTokensPerRolling30Days,
          concurrency: limits.concurrency,
        },
      ],
    });
    versions.createRule({
      ruleId: 'rule-e4-purge',
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
        question: 'synthetic E4 purge fixture',
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
        ingestMs: 1000,
        holdMs: 1000,
        deliveryMs: 1000,
        dryrunMs: 1000,
        sseReplayMs: 1000,
        deadLetterMs: 1000,
        decisionMetadataMs: 1000,
      },
    });
    store.database.exec(
      `UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
       INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1);`,
    );
    for (const eventId of ['event-e4-reserved', 'event-e4-flight']) {
      store.database
        .prepare(
          "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)",
        )
        .run(eventId, store.installationId, accountId, eventId, NOW, NOW, NOW);
      store.database
        .prepare(
          "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES (?, ?, 1, ?, X'01')",
        )
        .run(eventId, 'rule-e4-purge', NOW + 1000);
      reserveJudgeWork({
        store,
        id: eventId,
        workId: `work:${eventId}`,
        scope: {
          scope: 'source-owned',
          source: 'gmail',
          accountId,
          eventId,
          ruleId: 'rule-e4-purge',
          ruleVersion: 1,
          judgeId: judge.judgeId,
          judgeVersion: 1,
        },
        judge,
        limits,
        finalEnvelope: Buffer.from('e4'),
        switchGeneration: 0,
        now: NOW,
      });
    }
    beginJudgeTransport({ store, reservationId: 'event-e4-flight', now: NOW });
    new JudgeKinds({ store, now: () => NOW + 1 }).disable('typesafe');
    assert.deepEqual(
      (
        store.database
          .prepare('SELECT id, state, concurrency_owned FROM judge_budget_reservations ORDER BY id')
          .all() as Array<{ id: string; state: string; concurrency_owned: number }>
      ).map((row) => ({ ...row })),
      [
        { id: 'event-e4-flight', state: 'settled', concurrency_owned: 0 },
        { id: 'event-e4-reserved', state: 'released', concurrency_owned: 0 },
      ],
    );
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ?')
          .get('event-e4-flight') as { count: number }
      ).count,
      0,
    );
    assert.equal(
      new ImmutableVersions(store.database).activeVersion('judge-kind', 'typesafe'),
      null,
      'disable removes only its kind pointer',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E4 purge closure: kind disable removes every bound work class and re-enable resumes nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const resourcesBefore = lastingResources();
  const setup = await purgeFixture({ label: 'kind-disable' });
  try {
    const localJudge = {
      judgeId: 'judge-kind-disable-other',
      version: 1,
      kind: 'local-endpoint' as const,
      provider: 'ollama',
      model: 'nimble',
      endpoint: 'http://127.0.0.1:11434/v1/systemone',
      approvedAddressSet: ['127.0.0.1'] as const,
      promptTemplate: 'ollama-noul-v1',
      protocol: 'noul' as const,
    };
    const otherRule = agenticRule({ ruleId: 'rule-e4-kind-disable-other', version: 1 });
    assert.ok(otherRule.agentic, 'the other-kind fixture remains agentic');
    Object.assign(otherRule.agentic, { judge: localJudge });
    const versions = new ImmutableVersions(setup.store.database);
    versions.createJudge(localJudge);
    versions.createRule(otherRule);
    setup.store.database.exec(
      `UPDATE rule_versions SET state = 'active', approval_id = 'approval-e4-other',
         authorization_activation_id = 'activation-e4-other', activated_at = ${NOW}
       WHERE rule_id = 'rule-e4-kind-disable-other' AND version = 1;
       INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('rule', 'rule-e4-kind-disable-other', 1, NULL, ${NOW});
       INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-e4-kind-disable-other', '${setup.store.installationId}', 'gmail.message.received', 1,
               '${accountId}', 'dedupe-e4-kind-disable-other', ${NOW}, ${NOW}, ${NOW});
       INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES ('event-e4-kind-disable-other', 'rule-e4-kind-disable-other', 1, ${NOW + 10_000}, X'04');
       INSERT INTO rule_activation_points
         (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('activation-e12', '${setup.ruleId}', 1, 'gmail', '${accountId}', 'mailbox', X'01', ${NOW});`,
    );
    const authorityRows = (database: DatabaseSync) => ({
      activationPoints: (
        database
          .prepare('SELECT COUNT(*) AS count FROM rule_activation_points WHERE rule_id = ? AND rule_version = 1')
          .get(setup.ruleId) as { count: number }
      ).count,
      targetReferences: (
        database
          .prepare('SELECT COUNT(*) AS count FROM target_version_references WHERE rule_id = ? AND rule_version = 1')
          .get(setup.ruleId) as { count: number }
      ).count,
    });
    const authorityBefore = authorityRows(setup.store.database);
    assert.equal(authorityBefore.activationPoints, 1, 'the bound rule starts with its activation point');
    new JudgeKinds({ store: setup.store, now: () => NOW + 1 }).disable('typesafe');
    assert.deepEqual(
      authorityRows(setup.store.database),
      authorityBefore,
      'kind disable keeps the bound rule able to resume: its activation point and target references stay',
    );
    assertPurgedSurfaceInStore(setup.store, setup, 'judge kind disable');
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            'SELECT state, approval_id, authorization_activation_id FROM rule_versions WHERE rule_id = ? AND version = 1',
          )
          .get(setup.ruleId) as Record<string, unknown>),
      },
      { state: 'active', approval_id: 'approval-e12', authorization_activation_id: 'activation-e12' },
      'kind disable keeps the bound rule version and its standing approval lineage',
    );
    assert.equal(
      (
        setup.store.database
          .prepare(
            'SELECT COUNT(*) AS count FROM judge_versions WHERE judge_id = ? AND version = 1 AND revoked_at IS NULL',
          )
          .get(judge.judgeId) as { count: number }
      ).count,
      1,
      'kind disable keeps the immutable judge version unrevoked',
    );
    assert.equal(
      (
        setup.store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE rule_id = ?')
          .get(otherRule.ruleId) as { count: number }
      ).count,
      1,
      "kind disable leaves another judge kind's retained projection untouched",
    );
    setup.close();
    const reopened = await openEventDatabase({ stateDir: setup.root });
    try {
      assertPurgedSurfaceInStore(reopened, setup, 'judge kind disable after restart');
      assert.equal(
        (
          reopened.database
            .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE rule_id = ?')
            .get(otherRule.ruleId) as { count: number }
        ).count,
        1,
        "restart preserves the other judge kind's retained projection",
      );
      reopened.database
        .prepare(
          "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'typesafe', 1, NULL, ?)",
        )
        .run(NOW + 2);
      assert.deepEqual(
        reopened.immediate(() => recoverJudgeWork({ database: reopened.database, now: NOW + 3 })),
        { released: 0, settled: 0 },
        're-enabling the retained kind finds no reservation or projection to resume',
      );
      assert.deepEqual(
        authorityRows(reopened.database),
        authorityBefore,
        'after restart and re-enable the bound rule still has its activation point, so new events reach it again',
      );
      assertPurgedSurfaceInStore(reopened, setup, 'judge kind re-enable');
    } finally {
      reopened.close();
    }
  } finally {
    setup.close();
    await rm(setup.root, { recursive: true, force: true });
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'kind disable, restart and re-enable close every database and asynchronous handle',
  );
});

test('E4 purge closure: expiry settles only the expired rule on an event shared with live rule B work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e4-expiry-rule-bound-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const versions = new ImmutableVersions(store.database);
    const ruleA = agenticRule({ ruleId: 'rule-e4-a', version: 1 });
    const ruleB = agenticRule({ ruleId: 'rule-e4-b', version: 1 });
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: budgetLimits,
      providers: [{ provider: 'typesafe', ...budgetLimits }],
    });
    versions.createRule(ruleA);
    versions.createRule(ruleB);
    store.database.exec(
      `UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
       INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1);`,
    );
    store.database
      .prepare(
        "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)",
      )
      .run('event-e4-rule-bound', store.installationId, accountId, 'dedupe-e4-rule-bound', NOW, NOW, NOW);
    store.database.exec(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES ('event-e4-rule-bound', 'rule-e4-a', 1, ${NOW - 1}, X'01'),
              ('event-e4-rule-bound', 'rule-e4-b', 1, ${NOW + 10_000}, X'01');`,
    );
    insertRuleBoundReservation({ store, id: 'work-a', ruleId: 'rule-e4-a', ruleVersion: 1 });
    insertRuleBoundReservation({ store, id: 'work-b', ruleId: 'rule-e4-b', ruleVersion: 1 });
    new EventExpiry(store, () => NOW).sweep();

    assert.equal(
      (
        store.database.prepare('SELECT state FROM judge_budget_reservations WHERE id = ?').get('work-a') as {
          state: string;
        }
      ).state,
      'settled',
      'the expired rule is terminalised',
    );
    assertLiveRuleB(store, 'expiry');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('E4 purge closure: retention tightening settles only rule A on an event shared with live rule B work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-e4-tightening-rule-bound-');
  const store = await openEventDatabase({ stateDir: root });
  try {
    const versions = new ImmutableVersions(store.database);
    const parent = agenticRule({ ruleId: 'rule-e4-a', version: 1, ingestMs: 10_000 });
    const child = agenticRule({ ruleId: 'rule-e4-a', version: 2, ingestMs: 1 });
    const ruleB = agenticRule({ ruleId: 'rule-e4-b', version: 1, ingestMs: 10_000 });
    versions.createTarget(target);
    versions.createJudge(judge);
    versions.createJudgeKind({
      id: 'judge-kind:typesafe',
      kind: 'typesafe',
      version: 1,
      endpoint: 'https://api.typesafe.ai/v1/systemone',
    });
    versions.createJudgeBudget({
      budgetId: 'judge-budget',
      version: 1,
      global: { ...budgetLimits, concurrency: 4 },
      providers: [{ provider: 'typesafe', ...budgetLimits, concurrency: 4 }],
    });
    versions.createRule(parent);
    versions.createRule(child);
    versions.createRule(ruleB);
    store.database.exec(
      `UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
       INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
         VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1), ('rule', 'rule-e4-a', 1, 'activation-e4-a', 1);
       UPDATE rule_versions
          SET state = 'active', approval_id = 'approval-e4-a', authorization_activation_id = 'activation-e4-a', activated_at = 1
        WHERE rule_id = 'rule-e4-a' AND version = 1;
       INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
         VALUES ('activation-e4-a', 'rule-e4-a', 1, 'gmail', '${accountId}', 'mailbox', X'01', 1);`,
    );
    store.database
      .prepare(
        "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)",
      )
      .run(
        'event-e4-rule-bound',
        store.installationId,
        accountId,
        'dedupe-e4-tightening',
        NOW - 10,
        NOW - 10,
        NOW - 10,
      );
    store.database.exec(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES ('event-e4-rule-bound', 'rule-e4-a', 1, ${NOW + 10_000}, X'01'),
              ('event-e4-rule-bound', 'rule-e4-a', 2, ${NOW + 10_000}, X'01'),
              ('event-e4-rule-bound', 'rule-e4-b', 1, ${NOW + 10_000}, X'01');`,
    );
    insertRuleBoundReservation({ store, id: 'work-a', ruleId: 'rule-e4-a', ruleVersion: 1 });
    insertRuleBoundReservation({ store, id: 'work-a-v2', ruleId: 'rule-e4-a', ruleVersion: 2 });
    insertRuleBoundReservation({ store, id: 'work-b', ruleId: 'rule-e4-b', ruleVersion: 1 });
    reserveJudgeTest({
      store,
      id: 'work-derived-parent-synthetic',
      workId: 'work:derived-parent-synthetic',
      testWorkId: 'test-work-derived-parent-synthetic',
      judge,
      finalEnvelope: Buffer.from('synthetic-derived-parent'),
      switchGeneration: 0,
      now: NOW,
      authority: { ruleId: parent.ruleId, ruleVersion: parent.version },
    });
    beginJudgeTransport({ store, reservationId: 'work-derived-parent-synthetic', now: NOW });

    await applyDerivedTightening({
      database: store.database,
      parent,
      child,
      now: NOW,
      decryptPoint: async () => ({ historyId: '1' }),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    });

    assert.equal(
      (
        store.database.prepare('SELECT state FROM judge_budget_reservations WHERE id = ?').get('work-a') as {
          state: string;
        }
      ).state,
      'settled',
      'retention tightening: rule A is terminalised',
    );
    assert.equal(
      (
        store.database.prepare('SELECT state FROM judge_budget_reservations WHERE id = ?').get('work-a-v2') as {
          state: string;
        }
      ).state,
      'settled',
      'retention tightening: rule A version 2 is terminalised',
    );
    assertLiveRuleB(store, 'retention tightening');
    assert.equal(
      (
        store.database
          .prepare('SELECT state FROM judge_budget_reservations WHERE id = ?')
          .get('work-derived-parent-synthetic') as { state: string }
      ).state,
      'settled',
      'derived parent revoke settles synthetic work bound to the revoked parent',
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
