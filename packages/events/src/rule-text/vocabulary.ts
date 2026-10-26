/** The rule text's words: what the printer writes and the parser reads, kept in one place so the two agree. */
import type { JsonValue } from '../json.ts';
import { RULE_RETENTION_DEFAULTS } from '../retention.ts';
import { WORD_CHARACTERS } from './lines.ts';

/**
 * The words a bare name cannot be, because the grammar reads them where a name may end: `and` between names,
 * `version` after a subscriber's id, `port` after a host, `URL` after a scheme, `secret` after `to`. Any such name
 * is written quoted.
 */
export const NAME_RESERVED: ReadonlySet<string> = new Set(['and', 'version', 'port', 'URL', 'secret']);

/**
 * The words a dotted field cannot be, because the grammar reads them where a field may start: `not`, `raw`, `any`
 * and `all` in a condition, `nothing` after `looking at` and `keep`, `for` after `keep`. Such a field is written as its
 * JSON Pointer, `/any`.
 */
export const FIELD_RESERVED: ReadonlySet<string> = new Set(['not', 'raw', 'any', 'all', 'nothing', 'for']);

/** The four channels a rule's source can name. */
export const CHANNELS: readonly string[] = ['gmail', 'slack', 'resend', 'whatsapp'];

/** The phrase for each catalogue event at version 1. Any other event is written `event "<type>" version <n>`. */
export const EVENT_PHRASES: readonly { readonly type: string; readonly words: readonly string[] }[] = [
  { type: 'gmail.message.received', words: ['a', 'new', 'message', 'arrives'] },
  { type: 'gmail.message.sent', words: ['a', 'message', 'is', 'sent'] },
  { type: 'gmail.message.labelled', words: ['a', 'message', 'is', 'labelled'] },
  { type: 'slack.message.posted', words: ['a', 'Slack', 'message', 'is', 'posted'] },
  { type: 'resend.email.received', words: ['a', 'Resend', 'email', 'arrives'] },
  { type: 'resend.email.status_changed', words: ['a', 'Resend', 'email', 'changes', 'status'] },
  { type: 'whatsapp.message.received', words: ['a', 'WhatsApp', 'message', 'arrives'] },
];

const DAY = 86_400_000;

/** Duration units, largest first. A duration is written in the largest unit that divides it exactly. */
export const DURATION_UNITS: readonly (readonly [singular: string, plural: string, milliseconds: number])[] = [
  ['day', 'days', DAY],
  ['hour', 'hours', 3_600_000],
  ['minute', 'minutes', 60_000],
  ['second', 'seconds', 1_000],
  ['millisecond', 'milliseconds', 1],
];

/** The retention a rule has when its text has no `keep for` lines, without the queue's, which only a queued rule has. */
const { queueMs: queueDefault, ...ruleDefaults } = RULE_RETENTION_DEFAULTS;
export const DEFAULT_RETENTION: Readonly<Record<string, number>> = Object.freeze(ruleDefaults);
export const DEFAULT_QUEUE_RETENTION: number = queueDefault;

/** The `keep for` lines, in the order they are printed, with the retention field each sets. */
export const RETENTION_LINES: readonly (readonly [words: readonly string[], field: string])[] = [
  [['events'], 'ingestMs'],
  [['held', 'events'], 'holdMs'],
  [['deliveries'], 'deliveryMs'],
  [['dry', 'runs'], 'dryrunMs'],
  [['stream', 'replay'], 'sseReplayMs'],
  [['dead', 'letters'], 'deadLetterMs'],
  [['decisions'], 'decisionMetadataMs'],
  [['queue', 'items'], 'queueMs'],
];

/** The fields of the canonical rule document in the order a parsed document carries them. */
export const RULE_FIELDS: readonly string[] = [
  'ruleId',
  'version',
  'source',
  'event',
  'condition',
  'agentic',
  'mapping',
  'cloudEventType',
  'targets',
  'subscribers',
  'judges',
  'deliveryRateCap',
  'retention',
];

/** Fields a rule's text must account for, by a section or by `raw`, and what to say when it does not. */
export const REQUIRED_SECTIONS: readonly { readonly fields: readonly string[]; readonly message: string }[] = [
  { fields: ['ruleId', 'version'], message: "a rule's text starts with its id and version: rule <id>, version <n>" },
  {
    fields: ['source', 'event'],
    message: 'a rule says when it applies: when a new message arrives in <account>, in the inbox',
  },
  {
    fields: ['condition'],
    message: 'a rule says which messages match: match <condition>, or match any with conditions below it',
  },
  {
    fields: ['targets'],
    message: 'a rule says what happens to a match: then, with each target on its own indented line below it',
  },
];

/** Fields a parsed document gets a value for when its text says nothing: the empty lists, and the default retention. */
export const DEFAULTED_FIELDS: readonly string[] = ['judges', 'subscribers', 'retention'];

