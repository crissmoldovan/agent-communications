import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { type ActivityLine, gatedChange } from '@agentcomms/core';
import {
  downloadReceived,
  getMetrics,
  listDomains,
  listReceived,
  listScheduled,
  listSentEmails,
  listSuppressions,
  showReceived,
  showSentEmail,
} from '../src/operations/read.ts';
import { cancelScheduledChange } from '../src/operations/scheduled.ts';
import { executeSend, prepareSend, sendStatus } from '../src/operations/send.ts';
import { type Harness, newHarness, SENDING } from './support/harness.ts';

/*
 * The activity log, Resend's half (design 2026-10-25-activity §4.2, §8 Task 2a): every operation a capability row
 * names that reads or writes a Resend account records exactly one line — what it touched, never what it said — on the
 * command and the tool alike.
 */

let harness: Harness;
afterEach(async () => {
  await harness?.close();
});

/** Text that is only ever in a body or an attachment's bytes: none of it may reach the activity log. */
const BODY = 'Only-the-reader-sees-this-body-71c3e0';
const SENT_BODY = 'Only-the-recipient-reads-this-2f9b6d';
const BYTES = 'Only-the-attachment-bytes-5e8a14';

const RECEIVED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ATTACHMENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function seedReceived(): void {
  harness.fake.received = [
    {
      id: RECEIVED,
      from: 'Sam Lee <sam@partner.test>',
      to: ['hello@acme.test'],
      subject: 'Invoice March',
      html: `<p>${BODY}</p>`,
      text: BODY,
      message_id: '<received-1@partner.test>',
      attachments: [
        {
          id: ATTACHMENT,
          filename: 'invoice.pdf',
          content_type: 'application/pdf',
          bytes: new TextEncoder().encode(BYTES),
        },
      ],
    },
  ];
}

async function activityText(): Promise<string> {
  const directory = harness.core.activity.directory;
  const days = (await readdir(directory).catch(() => [])).filter((name) => name.endsWith('.jsonl')).sort();
  return (await Promise.all(days.map((day) => readFile(join(directory, day), 'utf8')))).join('');
}

async function lines(): Promise<ActivityLine[]> {
  return (await activityText())
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as ActivityLine);
}

/** The one line `call` added, asserting it added exactly one. */
async function onlyLine(call: () => Promise<unknown>): Promise<ActivityLine> {
  const before = (await lines()).length;
  await call().catch(() => undefined);
  const added = (await lines()).slice(before);
  assert.equal(added.length, 1, `expected one line, got ${JSON.stringify(added, null, 2)}`);
  return added[0] as ActivityLine;
}

const SAM = { name: 'Sam Lee', address: 'sam@partner.test' };

test('reading received mail records each email by id, subject and sender', async () => {
  harness = await newHarness();
  const account = await harness.addAccount({ name: 'acme/resend' });
  seedReceived();
  const context = harness.context();

  const listed = await onlyLine(() => listReceived(context, 'acme/resend'));
  assert.equal(listed.channel, 'resend');
  assert.equal(listed.operation, 'resend.received.list');
  assert.equal(listed.kind, 'read');
  assert.equal(listed.outcome, 'ok');
  assert.deepEqual(listed.account, { id: account.id, alias: 'acme/resend' });
  assert.equal(listed.count, 1);
  assert.deepEqual(listed.items, [{ id: RECEIVED, subject: 'Invoice March', from: SAM }]);
  assert.equal(listed.session.surface, 'cli');

  const shown = await onlyLine(() => showReceived(context, 'acme/resend', RECEIVED));
  assert.equal(shown.operation, 'resend.received.show');
  assert.deepEqual(shown.items, [{ id: RECEIVED, subject: 'Invoice March', from: SAM }]);

  const saved = await onlyLine(() => downloadReceived(context, 'acme/resend', RECEIVED));
  assert.equal(saved.operation, 'resend.received.download');
  assert.equal(saved.kind, 'read');
  assert.deepEqual(saved.items, [{ id: ATTACHMENT, name: 'invoice.pdf', size: BYTES.length }]);
  assert.deepEqual(saved.counts, { saved: 1 });
});

