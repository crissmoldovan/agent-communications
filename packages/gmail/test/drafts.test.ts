import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@cloudpixel/comms-core';
import { buildAuthUrl, exchangeCode, newPkce } from '../src/auth/oauth.ts';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { createDraft, deleteDraft, getDraft, listDrafts, replyDraft, updateDraft } from '../src/operations/drafts.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, TEST_CLIENT_ID, TEST_CLIENT_SECRET, tempDir } from './support/harness.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** An incoming message to reply to. */
function incoming(options: { id: string; from: string; to?: string; cc?: string; replyTo?: string }): FakeMessage {
  return {
    id: options.id,
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-09-17T16:02:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: options.from },
        { name: 'To', value: options.to ?? 'Jo Example <jo@example.test>' },
        ...(options.cc ? [{ name: 'Cc', value: options.cc }] : []),
        ...(options.replyTo ? [{ name: 'Reply-To', value: options.replyTo }] : []),
        { name: 'Subject', value: 'Phase 2 plan' },
        { name: 'Message-ID', value: '<abc@mail.partner.test>' },
        { name: 'References', value: '<start@mail.partner.test>' },
      ],
      body: { size: 5, data: base64url('Hello') },
    },
  };
}

async function connected(messages: Record<string, FakeMessage> = {}): Promise<{
  harness: Harness;
  context: GmailContext;
}> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages,
        sendAs: [
          {
            sendAsEmail: 'jo@example.test',
            displayName: 'Jo Example',
            isDefault: true,
            isPrimary: true,
            signature: '<div>— Jo<br>Head of Things</div>',
          },
        ],
      },
    ],
  });
  const client = { clientId: TEST_CLIENT_ID, clientSecret: TEST_CLIENT_SECRET };
  const pkce = newPkce();
  const authUrl = buildAuthUrl({
    client,
    endpoints: harness.endpoints,
    redirectUri: 'http://127.0.0.1:5123/',
    scopes: [SCOPES.gmailModify],
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
  await harness.addInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: tokens.refreshToken,
    grantedScopes: [SCOPES.gmailModify],
  });
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }) };
}

test('a draft is saved, and the result carries the preview the user should read', async () => {
  const { harness, context } = await connected();

  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    cc: ['ana@partner.test'],
    subject: 'Tuesday',
    text: 'Tuesday works for me.\n\nC',
  });

  assert.match(draft.draftId, /^d_/);
  assert.match(draft.messageId, /^dm_/);
  assert.deepEqual(draft.to, ['sam@partner.test']);
  // The preview is the thing to show: recipients, subject, the body verbatim in a fence, and the recipients again.
  assert.match(draft.preview, /MESSAGE PREVIEW · inbox work · draft d_/);
  assert.match(draft.preview, /nothing has been sent/);
  assert.match(draft.preview, /Tuesday works for me\./);
  assert.match(draft.preview, /── To sam@partner\.test · Cc ana@partner\.test · Bcc none/);

  // The signature Gmail holds is used as it stands.
  assert.match(draft.preview, /Head of Things/);

  const audit = await harness.core.audit.tail({ inbox: 'work' });
  const entry = audit.find((row) => row.operation === 'draft.create');
  assert.ok(entry);
  // Domains, never the addresses themselves.
  assert.deepEqual(entry?.recipientDomains, ['partner.test']);
});

test('what an agent writes stays text: it cannot put markup into the message', async () => {
  const { context } = await connected();
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Report',
    text: 'Here is <b>the report</b> and an image: <img src="https://tracker.test/x.png">',
    signature: false,
  });
  // The user sees exactly what the author typed, markup and all — as text.
  assert.match(draft.preview, /<b>the report<\/b>/);
  const saved = await getDraft(context, 'work', draft.draftId);
  assert.match(saved.preview, /<b>the report<\/b>/, 'the same text reads back from the saved draft');

  // What matters is the HTML part that will be sent: the markup is escaped, so no image is fetched on open.
  const { composeMessage } = await import('../src/domain/compose.ts');
  const composed = await composeMessage({
    from: 'jo@example.test',
    to: ['sam@partner.test'],
    subject: 'Report',
    text: 'Here is <b>the report</b> and an image: <img src="https://tracker.test/x.png">',
  });
  // The markup the author typed is text; the only tag that appears is the link this package made for the URL.
  assert.doesNotMatch(composed.html, /<img|<b>/);
  assert.match(composed.html, /&lt;img src=&quot;/);
  assert.match(composed.html, /<a href="https:\/\/tracker\.test\/x\.png">/);
});

