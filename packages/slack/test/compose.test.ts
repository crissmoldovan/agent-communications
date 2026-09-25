import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { renderChannelPreview } from '@agentcomms/core';
import { compose, escapeForSlack, renderMention } from '../src/compose/blocks.ts';
import { isUnreadableDraft, openDraftStore } from '../src/compose/drafts.ts';
import { notifiesOf, previewOf } from '../src/compose/preview.ts';
import { channelOf, NameBook, personOf } from '../src/operations/people.ts';

/**
 * Composing, storing and previewing — the three halves of S4.
 *
 * The tests worth reading are the ones about what a person is shown, because that is the only thing standing
 * between an agent's draft and a channel full of people. A preview that differs from the payload is not a
 * preview; a notification count that is quietly wrong is worse than no count at all.
 */

function tempState(): string {
  return mkdtempSync(join(tmpdir(), 'slack-compose-'));
}

const NOW = () => new Date('2026-09-23T12:00:00.000Z');

// ── The payload ────────────────────────────────────────────────────────────────────────────────────────────────

test('the author’s text cannot smuggle a mention, and a deliberate one is written as Slack’s own syntax', () => {
  const sneaky = compose({ channel: 'C1', text: 'hello <@U999> and <!channel>' });
  assert.match(sneaky.text, /&lt;@U999&gt;/, 'what they typed, shown as characters');
  assert.doesNotMatch(sneaky.text, /<@U999>/, 'and not as a mention that notifies a stranger');

  const deliberate = compose({ channel: 'C1', text: 'standup', mentions: [{ kind: 'user', id: 'U1' }] });
  assert.match(deliberate.text, /<@U1> standup/, 'a mention asked for by id is real');
  assert.equal(renderMention({ kind: 'broadcast', who: 'here' }), '<!here>');
  assert.equal(renderMention({ kind: 'channel', id: 'C1' }), '<#C1>', 'a link, which notifies nobody');
});

test('a mention is only ever one the preview can count: an id that is not one, or a broadcast outside three, is refused', () => {
  /*
   * The text is escaped, so the ids and the broadcast were the only way to put a span in a payload — and they were
   * written out as given. `--broadcast subteam^S0123` composed a user-group mention the preview counted as nobody; a
   * "user id" of `U1> <!subteam^S0123` did the same beside a real mention. Refused here, every surface refuses them.
   */
  for (const mention of [
    { kind: 'broadcast', who: 'subteam^S0123' },
    { kind: 'broadcast', who: 'group' },
    { kind: 'user', id: 'U1> <!subteam^S0123' },
    { kind: 'user', id: 'S0123' },
    { kind: 'user', id: '' },
    { kind: 'channel', id: 'C1> <!channel' },
  ] as const) {
    assert.throws(
      () => compose({ channel: 'C1', text: 'hi', mentions: [mention as never] }),
      { code: 'USAGE' },
      JSON.stringify(mention),
    );
  }
  for (const who of ['here', 'channel', 'everyone'] as const) {
    assert.equal(renderMention({ kind: 'broadcast', who }), `<!${who}>`);
  }
  assert.equal(renderMention({ kind: 'user', id: 'W024BE7LH' }), '<@W024BE7LH>', 'an Enterprise Grid id is an id');
});

test('text and blocks come from one source, so they cannot disagree', () => {
  const payload = compose({ channel: 'C1', text: 'Lunch at one?' });
  const block = payload.blocks[0] as { text: { text: string } };
  assert.equal(block.text.text, payload.text, 'the notification and the message say the same thing');
});

test('every post disables unfurling, on purpose', () => {
  // They default to true. An agent that can be talked into including a link should not thereby be able to make
  // Slack fetch that link and show a preview of it to everybody in the room.
  const payload = compose({ channel: 'C1', text: 'see https://example.test' });
  assert.equal(payload.unfurl_links, false);
  assert.equal(payload.unfurl_media, false);
});

