import assert from 'node:assert/strict';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { sseSubscriber, withEventsOwner } from './support/events-owner.ts';
import { readDatabase } from './support/lane-harness.ts';
import { freePort, issueCreated, openSse, withLiveEvents } from './support/live-events.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * D3 (workflows plan, Track D): the live stream runs. The owner starts one loopback listener for each subscriber
 * version something may deliver to — one an active workflow's SSE target binds, or one whose subscription is active —
 * and closes it when that ends. Its checks are today's (W31). An event's SSE frame is `id: <event id>`, `event:
 * <type>`, `data: <the CloudEvent>`, and Last-Event-ID replays rule frames and events in one order.
 */

type Listed = { subscriberId: string; version: number; listening: unknown; listenError: unknown };

async function listed(control: EventControlClient, subscriberId: string): Promise<Listed | undefined> {
  return ((await control.request('subscribersList', {})) as Listed[]).find(
    (entry) => entry.subscriberId === subscriberId,
  );
}

/** One plain HTTP GET to a listener, for the refusals: its status code. */
async function status(port: number, path: string, headers: Record<string, string>): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, headers }, (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      req.destroy();
    });
    req.once('error', reject);
    req.end();
  });
}

test('D3: the owner starts a listener for an approved subscription and stops it on remove; nothing delivered to gets none', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  const idle = await freePort();
  await withLiveEvents(
    [
      { document: sseSubscriber({ port }) },
      // Inert: given events but not approved, and bound by no workflow — nothing may deliver to it.
      { document: sseSubscriber({ subscriberId: 'not-approved', port: idle }), approve: false },
    ],
    async (harness) => {
      const control = harness.lane.control;
      assert.deepEqual((await listed(control, 'events-dashboard'))?.listening, { host: '127.0.0.1', port });
      assert.equal(
        (await listed(control, 'not-approved'))?.listening,
        null,
        'a subscriber nothing delivers to gets none',
      );
      const stream = await openSse({
        port,
        subscriberId: 'events-dashboard',
        token: harness.tokens.get('events-dashboard') ?? '',
      });
      assert.equal(stream.status, 200);
      await control.request('removeSubscriber', { subscriberId: 'events-dashboard' });
      for (let waited = 0; !stream.ended() && waited < 2_000; waited += 10) await new Promise((r) => setTimeout(r, 10));
      assert.equal(stream.ended(), true, 'removing the subscriber closes its open stream at once');
      await harness.tick();
      assert.equal(
        (await listed(control, 'events-dashboard'))?.listening,
        null,
        'and the next tick closes its listener',
      );
      // The port is free again: something else can bind it.
      const probe = createServer();
      await new Promise<void>((resolve, reject) => {
        probe.once('error', reject);
        probe.listen(port, '127.0.0.1', () => resolve());
      });
      await new Promise<void>((resolve) => probe.close(() => resolve()));
    },
  );
});

test('D3: a port in use shows PORT_IN_USE in subscribers list', { skip: WINDOWS_SKIP }, async () => {
  const holder = createServer();
  await new Promise<void>((resolve) => holder.listen(0, '127.0.0.1', () => resolve()));
  const address = holder.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  try {
    await withEventsOwner(async (harness) => {
      await harness.control.request('addSubscriber', { document: sseSubscriber({ port: address.port }) });
      const prepared = (await harness.control.request('subscriber-enable', {
        subscriberId: 'events-dashboard',
        version: 1,
      })) as { approvalId: string };
      await harness.approve(prepared.approvalId);
      await harness.owner.tick();
      const entry = await listed(harness.control, 'events-dashboard');
      assert.equal(entry?.listening, null);
      assert.equal(entry?.listenError, 'PORT_IN_USE');
      // When the port comes free, the next tick listens.
      await new Promise<void>((resolve) => holder.close(() => resolve()));
      await harness.owner.tick();
      assert.deepEqual((await listed(harness.control, 'events-dashboard'))?.listening, {
        host: '127.0.0.1',
        port: address.port,
      });
    });
  } finally {
    if (holder.listening) await new Promise<void>((resolve) => holder.close(() => resolve()));
  }
});

