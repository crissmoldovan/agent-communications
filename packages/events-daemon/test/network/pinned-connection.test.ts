import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import tls from 'node:tls';
import {
  addressSetDigest,
  connectPinnedTcp,
  connectPinnedTls,
  openPinnedConnection,
  PinnedResponseError,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
  streamPinnedResponseTo,
} from '../../src/network/pinned-connection.ts';
import { startLoopbackReceiver } from '../support/loopback-receiver.ts';
import { WINDOWS_SKIP } from '../support/short-temp.ts';
import {
  waitForSocketClose,
  withoutUncaughtSocketException,
  withSocketTestTimeout,
} from '../support/socket-error-sink.ts';

test('NET-B2: validates the approved fingerprint before resolving and pins every vetted answer', async () => {
  let resolverCalls = 0;
  const resolver = {
    lookup: async () => {
      resolverCalls += 1;
      return ['8.8.8.8'];
    },
  };
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://receiver.example.test/hook',
        approvedAddressSet: ['8.8.8.8'],
        approvedAddressSetDigest: 'not-the-fingerprint',
        resolver,
      }),
    /fingerprint/i,
  );
  assert.equal(resolverCalls, 0);

  const approvedAddressSet = ['8.8.8.8'];
  const pinned = await preparePinnedConnection({
    url: 'https://receiver.example.test/hook?x=1',
    approvedAddressSet,
    approvedAddressSetDigest: addressSetDigest(approvedAddressSet),
    resolver,
  });
  assert.equal(pinned.hostname, 'receiver.example.test');
  assert.equal(pinned.address, '8.8.8.8');
  assert.equal(pinned.tls.servername, 'receiver.example.test');
  assert.equal(pinned.tls.rejectUnauthorized, true);
  assert.match(
    requestBytesForPinnedConnection(pinned, 'POST', Buffer.from('x')).toString(),
    /Host: receiver\.example\.test\r\n/,
  );

  let tcpOptions: unknown;
  let tlsOptions: unknown;
  await openPinnedConnection(pinned, {
    tcpConnect: async (options) => {
      tcpOptions = options;
      return {} as never;
    },
    tlsConnect: async (options) => {
      tlsOptions = options;
      return {} as never;
    },
  });
  assert.deepEqual(tcpOptions, { host: '8.8.8.8', port: 443 });
  assert.deepEqual(tlsOptions, {
    socket: {},
    rejectUnauthorized: true,
    servername: 'receiver.example.test',
    certificateHost: 'receiver.example.test',
  });

  const literalHttps = await preparePinnedConnection({
    url: 'https://127.0.0.1:8443/',
    approvedAddressSet: ['127.0.0.1'],
  });
  assert.deepEqual(literalHttps.tls, {
    rejectUnauthorized: true,
    certificateHost: '127.0.0.1',
  });
});

test('NET-B2: refuses all-answer drift, proxy-shaped URLs, redirects, and nonliteral HTTP', async () => {
  const resolver = { lookup: async () => ['8.8.8.8', '10.0.0.1'] };
  await assert.rejects(
    () => preparePinnedConnection({ url: 'https://receiver.example.test/', approvedAddressSet: ['8.8.8.8'], resolver }),
    /approved|address/i,
  );
  await assert.rejects(
    () => preparePinnedConnection({ url: 'http://localhost:8080/', approvedAddressSet: ['127.0.0.1'], resolver }),
    /literal/i,
  );
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'http://127.0.0.1:8080/',
        approvedAddressSet: ['127.0.0.1', '8.8.8.8'],
        resolver: { lookup: async () => ['127.0.0.1'] },
      }),
    /one exact/i,
  );
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://user@receiver.example.test/',
        approvedAddressSet: ['8.8.8.8'],
        resolver,
      }),
    /userinfo/i,
  );

  let resolverCalls = 0;
  await assert.rejects(
    () =>
      preparePinnedConnection({
        url: 'https://receiver.example.test/',
        approvedAddressSet: ['8.8.8.8', '10.0.0.1'],
        resolver: {
          lookup: async () => {
            resolverCalls += 1;
            return ['8.8.8.8'];
          },
        },
      }),
    /sorted/i,
  );
  assert.equal(resolverCalls, 0, 'policy shape is rejected before a DNS lookup');
});

