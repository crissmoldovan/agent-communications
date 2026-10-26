import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { EventControlClient } from '../src/control/client.ts';
import { runEventOwner } from '../src/runtime/owner.ts';
import { eventPaths } from '../src/runtime/paths.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

/** Waits until the owner answers its control socket, failing at once if `running` settles first. */
async function untilAnswering(client: EventControlClient, running: Promise<void>): Promise<void> {
  let settled = false;
  running.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  // Bounded generously: the Mac this runs on is often loaded by other work.
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (settled) {
      await running;
      assert.fail('the owner stopped before it answered its control socket');
    }
    try {
      await client.request('status');
      return;
    } catch {
      if (Date.now() > deadline) assert.fail('the owner did not answer its control socket within 60 s');
      await delay(25);
    }
  }
}

async function lastStopNames(eventsDir: string): Promise<string[]> {
  return (await readdir(eventsDir)).filter((name) => name.startsWith('last-stop')).sort();
}

test('a stop by request writes last-stop.json with this pid, a time after the start and reason request', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-last-stop-');
  try {
    const configDir = await emptyConfigDir(stateDir);
    const eventsDir = eventPaths(stateDir).root;
    const startedAt = Date.now();
    const running = runEventOwner({ ...noRealHome(stateDir), stateDir, configDir });
    const client = new EventControlClient({ stateDir, clientName: 'events-daemon-last-stop-test' });
    await untilAnswering(client, running);
    assert.deepEqual(await lastStopNames(eventsDir), [], 'a running owner has written no marker');

    // `agent-events stop`'s own path: the control request runs the owner's stop().
    assert.deepEqual(await client.request('stop'), { stopping: true });
    await running;
    const stoppedAt = Date.now();

    const file = join(eventsDir, 'last-stop.json');
    const marker: unknown = JSON.parse(await readFile(file, 'utf8'));
    assert.ok(typeof marker === 'object' && marker !== null && 'at' in marker);
    const { at } = marker as { at: unknown };
    assert.equal(typeof at, 'string');
    assert.deepEqual(marker, { version: 1, pid: process.pid, at, reason: 'request' });
    const atMs = Date.parse(at as string);
    assert.ok(Number.isFinite(atMs), 'at is an ISO 8601 time');
    assert.equal(new Date(atMs).toISOString(), at, 'at is written as ISO 8601');
    assert.ok(atMs >= startedAt, 'the marker is newer than the start');
    assert.ok(atMs <= stoppedAt, 'the marker was written by this stop');
    assert.equal((await stat(file)).mode & 0o777, 0o600, 'the marker is owner-only');
    assert.deepEqual(await lastStopNames(eventsDir), ['last-stop.json'], 'no temporary file is left beside it');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  // A logout, a shutdown or a kill is not the person's decision: the desktop app restarts a service stopped so.
  test(`a stop by ${signal} writes last-stop.json with reason signal`, { skip: WINDOWS_SKIP }, async () => {
    const stateDir = await shortTempDir('aev-last-stop-signal-');
    try {
      const configDir = await emptyConfigDir(stateDir);
      const eventsDir = eventPaths(stateDir).root;
      // The owner hears its signals through this seam, so the test runner's own handlers on `process` never fire.
      const signals = new EventEmitter();
      const running = runEventOwner({ ...noRealHome(stateDir), stateDir, configDir, signals });
      const client = new EventControlClient({ stateDir, clientName: 'events-daemon-last-stop-signal-test' });
      let stopped = false;
      try {
        await untilAnswering(client, running);
        assert.equal(signals.listenerCount(signal), 1, `the owner listens for ${signal}`);
        signals.emit(signal);
        await running;
        stopped = true;
      } finally {
        // An owner that did not hear the signal is stopped here, so a failure never leaves it running.
        if (!stopped) {
          await client.request('stop').catch(() => undefined);
          await running.catch(() => undefined);
        }
      }
      const marker: unknown = JSON.parse(await readFile(join(eventsDir, 'last-stop.json'), 'utf8'));
      const { at } = marker as { at: unknown };
      assert.deepEqual(marker, { version: 1, pid: process.pid, at, reason: 'signal' });
      assert.equal(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT'), 0, 'its listeners are gone');
      assert.equal((await stat(join(eventsDir, 'last-stop.json'))).mode & 0o777, 0o600);
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  });
}

test('an owner that fails to start writes no marker', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('aev-last-stop-fail-');
  try {
    const configDir = await emptyConfigDir(stateDir);
    const eventsDir = eventPaths(stateDir).root;
    // The owner exists and its stop() runs before the start rethrows, as judge-hold-retention's control seam shows.
    await assert.rejects(
      runEventOwner({
        ...noRealHome(stateDir),
        stateDir,
        configDir,
        startControlServer: async () => {
          throw new Error('the control server refused to start');
        },
      }),
      /the control server refused to start/,
    );
    // Refused before the owner exists, as phase-d-owner-composition's missing seam is.
    await assert.rejects(
      runEventOwner({
        ...noRealHome(stateDir),
        stateDir,
        configDir,
        phaseDComposition: () => {
          throw new Error('the composition refused');
        },
      }),
      /the composition refused/,
    );
    assert.deepEqual(await lastStopNames(eventsDir), [], 'a failed start leaves no last-stop.json');
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
