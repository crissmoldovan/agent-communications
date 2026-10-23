import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createScanner } from 'typescript/unstable/ast/scanner';
import { codeImportSpecifiers, codeOnly, valueImports } from '../scripts/verify-events-phase-e2-tests.mjs';

/*
 * 0.26.0 R3: the E2 checker reads a file's imports with TypeScript's own tokenizer. Its old character scanner took an
 * apostrophe inside a regular expression for the start of a string, so an import after it went unread, and its
 * comment stripper took a `/*` inside a string for the start of a comment.
 */

const checker = fileURLToPath(new URL('../scripts/verify-events-phase-e2-tests.mjs', import.meta.url));

test('an apostrophe in a regular expression does not hide a later import', () => {
  assert.ok(codeImportSpecifiers("const q = /'/;\nimport '@receptron/laya';\n").includes('@receptron/laya'));
  // TypeScript ends a string that a misread quote opened at the line's end, so each specimen below puts the import on
  // the regular expression's own line: a quote of each kind, a flag, a class and an escaped slash, after each kind of
  // token a regular expression follows, and a backtick, whose template would run on past the line.
  const specimens = [
    "const q = /'/g; import '@receptron/laya';\n",
    'const q = /"/; import "@receptron/laya";\n',
    'const q = /`/;\nconst r = 1;\nimport "@receptron/laya";\n',
    "if (/[']/.test(text)) run(); import '@receptron/laya';\n",
    "function f() {\n  return /\\/'/; } import '@receptron/laya';\n",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    "const t = `${{ q: /'/ }.q}`; import '@receptron/laya';\n",
    "for (const m of /'/g.exec(text) ?? []) run(m); import '@receptron/laya';\n",
    "async function f() { return await /'/.source; } import '@receptron/laya';\n",
  ];
  for (const source of specimens) {
    assert.deepEqual(codeImportSpecifiers(source), ['@receptron/laya'], source);
    assert.deepEqual(valueImports(source), ['@receptron/laya'], source);
  }
  // A division is not a regular expression: the quote after it opens a string, and the import after that is read. A
  // word that names a value divides too: a contextual keyword, a keyword after `.`, and a private name.
  for (const value of ['total', '(total) / count', 'number', 'type', 'options.default', 'this.#count'])
    assert.deepEqual(
      codeImportSpecifiers(`const part = ${value} / 2; const s = '/'; import '@receptron/laya';\n`),
      ['@receptron/laya'],
      value,
    );
});

test("a regular expression after a statement's head or a block's end does not hide a later import", () => {
  /*
   * 0.26.0 review B, finding 4. The reader took every `)` and every `}` for the end of an expression, so a `/` after
   * the head of an `if`, a `while`, a `for` or a `with`, or after a block, divided: a quote in the regular expression
   * opened a string, and an import after it on that line went unread; a backtick opened a template, which hid every
   * import after it up to the file's next backtick.
   */
  const specimens = [
    "if (ok) /'/.test(s); import '@receptron/laya';\n",
    'while (ok) /"/.exec(s); import "@receptron/laya";\n',
    "for (const x of xs) /'/.test(x); import '@receptron/laya';\n",
    "for await (const x of xs) /'/.test(x); import '@receptron/laya';\n",
    "with (o) /'/.test(s); import '@receptron/laya';\n",
    "if (f(x)) /'/.test(s); import '@receptron/laya';\n",
    "if (ok) {} /'/.test(s); import '@receptron/laya';\n",
    "if (ok) {}\n/'/.test(s); import '@receptron/laya';\n",
    "function f() {} /'/.test(s); import '@receptron/laya';\n",
    "class A {} /'/.test(s); import '@receptron/laya';\n",
    "try {} finally {} /'/.test(s); import '@receptron/laya';\n",
    "const f = () => {}\n/'/.test(s); import '@receptron/laya';\n",
    // A backtick, read as a template, ran on to the file's next backtick, past every import between.
    "if (ok) /`/.test(s);\nimport '@receptron/laya';\nconst t = `x`;\n",
    "if (ok) {}\n/`/.test(s);\nimport '@receptron/laya';\nconst t = `x`;\n",
    "while (ok) {}\n/`/.test(s);\nawait import('@receptron/laya');\nconst t = `x`;\n",
  ];
  for (const source of specimens) {
    assert.deepEqual(codeImportSpecifiers(source), ['@receptron/laya'], source);
    assert.deepEqual(valueImports(source), ['@receptron/laya'], source);
  }
  // An object literal's `}`, and a call's `)`, inside a head too, still end an expression: the `/` after one divides,
  // and the quote after that opens a string. A block inside an object literal does not make the literal's `}` a block's.
  for (const value of ['{ a: 1 }', 'count(x)', '(() => 1)()', '{ a: () => {} }'])
    assert.deepEqual(
      codeImportSpecifiers(`const part = ${value} / 2; const s = '/'; import '@receptron/laya';\n`),
      ['@receptron/laya'],
      value,
    );
  assert.deepEqual(codeImportSpecifiers("if (count(x) / 2 > 1) run(); const s = '/'; import '@receptron/laya';\n"), [
    '@receptron/laya',
  ]);
});

