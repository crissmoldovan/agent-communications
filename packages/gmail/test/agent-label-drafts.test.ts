import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, decodeHeaderWords, UNLABELLED_PREVIEW_LINE } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { createDraft, replyDraft, updateDraft } from '../src/operations/drafts.ts';
import type { FakeAccount, FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, setAgentLabel } from './support/harness.ts';

/**
 * G1 (design 2026-10-15-agent-label §5): a draft is labelled when it is written. For identity `agent` its From is
 * `"<name> (<word>)" <address>`, the name the send-as display name, else the core's `agentLabel.name`, else a refusal;
 * for `me` it is the bare address, as every draft was before. The kind is `send` for a new message and `reply` for a
 * reply, and a mail rule's conversation matches only when every recipient does.
 */

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function incoming(id: string): FakeMessage {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-09-17T16:02:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Sam Lee <sam@partner.test>' },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: 'Phase 2 plan' },
        { name: 'Message-ID', value: '<abc@mail.partner.test>' },
      ],
      body: { size: 5, data: base64url('Hello') },
    },
  };
}

async function connected(
  sendAs: FakeAccount['sendAs'] = [
    { sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true },
  ],
): Promise<{ harness: Harness; context: GmailContext }> {
  const harness = await newHarness({
    accounts: [{ sub: 'sub-1', email: 'jo@example.test', sendAs, messages: { m1: incoming('m1') } }],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1' });
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }) };
}

/** The From header of a saved draft, exactly as the message Gmail holds carries it. */
function storedFrom(harness: Harness, draftId: string): string | undefined {
  const draft = harness.google.accounts.get('sub-1')?.drafts?.[draftId];
  const headers = (draft?.message.payload as { headers?: Array<{ name: string; value: string }> } | undefined)?.headers;
  return headers?.find((header) => header.name.toLowerCase() === 'from')?.value;
}

const firstLine = (preview: string): string => preview.split('\n')[0] ?? '';

test('an agent draft is labelled in its From line, with the send-as name and the default word', async () => {
  const { harness, context } = await connected();
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });

  assert.equal(storedFrom(harness, draft.draftId), '"Jo Example (agent)" <jo@example.test>');
  assert.equal(draft.identity, 'agent');
  assert.equal(draft.from, '"Jo Example (agent)" <jo@example.test>');
  assert.match(firstLine(draft.preview), /^Sent as Jo Example \(agent\)/, 'the first line states the identity');
  assert.match(draft.preview, /^From: +"Jo Example \(agent\)" <jo@example\.test>$/m);
});

test('the word is the person’s, and a name that already carries it is not labelled twice', async () => {
  const { harness, context } = await connected([
    { sendAsEmail: 'jo@example.test', displayName: 'Jo Example (twin)', isDefault: true, isPrimary: true },
  ]);
  await setAgentLabel(harness, { word: 'twin' });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  assert.equal(storedFrom(harness, draft.draftId), '"Jo Example (twin)" <jo@example.test>');
});

test('with no send-as name the core’s name is used, and with neither the draft is refused naming `label name`', async () => {
  const { harness, context } = await connected([
    { sendAsEmail: 'jo@example.test', displayName: '', isDefault: true, isPrimary: true },
  ]);
  await assert.rejects(
    createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'USAGE');
      assert.match(`${error.message} ${error.hint ?? ''}`, /`label name`/);
      return true;
    },
  );
  assert.equal(
    harness.google.requests.filter((request) => request.path.endsWith('/drafts')).length,
    0,
    'nothing was written to Drafts before the refusal',
  );

  await setAgentLabel(harness, { name: 'Jo From Settings' });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  assert.equal(storedFrom(harness, draft.draftId), '"Jo From Settings (agent)" <jo@example.test>');
});

test('a name that does not fit the label is refused, never cut short', async () => {
  const { context } = await connected([
    { sendAsEmail: 'jo@example.test', displayName: 'J'.repeat(95), isDefault: true, isPrimary: true },
  ]);
  await assert.rejects(
    createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'USAGE');
      assert.match(`${error.message} ${error.hint ?? ''}`, /`label name`/);
      return true;
    },
  );
});

