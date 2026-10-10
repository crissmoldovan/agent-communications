import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, emptyConfig, type SecretStore } from '@agentcomms/core';
import {
  catalogueEntry,
  defaultCloudEventType,
  resendEmailReceivedV1,
  resendEmailStatusChangedV1,
  slackMessagePostedV1,
  whatsappMessageReceivedV1,
} from '@agentcomms/events';
import type { ResendEventReader } from '@agentcomms/resend';
import type { SlackEventSource } from '@agentcomms/slack';
import type { WhatsAppEventOperations } from '@agentcomms/whatsapp';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { minimiseProjection } from '../src/runtime/projections.ts';
import { runSourceOwnerWork } from '../src/runtime/source-owner-work.ts';
import type { SourceScope } from '../src/sources/contracts.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { phaseDSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-d-source-events', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const retention = {
  ingestMs: 604_800_000,
  holdMs: 604_800_000,
  deliveryMs: 604_800_000,
  dryrunMs: 86_400_000,
  sseReplayMs: 604_800_000,
  deadLetterMs: 604_800_000,
  decisionMetadataMs: 7_776_000_000,
};
const receivedId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const statusId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const listDigest = createHash('sha256').update('{"lists":"d-source-events"}').digest('hex');

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref) ?? false;
  }
  invalidate(): void {}
}

test('D7b: projections keep catalogue identity inputs while dropping unmapped Slack and Resend content', () => {
  const rule = (event: { type: string; version: number }) =>
    ({
      ruleId: `projection-${event.type}`,
      version: 1,
      source: { channel: event.type.split('.')[0], accountIds: ['acc_ABCDEFGHIJKLMNOP'], options: {} },
      event,
      condition: { path: '/id', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [target],
      subscribers: [],
      judges: [],
      deliveryRateCap: 10,
      retention,
    }) as never;

  const slack = minimiseProjection(rule({ type: slackMessagePostedV1.type, version: 1 }), {
    ...slackMessagePostedV1.examples[0],
    text: 'unmapped Slack body',
  });
  assert.deepEqual(slack.event.channel, { id: 'C00000000' });
  assert.equal(slack.event.ts, '1700000000.123456');
  assert.equal(Object.hasOwn(slack.event, 'text'), false, 'unmapped Slack content is not retained');

  const receivedExample = resendEmailReceivedV1.examples[1];
  assert.ok(receivedExample);
  const received = minimiseProjection(rule({ type: resendEmailReceivedV1.type, version: 1 }), {
    ...receivedExample,
    body: 'unmapped Resend body',
    bodyTruncated: false,
  });
  assert.equal(received.event.emailId, receivedExample.emailId);
  assert.equal(Object.hasOwn(received.event, 'body'), false, 'unmapped Resend content is not retained');

  const statusExample = resendEmailStatusChangedV1.examples[0];
  assert.ok(statusExample);
  const status = minimiseProjection(rule({ type: resendEmailStatusChangedV1.type, version: 1 }), {
    ...statusExample,
  });
  assert.equal(status.event.emailId, statusExample.emailId);
  assert.equal(status.event.previous, 'queued');
  assert.equal(status.event.current, 'sent');
  assert.equal(status.event.at, '2026-10-07T12:00:00Z');

  const whatsappExample = whatsappMessageReceivedV1.examples[0];
  assert.ok(whatsappExample);
  const whatsapp = minimiseProjection(rule({ type: whatsappMessageReceivedV1.type, version: 1 }), {
    ...whatsappExample,
  });
  assert.deepEqual(whatsapp.event.chat, { id: '447700900001@s.whatsapp.net' });
  assert.equal(whatsapp.event.messageId, whatsappExample.messageId);
});

test('D7b: a private Slack conversation reaches one validated dry-run delivery with its alias and real metadata', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_ABCDEFGHIJKLMNOP';
  const setup = await fixture({
    source: 'slack',
    accountId,
    ruleId: 'rule-slack-private',
    scopeId: `slack:${accountId}:G-private`,
  });
  try {
    const source = slackReader(accountId, { id: 'G-private', name: 'private-planning', kind: 'private_channel' });
    await run(setup, { source: 'slack', accountId, scopeId: `slack:${accountId}:G-private` }, { slack: source });
    await assertDelivered(setup, {
      type: 'slack.message.posted',
      subject: 'G-private/1760000000.000000',
      data: {
        accountName: 'events/slack',
        channel: { id: 'G-private', name: 'private-planning', kind: 'private_channel' },
      },
    });
  } finally {
    await setup.close();
  }
});

