/** `parseRuleText`: the rule text back to its rule document. */
import type { JsonObject, JsonValue } from '../json.ts';
import { setOwn } from '../own-property.ts';
import { Cursor, lineTree, RuleTextFailure, type TextLine } from './lines.ts';
import type { RuleTextError, RuleTextParseResult } from './types.ts';
import {
  CHANNELS,
  DEFAULT_QUEUE_RETENTION,
  DEFAULT_RETENTION,
  DURATION_UNITS,
  EVENT_PHRASES,
  hasQueue,
  isFieldText,
  pointerTokens,
  REQUIRED_SECTIONS,
  RETENTION_LINES,
  RULE_FIELDS,
  series,
  suggestion,
} from './vocabulary.ts';

type Record_ = Record<string, JsonValue>;

/** The top-level keywords, and the document fields each one's section sets. */
const STATEMENTS: ReadonlyMap<string, readonly string[]> = new Map([
  ['rule', ['ruleId', 'version']],
  ['when', ['source', 'event']],
  ['match', ['condition']],
  ['ask', ['agentic']],
  ['then', ['targets']],
]);
const TOP_LEVEL = [
  'rule',
  'when',
  'match',
  'ask',
  'then',
  'keep',
  'keep for',
  'at most',
  'cloud event type',
  'subscriber',
  'raw',
];
const TOP_LEVEL_WORDS = 'rule, when, match, ask, then, keep, keep for, at most, cloud event type, subscriber or raw';

interface State {
  /** Fields a section set, with the line that set them. */
  readonly natural: Map<string, { readonly value: JsonValue; readonly line: number; readonly section: string }>;
  /** Fields `raw` set (or marked absent, as undefined), with where. */
  readonly raw: Map<string, { readonly value: JsonValue | undefined; readonly line: number; readonly column: number }>;
  /** Sections seen, by keyword, with their line; a section that failed still counts, so it is not reported missing. */
  readonly seen: Map<string, number>;
  readonly subscribers: JsonValue[];
  /** Every refusal so far; a section that can report several (one per target) adds them here. */
  readonly errors: RuleTextError[];
}

/**
 * Reads the rule text back to its rule document: the exact document `printRuleText` wrote, or the one a person's
 * edit says. It checks the text's grammar and nothing else; whether the accounts, lanes and targets exist, and whether
 * the event service accepts the rule, is the event service's to say when the document is submitted.
 */
export function parseRuleText(text: string): RuleTextParseResult {
  if (typeof text !== 'string')
    return { ok: false, errors: [{ line: 1, column: 1, message: 'rule text is a string' }] };
  const errors: RuleTextError[] = [];
  const lines = lineTree(text, errors);
  const state: State = { natural: new Map(), raw: new Map(), seen: new Map(), subscribers: [], errors };
  for (const line of lines) attempt(state, () => statement(line, state));
  const doc = assemble(state, errors, endOf(text));
  if (errors.length > 0) {
    errors.sort((left, right) => left.line - right.line || left.column - right.column);
    return { ok: false, errors };
  }
  return { ok: true, doc };
}

/** Runs `read`, recording a refusal instead of stopping, so one mistake does not hide the next. */
function attempt<T>(state: State, read: () => T): T | undefined {
  try {
    return read();
  } catch (error) {
    if (!(error instanceof RuleTextFailure)) throw error;
    state.errors.push(error.toError());
    return undefined;
  }
}

/** Where a missing section is reported: just after the text's last line. */
function endOf(text: string): number {
  return text.replace(/[ \t\r\n]+$/, '').split(/\r\n|\n|\r/).length + 1;
}

function fail(line: TextLine, message: string): never {
  throw new RuleTextFailure(line.number, line.column, message);
}

/** Refuses lines indented under a line that takes none. */
function noChildren(line: TextLine, what: string): void {
  const [child] = line.children;
  if (child !== undefined) fail(child, `unexpected indent: ${what} has no lines indented under it`);
}

/** Records that a once-only section starts on `line`, refusing a second one. */
function once(state: State, keyword: string, line: TextLine, cursor: Cursor): void {
  const first = state.seen.get(keyword);
  if (first !== undefined)
    cursor.fail(`a rule has one ${keyword} section; this repeats the one on line ${first}`, cursor.mark());
  state.seen.set(keyword, line.number);
}

function setNatural(state: State, section: string, line: TextLine, field: string, value: JsonValue): void {
  state.natural.set(field, { value, line: line.number, section });
}

