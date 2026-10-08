import assert from 'node:assert/strict';
import { test } from 'node:test';

type ProtocolModule = typeof import('../src/control/protocol.ts');

async function protocolModule(): Promise<ProtocolModule | null> {
  return import('../src/control/protocol.ts').catch(() => null);
}

test('CTRL-B1: version overlap selects the highest mutual protocol and no overlap is a typed refusal', async () => {
  const protocol = await protocolModule();
  assert.ok(protocol, 'Task 6 supplies protocol compatibility checks');
  if (!protocol) return;

  assert.deepEqual(protocol.negotiateVersion([1, 2, 3], [1, 3]), { ok: true, version: 3 });
  assert.deepEqual(protocol.negotiateVersion([1], [2, 3]), { ok: false, code: 'PROTOCOL_UNSUPPORTED' });
});
