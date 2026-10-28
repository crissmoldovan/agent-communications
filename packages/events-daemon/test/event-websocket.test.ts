import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { connect, type Socket } from 'node:net';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { websocketAccept } from '../src/runtime/websocket.ts';
import { runCli, sseSubscriber } from './support/events-owner.ts';
import { freePort, issueCreated, withLiveEvents } from './support/live-events.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * D4 (workflows plan, Track D): WebSocket on the live listener (W31) — the same path, the same Host, query, cookie and
 * Origin refusals, the same bearer (from Authorization, or a browser's `agentcomms.bearer.<token>` subprotocol), and
 * replay from Last-Event-ID or `agentcomms.after.<id>`. Push only, RFC 6455, no library: each event one text message;
 * the client may send only small control frames; a lost pong closes 4408, a rotated or revoked token 4401.
 */

const PATH = '/v1/streams/events-dashboard';

/** Node's own WebSocket client: each message it receives, and how it closed. */
interface Client {
  readonly socket: WebSocket;
  readonly messages: string[];
  closed(): Promise<number>;
  waitFor(count: number, timeoutMs?: number): Promise<void>;
}

async function client(port: number, init: { protocols?: string[]; headers?: Record<string, string> }): Promise<Client> {
  // Node's client takes its headers in an init object (undici's), and subprotocols as the standard array.
  const socket =
    init.headers === undefined
      ? new WebSocket(`ws://127.0.0.1:${port}${PATH}`, init.protocols ?? [])
      : new WebSocket(`ws://127.0.0.1:${port}${PATH}`, init as never);
  const messages: string[] = [];
  let code: number | undefined;
  const closed = new Promise<number>((resolve) => {
    socket.addEventListener('close', (event) => {
      code = event.code;
      resolve(event.code);
    });
  });
  socket.addEventListener('message', (event) => messages.push(String(event.data)));
  // The client's handshake holds no reference on the event loop: keep it alive until the socket opens or fails.
  const alive = setInterval(() => undefined, 100);
  try {
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () =>
        code === undefined ? reject(new Error('the WebSocket did not open')) : resolve(),
      );
    });
  } finally {
    clearInterval(alive);
  }
  return {
    socket,
    messages,
    async closed() {
      const held = setInterval(() => undefined, 100);
      try {
        return await closed;
      } finally {
        clearInterval(held);
      }
    },
    async waitFor(count, timeoutMs = 5_000) {
      for (let waited = 0; messages.length < count && waited < timeoutMs; waited += 10)
        await new Promise((resolve) => setTimeout(resolve, 10));
    },
  };
}

/** A raw handshake: the response head, and the socket for hand-made frames. */
async function raw(
  port: number,
  headers: Record<string, string>,
  path = PATH,
): Promise<{ readonly head: string; readonly socket: Socket; readonly rest: Buffer }> {
  const socket = connect(port, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  const key = randomBytes(16).toString('base64');
  const lines = [
    `GET ${path} HTTP/1.1`,
    ...Object.entries({
      Host: `127.0.0.1:${port}`,
      Upgrade: 'websocket',
      Connection: 'Upgrade',
      'Sec-WebSocket-Version': '13',
      'Sec-WebSocket-Key': key,
      ...headers,
    }).map(([name, value]) => `${name}: ${value}`),
    '',
    '',
  ];
  socket.write(lines.join('\r\n'));
  let received = Buffer.alloc(0);
  const head = await new Promise<string>((resolve) => {
    const onData = (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const end = received.indexOf('\r\n\r\n');
      if (end === -1) return;
      socket.off('data', onData);
      resolve(received.subarray(0, end).toString('latin1'));
      received = received.subarray(end + 4);
    };
    socket.on('data', onData);
    socket.once('end', () => resolve(received.toString('latin1')));
  });
  if (head.startsWith('HTTP/1.1 101'))
    assert.match(head, new RegExp(`Sec-WebSocket-Accept: ${websocketAccept(key).replace(/[+/]/g, '\\$&')}`));
  return { head, socket, rest: received };
}

/** A masked client frame. */
function clientFrame(opcode: number, payload: Buffer): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload);
  for (let index = 0; index < masked.length; index += 1)
    masked[index] = (masked[index] as number) ^ (mask[index % 4] as number);
  const length = payload.length;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, 0x80 | length])
      : Buffer.from([0x80 | opcode, 0x80 | 126, length >> 8, length & 0xff]);
  return Buffer.concat([head, mask, masked]);
}

