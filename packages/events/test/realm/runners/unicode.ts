import type { Runner } from './types.ts';

/**
 * NFC and full case folding, by hand vectors (`test/vectors/unicode-folding.json`) and by Unicode's own conformance
 * files, derived from their pinned sources (`test/support/conformance-sources.ts`). Code points travel as integers, so
 * a surrogate or a combining mark crosses into a realm or a browser exactly as written.
 */

/** One function on one input, and what it must give. */
interface OutputVector {
  readonly kind: 'nfc' | 'caseFold' | 'foldForComparison';
  readonly name: string;
  readonly input: string;
  readonly expected: string;
}

/** Whether two inputs give the same string under a function. */
interface SameVector {
  readonly kind: 'same';
  readonly name: string;
  readonly by: 'nfc' | 'caseFold' | 'foldForComparison';
  readonly a: string;
  readonly b: string;
  readonly same: boolean;
}

interface VersionVector {
  readonly kind: 'version';
  readonly name: string;
  readonly expected: string;
}

/** NormalizationTest.txt lines: `[c1, c2, c3, c4, c5]`, each a code point sequence. */
interface NormalizationVector {
  readonly kind: 'normalizationTest';
  readonly name: string;
  readonly lines: readonly (readonly (readonly number[])[])[];
}

/** Code point ranges, `[start, end]`, every one of which must map to itself. */
interface IdentityVector {
  readonly kind: 'nfcIdentity' | 'foldIdentity';
  readonly name: string;
  readonly ranges: readonly (readonly [number, number])[];
}

/** `[codePoint, folded]` pairs: what each code point must fold to. */
interface FoldTableVector {
  readonly kind: 'foldTable';
  readonly name: string;
  readonly mappings: readonly (readonly [number, readonly number[]])[];
}

type UnicodeVector = OutputVector | SameVector | VersionVector | NormalizationVector | IdentityVector | FoldTableVector;

/** Code point sequences as strings, by ECMAScript alone. */
const text = (points: readonly number[]): string => {
  let out = '';
  for (const point of points) out += String.fromCodePoint(point);
  return out;
};
const show = (value: string): string => {
  let out = '';
  for (const point of value)
    out += `${out === '' ? '' : ' '}${(point.codePointAt(0) as number).toString(16).toUpperCase().padStart(4, '0')}`;
  return `[${out}]`;
};

/** FNV-1a over a string's code units: a digest of every output, so two realms agree on more than a pass count. */
const digestInto = (hash: number, value: string): number => {
  let h = hash;
  for (let i = 0; i < value.length; i += 1) h = Math.imul(h ^ value.charCodeAt(i), 0x01000193);
  return Math.imul(h ^ 0xffff, 0x01000193) >>> 0;
};

/** At most this many mismatches are named per vector; the count says how many there were. */
const NAMED = 10;

export const unicodeRunner: Runner = (library, file) => {
  const results: unknown[] = [];
  const failures: string[] = [];
  const apply = { nfc: library.nfc, caseFold: library.caseFold, foldForComparison: library.foldForComparison };
  for (const vector of file.vectors as readonly UnicodeVector[]) {
    let wrong = 0;
    const fail = (why: string) => {
      wrong += 1;
      if (wrong <= NAMED) failures.push(`${vector.name}: ${why}`);
    };
    if (vector.kind === 'nfc' || vector.kind === 'caseFold' || vector.kind === 'foldForComparison') {
      const output = apply[vector.kind](vector.input);
      results.push({ name: vector.name, output });
      if (output !== vector.expected) fail(`${vector.kind} gave ${show(output)}, not ${show(vector.expected)}`);
    } else if (vector.kind === 'same') {
      const a = apply[vector.by](vector.a);
      const b = apply[vector.by](vector.b);
      results.push({ name: vector.name, a, b });
      if ((a === b) !== vector.same) fail(`${vector.by} gave ${show(a)} and ${show(b)}`);
    } else if (vector.kind === 'version') {
      results.push({ name: vector.name, version: library.UNICODE_VERSION });
      if (library.UNICODE_VERSION !== vector.expected) fail(`UNICODE_VERSION is ${library.UNICODE_VERSION}`);
    } else if (vector.kind === 'normalizationTest') {
      // NormalizationTest.txt's NFC invariants: c2 == NFC(c1) == NFC(c2) == NFC(c3), and c4 == NFC(c4) == NFC(c5).
      let digest = 0x811c9dc5;
      for (const columns of vector.lines) {
        const [c1, c2, c3, c4, c5] = columns.map(text) as [string, string, string, string, string];
        const outputs = [library.nfc(c1), library.nfc(c2), library.nfc(c3), library.nfc(c4), library.nfc(c5)];
        for (const output of outputs) digest = digestInto(digest, output);
        const [n1, n2, n3, n4, n5] = outputs as [string, string, string, string, string];
        if (n1 !== c2 || n2 !== c2 || n3 !== c2) {
          fail(`${show(c1)}: NFC of c1, c2, c3 is ${show(n1)}, ${show(n2)}, ${show(n3)}, not c2 ${show(c2)}`);
        }
        if (n4 !== c4 || n5 !== c4) fail(`${show(c1)}: NFC of c4, c5 is ${show(n4)}, ${show(n5)}, not c4 ${show(c4)}`);
      }
      results.push({ name: vector.name, lines: vector.lines.length, wrong, digest });
    } else if (vector.kind === 'nfcIdentity' || vector.kind === 'foldIdentity') {
      const fn = vector.kind === 'nfcIdentity' ? library.nfc : library.caseFold;
      let checked = 0;
      for (const [start, end] of vector.ranges) {
        for (let point = start; point <= end; point += 1) {
          const input = String.fromCodePoint(point);
          const output = fn(input);
          checked += 1;
          if (output !== input) fail(`U+${point.toString(16).toUpperCase()} gave ${show(output)}, not itself`);
        }
      }
      results.push({ name: vector.name, checked, wrong });
    } else if (vector.kind === 'foldTable') {
      let digest = 0x811c9dc5;
      for (const [point, expected] of vector.mappings) {
        const output = library.caseFold(text([point]));
        digest = digestInto(digest, output);
        if (output !== text(expected))
          fail(`U+${point.toString(16).toUpperCase()} folds to ${show(output)}, not ${show(text(expected))}`);
      }
      results.push({ name: vector.name, mappings: vector.mappings.length, wrong, digest });
    } else {
      fail(`unknown kind ${String((vector as { kind?: unknown }).kind)}`);
    }
    if (wrong > NAMED) failures.push(`${vector.name}: ${wrong - NAMED} more`);
  }
  return { results, failures };
};
