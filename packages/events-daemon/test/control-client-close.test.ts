import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { requestControl } from '../src/control/client.ts';
import { ControlFrameReader, encodeControlFrame } from '../src/control/protocol.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { withSocketTestTimeout } from './support/socket-error-sink.ts';

/**
 * Review of 0.31.0, finding 4: a control request waited only for a frame or an error, so an owner that died — its
 * socket ended or closed with no answer — left the call waiting for ever: an MCP tool, the CLI, a long-poll.
 */

type Behaviour = 'end-after-hello' | 'destroy-after-hello' | 'end-at-once' | 'hold';

async function fakeOwner(behaviour: Behaviour) {
  const dir = await shortTempDir('aev-ctl-close-');
  const endpoint = join(dir, 'control.sock');
  const sockets = new Set<Socket>();
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
    if (behaviour === 'end-at-once') {
      socket.end();
      return;
    }
    const reader = new ControlFrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        if ('hello' in (frame as Record<string, unknown>)) {
          socket.write(encodeControlFrame({ ok: true, version: 1, session: 'close-session' }));
          continue;
        }
        // The request arrives, and the owner dies before it answers.
        if (behaviour === 'end-after-hello') socket.end();
        else if (behaviour === 'destroy-after-hello') socket.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint, () => resolve());
  });
  return {
    record: {
      instanceId: '0'.repeat(32),
      pid: process.pid,
      processStart: 'test',
      endpoint,
      tokenFingerprint: '0'.repeat(64),
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('CTRL-B1: a control request rejects when the owner’s socket ends or closes before it answers', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const behaviour of ['end-after-hello', 'destroy-after-hello', 'end-at-once'] as const) {
    const owner = await fakeOwner(behaviour);
    try {
      await assert.rejects(
        withSocketTestTimeout(
          requestControl(owner.record, 'a'.repeat(64), 'close-test', 'lane-wait', {}),
          `the ${behaviour} request to settle`,
          5_000,
        ),
        (error: unknown) => {
          assert.doesNotMatch(String(error), /timed out/u, `${behaviour}: the request settled rather than hung`);
          assert.equal((error as NodeJS.ErrnoException).code, 'ECONNRESET', behaviour);
          return true;
        },
      );
    } finally {
      await owner.close();
    }
  }
});

test('CTRL-B1: a control request’s signal ends it at once and closes its connection', {
  skip: WINDOWS_SKIP,
}, async () => {
  const owner = await fakeOwner('hold');
  try {
    const abort = new AbortController();
    const pending = requestControl(owner.record, 'a'.repeat(64), 'abort-test', 'lane-wait', {}, abort.signal);
    setTimeout(() => abort.abort(), 100);
    await assert.rejects(withSocketTestTimeout(pending, 'the aborted request to settle', 5_000), /cancelled/u);
  } finally {
    await owner.close();
  }
});
