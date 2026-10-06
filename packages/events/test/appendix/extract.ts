/**
 * The Appendix A extractor (events phase A plan, Task 10): every normative constraint of A.1–A.7, read by machine from
 * the spec's own text.
 *
 * It is written from A.1's notation rules and nothing else: it imports nothing from the library, and in particular
 * nothing from `src/schema`, so the definitions (Task 11) and the hand transcription are each held to a reading that
 * shares no code with them. What it reads:
 *
 * - A.1's notation rules are its grammar. Each is quoted below and must still appear verbatim in A.1, so a change to
 *   the notation fails the test rather than silently changing what the extractor does.
 * - The `ts` blocks of A.1–A.7: aliases (`type X = string; // pattern …`), string-literal unions, object types,
 *   `CommonEventV1<…>` and `GmailMessageEventV1<T>`, and every property with its `?`, `| null`, `[]` and comment.
 * - Trailing comments, against a closed vocabulary that maps mechanically. Any other comment text is reported until
 *   an entry of the prose-rule file covers it ("unaccounted constraint comment").
 * - A.5's fenced JSON fragment (`dependentRequired` and the body's `maxLength`).
 * - The five metadata lists, fenced or inline, read as JSON once the notation is quoted.
 *
 * What no machine can map — cross-field rules, `subject` and `dedupeKey`, and adapter behaviour — is the prose-rule
 * file's (`test/fixtures/appendix-prose-rules.json`): each entry quotes the spec verbatim and says what it becomes.
 * `applyProseRules` adds those to the extraction; `checkProseRules` holds the file to the spec.
 */
import {
  type Branch,
  type Descriptor,
  type FieldRecord,
  type Invariant,
  type Json,
  type Kind,
  type Metadata,
  PATTERN_RULES,
  type Pattern,
  POINTER_RULES,
  patternPath,
  type RecordSet,
  type RootGrammar,
  show,
  stable,
  step,
  type Transcription,
} from './records.ts';

/** Collapses every run of whitespace to one space, as every verbatim comparison here does. */
export function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A.1's notation rules, quoted. Each must appear verbatim (whitespace-normalised) in its section. */
export const GRAMMAR: readonly { id: string; section: string; quote: string }[] = [
  { id: 'mechanical', section: 'A.1', quote: 'The notation below maps mechanically to JSON Schema 2020-12:' },
  {
    id: 'strict-objects',
    section: 'A.1',
    quote: 'every listed object is strict (`additionalProperties: false`) at every nesting level;',
  },
  {
    id: 'required-unless-question-mark',
    section: 'A.1',
    quote:
      'every property is required unless its name ends in `?`; an optional property, when present, is never implicitly nullable;',
  },
  {
    id: 'only-nullable-form',
    section: 'A.1',
    quote: '`T | null` is the only nullable form; arrays and their elements are non-null unless shown otherwise;',
  },
  {
    id: 'integer',
    section: 'A.1',
    quote: '`integer(minimum: 0)` is a JSON number with `multipleOf: 1` and the stated minimum;',
  },
  {
    id: 'formats',
    section: 'A.1',
    quote:
      "`date-time`, `email`, `uri` and `uuid` use their JSON Schema named string formats; `domain` is the catalogue's custom semantic-format annotation for an IDNA domain string. Email and domain values also obey D5's canonicalisation rules; and",
  },
  {
    id: 'code-point-lengths',
    section: 'A.1',
    quote:
      "every JSON Schema `minLength`/`maxLength`, including A.5's body limit, counts Unicode code points as JSON Schema 2020-12 requires, not ECMAScript UTF-16 code units ([JSON Schema validation §6.3.1](https://json-schema.org/draft/2020-12/json-schema-validation#section-6.3.1)); and",
  },
  {
    id: 'non-empty-string',
    section: 'A.1',
    quote: '`NonEmptyString` is a JSON string with `minLength: 1`; plain `string` may be empty.',
  },
  {
    id: 'array-order',
    section: 'A.1',
    quote: 'Array order is retained unless this appendix says the array is canonical-sorted.',
  },
  {
    id: 'root',
    section: 'A.1',
    quote:
      'Every generated source schema has `$schema: "https://json-schema.org/draft/2020-12/schema"` and exact `$id: "urn:agentcomms:schema:source:<catalogue-type>:v1"` (for example `urn:agentcomms:schema:source:gmail.message.received:v1`). It has one closed top-level object, flattens the common fields and type body into that object, and lists every non-optional property in `required`.',
  },
  {
    id: 'formats-prefix',
    section: 'A.1',
    quote:
      'For all seven definitions the first two `formats` entries are exactly `{pattern:["occurredAt"],format:"date-time"}` and `{pattern:["observedAt"],format:"date-time"}`. The per-type lists below are complete and include those entries so there is no implicit metadata.',
  },
  {
    id: 'fragment',
    section: 'A.5',
    quote:
      "In addition to A.1's ordinary optional-property translation, the generated A.5 JSON Schema contains these exact keywords (shown as the relevant fragments):",
  },
];

/** The named formats of A.1's rule, and the custom `domain`. */
const FORMATS: readonly string[] = ['date-time', 'email', 'uri', 'uuid', 'domain'];

/** The five metadata lists of D3, in their order. */
const METADATA: readonly (keyof Metadata)[] = ['untrusted', 'content', 'addresses', 'handles', 'formats'];

/** The closed list of words that make a sentence or comment constraint-bearing (Task 10's coverage sweep). */
export const SWEEP_WORDS: readonly string[] = [
  'must',
  'may not',
  'only',
  'exactly',
  'at least',
  'non-empty',
  'equals',
  'same',
  '!==',
  'duplicate',
  'sorted',
  'present',
  'absent',
  'required',
  'never',
  'skipped',
  'identical',
  'length',
];

