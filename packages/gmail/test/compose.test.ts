import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '@agent-communications/core';
import { composeMessage, formatAddress, planReply, textToHtml } from '../src/domain/compose.ts';

const OWN = ['jo@example.test', 'jo.alias@example.test'];

function address(name: string, email: string): { name: string; address: string } {
  return { name, address: email };
}

test('the HTML part is generated from the text, and carries nothing the author did not write', () => {
  const html = textToHtml('Hi Sam,\n\nThe plan is at https://example.test/plan?v=2 — take a look.\n\nC');
  assert.match(html, /<p>Hi Sam,<\/p>/);
  assert.match(html, /<a href="https:\/\/example\.test\/plan\?v=2">https:\/\/example\.test\/plan\?v=2<\/a>/);
  // No styles, no images, no tables: what renders the same everywhere.
  assert.doesNotMatch(html, /<img|style=|<table/);

  // Anything that looks like markup in the text is text, not markup.
  const escaped = textToHtml('Use <b>bold</b> & "quotes" <script>alert(1)</script>');
  assert.doesNotMatch(escaped, /<b>|<script>/);
  assert.match(escaped, /&lt;b&gt;bold&lt;\/b&gt; &amp; &quot;quotes&quot;/);
});

test('a composed message has both parts, threading headers and its attachment', async () => {
  const message = await composeMessage({
    from: 'Jo Example <jo@example.test>',
    to: ['Sam Lee <sam@partner.test>'],
    cc: ['ana@partner.test'],
    subject: 'Re: Café plan — “final”',
    text: 'Tuesday works.\n\nC',
    inReplyTo: '<abc@mail.partner.test>',
    references: ['<start@mail.partner.test>', '<abc@mail.partner.test>'],
    attachments: [{ filename: 'plan.pdf', content: Buffer.from('%PDF-1.4 fake'), contentType: 'application/pdf' }],
  });

  const raw = message.raw.toString('utf8');
  assert.match(raw, /^From: Jo Example <jo@example\.test>/m);
  assert.match(raw, /^To: Sam Lee <sam@partner\.test>/m);
  assert.match(raw, /^Cc: ana@partner\.test/m);
  // A subject with accents and curly quotes is encoded rather than mangled.
  assert.match(raw, /^Subject: =\?UTF-8\?/m);
  assert.match(raw, /^In-Reply-To: <abc@mail\.partner\.test>/m);
  assert.match(raw, /^References: <start@mail\.partner\.test>/m);
  assert.match(raw, /Content-Type: multipart\/(mixed|alternative)/);
  assert.match(raw, /filename=.*plan\.pdf/);
  assert.equal(message.text, 'Tuesday works.\n\nC');
  assert.match(message.html, /<p>Tuesday works\.<\/p>/);
  assert.ok(message.bytes > 0);
});

test('a signature is appended to both parts, in the wrapper Gmail expects', async () => {
  const message = await composeMessage({
    from: 'jo@example.test',
    to: ['sam@partner.test'],
    subject: 'Hello',
    text: 'Short one.',
    signature: { text: '— Jo\nHead of Things', html: '<div>— Jo<br>Head of Things</div>' },
  });
  assert.match(message.text, /Short one\.\n\n— Jo\nHead of Things$/);
  assert.match(message.html, /class="gmail_signature" data-smartmail="gmail_signature"/);
  assert.match(message.html, /Head of Things/);
});

test('a message with no recipients is refused before anything is built', async () => {
  await assert.rejects(
    composeMessage({ from: 'jo@example.test', to: [], subject: 'Nobody', text: 'x' }),
    (error: unknown) => error instanceof CommsError && error.code === 'BAD_DATA',
  );
});