function statement(line: TextLine, state: State): void {
  const cursor = new Cursor(line);
  const at = cursor.mark();
  const keyword = cursor.peekWord();
  switch (keyword) {
    case 'rule':
      once(state, 'rule', line, cursor);
      ruleLine(cursor, line, state);
      break;
    case 'when':
      once(state, 'when', line, cursor);
      whenLine(cursor, line, state);
      break;
    case 'match':
      once(state, 'match', line, cursor);
      cursor.take('match');
      setNatural(state, 'match', line, 'condition', condition(cursor, line));
      break;
    case 'ask':
      once(state, 'ask', line, cursor);
      setNatural(state, 'ask', line, 'agentic', ask(cursor, line));
      break;
    case 'then':
      once(state, 'then', line, cursor);
      thenSection(cursor, line, state);
      break;
    case 'keep': {
      const saved = cursor.save();
      if (cursor.take('keep', 'for') && cursor.atEnd()) {
        cursor.restore(saved);
        once(state, 'keep for', line, cursor);
        setNatural(state, 'keep for', line, 'retention', retention(line));
      } else {
        cursor.restore(saved);
        once(state, 'keep', line, cursor);
        setNatural(state, 'keep', line, 'mapping', keep(cursor, line));
      }
      break;
    }
    case 'at':
      if (!cursor.isNext('at', 'most')) cursor.fail('a line that starts with at says at most <n> an hour', at);
      once(state, 'at most', line, cursor);
      cursor.take('at', 'most');
      setNatural(state, 'at most', line, 'deliveryRateCap', cursor.integer('the hourly cap'));
      cursor.expect(['an', 'hour'], '"an hour" after the cap');
      cursor.expectEnd('the hourly cap');
      noChildren(line, 'at most');
      break;
    case 'cloud':
      once(state, 'cloud event type', line, cursor);
      cursor.expect(['cloud', 'event', 'type'], '"cloud event type <type>"');
      setNatural(state, 'cloud event type', line, 'cloudEventType', cursor.string('the CloudEvent type'));
      cursor.expectEnd('the CloudEvent type');
      noChildren(line, 'cloud event type');
      break;
    case 'subscriber':
      state.subscribers.push(subscriber(cursor, line));
      state.seen.set('subscriber', state.seen.get('subscriber') ?? line.number);
      break;
    case 'raw':
      rawLine(cursor, line, state);
      break;
    default: {
      if (keyword === undefined)
        cursor.fail(`a line here starts with a keyword: ${TOP_LEVEL_WORDS}; found ${cursor.describeNext()}`, at);
      const close = suggestion(keyword as string, TOP_LEVEL);
      cursor.fail(
        `unknown keyword ${JSON.stringify(keyword)}${close === undefined ? '.' : `; did you mean ${JSON.stringify(close)}?`} A line here starts with ${TOP_LEVEL_WORDS}`,
        at,
      );
    }
  }
}

function ruleLine(cursor: Cursor, line: TextLine, state: State): void {
  cursor.take('rule');
  const ruleId = cursor.name('the rule id');
  cursor.expect([',', 'version'], '", version <n>" after the rule id');
  const version = cursor.integer('the rule version');
  cursor.expectEnd('the rule version');
  noChildren(line, 'the rule line');
  setNatural(state, 'rule', line, 'ruleId', ruleId);
  setNatural(state, 'rule', line, 'version', version);
}

/** Names joined by `and`: `a`, `a and b`. */
function names(cursor: Cursor, what: string): string[] {
  const found = [cursor.name(what)];
  while (cursor.take('and')) found.push(cursor.name(what));
  return found;
}

const EVENT_CHOICES = `${EVENT_PHRASES.map((phrase) => phrase.words.join(' ')).join(', ')}, or event "<type>" version <n>`;

function whenLine(cursor: Cursor, line: TextLine, state: State): void {
  cursor.take('when');
  let type: string | undefined;
  let version = 1;
  for (const phrase of EVENT_PHRASES) {
    if (cursor.take(...phrase.words)) {
      type = phrase.type;
      break;
    }
  }
  if (type === undefined) {
    if (!cursor.take('event')) cursor.fail(`expected the event after when: ${EVENT_CHOICES}`, cursor.mark());
    const at = cursor.mark();
    type = cursor.string('the event type');
    if (!CHANNELS.includes(type.split('.')[0] as string))
      cursor.fail(
        `the event type starts with its channel, gmail, slack, resend or whatsapp, as in gmail.message.received; found ${JSON.stringify(type)}`,
        at,
      );
    cursor.expect(['version'], '"version <n>" after the event type');
    version = cursor.integer('the event version');
  }
  const channel = type.split('.')[0] as string;
  cursor.expect(['in'], '"in <account>" after the event');
  const accountIds = names(cursor, 'an account');
  const options = sourceOptions(cursor, channel);
  cursor.expectEnd('the source options');
  noChildren(line, 'the when line');
  setNatural(state, 'when', line, 'source', { channel, accountIds, options });
  setNatural(state, 'when', line, 'event', { type, version });
}

