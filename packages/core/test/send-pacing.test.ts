import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SEND_RETRY_BUDGET_MS, SEND_RETRY_MAX, sendPacing } from '../src/send-pacing.ts';

/**
 * The pacing a throttled send waits by (design 2026-10-08 §R2): the provider's wait when it gives one, backoff when it
 * does not, at most three retries and 45 seconds of waiting, and never a wait started that would run past the budget.
 * A clock and a sleep are injected, so nothing here waits for real.
 */

function clock(start = 1_000_000) {
  let now = start;
  const slept: number[] = [];
  return {
    now: () => now,
    sleep: async (ms: number) => {
      slept.push(ms);
      now += ms;
    },
    advance: (ms: number) => {
      now += ms;
    },
    slept,
  };
}

test('the budget is three retries and 45 seconds, well inside the two-minute sending lease', () => {
  assert.equal(SEND_RETRY_MAX, 3);
  assert.equal(SEND_RETRY_BUDGET_MS, 45_000);
});

test("the provider's wait is the wait, while it fits", async () => {
  const c = clock();
  const pacing = sendPacing({ now: c.now, sleep: c.sleep });
  assert.equal(pacing.next(2_000), 2_000);
  await pacing.wait(2_000);
  assert.equal(pacing.next(10_000), 10_000);
  await pacing.wait(10_000);
  assert.deepEqual(c.slept, [2_000, 10_000]);
  assert.equal(pacing.retries, 2);
});

test('without a wait from the provider, the backoff starts at one second and grows, with jitter', () => {
  const low = sendPacing({ now: () => 0, random: () => 0 });
  const high = sendPacing({ now: () => 0, random: () => 1 });
  // Half the step plus up to the other half: never zero, never more than the step.
  assert.deepEqual([low.next(), low.next(), low.next()], [500, 1_000, 2_000]);
  assert.deepEqual([high.next(), high.next(), high.next()], [1_000, 2_000, 4_000]);
});

test('no fourth retry, however short the wait', () => {
  const pacing = sendPacing({ now: () => 0 });
  assert.notEqual(pacing.next(1), null);
  assert.notEqual(pacing.next(1), null);
  assert.notEqual(pacing.next(1), null);
  assert.equal(pacing.next(1), null);
  assert.equal(pacing.retries, 3);
});

test('a wait that would run past the budget is not started, and spends no retry', async () => {
  const c = clock();
  const pacing = sendPacing({ now: c.now, sleep: c.sleep });
  // Gmail's sending limit names a time hours away: the send stops at once.
  assert.equal(pacing.next(3 * 60 * 60 * 1000), null);
  assert.equal(pacing.retries, 0);
  // Time spent on attempts counts too: 40 s gone leaves 5 s, so a 6 s wait is refused and a 4 s one is not.
  c.advance(40_000);
  assert.equal(pacing.next(6_000), null);
  assert.equal(pacing.next(4_000), 4_000);
});

test('a negative or unusable wait from the provider falls back to the backoff', () => {
  const pacing = sendPacing({ now: () => 0, random: () => 1 });
  assert.equal(pacing.next(-5), 1_000);
  assert.equal(pacing.next(Number.NaN), 2_000);
});
