import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@cloudpixel/comms-core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { followUps, searchContacts } from '../src/operations/contacts.ts';
import type { FakeAccount, FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET } from './support/harness.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function message(options: {
  id: string;
  threadId?: string;
  at: string;
  from: string;
  to?: string;
  subject: string;
  labels?: string[];
}): FakeMessage {
  return {
    id: options.id,
    threadId: options.threadId ?? options.id,
    labelIds: options.labels ?? ['INBOX'],
    internalDate: String(Date.parse(options.at)),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: options.from },
        { name: 'To', value: options.to ?? 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: options.subject },
      ],
      body: { size: 2, data: base64url('hi') },
    },
  };
}

async function connected(
  account: Partial<FakeAccount>,
  options: { contacts?: boolean } = {},
): Promise<{
  harness: Harness;
  context: GmailContext;
}> {
  const harness = await newHarness({
    accounts: [{ sub: 'sub-1', email: 'jo@example.test', ...account }],
  });
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const pkce = newPkce();
  const scopes = [SCOPES.gmailModify, SCOPES.contacts, SCOPES.otherContacts];
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes,
    state: 'st',
    codeChallenge: pkce.challenge,
  });
  const code = new URL(harness.google.consent(authUrl)).searchParams.get('code') ?? '';
  const tokens = await exchangeCode({
    client,
    endpoints: harness.endpoints,
    code,
    codeVerifier: pkce.verifier,
    redirectUri: 'http://127.0.0.1:5123/',
  });
  const inbox = await harness.addInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: tokens.refreshToken,
    grantedScopes: scopes,
  });
  if (options.contacts === false) {
    await harness.core.config.update((config) => ({
      ...config,
      inboxes: { ...config.inboxes, work: { ...inbox, contacts: false } },
    }));
  }
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }) };
}

test('contacts come from the address book, from past mail, and say which', async () => {
  const { context } = await connected({
    contacts: [{ name: 'Sam Lee', email: 'sam@partner.test' }],
    otherContacts: [{ name: 'Sam Reception', email: 'reception@partner.test' }],
    messages: {
      m1: message({ id: 'm1', at: '2026-09-15T09:00:00Z', from: 'Sam Lee <sam@partner.test>', subject: 'Plan' }),
      m2: message({ id: 'm2', at: '2026-09-17T09:00:00Z', from: 'Sam Lee <sam@partner.test>', subject: 'Plan again' }),
    },
  });

  const result = await searchContacts(context, 'sam');
  assert.equal(result.complete, true);
  const sam = result.contacts.find((contact) => contact.email === 'sam@partner.test');
  assert.ok(sam);
  assert.deepEqual(sam?.sources.sort(), ['contacts', 'history']);
  assert.equal(sam?.messages, 2, 'seen in two messages');
  assert.equal(sam?.name, 'Sam Lee');

  // A saved contact outranks one Google merely noticed.
  const order = result.contacts.map((contact) => contact.email);
  assert.ok(order.indexOf('sam@partner.test') < order.indexOf('reception@partner.test'));
});

test('a lookalike address is returned as a candidate, never as an answer', async () => {
  const { context } = await connected({
    contacts: [{ name: 'Sam Lee', email: 'sam@partner.test' }],
    otherContacts: [{ name: 'Sam Lee', email: 'sam@partner-invoices.test' }],
    messages: {},
  });
  const result = await searchContacts(context, 'sam');
  const addresses = result.contacts.map((contact) => contact.email);
  assert.ok(addresses.includes('sam@partner.test'));
  assert.ok(addresses.includes('sam@partner-invoices.test'), 'the lookalike is shown, not hidden');
  // But the saved one ranks first, and each row says where it came from.
  assert.equal(result.contacts[0]?.email, 'sam@partner.test');
  assert.deepEqual(result.contacts[1]?.sources, ['other-contacts']);
});

test('without the contacts permission, past mail still answers', async () => {
  const { context } = await connected(
    {
      contacts: [{ name: 'Sam Lee', email: 'sam@partner.test' }],
      messages: {
        m1: message({ id: 'm1', at: '2026-09-15T09:00:00Z', from: 'Sam Lee <sam@partner.test>', subject: 'Plan' }),
      },
    },
    { contacts: false },
  );
  const result = await searchContacts(context, 'sam');
  assert.deepEqual(
    result.contacts.map((contact) => contact.sources),
    [['history']],
  );
});

