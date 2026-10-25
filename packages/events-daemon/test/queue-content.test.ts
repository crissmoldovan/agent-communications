import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gmailMessageReceivedV1,
  type MappedClassification,
  slackMessagePostedV1,
  whatsappMessageReceivedV1,
} from '@agentcomms/events';
import { canonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { queueItemContent, queueItemLink } from '../src/domain/queue-target.ts';
import { prepareDeliveries } from '../src/runtime/deliveries.ts';

const DAY = 86_400_000;

const gmailEvent = {
  ...gmailMessageReceivedV1.examples[1],
  messageId: '18c0ffee0123abcd',
  from: { address: 'sender@example.test', name: 'A Sender' },
  subject: 'Quarterly numbers',
  snippet: 'snippet words',
  body: `${'x'.repeat(139)}😀 and the rest of a long body`,
} as Record<string, unknown>;

test('QUEUE-A: an item shows only fields its mapping includes, never fetching or adding one (Q4)', () => {
  const mapping = { who: { $path: '/from/address' }, s: { $path: '/subject' } };
  assert.deepEqual(
    queueItemContent({ eventType: 'gmail.message.received', mapping, event: gmailEvent as never, show: 'summary' }),
    {
      from: { address: 'sender@example.test' },
      subject: 'Quarterly numbers',
    },
  );
  const full = queueItemContent({
    eventType: 'gmail.message.received',
    mapping: { from: { $path: '/from' }, s: { $path: '/subject' }, b: { $path: '/body' }, id: { $path: '/messageId' } },
    event: gmailEvent as never,
    show: 'summary',
  });
  assert.deepEqual(full.from, { name: 'A Sender', address: 'sender@example.test' });
  assert.equal(Array.from(full.text ?? '').length, 140, 'first 140 characters, counted in code points');
  assert.ok(full.text?.endsWith('😀'), 'an astral character is never split');
  assert.deepEqual(full.link, { kind: 'gmail', messageId: '18c0ffee0123abcd' });
  const snippetOnly = queueItemContent({
    eventType: 'gmail.message.received',
    mapping: { from: { $path: '/from' }, s: { $path: '/subject' }, n: { $path: '/snippet' } },
    event: gmailEvent as never,
    show: 'summary',
  });
  assert.equal(snippetOnly.text, 'snippet words');
  assert.equal(snippetOnly.link, undefined, 'no link without its mapped id');
  const minimal = queueItemContent({
    eventType: 'gmail.message.received',
    mapping: { event: { $path: '' } },
    event: gmailEvent as never,
    show: 'minimal',
  });
  assert.deepEqual(minimal, {
    from: { name: 'A Sender', address: 'sender@example.test' },
    subject: 'Quarterly numbers',
  });
});

test('QUEUE-A: Slack and WhatsApp items keep their first words in place of a subject, and Slack links to its thread', () => {
  const slackEvent = {
    ...slackMessagePostedV1.examples[0],
    workspaceId: 'T0123ABCD',
    channel: { id: 'C0456EFGH', name: 'general', kind: 'public_channel' },
    threadTs: '1700000000.123456',
    author: { userId: 'U1', name: 'Poster', app: false, external: false },
    text: 'can someone look at this?',
  } as Record<string, unknown>;
  const mapping = {
    who: { $path: '/author/name' },
    text: { $path: '/text' },
    team: { $path: '/workspaceId' },
    channel: { $path: '/channel/id' },
    thread: { $path: '/threadTs' },
  };
  const summary = queueItemContent({
    eventType: 'slack.message.posted',
    mapping,
    event: slackEvent as never,
    show: 'summary',
  });
  assert.deepEqual(summary, {
    from: { name: 'Poster' },
    text: 'can someone look at this?',
    link: { kind: 'slack', workspaceId: 'T0123ABCD', channelId: 'C0456EFGH', threadTs: '1700000000.123456' },
  });
  assert.deepEqual(queueItemLink(summary.link), {
    kind: 'slack',
    url: 'https://app.slack.com/client/T0123ABCD/C0456EFGH/thread/C0456EFGH-1700000000.123456',
  });
  const minimal = queueItemContent({
    eventType: 'slack.message.posted',
    mapping,
    event: slackEvent as never,
    show: 'minimal',
  });
  assert.deepEqual(minimal, { from: { name: 'Poster' }, text: 'can someone look at this?' });

  const whatsappEvent = {
    ...whatsappMessageReceivedV1.examples[0],
    sender: { id: '447700900123@s.whatsapp.net', name: 'Friend' },
    text: 'see you at 6',
  } as Record<string, unknown>;
  assert.deepEqual(
    queueItemContent({
      eventType: 'whatsapp.message.received',
      mapping: { sender: { $path: '/sender' }, text: { $path: '/text' } },
      event: whatsappEvent as never,
      show: 'summary',
    }),
    { from: { name: 'Friend', address: '447700900123@s.whatsapp.net' }, text: 'see you at 6' },
  );
});

test("QUEUE-A: a Gmail link names the account the message arrived in, on Gmail's own web host only", () => {
  assert.deepEqual(queueItemLink({ kind: 'gmail', messageId: '18c0ffee0123abcd' }, 'me+work@example.test'), {
    kind: 'gmail',
    url: 'https://mail.google.com/mail/?authuser=me%2Bwork%40example.test#all/18c0ffee0123abcd',
  });
  assert.deepEqual(queueItemLink({ kind: 'gmail', messageId: '18c0ffee0123abcd' }), {
    kind: 'gmail',
    url: 'https://mail.google.com/mail/u/0/#all/18c0ffee0123abcd',
  });
  // An id that is not an id is never put into a link.
  const hostile = queueItemContent({
    eventType: 'gmail.message.received',
    mapping: { event: { $path: '' } },
    event: { ...gmailEvent, messageId: 'x/../../evil?y=1' } as never,
    show: 'summary',
  });
  assert.equal(hostile.link, undefined);
});

test('QUEUE-A: preparing a queue delivery encrypts its item content and the released flag, with no CloudEvent', async () => {
  const rule = canonicalFullRuleDocument({
    ruleId: 'rule-content',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: ['ibx_CONTENTCONTENT0'],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
    targets: [{ targetId: 'queue-content', version: 1, kind: 'queue', retentionMs: 7 * DAY, show: 'summary' }],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: {
      ingestMs: 7 * DAY,
      holdMs: 7 * DAY,
      deliveryMs: 7 * DAY,
      dryrunMs: DAY,
      sseReplayMs: 7 * DAY,
      deadLetterMs: 7 * DAY,
      decisionMetadataMs: 90 * DAY,
      queueMs: 7 * DAY,
    },
  });
  const sealed: Array<{ location: unknown; bytes: Buffer }> = [];
  const classification: MappedClassification = { untrusted: [], addresses: [], handles: [] };
  for (const released of [false, true]) {
    sealed.length = 0;
    const [delivery] = await prepareDeliveries({
      cipher: {
        async encrypt(location, bytes) {
          sealed.push({ location, bytes: Buffer.from(bytes) });
          return Buffer.from(bytes);
        },
        async decrypt() {
          throw new Error('never decrypts');
        },
      },
      definition: gmailMessageReceivedV1,
      event: gmailEvent,
      rule,
      classification,
      installationId: 'installation-1',
      createdAt: 1_000,
      newId: () => 'delivery-content',
      data: {},
      released,
    });
    assert.equal(delivery?.targetKey, 'queue:queue-content:1');
    assert.equal(delivery?.target.kind, 'queue');
    assert.equal(delivery?.cloudEventBytes, '');
    assert.equal(delivery?.expiresAt, 1_000 + 7 * DAY, 'the delivery keeps its ordinary delivery deadline');
    assert.deepEqual(sealed[0]?.location, {
      table: 'deliveries',
      column: 'encryptedRecord',
      key: [{ type: 'text', value: 'delivery-content' }],
    });
    assert.deepEqual(JSON.parse(sealed[0]?.bytes.toString('utf8') ?? '{}'), {
      kind: 'queue-item',
      item: { from: { name: 'A Sender', address: 'sender@example.test' }, subject: 'Quarterly numbers' },
      released,
    });
  }
});
