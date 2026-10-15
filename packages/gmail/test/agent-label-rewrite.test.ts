import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, type Config, UNLABELLED_PREVIEW_LINE } from '@agentcomms/core';
import { GmailContext } from '../src/context.ts';
import { createDraft } from '../src/operations/drafts.ts';
import { executeSend, prepareSend } from '../src/operations/send.ts';
import type { FakeMessage } from './support/fake-google.ts';
import { type Harness, newHarness } from './support/harness.ts';

/**
 * G2 (design 2026-10-15-agent-label §5): a draft whose From does not fit its identity — written in Gmail, written
 * before the label, or one whose identity a rule or `as` changed — is rewritten at prepare in its From header and
 * nowhere else, and the draft is replaced with the result. Every other byte of the raw message is the one Gmail held,
 * which these tests check against the bytes themselves, on plain, HTML and attachment drafts and on encoded and
 * folded From lines (the plan's review focus 3).
 */

const ALL_LABEL_PATHS = ['agentLabel.word', 'agentLabel.name', 'agentLabel.rules', 'agentLabel.slackIcons'];

async function label(harness: Harness, settings: Record<string, unknown>): Promise<void> {
  const added = { agentLabel: settings };
  await harness.core.config.update((config): Config => ({ ...config, ...added }), {
    consent: { kind: 'loosening-consent', paths: ALL_LABEL_PATHS },
  });
}

async function connected(): Promise<{ harness: Harness; context: GmailContext }> {
  const harness = await newHarness({
    accounts: [
      {
        sub: 'sub-1',
        email: 'jo@example.test',
        sendAs: [
          { sendAsEmail: 'jo@example.test', displayName: 'Jo Example', isDefault: true, isPrimary: true },
          // An alias Gmail has not verified: not one this mailbox may send as.
          { sendAsEmail: 'pending@example.test', displayName: 'Pending', verificationStatus: 'pending' },
        ],
      },
    ],
  });
  await harness.connectInbox({ alias: 'work', email: 'jo@example.test', sub: 'sub-1', sendPolicy: 'chat' });
  // Escalation is about who receives a message; these tests are about who it is from.
  await harness.core.config.update(
    (config) => ({ ...config, defaults: { ...config.defaults, riskEscalation: false } }),
    { consent: { kind: 'loosening-consent', paths: ['defaults.riskEscalation'] } },
  );
  return { harness, context: new GmailContext({ core: harness.core, env: harness.env }) };
}

/** A draft written somewhere else, saved through the API as a client would save it: these exact bytes. */
async function plant(context: GmailContext, lines: readonly string[]): Promise<string> {
  const transport = await context.transport('work');
  const created = await transport.createDraft(Buffer.from(lines.join('\r\n'), 'utf8'));
  return created.draftId;
}

function stored(harness: Harness, draftId: string): { raw: Buffer; messageId: string } {
  const draft = harness.google.accounts.get('sub-1')?.drafts?.[draftId];
  assert.ok(draft?.raw, `the fake holds draft ${draftId}'s raw bytes`);
  return { raw: Buffer.from(draft.raw, 'base64url'), messageId: draft.message.id ?? '' };
}

/**
 * The From header field of a raw message, found by this test's own reading rather than the code's: the one header
 * line, at the start of a line in the header block, that names From, with every folded line that continues it.
 */
function fromField(raw: Buffer): { start: number; end: number; text: string } {
  const text = raw.toString('latin1');
  const split = text.indexOf('\r\n\r\n');
  const head = split < 0 ? text : text.slice(0, split + 2);
  const found = [...head.matchAll(/(?:^|\r\n)(From:[^\r\n]*(?:\r\n[ \t][^\r\n]*)*)/gi)];
  assert.equal(found.length, 1, 'exactly one From field in the header block');
  const match = found[0] as RegExpMatchArray;
  const start = (match.index ?? 0) + match[0].length - (match[1] ?? '').length;
  return { start, end: start + (match[1] ?? '').length, text: match[1] ?? '' };
}

/** Every byte outside the From field is the one it was. */
function assertOnlyFromChanged(before: Buffer, after: Buffer, now: RegExp): void {
  const was = fromField(before);
  const is = fromField(after);
  assert.ok(before.subarray(0, was.start).equals(after.subarray(0, is.start)), 'the bytes before From are unchanged');
  assert.ok(before.subarray(was.end).equals(after.subarray(is.end)), 'the bytes after From are unchanged');
  assert.notEqual(was.text, is.text, 'the From field itself was rewritten');
  assert.match(is.text, now);
}

const PLAIN = [
  'MIME-Version: 1.0',
  'Date: Thu, 15 Oct 2026 09:00:00 +0000',
  'Message-ID: <plain-1@mail.example.test>',
  'Subject: Tuesday',
  'From: Jo Example <jo@example.test>',
  'To: Sam Lee <sam@partner.test>',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Tuesday works for me.',
  '',
];

const HTML = [
  'MIME-Version: 1.0',
  'From: Jo Example <jo@example.test>',
  'Date: Thu, 15 Oct 2026 09:00:00 +0000',
  'Subject: Tuesday',
  'To: sam@partner.test',
  'Content-Type: multipart/alternative; boundary="000000000000a1b2c3"',
  '',
  '--000000000000a1b2c3',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'Tuesday works for me.',
  '',
  '--000000000000a1b2c3',
  'Content-Type: text/html; charset="UTF-8"',
  '',
  '<div dir="ltr">Tuesday works for me.</div>',
  '',
  '--000000000000a1b2c3--',
  '',
];

