import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import * as library from '../src/index.ts';
import { RUNNERS, type VectorFile } from './realm/runners/index.ts';
import { type ConformanceFile, caseFoldingFile, normalizationTestFile } from './support/conformance-sources.ts';
import { createRealm, type Realm, realmBundle } from './support/realm.ts';

/**
 * NFC and full case folding come from the pinned Unicode 15.1 tables alone (events phase A plan, decision 2; UNI-b,
 * UNI-e and CND-e). Unicode's own conformance files, derived from their pinned sources, run here in Node against
 * `src/` and in the bare realm against the browser bundle, and must agree byte for byte; `pnpm verify:browser` runs
 * the same derived files in Chromium and WebKit. The hand vectors are `test/vectors/unicode-folding.json`, which the
 * conformance test runs everywhere too.
 */

let realm: Realm;
before(async () => {
  realm = createRealm(await realmBundle());
});

/** A derived file, in Node and in the realm: no failures in either, and the same results. */
async function inBoth(file: ConformanceFile) {
  const parsed = JSON.parse(file.text) as VectorFile;
  const runner = RUNNERS[parsed.family];
  assert.ok(runner, `no runner for ${parsed.family}`);
  const inNode = await runner(library, parsed);
  assert.deepEqual(inNode.failures, [], `${file.name}, in Node`);
  const inRealm = await realm.run(parsed.family, file.text);
  assert.deepEqual(JSON.parse(inRealm).failures, [], `${file.name}, in the realm`);
  assert.equal(inRealm, JSON.stringify(inNode), `${file.name}: the realm's results differ from Node's`);
  return inNode.results as { name: string; lines?: number; checked?: number; mappings?: number }[];
}

test('UNI-b: NFC meets NormalizationTest 15.1, in Node and in the bare realm', async () => {
  const results = await inBoth(normalizationTestFile());
  const lines = Object.fromEntries(results.map((result) => [result.name, result.lines ?? result.checked]));
  // Every part is there, whole: a parse that dropped lines would pass vacuously. 289 394 code points are assigned in
  // 15.1 (UnicodeData.txt, its ranges included), and Part 1 lists 17 029 of them.
  assert.deepEqual(lines, {
    'NormalizationTest.txt Part0': 25,
    'NormalizationTest.txt Part1': 17029,
    'NormalizationTest.txt Part2': 1844,
    'NormalizationTest.txt Part3': 176,
    'NormalizationTest.txt: every assigned code point Part 1 does not list is its own NFC': 272_365,
  });
});

test('CND-e: full case folding is CaseFolding 15.1’s C and F, never T, and everything else folds to itself', async () => {
  const results = await inBoth(caseFoldingFile());
  assert.deepEqual(
    results.map((result) => [result.name, result.mappings ?? result.checked]),
    [
      ['CaseFolding.txt: every C and F line', 1530],
      ['CaseFolding.txt: a code point with a T or S line folds by its C or F line, or to itself', 33],
      ['CaseFolding.txt: every code point with no C or F line folds to itself', 0x110000 - 1530],
    ],
  );
  // The Turkic mappings are the T lines' and never apply: I is i, İ is i + COMBINING DOT ABOVE.
  assert.equal(library.caseFold('I'), 'i');
  assert.notEqual(library.caseFold('I'), 'ı');
  assert.equal(library.caseFold('İ'), 'i̇');
});

test('UNI-e: no host case mapping: U+A7CB folds to itself under 15.1', (t) => {
  assert.equal(library.caseFold('Ɤ'), 'Ɤ');
  assert.equal(library.foldForComparison('Ɤ'), 'Ɤ');
  assert.equal(library.UNICODE_VERSION, '15.1.0');
  const host = process.versions.unicode ?? '';
  const major = Number.parseInt(host, 10);
  if (!(major >= 16)) {
    t.diagnostic(
      `this Node's Unicode is ${host || 'unknown'}, before U+A7CB was assigned (16.0): its own toLowerCase leaves it unchanged too, so the vector cannot tell a host conversion apart here`,
    );
    return;
  }
  // On a 16 or later host, a host conversion would give U+0264, so the vector above is known to discriminate.
  assert.equal('Ɤ'.toLowerCase(), 'ɤ', `this Node's Unicode is ${host}`);
});

test('NFC and folding keep a surrogate without its partner, and handle text longer than one slice', () => {
  assert.equal(library.nfc('\uD800'), '\uD800');
  assert.equal(library.caseFold('\uDFFF\uD800'), '\uDFFF\uD800');
  const long = 'Á'.repeat(10_000);
  assert.equal(library.nfc(long), 'Á'.repeat(10_000));
  assert.equal(library.foldForComparison(long), 'á'.repeat(10_000));
});
