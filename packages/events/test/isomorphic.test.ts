import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, posix, sep } from 'node:path';
import { test } from 'node:test';
import * as ts from 'typescript/unstable/ast';
import { createVirtualFileSystem } from 'typescript/unstable/fs';
import { API } from 'typescript/unstable/sync';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * The library reaches nothing but ECMAScript and zod (events phase A plan, decision 3, layers 1 and 2).
 *
 * The compiler is the first layer: `tsconfig.json` compiles `src/` with no Node types and no DOM types, so `process`,
 * `fetch` or a `node:` import do not compile. This is the second: a syntax-tree scan, with the same TypeScript 7 API
 * `test/helpers/printed-command-guard.mjs` uses, of the source, the generated tables and the built output. It refuses,
 * by syntax and never by file:
 *
 * - `specifier`: an import, an export-from, a dynamic `import()`, a `require()` or an `import x = require()` whose
 *   specifier is neither relative nor `zod`;
 * - `import-meta`: `import.meta`;
 * - `host-global`: a host global named in expression position, `Date` and `Function` among them;
 * - `host-member`: a member whose answer depends on the host's Unicode tables or is not deterministic;
 * - `regexp`: a regular expression with the `i` flag or a `\p{`/`\P{` property escape, and `RegExp` built from
 *   anything but literals — each depends on the engine's Unicode version or case tables;
 * - `node-types`: `/// <reference types="…" />`, or an `import("node:…")` type, in a declaration file.
 *
 * Fixtures in `test/fixtures/isomorphic/` hold one refused and one accepted example per rule.
 */

/** Rules by the name a finding carries. */
const RULES = ['specifier', 'import-meta', 'host-global', 'host-member', 'regexp', 'node-types'] as const;
type Rule = (typeof RULES)[number];

interface Finding {
  readonly path: string;
  readonly line: number;
  readonly rule: Rule;
  readonly text: string;
}

interface SourceFile {
  readonly path: string;
  readonly text: string;
}

/** Globals a host provides and ECMAScript does not, or that the library must not use (decision 3). */
const HOST_GLOBALS = new Set([
  'process',
  'Buffer',
  'global',
  'globalThis',
  'require',
  'module',
  'exports',
  '__dirname',
  '__filename',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'queueMicrotask',
  'fetch',
  'XMLHttpRequest',
  'WebSocket',
  'EventSource',
  'navigator',
  'window',
  'document',
  'self',
  'crypto',
  'performance',
  'console',
  'TextEncoder',
  'TextDecoder',
  'URL',
  'URLSearchParams',
  'structuredClone',
  'atob',
  'btoa',
  'Intl',
  'WebAssembly',
  'SharedArrayBuffer',
  'Atomics',
  'eval',
  'Function',
  // Instants are parsed exactly, never through `Date` (decision 14).
  'Date',
]);

/** Members whose result follows the host's Unicode version or locale. `Math.random` is refused on its own. */
const HOST_MEMBERS = new Set([
  'toLowerCase',
  'toUpperCase',
  'toLocaleLowerCase',
  'toLocaleUpperCase',
  'toLocaleString',
  'localeCompare',
  'normalize',
]);

const ALLOWED_PACKAGES = new Set(['zod']);

/** Parses `files` with the repository's own TypeScript, resolving nothing and writing nothing. */
function syntaxTrees(files: readonly SourceFile[]) {
  const root = '/agentcomms-events-isomorphism-scan';
  const config = posix.join(root, 'tsconfig.json');
  const api = new API({
    fs: createVirtualFileSystem({
      [config]: JSON.stringify({
        compilerOptions: { noLib: true, noResolve: true, allowJs: true },
        files: files.map((file) => file.path),
      }),
      ...Object.fromEntries(files.map((file) => [posix.join(root, file.path), file.text])),
    }),
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [config] });
    try {
      const project = snapshot.getProject(config);
      if (project === undefined) throw new Error('the scan could not open its project');
      const broken = project.program.getSyntacticDiagnostics();
      if (broken.length > 0) throw new Error(`the scan needs valid syntax: ${JSON.stringify(broken.slice(0, 3))}`);
      return files.map((file) => {
        const tree = project.program.getSourceFile(posix.join(root, file.path));
        if (tree === undefined) throw new Error(`the scan did not parse ${file.path}`);
        return { ...file, tree };
      });
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

const isRelative = (specifier: string) => specifier.startsWith('./') || specifier.startsWith('../');
const allowedSpecifier = (specifier: string) => isRelative(specifier) || ALLOWED_PACKAGES.has(specifier);

/** Whether a regular expression's source holds a Unicode property escape, `\p{…}` or `\P{…}`. */
function hasPropertyEscape(source: string): boolean {
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] !== '\\') continue;
    const next = source[i + 1];
    if ((next === 'p' || next === 'P') && source[i + 2] === '{') return true;
    i += 1;
  }
  return false;
}

