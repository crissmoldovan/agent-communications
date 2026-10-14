import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import {
  beginJudgeTransport,
  JudgeBudgetError,
  releaseJudgeWork,
  reserveJudgeTest,
  reserveJudgeWork,
  settleJudgeWork,
} from '../src/runtime/judge-budget.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const HOUR = 60 * 60 * 1000;
const THIRTY_DAYS = 30 * 24 * HOUR;
const NOW = 1_800_000_000_000;
const ACCOUNT = 'ibx_E5BUDGETAAAAAAA';

const target = { targetId: 'target-e5-budget', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const judge = {
  judgeId: 'judge-e5-budget',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe' as const,
  model: 'jev-1.13.0' as const,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};

function budget(version: number, overrides: Partial<typeof budgetLimits> = {}) {
  return {
    budgetId: 'judge-budget' as const,
    version,
    global: { ...budgetLimits, ...overrides },
    providers: [{ provider: 'typesafe', ...budgetLimits, ...overrides }],
  };
}

const budgetLimits = { callsPerRollingHour: 20, inputTokensPerRolling30Days: 100_000, concurrency: 3 };
const ruleLimits = {
  callsPerRollingHour: 20,
  inputTokensPerRolling30Days: 100_000,
  concurrency: 3,
  maxInputTokens: 512,
};

function rule(version: number) {
  return {
    ruleId: 'rule-e5-budget',
    version,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    agentic: {
      judge,
      question: 'Is this an E5 budget fixture?',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match' as const,
      ...ruleLimits,
      maxOutputTokens: 64,
    },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: 604_800_000,
      holdMs: 604_800_000,
      deliveryMs: 604_800_000,
      dryrunMs: 86_400_000,
      sseReplayMs: 604_800_000,
      deadLetterMs: 604_800_000,
      decisionMetadataMs: 7_776_000_000,
    },
  };
}

async function fixture(
  options: { readonly limits?: Partial<typeof ruleLimits>; readonly budget?: Partial<typeof budgetLimits> } = {},
) {
  const root = await shortTempDir('events-e5-budget-');
  const store = await openEventDatabase({ stateDir: root });
  const versions = new ImmutableVersions(store.database);
  const sourceLimits = { ...ruleLimits, ...options.limits };
  const budgetDocument = budget(1, options.budget);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeKind({
    id: 'judge-kind:typesafe',
    kind: 'typesafe',
    version: 1,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
  });
  versions.createJudgeBudget(budgetDocument);
  versions.createRule({ ...rule(1), agentic: { ...rule(1).agentic, ...sourceLimits } });
  store.database.exec(`UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 0 WHERE singleton = 1;
    INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
    VALUES ('judge-budget', 'judge-budget', 1, 'judge-budget@1', 1);
    INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
    VALUES ('judge-kind', 'typesafe', 1, 'judge-kind:typesafe@1', 1);
    INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
    VALUES ('rule', 'rule-e5-budget', 1, 'rule-e5-budget@1', 1);`);
  return { root, store, versions, limits: sourceLimits };
}

