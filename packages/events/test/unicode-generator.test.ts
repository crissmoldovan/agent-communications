import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { gunzipSync, gzipSync } from 'node:zlib';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * The Unicode 15.1 tables are generated from pinned sources, and nothing else (events phase A plan, decision 2; UNI-a).
 *
 * Three depths prove it. Here are the first two: the generator, run on tiny synthetic fragments, makes integer tables
 * written out by hand — so a generator bug cannot hide by being reproduced in both generation and check — and
 * `--check` refuses every kind of drift between the pins, the sources and the committed tables. The third, Unicode's
 * own conformance files run against the tables, is `unicode.test.ts`'s and `idna.test.ts`'s.
 */

interface Pin {
  readonly name: string;
  readonly url: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly vendored: string;
}

interface Generator {
  readonly VENDOR: string;
  readonly SOURCE_NAMES: readonly string[];
  buildTables(sources: Record<string, string>): Record<string, number[]>;
  checkVendor(vendor: string): string[];
  readPins(vendor: string): Pin[];
}

const generator = (await import(new URL('../scripts/unicode.mjs', import.meta.url).href)) as Generator;

const fragment = (name: string) => readFileSync(join(PACKAGE_ROOT, 'test', 'fixtures', 'ucd', name), 'utf8');
const fragments = () => Object.fromEntries(generator.SOURCE_NAMES.map((name) => [name, fragment(name)]));

test('UNI-a: the generator makes the expected tables from synthetic fragments', () => {
  const tables = generator.buildTables(fragments());
  // CaseFolding: C and F only, `[codePoint, length, ...folded]`. The T lines of I and İ and the S line of ẞ are not
  // kept; İ keeps its F mapping, i + COMBINING DOT ABOVE, and Cherokee small a folds to capital Ꭰ.
  assert.deepEqual(
    tables.caseFolding,
    [65, 1, 97, 73, 1, 105, 223, 2, 115, 115, 304, 2, 105, 775, 7838, 2, 115, 115, 43888, 1, 5024],
  );
  // Non-zero combining classes as merged ranges: U+0300 and U+0301 are adjacent and both 230, so one range.
  assert.deepEqual(
    tables.combiningClasses,
    [
      768, 769, 230, 776, 776, 230, 832, 832, 230, 836, 836, 230, 2364, 2364, 7, 2381, 2381, 9, 3953, 3953, 129, 3954,
      3954, 130,
    ],
  );
  // Canonical decompositions, one step; ½'s <fraction> compatibility decomposition is not canonical.
  assert.deepEqual(
    tables.decompositions,
    [192, 2, 65, 768, 832, 1, 768, 836, 2, 776, 769, 2392, 2, 2325, 2364, 3955, 2, 3953, 3954, 8486, 1, 937],
  );
  // Full_Composition_Exclusion: U+0958 from the file; U+0340 and U+2126 as singletons; U+0340 and U+0344 as
  // non-starters; U+0F73 because its decomposition starts with a non-starter, U+0F71 (class 129).
  assert.deepEqual(tables.compositionExclusions, [832, 832, 836, 836, 2392, 2392, 3955, 3955, 8486, 8486]);
  // General_Category Mn, Mc and Me, merged: U+0F71..U+0F73 are one range, U+0903 (Mc) and U+20DD (Me) are in.
  assert.deepEqual(
    tables.marks,
    [768, 769, 776, 776, 832, 832, 836, 836, 2307, 2307, 2364, 2364, 2381, 2381, 3953, 3955, 8413, 8413],
  );
  assert.deepEqual(tables.viramas, [2381, 2381]);
  // Bidi classes RFC 5893 names (L 0, R 1, AL 2, AN 3, EN 4, ES 5, CS 6, ET 7, ON 8, BN 9, NSM 10); SPACE is WS, which
  // it does not, so it is absent. The <CJK Ideograph Extension B, First>/<…, Last> pair is one range.
  assert.deepEqual(
    tables.bidiClasses,
    [
      49, 49, 4, 65, 66, 0, 189, 189, 8, 192, 192, 0, 768, 769, 10, 776, 776, 10, 832, 832, 10, 836, 836, 10, 937, 937,
      0, 1488, 1488, 1, 1575, 1576, 2, 1600, 1600, 2, 1632, 1632, 3, 2307, 2307, 0, 2325, 2325, 0, 2364, 2364, 10, 2381,
      2381, 10, 2392, 2392, 0, 3953, 3955, 10, 8204, 8205, 9, 8413, 8413, 10, 8486, 8486, 0, 131072, 173791, 0,
    ],
  );
  // Joining types (U 0, D 1, R 2, L 3, T 4, C 5), sorted and merged, U never kept.
  assert.deepEqual(
    tables.joiningTypes,
    [768, 770, 4, 1575, 1575, 2, 1576, 1576, 1, 1600, 1600, 5, 8205, 8205, 5, 43122, 43122, 3],
  );
  // The IDNA ranges cover every code point: `[start, end, status, mapping offset]`, statuses valid 0, ignored 1,
  // mapped 2, deviation 3, disallowed 4, disallowed_STD3_valid 5, disallowed_STD3_mapped 6. U+00E0..U+00FF (NV8)
  // and U+0100..U+0101 are one valid range: the IDNA2008 column is not UTS #46's. ẞ's mapping is ß's, stored once.
  assert.deepEqual(
    tables.idnaRanges,
    [
      0, 44, 5, -1, 45, 46, 0, -1, 47, 47, 5, -1, 48, 57, 0, -1, 58, 64, 5, -1, 65, 65, 2, 0, 66, 66, 2, 2, 67, 96, 4,
      -1, 97, 122, 0, -1, 123, 172, 4, -1, 173, 173, 1, -1, 174, 222, 4, -1, 223, 223, 3, 4, 224, 257, 0, -1, 258, 305,
      4, -1, 306, 307, 2, 7, 308, 7837, 4, -1, 7838, 7838, 2, 4, 7839, 8203, 4, -1, 8204, 8205, 3, 10, 8206, 9331, 4,
      -1, 9332, 9332, 6, 11, 9333, 1114111, 4, -1,
    ],
  );
  // `[length, ...sequence]`: a, b, ss, ij, nothing (the joiners' deviation mapping), (1).
  assert.deepEqual(tables.idnaMappings, [1, 97, 1, 98, 2, 115, 115, 2, 105, 106, 0, 3, 40, 49, 41]);
});

