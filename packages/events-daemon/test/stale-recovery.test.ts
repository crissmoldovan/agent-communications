import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverDeliveryLeases } from '../src/runtime/recovery.ts';

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

test('B2-T5: delivery lease recovery reaches the shared target dispatcher exactly once', async () => {
  let recoveries = 0;
  const expected = [{ state: 'terminal' as const, deliveryId: 'expired-lease' }];
  assert.deepEqual(
    await recoverDeliveryLeases({
      async recoverLeases() {
        recoveries += 1;
        return expected;
      },
    } as never),
    expected,
  );
  assert.equal(recoveries, 1);
});
