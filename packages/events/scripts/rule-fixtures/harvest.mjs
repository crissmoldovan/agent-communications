/**
 * Harvests every rule document the repository's tests build into `test/fixtures/rule-text/repository-rules.json`, for
 * the rule text's round-trip test, without running a test body.
 *
 *     pnpm build
 *     pnpm --filter @agentcomms/events harvest:rule-fixtures
 *
 * For each test file with a rule literal (`sites.ts` finds them by syntax), it writes a copy of the module beside it in
 * which each literal records its value as JSON, with `node:test` stubbed out so no test body runs, and evaluates that
 * copy under the repository's loopback seal. The module's top level makes its constants and helpers; a helper is called
 * where the file calls it, when the arguments need nothing local; a literal that reads a test's locals is evaluated
 * with the values `locals.mjs` gives for them. The fixture keeps each distinct document once, with every literal it
 * came from, and how many literals each file has, which `rule-text-fixtures.test.ts` compares with a fresh count.
 *
 * It exits 1, naming them, when a literal could not be evaluated: give that literal's locals in `locals.mjs`. The test
 * modules import the built workspace packages, so build first.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonicalJson } from '../../src/index.ts';
import LOCALS from './locals.mjs';
import { repositoryRoot, repositoryTestSources, ruleLiteralSites } from './sites.ts';

const repository = repositoryRoot();
const here = import.meta.dirname;
const fixture = join(here, '..', '..', 'test', 'fixtures', 'rule-text', 'repository-rules.json');
const stub = pathToFileURL(join(here, 'stub-node-test.mjs')).href;
const record = pathToFileURL(join(here, 'record.mjs')).href;
const seal = pathToFileURL(join(repository, 'test', 'helpers', 'loopback-seal-preload.mjs')).href;

const isRule = (value) =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.hasOwn(value, 'ruleId') &&
  Object.hasOwn(value, 'deliveryRateCap');

/** A literal evaluated with its locals: every free name resolves to a local, else to the module's own binding. */
function withLocals(ordinal, text, variant) {
  let body = text;
  for (const [from, to] of variant.__replace ?? []) body = body.split(from).join(to);
  const locals = Object.entries(variant).filter(([name]) => name !== '__each' && name !== '__replace');
  return `try {
  for (const __item of ${variant.__each ?? '[undefined]'}) {
    const __locals = { ${locals.map(([name, expression]) => `${JSON.stringify(name)}: (${expression})`).join(', ')} };
    const __scope = new Proxy({}, {
      has: (_, name) => typeof name === 'string' && (Object.hasOwn(__locals, name) || !(name in globalThis)),
      get: (_, name) => (name === Symbol.unscopables ? undefined : Object.hasOwn(__locals, name) ? __locals[name] : __harvestResolve(name)),
    });
    globalThis.__harvest(${ordinal}, new Function('__scope', ${JSON.stringify(`with (__scope) { return (${body}); }`)})(__scope));
  }
} catch (error) {
  globalThis.__harvestError(${ordinal}, error);
}
`;
}

