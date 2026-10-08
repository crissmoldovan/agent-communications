import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { classifyGmailMessage, occurrencesFromHistory } from '../src/sources/gmail.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('GML-B1: the any-label selector never admits a draft message', () => {
  const result = classifyGmailMessage({ labels: 'any', includeSpamTrash: true }, { labelIds: ['DRAFT', 'INBOX'] });

  assert.deepEqual(result, { eligible: false, reason: 'draft' });
});

test('GML-B1: Gmail observation metadata classifies inbox, explicit labels, and spam-trash independently', () => {
  assert.deepEqual(classifyGmailMessage({ labels: 'inbox', includeSpamTrash: false }, { labelIds: ['INBOX'] }), {
    eligible: true,
  });
  assert.deepEqual(
    classifyGmailMessage(
      { labels: ['Label_events'], includeSpamTrash: false },
      { labelIds: ['Label_events', 'UNREAD'] },
    ),
    { eligible: true },
  );
  assert.deepEqual(classifyGmailMessage({ labels: 'any', includeSpamTrash: false }, { labelIds: ['SPAM'] }), {
    eligible: false,
    reason: 'spam-trash',
  });
  assert.deepEqual(classifyGmailMessage({ labels: 'any', includeSpamTrash: true }, { labelIds: ['SPAM'] }), {
    eligible: true,
  });
});

test('GML-B1: Gmail history emits the specific added and combined label changes, never a duplicate convenience entry', () => {
  assert.deepEqual(
    occurrencesFromHistory({
      historyId: '102',
      nextPageToken: undefined,
      history: [
        {
          id: '101',
          messagesAdded: [
            { message: { id: 'message', threadId: 'thread' } },
            { message: { id: 'message', threadId: 'thread' } },
          ],
          labelsAdded: [{ message: { id: 'message', threadId: 'thread' }, labelIds: ['INBOX', 'STARRED'] }],
          labelsRemoved: [{ message: { id: 'message', threadId: 'thread' }, labelIds: ['UNREAD'] }],
        },
      ],
    }),
    [
      { kind: 'message', historyRecordId: '101', messageId: 'message', threadId: 'thread' },
      {
        kind: 'labelled',
        historyRecordId: '101',
        messageId: 'message',
        threadId: 'thread',
        added: ['INBOX', 'STARRED'],
        removed: ['UNREAD'],
      },
    ],
  );
});