/** Whether text holds a sweep word: case-insensitively, at the start of a word, so `presentation` counts too. */
export function constraintBearing(text: string): boolean {
  return SWEEP_WORDS.some((word) => {
    if (!/^[A-Za-z]/.test(word)) return text.includes(word);
    return new RegExp(`(?<![A-Za-z])${word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'i').test(text);
  });
}

export interface Section {
  id: string;
  heading: string;
  /** The section's whole text, code blocks included, whitespace-normalised: what quotes are found in. */
  text: string;
  /** The event types the section defines. */
  types: string[];
}

/** A sentence of prose, or a trailing comment, that the sweep may need covered. */
export interface Unit {
  section: string;
  types: readonly string[];
  text: string;
  /** For a comment: the declaration and the member it trails. */
  where?: string;
}

export interface CommentUnit extends Unit {
  where: string;
  /** Whether every clause is in the closed vocabulary. */
  recognised: boolean;
}

export interface ExtractedType {
  type: string;
  section: string;
  records: Record<string, FieldRecord>;
  metadata: Metadata;
}

export interface Extraction {
  sections: Section[];
  grammar: RootGrammar;
  types: ExtractedType[];
  /** Each non-generic alias of the notation, resolved. */
  aliases: Record<string, FieldRecord>;
  comments: CommentUnit[];
  sentences: Unit[];
}

// ---------------------------------------------------------------------------------------------------------------------
// The spec's text: Appendix A, its sections, their code blocks and their prose.

interface Line {
  text: string;
  number: number;
}

interface Block {
  lang: string;
  lines: Line[];
}

interface RawSection {
  id: string;
  heading: string;
  lines: Line[];
  code: Block[];
  prose: string[];
}

function sectionsOf(spec: string): RawSection[] {
  const lines = spec.replace(/\r\n/g, '\n').split('\n');
  const start = lines.findIndex((line) => line.startsWith('## Appendix A'));
  if (start < 0) throw new Error('the spec has no "## Appendix A" heading');
  let end = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  if (end < 0) end = lines.length;
  const headings: number[] = [];
  for (let index = start + 1; index < end; index++) if (lines[index]?.startsWith('### ')) headings.push(index);
  const sections: RawSection[] = [];
  for (let n = 1; n <= 7; n++) {
    const id = `A.${n}`;
    const found = headings.filter((index) => lines[index]?.startsWith(`### ${id} `));
    if (found.length !== 1) throw new Error(`Appendix A has ${found.length} headings starting "### ${id} "`);
    const first = found[0] as number;
    const next = headings.find((index) => index > first) ?? end;
    const body = lines.slice(first + 1, next).map((text, offset) => ({ text, number: first + 2 + offset }));
    sections.push({ id, heading: lines[first] as string, lines: body, ...blocksOf(body) });
  }
  const order = sections.map((section) => lines.indexOf(section.heading));
  if (stable(order) !== stable([...order].sort((a, b) => a - b))) throw new Error('A.1–A.7 are out of order');
  return sections;
}

/** A section's fenced code blocks, and its prose split into paragraphs and list items. */
function blocksOf(lines: Line[]): { code: Block[]; prose: string[] } {
  const code: Block[] = [];
  const prose: string[] = [];
  let paragraph: string[] = [];
  const flush = (): void => {
    if (paragraph.length > 0) prose.push(normalise(paragraph.join(' ')));
    paragraph = [];
  };
  let fence: Block | undefined;
  for (const line of lines) {
    const open = /^```(\w*)\s*$/.exec(line.text);
    if (fence) {
      if (/^```\s*$/.test(line.text)) {
        code.push(fence);
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (open) {
      flush();
      fence = { lang: open[1] ?? '', lines: [] };
      continue;
    }
    if (line.text.trim() === '') {
      flush();
      continue;
    }
    if (/^\s*- /.test(line.text)) {
      flush();
      paragraph.push(line.text.replace(/^\s*- /, ''));
      continue;
    }
    paragraph.push(line.text);
  }
  if (fence) throw new Error('an unclosed code fence in Appendix A');
  flush();
  return { code, prose };
}

/** Prose split into sentences: after `.`, `?` or `!` and whitespace, where the next sentence starts. */
export function sentencesOf(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.?!])\s+(?=[A-Z`*(“"[])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

// ---------------------------------------------------------------------------------------------------------------------
// The notation: a tokenizer and parser for the TypeScript subset A.1–A.7 write.

interface Token {
  kind: 'ident' | 'string' | 'number' | 'punct' | 'end';
  value: string;
  line: number;
}

/** A line's code and its trailing `//` comment, outside string literals. */
function splitComment(text: string): { code: string; comment?: string } {
  let quote: string | undefined;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quote) {
      if (char === quote) quote = undefined;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (char === '/' && text[index + 1] === '/') {
      return { code: text.slice(0, index), comment: normalise(text.slice(index + 2)) };
    }
  }
  return { code: text };
}

interface Lexed {
  tokens: Token[];
  /**
   * Comments by the line they trail. A comment-only line continues the comment on the line above, and is kept as the spec
   * writes it, `//` included, so a verbatim quote of the lines covers it.
   */
  comments: Map<number, string>;
}

function lex(block: Block, where: string): Lexed {
  const tokens: Token[] = [];
  const comments = new Map<number, string>();
  let lastComment: { line: number; owner: number } | undefined;
  for (const { text, number } of block.lines) {
    const { code, comment } = splitComment(text);
    if (comment !== undefined) {
      if (code.trim() === '') {
        if (!lastComment || lastComment.line !== number - 1) {
          throw new Error(`${where}, line ${number}: a comment on a line of its own trails nothing: "${comment}"`);
        }
        comments.set(lastComment.owner, `${comments.get(lastComment.owner)} // ${comment}`);
        lastComment = { line: number, owner: lastComment.owner };
      } else {
        comments.set(number, comment);
        lastComment = { line: number, owner: number };
      }
    } else {
      lastComment = undefined;
    }
    const pattern = /\s+|([A-Za-z_$][A-Za-z0-9_$]*)|(-?\d+)|'([^']*)'|"([^"]*)"|([{}[\]()<>;:,|&?=])/y;
    let index = 0;
    while (index < code.length) {
      pattern.lastIndex = index;
      const match = pattern.exec(code);
      if (!match) throw new Error(`${where}, line ${number}: cannot read "${code.slice(index)}"`);
      index = pattern.lastIndex;
      if (match[1] !== undefined) tokens.push({ kind: 'ident', value: match[1], line: number });
      else if (match[2] !== undefined) tokens.push({ kind: 'number', value: match[2], line: number });
      else if (match[3] !== undefined) tokens.push({ kind: 'string', value: match[3], line: number });
      else if (match[4] !== undefined) tokens.push({ kind: 'string', value: match[4], line: number });
      else if (match[5] !== undefined) tokens.push({ kind: 'punct', value: match[5], line: number });
    }
  }
  tokens.push({ kind: 'end', value: '', line: block.lines.at(-1)?.number ?? 0 });
  return { tokens, comments };
}

type TypeAst =
  | { t: 'string' | 'boolean' | 'null' }
  | { t: 'integer'; minimum: number }
  | { t: 'literal'; value: string | number | boolean }
  | { t: 'ref'; name: string; args: TypeAst[] }
  | { t: 'object'; members: Member[] }
  | { t: 'array'; of: TypeAst }
  | { t: 'union'; of: TypeAst[] }
  | { t: 'intersection'; of: TypeAst[] };

interface Member {
  name: string;
  optional: boolean;
  type: TypeAst;
  comment?: string;
  /** The member's dotted name inside its declaration, for messages. */
  where: string;
}

interface Declaration {
  name: string;
  section: string;
  params: { name: string; constraint?: TypeAst }[];
  type: TypeAst;
  comment?: string;
}

interface Assignment {
  name: string;
  value: Json;
}

