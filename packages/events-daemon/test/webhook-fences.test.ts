import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();
const { WebhookDispatcher } = await import('../src/runtime/webhook-dispatcher.ts');
const { EventLifecycle } = await import('../src/runtime/lifecycle.ts');
const { openEventDatabase } = await import('../src/store/database.ts');

const ACCOUNT = 'ibx_WEBHOOK_FENCES';

async function fixture() {
  const stateDir = await shortTempDir('events-webhook-fences-');
  const store = await openEventDatabase({ stateDir });
  const target = {
    targetId: 'target-fences',
    version: 1,
    kind: 'webhook' as const,
    url: { kind: 'plain' as const, value: 'https://receiver.test:44444/fenced' },
    approvedAddressSet: ['127.0.0.1'],
    signing: 'standard-webhooks' as const,
    ordering: 'strict' as const,
    retryLimit: 20,
    representation: 'plain' as const,
  };
  const targetJson = canonicalJson(target);
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  store.database.exec(`INSERT INTO rule_versions
    (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
    VALUES ('rule-fences@1', 'rule-fences', 1, '{"deliveryRateCap":20}', 'rule-digest', 'active', 'approval', 'activation', 1)`);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('target-fences@1', 'target-fences', 1, targetJson, sha256Hex(targetJson));
  store.database
    .prepare(
      `INSERT INTO event_secret_generations
       (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
       VALUES ('target', 'target-fences', 1, 'webhook-signing', 1, ?, ?, X'01', 'current', NULL, 1)`,
    )
    .run(sha256Hex(targetJson), sha256Hex('whsec_c2FmZS1maXh0dXJl'));
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-fences', ?, 'gmail.message.received', 1, ?, 'dedupe', 1, 1, 1)`,
    )
    .run(store.installationId, ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-fences', 'event-fences', ?, 'rule-fences', 1, 'matched', 2000000000000, 'retained')`,
    )
    .run(ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, encrypted_record, expires_at, state, switch_generation, next_at)
       VALUES ('delivery-fences', 'decision-fences', ?, 'rule-fences', 1, 'webhook:target-fences:1', 'target-fences',
        1, 'webhook', 'plain', ?, 2000000000000, 'queued', 7, 0)`,
    )
    .run(
      ACCOUNT,
      Buffer.from(JSON.stringify({ cloudEventBytes: '{"id":"fenced"}', untrusted: [], representation: 'plain' })),
    );
  return { stateDir, store };
}

test('B2-T6: pause before every DNS, TCP, TLS and write gate emits no later network action', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  for (const phase of ['dns', 'tcp', 'tls', 'write'] as const) {
    await t.test(phase, async () => {
      const setup = await fixture();
      const calls = { dns: 0, tcp: 0, tls: 0, write: 0 };
      const boundaries: string[] = [];
      const fakeSocket = {
        write() {
          calls.write += 1;
          return true;
        },
        destroy() {},
        once() {},
        on() {},
      };
      try {
        const dispatcher = new WebhookDispatcher({
          store: setup.store,
          cipher: {
            async decrypt(_: unknown, value: Uint8Array) {
              return Buffer.from(value);
            },
          },
          approvals: { get: async () => null },
          config: { load: async () => ({ inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
          fence: async (request: { readonly boundary: string }) => {
            boundaries.push(request.boundary);
          },
          secretReader: async () => [
            {
              generation: 1,
              lifecycle: 'current' as const,
              secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
              material: 'whsec_c2FmZS1maXh0dXJl',
            },
          ],
          resolver: {
            async lookup() {
              calls.dns += 1;
              return ['127.0.0.1'];
            },
          },
          tcpConnect: async () => {
            calls.tcp += 1;
            return fakeSocket as never;
          },
          tlsConnect: async () => {
            calls.tls += 1;
            return fakeSocket as never;
          },
          now: () => 1_700_000_000_000,
          beforeGate: async (current: string) => {
            if (current === phase) await new EventLifecycle(setup.store, () => 1_700_000_000_000).pause();
          },
        });
        assert.deepEqual(await dispatcher.dispatch('delivery-fences'), {
          state: 'paused',
          deliveryId: 'delivery-fences',
        });
        const expected = {
          dns: { dns: 0, tcp: 0, tls: 0, write: 0 },
          tcp: { dns: 1, tcp: 0, tls: 0, write: 0 },
          tls: { dns: 1, tcp: 1, tls: 0, write: 0 },
          write: { dns: 1, tcp: 1, tls: 1, write: 0 },
        }[phase];
        assert.deepEqual(calls, expected);
        assert.deepEqual(boundaries, [
          'dispatch',
          ...(['dns', 'tcp', 'tls', 'write'] as const)
            .slice(0, ['dns', 'tcp', 'tls', 'write'].indexOf(phase) + 1)
            .map((entry) => `webhook-${entry}`),
        ]);
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('B2-T6: the synchronous DNS gate starts resolution before a queued post-gate mutation can run', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  const events: string[] = [];
  let configReads = 0;
  let armPostGatePause = false;
  const originalImmediate = setup.store.immediate.bind(setup.store);
  const store = {
    ...setup.store,
    immediate(work: () => unknown) {
      const result = originalImmediate(work);
      if (armPostGatePause) {
        armPostGatePause = false;
        events.push('dns-gate');
        queueMicrotask(() => {
          events.push('pause');
          originalImmediate(() => {
            setup.store.database.prepare('UPDATE event_settings SET paused = 1').run();
          });
        });
      }
      return result;
    },
  };
  try {
    const dispatcher = new WebhookDispatcher({
      store: store as never,
      cipher: {
        async decrypt(_: unknown, value: Uint8Array) {
          return Buffer.from(value);
        },
      },
      approvals: { get: async () => null },
      config: {
        load: async () => {
          configReads += 1;
          if (configReads === 2) armPostGatePause = true;
          return { inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } };
        },
      } as never,
      fence: async () => undefined,
      secretReader: async () => [
        {
          generation: 1,
          lifecycle: 'current' as const,
          secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
          material: 'whsec_c2FmZS1maXh0dXJl',
        },
      ],
      resolver: {
        async lookup() {
          events.push('dns');
          return ['127.0.0.1'];
        },
      },
      tcpConnect: async () => {
        throw new Error('the post-DNS pause must win at the TCP gate');
      },
      now: () => 1_700_000_000_000,
    });
    assert.deepEqual(await dispatcher.dispatch('delivery-fences'), { state: 'paused', deliveryId: 'delivery-fences' });
    assert.deepEqual(events, ['dns-gate', 'dns', 'pause']);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: disable, replacement, target revocation, account removal and expiry after TCP all lose before TLS', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const cases = [
    {
      name: 'disable',
      mutate(store: Awaited<ReturnType<typeof openEventDatabase>>) {
        store.database.exec('UPDATE event_settings SET enabled = 0');
      },
      state: 'terminal',
    },
    {
      name: 'replacement',
      mutate(store: Awaited<ReturnType<typeof openEventDatabase>>) {
        store.database.exec('UPDATE target_versions SET document = \'{"replaced":true}\'');
      },
      state: 'terminal',
    },
    {
      name: 'target revocation',
      mutate(store: Awaited<ReturnType<typeof openEventDatabase>>) {
        store.database.exec('UPDATE target_versions SET revoked_at = 2');
      },
      state: 'terminal',
    },
    {
      name: 'expiry',
      mutate(store: Awaited<ReturnType<typeof openEventDatabase>>) {
        store.database.exec("UPDATE deliveries SET expires_at = 1 WHERE id = 'delivery-fences'");
      },
      state: 'expired',
    },
    {
      name: 'account removal',
      mutate(store: Awaited<ReturnType<typeof openEventDatabase>>) {
        store.database.exec('SELECT 1');
      },
      state: 'terminal',
      accountRemoved: true,
    },
  ] as const;
  for (const scenario of cases) {
    await t.test(scenario.name, async () => {
      const setup = await fixture();
      let accountLive = true;
      const calls = { tcp: 0, tls: 0, write: 0 };
      const fakeSocket = {
        write() {
          calls.write += 1;
          return true;
        },
        destroy() {},
        once() {},
        on() {},
      };
      try {
        const dispatcher = new WebhookDispatcher({
          store: setup.store,
          cipher: {
            async decrypt(_: unknown, value: Uint8Array) {
              return Buffer.from(value);
            },
          },
          approvals: { get: async () => null },
          config: {
            load: async () =>
              accountLive ? { inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } } : { inboxes: {} },
          } as never,
          fence: async () => undefined,
          secretReader: async () => [
            {
              generation: 1,
              lifecycle: 'current' as const,
              secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
              material: 'whsec_c2FmZS1maXh0dXJl',
            },
          ],
          resolver: { lookup: async () => ['127.0.0.1'] },
          tcpConnect: async () => {
            calls.tcp += 1;
            return fakeSocket as never;
          },
          tlsConnect: async () => {
            calls.tls += 1;
            return fakeSocket as never;
          },
          now: () => 1_700_000_000_000,
          beforeGate: (phase: string) => {
            if (phase !== 'tls') return;
            scenario.mutate(setup.store);
            if ('accountRemoved' in scenario && scenario.accountRemoved) accountLive = false;
          },
        });
        assert.deepEqual(await dispatcher.dispatch('delivery-fences'), {
          state: scenario.state,
          deliveryId: 'delivery-fences',
        });
        assert.deepEqual(calls, { tcp: 1, tls: 0, write: 0 }, 'no ClientHello or request follows the losing TLS gate');
        if ('accountRemoved' in scenario && scenario.accountRemoved) {
          const row = setup.store.database
            .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-fences'")
            .get() as { state: string; encrypted_record: Uint8Array | null };
          assert.equal(row.state, 'in-flight-at-account-removal');
          assert.equal(
            row.encrypted_record,
            null,
            'account removal keeps only its existing content-free in-flight outcome',
          );
        }
      } finally {
        setup.store.close();
        await rm(setup.stateDir, { recursive: true, force: true });
      }
    });
  }
});

test('B2-T6: a DNS answer that drifts outside its approved address set cannot begin TCP', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let tcp = 0;
  try {
    const dispatcher = new WebhookDispatcher({
      store: setup.store,
      cipher: {
        async decrypt(_: unknown, value: Uint8Array) {
          return Buffer.from(value);
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      secretReader: async () => [
        {
          generation: 1,
          lifecycle: 'current' as const,
          secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
          material: 'whsec_c2FmZS1maXh0dXJl',
        },
      ],
      resolver: { lookup: async () => ['192.168.0.1'] },
      tcpConnect: async () => {
        tcp += 1;
        throw new Error('TCP must not be attempted after address drift');
      },
    });
    await assert.rejects(dispatcher.dispatch('delivery-fences'), /outside approved|not permitted|approved/i);
    assert.equal(tcp, 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: a signing-generation change after its read loses the DNS gate before resolver invocation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let dns = 0;
  try {
    const dispatcher = new WebhookDispatcher({
      store: setup.store,
      cipher: {
        async decrypt(_: unknown, value: Uint8Array) {
          return Buffer.from(value);
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      secretReader: async () => [
        {
          generation: 1,
          lifecycle: 'current' as const,
          secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
          material: 'whsec_c2FmZS1maXh0dXJl',
        },
      ],
      resolver: {
        async lookup() {
          dns += 1;
          return ['127.0.0.1'];
        },
      },
      tcpConnect: async () => {
        throw new Error('a stale signing generation must not begin TCP');
      },
      beforeGate: (phase: string) => {
        if (phase === 'dns') {
          setup.store.database
            .prepare(
              `UPDATE event_secret_generations SET secret_digest = 'changed'
               WHERE owner_kind = 'target' AND owner_id = 'target-fences' AND owner_version = 1
                 AND purpose = 'webhook-signing' AND generation = 1`,
            )
            .run();
        }
      },
    });
    assert.deepEqual(await dispatcher.dispatch('delivery-fences'), {
      state: 'terminal',
      deliveryId: 'delivery-fences',
    });
    assert.equal(dns, 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: an expired overlap signing generation loses the DNS gate without resolving', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  let dns = 0;
  const overlapKey = 'whsec_b3ZlcmxhcC1maXh0dXJl';
  try {
    const target = setup.store.database
      .prepare("SELECT digest FROM target_versions WHERE target_id = 'target-fences' AND version = 1")
      .get() as { digest: string };
    setup.store.database
      .prepare(
        `INSERT INTO event_secret_generations
         (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
         VALUES ('target', 'target-fences', 1, 'webhook-signing', 2, ?, ?, X'02', 'overlap', ?, 1)`,
      )
      .run(target.digest, sha256Hex(overlapKey), 2_000_000_000_000);
    const dispatcher = new WebhookDispatcher({
      store: setup.store,
      cipher: {
        async decrypt(_: unknown, value: Uint8Array) {
          return Buffer.from(value);
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { mailbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      secretReader: async () => [
        {
          generation: 1,
          lifecycle: 'current' as const,
          secretDigest: sha256Hex('whsec_c2FmZS1maXh0dXJl'),
          material: 'whsec_c2FmZS1maXh0dXJl',
        },
        { generation: 2, lifecycle: 'overlap' as const, secretDigest: sha256Hex(overlapKey), material: overlapKey },
      ],
      resolver: {
        async lookup() {
          dns += 1;
          return ['127.0.0.1'];
        },
      },
      beforeGate: (phase: string) => {
        if (phase !== 'dns') return;
        setup.store.database
          .prepare(
            `UPDATE event_secret_generations SET expires_at = 1
             WHERE owner_kind = 'target' AND owner_id = 'target-fences' AND owner_version = 1
               AND purpose = 'webhook-signing' AND generation = 2`,
          )
          .run();
      },
    });
    assert.deepEqual(await dispatcher.dispatch('delivery-fences'), {
      state: 'terminal',
      deliveryId: 'delivery-fences',
    });
    assert.equal(dns, 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
