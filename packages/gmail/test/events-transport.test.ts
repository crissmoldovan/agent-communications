import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { type GmailTransport, GoogleGmailTransport } from '../src/gmail-api/transport.ts';
import { DRAFT_SEND_PATH } from './support/fake-google.ts';
import { newHarness } from './support/harness.ts';

async function transportForHistory(): Promise<{
  context: GmailContext;
  transport: GmailTransport;
  harness: Awaited<ReturnType<typeof newHarness>>;
}> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'events-subject',
        email: 'events@example.test',
        profile: { historyId: '102' },
        history: {
          pages: {
            first: {
              historyId: '101',
              nextPageToken: 'page-2',
              history: [
                {
                  id: '100',
                  messagesAdded: [{ message: { id: 'added-1', threadId: 'thread-1' } }],
                  labelsAdded: [{ message: { id: 'labelled-1' }, labelIds: ['Label_events'] }],
                  labelsRemoved: [],
                },
              ],
            },
            'page-2': {
              historyId: '102',
              history: [
                {
                  id: '101',
                  messagesAdded: [],
                  labelsAdded: [],
                  labelsRemoved: [{ message: { id: 'labelled-1' }, labelIds: ['Label_old'] }],
                },
              ],
            },
          },
        },
      },
    ],
  });
  await harness.connectInbox({ alias: 'events', email: 'events@example.test', sub: 'events-subject' });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  return { context, transport: await context.transport('events'), harness };
}

test('events transport lists specific Gmail history changes without a label filter across pages', async () => {
  const { harness, transport } = await transportForHistory();

  const first = await transport.listHistory({ historyId: '100' });
  const second = await transport.listHistory({ historyId: '100', pageToken: first.nextPageToken });

  assert.equal(first.historyId, '101');
  assert.equal(first.nextPageToken, 'page-2');
  assert.deepEqual(first.history[0]?.messagesAdded, [{ message: { id: 'added-1', threadId: 'thread-1' } }]);
  assert.deepEqual(first.history[0]?.labelsAdded, [{ message: { id: 'labelled-1' }, labelIds: ['Label_events'] }]);
  assert.deepEqual(second.history[0]?.labelsRemoved, [{ message: { id: 'labelled-1' }, labelIds: ['Label_old'] }]);
  assert.equal(second.historyId, '102');
  assert.equal(second.nextPageToken, undefined);
  assert.match(harness.google.url, /^http:\/\/127\.0\.0\.1:/);
  assert.equal(harness.google.requests.filter((request) => request.path === DRAFT_SEND_PATH).length, 0);

  const calls = harness.google.requests.filter((request) => request.path === '/gmail/v1/users/me/history');
  assert.deepEqual(
    calls.map((request) => request.params),
    [{ startHistoryId: '100' }, { startHistoryId: '100', pageToken: 'page-2' }],
  );
  assert.ok(calls.every((request) => request.params.labelId === undefined));
  assert.ok(calls.every((request) => request.path.startsWith('/gmail/')));
});

