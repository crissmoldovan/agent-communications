import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { createServer as createHttpServer, type Server } from 'node:http';
import { connect, createServer, type Socket } from 'node:net';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { SubscriberListeners } from '../src/runtime/events/listeners.ts';
import type { SseBearerMaterial, SseServer, SseServerOptions } from '../src/runtime/sse-server.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { sseSubscriber } from './support/events-owner.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

/*
 * Listener hardening before 0.36.0's release (security review of 0.36.0, M1 and L8): a listener's close ends within a
 * bound whatever its clients do; a half-sent request is cut by the listener's own header deadline, and a stream is not;
 * the listener takes at most 64 connections; a stream whose reader stops reading is closed once more than 1 MiB waits
 * for it; a stream admitted on the previous token closes when that token's overlap ends, with no frame needed; and a
 * listener writes only its own subscriber's rows.
 */

const ACCOUNT = 'account-hardening';
const SUBSCRIBER = 'subscriber-hardening';
const OTHER = 'subscriber-other';
const STREAM_ROW = 'stream-hardening';
const OTHER_ROW = 'stream-other';
const ORIGIN = 'http://127.0.0.1:38124';

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (address === null || typeof address === 'string') throw new Error('no port');
  return address.port;
}

function subscriberDocument(id: string, port: number): string {
  return canonicalJson({
    subscriberId: id,
    version: 1,
    kind: 'sse',
    authority: { host: '127.0.0.1', port },
    origins: [ORIGIN],
    retentionMs: 60_000,
  });
}

interface Fixture {
  readonly port: number;
  readonly store: EventDatabase;
  readonly server: SseServer;
  /** Puts a rule-target frame row in this listener's subscriber's log (or another subscriber's). */
  row(id: string, subscriberId?: string): void;
  close(): Promise<void>;
}

interface FixtureOptions {
  /** The listener binds its own port (the owner's way), rather than taking an injected one. */
  readonly production?: boolean;
  /** The bearer generations the ledger holds; by default one current generation, `current-token`. */
  readonly generations?: (now: number) => readonly SseBearerMaterial[];
  readonly httpTimeouts?: SseServerOptions['httpTimeouts'];
}

async function fixture(options: FixtureOptions = {}): Promise<Fixture> {
  const [{ startSseServer }, { openEventDatabase }] = await Promise.all([
    import('../src/runtime/sse-server.ts'),
    import('../src/store/database.ts'),
  ]);
  const stateDir = await shortTempDir('aev-sse-hardening-');
  const production = options.production === true;
  let listener: Server | undefined;
  let port: number;
  if (production) port = await freePort();
  else {
    listener = createHttpServer();
    await new Promise<void>((resolve, reject) => {
      listener?.once('error', reject);
      listener?.listen(0, '127.0.0.1', () => resolve());
    });
    const address = listener.address();
    if (address === null || typeof address === 'string') throw new Error('no port');
    port = address.port;
  }
  const store = await openEventDatabase({ stateDir });
  const now = Date.now();
  const generations = options.generations?.(now) ?? [
    { generation: 1, lifecycle: 'current' as const, material: 'current-token' },
  ];
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1');
  for (const id of [SUBSCRIBER, OTHER]) {
    const document = subscriberDocument(id, id === SUBSCRIBER ? port : port + 1);
    store.database
      .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run(`${id}@1`, id, document, sha256Hex(document));
  }
  const digest = sha256Hex(subscriberDocument(SUBSCRIBER, port));
  for (const generation of generations)
    store.database
      .prepare(
        `INSERT INTO event_secret_generations
           (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
            lifecycle, expires_at, created_at)
         VALUES ('subscriber', ?, 1, 'sse-bearer', ?, ?, ?, X'00', ?, ?, 1)`,
      )
      .run(
        SUBSCRIBER,
        generation.generation,
        digest,
        `secret-digest-${generation.generation}`,
        generation.lifecycle,
        generation.expiresAt ?? null,
      );
  store.database.exec(
    `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES ('rule-hardening@1', 'rule-hardening', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
     INSERT INTO target_versions (id, target_id, version, document, digest)
     VALUES ('target-hardening@1', 'target-hardening', 1, '{}', 'digest');
     INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-hardening', '${store.installationId}', 'example.event', 1, '${ACCOUNT}', 'hardening', 1, 1, 1);
     INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-hardening', 'event-hardening', '${ACCOUNT}', 'rule-hardening', 1, 'matched', 9999999999999,
             'retained');`,
  );
  for (const id of [SUBSCRIBER, OTHER])
    store.database
      .prepare(
        `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
            target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state,
            switch_generation)
         VALUES (?, 'decision-hardening', ?, 'rule-hardening', 1, ?, 'target-hardening', 1, 'sse', 'plain', ?, 1, X'00',
                 9999999999999, 'delivered', 1)`,
      )
      .run(`delivery-${id}`, ACCOUNT, `sse:target-hardening:1:${id}:1`, id);
  const server = await startSseServer({
    ...(listener === undefined ? {} : { listener }),
    store,
    subscriberId: SUBSCRIBER,
    subscriberVersion: 1,
    cipher: {
      encrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
      decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
    },
    approvals: { get: async () => null },
    config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
    readBearerGenerations: async () => generations,
    fence: async () => undefined,
    ...(options.httpTimeouts === undefined ? {} : { httpTimeouts: options.httpTimeouts }),
  });
  return {
    port,
    store,
    server,
    row(id, subscriberId = SUBSCRIBER) {
      const at = Date.now();
      store.database
        .prepare(
          `INSERT INTO stream_log
             (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
              event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
              expires_at, switch_generation)
           VALUES (?, ?, 'rule-hardening', 1, 'target-hardening', 1, ?, 1, 'event-hardening', ?, NULL, NULL, ?, ?, ?, 1)`,
        )
        .run(id, `delivery-${subscriberId}`, subscriberId, ACCOUNT, Buffer.from(`{"row":"${id}"}`), at, at + 60_000);
    },
    async close() {
      await Promise.race([server.close(), delay(5_000)]);
      if (listener?.listening) await new Promise<void>((resolve) => listener?.close(() => resolve()));
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    },
  };
}