test('a reply goes to the sender, and reply-all to everyone but us', () => {
  const context = {
    from: address('Sam Lee', 'sam@partner.test'),
    replyTo: [],
    to: [address('Jo Example', 'jo@example.test'), address('Ana', 'ana@partner.test')],
    cc: [address('Pat', 'pat@other.test'), address('Jo alias', 'jo.alias@example.test')],
    subject: 'Re: Phase 2 plan',
    messageIdHeader: '<abc@mail.partner.test>',
    references: ['<start@mail.partner.test>'],
    threadId: 't1',
  };

  const reply = planReply(context, { mode: 'reply', ownAddresses: OWN });
  assert.deepEqual(reply.to, ['sam@partner.test']);
  assert.deepEqual(reply.cc, []);
  assert.equal(reply.subject, 'Re: Phase 2 plan', 'one Re:, not two');
  assert.equal(reply.inReplyTo, '<abc@mail.partner.test>');
  assert.deepEqual(reply.references, ['<start@mail.partner.test>', '<abc@mail.partner.test>']);
  assert.equal(reply.threadId, 't1');

  const all = planReply(context, { mode: 'reply_all', ownAddresses: OWN });
  assert.deepEqual(all.to, ['sam@partner.test']);
  // Everyone else stays; both of our own addresses are gone, so we do not write to ourselves.
  assert.deepEqual(all.cc, ['ana@partner.test', 'pat@other.test']);
});

test('Reply-To decides where a reply goes, as every mail client does', () => {
  const context = {
    from: address('Sam Lee', 'sam@partner.test'),
    replyTo: [address('Accounts', 'accounts@partner.test')],
    to: [address('Jo', 'jo@example.test')],
    cc: [],
    subject: 'Invoice',
    messageIdHeader: '<x@y>',
    references: [],
    threadId: 't2',
  };
  const reply = planReply(context, { mode: 'reply', ownAddresses: OWN });
  assert.deepEqual(reply.to, ['accounts@partner.test'], 'the sender asked for replies elsewhere');
});

test('a forward is a new conversation, not a continuation of this one', () => {
  const context = {
    from: address('Sam Lee', 'sam@partner.test'),
    replyTo: [],
    to: [address('Jo', 'jo@example.test')],
    cc: [address('Ana', 'ana@partner.test')],
    subject: 'Re: Phase 2 plan',
    messageIdHeader: '<abc@mail>',
    references: ['<start@mail>'],
    threadId: 't1',
  };
  const forward = planReply(context, { mode: 'forward', ownAddresses: OWN, to: ['new@third.test'] });
  assert.deepEqual(forward.to, ['new@third.test']);
  assert.deepEqual(forward.cc, [], 'the original recipients are not carried into a forward');
  assert.equal(forward.subject, 'Fwd: Phase 2 plan');
  assert.equal(forward.inReplyTo, undefined);
  assert.deepEqual(forward.references, []);
  assert.equal(forward.threadId, undefined);
});

test('a reply to our own message still has somewhere to go', () => {
  const context = {
    from: address('Jo', 'jo@example.test'),
    replyTo: [],
    to: [address('Sam', 'sam@partner.test')],
    cc: [],
    subject: 'Plan',
    messageIdHeader: '<mine@mail>',
    references: [],
    threadId: 't3',
  };
  // Replying to something we sent: the sender is us, so falling back to the sender is better than an empty list.
  const reply = planReply(context, { mode: 'reply', ownAddresses: OWN });
  assert.deepEqual(reply.to, ['jo@example.test']);
  const all = planReply(context, { mode: 'reply_all', ownAddresses: OWN });
  assert.deepEqual(all.cc, ['sam@partner.test']);
});

test('a display name that could break a header is quoted', () => {
  assert.equal(formatAddress({ name: '', address: 'jo@example.test' }), 'jo@example.test');
  assert.equal(formatAddress({ name: 'Jo Example', address: 'jo@example.test' }), 'Jo Example <jo@example.test>');
  assert.equal(
    formatAddress({ name: 'Example, Jo', address: 'jo@example.test' }),
    '"Example, Jo" <jo@example.test>',
    'a comma would otherwise read as another recipient',
  );
  assert.equal(
    formatAddress({ name: 'Jo "The Plan" Example', address: 'jo@example.test' }),
    '"Jo \\"The Plan\\" Example" <jo@example.test>',
  );
});