/** A string literal's text, or undefined for anything else. */
function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/** Whether an identifier is a name — a declaration's, a key's, a member's — rather than a value read where it stands. */
function isNamePosition(node: ts.Identifier): boolean {
  const parent = node.parent as unknown as Record<string, unknown> | undefined;
  if (parent === undefined) return false;
  // `{ process }` reads the binding named `process`.
  if (ts.isShorthandPropertyAssignment(node.parent)) return false;
  return parent.name === node || parent.propertyName === node || parent.label === node;
}

/** Every finding in `files`: what each rule refuses, by syntax. */
function scan(files: readonly SourceFile[]): Finding[] {
  const findings: Finding[] = [];
  for (const { path, text, tree } of syntaxTrees(files)) {
    const add = (node: ts.Node, rule: Rule, said: string) => {
      const start = node.getStart ? node.getStart(tree) : node.pos;
      findings.push({ path, line: text.slice(0, start).split('\n').length, rule, text: said.slice(0, 160) });
    };
    const specifier = (node: ts.Node, value: string | undefined, what: string) => {
      if (value === undefined) add(node, 'specifier', `${what} of a specifier that is not a literal`);
      else if (!allowedSpecifier(value)) add(node, 'specifier', `${what} '${value}'`);
    };
    // Triple-slash directives are comments to the parser, so they are read as the text they are.
    const directive = /^[ \t]*\/\/\/[ \t]*<reference[ \t]+types[ \t]*=[ \t]*["']([^"']*)["']/gm;
    for (const match of text.matchAll(directive)) {
      findings.push({
        path,
        line: text.slice(0, match.index).split('\n').length,
        rule: 'node-types',
        text: match[0],
      });
    }
    const visit = (node: ts.Node): void => {
      if (ts.isImportDeclaration(node)) specifier(node, literalText(node.moduleSpecifier), 'import');
      else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
        specifier(node, literalText(node.moduleSpecifier), 'export from');
      } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
        specifier(node, literalText(node.moduleReference.expression), 'import = require');
      } else if (ts.isImportTypeNode(node)) {
        const argument = node.argument;
        const value = ts.isLiteralTypeNode(argument) ? literalText(argument.literal) : undefined;
        if (value?.startsWith('node:')) add(node, 'node-types', `import('${value}') type`);
        else specifier(node, value, 'import() type');
      } else if (ts.isCallExpression(node)) {
        if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
          specifier(node, literalText(node.arguments[0]), 'import()');
        } else if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
          specifier(node, literalText(node.arguments[0]), 'require()');
        }
      } else if (ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword) {
        add(node, 'import-meta', `import.${node.name.text}`);
      }

      if (ts.isPropertyAccessExpression(node)) {
        const name = node.name.text;
        if (HOST_MEMBERS.has(name)) add(node, 'host-member', `.${name}`);
        if (name === 'random' && ts.isIdentifier(node.expression) && node.expression.text === 'Math') {
          add(node, 'host-member', 'Math.random');
        }
      } else if (ts.isElementAccessExpression(node)) {
        const name = literalText(node.argumentExpression);
        if (name !== undefined && HOST_MEMBERS.has(name)) add(node, 'host-member', `['${name}']`);
      } else if (ts.isBindingElement(node)) {
        // An elision in an array pattern (`[, second]`) is a binding element with no name.
        const key = node.propertyName ?? node.name;
        if (key !== undefined && ts.isIdentifier(key) && HOST_MEMBERS.has(key.text)) {
          add(node, 'host-member', `{ ${key.text} }`);
        }
      }

      if (ts.isRegularExpressionLiteral(node)) {
        const at = node.text.lastIndexOf('/');
        const flags = node.text.slice(at + 1);
        if (flags.includes('i')) add(node, 'regexp', `${node.text}: the i flag`);
        if (hasPropertyEscape(node.text.slice(1, at))) add(node, 'regexp', `${node.text}: a property escape`);
      } else if (
        (ts.isNewExpression(node) || ts.isCallExpression(node)) &&
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'RegExp'
      ) {
        const [source, flags] = node.arguments ?? [];
        const pattern = literalText(source);
        const flagText = flags === undefined ? '' : literalText(flags);
        if (source !== undefined && pattern === undefined) add(node, 'regexp', 'RegExp from a non-literal source');
        else if (pattern !== undefined && hasPropertyEscape(pattern)) add(node, 'regexp', 'RegExp: a property escape');
        if (flagText === undefined) add(node, 'regexp', 'RegExp with non-literal flags');
        else if (flagText.includes('i')) add(node, 'regexp', 'RegExp: the i flag');
      }

      if (ts.isIdentifier(node) && HOST_GLOBALS.has(node.text) && !isNamePosition(node)) {
        add(node, 'host-global', node.text);
      }
      // Types say nothing about what runs; an import type was read above.
      if (ts.isTypeNode(node)) return;
      node.forEachChild(visit);
    };
    visit(tree);
  }
  return findings;
}