/** A recursive-descent reader of one `ts` block: `type` declarations and metadata assignments. */
function parseBlock(block: Block, section: string): { declarations: Declaration[]; assignments: Assignment[] } {
  const where = `${section}'s code`;
  const { tokens, comments } = lex(block, where);
  const used = new Set<number>();
  let position = 0;
  const peek = (offset = 0): Token => tokens[Math.min(position + offset, tokens.length - 1)] as Token;
  const next = (): Token => {
    const token = peek();
    position = Math.min(position + 1, tokens.length - 1);
    return token;
  };
  const fail = (message: string): never => {
    throw new Error(`${where}, line ${peek().line}: ${message} (at "${peek().value}")`);
  };
  const is = (value: string, offset = 0): boolean => peek(offset).kind === 'punct' && peek(offset).value === value;
  const expect = (value: string): Token => (is(value) ? next() : fail(`expected "${value}"`));
  const identifier = (): string => (peek().kind === 'ident' ? next().value : fail('expected a name'));
  const commentAt = (line: number): string | undefined => {
    const comment = comments.get(line);
    if (comment !== undefined) used.add(line);
    return comment;
  };

  // Each reader takes `owner`: the dotted member name through which a nested object's members are named.
  const union = (owner: string): TypeAst => {
    if (is('|')) next();
    const of = [intersection(owner)];
    while (is('|')) {
      next();
      of.push(intersection(owner));
    }
    return of.length === 1 ? (of[0] as TypeAst) : { t: 'union', of };
  };
  const intersection = (owner: string): TypeAst => {
    const of = [postfix(owner)];
    while (is('&')) {
      next();
      of.push(postfix(owner));
    }
    return of.length === 1 ? (of[0] as TypeAst) : { t: 'intersection', of };
  };
  const postfix = (owner: string): TypeAst => {
    let type = primary(owner);
    while (is('[') && is(']', 1)) {
      next();
      next();
      type = { t: 'array', of: type };
    }
    return type;
  };
  const members = (owner: string): Member[] => {
    expect('{');
    const list: Member[] = [];
    while (!is('}')) {
      const name = identifier();
      const optional = is('?');
      if (optional) next();
      expect(':');
      const dotted = owner === '' ? name : `${owner}.${name}`;
      const type = union(dotted);
      const comment = commentAt(expect(';').line);
      list.push({ name, optional, type, where: dotted, ...(comment === undefined ? {} : { comment }) });
    }
    expect('}');
    return list;
  };
  const primary = (owner: string): TypeAst => {
    if (is('{')) return { t: 'object', members: members(owner) };
    const token = next();
    if (token.kind === 'string') return { t: 'literal', value: token.value };
    if (token.kind === 'number') return { t: 'literal', value: Number(token.value) };
    if (token.kind === 'punct' && token.value === '(') {
      const inner = union(owner);
      expect(')');
      return inner;
    }
    if (token.kind !== 'ident') return fail('expected a type');
    switch (token.value) {
      case 'true':
        return { t: 'literal', value: true };
      case 'false':
        return { t: 'literal', value: false };
      case 'string':
      case 'boolean':
      case 'null':
        return { t: token.value };
      case 'integer': {
        expect('(');
        if (identifier() !== 'minimum') fail('integer(…) names only its minimum');
        expect(':');
        const minimum = next();
        if (minimum.kind !== 'number') fail('expected the minimum');
        expect(')');
        return { t: 'integer', minimum: Number(minimum.value) };
      }
      default: {
        const args: TypeAst[] = [];
        if (is('<')) {
          next();
          args.push(union(owner));
          while (is(',')) {
            next();
            args.push(union(owner));
          }
          expect('>');
        }
        return { t: 'ref', name: token.value, args };
      }
    }
  };

  const literal = (): Json => {
    const token = next();
    if (token.kind === 'string') return token.value;
    if (token.kind === 'number') return Number(token.value);
    if (token.kind === 'ident' && (token.value === 'true' || token.value === 'false')) return token.value === 'true';
    if (token.kind === 'punct' && token.value === '[') {
      const list: Json[] = [];
      while (!is(']')) {
        list.push(literal());
        if (!is(']')) expect(',');
      }
      expect(']');
      return list;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const object: { [key: string]: Json } = {};
      while (!is('}')) {
        const key = peek().kind === 'string' ? next().value : identifier();
        expect(':');
        if (Object.hasOwn(object, key)) fail(`the key ${key} twice`);
        object[key] = literal();
        if (!is('}')) expect(',');
      }
      expect('}');
      return object;
    }
    return fail('expected a value');
  };

  const declarations: Declaration[] = [];
  const assignments: Assignment[] = [];
  while (peek().kind !== 'end') {
    if (peek().kind === 'ident' && peek().value === 'type') {
      next();
      const name = identifier();
      const params: Declaration['params'] = [];
      if (is('<')) {
        next();
        for (;;) {
          const param = identifier();
          let constraint: TypeAst | undefined;
          if (peek().kind === 'ident' && peek().value === 'extends') {
            next();
            constraint = union('');
          }
          params.push(constraint === undefined ? { name: param } : { name: param, constraint });
          if (!is(',')) break;
          next();
        }
        expect('>');
      }
      expect('=');
      const type = union('');
      const comment = commentAt(expect(';').line);
      declarations.push({ name, section, params, type, ...(comment === undefined ? {} : { comment }) });
    } else {
      const name = identifier();
      expect('=');
      const value = literal();
      if (commentAt(expect(';').line) !== undefined) fail(`a comment on the metadata list ${name}`);
      assignments.push({ name, value });
    }
  }
  for (const [line, comment] of comments) {
    if (!used.has(line)) throw new Error(`${where}, line ${line}: a comment trails no declaration: "${comment}"`);
  }
  return { declarations, assignments };
}

/** A metadata literal written inline, as A.3 writes `untrusted = []`. */
function parseAssignment(text: string, section: string): Assignment {
  const { assignments, declarations } = parseBlock({ lang: 'ts', lines: [{ text: `${text};`, number: 0 }] }, section);
  const [assignment] = assignments;
  if (!assignment || assignments.length !== 1 || declarations.length > 0) {
    throw new Error(`${section}: cannot read the inline list "${text}"`);
  }
  return assignment;
}

// ---------------------------------------------------------------------------------------------------------------------
// Trailing comments, against the closed vocabulary.

type Keyword =
  | { key: 'uniqueItems' | 'sortedUtf8' | 'emptyAllowed' }
  | { key: 'format' | 'pattern'; value: string }
  | { key: 'maxLength'; value: number }
  | { key: 'const'; value: Json };

/**
 * The closed comment vocabulary (Task 10), clause by clause. A `format` clause may carry a description after a colon;
 * that description is not vocabulary, so it is left for a prose rule to account for.
 */
const VOCABULARY: readonly { clause: RegExp; keyword: (match: RegExpExecArray) => Keyword | undefined }[] = [
  { clause: /^duplicate-free$/, keyword: () => ({ key: 'uniqueItems' }) },
  { clause: /^(?:raw-UTF-8 sorted|canonical-sorted)$/, keyword: () => ({ key: 'sortedUtf8' }) },
  { clause: /^\[\] is allowed$/, keyword: () => ({ key: 'emptyAllowed' }) },
  { clause: /^pattern (\S+)$/, keyword: (match) => ({ key: 'pattern', value: match[1] as string }) },
  {
    clause: /^format ([a-z-]+)(?:: .+)?$/,
    keyword: (match) =>
      FORMATS.includes(match[1] as string) ? { key: 'format', value: match[1] as string } : undefined,
  },
  {
    clause: /^schema maxLength: (\d+) Unicode code points$/,
    keyword: (match) => ({ key: 'maxLength', value: Number(match[1]) }),
  },
  { clause: /^JSON integer const (-?\d+)$/, keyword: (match) => ({ key: 'const', value: Number(match[1]) }) },
  { clause: /^JSON boolean const (true|false)$/, keyword: (match) => ({ key: 'const', value: match[1] === 'true' }) },
];

