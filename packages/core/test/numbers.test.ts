import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError, readWholeNumber, wholeNumber } from '../src/index.ts';

/*
 * The check every CLI's number options go through, exported from the package so Gmail and Slack take the same one.
 * `Number.parseInt` read `abc` as NaN, `12abc` as 12 and `1e2` as 1; `Number` reads `1e2` as 100, `0x10` as 16 and
 * `''` as 0. Each is a number nobody typed.
 */

test('a whole number is digits and nothing else, or a number that is whole', () => {
  for (const [raw, read] of [
    ['0', 0],
    ['7', 7],
    ['007', 7],
    [' 12 ', 12],
    [65535, 65535],
    [0, 0],
  ] as const) {
    assert.equal(readWholeNumber(raw), read, JSON.stringify(raw));
  }
  for (const raw of [
    'abc',
    '12abc',
    '1e2',
    '0x10',
    '0b1',
    '2.5',
    '2.',
    '-1',
    '+5',
    '',
    ' ',
    'Infinity',
    'NaN',
    '１２',
    '99999999999999999999',
    2.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    2 ** 53,
    null,
    true,
    [5],
  ]) {
    assert.ok(Number.isNaN(readWholeNumber(raw)), `${JSON.stringify(raw)} was read as a whole number`);
  }
});

test('an option’s number is refused as USAGE naming the option and its range, and left out is undefined', () => {
  const limit = { name: '--limit', min: 1, max: 50 };
  assert.equal(wholeNumber(undefined, limit), undefined);
  assert.equal(wholeNumber('1', limit), 1);
  assert.equal(wholeNumber('50', limit), 50);
  assert.equal(wholeNumber(20, limit), 20);

  for (const raw of ['0', '51', '1e2', '12abc', 'abc', '', '-1', 2.5, 51]) {
    assert.throws(
      () => wholeNumber(raw, limit),
      (error: unknown) => {
        assert.ok(error instanceof CommsError);
        assert.equal(error.code, 'USAGE');
        assert.equal(error.message, `--limit "${String(raw)}" is not a whole number from 1 to 50`);
        return true;
      },
      JSON.stringify(raw),
    );
  }

  // With no most, the range says so; a caller's hint replaces the one about how to write it.
  assert.throws(() => wholeNumber('-3', { name: 'offset', min: 0 }), {
    code: 'USAGE',
    message: 'offset "-3" is not a whole number of 0 or more',
  });
  assert.throws(() => wholeNumber('x', { name: '--port', min: 0, max: 65535, hint: '0 picks a free one.' }), {
    code: 'USAGE',
    hint: '0 picks a free one.',
  });
  assert.throws(() => wholeNumber('1e2', limit), { hint: /digits/i });
});
