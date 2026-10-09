import { canonicalJson } from '../../json.ts';
import type { ObjectNode } from '../../schema/describe.ts';
import type {
  DefinitionInternal,
  GmailMessageLabelledV1,
  GmailMessageReceivedV1,
  GmailMessageSentV1,
} from '../types.ts';
import {
  ANY,
  address,
  array,
  common,
  dateTime,
  define,
  domain,
  integer,
  nonEmpty,
  nullableString,
  optional,
  riskFlags,
  string,
} from './shared.ts';

const inbox = /^ibx_[A-Z0-9]{16}$/u;

function messageRoot(type: 'gmail.message.received' | 'gmail.message.sent'): ObjectNode {
  return {
    kind: 'object',
    properties: {
      ...common(type, 'gmail', inbox),
      messageId: nonEmpty(),
      threadId: nonEmpty(),
      labels: array(nonEmpty(), true, true),
      from: { kind: 'nullable', of: address() },
      replyTo: array(address()),
      to: array(address()),
      cc: array(address()),
      subject: string(),
      snippet: string(),
      date: dateTime(),
      unread: { kind: 'boolean' },
      authentication: {
        kind: 'object',
        properties: {
          evaluatedBy: nullableString(),
          spf: nullableString(),
          dkim: nullableString(),
          dkimDomain: { kind: 'nullable', of: domain() },
          dmarc: nullableString(),
          aligned: { kind: 'nullable', of: { kind: 'boolean' } },
          ignoredHeaders: integer(),
        },
      },
      warnings: {
        kind: 'object',
        properties: {
          replyToDiffers: { kind: 'boolean' },
          replyToDomains: array(domain(), true, true),
          displayNameContainsOtherAddress: { kind: 'boolean' },
          fromDomain: { kind: 'nullable', of: domain() },
        },
      },
      hasAttachments: optional({ kind: 'boolean' }),
      attachments: optional(
        array({
          kind: 'object',
          properties: {
            name: string(),
            type: string(),
            size: integer(),
            inline: { kind: 'boolean' },
            riskFlags: riskFlags(),
          },
        }),
      ),
      body: optional(string()),
    },
  };
}

const metadata = {
  untrusted: [
    ['from', 'name'],
    ['replyTo', ANY, 'name'],
    ['to', ANY, 'name'],
    ['cc', ANY, 'name'],
    ['subject'],
    ['snippet'],
    ['attachments', ANY, 'name'],
    ['attachments', ANY, 'type'],
    ['body'],
  ],
  content: [
    ['from', 'name'],
    ['replyTo', ANY, 'name'],
    ['subject'],
    ['snippet'],
    ['attachments', ANY, 'name'],
    ['body'],
  ],
  addresses: [
    ['from', 'address'],
    ['replyTo', ANY, 'address'],
    ['to', ANY, 'address'],
    ['cc', ANY, 'address'],
  ],
  handles: [],
  formats: [
    { pattern: ['occurredAt'], format: 'date-time' },
    { pattern: ['observedAt'], format: 'date-time' },
    { pattern: ['date'], format: 'date-time' },
    { pattern: ['from', 'address'], format: 'email' },
    { pattern: ['replyTo', ANY, 'address'], format: 'email' },
    { pattern: ['to', ANY, 'address'], format: 'email' },
    { pattern: ['cc', ANY, 'address'], format: 'email' },
    { pattern: ['authentication', 'dkimDomain'], format: 'domain' },
    { pattern: ['warnings', 'replyToDomains', ANY], format: 'domain' },
    { pattern: ['warnings', 'fromDomain'], format: 'domain' },
  ],
} as const;

function messageExample<T extends 'gmail.message.received' | 'gmail.message.sent'>(
  type: T,
  maximal: boolean,
): T extends 'gmail.message.received' ? GmailMessageReceivedV1 : GmailMessageSentV1 {
  const event = {
    id: '0123456789abcdef0123456789abcdef',
    type,
    version: 1 as const,
    occurredAt: '2026-10-07T12:00:00Z',
    observedAt: '2026-10-07T12:00:01Z',
    account: { name: 'Inbox', id: 'ibx_ABCDEFGHIJKLMNOP', channel: 'gmail' as const },
    messageId: 'message-1',
    threadId: 'thread-1',
    labels: maximal ? ['INBOX', 'STARRED'] : [],
    from: maximal ? { address: 'sender@example.com', name: 'Sender' } : null,
    replyTo: [],
    to: [{ address: 'recipient@example.com', name: null }],
    cc: [],
    subject: 'Subject',
    snippet: 'Snippet',
    date: '2026-10-07T12:00:00Z',
    unread: true,
    authentication: {
      evaluatedBy: null,
      spf: null,
      dkim: null,
      dkimDomain: null,
      dmarc: null,
      aligned: null,
      ignoredHeaders: 0,
    },
    warnings: { replyToDiffers: false, replyToDomains: [], displayNameContainsOtherAddress: false, fromDomain: null },
    ...(maximal
      ? {
          hasAttachments: true,
          attachments: [{ name: 'file.txt', type: 'text/plain', size: 1, inline: false, riskFlags: [] }],
          body: 'Body',
        }
      : {}),
  };
  return event as unknown as T extends 'gmail.message.received' ? GmailMessageReceivedV1 : GmailMessageSentV1;
}