test('a non-ASCII name is encoded by the composer, RFC 2047, and decodes to the phrase', async () => {
  const { harness, context } = await connected([
    { sendAsEmail: 'jo@example.test', displayName: 'Renée Dürr', isDefault: true, isPrimary: true },
  ]);
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  const header = storedFrom(harness, draft.draftId) ?? '';
  assert.match(header, /^=\?UTF-8\?[QB]\?/i, `the name is an encoded-word: ${header}`);
  assert.doesNotMatch(header, /[^\x20-\x7e]/, 'no raw non-ASCII byte reaches the header');
  assert.equal(decodeHeaderWords(header), 'Renée Dürr (agent) <jo@example.test>');
  assert.match(draft.preview, /^From: +"Renée Dürr \(agent\)" <jo@example\.test>$/m, 'the preview shows it decoded');
});

test('`as: "me"` keeps the bare address, and the preview’s first line says it is unlabelled', async () => {
  const { harness, context } = await connected();
  const draft = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    subject: 'Tuesday',
    text: 'Yes.',
    as: 'me',
  });
  assert.equal(storedFrom(harness, draft.draftId), 'jo@example.test');
  assert.equal(draft.identity, 'me');
  assert.equal(firstLine(draft.preview), UNLABELLED_PREVIEW_LINE);

  await assert.rejects(
    createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'x', text: 'x', as: 'human' }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
    'only agent and me are identities',
  );
});

test('a new draft is kind `send` and a reply kind `reply`; a forward starts a new message', async () => {
  const { harness, context } = await connected();
  await setAgentLabel(harness, { rules: [{ account: 'work', kinds: ['reply'], as: 'me' }] });

  const fresh = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Hi', text: 'Hi.' });
  assert.equal(fresh.identity, 'agent', 'a rule for replies leaves a new message labelled');
  const reply = await replyDraft(context, 'work', 'm1', { text: 'Tuesday works.' });
  assert.equal(reply.identity, 'me', 'the reply rule applies to a reply');
  assert.equal(storedFrom(harness, reply.draftId), 'jo@example.test');
  const forward = await replyDraft(context, 'work', 'm1', { text: 'FYI.', mode: 'forward', to: ['new@third.test'] });
  assert.equal(forward.identity, 'agent', 'a forward is a new message, not a reply');

  // An update keeps the kind of the draft it changes: a reply stays a reply.
  const revisedReply = await updateDraft(context, 'work', reply.draftId, { text: 'Wednesday, then.' });
  assert.equal(revisedReply.identity, 'me');
  assert.equal(storedFrom(harness, reply.draftId), 'jo@example.test');
  const revisedFresh = await updateDraft(context, 'work', fresh.draftId, { text: 'Hello.' });
  assert.equal(revisedFresh.identity, 'agent');
  assert.equal(storedFrom(harness, fresh.draftId), '"Jo Example (agent)" <jo@example.test>');

  // `as` on the update wins over the rule, as it does everywhere.
  const relabelled = await updateDraft(context, 'work', reply.draftId, { as: 'agent' });
  assert.equal(relabelled.identity, 'agent');
  assert.equal(storedFrom(harness, reply.draftId), '"Jo Example (agent)" <jo@example.test>');
});

test('a rule on @domain applies only when every recipient is in it', async () => {
  const { harness, context } = await connected();
  await setAgentLabel(harness, { rules: [{ account: 'work', conversation: '@partner.test', as: 'me' }] });

  const inside = await createDraft(context, 'work', {
    to: ['Sam Lee <sam@partner.test>'],
    cc: ['ana@partner.test'],
    subject: 'Hi',
    text: 'Hi.',
  });
  assert.equal(inside.identity, 'me');
  assert.equal(storedFrom(harness, inside.draftId), 'jo@example.test');

  const mixed = await createDraft(context, 'work', {
    to: ['sam@partner.test'],
    bcc: ['someone@elsewhere.test'],
    subject: 'Hi',
    text: 'Hi.',
  });
  assert.equal(mixed.identity, 'agent', 'one recipient outside the domain and the rule does not apply');
  assert.equal(storedFrom(harness, mixed.draftId), '"Jo Example (agent)" <jo@example.test>');
});

test('a rule for another mailbox does not apply here', async () => {
  const { harness, context } = await connected();
  await setAgentLabel(harness, { rules: [{ account: 'home', as: 'me' }] });
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Hi', text: 'Hi.' });
  assert.equal(draft.identity, 'agent');
});
