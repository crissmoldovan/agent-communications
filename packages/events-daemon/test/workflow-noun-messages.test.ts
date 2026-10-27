import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

/*
 * One word, in what the event service says (workflows design 2026-10-27, W22: "the word 'rule' leaves every screen,
 * button, preview and message"). `workflow-noun.test.ts` holds the help and the tools to it; this holds every sentence
 * the event service's code can give a person or an agent — an error and its hint, a refusal, a preview, a rendered
 * list, a disclosure, Analyse's words and the briefs whose answers a person reads — by reading each string the source
 * writes. Identifiers stay: `ruleId`, `rule_versions`, the SQL that names them, the `rule` kind, the hidden `--rule`
 * flags and the contract's `rule enable` constant, which are words of the code, not of a sentence.
 */

const SOURCE = fileURLToPath(new URL('../src/', import.meta.url));

/**
 * The few that stay, each for its reason. A line a B3 guard's mutation names cannot change (plan, Global Constraints),
 * so a sentence on one waits for its guard to move.
 */
const KEPT: Readonly<Record<string, string>> = {
  // Flags kept hidden for scripts and the app (W22): names, not sentences.
  '--rule <workflow-id>': 'the hidden --rule alias of --workflow',
  // A contract constant the app compares (B3 v1 `appliesWhen`): the command word, which `rule` still is as an alias.
  'rule enable': 'the B3 v1 constant appliesWhen',
  // On lines B3 guards name (test/b3-guard-manifests/retained.json): the one `rule-test-rejects-retained-form`'s
  // `if (!isCatalogueForm)` is on, and the whole of `target-test-needs-exact-active-reference`'s.
  'a rule test catalogue selector is malformed': 'on a B3-anchored line',
  'the target has no active exact rule reference': 'a B3-anchored line',
};

interface Literal {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) =>
      entry.isDirectory()
        ? sourceFiles(join(directory, entry.name))
        : Promise.resolve(entry.name.endsWith('.ts') ? [join(directory, entry.name)] : []),
    ),
  );
  return nested.flat().sort();
}

const REGEX_BEFORE = new Set([...'(,=:[!&|?{};+-*%<>~^']);
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'case', 'in', 'of', 'delete', 'void', 'throw', 'new', 'else']);
const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '0': '\0' };
/** Where a template's expression was, in the text read from it. */
const HOLE = '…';

/**
 * Every string a TypeScript file writes — quoted strings, and each template with `…` where its expressions were —
 * with comments and regular expressions passed over. A small lexer, enough for this source; it is checked below on
 * the cases it must get right.
 */