/** The options after the accounts, each after a comma, for the channel the event belongs to. */
function sourceOptions(cursor: Cursor, channel: string): Record_ {
  const said = new Set<string>();
  const options: Record_ = { channel };
  const one = (what: string, at: number) => {
    if (said.has(what)) cursor.fail(`the ${what} are given twice`, at);
    said.add(what);
  };
  while (cursor.comma()) {
    const at = cursor.mark();
    if (channel === 'gmail') {
      if (cursor.take('in', 'the', 'inbox')) {
        one('labels', at);
        options.labels = 'inbox';
      } else if (cursor.take('in', 'any', 'label')) {
        one('labels', at);
        options.labels = 'any';
      } else if (cursor.take('in', 'label') || cursor.take('in', 'labels')) {
        one('labels', at);
        options.labels = names(cursor, 'a label');
      } else if (cursor.take('including', 'spam', 'and', 'trash')) {
        one('spam and trash', at);
        options.includeSpamTrash = true;
      } else
        cursor.fail(
          `a Gmail rule's options are in the inbox, in any label, in labels <label> and <label>, and including spam and trash; found ${cursor.describeNext()}`,
          at,
        );
    } else if (channel === 'slack') {
      if (!(cursor.take('in', 'conversation') || cursor.take('in', 'conversations')))
        cursor.fail(`a Slack rule's option is in conversations <id> and <id>; found ${cursor.describeNext()}`, at);
      one('conversations', at);
      options.conversations = names(cursor, 'a conversation');
    } else if (channel === 'resend') {
      if (!(cursor.take('kind') || cursor.take('kinds')))
        cursor.fail(`a Resend rule's option is kinds received and status; found ${cursor.describeNext()}`, at);
      one('kinds', at);
      options.kinds = names(cursor, 'a kind');
    } else if (channel === 'whatsapp') {
      if (cursor.take('in', 'all', 'allowed', 'chats')) {
        one('chats', at);
        options.chats = 'all-allowed';
      } else if (cursor.take('in', 'chat') || cursor.take('in', 'chats')) {
        one('chats', at);
        options.chats = names(cursor, 'a chat');
      } else
        cursor.fail(
          `a WhatsApp rule's option is in all allowed chats, or in chats <id> and <id>; found ${cursor.describeNext()}`,
          at,
        );
    } else
      cursor.fail(
        `the event's channel, ${JSON.stringify(channel)}, is not one of gmail, slack, resend and whatsapp`,
        at,
      );
  }
  const required: Readonly<Record<string, readonly [string, string]>> = {
    gmail: ['labels', 'say which mail: in the inbox, in any label, or in labels <label> and <label>'],
    slack: ['conversations', 'say which conversations: in conversations <id> and <id>'],
    resend: ['kinds', 'say which emails: kinds received and status'],
    whatsapp: ['chats', 'say which chats: in all allowed chats, or in chats <id> and <id>'],
  };
  const need = required[channel];
  if (need !== undefined && !Object.hasOwn(options, need[0]))
    cursor.fail(`after the accounts, ${need[1]}`, cursor.mark());
  if (channel === 'gmail' && !Object.hasOwn(options, 'includeSpamTrash')) options.includeSpamTrash = false;
  return options;
}

const DOTTED = /^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/;

/** A field: a dotted name (`from.address`), or a JSON Pointer, bare (`/from/address`) or quoted. */
export function field(cursor: Cursor, what: string): string {
  const at = cursor.mark();
  if (cursor.isString()) {
    const pointer = cursor.string(what);
    if (!isFieldText(pointer)) cursor.fail(`${what} in quotes is a JSON Pointer, which starts with /`, at);
    return pointer;
  }
  const word = cursor.word();
  if (word === undefined)
    return cursor.fail(`expected ${what}: a field such as subject or from.address; found ${cursor.describeNext()}`, at);
  if (word.startsWith('/')) return word;
  if (DOTTED.test(word)) return `/${word.split('.').join('/')}`;
  return cursor.fail(
    `${JSON.stringify(word)} is not a field: write a dotted name such as from.address, or a JSON Pointer such as /from/address`,
    at,
  );
}

/** Reads `, matching case` if it comes, then the end of the line. */
function caseSensitivity(cursor: Cursor): boolean {
  const sensitive = cursor.comma();
  if (sensitive) cursor.expect(['matching', 'case'], '"matching case" after the comma');
  cursor.expectEnd('the condition');
  return sensitive;
}

function textValue(cursor: Cursor, what: string): string {
  const at = cursor.mark();
  const value = cursor.value(what);
  if (typeof value !== 'string') cursor.fail(`${what} is quoted text`, at);
  return value as string;
}

