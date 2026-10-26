import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import {
  gmailMessageLabelledV1,
  gmailMessageReceivedV1,
  gmailMessageSentV1,
  resendEmailReceivedV1,
  resendEmailStatusChangedV1,
  slackMessagePostedV1,
  whatsappMessageReceivedV1,
} from '@agentcomms/events';
import { parseEventSource } from '../src/runtime/event-source.ts';

/**
 * An event's source ids, read back from its ingest `dedupe_key` (0.32.0 spec §3.5, §3.6): the ids the app joins on and
 * links with, and nothing else. Each key is made here by the catalogue's own `dedupeKey`, so the parser reads exactly
 * what ingest stores.
 */

const EMAIL_ID = '4ef9a417-02e9-4d39-ad75-9611e0fcc33c';

test('SRC: Gmail’s key is ["<historyId>","<messageId>","<kind>"], and its source is the message id', () => {
  for (const [definition, type] of [
    [gmailMessageReceivedV1, 'gmail.message.received'],
    [gmailMessageSentV1, 'gmail.message.sent'],
    [gmailMessageLabelledV1, 'gmail.message.labelled'],
  ] as const) {
    const key = definition.dedupeKey({ messageId: '18c2f0a1b2c3d4e5' } as never, { historyRecordId: '987654' });
    assert.equal(key, canonicalJson(['987654', '18c2f0a1b2c3d4e5', type.split('.')[2]]));
    assert.deepEqual(parseEventSource(type, key), { channel: 'gmail', messageId: '18c2f0a1b2c3d4e5' });
  }
});

test('SRC: Slack’s key is <channelId>/<ts>; WhatsApp’s <chatId>/<messageId>; Resend’s the email id', () => {
  const slack = slackMessagePostedV1.dedupeKey(
    { channel: { id: 'C0123ABCD' }, ts: '1730000000.123456' } as never,
    {} as never,
  );
  assert.equal(slack, 'C0123ABCD/1730000000.123456');
  assert.deepEqual(parseEventSource('slack.message.posted', slack), {
    channel: 'slack',
    channelId: 'C0123ABCD',
    ts: '1730000000.123456',
  });
  const whatsapp = whatsappMessageReceivedV1.dedupeKey(
    { chat: { id: '447700900123@s.whatsapp.net' }, messageId: '3EB0C767D82B6E2A5F1C' } as never,
    {} as never,
  );
  assert.deepEqual(parseEventSource('whatsapp.message.received', whatsapp), {
    channel: 'whatsapp',
    chatId: '447700900123@s.whatsapp.net',
    messageId: '3EB0C767D82B6E2A5F1C',
  });
  const received = resendEmailReceivedV1.dedupeKey({ emailId: EMAIL_ID } as never, {} as never);
  assert.deepEqual(parseEventSource('resend.email.received', received), { channel: 'resend', emailId: EMAIL_ID });
  const status = resendEmailStatusChangedV1.dedupeKey(
    { emailId: EMAIL_ID, previous: 'sent', current: 'delivered', at: '2026-10-26T12:00:00Z' } as never,
    {} as never,
  );
  assert.deepEqual(parseEventSource('resend.email.status_changed', status), { channel: 'resend', emailId: EMAIL_ID });
});

test('SRC: a key that is not exactly its type’s shape gives null, never a guess', () => {
  for (const [type, key] of [
    ['gmail.message.received', '987654,18c2f0a1b2c3d4e5'],
    ['gmail.message.received', canonicalJson(['987654', '18c2f0a1b2c3d4e5', 'sent'])],
    ['gmail.message.received', canonicalJson(['x', '18c2f0a1b2c3d4e5', 'received'])],
    ['gmail.message.received', canonicalJson(['987654', '', 'received'])],
    ['gmail.message.received', canonicalJson(['987654', 'a b', 'received'])],
    ['gmail.message.received', canonicalJson(['987654', '18c2f0a1b2c3d4e5'])],
    ['gmail.message.received', '["987654",'],
    ['slack.message.posted', 'C0123ABCD'],
    ['slack.message.posted', 'C0123ABCD/1730000000'],
    ['slack.message.posted', '/1730000000.123456'],
    ['whatsapp.message.received', 'only-a-chat'],
    ['whatsapp.message.received', 'a/b/c'],
    ['whatsapp.message.received', '/3EB0C767D82B6E2A5F1C'],
    ['resend.email.received', 'not-a-uuid'],
    ['resend.email.status_changed', EMAIL_ID],
    ['slack.reaction.added', 'C0123ABCD/1730000000.123456'],
    ['example.event', 'anything'],
    ['gmail.message.received', `["1","${'m'.repeat(600)}","received"]`],
  ] as const)
    assert.equal(parseEventSource(type, key), null, `${type} ${key.slice(0, 40)}`);
});
