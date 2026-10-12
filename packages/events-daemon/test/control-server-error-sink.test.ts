import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { startControlServer } from '../src/control/server.ts';
import { interceptAcceptedControlSocket } from './support/control-socket-seam.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import {
  waitForSocketClose,
  withoutUncaughtSocketException,
  withSocketTestTimeout,
} from './support/socket-error-sink.ts';

function deferred(): { readonly promise: Promise<void>; readonly release: () => void } {
  let release: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release?.() };
}

test('CTRL-B1: an accepted control socket destroyed before endpoint verification simply closes', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-control-server-sink-'));
  const endpoint = join(stateDir, 'control.sock');
  const verification = deferred();
  let control: Awaited<ReturnType<typeof startControlServer>> | undefined;
  let client: Socket | undefined;
  let accepted: Socket | undefined;
  const restoreAcceptSeam = interceptAcceptedControlSocket((socket) => {
    accepted = socket;
    // This is the exact accepted Unix-domain socket. The production listener runs before this trailing hook.
    socket.destroy(new Error('synthetic accepted-control reset'));
  });
  try {
    try {
      control = await withSocketTestTimeout(
        startControlServer({
          endpoint,
          token: 'a'.repeat(64),
          verifyEndpoint: async () => verification.promise,
          handle: async () => ({ state: 'unreachable' }),
        }),
        'the control server to listen on its Unix-domain socket',
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip('EPERM: the development sandbox blocks the Unix socket needed for this accepted-socket proof');
        return;
      }
      throw error;
    }
    await withoutUncaughtSocketException(
      'an accepted control socket must have a permanent error listener before verification',
      async () => {
        client = createConnection(endpoint);
        // This peer is not the resource under test; keep its close notification from becoming unrelated evidence.
        client.on('error', () => undefined);
        await withSocketTestTimeout(
          waitForSocketClose(client),
          'the peer of the destroyed accepted control socket to close',
        );
        assert.ok(accepted, "the test seam received the production server's accepted socket");
      },
    );
  } finally {
    restoreAcceptSeam();
    client?.destroy();
    verification.release();
    if (control !== undefined)
      await withSocketTestTimeout(control.close(), 'the control server to close after the accepted socket closes');
    await rm(stateDir, { recursive: true, force: true });
  }
});
