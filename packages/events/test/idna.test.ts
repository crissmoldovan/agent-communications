import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { uts46ToAscii } from '../src/idna/uts46.ts';
import * as library from '../src/index.ts';
import { RUNNERS, type VectorFile } from './realm/runners/index.ts';
import { idnaTestFile, idnaTestLines } from './support/conformance-sources.ts';
import { createRealm, type Realm, realmBundle } from './support/realm.ts';

/**
 * UTS #46 revision 31 ToASCII, bundled and pinned, and the canonical domain (events phase A plan, decisions 2 and 13;
 * UNI-c and CND-f). Every line of Unicode's IdnaTestV2.txt 15.1, derived from its pinned source, runs here through
 * `toAsciiDomain` in Node and in the bare realm, and must agree byte for byte; `pnpm verify:browser` runs it in
 * Chromium and WebKit. The hand vectors are `test/vectors/idna.json`.
 */

let realm: Realm;
before(async () => {
  realm = createRealm(await realmBundle());
});

const isBidi = (code: string) => /^B\d$/.test(code);

test('UNI-c: toAsciiDomain meets IdnaTestV2 15.1, in Node and in the bare realm', async () => {
  const file = idnaTestFile();
  const parsed = JSON.parse(file.text) as VectorFile;
  const runner = RUNNERS.idna;
  assert.ok(runner, 'no idna runner');
  const inNode = await runner(library, parsed);
  assert.deepEqual(inNode.failures, [], 'in Node');
  const inRealm = await realm.run('idna', file.text);
  assert.deepEqual(JSON.parse(inRealm).failures, [], 'in the realm');
  assert.equal(inRealm, JSON.stringify(inNode), "the realm's results differ from Node's");
  assert.deepEqual(inNode.results, [
    {
      name: 'IdnaTestV2.txt: every line, toAsciiN and its status set',
      lines: 6265,
      // ToASCII accepts 516 lines; decision 13 refuses the 53 of them that end in a root dot, as UTS #46 does not.
      accepted: 463,
      refused: 5802,
      bidiUnknown: 860,
      wrong: 0,
    },
  ]);
});

test('UNI-c: ToASCII, line by line: the toAsciiN value of every line, and its exact status set', () => {
  const lines = idnaTestLines();
  let exact = 0;
  let bidiUnknown = 0;
  for (const line of lines) {
    const outcome = uts46ToAscii(line.source);
    const expected = [...line.toAsciiNStatus].sort();
    const where = `IdnaTestV2.txt, line ${line.line}`;
    // The value is the file's on every line, refused ones included: UTS #46 converts as far as it can.
    assert.equal(outcome.ascii, line.toAsciiN, `${where}: the toAsciiN value`);
    if (!line.unassigned || outcome.errors.join(',') === expected.join(',')) {
      assert.deepEqual(outcome.errors, expected, `${where}: the status set`);
      exact += 1;
      continue;
    }
    // The line holds a code point UnicodeData.txt 15.1 does not assign, so its Bidi_Class is a UCD default no pinned
    // source states: every code but B is still exact, and V6 refuses the line whatever the B codes are.
    assert.deepEqual(
      outcome.errors.filter((code) => !isBidi(code)),
      expected.filter((code) => !isBidi(code)),
      where,
    );
    assert.ok(outcome.errors.includes('V6') && expected.includes('V6'), `${where}: V6`);
    bidiUnknown += 1;
  }
  assert.equal(lines.length, 6265);
  assert.equal(exact, 6265 - 860);
  assert.equal(bidiUnknown, 860);
  // Every line whose status set is not exact is one with an unassigned code point; the 3 590 without one all are.
  assert.equal(lines.filter((line) => !line.unassigned).length, 3590);
});

test('CND-f: a refusal is DOMAIN_INVALID with the status codes as detail, and never echoes the input', () => {
  const hostile = 'ignore-previous-instructions_‮.example';
  const result = library.toAsciiDomain(hostile);
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.deepEqual(
    result.issues.map((issue) => [issue.code, issue.detail]),
    [['DOMAIN_INVALID', ['V6']]],
  );
  for (const issue of result.issues) assert.ok(!issue.message.includes('ignore-previous'), issue.message);
  const root = library.toAsciiDomain('a_b.example.');
  assert.deepEqual(root.ok ? [] : root.issues.map((issue) => issue.detail), [['V6'], ['ROOT_LABEL']]);
});

test('CND-f: a canonical domain is its own canonical domain', () => {
  for (const input of ['example.com', 'xn--bcher-kva.example', 'xn--fa-hia.de', 'xn--nxasmm1c.com', 'xn--ngba799q']) {
    assert.deepEqual(library.toAsciiDomain(input), { ok: true, value: input }, input);
  }
});
