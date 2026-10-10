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
const { WhatsAppVisibilityFence } = await import('../src/runtime/whatsapp-visibility.ts');

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
      config: {
        load: async () => ({
          inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } },
          accounts: { whatsapp: { id: ACCOUNT, platform: 'whatsapp' } },
        }),
      } as never,
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

const WHATSAPP_MESSAGE = '["wa-msg","chat@example.test","sender@example.test","message-1"]';

async function whatsappFixture() {
  const setup = await fixture('http://127.0.0.1:44444/whatsapp');
  setup.store.database.exec(`
    INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
      VALUES ('${ACCOUNT}', 1, '${'a'.repeat(64)}', 1);
    INSERT INTO whatsapp_occurrences
      (account_id, message_id, first_seen_generation, first_seen_at, visibility_version)
      VALUES ('${ACCOUNT}', '${WHATSAPP_MESSAGE}', 1, 1, 1);
    UPDATE rule_versions
       SET document = '{"deliveryRateCap":20,"source":{"channel":"whatsapp"}}'
     WHERE id = 'rule-webhook@1';
    UPDATE deliveries
       SET whatsapp_message_id = '${WHATSAPP_MESSAGE}', whatsapp_visibility_version = 1
     WHERE id = 'delivery-webhook';
  `);
  return setup;
}

