import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestControl } from '../src/control/client.ts';
import { ControlFrameReader, encodeControlFrame } from '../src/control/protocol.ts';
import { interceptControlClientSocket } from './support/control-socket-seam.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import {
  waitForSocketClose,
  withoutUncaughtSocketException,
  withSocketTestTimeout,
} from './support/socket-error-sink.ts';

function closeServer(server: ReturnType<typeof createServer>, sockets: ReadonlySet<Socket>): Promise<void> {
  for (const socket of sockets) socket.destroy();
  return new Promise<void>((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );
}

test('CTRL-B1: a client socket destroyed with an error after its final exchange settles cannot escape socket.end()', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-control-client-sink-'));
  const endpoint = join(stateDir, 'control.sock');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    const reader = new ControlFrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        if ('hello' in (frame as Record<string, unknown>)) {
          socket.write(encodeControlFrame({ ok: true, version: 1, session: 'sink-session' }));
          continue;
        }
        const requestId = (frame as { readonly requestId: string }).requestId;
        socket.write(encodeControlFrame({ ok: true, requestId, data: { state: 'settled' } }));
      }
    });
  });
  let listening = false;
  let client: Socket | undefined;
  let restoreSocketSeam: () => void = () => undefined;
  try {
    try {
      await withSocketTestTimeout(
        new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(endpoint, () => {
            server.off('error', reject);
            resolve();
          });
        }),
        'the control-client fixture to listen on its Unix-domain socket',
      );
      listening = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('EPERM: the development sandbox blocks the Unix socket needed for this client lifecycle proof');
        return;
      }
      throw error;
    }
    restoreSocketSeam = interceptControlClientSocket((socket) => {
      client = socket;
      // `finish` follows the final exchange's cleanup and is raised by requestControl's socket.end().
      socket.once('finish', () => socket.destroy(new Error('synthetic control-client reset')));
    });
    assert.deepEqual(
      await withoutUncaughtSocketException('the client socket must remain safe after a settled exchange', async () => {
        const result = await withSocketTestTimeout(
          requestControl(
            {
              instanceId: '0'.repeat(32),
              pid: process.pid,
              processStart: 'test',
              endpoint,
              tokenFingerprint: '0'.repeat(64),
            },
            'a'.repeat(64),
            'error-sink-test',
            'status',
            {},
          ),
          'the settled control request',
        );
        assert.ok(client, 'the request used the intercepted production-created socket');
        await withSocketTestTimeout(waitForSocketClose(client), 'the destroyed control-client socket to close');
        return result;
      }),
      { state: 'settled' },
    );
  } finally {
    restoreSocketSeam();
    client?.destroy();
    if (listening)
      await withSocketTestTimeout(
        closeServer(server, sockets),
        'the control-client fixture server to close after destroying its accepted sockets',
      );
    await rm(stateDir, { recursive: true, force: true });
  }
});