/** A raw loopback socket to the listener. */
async function socketTo(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/** Resolves once the socket has closed, or false after `ms`. */
async function closedWithin(socket: Socket, ms: number): Promise<boolean> {
  if (socket.destroyed) return true;
  return Promise.race([
    new Promise<boolean>((resolve) => socket.once('close', () => resolve(true))),
    delay(ms).then(() => false),
  ]);
}

/** An admitted SSE stream on a raw socket: the request is sent whole and the response head read; then it is left. */
async function rawStream(port: number, token: string): Promise<{ readonly socket: Socket; readonly head: string }> {
  const socket = await socketTo(port);
  socket.write(
    `GET /v1/streams/${SUBSCRIBER} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
  );
  let received = '';
  const head = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve(received.slice(0, end));
    };
    socket.on('data', onData);
  });
  return { socket, head };
}

/** An admitted WebSocket on a raw socket: the handshake is sent and its answer read; then it is left. */
async function rawWebSocket(port: number, token: string): Promise<{ readonly socket: Socket; readonly head: string }> {
  const socket = await socketTo(port);
  socket.write(
    [
      `GET /v1/streams/${SUBSCRIBER} HTTP/1.1`,
      `Host: 127.0.0.1:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      'Sec-WebSocket-Version: 13',
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}`,
      `Authorization: Bearer ${token}`,
      '',
      '',
    ].join('\r\n'),
  );
  let received = '';
  const head = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      received += chunk.toString('latin1');
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve(received.slice(0, end));
    };
    socket.on('data', onData);
  });
  return { socket, head };
}

test('M1: a listener closes within a bound while a request is half-sent', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ production: true });
  const socket = await socketTo(setup.port);
  try {
    // A request line and a Host, and never the blank line that ends the headers. No token is needed for this.
    socket.write(`GET /v1/streams/${SUBSCRIBER} HTTP/1.1\r\nHost: 127.0.0.1:${setup.port}\r\n`);
    await delay(50);
    const started = Date.now();
    const closed = await Promise.race([setup.server.close().then(() => true), delay(4_000).then(() => false)]);
    assert.equal(closed, true, `the listener's close finished (after ${Date.now() - started} ms)`);
    assert.ok(Date.now() - started < 2_000, 'within its grace, not when the client goes away');
    assert.equal(await closedWithin(socket, 1_000), true, 'and the half-sent request is cut');
  } finally {
    socket.destroy();
    await setup.close();
  }
});