function respondingSocket() {
  const state = { writes: [] as Buffer[], destroyed: 0 };
  const listeners = new Map<string, (value: Buffer | Error) => void>();
  const socket = {
    write(bytes: Uint8Array) {
      state.writes.push(Buffer.from(bytes));
      setImmediate(() => listeners.get('data')?.(Buffer.from('HTTP/1.1 204 No Content\r\n\r\n')));
      return true;
    },
    destroy() {
      state.destroyed += 1;
    },
    once(event: string, listener: (value: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value: Buffer | Error) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
  return { socket, state };
}

test('P1: WhatsApp webhook bytes are written only under the live-list fence', { skip: WINDOWS_SKIP }, async (t) => {
  await t.test('a list acquisition that removes the account rechecks before it writes webhook bytes', async () => {
    const setup = await whatsappFixture();
    const peer = respondingSocket();
    let accountPresent = true;
    try {
      const visibilityFence = new WhatsAppVisibilityFence({
        store: setup.store,
        withCurrentEventVisibility: async (_input, work) => {
          accountPresent = false;
          return work({ version: 1, digest: 'a'.repeat(64), seesMessage: () => true });
        },
      });
      assert.deepEqual(
        await setup
          .dispatcher({
            tcpConnect: async () => peer.socket as never,
            hasConcreteWhatsAppVisibilityFence: true,
            whatsappVisibilityFence: visibilityFence,
            config: {
              load: async () =>
                accountPresent ? { accounts: { whatsapp: { id: ACCOUNT, platform: 'whatsapp' } } } : { accounts: {} },
            } as never,
          })
          .dispatch('delivery-webhook'),
        { state: 'terminal', deliveryId: 'delivery-webhook' },
      );
      assert.deepEqual(peer.state.writes, []);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });

  await t.test('a chat hidden between claim and write sends no bytes and cancels content', async () => {
    const setup = await whatsappFixture();
    const peer = respondingSocket();
    let gates = 0;
    try {
      assert.deepEqual(
        await setup
          .dispatcher({
            tcpConnect: async () => peer.socket as never,
            hasConcreteWhatsAppVisibilityFence: true,
            whatsappVisibilityFence: {
              async withCurrentSseFrameVisibility() {
                gates += 1;
                return undefined;
              },
            },
          })
          .dispatch('delivery-webhook'),
        { state: 'terminal', deliveryId: 'delivery-webhook' },
      );
      assert.equal(gates, 1);
      assert.deepEqual(peer.state.writes, []);
      assert.ok(peer.state.destroyed >= 1);
      assert.deepEqual(
        {
          ...(setup.store.database
            .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-webhook'")
            .get() as object),
        },
        { state: 'cancelled', encrypted_record: null },
      );
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });

  await t.test('an unreadable chat list sends nothing, purges nothing and releases the claim for a retry', async () => {
    const setup = await whatsappFixture();
    const peer = respondingSocket();
    try {
      await assert.rejects(
        setup
          .dispatcher({
            tcpConnect: async () => peer.socket as never,
            hasConcreteWhatsAppVisibilityFence: true,
            whatsappVisibilityFence: {
              async withCurrentSseFrameVisibility() {
                throw new Error('the chat list file is unreadable');
              },
            },
          })
          .dispatch('delivery-webhook'),
        (error: unknown) => error instanceof Error && 'code' in error && error.code === 'TRANSIENT',
      );
      assert.deepEqual(peer.state.writes, []);
      assert.ok(peer.state.destroyed >= 1);
      const row = setup.store.database
        .prepare("SELECT state, encrypted_record, lease_until FROM deliveries WHERE id = 'delivery-webhook'")
        .get() as { state: string; encrypted_record: Uint8Array | null; lease_until: number | null };
      assert.notEqual(row.state, 'cancelled', 'D-6: an unreadable list hides, it does not end the delivery');
      assert.notEqual(row.encrypted_record, null, 'D-6: nothing is purged merely because the file could not be read');
      assert.equal(row.lease_until, null, 'the claim is released so a later turn retries');
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });

  await t.test('a visible chat writes once inside the fence', async () => {
    const setup = await whatsappFixture();
    const peer = respondingSocket();
    let gates = 0;
    try {
      assert.deepEqual(
        await setup
          .dispatcher({
            tcpConnect: async () => peer.socket as never,
            hasConcreteWhatsAppVisibilityFence: true,
            whatsappVisibilityFence: {
              async withCurrentSseFrameVisibility(_input: unknown, recheck: () => Promise<void>, write: () => void) {
                gates += 1;
                await recheck();
                write();
              },
            },
          })
          .dispatch('delivery-webhook'),
        { state: 'issued', deliveryId: 'delivery-webhook' },
      );
      assert.equal(gates, 1);
      assert.equal(peer.state.writes.length, 1);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });

  await t.test('a non-WhatsApp delivery remains outside the list fence', async () => {
    const setup = await fixture('http://127.0.0.1:44444/ordinary');
    const peer = respondingSocket();
    try {
      assert.deepEqual(
        await setup
          .dispatcher({
            tcpConnect: async () => peer.socket as never,
            whatsappVisibilityFence: {
              async withCurrentSseFrameVisibility() {
                assert.fail('non-WhatsApp deliveries must not acquire the WhatsApp fence');
              },
            },
          })
          .dispatch('delivery-webhook'),
        { state: 'issued', deliveryId: 'delivery-webhook' },
      );
      assert.equal(peer.state.writes.length, 1);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });

  await t.test('a WhatsApp delivery with no concrete fence fails closed', async () => {
    const setup = await whatsappFixture();
    const peer = respondingSocket();
    try {
      assert.deepEqual(
        await setup.dispatcher({ tcpConnect: async () => peer.socket as never }).dispatch('delivery-webhook'),
        { state: 'terminal', deliveryId: 'delivery-webhook' },
      );
      assert.deepEqual(peer.state.writes, []);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  });
});

test('B2-T7: a webhook posts the prepared CloudEvent bytes and its default outcome seam settles the owned lease', {
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
      { state: 'delivered', attempts: 1 },
      'Task 7 settles only the issued attempt after the response',
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

/** A fake socket whose peer never answers, or streams `stream` bytes after the request, recording each destroy. */
function stallingSocket(stream?: string) {
  const state = { destroyed: 0 };
  const listeners = new Map<string, (value: unknown) => void>();
  const socket = {
    write() {
      if (stream !== undefined) queueMicrotask(() => listeners.get('data')?.(Buffer.from(stream, 'latin1')));
      return true;
    },
    destroy() {
      state.destroyed += 1;
    },
    once(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value: unknown) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
  return { socket, state };
}

test('B2-T6 (PR #60): a peer that accepts and never answers ends at the attempt deadline, and its socket is destroyed', {
  skip: WINDOWS_SKIP,
  timeout: 15_000,
}, async () => {
  const setup = await fixture('https://receiver.test:44444/stall');
  const peer = stallingSocket();
  const outcomes: unknown[] = [];
  try {
    const started = Date.now();
    assert.deepEqual(
      await setup
        .dispatcher({
          attemptTimeoutMs: 50,
          tcpConnect: async () => peer.socket as never,
          tlsConnect: async () => peer.socket as never,
          onOutcome: async (_claim: unknown, outcome: unknown) => outcomes.push(outcome),
        })
        .dispatch('delivery-webhook'),
      { state: 'issued', deliveryId: 'delivery-webhook' },
    );
    assert.ok(Date.now() - started < 5_000, 'the attempt is bounded, not left waiting for the peer');
    assert.deepEqual(outcomes, [{ kind: 'network' }]);
    assert.ok(peer.state.destroyed >= 1, 'the stalled socket is destroyed');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6 (PR #60): a peer streaming bytes with no status line is cut off at the byte limit and its socket destroyed', {
  skip: WINDOWS_SKIP,
  timeout: 15_000,
}, async () => {
  const setup = await fixture('https://receiver.test:44444/stream');
  const peer = stallingSocket('x'.repeat(4_096));
  const outcomes: unknown[] = [];
  try {
    const started = Date.now();
    assert.deepEqual(
      await setup
        .dispatcher({
          attemptTimeoutMs: 60_000,
          tcpConnect: async () => peer.socket as never,
          tlsConnect: async () => peer.socket as never,
          onOutcome: async (_claim: unknown, outcome: unknown) => outcomes.push(outcome),
        })
        .dispatch('delivery-webhook'),
      { state: 'issued', deliveryId: 'delivery-webhook' },
    );
    assert.deepEqual(outcomes, [{ kind: 'network' }]);
    assert.ok(Date.now() - started < 5_000, 'refused at the byte limit, long before the 60-second deadline');
    assert.ok(peer.state.destroyed >= 1);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T6 (PR #60): a TCP connect that completes after the deadline is refused, and the late socket is destroyed', {
  skip: WINDOWS_SKIP,
  timeout: 15_000,
}, async () => {
  const setup = await fixture('https://receiver.test:44444/late');
  const peer = stallingSocket();
  let arrived: (() => void) | undefined;
  const lateArrival = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  try {
    await assert.rejects(
      setup
        .dispatcher({
          attemptTimeoutMs: 20,
          tcpConnect: () =>
            new Promise((resolve) =>
              setTimeout(() => {
                resolve(peer.socket as never);
                queueMicrotask(() => arrived?.());
              }, 100),
            ),
          tlsConnect: async () => peer.socket as never,
        })
        .dispatch('delivery-webhook'),
      /deadline/,
    );
    await lateArrival;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(peer.state.destroyed, 1, 'a socket arriving after the deadline is never used and is destroyed');
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
