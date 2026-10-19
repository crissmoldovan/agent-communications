import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '../src/digest.ts';
import { CommsError, ERROR_REGISTRY, EXIT_CODES } from '../src/errors.ts';
import {
  checkedContents,
  checkedLimits,
  classifyStandingChange,
  type ExactPlace,
  effectiveStanding,
  parseExpiry,
  STANDING_ACTS,
  type StandingBinding,
  standingDigest,
  standingLimitReached,
  standingRefused,
} from '../src/standing.ts';
import { READS_AS_APPROVAL, STANDARD_EMOJI } from '../src/standing-emoji.ts';

/*
 * Standing approvals' model (design 2026-10-19-standing-approvals, S3, S5, S6, S8): the contents a person writes, named
 * by digest; the places and limits; and what widens one. Pure: nothing here reads a file or a clock.
 */

/** The `details.reason` of a BAD_DATA refusal of `input`. */
function refusedFor(input: { reactions?: string[]; replies?: string[] }): string {
  try {
    checkedContents(input);
  } catch (error) {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, 'BAD_DATA');
    return String(error.details?.reason);
  }
  assert.fail(`not refused: ${JSON.stringify(input)}`);
}

test('the acts a standing approval may cover are a reaction and a reply, and nothing else', () => {
  assert.deepEqual([...STANDING_ACTS], ['reaction', 'reply']);
  assert.ok(Object.isFrozen(STANDING_ACTS));
});

test('a text with a placeholder, a link, a mention or markup is refused, each with its reason', () => {
  assert.equal(refusedFor({ replies: ['Hi {name}, got it'] }), 'placeholder');
  assert.equal(refusedFor({ replies: ['Thanks [name]'] }), 'placeholder');
  assert.equal(refusedFor({ replies: ['See https://status.acme.test for it'] }), 'link');
  assert.equal(refusedFor({ replies: ['See www.acme.test'] }), 'link');
  assert.equal(refusedFor({ replies: ['Write to mailto:sam'] }), 'link');
  assert.equal(refusedFor({ replies: ['It is on acme.test now'] }), 'link');
  assert.equal(refusedFor({ replies: ['Got it <@U1>'] }), 'mention');
  assert.equal(refusedFor({ replies: ['Heads up @here'] }), 'mention');
  assert.equal(refusedFor({ replies: ['Got it <!channel>'] }), 'mention');
  assert.equal(refusedFor({ replies: ['Got it *bold*'] }), 'markup');
  assert.equal(refusedFor({ replies: ['Got it _now_'] }), 'markup');
  assert.equal(refusedFor({ replies: ['Got it ~not~'] }), 'markup');
  assert.equal(refusedFor({ replies: ['Got it `code`'] }), 'markup');
  assert.equal(refusedFor({ replies: ['a > b'] }), 'markup');
  assert.equal(refusedFor({ replies: ['a | b'] }), 'markup');
  assert.equal(refusedFor({ replies: ['Got it :tada:'] }), 'emoji-code');
  assert.equal(refusedFor({ replies: ['Got it\nand more'] }), 'multi-line');
  assert.equal(refusedFor({ replies: ['Got\u0007 it'] }), 'control-character');
  assert.equal(refusedFor({ replies: ['Got‮ it'] }), 'control-character');
  assert.equal(refusedFor({ replies: ['   '] }), 'empty');
});

test('a text over 200 characters is refused; 200 is allowed, counted in characters after trimming', () => {
  assert.equal(refusedFor({ replies: ['a'.repeat(201)] }), 'too-long');
  const fine = checkedContents({ replies: [`  ${'é'.repeat(200)}  `] });
  assert.equal(fine.contents[0]?.text, 'é'.repeat(200), 'trimmed, and 200 characters even where each is two bytes');
});

test('more than 5 reactions or 5 replies is refused', () => {
  assert.equal(refusedFor({ reactions: ['eyes', 'memo', 'pray', 'wave', 'bulb', 'mag'] }), 'too-many-reactions');
  assert.equal(refusedFor({ replies: ['one', 'two', 'three', 'four', 'five', 'six'] }), 'too-many-replies');
  // Five of each is the most, and allowed.
  const most = checkedContents({
    reactions: ['eyes', 'memo', 'pray', 'wave', 'bulb'],
    replies: ['one', 'two', 'three', 'four', 'five'],
  });
  assert.equal(most.contents.length, 10);
});