test('D7b: a Slack IM reaches one validated dry-run delivery with its real conversation kind', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_BCDEFGHIJKLMNOPQ';
  const setup = await fixture({
    source: 'slack',
    accountId,
    ruleId: 'rule-slack-im',
    scopeId: `slack:${accountId}:D-im`,
  });
  try {
    const source = slackReader(accountId, { id: 'D-im', name: null, kind: 'im' });
    await run(setup, { source: 'slack', accountId, scopeId: `slack:${accountId}:D-im` }, { slack: source });
    await assertDelivered(setup, {
      type: 'slack.message.posted',
      subject: 'D-im/1760000000.000000',
      data: { accountName: 'events/slack', channel: { id: 'D-im', name: null, kind: 'im' } },
    });
  } finally {
    await setup.close();
  }
});

test('B1: a Slack source resolved through a swapped alias is refused before a provider call or source write', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_CDEFGHIJKLMNOPQR';
  const scope: SourceScope = { source: 'slack', accountId, scopeId: `slack:${accountId}:C-identity` };
  const setup = await fixture({ source: 'slack', accountId, ruleId: 'rule-slack-identity', scopeId: scope.scopeId });
  try {
    let providerCalls = 0;
    const otherAccountId = 'acc_DEFGHIJKLMNOPQRS';
    const source: SlackEventSource = {
      accountId: otherAccountId,
      accountAlias: 'events/slack',
      workspaceId: 'T-other',
      conversation: async () => {
        providerCalls += 1;
        return { id: 'C-identity', name: null, kind: 'public_channel' };
      },
      history: async () => {
        providerCalls += 1;
        return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
      },
      replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
    };
    await assert.rejects(
      () => run(setup, scope, { slack: source }),
      (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'ACCOUNT_CHANGED',
    );
    assert.equal(providerCalls, 0, 'the other account has no provider call');
    assert.equal(count(setup, 'ingest'), 0, 'the other account has no occurrence or candidate write');
    assert.equal(
      setup.store.database.prepare('SELECT 1 FROM source_scan_state WHERE account_id = ?').get(otherAccountId),
      undefined,
      'the other account has no staged source state',
    );
    assert.equal(
      setup.store.database.prepare('SELECT 1 FROM cursors WHERE account_id = ?').get(otherAccountId),
      undefined,
      'the other account has no durable scan anchor',
    );
  } finally {
    await setup.close();
  }
});