test('UNI-a: the generator refuses a source it cannot read, naming the file and the line', () => {
  const broken = (name: string, edit: (text: string) => string, why: RegExp) => {
    const sources = fragments();
    sources[name] = edit(sources[name] as string);
    assert.throws(() => generator.buildTables(sources), why, name);
  };
  broken(
    'CaseFolding.txt',
    (text) => `${text}0042; Q; 0062; # unknown status\n`,
    /CaseFolding\.txt, line \d+: unknown status "Q"/,
  );
  broken(
    'UnicodeData.txt',
    (text) => text.replace('2A6DF;<CJK Ideograph Extension B, Last>', '2A6DF;<CJK Ideograph Extension C, Last>'),
    /UnicodeData\.txt, line \d+: a range ends that did not start/,
  );
  broken(
    'IdnaMappingTable.txt',
    (text) => text.replace('2475..10FFFF', '2476..10FFFF'),
    /IdnaMappingTable\.txt, line \d+: expected the line for U\+2475/,
  );
  broken(
    'IdnaMappingTable.txt',
    (text) => text.replace('2475..10FFFF', '2475..10FFFE'),
    /IdnaMappingTable\.txt: the table ends at U\+10FFFE, not U\+10FFFF/,
  );
  broken(
    'DerivedJoiningType.txt',
    (text) => `${text}0710 ; X\n`,
    /DerivedJoiningType\.txt, line \d+: unknown joining type "X"/,
  );
  broken(
    'CompositionExclusions.txt',
    (text) => `${text}0041\n`,
    /CompositionExclusions\.txt: U\+0041 has no canonical decomposition/,
  );
});

