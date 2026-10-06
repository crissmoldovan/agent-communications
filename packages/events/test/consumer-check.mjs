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
