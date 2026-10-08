import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { createGmailEventSource } from '../src/operations/events.ts';
import { newHarness } from './support/harness.ts';

function hasBodyData(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasBodyData);
  if (typeof value !== 'object' || value === null) return false;
  return Object.entries(value).some(([key, child]) => key === 'data' || hasBodyData(child));
}

async function sourceForEvents(): Promise<{
  source: Awaited<ReturnType<typeof createGmailEventSource>>;
  harness: Awaited<ReturnType<typeof newHarness>>;
}> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'events-subject',
        email: 'events@example.test',
        profile: { historyId: 'baseline-202' },
        attachments: { 'event-attachment': 'not delivered by metadata' },
        messages: {
          message: {
            id: 'message',
            threadId: 'thread',
            labelIds: ['INBOX', 'Label_events'],
            internalDate: '1760000000000',
            payload: {
              partId: '',
              mimeType: 'multipart/mixed',
              headers: [
                { name: 'From', value: 'Sender <sender@example.test>' },
                { name: 'Subject', value: 'Event fixture' },
              ],
              parts: [
                {
                  partId: '0',
                  mimeType: 'text/plain',
                  body: { size: 13, data: Buffer.from('body data here').toString('base64url') },
                },
                {
                  partId: '1',
                  mimeType: 'application/octet-stream',
                  filename: 'event.bin',
                  body: { size: 31, attachmentId: 'event-attachment' },
                },
              ],
            },
          },
        },
      },
    ],
  });
  await harness.connectInbox({ alias: 'events', email: 'events@example.test', sub: 'events-subject' });
  const source = await createGmailEventSource({
    alias: 'events',
    context: new GmailContext({ core: harness.core, env: harness.env }),
  });
  return { source, harness };
}

test('events source baseline is exactly getProfile and does not scan or materialise mail', async () => {
  const { harness, source } = await sourceForEvents();
  const before = harness.google.requests.length;

  const profile = await source.getProfile();

  assert.equal(profile.historyId, 'baseline-202');
  const providerCalls = harness.google.requests.slice(before).filter((request) => request.path.startsWith('/gmail/'));
  assert.deepEqual(
    providerCalls.map((request) => request.path),
    ['/gmail/v1/users/me/profile'],
  );
});

test('events source keeps metadata body-free and reserves full and attachment reads for lazy materialisation', async () => {
  const { harness, source } = await sourceForEvents();

  const metadata = await source.getMessageMetadata('message');
  assert.equal(metadata.internalDate, '1760000000000');
  assert.deepEqual(metadata.labelIds, ['INBOX', 'Label_events']);
  assert.equal(metadata.payload?.headers?.[1]?.value, 'Event fixture');
  assert.equal(metadata.payload?.parts?.[1]?.body?.attachmentId, 'event-attachment');
  assert.equal(hasBodyData(metadata), false);

  const full = await source.getMessage('message');
  assert.equal(hasBodyData(full), true);
  assert.deepEqual(await source.getAttachment('message', 'event-attachment'), Buffer.from('not delivered by metadata'));

  const messageCalls = harness.google.requests.filter(
    (request) => request.path === '/gmail/v1/users/me/messages/message',
  );
  assert.equal(messageCalls.length, 2);
  assert.ok(messageCalls.some((request) => request.params.fields !== undefined));
  assert.ok(messageCalls.some((request) => request.params.format === 'full' && request.params.fields === undefined));
  assert.equal(
    harness.google.requests.filter(
      (request) => request.path === '/gmail/v1/users/me/messages/message/attachments/event-attachment',
    ).length,
    1,
  );
  await assert.rejects(
    source.getMessageMetadata('deleted'),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});

test('events source unit contract obtains its provider boundary from GmailContext without a daemon Google client', async () => {
  const calls: string[] = [];
  const transport = {
    alias: 'events',
    inboxId: 'events-inbox',
    getProfile: async () => {
      calls.push('profile');
      return { emailAddress: 'events@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '202' };
    },
    listHistory: async () => {
      calls.push('history');
      return { history: [], historyId: '202', nextPageToken: undefined };
    },
    getMessageMetadata: async () => {
      calls.push('metadata');
      return {};
    },
    getMessage: async () => {
      calls.push('full');
      return {};
    },
    getAttachment: async () => {
      calls.push('attachment');
      return Buffer.alloc(0);
    },
  };
  const context = {
    inbox: async (alias: string) => ({ alias, inbox: { id: 'events-inbox' } }),
    requireCapability: async () => calls.push('capability'),
    transport: async () => {
      calls.push('transport');
      return transport;
    },
  } as unknown as GmailContext;

  const source = await createGmailEventSource({ alias: 'events', context });
  assert.deepEqual(calls, ['capability', 'transport']);
  assert.equal((await source.getProfile()).historyId, '202');
  assert.deepEqual(calls, ['capability', 'transport', 'profile']);

  const sourceText = readFileSync(new URL('../src/operations/events.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(sourceText, /@googleapis\/|google-auth-library/);
});
