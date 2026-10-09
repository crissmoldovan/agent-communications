import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { emptyConfig } from '@agentcomms/core';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { GmailSourceWorker, GmailStageExpiry } from '../src/sources/source-worker.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';
const STAGE = 'gmail-history:ibx_ABCDEFGHIJKLMNOP:100:0';

function storedPage() {
  return {
    cursorBefore: '100',
    page: {
      historyId: '101',
      nextPageToken: undefined,
      history: [
        {
          id: '101',
          messagesAdded: [{ message: { id: 'message-101', threadId: 'thread-101' } }],
          labelsAdded: [],
          labelsRemoved: [],
        },
      ],
    },
    stagedObservedAt: '2026-10-09T12:00:00.000Z',
    messageStates: {},
  };
}

function insertStage(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  options: { readonly expiresAt: number; readonly record?: Uint8Array | undefined },
): void {
  store.database
    .prepare(
      `INSERT INTO source_scan_state
       (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
       VALUES (?, 'gmail', ?, 'mailbox', 10, ?, ?, 10)`,
    )
    .run(STAGE, ACCOUNT, options.expiresAt, options.record ?? Buffer.from(JSON.stringify(storedPage())));
  store.database
    .prepare('INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, 1)')
    .run(STAGE, 'rule-1');
  store.database
    .prepare(
      "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 10)",
    )
    .run(ACCOUNT);
}

function commonExpiry(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  lock: MailboxLock,
  now: () => number,
): EventExpiry {
  return new EventExpiry(
    store,
    now,
    new GmailStageExpiry({
      store,
      mailboxLock: lock,
      decryptStage: async (record) => JSON.parse(Buffer.from(record).toString('utf8')),
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      now,
    }),
  );
}

test('D4a: the next paused owner tick terminalises an expired Gmail page without running a Gmail worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-gmail-common-expiry-paused-');
  const store = await openEventDatabase({ stateDir });
  try {
    const now = 20;
    const mailboxLock = new MailboxLock();
    insertStage(store, { expiresAt: now });
    const lifecycle = new EventLifecycle(store, () => now);
    await lifecycle.pause();
    let providerCalls = 0;
    const scheduler = new EventScheduler({
      store,
      lifecycle,
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
      expiry: commonExpiry(store, mailboxLock, () => now),
      cipher: {} as never,
      approvals: {} as never,
      config: {
        load: async () => ({ inboxes: { gmail: { id: ACCOUNT, provider: 'gmail' } } }),
      } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        providerCalls += 1;
        throw new Error('a paused owner must not start a Gmail worker');
      },
      mailboxLock,
      now: () => now,
    });

    await scheduler.tick();

    assert.equal(providerCalls, 0);
    const continuation = store.database
      .prepare('SELECT staged_at, stage_expires_at, encrypted_record FROM source_scan_state WHERE id = ?')
      .get(STAGE) as { staged_at: number | null; stage_expires_at: number | null; encrypted_record: Uint8Array };
    assert.deepEqual(
      { stagedAt: continuation.staged_at, stageExpiresAt: continuation.stage_expires_at },
      {
        stagedAt: null,
        stageExpiresAt: null,
      },
    );
    assert.deepEqual(JSON.parse(Buffer.from(continuation.encrypted_record).toString('utf8')), {
      cursorBefore: '100',
      page: { historyId: '101', history: [] },
      expired: true,
    });
    assert.equal(
      store.database.prepare('SELECT 1 FROM source_stage_rule_debts WHERE stage_id = ?').get(STAGE),
      undefined,
    );
    assert.equal(
      (
        store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ?").get(ACCOUNT) as {
          cursor: string;
        }
      ).cursor,
      '100',
    );
    assert.deepEqual(
      (
        store.database
          .prepare(
            "SELECT occurrence_key, outcome, error_code FROM source_occurrence_resolutions WHERE source = 'gmail'",
          )
          .all() as Array<Record<string, unknown>>
      ).map((row) => ({ ...row })),
      [{ occurrence_key: '101:message:message-101', outcome: 'retention-expired', error_code: 'STAGE_EXPIRED' }],
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: owner startup expires a Gmail page before a control request or worker can inspect it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-gmail-common-expiry-startup-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes.gmail = {
    id: ACCOUNT,
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:none:ibx_ABCDEFGHIJKLMNOP',
    internalDomains: [],
    createdAt: '2026-10-09T12:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const store = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(store.database, 'file');
    const cipher = new EventRecordCipher(
      store.database,
      await openEventSecretStore({ database: store.database, paths: store.paths, configDir }),
    );
    const record = await cipher.encrypt(
      { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: STAGE }] },
      Buffer.from(JSON.stringify(storedPage())),
    );
    insertStage(store, { expiresAt: 0, record });
  } finally {
    store.close();
  }

  let providerCalls = 0;
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    owner = await startEventOwner({
      stateDir,
      configDir,
      gmailSourceFor: async () => {
        providerCalls += 1;
        throw new Error('startup expiry must happen before a Gmail worker exists');
      },
    });
    assert.equal(providerCalls, 0);
    const duringStartup = await openEventDatabase({ stateDir });
    try {
      assert.deepEqual(
        {
          ...((duringStartup.database
            .prepare('SELECT staged_at, stage_expires_at FROM source_scan_state WHERE id = ?')
            .get(STAGE) as Record<string, unknown>) ?? {}),
        },
        { staged_at: null, stage_expires_at: null },
        'the page is content-free before this test makes any control request or ticks a worker',
      );
      assert.equal(
        (
          duringStartup.database
            .prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'gmail'")
            .get() as { outcome: string }
        ).outcome,
        'retention-expired',
      );
    } finally {
      duringStartup.close();
    }
  } finally {
    await owner?.stop();
    await rm(root, { recursive: true, force: true });
  }
});