test('P1: a reply to a recently observed Slack parent is admitted exactly once through the source owner', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_CDEFGHIJKLMNOPQR';
  const conversationId = 'C-recent-thread';
  const scope: SourceScope = { source: 'slack', accountId, scopeId: `slack:${accountId}:${conversationId}` };
  const setup = await fixture({ source: 'slack', accountId, ruleId: 'rule-slack-replies', scopeId: scope.scopeId });
  try {
    const parentTs = '1760000000.000000';
    const replyTs = '1760000001.000000';
    let replyCalls = 0;
    const source: SlackEventSource = {
      accountId,
      accountAlias: 'events/slack',
      workspaceId: 'T-d-source',
      conversation: async () => ({ id: conversationId, name: 'recent-thread', kind: 'private_channel' }),
      history: async () => ({
        messages: [slackEventMessage({ ts: parentTs, threadTs: null, replyCount: 1, text: 'parent' })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => {
        replyCalls += 1;
        return {
          messages: [slackEventMessage({ ts: replyTs, threadTs: parentTs, replyCount: 0, text: 'reply' })],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
    };

    await run(setup, scope, { slack: source });
    await run(setup, scope, { slack: source });

    assert.equal(replyCalls, 2, 'the second reconciliation starts from its durable reply watermark');
    assert.equal(count(setup, 'ingest'), 2, 'the parent and its reply are both durable source occurrences');
    assert.equal(count(setup, 'decisions'), 2, 'the reply is admitted once to the active rule version');
    assert.deepEqual(
      (
        setup.store.database.prepare('SELECT dedupe_key FROM ingest ORDER BY dedupe_key').all() as Array<{
          dedupe_key: string;
        }>
      ).map((row) => row.dedupe_key),
      [`${conversationId}/${parentTs}`, `${conversationId}/${replyTs}`],
      'the reply uses the ordinary Slack (conversationId, ts) identity',
    );
  } finally {
    await setup.close();
  }
});

test('P1: reconciliation drops a Slack parent after seven days and never infers its reply as new', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_DEFGHIJKLMNOPQRS';
  const conversationId = 'C-old-thread';
  const scope: SourceScope = { source: 'slack', accountId, scopeId: `slack:${accountId}:${conversationId}` };
  const setup = await fixture({ source: 'slack', accountId, ruleId: 'rule-slack-old-reply', scopeId: scope.scopeId });
  try {
    const parentTs = '1760000000.000000';
    let exposeReply = false;
    let replyCalls = 0;
    const source: SlackEventSource = {
      accountId,
      accountAlias: 'events/slack',
      workspaceId: 'T-d-source',
      conversation: async () => ({ id: conversationId, name: 'old-thread', kind: 'private_channel' }),
      history: async () => ({
        messages: [slackEventMessage({ ts: parentTs, threadTs: null, replyCount: 1, text: 'parent' })],
        nextCursor: null,
        retainedHistoryBoundary: false,
      }),
      replies: async () => {
        replyCalls += 1;
        return {
          messages: exposeReply
            ? [slackEventMessage({ ts: '1760704801.000000', threadTs: parentTs, replyCount: 0, text: 'old reply' })]
            : [],
          nextCursor: null,
          retainedHistoryBoundary: false,
        };
      },
    };

    await run(setup, scope, { slack: source });
    assert.equal(replyCalls, 1, 'the initially recent parent gets its bounded reconciliation');
    setup.advance(7 * 24 * 60 * 60 * 1_000 + 1);
    exposeReply = true;
    await run(setup, scope, { slack: source });

    assert.equal(replyCalls, 1, 'the expired parent is pruned before another provider replies call');
    assert.equal(count(setup, 'ingest'), 1, 'no reply to the old thread is inferred as a new occurrence');
    assert.equal(count(setup, 'decisions'), 1);
  } finally {
    await setup.close();
  }
});

test('D7b: a Resend received UUID reaches one validated dry-run delivery', { skip: WINDOWS_SKIP }, async () => {
  const accountId = 'acc_CDEFGHIJKLMNOPQR';
  const setup = await fixture({ source: 'resend', accountId, ruleId: 'rule-resend-received', scopeId: 'received' });
  try {
    const reader = resendReader({ received: true, status: 'sent' });
    await run(setup, { source: 'resend', accountId, scopeId: 'received' }, { resend: reader });
    await assertDelivered(setup, { type: 'resend.email.received', subject: receivedId, data: { constant: 'safe' } });
  } finally {
    await setup.close();
  }
});

test('D7b: a Resend sent status seeds, then emits its next observed UUID status change', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_DEFGHIJKLMNOPQRS';
  const setup = await fixture({ source: 'resend', accountId, ruleId: 'rule-resend-status', scopeId: 'status' });
  try {
    let status = 'sent';
    const reader = resendReader({
      received: false,
      get status() {
        return status;
      },
    });
    await run(setup, { source: 'resend', accountId, scopeId: 'status' }, { resend: reader });
    assert.equal(count(setup, 'decisions'), 0, 'the first status observation only seeds durable state');
    status = 'delivered';
    setup.advance(1);
    await run(setup, { source: 'resend', accountId, scopeId: 'status' }, { resend: reader });
    await assertDelivered(setup, {
      type: 'resend.email.status_changed',
      subject: statusId,
      data: { constant: 'safe' },
    });
  } finally {
    await setup.close();
  }
});

test('D7b: a WhatsApp group reaches one validated dry-run delivery with a catalogue chat kind', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_EFGHIJKLMNOPQRST';
  const chatJid = '120363000000000@g.us';
  const setup = await fixture({
    source: 'whatsapp',
    accountId,
    ruleId: 'rule-whatsapp-group',
    scopeId: `chat:${chatJid}`,
    chatJid,
  });
  try {
    await run(
      setup,
      { source: 'whatsapp', accountId, scopeId: `chat:${chatJid}` },
      { whatsapp: whatsappReader(accountId, chatJid, 'group') },
    );
    await assertDelivered(setup, {
      type: 'whatsapp.message.received',
      subject: `${chatJid}/["wa-msg","${chatJid}","447700900002@s.whatsapp.net","group-stanza"]`,
      data: { chatKind: 'group' },
    });
  } finally {
    await setup.close();
  }
});

test('D7b: a WhatsApp direct chat reaches one validated dry-run delivery with a catalogue chat kind', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_FGHIJKLMNOPQRSTU';
  const chatJid = '447700900001@s.whatsapp.net';
  const setup = await fixture({
    source: 'whatsapp',
    accountId,
    ruleId: 'rule-whatsapp-direct',
    scopeId: `chat:${chatJid}`,
    chatJid,
  });
  try {
    await run(
      setup,
      { source: 'whatsapp', accountId, scopeId: `chat:${chatJid}` },
      { whatsapp: whatsappReader(accountId, chatJid, 'direct') },
    );
    await assertDelivered(setup, {
      type: 'whatsapp.message.received',
      subject: `${chatJid}/["wa-msg","${chatJid}","447700900002@s.whatsapp.net","direct-stanza"]`,
      data: { chatKind: 'direct' },
    });
  } finally {
    await setup.close();
  }
});