test('M1: the header deadline cuts a half-sent request; an admitted stream outlives the request deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture({
    production: true,
    httpTimeouts: { headersTimeoutMs: 200, requestTimeoutMs: 300, connectionsCheckingIntervalMs: 50 },
  });
  const half = await socketTo(setup.port);
  const stream = await rawStream(setup.port, 'current-token');
  try {
    assert.match(stream.head, /^HTTP\/1\.1 200/);
    let answer = '';
    half.on('data', (chunk: Buffer) => {
      answer += chunk.toString('latin1');
    });
    half.write(`GET /v1/streams/${SUBSCRIBER} HTTP/1.1\r\nHost: 127.0.0.1:${setup.port}\r\n`);
    assert.equal(await closedWithin(half, 2_000), true, 'the half-sent request is cut by the header deadline');
    assert.match(answer, /^HTTP\/1\.1 408/);
    await delay(500);
    assert.equal(stream.socket.destroyed, false, 'the admitted stream is still open past the request deadline');
    let body = '';
    stream.socket.on('data', (chunk: Buffer) => {
      body += chunk.toString('utf8');
    });
    setup.row(STREAM_ROW);
    assert.equal(await setup.server.writeRule({ streamLogId: STREAM_ROW }), 1, 'and it still receives frames');
    for (let waited = 0; !body.includes(STREAM_ROW) && waited < 2_000; waited += 10) await delay(10);
    assert.match(body, new RegExp(`id: ${STREAM_ROW}`));
  } finally {
    half.destroy();
    stream.socket.destroy();
    await setup.close();
  }
});

test('M1: a listener takes at most 64 connections', { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture({ production: true });
  const sockets: Socket[] = [];
  try {
    for (let index = 0; index < 64; index += 1) {
      const socket = await socketTo(setup.port);
      socket.write(`GET /v1/streams/${SUBSCRIBER} HTTP/1.1\r\nHost: 127.0.0.1:${setup.port}\r\n`);
      sockets.push(socket);
    }
    await delay(100);
    assert.equal(
      sockets.some((socket) => socket.destroyed),
      false,
      'the first 64 stay open',
    );
    const extra = await socketTo(setup.port);
    sockets.push(extra);
    assert.equal(await closedWithin(extra, 2_000), true, 'the 65th is dropped');
  } finally {
    for (const socket of sockets) socket.destroy();
    await setup.close();
  }
});

test('L8: an SSE stream whose reader stops reading is closed once more than 1 MiB waits for it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  const stream = await rawStream(setup.port, 'current-token');
  try {
    assert.match(stream.head, /^HTTP\/1\.1 200/);
    stream.socket.pause();
    setup.row(STREAM_ROW);
    const frame = `data: ${'x'.repeat(4 * 1024 * 1024)}\n\n`;
    const reached: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      reached.push(await setup.server.writeLive({ streamLogId: STREAM_ROW, frame }));
      await delay(20);
    }
    assert.equal(reached[0], 1, 'the first frame is written');
    assert.equal(reached.at(-1), 0, 'a reader that has fallen more than 1 MiB behind has no stream any more');
    stream.socket.resume();
    assert.equal(await closedWithin(stream.socket, 5_000), true, 'its socket is closed');
  } finally {
    stream.socket.destroy();
    await setup.close();
  }
});

test('L8: a WebSocket whose reader stops reading is closed once more than 1 MiB waits for it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  const ws = await rawWebSocket(setup.port, 'current-token');
  try {
    assert.match(ws.head, /^HTTP\/1\.1 101/);
    ws.socket.pause();
    setup.row(STREAM_ROW);
    const frame = `data: ${'x'.repeat(4 * 1024 * 1024)}\n\n`;
    const reached: number[] = [];
    for (let index = 0; index < 8; index += 1) {
      reached.push(await setup.server.writeLive({ streamLogId: STREAM_ROW, frame }));
      await delay(20);
    }
    assert.equal(reached[0], 1, 'the first message is sent');
    assert.equal(reached.at(-1), 0, 'a reader that has fallen more than 1 MiB behind has no socket any more');
    ws.socket.resume();
    assert.equal(await closedWithin(ws.socket, 5_000), true, 'its socket is closed');
  } finally {
    ws.socket.destroy();
    await setup.close();
  }
});

