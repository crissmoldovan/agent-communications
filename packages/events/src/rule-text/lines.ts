/** The rule text's lowest layer: lines into a tree by indentation, and a cursor that reads one line's tokens. */

import type { Scalar } from '../conditions/types.ts';
import type { JsonValue } from '../json.ts';
import type { RuleTextError } from './types.ts';

/** One non-blank line, with the lines indented under it. */
export interface TextLine {
  /** 1-based line number in the text. */
  readonly number: number;
  /** Indentation level: two spaces each. */
  readonly level: number;
  /** 1-based column of the line's first character after its indentation. */
  readonly column: number;
  /** The line without its indentation and trailing spaces. */
  readonly text: string;
  readonly children: TextLine[];
}

/** A refusal at one place in the text; the parser turns it into a `RuleTextError`. */
export class RuleTextFailure extends Error {
  readonly line: number;
  readonly column: number;

  constructor(line: number, column: number, message: string) {
    super(message);
    this.name = 'RuleTextFailure';
    this.line = line;
    this.column = column;
  }

  toError(): RuleTextError {
    return { line: this.line, column: this.column, message: this.message };
  }
}

/** Splits `text` into a tree of lines. A line it cannot place is reported in `errors` and left out. */
export function lineTree(text: string, errors: RuleTextError[]): TextLine[] {
  const roots: TextLine[] = [];
  // stack[level] is the last line placed at that level.
  const stack: TextLine[] = [];
  const rows = text.split(/\r\n|\n|\r/);
  for (let index = 0; index < rows.length; index += 1) {
    const number = index + 1;
    const row = (rows[index] as string).replace(/[ \t]+$/, '');
    if (row.length === 0) continue;
    const indentation = /^[ \t]*/.exec(row)?.[0] ?? '';
    if (indentation.includes('\t')) {
      errors.push({
        line: number,
        column: 1,
        message: 'indent with spaces, two per level; this line has a tab in its indentation',
      });
      continue;
    }
    if (indentation.length % 2 !== 0) {
      errors.push({
        line: number,
        column: 1,
        message: `indent by two spaces per level; this line is indented by ${indentation.length}`,
      });
      continue;
    }
    const level = indentation.length / 2;
    const line: TextLine = {
      number,
      level,
      column: indentation.length + 1,
      text: row.slice(indentation.length),
      children: [],
    };
    if (level === 0) {
      roots.push(line);
      stack.length = 0;
      stack.push(line);
      continue;
    }
    if (stack.length === 0) {
      errors.push({
        line: number,
        column: line.column,
        message: 'this line is indented, but no line above it opens a block',
      });
      continue;
    }
    if (level > stack.length) {
      const deeper = level - stack.length + 1;
      errors.push({
        line: number,
        column: line.column,
        message: `this line is indented ${deeper === 2 ? 'two' : String(deeper)} levels deeper than the line above it; indent one level (two spaces) at a time`,
      });
      continue;
    }
    (stack[level - 1] as TextLine).children.push(line);
    stack.length = level;
    stack.push(line);
  }
  return roots;
}

/** The characters a bare word is made of. Anything else is quoted. */
export const WORD_CHARACTERS: RegExp = /^[A-Za-z0-9_./@:+~-]+$/;
const WORD_CHARACTER = /[A-Za-z0-9_./@:+~-]/;
const SEGMENT_CHARACTER = /[A-Za-z0-9_-]/;
const INTEGER = /^(0|[1-9][0-9]*)$/;
const NUMBER = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const PUNCTUATION = new Set([',', '=']);

/** Reads one line from left to right. Every method skips the spaces before what it reads. */
export class Cursor {
  readonly line: TextLine;
  #at = 0;

  constructor(line: TextLine) {
    this.line = line;
  }

  get text(): string {
    return this.line.text;
  }

  /** The current position, to come back to with `restore`. */
  save(): number {
    return this.#at;
  }

