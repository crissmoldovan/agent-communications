/**
 * Enough of TOML to read codex's `config.toml`, and a refusal for anything else.
 *
 * This used to be a line matcher that knew one spelling — `[mcp_servers.<name>]` sections with `key = "value"`
 * lines — and treated everything else as somebody else's section. TOML has several spellings of the same entry,
 * and the one it missed mattered: `[mcp_servers]` followed by `slack = { command = "npx", …, env = { … } }` is a
 * server the matcher never saw, so `mcp install` added its own over it through `codex mcp add` (which overwrites),
 * token and all, and `mcp prune` deleted runtimes it named. A multi-line `args` array was read as no arguments.
 *
 * So this is a parser rather than a pattern, for the whole of the syntax codex's own writer or a person editing
 * the file might use: dotted and quoted keys, table and array-of-table headers, the four kinds of string, arrays
 * across lines, inline tables. What it does not recognise it refuses, with a line number and never the text: a
 * file it cannot read is reported as one, so the callers can decline to act on it rather than act on half of it.
 * Dates and times are kept as their text, which nothing here needs to interpret.
 */

export class TomlError extends Error {}

type Table = Record<string, unknown>;

const BARE_KEY = /[A-Za-z0-9_-]/;
const ESCAPES: Record<string, string> = {
  b: '\b',
  t: '\t',
  n: '\n',
  f: '\f',
  r: '\r',
  e: '\u001b',
  '"': '"',
  '\\': '\\',
};
const INTEGER =
  /^[+-]?(?:0|[1-9](?:_?\d)*)$|^0x[0-9A-Fa-f](?:_?[0-9A-Fa-f])*$|^0o[0-7](?:_?[0-7])*$|^0b[01](?:_?[01])*$/;