export function isRecord(value: unknown): value is Readonly<Record<string, JsonValue>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a rule's targets include a queue: then its retention has a queue line, 7 days unless said. */
export function hasQueue(targets: JsonValue | undefined): boolean {
  return Array.isArray(targets) && targets.some((target) => isRecord(target) && target.kind === 'queue');
}

/** A whole number the text can write: 0 or more, and safe. */
export function isCount(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === 'string');
}

/** Whether `value` has only keys from `allowed` and every key in `required`. */
export function hasKeys(
  value: Readonly<Record<string, unknown>>,
  required: readonly string[],
  optional: readonly string[] = [],
): boolean {
  const keys = Object.keys(value);
  return (
    required.every((key) => Object.hasOwn(value, key)) &&
    keys.every((key) => required.includes(key) || optional.includes(key))
  );
}

/** A name, bare when it is one word the grammar does not use, and quoted JSON text otherwise. */
export function formatName(value: string): string {
  return WORD_CHARACTERS.test(value) && !NAME_RESERVED.has(value) ? value : JSON.stringify(value);
}

/** Names joined the way the text lists them: `a`, `a and b`, `a and b and c`. */
export function formatNames(values: readonly string[]): string {
  return values.map(formatName).join(' and ');
}

const DOTTED_POINTER = /^(\/[A-Za-z0-9_]+)+$/;
const BARE_POINTER = /^\/[A-Za-z0-9_./@:+~-]*$/;

/** Whether the text can write `value` as a field: a JSON Pointer, the empty one included. */
export function isFieldText(value: unknown): value is string {
  return typeof value === 'string' && (value === '' || value.startsWith('/'));
}

/** A field: `from.address` when every token is a plain word, else the pointer itself, bare or quoted. */
export function formatField(pointer: string): string {
  if (DOTTED_POINTER.test(pointer)) {
    const dotted = pointer.slice(1).split('/').join('.');
    if (!FIELD_RESERVED.has(dotted)) return dotted;
  }
  return BARE_POINTER.test(pointer) ? pointer : JSON.stringify(pointer);
}

/** A pointer's tokens, unescaped: the path a mapping item keeps a field at when it has no `as`. */
export function pointerTokens(pointer: string): readonly string[] {
  if (pointer === '') return [];
  return pointer
    .slice(1)
    .split('/')
    .map((token) => token.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/** A top-level field's pointer, for `raw`: `/retention`. */
export function fieldPointer(field: string): string {
  const pointer = `/${field.replaceAll('~', '~0').replaceAll('/', '~1')}`;
  return BARE_POINTER.test(pointer) ? pointer : JSON.stringify(pointer);
}

/** A duration in milliseconds, in the largest unit that divides it: `7 days`, `1 hour`, `1500 milliseconds`. */
export function formatDuration(milliseconds: number): string {
  for (const [singular, plural, size] of DURATION_UNITS) {
    if (milliseconds >= size && milliseconds % size === 0) {
      const count = milliseconds / size;
      return `${count} ${count === 1 ? singular : plural}`;
    }
  }
  return `${milliseconds} milliseconds`;
}

/** A plain JSON number as the text writes it. */
export function formatNumber(value: number): string {
  return JSON.stringify(value);
}

/** The edit distance between two words, with a swap of two neighbours counting as one edit, for suggestions. */
export function distance(left: string, right: string): number {
  const rows: number[][] = Array.from({ length: left.length + 1 }, (_, row) =>
    Array.from({ length: right.length + 1 }, (_, column) => (row === 0 ? column : column === 0 ? row : 0)),
  );
  const at = (row: number, column: number) => (rows[row] as number[])[column] as number;
  for (let row = 1; row <= left.length; row += 1) {
    for (let column = 1; column <= right.length; column += 1) {
      const cost = left[row - 1] === right[column - 1] ? 0 : 1;
      let best = Math.min(at(row - 1, column) + 1, at(row, column - 1) + 1, at(row - 1, column - 1) + cost);
      if (row > 1 && column > 1 && left[row - 1] === right[column - 2] && left[row - 2] === right[column - 1])
        best = Math.min(best, at(row - 2, column - 2) + 1);
      (rows[row] as number[])[column] = best;
    }
  }
  return at(left.length, right.length);
}

/** Words in a sentence: `a`, `a and b`, `a, b and c`. */
export function series(words: readonly string[], last: 'and' | 'or'): string {
  return words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} ${last} ${words.at(-1)}`;
}

/**
 * The phrase among `phrases` that `word` is a typo of, by the phrase's first word or by the whole phrase without its
 * spaces (`atmost` for `at most`), when it is close enough to be one.
 */
export function suggestion(word: string, phrases: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const phrase of phrases) {
    const found = Math.min(distance(word, phrase.split(' ')[0] as string), distance(word, phrase.replaceAll(' ', '')));
    if (found < bestDistance) {
      best = phrase;
      bestDistance = found;
    }
  }
  return best !== undefined && bestDistance <= Math.max(1, Math.floor(word.length / 3)) ? best : undefined;
}
