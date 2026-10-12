import { createConnection } from 'node:net';
import { test } from 'node:test';
import tls from 'node:tls';
import { startLoopbackReceiver, startLoopbackTlsReceiver } from './support/loopback-receiver.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import {
  waitForSocketClose,
  withoutUncaughtSocketException,
  withSocketTestTimeout,
} from './support/socket-error-sink.ts';
import { createLoopbackTestTls } from './support/test-tls.ts';

test('B2-T6 fixture: an accepted plain loopback peer destroyed with an error simply closes', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  let receiver: Awaited<ReturnType<typeof startLoopbackReceiver>> | undefined;
  let client: ReturnType<typeof createConnection> | undefined;
  try {
    try {
      receiver = await withSocketTestTimeout(
        startLoopbackReceiver((socket) => socket.on('data', () => undefined), {
          afterAccept: (socket) => socket.destroy(new Error('synthetic plain loopback reset')),
        }),
        'the plain loopback receiver to listen',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'EPERM: the development sandbox blocks loopback listeners; the coordinator runs this fixture proof outside it',
        );
        return;
      }
      throw error;
    }
    const activeReceiver = receiver;
    await withoutUncaughtSocketException(
      'the accepted plain loopback peer must have a permanent error listener',
      async () => {
        client = createConnection({ host: activeReceiver.host, port: activeReceiver.port });
        client.on('error', () => undefined);
        await withSocketTestTimeout(
          waitForSocketClose(client),
          'the plain loopback peer to close after its synthetic reset',
        );
      },
    );
  } finally {
    client?.destroy();
    if (receiver !== undefined)
      await withSocketTestTimeout(
        receiver.close(),
        'the plain loopback receiver to close after destroying accepted peers',
      );
  }
});

test('B2-T6 fixture: an accepted TLS loopback peer destroyed with an error simply closes', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const material = await createLoopbackTestTls();
  let receiver: Awaited<ReturnType<typeof startLoopbackTlsReceiver>> | undefined;
  let client: tls.TLSSocket | undefined;
  try {
    try {
      receiver = await withSocketTestTimeout(
        startLoopbackTlsReceiver(material, (socket) => socket.on('data', () => undefined), {
          afterAccept: (socket) => socket.destroy(new Error('synthetic TLS loopback reset')),
        }),
        'the TLS loopback receiver to listen',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'EPERM: the development sandbox blocks loopback listeners; the coordinator runs this fixture proof outside it',
        );
        return;
      }
      throw error;
    }
    const activeReceiver = receiver;
    await withoutUncaughtSocketException(
      'the accepted TLS loopback peer must have a permanent error listener',
      async () => {
        client = tls.connect({
          host: activeReceiver.host,
          port: activeReceiver.port,
          ca: material.cert,
          rejectUnauthorized: true,
          checkServerIdentity: (_name, certificate) => tls.checkServerIdentity('127.0.0.1', certificate),
        });
        client.on('error', () => undefined);
        await withSocketTestTimeout(
          waitForSocketClose(client),
          'the TLS loopback peer to close after its synthetic reset',
        );
      },
    );
  } finally {
    client?.destroy();
    if (receiver !== undefined)
      await withSocketTestTimeout(
        receiver.close(),
        'the TLS loopback receiver to close after destroying accepted peers',
      );
    await material.dispose();
  }
});
