import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { SlackHistorySource, slackConversationScope } from '../src/sources/slack.ts';
import { SlackReplyDrains } from '../src/sources/slack-replies.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'acc_SLACKEVENT00001';
const CONVERSATION = 'C-fenced';

const encryptState = async (value: unknown): Promise<Uint8Array> => Buffer.from(JSON.stringify(value));
const decryptState = async (record: Uint8Array): Promise<unknown> => JSON.parse(Buffer.from(record).toString('utf8'));

async function deferred<T>(): Promise<{
  readonly promise: Promise<T>;
  resolve(value: T): void;
}> {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((settle) => {
      resolve = settle;
    }),
    resolve,
  };
}

test('D4: a Slack page returned after disable or pause writes neither a stage nor a watermark', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database
      .prepare('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1 WHERE singleton = 1')
      .run();
    const first = await deferred<{
      messages: readonly { ts: string; threadTs: null; replyCount: number; text: string }[];
      nextCursor: null;
      retainedHistoryBoundary: false;
    }>();
    const firstStarted = await deferred<void>();
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        history: async () => {
          firstStarted.resolve();
          return first.promise;
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId: 'rule-slack', ruleVersion: 1, ingestRetentionMs: 500 }],
      admit: async () => 'terminal',
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 100,
    });

    const scanning = worker.scan({ conversationId: CONVERSATION, latest: '1700000010.000000', maxPages: 1 });
    await firstStarted.promise;
    store.database.prepare('UPDATE event_settings SET enabled = 0, switch_generation = 2 WHERE singleton = 1').run();
    first.resolve({
      messages: [
        {
          ts: '1700000001.000001',
          threadTs: null,
          replyCount: 0,
          text: '<untrusted-content boundary="test">\nlate page\n</untrusted-content boundary="test">',
        },
      ],
      nextCursor: null,
      retainedHistoryBoundary: false,
    });
    assert.deepEqual(await scanning, { watermark: '1700000000.000000', pending: true });
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE source = 'slack' AND staged_at IS NOT NULL").get(),
      undefined,
    );

    store.database
      .prepare('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 3 WHERE singleton = 1')
      .run();
    const paused = await deferred<{
      messages: readonly { ts: string; threadTs: null; replyCount: number; text: string }[];
      nextCursor: null;
      retainedHistoryBoundary: false;
    }>();
    const pausedStarted = await deferred<void>();
    const second = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        history: async () => {
          pausedStarted.resolve();
          return paused.promise;
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId: 'rule-slack', ruleVersion: 1, ingestRetentionMs: 500 }],
      admit: async () => 'terminal',
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 100,
    });
    const waiting = second.scan({ conversationId: CONVERSATION, latest: '1700000010.000000', maxPages: 1 });
    await pausedStarted.promise;
    store.database.prepare('UPDATE event_settings SET paused = 1 WHERE singleton = 1').run();
    paused.resolve({
      messages: [
        {
          ts: '1700000002.000002',
          threadTs: null,
          replyCount: 0,
          text: '<untrusted-content boundary="test">\npaused page\n</untrusted-content boundary="test">',
        },
      ],
      nextCursor: null,
      retainedHistoryBoundary: false,
    });
    assert.deepEqual(await waiting, { watermark: '1700000000.000000', pending: true });
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE source = 'slack' AND staged_at IS NOT NULL").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: a Slack reply page returned after the source fence moves cannot advance its saved cursor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-reply-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES ('intent-reply-fence', 'replace', '{}', 'digest', 'exact', '[]', '[]', 'pending-completion', 0, 0)`,
      )
      .run();
    store.database.prepare('UPDATE event_settings SET enabled = 1, paused = 0 WHERE singleton = 1').run();
    const page = await deferred<{ messages: []; nextCursor: string | null; retainedHistoryBoundary: false }>();
    const started = await deferred<void>();
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        async replies() {
          started.resolve();
          return page.promise;
        },
      },
      assertLive: () => {
        const settings = store.database
          .prepare('SELECT enabled, paused FROM event_settings WHERE singleton = 1')
          .get() as { enabled: number; paused: number };
        if (settings.enabled !== 1 || settings.paused !== 0) throw new CommsError('APPROVAL_VOID', 'stale reply write');
      },
      encryptState,
      decryptState,
      now: () => 100,
      nowTimestamp: () => '1700000010.000000',
      stage: {
        scope: { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:${CONVERSATION}` },
        debts: () => [{ ruleId: 'rule-test', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      },
    });
    await drains.begin({
      intentId: 'intent-reply-fence',
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      through: '1700000010.000000',
    });
    await drains.discoverParent({
      intentId: 'intent-reply-fence',
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
      parentTs: '1700000001.000001',
    });
    const resuming = drains.resumeOne({
      intentId: 'intent-reply-fence',
      accountId: ACCOUNT,
      conversationId: CONVERSATION,
    });
    await started.promise;
    store.database.prepare('UPDATE event_settings SET enabled = 0 WHERE singleton = 1').run();
    page.resolve({ messages: [], nextCursor: null, retainedHistoryBoundary: false });
    await assert.rejects(resuming, { code: 'APPROVAL_VOID' });
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT cursor, drained_at FROM slack_reply_drains WHERE intent_id = 'intent-reply-fence' AND account_id = ?",
          )
          .get(ACCOUNT) as Record<string, unknown>),
      },
      { cursor: null, drained_at: null },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