  restore(at: number): void {
    this.#at = at;
  }

  /** The 1-based column of a position on this line. */
  column(at: number = this.#at): number {
    return this.line.column + at;
  }

  fail(message: string, at?: number): never {
    throw new RuleTextFailure(this.line.number, this.column(at ?? this.#next()), message);
  }

  #next(): number {
    let at = this.#at;
    while (this.text[at] === ' ') at += 1;
    return at;
  }

  #skip(): void {
    this.#at = this.#next();
  }

  atEnd(): boolean {
    return this.#next() >= this.text.length;
  }

  /** What comes next, for a message: a word in quotes, "quoted text", or the end of the line. */
  describeNext(): string {
    const at = this.#next();
    if (at >= this.text.length) return 'the end of the line';
    if (this.text[at] === '"') return 'quoted text';
    const word = this.#wordAt(at);
    return word === undefined ? JSON.stringify(this.text[at]) : JSON.stringify(word);
  }

  /** Refuses anything left on the line. */
  expectEnd(after: string): void {
    if (!this.atEnd()) this.fail(`unexpected ${this.describeNext()} after ${after}`);
  }

  #wordAt(at: number): string | undefined {
    let end = at;
    while (end < this.text.length && WORD_CHARACTER.test(this.text[end] as string)) end += 1;
    return end === at ? undefined : this.text.slice(at, end);
  }

  /** The next bare word, without reading it. */
  peekWord(): string | undefined {
    return this.#wordAt(this.#next());
  }

  /** Reads the next bare word, if there is one. */
  word(): string | undefined {
    this.#skip();
    const word = this.#wordAt(this.#at);
    if (word !== undefined) this.#at += word.length;
    return word;
  }

  /** Whether the next tokens are exactly these words (or `,` and `=`), without reading them. */
  isNext(...tokens: readonly string[]): boolean {
    const at = this.#at;
    const found = this.take(...tokens);
    this.#at = at;
    return found;
  }

  /** Reads the tokens if they come next, all of them; otherwise reads nothing. */
  take(...tokens: readonly string[]): boolean {
    const start = this.#at;
    for (const token of tokens) {
      this.#skip();
      if (PUNCTUATION.has(token)) {
        if (this.text[this.#at] !== token) {
          this.#at = start;
          return false;
        }
        this.#at += 1;
        continue;
      }
      const word = this.#wordAt(this.#at);
      if (word !== token) {
        this.#at = start;
        return false;
      }
      this.#at += word.length;
    }
    return true;
  }

  /** Reads the tokens, or refuses naming what was expected. */
  expect(tokens: readonly string[], what?: string): void {
    if (!this.take(...tokens))
      this.fail(`expected ${what ?? JSON.stringify(tokens.join(' '))}, found ${this.describeNext()}`);
  }

  /** Reads a comma if one comes next. */
  comma(): boolean {
    return this.take(',');
  }

  isString(): boolean {
    return this.text[this.#next()] === '"';
  }

  /** The end of the quoted text that starts at `at`, after its closing quote, or undefined when it has none. */
  #stringEnd(at: number): number | undefined {
    let index = at + 1;
    while (index < this.text.length) {
      const character = this.text[index];
      if (character === '\\') index += 2;
      else if (character === '"') return index + 1;
      else index += 1;
    }
    return undefined;
  }

  /** Reads quoted text: a JSON string, with JSON's escapes. */
  string(what: string): string {
    this.#skip();
    const start = this.#at;
    if (this.text[start] !== '"') return this.fail(`${what} is quoted text, such as "…"; found ${this.describeNext()}`);
    const end = this.#stringEnd(start);
    if (end === undefined) return this.fail(`${what} has no closing quote`, start);
    let value: unknown;
    try {
      value = JSON.parse(this.text.slice(start, end));
    } catch {
      return this.fail(
        `${what} is not valid quoted text: write a quote as \\", a backslash as \\\\, a newline as \\n`,
        start,
      );
    }
    this.#at = end;
    return value as string;
  }

  /** Reads a name: a bare word, or quoted text when it has other characters. */
  name(what: string): string {
    if (this.isString()) return this.string(what);
    const word = this.word();
    if (word === undefined) return this.fail(`expected ${what}, found ${this.describeNext()}`);
    return word;
  }

  /** Reads a whole number written without leading zeros. */
  integer(what: string): number {
    this.#skip();
    const start = this.#at;
    const word = this.#wordAt(start);
    if (word === undefined || !INTEGER.test(word) || !Number.isSafeInteger(Number(word))) {
      return this.fail(
        `${what} is a whole number, such as 60; found ${word === undefined ? this.describeNext() : JSON.stringify(word)}`,
      );
    }
    this.#at += word.length;
    return Number(word);
  }

  /** Reads a JSON scalar: quoted text, a number, true, false or null. */
  value(what: string): Scalar {
    if (this.isString()) return this.string(what);
    this.#skip();
    const start = this.#at;
    const word = this.#wordAt(start);
    if (word === 'true' || word === 'false' || word === 'null') {
      this.#at += word.length;
      return word === 'null' ? null : word === 'true';
    }
    if (word !== undefined && NUMBER.test(word)) {
      const number = JSON.parse(word) as number;
      if (Number.isFinite(number)) {
        this.#at += word.length;
        return number;
      }
    }
    return this.fail(`${what} is quoted text, a number, true, false or null; found ${this.describeNext()}`);
  }

  /** Reads one JSON value of any kind, objects and arrays included, on this line. */
  json(what: string): JsonValue {
    this.#skip();
    const start = this.#at;
    const first = this.text[start];
    let end: number | undefined;
    if (first === '{' || first === '[') {
      let depth = 0;
      for (let index = start; index < this.text.length; index += 1) {
        const character = this.text[index];
        if (character === '"') {
          const close = this.#stringEnd(index);
          if (close === undefined) break;
          index = close - 1;
        } else if (character === '{' || character === '[') depth += 1;
        else if (character === '}' || character === ']') {
          depth -= 1;
          if (depth === 0) {
            end = index + 1;
            break;
          }
        }
      }
      if (end === undefined)
        return this.fail(`${what} is not closed: a ${first === '{' ? '}' : ']'} is missing`, start);
    } else if (first === '"') {
      end = this.#stringEnd(start);
      if (end === undefined) return this.fail(`${what} has no closing quote`, start);
    } else {
      const word = this.#wordAt(start);
      if (word === undefined) return this.fail(`${what} is JSON; found ${this.describeNext()}`);
      end = start + word.length;
    }
    let value: JsonValue;
    try {
      value = JSON.parse(this.text.slice(start, end)) as JsonValue;
    } catch {
      return this.fail(`${what} is not valid JSON`, start);
    }
    this.#at = end;
    return value;
  }

  /**
   * Reads an output path: segments joined by dots, each a bare segment (letters, digits, `_` and `-`) or quoted text,
   * with nothing between them. Returns undefined, reading nothing, when no segment comes next.
   */
  segments(what: string): readonly string[] | undefined {
    this.#skip();
    const start = this.#at;
    const found: string[] = [];
    for (;;) {
      if (this.text[this.#at] === '"') found.push(this.string(what));
      else {
        let end = this.#at;
        while (end < this.text.length && SEGMENT_CHARACTER.test(this.text[end] as string)) end += 1;
        if (end === this.#at) {
          this.#at = start;
          return undefined;
        }
        found.push(this.text.slice(this.#at, end));
        this.#at = end;
      }
      if (this.text[this.#at] !== '.') return found;
      this.#at += 1;
    }
  }

  /** Whether the next character is one that ends a token rather than starts one. */
  nextIs(character: string): boolean {
    return this.text[this.#next()] === character;
  }
}
