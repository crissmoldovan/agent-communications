import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describeNotifies, type PreviewNotifies, renderChannelPreview, renderMessagePreview } from '../src/render.ts';

const RLO = String.fromCodePoint(0x202e);

const nobody: PreviewNotifies = { here: false, channel: false, users: [], estimated: 0 };

test('a channel preview puts the reach where mail puts its recipients, above the body and again below it', () => {
  const preview = renderChannelPreview({
    workspace: 'acme',
    channel: '#engineering',
    body: 'Deploying 0.1.2 in ten minutes.',
    notifies: { here: false, channel: true, users: [], estimated: 412 },
    context: { approvalId: 'ap_7Q2', draftId: 'sd_19' },
  });

  assert.match(preview, /POST PREVIEW · workspace acme · approval ap_7Q2 · draft sd_19/);
  assert.match(preview, /Channel: {2}#engineering/);
  assert.match(preview, /Notifies: @channel — about 412 people/);
  assert.match(preview, /Body \(5 words, 31 characters\)/);
  // Below the body too: a long message scrolls the header out of view, and the reach is the thing to re-read.
  assert.match(preview, /── #engineering · @channel — about 412 people$/m);
});

test('a preview with no approval is titled as a draft, not a post', () => {
  const preview = renderChannelPreview({
    workspace: 'acme',
    channel: '#general',
    body: 'Morning.',
    notifies: nobody,
  });
  assert.match(preview, /^MESSAGE PREVIEW · workspace acme$/m);
  assert.doesNotMatch(preview, /POST PREVIEW/);
});

test('describeNotifies counts the people, because "@channel" is four characters either way', () => {
  assert.equal(describeNotifies({ ...nobody, channel: true, estimated: 412 }), '@channel — about 412 people');
  assert.equal(describeNotifies({ ...nobody, here: true, estimated: 1 }), '@here — about 1 person');
  assert.equal(
    describeNotifies({ here: false, channel: false, users: ['@sam', '@ana'], estimated: 2 }),
    '@sam, @ana — about 2 people',
  );
  assert.equal(
    describeNotifies({ here: true, channel: true, users: ['@sam'], estimated: 9 }),
    '@channel · @here · @sam — about 9 people',
  );
});

test('a message that notifies nobody says so rather than reporting a count of zero', () => {
  assert.equal(describeNotifies(nobody), 'nobody is notified');
  assert.equal(describeNotifies({ ...nobody, estimated: 400 }), 'nobody is notified');
});

test('an unresolved count says it is unknown instead of guessing at one', () => {
  const text = describeNotifies({ ...nobody, channel: true, estimated: 0, unknown: 'the member list is private' });
  assert.equal(text, '@channel — how many that reaches is not known — the member list is private');
  // The estimate it does hold is not shown alongside: two numbers, one of them wrong, is worse than none.
  assert.doesNotMatch(text, /about 0/);
});

test('channel and body text cannot smuggle control characters through the preview', () => {
  const preview = renderChannelPreview({
    workspace: 'acme',
    channel: `#gene${RLO}ring`,
    body: `approved${RLO} denied`,
    notifies: nobody,
  });
  assert.doesNotMatch(preview, new RegExp(RLO));
});

test('every label leaves a gap before its value, including the longest ones', () => {
  // `Reply-To:` and `Notifies:` are exactly as wide as the column was, so padding added nothing and the value ran
  // straight into the colon — `Reply-To:accounts@evil.test`, on the one line an approver most needs to skim.
  const mail = renderMessagePreview({
    recipients: {
      from: 'Jo <jo@example.test>',
      to: ['sam@partner.test'],
      cc: [],
      bcc: [],
      replyTo: ['accounts@evil.test'],
    },
    subject: 'Invoice',
    body: 'See attached.',
  });
  const channel = renderChannelPreview({
    workspace: 'acme',
    channel: '#engineering',
    body: 'Morning.',
    notifies: { ...nobody, channel: true, estimated: 3 },
  });

  for (const text of [mail, channel]) {
    for (const row of text.split('\n')) {
      const label = /^([A-Za-z-]+:)(\S)/.exec(row);
      assert.equal(label, null, `"${label?.[1]}" ran into its value: ${row}`);
    }
  }
});