/** A comment's mapped clauses, and whatever of it the vocabulary does not map. */
export function readComment(text: string): { keywords: Keyword[]; remainder: string[] } {
  const keywords: Keyword[] = [];
  const remainder: string[] = [];
  const clauses = text
    .split(/;\s*|,\s+|\s*\/\/\s*/)
    .map((part) => part.trim())
    .filter(Boolean);
  for (const clause of clauses) {
    const mapped = VOCABULARY.map((entry) => {
      const match = entry.clause.exec(clause);
      return match ? entry.keyword(match) : undefined;
    }).find((keyword) => keyword !== undefined);
    if (mapped === undefined) {
      remainder.push(clause);
      continue;
    }
    keywords.push(mapped);
    const description = /^format [a-z-]+: (.+)$/.exec(clause)?.[1];
    if (description !== undefined) remainder.push(description);
  }
  return { keywords, remainder };
}

// ---------------------------------------------------------------------------------------------------------------------
// Resolution: the notation's types, as nodes, then as records.

interface Node {
  kind: Kind;
  nullable: boolean;
  const?: Json;
  enum?: string[];
  pattern?: string;
  format?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  multipleOf?: number;
  branches?: Node[];
  items?: Node;
  uniqueItems?: boolean;
  sortedUtf8?: boolean;
  properties?: { name: string; optional: boolean; node: Node }[];
  dependentRequired?: Record<string, string[]>;
}

function substitute(type: TypeAst, env: ReadonlyMap<string, TypeAst>): TypeAst {
  switch (type.t) {
    case 'ref':
      if (type.args.length === 0 && env.has(type.name)) return env.get(type.name) as TypeAst;
      return { t: 'ref', name: type.name, args: type.args.map((arg) => substitute(arg, env)) };
    case 'object':
      return {
        t: 'object',
        members: type.members.map((member) => ({ ...member, type: substitute(member.type, env) })),
      };
    case 'array':
      return { t: 'array', of: substitute(type.of, env) };
    case 'union':
    case 'intersection':
      return { t: type.t, of: type.of.map((part) => substitute(part, env)) };
    default:
      return type;
  }
}

function applyComment(node: Node, comment: string | undefined, where: string): Node {
  if (comment === undefined) return node;
  const target = (kind: Kind, keyword: string): Node => {
    if (node.kind !== kind) throw new Error(`${where}: "${keyword}" in its comment, but it is ${node.kind}`);
    return node;
  };
  for (const keyword of readComment(comment).keywords) {
    switch (keyword.key) {
      case 'uniqueItems':
        target('array', 'duplicate-free').uniqueItems = true;
        break;
      case 'sortedUtf8':
        target('array', 'sorted').sortedUtf8 = true;
        break;
      case 'emptyAllowed':
        target('array', '[] is allowed');
        break;
      case 'format':
      case 'pattern': {
        const string = target('string', keyword.key);
        if (string[keyword.key] !== undefined && string[keyword.key] !== keyword.value) {
          throw new Error(`${where}: two ${keyword.key}s`);
        }
        string[keyword.key] = keyword.value;
        break;
      }
      case 'maxLength':
        target('string', 'maxLength').maxLength = keyword.value;
        break;
      case 'const':
        if (node.kind !== 'const' || node.const !== keyword.value) {
          throw new Error(`${where}: its comment says const ${stable(keyword.value)}, the notation ${node.kind}`);
        }
        break;
    }
  }
  return node;
}

function resolver(declarations: ReadonlyMap<string, Declaration>): (type: TypeAst, where: string) => Node {
  const resolve = (type: TypeAst, where: string): Node => {
    switch (type.t) {
      case 'string':
      case 'boolean':
        return { kind: type.t, nullable: false };
      case 'null':
        throw new Error(`${where}: null outside a union`);
      case 'integer':
        // A.1: `integer(minimum: 0)` is a JSON number with `multipleOf: 1` and the stated minimum.
        return { kind: 'number', nullable: false, multipleOf: 1, minimum: type.minimum };
      case 'literal':
        return { kind: 'const', nullable: false, const: type.value };
      case 'array':
        return {
          kind: 'array',
          nullable: false,
          items: resolve(type.of, `${where}[]`),
          uniqueItems: false,
          sortedUtf8: false,
        };
      case 'object': {
        const properties: NonNullable<Node['properties']> = [];
        for (const member of type.members) {
          if (properties.some((property) => property.name === member.name)) {
            throw new Error(`${where}: the property ${member.name} twice`);
          }
          const at = `${where}.${member.name}`;
          properties.push({
            name: member.name,
            optional: member.optional,
            node: applyComment(resolve(member.type, at), member.comment, at),
          });
        }
        return { kind: 'object', nullable: false, properties };
      }
      case 'intersection': {
        const properties: NonNullable<Node['properties']> = [];
        for (const part of type.of) {
          const node = resolve(part, where);
          if (node.kind !== 'object' || node.nullable) throw new Error(`${where}: an intersection of non-objects`);
          for (const property of node.properties ?? []) {
            if (properties.some((other) => other.name === property.name)) {
              throw new Error(`${where}: the intersection declares ${property.name} twice`);
            }
            properties.push(property);
          }
        }
        return { kind: 'object', nullable: false, properties };
      }
      case 'union': {
        const nulls = type.of.filter((part) => part.t === 'null');
        const rest = type.of.filter((part) => part.t !== 'null');
        const isText = (part: TypeAst): part is { t: 'literal'; value: string } =>
          part.t === 'literal' && typeof part.value === 'string';
        const literals = rest.filter(isText).map((part) => part.value);
        const others = rest.filter((part) => !isText(part));
        if (nulls.length > 1 || rest.length === 0) throw new Error(`${where}: a union the notation does not map`);
        if (new Set(literals).size !== literals.length) throw new Error(`${where}: a literal twice in a union`);
        let node: Node;
        if (others.length === 0) {
          node = { kind: 'enum', nullable: false, enum: literals };
        } else if (others.length === 1 && literals.length === 0) {
          node = resolve(others[0] as TypeAst, where);
        } else if (others.length === 1 && rest.at(-1) === others[0]) {
          // A union of string literals and one pattern alias, as WhatsAppMessageKindV1 is: anyOf the enum and the
          // pattern (decision 6).
          const other = resolve(others[0] as TypeAst, where);
          const plain =
            other.kind === 'string' &&
            !other.nullable &&
            other.pattern !== undefined &&
            other.format === undefined &&
            other.minLength === undefined &&
            other.maxLength === undefined;
          if (!plain) throw new Error(`${where}: literals in a union with something other than a pattern string`);
          node = {
            kind: 'anyOf',
            nullable: false,
            branches: [{ kind: 'enum', nullable: false, enum: literals }, other],
          };
        } else {
          throw new Error(`${where}: a union the notation does not map`);
        }
        if (nulls.length === 1) {
          if (node.nullable) throw new Error(`${where}: null twice`);
          node.nullable = true;
        }
        return node;
      }
      case 'ref': {
        // A.1: `NonEmptyString` is a JSON string with `minLength: 1`.
        if (type.name === 'NonEmptyString' && type.args.length === 0) {
          return { kind: 'string', nullable: false, minLength: 1 };
        }
        const declaration = declarations.get(type.name);
        if (!declaration)
          throw new Error(`${where}: the notation names ${type.name}, which Appendix A does not define`);
        if (declaration.params.length !== type.args.length) {
          throw new Error(`${where}: ${type.name} takes ${declaration.params.length} type arguments`);
        }
        const env = new Map(declaration.params.map((param, index) => [param.name, type.args[index] as TypeAst]));
        const node = resolve(substitute(declaration.type, env), declaration.name);
        return applyComment(node, declaration.comment, declaration.name);
      }
    }
  };
  return resolve;
}