/** One condition from the rest of `line`; `any` and `all` take their members from the lines indented under it. */
function condition(cursor: Cursor, line: TextLine): JsonValue {
  if (cursor.take('not')) return { not: condition(cursor, line) };
  if (cursor.take('raw')) {
    const value = cursor.json('the raw condition');
    cursor.expectEnd('the raw condition');
    noChildren(line, 'a raw condition');
    return value;
  }
  for (const group of ['any', 'all'] as const) {
    if (!cursor.take(group)) continue;
    cursor.expectEnd(group);
    if (line.children.length === 0) fail(line, `${group} needs its conditions on the lines indented under it`);
    return { [group]: line.children.map((child) => condition(new Cursor(child), child)) };
  }
  noChildren(line, 'a condition other than any and all');
  const path = field(cursor, 'the field');
  if (cursor.take('exists')) {
    cursor.expectEnd('exists');
    return { path, op: 'exists' };
  }
  if (cursor.take('is')) {
    if (cursor.take('not')) {
      const value = cursor.value('the value');
      return { path, op: 'notEquals', value, caseSensitive: caseSensitivity(cursor) };
    }
    if (cursor.take('one', 'of')) {
      const values = [cursor.value('a value')];
      while (cursor.comma()) values.push(cursor.value('a value'));
      cursor.expectEnd('the values');
      return { path, op: 'in', values };
    }
    for (const [words, op] of [
      [['more', 'than'], 'gt'],
      [['at', 'least'], 'gte'],
      [['less', 'than'], 'lt'],
      [['at', 'most'], 'lte'],
    ] as const) {
      if (!cursor.take(...words)) continue;
      const at = cursor.mark();
      const value = cursor.value('the bound');
      if (typeof value !== 'number' && typeof value !== 'string')
        cursor.fail('the bound is a number, or quoted text such as a time', at);
      cursor.expectEnd('the bound');
      return { path, op, value };
    }
    const value = cursor.value('the value');
    return { path, op: 'equals', value, caseSensitive: caseSensitivity(cursor) };
  }
  if (cursor.take('contains') || cursor.take('mentions')) {
    const value = cursor.value('the value');
    return { path, op: 'contains', value, caseSensitive: caseSensitivity(cursor) };
  }
  for (const [words, op] of [
    [['starts', 'with'], 'startsWith'],
    [['ends', 'with'], 'endsWith'],
  ] as const) {
    if (!cursor.take(...words)) continue;
    const value = textValue(cursor, 'the text');
    return { path, op, value, caseSensitive: caseSensitivity(cursor) };
  }
  if (cursor.take('has', 'domain')) {
    const value = textValue(cursor, 'the domain');
    const includeSubdomains = cursor.take('or', 'a', 'subdomain');
    cursor.expectEnd('the domain');
    return { path, op: 'domainIs', value, includeSubdomains };
  }
  return cursor.fail(
    `after the field comes exists, is, is not, is one of, is more than, is at least, is less than, is at most, contains, starts with, ends with or has domain; found ${cursor.describeNext()}`,
    cursor.mark(),
  );
}

/** A duration: a whole number and a unit, `7 days`, `1 hour`. */
export function duration(cursor: Cursor, what: string): number {
  const count = cursor.integer(what);
  const at = cursor.mark();
  const unit = cursor.word();
  const found = DURATION_UNITS.find(([singular, plural]) => unit === singular || unit === plural);
  if (found === undefined)
    return cursor.fail(`${what} is a duration such as 7 days: days, hours, minutes, seconds or milliseconds`, at);
  const milliseconds = count * found[2];
  if (!Number.isSafeInteger(milliseconds)) return cursor.fail(`${what} is too long`, at);
  return milliseconds;
}

/** Reads `, clause`s, each at most once, by its first word; then the end of the line. */
function clauses(
  cursor: Cursor,
  what: string,
  readers: Readonly<Record<string, readonly [phrase: string, read: () => void]>>,
): void {
  const said = new Set<string>();
  while (cursor.comma()) {
    const at = cursor.mark();
    const word = cursor.peekWord();
    if (word === undefined || !Object.hasOwn(readers, word)) {
      const phrases = Object.values(readers).map(([phrase]) => phrase);
      cursor.fail(`${what}'s options are ${series(phrases, 'and')}; found ${cursor.describeNext()}`, at);
    }
    const [phrase, read] = readers[word] as readonly [string, () => void];
    if (said.has(word)) cursor.fail(`${what} says ${phrase.split(' <')[0]} twice`, at);
    said.add(word);
    read();
  }
  cursor.expectEnd(what);
}

function targetHead(cursor: Cursor): Record_ {
  const targetId = cursor.name('the target id');
  cursor.expect([',', 'version'], '", version <n>" after the target id');
  return { targetId, version: cursor.integer('the target version') };
}

function representationReader(cursor: Cursor, target: Record_, word: 'plain' | 'enveloped'): () => void {
  return () => {
    const at = cursor.mark();
    if (Object.hasOwn(target, 'representation')) cursor.fail('a target is plain or enveloped, not both', at);
    cursor.take(word);
    target.representation = word;
  };
}

const TARGET_KINDS = ['dry run', 'queue', 'webhook', 'stream', 'raw'];

