// Runs inside a fresh project that installed the packed tarball (scripts/verify-package.mjs).
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as events from '@agentcomms/events';

/*
 * The installed package imports in a fresh project, and nothing it ships reaches a Node module (events phase A plan,
 * decision 3, layer 5; PKG-d). A browser bundler resolving it would find no `node:` edge and no `require(`.
 */

// It imports, and its canonical JSON is the one the vectors pin (test/vectors/canonical-json.json).
const order = { '｡': 1, '\u{1F600}': 2 };
const cases = [
  [order, '{"\u{1F600}":2,"｡":1}'],
  [
    { b: { d: 1, c: [{ z: true, a: null }] }, a: 'x', dropped: undefined },
    '{"a":"x","b":{"c":[{"a":null,"z":true}],"d":1}}',
  ],
  [{ z: -0, n: [2 ** 53, 1e21] }, '{"n":[9007199254740992,1e+21],"z":0}'],
  [['\uD800', 'a\uDC00b'], '["\\ud800","a\\udc00b"]'],
];
for (const [input, canonical] of cases) assert.equal(events.canonicalJson(input), canonical);
assert.throws(() => events.canonicalJson([undefined]), events.EventsError);
assert.equal(events.compareUtf8('｡', '\u{1F600}'), -1);

// Event identity, through the installed package's own WebCrypto call (test/vectors/event-id.json's first vector).
const identity = {
  installationId: '00112233445566778899aabbccddeeff',
  accountId: 'ibx_TESTINBOX0000001',
  eventType: 'gmail.message.received',
  typeVersion: 1,
  dedupeKey: '["123456","18f00000000000a1","received"]',
};
assert.equal(
  events.eventIdPreimage(identity),
  '["agentcomms-event-v1","00112233445566778899aabbccddeeff","ibx_TESTINBOX0000001","gmail.message.received",1,"[\\"123456\\",\\"18f00000000000a1\\",\\"received\\"]"]',
);
assert.equal(await events.eventId(identity), '9a9231c84c9ef1a5cde18246e5d09a2f');
assert.equal(events.CATALOGUE.length, 7, 'the installed catalogue has every version-1 definition');