/** A node's kind and scalar constraints: what a record and an anyOf branch both carry. */
function scalar(node: Node): Branch {
  const branch: Branch = { kind: node.kind };
  if (node.const !== undefined) branch.const = node.const;
  if (node.enum !== undefined) branch.enum = node.enum;
  if (node.pattern !== undefined) branch.pattern = node.pattern;
  if (node.format !== undefined) branch.format = node.format;
  if (node.minLength !== undefined) branch.minLength = node.minLength;
  if (node.maxLength !== undefined) branch.maxLength = node.maxLength;
  if (node.minimum !== undefined) branch.minimum = node.minimum;
  if (node.multipleOf !== undefined) branch.multipleOf = node.multipleOf;
  return branch;
}

function toBranch(node: Node, where: string): Branch {
  if (node.nullable || node.kind === 'object' || node.kind === 'array' || node.kind === 'anyOf') {
    throw new Error(`${where}: an anyOf branch that is not a non-null scalar`);
  }
  return scalar(node);
}

function toRecord(node: Node, optional: boolean, where: string): FieldRecord {
  const record: FieldRecord = { optional, nullable: node.nullable, ...scalar(node) };
  switch (node.kind) {
    case 'anyOf':
      record.branches = (node.branches ?? []).map((branch) => toBranch(branch, where));
      break;
    case 'array':
      record.uniqueItems = node.uniqueItems === true;
      record.sortedUtf8 = node.sortedUtf8 === true;
      break;
    case 'object':
      // A.1: every listed object is strict, at every nesting level.
      record.additionalProperties = false;
      if (node.dependentRequired !== undefined) record.dependentRequired = node.dependentRequired;
      break;
    default:
      break;
  }
  return record;
}

function flatten(node: Node, path: string, optional: boolean, out: Record<string, FieldRecord>, where: string): void {
  out[path] = toRecord(node, optional, `${where} ${show(path)}`);
  for (const property of node.properties ?? [])
    flatten(property.node, path + step(property.name), property.optional, out, where);
  if (node.items) flatten(node.items, `${path}/*`, false, out, where);
}

function reaches(node: Node, pattern: Pattern): boolean {
  let current: Node | undefined = node;
  for (const token of pattern) {
    if (!current) return false;
    if (typeof token === 'string') {
      current =
        current.kind === 'object' ? current.properties?.find((property) => property.name === token)?.node : undefined;
    } else {
      current = current.kind === 'array' ? current.items : undefined;
    }
  }
  return current !== undefined;
}

// ---------------------------------------------------------------------------------------------------------------------
// Metadata.

function isPattern(value: Json): value is Pattern {
  return (
    Array.isArray(value) &&
    value.every(
      (token) =>
        typeof token === 'string' ||
        (token !== null &&
          typeof token === 'object' &&
          !Array.isArray(token) &&
          stable(token) === stable({ any: true })),
    )
  );
}