/** Files under `directory` (relative to the package) whose names match, as `{ path, text }` with `/` separators. */
function filesUnder(directory: string, matches: (name: string) => boolean): SourceFile[] {
  const at = join(PACKAGE_ROOT, directory);
  if (!existsSync(at)) return [];
  return readdirSync(at, { recursive: true })
    .map((entry) => String(entry))
    .filter(matches)
    .sort()
    .map((entry) => {
      const path = `${directory}/${entry.split(sep).join('/')}`;
      return { path, text: readFileSync(join(PACKAGE_ROOT, path), 'utf8') };
    });
}

const show = (findings: readonly Finding[]) =>
  findings.map((finding) => `\n  ${finding.path}:${finding.line} ${finding.rule}: ${finding.text}`).join('');

test('ISO-a: the source compiles with no Node and no DOM types', () => {
  const config = JSON.parse(readFileSync(join(PACKAGE_ROOT, 'tsconfig.json'), 'utf8'));
  assert.deepEqual(config.compilerOptions.types, []);
  assert.deepEqual(config.compilerOptions.lib, ['ES2023']);
});

test('ISO-a: the source, the generated tables and the built output reach nothing but ECMAScript and zod', () => {
  const source = filesUnder('src', (name) => name.endsWith('.ts'));
  assert.ok(source.length > 0, 'no source found');
  const generated = readdirSync(PACKAGE_ROOT).includes('vendor')
    ? readdirSync(join(PACKAGE_ROOT, 'vendor')).flatMap((vendor) =>
        filesUnder(`vendor/${vendor}/generated`, (name) => name.endsWith('.ts')),
      )
    : [];
  assert.ok(existsSync(join(PACKAGE_ROOT, 'dist', 'index.mjs')), 'packages/events has no dist: run `pnpm build`');
  const built = filesUnder('dist', (name) => name.endsWith('.mjs') || name.endsWith('.d.mts'));
  assert.ok(
    built.some((file) => file.path.endsWith('.d.mts')),
    'the build has no declarations',
  );
  const findings = scan([...source, ...generated, ...built]);
  assert.deepEqual(findings, [], `the library reaches beyond ECMAScript and zod:${show(findings)}`);
});