// Every file it ships under dist: no `node:` specifier and no `require(`.
const dist = dirname(fileURLToPath(import.meta.resolve('@agentcomms/events')));
const shipped = readdirSync(dist, { recursive: true }).map(String);
assert.ok(shipped.includes('index.mjs') && shipped.includes('index.d.mts'), `dist holds ${shipped.join(', ')}`);
for (const file of shipped) {
  const text = readFileSync(join(dist, file), 'utf8');
  assert.doesNotMatch(text, /["'`]node:/, `dist/${file} names a node: module`);
  assert.doesNotMatch(text, /\brequire\(/, `dist/${file} calls require(`);
}

// A library: no command.
const manifest = JSON.parse(readFileSync(join(dist, '..', 'package.json'), 'utf8'));
assert.equal(manifest.bin, undefined, 'a library has no bin');
assert.deepEqual(manifest.agentcommsPackage, { kind: 'library' });

console.log(
  `events consumer check: imports, canonical JSON, an event id through WebCrypto, no node: or require( in ${shipped.length} dist files, no bin OK`,
);

// --- Pointers and pointer patterns (events phase A plan, Task 9; test/vectors/pointers.json) ---
{
  const parsed = events.parsePointer('/a~1b/~0c');
  assert.deepEqual(parsed, { ok: true, value: ['a/b', '~c'] });
  assert.equal(events.parsePointer('/~2').ok, false);
  assert.equal(events.formatPointer(['a/b', '~c', 0]), '/a~1b/~0c/0');
  const own = JSON.parse('{"__proto__": {"x": 1}, "list": [10, 20]}');
  assert.deepEqual(events.getPointer(own, '/__proto__/x'), { found: true, value: 1 });
  assert.deepEqual(events.getPointer({}, '/constructor'), { found: false });
  assert.throws(() => events.getPointer(own, '/list/01'), events.EventsError);
  assert.equal(events.relatePointers('/a/b', '/a/bc'), 'disjoint');
  assert.equal(events.relatePointers('/to/0', '/to/0/name'), 'ancestor');
  const nested = { a: [{ b: ['x', 'y'] }, { b: [] }, { b: ['z'] }], n: null };
  assert.deepEqual(events.expandPattern(['a', { any: true }, 'b', { any: true }], nested), [
    '/a/0/b/0',
    '/a/0/b/1',
    '/a/2/b/0',
  ]);
  assert.deepEqual(events.expandPattern(['n', 'x'], nested), []);
  assert.equal(events.matchesPattern(['to', { any: true }, 'name'], '/to/12/name'), true);
  assert.equal(events.matchesPattern(['to', { any: true }, 'name'], '/to/01/name'), false);
  console.log('events consumer check: RFC 6901 pointers and pointer patterns, own properties only, OK');
}

// --- Unicode 15.1: NFC and full case folding (events phase A, task 5) ---
// From the bundled tables alone: U+A7CB, assigned in Unicode 16, is its own folding under 15.1, whatever Node's is.
assert.equal(events.UNICODE_VERSION, '15.1.0');
assert.equal(events.nfc('é'), 'é');
assert.equal(events.nfc('क़'), 'क़');
assert.equal(events.caseFold('İ'), 'i̇');
assert.equal(events.caseFold('Ɤ'), 'Ɤ');
assert.equal(events.foldForComparison('STRASSE'), events.foldForComparison('straße'));
console.log('events consumer check: Unicode 15.1 NFC and case folding OK');
// --- end Unicode 15.1 ---

// --- Deterministic conditions and static agentic checks (events phase A, task 12) ---
{
  const definition = events.CATALOGUE.find((entry) => entry.type === 'gmail.message.received');
  assert.ok(definition);
  const condition = events.canonicaliseCondition(definition, { path: '/subject', op: 'equals', value: 'Straße' });
  assert.deepEqual(condition, {
    ok: true,
    value: { path: '/subject', op: 'equals', value: 'Straße', caseSensitive: false },
  });
  assert.equal(
    events.canonicalJson(condition.value),
    '{"caseSensitive":false,"op":"equals","path":"/subject","value":"Straße"}',
  );
  assert.equal(
    events.evaluateCondition(definition, condition.value, { ...definition.examples[0], subject: 'STRASSE' }),
    true,
  );
  assert.equal(events.describeCondition(condition.value), '/subject equals "Straße"');
  assert.deepEqual(events.conditionPointers(condition.value), ['/subject']);
  assert.deepEqual(
    events.canonicaliseAgenticCondition(definition, condition.value, {
      judgeId: 'consumer-check',
      judgeVersion: 1,
      question: '',
      inputs: [],
      threshold: 0,
    }),
    {
      ok: true,
      value: {
        judgeId: 'consumer-check',
        judgeVersion: 1,
        question: '',
        inputs: [],
        threshold: 0,
        onUncertain: 'no-match',
      },
    },
  );
  console.log('events consumer check: deterministic conditions and static agentic checks OK');
}
// --- end deterministic conditions ---

// --- UTS #46 revision 31: the canonical domain (events phase A, task 6) ---
// Bundled and pinned: nontransitional, so ß is kept; a trailing root dot is refused (decision 13).
assert.deepEqual(events.toAsciiDomain('Bücher.Example'), { ok: true, value: 'xn--bcher-kva.example' });
assert.deepEqual(events.toAsciiDomain('faß.de'), { ok: true, value: 'xn--fa-hia.de' });
const rootDot = events.toAsciiDomain('example.com.');
assert.equal(rootDot.ok, false);
assert.deepEqual(
  rootDot.issues.map((issue) => [issue.code, issue.detail]),
  [['DOMAIN_INVALID', ['ROOT_LABEL']]],
);
assert.deepEqual(events.toAsciiDomain('a_b.example').issues?.[0]?.detail, ['V6']);
console.log('events consumer check: UTS #46 domains OK');
// --- end UTS #46 ---

// --- Mapping, provenance and delivery schemas (events phase A, task 13) ---
{
  const definition = events.CATALOGUE[0];
  const event = definition.examples[1];
  const compiled = events.compileMapping(definition, {
    subject: { $path: '/subject' },
    from: { $path: '/from' },
    omitted: { $path: '/body', missing: 'omit' },
  });
  assert.equal(compiled.ok, true);
  if (!compiled.ok) throw new Error('mapping did not compile');
  const mapped = events.evaluateMapping(compiled.value, event);
  const classified = events.classifyMapped(definition, event, mapped);
  assert.deepEqual(
    classified.untrusted.map((entry) => entry.pointer),
    ['/subject', '/from/name', '/omitted'],
  );
  const delivered = events.applyRepresentation(mapped.data, classified, { kind: 'plain' });
  assert.deepEqual(delivered, { subject: event.subject, from: event.from, omitted: event.body });
  assert.equal(
    events.deliverySchema(definition, compiled.value, { kind: 'plain' }, 'rule/one', 1, 'target one', 1).$id,
    'urn:agentcomms:schema:delivery:rule%2Fone:v1:target%20one:v1',
  );
  console.log('events consumer check: mapping, provenance, representation and delivery schema OK');
}
// --- end mapping ---

// --- CloudEvents wire contract (events phase A, task 14) ---
{
  const definition = events.CATALOGUE[0];
  const event = definition.examples[0];
  const cloudEvent = events.buildCloudEvent(definition, event, {
    deliveryId: 'delivery-1',
    installationId: 'installation-1',
    ruleId: 'rule-1',
    ruleVersion: 1,
    targetId: 'target-1',
    targetVersion: 1,
    data: { subject: event.subject },
    untrusted: ['/subject'],
  });
  assert.equal(cloudEvent.type, 'com.agentcomms.gmail.message.received.v1');
  assert.equal(cloudEvent.agentcommsuntrusted, '%2Fsubject');
  assert.equal(events.cloudEventBytes(events.TEST_CLOUD_EVENT), events.TEST_CLOUD_EVENT_BYTES);
  console.log('events consumer check: CloudEvents bytes, D6 type and untrusted extension OK');
}
// --- end CloudEvents wire ---

// --- The semantic formats and exact instants (events phase A, task 7) ---
// Never through Date: a Slack ts's microseconds survive, and .1 is .100000.
assert.equal(events.compareInstants('2024-05-01T12:00:00.000999Z', '2024-05-01T12:00:00.001Z'), -1);
assert.equal(events.compareInstants('2024-05-01T14:00:00+02:00', '2024-05-01T12:00:00.100000Z'), -1);
assert.equal(events.compareInstants('2024-05-01T12:00:00.1Z', '2024-05-01T12:00:00.100000Z'), 0);
assert.equal(events.isInstant('2024-05-01T12:00:00'), false);
assert.equal(events.isFormat('uuid', '123E4567-E89B-12D3-A456-426614174000'), true);
assert.equal(events.isFormat('uri', '/relative'), false);
assert.equal(events.isFormat('domain', 'example.com.'), false);
assert.equal(events.isFormat('email', 'Someone@example.com'), true);
assert.deepEqual(events.canonicalEmail('Someone@Bücher.Example'), { ok: true, value: 'Someone@xn--bcher-kva.example' });
console.log('events consumer check: the five semantic formats and exact instants OK');
// --- end semantic formats ---

// --- Bundled Unicode licence (events phase A, task 15) ---
assert.match(
  readFileSync(join(dist, '..', 'THIRD_PARTY_LICENSES'), 'utf8'),
  /unicode-character-database@15\.1\.0 — Unicode-3\.0/u,
);
console.log('events consumer check: bundled Unicode licence OK');
// --- end bundled Unicode licence ---