const FLOAT = /^[+-]?(?:0|[1-9](?:_?\d)*)(?:\.\d(?:_?\d)*)?(?:[eE][+-]?\d(?:_?\d)*)?$|^[+-]?(?:inf|nan)$/;
const DATE_TIME =
  /^\d{4}-\d{2}-\d{2}(?:[Tt ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?)?$|^\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?$/;

function isTable(value: unknown): value is Table {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseToml(text: string): Table {
  const source = text.startsWith('\uFEFF') ? text.slice(1) : text;
  const root: Table = {};
  let current: Table = root;
  let pos = 0;

  const fail = (why: string): never => {
    const line = source.slice(0, pos).split('\n').length;
    throw new TomlError(`line ${line}: ${why}`);
  };
  const at = (offset = 0) => source[pos + offset] ?? '';
  const startsWith = (token: string) => source.startsWith(token, pos);

  const skipSpaces = () => {
    while (at() === ' ' || at() === '\t') pos += 1;
  };
  const skipComment = () => {
    if (at() !== '#') return;
    while (pos < source.length && at() !== '\n') pos += 1;
  };
  /** Spaces, line breaks and comments: what may sit between the parts of an array or a document. */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (at() === '\n') pos += 1;
      else if (at() === '\r' && at(1) === '\n') pos += 2;
      else return;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (pos >= source.length || at() === '\n') return;
    if (at() === '\r' && at(1) === '\n') return;
    fail('more on this line than one key and value');
  };

  const basicString = (): string => {
    pos += 1;
    let value = '';
    for (;;) {
      const char = at();
      if (pos >= source.length || char === '\n') fail('a string that does not end on its line');
      pos += 1;
      if (char === '"') return value;
      value += char === '\\' ? escapeSequence() : char;
    }
  };
  const escapeSequence = (): string => {
    const code = at();
    pos += 1;
    const known = ESCAPES[code];
    if (known !== undefined) return known;
    const width = code === 'u' ? 4 : code === 'U' ? 8 : code === 'x' ? 2 : 0;
    const hex = source.slice(pos, pos + width);
    if (width === 0 || !/^[0-9A-Fa-f]+$/.test(hex) || hex.length !== width) fail('an escape this cannot read');
    pos += width;
    return String.fromCodePoint(Number.parseInt(hex, 16));
  };
  const multilineBasic = (): string => {
    pos += 3;
    if (at() === '\n') pos += 1;
    else if (at() === '\r' && at(1) === '\n') pos += 2;
    let value = '';
    for (;;) {
      if (pos >= source.length) fail('a string that never ends');
      if (startsWith('"""')) {
        // Up to two quotes may sit against the closing three and belong to the string.
        let extra = 0;
        while (extra < 2 && at(3 + extra) === '"') extra += 1;
        value += '"'.repeat(extra);
        pos += 3 + extra;
        return value;
      }
      const char = at();
      pos += 1;
      if (char !== '\\') {
        value += char;
        continue;
      }
      // A backslash at the end of a line joins it to the next, dropping the whitespace between.
      const rest = /^[ \t]*\r?\n/.exec(source.slice(pos));
      if (rest) {
        pos += rest[0].length;
        while (/[ \t\r\n]/.test(at())) pos += 1;
        continue;
      }
      value += escapeSequence();
    }
  };
  const literalString = (): string => {
    const end = source.indexOf("'", pos + 1);
    const newline = source.indexOf('\n', pos + 1);
    if (end === -1 || (newline !== -1 && newline < end)) fail('a string that does not end on its line');
    const value = source.slice(pos + 1, end);
    pos = end + 1;
    return value;
  };
  const multilineLiteral = (): string => {
    pos += 3;
    if (at() === '\n') pos += 1;
    else if (at() === '\r' && at(1) === '\n') pos += 2;
    const end = source.indexOf("'''", pos);
    if (end === -1) fail('a string that never ends');
    let close = end;
    while (close - end < 2 && source[close + 3] === "'") close += 1;
    const value = source.slice(pos, close);
    pos = close + 3;
    return value;
  };

  const simpleKey = (): string => {
    if (at() === '"') return basicString();
    if (at() === "'") return literalString();
    const start = pos;
    while (BARE_KEY.test(at())) pos += 1;
    if (pos === start) fail('a key this cannot read');
    return source.slice(start, pos);
  };
  const key = (): string[] => {
    const parts = [simpleKey()];
    for (;;) {
      skipSpaces();
      if (at() !== '.') return parts;
      pos += 1;
      skipSpaces();
      parts.push(simpleKey());
    }
  };

  /** The table a dotted path names, made where it does not exist yet; the last of an array of tables. */
  const tableAt = (from: Table, path: readonly string[]): Table => {
    let table = from;
    for (const part of path) {
      let next = table[part];
      if (next === undefined) {
        next = {};
        table[part] = next;
      }
      if (Array.isArray(next)) next = next.at(-1);
      if (!isTable(next)) fail(`"${part}" is a value and a table at once`);
      table = next as Table;
    }
    return table;
  };
  const assign = (table: Table, path: readonly string[], value: unknown) => {
    const parent = tableAt(table, path.slice(0, -1));
    const last = path.at(-1) ?? '';
    if (last in parent) fail('a key defined twice');
    parent[last] = value;
  };

  const scalar = (): unknown => {
    let token = /^[0-9A-Za-z_+\-.:]+/.exec(source.slice(pos))?.[0] ?? '';
    // A date and a time may be separated by a single space.
    const time = /^ \d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:[Zz]|[+-]\d{2}:\d{2})?/.exec(source.slice(pos + token.length));
    if (/^\d{4}-\d{2}-\d{2}$/.test(token) && time) token += time[0];
    if (token === '') fail('a value this cannot read');
    pos += token.length;
    if (token === 'true') return true;
    if (token === 'false') return false;
    if (INTEGER.test(token)) {
      const digits = token.replace(/_/g, '');
      return /^0[xob]/.test(digits) ? Number(digits) : Number.parseInt(digits, 10);
    }
    if (FLOAT.test(token)) {
      const digits = token.replace(/_/g, '');
      if (/inf$/.test(digits)) return digits.startsWith('-') ? -Infinity : Infinity;
      if (/nan$/.test(digits)) return Number.NaN;
      return Number.parseFloat(digits);
    }
    if (DATE_TIME.test(token)) return token;
    return fail('a value this cannot read');
  };

  const array = (): unknown[] => {
    pos += 1;
    const values: unknown[] = [];
    for (;;) {
      skipBlank();
      if (at() === ']') {
        pos += 1;
        return values;
      }
      values.push(value());
      skipBlank();
      if (at() === ',') pos += 1;
      else if (at() !== ']') fail('an array this cannot read');
    }
  };
  const inlineTable = (): Table => {
    pos += 1;
    const table: Table = {};
    for (;;) {
      // Line breaks and a trailing comma are TOML 1.1, and cost nothing to accept.
      skipBlank();
      if (at() === '}') {
        pos += 1;
        return table;
      }
      const path = key();
      skipSpaces();
      if (at() !== '=') fail('a key with no value');
      pos += 1;
      skipSpaces();
      assign(table, path, value());
      skipBlank();
      if (at() === ',') pos += 1;
      else if (at() !== '}') fail('an inline table this cannot read');
    }
  };

  const value = (): unknown => {
    if (startsWith('"""')) return multilineBasic();
    if (at() === '"') return basicString();
    if (startsWith("'''")) return multilineLiteral();
    if (at() === "'") return literalString();
    if (at() === '[') return array();
    if (at() === '{') return inlineTable();
    return scalar();
  };

  for (;;) {
    skipBlank();
    if (pos >= source.length) return root;
    if (startsWith('[[')) {
      pos += 2;
      skipSpaces();
      const path = key();
      if (!startsWith(']]')) fail('a table header this cannot read');
      pos += 2;
      endOfLine();
      const parent = tableAt(root, path.slice(0, -1));
      const last = path.at(-1) ?? '';
      const list = parent[last] ?? [];
      if (!Array.isArray(list)) fail(`"${last}" is a table and an array of tables at once`);
      const table: Table = {};
      (list as unknown[]).push(table);
      parent[last] = list;
      current = table;
    } else if (at() === '[') {
      pos += 1;
      skipSpaces();
      const path = key();
      if (at() !== ']') fail('a table header this cannot read');
      pos += 1;
      endOfLine();
      current = tableAt(root, path);
    } else {
      const path = key();
      skipSpaces();
      if (at() !== '=') fail('a key with no value');
      pos += 1;
      skipSpaces();
      assign(current, path, value());
      endOfLine();
    }
  }
}
