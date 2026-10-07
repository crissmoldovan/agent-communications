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
