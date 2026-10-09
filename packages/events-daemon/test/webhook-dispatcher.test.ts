import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import tls from 'node:tls';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { startLoopbackReceiver, startLoopbackTlsReceiver } from './support/loopback-receiver.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { createLoopbackTestTls } from './support/test-tls.ts';

assertLoopbackSeal();
const { WebhookDispatcher, classifyWebhookResponseStatus } = await import('../src/runtime/webhook-dispatcher.ts');
const { openEventDatabase } = await import('../src/store/database.ts');

const ACCOUNT = 'ibx_WEBHOOK_DISPATCH';
const SIGNING_KEY = 'whsec_c3VwZXJzZWNyZXQ=';

test('B2-T6: webhook response classification keeps only numeric success state and never follows a redirect', () => {
  assert.deepEqual(classifyWebhookResponseStatus(204), { kind: 'response', status: 204, success: true });
  assert.deepEqual(classifyWebhookResponseStatus(503), { kind: 'response', status: 503, success: false });
  assert.deepEqual(classifyWebhookResponseStatus(302), { kind: 'response', status: 302, success: false });
});

async function fixture(url: string) {
  const stateDir = await shortTempDir('events-webhook-dispatch-');
  const store = await openEventDatabase({ stateDir });
  const target = {
    targetId: 'target-webhook',
    version: 1,
    kind: 'webhook' as const,
    url: { kind: 'plain' as const, value: url },
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
    VALUES ('rule-webhook@1', 'rule-webhook', 1, '{"deliveryRateCap":20}', 'rule-digest', 'active', 'approval', 'activation', 1)`);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('target-webhook@1', 'target-webhook', 1, targetJson, sha256Hex(targetJson));
  store.database
    .prepare(
      `INSERT INTO event_secret_generations
       (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
       VALUES ('target', 'target-webhook', 1, 'webhook-signing', 1, ?, ?, X'01', 'current', NULL, 1)`,
    )
    .run(sha256Hex(targetJson), sha256Hex(SIGNING_KEY));
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-webhook', ?, 'gmail.message.received', 1, ?, 'dedupe', 1, 1, 1)`,
    )
    .run(store.installationId, ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-webhook', 'event-webhook', ?, 'rule-webhook', 1, 'matched', 2000000000000, 'retained')`,
    )
    .run(ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, encrypted_record, expires_at, state, switch_generation, next_at)
       VALUES ('delivery-webhook', 'decision-webhook', ?, 'rule-webhook', 1, 'webhook:target-webhook:1',
        'target-webhook', 1, 'webhook', 'plain', ?, 2000000000000, 'queued', 7, 0)`,
    )
    .run(
      ACCOUNT,
      Buffer.from(
        JSON.stringify({
          cloudEventBytes: '{"id":"delivery-webhook","value":"stable"}',
          untrusted: [],
          representation: 'plain',
        }),
      ),
    );
  const dispatcher = (options: Record<string, unknown> = {}) =>
    new WebhookDispatcher({
      store,
      cipher: {
        async decrypt(_: unknown, bytes: Uint8Array) {
          return Buffer.from(bytes);
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      secretReader: async ({ purpose }: { readonly purpose: string }) =>
        purpose === 'webhook-signing'
          ? [
              {
                generation: 1,
                lifecycle: 'current' as const,
                secretDigest: sha256Hex(SIGNING_KEY),
                material: SIGNING_KEY,
              },
            ]
          : [],
      now: () => 1_700_000_000_000,
      resolver: { lookup: async () => ['127.0.0.1'] },
      ...options,
    });
  return { stateDir, store, dispatcher };
}

test('B2-T6: a webhook posts the prepared CloudEvent bytes with Standard Webhooks headers and leaves outcome ownership for Task 7', {
  skip: WINDOWS_SKIP,
}, async () => {
  let request = '';
  const receiver = await startLoopbackReceiver((socket) => {
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (request.includes('\r\n\r\n') && request.endsWith('{"id":"delivery-webhook","value":"stable"}')) {
        socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
  });
  const setup = await fixture(`http://${receiver.host}:${receiver.port}/webhook`);
  try {
    assert.deepEqual(await setup.dispatcher().dispatch('delivery-webhook'), {
      state: 'issued',
      deliveryId: 'delivery-webhook',
    });
    assert.match(request, /^POST \/webhook HTTP\/1\.1\r\nHost: 127\.0\.0\.1:/);
    assert.match(request, /Content-Type: application\/cloudevents\+json; charset=utf-8/);
    assert.match(request, /webhook-id: delivery-webhook/);
    assert.match(request, /webhook-timestamp: 1700000000/);
    assert.match(request, /webhook-signature: v1,[A-Za-z0-9+/]+=*/);
    assert.match(request, /\r\n\r\n\{"id":"delivery-webhook","value":"stable"\}$/);
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, attempts FROM deliveries WHERE id = 'delivery-webhook'")
          .get() as object),
      },
      { state: 'disclosing', attempts: 1 },
      'Task 6 has issued bytes but Task 7 owns outcome settlement',
    );
  } finally {
    setup.store.close();
    await receiver.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: a redirect is classified as one issued webhook outcome and is never followed', {
  skip: WINDOWS_SKIP,
}, async () => {
  let connections = 0;
  const receiver = await startLoopbackReceiver((socket) => {
    connections += 1;
    socket.once('data', () => {
      socket.end('HTTP/1.1 302 Found\r\nLocation: /elsewhere\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
  });
  const setup = await fixture(`http://${receiver.host}:${receiver.port}/first`);
  try {
    assert.deepEqual(await setup.dispatcher().dispatch('delivery-webhook'), {
      state: 'issued',
      deliveryId: 'delivery-webhook',
    });
    assert.equal(connections, 1, 'the raw adapter does not follow Location');
  } finally {
    setup.store.close();
    await receiver.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: a network outcome is content-free and leaves retry/backoff ownership with Task 7', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture('https://receiver.test:44444/network');
  const outcomes: unknown[] = [];
  let errorListener: ((error: Error) => void) | undefined;
  const fakeSocket = {
    write() {
      queueMicrotask(() => errorListener?.(new Error('fixture network reset')));
      return true;
    },
    destroy() {},
    once(event: string, listener: (error: Error) => void) {
      if (event === 'error') errorListener = listener;
      return this;
    },
    on() {
      return this;
    },
  };
  try {
    assert.deepEqual(
      await setup
        .dispatcher({
          tcpConnect: async () => fakeSocket as never,
          tlsConnect: async () => fakeSocket as never,
          onOutcome: async (_claim: unknown, outcome: unknown) => outcomes.push(outcome),
        })
        .dispatch('delivery-webhook'),
      { state: 'issued', deliveryId: 'delivery-webhook' },
    );
    assert.deepEqual(outcomes, [{ kind: 'network' }]);
    const row = setup.store.database
      .prepare("SELECT state, attempts, next_at FROM deliveries WHERE id = 'delivery-webhook'")
      .get() as { state: string; attempts: number; next_at: number };
    assert.equal(row.state, 'disclosing');
    assert.equal(row.attempts, 1);
    assert.equal(row.next_at, 0, 'Task 6 does not create retry/backoff state; Task 7 settles the one live lease');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6: an HTTPS webhook uses a per-test loopback certificate over the separately fenced TLS connection', {
  skip: WINDOWS_SKIP,
}, async () => {
  const material = await createLoopbackTestTls();
  let request = '';
  const receiver = await startLoopbackTlsReceiver(material, (socket) => {
    socket.on('data', (chunk) => {
      request += chunk.toString('utf8');
      if (request.includes('\r\n\r\n')) {
        socket.end('HTTP/1.1 204 No Content\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      }
    });
  });
  const setup = await fixture(`https://${receiver.host}:${receiver.port}/secure`);
  try {
    assert.deepEqual(
      await setup
        .dispatcher({
          tlsConnect: async (options: { readonly socket: tls.TLSSocket; readonly certificateHost: string }) =>
            new Promise<tls.TLSSocket>((resolve, reject) => {
              const socket = tls.connect({
                socket: options.socket,
                rejectUnauthorized: true,
                ca: material.cert,
                checkServerIdentity: (_name, certificate) =>
                  tls.checkServerIdentity(options.certificateHost, certificate),
              });
              socket.once('error', reject);
              socket.once('secureConnect', () => {
                socket.off('error', reject);
                resolve(socket);
              });
            }),
        })
        .dispatch('delivery-webhook'),
      { state: 'issued', deliveryId: 'delivery-webhook' },
    );
    assert.match(request, /^POST \/secure HTTP\/1\.1\r\n/);
  } finally {
    setup.store.close();
    await receiver.close();
    await material.dispose();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
