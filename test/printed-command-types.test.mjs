import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { API } from 'typescript/unstable/sync';

/*
 * The compile-time half of CUE-403 task 15 (design 2026-10-04, D5; §4 7a and 7e-encapsulation): fixtures that must
 * compile — each way round the two command brands marked `@ts-expect-error`, so a way that compiled would leave its
 * directive unused, which is an error of its own — compiled in isolation, with the repository's own compiler options,
 * against the packages' source. The runtime-source half is `printed-command-construction.test.mjs`.
 *
 * Isolated: a program of its own for the fixtures, its configuration given to the compiler in memory, and anything
 * else read from disk as it is — or, for a mutation check below, as a test says a source file reads.
 */

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const FIXTURES = join(ROOT, 'test', 'fixtures', 'printed-commands', 'compile');
/** The compiler names paths with forward slashes on every platform, Windows' drive letters included. */
const slash = (path) => path.replace(/\\/g, '/');
const key = (path) => (process.platform === 'win32' ? slash(path).toLowerCase() : slash(path));

/** The fixtures, found rather than listed, so a new one is compiled too. */
function fixtures() {
  return readdirSync(FIXTURES)
    .filter((name) => name.endsWith('.ts'))
    .sort()
    .map((name) => join(FIXTURES, name));
}

/**
 * Compiles `files` as one program, with `tsconfig.base.json`'s options, and returns every diagnostic as
 * `{ file, line, code, text }`. `overrides` maps a source file's path to the text it is to be read as, for a mutation.
 */
export function compile(files, overrides = new Map()) {
  const config = join(FIXTURES, 'tsconfig.compile.json');
  const virtual = new Map([
    [
      key(config),
      JSON.stringify({
        extends: slash(join(ROOT, 'tsconfig.base.json')),
        compilerOptions: { noEmit: true },
        files: files.map(slash),
      }),
    ],
    ...[...overrides].map(([path, text]) => [key(path), text]),
  ]);
  const api = new API({
    cwd: ROOT,
    fs: {
      // Anything not given here is read from disk: `undefined` hands it back to the compiler's own file system.
      readFile: (name) => virtual.get(key(name)),
      fileExists: (name) => (virtual.has(key(name)) ? true : undefined),
    },
  });
  try {
    const snapshot = api.updateSnapshot({ openProjects: [slash(config)] });
    try {
      const project = snapshot.getProject(slash(config));
      assert.ok(project, 'the fixtures were compiled as a project');
      const found = [
        ...project.program.getConfigFileParsingDiagnostics(),
        ...project.program.getProgramDiagnostics(),
        ...project.program.getGlobalDiagnostics(),
      ].map((diagnostic) => ({
        file: diagnostic.fileName ?? '(program)',
        line: 0,
        code: diagnostic.code,
        text: diagnostic.text,
      }));
      for (const file of files) {
        const source = readFileSync(file, 'utf8');
        for (const diagnostic of [
          ...project.program.getSyntacticDiagnostics(slash(file)),
          ...project.program.getSemanticDiagnostics(slash(file)),
        ]) {
          const text = virtual.get(key(file)) ?? source;
          found.push({
            file: slash(file).slice(slash(ROOT).length),
            line: text.slice(0, diagnostic.pos).split('\n').length,
            code: diagnostic.code,
            text: diagnostic.text,
          });
        }
      }
      return found;
    } finally {
      snapshot.dispose();
    }
  } finally {
    api.close();
  }
}

const said = (diagnostics) =>
  diagnostics.map(({ file, line, code, text }) => `${file}:${line} TS${code} ${text}`).join('\n');

/** TS2578: a `@ts-expect-error` with nothing under it to expect — what a way round the brands that compiled leaves. */
const UNUSED_DIRECTIVE = 2578;

test('every printed-command fixture compiles: each string, forgery and constructor it marks is refused (7a, 7e-encapsulation)', () => {
  const files = fixtures();
  assert.deepEqual(
    files.map((file) => file.slice(FIXTURES.length + 1)),
    ['command-fields.ts', 'encapsulation.ts'],
    'the fixtures this checks',
  );
  const diagnostics = compile(files);
  assert.deepEqual(diagnostics, [], `the fixtures do not compile as written:\n${said(diagnostics)}`);
  // And each fixture marks what it should: the refusals are there to be met.
  for (const file of files) {
    const directives = readFileSync(file, 'utf8').match(/@ts-expect-error/g)?.length ?? 0;
    assert.ok(directives >= 8, `${file} marks ${directives} refusals`);
  }
});

/*
 * The harness is not blind: each of these, read in place of the real source, is a way round a brand that compiles —
 * and the fixture that guards it stops compiling, with its directive left unused. The mutations the plan lists are
 * applied by hand too (see the commit); these few stay here so the check cannot quietly become a no-op.
 */
const MUTATIONS = [
  {
    name: 'the locator exports its gate',
    file: 'packages/core/src/cli-command.ts',
    from: "const GATE: unique symbol = Symbol('locateCliCommand');",
    to: "export const GATE: unique symbol = Symbol('locateCliCommand');",
    fixture: 'encapsulation.ts',
  },
  {
    name: 'the locator exports its class as a value',
    file: 'packages/core/src/cli-command.ts',
    from: 'export type { PrintedCommand };',
    to: 'export { PrintedCommand };',
    fixture: 'encapsulation.ts',
  },
  {
    // Was the update stop's `UpdateWays`, retired with the stop (design 2026-10-16, U1): the next command field the
    // same fixture guards, so the mutation still proves `command-fields.ts` is not blind.
    name: 'the change policy’s tightening command takes a string',
    file: 'packages/core/src/operations/change-policy.ts',
    from: '    command: Handoff;\n    /** From a chat: this tool, with these arguments. */',
    to: '    command: Handoff | string;\n    /** From a chat: this tool, with these arguments. */',
    fixture: 'command-fields.ts',
  },
  {
    name: 'inlineCommand takes a string',
    file: 'packages/core/src/cli-runtime.ts',
    from: 'export function inlineCommand(command: PrintedCommand | ExternalCommand): string {',
    to: "export function inlineCommand(command: PrintedCommand | ExternalCommand | string): string {\n  if (typeof command === 'string') return command;",
    fixture: 'command-fields.ts',
  },
];

for (const mutation of MUTATIONS) {
  test(`the compile harness fails when ${mutation.name}`, () => {
    const path = join(ROOT, mutation.file);
    const source = readFileSync(path, 'utf8');
    assert.ok(source.includes(mutation.from), `${mutation.file} no longer reads as the mutation expects`);
    const diagnostics = compile(
      [join(FIXTURES, mutation.fixture)],
      new Map([[path, source.replace(mutation.from, mutation.to)]]),
    );
    assert.ok(
      diagnostics.some(({ code, file }) => code === UNUSED_DIRECTIVE && file.endsWith(mutation.fixture)),
      `${mutation.name}: the fixture still compiled:\n${said(diagnostics)}`,
    );
  });
}