const ATTACHMENT = [
  'MIME-Version: 1.0',
  'Subject: The plan',
  'To: sam@partner.test',
  'From: Jo Example <jo@example.test>',
  'Content-Type: multipart/mixed; boundary="mixed-boundary-1"',
  '',
  '--mixed-boundary-1',
  'Content-Type: text/plain; charset="UTF-8"',
  '',
  'The plan is attached.',
  '',
  '--mixed-boundary-1',
  'Content-Type: application/pdf; name="plan.pdf"',
  'Content-Disposition: attachment; filename="plan.pdf"',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('%PDF-1.4 a synthetic plan').toString('base64'),
  '',
  '--mixed-boundary-1--',
  '',
];

const ENCODED = PLAIN.map((line) =>
  line.startsWith('From:') ? 'From: =?UTF-8?Q?Jo_Exampl=C3=A9?= <jo@example.test>' : line,
);

const FOLDED = PLAIN.flatMap((line) =>
  line.startsWith('From:') ? ['From: "Jo Example, of the', ' Example Company" <jo@example.test>'] : [line],
);

const LABELLED = /^From: "Jo Example \(agent\)" <jo@example\.test>$/;

for (const [name, lines] of [
  ['a plain draft', PLAIN],
  ['an HTML draft', HTML],
  ['a draft with an attachment', ATTACHMENT],
  ['a draft whose From is RFC 2047-encoded', ENCODED],
  ['a draft whose From is folded over two lines', FOLDED],
] as const) {
  test(`${name} written elsewhere is labelled at prepare, in its From header and nowhere else`, async () => {
    const { harness, context } = await connected();
    const draftId = await plant(context, lines);
    const before = stored(harness, draftId);

    const prepared = await prepareSend(context, 'work', draftId);

    const after = stored(harness, draftId);
    assertOnlyFromChanged(before.raw, after.raw, LABELLED);
    assert.equal(prepared.draftId, draftId, 'the same draft, replaced');
    assert.notEqual(after.messageId, before.messageId, 'Gmail gave the rewritten draft a new message');
    assert.equal(prepared.identity, 'agent');
    assert.equal(prepared.fromRewritten, true);
    const [first, second] = prepared.preview.split('\n');
    assert.match(first ?? '', /^Sent as Jo Example \(agent\)/, 'the first line states the identity');
    assert.match(second ?? '', /^The From line was rewritten for this send/, 'and the next says it was rewritten');
    assert.match(prepared.preview, /^From: +"Jo Example \(agent\)" <jo@example\.test>$/m, 'the new From is shown');

    // The approval is bound to the rewritten draft, and that is what goes.
    const sent = await executeSend(context, 'work', { approvalId: prepared.approvalId });
    const message = harness.google.accounts.get('sub-1')?.messages?.[sent.sentMessageId ?? ''] as FakeMessage;
    const headers = (message.payload as { headers: Array<{ name: string; value: string }> }).headers;
    assert.equal(headers.find((header) => header.name === 'From')?.value, '"Jo Example (agent)" <jo@example.test>');
  });
}

test('a draft that already fits its identity is not touched', async () => {
  const { harness, context } = await connected();
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  const before = stored(harness, draft.draftId);
  const puts = () => harness.google.requests.filter((request) => request.method === 'PUT').length;
  const putsBefore = puts();

  const prepared = await prepareSend(context, 'work', draft.draftId);
  assert.equal(puts(), putsBefore, 'nothing was written back');
  assert.ok(stored(harness, draft.draftId).raw.equals(before.raw));
  assert.equal(prepared.fromRewritten, false);
  assert.doesNotMatch(prepared.preview, /was rewritten/);
});

test('`as: "me"` takes the label off an agent draft, and the first line says it goes unlabelled', async () => {
  const { harness, context } = await connected();
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  const before = stored(harness, draft.draftId);

  const prepared = await prepareSend(context, 'work', draft.draftId, { as: 'me' });
  assertOnlyFromChanged(before.raw, stored(harness, draft.draftId).raw, /^From: jo@example\.test$/);
  assert.equal(prepared.identity, 'me');
  assert.equal(prepared.preview.split('\n')[0], UNLABELLED_PREVIEW_LINE);
  assert.match(prepared.preview, /^From: +jo@example\.test$/m);

  await assert.rejects(
    prepareSend(context, 'work', draft.draftId, { as: 'someone' }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
  );
});

test('a rule that settles `me` for the conversation is followed at prepare too', async () => {
  const { harness, context } = await connected();
  const draft = await createDraft(context, 'work', { to: ['sam@partner.test'], subject: 'Tuesday', text: 'Yes.' });
  await label(harness, { rules: [{ account: 'work', conversation: 'sam@partner.test', as: 'me' }] });
  const prepared = await prepareSend(context, 'work', draft.draftId);
  assert.equal(prepared.identity, 'me');
  assert.equal(prepared.fromRewritten, true);
  assert.equal(prepared.preview.split('\n')[0], UNLABELLED_PREVIEW_LINE);
});

test('a From this mailbox may not send as is refused, and the draft is left as it was', async () => {
  const { harness, context } = await connected();
  for (const from of ['Someone <someone@elsewhere.test>', 'Pending <pending@example.test>']) {
    const draftId = await plant(
      context,
      PLAIN.map((line) => (line.startsWith('From:') ? `From: ${from}` : line)),
    );
    const before = stored(harness, draftId);
    await assert.rejects(prepareSend(context, 'work', draftId), (error: unknown) => {
      assert.ok(error instanceof CommsError);
      assert.equal(error.code, 'BAD_DATA');
      assert.match(error.message, /cannot send as/);
      return true;
    });
    assert.ok(stored(harness, draftId).raw.equals(before.raw), `${from}: nothing was rewritten`);
    assert.equal((await harness.core.approvals.list()).length, 0, 'and no approval was recorded');
  }
});
