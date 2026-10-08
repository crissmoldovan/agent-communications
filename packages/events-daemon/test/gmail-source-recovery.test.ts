import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('GML-B1: restart reads the first durable observedAt sample rather than resampling a staged Gmail occurrence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-recovery-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let now = 1_760_000_000_000;
      let metadataReads = 0;
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
          metadataReads += 1;
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
      const base = {
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
            ingestRetentionMs: 1_000,
          },
        ],
        assertDisclosable: async () => undefined,
        encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => now,
      };
      await new GmailSourceWorker({ ...base, admit: async () => 'pending' as const }).scan();
      now += 500;
      let observedAt = '';
      await new GmailSourceWorker({
        ...base,
        admit: async (occurrence) => {
          observedAt = occurrence.observedAt;
          return 'terminal' as const;
        },
      }).scan();
      assert.equal(observedAt, '2025-10-09T08:53:20.000Z');
      assert.equal(metadataReads, 1, 'the encrypted classified occurrence is reused after restart');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('GML-B1: an expired cursor drains a staged Gmail page before re-baselining the mailbox', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-expired-stage-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let expired = false;
      let metadataReads = 0;
      let admissions = 0;
      const source = {
        async listHistory() {
          if (expired) throw new CommsError('NOT_FOUND', 'the cursor has aged out');
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
          metadataReads += 1;
          return {
            id: 'message',
            threadId: 'thread',
            labelIds: ['INBOX'],
            internalDate: '1760000000000',
            payload: { headers: [{ name: 'Subject', value: 'Subject' }] },
          };
        },
        async getProfile() {
          return { emailAddress: 'events@example.test', messagesTotal: 0, threadsTotal: 0, historyId: '500' };
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
            ingestRetentionMs: 60_000,
          },
        ],
        assertDisclosable: async () => undefined,
        encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
      };

      await new GmailSourceWorker({ ...options, admit: async () => 'pending' as const }).scan();
      expired = true;
      const draining = new GmailSourceWorker({
        ...options,
        admit: async () => {
          admissions += 1;
          return 'terminal' as const;
        },
      });
      // The staged chain is complete, so it drains without asking Gmail again and commits its own cursor; the next
      // scan from that cursor then finds it aged out and re-baselines.
      assert.deepEqual(await draining.scan(), { cursor: '101', pending: false });
      assert.deepEqual(await draining.scan(), { cursor: '500', pending: false });
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as { count: number }
        ).count,
        1,
        'one content-free gap for the aged-out cursor',
      );
      assert.equal(metadataReads, 1, 'the encrypted classified page supplies the terminal drain');
      assert.equal(admissions, 1);
      assert.equal(
        (store.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }).count,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
