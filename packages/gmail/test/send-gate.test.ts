import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@cloudpixel/comms-core';
import { GmailContext } from '../src/context.ts';
import { createDraft } from '../src/operations/drafts.ts';
import {
  beginApproval,
  executeSend,
  finishApproval,
  listApprovals,
  prepareSend,
  revokeApproval,
} from '../src/operations/send.ts';
import type { FakeGoogle } from './support/fake-google.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * The gate, end to end. Everything here is about one promise: **nothing leaves the mailbox that a person has not seen
 * in the form it will arrive in** — and where that promise is narrower than it sounds, the test says so rather than
 * pretending otherwise.
 */

async function connected(
  options: { sendPolicy?: 'chat' | 'confirm' | 'never'; riskEscalation?: boolean } = {},
): Promise<{ harness: Harness; context: GmailContext; google: FakeGoogle }> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [{ sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true }],
      },
    ],
  });
  await harness.connectInbox({
    alias: 'work',
    email: 'jo@example.test',
    sub: 'sub-1',
    sendPolicy: options.sendPolicy ?? 'chat',
  });
  if (options.riskEscalation === false) {
    // Turning escalation off is a loosening, and the store refuses one without consent — exactly as it would for a
    // person. The test passes the consent a terminal would have obtained, rather than writing around the gate.
    await harness.core.config.update(
      (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
      { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
    );
  }
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }), google: harness.google };
}

async function draftTo(context: GmailContext, to: string[], text = 'Tuesday works for me.'): Promise<string> {
  const draft = await createDraft(context, 'work', { to, subject: 'Tuesday', text });
  return draft.draftId;
}

test('prepare shows the message, records an approval, and sends nothing', async () => {
  const { context, google } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);

  const prepared = await prepareSend(context, 'work', draftId);
  assert.match(prepared.approvalId, /^ap_/);
  assert.equal(prepared.effectivePolicy, 'chat');
  assert.match(prepared.preview, /SEND PREVIEW/);
  assert.match(prepared.preview, /nothing has been sent/);
  assert.match(prepared.preview, /Tuesday works for me\./);
  assert.match(prepared.preview, /── To sam@partner\.test/, 'the recipients are repeated after the body');
  assert.match(prepared.preview, /Policy: chat/);
  assert.deepEqual(prepared.expect.to, ['sam@partner.test']);

  // Preparing is not sending, and nothing reached a send endpoint.
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
});

test('a send goes through, once, and is read back from Sent', async () => {
  const { context, google, harness } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);

  const sent = await executeSend(context, 'work', {
    draftId,
    approvalId: prepared.approvalId,
    expect: prepared.expect,
  });
  assert.ok(sent.sentMessageId);
  assert.deepEqual(sent.to, ['sam@partner.test']);
  assert.ok(sent.verified?.labelIds.includes('SENT'), 'the message Gmail filed is in Sent');
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 1);

  // The same approval cannot be used twice: the claim marker is the guarantee, across processes.
  await assert.rejects(
    executeSend(context, 'work', { draftId, approvalId: prepared.approvalId, expect: prepared.expect }),
    (error: unknown) => error instanceof CommsError && error.code.startsWith('APPROVAL'),
  );
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 1, 'still one send');

  const audit = await harness.core.audit.tail({ inbox: 'work' });
  const executed = audit.find((entry) => entry.operation === 'send.execute');
  assert.ok(executed, 'a send is always audited');
  assert.deepEqual(executed?.recipients, ['sam@partner.test'], 'who it went to, not just the domain');
});

test('editing the draft after the preview voids the approval, and nothing is sent', async () => {
  const { context, google } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);

  const { updateDraft } = await import('../src/operations/drafts.ts');
  await updateDraft(context, 'work', draftId, { text: 'Actually, Wednesday.' });

  await assert.rejects(
    executeSend(context, 'work', { draftId, approvalId: prepared.approvalId, expect: prepared.expect }),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'APPROVAL_VOID');
      return true;
    },
  );
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
});