test('a send records the approval asked for, then what was sent, to whom; and the sent mail reads back', async () => {
  harness = await newHarness();
  const account = await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context();

  let approvalId = '';
  const prepared = await onlyLine(async () => {
    approvalId = (
      await prepareSend(context, 'acme/resend', {
        from: 'Jo Example <hello@acme.test>',
        to: ['sam@partner.test'],
        subject: 'Hello',
        text: SENT_BODY,
      })
    ).approvalId;
  });
  assert.equal(prepared.operation, 'resend.send.prepare');
  assert.equal(prepared.kind, 'approval');
  assert.equal(prepared.approvalId, approvalId);
  assert.deepEqual(prepared.items, [{ id: approvalId, subject: 'Hello' }]);
  assert.deepEqual(prepared.recipients, ['sam@partner.test']);

  let resendId: string | undefined;
  const sent = await onlyLine(async () => {
    resendId = (await executeSend(context, 'acme/resend', { approvalId })).resendId;
  });
  assert.ok(resendId);
  assert.equal(sent.operation, 'resend.send.execute');
  assert.equal(sent.kind, 'write');
  assert.equal(sent.outcome, 'ok');
  assert.deepEqual(sent.account, { id: account.id, alias: 'acme/resend' });
  assert.equal(sent.approvalId, approvalId);
  assert.deepEqual(sent.items, [{ id: resendId, subject: 'Hello' }]);
  assert.deepEqual(sent.recipients, ['sam@partner.test']);

  const again = await onlyLine(() => executeSend(context, 'acme/resend', { approvalId }));
  assert.equal(again.outcome, 'refused', 'a used approval is refused');

  const status = await onlyLine(() => sendStatus(context, 'acme/resend', approvalId));
  assert.equal(status.operation, 'resend.send.status');
  assert.equal(status.kind, 'read');
  assert.equal(status.approvalId, approvalId);
  assert.deepEqual(status.items, [{ id: resendId }]);

  const list = await onlyLine(() => listSentEmails(context, 'acme/resend'));
  assert.equal(list.operation, 'resend.emails.list');
  assert.equal(list.items?.[0]?.id, resendId);
  assert.equal(list.items?.[0]?.subject, 'Hello');
  assert.deepEqual(list.items?.[0]?.from, { name: 'Jo Example (agent)', address: 'hello@acme.test' });

  const one = await onlyLine(() => showSentEmail(context, 'acme/resend', resendId));
  assert.equal(one.operation, 'resend.emails.show');
  assert.equal(one.items?.[0]?.id, resendId);
});

test('domains, metrics and suppressions record a read; a key that cannot read records a refusal', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend' });
  await harness.addAccount({ name: 'other/resend', tier: 'sending_access', key: SENDING });
  const context = harness.context();

  const domains = await onlyLine(() => listDomains(context, 'acme/resend'));
  assert.equal(domains.operation, 'resend.domains');
  assert.equal(domains.count, 2);

  const metrics = await onlyLine(() => getMetrics(context, 'acme/resend'));
  assert.equal(metrics.operation, 'resend.metrics');
  assert.equal(metrics.outcome, 'ok');

  harness.fake.suppressions = [
    {
      id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
      email: 'gone@partner.test',
      origin: 'bounce',
      source_id: null,
      created_at: '2026-10-20',
    },
  ];
  const suppressed = await onlyLine(() => listSuppressions(context, 'acme/resend'));
  assert.equal(suppressed.operation, 'resend.suppressions');
  assert.equal(suppressed.count, 1);
  assert.doesNotMatch(JSON.stringify(suppressed), /gone@partner\.test/, 'never the addresses');

  const refused = await onlyLine(() => listDomains(context, 'other/resend'));
  assert.equal(refused.outcome, 'refused');
  assert.match(refused.reason ?? '', /can only send email/);

  const usage = await onlyLine(() => getMetrics(context, 'acme/resend', { start: 'last week' }));
  assert.equal(usage.outcome, 'refused');
  assert.match(usage.reason ?? '', /^USAGE: /);
});

