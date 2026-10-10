import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import { resendEmailReceivedV1, slackMessagePostedV1, whatsappMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { runSourceOwnerWork } from '../src/runtime/source-owner-work.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { assertSourceWriteStillLive, type SourceScope, sourceRuleSetSnapshot } from '../src/sources/contracts.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { phaseDSourceRegistry } from '../src/sources/registry.ts';
import { type ResendEventReader, ResendReceivedSource } from '../src/sources/resend.ts';
import { ResendStatusSource } from '../src/sources/resend-status.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { SlackHistorySource, slackConversationScope } from '../src/sources/slack.ts';
import { SlackReplyDrains } from '../src/sources/slack-replies.ts';
import { WhatsAppSourceWorker } from '../src/sources/whatsapp.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

type DSource = 'slack' | 'resend' | 'whatsapp';

const target = { targetId: 'd9-target', version: 1, kind: 'dry-run' as const, retentionMs: 1_000 };
const retention = {
  ingestMs: 1_000,
  holdMs: 1_000,
  deliveryMs: 1_000,
  dryrunMs: 1_000,
  sseReplayMs: 1_000,
  deadLetterMs: 1_000,
  decisionMetadataMs: 1_000,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function config(source: DSource, accountId: string, live = true) {
  return { inboxes: {}, accounts: live ? { account: { id: accountId, platform: source } } : {} };
}

function eventFor(source: DSource, accountId: string): Record<string, unknown> {
  const example =
    source === 'slack'
      ? slackMessagePostedV1.examples[0]
      : source === 'resend'
        ? resendEmailReceivedV1.examples[0]
        : whatsappMessageReceivedV1.examples[0];
  if (example === undefined) throw new Error('the event catalogue fixture is missing');
  return { ...example, account: { ...(example.account as object), id: accountId, channel: source } };
}

function ruleFor(source: DSource, accountId: string, id: string) {
  const event =
    source === 'slack' ? slackMessagePostedV1 : source === 'resend' ? resendEmailReceivedV1 : whatsappMessageReceivedV1;
  const options =
    source === 'slack'
      ? { channel: 'slack', conversations: ['C-d9'] }
      : source === 'resend'
        ? { channel: 'resend', kinds: ['received'] }
        : { channel: 'whatsapp', chats: ['chat@example.test'] };
  return {
    ruleId: id,
    version: 1,
    source: { channel: source, accountIds: [accountId], options },
    event: { type: event.type, version: 1 },
    condition: { path: '/id', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 10,
    retention,
  };
}

function sourceFence(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  scope: SourceScope,
  rules: () => readonly { ruleId: string; ruleVersion: number }[],
) {
  const settings = store.database
    .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
    .get() as { enabled: number; switch_generation: number };
  const snapshot = {
    generation: settings.switch_generation,
    enabled: settings.enabled,
    startedAt: 1,
    rules: sourceRuleSetSnapshot(rules()),
  };
  return () => assertSourceWriteStillLive(store.database, scope, snapshot, rules);
}

function sourceRows(store: Awaited<ReturnType<typeof openEventDatabase>>, source: DSource, accountId: string): number {
  return (
    store.database
      .prepare('SELECT count(*) AS count FROM source_scan_state WHERE source = ? AND account_id = ?')
      .get(source, accountId) as { count: number }
  ).count;
}

test('D9: held Slack history/reply provider, stage and cursor writes use their real post-await fences', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d9-slack-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'd9-slack';
    const conversationId = 'C-d9';
    const scope = slackConversationScope(accountId, conversationId);
    const rules = () => [{ ruleId: 'd9-slack-rule', ruleVersion: 1, ingestRetentionMs: 1_000 }];
    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1');
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1.000000', 0)",
      )
      .run(accountId, scope.scopeId);

    const page = deferred<ReturnType<typeof slackPage>>();
    const started = deferred<void>();
    const provider = slackWorker(store, accountId, conversationId, rules, {
      history: async () => {
        started.resolve();
        return page.promise;
      },
    });
    const scanning = provider.scan({ conversationId, latest: '3.000000', maxPages: 1 });
    await started.promise;
    store.database.exec('UPDATE event_settings SET enabled = 0, switch_generation = 2');
    page.resolve(slackPage());
    assert.deepEqual(await scanning, { watermark: '1.000000', pending: true });
    assert.equal(
      store.database
        .prepare("SELECT 1 FROM source_scan_state WHERE source = 'slack' AND account_id = ? AND staged_at IS NOT NULL")
        .get(accountId),
      undefined,
      'a stale provider page created no content stage',
    );

    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 3');
    let encryption = 0;
    const stageEncrypt = deferred<Uint8Array>();
    const stageWorker = slackWorker(
      store,
      accountId,
      conversationId,
      rules,
      { history: async () => slackPage() },
      async (value) => {
        encryption += 1;
        return encryption === 2 ? stageEncrypt.promise : Buffer.from(JSON.stringify(value));
      },
    );
    const staging = stageWorker.scan({ conversationId, latest: '3.000000', maxPages: 1 });
    await Promise.resolve();
    store.database.exec('UPDATE event_settings SET paused = 1');
    stageEncrypt.resolve(Buffer.from('{}'));
    assert.deepEqual(await staging, { watermark: '1.000000', pending: true });
    assert.equal(
      store.database
        .prepare("SELECT 1 FROM source_scan_state WHERE source = 'slack' AND account_id = ? AND staged_at IS NOT NULL")
        .get(accountId),
      undefined,
      'the real stage commit was fenced after encryption',
    );

    store.database.exec('UPDATE event_settings SET paused = 0');
    let cursorEncryption = 0;
    const cursorEncrypt = deferred<Uint8Array>();
    const cursorWorker = slackWorker(
      store,
      accountId,
      conversationId,
      rules,
      { history: async () => slackPage() },
      async (value) => {
        cursorEncryption += 1;
        return cursorEncryption === 4 ? cursorEncrypt.promise : Buffer.from(JSON.stringify(value));
      },
    );
    const moving = cursorWorker.scan({ conversationId, latest: '3.000000', maxPages: 1 });
    await Promise.resolve();
    store.database.exec('UPDATE event_settings SET switch_generation = 4');
    cursorEncrypt.resolve(Buffer.from('{}'));
    assert.deepEqual(await moving, { watermark: '1.000000', pending: true });
    assert.equal(
      (
        store.database
          .prepare("SELECT cursor FROM cursors WHERE source = 'slack' AND account_id = ?")
          .get(accountId) as { cursor: string }
      ).cursor,
      '1.000000',
      'the final cursor move did not write after its encryption await',
    );

    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 5');
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES ('d9-reply', 'replace', '{}', 'digest', 'exact', '[]', '[]', 'pending-completion', 1, 1)`,
      )
      .run();
    const reply = deferred<{ messages: []; nextCursor: null; retainedHistoryBoundary: false }>();
    const replyStarted = deferred<void>();
    const drains = new SlackReplyDrains({
      database: store.database,
      source: {
        replies: async () => {
          replyStarted.resolve();
          return reply.promise;
        },
      },
      assertLive: sourceFence(store, scope, rules),
      encryptState: async (value) => Buffer.from(JSON.stringify(value)),
      decryptState: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      now: () => 1,
      nowTimestamp: () => '3.000000',
      stage: {
        scope,
        debts: () => [{ ruleId: 'rule-test', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      },
    });
    await drains.begin({ intentId: 'd9-reply', accountId, conversationId, through: '3.000000' });
    await drains.discoverParent({ intentId: 'd9-reply', accountId, conversationId, parentTs: '2.000000' });
    const replying = drains.resumeOne({ intentId: 'd9-reply', accountId, conversationId });
    await replyStarted.promise;
    store.database.exec('UPDATE event_settings SET paused = 1');
    reply.resolve({ messages: [], nextCursor: null, retainedHistoryBoundary: false });
    await assert.rejects(replying, { code: 'APPROVAL_VOID' });
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT cursor, drained_at FROM slack_reply_drains WHERE intent_id = 'd9-reply'")
          .get() as Record<string, unknown>),
      },
      { cursor: null, drained_at: null },
      'the actual reply cursor conditional update stayed unchanged',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D9: held Resend received/status provider and crypto boundaries use their real stage and anchor fences', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d9-resend-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'd9-resend';
    const oldId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const receivedScope: SourceScope = { source: 'resend', accountId, scopeId: 'received' };
    const statusScope: SourceScope = { source: 'resend', accountId, scopeId: 'status' };
    const receivedRules = () => [{ ruleId: 'd9-received', ruleVersion: 1, ingestRetentionMs: 1_000 }];
    const statusRules = () => [{ ruleId: 'd9-status', ruleVersion: 1, ingestRetentionMs: 1_000 }];
    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1');
    const detail = deferred<Awaited<ReturnType<ResendEventReader['getReceived']>>>();
    const detailStarted = deferred<void>();
    const received = new ResendReceivedSource({
      store,
      accountId,
      reader: {
        listReceived: async () => ({ emails: [{ id: newId }, { id: oldId }], next: null }),
        getReceived: async () => {
          detailStarted.resolve();
          return detail.promise;
        },
        listSent: async () => ({ emails: [], next: null }),
      },
      encrypt: async (value) => Buffer.from(JSON.stringify(value)),
      decrypt: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      debts: receivedRules,
      admit: async () => 'terminal',
      assertWriteStillLive: sourceFence(store, receivedScope, receivedRules),
      now: () => 1,
    });
    await received.seedAnchor(oldId);
    const scanning = received.scan();
    await detailStarted.promise;
    store.database.exec('UPDATE event_settings SET switch_generation = 2');
    detail.resolve({
      kind: 'candidate',
      candidate: { emailId: newId, receivedAt: '2026-10-09T00:00:00.000Z', subject: 'late' },
    });
    await assert.rejects(scanning, { code: 'APPROVAL_VOID' });
    assert.equal(received.anchorId(), oldId, 'a stale detail result did not move the received anchor');

    store.database.exec('UPDATE event_settings SET switch_generation = 3');
    const statusPage = deferred<Awaited<ReturnType<ResendEventReader['listSent']>>>();
    const statusStarted = deferred<void>();
    const status = new ResendStatusSource({
      store,
      accountId,
      reader: {
        listReceived: async () => ({ emails: [], next: null }),
        getReceived: async () => ({ kind: 'vanished' }),
        listSent: async () => {
          statusStarted.resolve();
          return statusPage.promise;
        },
      },
      encrypt: async (value) => Buffer.from(JSON.stringify(value)),
      decrypt: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      debts: statusRules,
      admit: async () => 'terminal',
      assertWriteStillLive: sourceFence(store, statusScope, statusRules),
      now: () => Date.parse('2026-10-09T00:00:00.000Z'),
    });
    const polling = status.scan();
    await statusStarted.promise;
    store.database.exec('UPDATE event_settings SET paused = 1');
    statusPage.resolve({ emails: [resendStatus(newId)], next: null });
    await assert.rejects(polling, { code: 'APPROVAL_VOID' });
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM resend_status_state WHERE account_id = ? AND email_id = ?')
        .get(accountId, newId),
      undefined,
    );

    store.database.exec('UPDATE event_settings SET paused = 0');
    const held = deferred<Uint8Array>();
    const cryptoAccount = `${accountId}-crypto`;
    const cryptoScope: SourceScope = { source: 'resend', accountId: cryptoAccount, scopeId: 'received' };
    const encrypting = new ResendReceivedSource({
      store,
      accountId: cryptoAccount,
      reader: {
        listReceived: async () => ({ emails: [], next: null }),
        getReceived: async () => ({ kind: 'vanished' }),
        listSent: async () => ({ emails: [], next: null }),
      },
      encrypt: async () => held.promise,
      decrypt: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
      debts: receivedRules,
      admit: async () => 'terminal',
      assertWriteStillLive: sourceFence(store, cryptoScope, receivedRules),
      now: () => 1,
    }).seedAnchor(oldId);
    await Promise.resolve();
    store.database.exec('UPDATE event_settings SET enabled = 0, switch_generation = 4');
    held.resolve(Buffer.from('{}'));
    await assert.rejects(encrypting, { code: 'APPROVAL_VOID' });
    assert.equal(sourceRows(store, 'resend', cryptoAccount), 0, 'the held encryption did not create state');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D9: held WhatsApp snapshot and first-representation encryption use the candidate/head commit fence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d9-whatsapp-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'd9-whatsapp';
    const scope: SourceScope = { source: 'whatsapp', accountId, scopeId: 'chat:chat@example.test' };
    const rules = () => [
      { ruleId: 'd9-whatsapp', ruleVersion: 1, ingestRetentionMs: 1_000, activationId: 'activation' },
    ];
    const visibility = { version: 1, digest: 'a'.repeat(64), seesMessage: () => true };
    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1');
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('d9-whatsapp@1', 'd9-whatsapp', '{}', 'digest');
    const snapshot = deferred<never>();
    const snapshotStarted = deferred<void>();
    const reading = new WhatsAppSourceWorker({
      store,
      accountId,
      snapshot: async (work) => {
        snapshotStarted.resolve();
        return work(await snapshot.promise);
      },
      stage: async () => Buffer.from('stage'),
      rules,
      assertWrite: sourceFence(store, scope, rules),
      now: () => 1,
    }).scan();
    await snapshotStarted.promise;
    store.database.exec('UPDATE event_settings SET switch_generation = 2');
    snapshot.resolve({
      visibility,
      messages: [{ chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false }],
    } as never);
    await assert.rejects(reading, { code: 'APPROVAL_VOID' });
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_heads').get(), undefined);

    store.database.exec('UPDATE event_settings SET switch_generation = 3');
    const staged = deferred<Uint8Array>();
    const stageStarted = deferred<void>();
    const committing = new WhatsAppSourceWorker({
      store,
      accountId,
      snapshot: async (work) =>
        work({
          visibility,
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
          ],
        }),
      stage: async () => {
        stageStarted.resolve();
        return staged.promise;
      },
      rules,
      assertWrite: sourceFence(store, scope, rules),
      now: () => 1,
    }).scan();
    await stageStarted.promise;
    store.database.exec('UPDATE event_settings SET paused = 1');
    staged.resolve(Buffer.from('stage'));
    await assert.rejects(committing, { code: 'APPROVAL_VOID' });
    for (const table of ['whatsapp_snapshot_heads', 'whatsapp_occurrences', 'source_scan_state'] as const)
      assert.equal(
        store.database.prepare(`SELECT 1 FROM ${table}`).get(),
        undefined,
        `paused candidate left no ${table}`,
      );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a chat-A WhatsApp turn refuses its account-wide B write after B is revoked during encryption', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-account-wide-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'acc_ABCDEFGHIJKLMNOP';
    const chatA = 'chat-a@example.test';
    const chatB = 'chat-b@example.test';
    const scopeA: SourceScope = { source: 'whatsapp', accountId, scopeId: `chat:${chatA}` };
    const scopeB: SourceScope = { source: 'whatsapp', accountId, scopeId: `chat:${chatB}` };
    const ruleA = {
      ...ruleFor('whatsapp', accountId, 'account-wide-a'),
      source: {
        channel: 'whatsapp' as const,
        accountIds: [accountId],
        options: { channel: 'whatsapp' as const, chats: [chatA] },
      },
    };
    const ruleB = {
      ...ruleFor('whatsapp', accountId, 'account-wide-b'),
      source: {
        channel: 'whatsapp' as const,
        accountIds: [accountId],
        options: { channel: 'whatsapp' as const, chats: [chatB] },
      },
    };
    installActiveScope(store, scopeA, ruleA);
    installActiveScope(store, scopeB, ruleB);
    for (const rule of [ruleA, ruleB])
      store.database
        .prepare(
          'UPDATE rule_activation_points SET encrypted_position = ? WHERE activation_id = ? AND rule_id = ? AND rule_version = 1',
        )
        .run(
          Buffer.from(
            JSON.stringify({ capturedAt: '1970-01-01T00:00:00.000Z', baselineGeneration: 0, baselineIdentities: [] }),
          ),
          `activation-${rule.ruleId}`,
          rule.ruleId,
        );
    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1');

    const stageStarted = deferred<void>();
    const staged = deferred<void>();
    const running = runSourceOwnerWork(
      {
        store,
        cipher: {
          decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
          encrypt: async (_location: unknown, value: Uint8Array) => {
            stageStarted.resolve();
            await staged.promise;
            return Buffer.from(value);
          },
        } as never,
        approvals: { get: async () => null },
        config: { load: async () => config('whatsapp', accountId) } as never,
        taint: { record: async () => undefined } as never,
        lifecycle: {} as never,
        sourceRegistry: phaseDSourceRegistry(),
        slackSourceFor: async () => {
          throw new Error('not Slack');
        },
        resendReaderFor: async () => {
          throw new Error('not Resend');
        },
        whatsappEventOperations: {
          withEventSnapshot: async (_input: unknown, work: (snapshot: unknown) => unknown) =>
            work({
              messages: [
                {
                  chatJid: chatB,
                  chatKind: 'unknown',
                  senderJidRaw: 'sender@example.test',
                  stanzaId: 'message-b',
                  fromMe: false,
                  at: '1970-01-01T00:00:01.000Z',
                },
              ],
            } as never),
        } as never,
        whatsappVisibilityFence: visibilityFence(store),
        now: () => 1,
      },
      scopeA,
    );
    await stageStarted.promise;
    store.database.prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ?").run(ruleB.ruleId);
    staged.resolve();

    await assert.rejects(running, { code: 'APPROVAL_VOID' });
    assert.equal(
      store.database
        .prepare("SELECT 1 FROM whatsapp_occurrences WHERE account_id = ? AND message_id LIKE '%message-b%'")
        .get(accountId),
      undefined,
      'the revoked chat-B tuple has no occurrence ledger row',
    );
    assert.equal(
      store.database
        .prepare("SELECT 1 FROM source_scan_state WHERE source = 'whatsapp' AND account_id = ?")
        .get(accountId),
      undefined,
      'the revoked chat-B tuple has no retained ciphertext',
    );
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM whatsapp_rule_admissions WHERE rule_id = ? AND rule_version = 1')
        .get(ruleB.ruleId),
      undefined,
      'the revoked chat-B tuple has no admission',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D9: source-owner crypto wrappers re-read Resend core configuration after encryption and decryption', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const boundary of ['encryption', 'decryption'] as const) {
    const stateDir = await shortTempDir(`events-d9-owner-${boundary}-`);
    const store = await openEventDatabase({ stateDir });
    try {
      const accountId = `d9-owner-${boundary}`;
      const scope: SourceScope = { source: 'resend', accountId, scopeId: 'received' };
      const oldId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const newId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      installActiveScope(store, scope, ruleFor('resend', accountId, `d9-owner-${boundary}`));
      store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1');
      store.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('resend', ?, 'received', ?, 0)",
        )
        .run(accountId, oldId);
      if (boundary === 'decryption')
        store.database
          .prepare(
            'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, 1)',
          )
          .run(
            `resend-received:${accountId}`,
            'resend',
            accountId,
            'received',
            Buffer.from(JSON.stringify(resendState(oldId))),
          );
      let current = config('resend', accountId);
      const held = deferred<Uint8Array>();
      const started = deferred<void>();
      let encryptCalls = 0;
      const running = runSourceOwnerWork(
        {
          store,
          cipher: {
            encrypt: async (_location: unknown, value: Uint8Array) => {
              encryptCalls += 1;
              if (boundary === 'encryption' && encryptCalls === 2) {
                started.resolve();
                return held.promise;
              }
              return Buffer.from(value);
            },
            decrypt: async (_location: unknown, value: Uint8Array) => {
              if (boundary === 'decryption') {
                started.resolve();
                return held.promise;
              }
              return Buffer.from(value);
            },
          } as never,
          approvals: { get: async () => null },
          config: { load: async () => current } as never,
          taint: { record: async () => undefined } as never,
          lifecycle: {} as never,
          sourceRegistry: phaseDSourceRegistry(),
          slackSourceFor: async () => {
            throw new Error('not Slack');
          },
          resendReaderFor: async () => ({
            listReceived: async () => ({ emails: [{ id: newId }, { id: oldId }], next: null }),
            getReceived: async () => ({ kind: 'vanished' }),
            listSent: async () => ({ emails: [], next: null }),
          }),
          whatsappEventOperations: {} as never,
          whatsappVisibilityFence: visibilityFence(store),
          now: () => 1,
        },
        scope,
      );
      await started.promise;
      const before = Buffer.from(
        (
          store.database
            .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
            .get(`resend-received:${accountId}`) as { encrypted_record: Uint8Array }
        ).encrypted_record,
      );
      current = config('resend', accountId, false);
      held.resolve(
        Buffer.from(
          JSON.stringify({ anchorId: oldId, cycleHeadId: newId, after: null, pagesScanned: 1, items: [newId, oldId] }),
        ),
      );
      await running.catch((error: unknown) => {
        assert.equal((error as { code?: string }).code, 'NOT_FOUND');
      });
      const after = Buffer.from(
        (
          store.database
            .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
            .get(`resend-received:${accountId}`) as { encrypted_record: Uint8Array }
        ).encrypted_record,
      );
      assert.deepEqual(after, before, `${boundary} did not add or replace a source row after removal`);
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('D9: scheduler provider-result writes re-read core config for every D source and purge a removed account', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const source of ['slack', 'resend', 'whatsapp'] as const) {
    const stateDir = await shortTempDir(`events-d9-scheduler-${source}-`);
    const store = await openEventDatabase({ stateDir });
    try {
      const accountId = `d9-scheduler-${source}`;
      const scope = schedulerScope(source, accountId);
      installActiveScope(store, scope, ruleFor(source, accountId, `d9-scheduler-${source}`));
      store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1');
      store.database
        .prepare('INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES (?, ?, ?, ?, 0)')
        .run(scope.source, scope.accountId, scope.scopeId, source === 'slack' ? '1.000000' : 'empty');
      let current = config(source, accountId);
      const started = deferred<void>();
      const release = deferred<Readonly<{ retryAfterMs?: number }>>();
      const scheduler = new EventScheduler({
        store,
        lifecycle: new EventLifecycle(store, () => 1),
        activations: { resumeClaimedCompletions: async () => undefined } as never,
        dispatcher: { recoverLeases: async () => undefined } as never,
        expiry: { sweepAll: async () => undefined } as never,
        cipher: {} as never,
        approvals: {} as never,
        config: { load: async () => current } as never,
        taint: {} as never,
        gmailSourceFor: async () => {
          throw new Error('not Gmail');
        },
        sourceWorkFor: async () => {
          started.resolve();
          return release.promise;
        },
        mailboxLock: new MailboxLock(new SourceScopeLock()),
        sourceRegistry: phaseDSourceRegistry(),
        whatsappVisibilityFence: visibilityFence(store),
        now: () => 1,
      });
      const ticking = scheduler.tick();
      await started.promise;
      current = config(source, accountId, false);
      release.resolve({ retryAfterMs: 10 });
      await ticking;
      assert.equal(
        store.database.prepare('SELECT 1 FROM cursors WHERE source = ? AND account_id = ?').get(source, accountId),
        undefined,
      );
      assert.equal(
        store.database
          .prepare('SELECT 1 FROM rule_activation_points WHERE source = ? AND account_id = ?')
          .get(source, accountId),
        undefined,
      );
      assert.ok(store.database.prepare('SELECT 1 FROM account_revocations WHERE account_id = ?').get(accountId));
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('D9: evaluator decision commits re-read each D account after a held projection decryption and purge stale work', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const source of ['slack', 'resend', 'whatsapp'] as const) {
    const stateDir = await shortTempDir(`events-d9-evaluate-${source}-`);
    const store = await openEventDatabase({ stateDir });
    try {
      const accountId = `d9-evaluate-${source}`;
      const rule = ruleFor(source, accountId, `d9-evaluate-${source}`);
      const versions = new ImmutableVersions(store.database);
      versions.createTarget(target);
      versions.createRule(rule as never);
      store.database.exec(
        `UPDATE rule_versions
            SET state = 'active', approval_id = 'd9-approval', authorization_activation_id = 'd9-activation', activated_at = 1
          WHERE rule_id = '${rule.ruleId}' AND version = 1;
         INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
         VALUES ('rule', '${rule.ruleId}', 1, 'd9-activation', 1);`,
      );
      store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
      const event = eventFor(source, accountId);
      const eventId = `d9-event-${source}`;
      store.database
        .prepare(
          'INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1)',
        )
        .run(eventId, store.installationId, String(event.type), accountId, `dedupe-${source}`);
      let current = config(source, accountId);
      const decryptStarted = deferred<void>();
      const decrypt = deferred<Uint8Array>();
      const evaluator = new EventEvaluator({
        store,
        cipher: {
          encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
          decrypt: async () => {
            decryptStarted.resolve();
            return decrypt.promise;
          },
        } as never,
        config: { load: async () => current } as never,
        fence: async () => ({
          switchGeneration: 7,
          approvalId: 'approval',
          authorizationActivationId: 'activation',
          usedAt: 'now',
        }),
        taint: { record: async () => undefined },
        now: () => 2,
        newId: () => `d9-decision-${source}`,
      });
      const evaluating = evaluator.admit({ event, eventId, ruleId: rule.ruleId, ruleVersion: 1, stagedAt: 1 });
      await decryptStarted.promise;
      current = config(source, accountId, false);
      decrypt.resolve(Buffer.from(JSON.stringify({ event })));
      assert.equal(await evaluating, 'terminal');
      for (const table of ['ingest_rules', 'decisions', 'deliveries'] as const)
        assert.equal(
          store.database.prepare(`SELECT 1 FROM ${table}`).get(),
          undefined,
          `${source} left no stale ${table}`,
        );
      assert.ok(store.database.prepare('SELECT 1 FROM account_revocations WHERE account_id = ?').get(accountId));
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('D9: dry-run append re-reads each D account after local-record encryption and purges removed work', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const source of ['slack', 'resend', 'whatsapp'] as const) {
    const stateDir = await shortTempDir(`events-d9-dryrun-${source}-`);
    const store = await openEventDatabase({ stateDir });
    try {
      const accountId = `d9-dryrun-${source}`;
      const rule = ruleFor(source, accountId, `d9-dryrun-${source}`);
      const deliveryId = `d9-delivery-${source}`;
      const versions = new ImmutableVersions(store.database);
      versions.createTarget(target);
      versions.createRule(rule as never);
      store.database.exec(
        `UPDATE rule_versions
            SET state = 'active', approval_id = 'd9-approval', authorization_activation_id = 'd9-activation', activated_at = 1
          WHERE rule_id = '${rule.ruleId}' AND version = 1;
         INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
         VALUES ('rule', '${rule.ruleId}', 1, 'd9-activation', 1);`,
      );
      store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
      store.database
        .prepare(
          'INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1)',
        )
        .run(`d9-event-${source}`, store.installationId, rule.event.type, accountId, `dedupe-${source}`);
      store.database
        .prepare(
          "INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state) VALUES (?, ?, ?, ?, 1, 'matched', 1000, 'retained')",
        )
        .run(`d9-decision-${source}`, `d9-event-${source}`, accountId, rule.ruleId);
      const plaintext = Buffer.from(
        JSON.stringify({
          cloudEventBytes: '{"subject":"untrusted"}',
          untrusted: ['/subject'],
          representation: 'plain',
        }),
      );
      store.database
        .prepare(
          `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
            encrypted_record, expires_at, state, switch_generation)
           VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, 1000, 'queued', 7)`,
        )
        .run(
          deliveryId,
          `d9-decision-${source}`,
          accountId,
          rule.ruleId,
          'dryrun:d9-target:1',
          target.targetId,
          plaintext,
        );
      let current = config(source, accountId);
      const encrypted = deferred<Uint8Array>();
      const encryptedStarted = deferred<void>();
      const dispatcher = new DryRunDispatcher({
        store,
        cipher: {
          decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
          encrypt: async () => {
            encryptedStarted.resolve();
            return encrypted.promise;
          },
        },
        approvals: { get: async () => null },
        config: { load: async () => current } as never,
        fence: async () => ({
          switchGeneration: 7,
          approvalId: 'approval',
          authorizationActivationId: 'activation',
          usedAt: 'now',
        }),
        now: () => 2,
        whatsappVisibilityFence: visibilityFence(store),
      } as never);
      const dispatching = dispatcher.dispatch(deliveryId);
      await encryptedStarted.promise;
      current = config(source, accountId, false);
      encrypted.resolve(Buffer.from(plaintext));
      assert.deepEqual(await dispatching, { state: 'terminal', deliveryId });
      assert.equal(store.database.prepare('SELECT 1 FROM dryrun_log WHERE delivery_id = ?').get(deliveryId), undefined);
      assert.deepEqual(
        {
          ...(store.database
            .prepare('SELECT state, encrypted_record FROM deliveries WHERE id = ?')
            .get(deliveryId) as Record<string, unknown>),
        },
        { state: 'in-flight-at-account-removal', encrypted_record: null },
      );
      assert.ok(store.database.prepare('SELECT 1 FROM account_revocations WHERE account_id = ?').get(accountId));
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

function slackPage() {
  return {
    messages: [{ ts: '2.000000', threadTs: null, replyCount: 0, text: '<untrusted-content>late</untrusted-content>' }],
    nextCursor: null,
    retainedHistoryBoundary: false,
  };
}

function slackWorker(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  accountId: string,
  _conversationId: string,
  rules: () => readonly { ruleId: string; ruleVersion: number; ingestRetentionMs: number }[],
  source: { history(): Promise<ReturnType<typeof slackPage>> },
  encryptStage: (value: unknown) => Promise<Uint8Array> = async (value) => Buffer.from(JSON.stringify(value)),
) {
  return new SlackHistorySource({
    store,
    accountId,
    source,
    lock: new SourceScopeLock(),
    rules,
    admit: async () => 'terminal',
    encryptStage: (value) => encryptStage(value),
    decryptStage: async (value) => JSON.parse(Buffer.from(value).toString('utf8')),
    accountLive: async () => undefined,
    now: () => 1,
  });
}

function resendStatus(id: string) {
  return {
    id,
    lastEvent: 'sent',
    from: null,
    to: [],
    cc: [],
    bcc: [],
    subject: 'late',
    createdAt: '2026-10-09T00:00:00.000Z',
    scheduledAt: null,
    messageId: null,
  };
}

function resendState(anchorId: string) {
  return { anchorId, cycleHeadId: null, after: null, pagesScanned: 0, items: [] };
}

function visibilityFence(store: Awaited<ReturnType<typeof openEventDatabase>>): WhatsAppVisibilityFence {
  return new WhatsAppVisibilityFence({
    store,
    withCurrentEventVisibility: async (_input, work) =>
      work({ version: 1, digest: 'a'.repeat(64), seesMessage: () => true }),
  });
}

function schedulerScope(source: DSource, accountId: string): SourceScope {
  if (source === 'slack') return { source, accountId, scopeId: `slack:${accountId}:C-d9` };
  if (source === 'resend') return { source, accountId, scopeId: 'received' };
  return { source, accountId, scopeId: 'chat:chat@example.test' };
}

function installActiveScope(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  scope: SourceScope,
  rule: ReturnType<typeof ruleFor>,
): void {
  store.database
    .prepare(
      `INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, 'digest', 'active', 'approval', 'activation', 0)`,
    )
    .run(`${rule.ruleId}@1`, rule.ruleId, canonicalJson(rule));
  store.database
    .prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, ?, 0)",
    )
    .run(rule.ruleId, `activation-${rule.ruleId}`);
  store.database
    .prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, inherited_from_version_id, created_at)
       VALUES (?, ?, 1, ?, ?, ?, ?, NULL, 0)`,
    )
    .run(`activation-${rule.ruleId}`, rule.ruleId, scope.source, scope.accountId, scope.scopeId, Buffer.from('{}'));
}