function stringsOf(source: string, file = '<source>'): Literal[] {
  const found: Literal[] = [];
  let index = 0;
  let line = 1;
  let previous = '';
  let word = '';
  let inWord = false;
  const advance = (count = 1): void => {
    for (let step = 0; step < count; step += 1) if (source[index++] === '\n') line += 1;
  };
  const quoted = (quote: string): string => {
    advance();
    let text = '';
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') {
        const next = source[index + 1] ?? '';
        text += ESCAPES[next] ?? next;
        advance(2);
      } else {
        text += source[index];
        advance();
      }
    }
    advance();
    return text;
  };
  const template = (): string => {
    advance();
    let text = '';
    while (index < source.length && source[index] !== '`') {
      if (source[index] === '\\') {
        const next = source[index + 1] ?? '';
        text += ESCAPES[next] ?? next;
        advance(2);
      } else if (source[index] === '$' && source[index + 1] === '{') {
        advance(2);
        code('}');
        advance();
        text += HOLE;
      } else {
        text += source[index];
        advance();
      }
    }
    advance();
    return text;
  };
  const regex = (): void => {
    advance();
    let inClass = false;
    while (index < source.length) {
      const char = source[index];
      if (char === '\\') advance(2);
      else if (char === '\n') return;
      else {
        advance();
        if (char === '[') inClass = true;
        else if (char === ']') inClass = false;
        else if (char === '/' && !inClass) break;
      }
    }
    while (/[a-z]/u.test(source[index] ?? '')) advance();
  };
  /** Code up to the unmatched `end` (or the end of the file): the strings in it, nested templates included. */
  const code = (end: string | null): void => {
    let depth = 0;
    while (index < source.length) {
      const char = source[index] as string;
      const next = source[index + 1];
      if (end !== null && char === end && depth === 0) return;
      if (char === '/' && next === '/') {
        while (index < source.length && source[index] !== '\n') advance();
      } else if (char === '/' && next === '*') {
        advance(2);
        while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) advance();
        advance(2);
      } else if (char === "'" || char === '"' || char === '`') {
        const at = line;
        const text = char === '`' ? template() : quoted(char);
        found.push({ file, line: at, text });
        previous = 'a';
        word = '';
        inWord = false;
      } else if (char === '/' && (previous === '' || REGEX_BEFORE.has(previous) || REGEX_AFTER_WORD.has(word))) {
        regex();
        previous = 'a';
        word = '';
        inWord = false;
      } else {
        if (char === '{') depth += 1;
        else if (char === '}') depth -= 1;
        const wordChar = /[\w$]/u.test(char);
        if (wordChar) word = inWord ? word + char : char;
        else if (!/\s/u.test(char)) word = '';
        inWord = wordChar;
        if (!/\s/u.test(char)) previous = char;
        advance();
      }
    }
  };
  code(null);
  return found;
}

/** A sentence: words with a space between them, and not SQL, whose `rule_versions` and `rule.` aliases are names. */
function isSentence(text: string): boolean {
  return (
    /\S\s+\S/u.test(text) &&
    !/\b(?:SELECT|INSERT|UPDATE|DELETE|CREATE|TABLE|FROM|WHERE|JOIN|AND|ORDER BY|VALUES)\b/u.test(text)
  );
}

test('the lexer reads strings and templates, and passes over comments and regular expressions', () => {
  // TypeScript source, as data: its `${…}` are the text a template holds, not placeholders here.
  const source = [
    "const a = 'it\\'s a rule'; // 'not this rule'",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the lexer.
    '/* "nor this rule" */ const b = /["\'`]rule/u.test(x) ? `the ${y ? \'inner rule\' : `${z}`} rule` : "x";',
    'const c = (n / 2) / 3; const d = "after division"; return /a"b/u;',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: this is deliberate source text for the lexer.
    "const e = `x${'{'}y`; const f = 'last rule';",
  ].join('\n');
  assert.deepEqual(
    stringsOf(source).map(({ text, line }) => [line, text]),
    [
      [1, "it's a rule"],
      [2, 'inner rule'],
      [2, '…'],
      [2, 'the … rule'],
      [2, 'x'],
      [3, 'after division'],
      [4, '{'],
      [4, 'x…y'],
      [4, 'last rule'],
    ],
  );
});

test('nothing the event service says to a person or an agent calls a workflow a rule', async () => {
  const files = await sourceFiles(SOURCE);
  assert.ok(files.length > 100, 'the whole source was read');
  const saying: string[] = [];
  const kept = new Set<string>();
  for (const path of files) {
    const file = relative(SOURCE, path).split('\\').join('/');
    for (const { line, text } of stringsOf(await readFile(path, 'utf8'), file)) {
      if (!/\brules?\b/iu.test(text) || !isSentence(text)) continue;
      if (Object.hasOwn(KEPT, text)) {
        kept.add(text);
        continue;
      }
      saying.push(`${file}:${line}: ${JSON.stringify(text)}`);
    }
  }
  assert.deepEqual(saying, [], `these still say rule:\n${saying.join('\n')}`);
  assert.deepEqual([...kept].sort(), Object.keys(KEPT).sort(), 'each kept sentence is still in the source');
});