test('GML-B1: one mailbox cursor follows every history page and commits only after terminal source admission', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-source-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      const historyCalls: Array<string | undefined> = [];
      const admitted: string[] = [];
      const fenced: string[] = [];
      let fullReads = 0;
      const source = {
        async listHistory({ pageToken }: { historyId: string; pageToken?: string }) {
          historyCalls.push(pageToken);
          return pageToken === undefined
            ? {
                historyId: '101',
                nextPageToken: 'second',
                history: [
                  {
                    id: '101',
                    messagesAdded: [{ message: { id: 'received', threadId: 'thread' } }],
                    labelsAdded: [],
                    labelsRemoved: [],
                  },
                ],
              }
            : { historyId: '102', nextPageToken: undefined, history: [] };
        },
        async getMessageMetadata(messageId: string) {
          return {
            id: messageId,
            threadId: 'thread',
            labelIds: ['INBOX', 'UNREAD'],
            snippet: 'one message',
            internalDate: '1760000000000',
            payload: {
              headers: [
                { name: 'From', value: 'Sender <sender@example.test>' },
                { name: 'Subject', value: 'Subject' },
              ],
            },
          };
        },
        async getMessage() {
          fullReads += 1;
          throw new Error('history acquisition must not read a full message');
        },
      };
      const worker = new GmailSourceWorker({
        store,
        source,
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: new MailboxLock(),
        rules: () => [
          {
            ruleId: 'rule-1',
            ruleVersion: 1,
            eventType: 'gmail.message.received',
            options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
            ingestRetentionMs: 60_000,
          },
          {
            ruleId: 'rule-sent',
            ruleVersion: 1,
            eventType: 'gmail.message.sent',
            options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
            ingestRetentionMs: 60_000,
          },
        ],
        assertDisclosable: async (rule) => {
          fenced.push(`${rule.ruleId}@${rule.ruleVersion}`);
        },
        admit: async (occurrence) => {
          admitted.push(String(occurrence.event.type));
          return 'terminal';
        },
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_010_000,
      });

      await worker.scan();

      assert.deepEqual(historyCalls, [undefined, 'second']);
      assert.deepEqual(fenced, ['rule-1@1', 'rule-sent@1']);
      assert.deepEqual(admitted, ['gmail.message.received']);
      assert.equal(fullReads, 0, 'body materialisation is an explicit later projection path');
      assert.equal(
        (
          store.database
            .prepare(
              "SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ? AND cursor_scope = 'mailbox'",
            )
            .get('ibx_ABCDEFGHIJKLMNOP') as { cursor: string }
        ).cursor,
        '102',
      );
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

test('GML-B1: a Gmail label change has its own observed-time event without a classification or body read', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-labelled-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let metadataReads = 0;
      let labelled: Record<string, unknown> | undefined;
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
                  messagesAdded: [],
                  labelsAdded: [{ message: { id: 'message', threadId: 'thread' }, labelIds: ['STARRED'] }],
                  labelsRemoved: [{ message: { id: 'message', threadId: 'thread' }, labelIds: ['INBOX'] }],
                },
              ],
            };
          },
          async getMessageMetadata() {
            metadataReads += 1;
            throw new Error('a labelled history occurrence already carries its thread id');
          },
        },
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: new MailboxLock(),
        rules: () => [
          {
            ruleId: 'rule-labels',
            ruleVersion: 1,
            eventType: 'gmail.message.labelled' as const,
            options: { channel: 'gmail' as const, labels: 'any' as const, includeSpamTrash: true },
            ingestRetentionMs: 60_000,
          },
        ],
        assertDisclosable: async () => undefined,
        admit: async (occurrence) => {
          labelled = occurrence.event;
          return 'terminal' as const;
        },
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_000_000,
      });

      await worker.scan();
      assert.equal(metadataReads, 0);
      assert.ok(labelled);
      assert.match(String(labelled.id), /^[0-9a-f]{32}$/u);
      const { id: _id, ...labelledWithoutId } = labelled;
      assert.deepEqual(labelledWithoutId, {
        type: 'gmail.message.labelled',
        version: 1,
        occurredAt: '2025-10-09T08:53:20.000Z',
        observedAt: '2025-10-09T08:53:20.000Z',
        account: { name: 'Events inbox', id: 'ibx_ABCDEFGHIJKLMNOP', channel: 'gmail' },
        messageId: 'message',
        threadId: 'thread',
        added: ['STARRED'],
        removed: ['INBOX'],
      });
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CAT-B1: an injected Gmail event-id collision degrades the source and leaves its cursor unchanged', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-collision-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
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
                  messagesAdded: [
                    { message: { id: 'one', threadId: 'thread' } },
                    { message: { id: 'two', threadId: 'thread' } },
                  ],
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
              snippet: messageId,
              internalDate: '1760000000000',
              payload: { headers: [{ name: 'Subject', value: messageId }] },
            };
          },
        },
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
        admit: async () => 'terminal' as const,
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        eventIdFor: async () => '00000000000000000000000000000000',
      });

      await assert.rejects(
        worker.scan(),
        (error: unknown) => error instanceof Error && /collision/i.test(error.message),
      );
      assert.equal(
        (store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail'").get() as { cursor: string })
          .cursor,
        '100',
      );
      assert.equal(
        (
          store.database
            .prepare("SELECT kind FROM operational_records WHERE id = 'gmail-collision:ibx_ABCDEFGHIJKLMNOP'")
            .get() as { kind: string }
        ).kind,
        'source-degraded-event-id-collision',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('GML-B1: an expired Gmail history cursor rebases without backfill and records one content-free source gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-gap-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let profiles = 0;
      const worker = new GmailSourceWorker({
        store,
        source: {
          async listHistory() {
            throw new CommsError('NOT_FOUND', 'expired cursor');
          },
          async getProfile() {
            profiles += 1;
            return { emailAddress: 'events@example.test', messagesTotal: 0, threadsTotal: 0, historyId: '500' };
          },
          async getMessageMetadata() {
            throw new Error('a rebaseline must not read a message');
          },
        },
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: new MailboxLock(),
        rules: () => [],
        assertDisclosable: async () => undefined,
        admit: async () => 'terminal' as const,
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_000_000,
      });

      assert.deepEqual(await worker.scan(), { cursor: '500', pending: false });
      assert.equal(profiles, 1);
      assert.equal(
        (store.database.prepare('SELECT COUNT(*) AS count FROM ingest').get() as { count: number }).count,
        0,
      );
      assert.equal(
        (store.database.prepare('SELECT kind FROM operational_records').get() as { kind: string }).kind,
        'agentcomms.source.gap',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('ING-B1: a Gmail message deleted after history listing resolves vanished and permits cursor progress', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-vanished-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
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
                  messagesAdded: [{ message: { id: 'gone', threadId: 'thread' } }],
                  labelsAdded: [],
                  labelsRemoved: [],
                },
              ],
            };
          },
          async getMessageMetadata() {
            throw new CommsError('NOT_FOUND', 'the message no longer exists');
          },
        },
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
        admit: async () => 'terminal' as const,
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_000_000,
      });

      assert.deepEqual(await worker.scan(), { cursor: '101', pending: false });
      assert.equal(
        (
          store.database
            .prepare("SELECT outcome FROM source_occurrence_resolutions WHERE occurrence_key = '101:message:gone'")
            .get() as { outcome: string }
        ).outcome,
        'vanished',
      );
      assert.equal(
        (store.database.prepare('SELECT COUNT(*) AS count FROM operational_records').get() as { count: number }).count,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('ING-B1: an undecodable Gmail metadata read keeps its encrypted retry until one unresolvable gap permits progress', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-metadata-retry-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let now = 1_760_000_000_000;
      let reads = 0;
      const workerOptions = {
        store,
        source: {
          async listHistory() {
            return {
              historyId: '101',
              nextPageToken: undefined,
              history: [
                {
                  id: '101',
                  messagesAdded: [{ message: { id: 'broken', threadId: 'thread' } }],
                  labelsAdded: [],
                  labelsRemoved: [],
                },
              ],
            };
          },
          async getMessageMetadata() {
            reads += 1;
            return { id: 'broken', threadId: 'thread', internalDate: 'not-a-date', payload: { headers: [] } };
          },
        },
        mailbox: { accountId: 'ibx_ABCDEFGHIJKLMNOP', name: 'Events inbox' },
        mailboxLock: new MailboxLock(),
        rules: () => [
          {
            ruleId: 'rule-1',
            ruleVersion: 1,
            eventType: 'gmail.message.received' as const,
            options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
            ingestRetentionMs: 2 * 86_400_000,
          },
        ],
        assertDisclosable: async () => undefined,
        admit: async () => 'terminal' as const,
        encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => now,
      };

      assert.deepEqual(await new GmailSourceWorker(workerOptions).scan(), { cursor: '100', pending: true });
      assert.equal(reads, 1);
      now += 86_400_000;
      assert.deepEqual(await new GmailSourceWorker(workerOptions).scan(), { cursor: '101', pending: false });
      assert.equal(reads, 1, 'the retry deadline terminalises without another provider read');
      assert.equal(
        (
          store.database
            .prepare(
              "SELECT outcome, error_code FROM source_occurrence_resolutions WHERE occurrence_key = '101:message:broken'",
            )
            .get() as { outcome: string; error_code: string }
        ).outcome,
        'unresolvable',
      );
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as {
            count: number;
          }
        ).count,
        1,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: the Gmail source fence refuses before metadata read, admission, or cursor progress', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-fence-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'ibx_ABCDEFGHIJKLMNOP', 'mailbox', '100', 0)",
        )
        .run();
      let metadataReads = 0;
      let admissions = 0;
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
                  messagesAdded: [{ message: { id: 'message', threadId: 'thread' } }],
                  labelsAdded: [],
                  labelsRemoved: [],
                },
              ],
            };
          },
          async getMessageMetadata() {
            metadataReads += 1;
            return {};
          },
        },
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
        assertDisclosable: async () => {
          throw new CommsError('APPROVAL_VOID', 'the exact lineage is revoked');
        },
        admit: async () => {
          admissions += 1;
          return 'terminal' as const;
        },
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        decryptStage: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
      });

      await assert.rejects(
        worker.scan(),
        (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
      );
      assert.equal(metadataReads, 0);
      assert.equal(admissions, 0);
      assert.equal(
        (store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail'").get() as { cursor: string })
          .cursor,
        '100',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
