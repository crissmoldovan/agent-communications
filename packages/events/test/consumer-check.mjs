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
  `events consumer check: imports, canonical JSON, no node: or require( in ${shipped.length} dist files, no bin OK`,
);