test('recipients that do not match the ones approved are refused', async () => {
  const { context, google } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);

  await assert.rejects(
    executeSend(context, 'work', {
      draftId,
      approvalId: prepared.approvalId,
      // What the agent claims it is sending, which is not what the draft says.
      expect: { ...prepared.expect, to: ['someone@else.test'] },
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
  );
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
});

test('under confirm, no argument an agent can pass will send: only a typed approval', async () => {
  const { context, google } = await connected({ sendPolicy: 'confirm', riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);
  assert.equal(prepared.effectivePolicy, 'confirm');
  assert.match(prepared.nextStep, /cannot approve this yourself/);

  await assert.rejects(
    executeSend(context, 'work', { draftId, approvalId: prepared.approvalId, expect: prepared.expect }),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING',
  );
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 0);

  // The terminal path: the preview is shown again, from the draft as it is now, with a challenge to type back.
  const prompt = await beginApproval(context, prepared.approvalId);
  assert.match(prompt.preview, /SEND PREVIEW/);
  assert.equal(prompt.challenge.length, 4);

  await assert.rejects(
    finishApproval(context, prepared.approvalId, 'nope'),
    (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_REQUIRED',
  );
  await finishApproval(context, prepared.approvalId, prompt.challenge);

  const sent = await executeSend(context, 'work', {
    draftId,
    approvalId: prepared.approvalId,
    expect: prepared.expect,
  });
  assert.ok(sent.sentMessageId);
});

test('a policy of never refuses at prepare, before anything is computed', async () => {
  const { context } = await connected({ sendPolicy: 'never', riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  await assert.rejects(
    prepareSend(context, 'work', draftId),
    (error: unknown) => error instanceof CommsError && error.code === 'POLICY_NEVER',
  );
});

test('an address seen in mail we read escalates a chat send to confirm', async () => {
  const { context } = await connected();
  // A message arrived this week carrying an address nobody here has ever written to.
  await context.core.taint.record([{ address: 'payments@attacker.test', source: 'body', inboxId: 'ibx-any' }], {
    ownAddresses: ['jo@example.test'],
    internalDomains: ['example.test'],
  });

  const draftId = await draftTo(context, ['payments@attacker.test']);
  const prepared = await prepareSend(context, 'work', draftId);
  assert.equal(prepared.effectivePolicy, 'confirm', 'the agent cannot approve this one in the chat');
  assert.ok(prepared.riskFlags.includes('recipient-tainted'));
  assert.match(prepared.preview, /ADDRESS SEEN IN MAIL YOU READ/);
});

test('an approval can be cancelled, and cancelling is never refused', async () => {
  const { context } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);

  const open = await listApprovals(context, { inbox: 'work' });
  assert.equal(open.length, 1);
  assert.equal(open[0]?.state, 'pending');
  assert.ok(!('challengeHash' in (open[0] ?? {})), 'a challenge hash is never handed to a caller');

  await revokeApproval(context, prepared.approvalId);
  await assert.rejects(
    executeSend(context, 'work', { draftId, approvalId: prepared.approvalId, expect: prepared.expect }),
    (error: unknown) => error instanceof CommsError,
  );
});

test('a draft an agent could not have written is refused outright', async () => {
  const { context, google } = await connected({ riskEscalation: false });
  const account = google.accounts.get('sub-1');
  assert.ok(account);
  // A draft written in Gmail, carrying a tracking pixel: an agent could not have produced this, so it may not send it.
  const raw = [
    'From: Jo Example <jo@example.test>',
    'To: sam@partner.test',
    'Subject: Numbers',
    'Content-Type: text/html; charset="UTF-8"',
    '',
    '<p>Here they are.</p><img src="https://tracker.test/open.gif?id=42">',
  ].join('\r\n');
  const draftId = 'd_handwritten';
  account.drafts = {
    ...(account.drafts ?? {}),
    [draftId]: {
      id: draftId,
      message: {
        id: 'dm_handwritten',
        threadId: 't_handwritten',
        labelIds: ['DRAFT'],
        payload: {
          partId: '',
          mimeType: 'text/html',
          headers: [
            { name: 'From', value: 'Jo Example <jo@example.test>' },
            { name: 'To', value: 'sam@partner.test' },
            { name: 'Subject', value: 'Numbers' },
          ],
          body: { size: raw.length, data: Buffer.from(raw.split('\r\n\r\n')[1] ?? '', 'utf8').toString('base64url') },
        },
      },
    },
  };

  await assert.rejects(prepareSend(context, 'work', draftId), (error: unknown) => {
    assert.ok(error instanceof CommsError);
    assert.equal(error.code, 'UNSENDABLE_HTML');
    assert.match(error.hint ?? '', /send it from Gmail/);
    return true;
  });
  assert.equal(google.requests.filter((request) => request.path.endsWith('/send')).length, 0);
});

test('the rate cap stops a run of sends, and says when it lifts', async () => {
  const { context, harness } = await connected({ riskEscalation: false });
  // Lowering a cap is a tightening, so it needs no consent.
  await harness.core.config.update((config) => ({
    ...config,
    defaults: { ...config.defaults, sendCaps: { perHour: 1, perDay: 10 } },
  }));

  const first = await draftTo(context, ['sam@partner.test']);
  const firstApproval = await prepareSend(context, 'work', first);
  await executeSend(context, 'work', {
    draftId: first,
    approvalId: firstApproval.approvalId,
    expect: firstApproval.expect,
  });

  const second = await draftTo(context, ['sam@partner.test'], 'And one more thing.');
  const secondApproval = await prepareSend(context, 'work', second);
  await assert.rejects(
    executeSend(context, 'work', {
      draftId: second,
      approvalId: secondApproval.approvalId,
      expect: secondApproval.expect,
    }),
    (error: unknown) => error instanceof CommsError && error.code === 'RATE_CAPPED',
  );
});

test('the transport refuses a send endpoint reached without an approval', async () => {
  const { harness } = await connected({ riskEscalation: false });
  const { GoogleGmailTransport } = await import('../src/gmail-api/transport.ts');
  const { TokenSource } = await import('../src/auth/session.ts');
  const config = await harness.core.config.load();
  const inbox = config.inboxes.work;
  const client = config.clients.default;
  assert.ok(inbox && client);
  const transport = new GoogleGmailTransport({
    tokens: new TokenSource({ core: harness.core, endpoints: harness.endpoints, inbox, client, alias: 'work' }),
    endpoints: harness.endpoints,
  });

  // Reaching the endpoint directly, as a future caller might: the auth client refuses before a request is made.
  await assert.rejects(
    transport.call('send', () => transport.gmail().users.drafts.send({ userId: 'me', requestBody: { id: 'd_x' } })),
    (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'SEND_REFUSED');
      return true;
    },
  );
});

test('while a send is in flight, nothing else may touch the draft it is standing on', async () => {
  const { context, harness } = await connected({ riskEscalation: false });
  const draftId = await draftTo(context, ['sam@partner.test']);
  const prepared = await prepareSend(context, 'work', draftId);

  // Put the approval in `sending`, which is the window `executeSend` holds open around the final read.
  const record = await harness.core.approvals.get(prepared.approvalId);
  assert.ok(record);
  await harness.core.approvals.claimForSend(prepared.approvalId, {
    draftMessageId: record.draftMessageId,
    digest: record.digest,
    inboxId: record.inboxId,
    inboxSub: record.inboxSub,
    policy: 'chat',
    expect: record.expect,
  });

  const { modify, trash } = await import('../src/operations/organise.ts');
  const { updateDraft, deleteDraft } = await import('../src/operations/drafts.ts');
  const refuses = (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_PENDING';

  // The draft itself, which was already guarded.
  await assert.rejects(updateDraft(context, 'work', draftId, { text: 'changed' }), refuses);
  await assert.rejects(deleteDraft(context, 'work', draftId), refuses);
  // And the draft's *message*, reached through the organising tools — the same act one operation along.
  await assert.rejects(modify(context, 'work', { messageIds: [record.draftMessageId], addLabels: ['INBOX'] }), refuses);
  await assert.rejects(trash(context, 'work', { messageIds: [record.draftMessageId] }), refuses);

  // An unrelated message is not affected: the guard names one message, not the mailbox.
  const other = await draftTo(context, ['ana@partner.test'], 'Separate.');
  const otherDraft = await (await import('../src/operations/drafts.ts')).getDraft(context, 'work', other);
  await modify(context, 'work', { messageIds: [otherDraft.messageId], addLabels: ['INBOX'], dryRun: true });
});
