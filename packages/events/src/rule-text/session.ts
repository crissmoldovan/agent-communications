/**
 * The agent-session target in the rule text (0.33.0 design §3.5, §3.6), as the prototype draws it:
 *
 * ```
 *   session triage, version 1, working in /example/home/acme
 *     if none start with claude-code
 *     if busy wait
 *     give
 *       fields from.address, subject
 *       text "Check the invoice against Stripe before replying."
 *       written by anthropic/claude-sonnet-4.5 via openrouter, asking "Say in one line what the sender wants.", from subject
 *       file /example/home/acme/billing/HOW-WE-INVOICE.md
 *     instruction "Reply to the sender with what you found."
 * ```
 *
 * The printer and the parser for it live here, beside `parse.ts` and `print.ts`, which call them.
 */
import { canonicalJson, type JsonValue } from '../json.ts';
import { Cursor, type TextLine } from './lines.ts';
import { formatField, formatName, hasKeys, isFieldText, isRecord, isStringArray } from './vocabulary.ts';

type Record_ = Record<string, JsonValue>;

/** A provider's word in the text, and back: the prototype's `claude-code` is the relay's `claude`. */
const PROVIDER_WORDS: Readonly<Record<string, string>> = { claude: 'claude-code', codex: 'codex' };
const PROVIDERS_BY_WORD: Readonly<Record<string, string>> = { 'claude-code': 'claude', codex: 'codex' };

const TARGET_FIELDS = ['targetId', 'version', 'kind', 'find', 'ifNone', 'provider', 'mode', 'ifBusy', 'context'];

/** The values the parser fills when the text says nothing of them; the printer leaves out exactly these. */
const DEFAULTS = { ifNone: 'queue-only', ifBusy: 'queue', mode: 'manual' } as const;

const fields = (pointers: readonly string[]) => pointers.map(formatField).join(', ');

/** One context part's line under `give`, or `raw <JSON>` when the readable form has no words for it. */
function partLine(part: JsonValue): string {
  const raw = `      raw ${canonicalJson(part)}`;
  if (!isRecord(part)) return raw;
  if (hasKeys(part, ['text']) && typeof part.text === 'string') return `      text ${JSON.stringify(part.text)}`;
  if (hasKeys(part, ['fields']) && isStringArray(part.fields) && part.fields.every(isFieldText))
    return `      fields ${fields(part.fields)}`;
  if (hasKeys(part, ['file']) && typeof part.file === 'string') return `      file ${formatName(part.file)}`;
  if (hasKeys(part, ['generate']) && isRecord(part.generate)) {
    const generate = part.generate;
    if (!hasKeys(generate, ['provider', 'model', 'instruction', 'from'])) return raw;
    const { provider, model, instruction, from } = generate;
    if (typeof provider !== 'string' || typeof model !== 'string' || typeof instruction !== 'string') return raw;
    if (!isStringArray(from) || !from.every(isFieldText)) return raw;
    return `      written by ${formatName(model)} via ${formatName(provider)}, asking ${JSON.stringify(instruction)}, from ${fields(from)}`;
  }
  return raw;
}

/** A session target's lines at levels 1 to 3, or undefined when its shape is one the readable form cannot say. */
export function sessionTargetLines(target: Readonly<Record<string, JsonValue>>): string[] | undefined {
  if (!hasKeys(target, TARGET_FIELDS, ['instruction'])) return undefined;
  const { find, ifNone, provider, mode, ifBusy, context, instruction } = target;
  if (typeof provider !== 'string' || !Object.hasOwn(PROVIDER_WORDS, provider)) return undefined;
  if (typeof ifNone !== 'string' || typeof ifBusy !== 'string' || typeof mode !== 'string') return undefined;
  if (!Array.isArray(context)) return undefined;
  if (instruction !== undefined && typeof instruction !== 'string') return undefined;
  if (!isRecord(find)) return undefined;
  let where: string;
  if (hasKeys(find, ['folder']) && typeof find.folder === 'string') where = `working in ${formatName(find.folder)}`;
  else if (hasKeys(find, ['lane']) && typeof find.lane === 'string') where = `in lane ${formatName(find.lane)}`;
  else return undefined;
  if (!['start', 'queue-only'].includes(ifNone) || !['queue', 'queue-only'].includes(ifBusy)) return undefined;
  const word = PROVIDER_WORDS[provider] as string;
  const starts = ifNone === 'start';
  // A folder's session says what happens when there is none; a lane's is the lane's window, so only a start is news.
  const none = starts
    ? [`    if none start with ${word}`]
    : Object.hasOwn(find, 'folder')
      ? ['    if none leave it in the queue']
      : [];
  return [
    `  session ${formatName(target.targetId as string)}, version ${target.version}, ${where}${starts ? '' : `, with ${word}`}`,
    ...none,
    `    if busy ${ifBusy === 'queue' ? 'wait' : 'leave it in the queue'}`,
    ...(mode === DEFAULTS.mode ? [] : [`    mode ${formatName(mode)}`]),
    ...(context.length === 0 ? [] : ['    give', ...context.map(partLine)]),
    ...(instruction === undefined ? [] : [`    instruction ${JSON.stringify(instruction)}`]),
  ];
}

/** What the session parser borrows from `parse.ts`, passed in so the two modules do not import each other. */
export interface SessionParseHelpers {
  readonly targetHead: (cursor: Cursor) => Record_;
  readonly clauses: (
    cursor: Cursor,
    what: string,
    readers: Readonly<Record<string, readonly [phrase: string, read: () => void]>>,
  ) => void;
  readonly block: (
    line: TextLine,
    what: string,
    readers: readonly (readonly [
      words: readonly string[],
      read: (cursor: Cursor, child: TextLine) => void,
      takesLines?: 'takes lines',
    ])[],
  ) => void;
  readonly field: (cursor: Cursor, what: string) => string;
  readonly noChildren: (line: TextLine, what: string) => void;
}

