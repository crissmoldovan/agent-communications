import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import {
  isSlackReplyEligible,
  SlackReplyDrains,
  SlackReplyReconciler,
  SlackReplyStageExpiry,
} from '../src/sources/slack-replies.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'acc_SLACKEVENT00001';
const CONVERSATION = 'C-events';
const INTENT = 'intent-slack-drain';

const encryptState = async (value: unknown): Promise<Uint8Array> => Buffer.from(JSON.stringify(value));
const decryptState = async (record: Uint8Array): Promise<unknown> => JSON.parse(Buffer.from(record).toString('utf8'));

test('D4: a reply parent is eligible only when top-level history observed it within seven days and no reply becomes new', () => {
  assert.equal(isSlackReplyEligible('1700000001.000001', '1700000010.000000', '1700604801.000001'), true);
  assert.equal(isSlackReplyEligible('1700000001.000001', '1700000010.000000', '1700604801.000002'), false);
  assert.equal(isSlackReplyEligible('1700000011.000001', '1700000010.000000', '1700000012.000001'), false);
});

test('D4: Slack replacement completion waits for top-level coverage and every frozen reply drain', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-replies-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES (?, 'replace', '{}', 'digest', 'exact', '[]', '[]', 'pending-completion', 0, 0)`,
      )
      .run(INTENT);
    const calls: Array<string | undefined> = [];
    const admitted: Array<{ ts: string; stageId: string }> = [];
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        async replies(input) {
          calls.push(input.cursor);
          return input.cursor === undefined
            ? {
                messages: [
                  {
                    ts: input.parentTs,
                    threadTs: null,
                    replyCount: 2,
                    text: '<untrusted-content>parent</untrusted-content>',
                  },
                ],
                nextCursor: 'reply-page-2',
                retainedHistoryBoundary: false,
              }
            : {
                messages: [
                  {
                    ts: '1700000002.000002',
                    threadTs: input.parentTs,
                    replyCount: 0,
                    text: '<untrusted-content>reply</untrusted-content>',
                  },
                ],
                nextCursor: null,
                retainedHistoryBoundary: false,
              };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 100,
      nowTimestamp: () => '1700000010.000000',
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-old', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async ({ candidate, stageId }) => {
          assert.ok(
            store.database
              .prepare('SELECT 1 FROM source_scan_state WHERE id = ? AND staged_at IS NOT NULL')
              .get(stageId),
            'each reply reaches admission from a durable source stage',
          );
          admitted.push({ ts: candidate.message.ts, stageId });
          return 'terminal';
        },
      },
    });
    await drains.begin({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      through: '1700000010.000000',
    });
    await drains.discoverParent({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000001',
    });
    assert.equal(await drains.complete({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    await drains.topLevelCovered({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION });
    assert.equal(await drains.complete({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT cursor, covered_through, drained_at FROM slack_reply_drains WHERE intent_id = ?')
          .get(INTENT) as Record<string, unknown>),
      },
      { cursor: 'reply-page-2', covered_through: '1700000001.000001', drained_at: null },
      'a partial page advances only its opaque cursor; it cannot certify P',
    );
    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    assert.equal(await drains.complete({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    assert.deepEqual(calls, [undefined, 'reply-page-2']);
    assert.deepEqual(
      admitted.map(({ ts }) => ts),
      ['1700000002.000002'],
    );
    assert.equal(
      (
        store.database.prepare('SELECT covered_through FROM slack_reply_drains WHERE intent_id = ?').get(INTENT) as {
          covered_through: string;
        }
      ).covered_through,
      '1700000010.000000',
      'only the terminal staged page advances the parent coverage to the frozen P bound',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: a paginated reply drain yields one parent to another and resumes its saved cursor after restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reply-fair-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES (?, 'replace', '{}', 'digest-fair', 'exact', '[]', '[]', 'pending-completion', 0, 0)`,
      )
      .run(INTENT);
    const calls: Array<{ parent: string; cursor: string | undefined }> = [];
    const source = {
      async replies(input: { parentTs: string; cursor?: string | undefined }) {
        calls.push({ parent: input.parentTs, cursor: input.cursor });
        if (input.parentTs === '1700000001.000001' && input.cursor === undefined)
          return { messages: [], nextCursor: 'p1-next', retainedHistoryBoundary: false };
        return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
      },
    };
    const options = {
      database: store.database,
      source,
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 100,
      nowTimestamp: () => '1700000010.000000',
      stage: {
        scope: { source: 'slack' as const, accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-test', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal' as const,
      },
    };
    const first = new SlackReplyDrains(options);
    await first.begin({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      through: '1700000010.000000',
    });
    await first.discoverParent({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000001',
    });
    await first.discoverParent({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000002.000002',
    });
    assert.equal(await first.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.equal(await first.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    const restarted = new SlackReplyDrains(options);
    assert.equal(
      await restarted.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }),
      true,
    );
    assert.deepEqual(calls, [
      { parent: '1700000001.000001', cursor: undefined },
      { parent: '1700000002.000002', cursor: undefined },
      { parent: '1700000001.000001', cursor: 'p1-next' },
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a replacement reply cursor and coverage wait for the staged reply to become terminal', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reply-pending-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES (?, 'replace', '{}', 'digest-pending', 'exact', '[]', '[]', 'pending-completion', 0, 0)`,
      )
      .run(INTENT);
    let attempts = 0;
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        async replies(input) {
          return {
            messages: [
              {
                ts: '1700000002.000000',
                threadTs: input.parentTs,
                replyCount: 0,
                text: '<untrusted-content>pending reply</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 100,
      nowTimestamp: () => '1700000010.000000',
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-old', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => (++attempts === 1 ? 'pending' : 'terminal'),
      },
    });
    await drains.begin({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      through: '1700000010.000000',
    });
    await drains.discoverParent({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000000',
    });
    await drains.topLevelCovered({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION });

    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT cursor, covered_through, drained_at FROM slack_reply_drains WHERE intent_id = ?')
          .get(INTENT) as Record<string, unknown>),
      },
      { cursor: null, covered_through: '1700000001.000000', drained_at: null },
      'a pending staged reply cannot move its reply cursor or certify its parent through P',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT COUNT(*) AS count FROM source_scan_state WHERE id LIKE 'slack-reply-page:%'")
          .get() as {
          count: number;
        }),
      },
      { count: 1 },
      'the unfinished reply remains durable for the next owner turn',
    );
    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    assert.equal(attempts, 2, 'the same staged candidate is retried, not skipped by an early cursor update');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a retained-history reply boundary never certifies a replacement drain through P', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reply-boundary-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES (?, 'replace', '{}', 'digest-boundary', 'exact', '[]', '[]', 'pending-completion', 0, 0)`,
      )
      .run(INTENT);
    let calls = 0;
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        async replies(input) {
          calls += 1;
          return {
            messages: [
              {
                ts: '1700000002.000000',
                threadTs: input.parentTs,
                replyCount: 0,
                text: '<untrusted-content>reply before retained boundary</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: true,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 100,
      nowTimestamp: () => '1700000010.000000',
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-old', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      },
    });
    await drains.begin({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      through: '1700000010.000000',
    });
    await drains.discoverParent({
      intentId: INTENT,
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000000',
    });
    await drains.topLevelCovered({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION });

    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
    assert.equal(calls, 1, 'the known incomplete boundary stays durable instead of re-reading and pretending coverage');
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT cursor, covered_through, drained_at FROM slack_reply_drains WHERE intent_id = ?')
          .get(INTENT) as Record<string, unknown>),
      },
      { cursor: null, covered_through: '1700000001.000000', drained_at: null },
    );
    assert.equal(await drains.complete({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), false);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: ordinary reply pagination persists its cursor across restart and a 429 without loss or duplication', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reconcile-restart-');
  let store = await openEventDatabase({ stateDir });
  try {
    const calls: Array<string | undefined> = [];
    const admitted: string[] = [];
    let rateLimited = true;
    const source = {
      async replies(input: { parentTs: string; cursor?: string | undefined }) {
        calls.push(input.cursor);
        if (input.cursor === 'reply-page-2' && rateLimited) {
          rateLimited = false;
          throw new CommsError('TRANSIENT', 'Slack is rate-limiting this workspace', {
            details: { retryAfterSeconds: 60 },
          });
        }
        if (input.cursor === undefined)
          return {
            messages: [
              {
                ts: '1700000002.000002',
                threadTs: input.parentTs,
                replyCount: 0,
                text: '<untrusted-content>first reply</untrusted-content>',
              },
            ],
            nextCursor: 'reply-page-2',
            retainedHistoryBoundary: false,
          };
        return {
          messages: [
            {
              ts: '1700000003.000003',
              threadTs: input.parentTs,
              replyCount: 0,
              text: '<untrusted-content>second reply</untrusted-content>',
            },
          ],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
    };
    const options = {
      source,
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 1_700_000_010_000,
      stage: {
        scope: { source: 'slack' as const, accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-active', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async ({ candidate }: { candidate: { message: { ts: string } } }) => {
          admitted.push(candidate.message.ts);
          return 'terminal' as const;
        },
      },
    };
    const reconciler = () => new SlackReplyReconciler({ ...options, database: store.database });
    const first = reconciler();
    await first.discoverParent({ accountId: ACCOUNT, conversationId: CONVERSATION, parentTs: '1700000001.000001' });
    assert.equal(
      await first.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000010.000000' }),
      false,
      'the owner budget ends after one persisted reply page',
    );
    store.close();
    store = await openEventDatabase({ stateDir });
    const resumed = reconciler();
    await assert.rejects(
      resumed.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '9999999999.999999' }),
      { code: 'TRANSIENT' },
      'a 429 leaves the exact reply cursor for the next owner turn',
    );
    const after429 = reconciler();
    assert.equal(
      await after429.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '9999999999.999999' }),
      true,
    );
    assert.deepEqual(calls, [undefined, 'reply-page-2', 'reply-page-2']);
    assert.deepEqual(admitted, ['1700000002.000002', '1700000003.000003']);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a reply staged before the seven-day boundary finishes without another old-thread provider read', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reconcile-staged-age-');
  const store = await openEventDatabase({ stateDir });
  try {
    const now = { value: 1_700_000_000_000 };
    let reads = 0;
    let attempts = 0;
    const reconciler = new SlackReplyReconciler({
      database: store.database,
      source: {
        async replies(input) {
          reads += 1;
          return {
            messages: [
              {
                ts: '1700000002.000000',
                threadTs: input.parentTs,
                replyCount: 0,
                text: '<untrusted-content>staged before expiry</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => now.value,
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-active', ruleVersion: 1, ingestRetentionMs: 14 * 24 * 60 * 60 * 1_000 }],
        admit: async () => (++attempts === 1 ? 'pending' : 'terminal'),
      },
    });
    await reconciler.discoverParent({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000000',
    });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000010.000000' }),
      false,
    );
    now.value += 7 * 24 * 60 * 60 * 1_000 + 1;
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700604810.000000' }),
      true,
    );
    assert.equal(reads, 1, 'the terminal retry resumes its durable stage instead of polling the old parent again');
    assert.equal(attempts, 2, 'the reply observed while the parent was eligible is not discarded at the boundary');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: an ordinary retained-history reply boundary holds its watermark without re-polling', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reconcile-boundary-');
  const store = await openEventDatabase({ stateDir });
  try {
    let calls = 0;
    const reconciler = new SlackReplyReconciler({
      database: store.database,
      source: {
        async replies(input) {
          calls += 1;
          return {
            messages: [
              {
                ts: '1700000002.000000',
                threadTs: input.parentTs,
                replyCount: 0,
                text: '<untrusted-content>ordinary retained boundary</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: true,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 1_700_000_000_000,
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-active', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      },
    });
    await reconciler.discoverParent({
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000000',
    });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000010.000000' }),
      false,
    );
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000011.000000' }),
      false,
    );
    assert.equal(calls, 1);
    const state = store.database
      .prepare("SELECT encrypted_record FROM source_scan_state WHERE id LIKE 'slack-reply-reconciliation:%'")
      .get() as { encrypted_record: Uint8Array };
    const record = (await decryptState(state.encrypted_record)) as { watermark: string; latest: string | null };
    assert.equal(record.watermark, '1700000001.000000');
    assert.equal(record.latest, '1700000010.000000');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: an ordinary retained boundary yields its turn and expires after its staged page is swept', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reconcile-boundary-fairness-');
  const store = await openEventDatabase({ stateDir });
  try {
    const now = { value: 1_700_000_000_000 };
    const parentA = '1700000001.000000';
    const parentB = '1700000002.000000';
    let aReads = 0;
    let bReads = 0;
    const reconciler = new SlackReplyReconciler({
      database: store.database,
      source: {
        async replies(input) {
          if (input.parentTs === parentA) {
            aReads += 1;
            return {
              messages: [
                {
                  ts: '1700000006.000000',
                  threadTs: parentA,
                  replyCount: 0,
                  text: '<untrusted-content>retained boundary</untrusted-content>',
                },
              ],
              nextCursor: null,
              retainedHistoryBoundary: true,
            };
          }
          bReads += 1;
          return {
            messages: [
              {
                ts: bReads === 1 ? '1700000005.000000' : bReads === 2 ? '1700000015.000000' : '1700000025.000000',
                threadTs: parentB,
                replyCount: 0,
                text: '<untrusted-content>other parent reply</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => now.value,
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-active', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      },
    });
    await reconciler.discoverParent({ accountId: ACCOUNT, conversationId: CONVERSATION, parentTs: parentB });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000010.000000' }),
      true,
      'B completes its initial reply scan',
    );
    await reconciler.discoverParent({ accountId: ACCOUNT, conversationId: CONVERSATION, parentTs: parentA });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000020.000000' }),
      false,
      'A retains its boundary without treating it as covered',
    );
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000020.000000' }),
      true,
      'the next owner pass gives B its own reply turn',
    );
    assert.equal(bReads, 2, 'B is read again after A retained its boundary');

    now.value += 1_001;
    const expiry = new SlackReplyStageExpiry({
      database: store.database,
      lock: new SourceScopeLock(),
      decrypt: decryptState,
      encrypt: encryptState,
      now: () => now.value,
    });
    assert.equal(await expiry.sweep(), 1, 'the boundary page reaches its retention deadline');
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000030.000000' }),
      false,
      'A keeps its expired retained boundary unresolved before its eligibility ends',
    );
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000030.000000' }),
      true,
      'the expired retained-boundary continuation yields its turn to B',
    );
    assert.equal(bReads, 3, 'B remains fair after A resumes its expired boundary marker');

    now.value += 8 * 24 * 60 * 60 * 1_000;
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700700000.000000' }),
      true,
      'the seven-day ordinary-reconciliation cutoff drops the retained-boundary parent',
    );
    const states = store.database
      .prepare("SELECT encrypted_record FROM source_scan_state WHERE id LIKE 'slack-reply-reconciliation:%'")
      .all() as Array<{ encrypted_record: Uint8Array }>;
    assert.equal(
      (await Promise.all(states.map(async (state) => decryptState(state.encrypted_record)))).some(
        (state) => (state as { parentTs: string }).parentTs === parentA,
      ),
      false,
      'A is no longer retained after its boundary stage expires',
    );
    assert.equal(aReads, 1, 'expiry never retries the retained boundary from Slack');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a pending ordinary reply page yields its turn to another eligible parent', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reconcile-pending-fairness-');
  const store = await openEventDatabase({ stateDir });
  try {
    const parentA = '1700000001.000000';
    const parentB = '1700000002.000000';
    let bReads = 0;
    const admitted: string[] = [];
    const reconciler = new SlackReplyReconciler({
      database: store.database,
      source: {
        async replies(input) {
          if (input.parentTs === parentA)
            return {
              messages: [
                {
                  ts: '1700000006.000000',
                  threadTs: parentA,
                  replyCount: 0,
                  text: '<untrusted-content>pending reply</untrusted-content>',
                },
              ],
              nextCursor: null,
              retainedHistoryBoundary: false,
            };
          bReads += 1;
          return {
            messages: [
              {
                ts: bReads === 1 ? '1700000005.000000' : '1700000015.000000',
                threadTs: parentB,
                replyCount: 0,
                text: '<untrusted-content>other parent reply</untrusted-content>',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      assertLive: () => undefined,
      encryptState,
      decryptState,
      now: () => 1_700_000_000_000,
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-active', ruleVersion: 1, ingestRetentionMs: 7 * 24 * 60 * 60 * 1_000 }],
        admit: async ({ candidate }) => {
          if (candidate.message.threadTs === parentA) return 'pending';
          admitted.push(candidate.message.ts);
          return 'terminal';
        },
      },
    });
    await reconciler.discoverParent({ accountId: ACCOUNT, conversationId: CONVERSATION, parentTs: parentB });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000010.000000' }),
      true,
      'B completes its initial reply scan',
    );
    await reconciler.discoverParent({ accountId: ACCOUNT, conversationId: CONVERSATION, parentTs: parentA });
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000020.000000' }),
      false,
      'A keeps its disclosure-fenced page durable',
    );
    assert.equal(
      await reconciler.resumeOne({ accountId: ACCOUNT, conversationId: CONVERSATION, latest: '1700000020.000000' }),
      true,
      'the next owner pass reads and stages B while A is still pending',
    );
    assert.equal(bReads, 2, 'B is read again rather than A monopolising owner turns');
    assert.deepEqual(admitted, ['1700000005.000000', '1700000015.000000']);
    assert.equal(
      (
        store.database
          .prepare("SELECT COUNT(*) AS count FROM source_scan_state WHERE id LIKE 'slack-reply-page:%'")
          .get() as {
          count: number;
        }
      ).count,
      1,
      'A remains staged for a later terminal admission',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