test('D4a: the next Gmail scan resumes a common-expiry continuation and does not re-project its occurrence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-gmail-common-expiry-cursor-');
  const store = await openEventDatabase({ stateDir });
  try {
    const now = 20;
    const mailboxLock = new MailboxLock();
    insertStage(store, { expiresAt: now });
    await commonExpiry(store, mailboxLock, () => now).sweepAll();

    const historyStarts: string[] = [];
    let metadataReads = 0;
    const worker = new GmailSourceWorker({
      store,
      mailboxLock,
      mailbox: { accountId: ACCOUNT, name: 'Events inbox' },
      source: {
        async listHistory({ historyId }: { readonly historyId: string }) {
          historyStarts.push(historyId);
          return { historyId, nextPageToken: undefined, history: [] };
        },
        async getMessageMetadata() {
          metadataReads += 1;
          throw new Error('the expired page must not be projected again');
        },
      },
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
      admit: async () => 'terminal' as const,
      encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (record) => JSON.parse(Buffer.from(record).toString('utf8')),
      now: () => now,
    });

    assert.deepEqual(await worker.scan(), { cursor: '101', pending: false });
    assert.deepEqual(historyStarts, []);
    assert.equal(metadataReads, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: a Gmail stage before its deadline is left encrypted and untouched by common expiry', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-gmail-common-expiry-future-');
  const store = await openEventDatabase({ stateDir });
  try {
    let decrypts = 0;
    const mailboxLock = new MailboxLock();
    insertStage(store, { expiresAt: 21 });
    const expiry = new EventExpiry(
      store,
      () => 20,
      new GmailStageExpiry({
        store,
        mailboxLock,
        decryptStage: async (record) => {
          decrypts += 1;
          return JSON.parse(Buffer.from(record).toString('utf8'));
        },
        encryptStage: async (value) => Buffer.from(JSON.stringify(value)),
        now: () => 20,
      }),
    );

    const result = await expiry.sweepAll();

    assert.equal(result.sourceStages, 0);
    assert.equal(decrypts, 0);
    assert.notEqual(store.database.prepare('SELECT 1 FROM source_scan_state WHERE id = ?').get(STAGE), undefined);
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_occurrence_resolutions WHERE source = 'gmail'").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: paused common expiry preserves an expired page as a continuation until its unexpired chain sibling commits', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-gmail-common-expiry-chain-');
  const store = await openEventDatabase({ stateDir });
  try {
    let now = 0;
    const mailboxLock = new MailboxLock();
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', ?, 'mailbox', '100', 0)",
      )
      .run(ACCOUNT);
    const rules = () => [
      {
        ruleId: 'rule-1',
        ruleVersion: 1,
        eventType: 'gmail.message.received' as const,
        options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
        ingestRetentionMs: 100,
      },
    ];
    const page0 = {
      historyId: '101',
      nextPageToken: 'page-1',
      history: [
        {
          id: '101',
          messagesAdded: [{ message: { id: 'message-101', threadId: 'thread-101' } }],
          labelsAdded: [],
          labelsRemoved: [],
        },
      ],
    };
    const page1 = {
      historyId: '102',
      nextPageToken: undefined,
      history: [
        {
          id: '102',
          messagesAdded: [{ message: { id: 'message-102', threadId: 'thread-102' } }],
          labelsAdded: [],
          labelsRemoved: [],
        },
      ],
    };
    const base = {
      store,
      mailboxLock,
      mailbox: { accountId: ACCOUNT, name: 'Events inbox' },
      rules,
      assertDisclosable: async () => undefined,
      encryptStage: async (value: unknown) => Buffer.from(JSON.stringify(value)),
      decryptStage: async (record: Uint8Array) => JSON.parse(Buffer.from(record).toString('utf8')),
      now: () => now,
    };

    await assert.rejects(
      new GmailSourceWorker({
        ...base,
        source: {
          async listHistory({ pageToken }: { readonly pageToken?: string | undefined }) {
            if (pageToken === undefined) return page0;
            throw new Error('the first scan is interrupted before page 1');
          },
          async getMessageMetadata() {
            throw new Error('the interrupted scan must not read metadata');
          },
        },
        admit: async () => 'terminal' as const,
      }).scan(),
    );

    now = 50;
    assert.deepEqual(
      await new GmailSourceWorker({
        ...base,
        source: {
          async listHistory({ pageToken }: { readonly pageToken?: string | undefined }) {
            assert.equal(pageToken, 'page-1');
            return page1;
          },
          async getMessageMetadata(messageId: string) {
            assert.equal(messageId, 'message-101');
            return {
              id: messageId,
              threadId: 'thread-101',
              labelIds: ['INBOX'],
              snippet: 'first page',
              internalDate: String(now),
              payload: { headers: [{ name: 'Subject', value: 'first page' }] },
            };
          },
        },
        admit: async () => 'pending' as const,
      }).scan(),
      { cursor: '100', pending: true },
    );
    assert.deepEqual(
      store.database
        .prepare('SELECT id, stage_expires_at FROM source_scan_state ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 'gmail-history:ibx_ABCDEFGHIJKLMNOP:100:0', stage_expires_at: 100 },
        { id: 'gmail-history:ibx_ABCDEFGHIJKLMNOP:100:1', stage_expires_at: 150 },
      ],
    );

    now = 100;
    const lifecycle = new EventLifecycle(store, () => now);
    await lifecycle.pause();
    const scheduler = new EventScheduler({
      store,
      lifecycle,
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher: { recoverLeases: async () => undefined, dispatch: async () => undefined } as never,
      expiry: commonExpiry(store, mailboxLock, () => now),
      cipher: {} as never,
      approvals: {} as never,
      config: { load: async () => ({ inboxes: { gmail: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('a paused owner must not collect');
      },
      mailboxLock,
      now: () => now,
    });
    await scheduler.tick();

    const expired = store.database
      .prepare('SELECT staged_at, stage_expires_at, encrypted_record FROM source_scan_state WHERE id = ?')
      .get(STAGE) as
      | { staged_at: number | null; stage_expires_at: number | null; encrypted_record: Uint8Array }
      | undefined;
    assert.ok(expired, 'expiry retains the page as a content-free continuation');
    assert.deepEqual(JSON.parse(Buffer.from(expired.encrypted_record).toString('utf8')), {
      cursorBefore: '100',
      page: { historyId: '101', nextPageToken: 'page-1', history: [] },
      expired: true,
    });
    assert.deepEqual(
      { stagedAt: expired.staged_at, stageExpiresAt: expired.stage_expires_at },
      {
        stagedAt: null,
        stageExpiresAt: null,
      },
    );
    assert.equal(
      (
        store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ?").get(ACCOUNT) as {
          cursor: string;
        }
      ).cursor,
      '100',
    );
    assert.deepEqual(
      store.database
        .prepare('SELECT id, stage_expires_at FROM source_scan_state ORDER BY id')
        .all()
        .map((row) => ({ ...row })),
      [
        { id: 'gmail-history:ibx_ABCDEFGHIJKLMNOP:100:0', stage_expires_at: null },
        { id: 'gmail-history:ibx_ABCDEFGHIJKLMNOP:100:1', stage_expires_at: 150 },
      ],
    );
    assert.equal((await commonExpiry(store, mailboxLock, () => now).sweepAll()).sourceStages, 0);

    await lifecycle.resume();
    const historyCalls: Array<string | undefined> = [];
    const metadataReads: string[] = [];
    const admitted: string[] = [];
    assert.deepEqual(
      await new GmailSourceWorker({
        ...base,
        source: {
          async listHistory({ pageToken }: { readonly pageToken?: string | undefined }) {
            historyCalls.push(pageToken);
            throw new Error('the retained chain pages must resume without re-fetching');
          },
          async getMessageMetadata(messageId: string) {
            metadataReads.push(messageId);
            return {
              id: messageId,
              threadId: 'thread-102',
              labelIds: ['INBOX'],
              snippet: 'second page',
              internalDate: String(now),
              payload: { headers: [{ name: 'Subject', value: 'second page' }] },
            };
          },
        },
        admit: async (occurrence) => {
          admitted.push(String(occurrence.event.messageId));
          return 'terminal' as const;
        },
      }).scan(),
      { cursor: '102', pending: false },
    );
    assert.deepEqual(historyCalls, []);
    assert.deepEqual(metadataReads, ['message-102']);
    assert.deepEqual(admitted, ['message-102']);
    assert.equal(store.database.prepare('SELECT 1 FROM source_scan_state WHERE source = ?').get('gmail'), undefined);
    assert.equal(
      (
        store.database.prepare("SELECT cursor FROM cursors WHERE source = 'gmail' AND account_id = ?").get(ACCOUNT) as {
          cursor: string;
        }
      ).cursor,
      '102',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
