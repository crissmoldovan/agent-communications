import assert from 'node:assert/strict';
import { test } from 'node:test';

type InstanceModule = typeof import('../src/control/instance.ts');

async function instanceModule(): Promise<InstanceModule | null> {
  return import('../src/control/instance.ts').catch(() => null);
}

test('CTRL-B1: stale recovery requires a dead owner and a failed authenticated probe', async () => {
  const instances = await instanceModule();
  assert.ok(instances, 'Task 6 supplies instance recovery');
  if (!instances) return;

  const record = {
    instanceId: 'instance-1',
    pid: 42,
    processStart: 'start-1',
    endpoint: '/tmp/events-control.sock',
    tokenFingerprint: 'f'.repeat(64),
  };
  assert.equal(
    await instances.mayRecoverStaleInstance({
      record,
      isProcessLive: async () => false,
      authenticatedProbe: async () => false,
      ownershipMatches: async () => true,
    }),
    true,
  );
  for (const refusal of [
    { isProcessLive: async () => true, authenticatedProbe: async () => false, ownershipMatches: async () => true },
    { isProcessLive: async () => false, authenticatedProbe: async () => true, ownershipMatches: async () => true },
    { isProcessLive: async () => false, authenticatedProbe: async () => false, ownershipMatches: async () => false },
  ]) {
    assert.equal(await instances.mayRecoverStaleInstance({ record, ...refusal }), false);
  }
});
