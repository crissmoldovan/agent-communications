import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveRegisteredListeners, stopRegisteredListeners } from './support/detached-listeners.ts';

test('the Gmail suite leaves none of its detached OAuth listeners alive', async () => {
  // A listener whose flow just finished may still be exiting (Windows is slow to reap a process), so wait up to ten
  // seconds for completed listeners before counting what remains as a leak.
  let live = await liveRegisteredListeners();
  for (let waited = 0; live.length > 0 && waited < 10_000; waited += 250) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    live = await liveRegisteredListeners();
  }
  try {
    assert.deepEqual(
      live,
      [],
      `detached oauth-listen processes are still alive after the Gmail suite: ${live
        .map((entry) => `${entry.pid} (${entry.flowId}) from ${entry.testFile} > ${entry.testName}`)
        .join(', ')}`,
    );
  } finally {
    await stopRegisteredListeners(live);
  }
});
