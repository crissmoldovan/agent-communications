import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Throttle } from '../src/api/throttle.ts';

const INTERVAL = 10;

function controlledClock(initial = 0): {
  now: () => number;
  set: (value: number) => void;
  sleep: (ms: number) => Promise<void>;
  sleeps: readonly { ms: number; wake: () => void }[];
  wake: (index: number) => void;
} {
  let now = initial;
  const sleeps: Array<{ ms: number; wake: () => void }> = [];
  return {
    now: () => now,
    set: (value) => {
      now = value;
    },
    sleep: async (ms) => new Promise<void>((resolve) => sleeps.push({ ms, wake: resolve })),
    sleeps,
    wake: (index) => sleeps[index]?.wake(),
  };
}

/**
 * Waits for the throttle's file-lock I/O to reach a state, bounded by wall time rather than event-loop turns: under a
 * parallel full verify that I/O can take longer than a hundred turns without anything being wrong.
 */
async function until(condition: () => boolean, message: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
  if (condition()) return;
  assert.fail(message);
}

test('background reads take at most every other throttle slot under contention', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resend-priority-'));
  try {
    let now = 0;
    const grants: number[] = [];
    const waits: number[] = [];
    const throttle = new Throttle(dir, {
      intervalMs: INTERVAL,
      now: () => now,
      sleep: async (ms) => {
        waits.push(ms);
        now += ms;
      },
    });

    await throttle.before('background-event');
    grants.push(now);
    await throttle.before('background-event');
    grants.push(now);
    await throttle.before('background-event');
    grants.push(now);

    assert.deepEqual(grants, [0, 20, 40]);
    assert.deepEqual(waits, [20, 20]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an interactive read arriving while background reads wait takes the next free slot', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resend-priority-'));
  try {
    const clock = controlledClock();
    const throttle = new Throttle(dir, { intervalMs: INTERVAL, now: clock.now, sleep: clock.sleep });
    await throttle.before();

    const background = throttle.before('background-event');
    await until(() => clock.sleeps.length === 1, 'the background read should be waiting for the next slot');
    let interactiveFinished = false;
    const interactive = throttle.before().then(() => {
      interactiveFinished = true;
    });
    await until(() => clock.sleeps.length === 2, 'the interactive read should reserve the next slot');
    assert.equal(clock.sleeps[1]?.ms, INTERVAL, 'the interactive read waits at most one interval');

    clock.set(INTERVAL);
    clock.wake(0);
    clock.wake(1);
    await until(() => clock.sleeps.length === 3, 'the deferred read should schedule its next interval wait');
    const interactiveFinishedAtNextSlot = interactiveFinished;

    clock.set(INTERVAL * 2);
    clock.wake(2);
    await Promise.all([background, interactive]);
    assert.equal(interactiveFinishedAtNextSlot, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an abandoned background waiter leaves no durable entry or delay for a later read', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resend-priority-'));
  try {
    const clock = controlledClock();
    const throttle = new Throttle(dir, { intervalMs: INTERVAL, now: clock.now, sleep: clock.sleep });
    await throttle.before();

    void throttle.before('background-event');
    await until(() => clock.sleeps.length === 1, 'the abandoned background read should be sleeping');
    const state = JSON.parse(await readFile(throttle.path, 'utf8')) as Record<string, unknown>;
    assert.equal('waiting' in state, false);
    assert.equal('lastGranted' in state, false);

    let laterFinished = false;
    void throttle.before().then(() => {
      laterFinished = true;
    });
    await until(() => clock.sleeps.length === 2, 'the later interactive read should reserve the next slot');
    clock.set(INTERVAL);
    clock.wake(1);
    await until(() => laterFinished, 'the later read should not wait behind the abandoned background read');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('obsolete waiter fields in the shared state file are ignored and removed on the next write', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resend-priority-'));
  try {
    const throttle = new Throttle(dir, {
      intervalMs: INTERVAL,
      now: () => 0,
      sleep: async (ms) => {
        throw new Error(`unexpected wait of ${ms} ms`);
      },
    });
    await mkdir(join(dir, 'resend'), { recursive: true });
    await writeFile(
      throttle.path,
      JSON.stringify({
        next: 0,
        blockedUntil: 0,
        waiting: [{ id: 'abandoned', priority: 'background-event', queuedAt: 0 }],
        lastGranted: 'background-event',
      }),
    );

    await throttle.before();

    assert.deepEqual(JSON.parse(await readFile(throttle.path, 'utf8')), { next: INTERVAL, blockedUntil: 0 });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('background polling never schedules another lock attempt faster than one interval', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'resend-priority-'));
  try {
    const clock = controlledClock();
    const throttle = new Throttle(dir, { intervalMs: INTERVAL, now: clock.now, sleep: clock.sleep });
    await throttle.before();

    void throttle.before('background-event');
    await until(() => clock.sleeps.length === 1, 'the first background read should be waiting');
    void throttle.before('background-event');
    await until(() => clock.sleeps.length === 2, 'the second background read should be waiting');

    assert.ok(
      clock.sleeps.every(({ ms }) => ms >= INTERVAL),
      `scheduled waits: ${clock.sleeps.map(({ ms }) => ms)}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
