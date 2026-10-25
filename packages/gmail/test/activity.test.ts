import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import type { ActivityLine } from '@agentcomms/core';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { listLabels, listSendAs, threadTimeline } from '../src/operations/analyse.ts';
import { type DownloadQuestion, downloadAttachments, findAttachments } from '../src/operations/attachments.ts';
import { followUps, searchContacts } from '../src/operations/contacts.ts';
import { createDraft, deleteDraft, getDraft, listDrafts, replyDraft, updateDraft } from '../src/operations/drafts.ts';
import { exportMail } from '../src/operations/export.ts';
import { whoami } from '../src/operations/inboxes.ts';
import { applyUndo, createLabel, modify, trash } from '../src/operations/organise.ts';
import { readMessage, readThread } from '../src/operations/read.ts';
import { search } from '../src/operations/search.ts';
import { executeSend, prepareSend, revokeApproval } from '../src/operations/send.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness, tempDir } from './support/harness.ts';
import { cli, connect, wire } from './support/surfaces.ts';

/*
 * The activity log, Gmail's half (design 2026-10-25-activity §4.2, §8 Task 2a): every operation a capability row names
 * that reads or writes a mailbox records exactly one line — what it touched, never what it said — on the command and
 * the tool alike, and an operation another one calls on its way records nothing of its own.
 */

/** Text that is only ever in a body, a snippet or an attachment's bytes: none of it may reach the activity log. */
const BODY = 'Only-the-reader-sees-this-body-6d0c1f';
const SNIPPET = 'Only-the-search-row-snippet-9a7e42';
const BYTES = 'Only-the-attachment-bytes-3b5d88';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

/** A message from Sam with a body and one attachment, in thread `t1`. */
function fromSam(id: string, at: string, subject: string): FakeMessage {
  return {
    id,
    threadId: 't1',
    labelIds: ['INBOX', 'UNREAD'],
    snippet: SNIPPET,
    internalDate: String(Date.parse(at)),
    payload: {
      partId: '',
      mimeType: 'multipart/mixed',
      headers: [
        { name: 'From', value: 'Sam Lee <sam@partner.test>' },
        { name: 'To', value: 'Jo Example <jo@example.test>' },
        { name: 'Subject', value: subject },
        { name: 'Message-ID', value: `<${id}@partner.test>` },
      ],
      parts: [
        { partId: '0', mimeType: 'text/plain', body: { size: BODY.length, data: base64url(BODY) } },
        {
          partId: '1',
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
          headers: [{ name: 'Content-Disposition', value: 'attachment; filename="invoice.pdf"' }],
          body: { size: BYTES.length, attachmentId: `att-${id}` },
        },
      ],
    },
  };
}

interface Connected {
  harness: Harness;
  context: GmailContext;
  inboxId: string;
}

async function connected(options: { sendPolicy?: 'chat' | 'confirm' | 'never' } = {}): Promise<Connected> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: {
          m1: fromSam('m1', '2026-10-20T09:00:00Z', 'Invoice March'),
          m2: fromSam('m2', '2026-10-21T09:00:00Z', 'Re: Invoice March'),
        },
        attachments: { 'att-m1': BYTES, 'att-m2': BYTES },
        labels: [{ id: 'Label_1', name: 'Clients', type: 'user' }],
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
        contacts: [{ name: 'Sam Lee', email: 'sam@partner.test' }],
      },
    ],
  });
  const inbox = await harness.connectInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    scopes: [SCOPES.gmailModify],
    sendPolicy: options.sendPolicy ?? 'chat',
  });
  // These tests are about what is recorded of a send, not about who may receive one.
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  // Downloads land in a home of their own, and "the current folder" is a temporary one.
  const home = tempDir('agent-gmail-activity-home-');
  const context = new GmailContext({
    core: harness.core,
    env: { ...harness.env, HOME: home, USERPROFILE: home },
    cwd: tempDir('agent-gmail-activity-cwd-'),
  });
  return { harness, context, inboxId: inbox.id };
}

/** Every line the activity log holds, oldest first, as written. */
async function activityText(harness: Harness): Promise<string> {
  const directory = harness.core.activity.directory;
  const days = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort();
  const texts = await Promise.all(days.map((day) => readFile(join(directory, day), 'utf8')));
  return texts.join('');
}