/** The close code of the server's close frame, read from what the raw socket receives next. */
async function closeCode(socket: Socket, already: Buffer): Promise<number> {
  let received = already;
  const find = (): number | null => {
    let at = 0;
    while (at + 2 <= received.length) {
      const opcode = (received[at] as number) & 0x0f;
      let length = (received[at + 1] as number) & 0x7f;
      let offset = at + 2;
      if (length === 126) {
        if (at + 4 > received.length) return null;
        length = received.readUInt16BE(at + 2);
        offset = at + 4;
      }
      if (offset + length > received.length) return null;
      if (opcode === 0x8) return received.readUInt16BE(offset);
      at = offset + length;
    }
    return null;
  };
  const found = find();
  if (found !== null) return found;
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no close frame')), 5_000);
    socket.on('data', (chunk: Buffer) => {
      received = Buffer.concat([received, chunk]);
      const code = find();
      if (code !== null) {
        clearTimeout(timer);
        resolve(code);
      }
    });
  });
}

test('D4: a WebSocket with Authorization receives each event as one text message, the CloudEvent', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) }], async (harness) => {
    const token = harness.tokens.get('events-dashboard') ?? '';
    const live = await client(port, { headers: { authorization: `Bearer ${token}` } });
    const ids = await harness.raise((run, workflow) => [
      issueCreated(run, workflow, Date.now(), 1),
      issueCreated(run, workflow, Date.now(), 2),
    ]);
    await harness.tick();
    await harness.tick();
    await live.waitFor(2);
    assert.equal(live.messages.length, 2, 'one text message per event');
    const events = live.messages.map(
      (message) => JSON.parse(message) as { id: string; type: string; specversion: string },
    );
    assert.deepEqual(
      events.map((event) => event.id),
      ids,
      'in the order raised',
    );
    for (const event of events) {
      assert.equal(event.specversion, '1.0');
      assert.equal(event.type, 'acme.client-asks.issue.created');
    }
    // `agentcomms.after.<id>` replays after that event.
    const after = await client(port, {
      protocols: ['agentcomms.events.v1', `agentcomms.bearer.${token}`, `agentcomms.after.${ids[0]}`],
      headers: { origin: 'http://localhost:3000' },
    });
    await after.waitFor(1);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.deepEqual(
      after.messages.map((message) => (JSON.parse(message) as { id: string }).id),
      [ids[1]],
    );
    // And Last-Event-ID the same.
    const lastEventId = await client(port, {
      headers: { authorization: `Bearer ${token}`, 'last-event-id': ids[0] as string },
    });
    await lastEventId.waitFor(1);
    assert.deepEqual(
      lastEventId.messages.map((message) => (JSON.parse(message) as { id: string }).id),
      [ids[1]],
    );
    for (const open of [live, after, lastEventId]) open.socket.close();
  });
});

test('D4: a browser subprotocol bearer is accepted; the answer names agentcomms.events.v1 only, never the token; permessage-deflate is not negotiated', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port }) }], async (harness) => {
    const token = harness.tokens.get('events-dashboard') ?? '';
    const node = await client(port, {
      protocols: ['agentcomms.events.v1', `agentcomms.bearer.${token}`],
      headers: { origin: 'http://localhost:3000' },
    });
    assert.equal(node.socket.protocol, 'agentcomms.events.v1');
    node.socket.close();
    const handshake = await raw(port, {
      Origin: 'http://localhost:3000',
      'Sec-WebSocket-Protocol': `agentcomms.events.v1, agentcomms.bearer.${token}`,
      'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits',
    });
    assert.match(handshake.head, /^HTTP\/1\.1 101 /u);
    assert.match(handshake.head, /\r\nSec-WebSocket-Protocol: agentcomms\.events\.v1(\r\n|$)/u);
    assert.equal(handshake.head.includes(token), false, 'the answer never echoes the token');
    assert.doesNotMatch(handshake.head, /Sec-WebSocket-Extensions/iu, 'no extension is negotiated');
    handshake.socket.destroy();
    // A wrong bearer, either way, is refused before the handshake.
    for (const headers of [
      { Origin: 'http://localhost:3000', 'Sec-WebSocket-Protocol': 'agentcomms.events.v1, agentcomms.bearer.wrong' },
      // The right bearer as a subprotocol, but from no page: a browser's way, without a browser's Origin.
      { 'Sec-WebSocket-Protocol': `agentcomms.events.v1, agentcomms.bearer.${token}` },
      { Authorization: 'Bearer wrong' },
      {},
    ]) {
      const refused = await raw(port, headers);
      assert.match(refused.head, /^HTTP\/1\.1 403 /u, JSON.stringify(headers));
      refused.socket.destroy();
    }
  });
});

