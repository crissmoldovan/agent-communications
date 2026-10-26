import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, sep } from 'node:path';
import { test } from 'node:test';
import { repositoryTestSources, ruleLiteralSites } from '../scripts/rule-fixtures/sites.ts';
import { type JsonObject, parseRuleText, printRuleText } from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * Every rule fixture in the repository round-trips through the rule text (0.33.0 design §3.2): printing then parsing
 * gives the same document, and printing is stable. The rules the TypeScript tests build are harvested into
 * `fixtures/rule-text/repository-rules.json` by `scripts/rule-fixtures/harvest.mjs`, and counted again here, file by
 * file, so a rule literal added anywhere fails until it is harvested. The JSON fixtures are read where they are, so a
 * new one is covered as soon as it lands.
 */

const REPOSITORY = join(PACKAGE_ROOT, '..', '..');

interface Fixture {
  readonly from: string;
  readonly document: JsonObject;
}

const isRule = (value: object): value is JsonObject =>
  !Array.isArray(value) && Object.hasOwn(value, 'ruleId') && Object.hasOwn(value, 'deliveryRateCap');

/** The repository's files under a test folder, outside this package, by extension. */
function testFiles(extensions: readonly string[]): string[] {
  const found: string[] = [];
  const visit = (directory: string) => {
    for (const entry of readdirSync(join(REPOSITORY, directory), { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name.startsWith('.')) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (extensions.some((extension) => entry.name.endsWith(extension))) found.push(path.split(sep).join('/'));
    }
  };
  for (const root of ['packages', 'apps', 'test']) visit(root);
  return found
    .filter((path) => path.includes('/test/') || path.startsWith('test/'))
    .filter((path) => !path.startsWith('packages/events/'))
    .sort();
}

/** Every rule document in the JSON test fixtures, including one held as JSON text inside a fixture. */
function jsonFixtures(): Fixture[] {
  const found: Fixture[] = [];
  const visit = (value: unknown, from: string) => {
    if (typeof value === 'string') {
      const text = value.trim();
      if (!text.startsWith('{') && !text.startsWith('[')) return;
      try {
        visit(JSON.parse(text), `${from}(json)`);
      } catch {
        return;
      }
      return;
    }
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries()) visit(item, `${from}/${index}`);
    } else if (typeof value === 'object' && value !== null) {
      if (isRule(value)) found.push({ from, document: value });
      for (const [key, member] of Object.entries(value)) visit(member, `${from}/${key}`);
    }
  };
  for (const path of testFiles(['.json'])) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(REPOSITORY, path), 'utf8'));
    } catch {
      continue;
    }
    visit(parsed, `${path}#`);
  }
  return found;
}

const HARVESTED = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'rule-text', 'repository-rules.json'), 'utf8'),
) as {
  readonly literals: Readonly<Record<string, number>>;
  readonly rules: readonly { readonly from: readonly string[]; readonly document: JsonObject }[];
};

const FIXTURES: readonly Fixture[] = [
  ...HARVESTED.rules.map((rule) => ({ from: rule.from[0] as string, document: rule.document })),
  ...jsonFixtures(),
];

/**
 * The fixtures whose text needs the escape form, and the lines that carry it. Each is a document the event service
 * would refuse or has not finished: a partial one built for one step, an authoring condition without its explicit
 * `caseSensitive`, no targets, or a queue rule whose retention has no `queueMs`. A canonical rule never needs one.
 */
const ESCAPED: Readonly<Record<string, readonly string[]>> = {
  // `event: { version: 1 }` with no type, and no source: the test adds them per channel.
  'packages/events-daemon/test/activation-documents.test.ts': ['raw /event =', 'raw /source absent'],
  // An empty condition, refused by the consumer contract.
  'packages/events-daemon/test/b3-consumer-contract.test.ts': ['match raw'],
  // `options: {}` and the event as a test parameter.
  'packages/events-daemon/test/d-source-events.test.ts': ['raw /event =', 'raw /source ='],
  // A rule with no targets, for a source-option check.
  'packages/events-daemon/test/disclosure-fence.test.ts': ['raw /targets ='],
  // The common part of a rule; each case adds its source and event.
  'packages/events-daemon/test/event-taint-platform.test.ts': ['raw /event absent', 'raw /source absent'],
  // An authoring condition: contains without caseSensitive.
  'packages/events-daemon/test/judge-documents.test.ts': ['match raw'],
  // Retention with only the fields the store reads.
  'packages/events-daemon/test/lane-store.test.ts': ['raw /retention ='],
  'packages/events-daemon/test/queue-store.test.ts': ['raw /retention ='],
  // A queue rule whose retention has no queueMs.
  'packages/events-daemon/test/queue-domain.test.ts': ['raw /retention ='],
  // A rule with no targets yet.
  'packages/events-daemon/test/phase-d-owner-e2e.test.ts': ['raw /targets ='],
  // Partial rules written straight into the store.
  'packages/events-daemon/test/sse-persistence-auth.test.ts': [
    'raw /condition absent',
    'raw /event absent',
    'raw /judges absent',
    'raw /retention =',
    'raw /source absent',
  ],
  'packages/events-daemon/test/support/browser-sse-fixture.ts': [
    'raw /condition absent',
    'raw /event absent',
    'raw /judges absent',
    'raw /retention =',
    'raw /source absent',
  ],
  // `condition: {}` in the control contract's request vectors.
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/desktop-operation-requests.json#/12/request/args/document':
    ['match raw'],
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/desktop-operation-requests.json#/13/request/args/document':
    ['match raw'],
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/error-vectors.json#/1/request/args/document': [
    'match raw',
  ],
  'packages/events-daemon/test/fixtures/b3-control-contract-v1/operation-requests.json#/0/request/args/document': [
    'match raw',
  ],
};

