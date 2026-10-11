import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestControl } from '../src/control/client.ts';
import { startControlServer } from '../src/control/server.ts';
import { createOwnerB3ControlService } from '../src/runtime/owner.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';

test('B3 secret owner rejects every caller-selected app/window origin before the secret control and accepts only interactive-terminal', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-origin-'));
  const opened = await openEventDatabase({ stateDir });
  let storeCalls = 0;
  const secrets = {
    async targetSecretCreate() {
      storeCalls += 1;
      return { kind: 'target-secret', targetId: 'target-1', version: 1, generation: 1 };
    },
  };
  const owner = createOwnerB3ControlService({
    store: opened,
    ports: {
      quiescer: new WriterQuiescer(),
      secrets: secrets as never,
      assertObjectSecretReady: async () => ({ ready: true as const }),
    },
    config: { load: async () => ({ inboxes: {}, accounts: {} }) as never },
    activations: { issueApprovalViewChallenge: async () => null },
    cipher: { encrypt: async () => Buffer.alloc(0) },
  });
  try {
    for (const origin of ['app', 'window', 'secrets', 'forged-raw-control'] as const) {
      assert.deepEqual(
        await owner.handle({
          operation: 'targetSecretCreate',
          args: { targetId: 'target-1', version: 1 },
          origin,
        }),
        { kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' },
        `${origin} is a self-declared label, not C's future capability`,
      );
      assert.equal(storeCalls, 0, `${origin} is refused before a secret-store call`);
    }
    assert.deepEqual(
      await owner.handle({
        operation: 'targetSecretCreate',
        args: { targetId: 'target-1', version: 1 },
        origin: 'interactive-terminal',
      }),
      { kind: 'target-secret', targetId: 'target-1', version: 1, generation: 1 },
    );
    assert.equal(storeCalls, 1, 'only the terminal-labelled control request reaches the Task 2 secret engine');
  } finally {
    opened.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 same-user raw client holding the owner token may declare interactive-terminal; app/window/secrets labels remain refused', async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-origin-raw-'));
  const opened = await openEventDatabase({ stateDir });
  const endpoint = join(stateDir, 'control.sock');
  // The owner-only socket and its token are a same-OS-user boundary, not C's future non-forgeable window capability.
  // A raw client that holds this token can declare `interactive-terminal`; that is within the explicitly documented
  // same-user threat model. The CLI and MCP tests prove the repository-provided surfaces do not grant that power.
  // A short stand-in would be rejected as a malformed hello before it reached the authenticated-origin assertion.
  const token = 'a'.repeat(64);
  let storeCalls = 0;
  const owner = createOwnerB3ControlService({
    store: opened,
    ports: {
      quiescer: new WriterQuiescer(),
      secrets: {
        async targetSecretCreate() {
          storeCalls += 1;
          return { kind: 'target-secret', targetId: 'target-1', version: 1, generation: 1 };
        },
      } as never,
      assertObjectSecretReady: async () => ({ ready: true as const }),
    },
    config: { load: async () => ({ inboxes: {}, accounts: {} }) as never },
    activations: { issueApprovalViewChallenge: async () => null },
    cipher: { encrypt: async () => Buffer.alloc(0) },
  });
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  try {
    try {
      control = await startControlServer({
        endpoint,
        token,
        verifyEndpoint: async () => undefined,
        handle: async (request) =>
          owner.handle({
            operation: request.operation as 'targetSecretCreate',
            args: request.args,
            origin: request.origin,
          }),
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('sandbox does not permit the Unix socket needed for the raw authenticated-control proof');
        return;
      }
      throw error;
    }
    const record = {
      instanceId: '0'.repeat(32),
      pid: process.pid,
      processStart: 'test',
      endpoint,
      tokenFingerprint: '0'.repeat(64),
    };
    for (const origin of ['app', 'window', 'secrets'] as const) {
      assert.deepEqual(
        await requestControl(record, token, origin, 'targetSecretCreate', { targetId: 'target-1', version: 1 }),
        { kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' },
      );
      assert.equal(storeCalls, 0, `${origin} is rejected before the secret control`);
    }
    assert.deepEqual(
      await requestControl(record, token, 'interactive-terminal', 'targetSecretCreate', {
        targetId: 'target-1',
        version: 1,
      }),
      { kind: 'target-secret', targetId: 'target-1', version: 1, generation: 1 },
    );
    assert.equal(storeCalls, 1);
  } finally {
    await control?.close();
    opened.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
