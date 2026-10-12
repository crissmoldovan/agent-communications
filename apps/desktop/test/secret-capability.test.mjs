import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test as nodeTest } from 'node:test';
import { fixture } from './helpers/secret-fixture.mjs';

const unavailable = { kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' };
const test = process.platform === 'win32' ? nodeTest.skip : nodeTest;
// Production paths exercised by the owner fixture:
// ../../../packages/events-daemon/src/runtime/owner.ts
// ../../../packages/events-daemon/src/runtime/desktop-secret-capability.ts
// ../../../packages/events-daemon/src/runtime/desktop-secret-result.ts

// desktop-mutation: desktop-secret-app-result
test('secret-capability: real owner accepts a matching session operation and MAC once', async () =>
  fixture(async ({ request, issue }) => {
    const capability = await issue();
    const result = await request('targetSecretCreate', { targetId: 'target-capability', version: 1, capability });
    assert.equal(result.kind, 'RevealOnce', 'matching proof reaches the real secret engine');
    assert.equal(typeof result.material === 'string', true);
  }));

// desktop-mutation: desktop-secret-trace
test('secret-trace: real owner leaves hidden and generated material off every non-secret durable and reply surface', async (t) =>
  fixture(async ({ request, issue, root }) => {
    const captures = [];
    for (const method of ['log', 'warn', 'error', 'debug'])
      t.mock.method(console, method, (...args) => {
        captures.push(args);
      });
    const hidden = 'synthetic-hidden-trace-judge';
    await request('judgeKeySet', {
      judgeId: 'judge-capability',
      version: 1,
      hidden,
      capability: await issue('judgeKeySet'),
    });
    const generated = await request('targetSecretCreate', {
      targetId: 'target-capability',
      version: 1,
      capability: await issue(),
    });
    assert.equal(generated.kind, 'RevealOnce');
    const sentinels = [hidden, generated.material];
    const surfaces = [captures, await request('status'), await request('targets-list'), await request('judgesList')];
    for (const surface of surfaces)
      for (const sentinel of sentinels)
        assert.equal(
          JSON.stringify(surface).includes(sentinel),
          false,
          'material leaked to a non-secret response or log',
        );
    async function scan(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        if (entry.name === 'secrets') continue;
        const path = join(directory, entry.name);
        if (entry.isDirectory()) await scan(path);
        else if (entry.isFile()) {
          const bytes = await readFile(path);
          for (const sentinel of sentinels)
            assert.equal(
              bytes.includes(Buffer.from(sentinel)),
              false,
              'material leaked to audit, SQLite/WAL, or a preference',
            );
        }
      }
    }
    await scan(root);
  }));

async function attackProof(attack) {
  return fixture(async ({ request, issue }) => {
    const capability = await issue();
    const args = { targetId: 'target-capability', version: 1, capability };
    if (attack === 'missing') delete args.capability;
    if (attack === 'forged') args.capability = { ...capability, mac: '0'.repeat(64) };
    if (attack === 'replay') {
      const first = await request('targetSecretCreate', args);
      assert.equal(first.kind, 'RevealOnce');
    }
    const result = await request(
      attack === 'cross-operation' ? 'targetSecretRotate' : 'targetSecretCreate',
      args,
      attack === 'cross-session' ? 'session-b' : 'session-a',
    );
    assert.equal(JSON.stringify(result) === JSON.stringify(unavailable), true, 'proof must be refused');
  });
}

// desktop-mutation: desktop-secret-attached-label
test('secret-capability: an attached owner never trusts a window label', async () =>
  fixture(async ({ request }) => {
    for (const origin of ['app', 'secrets', 'desktop-secrets']) {
      const result = await request(
        'targetSecretCreate',
        { targetId: 'target-capability', version: 1, capability: { nonce: '0'.repeat(64), mac: '0'.repeat(64) } },
        'session-a',
        origin,
      );
      assert.equal(JSON.stringify(result) === JSON.stringify(unavailable), true, 'label must not confer authority');
    }
  }, false));

// desktop-mutation: desktop-secret-missing-hmac
test('secret-capability: real owner refuses missing proof', () => attackProof('missing'));

// desktop-mutation: desktop-secret-forged-hmac
test('secret-capability: real owner refuses forged proof', () => attackProof('forged'));

// desktop-mutation: desktop-secret-failed-proof-consumption
test('secret-capability: real owner consumes a nonce before every failed proof validation', async () =>
  fixture(async ({ request, issue }) => {
    const attempts = [
      {
        name: 'malformed MAC',
        invalid: (capability) => ({ nonce: capability.nonce, mac: 'x' }),
      },
      {
        name: 'wrong MAC',
        invalid: (capability) => ({ ...capability, mac: '0'.repeat(64) }),
      },
      {
        name: 'wrong session',
        session: 'session-b',
        invalid: (capability) => capability,
      },
      {
        name: 'wrong operation',
        operation: 'targetSecretRotate',
        invalid: (capability) => capability,
      },
      {
        name: 'expired proof',
        expires: true,
        invalid: (capability) => capability,
      },
    ];
    for (const attempt of attempts) {
      const capability = await issue();
      const originalNow = Date.now;
      try {
        if (attempt.expires) Date.now = () => originalNow() + 60_001;
        const refused = await request(
          attempt.operation ?? 'targetSecretCreate',
          { targetId: 'target-capability', version: 1, capability: attempt.invalid(capability) },
          attempt.session ?? 'session-a',
        );
        assert.equal(refused.kind, unavailable.kind, `${attempt.name} must be refused`);
        assert.equal(refused.code, unavailable.code, `${attempt.name} must be refused`);
        const retried = await request('targetSecretCreate', {
          targetId: 'target-capability',
          version: 1,
          capability,
        });
        assert.equal(retried.kind, unavailable.kind, `${attempt.name} must consume the original nonce`);
        assert.equal(retried.code, unavailable.code, `${attempt.name} must consume the original nonce`);
      } finally {
        Date.now = originalNow;
      }
    }
  }));

// desktop-mutation: desktop-secret-capability-replay
test('secret-capability: real owner refuses replay proof', () => attackProof('replay'));

// desktop-mutation: desktop-secret-cross-session
test('secret-capability: real owner refuses cross-session proof', () => attackProof('cross-session'));

// desktop-mutation: desktop-secret-cross-operation
test('secret-capability: real owner refuses cross-operation proof', () => attackProof('cross-operation'));

// desktop-mutation: desktop-secret-session-close
test('secret-close-race: owner discards unused authority when the native secret session closes', async () =>
  fixture(async ({ request, issue, closeSession }) => {
    const capability = await issue();
    assert.equal(typeof closeSession, 'function', 'owner must invalidate capability when the transport closes');
    closeSession('session-a');
    const result = await request('targetSecretCreate', { targetId: 'target-capability', version: 1, capability });
    assert.equal(
      JSON.stringify(result) === JSON.stringify(unavailable),
      true,
      'closed session must not retain authority',
    );
  }));