function thenSection(cursor: Cursor, line: TextLine, state: State): void {
  cursor.take('then');
  cursor.expectEnd('then');
  if (line.children.length === 0) fail(line, 'then needs at least one target, each on its own line indented under it');
  const failed = state.errors.length;
  const targets = line.children.map((child) => attempt(state, () => target(child)));
  if (state.errors.length === failed) setNatural(state, 'then', line, 'targets', targets as JsonValue[]);
}

function target(line: TextLine): JsonValue {
  const cursor = new Cursor(line);
  const at = cursor.mark();
  if (cursor.take('raw')) {
    const value = cursor.json('the raw target');
    cursor.expectEnd('the raw target');
    noChildren(line, 'a raw target');
    return value;
  }
  if (cursor.take('dry', 'run')) {
    const target = { ...targetHead(cursor), kind: 'dry-run' } as Record_;
    clauses(cursor, 'a dry run', {
      keep: [
        'keep <duration>',
        () => {
          cursor.take('keep');
          target.retentionMs = duration(cursor, 'how long a dry run keeps a record');
        },
      ],
    });
    noChildren(line, 'a dry run');
    return target;
  }
  if (cursor.take('queue')) {
    const target = { ...targetHead(cursor), kind: 'queue' } as Record_;
    clauses(cursor, 'a queue', {
      in: [
        'in lane <name>',
        () => {
          cursor.expect(['in', 'lane'], '"in lane <name>"');
          target.lane = { name: cursor.name('the lane') };
        },
      ],
      keep: [
        'keep <duration>',
        () => {
          cursor.take('keep');
          target.retentionMs = duration(cursor, 'how long a queue keeps an item');
        },
      ],
      show: [
        'show <what>',
        () => {
          cursor.take('show');
          target.show = cursor.name('what an item shows');
        },
      ],
    });
    if (!Object.hasOwn(target, 'show')) target.show = 'summary';
    noChildren(line, 'a queue');
    return target;
  }
  if (cursor.take('webhook')) {
    const target = { ...targetHead(cursor), kind: 'webhook' } as Record_;
    clauses(cursor, 'a webhook', {
      plain: ['plain', representationReader(cursor, target, 'plain')],
      enveloped: ['enveloped', representationReader(cursor, target, 'enveloped')],
      retrying: [
        'retrying up to <n> times',
        () => {
          cursor.expect(['retrying', 'up', 'to'], '"retrying up to <n> times"');
          target.retryLimit = cursor.integer('the retry limit');
          if (!(cursor.take('times') || cursor.take('time')))
            cursor.fail('expected "times" after the retry limit', cursor.mark());
        },
      ],
    });
    webhookLines(line, target);
    return target;
  }
  if (cursor.take('stream')) {
    const target = { ...targetHead(cursor), kind: 'sse' } as Record_;
    clauses(cursor, 'a stream', {
      plain: ['plain', representationReader(cursor, target, 'plain')],
      enveloped: ['enveloped', representationReader(cursor, target, 'enveloped')],
      to: [
        'to subscriber <id> version <n>',
        () => {
          cursor.expect(['to', 'subscriber'], '"to subscriber <id> version <n>"');
          target.subscriberId = cursor.name('the subscriber id');
          cursor.expect(['version'], '"version <n>" after the subscriber id');
          target.subscriberVersion = cursor.integer('the subscriber version');
        },
      ],
    });
    noChildren(line, 'a stream');
    return target;
  }
  const word = cursor.peekWord();
  if (word === 'session' || word === 'linear')
    return cursor.fail(
      `a ${word} target is not in this version of the rule text yet; write it as raw followed by its JSON document`,
      at,
    );
  const close = word === undefined ? undefined : suggestion(word, TARGET_KINDS);
  return cursor.fail(
    `a target starts with ${series(TARGET_KINDS, 'or')}; found ${cursor.describeNext()}${
      close === undefined ? '' : `. Did you mean ${JSON.stringify(close)}?`
    }`,
    at,
  );
}

/** A webhook's indented lines: where it sends, the addresses it may reach, and its signing and ordering. */
function webhookLines(line: TextLine, target: Record_): void {
  const said = new Set<string>();
  for (const child of line.children) {
    const cursor = new Cursor(child);
    const at = cursor.mark();
    noChildren(child, 'a webhook option');
    const word = cursor.peekWord() ?? '';
    if (said.has(word)) cursor.fail(`a webhook says ${word} once`, at);
    said.add(word);
    if (cursor.take('to', 'secret')) {
      const scheme = cursor.name('the scheme');
      cursor.expect(['URL', 'on'], '"URL on <host>" after the scheme');
      const host = cursor.name('the host');
      cursor.expect(['port'], '"port <n>" after the host');
      const port = cursor.integer('the port');
      cursor.expect([',', 'fingerprint'], '", fingerprint <sha-256>" after the port');
      target.url = { kind: 'secret', scheme, host, port, sha256: cursor.name('the fingerprint') };
    } else if (cursor.take('to')) target.url = { kind: 'plain', value: cursor.name('the URL') };
    else if (cursor.take('approved', 'address') || cursor.take('approved', 'addresses'))
      target.approvedAddressSet = names(cursor, 'an address');
    else if (cursor.take('signed')) target.signing = cursor.name('the signing');
    else if (cursor.take('ordering')) target.ordering = cursor.name('the ordering');
    else
      cursor.fail(
        `a webhook's indented lines are to, approved addresses, signed and ordering; found ${cursor.describeNext()}`,
        at,
      );
    cursor.expectEnd('the webhook option');
  }
  if (!Object.hasOwn(target, 'signing')) target.signing = 'standard-webhooks';
  if (!Object.hasOwn(target, 'ordering')) target.ordering = 'strict';
}

