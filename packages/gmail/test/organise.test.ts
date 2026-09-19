import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agent-communications/core';
import { SCOPES } from '../src/auth/scopes.ts';
import { GmailContext } from '../src/context.ts';
import { applyUndo, createLabel, modify, resolveLabelIds, trash } from '../src/operations/organise.ts';
import type { FakeGoogle, FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness } from './support/harness.ts';

function base64url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function message(id: string, threadId: string, labels: string[]): FakeMessage {
  return {
    id,
    threadId,
    labelIds: labels,
    internalDate: String(Date.parse('2026-09-17T09:00:00Z')),
    payload: {
      partId: '',
      mimeType: 'text/plain',
      headers: [
        { name: 'From', value: 'sam@partner.test' },
        { name: 'Subject', value: `Message ${id}` },
      ],
      body: { size: 2, data: base64url('hi') },
    },
  };
}

async function connected(scopes: string[] = [SCOPES.gmailModify]): Promise<{
  harness: Harness;
  context: GmailContext;
  google: FakeGoogle;
}> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        messages: {
          m1: message('m1', 't1', ['INBOX', 'UNREAD']),
          m2: message('m2', 't1', ['INBOX']),
          m3: message('m3', 't2', ['INBOX', 'STARRED']),
        },
        labels: [
          { id: 'INBOX', name: 'INBOX', type: 'system' },
          { id: 'UNREAD', name: 'UNREAD', type: 'system' },
          { id: 'STARRED', name: 'STARRED', type: 'system' },
          { id: 'Label_9', name: 'Clients', type: 'user' },
        ],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', scopes });
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }), google: harness.google };
}

test('a label is found by name, by id, or by the system name in any case', async () => {
  const { context } = await connected();
  assert.deepEqual(await resolveLabelIds(context, 'work', ['Clients']), ['Label_9']);
  assert.deepEqual(await resolveLabelIds(context, 'work', ['clients']), ['Label_9']);
  assert.deepEqual(await resolveLabelIds(context, 'work', ['Label_9']), ['Label_9']);
  assert.deepEqual(await resolveLabelIds(context, 'work', ['inbox']), ['INBOX']);
  await assert.rejects(
    resolveLabelIds(context, 'work', ['no such label']),
    (error: unknown) => error instanceof CommsError && error.code === 'NOT_FOUND',
  );
});

test('a dry run says what would change and touches nothing', async () => {
  const { context, google } = await connected();
  const planned = await modify(context, 'work', { threadIds: ['t1'], archive: true, dryRun: true });

  assert.equal(planned.dryRun, true);
  assert.equal(planned.messages, 2, 'both messages in the thread');
  assert.deepEqual(planned.removeLabelIds, ['INBOX']);
  assert.deepEqual(planned.undo, [
    { messageId: 'm1', addLabelIds: ['INBOX'], removeLabelIds: [] },
    { messageId: 'm2', addLabelIds: ['INBOX'], removeLabelIds: [] },
  ]);

  // Nothing was asked of Gmail beyond reading the thread and the labels.
  assert.equal(google.requests.filter((request) => request.path.includes('batchModify')).length, 0);
  assert.deepEqual(google.accounts.get('sub-1')?.messages?.m1?.labelIds, ['INBOX', 'UNREAD']);
});

test('archiving, reading and starring are label changes, and can be put back', async () => {
  const { context, harness, google } = await connected();
  const result = await modify(context, 'work', {
    messageIds: ['m1'],
    archive: true,
    markRead: true,
    addLabels: ['Clients'],
  });

  assert.equal(result.messages, 1);
  assert.deepEqual(result.addLabelIds, ['Label_9']);
  assert.deepEqual(result.removeLabelIds.sort(), ['INBOX', 'UNREAD']);
  assert.deepEqual(google.accounts.get('sub-1')?.messages?.m1?.labelIds, ['Label_9']);

  // The undo restores exactly what each message had, so applying it returns the mailbox to where it started.
  const undo = result.undo;
  assert.ok(undo);
  await applyUndo(context, 'work', undo);
  assert.deepEqual((google.accounts.get('sub-1')?.messages?.m1?.labelIds ?? []).sort(), ['INBOX', 'UNREAD']);

  const audit = await harness.core.audit.tail({ inbox: 'work' });
  assert.ok(audit.some((entry) => entry.operation === 'modify'));
});