test('a reply goes to the sender and keeps the conversation together', async () => {
  const { context } = await connected({
    m1: incoming({ id: 'm1', from: 'Sam Lee <sam@partner.test>', cc: 'Ana <ana@partner.test>' }),
  });

  const reply = await replyDraft(context, 'work', 'm1', { text: 'Tuesday works.' });
  assert.deepEqual(reply.to, ['sam@partner.test']);
  assert.deepEqual(reply.cc, [], 'a plain reply does not copy everyone');
  assert.equal(reply.subject, 'Re: Phase 2 plan');
  assert.equal(reply.threadId, 't1', 'the draft stays in the conversation');

  const all = await replyDraft(context, 'work', 'm1', { text: 'Tuesday works.', mode: 'reply_all' });
  assert.deepEqual(all.cc, ['ana@partner.test']);
  assert.ok(!all.to.includes('jo@example.test'), 'we are not a recipient of our own reply');
});

test('a reply-to that redirects is carried out, and said out loud', async () => {
  const { context } = await connected({
    m1: incoming({ id: 'm1', from: 'Sam Lee <sam@partner.test>', replyTo: 'accounts@evil.test' }),
  });
  const reply = await replyDraft(context, 'work', 'm1', { text: 'Sure.' });
  assert.deepEqual(reply.to, ['accounts@evil.test'], 'the sender asked for replies elsewhere');
  assert.ok(reply.warnings.some((warning) => /asked for replies to go to accounts@evil\.test/.test(warning)));
  assert.match(reply.preview, /! the sender asked for replies/);
});

test('a forward needs somewhere to go, and starts its own conversation', async () => {
  const { context } = await connected({ m1: incoming({ id: 'm1', from: 'Sam Lee <sam@partner.test>' }) });

  await assert.rejects(
    replyDraft(context, 'work', 'm1', { text: 'See below.', mode: 'forward' }),
    (error: unknown) => error instanceof CommsError && error.code === 'REPLY_INVALID',
  );

  const forward = await replyDraft(context, 'work', 'm1', {
    text: 'See below.',
    mode: 'forward',
    to: ['new@third.test'],
  });
  assert.deepEqual(forward.to, ['new@third.test']);
  assert.equal(forward.subject, 'Fwd: Phase 2 plan');
  assert.notEqual(forward.threadId, 't1', 'a forward is not a reply to the people who were already there');
});

test('a file is attached by path, and only from where attaching is allowed', async () => {
  const { context, harness } = await connected();
  const home = tempDir('agent-gmail-home-');
  // Widening where files may be attached from is a safety setting, so the change carries consent, as a person's
  // would.
  await harness.core.config.update((config) => ({ ...config, defaults: { ...config.defaults, attachRoots: [home] } }), {
    consent: { kind: 'loosening-consent', paths: ['defaults.attachRoots'] },
  });
  const contextWithHome = new GmailContext({ core: harness.core, env: { ...harness.env, HOME: home } });

  const allowed = join(home, 'plan.pdf');
  await writeFile(allowed, '%PDF-1.4 fake');
  const draft = await createDraft(contextWithHome, 'work', {
    to: ['sam@partner.test'],
    subject: 'Plan',
    text: 'Attached.',
    attach: [allowed],
  });
  assert.deepEqual(
    draft.attachments.map((attachment) => attachment.filename),
    ['plan.pdf'],
  );
  assert.match(draft.preview, /Attach: {2}plan\.pdf/);

  // Credentials sit in dot-directories under home, and the jail refuses them whatever an agent types.
  await mkdir(join(home, '.ssh'), { recursive: true });
  await writeFile(join(home, '.ssh', 'id_rsa'), 'PRIVATE KEY');
  await assert.rejects(
    createDraft(contextWithHome, 'work', {
      to: ['sam@partner.test'],
      subject: 'Oops',
      text: 'x',
      attach: [join(home, '.ssh', 'id_rsa')],
    }),
    (error: unknown) => error instanceof CommsError,
  );

  // And a file outside the allowed roots is refused too.
  const elsewhere = join(tempDir(), 'other.txt');
  await writeFile(elsewhere, 'nope');
  await assert.rejects(
    createDraft(contextWithHome, 'work', { to: ['sam@partner.test'], subject: 'Oops', text: 'x', attach: [elsewhere] }),
    (error: unknown) => error instanceof CommsError,
  );
});