test('scheduled mail: a list records each email, and a cancel records the write once', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  const context = harness.context('mcp');
  const at = new Date(Date.now() + 3600 * 1000).toISOString();
  const prepared = await prepareSend(context, 'acme/resend', {
    from: 'hello@acme.test',
    to: ['sam@partner.test'],
    subject: 'Later',
    text: SENT_BODY,
    scheduledAt: at,
  });
  const ours = await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
  const resendId = ours.resendId as string;

  const listed = await onlyLine(() => listScheduled(context, 'acme/resend'));
  assert.equal(listed.operation, 'resend.scheduled.list');
  assert.deepEqual(
    listed.items?.map((item) => [item.id, item.subject]),
    [[resendId, 'Later']],
  );

  const cancelled = await onlyLine(() =>
    gatedChange(context.core, cancelScheduledChange(context, 'acme/resend', resendId), {
      channel: 'resend',
      surface: 'mcp',
    }),
  );
  assert.equal(cancelled.operation, 'resend.scheduled.cancel');
  assert.equal(cancelled.kind, 'write');
  assert.equal(cancelled.outcome, 'ok');
  assert.deepEqual(cancelled.items, [{ id: resendId }]);
  assert.deepEqual(cancelled.counts, { recipients: 1 });
  assert.equal(cancelled.session.surface, 'mcp');

  // Cancelled now, so the look refuses it: the same line, refused, and the same error.
  const again = await onlyLine(() =>
    gatedChange(context.core, cancelScheduledChange(context, 'acme/resend', resendId), {
      channel: 'resend',
      surface: 'mcp',
    }),
  );
  assert.equal(again.operation, 'resend.scheduled.cancel');
  assert.equal(again.outcome, 'failed');
  assert.match(again.reason ?? '', /is not scheduled/);
});

test('no body, no sent text and no attachment byte reaches the activity log', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend', mode: 'send' });
  seedReceived();
  const context = harness.context();
  // Sent first: once Sam's mail is read, a send to Sam would wait for a terminal.
  const prepared = await prepareSend(context, 'acme/resend', {
    from: 'hello@acme.test',
    to: ['sam@partner.test'],
    subject: 'Hello',
    text: SENT_BODY,
  });
  const sent = await executeSend(context, 'acme/resend', { approvalId: prepared.approvalId });
  await showSentEmail(context, 'acme/resend', sent.resendId);
  await listReceived(context, 'acme/resend');
  await showReceived(context, 'acme/resend', RECEIVED);
  await downloadReceived(context, 'acme/resend', RECEIVED);

  const text = await activityText();
  assert.ok((await lines()).length >= 6, 'every call above recorded a line');
  for (const secret of [BODY, SENT_BODY, BYTES]) {
    assert.equal(text.includes(secret), false, `the activity log holds ${secret}`);
  }
  assert.equal(text.includes('untrusted-content'), false, 'fields are kept as written, not as enveloped');
});

test('the tool and the command record the same line, each with its own surface', async () => {
  harness = await newHarness();
  await harness.addAccount({ name: 'acme/resend' });
  seedReceived();

  const mcp = await harness.mcp();
  try {
    const line = await onlyLine(async () => {
      const result = await mcp.call('resend_received_list', { account: 'acme/resend' });
      assert.notEqual(result.isError, true, JSON.stringify(result.structuredContent));
    });
    assert.equal(line.operation, 'resend.received.list');
    assert.equal(line.session.surface, 'mcp');
    assert.deepEqual(line.session.client, { name: 'test', version: '0' });
  } finally {
    await mcp.close();
  }

  const command = await onlyLine(async () => {
    const run = await harness.cli(['--json', 'received', 'list', '--account', 'acme/resend']);
    assert.equal(run.code, 0, run.stdout + run.stderr);
  });
  assert.equal(command.operation, 'resend.received.list');
  assert.equal(command.session.surface, 'cli');
  assert.equal(command.session.client, undefined);
});
