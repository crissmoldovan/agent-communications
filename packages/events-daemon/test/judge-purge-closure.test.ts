import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { beginJudgeTransport, reserveJudgeWork } from '../src/runtime/judge-budget.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { applyDerivedTightening } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const NOW = 1_800_000_000_000;
const accountId = 'ibx_E4PURGEAAAAAAAA';
const target = { targetId: 'target-e4-purge', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
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
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1);",
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
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-budget', 'judge-budget', 1, NULL, 1), ('judge-kind', 'typesafe', 1, NULL, 1);",
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
      global: budgetLimits,
      providers: [{ provider: 'typesafe', ...budgetLimits }],
    });
    versions.createRule(parent);
    versions.createRule(child);
    versions.createRule(ruleB);
    store.database.exec(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
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
              ('event-e4-rule-bound', 'rule-e4-b', 1, ${NOW + 10_000}, X'01');`,
    );
    insertRuleBoundReservation({ store, id: 'work-a', ruleId: 'rule-e4-a', ruleVersion: 1 });
    insertRuleBoundReservation({ store, id: 'work-b', ruleId: 'rule-e4-b', ruleVersion: 1 });

    await applyDerivedTightening({
      database: store.database,
      parent,
      child,
      now: NOW,
      decryptPoint: async () => ({ historyId: '1' }),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    });

    assertLiveRuleB(store, 'retention tightening');
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
