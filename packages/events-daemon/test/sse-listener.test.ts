import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { rm } from 'node:fs/promises';
import { createServer, request, type Server } from 'node:http';
import { createConnection } from 'node:net';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import {
  waitForSocketClose,
  withoutUncaughtSocketException,
  withSocketTestTimeout,
} from './support/socket-error-sink.ts';
import { requestSse } from './support/sse-client.ts';

assertLoopbackSeal();

const accountId = 'account-sse-listener';
const liveStreamId = 'stream-listener';
let PORT = 0;
const injectedPort = 43_105;
const allowedOrigin = 'http://127.0.0.1:38124';
let subscriber = {
  subscriberId: 'subscriber-listener',
  version: 1,
  kind: 'sse' as const,
  authority: { host: '127.0.0.1' as const, port: PORT },
  origins: [allowedOrigin],
  retentionMs: 60_000,
};

class InjectedListener extends EventEmitter {
  listening: boolean;
  listenCalls = 0;
  closeCalls = 0;
  private bound: { address: string; family: string; port: number } | null;

  constructor(bound: { address: string; family: string; port: number } | null, listening = bound !== null) {
    super();
    this.bound = bound;
    this.listening = listening;
  }

  address(): { address: string; family: string; port: number } | null {
    return this.bound;
  }

  listen(port: number, host: string, done: () => void): this {
    this.listenCalls += 1;
    this.bound = { address: host, family: host === '::1' ? 'IPv6' : 'IPv4', port };
    this.listening = true;
    done();
    return this;
  }

  close(done?: (error?: Error) => void): this {
    this.closeCalls += 1;
    this.listening = false;
    done?.();
    return this;
  }
}