test('drafts can be listed, read back and deleted', async () => {
  const { context } = await connected();
  const first = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'One', text: 'First.' });
  await createDraft(context, 'work', { to: ['ana@partner.test'], subject: 'Two', text: 'Second.' });

  const drafts = await listDrafts(context, 'work');
  assert.equal(drafts.length, 2);
  assert.ok(drafts.some((draft) => draft.subject === 'One' && draft.to.includes('sam@partner.test')));

  const read = await getDraft(context, 'work', first.draftId);
  assert.equal(read.subject, 'One');
  assert.match(read.preview, /First\./);

  await deleteDraft(context, 'work', first.draftId);
  assert.equal((await listDrafts(context, 'work')).length, 1);
});

test('drafting needs the permission to draft, checked before Google is called', async () => {
  const harness = await newHarness({ accounts: [{ sub: 'sub-1', email: 'jo@example.test' }] });
  await harness.addInbox({
    alias: 'readonly',
    email: 'jo@example.test',
    sub: 'sub-1',
    refreshToken: 'rt_x',
    grantedScopes: [SCOPES.gmailReadonly],
  });
  const context = new GmailContext({ core: harness.core, env: harness.env });
  await assert.rejects(
    createDraft(context, 'readonly', { to: ['sam@partner.test'], subject: 'No', text: 'x' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'SCOPE_MISSING');
      assert.match(error.hint ?? '', /inbox reauth readonly --tier draft/);
      return true;
    },
  );
  assert.equal(harness.google.requests.filter((request) => request.path.includes('/drafts')).length, 0);
});

test('a message going outside the organisation says so, and blind copies are named', async () => {
  const { harness, context } = await connected();
  const config = await harness.core.config.load();
  const inbox = config.inboxes.work;
  assert.ok(inbox);
  await harness.core.config.update(
    (current) => ({
      ...current,
      inboxes: { ...current.inboxes, work: { ...inbox, internalDomains: ['example.test'] } },
    }),
    { consent: { kind: 'loosening-consent', paths: ['inboxes.work.internalDomains'] } },
  );

  const draft = await createDraft(new GmailContext({ core: harness.core, env: harness.env }), 'work', {
    to: ['colleague@example.test'],
    bcc: ['quiet@partner.test'],
    subject: 'Heads up',
    text: 'Short one.',
  });
  assert.ok(draft.warnings.some((warning) => /goes outside your organisation: quiet@partner\.test/.test(warning)));
  assert.ok(draft.warnings.some((warning) => /1 blind recipient/.test(warning)));
});

test('updating a draft replaces its content and gives it a new message id', async () => {
  const { context } = await connected();
  const first = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tuesday',
    text: 'Tuesday works.',
  });

  const revised = await updateDraft(context, 'work', first.draftId, { text: 'Wednesday is better, sorry.' });
  assert.equal(revised.draftId, first.draftId, 'the same draft, not a second one');
  assert.notEqual(revised.messageId, first.messageId, 'a new message id is what makes an edit detectable');
  assert.deepEqual(revised.to, ['sam@partner.test'], 'what was not restated is kept');
  assert.equal(revised.subject, 'Tuesday');
  assert.match(revised.preview, /Wednesday is better/);

  const read = await getDraft(context, 'work', first.draftId);
  assert.match(read.preview, /Wednesday is better/);
  assert.equal((await listDrafts(context, 'work')).length, 1, 'no orphan draft was left behind');
});