test("a comment, a string or a template's text that only mentions a package is not an import", () => {
  const mentions = [
    "// import '@receptron/laya';\n",
    "/* require('@receptron/laya') */\n",
    "/**\n * import x from '@receptron/laya';\n */\n",
    'const s = "import \'@receptron/laya\'";\n',
    'const s = \'export * from "@receptron/laya"\';\n',
    "const t = `import('@receptron/laya')`;\n",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    "const t = `${name} from '@receptron/laya'`;\n",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    "const t = `${`nested ${x}`} require('@receptron/laya')`;\n",
    // An object's `}` inside a substitution closes the object, not the substitution.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    "const t = `${ { a: 1 }.a + /`/.source } import('@receptron/laya')`;\n",
    "const o = { from: '@receptron/laya', import: '@receptron/laya' };\n",
    "const b = Buffer.from('@receptron/laya');\nconst m = module.require('@receptron/laya');\n",
  ];
  for (const source of mentions) {
    assert.deepEqual(codeImportSpecifiers(source), [], source);
    assert.deepEqual(valueImports(source), [], source);
  }
  // And the import beside each mention is still read.
  for (const source of mentions)
    assert.deepEqual(codeImportSpecifiers(`${source}import 'node:net';\n`), ['node:net'], source);
});

test("import type is not a value import; import(), require, export-from and import type from 'x' are", () => {
  const source = [
    "import type { A } from 'type-named';",
    "import type B from 'type-default';",
    "import type * as C from 'type-namespace';",
    "export type { D } from 'type-reexport';",
    "export type * from 'type-star';",
    "import type from 'default-named-type';",
    "import type, { e } from 'default-named-type-and-named';",
    "import { type F, g } from 'mixed';",
    "import * as h from 'namespace';",
    "const i = await import('dynamic');",
    'const j = require("required");',
    'const jj = require(`required-template`);',
    "import k = require('import-equals');",
    "export { l } from 'reexport';",
    "export * from 'star';",
    "import 'bare';",
    '',
  ].join('\n');
  assert.deepEqual(codeImportSpecifiers(source), [
    'type-named',
    'type-default',
    'type-namespace',
    'type-reexport',
    'type-star',
    'default-named-type',
    'default-named-type-and-named',
    'mixed',
    'namespace',
    'dynamic',
    'required',
    'required-template',
    'import-equals',
    'reexport',
    'star',
    'bare',
  ]);
  assert.deepEqual(valueImports(source), [
    'default-named-type',
    'default-named-type-and-named',
    'mixed',
    'namespace',
    'dynamic',
    'required',
    'required-template',
    'import-equals',
    'reexport',
    'star',
    'bare',
  ]);
  // A type-only import and a value import of the same built-in: only the value import counts.
  assert.deepEqual(
    valueImports("import type { Socket } from 'node:net';\nimport { createServer } from 'node:net';\n"),
    ['node:net'],
  );
});

test('codeOnly removes comments, and keeps a // inside a string or a regular expression', () => {
  assert.equal(
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    codeOnly("const url = 'http://127.0.0.1/'; // a note\nconst re = /[//]/; /* a block */ const t = `//${a}`;\n"),
    // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
    "const url = 'http://127.0.0.1/'; \nconst re = /[//]/;  const t = `//${a}`;\n",
  );
  // A `/*` inside a string or a regular expression opens no comment, so the code after it stays.
  assert.equal(
    codeOnly("const glob = 'packages/*/dist';\nimport 'node:net';\n/* the end */\n"),
    "const glob = 'packages/*/dist';\nimport 'node:net';\n\n",
  );
  assert.equal(
    codeOnly("const re = /a\\/*/;\nfetch('http://127.0.0.1/');\n"),
    "const re = /a\\/*/;\nfetch('http://127.0.0.1/');\n",
  );
  // Everything that is not a comment is kept byte for byte.
  // biome-ignore lint/suspicious/noTemplateCurlyInString: source text under test, not a template
  const code = "#!/usr/bin/env node\nconst a = `x${b / 2}y` + '\\'' + \"é\" + /[/*]\\//giu.source;\n";
  assert.equal(codeOnly(code), code);
  assert.equal(codeOnly(`/** doc */\n${code}// last`), `\n${code}`);
});

test("the scanner this reads with is TypeScript's own", () => {
  assert.equal(typeof createScanner, 'function');
  assert.match(
    readFileSync(checker, 'utf8'),
    /^import \{ createScanner \} from 'typescript\/unstable\/ast\/scanner';$/m,
    'the E2 checker reads with the scanner of the repository’s own TypeScript',
  );
});