// The drift checks run against copies of the vendor directory, never the committed one.
const scratch = mkdtempSync(join(tmpdir(), 'agentcomms-unicode-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
let copies = 0;
function vendorCopy(): string {
  copies += 1;
  const copy = join(scratch, `${copies}`, 'unicode-15.1.0');
  cpSync(generator.VENDOR, copy, { recursive: true });
  return copy;
}
const sourcePath = (vendor: string, name: string) => join(vendor, 'sources', `${name}.gz`);
const sourceBytes = (vendor: string, name: string) => gunzipSync(readFileSync(sourcePath(vendor, name)));

test('UNI-a: the check refuses drift, naming the file', async (t) => {
  await t.test('a pristine copy passes', () => {
    assert.deepEqual(generator.checkVendor(vendorCopy()), []);
  });
  await t.test('an edited generated file', () => {
    const vendor = vendorCopy();
    const path = join(vendor, 'generated', 'case-folding.ts');
    writeFileSync(path, readFileSync(path, 'utf8').replace('65, 1, 97,', '65, 1, 98,'));
    assert.deepEqual(generator.checkVendor(vendor), [
      'unicode-15.1.0/generated/case-folding.ts is not what the pinned sources generate — run `pnpm sync:unicode`',
    ]);
  });
  await t.test('a source whose bytes no longer match its pin', () => {
    const vendor = vendorCopy();
    const bytes = sourceBytes(vendor, 'CaseFolding.txt');
    writeFileSync(sourcePath(vendor, 'CaseFolding.txt'), gzipSync(Buffer.concat([bytes, Buffer.from('# more\n')])));
    assert.deepEqual(generator.checkVendor(vendor), [
      `unicode-15.1.0/sources/CaseFolding.txt.gz holds ${bytes.length + 7} bytes of CaseFolding.txt, and SOURCES.json pins ${bytes.length}`,
    ]);
  });
  await t.test('a missing source', () => {
    const vendor = vendorCopy();
    unlinkSync(sourcePath(vendor, 'DerivedJoiningType.txt'));
    assert.deepEqual(generator.checkVendor(vendor), [
      'unicode-15.1.0/sources/DerivedJoiningType.txt.gz is missing: it should hold DerivedJoiningType.txt, from https://www.unicode.org/Public/15.1.0/ucd/extracted/DerivedJoiningType.txt',
    ]);
  });
  await t.test('an extra file in generated/', () => {
    const vendor = vendorCopy();
    writeFileSync(join(vendor, 'generated', 'scripts.ts'), 'export {};\n');
    assert.deepEqual(generator.checkVendor(vendor), [
      'unicode-15.1.0/generated/scripts.ts is not a table the generator makes',
    ]);
  });
  await t.test('a missing generated file', () => {
    const vendor = vendorCopy();
    unlinkSync(join(vendor, 'generated', 'marks.ts'));
    assert.deepEqual(generator.checkVendor(vendor), [
      'unicode-15.1.0/generated/marks.ts is missing — run `pnpm sync:unicode`',
    ]);
  });
  await t.test('a pin whose size matches but hash does not: one byte flipped in a decompressed source', () => {
    const vendor = vendorCopy();
    const bytes = Buffer.from(sourceBytes(vendor, 'IdnaMappingTable.txt'));
    const at = bytes.indexOf('0041          ; mapped');
    bytes[at + 3] = '2'.charCodeAt(0);
    writeFileSync(sourcePath(vendor, 'IdnaMappingTable.txt'), gzipSync(bytes));
    const [problem, ...rest] = generator.checkVendor(vendor);
    assert.deepEqual(rest, []);
    assert.match(
      problem ?? '',
      /^unicode-15\.1\.0\/sources\/IdnaMappingTable\.txt\.gz: the SHA-256 of IdnaMappingTable\.txt is [0-9a-f]{64}, and SOURCES\.json pins 402cbd285f1f952fcd0834b63541d54f69d3d8f1b8f8599bf71a1a14935f82c4$/,
    );
  });
  await t.test('a licence that is not the pinned one', () => {
    const vendor = vendorCopy();
    writeFileSync(join(vendor, 'LICENSE'), readFileSync(join(vendor, 'LICENSE'), 'utf8').replace('V3', 'V4'));
    assert.match(
      generator.checkVendor(vendor).join('\n'),
      /^unicode-15\.1\.0\/LICENSE: the SHA-256 of license\.txt is/,
    );
  });
  await t.test('a file in sources/ that no pin names', () => {
    const vendor = vendorCopy();
    writeFileSync(join(vendor, 'sources', 'Scripts.txt.gz'), gzipSync(Buffer.from('# not pinned\n')));
    assert.deepEqual(generator.checkVendor(vendor), ['unicode-15.1.0/sources/Scripts.txt.gz is not a pinned source']);
  });
});

test('UNI-a: the pins are decision 2’s, and every one is checked', () => {
  const pins = generator.readPins(generator.VENDOR);
  assert.deepEqual(
    pins.map((pin) => [pin.name, pin.bytes, pin.sha256]),
    [
      ['CaseFolding.txt', 84870, '4e55acfdc32825a22e87670e9056a3bf94ad7c5400065778e9e10f8314372bcf'],
      ['UnicodeData.txt', 1914200, '2fc713e6a31a87c4850a37fe2caffa4218180fadb5de86b43a143ddb4581fb86'],
      ['CompositionExclusions.txt', 8888, '59d2d9e3dfdf0a999cf9dae11d594f053631222679a2f5710315ea07f7fe82af'],
      ['DerivedJoiningType.txt', 39057, '2e0ed3733272299007cf0b76e84a8a653192d99a4429d2232fffcabccfd2d462'],
      ['IdnaMappingTable.txt', 874566, '402cbd285f1f952fcd0834b63541d54f69d3d8f1b8f8599bf71a1a14935f82c4'],
      ['NormalizationTest.txt', 2625136, '871238e37e3be0696ec2bd0891119a041b052da1a84485eda05a5438724b223e'],
      ['IdnaTestV2.txt', 749716, 'd668c4ea58d60fe04e6c011df98e0b317da6abaa1273d58f42b581eb0dd7adda'],
      ['license.txt', 1995, 'e7a93b009565cfce55919a381437ac4db883e9da2126fa28b91d12732bc53d96'],
    ],
  );
  for (const pin of pins) {
    const under = pin.name === 'license.txt' ? 'https://www.unicode.org/' : 'https://www.unicode.org/Public/';
    assert.ok(pin.url.startsWith(under) && pin.url.endsWith(`/${pin.name}`), pin.url);
  }
});

test('UNI-a: the committed tables are what the pinned sources generate', () => {
  const run = spawnSync(process.execPath, [join(PACKAGE_ROOT, 'scripts', 'unicode.mjs'), '--check'], {
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /^Unicode 15\.1\.0 tables match their pinned sources: 8 files checked by size and SHA-256/);
});
