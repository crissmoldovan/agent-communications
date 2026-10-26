import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActivityLine } from '@agentcomms/core';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { createDraft, replyDraft } from '../src/operations/drafts.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';

/*
 * 0.32.0, Task E (design 2026-10-26-owner-feedback-0320 §3.6): the activity lines that tie a reply to the message it
 * answers. A reply draft names the message and its thread (`replyTo`) and the draft it made (`draftId`); a send
 * prepared from a draft that answers a message in this mailbox names that message too; and the send itself names the
 * draft it sent and the thread it went into. Only ids, all of them Gmail's: never a body. Against the fake transport,
 * never Gmail.
 */

const BODY = 'Only-the-reader-sees-this-body-41c7e2';

/** A message from Sam, in thread `t1`, with a Message-ID header a reply's In-Reply-To names. */
function fromSam(id: string, subject: string): FakeMessage {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX'],
    internalDate: String(Date.parse('2026-10-20T09:00:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'Sam Lee <sam@partner.test>' },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@partner.test>` },
      ],
      body: { size: BODY.length, data: Buffer.from(BODY).toString('base64url') },
    },
  };
}

async function connected(): Promise<{ harness: Harness; context: GmailContext }> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: { m1: fromSam('m1', 'Invoice March') },
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    scopes: [SCOPES.gmailModify],
    sendPolicy: 'chat',
  });
  // These tests are about what a line records, not about who may receive a send.
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  const home = tempDir('agent-gmail-reply-links-home-');
  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: home, USERPROFILE: home },
    cwd: tempDir('agent-gmail-reply-links-cwd-'),
  });
  return { harness, context };
}

async function lines(harness: Harness): Promise<ActivityLine[]> {
  const directory = harness.core.activity.directory;
  const days = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort();
  const text = (await Promise.all(days.map((day) => readFile(join(directory, day), 'utf8')))).join('');
  return text
    .split('\n')
    .filter(Boolean)
    .map((raw) => JSON.parse(raw) as ActivityLine);
}

/** The one line `call` added. */
async function onlyLine(harness: Harness, call: () => Promise<unknown>): Promise<ActivityLine> {
  const before = (await lines(harness)).length;
  await call();
  const added = (await lines(harness)).slice(before);
  assert.equal(added.length, 1, `expected one line, got ${JSON.stringify(added, null, 2)}`);
  return added[0] as ActivityLine;
}

test('a reply draft names the message it answers and its thread, and the draft it made', async () => {
  const { harness, context } = await connected();
  let draftId = '';
  const line = await onlyLine(harness, async () => {
    draftId = (await replyDraft(context, 'work', 'm1', { text: BODY })).draftId;
  });
  assert.equal(line.operation, 'gmail.draft.reply');
  assert.deepEqual(line.replyTo, { messageId: 'm1', threadId: 't1' });
  assert.equal(line.draftId, draftId);
  assert.deepEqual(line.items, [{ id: draftId, subject: 'Re: Invoice March' }]);
  assert.equal(JSON.stringify(line).includes(BODY), false);
});

test('a forward answers nothing: it names its draft, and no message it replies to', async () => {
  const { harness, context } = await connected();
  let draftId = '';
  const line = await onlyLine(harness, async () => {
    draftId = (await replyDraft(context, 'work', 'm1', { text: BODY, mode: 'forward', to: ['kim@partner.test'] }))
      .draftId;
  });
  assert.equal(line.operation, 'gmail.draft.reply');
  assert.equal(line.replyTo, undefined);
  assert.equal(line.draftId, draftId);
});

test('a reply sent: its prepare names the message it answers, and its send the draft and the thread', async () => {
  const { harness, context } = await connected();
  const { draftId } = await replyDraft(context, 'work', 'm1', { text: BODY });

  let approvalId = '';
  const prepared = await onlyLine(harness, async () => {
    approvalId = (await prepareSend(context, 'work', draftId)).approvalId;
  });
  assert.equal(prepared.operation, 'gmail.send.prepare');
  assert.deepEqual(prepared.replyTo, { messageId: 'm1', threadId: 't1' });
  assert.equal(prepared.draftId, draftId);
  assert.equal(prepared.approvalId, approvalId);

  let sentId: string | undefined;
  let threadId: string | undefined;
  const sent = await onlyLine(harness, async () => {
    const result = await executeSend(context, 'work', { approvalId });
    sentId = result.sentMessageId;
    threadId = result.threadId;
  });
  assert.ok(sentId);
  assert.equal(threadId, 't1');
  assert.equal(sent.operation, 'gmail.send.execute');
  assert.equal(sent.outcome, 'ok');
  assert.equal(sent.draftId, draftId);
  assert.equal(sent.threadId, 't1');
  assert.equal(sent.approvalId, approvalId);
  assert.deepEqual(sent.items, [{ id: sentId, subject: 'Re: Invoice March' }]);
  // The send's line is joined to what it answers through its draft — or its approval — not told it again.
  assert.equal(sent.replyTo, undefined);
});

test('a new message sent names its draft and thread, and answers nothing', async () => {
  const { harness, context } = await connected();
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  let approvalId = '';
  const prepared = await onlyLine(harness, async () => {
    approvalId = (await prepareSend(context, 'work', draftId)).approvalId;
  });
  assert.equal(prepared.replyTo, undefined);
  assert.equal(prepared.draftId, draftId);

  let threadId: string | undefined;
  const sent = await onlyLine(harness, async () => {
    threadId = (await executeSend(context, 'work', { approvalId })).threadId;
  });
  assert.ok(threadId);
  assert.equal(sent.draftId, draftId);
  assert.equal(sent.threadId, threadId);
  assert.equal(sent.replyTo, undefined);
});

test('a refused send names no draft: a refusal has no result to read one from', async () => {
  const { harness, context } = await connected();
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  const { approvalId } = await prepareSend(context, 'work', draftId);
  await executeSend(context, 'work', { approvalId });
  const again = await onlyLine(harness, () => executeSend(context, 'work', { approvalId }).catch(() => undefined));
  assert.equal(again.operation, 'gmail.send.execute');
  assert.equal(again.outcome, 'refused');
  // A refusal has no result to read a draft from: nothing is said that the call did not establish.
  assert.equal(again.draftId, undefined);
});
