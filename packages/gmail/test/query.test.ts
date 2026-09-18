import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compileQuery, localMidnightEpochSeconds, tokenizeQuery } from '../src/domain/query.ts';

test('dates become absolute instants in the user’s timezone, not Gmail’s', () => {
  const london = compileQuery('after:2026-09-17 from:sam', { timezone: 'Europe/London' });
  // Midnight on 17 September in London is 23:00 UTC on the 16th (BST).
  assert.equal(london.compiled, `after:${Date.UTC(2026, 8, 16, 23, 0, 0) / 1000} from:sam`);
  assert.deepEqual(london.rewrites, [{ operator: 'after', from: '2026-09-17', to: String(Date.UTC(2026, 8, 16, 23) / 1000) }]);
  assert.equal(london.timezone, 'Europe/London');

  // The same date in Tokyo is a different instant, which is the entire point.
  const tokyo = compileQuery('after:2026-09-17', { timezone: 'Asia/Tokyo' });
  assert.notEqual(tokyo.compiled, london.compiled);
  assert.equal(tokyo.compiled, `after:${Date.UTC(2026, 8, 16, 15, 0, 0) / 1000}`);
});

test('every date form Gmail documents is understood, and negation survives', () => {
  const slashes = compileQuery('before:2026/01/05', { timezone: 'UTC' });
  assert.equal(slashes.compiled, `before:${Date.UTC(2026, 0, 5) / 1000}`);

  const american = compileQuery('after:01/05/2026', { timezone: 'UTC' });
  assert.equal(american.compiled, `after:${Date.UTC(2026, 0, 5) / 1000}`);

  const negated = compileQuery('-before:2026-01-05', { timezone: 'UTC' });
  assert.equal(negated.compiled, `-before:${Date.UTC(2026, 0, 5) / 1000}`);
});

test('everything that is not a date is left exactly as the user wrote it', () => {
  const query = 'from:sam@partner.test subject:"phase 2 plan" has:attachment older_than:7d {inbox spam} -in:trash';
  const compiled = compileQuery(query, { timezone: 'UTC' });
  assert.equal(compiled.compiled, query);
  assert.deepEqual(compiled.rewrites, []);
});

test('a quoted phrase holding a colon or spaces stays one token', () => {
  assert.deepEqual(tokenizeQuery('subject:"re: the plan" from:sam'), ['subject:"re: the plan"', 'from:sam']);
  assert.deepEqual(tokenizeQuery('  spaced   out  '), ['spaced', 'out']);
  assert.deepEqual(tokenizeQuery('"unclosed quote'), ['"unclosed quote']);
  // A date inside a quoted phrase is text, not an operator.
  assert.equal(compileQuery('subject:"after:2026-09-17"', { timezone: 'UTC' }).rewrites.length, 0);
});

test('daylight saving is taken from the zone, not assumed', () => {
  // London: BST in July (UTC+1), GMT in January (UTC+0).
  assert.equal(localMidnightEpochSeconds({ year: 2026, month: 7, day: 1 }, 'Europe/London'), Date.UTC(2026, 5, 30, 23) / 1000);
  assert.equal(localMidnightEpochSeconds({ year: 2026, month: 1, day: 1 }, 'Europe/London'), Date.UTC(2026, 0, 1, 0) / 1000);
  // A zone with a half-hour offset.
  assert.equal(localMidnightEpochSeconds({ year: 2026, month: 3, day: 1 }, 'Asia/Kolkata'), Date.UTC(2026, 1, 28, 18, 30) / 1000);
});

test('an unusable date or timezone leaves the query alone rather than guessing', () => {
  assert.equal(compileQuery('after:not-a-date', { timezone: 'UTC' }).compiled, 'after:not-a-date');
  assert.equal(compileQuery('after:2026-13-45', { timezone: 'Mars/Olympus' }).compiled, 'after:2026-13-45');
  assert.equal(localMidnightEpochSeconds({ year: 2026, month: 1, day: 1 }, 'Mars/Olympus'), null);
});