/** The module copy that records its rule literals, and what to evaluate after its body. */
function instrumented(source, file) {
  const typed = source.path.endsWith('.ts') || source.path.endsWith('.mts');
  const js = typed ? stripTypeScriptTypes(source.text, { mode: 'strip' }) : source.text;
  let body = js;
  for (const site of [...file.sites].sort((left, right) => right.start - left.start))
    body = `${body.slice(0, site.start)}globalThis.__harvest(${site.ordinal}, (${body.slice(site.start, site.end)}))${body.slice(site.end)}`;
  body = body.replace(/from\s+(['"])node:test\1/g, `from '${stub}'`);
  // A direct eval in the module's scope: what a literal evaluated with its locals reads of the module's own bindings.
  let tail = '\n;\nconst __harvestResolve = (__name) => eval(__name);\n';
  for (const site of file.sites) {
    const text = js.slice(site.start, site.end);
    const variants = LOCALS[`${source.path}#${site.ordinal}`];
    if (variants !== undefined) for (const variant of variants) tail += withLocals(site.ordinal, text, variant);
    else if (site.inFunction)
      tail += `try { globalThis.__harvest(${site.ordinal}, (${text})); } catch (error) { globalThis.__harvestError(${site.ordinal}, error); }\n`;
  }
  for (const call of file.calls)
    tail += `await globalThis.__harvestTry(async () => (${js.slice(call.start, call.end)}));\n`;
  return body + tail;
}

const sources = repositoryTestSources(repository);
const sites = ruleLiteralSites(sources);
const scratch = mkdtempSync(join(tmpdir(), 'agentcomms-rule-harvest-'));
const literals = {};
const documents = new Map();
const unevaluated = [];
try {
  for (const source of sources) {
    const file = sites.get(source.path);
    if (file === undefined) continue;
    literals[source.path] = file.sites.length;
    const copy = join(dirname(join(repository, source.path)), `.harvest-${basename(source.path)}.tmp.mjs`);
    const out = join(scratch, `${Object.keys(literals).length}.json`);
    writeFileSync(copy, instrumented(source, file));
    let run;
    try {
      run = spawnSync(
        process.execPath,
        [
          '--experimental-strip-types',
          '--disable-warning=ExperimentalWarning',
          '--import',
          seal,
          '--import',
          record,
          copy,
        ],
        { cwd: repository, env: { ...process.env, HARVEST_OUT: out }, timeout: 120_000, encoding: 'utf8' },
      );
    } finally {
      rmSync(copy, { force: true });
    }
    const captured = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : [];
    for (const site of file.sites) {
      const evaluated = captured.filter((entry) => entry.ordinal === site.ordinal && Object.hasOwn(entry, 'value'));
      // A literal can evaluate to part of a rule (`Object.assign(rule, { targets, deliveryRateCap })`): no document.
      const values = evaluated.filter((entry) => isRule(entry.value));
      if (evaluated.length === 0) {
        const why =
          captured.find((entry) => entry.ordinal === site.ordinal && entry.error)?.error ?? run.stderr?.trim();
        unevaluated.push(`${source.path}#${site.ordinal} (line ${site.line}): ${(why ?? 'no value').split('\n')[0]}`);
      }
      for (const { value } of values) {
        const key = canonicalJson(value);
        const from = `${source.path}:${site.line}`;
        const known = documents.get(key);
        if (known === undefined) documents.set(key, { from: [from], document: value });
        else if (!known.from.includes(from)) known.from.push(from);
      }
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

writeFileSync(
  fixture,
  `${JSON.stringify(
    {
      about:
        'Every rule document the TypeScript tests of this repository build, harvested by packages/events/scripts/rule-fixtures/harvest.mjs without running a test body. from names each literal by file and line; literals counts each file’s rule literals, which rule-text-fixtures.test.ts compares with a fresh count. The JSON fixtures are not copied here: that test reads them where they are.',
      literals,
      rules: [...documents.values()],
    },
    null,
    2,
  )}\n`,
);
// The repository's formatter, so the written fixture is the one its lint accepts.
spawnSync(
  process.execPath,
  [join(repository, 'node_modules', '@biomejs', 'biome', 'bin', 'biome'), 'format', '--write', fixture],
  {
    stdio: 'ignore',
  },
);

const count = Object.values(literals).reduce((total, each) => total + each, 0);
process.stdout.write(
  `Harvested ${documents.size} rule documents from ${count} literals in ${Object.keys(literals).length} files into ${fixture}\n`,
);
if (unevaluated.length > 0) {
  process.stderr.write(
    `These literals could not be evaluated; give their locals in locals.mjs:\n  ${unevaluated.join('\n  ')}\n`,
  );
  process.exitCode = 1;
}
