import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { isSlackReplyEligible, SlackReplyDrains } from '../src/sources/slack-replies.ts';
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
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        async replies(input) {
          calls.push(input.cursor);
          return input.cursor === undefined
            ? {
                messages: [{ ts: input.parentTs, threadTs: null, replyCount: 2, text: 'parent' }],
                nextCursor: 'reply-page-2',
                retainedHistoryBoundary: false,
              }
            : {
                messages: [{ ts: '1700000002.000002', threadTs: input.parentTs, replyCount: 0, text: 'reply' }],
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
    assert.equal(await drains.resumeOne({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    assert.equal(await drains.complete({ intentId: INTENT, accountId: ACCOUNT, conversationId: CONVERSATION }), true);
    assert.deepEqual(calls, [undefined, 'reply-page-2']);
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
        if (input.parentTs === '1700000001.000001' && input.cursor === undefined) return { nextCursor: 'p1-next' };
        return { nextCursor: null };
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
