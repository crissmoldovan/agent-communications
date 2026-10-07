import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import * as library from '../src/index.ts';
import { PACKAGE_ROOT } from './support/realm.ts';

/**
 * The five semantic formats and exact instants (events phase A plan, decisions 10, 12, 13 and 14; D5-v). The vectors
 * are `test/vectors/formats.json`, which the conformance test runs in Node and the bare realm and `pnpm verify:browser`
 * in Chromium and WebKit. Here: that every format has both kinds of vector, and an independent oracle for the
 * calendar arithmetic — the test may use `Date`; the library may not, and the isomorphism guard holds it to that.
 */

interface FormatVector {
  readonly kind: string;
  readonly format?: string;
  readonly value?: unknown;
  readonly valid?: boolean;
}

const vectors = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'test', 'vectors', 'formats.json'), 'utf8')) as {
    vectors: FormatVector[];
  }
).vectors;

test('D5-v: isFormat dispatches all five formats, each with accepted and refused vectors', () => {
  const formats: library.SemanticFormat[] = ['email', 'domain', 'date-time', 'uri', 'uuid'];
  for (const format of formats) {
    const mine = vectors.filter((vector) => vector.kind === 'format' && vector.format === format);
    assert.ok(mine.filter((vector) => vector.valid === true).length >= 2, `${format}: accepted vectors`);
    assert.ok(mine.filter((vector) => vector.valid === false).length >= 2, `${format}: refused vectors`);
    // Each accepted value, through the dispatch itself; the cross-format refusals below show it dispatches by name.
    for (const vector of mine.filter((candidate) => candidate.valid === true)) {
      assert.equal(library.isFormat(format, vector.value), true, `${format}: ${String(vector.value)}`);
    }
  }
  assert.equal(library.isFormat('uuid', '2024-05-01T12:00:00Z'), false);
  assert.equal(library.isFormat('date-time', '123e4567-e89b-12d3-a456-426614174000'), false);
  assert.equal(library.isFormat('domain', 'someone@example.com'), false);
  assert.equal(library.isFormat('email', 'example.com'), false);
  assert.equal(library.isFormat('uri', 'example.com'), false);
  for (const format of formats) assert.equal(library.isFormat(format, null), false, `${format}: null`);
});

/** A deterministic sequence of instants across years 1 to 9999, by a linear congruential generator. */
function* samples(count: number): Generator<number> {
  const first = Date.UTC(1, 0, 1);
  const span = Date.UTC(9999, 11, 31, 23, 59, 59, 999) - first;
  let state = 0x2545f491;
  for (let i = 0; i < count; i += 1) {
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    const high = state;
    state = (Math.imul(state, 1_103_515_245) + 12_345) >>> 0;
    yield first + Math.floor(((high * 2 ** 32 + state) / 2 ** 64) * span);
  }
}

/** `ms` as RFC 3339 at a whole-minute offset from UTC, written out by hand from `Date`'s UTC fields. */
function atOffset(ms: number, minutes: number): string {
  const local = new Date(ms + minutes * 60_000);
  const pad = (value: number, width = 2) => String(value).padStart(width, '0');
  const sign = minutes < 0 ? '-' : '+';
  const offset = Math.abs(minutes);
  return (
    `${pad(local.getUTCFullYear(), 4)}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}` +
    `.${pad(local.getUTCMilliseconds(), 3)}${sign}${pad(Math.floor(offset / 60))}:${pad(offset % 60)}`
  );
}

test('D5-v: instants agree with an independent calendar across years 1 to 9999, at any offset', () => {
  const instants = [...samples(2000)];
  const offsets = [-720, -570, -60, 0, 45, 330, 840];
  for (const [index, ms] of instants.entries()) {
    const utc = new Date(ms).toISOString();
    const shifted = atOffset(ms, offsets[index % offsets.length] as number);
    assert.ok(library.isInstant(utc), utc);
    assert.ok(library.isInstant(shifted), shifted);
    assert.equal(library.compareInstants(utc, shifted), 0, `${utc} and ${shifted}`);
    const next = instants[(index + 1) % instants.length] as number;
    const expected = Math.sign(ms - next);
    assert.equal(library.compareInstants(utc, new Date(next).toISOString()), expected, `${utc} against ${next}`);
  }
});

test('D5-v: every calendar day of a 400-year cycle is valid, and no day past its month’s end', () => {
  for (let year = 2000; year < 2400; year += 1) {
    for (let month = 1; month <= 12; month += 1) {
      const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
      const stem = `${String(year)}-${String(month).padStart(2, '0')}`;
      assert.ok(library.isInstant(`${stem}-${String(last).padStart(2, '0')}T00:00:00Z`), `${stem}-${last}`);
      if (last < 31) assert.ok(!library.isInstant(`${stem}-${String(last + 1)}T00:00:00Z`), `${stem}-${last + 1}`);
    }
  }
});

test('D5-v: compareInstants is a total order over the vectors’ instants', () => {
  const instants = vectors
    .filter((vector) => vector.kind === 'format' && vector.format === 'date-time' && vector.valid === true)
    .map((vector) => vector.value as string);
  const sorted = [...instants].sort(library.compareInstants);
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = 0; j < sorted.length; j += 1) {
      const a = sorted[i] as string;
      const b = sorted[j] as string;
      const order = library.compareInstants(a, b);
      assert.equal(order, -library.compareInstants(b, a) || 0, `${a} and ${b} are not antisymmetric`);
      if (i < j) assert.ok(order <= 0, `${a} sorts before ${b}, yet compares ${order}`);
    }
  }
});
