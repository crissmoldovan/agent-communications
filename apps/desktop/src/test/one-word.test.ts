// @vitest-environment node
/*
 * One word (workflows design W22, plan E4): everything a person reads in the app says workflow, never rule. This reads
 * every source file under `src` (not the tests) the way the bundler does, and looks at each string a person could
 * read: string literals, template text and JSX text. Identifiers stay as they are — `ruleId`, a call's kind, a tab's
 * key — so a literal shaped like one (a single camelCase, kebab-case or dotted word, outside any sentence) is left
 * out, as are module paths and types. The label rules and behaviour rules screens are a different thing, and are
 * allowed by path.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAst } from 'vite';
import { describe, expect, it } from 'vitest';

const SRC = fileURLToPath(new URL('../', import.meta.url));

/** The screens about agents' label and behaviour rules: a different kind of rule, which keeps its name (W22). */
const ALLOWED: readonly string[] = [
  'screens/Agent.tsx',
  'components/RuleForm.tsx',
  'screens/YourAgents.tsx',
  'screens/Accounts.tsx',
  'screens/accounts/AgentsHere.tsx',
];

/** A literal that is an identifier, not words: one camelCase word, or words joined by `-`, `_`, `.`, `:`, `/` or `@`. */
const IDENTIFIER = /^(?:[a-z][a-zA-Z0-9]*|[a-z0-9]+(?:[-_.:/@][a-z0-9]+)+)$/;

interface Hit {
  file: string;
  line: number;
  text: string;
}

function sources(directory: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== 'test') found.push(...sources(path));
    } else if (/\.tsx?$/.test(entry) && !/\.d\.ts$/.test(entry)) found.push(path);
  }
  return found;
}

type Node = { type: string; start: number; [key: string]: unknown };

/** Every string in `file` a person could read, with its line. */
function visibleStrings(file: string): Hit[] {
  const text = readFileSync(file, 'utf8');
  const name = relative(SRC, file).split(sep).join('/');
  const ast = parseAst(text, { lang: file.endsWith('.tsx') ? 'tsx' : 'ts' }, file) as unknown as Node;
  const hits: Hit[] = [];
  const lineOf = (at: number) => text.slice(0, at).split('\n').length;
  const visit = (node: unknown, inSentence: boolean): void => {
    if (Array.isArray(node)) {
      for (const child of node) visit(child, inSentence);
      return;
    }
    if (typeof node !== 'object' || node === null) return;
    const each = node as Node;
    // Types and module paths are never read by a person.
    if (/^TS(?!AsExpression|SatisfiesExpression|NonNullExpression|InstantiationExpression)/.test(each.type)) return;
    if (each.type === 'ImportDeclaration' || each.type === 'ExportAllDeclaration') return;
    const said = (words: string) => {
      if (words.trim() !== '' && (inSentence || !IDENTIFIER.test(words.trim())))
        hits.push({ file: name, line: lineOf(each.start), text: words });
    };
    if (each.type === 'Literal' && typeof each.value === 'string') said(each.value);
    if (each.type === 'JSXText' && typeof each.value === 'string') said(each.value);
    if (each.type === 'TemplateElement') said(String((each.value as { cooked?: string }).cooked ?? ''));
    for (const [key, child] of Object.entries(each)) {
      if (key === 'parent') continue;
      // A property's own name is an identifier; an export's or a dynamic import's source is a module path.
      if (each.type === 'Property' && key === 'key' && each.computed !== true) continue;
      if ((each.type === 'ExportNamedDeclaration' || each.type === 'ImportExpression') && key === 'source') continue;
      // Inside a template's expressions, a single word is part of a sentence: `${n} ${n === 1 ? 'rule' : 'rules'}`.
      visit(child, inSentence || (each.type === 'TemplateLiteral' && key === 'expressions'));
    }
  };
  visit(ast, false);
  return hits;
}

describe('one word: workflow', () => {
  it('reads the strings a person reads, and leaves identifiers out', () => {
    const probe = join(SRC, 'workflows', 'copy.ts');
    const strings = visibleStrings(probe).map((hit) => hit.text);
    expect(strings).toContain('Which project?');
    expect(strings).not.toContain('timed-out');
  });

  it('no string a person reads in apps/desktop/src says rule', () => {
    const found = sources(SRC)
      .filter((file) => !ALLOWED.includes(relative(SRC, file).split(sep).join('/')))
      .flatMap(visibleStrings)
      .filter((hit) => /\brules?\b/i.test(hit.text))
      .map((hit) => `${hit.file}:${hit.line}: ${JSON.stringify(hit.text)}`);
    expect(found).toEqual([]);
  });
});
