import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';

assertLoopbackSeal();

/**
 * E2 CI round 1: no E2 test may wait without a bound. `node --test` gives a test none, and Node 24 keeps a test whose
 * awaited promise never settles pending for ever (Node 22 cancels it once the event loop drains): on windows-latest
 * with Node 24 one boundary test held its job for 5.7 hours. So every E2 test that starts or awaits a child, a
 * listener, an owner or a worker declares its own `timeout`, and this reads every E2 test file to hold that.
 */
const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));

/**
 * Node's own ways to start a process or open a socket, as a test, or a helper in its file, calls them. A bare call of
 * `exec` is child_process's; a method call of it is a regular expression's, and starts nothing.
 */
const STARTS =
  /\b(?:spawn|spawnSync|execFile|execFileSync|execSync|fork|createServer|createSecureServer|createSocket|connect|request|fetch)\s*\(|(?<![.\w$])exec\s*\(|\.listen\(/u;

/** What an E2 test imports that starts a process, a listener, an owner or a worker, or runs an oracle that does. */
const IMPORTED_STARTERS: ReadonlySet<string> = new Set([
  'createLayaWorkerBoundary',
  'createLayaWorkerBoundaryForTest',
  'LayaWorkerSupervisor',
  'startEventOwner',
  'runStrictMutationChild',
  'expectLayaMutationToFail',
  'expectEveryLayaMutationToFail',
  'copyRepositoryTree',
  'sandboxExecAvailable',
  'runBoundaryGate',
  'runProductionChecks',
  'egressCheck',
  'startLoopbackReceiver',
  'startLoopbackTlsReceiver',
]);

const TOP_LEVEL =
  /^(?:export\s+)?(?:(?:async\s+function|function|const|let|class|interface|type|for|if|await)\b|test\()/gmu;
const NAMED = /^(?:export\s+)?(?:async\s+function|function|const|let|class)\s+([A-Za-z0-9_$]+)/u;
const IMPORT = /^import\s+(?:type\s+)?(?:\{([^}]*)\}|\*\s+as\s+([A-Za-z0-9_$]+))\s+from\s/gmu;

function mentions(text: string, name: string): boolean {
  return new RegExp(`(?<![\\w$])${name.replaceAll('$', '\\$')}(?![\\w$])`, 'u').test(text);
}

/**
 * The tests in one file's source that start or await a process, a listener, an owner or a worker — directly, through a
 * helper declared in the same file, or through an imported starter — and declare no `timeout`.
 */
function unboundedChildTests(source: string): readonly string[] {
  const starts = [...source.matchAll(TOP_LEVEL)].map((match) => match.index);
  const blocks = starts.map((at, index) => source.slice(at, starts[index + 1] ?? source.length));
  const imported = new Set(
    [...source.matchAll(IMPORT)].flatMap((match) =>
      (match[2] ?? match[1] ?? '')
        .split(',')
        .map(
          (part) =>
            part
              .trim()
              .replace(/^type\s+/u, '')
              .split(/\s+as\s+/u)
              .at(-1) ?? '',
        )
        .filter((name) => IMPORTED_STARTERS.has(name)),
    ),
  );
  const tainted = new Set(imported);
  const named = blocks.flatMap((text) => {
    const name = NAMED.exec(text)?.[1];
    return name === undefined ? [] : [{ name, text }];
  });
  for (let grew = true; grew; ) {
    grew = false;
    for (const { name, text } of named) {
      if (tainted.has(name)) continue;
      if (STARTS.test(text) || [...tainted].some((starter) => mentions(text, starter))) {
        tainted.add(name);
        grew = true;
      }
    }
  }
  return blocks.flatMap((text) => {
    if (!text.startsWith('test(')) return [];
    const head = text.slice(0, Math.max(0, text.indexOf('=>')));
    if (/\btimeout\s*:/u.test(head)) return [];
    if (!STARTS.test(text) && ![...tainted].some((starter) => mentions(text, starter))) return [];
    return [/^test\(\s*(['"`])((?:\\.|(?!\1).)*)\1/su.exec(text)?.[2] ?? text.slice(0, 80)];
  });
}

function e2TestFiles(): readonly string[] {
  const daemon = readdirSync(join(repositoryRoot, 'packages/events-daemon/test'))
    .filter((name) => /^laya-.+\.test\.(?:ts|mjs)$/u.test(name))
    .map((name) => `packages/events-daemon/test/${name}`);
  const root = readdirSync(join(repositoryRoot, 'test'))
    .filter((name) => /^laya-.+\.test\.mjs$/u.test(name))
    .map((name) => `test/${name}`);
  return [...daemon, ...root];
}

test('E2 CI round 1: the bound check finds a child started directly, through a helper or by an import, and nothing else', () => {
  // Specimens are built from parts, so this file's own text starts nothing the check would read.
  const call = (name: string) => `${name}(`;
  const declare = (name: string, options: string, body: string) =>
    ['te', `st('${name}', ${options}async () => {\n  ${body}\n});\n`].join('');
  const helper = ['async function', ` startIt() {\n  ${call('spa' + 'wn')}'x');\n}\n`].join('');
  const specimen = [
    ['im', "port { createLayaWorkerBoundaryForTest } from './probe.ts';\n"].join(''),
    helper,
    declare('direct', '', `${call('spa' + 'wn')}'x');`),
    declare('through a helper', '', 'await startIt();'),
    declare('through an import', '', 'await createLayaWorkerBoundaryForTest({});'),
    declare('bounded', '{ timeout: 1_000 }, ', 'await startIt();'),
    declare('pure', '', 'assert.equal(1, 1);'),
  ].join('\n');
  assert.deepEqual(unboundedChildTests(specimen), ['direct', 'through a helper', 'through an import']);
});

test('E2 CI round 1: every E2 test that starts or awaits a child, a listener, an owner or a worker has its own timeout', () => {
  const files = e2TestFiles();
  assert.ok(files.includes('packages/events-daemon/test/laya-boundary.test.ts'));
  assert.ok(files.includes('test/laya-release-gate.test.mjs'));
  const unbounded = files.flatMap((file) =>
    unboundedChildTests(readFileSync(join(repositoryRoot, file), 'utf8')).map((name) => `${file}: ${name}`),
  );
  assert.deepEqual(unbounded, [], 'each of these can wait for ever on Node 24');
});
