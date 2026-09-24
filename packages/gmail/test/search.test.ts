import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { search } from '../src/operations/search.ts';
import type { FakeAccount, FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './support/harness.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** A message with just enough for a search row. */
function message(options: {
  id: string;
  threadId?: string;
  at: string;
  from: string;
  subject: string;
  snippet?: string;
  labels?: string[];
  withAttachment?: boolean;
}): FakeMessage {
  return {
    id: options.id,
    threadId: options.threadId ?? options.id,
    labelIds: options.labels ?? ['INBOX'],
    snippet: options.snippet ?? '',
    internalDate: String(Date.parse(options.at)),
    payload: {
      partId: '',
      mimeType: options.withAttachment ? 'multipart/mixed' : 'text/html',
      headers: [
        { name: 'From', value: options.from },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: options.subject },
      ],
      ...(options.withAttachment
        ? {
            parts: [
              { partId: '0', mimeType: 'text/html', body: { size: 3, data: base64url('<p>x</p>') } },
              {
                partId: '1',
                mimeType: 'application/pdf',
                filename: 'invoice.pdf',
                headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
                body: { size: 10, attachmentId: 'att-1' },
              },
            ],
          }
        : { body: { size: 3, data: base64url('<p>x</p>') } }),
    },
  };
}

/** A harness with one or more signed-in mailboxes, each holding its own messages. */
async function connected(
  accounts: Array<{ alias: string; email: string; sub: string; messages: Record<string, FakeMessage> }>,
): Promise<{
  harness: Harness;
  context: GmailContext;
}> {
  const harness = await newHarness({
    accounts: accounts.map(
      (account): FakeAccount => ({ sub: account.sub, email: account.email, messages: account.messages }),
    ),
  });
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  for (const account of accounts) {
    const pkce = newPkce();
    const authUrl = buildAuthUrl({
      client,
      endpoints: harness.endpoints,
      redirectUri: 'http://127.0.0.1:5123/',
      scopes: [SCOPES.gmailModify],
      state: 'st',
      codeChallenge: pkce.challenge,
    });
    const code = new URL(harness.google.consent(authUrl, { sub: account.sub })).searchParams.get('code') ?? '';
    const tokens = await exchangeCode({
      client,
      endpoints: harness.endpoints,
      code,
      codeVerifier: pkce.verifier,
      redirectUri: 'http://127.0.0.1:5123/',
    });
    await harness.addInbox({
      alias: account.alias,
      email: account.email,
      sub: account.sub,
      refreshToken: tokens.refreshToken,
      grantedScopes: [SCOPES.gmailModify],
    });
  }
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }) };
}

test('results from several mailboxes arrive as one list, newest first', async () => {
  const { context } = await connected([
    {
      alias: 'work',
      email: 'jo@example.test',
      sub: 'sub-1',
      messages: {
        w1: message({ id: 'w1', at: '2026-09-15T09:00:00Z', from: 'sam@partner.test', subject: 'Plan' }),
        w2: message({ id: 'w2', at: '2026-09-17T09:00:00Z', from: 'sam@partner.test', subject: 'Plan again' }),
      },
    },
    {
      alias: 'home',
      email: 'jo.home@example.test',
      sub: 'sub-2',
      messages: {
        h1: message({ id: 'h1', at: '2026-09-16T09:00:00Z', from: 'club@local.test', subject: 'Plan for Saturday' }),
      },
    },
  ]);

  const result = await search(context, { query: 'plan', inboxes: 'all' });
  assert.deepEqual(
    result.rows.map((row) => `${row.inbox}:${row.messageId}`),
    ['work:w2', 'home:h1', 'work:w1'],
    'merged by date across mailboxes, not grouped by mailbox',
  );
  assert.equal(result.complete, true);
  assert.deepEqual(result.errors, []);
  assert.equal(result.returned, 3);
  assert.equal(result.hasMore, false);
  assert.equal(result.nextCursor, undefined);
  assert.deepEqual(result.inboxes, ['home', 'work']);
});

test('the compiled query is what reaches Gmail, and is reported back', async () => {
  const { harness, context } = await connected([
    {
      alias: 'work',
      email: 'jo@example.test',
      sub: 'sub-1',
      messages: {
        w1: message({ id: 'w1', at: '2026-09-15T09:00:00Z', from: 'sam@partner.test', subject: 'Old' }),
        w2: message({ id: 'w2', at: '2026-09-18T09:00:00Z', from: 'sam@partner.test', subject: 'New' }),
      },
    },
  ]);

  const result = await search(context, { query: 'after:2026-09-17', inboxes: ['work'] });
  assert.equal(result.query.given, 'after:2026-09-17');
  assert.match(result.query.compiled, /^after:\d+$/);
  assert.equal(result.query.rewrites.length, 1);
  assert.deepEqual(
    result.rows.map((row) => row.messageId),
    ['w2'],
    'the date filter was applied as an instant, so the older message is out',
  );

  const listed = harness.google.requests.filter((request) => request.path === '/gmail/v1/users/me/threads');
  assert.equal(listed[0]?.params.q, result.query.compiled);
});

