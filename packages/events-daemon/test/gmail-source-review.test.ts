import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { type GmailSourceRule, GmailSourceWorker } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';

function added(id: string) {
  return {
    id,
    messagesAdded: [{ message: { id: `message-${id}`, threadId: 'thread' } }],
    labelsAdded: [],
    labelsRemoved: [],
  };
}

async function world(rules: readonly GmailSourceRule[]) {
  const stateDir = await shortTempDir('aev-gmail-review-');
  const store = await openEventDatabase({ stateDir });
  store.database
    .prepare(
      "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 0)",
    )
    .run(ACCOUNT);
  const mailbox: { history: ReturnType<typeof added>[] | Array<Record<string, unknown>> } = { history: [] };
  const admitted: string[] = [];
  let admitPending = false;
  const worker = new GmailSourceWorker({
    store,
    source: {
      async listHistory({ historyId }: { historyId: string }) {
        const after = (mailbox.history as Array<{ id: string }>).filter(
          (record) => Number(record.id) > Number(historyId),
        );
        return {
          historyId: after.at(-1)?.id ?? historyId,
          nextPageToken: undefined,
          history: after as never,
        };
      },
      async getMessageMetadata(messageId: string) {
        return {
          id: messageId,
          threadId: 'thread',
          labelIds: ['INBOX'],
          internalDate: '1760000000000',
          payload: { headers: [{ name: 'Subject', value: 'Subject' }] },
        };
      },
    },
    mailbox: { accountId: ACCOUNT, name: 'Events inbox' },
    mailboxLock: new MailboxLock(),
    rules: () => rules,
    assertDisclosable: async () => undefined,
    admit: async (occurrence) => {
      if (admitPending) return 'pending';
      admitted.push(`${occurrence.rule.ruleId}:${String(occurrence.event.messageId)}`);
      return 'terminal';
    },
    encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
    decryptStage: async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')),
  });
  return {
    stateDir,
    store,
    worker,
    mailbox,
    admitted,
    setPending: (value: boolean) => {
      admitPending = value;
    },
  };
}

const received: GmailSourceRule = {
  ruleId: 'rule-received',
  ruleVersion: 1,
  eventType: 'gmail.message.received',
  options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  ingestRetentionMs: 600_000,
};

test('GML-B1: mail that arrives while a scan waits on its staged page is admitted later, never jumped over', {
  skip: WINDOWS_SKIP,
}, async () => {
  const w = await world([received]);
  try {
    w.mailbox.history = [added('101')];
    w.setPending(true);
    assert.deepEqual(
      await w.worker.scan(),
      { cursor: '100', pending: true },
      'the staged page waits; the cursor stays',
    );
    w.mailbox.history = [added('101'), added('102')];
    w.setPending(false);
    assert.deepEqual(
      await w.worker.scan(),
      { cursor: '101', pending: false },
      'the staged chain commits its own cursor',
    );
    assert.deepEqual(await w.worker.scan(), { cursor: '102', pending: false });
    assert.deepEqual(w.admitted, ['rule-received:message-101', 'rule-received:message-102']);
  } finally {
    w.store.close();
    await rm(w.stateDir, { recursive: true, force: true });
  }
});

test('GML-B1: a label change matches a rule only through its own added and removed labels (D4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const labelled = (
    ruleId: string,
    labels: readonly string[] | 'any' | 'inbox',
    includeSpamTrash = false,
  ): GmailSourceRule => ({
    ruleId,
    ruleVersion: 1,
    eventType: 'gmail.message.labelled',
    options: { channel: 'gmail', labels: labels as never, includeSpamTrash },
    ingestRetentionMs: 600_000,
  });
  const w = await world([
    labelled('rule-x', ['Label_x']),
    labelled('rule-any', 'any'),
    labelled('rule-any-spam', 'any', true),
  ]);
  try {
    const change = (id: string, add: string[], remove: string[]) => ({
      id,
      messagesAdded: [],
      labelsAdded: add.length ? [{ message: { id: `message-${id}`, threadId: 'thread' }, labelIds: add }] : [],
      labelsRemoved: remove.length ? [{ message: { id: `message-${id}`, threadId: 'thread' }, labelIds: remove }] : [],
    });
    w.mailbox.history = [
      change('101', ['Label_other'], []),
      change('102', ['Label_x'], []),
      change('103', [], ['Label_x']),
      change('104', ['SPAM'], []),
    ];
    await w.worker.scan();
    assert.deepEqual(w.admitted.sort(), [
      'rule-any-spam:message-101',
      'rule-any-spam:message-102',
      'rule-any-spam:message-103',
      'rule-any-spam:message-104',
      'rule-any:message-101',
      'rule-any:message-102',
      'rule-any:message-103',
      'rule-x:message-102',
      'rule-x:message-103',
    ]);
  } finally {
    w.store.close();
    await rm(w.stateDir, { recursive: true, force: true });
  }
});
