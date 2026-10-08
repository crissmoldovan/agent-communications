import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { persistGmailBaseline } from '../src/runtime/baseline.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('APR-B1: a replacement baseline, page stage, and cursor commit share the same mailbox lock ordering', async () => {
  const lock = new MailboxLock();
  const order: string[] = [];
  let releaseStage!: () => void;
  const staged = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });

  const page = lock.withMailbox('ibx_ABCDEFGHIJKLMNOP', async () => {
    order.push('stage');
    await staged;
    order.push('cursor');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const replacementBaseline = lock.withMailbox('ibx_ABCDEFGHIJKLMNOP', async () => {
    order.push('replacement-P');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['stage'], 'P cannot be sampled inside a staged page/cursor critical section');

  releaseStage();
  await Promise.all([page, replacementBaseline]);
  assert.deepEqual(order, ['stage', 'cursor', 'replacement-P']);
});

test('APR-B1: the real Gmail stage and final cursor boundary keep a replacement P outside both deterministic interleavings', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-replacement-race-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'ibx_ABCDEFGHIJKLMNOP';
    const lock = new MailboxLock();
    for (const boundary of ['stage', 'cursor'] as const) {
      store.database.exec('DELETE FROM source_scan_state; DELETE FROM cursors');
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 0)",
        )
        .run(accountId);
      const order: string[] = [];
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let reached!: () => void;
      const atBoundary = new Promise<void>((resolve) => {
        reached = resolve;
      });
      const worker = new GmailSourceWorker({
        store,
        source: {
          async listHistory() {
            return {
              historyId: '101',
              nextPageToken: undefined,
              history: [
                {
                  id: '101',
                  messagesAdded: [{ message: { id: `message-${boundary}`, threadId: 'thread' } }],
                  labelsAdded: [],
                  labelsRemoved: [],
                },
              ],
            };
          },
          async getMessageMetadata(messageId: string) {
            return {
              id: messageId,
              threadId: 'thread',
              labelIds: ['INBOX'],
              internalDate: '1760000000000',
              payload: { headers: [{ name: 'Subject', value: 'subject' }] },
            };
          },
        },
        mailbox: { accountId, name: 'Events inbox' },
        mailboxLock: lock,
        rules: () => [
          {
            ruleId: 'rule-race',
            ruleVersion: 1,
            eventType: 'gmail.message.received',
            options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
            ingestRetentionMs: 60_000,
          },
        ],
        assertDisclosable: async () => undefined,
        admit: async () => 'terminal',
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
        onPageStaged:
          boundary === 'stage'
            ? async () => {
                order.push('stage');
                reached();
                await blocked;
              }
            : undefined,
        beforeCursorCommit:
          boundary === 'cursor'
            ? async () => {
                order.push('cursor');
                reached();
                await blocked;
              }
            : () => {
                order.push('cursor');
              },
      });
      const scan = worker.scan();
      await atBoundary;
      const baseline = persistGmailBaseline(
        lock,
        accountId,
        async () => ({
          getProfile: async () => ({
            emailAddress: 'events@example.test',
            messagesTotal: 1,
            threadsTotal: 1,
            historyId: '101',
          }),
        }),
        async () => {
          order.push('replacement-P');
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, [boundary], `P must not enter the page's ${boundary} critical section`);
      release();
      await Promise.all([scan, baseline]);
      assert.deepEqual(
        order,
        boundary === 'stage' ? ['stage', 'cursor', 'replacement-P'] : ['cursor', 'replacement-P'],
      );
      assert.equal(
        (
          store.database
            .prepare(
              "SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'",
            )
            .get(accountId) as { cursor: string }
        ).cursor,
        '101',
      );
    }
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