test('D4: a text frame from the client closes 1008; a 126-byte ping closes 1009; a small ping is answered', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port }) }], async (harness) => {
    const token = harness.tokens.get('events-dashboard') ?? '';
    const pinged = await raw(port, { Authorization: `Bearer ${token}` });
    pinged.socket.write(clientFrame(0x9, Buffer.from('hello')));
    const pong = await new Promise<Buffer>((resolve) => pinged.socket.once('data', (chunk: Buffer) => resolve(chunk)));
    assert.equal((pong[0] as number) & 0x0f, 0xa, 'a ping is answered with a pong');
    assert.equal(pong.subarray(2).toString(), 'hello');
    pinged.socket.write(clientFrame(0x1, Buffer.from('a message')));
    assert.equal(await closeCode(pinged.socket, Buffer.alloc(0)), 1008, 'a data frame closes 1008');
    pinged.socket.destroy();
    const big = await raw(port, { Authorization: `Bearer ${token}` });
    big.socket.write(clientFrame(0x9, Buffer.alloc(126, 1)));
    assert.equal(await closeCode(big.socket, big.rest), 1009, 'a frame over 125 bytes closes 1009');
    big.socket.destroy();
  });
});

test('D4: no pong in 60 s closes 4408; a token rotation closes 4401', { skip: WINDOWS_SKIP }, async () => {
  const port = await freePort();
  await withLiveEvents(
    [{ document: sseSubscriber({ port }) }],
    async (harness) => {
      const token = harness.tokens.get('events-dashboard') ?? '';
      // A raw client never answers the server's pings: past the (shortened) pong deadline it is closed 4408.
      const silent = await raw(port, { Authorization: `Bearer ${token}` });
      assert.equal(await closeCode(silent.socket, silent.rest), 4408);
      silent.socket.destroy();
      // Node's client answers pings, and stays open until the token is rotated.
      const node = await client(port, { headers: { authorization: `Bearer ${token}` } });
      const rotated = await runCli(
        harness.stateDir,
        ['subscriber', 'token', 'rotate', 'events-dashboard', '--version', '1'],
        {
          tty: true,
          json: false,
        },
      );
      assert.equal(rotated.code, 0, rotated.err);
      assert.equal(await node.closed(), 4401);
    },
    { eventsWebSocket: { pingMs: 50, pongTimeoutMs: 300 } },
  );
});

test('D4: Host, query, cookie and Origin refusals hold for the upgrade', { skip: WINDOWS_SKIP }, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port, origins: ['http://localhost:3000'] }) }], async (harness) => {
    const token = harness.tokens.get('events-dashboard') ?? '';
    const bearer = { Authorization: `Bearer ${token}` };
    for (const [why, headers, path, status] of [
      ['another Host', { ...bearer, Host: `localhost:${port}` }, PATH, 403],
      ['a query', bearer, `${PATH}?after=1`, 403],
      ['a cookie', { ...bearer, Cookie: 'a=b' }, PATH, 403],
      ['an Origin not listed', { ...bearer, Origin: 'http://evil.example' }, PATH, 403],
      ['another path', bearer, '/v1/streams/someone-else', 404],
      ['the listed Origin', { ...bearer, Origin: 'http://localhost:3000' }, PATH, 101],
    ] as const) {
      const answer = await raw(port, headers, path);
      assert.match(answer.head, new RegExp(`^HTTP/1\\.1 ${status} `, 'u'), why);
      answer.socket.destroy();
    }
  });
});

test('D4: a frame written after subscriber remove returns never reaches a WebSocket', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  let removeDuring: (() => Promise<void>) | undefined;
  await withLiveEvents(
    [{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) }],
    async (harness) => {
      const token = harness.tokens.get('events-dashboard') ?? '';
      const live = await client(port, { headers: { authorization: `Bearer ${token}` } });
      let removed = false;
      removeDuring = async () => {
        if (removed) return;
        removed = true;
        await new EventControlClient({ stateDir: harness.stateDir, clientName: 'd4-remove' }).request(
          'removeSubscriber',
          { subscriberId: 'events-dashboard' },
        );
      };
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      assert.equal(removed, true);
      assert.equal(await live.closed(), 4401, 'the removal closed the socket as a revoked token');
      assert.deepEqual(live.messages, [], 'no event reached the WebSocket');
      const delivery = harness.database
        .prepare('SELECT state FROM event_deliveries WHERE event_id = ?')
        .get(eventId as string) as { state: string };
      assert.equal(delivery.state, 'cancelled');
    },
    { eventDispatchTestPoint: async (point) => (point === 'after-fence' ? removeDuring?.() : undefined) },
  );
});
