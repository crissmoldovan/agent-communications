import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { beginJudgeTransport, reserveJudgeWork, settleJudgeWork } from '../src/runtime/judge-budget.ts';
import { recoverJudgeWork } from '../src/runtime/judge-recovery.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { JUDGE_CRASH_POINTS, type JudgeCrashPoint } from './fixtures/judges/crash-recovery/points.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const NOW = 1_800_000_000_000;
const ACCOUNT = 'ibx_E5CRASHAAAAAAA';
const target = { targetId: 'target-e5-crash', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const judge = {
  judgeId: 'judge-e5-crash',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe' as const,
  model: 'jev-1.13.0' as const,
  endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};
const limits = { callsPerRollingHour: 20, inputTokensPerRolling30Days: 100_000, concurrency: 2, maxInputTokens: 512 };
const budgetLimits = { callsPerRollingHour: 20, inputTokensPerRolling30Days: 100_000, concurrency: 2 };

function rule() {
  return {
    ruleId: 'rule-e5-crash',
    version: 1,
    source: {
      channel: 'gmail' as const,
      accountIds: [ACCOUNT],
      options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    agentic: {
      judge,
      question: 'E5 crash fixture',
      inputs: ['/subject'],
      threshold: 0.5,
      onUncertain: 'no-match' as const,
      ...limits,
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

async function fixture() {
  const root = await shortTempDir('events-e5-crash-');
  const store = await openEventDatabase({ stateDir: root });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeBudget({
    budgetId: 'judge-budget',
    version: 1,
    global: budgetLimits,
    providers: [{ provider: 'typesafe', ...budgetLimits }],
  });
  versions.createRule(rule());
  store.database.exec(`INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES
    ('judge-budget', 'judge-budget', 1, 'judge-budget@1', 1), ('judge-kind', 'typesafe', 1, 'judge-kind:typesafe@1', 1);
    INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
    VALUES ('event-e5-crash', '${store.installationId}', 'gmail.message.received', 1, '${ACCOUNT}', 'e5-crash', ${NOW}, ${NOW}, ${NOW});
    INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
    VALUES ('event-e5-crash', 'rule-e5-crash', 1, ${NOW + 60_000}, X'01');`);
  return { root, store };
}

function reserve(setup: Awaited<ReturnType<typeof fixture>>, id: string) {
  return reserveJudgeWork({
    store: setup.store,
    id,
    workId: `work:${id}`,
    scope: {
      scope: 'source-owned' as const,
      source: 'gmail' as const,
      accountId: ACCOUNT,
      eventId: 'event-e5-crash',
      ruleId: 'rule-e5-crash',
      ruleVersion: 1,
      judgeId: judge.judgeId,
      judgeVersion: judge.version,
    },
    judge,
    limits,
    finalEnvelope: Buffer.from('e5-crash'),
    switchGeneration: 0,
    now: NOW,
  });
}

function crashesBeforeTransport(point: JudgeCrashPoint): boolean {
  return point === 'after-reserve' || point === 'before-transport';
}

test('E5 crash: every named interruption leaves either a pre-I/O release or one post-I/O pessimistic terminalisation', {
  skip: WINDOWS_SKIP,
}, async (context) => {
  for (const point of JUDGE_CRASH_POINTS) {
    await context.test(point, async () => {
      const setup = await fixture();
      try {
        reserve(setup, `crash:${point}`);
        if (!crashesBeforeTransport(point)) {
          beginJudgeTransport({ store: setup.store, reservationId: `crash:${point}`, now: NOW });
          assert.throws(
            () =>
              settleJudgeWork({
                store: setup.store,
                reservationId: `crash:${point}`,
                result: 'unknown',
                now: NOW,
                testFailpoint: (current) =>
                  current === point &&
                  (() => {
                    throw new Error(`crash:${point}`);
                  })(),
              }),
            new RegExp(`crash:${point}`),
          );
        }
        setup.store.close();
        const restarted = await openEventDatabase({ stateDir: setup.root });
        try {
          const first = restarted.immediate(() => recoverJudgeWork({ database: restarted.database, now: NOW + 1 }));
          const second = restarted.immediate(() => recoverJudgeWork({ database: restarted.database, now: NOW + 2 }));
          assert.equal(second.released + second.settled, 0, 'recovery is idempotent');
          const row = restarted.database
            .prepare('SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = ?')
            .get(`crash:${point}`) as { state: string; concurrency_owned: number };
          if (crashesBeforeTransport(point)) {
            assert.deepEqual(
              { first, row: { ...row } },
              { first: { released: 1, settled: 0 }, row: { state: 'released', concurrency_owned: 0 } },
            );
            assert.equal(
              (restarted.database.prepare('SELECT COUNT(*) AS count FROM decisions').get() as { count: number }).count,
              0,
            );
          } else {
            assert.deepEqual(
              { first, row: { ...row } },
              { first: { released: 0, settled: 1 }, row: { state: 'settled', concurrency_owned: 0 } },
            );
            assert.deepEqual(
              { ...(restarted.database.prepare('SELECT outcome, metadata_state FROM decisions').get() as object) },
              { outcome: 'no-match', metadata_state: 'judge-io-unknown' },
            );
            assert.equal(
              (restarted.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number })
                .count,
              0,
            );
          }
        } finally {
          restarted.close();
        }
      } finally {
        try {
          setup.store.close();
        } catch {
          /* restart closed the original handle */
        }
        await rm(setup.root, { recursive: true, force: true });
      }
    });
  }
});

test('E5 crash: a late result cannot settle a recovery-terminalised work item or restore its projection', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    reserve(setup, 'late-result');
    beginJudgeTransport({ store: setup.store, reservationId: 'late-result', now: NOW });
    setup.store.immediate(() => recoverJudgeWork({ database: setup.store.database, now: NOW + 1 }));
    assert.equal(
      settleJudgeWork({
        store: setup.store,
        reservationId: 'late-result',
        result: 'completed',
        actualInputTokens: 1,
        now: NOW + 2,
      }),
      false,
    );
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E5 crash: owner startup does not issue a judge-ledger statement before the B3 gate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const statements: Array<{ readonly phase: 'setup' | 'owner-start'; readonly statement: string }> = [];
  const prototype = DatabaseSync.prototype;
  const prepare = prototype.prepare;
  const exec = prototype.exec;
  let phase: 'setup' | 'owner-start' = 'setup';
  prototype.prepare = function (this: DatabaseSync, statement: string) {
    statements.push({ phase, statement });
    return prepare.call(this, statement);
  };
  prototype.exec = function (this: DatabaseSync, statement: string) {
    statements.push({ phase, statement });
    return exec.call(this, statement);
  };
  let setup: Awaited<ReturnType<typeof fixture>> | undefined;
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    setup = await fixture();
    reserve(setup, 'owner-recovery');
    beginJudgeTransport({ store: setup.store, reservationId: 'owner-recovery', now: NOW });
    setup.store.close();
    phase = 'owner-start';
    try {
      owner = await startEventOwner({
        stateDir: setup.root,
        tickMs: 60_000,
        now: () => NOW + 1,
      });
    } catch (error) {
      if (!(error instanceof Error) || !/EPERM/u.test(error.message)) throw error;
    }
    phase = 'setup';
    const reopened = await openEventDatabase({ stateDir: setup.root });
    try {
      assert.deepEqual(
        {
          ...(reopened.database
            .prepare("SELECT state, concurrency_owned FROM judge_budget_reservations WHERE id = 'owner-recovery'")
            .get() as object),
        },
        { state: 'in-flight', concurrency_owned: 1 },
      );
    } finally {
      reopened.close();
    }
    assert.deepEqual(
      statements
        .filter(({ phase: recordedPhase }) => recordedPhase === 'owner-start')
        .map(({ statement }) => statement)
        .filter((statement) => /judge_budget_reservations|judge_test_charges|judge-recovery/iu.test(statement)),
      [],
      'the complete open/migration/start sequence is inert for Task 5 ledger/recovery SQL until Task 7 wires recovery after B3',
    );
  } finally {
    await owner?.stop();
    prototype.prepare = prepare;
    prototype.exec = exec;
    try {
      setup?.store.close();
    } catch {
      /* owner/restart may have closed it */
    }
    if (setup !== undefined) await rm(setup.root, { recursive: true, force: true });
  }
});