test('P1: overlapping WhatsApp scopes admit a new chat tuple once to every matching rule whichever scope runs first', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const accountId = 'acc_GHIJKLMNOPQRSTUV';
  const chatJid = '447700900003@s.whatsapp.net';
  for (const firstScope of [`all-allowed`, `chat:${chatJid}`] as const) {
    await t.test(firstScope, async () => {
      const setup = await fixture({
        source: 'whatsapp',
        accountId,
        ruleId: 'rule-whatsapp-all',
        scopeId: firstScope,
        chatJid,
        whatsappRules: [
          { ruleId: 'rule-whatsapp-all', chats: 'all-allowed' },
          { ruleId: 'rule-whatsapp-chat', chats: [chatJid] },
        ],
      });
      try {
        const reader = whatsappReader(accountId, chatJid, 'direct');
        await run(setup, { source: 'whatsapp', accountId, scopeId: firstScope }, { whatsapp: reader });
        await run(
          setup,
          { source: 'whatsapp', accountId, scopeId: firstScope === 'all-allowed' ? `chat:${chatJid}` : 'all-allowed' },
          { whatsapp: reader },
        );
        assert.deepEqual(
          (
            setup.store.database
              .prepare('SELECT rule_id, rule_version FROM whatsapp_rule_admissions ORDER BY rule_id, rule_version')
              .all() as Array<{ rule_id: string; rule_version: number }>
          ).map((row) => ({ ...row })),
          [
            { rule_id: 'rule-whatsapp-all', rule_version: 1 },
            { rule_id: 'rule-whatsapp-chat', rule_version: 1 },
          ],
        );
      } finally {
        await setup.close();
      }
    });
  }
});

test('P1: a WhatsApp tuple present at one rule activation point is admitted only to the rule whose point follows it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'acc_HIJKLMNOPQRSTUVW';
  const chatJid = '447700900004@s.whatsapp.net';
  const messageId = `["wa-msg","${chatJid}","447700900002@s.whatsapp.net","direct-stanza"]`;
  const setup = await fixture({
    source: 'whatsapp',
    accountId,
    ruleId: 'rule-whatsapp-all-before',
    scopeId: `chat:${chatJid}`,
    chatJid,
    whatsappRules: [
      { ruleId: 'rule-whatsapp-all-before', chats: 'all-allowed' },
      { ruleId: 'rule-whatsapp-chat-after', chats: [chatJid] },
    ],
    whatsappBaselineIdentities: { [`chat:${chatJid}`]: [messageId] },
  });
  try {
    await run(
      setup,
      { source: 'whatsapp', accountId, scopeId: `chat:${chatJid}` },
      { whatsapp: whatsappReader(accountId, chatJid, 'direct') },
    );
    assert.deepEqual(
      (
        setup.store.database.prepare('SELECT rule_id FROM whatsapp_rule_admissions ORDER BY rule_id').all() as Array<{
          rule_id: string;
        }>
      ).map((row) => row.rule_id),
      ['rule-whatsapp-all-before'],
    );
  } finally {
    await setup.close();
  }
});

