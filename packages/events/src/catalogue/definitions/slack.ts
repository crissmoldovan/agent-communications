import type { ObjectNode } from '../../schema/describe.ts';
import type { DefinitionInternal, SlackMessagePostedV1 } from '../types.ts';
import { ANY, array, common, define, nonEmpty, nullableString, optional, string } from './shared.ts';

const account = /^acc_[A-Z0-9]{16}$/u;
const slackTs = (): { kind: 'string'; pattern: RegExp } => ({ kind: 'string', pattern: /^[0-9]+\.[0-9]{6}$/u });

const root: ObjectNode = {
  kind: 'object',
  properties: {
    ...common('slack.message.posted', 'slack', account),
    workspaceId: nonEmpty(),
    ts: slackTs(),
    threadTs: { kind: 'nullable', of: slackTs() },
    channel: {
      kind: 'object',
      properties: {
        id: nonEmpty(),
        name: nullableString(),
        kind: { kind: 'enum', values: ['public_channel', 'private_channel', 'im', 'mpim'] },
      },
    },
    author: {
      kind: 'object',
      properties: {
        userId: optional(nonEmpty()),
        botId: optional(nonEmpty()),
        name: nullableString(),
        app: { kind: 'boolean' },
        external: { kind: 'boolean' },
      },
    },
    text: string(),
    truncated: { kind: 'boolean' },
    mismatch: { kind: 'boolean' },
    unrenderable: { kind: 'boolean' },
    editedTs: { kind: 'nullable', of: slackTs() },
    mentions: array(
      {
        kind: 'object',
        properties: {
          kind: { kind: 'enum', values: ['user', 'channel', 'usergroup'] },
          id: nonEmpty(),
          label: nullableString(),
        },
      },
      true,
    ),
    files: array({
      kind: 'object',
      properties: { id: nonEmpty(), name: nullableString(), mimeType: nullableString() },
    }),
  },
};

export const slackMessagePostedV1: DefinitionInternal<SlackMessagePostedV1, Record<string, never>> = define<
  SlackMessagePostedV1,
  Record<string, never>
>({
  type: 'slack.message.posted',
  version: 1,
  channel: 'slack',
  description: root,
  untrusted: [
    ['channel', 'name'],
    ['author', 'name'],
    ['text'],
    ['mentions', ANY, 'label'],
    ['files', ANY, 'name'],
    ['files', ANY, 'mimeType'],
  ],
  content: [['channel', 'name'], ['author', 'name'], ['text'], ['mentions', ANY, 'label'], ['files', ANY, 'name']],
  addresses: [],
  handles: [
    { pattern: ['channel', 'id'], workspace: ['workspaceId'] },
    { pattern: ['author', 'userId'], workspace: ['workspaceId'] },
    { pattern: ['author', 'botId'], workspace: ['workspaceId'] },
    { pattern: ['mentions', ANY, 'id'], workspace: ['workspaceId'] },
    { pattern: ['files', ANY, 'id'], workspace: ['workspaceId'] },
  ],
  formats: [
    { pattern: ['occurredAt'], format: 'date-time' },
    { pattern: ['observedAt'], format: 'date-time' },
  ],
  invariants: [{ rule: 'slack-ts-instant', pointers: ['/ts', '/occurredAt'] }],
  identityPointers: ['/channel/id', '/ts'],
  subject: (event) => `${event.channel.id}/${event.ts}`,
  dedupeKey: (event) => `${event.channel.id}/${event.ts}`,
  examples: [
    {
      id: '0123456789abcdef0123456789abcdef',
      type: 'slack.message.posted',
      version: 1,
      occurredAt: '2023-11-14T22:13:20.123456Z',
      observedAt: '2026-10-07T12:00:01Z',
      account: { name: 'Workspace', id: 'acc_ABCDEFGHIJKLMNOP', channel: 'slack' },
      workspaceId: 'T00000000',
      ts: '1700000000.123456',
      threadTs: null,
      channel: { id: 'C00000000', name: null, kind: 'public_channel' },
      author: { name: null, app: false, external: false },
      text: 'Hello',
      truncated: false,
      mismatch: false,
      unrenderable: false,
      editedTs: null,
      mentions: [],
      files: [],
    },
    {
      id: 'fedcba9876543210fedcba9876543210',
      type: 'slack.message.posted',
      version: 1,
      occurredAt: '2023-11-14T22:13:21Z',
      observedAt: '2026-10-07T12:00:02Z',
      account: { name: 'Workspace', id: 'acc_ABCDEFGHIJKLMNOP', channel: 'slack' },
      workspaceId: 'T00000000',
      ts: '1700000001.000000',
      threadTs: '1700000000.123456',
      channel: { id: 'C00000000', name: 'general', kind: 'public_channel' },
      author: { userId: 'U00000000', name: 'Person', app: false, external: false },
      text: 'Hello again',
      truncated: false,
      mismatch: false,
      unrenderable: false,
      editedTs: null,
      mentions: [{ kind: 'user', id: 'U00000000', label: 'Person' }],
      files: [{ id: 'F00000000', name: 'file.txt', mimeType: 'text/plain' }],
    },
  ],
});
