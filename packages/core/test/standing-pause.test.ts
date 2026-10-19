import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CommsError } from '../src/errors.ts';
import { STANDING_PAUSE_MS, standingPause } from '../src/standing-pause.ts';

/*
 * The pause between deciding a standing act and making it (design 2026-10-19-standing-approvals, S9, the lead's call
 * after review): 5 to 30 seconds, drawn from the operating system's CSPRNG. Every test injects the sleep, so none waits.
 */

test('it sleeps what the source drew, from 5 to 30 seconds, and says how long', async () => {
  const asked: [number, number][] = [];
  const slept: number[] = [];
  const pause = standingPause({
    random: (min, max) => {
      asked.push([min, max]);
      return 12_345;
    },
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  assert.equal(await pause(), 12_345);
  assert.deepEqual(asked, [[5_000, 30_000]]);
  assert.deepEqual(slept, [12_345]);
  assert.deepEqual(STANDING_PAUSE_MS, { min: 5_000, max: 30_000 });
});

test('a source that draws outside the range, or no whole number, is refused before anything sleeps', async () => {
  for (const drawn of [0, 4_999, 30_001, 7_000.5, Number.NaN]) {
    const slept: number[] = [];
    const pause = standingPause({
      random: () => drawn,
      sleep: async (ms) => {
        slept.push(ms);
      },
    });
    await assert.rejects(pause(), (error: unknown) => error instanceof CommsError && error.code === 'UNEXPECTED');
    assert.deepEqual(slept, [], String(drawn));
  }
});

test('the default source is the CSPRNG: every draw in range, both ends included, and not one value', async () => {
  const slept: number[] = [];
  const pause = standingPause({
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  for (let draw = 0; draw < 200; draw += 1) await pause();
  for (const ms of slept) {
    assert.ok(Number.isSafeInteger(ms) && ms >= 5_000 && ms <= 30_000, String(ms));
  }
  assert.ok(new Set(slept).size > 100, 'two hundred draws from 25,001 values are not a handful');
});