function subscriber(cursor: Cursor, line: TextLine): JsonValue {
  cursor.take('subscriber');
  const subscriberId = cursor.name('the subscriber id');
  cursor.expect([',', 'version'], '", version <n>" after the subscriber id');
  const found: Record_ = { subscriberId, version: cursor.integer('the subscriber version'), kind: 'sse' };
  clauses(cursor, 'a subscriber', {
    on: [
      'on <host> port <n>',
      () => {
        cursor.take('on');
        const host = cursor.name('the host');
        cursor.expect(['port'], '"port <n>" after the host');
        found.authority = { host, port: cursor.integer('the port') };
      },
    ],
    keep: [
      'keep <duration>',
      () => {
        cursor.take('keep');
        found.retentionMs = duration(cursor, 'how long a subscriber can replay');
      },
    ],
  });
  for (const child of line.children) {
    const inner = new Cursor(child);
    noChildren(child, 'origins');
    if (Object.hasOwn(found, 'origins')) inner.fail('a subscriber lists its origins once', inner.mark());
    if (!(inner.take('origin') || inner.take('origins')))
      inner.fail(
        `a subscriber's indented line is origins <origin> and <origin>; found ${inner.describeNext()}`,
        inner.mark(),
      );
    found.origins = names(inner, 'an origin');
    inner.expectEnd('the origins');
  }
  return found;
}

function rawLine(cursor: Cursor, line: TextLine, state: State): void {
  cursor.take('raw');
  const at = cursor.mark();
  const pointer = cursor.isString() ? cursor.string('the field') : cursor.word();
  if (pointer === undefined || !pointer.startsWith('/') || pointer.slice(1).includes('/') || /~[^01]|~$/.test(pointer))
    cursor.fail('raw names one top-level field as a JSON Pointer, such as /retention', at);
  const name = (pointer as string).slice(1).replaceAll('~1', '/').replaceAll('~0', '~');
  if (state.raw.has(name)) cursor.fail(`raw gives ${pointer} twice`, at);
  let value: JsonValue | undefined;
  if (!cursor.take('absent')) {
    cursor.expect(['='], '"= <JSON>" or "absent" after the field');
    value = cursor.json('the raw value');
  }
  cursor.expectEnd('the raw value');
  noChildren(line, 'a raw line');
  state.raw.set(name, { value, line: line.number, column: cursor.column(at) });
}

/** The document from what the sections and `raw` said, with the defaults for what neither did. */
function assemble(state: State, errors: RuleTextError[], end: number): JsonObject {
  if (state.subscribers.length > 0)
    state.natural.set('subscribers', {
      value: state.subscribers,
      line: state.seen.get('subscriber') ?? 1,
      section: 'subscriber',
    });
  for (const [name, raw] of state.raw) {
    const natural = state.natural.get(name);
    if (natural !== undefined)
      errors.push({
        line: raw.line,
        column: raw.column,
        message: `${name} is given twice: by this raw line and by the ${natural.section} section on line ${natural.line}`,
      });
  }
  const tried = new Set([...state.seen.keys()].flatMap((keyword) => STATEMENTS.get(keyword) ?? []));
  for (const section of REQUIRED_SECTIONS) {
    const missing = section.fields.some((name) => !state.natural.has(name) && !state.raw.has(name) && !tried.has(name));
    if (missing) errors.push({ line: section.fields[0] === 'ruleId' ? 1 : end, column: 1, message: section.message });
  }
  const doc: Record_ = {};
  const has = (name: string) => state.natural.has(name) || state.raw.has(name);
  for (const name of [...RULE_FIELDS, ...state.raw.keys()]) {
    if (Object.hasOwn(doc, name)) continue;
    const natural = state.natural.get(name);
    const raw = state.raw.get(name);
    if (natural !== undefined) setOwn(doc, name, natural.value);
    else if (raw !== undefined && raw.value !== undefined) setOwn(doc, name, raw.value);
  }
  if (!has('judges')) doc.judges = [];
  if (!has('subscribers')) doc.subscribers = [];
  if (!state.raw.has('retention')) {
    const queued = hasQueue(doc.targets);
    const overrides = state.natural.get('retention')?.value as Record_ | undefined;
    const retention: Record_ = { ...DEFAULT_RETENTION };
    if (queued) retention.queueMs = DEFAULT_QUEUE_RETENTION;
    doc.retention = { ...retention, ...overrides };
  }
  return doc;
}