test('a custom emoji is refused: only the standard names shipped with this release', () => {
  assert.equal(refusedFor({ reactions: ['partyparrot'] }), 'custom-emoji');
  assert.equal(refusedFor({ reactions: ['EYES'] }), 'custom-emoji', 'names are exact');
  assert.equal(Object.keys(STANDARD_EMOJI).length, 30);
  for (const [name, codePoint] of Object.entries(STANDARD_EMOJI)) {
    assert.match(codePoint, /^U\+[0-9A-F]{4,5}$/, `${name} has its code point`);
  }
  // A name written between colons is the same name.
  assert.equal(checkedContents({ reactions: [':memo:'] }).contents[0]?.text, 'memo');
});

test('the same content twice is refused', () => {
  assert.equal(refusedFor({ reactions: ['eyes', 'eyes'] }), 'duplicate');
  assert.equal(refusedFor({ replies: ['Got it', ' Got it '] }), 'duplicate');
});

test('no contents given holds eyes alone', () => {
  const none = checkedContents({});
  assert.deepEqual(
    none.contents.map(({ kind, text }) => ({ kind, text })),
    [{ kind: 'reaction', text: 'eyes' }],
  );
  assert.deepEqual(none.warnings, []);
  assert.deepEqual(checkedContents({ reactions: [], replies: [] }).contents.length, 1);
  // Replies alone hold the replies alone: no reaction is allowed that was not written.
  assert.deepEqual(
    checkedContents({ replies: ['Got it'] }).contents.map((content) => content.kind),
    ['reply'],
  );
});

test('an emoji that reads as approval is warned for', () => {
  assert.equal(READS_AS_APPROVAL.length, 10);
  for (const name of READS_AS_APPROVAL) assert.ok(Object.hasOwn(STANDARD_EMOJI, name), name);
  const checked = checkedContents({ reactions: ['eyes', 'white_check_mark', '+1'] });
  assert.deepEqual(checked.warnings, [
    ':white_check_mark: can read as approval: people read ✅ on "can I deploy?" as a yes, and a Slack workflow can start on a reaction.',
    ':+1: can read as approval: people read ✅ on "can I deploy?" as a yes, and a Slack workflow can start on a reaction.',
  ]);
});

test('a digest covers kind and text, and reordering contents keeps each digest', () => {
  const reaction = checkedContents({ reactions: ['eyes'], replies: ['eyes'] });
  const [asReaction, asReply] = reaction.contents;
  assert.equal(asReaction?.kind, 'reaction');
  assert.equal(asReply?.kind, 'reply');
  assert.notEqual(asReaction?.digest, asReply?.digest, 'reaction eyes and reply eyes differ');
  assert.equal(asReaction?.digest, sha256Hex(canonicalJson({ kind: 'reaction', text: 'eyes' })));
  assert.equal(asReply?.digest, sha256Hex(canonicalJson({ kind: 'reply', text: 'eyes' })));

  const forward = checkedContents({ reactions: ['eyes', 'memo'], replies: ['Got it', 'On it'] });
  const backward = checkedContents({ reactions: ['memo', 'eyes'], replies: ['On it', 'Got it'] });
  const byText = (list: typeof forward.contents) =>
    Object.fromEntries(list.map((content) => [`${content.kind}:${content.text}`, content.digest]));
  assert.deepEqual(byText(forward.contents), byText(backward.contents));
  // Reactions first, then replies, each as written.
  assert.deepEqual(
    forward.contents.map((content) => content.text),
    ['eyes', 'memo', 'Got it', 'On it'],
  );
});