type FixtureSource = 'slack' | 'resend' | 'whatsapp';

async function fixture(input: {
  source: FixtureSource;
  accountId: string;
  ruleId: string;
  scopeId: string;
  chatJid?: string;
  whatsappRules?: readonly Readonly<{ ruleId: string; chats: 'all-allowed' | readonly string[] }>[];
  whatsappBaselineIdentities?: Readonly<Record<string, readonly string[]>>;
}) {
  const root = await shortTempDir(`aev-d-source-${input.source}-`);
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const now = { value: Date.parse('2026-10-09T12:00:00.000Z') };
  const config = emptyConfig();
  config.accounts[`events/${input.source}`] = { id: input.accountId, platform: input.source } as never;
  const store = await openEventDatabase({ stateDir });
  await selectEventSecretStore(store.database, 'file');
  const secrets = await openEventSecretStore({
    database: store.database,
    paths: store.paths,
    configDir,
    stores: { file: new MemorySecretStore() },
  });
  const cipher = new EventRecordCipher(store.database, secrets);
  const approvals = new ApprovalStore(join(root, 'approvals'), {
    now: () => new Date(now.value),
    loadConfig: async () => config,
  });
  let intent = 0;
  const runtime = new ActivationRuntime({
    store,
    approvals,
    config: { load: async () => config } as never,
    sourceRegistry: phaseDSourceRegistry(),
    mailboxLock: new MailboxLock(new SourceScopeLock()),
    now: () => now.value,
    newIntentId: () => `activation-d-source-${++intent}`,
    gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '1' }) }) as never,
    sourceBaselineFor: async (scope) => {
      if (scope.source === 'slack')
        return { timestamp: '1759999999.000000', replyDrain: { through: '1759999999.000000' } };
      if (scope.source === 'resend')
        return scope.scopeId === 'received' ? { anchorId: 'empty' } : { startedAt: new Date(now.value).toISOString() };
      return {
        capturedAt: new Date(now.value).toISOString(),
        baselineGeneration: 0,
        baselineIdentities: input.whatsappBaselineIdentities?.[scope.scopeId] ?? [],
      };
    },
    encryptBaseline: async (_intent, _account, position) => Buffer.from(JSON.stringify(position)),
    decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
    encryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, position }) =>
      cipher.encrypt(
        ruleActivationPointLocation(activationId, ruleId, ruleVersion, accountId, positionScope),
        Buffer.from(JSON.stringify(position)),
      ),
    decryptPoint: async ({ activationId, ruleId, ruleVersion, accountId, positionScope, stored }) =>
      JSON.parse(
        (
          await cipher.decrypt(
            ruleActivationPointLocation(activationId, ruleId, ruleVersion, accountId, positionScope),
            stored,
          )
        ).toString('utf8'),
      ),
  });
  const options =
    input.source === 'slack'
      ? { channel: 'slack' as const, conversations: [input.scopeId.slice(`slack:${input.accountId}:`.length)] }
      : input.source === 'resend'
        ? { channel: 'resend' as const, kinds: [input.scopeId] }
        : { channel: 'whatsapp' as const, chats: [input.chatJid as string] };
  const event =
    input.source === 'slack'
      ? 'slack.message.posted'
      : input.source === 'resend'
        ? input.scopeId === 'received'
          ? 'resend.email.received'
          : 'resend.email.status_changed'
        : 'whatsapp.message.received';
  const mapping =
    input.source === 'slack'
      ? {
          accountName: { $path: '/account/name' },
          channel: { $path: '/channel' },
        }
      : input.source === 'whatsapp'
        ? { chatKind: { $path: '/chat/kind' } }
        : { constant: 'safe' };
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  const ruleInputs =
    input.source === 'whatsapp' && input.whatsappRules !== undefined
      ? input.whatsappRules.map((rule) => ({
          ruleId: rule.ruleId,
          options: { channel: 'whatsapp' as const, chats: rule.chats },
        }))
      : [{ ruleId: input.ruleId, options }];
  for (const ruleInput of ruleInputs) {
    versions.createRule({
      ruleId: ruleInput.ruleId,
      version: 1,
      source: { channel: input.source, accountIds: [input.accountId], options: ruleInput.options },
      event: { type: event, version: 1 },
      condition: { path: '/id', op: 'exists' },
      mapping,
      targets: [target],
      subscribers: [],
      judges: [],
      deliveryRateCap: 60,
      retention,
    });
    const preparedRule = await runtime.prepareRule({ ruleId: ruleInput.ruleId, version: 1 });
    if (!('approvalId' in preparedRule)) throw new Error('a first rule activation must require approval');
    await approve(runtime, preparedRule);
  }
  await approve(runtime, await runtime.prepareEnableAll());
  if (input.source === 'slack') {
    // The production scheduler installs this approved activation point before the source's first turn.
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('slack', ?, ?, '1759999999.000000', ?)",
      )
      .run(input.accountId, input.scopeId, now.value);
  }
  if (input.source === 'resend' && input.scopeId === 'received') {
    // The production scheduler installs this approved activation point before the source's first turn.
    store.database
      .prepare(
        "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('resend', ?, 'received', 'empty', ?)",
      )
      .run(input.accountId, now.value);
  }
  const whatsappOperations: WhatsAppEventOperations = {
    withCurrentEventVisibility: async (_input, work) =>
      work({ version: 1, digest: listDigest, seesMessage: () => true }),
    withEventSnapshot: async (_input, work) =>
      work({
        accountId: input.accountId,
        accountName: 'events/whatsapp',
        visibility: { version: 1, digest: listDigest, seesMessage: () => true },
        messages: [],
      }),
  };
  const whatsapp = createPhaseDWhatsAppOwnerComposition({ database: store, eventOperations: whatsappOperations });
  return {
    root,
    store,
    cipher,
    config,
    approvals,
    now,
    advance: (milliseconds: number) => (now.value += milliseconds),
    whatsappOperations,
    whatsappFence: whatsapp.visibilityFence,
    close: async () => {
      store.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function approve(runtime: ActivationRuntime, prepared: PreparedActivation): Promise<void> {
  await runtime.approve({ approvalId: prepared.approvalId, answer: await runtime.issueChallenge(prepared.approvalId) });
}

function slackReader(
  accountId: string,
  conversation: {
    id: string;
    name: string | null;
    kind: 'private_channel' | 'im';
  },
): SlackEventSource {
  return {
    accountId,
    accountAlias: 'events/slack',
    workspaceId: 'T-d-source',
    conversation: async () => conversation,
    history: async () => ({
      messages: [
        {
          ts: '1760000000.000000',
          threadTs: null,
          replyCount: 0,
          text: '<untrusted-content>source event</untrusted-content>',
          author: { name: null, app: false, external: false },
          truncated: false,
          mismatch: false,
          unrenderable: false,
          editedTs: null,
          mentions: [],
          files: [],
        },
      ],
      nextCursor: null,
      retainedHistoryBoundary: false,
    }),
    replies: async () => ({ messages: [], nextCursor: null, retainedHistoryBoundary: false }),
  };
}

function slackEventMessage(input: {
  readonly ts: string;
  readonly threadTs: string | null;
  readonly replyCount: number;
  readonly text: string;
}) {
  return {
    ...input,
    text: `<untrusted-content>${input.text}</untrusted-content>`,
    author: { name: null, app: false, external: false },
    truncated: false,
    mismatch: false,
    unrenderable: false,
    editedTs: null,
    mentions: [],
    files: [],
  };
}

function resendReader(input: { received: boolean; readonly status: string }): ResendEventReader {
  return {
    listReceived: async () => ({ emails: input.received ? [{ id: receivedId }] : [], next: null }),
    getReceived: async () => ({
      kind: 'candidate',
      candidate: {
        emailId: receivedId,
        receivedAt: '2026-10-09T12:00:00.000Z',
        subject: 'received event',
        attachments: [],
        attachmentCount: 0,
        from: null,
        replyTo: [],
        to: [],
        cc: [],
        receivedFor: [],
        messageId: null,
        authentication: { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
      },
    }),
    listSent: async () => ({
      emails: [
        {
          id: statusId,
          lastEvent: input.status,
          from: null,
          to: [],
          cc: [],
          bcc: [],
          subject: 'status event',
          createdAt: '2026-10-09T12:00:00.000Z',
          scheduledAt: null,
          messageId: null,
        },
      ],
      next: null,
    }),
  };
}

function whatsappReader(accountId: string, chatJid: string, kind: 'group' | 'direct'): WhatsAppEventOperations {
  const visibility = { version: 1 as const, digest: listDigest, seesMessage: () => true };
  return {
    withCurrentEventVisibility: async (_input, work) => work(visibility),
    withEventSnapshot: async (_input, work) =>
      work({
        accountId,
        accountName: 'events/whatsapp',
        visibility,
        messages: [
          {
            sourceOrder: 1,
            chatJid,
            chatKind: kind,
            senderJidRaw: '447700900002@s.whatsapp.net',
            stanzaId: kind === 'group' ? 'group-stanza' : 'direct-stanza',
            fromMe: false,
            at: '2026-10-09T12:00:00.000Z',
            kind: 'text',
            body: 'source event',
          },
        ],
      }),
  };
}

async function run(
  setup: Awaited<ReturnType<typeof fixture>>,
  scope: SourceScope,
  readers: { slack?: SlackEventSource; resend?: ResendEventReader; whatsapp?: WhatsAppEventOperations },
): Promise<void> {
  await runSourceOwnerWork(
    {
      store: setup.store,
      cipher: setup.cipher,
      approvals: setup.approvals,
      config: { load: async () => setup.config } as never,
      taint: { record: async () => undefined } as never,
      lifecycle: {} as never,
      sourceRegistry: phaseDSourceRegistry(),
      slackSourceFor: async () => readers.slack as SlackEventSource,
      resendReaderFor: async () => readers.resend as ResendEventReader,
      whatsappEventOperations: readers.whatsapp ?? setup.whatsappOperations,
      whatsappVisibilityFence: setup.whatsappFence,
      now: () => setup.now.value,
    },
    scope,
  );
}

async function assertDelivered(
  setup: Awaited<ReturnType<typeof fixture>>,
  expected: { type: string; subject: string; data: unknown },
): Promise<void> {
  // admitEvent calls @agentcomms/events validateEvent before it writes ingest; the persisted row proves that the
  // actual source fact (rather than a test-side reconstruction) crossed that catalogue gate.
  assert.equal(count(setup, 'ingest'), 1, 'the actual source fact passes its @agentcomms/events catalogue validation');
  assert.equal(count(setup, 'decisions'), 1, 'the source candidate creates exactly one decision');
  const delivery = setup.store.database.prepare('SELECT id FROM deliveries').get() as { id: string } | undefined;
  assert.ok(delivery, 'the matched decision creates one dry-run delivery');
  assert.equal(count(setup, 'deliveries'), 1);
  const dispatcher = new DryRunDispatcher({
    store: setup.store,
    cipher: setup.cipher,
    approvals: setup.approvals,
    config: { load: async () => setup.config } as never,
    now: () => setup.now.value,
    whatsappVisibilityFence: setup.whatsappFence,
  });
  assert.deepEqual(await dispatcher.dispatch(delivery.id), { state: 'delivered', deliveryId: delivery.id });
  assert.equal(dispatcher.list().length, 1, 'exactly one local dry-run record is retained');
  const cloud = JSON.parse((await dispatcher.read(delivery.id)).record.cloudEventBytes) as Record<string, unknown>;
  const definition = catalogueEntry(expected.type, 1);
  assert.equal(definition.ok, true, 'the catalogue has the emitted source type');
  if (!definition.ok) throw new Error('unreachable');
  assert.equal(cloud.specversion, '1.0');
  assert.equal(cloud.type, defaultCloudEventType(definition.value));
  assert.equal(cloud.subject, expected.subject);
  assert.deepEqual(cloud.data, expected.data);
}

function count(setup: Awaited<ReturnType<typeof fixture>>, table: 'ingest' | 'decisions' | 'deliveries'): number {
  return (setup.store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
}

function ruleActivationPointLocation(
  activationId: string,
  ruleId: string,
  ruleVersion: number,
  accountId: string,
  positionScope: string,
) {
  return {
    table: 'rule_activation_points',
    column: 'encryptedPosition',
    key: [
      { type: 'text' as const, value: activationId },
      { type: 'text' as const, value: ruleId },
      { type: 'integer' as const, value: ruleVersion },
      { type: 'text' as const, value: accountId },
      { type: 'text' as const, value: positionScope },
    ],
  };
}