test('rows carry what a reader needs to choose, with sender text kept in the envelope', async () => {
  const { context } = await connected([
    {
      alias: 'work',
      email: 'jo@example.test',
      sub: 'sub-1',
      messages: {
        w1: message({
          id: 'w1',
          at: '2026-09-17T09:00:00Z',
          from: 'Sam Lee <sam@partner.test>',
          subject: 'Invoice 42',
          snippet: 'Please find the invoice attached',
          labels: ['INBOX', 'UNREAD'],
          withAttachment: true,
        }),
      },
    },
  ]);

  const result = await search(context, { query: 'invoice', inboxes: ['work'] });
  const row = result.rows[0];
  assert.equal(row?.subject, 'Invoice 42');
  assert.deepEqual(row?.from, { name: 'Sam Lee', address: 'sam@partner.test' });
  assert.equal(row?.unread, true);
  assert.equal(row?.attachmentCount, 1);
  assert.equal(row?.toCount, 1);
  assert.match(row?.webLink ?? '', /^https:\/\/mail\.google\.com\//);

  // The subject and snippet are sender-controlled, so the model-facing rendering is enveloped.
  assert.match(result.enveloped, /^<untrusted-content boundary="[^"]+" field="search-results">/);
  assert.match(result.enveloped, /Invoice 42/);
});

test('a page stops at the limit, and the cursor continues where it stopped', async () => {
  const messages: Record<string, FakeMessage> = {};
  for (let index = 0; index < 7; index++) {
    messages[`m${index}`] = message({
      id: `m${index}`,
      at: new Date(Date.parse('2026-09-10T09:00:00Z') + index * 86_400_000).toISOString(),
      from: 'sam@partner.test',
      subject: `Note ${index}`,
    });
  }
  const { context } = await connected([{ alias: 'work', email: 'jo@example.test', sub: 'sub-1', messages }]);

  const first = await search(context, { query: 'note', inboxes: ['work'], limit: 3 });
  assert.equal(first.rows.length, 3);
  assert.equal(first.hasMore, true);
  assert.ok(first.nextCursor);

  const second = await search(context, { query: 'note', inboxes: ['work'], limit: 3, cursor: first.nextCursor });
  assert.equal(second.rows.length, 3);
  const firstIds = first.rows.map((row) => row.messageId);
  const secondIds = second.rows.map((row) => row.messageId);
  assert.deepEqual(
    firstIds.filter((id) => secondIds.includes(id)),
    [],
    'a second page repeats nothing from the first',
  );
  // Newest first across both pages.
  assert.deepEqual([...firstIds, ...secondIds], ['m6', 'm5', 'm4', 'm3', 'm2', 'm1']);
});

test('a cursor cannot be replayed against a different search', async () => {
  const { context } = await connected([
    {
      alias: 'work',
      email: 'jo@example.test',
      sub: 'sub-1',
      messages: {
        m1: message({ id: 'm1', at: '2026-09-15T09:00:00Z', from: 'sam@partner.test', subject: 'One' }),
        m2: message({ id: 'm2', at: '2026-09-16T09:00:00Z', from: 'sam@partner.test', subject: 'Two' }),
      },
    },
    {
      alias: 'home',
      email: 'jo.home@example.test',
      sub: 'sub-2',
      messages: { h1: message({ id: 'h1', at: '2026-09-16T10:00:00Z', from: 'a@b.test', subject: 'Three' }) },
    },
  ]);

  const page = await search(context, { query: 'o', inboxes: ['work'], limit: 1 });
  assert.ok(page.nextCursor);

  await assert.rejects(
    search(context, { query: 'different', inboxes: ['work'], cursor: page.nextCursor }),
    (error: unknown) => error instanceof CommsError && error.code === 'CURSOR_MISMATCH' && error.exitCode === 64,
  );
  await assert.rejects(
    search(context, { query: 'o', inboxes: 'all', cursor: page.nextCursor }),
    (error: unknown) => error instanceof CommsError && error.code === 'CURSOR_MISMATCH',
  );
  await assert.rejects(
    search(context, { query: 'o', inboxes: ['work'], cursor: 'not-a-cursor' }),
    (error: unknown) => error instanceof CommsError && error.code === 'CURSOR_MISMATCH',
  );
});

test('one failing mailbox does not fail the search, and is named', async () => {
  const { harness, context } = await connected([
    {
      alias: 'work',
      email: 'jo@example.test',
      sub: 'sub-1',
      messages: { w1: message({ id: 'w1', at: '2026-09-17T09:00:00Z', from: 'sam@partner.test', subject: 'Plan' }) },
    },
    {
      alias: 'broken',
      email: 'jo.broken@example.test',
      sub: 'sub-2',
      messages: { b1: message({ id: 'b1', at: '2026-09-17T10:00:00Z', from: 'x@y.test', subject: 'Plan' }) },
    },
  ]);

  // The second mailbox's grant is gone; the first still answers.
  const config = await context.config();
  const secrets = await harness.core.secrets('file');
  const broken = config.inboxes.broken;
  assert.ok(broken);
  const token = await secrets.get(broken.secretRef);
  harness.google.revoke(token ?? '');

  const result = await search(context, { query: 'plan', inboxes: 'all' });
  assert.equal(result.complete, false);
  assert.equal(result.errors.length, 1);
  assert.equal(result.errors[0]?.inbox, 'broken');
  assert.match(result.errors[0]?.code ?? '', /AUTH_REQUIRED|PROVIDER_UNAVAILABLE/);
  assert.deepEqual(
    result.rows.map((row) => row.messageId),
    ['w1'],
    'the mailbox that worked still returned its results',
  );
});

test('a mailbox that may not read is refused before Gmail is called', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({
    alias: 'limited',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: 'rt_x',
    grantedScopes: [SCOPES.openid],
  });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  const result = await search(context, { query: 'anything', inboxes: ['limited'] });
  assert.equal(result.complete, false);
  assert.equal(result.errors[0]?.code, 'SCOPE_MISSING');
  assert.equal(result.rows.length, 0);
  assert.equal(harness.google.requests.filter((request) => request.path.startsWith('/gmail')).length, 0);
});

test('searching with no mailbox connected says so', async () => {
  const harness = await newHarness();
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await assert.rejects(
    search(context, { query: 'anything' }),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});