async function lines(harness: Harness): Promise<ActivityLine[]> {
  return (await activityText(harness))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityLine);
}

/** The lines `call` added: asserting it added exactly `expected` of them. */
async function recordedBy(harness: Harness, call: () => Promise<unknown>, expected = 1): Promise<ActivityLine[]> {
  const before = (await lines(harness)).length;
  await call().catch(() => undefined);
  const added = (await lines(harness)).slice(before);
  assert.equal(added.length, expected, `expected ${expected} line(s), got ${JSON.stringify(added, null, 2)}`);
  return added;
}

async function onlyLine(harness: Harness, call: () => Promise<unknown>): Promise<ActivityLine> {
  return (await recordedBy(harness, call))[0] as ActivityLine;
}

const SAM = { name: 'Sam Lee', address: 'sam@partner.test' };

test('a search records its query, its count, and each row by id, subject and sender', async () => {
  const { harness, context, inboxId } = await connected();
  const line = await onlyLine(harness, () =>
    search(context, { query: 'invoice', inboxes: ['work'], kind: 'messages' }),
  );
  assert.equal(line.channel, 'gmail');
  assert.equal(line.operation, 'gmail.search');
  assert.equal(line.kind, 'read');
  assert.equal(line.outcome, 'ok');
  assert.deepEqual(line.account, { id: inboxId, alias: 'work' });
  assert.equal(line.query, 'invoice');
  assert.equal(line.count, 2);
  assert.deepEqual(line.items, [
    { id: 'm2', subject: 'Re: Invoice March', from: SAM },
    { id: 'm1', subject: 'Invoice March', from: SAM },
  ]);
  assert.equal(line.session.surface, 'cli');
  assert.equal(typeof line.ms, 'number');
});

test('reading a message, a thread and a timeline each record one line of what was read', async () => {
  const { harness, context } = await connected();
  const message = await onlyLine(harness, () => readMessage(context, 'work', 'm1'));
  assert.equal(message.operation, 'gmail.message.read');
  assert.deepEqual(message.items, [{ id: 'm1', subject: 'Invoice March', from: SAM }]);

  const thread = await onlyLine(harness, () => readThread(context, 'work', 't1'));
  assert.equal(thread.operation, 'gmail.thread.read');
  assert.equal(thread.count, 2);
  assert.deepEqual(
    thread.items?.map((item) => item.id),
    ['m1', 'm2'],
  );
  assert.deepEqual(thread.items?.[1], { id: 'm2', subject: 'Re: Invoice March', from: SAM });

  // The timeline reads its thread on the way: one line, the timeline's.
  const timeline = await onlyLine(harness, () => threadTimeline(context, 'work', 't1'));
  assert.equal(timeline.operation, 'gmail.thread.timeline');
  assert.equal(timeline.kind, 'read');
  assert.equal(timeline.count, 2);
  assert.deepEqual(timeline.items?.[0], { id: 'm1', subject: 'Invoice March', from: SAM });
  assert.deepEqual(timeline.items?.[1], { id: 'm2', from: SAM });
});

test('two calls at once record two lines, neither inside the other', async () => {
  const { harness, context } = await connected();
  const added = await recordedBy(
    harness,
    () => Promise.all([readMessage(context, 'work', 'm1'), readThread(context, 'work', 't1')]),
    2,
  );
  assert.deepEqual(added.map((line) => line.operation).sort(), ['gmail.message.read', 'gmail.thread.read']);
});