test('searching for nothing is a usage error, not an empty list', async () => {
  const { context } = await connected({ messages: {} });
  await assert.rejects(
    searchContacts(context, '   '),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('follow-ups: threads where we spoke last and nobody answered', async () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const { context } = await connected({
    messages: {
      // We wrote nine days ago and nobody replied: overdue.
      sent1: message({
        id: 'sent1',
        threadId: 't1',
        at: daysAgo(9),
        from: 'Jo Example <jo@example.test>',
        to: 'sam@partner.test',
        subject: 'Quote for the rig',
        labels: ['SENT'],
      }),
      // We wrote yesterday: not overdue yet.
      sent2: message({
        id: 'sent2',
        threadId: 't2',
        at: daysAgo(1),
        from: 'Jo Example <jo@example.test>',
        to: 'ana@partner.test',
        subject: 'Yesterday',
        labels: ['SENT'],
      }),
      // They replied to this one, so nobody is waiting on them.
      sent3: message({
        id: 'sent3',
        threadId: 't3',
        at: daysAgo(10),
        from: 'Jo Example <jo@example.test>',
        to: 'pat@partner.test',
        subject: 'Answered',
        labels: ['SENT'],
      }),
      reply3: message({
        id: 'reply3',
        threadId: 't3',
        at: daysAgo(8),
        from: 'Pat <pat@partner.test>',
        subject: 'Re: Answered',
        labels: ['INBOX'],
      }),
    },
  });

  const result = await followUps(context, { direction: 'them', olderThanDays: 3, lookbackDays: 30 });
  assert.deepEqual(
    result.rows.map((row) => row.threadId),
    ['t1'],
    'only the thread we spoke last in, old enough to chase',
  );
  assert.equal(result.rows[0]?.with, 'sam@partner.test');
  assert.equal(result.rows[0]?.direction, 'awaiting-them');
  assert.ok((result.rows[0]?.ageDays ?? 0) >= 9);
  assert.match(result.query, /in:sent older_than:3d newer_than:30d/);
});

test('follow-ups the other way: what has arrived and is still unanswered', async () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const { context } = await connected({
    messages: {
      in1: message({
        id: 'in1',
        threadId: 't1',
        at: daysAgo(2),
        from: 'Sam Lee <sam@partner.test>',
        subject: 'Can you confirm?',
        labels: ['INBOX'],
      }),
      out1: message({
        id: 'out1',
        threadId: 't2',
        at: daysAgo(2),
        from: 'Jo Example <jo@example.test>',
        to: 'ana@partner.test',
        subject: 'Already answered',
        labels: ['SENT'],
      }),
    },
  });

  const result = await followUps(context, { direction: 'me', lookbackDays: 30 });
  assert.deepEqual(
    result.rows.map((row) => row.threadId),
    ['t1'],
  );
  assert.equal(result.rows[0]?.direction, 'awaiting-me');
  assert.equal(result.rows[0]?.with, 'sam@partner.test');
  assert.match(result.query, /-category:promotions/);
});

test('a half-written draft does not hide the thread it is sitting in', async () => {
  const now = Date.parse('2026-09-18T12:00:00Z');
  const daysAgo = (days: number) => new Date(now - days * 86_400_000).toISOString();
  const { context } = await connected({
    messages: {
      in1: message({
        id: 'in1',
        threadId: 't1',
        at: daysAgo(4),
        from: 'Sam Lee <sam@partner.test>',
        subject: 'Can you confirm?',
        labels: ['INBOX'],
      }),
      // The user started an answer and never finished it. That is the thread they most need to see.
      d1: message({
        id: 'd1',
        threadId: 't1',
        at: daysAgo(3),
        from: 'Jo Example <jo@example.test>',
        to: 'sam@partner.test',
        subject: 'Re: Can you confirm?',
        labels: ['DRAFT'],
      }),
    },
  });

  const waiting = await followUps(context, { direction: 'me', lookbackDays: 30 });
  assert.deepEqual(
    waiting.rows.map((row) => row.threadId),
    ['t1'],
    'the draft is not an answer, so the thread is still unanswered',
  );
  // The age is taken from the last real message rather than the draft, so a started answer does not reset the clock.
  assert.ok((waiting.rows[0]?.ageDays ?? 0) >= 3, 'its age comes from the last real message, not the draft');
});