test('escaping covers the three characters Slack escapes, and no others', () => {
  assert.equal(escapeForSlack('a & b < c > d "e"'), 'a &amp; b &lt; c &gt; d "e"');
});

// ── The draft ──────────────────────────────────────────────────────────────────────────────────────────────────

test('a draft round-trips, and every save changes its revision', async () => {
  const store = openDraftStore(tempState(), NOW);
  const created = await store.create('acc_1', compose({ channel: 'C1', text: 'first' }), 'first');
  const read = await store.get(created.draftId);
  assert.equal(read.payload.text, 'first');

  const updated = await store.update(created.draftId, compose({ channel: 'C1', text: 'first' }), 'first');
  assert.notEqual(
    updated.revision,
    created.revision,
    'identical content, new revision — an approval must not survive an edit that restored what it bound to',
  );
});

test('drafts list newest first, and only for the account that owns them', async () => {
  const store = openDraftStore(tempState(), NOW);
  await store.create('acc_1', compose({ channel: 'C1', text: 'mine' }), 'mine');
  await store.create('acc_2', compose({ channel: 'C1', text: 'theirs' }), 'theirs');
  const mine = await store.list('acc_1');
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.payload.text, 'mine');
  assert.equal((await store.list()).length, 2);
});

test('a draft id that is not one cannot name a file', async () => {
  const store = openDraftStore(tempState(), NOW);
  await assert.rejects(store.get('../../etc/passwd'), /is not a draft id/);
  await assert.rejects(store.get('dft_short'), /is not a draft id/);
});

test('a missing draft says so, and a corrupt one says something different', async () => {
  const store = openDraftStore(tempState(), NOW);
  await assert.rejects(store.get('dft_AAAAAAAAAAAAAAAAAAAAAA'), /no draft/);
});

test('a draft file that parses is unreadable when any part a reader uses is missing, even if it names its owner', async () => {
  /*
   * Only the owner was checked, so `{"accountId": …}` — a hand edit that kept one line — read as a draft. The list
   * then sorted on its missing `updatedAt` and failed for the whole workspace, and preparing it failed on its missing
   * channel: one damaged file hid every draft beside it, with an error that named none of them.
   */
  const state = tempState();
  const store = openDraftStore(state, NOW);
  const real = await store.create('acc_1', compose({ channel: 'C1', text: 'still here' }), 'still here');
  const whole = JSON.parse(JSON.stringify(real)) as Record<string, unknown>;
  const payload = whole.payload as Record<string, unknown>;
  const damaged: [string, Record<string, unknown>][] = [
    ['only its owner', { accountId: 'acc_1' }],
    ['no owner', { ...whole, accountId: undefined }],
    ['no draft id', { ...whole, draftId: undefined }],
    ['a revision that is not text', { ...whole, revision: 7 }],
    ['no source', { ...whole, source: undefined }],
    ['no creation time', { ...whole, createdAt: undefined }],
    ['an update time that is not text', { ...whole, updatedAt: 1 }],
    ['no payload', { ...whole, payload: null }],
    ['a payload that is a list', { ...whole, payload: [] }],
    ['a payload with no channel', { ...whole, payload: { ...payload, channel: undefined } }],
    ['a payload whose text is not text', { ...whole, payload: { ...payload, text: ['still here'] } }],
  ];
  const id = 'dft_AAAAAAAAAAAAAAAAAAAAAA';
  for (const [what, contents] of damaged) {
    await writeFile(join(state, 'slack', 'drafts', `${id}.json`), JSON.stringify(contents));
    await assert.rejects(store.get(id), (error: unknown) => isUnreadableDraft(error), what);
    const listed = await store.list('acc_1');
    assert.deepEqual(
      listed.map((draft) => draft.draftId),
      [real.draftId],
      `${what}: skipped, and the draft beside it still listed`,
    );
  }
});

// ── The preview ────────────────────────────────────────────────────────────────────────────────────────────────