function messageDefinition<T extends 'gmail.message.received' | 'gmail.message.sent'>(
  type: T,
  suffix: 'received' | 'sent',
) {
  return define<
    T extends 'gmail.message.received' ? GmailMessageReceivedV1 : GmailMessageSentV1,
    { historyRecordId: string }
  >({
    type,
    version: 1,
    channel: 'gmail',
    description: messageRoot(type),
    ...metadata,
    invariants: [
      { rule: 'sorted-utf8', pattern: ['labels'] },
      { rule: 'sorted-utf8', pattern: ['attachments', ANY, 'riskFlags'] },
      { rule: 'sorted-utf8', pattern: ['warnings', 'replyToDomains'] },
      { rule: 'same-instant', pointers: ['/date', '/occurredAt'] },
    ],
    identityPointers: ['/messageId'],
    subject: (event) => event.messageId,
    dedupeKey: (event, staging) => {
      if (!/^[0-9]+$/u.test(staging.historyRecordId)) throw new Error('historyRecordId must be an unsigned decimal');
      return canonicalJson([staging.historyRecordId, event.messageId, suffix]);
    },
    examples: [messageExample(type, false), messageExample(type, true)],
  });
}

export const gmailMessageReceivedV1: DefinitionInternal<GmailMessageReceivedV1, { historyRecordId: string }> =
  messageDefinition('gmail.message.received', 'received');
export const gmailMessageSentV1: DefinitionInternal<GmailMessageSentV1, { historyRecordId: string }> =
  messageDefinition('gmail.message.sent', 'sent');

const labelledRoot: ObjectNode = {
  kind: 'object',
  properties: {
    ...common('gmail.message.labelled', 'gmail', inbox),
    messageId: nonEmpty(),
    threadId: nonEmpty(),
    added: array(nonEmpty(), true, true),
    removed: array(nonEmpty(), true, true),
  },
};

export const gmailMessageLabelledV1: DefinitionInternal<GmailMessageLabelledV1, { historyRecordId: string }> = define<
  GmailMessageLabelledV1,
  { historyRecordId: string }
>({
  type: 'gmail.message.labelled',
  version: 1,
  channel: 'gmail',
  description: labelledRoot,
  untrusted: [],
  content: [],
  addresses: [],
  handles: [],
  formats: [
    { pattern: ['occurredAt'], format: 'date-time' },
    { pattern: ['observedAt'], format: 'date-time' },
  ],
  invariants: [
    { rule: 'sorted-utf8', pattern: ['added'] },
    { rule: 'sorted-utf8', pattern: ['removed'] },
    { rule: 'non-empty-either', pointers: ['/added', '/removed'] },
    { rule: 'disjoint', pointers: ['/added', '/removed'] },
    { rule: 'identical', pointers: ['/occurredAt', '/observedAt'] },
  ],
  identityPointers: ['/messageId'],
  subject: (event) => event.messageId,
  dedupeKey: (event, staging) => {
    if (!/^[0-9]+$/u.test(staging.historyRecordId)) throw new Error('historyRecordId must be an unsigned decimal');
    return canonicalJson([staging.historyRecordId, event.messageId, 'labelled']);
  },
  examples: [
    {
      id: '0123456789abcdef0123456789abcdef',
      type: 'gmail.message.labelled',
      version: 1,
      occurredAt: '2026-10-07T12:00:00Z',
      observedAt: '2026-10-07T12:00:00Z',
      account: { name: 'Inbox', id: 'ibx_ABCDEFGHIJKLMNOP', channel: 'gmail' },
      messageId: 'message-1',
      threadId: 'thread-1',
      added: ['INBOX'],
      removed: [],
    },
    {
      id: 'fedcba9876543210fedcba9876543210',
      type: 'gmail.message.labelled',
      version: 1,
      occurredAt: '2026-10-07T12:01:00Z',
      observedAt: '2026-10-07T12:01:00Z',
      account: { name: 'Inbox', id: 'ibx_ABCDEFGHIJKLMNOP', channel: 'gmail' },
      messageId: 'message-2',
      threadId: 'thread-2',
      added: ['STARRED'],
      removed: ['INBOX'],
    },
  ],
});