/** The escape lines of a printed rule, by their start: `raw /retention =`, `raw /source absent`, `match raw`. */
function escapes(text: string): string[] {
  const found = new Set<string>();
  for (const line of text.split('\n')) {
    const top = /^raw (\S+) (=|absent)/.exec(line);
    if (top !== null) found.add(`raw ${top[1]} ${top[2]}`);
    else if (/^\s*(match )?(not )*raw /.test(line)) found.add(/^match/.test(line) ? 'match raw' : 'raw item');
  }
  return [...found].sort();
}

test('the repository has rule fixtures to check: the harvested TypeScript ones and the JSON ones', () => {
  assert.ok(HARVESTED.rules.length >= 150, `${HARVESTED.rules.length} harvested rules`);
  assert.ok(FIXTURES.length - HARVESTED.rules.length >= 18, 'the JSON fixtures hold rule documents');
});

test('every rule fixture in the repository round-trips through the rule text, and prints the same text twice', () => {
  for (const { from, document } of FIXTURES) {
    const text = printRuleText(document);
    const parsed = parseRuleText(text);
    assert.ok(parsed.ok, `${from} parses back:\n${text}\n${JSON.stringify(parsed)}`);
    assert.deepStrictEqual(parsed.doc, document, `${from} round-trips through:\n${text}`);
    assert.equal(printRuleText(parsed.doc), text, `${from} prints the same text twice`);
  }
});

test('only a fixture the event service would refuse needs the escape form, and only where it is odd', () => {
  const found: Record<string, string[]> = {};
  for (const { from, document } of FIXTURES) {
    const lines = escapes(printRuleText(document));
    // A harvested literal by its file, so an edit above it in the test does not move it; a JSON one by its place.
    const where = from.includes('#') ? from : (from.split(':')[0] as string);
    if (lines.length > 0) found[where] = [...new Set([...(found[where] ?? []), ...lines])].sort();
  }
  assert.deepEqual(found, ESCAPED);
});

test('the harvest holds every rule literal of every test file: a fresh count, file by file, matches it', () => {
  const counted = Object.fromEntries(
    [...ruleLiteralSites(repositoryTestSources(REPOSITORY))].map(([path, file]) => [path, file.sites.length]),
  );
  assert.deepEqual(
    counted,
    HARVESTED.literals,
    'a test file has a rule literal the harvest does not: run pnpm build, then pnpm --filter @agentcomms/events harvest:rule-fixtures',
  );
});

test('the count sees a literal added to a file it already counts, a spread copy, a helper, and a new file', () => {
  const counted = ruleLiteralSites([
    {
      path: 'packages/x/test/one.test.ts',
      text: [
        'const rule = { ruleId: "a", version: 1, targets: [], deliveryRateCap: 1 };',
        'function ruleFor(cap: number) { return { ...rule, deliveryRateCap: cap }; }',
        'const shorthand = (deliveryRateCap: number) => ({ ruleId: "b", targets: [], deliveryRateCap });',
        'const notARule = { deliveryRateCap: 1 };',
        'const sql = \'{"deliveryRateCap":1,"targets":[]}\';',
        'ruleFor(2);',
      ].join('\n'),
    },
    { path: 'packages/x/test/two.test.mjs', text: 'export const r = { targets: [], deliveryRateCap: 3 };' },
    { path: 'packages/x/test/none.test.ts', text: 'const deliveryRateCap = 1;' },
  ]);
  assert.deepEqual(
    Object.fromEntries(
      [...counted].map(([path, file]) => [path, file.sites.map((site) => [site.line, site.helper ?? null])]),
    ),
    {
      'packages/x/test/one.test.ts': [
        [1, null],
        [2, 'ruleFor'],
        [3, 'shorthand'],
      ],
      'packages/x/test/two.test.mjs': [[1, null]],
    },
  );
  assert.equal(counted.get('packages/x/test/one.test.ts')?.calls.length, 1, 'the helper call the harvester tries');
});