test('a change that contradicts itself, or changes nothing, is refused', async () => {
  const { context } = await connected();
  await assert.rejects(
    modify(context, 'work', { messageIds: ['m1'], addLabels: ['Clients'], removeLabels: ['Clients'] }),
    (error: unknown) => error instanceof CommsError && /both added and removed/.test(error.message),
  );
  await assert.rejects(
    modify(context, 'work', { messageIds: ['m1'] }),
    (error: unknown) => error instanceof CommsError && /nothing to change/.test(error.message),
  );
  await assert.rejects(
    modify(context, 'work', { archive: true }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('the bin is reversible, and nothing is ever deleted outright', async () => {
  const { context, google } = await connected();

  const planned = await trash(context, 'work', { threadIds: ['t1'], dryRun: true });
  assert.deepEqual(planned.messages, ['m1', 'm2']);
  assert.deepEqual(google.accounts.get('sub-1')?.messages?.m1?.labelIds, ['INBOX', 'UNREAD']);

  await trash(context, 'work', { messageIds: ['m3'] });
  const binned = google.accounts.get('sub-1')?.messages?.m3?.labelIds ?? [];
  assert.ok(binned.includes('TRASH'));
  assert.ok(!binned.includes('INBOX'));

  await trash(context, 'work', { messageIds: ['m3'], undo: true });
  const restored = google.accounts.get('sub-1')?.messages?.m3?.labelIds ?? [];
  assert.ok(!restored.includes('TRASH'));
  assert.ok(restored.includes('INBOX'));
});

test('creating a label twice is not an error', async () => {
  const { context } = await connected();
  const created = await createLabel(context, 'work', 'Invoices');
  assert.equal(created.existed, false);
  assert.match(created.id, /^Label_/);

  const again = await createLabel(context, 'work', 'invoices');
  assert.equal(again.existed, true);
  assert.equal(again.id, created.id, 'the same label, found by name whatever the case');

  await assert.rejects(
    createLabel(context, 'work', '   '),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('organising needs the permission to organise, checked before Google is called', async () => {
  const { context, google } = await connected([SCOPES.gmailReadonly]);
  await assert.rejects(modify(context, 'work', { messageIds: ['m1'], archive: true }), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'SCOPE_MISSING');
    assert.match(error.hint ?? '', /--tier organize/);
    return true;
  });
  assert.equal(google.requests.filter((request) => request.path.includes('batchModify')).length, 0);
});

test('the undo puts back what each message had, not what the selection had in common', async () => {
  const { context, google } = await connected();
  const account = google.accounts.get('sub-1');
  assert.ok(account);
  // m2 is already archived. A selection is rarely uniform, and this is the case a wholesale swap gets wrong.
  account.messages = {
    ...account.messages,
    m2: { ...(account.messages?.m2 ?? {}), id: 'm2', threadId: 't1', labelIds: ['UNREAD'] },
  };

  const archived = await modify(context, 'work', { messageIds: ['m1', 'm2'], archive: true });
  assert.equal(archived.messages, 2);
  // Only m1 had INBOX, so only m1 is put back.
  assert.deepEqual(archived.undo, [{ messageId: 'm1', addLabelIds: ['INBOX'], removeLabelIds: [] }]);

  await applyUndo(context, 'work', archived.undo ?? []);
  assert.ok(google.accounts.get('sub-1')?.messages?.m1?.labelIds?.includes('INBOX'));
  assert.ok(
    !google.accounts.get('sub-1')?.messages?.m2?.labelIds?.includes('INBOX'),
    'a message that was already archived stays archived — the undo restores, it does not impose',
  );
});