test('events transport maps an expired Gmail history cursor through the ordinary provider error path', async () => {
  const { harness, transport } = await transportForHistory();
  harness.google.failNext('/gmail/v1/users/me/history', 1, 404, 'notFound');

  await assert.rejects(
    transport.listHistory({ historyId: 'expired' }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});

test('events transport unit contract sends only the unfiltered cursor parameters and reduces specific arrays', async () => {
  const transport = new GoogleGmailTransport({
    tokens: {
      alias: 'events',
      inbox: { id: 'events-inbox' },
      accessToken: async () => ({ token: 'fake', expiresAt: 0, scopes: [] }),
      invalidate: () => undefined,
    } as never,
    endpoints: {
      authUrl: 'http://unused.invalid/auth',
      tokenUrl: 'http://unused.invalid/token',
      revokeUrl: 'http://unused.invalid/revoke',
      gmailRoot: 'http://unused.invalid/',
      peopleRoot: 'http://unused.invalid/',
    },
  });
  let request: Record<string, unknown> | undefined;
  transport.gmail = () =>
    ({
      users: {
        history: {
          list: async (options: Record<string, unknown>) => {
            request = options;
            return {
              data: {
                historyId: '102',
                history: [
                  {
                    id: '101',
                    messages: [{ id: 'generic-must-not-escape' }],
                    messagesAdded: [{ message: { id: 'added-1', threadId: 'thread-1' } }],
                    labelsAdded: [{ message: { id: 'labelled-1' }, labelIds: ['Label_events'] }],
                    labelsRemoved: [{ message: { id: 'labelled-1' }, labelIds: ['Label_old'] }],
                  },
                ],
              },
            };
          },
        },
      },
    }) as never;

  const page = await transport.listHistory({ historyId: '100', pageToken: 'page-2' });

  assert.deepEqual(request, { userId: 'me', startHistoryId: '100', pageToken: 'page-2' });
  assert.deepEqual(page, {
    historyId: '102',
    nextPageToken: undefined,
    history: [
      {
        id: '101',
        messagesAdded: [{ message: { id: 'added-1', threadId: 'thread-1' } }],
        labelsAdded: [{ message: { id: 'labelled-1' }, labelIds: ['Label_events'] }],
        labelsRemoved: [{ message: { id: 'labelled-1' }, labelIds: ['Label_old'] }],
      },
    ],
  });
});

test('events transport unit contract asks Gmail for metadata without body data', async () => {
  const transport = new GoogleGmailTransport({
    tokens: {
      alias: 'events',
      inbox: { id: 'events-inbox' },
      accessToken: async () => ({ token: 'fake', expiresAt: 0, scopes: [] }),
      invalidate: () => undefined,
    } as never,
    endpoints: {
      authUrl: 'http://unused.invalid/auth',
      tokenUrl: 'http://unused.invalid/token',
      revokeUrl: 'http://unused.invalid/revoke',
      gmailRoot: 'http://unused.invalid/',
      peopleRoot: 'http://unused.invalid/',
    },
  });
  let request: Record<string, unknown> | undefined;
  transport.gmail = () =>
    ({
      users: {
        messages: {
          get: async (options: Record<string, unknown>) => {
            request = options;
            return { data: { id: 'message' } };
          },
        },
      },
    }) as never;

  await transport.getMessageMetadata('message');

  assert.equal(request?.userId, 'me');
  assert.equal(request?.id, 'message');
  assert.equal(request?.format, 'full');
  assert.match(String(request?.fields), /labelIds,.*internalDate,.*headers/);
  assert.match(String(request?.fields), /body\/size,body\/attachmentId/);
  assert.doesNotMatch(String(request?.fields), /body\/data/);
});

test('events transport refuses a history page that omits a cursor or message id rather than inventing an empty one', async () => {
  const transportReturning = (data: Record<string, unknown>) => {
    const transport = new GoogleGmailTransport({
      tokens: {
        alias: 'events',
        inbox: { id: 'events-inbox' },
        accessToken: async () => ({ token: 'fake', expiresAt: 0, scopes: [] }),
        invalidate: () => undefined,
      } as never,
      endpoints: {
        authUrl: 'http://unused.invalid/auth',
        tokenUrl: 'http://unused.invalid/token',
        revokeUrl: 'http://unused.invalid/revoke',
        gmailRoot: 'http://unused.invalid/',
        peopleRoot: 'http://unused.invalid/',
      },
    });
    transport.gmail = () => ({ users: { history: { list: async () => ({ data }) } } }) as never;
    return transport;
  };
  const badData = (pattern: RegExp) => (error: unknown) =>
    error instanceof CommsError && error.code === 'BAD_DATA' && pattern.test(error.message);
  await assert.rejects(transportReturning({ history: [] }).listHistory({ historyId: '100' }), badData(/history id/));
  await assert.rejects(
    transportReturning({ historyId: '101', history: [{ id: '101', messagesAdded: [{ message: {} }] }] }).listHistory({
      historyId: '100',
    }),
    badData(/message id/),
  );
  await assert.rejects(
    transportReturning({
      historyId: '101',
      history: [{ id: '101', labelsAdded: [{ message: { threadId: 't' }, labelIds: ['L'] }] }],
    }).listHistory({ historyId: '100' }),
    badData(/message id/),
  );
  await assert.rejects(
    transportReturning({ historyId: '101', history: [{ messagesAdded: [] }] }).listHistory({ historyId: '100' }),
    badData(/history record id/),
  );
});
