import assert from 'node:assert/strict';
import { connect, type Socket } from 'node:net';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore } from '@agentcomms/core';
import { StreamReplay } from '../src/runtime/stream-replay.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { sseSubscriber } from './support/events-owner.ts';
import { freePort, issueCreated, type LiveEventsHarness, withLiveEvents } from './support/live-events.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.36.0, M1 and L8, against the real owner: a listener that is no longer wanted closes within a
 * bound at the next tick, whatever its clients do — a request left half-sent, or a token holder that stops reading —
 * so neither holds the owner's tick, and with it the engine, the sources and every other delivery. And a listener's
 * event writer writes only its own subscriber's rows.
 */

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function socketTo(port: number): Promise<Socket> {
  const socket = connect(port, '127.0.0.1');
  socket.on('error', () => undefined);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', () => resolve());
    socket.once('error', reject);
  });
  return socket;
}

/**
 * The subscriber is removed, which an agent may do (it tightens); the next tick closes its listener. It must finish in
 * a few seconds. The client is let go only after the bound, so a tick that waited on it shows as a failure here.
 */
async function removeThenTick(harness: LiveEventsHarness, client: Socket): Promise<void> {
  await harness.lane.control.request('removeSubscriber', { subscriberId: 'events-dashboard' });
  const started = Date.now();
  const tick = harness.tick();
  try {
    const finished = await Promise.race([tick.then(() => true), delay(8_000).then(() => false)]);
    const took = Date.now() - started;
    assert.equal(finished, true, `the tick finished while the client still holds its socket (waited ${took} ms)`);
    assert.ok(took < 5_000, `within a few seconds (took ${took} ms)`);
  } finally {
    client.destroy();
    await tick;
  }
}

test('M1: a request left half-sent does not hold the tick that closes its listener', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port }) }], async (harness) => {
    const client = await socketTo(port);
    // The review's scenario: a request line and a Host, and never the blank line. No token is needed.
    client.write(`GET /v1/streams/events-dashboard HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n`);
    await delay(50);
    await removeThenTick(harness, client);
  });
});

test('M1: a token holder that stops reading does not hold the tick that closes its listener', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port }) }], async (harness) => {
    const client = await socketTo(port);
    const token = harness.tokens.get('events-dashboard') ?? '';
    client.write(
      `GET /v1/streams/events-dashboard HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\n\r\n`,
    );
    let head = '';
    await new Promise<void>((resolve) => {
      const onData = (chunk: Buffer) => {
        head += chunk.toString('latin1');
        if (!head.includes('\r\n\r\n')) return;
        client.off('data', onData);
        resolve();
      };
      client.on('data', onData);
    });
    assert.match(head, /^HTTP\/1\.1 200/);
    // It stops reading. Its events keep coming: enough to fill the loopback socket's buffers, so the stream's end can
    // no longer be flushed, but less than the 1 MiB a stream may hold before it is closed for not reading.
    client.pause();
    const url = `https://linear.app/acme/issue/ACME-1?${'x'.repeat(64 * 1024)}`;
    const raised = await harness.raise((run, workflow) => {
      (workflow.flow.limits as { eventsPerHour: number }).eventsPerHour = 600;
      return Array.from({ length: 24 }, (_, index) => {
        const settle = issueCreated(run, workflow, Date.now(), index + 1);
        return { ...settle, output: { ...settle.output, issue: { id: 'issue-1', identifier: 'ACME-1', url } } };
      });
    });
    assert.equal(raised.length, 24);
    await harness.tick();
    const delivered = harness.database
      .prepare("SELECT COUNT(*) AS count FROM event_deliveries WHERE state = 'delivered'")
      .get() as { count: number };
    assert.equal(delivered.count, 24, 'every event was delivered to the stream');
    t.diagnostic(
      `the stream was ${client.destroyed ? 'already closed' : 'still open'} when its subscriber was removed`,
    );
    await removeThenTick(harness, client);
  });
});

test("L8: a listener's event writer refuses another subscriber's row", { skip: WINDOWS_SKIP }, async () => {
  const mine = await freePort();
  const theirs = await freePort();
  await withLiveEvents(
    [
      { document: sseSubscriber({ port: mine }) },
      { document: sseSubscriber({ subscriberId: 'other-dashboard', port: theirs }) },
    ],
    async (harness) => {
      await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      const rows = harness.database
        .prepare('SELECT id, subscriber_id FROM event_stream_log ORDER BY subscriber_id')
        .all() as Array<{ id: string; subscriber_id: string }>;
      const other = rows.find((row) => row.subscriber_id === 'other-dashboard');
      assert.ok(other, "the event was delivered into the other subscriber's log");
      const configDir = join(dirname(harness.stateDir), 'config');
      const store = await openEventDatabase({ stateDir: harness.stateDir });
      try {
        const secrets = await openEventSecretStore({ database: store.database, paths: store.paths, configDir });
        const config = new ConfigStore(configDir);
        const replay = new StreamReplay({
          store,
          cipher: new EventRecordCipher(store.database, secrets, new WriterQuiescer()),
          approvals: new ApprovalStore(harness.stateDir, { loadConfig: () => config.load() }),
          config,
        });
        const written: string[] = [];
        const write = (subscriberId: string) =>
          replay.writeEvent({
            eventStreamLogId: other.id,
            subscriberId,
            subscriberVersion: 1,
            isStreamCurrent: () => true,
            writeFrame: (frame) => written.push(frame),
          });
        assert.equal(await write('events-dashboard'), false, "this listener's writer refuses the other's row");
        assert.deepEqual(written, []);
        // The row is one its own subscriber's listener would write: the refusal is whose row it is, nothing else.
        assert.equal(await write('other-dashboard'), true);
        assert.equal(written.length, 1);
      } finally {
        store.close();
      }
    },
  );
});