test('finding and downloading attachments record each file by name and size, and the question by its id', async () => {
  const { harness, context } = await connected();
  const found = await onlyLine(harness, () => findAttachments(context, { inboxes: ['work'], filename: 'invoice' }));
  assert.equal(found.operation, 'gmail.attachments.find');
  assert.match(found.query ?? '', /has:attachment filename:invoice/);
  assert.equal(found.count, 2);
  assert.deepEqual(found.items?.[0], {
    id: 'm2/1',
    subject: 'Re: Invoice March',
    from: { address: 'sam@partner.test' },
    name: 'invoice.pdf',
    size: BYTES.length,
  });

  let question: DownloadQuestion | undefined;
  const asked = await onlyLine(harness, async () => {
    question = (await downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }])) as DownloadQuestion;
  });
  assert.ok(question?.destinationRequired);
  assert.equal(asked.operation, 'gmail.attachments.download');
  assert.equal(asked.kind, 'read');
  assert.equal(asked.approvalId, question.choiceId);
  assert.deepEqual(asked.counts, { toSave: 1, skipped: 0 });
  assert.equal(asked.items?.[0]?.name, 'invoice.pdf');

  const saved = await onlyLine(harness, () =>
    downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }], {
      saveTo: 'downloads',
      choiceId: question?.choiceId,
    }),
  );
  assert.equal(saved.outcome, 'ok');
  assert.equal(saved.approvalId, question.choiceId);
  assert.deepEqual(saved.counts, { saved: 1, skipped: 0 });
  assert.deepEqual(saved.items, [
    {
      id: 'm1/1',
      subject: 'Invoice March',
      from: { address: 'sam@partner.test' },
      name: 'invoice.pdf',
      size: BYTES.length,
    },
  ]);
});

test('contacts record the words searched for and a count, never the people found', async () => {
  const { harness, context } = await connected();
  const line = await onlyLine(harness, () => searchContacts(context, 'sam', { inboxes: ['work'] }));
  assert.equal(line.operation, 'gmail.contacts.search');
  assert.equal(line.query, 'sam');
  assert.equal(typeof line.count, 'number');
  assert.equal(line.items, undefined);
  assert.doesNotMatch(JSON.stringify(line), /partner\.test/);
});

test('follow-ups, labels, send-as and whoami each record one read', async () => {
  const { harness, context } = await connected();
  const follow = await onlyLine(harness, () => followUps(context, { inboxes: ['work'], direction: 'me' }));
  assert.equal(follow.operation, 'gmail.followups');
  assert.equal(follow.kind, 'read');
  assert.deepEqual(follow.items?.[0], {
    id: 't1',
    subject: 'Re: Invoice March',
    from: { address: 'sam@partner.test' },
  });

  const labels = await onlyLine(harness, () => listLabels(context, 'work'));
  assert.equal(labels.operation, 'gmail.labels.list');
  assert.equal(typeof labels.count, 'number');

  const sendAs = await onlyLine(harness, () => listSendAs(context, 'work'));
  assert.equal(sendAs.operation, 'gmail.sendas.list');
  assert.equal(sendAs.count, 1);

  const profile = await onlyLine(harness, () => whoami(context, 'work'));
  assert.equal(profile.operation, 'gmail.whoami');
  assert.equal(profile.outcome, 'ok');
});

test('an export records one line, the file it wrote, and not the read it made on the way', async () => {
  const { harness, context } = await connected();
  for (const thread of [false, true]) {
    const line = await onlyLine(harness, () => exportMail(context, 'work', thread ? 't1' : 'm1', { thread }));
    assert.equal(line.operation, 'gmail.export');
    assert.equal(line.kind, 'read');
    assert.equal(line.items?.length, 1);
    assert.equal(line.items?.[0]?.id, thread ? 't1' : 'm1');
    assert.match(line.items?.[0]?.name ?? '', thread ? /_thread-t1\.md$/ : /_message-m1\.md$/);
    assert.ok((line.items?.[0]?.size ?? 0) > 0);
    assert.deepEqual(line.counts, { messages: thread ? 2 : 1 });
  }
});