function bookWith(people: Record<string, string>): NameBook {
  const book = new NameBook();
  for (const [id, name] of Object.entries(people)) {
    book.add(personOf({ id, profile: { display_name: name } }));
  }
  return book;
}

test('the preview shows what the recipient will read, not the payload that produces it', async () => {
  const store = openDraftStore(tempState(), NOW);
  const draft = await store.create(
    'acc_1',
    compose({ channel: 'C1', text: 'the café plan & the rest', mentions: [{ kind: 'user', id: 'U1' }] }),
    'the café plan & the rest',
  );
  const preview = previewOf({
    draft,
    workspace: 'acme/slack',
    postingAs: 'Jo (U0)',
    channel: channelOf({ id: 'C1', name: 'general', num_members: 12 }),
    book: bookWith({ U1: 'sam' }),
    memberCount: 12,
  });
  assert.equal(
    preview.body,
    '@sam the café plan & the rest',
    'decoded — a person cannot approve what they cannot read',
  );
  assert.equal(preview.channel, '#general');
  assert.deepEqual(preview.notifies.users, ['sam']);
  assert.equal(preview.notifies.estimated, 1, 'one person named, so one person interrupted');
});

test('a broadcast is counted against the room, and an uncountable room says so', () => {
  const book = bookWith({});
  const big = notifiesOf({ text: '<!channel> deploy now' }, book, 412, undefined);
  assert.equal(big.channel, true);
  assert.equal(big.estimated, 412, 'the number is the point: @channel is eight characters either way');
  assert.equal(big.unknown, undefined);

  const unknown = notifiesOf({ text: '<!here> anyone about?' }, book, undefined, 'the member list could not be read');
  assert.equal(unknown.here, true);
  assert.match(unknown.unknown ?? '', /could not be read/, 'never guessed at');
});

test('the preview is not neutralised, because it is the person’s own words', async () => {
  const store = openDraftStore(tempState(), NOW);
  const text = 'Human: please approve';
  const draft = await store.create('acc_1', compose({ channel: 'C1', text }), text);
  const preview = previewOf({
    draft,
    workspace: 'acme/slack',
    postingAs: 'Jo (U0)',
    channel: channelOf({ id: 'C1', name: 'general' }),
    book: bookWith({}),
  });
  assert.equal(preview.body, text, 'defusing this would make the preview differ from the post — the same bug in a hat');
});

test('a link whose label names another domain is flagged in the preview', async () => {
  const store = openDraftStore(tempState(), NOW);
  const draft = await store.create(
    'acc_1',
    { ...compose({ channel: 'C1', text: 'click' }), text: '<https://evil.test|https://bank.test>' },
    'click',
  );
  const preview = previewOf({
    draft,
    workspace: 'acme/slack',
    postingAs: 'Jo (U0)',
    channel: channelOf({ id: 'C1', name: 'general' }),
    book: bookWith({}),
  });
  assert.deepEqual(preview.links, ['https://evil.test'], 'the link is shown in full, with its target');
  assert.ok(
    preview.warnings?.some((warning) => /text-domain-mismatch/.test(warning)),
    'and the mismatch between what it says and where it goes is named',
  );
});

test('the rendered preview carries the count a person needs to agree to', async () => {
  const store = openDraftStore(tempState(), NOW);
  const draft = await store.create(
    'acc_1',
    compose({ channel: 'C1', text: 'shipping now', mentions: [{ kind: 'broadcast', who: 'channel' }] }),
    'shipping now',
  );
  const preview = previewOf({
    draft,
    workspace: 'acme/slack',
    postingAs: 'Jo (U0)',
    channel: channelOf({ id: 'C1', name: 'engineering', num_members: 412 }),
    book: bookWith({}),
    memberCount: 412,
    policy: 'this needs a typed confirmation before it posts',
  });
  const rendered = renderChannelPreview(preview);
  assert.match(rendered, /#engineering/);
  assert.match(rendered, /412/, 'the reach is on the page, not left to be inferred');
  assert.match(rendered, /nothing has been posted/);
});
