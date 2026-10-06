import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canonicalJson,
  codePointLength,
  compareUtf8,
  EventsError,
  isJsonValue,
  isWellFormed,
  utf8ByteLength,
} from '../src/index.ts';

/**
 * Canonical JSON's refusals, and the text helpers every later area counts and sorts with. The bytes canonical JSON
 * writes are proven against core's own `canonicalJson` by the vectors (`test/vectors/canonical-json.json`, in Node and
 * the bare realm) and by `test/events-canonical-json.test.mjs` at the repository root, through both built packages.
 */

/** Asserts `canonicalJson(value)` throws the library's NOT_JSON refusal, naming where. */
function refused(value: unknown, pointer: string, what: RegExp): void {
  assert.equal(isJsonValue(value), false, `isJsonValue accepted ${pointer || 'the root'}`);
  assert.throws(
    () => canonicalJson(value),
    (error: unknown) => {
      assert.ok(error instanceof EventsError, String(error));
      assert.equal(error.code, 'NOT_JSON');
      assert.equal(error.pointer, pointer);
      assert.match(error.message, what);
      return true;
    },
  );
}

test('CJ-a: canonical JSON refuses what is not JSON, where core would write something', () => {
  refused([1, undefined, 2], '/1', /undefined/);
  refused({ a: Number.NaN }, '/a', /non-finite number/);
  refused({ list: [Number.POSITIVE_INFINITY] }, '/list/0', /non-finite number/);
  refused(Number.NEGATIVE_INFINITY, '', /non-finite number/);
  refused(new Map([['a', 1]]), '', /not a plain object/);
  refused({ inner: Object.create({ inherited: 1 }) }, '/inner', /not a plain object/);
  refused(new Date(0), '', /not a plain object/);
  refused(
    new (class Thing {
      readonly a = 1;
    })(),
    '',
    /not a plain object/,
  );
  refused(undefined, '', /undefined/);
  refused({ f: () => 1 }, '/f', /a function/);
  refused({ big: 1n }, '/big', /a bigint/);
  refused({ s: Symbol('s') }, '/s', /a symbol/);
  // A hole in an array is an undefined element, which core would write as nothing between two commas.
  // biome-ignore lint/suspicious/noSparseArray: the hole is the case under test
  refused([1, , 3], '/1', /undefined/);
  // A key holding `/` or `~` is escaped in the pointer, as RFC 6901 writes it.
  refused({ 'a/b': { '~': Number.NaN } }, '/a~1b/~0', /non-finite number/);
  const cycle: Record<string, unknown> = { a: 1 };
  cycle.self = { again: cycle };
  refused(cycle, '/self/again', /cycle/);
});

test('CJ-a: what canonical JSON accepts, isJsonValue accepts', () => {
  for (const value of [
    null,
    true,
    0,
    -0,
    1.5,
    '',
    'é',
    [],
    {},
    { a: [1, { b: null }] },
    { dropped: undefined },
    Object.create(null),
    JSON.parse('{"__proto__": 1}'),
  ]) {
    assert.equal(isJsonValue(value), true, Object.prototype.toString.call(value));
    assert.equal(typeof canonicalJson(value), 'string');
  }
  // The same structure twice is not a cycle.
  const shared = { x: 1 };
  assert.equal(canonicalJson({ a: shared, b: shared }), '{"a":{"x":1},"b":{"x":1}}');
});

/** A small deterministic generator, so a failing case is the same on every run. */
function generator(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

/** Code points at every UTF-8 and UTF-16 boundary, and either side of the surrogate block. */
const BOUNDARIES = [
  0x00, 0x41, 0x7f, 0x80, 0x7ff, 0x800, 0xd7ff, 0xe000, 0xff61, 0xfffd, 0xffff, 0x10000, 0x1f600, 0x10ffff,
];

test('compareUtf8 orders strings as their UTF-8 bytes do, which UTF-16 order does not', () => {
  const next = generator(20261006);
  const pick = () => {
    const length = Math.floor(next() * 5);
    let text = '';
    for (let i = 0; i < length; i += 1) {
      const point =
        next() < 0.6 ? (BOUNDARIES[Math.floor(next() * BOUNDARIES.length)] ?? 0) : Math.floor(next() * 0x110000);
      // The corpus is well-formed: a code point in the surrogate block is not a character.
      text += String.fromCodePoint(point >= 0xd800 && point <= 0xdfff ? 0xe000 : point);
    }
    return text;
  };
  const sign = (n: number) => (n < 0 ? -1 : n > 0 ? 1 : 0);
  for (let i = 0; i < 20_000; i += 1) {
    const a = pick();
    const b = pick();
    const bytes = sign(Buffer.compare(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8')));
    assert.equal(sign(compareUtf8(a, b)), bytes, `${JSON.stringify(a)} against ${JSON.stringify(b)}`);
  }
  // The case decision 11 names: a BMP character at U+E000 or above against an astral one.
  assert.equal(compareUtf8('｡', '\u{1F600}'), -1);
  assert.ok('｡' > '\u{1F600}', 'UTF-16 order puts the astral character first');
  assert.equal(compareUtf8('', '\u{10000}'), -1);
  assert.equal(compareUtf8('a', 'a'), 0);
  assert.equal(compareUtf8('a', 'ab'), -1);
  assert.equal(compareUtf8('ab', 'a'), 1);
  assert.equal(compareUtf8('', ''), 0);
});

test('utf8ByteLength counts UTF-8 bytes at every boundary, and a lone surrogate as the three of its replacement', () => {
  for (const point of BOUNDARIES) {
    const text = String.fromCodePoint(point);
    assert.equal(utf8ByteLength(text), Buffer.byteLength(text, 'utf8'), point.toString(16));
  }
  assert.equal(utf8ByteLength(''), 0);
  assert.equal(utf8ByteLength('\u007F'), 1);
  assert.equal(utf8ByteLength('\u0080'), 2);
  assert.equal(utf8ByteLength('߿'), 2);
  assert.equal(utf8ByteLength('ࠀ'), 3);
  assert.equal(utf8ByteLength('￿'), 3);
  assert.equal(utf8ByteLength('\u{10000}'), 4);
  assert.equal(utf8ByteLength('\u{10FFFF}'), 4);
  assert.equal(utf8ByteLength('a\u{1F600}é'), 1 + 4 + 2);
  assert.equal(utf8ByteLength('\uD800'), 3);
  assert.equal(utf8ByteLength('\uDC00\uD800'), 6);
});

test('codePointLength counts code points: a pair is one, a lone surrogate is one', () => {
  assert.equal(codePointLength(''), 0);
  assert.equal(codePointLength('a'), 1);
  assert.equal(codePointLength('\u{1F600}'), 1);
  assert.equal(codePointLength('a\u{1F600}b'), 3);
  assert.equal(codePointLength('\uD800'), 1);
  assert.equal(codePointLength('\uD800\uD800'), 2);
  assert.equal(codePointLength('\uDC00😀'), 2);
  assert.equal(codePointLength('\u{10FFFF}'.repeat(3)), 3);
});

test('isWellFormed is false exactly when a surrogate is unpaired', () => {
  for (const text of ['', 'a', '\u{1F600}', '😀😀', '', '\u{10FFFF}']) {
    assert.equal(isWellFormed(text), true, JSON.stringify(text));
  }
  for (const text of ['\uD800', '\uDC00', '\uDC00\uD800', 'a\uD83D', '\uDE00a', '\uD83D😀']) {
    assert.equal(isWellFormed(text), false, JSON.stringify(text));
  }
});