for (const transport of ['sse', 'websocket'] as const) {
  test(`L8: a ${transport} stream admitted on the previous token closes when its overlap ends, with no frame`, {
    skip: WINDOWS_SKIP,
  }, async () => {
    const setup = await fixture({
      generations: (now) => [
        { generation: 2, lifecycle: 'current', material: 'current-token' },
        { generation: 1, lifecycle: 'overlap', material: 'previous-token', expiresAt: now + 1_000 },
      ],
    });
    const stream =
      transport === 'sse'
        ? await rawStream(setup.port, 'previous-token')
        : await rawWebSocket(setup.port, 'previous-token');
    try {
      assert.match(stream.head, transport === 'sse' ? /^HTTP\/1\.1 200/ : /^HTTP\/1\.1 101/);
      let body = '';
      stream.socket.on('data', (chunk: Buffer) => {
        body += chunk.toString('latin1');
      });
      // An SSE stream ends with its response's last chunk; a WebSocket with a 4401 close and its socket.
      const ended =
        transport === 'sse'
          ? async () => {
              for (let waited = 0; !body.endsWith('0\r\n\r\n') && waited < 3_000; waited += 10) await delay(10);
              return body.endsWith('0\r\n\r\n');
            }
          : () => closedWithin(stream.socket, 3_000);
      assert.equal(
        await ended(),
        true,
        "the stream ends at the previous token's authorizedUntil, though no frame came",
      );
      if (transport === 'websocket') assert.ok(body.includes('\x88\x02\x11\x31'), 'with the close code 4401');
    } finally {
      stream.socket.destroy();
      await setup.close();
    }
  });
}

test("L8: a listener's writers refuse another subscriber's row", { skip: WINDOWS_SKIP }, async () => {
  const setup = await fixture();
  const stream = await rawStream(setup.port, 'current-token');
  let body = '';
  stream.socket.on('data', (chunk: Buffer) => {
    body += chunk.toString('utf8');
  });
  try {
    setup.row(OTHER_ROW, OTHER);
    assert.equal(await setup.server.writeRule({ streamLogId: OTHER_ROW }), 0, 'writeRule refuses it');
    // Its own row still goes, so the refusal is the row's owner and nothing else.
    setup.row(STREAM_ROW);
    assert.equal(await setup.server.writeRule({ streamLogId: STREAM_ROW }), 1);
    for (let waited = 0; !body.includes(STREAM_ROW) && waited < 2_000; waited += 10) await delay(10);
    assert.match(body, new RegExp(`id: ${STREAM_ROW}`));
    assert.equal(body.includes(OTHER_ROW), false, "no frame of another subscriber's row reached this stream");
  } finally {
    stream.socket.destroy();
    await setup.close();
  }
});

test('M1: the owner waits a bounded time for a listener whose close never settles', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-sse-close-bound-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = canonicalJson(sseSubscriber({ port: 4801 }) as never);
    store.database
      .prepare(
        `INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest, state)
         VALUES ('events-dashboard@1', 'events-dashboard', 1, ?, ?, 'active')`,
      )
      .run(document, sha256Hex(document));
    let closes = 0;
    const stuck: SseServer = {
      authority: { host: '127.0.0.1', port: 4801 },
      boundAddress: () => null,
      // A close that never settles: a client holding it, in a listener that has no bound of its own.
      close: () => {
        closes += 1;
        return new Promise<void>(() => undefined);
      },
      rotate: () => undefined,
      writeLive: async () => 0,
      writeEvent: async () => 0,
      writeRule: async () => 0,
      preflightCount: () => 0,
    };
    const listeners = new SubscriberListeners({
      store,
      cipher: { encrypt: async () => Buffer.alloc(0), decrypt: async () => Buffer.alloc(0) },
      approvals: { get: async () => null },
      config: { load: async () => ({}) } as never,
      eventSecrets: { readLiveGenerations: async () => [] },
      registry: { register: () => () => undefined },
      startServer: async () => stuck,
      closeBoundMs: 200,
    });
    await listeners.reconcile();
    assert.deepEqual(listeners.status('events-dashboard', 1).listening, { host: '127.0.0.1', port: 4801 });
    store.database.prepare("UPDATE subscriber_versions SET revoked_at = 1 WHERE id = 'events-dashboard@1'").run();
    const reconciled = await Promise.race([listeners.reconcile().then(() => true), delay(3_000).then(() => false)]);
    assert.equal(reconciled, true, 'the reconcile that closes it finishes all the same');
    assert.equal(closes, 1);
    assert.equal(listeners.status('events-dashboard', 1).listening, null);
    const stopped = await Promise.race([listeners.close().then(() => true), delay(3_000).then(() => false)]);
    assert.equal(stopped, true);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