test('NET-B2: connected pinned TCP keeps an error sink after its connect listener settles', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let peer: import('node:net').Socket | undefined;
  let peerArrived: (() => void) | undefined;
  const arrived = new Promise<void>((resolve) => {
    peerArrived = resolve;
  });
  let receiver: Awaited<ReturnType<typeof startLoopbackReceiver>>;
  try {
    receiver = await withSocketTestTimeout(
      startLoopbackReceiver((socket) => {
        peer = socket;
        peerArrived?.();
      }),
      'the pinned-TCP receiver to listen',
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') {
      t.skip(
        'EPERM: the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it',
      );
      return;
    }
    throw error;
  }

  let socket: import('node:net').Socket | undefined;
  try {
    socket = await withSocketTestTimeout(
      connectPinnedTcp({ host: receiver.host, port: receiver.port }),
      'the pinned TCP connection to settle',
    );
    await withSocketTestTimeout(arrived, 'the pinned-TCP receiver to accept its peer');
    assert.ok(peer);
    await withoutUncaughtSocketException('a transport error must have a permanent resource listener', async () => {
      const closed = waitForSocketClose(socket as import('node:net').Socket);
      peer?.resetAndDestroy();
      await withSocketTestTimeout(closed, 'the reset pinned TCP client socket to close');
    });
  } finally {
    socket?.destroy();
    await withSocketTestTimeout(receiver.close(), 'the pinned-TCP receiver to close');
  }
});

test('NET-B2: handshaken pinned TLS keeps an error sink after its handshake listener settles', async () => {
  const fakeSocket = new EventEmitter();
  const tlsModule = tls as unknown as { connect: typeof tls.connect };
  const originalConnect = tlsModule.connect;
  tlsModule.connect = (() => {
    queueMicrotask(() => fakeSocket.emit('secureConnect'));
    return fakeSocket as unknown as tls.TLSSocket;
  }) as typeof tls.connect;
  try {
    assert.equal(
      await withSocketTestTimeout(
        connectPinnedTls({
          socket: new EventEmitter() as unknown as import('node:net').Socket,
          rejectUnauthorized: true,
          certificateHost: 'receiver.example.test',
        }),
        'the seam-provided TLS handshake to settle',
      ),
      fakeSocket,
    );
    await withoutUncaughtSocketException('a synthetic TLS error must have a permanent resource listener', () => {
      queueMicrotask(() => fakeSocket.emit('error', new Error('synthetic TLS peer reset')));
    });
  } finally {
    tlsModule.connect = originalConnect;
  }
});

test('E2 pinned stream: abort waits for its pending sink callback', async () => {
  const controller = new AbortController();
  const socket = new EventEmitter() as EventEmitter & {
    write(bytes: Uint8Array): boolean;
    destroy(): void;
    pause(): void;
    resume(): void;
  };
  let releaseSink!: () => void;
  const sinkBlocked = new Promise<void>((resolve) => {
    releaseSink = resolve;
  });
  let sinkEntered!: () => void;
  const sinkEnteredPromise = new Promise<void>((resolve) => {
    sinkEntered = resolve;
  });
  socket.write = () => {
    queueMicrotask(() => socket.emit('data', Buffer.from('pending sink', 'utf8')));
    return true;
  };
  socket.destroy = () => undefined;
  socket.pause = () => undefined;
  socket.resume = () => undefined;
  const stream = streamPinnedResponseTo(socket as unknown as tls.TLSSocket, Buffer.from('request', 'utf8'), {
    maxBytes: 1024,
    signal: controller.signal,
    onChunk: async () => {
      sinkEntered();
      await sinkBlocked;
    },
  });
  void stream.catch(() => undefined);

  try {
    await sinkEnteredPromise;
    controller.abort(new PinnedResponseError('NETWORK_ABORTED'));
    const state = await Promise.race([
      stream.then(
        () => 'settled' as const,
        () => 'settled' as const,
      ),
      new Promise<'blocked'>((resolve) => setTimeout(() => resolve('blocked'), 20)),
    ]);
    assert.equal(state, 'blocked', 'an abort must wait for the active sink callback before stream settlement');
    releaseSink();
    await assert.rejects(
      () => stream,
      (error: unknown) => error instanceof PinnedResponseError && error.code === 'NETWORK_ABORTED',
    );
  } finally {
    releaseSink();
    await Promise.allSettled([stream]);
  }
});

test('E6-A: global-only mode is reserved for the exact fixed TypeSafe endpoint', async () => {
  let resolverCalls = 0;
  const resolver = {
    async lookup() {
      resolverCalls += 1;
      return ['8.8.8.8'];
    },
  };
  for (const url of ['https://receiver.example.test/hook', 'http://127.0.0.1:11434/v1/systemone']) {
    await assert.rejects(
      () => preparePinnedConnection({ url, addressMode: 'global-only', resolver }),
      (error: unknown) => error instanceof Error && /global-only.*TypeSafe|TypeSafe.*global-only/i.test(error.message),
      url,
    );
  }
  assert.equal(resolverCalls, 0, 'webhooks and local endpoints remain exact-set-only before DNS');
});
