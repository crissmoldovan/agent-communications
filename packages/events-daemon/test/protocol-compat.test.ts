import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('control fixture vectors use the production frame and version parser', async () => {
  const protocol = await protocolModule();
  assert.ok(protocol);
  if (!protocol) return;
  const vectors = JSON.parse(await readFile(new URL('./fixtures/control-protocol-v1.json', import.meta.url), 'utf8'));
  for (const name of ['validHello', 'validRequest', 'success', 'failure']) {
    assert.deepEqual(protocol.decodeControlFrame(protocol.encodeControlFrame(vectors[name])), vectors[name]);
  }
  assert.equal(Buffer.from(protocol.encodeControlFrame({ ok: true })).toString('hex'), vectors.simpleFrameHex);
  assert.throws(() => protocol.decodeControlFrame(Buffer.from(vectors.malformedHex, 'hex')));
  assert.throws(() => protocol.decodeControlFrame(Buffer.from(vectors.oversizePrefixHex, 'hex')));
  assert.deepEqual(protocol.negotiateVersion(vectors.noOverlap.hello.supportedVersions, [1]), {
    ok: false,
    code: 'PROTOCOL_UNSUPPORTED',
  });
});