test('drafts record their id and subject; a list records each', async () => {
  const { harness, context } = await connected();
  let draftId = '';
  const created = await onlyLine(harness, async () => {
    draftId = (await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY })).draftId;
  });
  assert.equal(created.operation, 'gmail.draft.create');
  assert.equal(created.kind, 'write');
  assert.deepEqual(created.items, [{ id: draftId, subject: 'Plan' }]);

  const updated = await onlyLine(harness, () =>
    updateDraft(context, 'work', draftId, { to: ['sam@partner.test'], subject: 'Plan, v2', text: BODY }),
  );
  assert.equal(updated.operation, 'gmail.draft.update');
  assert.deepEqual(updated.items, [{ id: draftId, subject: 'Plan, v2' }]);

  const shown = await onlyLine(harness, () => getDraft(context, 'work', draftId));
  assert.equal(shown.operation, 'gmail.draft.get');
  assert.equal(shown.kind, 'read');
  assert.deepEqual(shown.items, [{ id: draftId, subject: 'Plan, v2' }]);

  const listed = await onlyLine(harness, () => listDrafts(context, 'work'));
  assert.equal(listed.operation, 'gmail.draft.list');
  assert.deepEqual(listed.items, [{ id: draftId, subject: 'Plan, v2' }]);

  const reply = await onlyLine(harness, () => replyDraft(context, 'work', 'm1', { text: BODY }));
  assert.equal(reply.operation, 'gmail.draft.reply');
  assert.equal(reply.kind, 'write');
  assert.equal(reply.items?.[0]?.subject, 'Re: Invoice March');

  const deleted = await onlyLine(harness, () => deleteDraft(context, 'work', draftId));
  assert.equal(deleted.operation, 'gmail.draft.delete');
  assert.deepEqual(deleted.items, [{ id: draftId }]);
});

test('a send records the approval asked for, then what was sent, to whom, around the gate', async () => {
  const { harness, context, inboxId } = await connected();
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });

  let approvalId = '';
  const prepared = await onlyLine(harness, async () => {
    approvalId = (await prepareSend(context, 'work', draftId)).approvalId;
  });
  assert.equal(prepared.operation, 'gmail.send.prepare');
  assert.equal(prepared.kind, 'approval');
  assert.equal(prepared.approvalId, approvalId);
  assert.deepEqual(prepared.items, [{ id: draftId, subject: 'Plan' }]);
  assert.deepEqual(prepared.recipients, ['sam@partner.test']);

  let sentId: string | undefined;
  const sent = await onlyLine(harness, async () => {
    sentId = (await executeSend(context, 'work', { approvalId })).sentMessageId;
  });
  assert.ok(sentId);
  assert.equal(sent.operation, 'gmail.send.execute');
  assert.equal(sent.kind, 'write');
  assert.equal(sent.outcome, 'ok');
  assert.deepEqual(sent.account, { id: inboxId, alias: 'work' });
  assert.equal(sent.approvalId, approvalId);
  assert.deepEqual(sent.items, [{ id: sentId, subject: 'Plan' }]);
  assert.deepEqual(sent.recipients, ['sam@partner.test']);

  // Used: sending again is refused, and recorded as refused.
  const again = await onlyLine(harness, () => executeSend(context, 'work', { approvalId }));
  assert.equal(again.operation, 'gmail.send.execute');
  assert.equal(again.outcome, 'refused');
  assert.match(again.reason ?? '', /^APPROVAL_/);
});

test('cancelling a send records the approval ended, against its mailbox', async () => {
  const { harness, context, inboxId } = await connected();
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  const { approvalId } = await prepareSend(context, 'work', draftId);
  const cancelled = await onlyLine(harness, () => revokeApproval(context, approvalId));
  assert.equal(cancelled.operation, 'gmail.send.cancel');
  assert.equal(cancelled.kind, 'approval');
  assert.equal(cancelled.outcome, 'ok');
  assert.equal(cancelled.approvalId, approvalId);
  assert.deepEqual(cancelled.account, { id: inboxId, alias: 'work' });
});

test('a send the policy refuses is recorded as refused, with why', async () => {
  const { harness, context } = await connected({ sendPolicy: 'never' });
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  const line = await onlyLine(harness, () => prepareSend(context, 'work', draftId));
  assert.equal(line.operation, 'gmail.send.prepare');
  assert.equal(line.outcome, 'refused');
  assert.match(line.reason ?? '', /^POLICY_NEVER: /);
});

