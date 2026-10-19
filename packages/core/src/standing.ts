import { isDangerous } from './chars.ts';
import { ACCOUNT_ID_PATTERN, type Config, standingEpochOf } from './config.ts';
import type { Core } from './core.ts';
import { canonicalJson, sha256Hex } from './digest.ts';
import { CommsError } from './errors.ts';
import { APPROVAL_ID_PATTERN } from './ids.ts';
import { ensureSendEpochConfig } from './send-epoch.ts';
import { isStandardEmoji, READS_AS_APPROVAL, STANDARD_EMOJI } from './standing-emoji.ts';

/**
 * Standing approvals (design 2026-10-19-standing-approvals): the person's yes given in advance, for acknowledging — an
 * exact set of contents they wrote, a bounded set of places, a bounded number of uses, and a time limit. The agent
 * decides whether to acknowledge a message that has just arrived, and with which of the contents; it never writes the
 * words, and it cannot pick an old message or a new place.
 *
 * This module is the model: the contents, each named by its digest and never by its position (S3); the places (S5);
 * the limits (S6); the digest a standing record is bound to; and what widens one, which only a person may approve at a
 * terminal (S8). Pure, but for `raiseStandingEpoch`: nothing else here reads a file or a clock.
 */

/** S1: the acts a standing approval may cover. A reaction is only ever added, never removed. */
export const STANDING_ACTS: readonly ['reaction', 'reply'] = Object.freeze(['reaction', 'reply'] as const);
export type StandingAct = (typeof STANDING_ACTS)[number];

/** One content the person wrote: a standard emoji's name, or a fixed reply. Named by `digest`, never by position. */
export interface StandingContent {
  kind: StandingAct;
  text: string;
  /** `sha256Hex(canonicalJson({ kind, text }))`: the kind and the exact text, and nothing else. */
  digest: string;
}

/**
 * Who shares a place, as recorded when it was named (S5). `externalMembers` is null when the place has 50 or more
 * members, which are not read one by one.
 */
export interface SharedState {
  extShared: boolean;
  pendingExtShared: boolean;
  externalMembers: boolean | null;
}

/** A channel or DM named exactly, with what the person was shown of it: its name, its member count and its sharing. */
export interface ExactPlace {
  id: string;
  name: string | null;
  members: number;
  shared: SharedState;
}

/** S5: exact channels or DMs, or the threads in one workspace where the person posted themselves. */
export type StandingPlaces = { kind: 'exact'; places: ExactPlace[] } | { kind: 'threads-i-am-in' };

/**
 * S6: the limits. `perThread` and `perSender` count across every standing approval of the account: `perSender` is how
 * many acts a day may answer messages from any one person (the lead's call, after review), the cap on what an injected
 * agent can say to one recipient by choosing which of their messages to acknowledge.
 */
export interface StandingLimits {
  perThread: number;
  perHour: number;
  perDay: number;
  perSender: number;
  expiresDays: number;
}

/** Exactly what a standing record permits, stored on it so a terminal can show it again and prove it is what was made. */
export interface StandingBinding {
  /** One line about it, for a listing. Shown; not in the digest. */
  summary: string;
  target: { kind: 'account'; name: string; id: string };
  /** Reactions first, then replies, as written. */
  contents: StandingContent[];
  places: StandingPlaces;
  limits: StandingLimits;
  /** Who proposed it: an agent, over MCP or without a person at the terminal, or the person at their terminal. */
  proposedBy: 'agent' | 'person';
  /** The standing id this widens, which approving it ends. */
  replaces?: string | undefined;
  /** S3's warnings, as the preview shows them. */
  warnings: string[];
}

/** What a narrowing keeps: content digests, exact place ids, and lower limits. It applies at once. */
export interface StandingNarrowing {
  keep?: string[];
  places?: string[];
  limits?: Partial<StandingLimits>;
}

/** Why a standing act is refused (S4, S5, S7, S9): one of these, in `details.reason` of `STANDING_REFUSED`. */
export type StandingRefusal =
  | 'not-fresh'
  | 'not-newest'
  | 'already-acknowledged'
  | 'not-human'
  | 'interactive'
  | 'place-not-covered'
  | 'big-room'
  | 'count-unreadable'
  | 'external'
  | 'shared-state-changed'
  | 'reaction-as-person'
  | 'app-not-member'
  | 'content-not-held'
  | 'clock-behind'
  | 'unreadable';

