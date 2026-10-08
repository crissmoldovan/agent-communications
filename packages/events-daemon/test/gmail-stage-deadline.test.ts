import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('STG-B1: a durable Gmail stage expires at its original deadline after downtime and only then advances the cursor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-stage-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let now = 1_760_000_000_000;
      const source = {
        async listHistory() {
          return {
            historyId: '101',
            nextPageToken: undefined,
            history: [
              {
                id: '101',
                messagesAdded: [{ message: { id: 'message', threadId: 'thread' } }],
                labelsAdded: [],
                labelsRemoved: [],
              },
            ],
          };
        },
        async getMessageMetadata() {
          return {
            id: 'message',
            threadId: 'thread',
            labelIds: ['INBOX'],
            snippet: 'fixture',
            internalDate: String(now),
            payload: { headers: [{ name: 'Subject', value: 'Subject' }] },
          };
        },
      };
      const options = {
        store,
        source,
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: new MailboxLock(),
        rules: () => [
          {
            ruleId: 'rule-1',
            ruleVersion: 1,
            eventType: 'gmail.message.received' as const,
            options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
            ingestRetentionMs: 100,
          },
        ],
        assertDisclosable: async () => undefined,
        encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => now,
      };
      const first = new GmailSourceWorker({ ...options, admit: async () => 'pending' as const });
      assert.deepEqual(await first.scan(), { cursor: '100', pending: true });
      const staged = store.database.prepare('SELECT staged_at, stage_expires_at FROM source_scan_state').get() as {
        staged_at: number;
        stage_expires_at: number;
      };
      assert.equal(staged.staged_at, now);
      assert.equal(staged.stage_expires_at, now + 100);

      now += 100;
      const restarted = new GmailSourceWorker({ ...options, admit: async () => 'terminal' as const });
      assert.deepEqual(await restarted.scan(), { cursor: '101', pending: false });
      assert.equal(
        (
          store.database.prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'gmail'").get() as {
            outcome: string;
          }
        ).outcome,
        'retention-expired',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