test('ISO-a: each rule has a refused and an accepted fixture, and the scan tells them apart', () => {
  const fixtures = filesUnder('test/fixtures/isomorphic', (name) => /\.(?:refused|accepted)\./.test(name));
  for (const rule of RULES) {
    for (const verdict of ['refused', 'accepted']) {
      assert.ok(
        fixtures.some((file) => file.path.split('/').at(-1)?.startsWith(`${rule}.${verdict}.`)),
        `no ${verdict} fixture for ${rule}`,
      );
    }
  }
  for (const fixture of fixtures) {
    const [rule, verdict] = (fixture.path.split('/').at(-1) ?? '').split('.');
    const findings = scan([fixture]);
    if (verdict === 'accepted') {
      assert.deepEqual(findings, [], `${fixture.path} is refused:${show(findings)}`);
    } else {
      assert.ok(findings.length > 0, `${fixture.path} is accepted`);
      assert.deepEqual(
        [...new Set(findings.map((finding) => finding.rule))],
        [rule],
        `${fixture.path} is refused for another rule:${show(findings)}`,
      );
    }
  }
});

test('ISO-a: every name and shape the rules list is refused, and the near misses are not', () => {
  const rulesOf = (text: string, path = 'probe.ts') => scan([{ path, text }]).map((finding) => finding.rule);
  for (const name of HOST_GLOBALS) {
    assert.deepEqual(rulesOf(`export const value = ${name};\n`), ['host-global'], name);
    // As a member, a key or a declaration's name it is a name, not the host's value.
    assert.deepEqual(rulesOf(`const o = { ${name}: 1 };\nexport const value = o.${name};\n`), [], `${name} as a key`);
  }
  assert.deepEqual(rulesOf('const process = 1;\nexport const value = { process };\n'), ['host-global']);
  for (const name of HOST_MEMBERS) {
    assert.deepEqual(rulesOf(`export const value = (text: string) => text.${name}();\n`), ['host-member'], name);
    assert.deepEqual(rulesOf(`export const value = (text: string) => text['${name}'];\n`), ['host-member'], name);
  }
  assert.deepEqual(rulesOf('export const { normalize } = String.prototype;\n'), ['host-member']);
  assert.deepEqual(rulesOf('export const value = Math.random();\n'), ['host-member']);
  assert.deepEqual(rulesOf('export const value = Math.max(1, 2);\n'), []);

  assert.deepEqual(rulesOf('export const word = /\\p{L}+/u;\n'), ['regexp']);
  assert.deepEqual(rulesOf('export const word = /\\P{L}/u;\n'), ['regexp']);
  assert.deepEqual(rulesOf('export const word = /\\\\p{L}/u;\n'), [], 'an escaped backslash before p is no escape');
  assert.deepEqual(rulesOf('export const word = (source: string) => new RegExp(source);\n'), ['regexp']);
  assert.deepEqual(rulesOf("export const word = new RegExp('a', 'gi');\n"), ['regexp']);
  assert.deepEqual(rulesOf("export const word = RegExp('\\\\p{L}', 'u');\n"), ['regexp']);
  assert.deepEqual(rulesOf("export const word = new RegExp('^a+$', 'gu');\n"), []);

  assert.deepEqual(rulesOf("export * from 'node:path';\n"), ['specifier']);
  assert.deepEqual(rulesOf("export const load = () => import('node:fs');\n"), ['specifier']);
  assert.deepEqual(rulesOf('export const load = (name: string) => import(name);\n'), ['specifier']);
  assert.deepEqual(rulesOf("import fs = require('fs');\nexport const read = fs;\n"), ['specifier']);
  assert.deepEqual(rulesOf("export const fs = require('node:fs');\n", 'probe.mjs'), ['specifier', 'host-global']);
  assert.deepEqual(rulesOf("import type { Stats } from 'node:fs';\nexport type S = Stats;\n"), ['specifier']);
  assert.deepEqual(rulesOf("import { z } from 'zod';\nexport * from './json.ts';\nexport const s = z;\n"), []);
  assert.deepEqual(rulesOf("export declare const s: import('zod').ZodString;\n", 'probe.d.mts'), []);
  assert.deepEqual(rulesOf("export declare const s: import('node:fs').Stats;\n", 'probe.d.mts'), ['node-types']);
  assert.deepEqual(rulesOf('/// <reference types="node" />\nexport {};\n', 'probe.d.mts'), ['node-types']);
});