test('organising, undoing, binning and labelling record the messages they changed', async () => {
  const { harness, context } = await connected();
  const dry = await onlyLine(harness, () =>
    modify(context, 'work', { messageIds: ['m1'], archive: true, dryRun: true }),
  );
  assert.equal(dry.operation, 'gmail.organise');
  assert.equal(dry.kind, 'read', 'a dry run changes nothing');

  let undo: Parameters<typeof applyUndo>[2] = [];
  const archived = await onlyLine(harness, async () => {
    undo = (await modify(context, 'work', { messageIds: ['m1'], archive: true })).undo ?? [];
  });
  assert.equal(archived.kind, 'write');
  assert.equal(archived.count, 1);
  assert.deepEqual(archived.items, [{ id: 'm1' }]);

  const undone = await onlyLine(harness, () => applyUndo(context, 'work', undo));
  assert.equal(undone.operation, 'gmail.organise.undo');
  assert.deepEqual(undone.items, [{ id: 'm1' }]);

  const binned = await onlyLine(harness, () => trash(context, 'work', { threadIds: ['t1'] }));
  assert.equal(binned.operation, 'gmail.trash');
  assert.equal(binned.kind, 'write');
  assert.deepEqual(binned.items?.map((item) => item.id).sort(), ['m1', 'm2']);

  const label = await onlyLine(harness, () => createLabel(context, 'work', 'Agent'));
  assert.equal(label.operation, 'gmail.label.create');
  assert.equal(label.items?.length, 1);
});

test('a call that fails is recorded as failed, and one refused for a usage mistake as refused', async () => {
  const { harness, context } = await connected();
  const missing = await onlyLine(harness, () => readMessage(context, 'work', 'no-such-message'));
  assert.equal(missing.operation, 'gmail.message.read');
  assert.equal(missing.outcome, 'failed');
  assert.ok(missing.reason);

  const empty = await onlyLine(harness, () => search(context, { query: 'x', inboxes: [] }));
  assert.equal(empty.outcome, 'refused');
  assert.match(empty.reason ?? '', /^USAGE: /);

  const unknown = await onlyLine(harness, () => readMessage(context, 'nowhere', 'm1'));
  assert.deepEqual(unknown.account, { id: '', alias: 'nowhere' });
});

test('a search of several mailboxes is one line, naming them all', async () => {
  const { harness, context } = await connected();
  await harness.addInbox({ alias: 'home', email: 'jo@home.test', refreshToken: 'not-refreshable' });
  const line = await onlyLine(harness, () => search(context, { query: 'invoice' }));
  assert.deepEqual(line.account, { id: '', alias: 'home,work' });
  assert.equal(line.count, 1, 'work answered, home could not');
});

test('no body, snippet or attachment byte reaches the activity log', async () => {
  const { harness, context } = await connected();
  await search(context, { query: 'invoice', inboxes: ['work'] });
  await readMessage(context, 'work', 'm1');
  await readThread(context, 'work', 't1');
  await threadTimeline(context, 'work', 't1');
  await exportMail(context, 'work', 't1', { thread: true, format: 'json' });
  const question = (await downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }])) as DownloadQuestion;
  await downloadAttachments(context, 'work', [{ messageId: 'm1', partId: '1' }], {
    saveTo: 'downloads',
    choiceId: question.choiceId,
  });
  const { draftId } = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Plan', text: BODY });
  await getDraft(context, 'work', draftId);
  const { approvalId } = await prepareSend(context, 'work', draftId);
  await executeSend(context, 'work', { approvalId });

  const text = await activityText(harness);
  assert.ok((await lines(harness)).length >= 10, 'every call above recorded a line');
  for (const secret of [BODY, SNIPPET, BYTES, base64url(BODY), base64url(BYTES)]) {
    assert.equal(text.includes(secret), false, `the activity log holds ${secret}`);
  }
  assert.equal(text.includes('untrusted-content'), false, 'fields are kept as written, not as enveloped');
});

test('the tool and the command record the same line, each with its own surface', async () => {
  const { harness } = await connected();
  const mcp = await connect({ core: harness.core, env: harness.env });
  try {
    const line = await onlyLine(harness, async () =>
      wire(await mcp.call('gmail_search', { inboxes: ['work'], query: 'invoice' })),
    );
    assert.equal(line.operation, 'gmail.search');
    assert.equal(line.session.surface, 'mcp');
    assert.deepEqual(line.session.client, { name: 'test-client', version: '1.0.0' });
    assert.equal(line.count, 1);
  } finally {
    await mcp.close();
  }

  const command = await onlyLine(harness, async () => {
    const run = await cli(harness, ['search', 'invoice', '--inbox', 'work', '--json']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
  });
  assert.equal(command.operation, 'gmail.search');
  assert.equal(command.session.surface, 'cli');
  assert.equal(command.session.client, undefined);
  assert.equal(command.query, 'invoice');
});
