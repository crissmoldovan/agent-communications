import assert from 'node:assert/strict';
import { startLoopbackTrap } from '../loopback-trap.mjs';

export async function noEgressSentinel() {
  const trap = await startLoopbackTrap();
  return {
    ...trap,
    audit() {
      assert.deepEqual(trap.requests, [], 'external request reached synthetic trap');
    },
  };
}
