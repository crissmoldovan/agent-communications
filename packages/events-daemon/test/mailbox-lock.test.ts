import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { persistGmailBaseline } from '../src/runtime/baseline.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('GML-B1: one account mailbox lock keeps a baseline outside a page stage and cursor commit', async () => {
  const lock = new MailboxLock();
  const order: string[] = [];
  let releaseStage: (() => void) | undefined;
  const staged = new Promise<void>((resolve) => {
    releaseStage = resolve;
  });

  const page = lock.withMailbox('account-1', async () => {
    order.push('stage');
    await staged;
    order.push('cursor');
  });
  await new Promise((resolve) => setImmediate(resolve));
  const baseline = lock.withMailbox('account-1', async () => {
    order.push('baseline');
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['stage']);

  releaseStage?.();
  await Promise.all([page, baseline]);
  assert.deepEqual(order, ['stage', 'cursor', 'baseline']);
});

test('GML-B1: the real Gmail page stage, final cursor commit, and baseline capture share one account lock', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-mailbox-lock-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      const lock = new MailboxLock();
      const order: string[] = [];
      let releaseStage: (() => void) | undefined;
      const staged = new Promise<void>((resolve) => {
        releaseStage = resolve;
      });
      const worker = new GmailSourceWorker({
        store,
        source: {
          async listHistory() {
            return {
              historyId: '101',
              nextPageToken: undefined,
              history: [],
            };
          },
          async getMessageMetadata() {
            throw new Error('an empty history page never reads metadata');
          },
        },
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: lock,
        // The scheduler polls only an account some live rule version binds; a page is staged for that version.
        rules: () => [
          {
            ruleId: 'rule-lock',
            ruleVersion: 1,
            eventType: 'gmail.message.received' as const,
            options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
            ingestRetentionMs: 600_000,
          },
        ],
        assertDisclosable: async () => undefined,
        admit: async () => 'terminal' as const,
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        onPageStaged: async () => {
          order.push('stage');
          await staged;
        },
        beforeCursorCommit: () => {
          order.push('cursor');
        },
      });

      const page = worker.scan();
      await new Promise((resolve) => setImmediate(resolve));
      const baseline = persistGmailBaseline(
        lock,
        'ibx_ABCDEFGHIJKLMNOP',
        async () => ({
          getProfile: async () => ({
            emailAddress: 'events@example.test',
            messagesTotal: 0,
            threadsTotal: 0,
            historyId: '200',
          }),
        }),
        () => {
          order.push('baseline');
        },
      );
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(order, ['stage']);

      releaseStage?.();
      await Promise.all([page, baseline]);
      assert.deepEqual(order, ['stage', 'cursor', 'baseline']);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