/** How long a message stays fresh enough to acknowledge (S4). */
export const STANDING_FRESH_MS: number = 15 * 60 * 1000;
/** How far back `threads-i-am-in` looks for the person's own message (S5). */
export const STANDING_THREAD_LOOKBACK_MS: number = 14 * 24 * 60 * 60 * 1000;
/** A place with this many members or more is a big room (S5). */
export const STANDING_BIG_ROOM = 50;
/** S3: at most this many reactions, and this many replies, each reply at most this many characters. */
export const STANDING_MAX_REACTIONS = 5;
export const STANDING_MAX_REPLIES = 5;
export const STANDING_MAX_REPLY_LENGTH = 200;
/** S3: what a standing approval holds when no content is given. */
export const STANDING_DEFAULT_REACTION = 'eyes';
/** One day, the unit a standing approval's expiry is counted in. */
export const STANDING_DAY_MS: number = 24 * 60 * 60 * 1000;

/** S6's table: each limit's default and the range a person may set it to. */
export const STANDING_LIMITS: Readonly<Record<keyof StandingLimits, { default: number; min: number; max: number }>> =
  Object.freeze({
    perThread: Object.freeze({ default: 1, min: 1, max: 3 }),
    perHour: Object.freeze({ default: 10, min: 1, max: 30 }),
    perDay: Object.freeze({ default: 30, min: 1, max: 100 }),
    perSender: Object.freeze({ default: 3, min: 1, max: 10 }),
    expiresDays: Object.freeze({ default: 7, min: 1, max: 30 }),
  });

const LIMIT_NAMES = ['perThread', 'perHour', 'perDay', 'perSender', 'expiresDays'] as const;

/** Why a content a person wrote is refused: `details.reason` of the BAD_DATA. */
export type ContentRefusal =
  | 'too-many-reactions'
  | 'too-many-replies'
  | 'custom-emoji'
  | 'empty'
  | 'too-long'
  | 'multi-line'
  | 'control-character'
  | 'mention'
  | 'link'
  | 'placeholder'
  | 'markup'
  | 'emoji-code'
  | 'pictograph'
  | 'duplicate';

const CONTENT_WORDS: Readonly<Record<ContentRefusal, string>> = Object.freeze({
  'too-many-reactions': `a standing approval holds at most ${STANDING_MAX_REACTIONS} reactions`,
  'too-many-replies': `a standing approval holds at most ${STANDING_MAX_REPLIES} replies`,
  'custom-emoji': 'only a standard emoji from the list this release ships may be a standing reaction',
  empty: 'a standing reply has no words',
  'too-long': `a standing reply is at most ${STANDING_MAX_REPLY_LENGTH} characters`,
  'multi-line': 'a standing reply is one line',
  'control-character': 'a standing reply holds a control or invisible character',
  mention: 'a standing reply mentions nobody: no @, and no <@…> or <!…>',
  link: 'a standing reply holds no link, address or domain',
  placeholder: 'a standing reply is sent exactly as written: it holds no placeholder',
  markup: 'a standing reply is plain text: no formatting characters',
  'emoji-code': 'a standing reply holds no :emoji: code; a reaction is its own content',
  pictograph: 'a standing reply holds no emoji or pictograph, such as ✅, ✔ or 👍; a reaction is its own content',
  duplicate: 'a standing approval holds each content once',
});

/** The refusal of a content, as BAD_DATA, with its reason and which content it was. */
function contentRefused(reason: ContentRefusal, where?: { kind: StandingAct; position: number }): CommsError {
  return new CommsError('BAD_DATA', `nothing was prepared: ${CONTENT_WORDS[reason]}`, {
    hint:
      reason === 'custom-emoji'
        ? `Choose from the standard emoji: ${Object.keys(STANDARD_EMOJI).join(', ')}.`
        : 'Write each reply as plain words on one line, at most 200 characters: no links, mentions, markup, placeholders, emoji or emoji codes. A reply is sent exactly as written.',
    details: { reason, ...(where === undefined ? {} : { kind: where.kind, position: where.position }) },
  });
}

