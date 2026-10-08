import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
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

async function world(
  rules: readonly GmailSourceRule[],
  hooks: {
    onList?: (store: Awaited<ReturnType<typeof openEventDatabase>>) => void;
    accountLive?: () => Promise<void>;
    eventIdFor?: () => Promise<string>;
    onDisclosable?: () => void;
  } = {},
) {
  const stateDir = await shortTempDir('aev-gmail-review-');
  const store = await openEventDatabase({ stateDir });
  store.database
    .prepare(
      "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 0)",
    )
    .run(ACCOUNT);
  const mailbox: { history: ReturnType<typeof added>[] | Array<Record<string, unknown>> } = { history: [] };
  const admitted: string[] = [];
  const metadataReads: string[] = [];
  let profileReads = 0;
  let listCalls = 0;
  let pagesStaged = 0;
  let admitPending = false;
  const worker = new GmailSourceWorker({
    store,
    source: {
      async listHistory({ historyId }: { historyId: string }) {
        listCalls += 1;
        hooks.onList?.(store);
        const after = (mailbox.history as Array<{ id: string }>).filter(
          (record) => Number(record.id) > Number(historyId),
        );
        return {
          historyId: after.at(-1)?.id ?? historyId,
          nextPageToken: undefined,
          history: after as never,
        };
      },
      async getProfile() {
        profileReads += 1;
        return { emailAddress: 'events@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '500' };
      },
      async getMessageMetadata(messageId: string) {
        metadataReads.push(messageId);
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
    accountLive: hooks.accountLive,
    ...(hooks.eventIdFor ? { eventIdFor: hooks.eventIdFor } : {}),
    onPageStaged: async () => {
      pagesStaged += 1;
    },
    assertDisclosable: async () => hooks.onDisclosable?.(),
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
    metadataReads,
    profileReads: () => profileReads,
    listCalls: () => listCalls,
    pagesStaged: () => pagesStaged,
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

test('GML-B1: a history response that returns after a disable-all or an account removal recreates nothing (D12)', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [name, change] of [
    [
      'disable-all',
      (store: Awaited<ReturnType<typeof openEventDatabase>>) =>
        store.database.exec('UPDATE event_settings SET enabled = 0, switch_generation = switch_generation + 1'),
    ],
    [
      'account removal',
      (store: Awaited<ReturnType<typeof openEventDatabase>>) =>
        store.database
          .prepare('INSERT OR REPLACE INTO account_revocations (account_id, revoked_at) VALUES (?, ?)')
          .run(ACCOUNT, Date.now() + 1),
    ],
  ] as const) {
    const w = await world([received], { onList: change });
    try {
      w.store.database.exec('UPDATE event_settings SET enabled = 1');
      w.mailbox.history = [added('101')];
      assert.deepEqual(await w.worker.scan(), { cursor: '100', pending: true }, `${name}: the stale scan stops`);
      const staged = (
        w.store.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }
      ).count;
      assert.equal(staged, 0, `${name}: no purged staging is recreated`);
      assert.deepEqual(w.admitted, [], `${name}: nothing is admitted`);
    } finally {
      w.store.close();
      await rm(w.stateDir, { recursive: true, force: true });
    }
  }
});

test('GML-B1: a history response that returns after the account left the configuration stages nothing (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  // The configuration is the authority: no tombstone exists yet, since only a later tick records the removal.
  let removed = false;
  const w = await world([received], {
    onList: () => {
      removed = true;
    },
    accountLive: async () => {
      if (removed)
        throw new CommsError('NOT_FOUND', 'the Gmail account bound to this event work is no longer connected', {
          details: { reason: 'ACCOUNT_REMOVED', accountId: ACCOUNT },
        });
    },
  });
  try {
    w.store.database.exec('UPDATE event_settings SET enabled = 1');
    w.mailbox.history = [added('101')];
    await assert.rejects(
      () => w.worker.scan(),
      (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
    );
    const count = (table: string) =>
      (w.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
    assert.equal(count('source_scan_state'), 0, 'no page is staged for a removed account');
    assert.equal(w.pagesStaged(), 0, 'and none was staged and purged afterwards');
    assert.equal(count('source_stage_rule_debts'), 0);
    assert.equal(count('cursors'), 0, 'the removed account keeps no cursor');
    assert.deepEqual(w.metadataReads, [], 'no further provider read is made for a removed account');
    assert.deepEqual(w.admitted, []);
  } finally {
    w.store.close();
    await rm(w.stateDir, { recursive: true, force: true });
  }
});

function revoke(store: Awaited<ReturnType<typeof openEventDatabase>>, rule: GmailSourceRule): void {
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at, revoked_at)
       VALUES (?, ?, ?, '{}', 'digest', 'revoked', 'approval', 'activation', 1, 2)`,
    )
    .run(`${rule.ruleId}@${rule.ruleVersion}`, rule.ruleId, rule.ruleVersion);
}

test('GML-B1: a page is staged only for rule versions still live when it is written, never as an orphan', {
  skip: WINDOWS_SKIP,
}, async () => {
  const other: GmailSourceRule = { ...received, ruleId: 'rule-other' };
  // The only rule revoked during the provider call: the page is owed to nobody and is not written.
  {
    const w = await world([received], { onList: (store) => revoke(store, received) });
    try {
      w.store.database.exec('UPDATE event_settings SET enabled = 1');
      w.mailbox.history = [added('101')];
      assert.deepEqual(await w.worker.scan(), { cursor: '100', pending: true }, 'the scan stops');
      const count = (table: string) =>
        (w.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      assert.equal(count('source_scan_state'), 0, 'no orphan page is staged');
      assert.equal(count('source_stage_rule_debts'), 0);
      assert.deepEqual(w.admitted, []);
    } finally {
      w.store.close();
      await rm(w.stateDir, { recursive: true, force: true });
    }
  }
  // One of two revoked: the page is staged, and owes only the live version.
  {
    const w = await world([received, other], { onList: (store) => revoke(store, received) });
    try {
      w.store.database.exec('UPDATE event_settings SET enabled = 1');
      w.setPending(true);
      w.mailbox.history = [added('101')];
      await w.worker.scan();
      const staged = (
        w.store.database.prepare('SELECT rule_id FROM source_stage_rule_debts ORDER BY rule_id').all() as Array<{
          rule_id: string;
        }>
      ).map((row) => row.rule_id);
      assert.deepEqual(staged, ['rule-other'], 'the revoked version is owed nothing');
    } finally {
      w.store.close();
      await rm(w.stateDir, { recursive: true, force: true });
    }
  }
});

function removable() {
  let removed = false;
  return {
    remove: () => {
      removed = true;
    },
    accountLive: async () => {
      if (removed)
        throw new CommsError('NOT_FOUND', 'the Gmail account bound to this event work is no longer connected', {
          details: { reason: 'ACCOUNT_REMOVED', accountId: ACCOUNT },
        });
    },
  };
}

test('GML-B1: a Gmail 404 that meets an account removal is never re-baselined with a provider call (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const account = removable();
  const w = await world([received], {
    onList: () => {
      account.remove();
      // Gmail's own 404 carries no removal reason: only the configuration can say the account is gone.
      throw new CommsError('NOT_FOUND', 'Requested entity was not found.');
    },
    accountLive: account.accountLive,
  });
  try {
    w.store.database.exec('UPDATE event_settings SET enabled = 1');
    await assert.rejects(
      () => w.worker.scan(),
      (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
    );
    assert.equal(w.profileReads(), 0, 'a removed account gets no getProfile call');
    assert.equal(
      (w.store.database.prepare('SELECT COUNT(*) AS count FROM cursors').get() as { count: number }).count,
      0,
      'and no re-baselined cursor',
    );
  } finally {
    w.store.close();
    await rm(w.stateDir, { recursive: true, force: true });
  }
});

test('GML-B1: an account removed while an event identity is hashed gets no ingest record and no admission (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const account = removable();
  const w = await world([received], {
    accountLive: account.accountLive,
    eventIdFor: async () => {
      account.remove();
      return '11111111111111111111111111111111';
    },
  });
  try {
    w.store.database.exec('UPDATE event_settings SET enabled = 1');
    w.mailbox.history = [added('101')];
    await assert.rejects(
      () => w.worker.scan(),
      (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
    );
    assert.equal(
      (w.store.database.prepare('SELECT COUNT(*) AS count FROM ingest').get() as { count: number }).count,
      0,
      'no ingest record is written for a removed account',
    );
    assert.deepEqual(w.admitted, [], 'and nothing is admitted');
  } finally {
    w.store.close();
    await rm(w.stateDir, { recursive: true, force: true });
  }
});

test('GML-B1: a removed account is not polled, and a removal before a metadata read stops that read (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  // Removed before the scan: no history call is made at all.
  {
    const account = removable();
    account.remove();
    const w = await world([received], { accountLive: account.accountLive });
    try {
      w.store.database.exec('UPDATE event_settings SET enabled = 1');
      w.mailbox.history = [added('101')];
      await assert.rejects(
        () => w.worker.scan(),
        (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
      );
      assert.equal(w.listCalls(), 0, 'a removed account gets no history call');
    } finally {
      w.store.close();
      await rm(w.stateDir, { recursive: true, force: true });
    }
  }
  // Removed after the page is staged, at the source fence: no metadata call is made.
  {
    const account = removable();
    const w = await world([received], { accountLive: account.accountLive, onDisclosable: account.remove });
    try {
      w.store.database.exec('UPDATE event_settings SET enabled = 1');
      w.mailbox.history = [added('101')];
      await assert.rejects(
        () => w.worker.scan(),
        (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
      );
      assert.deepEqual(w.metadataReads, [], 'a removed account gets no metadata call');
    } finally {
      w.store.close();
      await rm(w.stateDir, { recursive: true, force: true });
    }
  }
});
