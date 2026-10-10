import type { ObjectNode } from '../../schema/describe.ts';
import { whatsappMessageKey } from '../keys.ts';
import type { DefinitionInternal, WhatsAppMessageReceivedV1 } from '../types.ts';
import { common, dateTime, define, integer, nonEmpty, nullableString } from './shared.ts';

const account = /^acc_[A-Z0-9]{16}$/u;
const kinds = [
  'text',
  'image',
  'video',
  'audio',
  'contact',
  'location',
  'group-event',
  'link',
  'document',
  'system',
  'gif',
  'waiting',
  'deleted',
  'sticker',
  'poll',
  'video-note',
  'call',
  'album',
  'unknown',
] as const;
const messageKind = (): {
  kind: 'union';
  of: readonly [{ kind: 'enum'; values: typeof kinds }, { kind: 'string'; pattern: RegExp }];
} => ({
  kind: 'union',
  of: [
    { kind: 'enum', values: kinds },
    { kind: 'string', pattern: /^unknown:[0-9]+$/u },
  ],
});

const root: ObjectNode = {
  kind: 'object',
  properties: {
    ...common('whatsapp.message.received', 'whatsapp', account),
    workspaceId: { kind: 'string', pattern: account },
    messageId: nonEmpty(),
    chat: {
      kind: 'object',
      properties: {
        id: nonEmpty(),
        name: nullableString(),
        kind: {
          kind: 'enum',
          values: ['direct', 'hidden-number', 'group', 'status', 'broadcast', 'channel', 'unknown'],
        },
      },
    },
    sender: { kind: 'object', properties: { id: nonEmpty(), name: nullableString() } },
    text: nullableString(),
    at: dateTime(),
    fromMe: { kind: 'const', value: false },
    kind: messageKind(),
    viewOnce: { kind: 'boolean' },
    groupEvent: { kind: 'nullable', of: integer() },
    media: {
      kind: 'nullable',
      of: {
        kind: 'object',
        properties: {
          type: messageKind(),
          mime: nullableString(),
          size: { kind: 'nullable', of: integer() },
          name: nullableString(),
        },
      },
    },
  },
};

const firstSender = '447700900002@s.whatsapp.net';

export const whatsappMessageReceivedV1: DefinitionInternal<WhatsAppMessageReceivedV1, Record<string, never>> = define<
  WhatsAppMessageReceivedV1,
  Record<string, never>
>({
  type: 'whatsapp.message.received',
  version: 1,
  channel: 'whatsapp',
  description: root,
  untrusted: [['chat', 'name'], ['sender', 'name'], ['text'], ['media', 'mime'], ['media', 'name']],
  content: [['chat', 'name'], ['sender', 'name'], ['text'], ['media', 'name']],
  addresses: [],
  handles: [
    { pattern: ['chat', 'id'], workspace: ['workspaceId'] },
    { pattern: ['sender', 'id'], workspace: ['workspaceId'] },
  ],
  formats: [
    { pattern: ['occurredAt'], format: 'date-time' },
    { pattern: ['observedAt'], format: 'date-time' },
    { pattern: ['at'], format: 'date-time' },
  ],
  invariants: [
    { rule: 'same-instant', pointers: ['/at', '/occurredAt'] },
    { rule: 'identical', pointers: ['/workspaceId', '/account/id'] },
    { rule: 'whatsapp-message-key', pointers: ['/messageId', '/sender/id'] },
  ],
  identityPointers: ['/chat/id', '/messageId'],
  subject: (event) => `${event.chat.id}/${event.messageId}`,
  dedupeKey: (event) => `${event.chat.id}/${event.messageId}`,
  examples: [
    {
      id: '0123456789abcdef0123456789abcdef',
      type: 'whatsapp.message.received',
      version: 1,
      occurredAt: '2026-10-07T12:00:00Z',
      observedAt: '2026-10-07T12:00:01Z',
      account: { name: 'Phone', id: 'acc_ABCDEFGHIJKLMNOP', channel: 'whatsapp' },
      workspaceId: 'acc_ABCDEFGHIJKLMNOP',
      messageId: whatsappMessageKey('447700900001@s.whatsapp.net', firstSender, 'stanza-1'),
      chat: { id: '447700900001@s.whatsapp.net', name: null, kind: 'direct' },
      sender: { id: firstSender, name: null },
      text: null,
      at: '2026-10-07T12:00:00Z',
      fromMe: false,
      kind: 'text',
      viewOnce: false,
      groupEvent: null,
      media: null,
    },
    {
      id: 'fedcba9876543210fedcba9876543210',
      type: 'whatsapp.message.received',
      version: 1,
      occurredAt: '2026-10-07T12:01:00Z',
      observedAt: '2026-10-07T12:01:01Z',
      account: { name: 'Phone', id: 'acc_ABCDEFGHIJKLMNOP', channel: 'whatsapp' },
      workspaceId: 'acc_ABCDEFGHIJKLMNOP',
      messageId: whatsappMessageKey('120363000000000@g.us', '447700900003@s.whatsapp.net', 'stanza-2'),
      chat: { id: 'group-display', name: 'Group', kind: 'group' },
      sender: { id: '447700900003@s.whatsapp.net', name: 'Person' },
      text: 'Hello',
      at: '2026-10-07T12:01:00Z',
      fromMe: false,
      kind: 'image',
      viewOnce: true,
      groupEvent: 0,
      media: { type: 'image', mime: 'image/jpeg', size: 1, name: 'image.jpg' },
    },
  ],
});