test('D3: SSE: id, event and data lines for an event; Last-Event-ID replays rule frames and events in one order', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents(
    [{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }), bound: true }],
    async (harness) => {
      const token = harness.tokens.get('events-dashboard') ?? '';
      const live = await openSse({ port, subscriberId: 'events-dashboard', token });
      assert.equal(live.status, 200);
      const ruleFrame = async (subject: string) => {
        const before = readDatabase(harness.stateDir, (db) =>
          db.prepare('SELECT COUNT(*) AS count FROM stream_log').get(),
        ) as { count: number };
        harness.lane.mailbox.send(subject);
        for (let index = 0; index < 20; index += 1) {
          await harness.tick();
          const after = readDatabase(harness.stateDir, (db) =>
            db.prepare('SELECT COUNT(*) AS count FROM stream_log').get(),
          ) as { count: number };
          if (after.count > before.count) return;
        }
        assert.fail(`the mail "${subject}" never reached the subscriber's rule frames`);
      };
      await ruleFrame('first rule frame');
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      await ruleFrame('second rule frame');
      // Live: the event arrived on the open stream as its own frame.
      await live.waitFor(1);
      const liveEvent = live.frames().find((frame) => frame.event !== null);
      assert.ok(liveEvent, 'the open stream received the event');
      assert.equal(liveEvent.id, eventId);
      assert.equal(liveEvent.event, 'acme.client-asks.issue.created');
      const cloudEvent = JSON.parse(liveEvent.data) as { id: string; type: string; agentcommsuntrusted?: string };
      assert.equal(cloudEvent.id, eventId);
      assert.equal(cloudEvent.type, 'acme.client-asks.issue.created');
      live.close();
      // Replay from the start: rule frame, event, rule frame — one order, by when each reached this subscriber.
      const all = await openSse({ port, subscriberId: 'events-dashboard', token });
      await all.waitFor(3);
      const frames = all.frames();
      all.close();
      assert.deepEqual(
        frames.map((frame) => (frame.event === null ? 'rule' : frame.event)),
        ['rule', 'acme.client-asks.issue.created', 'rule'],
      );
      // After the first rule frame: the event, then the second rule frame. After the event (its id): the rule frame.
      const afterRule = await openSse({
        port,
        subscriberId: 'events-dashboard',
        token,
        lastEventId: frames[0]?.id ?? '',
      });
      await afterRule.waitFor(2);
      assert.deepEqual(
        afterRule.frames().map((frame) => frame.id),
        [eventId, frames[2]?.id],
      );
      afterRule.close();
      const afterEvent = await openSse({ port, subscriberId: 'events-dashboard', token, lastEventId: eventId ?? '' });
      await afterEvent.waitFor(1);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.deepEqual(
        afterEvent.frames().map((frame) => frame.id),
        [frames[2]?.id],
      );
      afterEvent.close();
      // An id this subscriber never had replays nothing.
      const unknown = await openSse({ port, subscriberId: 'events-dashboard', token, lastEventId: 'wfe_unknown' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(unknown.frames(), []);
      unknown.close();
    },
  );
});

test('D3: Host, query, cookie and Origin refusals hold for event streams', { skip: WINDOWS_SKIP }, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port, origins: ['http://localhost:3000'] }) }], async (harness) => {
    const token = harness.tokens.get('events-dashboard') ?? '';
    const path = '/v1/streams/events-dashboard';
    const good = { host: `127.0.0.1:${port}`, authorization: `Bearer ${token}` };
    assert.equal(await status(port, path, { ...good, host: `localhost:${port}` }), 403, 'another Host');
    assert.equal(await status(port, `${path}?after=1`, good), 403, 'a query');
    assert.equal(await status(port, path, { ...good, cookie: 'a=b' }), 403, 'a cookie');
    assert.equal(await status(port, path, { ...good, origin: 'http://evil.example' }), 403, 'an Origin not listed');
    assert.equal(await status(port, path, { ...good, authorization: 'Bearer wrong' }), 403, 'another bearer');
    assert.equal(await status(port, path, { ...good, origin: 'http://localhost:3000' }), 200, 'the listed Origin');
    assert.equal(await status(port, path, good), 200, 'no Origin: a program, not a page');
  });
});

test('D3: a frame written after subscriber remove returns never reaches the stream', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  let removeDuring: (() => Promise<void>) | undefined;
  await withLiveEvents(
    [{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) }],
    async (harness) => {
      const token = harness.tokens.get('events-dashboard') ?? '';
      const stream = await openSse({ port, subscriberId: 'events-dashboard', token });
      assert.equal(stream.status, 200);
      // The dispatcher has claimed the delivery and fenced it when the person removes the subscriber; its frame is
      // written after the removal returns, and must reach nothing.
      let removed = false;
      removeDuring = async () => {
        if (removed) return;
        removed = true;
        await new EventControlClient({ stateDir: harness.stateDir, clientName: 'd3-remove' }).request(
          'removeSubscriber',
          { subscriberId: 'events-dashboard' },
        );
      };
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      assert.equal(removed, true, 'the removal ran inside the attempt');
      await new Promise((resolve) => setTimeout(resolve, 200));
      assert.deepEqual(
        stream.frames().filter((frame) => frame.event !== null),
        [],
        'no event frame reached the stream',
      );
      assert.equal(stream.ended(), true, 'the stream was closed by the removal');
      const delivery = harness.database
        .prepare('SELECT state FROM event_deliveries WHERE event_id = ?')
        .get(eventId as string) as { state: string };
      assert.equal(delivery.state, 'cancelled');
      const logged = harness.database
        .prepare('SELECT COUNT(*) AS count FROM event_stream_log WHERE event_id = ?')
        .get(eventId as string) as { count: number };
      assert.equal(logged.count, 0, 'and nothing was kept for a replay');
    },
    { eventDispatchTestPoint: async (point) => (point === 'after-fence' ? removeDuring?.() : undefined) },
  );
});

test("a workflow SSE target's frame reaches an open stream at once, not only on the next replay", {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents(
    [{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }), bound: true }],
    async (harness) => {
      const token = harness.tokens.get('events-dashboard') ?? '';
      const live = await openSse({ port, subscriberId: 'events-dashboard', token });
      assert.equal(live.status, 200);
      harness.lane.mailbox.send('a rule frame while the stream is open');
      let logged: { id: string } | undefined;
      for (let index = 0; index < 20 && logged === undefined; index += 1) {
        await harness.tick();
        logged = readDatabase(harness.stateDir, (db) =>
          db.prepare('SELECT id FROM stream_log ORDER BY delivered_at DESC LIMIT 1').get(),
        ) as { id: string } | undefined;
      }
      assert.ok(logged, "the mail reached the subscriber's rule frames");
      await live.waitFor(1, 2_000);
      const frames = live.frames();
      live.close();
      assert.deepEqual(
        frames.map((frame) => ({ id: frame.id, event: frame.event })),
        [{ id: logged.id, event: null }],
        'the open stream got the rule frame without reconnecting',
      );
    },
  );
});
