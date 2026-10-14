import assert from 'node:assert/strict';
import { test } from 'node:test';
import { liveRegisteredListeners, stopRegisteredListeners } from './support/detached-listeners.ts';

test('the Gmail suite leaves none of its detached OAuth listeners alive', async () => {
  const live = await liveRegisteredListeners();
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