async function injectedListenerFixture(listener: InjectedListener) {
  const [{ startSseServer }, { openEventDatabase }] = await Promise.all([
    import('../src/runtime/sse-server.ts'),
    import('../src/store/database.ts'),
  ]);
  const stateDir = await shortTempDir('events-sse-listener-injected-');
  const store = await openEventDatabase({ stateDir });
  const injectedSubscriber = { ...subscriber, authority: { host: '127.0.0.1' as const, port: injectedPort } };
  const document = canonicalJson(injectedSubscriber);
  store.database
    .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('subscriber-listener@1', subscriber.subscriberId, subscriber.version, document, sha256Hex(document));
  const start = () =>
    startSseServer({
      listener: listener as unknown as Server,
      store,
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      cipher: {
        encrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
        decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
      },
      approvals: { get: async () => null },
      config: { load: async () => ({}) } as never,
      readBearerGenerations: async () => [],
    });
  return {
    start,
    async close() {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

for (const refusal of [
  {
    name: 'a non-loopback bound address',
    listener: () => new InjectedListener({ address: '0.0.0.0', family: 'IPv4', port: injectedPort }),
  },
  {
    name: 'the wrong bound port',
    listener: () => new InjectedListener({ address: '127.0.0.1', family: 'IPv4', port: injectedPort + 1 }),
  },
  {
    name: 'a server that is not listening',
    listener: () => new InjectedListener(null, false),
  },
]) {
  test(`B2-T9: the injected SSE listener refuses ${refusal.name} without taking ownership`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const listener = refusal.listener();
    const setup = await injectedListenerFixture(listener);
    try {
      await assert.rejects(
        setup.start(),
        /injected SSE listener/,
        'the test-only seam must refuse a server outside the persisted exact authority',
      );
      assert.equal(listener.listenCalls, 0, 'the SSE server must not bind an injected listener');
      assert.equal(listener.closeCalls, 0, 'the SSE server must not close a refused injected listener');
    } finally {
      await setup.close();
    }
  });
}

test('B2-T9: closing an SSE server leaves its accepted injected listener open', { skip: WINDOWS_SKIP }, async () => {
  const listener = new InjectedListener({ address: '127.0.0.1', family: 'IPv4', port: injectedPort });
  const setup = await injectedListenerFixture(listener);
  try {
    const server = await setup.start();
    await server.close();
    assert.equal(listener.listening, true, 'the caller-owned listener must remain bound');
    assert.equal(listener.closeCalls, 0, 'the SSE server must close only a listener it opened');
  } finally {
    await setup.close();
  }
});

async function fixture(options: { readonly production?: boolean } = {}) {
  const [{ startSseServer }, { openEventDatabase }] = await Promise.all([
    import('../src/runtime/sse-server.ts'),
    import('../src/store/database.ts'),
  ]);
  const stateDir = await shortTempDir('events-sse-listener-');
  const listener = createServer();
  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => resolve());
  });
  // The production path binds the persisted authority itself. Its port is probed here and released, so another suite
  // could take it in between: such a start is retried below on EADDRINUSE rather than reported as a failure.
  const production = options.production === true;
  let store: Awaited<ReturnType<typeof openEventDatabase>> | undefined;
  try {
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('the SSE listener has no TCP address');
    PORT = address.port;
    subscriber = { ...subscriber, authority: { host: '127.0.0.1', port: PORT } };
    store = await openEventDatabase({ stateDir });
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1');
    const document = canonicalJson(subscriber);
    store.database
      .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run('subscriber-listener@1', subscriber.subscriberId, subscriber.version, document, sha256Hex(document));
    // The secret ledger's lifecycle row is what a live stream's bearer generation is checked against at every frame.
    store.database
      .prepare(
        `INSERT INTO event_secret_generations
       (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle,
        expires_at, created_at)
       VALUES ('subscriber', ?, ?, 'sse-bearer', 1, ?, 'secret-digest', X'00', 'current', NULL, 1)`,
      )
      .run(subscriber.subscriberId, subscriber.version, sha256Hex(document));
    store.database.exec(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES ('rule-listener@1', 'rule-listener', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
     INSERT INTO target_versions (id, target_id, version, document, digest)
     VALUES ('target-listener@1', 'target-listener', 1, '{}', 'digest');
     INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-listener', '${store.installationId}', 'example.event', 1, '${accountId}', 'listener', 1, 1, 1);
     INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-listener', 'event-listener', '${accountId}', 'rule-listener', 1, 'matched', 9999999999999, 'retained');
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state, switch_generation)
     VALUES ('delivery-listener', 'decision-listener', '${accountId}', 'rule-listener', 1,
             'sse:target-listener:1:subscriber-listener:1', 'target-listener', 1, 'sse', 'plain', 'subscriber-listener', 1,
             X'00', 9999999999999, 'delivered', 1);`,
    );
    if (production) await new Promise<void>((resolve) => listener.close(() => resolve()));
    const server = await startSseServer({
      ...(production ? {} : { listener }),
      store,
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      cipher: {
        encrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
        decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: accountId, provider: 'gmail' } } }) } as never,
      readBearerGenerations: async () => [{ generation: 1, lifecycle: 'current' as const, material: 'listener-token' }],
      fence: async () => undefined,
    });
    return { stateDir, store, server, listener };
  } catch (error) {
    store?.close();
    if (listener.listening) await new Promise<void>((resolve) => listener.close(() => resolve()));
    await rm(stateDir, { recursive: true, force: true });
    throw error;
  }
}

async function closeFixture(setup: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await setup.server.close();
  if (setup.listener.listening) {
    await new Promise<void>((resolve, reject) =>
      setup.listener.close((error) => (error === undefined ? resolve() : reject(error))),
    );
  }
}

test('B2-T9: an SSE connection reset after stream admission simply closes', { skip: WINDOWS_SKIP }, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  try {
    setup = await withSocketTestTimeout(fixture(), 'the SSE listener fixture to start');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip(
        'EPERM: the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it',
      );
      return;
    }
    throw error;
  }
  let client: ReturnType<typeof createConnection> | undefined;
  try {
    await withoutUncaughtSocketException('the accepted SSE socket must have a permanent error listener', async () => {
      client = createConnection({ host: '127.0.0.1', port: PORT });
      client.on('error', () => undefined);
      await withSocketTestTimeout(
        new Promise<void>((resolve, reject) => {
          client?.once('connect', resolve);
          client?.once('error', reject);
        }),
        'the SSE reset-test client to connect',
      );
      const receivedHeaders = new Promise<void>((resolve) => {
        let received = '';
        client?.on('data', (chunk: Buffer) => {
          received += chunk.toString('latin1');
          if (received.includes('\r\n\r\n')) resolve();
        });
      });
      client.write(
        `GET /v1/streams/${subscriber.subscriberId} HTTP/1.1\r\nHost: 127.0.0.1:${PORT}\r\nAuthorization: Bearer listener-token\r\n\r\n`,
      );
      await withSocketTestTimeout(receivedHeaders, 'the SSE stream to admit the reset-test client');
      const closed = waitForSocketClose(client);
      client.resetAndDestroy();
      await withSocketTestTimeout(closed, 'the reset-test SSE client socket to close');
    });
  } finally {
    client?.destroy();
    await withSocketTestTimeout(closeFixture(setup), 'the SSE listener to close after the reset-test socket closes');
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T9: loopback SSE listener rejects an invalid route, Host, query, cookie or bearer before stream registration', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  try {
    setup = await fixture();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it');
      return;
    }
    throw error;
  }
  try {
    assert.deepEqual(setup.server.authority, subscriber.authority, 'the listener binds only its persisted authority');
    for (const { expected, ...input } of [
      {
        expected: 404,
        path: '/v1/streams/other',
        headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer listener-token' },
      },
      { expected: 403, headers: { host: 'wrong.test', authorization: 'Bearer listener-token' } },
      {
        expected: 403,
        path: '/v1/streams/subscriber-listener?access_token=listener-token',
        headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer listener-token' },
      },
      {
        expected: 403,
        headers: { host: `127.0.0.1:${PORT}`, cookie: 'token=listener-token', authorization: 'Bearer listener-token' },
      },
      { expected: 403, headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer wrong' } },
    ]) {
      const result = await requestSse({ port: PORT, ...input });
      assert.equal(result.status, expected);
    }
  } finally {
    await closeFixture(setup);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T9: the production listener binds exactly its persisted loopback authority and serves only there', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>> | undefined;
  for (let attempt = 0; attempt < 5 && setup === undefined; attempt += 1) {
    try {
      setup = await fixture({ production: true });
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EPERM') {
        t.skip(
          'the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it',
        );
        return;
      }
      if (code !== 'EADDRINUSE') throw error;
    }
  }
  assert.ok(setup, 'the production listener started within five probed ports');
  try {
    assert.deepEqual(
      setup.server.boundAddress(),
      { address: '127.0.0.1', family: 'IPv4', port: PORT },
      'the production path listens on exactly the persisted loopback host and port',
    );
    const result = await requestSse({
      port: PORT,
      path: '/v1/streams/other',
      headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer listener-token' },
    });
    assert.equal(result.status, 404, 'the production listener answers on its authority and refuses another route');
  } finally {
    await closeFixture(setup);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T9: exact-origin preflight reflects only the approved CORS contract without credentials or a wildcard', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  try {
    setup = await fixture();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it');
      return;
    }
    throw error;
  }
  try {
    const approved = await requestSse({
      port: PORT,
      method: 'OPTIONS',
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: allowedOrigin,
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,last-event-id',
      },
    });
    assert.equal(approved.status, 204);
    assert.equal(approved.headers['access-control-allow-origin'], allowedOrigin);
    assert.equal(approved.headers['access-control-allow-methods'], 'GET');
    assert.equal(approved.headers['access-control-allow-headers'], 'Authorization, Last-Event-ID');
    assert.equal(approved.headers.vary, 'Origin');
    assert.equal(approved.headers['access-control-allow-credentials'], undefined);
    assert.notEqual(approved.headers['access-control-allow-origin'], '*');

    const refused = await requestSse({
      port: PORT,
      method: 'OPTIONS',
      headers: {
        host: `127.0.0.1:${PORT}`,
        origin: 'http://127.0.0.1:38125',
        'access-control-request-method': 'GET',
        'access-control-request-headers': 'authorization,last-event-id',
      },
    });
    assert.equal(refused.status, 403);
  } finally {
    await closeFixture(setup);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

/** A live frame is for a row appended after the subscriber connected; a row present at connect is replayed instead. */
function appendLiveRow(store: Awaited<ReturnType<typeof fixture>>['store']): void {
  const now = Date.now();
  store.database
    .prepare(
      `INSERT INTO stream_log
       (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, event_id,
        account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at, expires_at, switch_generation)
       VALUES (?, 'delivery-listener', 'rule-listener', 1, 'target-listener', 1, 'subscriber-listener', 1, 'event-listener',
               ?, NULL, NULL, X'00', ?, ?, 1)`,
    )
    .run(liveStreamId, accountId, now, now + 60_000);
}

test('B2-T9: a bearer rotation persisted in the secret ledger ends an open stream at its next frame, with no in-process rotate', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  try {
    setup = await fixture();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it');
      return;
    }
    throw error;
  }
  try {
    const connected = request({
      host: '127.0.0.1',
      port: PORT,
      path: '/v1/streams/subscriber-listener',
      headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer listener-token' },
    });
    const frames: string[] = [];
    let ended = false;
    const open = new Promise<void>((resolve, reject) => {
      connected.once('response', (incoming) => {
        incoming.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')));
        incoming.once('end', () => {
          ended = true;
        });
        resolve();
      });
      connected.once('error', reject);
    });
    connected.end();
    await open;
    appendLiveRow(setup.store);
    assert.equal(await setup.server.writeLive({ streamLogId: liveStreamId, frame: 'data: before\n\n' }), 1);
    // Another writer rotates the ledger: generation 1 is retired and generation 2 is current. Nobody calls rotate().
    setup.store.database.exec(
      `UPDATE event_secret_generations SET lifecycle = 'retired' WHERE owner_kind = 'subscriber' AND generation = 1;
       INSERT INTO event_secret_generations
         (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
          lifecycle, expires_at, created_at)
       SELECT owner_kind, owner_id, owner_version, purpose, 2, owner_digest, 'secret-digest-2', X'01', 'current',
              NULL, 2
       FROM event_secret_generations WHERE owner_kind = 'subscriber' AND generation = 1;`,
    );
    assert.equal(await setup.server.writeLive({ streamLogId: liveStreamId, frame: 'data: after\n\n' }), 0);
    for (let waited = 0; !ended && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(frames, ['data: before\n\n']);
    assert.equal(ended, true, 'the stream whose bearer generation the ledger retired is closed');
  } finally {
    await closeFixture(setup);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T9: rotation, pause and the per-frame writer gate prevent a registered old stream from receiving another frame', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let setup: Awaited<ReturnType<typeof fixture>>;
  try {
    setup = await fixture();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip('the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it');
      return;
    }
    throw error;
  }
  try {
    const connected = request({
      host: '127.0.0.1',
      port: PORT,
      path: '/v1/streams/subscriber-listener',
      headers: { host: `127.0.0.1:${PORT}`, authorization: 'Bearer listener-token' },
    });
    const frames: string[] = [];
    const open = new Promise<void>((resolve, reject) => {
      connected.once('response', (incoming) => {
        incoming.on('data', (chunk: Buffer) => frames.push(chunk.toString('utf8')));
        resolve();
      });
      connected.once('error', reject);
    });
    connected.end();
    await open;
    appendLiveRow(setup.store);
    assert.equal(await setup.server.writeLive({ streamLogId: liveStreamId, frame: 'data: first\n\n' }), 1);
    setup.server.rotate({
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      generation: 2,
    });
    assert.equal(await setup.server.writeLive({ streamLogId: liveStreamId, frame: 'data: old\n\n' }), 0);
    setup.store.database.exec('UPDATE event_settings SET paused = 1');
    assert.equal(await setup.server.writeLive({ streamLogId: liveStreamId, frame: 'data: paused\n\n' }), 0);
    // The client reads over a real loopback socket: wait (bounded) for the first frame, then give any frame wrongly
    // written after the rotation or the pause the same chance to arrive before asserting none did.
    for (let waited = 0; frames.length === 0 && waited < 2_000; waited += 5)
      await new Promise((resolve) => setTimeout(resolve, 5));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(frames, ['data: first\n\n']);
  } finally {
    await closeFixture(setup);
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