/** The digest of one content: its kind and exact text. */
export function standingContentDigest(kind: StandingAct, text: string): string {
  return sha256Hex(canonicalJson({ kind, text }));
}

/** A reaction's name, exactly as listed — `:name:` read as `name` — or the refusal of a custom one. */
function reactionName(written: string, position: number): string {
  const trimmed = written.trim();
  const name = /^:[^:]+:$/.test(trimmed) ? trimmed.slice(1, -1) : trimmed;
  if (!isStandardEmoji(name)) throw contentRefused('custom-emoji', { kind: 'reaction', position });
  return name;
}

/** Each reason a reply's text is refused for, in the order checked: the first that applies is the one given. */
const REPLY_RULES: readonly (readonly [ContentRefusal, (text: string) => boolean])[] = Object.freeze([
  ['multi-line', (text: string) => /[\r\n\u2028\u2029]/.test(text)],
  // A ✅ or a 👍 in the words reads as a yes as surely as the reaction does (the lead's call, after review): an
  // Extended_Pictographic character, or the plain check mark ✓, which Unicode does not count as one. Before
  // the invisible characters, so an emoji's own variation selector is said as the emoji it is part of.
  ['pictograph', (text: string) => /[\p{Extended_Pictographic}\u2713]/u.test(text)],
  [
    'control-character',
    (text: string) => [...text].some((char) => char === '\t' || isDangerous(char.codePointAt(0) ?? 0)),
  ],
  // Before markup: `<@U1>` and `<!here>` are mentions, which is what the person needs to hear.
  ['mention', (text: string) => /@|<[@!#]/.test(text)],
  ['link', (text: string) => /:\/\/|www\.|mailto:|[A-Za-z0-9-]+\.[A-Za-z]{2,}/i.test(text)],
  ['placeholder', (text: string) => /[{}[\]]/.test(text)],
  ['markup', (text: string) => /[<>*_~`|]/.test(text)],
  ['emoji-code', (text: string) => /:[A-Za-z0-9_+-]+:/.test(text)],
]);

/**
 * Words that read as a yes in a reply (the lead's call, after review): "OK" or "Done" on "can I deploy?" is taken for
 * approval as surely as ✅ is. Matched whole, in any case. Allowed, with a warning in the preview.
 */
const APPROVAL_WORDS: readonly (readonly [string, RegExp])[] = Object.freeze([
  ['yes', /\byes\b/i],
  ['approved', /\bapproved\b/i],
  ['approve', /\bapprove\b/i],
  ['go ahead', /\bgo\s+ahead\b/i],
  ['lgtm', /\blgtm\b/i],
  ['ok', /\bok\b/i],
  ['done', /\bdone\b/i],
  ['confirmed', /\bconfirmed\b/i],
]);

/** What a reply's reads-as-approval warning begins with: the preview shows it under that reply. */
export function replyWarningPrefix(text: string): string {
  return `The reply "${text}" can read as approval:`;
}

/** S3's warning for a reply holding words that read as a yes, or null. */
function replyReadsAsApproval(text: string): string | null {
  const said = APPROVAL_WORDS.filter(([, pattern]) => pattern.test(text)).map(([word]) => `"${word}"`);
  if (said.length === 0) return null;
  return `${replyWarningPrefix(text)} it says ${said.join(', ')}. People read "OK" or "Done" on "can I deploy?" as a yes.`;
}

/** A reply's text, trimmed and checked (S3), or the refusal of the first rule it breaks. */
function replyText(written: string, position: number): string {
  const where = { kind: 'reply' as const, position };
  const text = written.trim();
  if (text === '') throw contentRefused('empty', where);
  for (const [reason, breaks] of REPLY_RULES) if (breaks(text)) throw contentRefused(reason, where);
  if ([...text].length > STANDING_MAX_REPLY_LENGTH) throw contentRefused('too-long', where);
  return text;
}

/** S3's warning for an emoji that reads as approval, in the spec's words. */
function readsAsApprovalWarning(name: string): string {
  return `:${name}: can read as approval: people read ✅ on "can I deploy?" as a yes, and a Slack workflow can start on a reaction.`;
}

/**
 * The contents a person wrote, checked (S3): reactions first, then replies, each as written, each with its digest; and
 * the warnings the preview shows. With no content given at all, `eyes` alone. Refuses BAD_DATA, with `details.reason`,
 * for anything S3 does not allow.
 */
export function checkedContents(input: { reactions?: string[]; replies?: string[] }): {
  contents: StandingContent[];
  warnings: string[];
} {
  const reactions = input.reactions ?? [];
  const replies = input.replies ?? [];
  if (reactions.length > STANDING_MAX_REACTIONS) throw contentRefused('too-many-reactions');
  if (replies.length > STANDING_MAX_REPLIES) throw contentRefused('too-many-replies');
  const names =
    reactions.length === 0 && replies.length === 0
      ? [STANDING_DEFAULT_REACTION]
      : reactions.map((written, index) => reactionName(written, index + 1));
  const texts = replies.map((written, index) => replyText(written, index + 1));
  const contents: StandingContent[] = [
    ...names.map((text) => ({ kind: 'reaction' as const, text, digest: standingContentDigest('reaction', text) })),
    ...texts.map((text) => ({ kind: 'reply' as const, text, digest: standingContentDigest('reply', text) })),
  ];
  if (new Set(contents.map((content) => content.digest)).size !== contents.length) throw contentRefused('duplicate');
  const warnings = [
    ...names.filter((name) => READS_AS_APPROVAL.includes(name)).map(readsAsApprovalWarning),
    ...texts.map(replyReadsAsApproval).filter((warning): warning is string => warning !== null),
  ];
  return { contents, warnings };
}

/** S6's limits, each from the table: its default when left out, and BAD_DATA outside its range. */
export function checkedLimits(input: Partial<StandingLimits>): StandingLimits {
  const limits = {} as StandingLimits;
  for (const name of LIMIT_NAMES) {
    const { default: fallback, min, max } = STANDING_LIMITS[name];
    const given = input[name];
    const value = given ?? fallback;
    if (!Number.isSafeInteger(value) || value < min || value > max) {
      throw new CommsError('BAD_DATA', `nothing was prepared: ${name} is a whole number from ${min} to ${max}`, {
        hint: `Leave it out for ${fallback}, or give a whole number from ${min} to ${max}.`,
        details: { reason: 'limit-out-of-range', limit: name, min, max, given: given ?? null },
      });
    }
    limits[name] = value;
  }
  return limits;
}

/** `<n>d`, from `1d` to `30d`, as the CLI takes an expiry: the number of days. USAGE for anything else. */
export function parseExpiry(text: string): number {
  const { min, max } = STANDING_LIMITS.expiresDays;
  const match = /^([1-9][0-9]?)d$/.exec(text);
  const days = match === null ? Number.NaN : Number(match[1]);
  if (!Number.isSafeInteger(days) || days < min || days > max) {
    throw new CommsError('USAGE', `"${text}" is not an expiry: give a number of days from ${min} to ${max}, as 7d`, {
      hint: `Leave it out for ${STANDING_LIMITS.expiresDays.default}d.`,
    });
  }
  return days;
}

/** The canonical form of a place, as the digest binds it. */
function canonicalPlaces(places: StandingPlaces): unknown {
  if (places.kind === 'threads-i-am-in') return { kind: 'threads-i-am-in' };
  return {
    kind: 'exact',
    places: places.places.map((place) => ({
      id: place.id,
      name: place.name,
      members: place.members,
      shared: {
        extShared: place.shared.extShared,
        pendingExtShared: place.shared.pendingExtShared,
        externalMembers: place.shared.externalMembers,
      },
    })),
  };
}

/**
 * The digest a standing record is bound to: everything its binding holds but the summary — the account, every content
 * with its digest in order, every place as recorded, the limits, who proposed it, what it replaces, and the warnings
 * the person was shown.
 */
export function standingDigest(binding: StandingBinding): string {
  return sha256Hex(
    canonicalJson({
      kind: 'standing',
      target: { kind: binding.target.kind, name: binding.target.name, id: binding.target.id },
      contents: binding.contents.map((content) => ({
        kind: content.kind,
        text: content.text,
        digest: content.digest,
      })),
      places: canonicalPlaces(binding.places),
      limits: {
        perThread: binding.limits.perThread,
        perHour: binding.limits.perHour,
        perDay: binding.limits.perDay,
        perSender: binding.limits.perSender,
        expiresDays: binding.limits.expiresDays,
      },
      proposedBy: binding.proposedBy,
      replaces: binding.replaces ?? null,
      warnings: [...binding.warnings],
    }),
  );
}

/** A narrowing that is not one: USAGE, saying what to do instead. */
function notANarrowing(message: string): CommsError {
  return new CommsError('USAGE', `nothing was narrowed: ${message}`, {
    hint: 'A narrowing keeps some of what the standing approval holds. To end it altogether, revoke it.',
  });
}

/**
 * The standing approval as it applies after `narrowed`: only the contents whose digests it keeps, only the exact
 * places it keeps, and the lower of each limit — so a narrowing never raises one, whatever it says. USAGE for a digest
 * or a place the approval does not hold, for keeping none, and for places kept from `threads-i-am-in`, which names none.
 */
export function effectiveStanding(binding: StandingBinding, narrowed?: StandingNarrowing): StandingBinding {
  if (narrowed === undefined) return binding;
  let contents = binding.contents;
  if (narrowed.keep !== undefined) {
    const keep = new Set(narrowed.keep);
    for (const digest of keep) {
      if (!binding.contents.some((content) => content.digest === digest)) {
        throw notANarrowing('it keeps a content this standing approval does not hold');
      }
    }
    contents = binding.contents.filter((content) => keep.has(content.digest));
    if (contents.length === 0) throw notANarrowing('it would keep no content at all');
  }
  let places = binding.places;
  if (narrowed.places !== undefined) {
    if (binding.places.kind !== 'exact') {
      throw notANarrowing('threads-i-am-in names no places to keep; narrow its contents or limits, or revoke it');
    }
    const keep = new Set(narrowed.places);
    const held = binding.places.places;
    for (const id of keep) {
      if (!held.some((place) => place.id === id))
        throw notANarrowing('it keeps a place this standing approval does not cover');
    }
    const kept = held.filter((place) => keep.has(place.id));
    if (kept.length === 0) throw notANarrowing('it would keep no place at all');
    places = { kind: 'exact', places: kept };
  }
  const limits = { ...binding.limits };
  for (const name of LIMIT_NAMES) {
    const lower = narrowed.limits?.[name];
    if (lower !== undefined && Number.isFinite(lower)) limits[name] = Math.min(limits[name], lower);
  }
  return { ...binding, contents, places, limits };
}

/**
 * The narrowing `narrowing` makes of what is in force — `binding` as `narrowed` already leaves it — as the `narrowed` to
 * store beside `binding`: the contents and exact places kept, and every limit, as asked. Applies at once, so it may
 * only narrow (S8): USAGE for anything that would widen what is in force — a higher limit, a later expiry, a content
 * or a place not held — and BAD_DATA for a limit outside the table.
 */
export function narrowedFurther(
  binding: StandingBinding,
  narrowed: StandingNarrowing | undefined,
  narrowing: StandingNarrowing,
): StandingNarrowing {
  const before = effectiveStanding(binding, narrowed);
  const kept = effectiveStanding(before, {
    ...(narrowing.keep === undefined ? {} : { keep: narrowing.keep }),
    ...(narrowing.places === undefined ? {} : { places: narrowing.places }),
  });
  const asked: Partial<StandingLimits> = { ...kept.limits };
  for (const name of LIMIT_NAMES) {
    const value = narrowing.limits?.[name];
    if (value !== undefined) asked[name] = value;
  }
  const after = { ...kept, limits: checkedLimits(asked) };
  if (classifyStandingChange(before, after) === 'widens') {
    throw new CommsError('USAGE', 'nothing was narrowed: this would widen the standing approval, not narrow it', {
      hint: 'A narrowing only lowers a limit, ends it sooner, or keeps fewer contents or places. Anything more is a new standing approval, which the person approves at their terminal with its code.',
      details: { reason: 'widens' },
    });
  }
  return {
    keep: after.contents.map((content) => content.digest),
    ...(after.places.kind === 'exact' ? { places: after.places.places.map((place) => place.id) } : {}),
    limits: { ...after.limits },
  };
}

/** How many days a standing approval lasts once approved, as narrowed: the lower of its own and the narrowing's. */
export function standingDays(binding: StandingBinding, narrowed?: StandingNarrowing): number {
  const lower = narrowed?.limits?.expiresDays;
  return typeof lower === 'number' && Number.isFinite(lower)
    ? Math.min(binding.limits.expiresDays, lower)
    : binding.limits.expiresDays;
}

/** A Slack conversation a standing approval may name exactly: a channel, a private channel or group DM, or a DM. */
export const STANDING_PLACE_PATTERN: RegExp = /^[CGD][A-Z0-9]{2,}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isStrings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === 'string');

/** Why `shared` is not a recorded sharing state, or null. */
function sharedProblem(shared: unknown): string | null {
  if (!isRecord(shared)) return 'a place has no sharing state';
  if (typeof shared.extShared !== 'boolean' || typeof shared.pendingExtShared !== 'boolean') {
    return 'a place has no sharing state';
  }
  if (shared.externalMembers !== null && typeof shared.externalMembers !== 'boolean') {
    return 'a place has no sharing state';
  }
  return null;
}

/** Why `places` is not a standing approval's places, or null. */
function placesProblem(places: unknown): string | null {
  if (!isRecord(places)) return 'it has no places';
  if (places.kind === 'threads-i-am-in') return Object.keys(places).length === 1 ? null : 'its places are not one kind';
  if (places.kind !== 'exact' || !Array.isArray(places.places)) return 'it has no places';
  if (places.places.length === 0) return 'it names no place';
  const seen = new Set<string>();
  for (const place of places.places as unknown[]) {
    if (!isRecord(place) || typeof place.id !== 'string' || !STANDING_PLACE_PATTERN.test(place.id)) {
      return 'a place is not a Slack channel or DM id';
    }
    if (seen.has(place.id)) return 'a place is named twice';
    seen.add(place.id);
    if (place.name !== null && typeof place.name !== 'string') return 'a place has no name or null';
    if (!Number.isSafeInteger(place.members) || (place.members as number) < 0) return 'a place has no member count';
    const shared = sharedProblem(place.shared);
    if (shared !== null) return shared;
  }
  return null;
}

/**
 * Why `binding` is not one a standing record may hold, or null: every content one `checkedContents` gives for its
 * texts, in order, with its digest; exactly the warnings those contents give (S3); every limit inside the table; places
 * of one kind, each a Slack id once, with its member count and sharing; an account by its id; and who proposed it. The store refuses one before writing it, and
 * the validator a record that holds one, so nothing a caller assembles by hand — a custom emoji, a 31-day expiry, a
 * reply with a link — can become a standing approval.
 */
export function standingBindingProblem(binding: unknown): string | null {
  if (!isRecord(binding)) return 'it is not a standing approval';
  if (typeof binding.summary !== 'string') return 'it has no summary';
  const target = binding.target;
  if (!isRecord(target) || target.kind !== 'account' || typeof target.name !== 'string') return 'it names no account';
  if (typeof target.id !== 'string' || !ACCOUNT_ID_PATTERN.test(target.id)) return 'it names no account by its id';
  if (!Array.isArray(binding.contents)) return 'it has no contents';
  const written = binding.contents as unknown[];
  if (!written.every((content) => isRecord(content) && typeof content.text === 'string'))
    return 'a content is unreadable';
  const contents = written as StandingContent[];
  let checked: StandingContent[];
  let warnings: string[];
  try {
    ({ contents: checked, warnings } = checkedContents({
      reactions: contents.filter((content) => content.kind === 'reaction').map((content) => content.text),
      replies: contents.filter((content) => content.kind === 'reply').map((content) => content.text),
    }));
  } catch {
    return 'a content is not one a standing approval may hold';
  }
  // Only what was written: the default `eyes` stands for no contents at all, and a binding always says what it holds.
  if (contents.length === 0) return 'it holds no content';
  const canonical = (list: StandingContent[]) =>
    canonicalJson(list.map((content) => ({ kind: content.kind, text: content.text, digest: content.digest })));
  if (canonical(checked) !== canonical(contents))
    return 'its contents are not as checked, in order, with their digests';
  const places = placesProblem(binding.places);
  if (places !== null) return places;
  if (!isRecord(binding.limits)) return 'it has no limits';
  try {
    if (canonicalJson(checkedLimits(binding.limits as Partial<StandingLimits>)) !== canonicalJson(binding.limits)) {
      return 'its limits are not whole and complete';
    }
  } catch {
    return 'a limit is outside the table';
  }
  if (binding.proposedBy !== 'agent' && binding.proposedBy !== 'person') return 'it does not say who proposed it';
  if (
    binding.replaces !== undefined &&
    (typeof binding.replaces !== 'string' || !APPROVAL_ID_PATTERN.test(binding.replaces))
  ) {
    return 'what it replaces is not an approval id';
  }
  if (!isStrings(binding.warnings)) return 'its warnings are unreadable';
  // S3's warnings are its contents', derived again here: a caller cannot leave one out of what the person is shown.
  if (canonicalJson(binding.warnings) !== canonicalJson(warnings))
    return 'its warnings are not the ones its contents give';
  return null;
}

/** A copy of `binding` holding exactly its own fields, or BAD_DATA naming why it is not one (`standingBindingProblem`). */
export function canonicalStandingBinding(binding: StandingBinding): StandingBinding {
  const problem = standingBindingProblem(binding);
  if (problem !== null) {
    throw new CommsError('BAD_DATA', `nothing was prepared: ${problem}`, {
      hint: 'This is a bug — please report it.',
      details: { reason: 'binding-invalid' },
    });
  }
  return {
    summary: binding.summary,
    target: { kind: 'account', name: binding.target.name, id: binding.target.id },
    contents: binding.contents.map((content) => ({ kind: content.kind, text: content.text, digest: content.digest })),
    places:
      binding.places.kind === 'threads-i-am-in'
        ? { kind: 'threads-i-am-in' }
        : {
            kind: 'exact',
            places: binding.places.places.map((place) => ({
              id: place.id,
              name: place.name,
              members: place.members,
              shared: {
                extShared: place.shared.extShared,
                pendingExtShared: place.shared.pendingExtShared,
                externalMembers: place.shared.externalMembers,
              },
            })),
          },
    limits: { ...binding.limits },
    proposedBy: binding.proposedBy,
    ...(binding.replaces === undefined ? {} : { replaces: binding.replaces }),
    warnings: [...binding.warnings],
  };
}

/**
 * Why `narrowed`, stored beside `binding`, is not a narrowing of it, or null: each key what a narrowing holds, each
 * content and place one the binding has, and no limit above the binding's or outside the table. Not bound into the
 * record's digest, since it changes after approval; only ever able to narrow, so a hand that edits it can only take away.
 */
export function standingNarrowingProblem(binding: StandingBinding, narrowed: unknown): string | null {
  if (narrowed === undefined) return null;
  if (!isRecord(narrowed)) return 'it is not a narrowing';
  for (const key of Object.keys(narrowed))
    if (!['keep', 'places', 'limits'].includes(key)) return 'it is not a narrowing';
  if (narrowed.keep !== undefined && !isStrings(narrowed.keep)) return 'it keeps something that is not a digest';
  if (narrowed.places !== undefined && !isStrings(narrowed.places)) return 'it keeps something that is not a place';
  if (narrowed.limits !== undefined) {
    if (!isRecord(narrowed.limits)) return 'its limits are unreadable';
    for (const [name, value] of Object.entries(narrowed.limits)) {
      if (!(LIMIT_NAMES as readonly string[]).includes(name)) return 'it narrows a limit there is none of';
      const limit = name as keyof StandingLimits;
      if (!Number.isSafeInteger(value) || (value as number) < STANDING_LIMITS[limit].min)
        return 'a limit is outside the table';
      if ((value as number) > binding.limits[limit]) return 'it raises a limit';
    }
  }
  try {
    effectiveStanding(binding, narrowed as StandingNarrowing);
  } catch {
    return 'it keeps what the standing approval does not hold';
  }
  return null;
}

/** Whether a place recorded as `after` is one `before` approved: the same id, shared the same, and no bigger a room. */
function placeCovered(before: ExactPlace[], after: ExactPlace): boolean {
  const held = before.find((place) => place.id === after.id);
  if (held === undefined) return false;
  if (canonicalJson(held.shared) !== canonicalJson(after.shared)) return false;
  return after.members < STANDING_BIG_ROOM || held.members >= STANDING_BIG_ROOM;
}

/**
 * What `after` does to `before` (S8): `widens` with any content digest or exact place `before` does not hold — a place
 * shared differently, or grown to 50 or more members, is not the place it approved — a swap between exact places and
 * `threads-i-am-in` either way, another account, any higher limit, or a later expiry; `same` when it permits exactly
 * what `before` does; anything else that differs `narrows`. Unclear is a widening: it costs a person a code, never a
 * yes they did not give.
 */
export function classifyStandingChange(before: StandingBinding, after: StandingBinding): 'same' | 'narrows' | 'widens' {
  if (before.target.id !== after.target.id) return 'widens';
  const held = new Set(before.contents.map((content) => content.digest));
  if (after.contents.some((content) => !held.has(content.digest))) return 'widens';
  if (before.places.kind !== after.places.kind) return 'widens';
  if (before.places.kind === 'exact' && after.places.kind === 'exact') {
    const approved = before.places.places;
    if (after.places.places.some((place) => !placeCovered(approved, place))) return 'widens';
  }
  for (const name of LIMIT_NAMES) if (after.limits[name] > before.limits[name]) return 'widens';

  const kept = new Set(after.contents.map((content) => content.digest));
  const fewerContents = before.contents.some((content) => !kept.has(content.digest));
  const afterPlaces = after.places.kind === 'exact' ? after.places.places : [];
  const fewerPlaces =
    before.places.kind === 'exact' &&
    before.places.places.some((place) => !afterPlaces.some((now) => now.id === place.id));
  const lower = LIMIT_NAMES.some((name) => after.limits[name] < before.limits[name]);
  return fewerContents || fewerPlaces || lower ? 'narrows' : 'same';
}

/** `<why>` for each refusal reason, which `standingRefused` writes after `nothing was sent: `. */
const REFUSAL_WORDS: Readonly<Record<StandingRefusal, string>> = Object.freeze({
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
});

/**
 * The refusal of a standing act S4, S5, S7 or S9 does not allow: `STANDING_REFUSED`, `nothing was sent: <why>`, with
 * `details.reason`. `hint` is the caller's: the located `standing list`, and to ask the person instead — never a command
 * that widens one.
 */
export function standingRefused(reason: StandingRefusal, hint: string): CommsError {
  return new CommsError('STANDING_REFUSED', `nothing was sent: ${REFUSAL_WORDS[reason]}`, {
    hint,
    details: { reason },
  });
}

const LIMIT_WORDS: Readonly<Record<'perThread' | 'perHour' | 'perDay' | 'perSender', string>> = Object.freeze({
  perThread: 'per thread',
  perHour: 'an hour',
  perDay: 'a day',
  perSender: 'a day on messages from one person',
});

/**
 * The refusal of a standing act a limit stops (S6): `STANDING_LIMIT`, saying which limit and when it frees — `freesAt`
 * an ISO time, or null for `perThread`, which never frees. Never queued.
 */
export function standingLimitReached(
  limit: 'perThread' | 'perHour' | 'perDay' | 'perSender',
  allowed: number,
  freesAt: string | null,
  hint: string,
): CommsError {
  const frees = freesAt === null ? 'and it does not free' : `until ${freesAt}`;
  return new CommsError(
    'STANDING_LIMIT',
    `nothing was sent: this standing approval allows ${allowed} ${LIMIT_WORDS[limit]}, and that is reached, ${frees}`,
    { hint, details: { limit, allowed, freesAt } },
  );
}

/**
 * Ends every standing approval at once (S8): the standing epoch raised by one, in one locked write of the
 * configuration, which `ConfigStore.update` never lets fall back. Every standing record and every unused child binds
 * the epoch it was made under, so each has ended from this moment, whatever any record still says. The configuration
 * is made version 3 first, where the epoch lives. Returns the new epoch.
 */
export async function raiseStandingEpoch(core: Core): Promise<number> {
  await ensureSendEpochConfig(core);
  const written = await core.config.update(
    (config) => ({ ...config, standingEpoch: standingEpochOf(config) + 1 }) as Config,
  );
  return standingEpochOf(written);
}