/** The lines indented under a section, each read once by the reader its first words choose. */
function block(
  line: TextLine,
  what: string,
  readers: readonly (readonly [
    words: readonly string[],
    read: (cursor: Cursor, child: TextLine) => void,
    takesLines?: 'takes lines',
  ])[],
): void {
  const said = new Map<string, number>();
  for (const child of line.children) {
    const cursor = new Cursor(child);
    const at = cursor.mark();
    const found = readers.find(([words]) => cursor.isNext(...words));
    if (found === undefined) {
      const choices = readers.map(([words]) => words.join(' '));
      const word = cursor.peekWord();
      const close = word === undefined ? undefined : suggestion(word, choices);
      cursor.fail(
        `${what}'s lines are ${series(choices, 'and')}; found ${cursor.describeNext()}${
          close === undefined ? '' : `. Did you mean ${JSON.stringify(close)}?`
        }`,
        at,
      );
    }
    const [words, read, takesLines] = found as (typeof readers)[number];
    const key = words.join(' ');
    const first = said.get(key);
    if (first !== undefined) cursor.fail(`${what} says ${key} once; it is already on line ${first}`, at);
    said.set(key, child.number);
    cursor.take(...words);
    if (takesLines === undefined) noChildren(child, key);
    read(cursor, child);
    cursor.expectEnd(key);
  }
}

const UNSURE: Readonly<Record<string, string>> = { drop: 'no-match', hold: 'hold' };

function unsure(cursor: Cursor): string {
  const at = cursor.mark();
  const word = cursor.word();
  if (word === undefined || !Object.hasOwn(UNSURE, word))
    return cursor.fail(
      `when the judge is unsure, the rule can drop the message or hold it; found ${word === undefined ? cursor.describeNext() : JSON.stringify(word)}`,
      at,
    );
  return UNSURE[word] as string;
}

/** The `ask` section: the judge on its first line, the rest on the lines indented under it. */
function ask(cursor: Cursor, line: TextLine): JsonValue {
  cursor.take('ask');
  const judge: Record_ = { judgeId: cursor.name('the judge id') };
  cursor.expect([',', 'version'], '", version <n>" after the judge id');
  judge.version = cursor.integer('the judge version');
  if (cursor.comma()) {
    cursor.expect(['via'], '", via <provider>"');
    judge.provider = cursor.name('the provider');
  }
  cursor.expectEnd('the judge');
  const agentic: Record_ = { judge };
  block(line, 'an ask', [
    [
      ['question'],
      (inner) => {
        agentic.question = inner.string('the question');
      },
    ],
    [
      ['looking', 'at'],
      (inner) => {
        if (inner.take('nothing')) agentic.inputs = [];
        else {
          const inputs = [field(inner, 'a field the judge looks at')];
          while (inner.comma()) inputs.push(field(inner, 'a field the judge looks at'));
          agentic.inputs = inputs;
        }
      },
    ],
    [
      ['yes', 'at'],
      (inner) => {
        const at = inner.mark();
        const threshold = inner.value('the bar');
        if (typeof threshold !== 'number') inner.fail('the bar is a number from 0 to 1, such as 0.7', at);
        agentic.threshold = threshold;
        if (inner.comma()) {
          inner.expect(['if', 'unsure'], '", if unsure drop" or ", if unsure hold"');
          if (Object.hasOwn(agentic, 'onUncertain'))
            inner.fail('the ask says what happens when the judge is unsure once', inner.mark());
          agentic.onUncertain = unsure(inner);
        }
      },
    ],
    [
      ['if', 'unsure'],
      (inner) => {
        if (Object.hasOwn(agentic, 'onUncertain'))
          inner.fail('the ask says what happens when the judge is unsure once', inner.mark());
        agentic.onUncertain = unsure(inner);
      },
    ],
    [
      ['at', 'most'],
      (inner) => {
        const said = new Set<string>();
        do {
          const at = inner.mark();
          const count = inner.integer('the limit');
          let field: string;
          if (inner.take('call', 'an', 'hour') || inner.take('calls', 'an', 'hour')) field = 'callsPerRollingHour';
          else if (
            inner.take('input', 'token', 'in', '30', 'days') ||
            inner.take('input', 'tokens', 'in', '30', 'days')
          )
            field = 'inputTokensPerRolling30Days';
          else if (inner.take('at', 'a', 'time')) field = 'concurrency';
          else
            return inner.fail(
              `a judge's limits are <n> calls an hour, <n> input tokens in 30 days and <n> at a time; found ${inner.describeNext()}`,
              inner.mark(),
            );
          if (said.has(field)) inner.fail('each limit is given once', at);
          said.add(field);
          agentic[field] = count;
        } while (inner.comma());
      },
    ],
    [
      ['each', 'call', 'up', 'to'],
      (inner) => {
        const said = new Set<string>();
        do {
          const at = inner.mark();
          const count = inner.integer('the token cap');
          if (!(inner.take('token') || inner.take('tokens')))
            inner.fail('expected "tokens in" or "tokens out"', inner.mark());
          const field = inner.take('in') ? 'maxInputTokens' : inner.take('out') ? 'maxOutputTokens' : undefined;
          if (field === undefined) return inner.fail('expected "in" or "out" after tokens', inner.mark());
          if (said.has(field)) inner.fail('each call gives its tokens in and out once each', at);
          said.add(field);
          agentic[field] = count;
        } while (inner.take('and'));
      },
    ],
    [
      ['judge'],
      (inner, child) => {
        if (!inner.atEnd() && !inner.nextIs(',')) judge.kind = inner.name('the judge kind');
        if (inner.comma()) {
          inner.expect(['model'], '", model <name>"');
          judge.model = inner.name('the model');
        }
        block(child, 'a judge', [
          [
            ['endpoint'],
            (deeper) => {
              judge.endpoint = deeper.name('the endpoint');
            },
          ],
          [
            ['approved'],
            (deeper) => {
              if (!(deeper.take('address') || deeper.take('addresses')))
                deeper.fail('expected "approved addresses <address> and <address>"', deeper.mark());
              judge.approvedAddressSet = names(deeper, 'an address');
            },
          ],
          [
            ['prompt', 'template'],
            (deeper) => {
              judge.promptTemplate = deeper.name('the prompt template');
            },
          ],
          [
            ['protocol'],
            (deeper) => {
              judge.protocol = deeper.name('the protocol');
            },
          ],
          [
            ['score', 'at'],
            (deeper) => {
              judge.scorePointer = field(deeper, 'the score');
            },
          ],
        ]);
      },
      'takes lines',
    ],
  ]);
  return agentic;
}