function addProjection(
  setup: Awaited<ReturnType<typeof fixture>>,
  input: { readonly eventId: string; readonly ruleVersion?: number; readonly accountId?: string } = {
    eventId: 'event-e5',
  },
): void {
  const version = input.ruleVersion ?? 1;
  const accountId = input.accountId ?? ACCOUNT;
  setup.store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
    )
    .run(input.eventId, setup.store.installationId, accountId, `dedupe:${input.eventId}`, NOW, NOW, NOW);
  setup.store.database
    .prepare(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES (?, 'rule-e5-budget', ?, ?, X'01')`,
    )
    .run(input.eventId, version, NOW + HOUR);
}

function sourceWork(eventId: string, ruleVersion: number = 1) {
  return {
    scope: 'source-owned' as const,
    source: 'gmail' as const,
    accountId: ACCOUNT,
    eventId,
    ruleId: 'rule-e5-budget',
    ruleVersion,
    judgeId: judge.judgeId,
    judgeVersion: judge.version,
  };
}

function reserve(
  setup: Awaited<ReturnType<typeof fixture>>,
  id: string,
  eventId: string,
  now: number = NOW,
  overrides: Partial<{
    readonly finalEnvelope: Uint8Array;
    readonly maxInputTokens: number;
    readonly workId: string;
  }> = {},
) {
  const { finalEnvelope, maxInputTokens, workId } = overrides;
  return reserveJudgeWork({
    store: setup.store,
    id,
    workId: workId ?? `work:${id}`,
    scope: sourceWork(eventId),
    judge,
    limits: { ...setup.limits, ...(maxInputTokens === undefined ? {} : { maxInputTokens }) },
    finalEnvelope: finalEnvelope ?? Buffer.from('{"v":1}', 'utf8'),
    switchGeneration: 0,
    now,
  });
}

function expectBudget(code: JudgeBudgetError['code']) {
  return (error: unknown): boolean => error instanceof JudgeBudgetError && error.code === code;
}

test('E4 budget digest fence: a live reservation refuses an altered active budget before it creates ledger work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ budget: { callsPerRollingHour: 1 } });
  try {
    addProjection(setup, { eventId: 'event-e4-altered-live-budget' });
    setup.store.database
      .prepare('UPDATE judge_budget_versions SET document = replace(document, ?, ?) WHERE version = 1')
      .run('"callsPerRollingHour":1', '"callsPerRollingHour":2');

    assert.throws(
      () => reserve(setup, 'altered-live-budget', 'event-e4-altered-live-budget'),
      (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      0,
      'a digest-drifting active budget cannot create a reservation under its raised limits',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 kind digest fence: a live reservation treats an altered active kind document as unavailable', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    addProjection(setup, { eventId: 'event-e4-altered-live-kind' });
    setup.store.database
      .prepare('UPDATE judge_kind_versions SET document = replace(document, ?, ?) WHERE kind = ? AND version = 1')
      .run('"version":1', '"version":2', 'typesafe');

    assert.throws(
      () => reserve(setup, 'altered-live-kind', 'event-e4-altered-live-kind'),
      expectBudget('JUDGE_KIND_DISABLED'),
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      0,
      'an unavailable kind cannot create a reservation',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: rolling call and token windows include reserved, in-flight, and settled but never released', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 3, inputTokensPerRolling30Days: 9, concurrency: 3 } });
  try {
    for (const eventId of ['event-e5-one', 'event-e5-two', 'event-e5-three', 'event-e5-four'])
      addProjection(setup, { eventId });
    reserve(setup, 'reservation-one', 'event-e5-one', NOW, { finalEnvelope: Buffer.from('xxxx') });
    beginJudgeTransport({ store: setup.store, reservationId: 'reservation-one', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'reservation-one',
      result: 'completed',
      actualInputTokens: 4,
      now: NOW,
    });
    reserve(setup, 'reservation-two', 'event-e5-two', NOW, { finalEnvelope: Buffer.from('xxxx') });
    beginJudgeTransport({ store: setup.store, reservationId: 'reservation-two', now: NOW });
    reserve(setup, 'reservation-three', 'event-e5-three', NOW, { finalEnvelope: Buffer.from('x') });
    await assert.rejects(
      async () => reserve(setup, 'reservation-four', 'event-e5-four'),
      expectBudget('CALLS_PER_ROLLING_HOUR_EXHAUSTED'),
    );
    settleJudgeWork({
      store: setup.store,
      reservationId: 'reservation-two',
      result: 'completed',
      actualInputTokens: 4,
      now: NOW,
    });
    assert.equal(releaseJudgeWork({ store: setup.store, reservationId: 'reservation-three', now: NOW }), true);
    assert.equal(
      (
        setup.store.database
          .prepare(
            "SELECT SUM(COALESCE(actual_input_tokens, estimated_input_tokens)) AS tokens FROM judge_budget_reservations WHERE state != 'released'",
          )
          .get() as { tokens: number }
      ).tokens,
      8,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 attempt ledger: a released attempt stays terminal while one retry row owns and counts the logical work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({
    limits: { callsPerRollingHour: 1, inputTokensPerRolling30Days: 4, concurrency: 1 },
    budget: { callsPerRollingHour: 1, inputTokensPerRolling30Days: 4, concurrency: 1 },
  });
  const logicalWorkId = 'logical:released-retry';
  try {
    addProjection(setup, { eventId: 'event-e5-released-retry' });
    const first = reserve(setup, 'released-attempt-one', 'event-e5-released-retry', NOW, {
      finalEnvelope: Buffer.from('one'),
      workId: logicalWorkId,
    });
    assert.equal(first.id, 'released-attempt-one', 'the first attempt uses its supplied attempt identity');
    assert.equal(
      releaseJudgeWork({ store: setup.store, reservationId: first.id, now: NOW + 1 }),
      true,
      'the pre-I/O first attempt releases exactly once',
    );

    const second = reserve(setup, 'released-attempt-two', 'event-e5-released-retry', NOW + 2, {
      finalEnvelope: Buffer.from('two'),
      workId: logicalWorkId,
    });
    assert.equal(second.id, 'released-attempt-two', 'a retry receives a new durable attempt identity');
    assert.deepEqual(
      setup.store.database
        .prepare(
          `SELECT id, work_id, state, concurrency_owned
             FROM judge_budget_reservations
            WHERE work_id = ?
            ORDER BY reserved_at, id`,
        )
        .all(logicalWorkId)
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        {
          id: 'released-attempt-one',
          work_id: logicalWorkId,
          state: 'released',
          concurrency_owned: 0,
        },
        {
          id: 'released-attempt-two',
          work_id: logicalWorkId,
          state: 'reserved',
          concurrency_owned: 1,
        },
      ],
      'the released row remains terminal beside the retry row',
    );
    assert.throws(
      () =>
        reserve(setup, 'released-attempt-three', 'event-e5-released-retry', NOW + 3, {
          finalEnvelope: Buffer.from('two'),
          workId: logicalWorkId,
        }),
      expectBudget('JUDGE_WORK_OWNER_HELD'),
      'the logical-work fence refuses a second live attempt',
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            `SELECT COUNT(*) AS calls,
                    SUM(COALESCE(actual_input_tokens, estimated_input_tokens)) AS tokens,
                    SUM(concurrency_owned) AS concurrency
               FROM judge_budget_reservations
              WHERE work_id = ? AND state IN ('reserved', 'in-flight', 'settled')`,
          )
          .get(logicalWorkId) as object),
      },
      { calls: 1, tokens: 3, concurrency: 1 },
      'the rolling and concurrency ledgers count the retry attempt exactly once and the released attempt never',
    );
    assert.equal(
      beginJudgeTransport({ store: setup.store, reservationId: second.id, now: NOW + 4 }),
      true,
      'the one live retry can enter the physical-I/O state',
    );
    assert.equal(
      settleJudgeWork({
        store: setup.store,
        reservationId: second.id,
        result: 'completed',
        actualInputTokens: 3,
        now: NOW + 5,
      }),
      true,
      'the one charged retry settles exactly once',
    );
    assert.throws(
      () =>
        reserve(setup, 'released-attempt-three', 'event-e5-released-retry', NOW + 6, {
          finalEnvelope: Buffer.from('two'),
          workId: logicalWorkId,
        }),
      expectBudget('GLOBAL_CALLS_PER_ROLLING_HOUR_EXHAUSTED'),
      'the settled retry alone exhausts the one-call rolling ceiling',
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            `SELECT COUNT(*) AS calls,
                    SUM(COALESCE(actual_input_tokens, estimated_input_tokens)) AS tokens,
                    SUM(concurrency_owned) AS concurrency
               FROM judge_budget_reservations
              WHERE work_id = ? AND state IN ('reserved', 'in-flight', 'settled')`,
          )
          .get(logicalWorkId) as object),
      },
      { calls: 1, tokens: 3, concurrency: 0 },
      'the failed retry adds neither a rolling charge nor a concurrency owner',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: concurrency counts only reserved and in-flight work', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 10, concurrency: 2 } });
  try {
    for (const eventId of ['event-e5-a', 'event-e5-b', 'event-e5-c', 'event-e5-d']) addProjection(setup, { eventId });
    reserve(setup, 'concurrency-settled', 'event-e5-a');
    beginJudgeTransport({ store: setup.store, reservationId: 'concurrency-settled', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'concurrency-settled',
      result: 'completed',
      actualInputTokens: 1,
      now: NOW,
    });
    assert.equal(
      (
        setup.store.database
          .prepare("SELECT concurrency_owned FROM judge_budget_reservations WHERE id = 'concurrency-settled'")
          .get() as { concurrency_owned: number }
      ).concurrency_owned,
      0,
      'settlement frees its durable concurrency slot',
    );
    reserve(setup, 'concurrency-reserved', 'event-e5-b');
    reserve(setup, 'concurrency-inflight', 'event-e5-c');
    beginJudgeTransport({ store: setup.store, reservationId: 'concurrency-inflight', now: NOW });
    await assert.rejects(
      async () => reserve(setup, 'concurrency-blocked', 'event-e5-d'),
      expectBudget('CONCURRENCY_EXHAUSTED'),
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: stable rule and installation identities survive immutable replacements', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 2 }, budget: { callsPerRollingHour: 1 } });
  try {
    addProjection(setup, { eventId: 'event-e5-old' });
    reserve(setup, 'stable-old', 'event-e5-old');
    beginJudgeTransport({ store: setup.store, reservationId: 'stable-old', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'stable-old',
      result: 'completed',
      actualInputTokens: 1,
      now: NOW,
    });
    setup.versions.createJudgeBudget(budget(2, { callsPerRollingHour: 1 }));
    setup.versions.createRule({ ...rule(2), agentic: { ...rule(2).agentic, callsPerRollingHour: 2 } });
    setup.store.database
      .prepare(
        "UPDATE active_versions SET version = 2, current_cutover_id = 'judge-budget@2' WHERE kind = 'judge-budget'",
      )
      .run();
    addProjection(setup, { eventId: 'event-e5-new', ruleVersion: 2 });
    await assert.rejects(
      async () =>
        reserveJudgeWork({
          store: setup.store,
          id: 'stable-new',
          workId: 'work:stable-new',
          scope: sourceWork('event-e5-new', 2),
          judge,
          limits: { ...setup.limits, callsPerRollingHour: 2 },
          finalEnvelope: Buffer.from('x'),
          switchGeneration: 0,
          now: NOW,
        }),
      expectBudget('GLOBAL_CALLS_PER_ROLLING_HOUR_EXHAUSTED'),
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: a stable rule ledger key does not include its immutable version', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 1 }, budget: { callsPerRollingHour: 10 } });
  try {
    addProjection(setup, { eventId: 'event-e5-rule-v1' });
    reserve(setup, 'rule-key-v1', 'event-e5-rule-v1');
    beginJudgeTransport({ store: setup.store, reservationId: 'rule-key-v1', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'rule-key-v1',
      result: 'completed',
      actualInputTokens: 1,
      now: NOW,
    });
    setup.versions.createRule({ ...rule(2), agentic: { ...rule(2).agentic, callsPerRollingHour: 1 } });
    addProjection(setup, { eventId: 'event-e5-rule-v2', ruleVersion: 2 });
    await assert.rejects(
      async () =>
        reserveJudgeWork({
          store: setup.store,
          id: 'rule-key-v2',
          workId: 'work:rule-key-v2',
          scope: sourceWork('event-e5-rule-v2', 2),
          judge,
          limits: { ...setup.limits, callsPerRollingHour: 1 },
          finalEnvelope: Buffer.from('x'),
          switchGeneration: 0,
          now: NOW,
        }),
      expectBudget('CALLS_PER_ROLLING_HOUR_EXHAUSTED'),
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: the one-hour window lower bound is inclusive', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 1, inputTokensPerRolling30Days: 100 } });
  try {
    addProjection(setup, { eventId: 'event-e5-hour' });
    addProjection(setup, { eventId: 'event-e5-hour-at' });
    reserve(setup, 'hour-edge', 'event-e5-hour', NOW - HOUR);
    await assert.rejects(
      async () => reserve(setup, 'hour-at-edge', 'event-e5-hour-at', NOW),
      expectBudget('CALLS_PER_ROLLING_HOUR_EXHAUSTED'),
    );
    settleJudgeWork({ store: setup.store, reservationId: 'hour-edge', result: 'unknown', now: NOW - HOUR });
    setup.store.database
      .prepare("UPDATE judge_budget_reservations SET reserved_at = ? WHERE id = 'hour-edge'")
      .run(NOW - HOUR - 1);
    addProjection(setup, { eventId: 'event-e5-hour-after' });
    assert.equal(reserve(setup, 'hour-after-edge', 'event-e5-hour-after', NOW).state, 'reserved');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: the thirty-day token window lower bound is inclusive', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ limits: { callsPerRollingHour: 10, inputTokensPerRolling30Days: 2 } });
  try {
    addProjection(setup, { eventId: 'event-e5-token' });
    addProjection(setup, { eventId: 'event-e5-token-at' });
    reserve(setup, 'token-edge', 'event-e5-token', NOW - THIRTY_DAYS, { finalEnvelope: Buffer.from('aa') });
    await assert.rejects(
      async () => reserve(setup, 'token-at-edge', 'event-e5-token-at', NOW, { finalEnvelope: Buffer.from('a') }),
      expectBudget('INPUT_TOKENS_PER_ROLLING_30_DAYS_EXHAUSTED'),
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: final-envelope UTF-8 bytes are reserved before I/O and over-limit input never reaches transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    addProjection(setup, { eventId: 'event-e5-utf8' });
    assert.equal(
      reserve(setup, 'utf8-estimate', 'event-e5-utf8', NOW, { finalEnvelope: Buffer.from('é', 'utf8') })
        .estimatedInputTokens,
      2,
    );
    let transportCalls = 0;
    addProjection(setup, { eventId: 'event-e5-limit' });
    await assert.rejects(async () => {
      reserve(setup, 'input-refusal', 'event-e5-limit', NOW, {
        finalEnvelope: Buffer.from('xx'),
        maxInputTokens: 1,
      });
      transportCalls += 1;
    }, expectBudget('INPUT_TOKEN_LIMIT_EXCEEDED'));
    assert.equal(transportCalls, 0);
    addProjection(setup, { eventId: 'event-e5-cap' });
    await assert.rejects(
      async () => reserve(setup, 'cap-refusal', 'event-e5-cap', NOW, { finalEnvelope: Buffer.alloc(65_537) }),
      expectBudget('JUDGE_REQUEST_TOO_LARGE'),
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: one reservation crosses the pre-I/O transport gate at most once', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture();
  try {
    addProjection(setup, { eventId: 'event-e5-one-transport' });
    reserve(setup, 'one-transport', 'event-e5-one-transport');
    assert.equal(beginJudgeTransport({ store: setup.store, reservationId: 'one-transport', now: NOW }), true);
    assert.equal(
      beginJudgeTransport({ store: setup.store, reservationId: 'one-transport', now: NOW + 1 }),
      false,
      'a retry cannot cross the durable pre-I/O edge twice',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: only a parsed successful answer may replace the estimate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    for (const eventId of [
      'event-e5-known',
      'event-e5-omitted',
      'event-e5-unknown',
      'event-e5-timeout',
      'event-e5-transport-failure',
      'event-e5-output',
    ])
      addProjection(setup, { eventId });
    reserve(setup, 'known-input', 'event-e5-known', NOW, { finalEnvelope: Buffer.from('estimate') });
    beginJudgeTransport({ store: setup.store, reservationId: 'known-input', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'known-input',
      result: 'completed',
      actualInputTokens: 3,
      now: NOW,
    });
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            "SELECT state, actual_input_tokens, concurrency_owned FROM judge_budget_reservations WHERE id = 'known-input'",
          )
          .get() as object),
      },
      { state: 'settled', actual_input_tokens: 3, concurrency_owned: 0 },
    );
    reserve(setup, 'omitted-result', 'event-e5-omitted', NOW, { finalEnvelope: Buffer.from('estimate') });
    beginJudgeTransport({ store: setup.store, reservationId: 'omitted-result', now: NOW });
    assert.deepEqual(
      {
        settled: settleJudgeWork({
          store: setup.store,
          reservationId: 'omitted-result',
          actualInputTokens: 0,
          now: NOW,
        } as unknown as Parameters<typeof settleJudgeWork>[0]),
        ...((setup.store.database
          .prepare(
            "SELECT state, actual_input_tokens, estimated_input_tokens, concurrency_owned FROM judge_budget_reservations WHERE id = 'omitted-result'",
          )
          .get() as object) ?? {}),
      },
      { settled: true, state: 'settled', actual_input_tokens: null, estimated_input_tokens: 8, concurrency_owned: 0 },
      'an omitted discriminant can never turn zero into a completed provider-usage charge',
    );
    for (const outcome of [
      { id: 'unknown-input', eventId: 'event-e5-unknown', result: 'unknown' as const },
      { id: 'timeout-input', eventId: 'event-e5-timeout', result: 'timeout' as never },
      {
        id: 'transport-failure-input',
        eventId: 'event-e5-transport-failure',
        result: 'transport-failure' as never,
      },
    ]) {
      reserve(setup, outcome.id, outcome.eventId);
      beginJudgeTransport({ store: setup.store, reservationId: outcome.id, now: NOW });
      settleJudgeWork({
        store: setup.store,
        reservationId: outcome.id,
        result: outcome.result,
        actualInputTokens: 0,
        now: NOW,
      } as unknown as Parameters<typeof settleJudgeWork>[0]);
    }
    reserve(setup, 'output-limit', 'event-e5-output');
    beginJudgeTransport({ store: setup.store, reservationId: 'output-limit', now: NOW });
    settleJudgeWork({
      store: setup.store,
      reservationId: 'output-limit',
      result: 'output-token-limit',
      actualInputTokens: 0,
      now: NOW,
    } as unknown as Parameters<typeof settleJudgeWork>[0]);
    assert.deepEqual(
      (
        setup.store.database
          .prepare(
            `SELECT id, actual_input_tokens, estimated_input_tokens
             FROM judge_budget_reservations
             WHERE id IN ('unknown-input', 'timeout-input', 'transport-failure-input', 'output-limit')
             ORDER BY id`,
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({ ...row })),
      [
        { id: 'output-limit', actual_input_tokens: null, estimated_input_tokens: 7 },
        { id: 'timeout-input', actual_input_tokens: null, estimated_input_tokens: 7 },
        { id: 'transport-failure-input', actual_input_tokens: null, estimated_input_tokens: 7 },
        { id: 'unknown-input', actual_input_tokens: null, estimated_input_tokens: 7 },
      ],
      'every post-write result without a parsed provider answer preserves its conservative estimate',
    );
    for (const reservationId of ['unknown-input', 'timeout-input', 'transport-failure-input'])
      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare('SELECT outcome, metadata_state FROM decisions WHERE id = ?')
            .get(`judge:${reservationId}`) as object),
        },
        { outcome: 'no-match', metadata_state: 'judge-io-unknown' },
      );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT outcome, metadata_state FROM decisions WHERE id = 'judge:output-limit'")
          .get() as object),
      },
      { outcome: 'no-match', metadata_state: 'output-token-limit-exceeded' },
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      2,
      'the completed and malformed-discriminant rows retain their projections; each named failed post-I/O outcome is terminally purged',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: a settled reservation cannot be charged or terminalised a second time', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    addProjection(setup, { eventId: 'event-e5-once' });
    reserve(setup, 'settle-once', 'event-e5-once');
    beginJudgeTransport({ store: setup.store, reservationId: 'settle-once', now: NOW });
    assert.equal(
      settleJudgeWork({
        store: setup.store,
        reservationId: 'settle-once',
        result: 'completed',
        actualInputTokens: 2,
        now: NOW,
      }),
      true,
    );
    assert.equal(
      settleJudgeWork({
        store: setup.store,
        reservationId: 'settle-once',
        result: 'completed',
        actualInputTokens: 99,
        now: NOW + 1,
      }),
      false,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare(
            "SELECT state, actual_input_tokens, concurrency_owned FROM judge_budget_reservations WHERE id = 'settle-once'",
          )
          .get() as object),
      },
      { state: 'settled', actual_input_tokens: 2, concurrency_owned: 0 },
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: judge tests have an exact-version unrefundable ten-per-hour charge and consume global only', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({ budget: { callsPerRollingHour: 40, concurrency: 2 } });
  try {
    for (let index = 0; index < 10; index += 1) {
      const reservation = reserveJudgeTest({
        store: setup.store,
        id: `judge-test-${index}`,
        workId: `judge-test-work-${index}`,
        testWorkId: `judge-test-work-${index}`,
        judge,
        finalEnvelope: Buffer.from('x'),
        switchGeneration: 0,
        now: NOW,
        authority: { ruleId: 'rule-e5-budget', ruleVersion: 1 },
      });
      beginJudgeTransport({ store: setup.store, reservationId: reservation.id, now: NOW });
      settleJudgeWork({ store: setup.store, reservationId: reservation.id, result: 'unknown', now: NOW });
    }
    await assert.rejects(
      async () =>
        reserveJudgeTest({
          store: setup.store,
          id: 'judge-test-eleven',
          workId: 'judge-test-work-eleven',
          testWorkId: 'judge-test-work-eleven',
          judge,
          finalEnvelope: Buffer.from('x'),
          switchGeneration: 0,
          now: NOW,
          authority: { ruleId: 'rule-e5-budget', ruleVersion: 1 },
        }),
      expectBudget('JUDGE_TEST_RATE_EXHAUSTED'),
    );
    setup.versions.createJudge({ ...judge, version: 2 });
    const nextVersion = reserveJudgeTest({
      store: setup.store,
      id: 'judge-test-version-two',
      workId: 'judge-test-work-version-two',
      testWorkId: 'judge-test-work-version-two',
      judge: { ...judge, version: 2 },
      finalEnvelope: Buffer.from('x'),
      switchGeneration: 0,
      now: NOW,
      authority: { ruleId: 'rule-e5-budget', ruleVersion: 1 },
    });
    assert.equal(nextVersion.provider, null);
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_test_charges').get() as { count: number })
        .count,
      11,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 budget: no active singleton refuses before a transport can begin', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture();
  try {
    addProjection(setup, { eventId: 'event-e5-no-singleton' });
    setup.store.database.prepare("DELETE FROM active_versions WHERE kind = 'judge-budget'").run();
    await assert.rejects(
      async () => reserve(setup, 'no-singleton', 'event-e5-no-singleton'),
      expectBudget('NO_ACTIVE_BUDGET'),
    );
    assert.equal(
      (
        setup.store.database.prepare('SELECT COUNT(*) AS count FROM judge_budget_reservations').get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
