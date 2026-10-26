import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { threadTimeline } from '../src/operations/analyse.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { readMessage, readThread } from '../src/operations/read.ts';
import { search } from '../src/operations/search.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import { gmailCaptures } from '../src/search-capture.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * Gmail's half of Search on this machine (design 2026-10-26-local-search, S2, S3, §5): a read, a search and a send hand
 * what they had in hand to core's capture after they succeed — only where the person switched Search on for the
 * mailbox, never from the mailbox's own address, and never changing what the call returns. Against the fake Google;
 * the inbox's lines are sealed, so the body planted here is in none of them.
 */

const BODY = 'Only-the-reader-sees-this-body-5f1e0a, about the invoice';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function message(id: string, from: string, subject: string, at: string): FakeMessage {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX'],
    snippet: 'about the invoice',
    internalDate: String(Date.parse(at)),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@partner.test>` },
      ],
      body: { size: BODY.length, data: base64url(BODY) },
    },
  };
}

async function connected(): Promise<{ harness: Harness; context: GmailContext; inboxId: string }> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: {
          m1: message('m1', 'Sam Lee <sam@partner.test>', 'Invoice March', '2026-10-20T09:00:00Z'),
          m2: message('m2', 'Jo Example <jo@example.test>', 'Re: Invoice March', '2026-10-21T09:00:00Z'),
        },
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
      },
    ],
  });
  const inbox = await harness.connectInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    scopes: [SCOPES.gmailModify],
    sendPolicy: 'chat',
  });
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  const home = tempDir('agent-gmail-search-home-');
  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: home, USERPROFILE: home },
    cwd: tempDir('agent-gmail-search-cwd-'),
  });
  return { harness, context, inboxId: inbox.id };
}

async function searchOn(harness: Harness, inboxId: string): Promise<void> {
  await harness.core.config.update((config) => ({ ...config, search: { enabled: 'on', accounts: [inboxId] } }), {
    consent: { kind: 'loosening-consent', paths: ['search.enabled', 'search.accounts'] },
  });
}

/** Every line the search inbox holds now. */
function inboxLines(harness: Harness): string[] {
  const dir = join(harness.core.paths.stateDir, 'search', 'inbox');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) =>
    readFileSync(join(dir, name), 'utf8')
      .split('\n')
      .filter((line) => line.trim() !== ''),
  );
}

test('with Search off, a read keeps nothing; on for the mailbox, each message read is one sealed line', async () => {
  const { harness, context, inboxId } = await connected();
  const off = await readMessage(context, 'work', 'm1');
  assert.deepEqual(inboxLines(harness), []);
  assert.equal(existsSync(join(harness.core.paths.stateDir, 'search')), false);
  await searchOn(harness, inboxId);
  const on = await readMessage(context, 'work', 'm1');
  // The result is what it was: capture never changes it.
  assert.equal(on.body.enveloped.replace(/boundary="[^"]+"/g, ''), off.body.enveloped.replace(/boundary="[^"]+"/g, ''));
  assert.equal(inboxLines(harness).length, 1);
  // A thread: Sam's message is kept, and Jo's own is not an ask.
  await readThread(context, 'work', 't1');
  assert.equal(inboxLines(harness).length, 2);
  // A search's rows, as partial: Sam's only.
  await search(context, { query: 'invoice', inboxes: ['work'], kind: 'messages' });
  assert.equal(inboxLines(harness).length, 3);
  // A timeline carries no text, and keeps nothing.
  await threadTimeline(context, 'work', 't1');
  assert.equal(inboxLines(harness).length, 3);
  for (const line of inboxLines(harness)) {
    assert.equal(line.includes('Only-the-reader'), false, 'sealed');
    assert.equal(line.includes('sam@partner.test'), false, 'sealed');
    assert.deepEqual(Object.keys(JSON.parse(line) as object).sort(), ['sealed', 'v']);
  }
});

test('a send keeps what went as out, after Gmail accepted it', async () => {
  const { harness, context, inboxId } = await connected();
  await searchOn(harness, inboxId);
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  const { approvalId } = await prepareSend(context, 'work', draftId);
  const before = inboxLines(harness).length;
  const sent = await executeSend(context, 'work', { approvalId });
  assert.ok(sent.sentMessageId);
  assert.equal(inboxLines(harness).length, before + 1);
  const [captured] = gmailCaptures('gmail.send.execute', sent);
  assert.equal(captured?.capture.direction, 'out');
  assert.equal(captured?.capture.sourceId, sent.sentMessageId);
  assert.equal(captured?.capture.text.includes('Only-the-reader-sees-this-body'), true);
  // Nothing was added to what the send returned.
  assert.equal('text' in sent, false);
});

test('the capture describers keep only what the result holds, and nothing for an operation that keeps nothing', () => {
  assert.deepEqual(gmailCaptures('gmail.labels.list', { labels: [] }), []);
  assert.deepEqual(gmailCaptures('gmail.send.execute', { inbox: 'work', sentMessageId: 'x' }), []);
  const [row] = gmailCaptures('gmail.search', {
    rows: [
      {
        inbox: 'work',
        threadId: 't9',
        messageId: 'm9',
        date: '2026-10-20T09:00:00Z',
        from: { name: 'Sam', address: 'sam@partner.test' },
        subject: '<untrusted-content boundary="b1" field="subject">\nHello\n</untrusted-content boundary="b1">',
        snippet: 'a snippet',
      },
    ],
  });
  assert.equal(row?.capture.subject, 'Hello');
  assert.equal(row?.capture.partial, true);
});