/** The `keep for` block: one retention per line, each a duration. */
function retention(line: TextLine): JsonValue {
  const overrides: Record_ = {};
  if (line.children.length === 0)
    fail(line, 'keep for needs its retentions on the lines indented under it, such as  events 7 days');
  block(
    line,
    'keep for',
    RETENTION_LINES.map(([words, field]) => [
      words,
      (cursor: Cursor) => {
        overrides[field] = duration(cursor, `how long it keeps ${words.join(' ')}`);
      },
    ]),
  );
  return overrides;
}

/** Sets `value` at `path` in a mapping under construction, through objects this parse made, never over a value. */
function place(
  root: Record_,
  path: readonly string[],
  value: JsonValue,
  made: Set<object>,
  cursor: Cursor,
  at: number,
): void {
  let node = root;
  for (const key of path.slice(0, -1)) {
    if (!Object.hasOwn(node, key)) {
      const child: Record_ = {};
      setOwn<JsonValue>(node, key, child);
      made.add(child);
      node = child;
      continue;
    }
    const existing = node[key];
    if (typeof existing !== 'object' || existing === null || !made.has(existing))
      cursor.fail(`${path.join('.')} is kept inside a value that is already kept`, at);
    node = existing as Record_;
  }
  const last = path.at(-1) as string;
  if (Object.hasOwn(node, last)) cursor.fail(`${path.join('.')} is kept twice`, at);
  setOwn(node, last, value);
}

/** The `keep` line: the mapping, as fields, fields kept elsewhere (`as`), and fixed values (`name = JSON`). */
function keep(cursor: Cursor, line: TextLine): JsonValue {
  cursor.take('keep');
  noChildren(line, 'keep');
  const saved = cursor.save();
  if (cursor.take('nothing') && cursor.atEnd()) return {};
  cursor.restore(saved);
  const root: Record_ = {};
  const made = new Set<object>();
  do {
    const at = cursor.mark();
    const start = cursor.save();
    const named = cursor.segments('a kept name');
    if (named !== undefined && cursor.take('=')) {
      place(root, named, cursor.json('the fixed value'), made, cursor, at);
      continue;
    }
    cursor.restore(start);
    const pointer = field(cursor, 'a field to keep');
    let path = pointerTokens(pointer);
    if (cursor.take('as')) {
      const as = cursor.segments('where the field is kept');
      if (as === undefined) cursor.fail(`expected a name after as; found ${cursor.describeNext()}`, cursor.mark());
      path = as as readonly string[];
    }
    if (path.length === 0) cursor.fail('the whole event is kept under a name: "" as <name>', at);
    const reference: Record_ = { $path: pointer };
    if (cursor.take('if', 'missing')) reference.missing = cursor.name('what happens when the field is missing');
    place(root, path, reference, made, cursor, at);
  } while (cursor.comma());
  cursor.expectEnd('the kept fields');
  return root;
}
