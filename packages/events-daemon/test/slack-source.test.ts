import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import {
  compareSlackTimestamp,
  createSlackLocalEventSource,
  SlackHistorySource,
  slackConversationScope,
} from '../src/sources/slack.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'acc_SLACKEVENT00001';
const CONVERSATION = 'C-events';

test('D4: Slack timestamps compare as exact decimals rather than JavaScript numbers', () => {
  assert.equal(compareSlackTimestamp('9007199254740992.000000', '9007199254740993.000000'), -1);
  assert.equal(compareSlackTimestamp('1700000000.001000', '1700000000.000999'), 1);
  assert.throws(() => compareSlackTimestamp('1700000000.1', '1700000000.000001'));
});

test('D4: the Slack adapter exposes only canonical conversation scopes through the shared source lock', async () => {
  const adapter = createSlackLocalEventSource();
  const scopes = adapter.scopesFor({
    accountId: ACCOUNT,
    options: { channel: 'slack', conversations: ['C-alpha', 'C-zeta'] },
  });
  assert.deepEqual(scopes, [
    { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:C-alpha` },
    { source: 'slack', accountId: ACCOUNT, scopeId: `slack:${ACCOUNT}:C-zeta` },
  ]);
  assert.equal(await adapter.baseline(async () => '1700000000.000000'), '1700000000.000000');
});

test('D4: Slack history preserves its frozen interval through a budget cut and advances its watermark only on the final page', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-history-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const calls: Array<{ readonly cursor: string | undefined; readonly latest: string }> = [];
    const admitted: string[] = [];
    const source = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history(input) {
          calls.push({ cursor: input.cursor, latest: input.latest });
          return input.cursor === undefined
            ? {
                messages: [
                  {
                    ts: '1700000001.000001',
                    threadTs: null,
                    replyCount: 1,
                    text: '<untrusted-content boundary="test">\nfirst page\n</untrusted-content boundary="test">',
                  },
                  {
                    ts: '1700000002.000002',
                    threadTs: '1700000001.000001',
                    replyCount: 0,
                    text: '<untrusted-content boundary="test">\nnot top level\n</untrusted-content boundary="test">',
                  },
                ],
                nextCursor: 'page-2',
                retainedHistoryBoundary: false,
              }
            : {
                messages: [
                  {
                    ts: '1700000003.000003',
                    threadTs: null,
                    replyCount: 0,
                    text: '<untrusted-content boundary="test">\nsecond page\n</untrusted-content boundary="test">',
                  },
                ],
                nextCursor: null,
                retainedHistoryBoundary: false,
              };
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId: 'rule-slack', ruleVersion: 1, ingestRetentionMs: 500 }],
      admit: async (candidate) => {
        admitted.push(candidate.message.ts);
        return 'terminal';
      },
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 100,
    });

    assert.deepEqual(await source.scan({ conversationId: CONVERSATION, latest: '1700000010.000000', maxPages: 1 }), {
      watermark: '1700000000.000000',
      pending: true,
    });
    assert.equal(
      (
        store.database
          .prepare("SELECT cursor FROM cursors WHERE source = 'slack' AND account_id = ? AND cursor_scope = ?")
          .get(ACCOUNT, scope.scopeId) as { cursor: string }
      ).cursor,
      '1700000000.000000',
      'a short first page with a cursor cannot move the committed watermark',
    );

    assert.deepEqual(await source.scan({ conversationId: CONVERSATION, latest: '9999999999.999999', maxPages: 1 }), {
      watermark: '1700000010.000000',
      pending: false,
    });
    assert.deepEqual(calls, [
      { cursor: undefined, latest: '1700000010.000000' },
      { cursor: 'page-2', latest: '1700000010.000000' },
    ]);
    assert.deepEqual(admitted, ['1700000001.000001', '1700000003.000003']);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7b/S: the history worker reports every top-level parent and only reports coverage after its terminal cursor write', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-drain-observer-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const observed: string[] = [];
    let covered = 0;
    const source = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history() {
          return {
            messages: [
              {
                ts: '1700000001.000001',
                threadTs: null,
                replyCount: 1,
                text: '<untrusted-content boundary="test">\\nparent\\n</untrusted-content boundary="test">',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId: 'rule-slack-drain', ruleVersion: 1, ingestRetentionMs: 500 }],
      admit: async () => 'terminal',
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      replacementObserver: {
        onTopLevel: async (message) => {
          observed.push(message.ts);
        },
        onHistoryCovered: async () => {
          covered += 1;
        },
      },
      now: () => 100,
    });

    await source.scan({ conversationId: CONVERSATION, latest: '1700000010.000000', maxPages: 1 });
    assert.deepEqual(observed, ['1700000001.000001']);
    assert.equal(covered, 1);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: an invalid Slack cursor restarts the same durable interval without recording a retained-history gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-cursor-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const cursors: Array<string | undefined> = [];
    let attempt = 0;
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history(input) {
          cursors.push(input.cursor);
          attempt += 1;
          if (attempt === 1) {
            return { messages: [], nextCursor: 'bad-cursor', retainedHistoryBoundary: false };
          }
          if (attempt === 2)
            throw Object.assign(new Error('invalid cursor'), { code: 'BAD_DATA', slackError: 'invalid_cursor' });
          return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
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

    await worker.scan({ conversationId: CONVERSATION, latest: '1700000010.000000', maxPages: 1 });
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '1700000099.000000', maxPages: 1 }), {
      watermark: '1700000000.000000',
      pending: true,
    });
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '1700000099.000000', maxPages: 1 }), {
      watermark: '1700000010.000000',
      pending: false,
    });
    assert.deepEqual(cursors, [undefined, 'bad-cursor', undefined]);
    assert.equal(
      store.database.prepare("SELECT 1 FROM operational_records WHERE kind = 'agentcomms.source.gap'").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: a 429 leaves the persisted Slack interval untouched for the next bounded retry', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-429-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const calls: Array<{ latest: string; cursor: string | undefined }> = [];
    let retry = true;
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history(input) {
          calls.push({ latest: input.latest, cursor: input.cursor });
          if (retry) {
            retry = false;
            throw new CommsError('TRANSIENT', 'Slack is rate-limiting this workspace', {
              details: { retryAfterSeconds: 60 },
            });
          }
          return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
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
    await assert.rejects(worker.scan({ conversationId: CONVERSATION, latest: '1700000010.000000' }), {
      code: 'TRANSIENT',
    });
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '9999999999.999999' }), {
      watermark: '1700000010.000000',
      pending: false,
    });
    assert.deepEqual(calls, [
      { latest: '1700000010.000000', cursor: undefined },
      { latest: '1700000010.000000', cursor: undefined },
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: only an explicit retained-history boundary records one Slack gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-gap-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history() {
          return { messages: [], nextCursor: null, retainedHistoryBoundary: true };
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
    await worker.scan({ conversationId: CONVERSATION, latest: '1700000010.000000' });
    assert.equal(
      (
        store.database
          .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
          .get() as { count: number }
      ).count,
      1,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: a stale history page from an earlier scan generation is never resumed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-generation-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    const scanId = `slack-history-scan:${Buffer.from(JSON.stringify([ACCOUNT, CONVERSATION])).toString('base64url')}`;
    const staleId = `slack-history-page:${Buffer.from(JSON.stringify([ACCOUNT, CONVERSATION, 1, null, null])).toString('base64url')}`;
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES (?, 'slack', ?, ?, ?, 0), (?, 'slack', ?, ?, ?, 0)`,
      )
      .run(
        scanId,
        ACCOUNT,
        scope.scopeId,
        Buffer.from(
          JSON.stringify({
            kind: 'slack-history-scan-v1',
            oldest: '1700000000.000000',
            latest: '1700000010.000000',
            cursor: null,
            generation: 2,
          }),
        ),
        staleId,
        ACCOUNT,
        scope.scopeId,
        Buffer.from(
          JSON.stringify({
            kind: 'slack-history-page-v1',
            scanGeneration: 1,
            cursorBefore: null,
            nextCursor: null,
            page: { messages: [], nextCursor: null, retainedHistoryBoundary: false },
            completed: [],
          }),
        ),
      );
    let reads = 0;
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history() {
          reads += 1;
          return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
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
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '9999999999.999999' }), {
      watermark: '1700000010.000000',
      pending: false,
    });
    assert.equal(reads, 1);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4: Slack history keeps Task 4a’s first-stage shortest deadline and resumes content-free after common expiry', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-slack-expiry-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = slackConversationScope(ACCOUNT, CONVERSATION);
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1700000000.000000', 0)",
      )
      .run(ACCOUNT, scope.scopeId);
    store.database.prepare('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1').run();
    let reads = 0;
    const worker = new SlackHistorySource({
      store,
      accountId: ACCOUNT,
      source: {
        async history() {
          reads += 1;
          return {
            messages: [
              {
                ts: '1700000001.000001',
                threadTs: null,
                replyCount: 0,
                text: '<untrusted-content boundary="test">\nexpires\n</untrusted-content boundary="test">',
              },
            ],
            nextCursor: null,
            retainedHistoryBoundary: false,
          };
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [
        { ruleId: 'rule-long', ruleVersion: 1, ingestRetentionMs: 900 },
        { ruleId: 'rule-short', ruleVersion: 1, ingestRetentionMs: 200 },
      ],
      admit: async () => 'pending',
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 100,
    });
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '1700000010.000000' }), {
      watermark: '1700000000.000000',
      pending: true,
    });
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT staged_at, stage_expires_at FROM source_scan_state WHERE source = 'slack' AND staged_at IS NOT NULL",
          )
          .get() as Record<string, unknown>),
      },
      { staged_at: 100, stage_expires_at: 300 },
    );
    assert.equal(new EventExpiry(store, () => 300).sweep().sourceStages, 1);
    store.database.prepare('UPDATE event_settings SET enabled = 0, switch_generation = 2 WHERE singleton = 1').run();
    assert.deepEqual(await worker.scan({ conversationId: CONVERSATION, latest: '9999999999.999999' }), {
      watermark: '1700000010.000000',
      pending: false,
    });
    assert.equal(reads, 1, 'the expired page advances content-free without a new provider read');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