function metadataOf(lists: ReadonlyMap<string, Json>, section: string): Metadata {
  const shape = (name: string, value: Json, keys: readonly string[]): void => {
    if (!Array.isArray(value)) throw new Error(`${section}: ${name} is not a list`);
    for (const item of value) {
      if (keys.length === 0) {
        if (!isPattern(item)) throw new Error(`${section}: ${name} holds ${stable(item)}, which is not a pattern`);
        continue;
      }
      if (
        item === null ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        stable(Object.keys(item).sort()) !== stable([...keys].sort())
      ) {
        throw new Error(`${section}: ${name} holds ${stable(item)}, not an object of ${keys.join(' and ')}`);
      }
      for (const key of keys) {
        const field = item[key] as Json;
        if (key === 'format' ? !FORMATS.includes(field as string) : !isPattern(field)) {
          throw new Error(`${section}: ${name} holds ${stable(item)}, whose ${key} is not legal`);
        }
      }
    }
  };
  const read = (name: keyof Metadata, keys: readonly string[]): Json => {
    const value = lists.get(name);
    if (value === undefined) throw new Error(`${section} does not give ${name}`);
    shape(name, value, keys);
    return value;
  };
  return {
    untrusted: read('untrusted', []) as Pattern[],
    content: read('content', []) as Pattern[],
    addresses: read('addresses', []) as Pattern[],
    handles: read('handles', ['pattern', 'workspace']) as Metadata['handles'],
    formats: read('formats', ['pattern', 'format']) as Metadata['formats'],
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The extraction.

/** Every constraint A.1–A.7's notation, comments, fragment and metadata state, read from the spec's text. */
export function extractAppendix(spec: string): Extraction {
  const raw = sectionsOf(spec);
  const textOf = new Map(
    raw.map((section) => [section.id, normalise(section.lines.map((line) => line.text).join('\n'))]),
  );

  // The grammar must still be A.1's words.
  for (const rule of GRAMMAR) {
    if (!textOf.get(rule.section)?.includes(normalise(rule.quote))) {
      throw new Error(`the notation rule "${rule.id}" is no longer verbatim in ${rule.section}: "${rule.quote}"`);
    }
  }
  const rootRule = GRAMMAR.find((rule) => rule.id === 'root')?.quote ?? '';
  const schemaUri = /`\$schema: "([^"]+)"`/.exec(rootRule)?.[1];
  const idTemplate = /`\$id: "([^"]+)"`/.exec(rootRule)?.[1];
  if (schemaUri === undefined || idTemplate === undefined) throw new Error('the root rule names no $schema or $id');

  // Every `ts` block: declarations into one namespace, metadata by section.
  const declarations = new Map<string, Declaration>();
  const lists = new Map<string, Map<string, Json>>();
  const list = (section: string, assignment: Assignment): void => {
    if (!(METADATA as readonly string[]).includes(assignment.name)) {
      throw new Error(`${section}: ${assignment.name} is not one of the five metadata lists`);
    }
    const mine = lists.get(section) ?? new Map<string, Json>();
    if (mine.has(assignment.name)) throw new Error(`${section} gives ${assignment.name} twice`);
    mine.set(assignment.name, assignment.value);
    lists.set(section, mine);
  };
  for (const section of raw) {
    for (const block of section.code.filter((code) => code.lang === 'ts')) {
      const parsed = parseBlock(block, section.id);
      for (const declaration of parsed.declarations) {
        if (declarations.has(declaration.name)) throw new Error(`${declaration.name} is declared twice`);
        declarations.set(declaration.name, declaration);
      }
      for (const assignment of parsed.assignments) {
        if (section.id === 'A.1') throw new Error('A.1 gives a metadata list');
        list(section.id, assignment);
      }
    }
    for (const paragraph of section.prose) {
      for (const match of paragraph.matchAll(/`((?:untrusted|content|addresses|handles|formats) = [^`]*)`/g)) {
        list(section.id, parseAssignment(match[1] as string, section.id));
      }
    }
  }
  const resolve = resolver(declarations);

  // The event types: declarations that intersect CommonEventV1, a generic one instantiated per literal of its
  // parameter's constraint.
  const roots: { type: string; section: string; root: Node }[] = [];
  for (const declaration of declarations.values()) {
    if (declaration.section === 'A.1' || declaration.type.t !== 'intersection') continue;
    const common = declaration.type.of.find((part) => part.t === 'ref' && part.name === 'CommonEventV1');
    if (common?.t !== 'ref') continue;
    const first = common.args[0];
    const instances: { literal: string; env: Map<string, TypeAst> }[] = [];
    if (first?.t === 'literal' && typeof first.value === 'string' && declaration.params.length === 0) {
      instances.push({ literal: first.value, env: new Map() });
    } else if (first?.t === 'ref' && declaration.params.length === 1 && declaration.params[0]?.name === first.name) {
      const constraint = declaration.params[0].constraint;
      const literals = constraint?.t === 'union' ? constraint.of : constraint ? [constraint] : [];
      for (const literal of literals) {
        if (literal.t !== 'literal' || typeof literal.value !== 'string') {
          throw new Error(`${declaration.name}: its type parameter is not a union of type literals`);
        }
        instances.push({ literal: literal.value, env: new Map([[first.name, literal]]) });
      }
    } else {
      throw new Error(
        `${declaration.name}: an event type whose CommonEventV1 type is neither a literal nor its parameter`,
      );
    }
    for (const { literal, env } of instances) {
      roots.push({
        type: literal,
        section: declaration.section,
        root: resolve(substitute(declaration.type, env), literal),
      });
    }
  }
  const typesIn = (section: string): string[] =>
    roots.filter((root) => root.section === section).map((root) => root.type);

  // A.5's fragment: the body's maxLength and the bidirectional dependentRequired.
  for (const section of raw) {
    for (const block of section.code.filter((code) => code.lang === 'json')) {
      const fragment = JSON.parse(block.lines.map((line) => line.text).join('\n')) as { [key: string]: Json };
      const { properties, dependentRequired, ...rest } = fragment;
      if (Object.keys(rest).length > 0) throw new Error(`${section.id}'s fragment has ${Object.keys(rest).join(', ')}`);
      for (const { root, type } of roots.filter((entry) => entry.section === section.id)) {
        for (const [name, schema] of Object.entries((properties ?? {}) as { [key: string]: { [key: string]: Json } })) {
          const property = root.properties?.find((candidate) => candidate.name === name);
          if (!property) throw new Error(`${type}: A.5's fragment names ${name}, which the type does not declare`);
          const { type: kind, maxLength, ...others } = schema;
          if (Object.keys(others).length > 0 || kind !== property.node.kind) {
            throw new Error(`${type}: A.5's fragment for ${name} is not what the notation declares`);
          }
          if (maxLength !== undefined) {
            if (property.node.maxLength !== undefined && property.node.maxLength !== maxLength) {
              throw new Error(`${type}: A.5's fragment and the comment give ${name} two maxLengths`);
            }
            property.node.maxLength = maxLength as number;
          }
        }
        if (dependentRequired !== undefined) {
          for (const [name, needs] of Object.entries(dependentRequired as { [key: string]: string[] })) {
            for (const other of [name, ...needs]) {
              if (!root.properties?.some((property) => property.name === other && property.optional)) {
                throw new Error(`${type}: A.5's dependentRequired names ${other}, which is not an optional property`);
              }
            }
          }
          root.dependentRequired = dependentRequired as Record<string, string[]>;
        }
      }
    }
  }

  // The metadata, for every type of each section, with A.1's two leading formats.
  const leading = [
    ...(GRAMMAR.find((rule) => rule.id === 'formats-prefix')?.quote ?? '').matchAll(/`(\{pattern:[^`]+\})`/g),
  ].map((match) => parseAssignment(`formats = ${match[1]}`, 'A.1').value);
  if (leading.length !== 2) throw new Error('A.1 does not give the two leading formats');
  const types: ExtractedType[] = roots.map(({ type, section, root }) => {
    const metadata = metadataOf(lists.get(section) ?? new Map(), section);
    if (stable(metadata.formats.slice(0, 2)) !== stable(leading)) {
      throw new Error(`${type}: its formats do not start with A.1's occurredAt and observedAt entries`);
    }
    const patterns: [string, Pattern][] = [
      ...METADATA.slice(0, 3).flatMap((name) =>
        (metadata[name] as Pattern[]).map((pattern): [string, Pattern] => [name, pattern]),
      ),
      ...metadata.handles.flatMap((handle): [string, Pattern][] => [
        ['handles', handle.pattern],
        ['handles workspace', handle.workspace],
      ]),
      ...metadata.formats.map((format): [string, Pattern] => ['formats', format.pattern]),
    ];
    for (const [name, pattern] of patterns) {
      if (!reaches(root, pattern))
        throw new Error(`${type}: ${name} names ${stable(pattern)}, which the type does not declare`);
    }
    const records: Record<string, FieldRecord> = {};
    flatten(root, '', false, records, type);
    return { type, section, records, metadata };
  });

  // Every non-generic alias, resolved, for the rules that name one.
  const aliases: Record<string, FieldRecord> = {};
  for (const declaration of declarations.values()) {
    if (declaration.params.length > 0) continue;
    aliases[declaration.name] = toRecord(
      resolve({ t: 'ref', name: declaration.name, args: [] }, declaration.name),
      false,
      declaration.name,
    );
  }

  // The units the sweep may need covered: every trailing comment, and every sentence of prose.
  const comments: CommentUnit[] = [];
  const collect = (type: TypeAst, owner: string, section: string): void => {
    switch (type.t) {
      case 'object':
        for (const member of type.members) {
          if (member.comment !== undefined) {
            comments.push({
              section,
              types: typesIn(section),
              text: member.comment,
              where: `${owner}.${member.where}`,
              recognised: readComment(member.comment).remainder.length === 0,
            });
          }
          collect(member.type, owner, section);
        }
        break;
      case 'array':
        collect(type.of, owner, section);
        break;
      case 'union':
      case 'intersection':
        for (const part of type.of) collect(part, owner, section);
        break;
      case 'ref':
        for (const arg of type.args) collect(arg, owner, section);
        break;
      default:
        break;
    }
  };
  for (const declaration of declarations.values()) {
    if (declaration.comment !== undefined) {
      comments.push({
        section: declaration.section,
        types: typesIn(declaration.section),
        text: declaration.comment,
        where: declaration.name,
        recognised: readComment(declaration.comment).remainder.length === 0,
      });
    }
    collect(declaration.type, declaration.name, declaration.section);
  }
  const sentences: Unit[] = raw.flatMap((section) =>
    section.prose.flatMap((paragraph) =>
      sentencesOf(paragraph).map((text) => ({ section: section.id, types: typesIn(section.id), text })),
    ),
  );

  return {
    sections: raw.map((section) => ({
      id: section.id,
      heading: section.heading,
      text: textOf.get(section.id) ?? '',
      types: typesIn(section.id),
    })),
    grammar: { schemaUri, idTemplate },
    types,
    aliases,
    comments,
    sentences,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// The prose rules: what a person read where no machine can.

/** A schema keyword the prose states, at record paths or at one of A.1's aliases. */
export type KeywordRule = { paths: string[] } & { [field: string]: Json };
export type AliasKeywordRule = { alias: string } & { [field: string]: Json };

export type Becomes =
  | { invariant: Invariant }
  | { keyword: KeywordRule | AliasKeywordRule }
  | { subject: Descriptor }
  | { dedupeKey: Descriptor }
  | { informational: string };

export interface ProseRule {
  types: string[];
  quote: string;
  becomes: Becomes;
}

export interface ProseRules {
  description: string;
  rules: ProseRule[];
}

/** The record fields a keyword rule may state. `sortedUtf8` is not one: it is only ever a named invariant. */
const KEYWORD_FIELDS: readonly string[] = [
  'kind',
  'nullable',
  'optional',
  'const',
  'enum',
  'pattern',
  'format',
  'minLength',
  'maxLength',
  'minimum',
  'multipleOf',
  'branches',
  'uniqueItems',
  'additionalProperties',
  'dependentRequired',
];

function covers(quote: string, unit: Unit): boolean {
  return normalise(quote).includes(normalise(unit.text));
}

/** A unit is covered by a quote that contains it, from a rule about one of its section's types (any rule, in A.1). */
function covered(unit: Unit, rules: ProseRules, grammar: boolean): boolean {
  if (grammar && GRAMMAR.some((rule) => rule.section === unit.section && covers(rule.quote, unit))) return true;
  return rules.rules.some(
    (rule) =>
      covers(rule.quote, unit) && (unit.section === 'A.1' || rule.types.some((type) => unit.types.includes(type))),
  );
}

function scope(unit: Unit): string {
  return unit.types.length > 0 ? `${unit.section} (${unit.types.join(', ')})` : unit.section;
}

/** Every comment with text the closed vocabulary does not map, that no prose rule covers. */
export function unaccountedComments(extraction: Extraction, rules: ProseRules): string[] {
  return extraction.comments
    .filter((comment) => !comment.recognised && !covered(comment, rules, false))
    .map((comment) => `unaccounted constraint comment in ${scope(comment)}, ${comment.where}: "${comment.text}"`);
}

/** Every constraint-bearing sentence of A.1–A.7's prose that neither a prose rule nor the grammar covers. */
export function uncoveredSentences(extraction: Extraction, rules: ProseRules): string[] {
  return extraction.sentences
    .filter((sentence) => constraintBearing(sentence.text) && !covered(sentence, rules, true))
    .map((sentence) => `uncovered constraint-bearing sentence in ${scope(sentence)}: "${sentence.text}"`);
}

function becomesKind(becomes: Becomes): string {
  return Object.keys(becomes)[0] ?? '';
}

/** The extraction with every prose rule applied: invariants, descriptors, and keywords the prose states. */
export function applyProseRules(extraction: Extraction, rules: ProseRules): { types: RecordSet[]; problems: string[] } {
  const problems: string[] = [];
  const types = extraction.types.map((extracted): RecordSet => {
    const type = extracted.type;
    const records = structuredClone(extracted.records);
    const mine = rules.rules.filter((rule) => rule.types.includes(type));
    const invariants = mine.flatMap((rule) => ('invariant' in rule.becomes ? [rule.becomes.invariant] : []));
    const subjects = mine.flatMap((rule) => ('subject' in rule.becomes ? [rule.becomes.subject] : []));
    const keys = mine.flatMap((rule) => ('dedupeKey' in rule.becomes ? [rule.becomes.dedupeKey] : []));
    if (subjects.length !== 1)
      problems.push(`${type}: ${subjects.length} prose rules give its subject; exactly one must`);
    if (keys.length !== 1) problems.push(`${type}: ${keys.length} prose rules give its dedupeKey; exactly one must`);

    for (const rule of mine) {
      if (!('keyword' in rule.becomes) || !('paths' in rule.becomes.keyword)) continue;
      const { paths, ...fields } = rule.becomes.keyword as KeywordRule;
      for (const path of paths) {
        const record = records[path] as unknown as Record<string, unknown> | undefined;
        if (!record) {
          problems.push(`${type} ${show(path)}: a keyword rule names a position the type does not declare`);
          continue;
        }
        for (const [field, value] of Object.entries(fields)) {
          const current = record[field];
          if (current === undefined || (field === 'uniqueItems' && current === false)) record[field] = value;
          else if (stable(current) !== stable(value)) {
            problems.push(
              `${type} ${show(path)}: a prose rule says ${field} ${stable(value)}, the notation ${stable(current)}`,
            );
          }
        }
      }
    }

    const position = (pointer: string): boolean => Object.hasOwn(records, pointer);
    for (const invariant of invariants) {
      if ('pattern' in invariant) {
        if (records[patternPath(invariant.pattern)]?.kind !== 'array') {
          problems.push(`${type}: ${stable(invariant)} names no array position`);
        }
      } else {
        for (const pointer of invariant.pointers) {
          if (!position(pointer))
            problems.push(`${type}: ${stable(invariant)} names ${pointer}, which the type does not declare`);
        }
      }
    }
    for (const descriptor of [...subjects, ...keys]) {
      const pointers =
        'pointer' in descriptor
          ? [descriptor.pointer]
          : 'pointers' in descriptor
            ? descriptor.pointers
            : descriptor.canonicalJson.flatMap((part) =>
                typeof part === 'object' && 'pointer' in part ? [part.pointer] : [],
              );
      for (const pointer of pointers) {
        if (!position(pointer))
          problems.push(`${type}: a descriptor names ${pointer}, which the type does not declare`);
      }
    }

    // The named sorted-utf8 invariants are exactly the arrays the comments call sorted.
    const named = new Set(
      invariants.flatMap((invariant) => ('pattern' in invariant ? [patternPath(invariant.pattern)] : [])),
    );
    const commented = new Set(Object.keys(records).filter((path) => records[path]?.sortedUtf8 === true));
    for (const path of named) {
      if (!commented.has(path))
        problems.push(`${type} ${show(path)}: sorted-utf8 is named, but no comment says it is sorted`);
    }
    for (const path of commented) {
      if (!named.has(path))
        problems.push(`${type} ${show(path)}: a comment says it is sorted, but no rule names sorted-utf8`);
    }

    return {
      type,
      records,
      metadata: extracted.metadata,
      invariants,
      subject: subjects[0] ?? { pointer: '(none)' },
      dedupeKey: keys[0] ?? { pointer: '(none)' },
    };
  });

  for (const rule of rules.rules) {
    if (!('keyword' in rule.becomes) || !('alias' in rule.becomes.keyword)) continue;
    const { alias, ...fields } = rule.becomes.keyword as AliasKeywordRule;
    const record = extraction.aliases[alias] as unknown as Record<string, unknown> | undefined;
    if (!record) {
      problems.push(`a keyword rule names the alias ${alias}, which A.1–A.7 do not declare`);
      continue;
    }
    for (const [field, value] of Object.entries(fields)) {
      if (stable(record[field]) !== stable(value)) {
        problems.push(`${alias}: a prose rule says ${field} ${stable(value)}, the notation ${stable(record[field])}`);
      }
    }
  }
  return { types, problems };
}

function descriptorProblem(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  const keys = stable(Object.keys(value).sort());
  const object = value as Record<string, unknown>;
  const strings = (list: unknown): boolean => Array.isArray(list) && list.every((item) => typeof item === 'string');
  if (keys === stable(['pointer']))
    return typeof object.pointer === 'string' ? undefined : 'a pointer that is not a string';
  if (keys === stable(['join', 'pointers'])) {
    return typeof object.join === 'string' && strings(object.pointers) && (object.pointers as string[]).length >= 2
      ? undefined
      : 'a join of fewer than two pointers';
  }
  if (keys === stable(['canonicalJson'])) {
    const parts = object.canonicalJson;
    const part = (item: unknown): boolean =>
      typeof item === 'string' ||
      (item !== null &&
        typeof item === 'object' &&
        (stable(Object.keys(item)) === stable(['pointer']) || stable(Object.keys(item)) === stable(['staging'])) &&
        Object.values(item).every((field) => typeof field === 'string'));
    return Array.isArray(parts) && parts.length > 0 && parts.every(part)
      ? undefined
      : 'a canonical JSON list it cannot read';
  }
  return `keys ${keys}`;
}

function ruleShapeProblem(rule: ProseRule, known: ReadonlySet<string>): string | undefined {
  if (stable(Object.keys(rule).sort()) !== stable(['becomes', 'quote', 'types']))
    return 'its keys are not types, quote and becomes';
  if (!Array.isArray(rule.types) || rule.types.length === 0) return 'it names no type';
  if (new Set(rule.types).size !== rule.types.length) return 'it names a type twice';
  const unknown = rule.types.filter((type) => !known.has(type));
  if (unknown.length > 0) return `it names ${unknown.join(', ')}, not catalogue types`;
  if (typeof rule.quote !== 'string' || normalise(rule.quote) === '') return 'its quote is empty';
  const becomes = rule.becomes as unknown;
  if (becomes === null || typeof becomes !== 'object' || Object.keys(becomes).length !== 1) {
    return '"becomes" is not exactly one of invariant, keyword, subject, dedupeKey and informational';
  }
  const kind = becomesKind(rule.becomes);
  const value = (rule.becomes as Record<string, unknown>)[kind];
  switch (kind) {
    case 'invariant': {
      const invariant = value as Record<string, unknown>;
      const keys = stable(Object.keys(invariant ?? {}).sort());
      if (PATTERN_RULES.includes(invariant?.rule as string)) {
        return keys === stable(['pattern', 'rule']) && isPattern(invariant.pattern as Json)
          ? undefined
          : `${invariant.rule} takes exactly a pattern`;
      }
      if (POINTER_RULES.includes(invariant?.rule as string)) {
        const pointers = invariant.pointers;
        return keys === stable(['pointers', 'rule']) &&
          Array.isArray(pointers) &&
          pointers.length === 2 &&
          pointers.every((pointer) => typeof pointer === 'string')
          ? undefined
          : `${invariant.rule} takes exactly two pointers`;
      }
      return `${stable(invariant?.rule)} is not one of decision 7's invariants`;
    }
    case 'keyword': {
      const keyword = value as Record<string, unknown>;
      const target = ['paths', 'alias'].filter((key) => key in (keyword ?? {}));
      if (target.length !== 1) return 'a keyword rule names exactly one of paths and alias';
      if (
        'paths' in keyword &&
        !(
          Array.isArray(keyword.paths) &&
          keyword.paths.length > 0 &&
          keyword.paths.every((path) => typeof path === 'string')
        )
      ) {
        return 'its paths are not a list of record paths';
      }
      if ('alias' in keyword && typeof keyword.alias !== 'string') return 'its alias is not a name';
      const fields = Object.keys(keyword).filter((key) => key !== 'paths' && key !== 'alias');
      if (fields.length === 0) return 'a keyword rule states no keyword';
      const illegal = fields.filter((field) => !KEYWORD_FIELDS.includes(field));
      return illegal.length > 0 ? `a keyword rule cannot state ${illegal.join(', ')}` : undefined;
    }
    case 'subject':
    case 'dedupeKey': {
      const problem = descriptorProblem(value);
      return problem === undefined ? undefined : `its ${kind} is ${problem}`;
    }
    case 'informational':
      return typeof value === 'string' && value.trim() !== '' ? undefined : 'an informational rule gives no reason';
    default:
      return `"becomes" is ${stable(kind)}`;
  }
}

/** The prose-rule file, held to the spec: verbatim quotes, a well-formed result, the sweep, and one rule per invariant. */
export function checkProseRules(
  extraction: Extraction,
  rules: ProseRules,
  transcription: Transcription,
): { verbatim: string[]; shape: string[]; coverage: string[]; oneToOne: string[] } {
  const known = new Set(extraction.types.map((type) => type.type));
  const sectionOf = new Map(extraction.types.map((type) => [type.type, type.section]));
  const text = new Map(extraction.sections.map((section) => [section.id, section.text]));
  const label = (rule: ProseRule): string => `"${normalise(rule.quote ?? '')}"`;

  const shape: string[] = [];
  const verbatim: string[] = [];
  for (const rule of rules.rules) {
    const problem = ruleShapeProblem(rule, known);
    if (problem !== undefined) {
      shape.push(`${label(rule)}: ${problem}`);
      continue;
    }
    const quote = normalise(rule.quote);
    const anywhere = extraction.sections.some((section) => section.text.includes(quote));
    if (!anywhere) {
      verbatim.push(`not verbatim in A.1–A.7: ${label(rule)}`);
      continue;
    }
    const inA1 = text.get('A.1')?.includes(quote) === true;
    const home = rule.types.every((type) => text.get(sectionOf.get(type) ?? '')?.includes(quote) === true);
    if (!inA1 && !home)
      verbatim.push(`quoted from outside A.1 and the sections defining ${rule.types.join(', ')}: ${label(rule)}`);
  }

  const coverage = [...unaccountedComments(extraction, rules), ...uncoveredSentences(extraction, rules)];

  const oneToOne: string[] = [];
  const stating = (type: string, invariant: string): number =>
    rules.rules.filter(
      (rule) =>
        'invariant' in rule.becomes && rule.types.includes(type) && stable(rule.becomes.invariant) === invariant,
    ).length;
  for (const entry of transcription.types) {
    const seen = new Set<string>();
    for (const invariant of entry.invariants.map(stable)) {
      if (seen.has(invariant)) oneToOne.push(`${entry.type}: the transcription names ${invariant} twice`);
      seen.add(invariant);
      const count = stating(entry.type, invariant);
      if (count !== 1) oneToOne.push(`${entry.type} ${invariant}: ${count} prose rules state it; exactly one must`);
    }
  }
  for (const rule of rules.rules) {
    if (!('invariant' in rule.becomes)) continue;
    const invariant = stable(rule.becomes.invariant);
    for (const type of rule.types) {
      const entry = transcription.types.find((candidate) => candidate.type === type);
      if (!entry?.invariants.some((named) => stable(named) === invariant)) {
        oneToOne.push(`${type} ${invariant}: a prose rule states it, and the transcription does not name it`);
      }
    }
  }
  return { verbatim, shape, coverage, oneToOne };
}