test('limits outside the table are refused, and parseExpiry reads <n>d from 1 to 30', () => {
  assert.deepEqual(checkedLimits({}), { perThread: 1, perHour: 10, perDay: 30, expiresDays: 7 });
  assert.deepEqual(checkedLimits({ perThread: 3, perHour: 30, perDay: 100, expiresDays: 30 }), {
    perThread: 3,
    perHour: 30,
    perDay: 100,
    expiresDays: 30,
  });
  for (const outside of [
    { perThread: 0 },
    { perThread: 4 },
    { perHour: 31 },
    { perDay: 101 },
    { perDay: 0 },
    { expiresDays: 31 },
    { expiresDays: 0 },
    { perHour: 1.5 },
  ]) {
    assert.throws(
      () => checkedLimits(outside),
      (error: unknown) => error instanceof CommsError && error.code === 'BAD_DATA',
      JSON.stringify(outside),
    );
  }
  assert.equal(parseExpiry('7d'), 7);
  assert.equal(parseExpiry('1d'), 1);
  assert.equal(parseExpiry('30d'), 30);
  for (const text of ['31d', '0d', '7', 'd', '7h', ' 7d', '07d', '1.5d', '-1d']) {
    assert.throws(
      () => parseExpiry(text),
      (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
      text,
    );
  }
});

const ROOM: ExactPlace = {
  id: 'C0ROOM',
  name: 'support',
  members: 12,
  shared: { extShared: false, pendingExtShared: false, externalMembers: false },
};
const OTHER: ExactPlace = {
  id: 'C0OTHER',
  name: 'ops',
  members: 8,
  shared: { extShared: false, pendingExtShared: false, externalMembers: false },
};

function binding(over: Partial<StandingBinding> = {}): StandingBinding {
  const { contents, warnings } = checkedContents({ reactions: ['eyes', 'memo'], replies: ['Got it, I will look'] });
  return {
    summary: 'acknowledge in #support',
    target: { kind: 'account', name: 'acme/slack', id: 'acc_AAAAAAAAAAAAAAAA' },
    contents,
    places: { kind: 'exact', places: [ROOM, OTHER] },
    limits: checkedLimits({ perThread: 2, perHour: 10, perDay: 30, expiresDays: 7 }),
    proposedBy: 'person',
    warnings,
    ...over,
  };
}

test('the standing digest ignores the summary and changes with anything else', () => {
  const base = binding();
  assert.match(standingDigest(base), /^[0-9a-f]{64}$/);
  assert.equal(standingDigest(binding({ summary: 'something else entirely' })), standingDigest(base));
  const changed: StandingBinding[] = [
    binding({ target: { kind: 'account', name: 'acme/slack', id: 'acc_BBBBBBBBBBBBBBBB' } }),
    binding({ target: { kind: 'account', name: 'beta/slack', id: 'acc_AAAAAAAAAAAAAAAA' } }),
    binding({ contents: checkedContents({ reactions: ['eyes'] }).contents }),
    binding({ places: { kind: 'threads-i-am-in' } }),
    binding({ places: { kind: 'exact', places: [ROOM] } }),
    binding({ places: { kind: 'exact', places: [{ ...ROOM, members: 13 }, OTHER] } }),
    binding({ places: { kind: 'exact', places: [{ ...ROOM, name: 'help' }, OTHER] } }),
    binding({
      places: { kind: 'exact', places: [{ ...ROOM, shared: { ...ROOM.shared, pendingExtShared: true } }, OTHER] },
    }),
    binding({ limits: { ...base.limits, perThread: 1 } }),
    binding({ limits: { ...base.limits, perHour: 9 } }),
    binding({ limits: { ...base.limits, perDay: 29 } }),
    binding({ limits: { ...base.limits, expiresDays: 6 } }),
    binding({ proposedBy: 'agent' }),
    binding({ replaces: 'ap_00000000000000000000000001' }),
    binding({ warnings: ['another warning'] }),
  ];
  const digests = new Set([standingDigest(base), ...changed.map(standingDigest)]);
  assert.equal(digests.size, changed.length + 1, 'every change gives its own digest');
});

test('replacing a text with one outside the old set widens', () => {
  const before = binding();
  const swapped = checkedContents({ reactions: ['eyes', 'memo'], replies: ['Approved, go ahead'] });
  assert.equal(classifyStandingChange(before, binding({ contents: swapped.contents })), 'widens');
  // So does one more content, or one more place, or a higher limit, or a later expiry.
  const more = checkedContents({ reactions: ['eyes', 'memo', 'pray'], replies: ['Got it, I will look'] });
  assert.equal(classifyStandingChange(before, binding({ contents: more.contents })), 'widens');
  const third: ExactPlace = { ...OTHER, id: 'C0THIRD' };
  assert.equal(
    classifyStandingChange(before, binding({ places: { kind: 'exact', places: [ROOM, OTHER, third] } })),
    'widens',
  );
  assert.equal(classifyStandingChange(before, binding({ limits: { ...before.limits, perThread: 3 } })), 'widens');
  assert.equal(classifyStandingChange(before, binding({ limits: { ...before.limits, perHour: 11 } })), 'widens');
  assert.equal(classifyStandingChange(before, binding({ limits: { ...before.limits, perDay: 31 } })), 'widens');
  assert.equal(classifyStandingChange(before, binding({ limits: { ...before.limits, expiresDays: 8 } })), 'widens');
  // A place grown to a big room, or shared differently, is a place the person has not approved.
  assert.equal(
    classifyStandingChange(before, binding({ places: { kind: 'exact', places: [{ ...ROOM, members: 50 }, OTHER] } })),
    'widens',
  );
  assert.equal(
    classifyStandingChange(
      before,
      binding({ places: { kind: 'exact', places: [{ ...ROOM, shared: { ...ROOM.shared, extShared: true } }, OTHER] } }),
    ),
    'widens',
  );
  // Another account is not this one.
  assert.equal(
    classifyStandingChange(
      before,
      binding({ target: { kind: 'account', name: 'x/slack', id: 'acc_BBBBBBBBBBBBBBBB' } }),
    ),
    'widens',
  );
});

test('a subset of contents and places with lower limits narrows; the same is same', () => {
  const before = binding();
  const fewer = before.contents.filter((content) => content.text !== 'memo');
  assert.equal(
    classifyStandingChange(
      before,
      binding({
        contents: fewer,
        places: { kind: 'exact', places: [ROOM] },
        limits: { perThread: 1, perHour: 5, perDay: 20, expiresDays: 3 },
      }),
    ),
    'narrows',
  );
  assert.equal(classifyStandingChange(before, binding({ summary: 'renamed' })), 'same');
  // The member count moving under 50, or a new name, approves nothing new.
  assert.equal(
    classifyStandingChange(
      before,
      binding({ places: { kind: 'exact', places: [{ ...ROOM, members: 30, name: 'help' }, OTHER] } }),
    ),
    'same',
  );
  // Lower on one limit and higher on another is a widening all the same.
  assert.equal(
    classifyStandingChange(before, binding({ limits: { ...before.limits, perThread: 1, perHour: 11 } })),
    'widens',
  );
});

test('exact places replaced by threads-i-am-in widens, and the other way round', () => {
  assert.equal(classifyStandingChange(binding(), binding({ places: { kind: 'threads-i-am-in' } })), 'widens');
  assert.equal(classifyStandingChange(binding({ places: { kind: 'threads-i-am-in' } }), binding()), 'widens');
  assert.equal(
    classifyStandingChange(
      binding({ places: { kind: 'threads-i-am-in' } }),
      binding({ places: { kind: 'threads-i-am-in' } }),
    ),
    'same',
  );
});

test('effectiveStanding keeps only the kept digests and the lower limits', () => {
  const before = binding();
  const [eyes, , reply] = before.contents;
  const narrowed = effectiveStanding(before, {
    keep: [eyes?.digest as string, reply?.digest as string],
    places: ['C0ROOM'],
    limits: { perThread: 1, perHour: 50, expiresDays: 2 },
  });
  assert.deepEqual(
    narrowed.contents.map((content) => content.text),
    ['eyes', 'Got it, I will look'],
  );
  assert.deepEqual(narrowed.places, { kind: 'exact', places: [ROOM] });
  // The lower of each: a narrowing never raises a limit, whatever it says.
  assert.deepEqual(narrowed.limits, { perThread: 1, perHour: 10, perDay: 30, expiresDays: 2 });
  assert.notEqual(classifyStandingChange(before, narrowed), 'widens');
  assert.deepEqual(effectiveStanding(before), before, 'nothing narrowed is the approval as it was');
  assert.deepEqual(effectiveStanding(before, {}), before);

  // A digest or a place it does not hold, or keeping nothing at all, is not a narrowing of it.
  for (const narrowing of [{ keep: ['f'.repeat(64)] }, { keep: [] }, { places: ['C0ELSEWHERE'] }, { places: [] }]) {
    assert.throws(
      () => effectiveStanding(before, narrowing),
      (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
      JSON.stringify(narrowing),
    );
  }
  assert.throws(
    () => effectiveStanding(binding({ places: { kind: 'threads-i-am-in' } }), { places: ['C0ROOM'] }),
    (error: unknown) => error instanceof CommsError && error.code === 'USAGE',
    'threads-i-am-in has no places to keep',
  );
});

test('STANDING_REFUSED and STANDING_LIMIT: exit 10, not retryable, their message and details', () => {
  assert.deepEqual(ERROR_REGISTRY.STANDING_REFUSED, {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: 'this standing approval does not cover this act',
  });
  assert.deepEqual(ERROR_REGISTRY.STANDING_LIMIT, {
    exit: EXIT_CODES.APPROVAL,
    retryable: false,
    summary: "a standing approval's limit is reached",
  });

  const refused = standingRefused('not-fresh', 'Ask the person instead.');
  assert.equal(refused.code, 'STANDING_REFUSED');
  assert.equal(refused.exitCode, 10);
  assert.equal(refused.retryable, false);
  assert.equal(
    refused.message,
    'nothing was sent: the message is older than 15 minutes, or than this standing approval',
  );
  assert.equal(refused.hint, 'Ask the person instead.');
  assert.deepEqual(refused.details, { reason: 'not-fresh' });

  const words: Record<string, string> = {
    'not-fresh': 'the message is older than 15 minutes, or than this standing approval',
    'not-newest': 'the message is not the newest from someone else in its thread or channel',
    'already-acknowledged': 'this message or thread was already acknowledged under a standing approval',
    'not-human': "the message, or its thread's first message, is not from a person",
    interactive: 'the message has buttons or menus, or came from a workflow',
    'place-not-covered': 'this standing approval does not cover this place',
    'big-room': 'this place has 50 or more members, and was not approved with that count',
    'count-unreadable': 'how many people are in this place could not be read',
    external: 'someone from another organisation is in this place',
    'shared-state-changed': 'who shares this place changed since it was approved',
    'reaction-as-person': 'a standing reaction goes only as the agent app, and here it would go as you',
    'app-not-member': 'the agent app is not a member of this place, or whether it is could not be read',
    'content-not-held': 'this standing approval holds no such content',
    'clock-behind': "the clock is earlier than this account's last standing act",
    unreadable: 'the message or its thread could not be read',
  };
  for (const [reason, why] of Object.entries(words)) {
    const error = standingRefused(reason as Parameters<typeof standingRefused>[0], 'h');
    assert.equal(error.message, `nothing was sent: ${why}`, reason);
    assert.deepEqual(error.details, { reason });
  }

  const hour = standingLimitReached('perHour', 10, '2026-10-19T11:00:00.000Z', 'Ask the person instead.');
  assert.equal(hour.code, 'STANDING_LIMIT');
  assert.equal(hour.exitCode, 10);
  assert.equal(hour.retryable, false);
  assert.match(hour.message, /^nothing was sent: /);
  assert.match(hour.message, /10 an hour/);
  assert.match(hour.message, /2026-10-19T11:00:00\.000Z/);
  assert.deepEqual(hour.details, { limit: 'perHour', allowed: 10, freesAt: '2026-10-19T11:00:00.000Z' });
  const thread = standingLimitReached('perThread', 1, null, 'h');
  assert.deepEqual(thread.details, { limit: 'perThread', allowed: 1, freesAt: null });
  assert.match(thread.message, /1 per thread/);
  const day = standingLimitReached('perDay', 30, '2026-10-20T10:00:00.000Z', 'h');
  assert.match(day.message, /30 a day/);
});