function providerWord(cursor: Cursor): string {
  const at = cursor.mark();
  const word = cursor.name('the provider');
  const provider = PROVIDERS_BY_WORD[word];
  if (provider === undefined)
    return cursor.fail(`a session's provider is claude-code or codex; found ${JSON.stringify(word)}`, at);
  return provider;
}

function fieldList(cursor: Cursor, helpers: SessionParseHelpers, what: string): string[] {
  const found = [helpers.field(cursor, what)];
  while (cursor.comma()) found.push(helpers.field(cursor, what));
  return found;
}

/** One line under `give`: a context part. */
function contextPart(child: TextLine, cursor: Cursor, helpers: SessionParseHelpers): JsonValue {
  const at = cursor.mark();
  helpers.noChildren(child, 'a context part');
  if (cursor.take('raw')) {
    const value = cursor.json('the raw context part');
    cursor.expectEnd('the raw context part');
    return value;
  }
  if (cursor.take('text')) {
    const text = cursor.string('the text');
    cursor.expectEnd('the text');
    return { text };
  }
  if (cursor.take('fields')) {
    const pointers = fieldList(cursor, helpers, 'a field');
    cursor.expectEnd('the fields');
    return { fields: pointers };
  }
  if (cursor.take('file')) {
    const file = cursor.name('the file');
    cursor.expectEnd('the file');
    return { file };
  }
  if (cursor.take('written', 'by')) {
    const model = cursor.name('the model');
    cursor.expect(['via'], '"via <provider>" after the model');
    const provider = cursor.name('the provider');
    cursor.expect([',', 'asking'], '", asking "<instruction>"" after the provider');
    const instruction = cursor.string('what the model is asked');
    cursor.expect([',', 'from'], '", from <field>, <field>" after what the model is asked');
    const from = fieldList(cursor, helpers, 'a field the model reads');
    cursor.expectEnd('the fields the model reads');
    return { generate: { provider, model, instruction, from } };
  }
  return cursor.fail(`a context part is fields, text, written by, file or raw; found ${cursor.describeNext()}`, at);
}

/** The session target after its keyword, with the lines indented under it. */
export function parseSessionTarget(cursor: Cursor, line: TextLine, helpers: SessionParseHelpers): Record_ {
  const target: Record_ = { ...helpers.targetHead(cursor), kind: 'session' };
  let provider: string | undefined;
  helpers.clauses(cursor, 'a session', {
    working: [
      'working in <folder>',
      () => {
        const at = cursor.mark();
        if (Object.hasOwn(target, 'find')) cursor.fail('a session is found by its folder or by a lane, not both', at);
        cursor.expect(['working', 'in'], '"working in <folder>"');
        target.find = { folder: cursor.name('the folder') };
      },
    ],
    in: [
      'in lane <name>',
      () => {
        const at = cursor.mark();
        if (Object.hasOwn(target, 'find')) cursor.fail('a session is found by its folder or by a lane, not both', at);
        cursor.expect(['in', 'lane'], '"in lane <name>"');
        target.find = { lane: cursor.name('the lane') };
      },
    ],
    with: [
      'with <provider>',
      () => {
        const at = cursor.mark();
        cursor.take('with');
        if (provider !== undefined) cursor.fail('a session names its provider once', at);
        provider = providerWord(cursor);
      },
    ],
  });
  if (!Object.hasOwn(target, 'find'))
    cursor.fail('a session says where it is found: working in <folder>, or in lane <name>', cursor.mark());
  let context: JsonValue[] = [];
  helpers.block(line, 'a session', [
    [
      ['if', 'none'],
      (inner) => {
        if (inner.take('leave', 'it', 'in', 'the', 'queue')) {
          target.ifNone = 'queue-only';
          return;
        }
        inner.expect(['start', 'with'], '"start with <provider>" or "leave it in the queue" after if none');
        const at = inner.mark();
        const named = providerWord(inner);
        if (provider !== undefined) inner.fail('a session names its provider once', at);
        provider = named;
        target.ifNone = 'start';
      },
    ],
    [
      ['if', 'busy'],
      (inner) => {
        if (inner.take('wait')) target.ifBusy = 'queue';
        else if (inner.take('leave', 'it', 'in', 'the', 'queue')) target.ifBusy = 'queue-only';
        else inner.fail(`if busy says wait or leave it in the queue; found ${inner.describeNext()}`, inner.mark());
      },
    ],
    [
      ['mode'],
      (inner) => {
        target.mode = inner.name('the mode');
      },
    ],
    [
      ['give'],
      (_inner, child) => {
        if (child.children.length === 0)
          new Cursor(child).fail('give needs its context parts on the lines indented under it');
        context = child.children.map((part) => contextPart(part, new Cursor(part), helpers));
      },
      'takes lines',
    ],
    [
      ['instruction'],
      (inner) => {
        target.instruction = inner.string('the instruction');
      },
    ],
  ]);
  if (provider === undefined)
    cursor.fail(
      'a session names its provider: "if none start with claude-code", or ", with claude-code" after its folder',
      0,
    );
  return {
    ...target,
    ifNone: target.ifNone ?? DEFAULTS.ifNone,
    provider: provider as string,
    mode: target.mode ?? DEFAULTS.mode,
    ifBusy: target.ifBusy ?? DEFAULTS.ifBusy,
    context,
  };
}
