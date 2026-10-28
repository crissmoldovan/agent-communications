import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { Socket } from 'node:net';
import { join } from 'node:path';
import { test } from 'node:test';
import { EventControlClient } from '../src/control/client.ts';
import { createWorkflowEventSink } from '../src/runtime/events/sink.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { runCli, sseSubscriber, webhookSubscriber } from './support/events-owner.ts';
import { freePort, issueCreated, liveWorkflow, openSse, withLiveEvents } from './support/live-events.ts';
import { startLoopbackReceiver } from './support/loopback-receiver.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInSecrets } from './support/stand-ins.ts';
import { seedRun } from './support/workflow-event-rows.ts';

/*
 * D5 (workflows plan, Track D): events reach their subscribers — live into the stream log, and by signed webhook —
 * at least once, in order per subscriber, with retries, a dead letter, a bounded backlog, and revocation that wins.
 * Webhooks go only to a loopback receiver (`loopback-receiver.ts`), never to anything real.
 */

interface Received {
  readonly headers: Readonly<Record<string, string>>;
  readonly body: string;
  /** When the whole request had arrived. */
  readonly at: number;
}

/** A loopback webhook receiver answering each request with the next status it is given (the last one repeats). */
async function receiver(statuses: readonly number[]) {
  const requests: Received[] = [];
  const handle = (socket: Socket) => {
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf('\r\n\r\n');
      if (end === -1) return;
      const head = buffer.subarray(0, end).toString('latin1').split('\r\n');
      const headers = Object.fromEntries(
        head.slice(1).map((line) => {
          const at = line.indexOf(':');
          return [line.slice(0, at).trim().toLowerCase(), line.slice(at + 1).trim()];
        }),
      );
      const length = Number(headers['content-length'] ?? 0);
      if (buffer.byteLength < end + 4 + length) return;
      requests.push({ headers, body: buffer.subarray(end + 4, end + 4 + length).toString('utf8'), at: Date.now() });
      const status = statuses[Math.min(requests.length - 1, statuses.length - 1)] ?? 200;
      socket.end(`HTTP/1.1 ${status} X\r\nContent-Length: 0\r\nConnection: close\r\n\r\n`);
    });
  };
  const server = await startLoopbackReceiver(handle);
  return { server, requests, url: `http://127.0.0.1:${server.port}/hooks/events` };
}

function verify(secret: string, received: Received): boolean[] {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64');
  const expected = createHmac('sha256', key)
    .update(`${received.headers['webhook-id']}.${received.headers['webhook-timestamp']}.${received.body}`, 'utf8')
    .digest('base64');
  return (received.headers['webhook-signature'] ?? '').split(' ').map((signature) => signature === `v1,${expected}`);
}

async function signingSecret(stateDir: string, rotate = false): Promise<string> {
  const made = await runCli(
    stateDir,
    ['subscriber', 'secret', rotate ? 'rotate' : 'create', 'crm-hook', '--version', '1'],
    { tty: true, json: false },
  );
  assert.equal(made.code, 0, made.err);
  const secret = /Generated credential \(shown once\): (whsec_\S+)/u.exec(made.out)?.[1];
  assert.ok(secret);
  return secret;
}

function delivery(
  harness: { database: import('node:sqlite').DatabaseSync },
  eventId: string,
): { state: string; attempts: number; last_error_code: string | null; dead_letter_expires_at: number | null } {
  return {
    ...(harness.database
      .prepare(
        'SELECT state, attempts, last_error_code, dead_letter_expires_at FROM event_deliveries WHERE event_id = ?',
      )
      .get(eventId) as {
      state: string;
      attempts: number;
      last_error_code: string | null;
      dead_letter_expires_at: number | null;
    }),
  };
}

test('D5: a webhook subscriber receives the CloudEvent with webhook-id = event id on every try; deliveries list and retry name it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await receiver([500, 200]);
  try {
    await withLiveEvents([{ document: webhookSubscriber({ url: hook.url }) }], async (harness) => {
      const secret = await signingSecret(harness.stateDir);
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      assert.equal(hook.requests.length, 1);
      assert.equal(delivery(harness, eventId as string).state, 'retryable');
      const listed = (await harness.lane.control.request('deliveriesList', {})) as Array<Record<string, unknown>>;
      const row = listed.find((entry) => entry.kind === 'event');
      assert.equal(row?.deliveryId, `${eventId}:crm-hook`);
      assert.equal(row?.state, 'retryable');
      assert.equal(row?.lastStatus, 500);
      // An agent — here, the CLI inside the event service's MCP server — cannot stop it; the person can.
      const agent = await runCli(harness.stateDir, ['delivery', 'drop', `${eventId}:crm-hook`], {
        env: { AGENTCOMMS_MCP_SERVER: 'events' },
      });
      assert.equal(agent.code, 10, agent.err);
      assert.equal(delivery(harness, eventId as string).state, 'retryable');
      // "Try now", by the event delivery's own key.
      const retried = await harness.lane.control.request('retryDelivery', { deliveryId: `${eventId}:crm-hook` });
      assert.equal((retried as { kind: string }).kind, 'delivery-retried');
      await harness.tick();
      assert.equal(hook.requests.length, 2);
      assert.equal(delivery(harness, eventId as string).state, 'delivered');
      for (const request of hook.requests) {
        assert.equal(request.headers['webhook-id'], eventId, 'webhook-id is the event id, on every try');
        assert.equal(request.headers['content-type'], 'application/cloudevents+json; charset=utf-8');
        const body = JSON.parse(request.body) as { id: string; type: string; specversion: string };
        assert.equal(body.id, eventId);
        assert.equal(body.type, 'acme.client-asks.issue.created');
        assert.deepEqual(verify(secret, request), [true]);
      }
      const event = harness.database
        .prepare('SELECT state, encrypted_record FROM workflow_events WHERE id = ?')
        .get(eventId as string) as { state: string; encrypted_record: Uint8Array | null };
      assert.deepEqual({ ...event }, { state: 'done', encrypted_record: null }, 'a delivered event keeps no record');
    });
  } finally {
    await hook.server.close();
  }
});

test('D5: signatures with the current and the overlap secret', { skip: WINDOWS_SKIP }, async () => {
  const hook = await receiver([200]);
  try {
    await withLiveEvents([{ document: webhookSubscriber({ url: hook.url }) }], async (harness) => {
      const first = await signingSecret(harness.stateDir);
      const second = await signingSecret(harness.stateDir, true);
      await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      assert.equal(hook.requests.length, 1);
      const request = hook.requests[0] as Received;
      assert.equal((request.headers['webhook-signature'] ?? '').split(' ').length, 2, 'two signatures');
      assert.deepEqual(verify(second, request), [true, false], 'the current secret signs first');
      assert.deepEqual(verify(first, request), [false, true], 'the overlap secret signs too');
    });
  } finally {
    await hook.server.close();
  }
});

test('D5: strict order: the second waits for the first to settle', { skip: WINDOWS_SKIP }, async () => {
  const hook = await receiver([500, 200]);
  try {
    await withLiveEvents([{ document: webhookSubscriber({ url: hook.url }) }], async (harness) => {
      await signingSecret(harness.stateDir);
      const ids = await harness.raise((run, workflow) => [
        issueCreated(run, workflow, Date.now(), 1),
        issueCreated(run, workflow, Date.now(), 2),
      ]);
      await harness.tick();
      await harness.tick();
      assert.deepEqual(
        hook.requests.map((request) => request.headers['webhook-id']),
        [ids[0]],
        'the second is not sent while the first waits for its retry',
      );
      assert.equal(delivery(harness, ids[1] as string).state, 'queued');
      await harness.lane.control.request('retryDelivery', { deliveryId: `${ids[0]}:crm-hook` });
      await harness.tick();
      await harness.tick();
      assert.deepEqual(
        hook.requests.map((request) => request.headers['webhook-id']),
        [ids[0], ids[0], ids[1]],
      );
    });
  } finally {
    await hook.server.close();
  }
});

test('D5: retries up to retryLimit, then a dead letter kept deadLetterMs; drop lets it go', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await receiver([503]);
  try {
    await withLiveEvents([{ document: webhookSubscriber({ url: hook.url, retryLimit: 2 }) }], async (harness) => {
      await signingSecret(harness.stateDir);
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.tick();
      await harness.lane.control.request('retryDelivery', { deliveryId: `${eventId}:crm-hook` });
      const before = Date.now();
      await harness.tick();
      assert.equal(hook.requests.length, 2);
      const dead = delivery(harness, eventId as string);
      assert.equal(dead.state, 'dead-lettered');
      assert.equal(dead.attempts, 2);
      assert.equal(dead.last_error_code, 'HTTP_NON_SUCCESS');
      const kept = (dead.dead_letter_expires_at ?? 0) - before;
      assert.ok(kept > 6.9 * 86_400_000 && kept <= 7 * 86_400_000 + 60_000, `kept for deadLetterMs (${kept})`);
      const event = harness.database
        .prepare('SELECT state FROM workflow_events WHERE id = ?')
        .get(eventId as string) as { state: string };
      assert.equal(event.state, 'open', 'a dead letter keeps its event, so it can be tried again');
      await harness.lane.control.request('dropDelivery', { deliveryId: `${eventId}:crm-hook` });
      const dropped = harness.database
        .prepare('SELECT state, encrypted_record FROM workflow_events WHERE id = ?')
        .get(eventId as string) as { state: string; encrypted_record: Uint8Array | null };
      assert.deepEqual({ ...dropped }, { state: 'done', encrypted_record: null });
    });
  } finally {
    await hook.server.close();
  }
});

test('D5: a delivery claimed before subscriber remove and fenced after it sends nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await receiver([200]);
  let removeDuring: (() => Promise<void>) | undefined;
  try {
    await withLiveEvents(
      [{ document: webhookSubscriber({ url: hook.url }) }],
      async (harness) => {
        await signingSecret(harness.stateDir);
        let removed = false;
        removeDuring = async () => {
          if (removed) return;
          removed = true;
          await new EventControlClient({ stateDir: harness.stateDir, clientName: 'd5-remove' }).request(
            'removeSubscriber',
            { subscriberId: 'crm-hook' },
          );
        };
        const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
        await harness.tick();
        assert.equal(removed, true, 'the removal ran after the claim and the fence');
        assert.equal(hook.requests.length, 0, 'nothing was sent');
        assert.equal(delivery(harness, eventId as string).state, 'cancelled');
      },
      { eventDispatchTestPoint: async (point) => (point === 'after-fence' ? removeDuring?.() : undefined) },
    );
  } finally {
    await hook.server.close();
  }
});

test('D5: disabling the workflow cancels its open event deliveries', { skip: WINDOWS_SKIP }, async () => {
  const hook = await receiver([200]);
  try {
    await withLiveEvents([{ document: webhookSubscriber({ url: hook.url }) }], async (harness) => {
      await signingSecret(harness.stateDir);
      const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
      await harness.lane.control.request('rule-disable', { ruleId: liveWorkflow().ruleId });
      const cancelled = delivery(harness, eventId as string);
      assert.equal(cancelled.state, 'cancelled');
      assert.equal(cancelled.last_error_code, 'WORKFLOW_REVOKED');
      await harness.tick();
      assert.equal(hook.requests.length, 0);
      const event = harness.database
        .prepare('SELECT state, encrypted_record FROM workflow_events WHERE id = ?')
        .get(eventId as string) as { state: string; encrypted_record: Uint8Array | null };
      assert.deepEqual({ ...event }, { state: 'cancelled', encrypted_record: null });
    });
  } finally {
    await hook.server.close();
  }
});

test('D5: past 10,000 undelivered the oldest expire with SUBSCRIBER_BACKLOG', { skip: WINDOWS_SKIP }, async () => {
  const root = await shortTempDir('aev-d5-backlog-');
  const home = await standInHome(root);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    await standInSecrets(store.database);
    const cipher = new EventRecordCipher(
      store.database,
      await openEventSecretStore({ database: store.database, paths: store.paths, configDir: home.configDir }),
      new WriterQuiescer(),
    );
    const document = JSON.stringify({
      authority: { host: '127.0.0.1', port: 4801 },
      events: { content: 'none', namespaces: ['acme'], patterns: ['acme.*.*.*'] },
      kind: 'sse',
      origins: [],
      retentionMs: 86_400_000,
      subscriberId: 'events-dashboard',
      version: 1,
    });
    const { sha256Hex } = await import('@agentcomms/core');
    store.database
      .prepare(
        "INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest, state) VALUES ('events-dashboard@1', 'events-dashboard', 1, ?, ?, 'active')",
      )
      .run(document, sha256Hex(document));
    const now = Date.now();
    const runId = seedRun(store.database, { ruleId: 'david-by-mail', ruleVersion: 1, accountId: 'acct', now });
    // 10,000 undelivered events already wait for this subscriber.
    store.database.exec(`
      WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 10000)
      INSERT INTO workflow_events (id, run_id, step_id, rule_id, rule_version, account_id, type, schema, sequence,
                                   raised_at, expires_at, state, encrypted_record)
      SELECT 'wfe_' || printf('%026d', i), '${runId}', 'issue', 'david-by-mail', 1, 'acct',
             'acme.client-asks.issue.created', 'step.deliver.linear', i, ${now}, ${now + 86_400_000}, 'open', X'00'
        FROM n;
      INSERT INTO event_deliveries (event_id, subscriber_id, subscriber_version, kind, state, ordering_sequence)
      SELECT id, 'events-dashboard', 1, 'sse', 'queued', sequence FROM workflow_events;
    `);
    const sink = createWorkflowEventSink({ cipher, installationId: store.installationId });
    const run = {
      id: runId,
      ruleId: 'david-by-mail',
      ruleVersion: 1,
      accountId: 'acct',
      eventId: `event-${runId}`,
      depth: 0,
      parentRunId: null,
      startedAt: now,
      expiresAt: now + 86_400_000,
      shadow: false,
    };
    const prepared = await sink.prepare([issueCreated(run, liveWorkflow(), now + 1)]);
    store.immediate(() => sink.commitInTransaction(store.database, prepared));
    const oldest = store.database
      .prepare('SELECT state, last_error_code FROM event_deliveries WHERE ordering_sequence = 1')
      .get() as { state: string; last_error_code: string };
    assert.deepEqual({ ...oldest }, { state: 'expired', last_error_code: 'SUBSCRIBER_BACKLOG' });
    const waiting = store.database
      .prepare("SELECT COUNT(*) AS count FROM event_deliveries WHERE state = 'queued'")
      .get() as { count: number };
    assert.equal(waiting.count, 10_000, 'the backlog stays at its bound, the new event in it');
    const event = store.database
      .prepare("SELECT state FROM workflow_events WHERE id = 'wfe_00000000000000000000000001'")
      .get() as { state: string };
    assert.equal(event.state, 'done', "the expired one's record goes");
  } finally {
    store.close();
  }
});

test('D5: a live subscriber with no stream open is delivered into the log and replays later', {
  skip: WINDOWS_SKIP,
}, async () => {
  const port = await freePort();
  await withLiveEvents([{ document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) }], async (harness) => {
    const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
    await harness.tick();
    assert.equal(delivery(harness, eventId as string).state, 'delivered', 'delivered with no stream open');
    const later = await openSse({
      port,
      subscriberId: 'events-dashboard',
      token: harness.tokens.get('events-dashboard') ?? '',
    });
    await later.waitFor(1);
    assert.deepEqual(
      later.frames().map((frame) => [frame.id, frame.event]),
      [[eventId, 'acme.client-asks.issue.created']],
    );
    later.close();
  });
});

test('D5: events written before a crash are delivered after the restart, once each', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await receiver([200]);
  const port = await freePort();
  try {
    await withLiveEvents(
      [
        { document: webhookSubscriber({ url: hook.url }) },
        { document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) },
      ],
      async (harness) => {
        await signingSecret(harness.stateDir);
        const ids = await harness.raise((run, workflow) => [
          issueCreated(run, workflow, Date.now(), 1),
          issueCreated(run, workflow, Date.now(), 2),
        ]);
        // The service stopped mid-attempt: the first event's deliveries were claimed, their leases now lapsed.
        harness.database
          .prepare(
            `UPDATE event_deliveries SET state = 'disclosing', attempts = 1, attempt_id = 'crashed', lease_token = 'crashed',
                    lease_until = ? WHERE event_id = ?`,
          )
          .run(Date.now() - 1, ids[0] as string);
        for (let index = 0; index < 4; index += 1) await harness.tick();
        assert.deepEqual(
          hook.requests.map((request) => request.headers['webhook-id']),
          ids,
          'each event reached the webhook once, in order',
        );
        const logged = harness.database
          .prepare('SELECT event_id, COUNT(*) AS count FROM event_stream_log GROUP BY event_id ORDER BY delivered_at')
          .all() as Array<{ event_id: string; count: number }>;
        assert.deepEqual(
          logged.map((row) => ({ ...row })),
          ids.map((id) => ({ event_id: id, count: 1 })),
          'and the live subscriber once each',
        );
      },
    );
  } finally {
    await hook.server.close();
  }
});

test('D5: a webhook subscriber that hangs holds back neither the owner’s own ticks nor another subscriber', {
  skip: WINDOWS_SKIP,
}, async () => {
  // A receiver that reads each request and never answers: the attempt waits out its whole timeout.
  const held = new Set<Socket>();
  const server = await startLoopbackReceiver((socket) => {
    socket.on('data', () => held.add(socket));
    socket.once('close', () => held.delete(socket));
  });
  const port = await freePort();
  try {
    await withLiveEvents(
      [
        { document: webhookSubscriber({ url: `http://127.0.0.1:${server.port}/hooks/events` }) },
        { document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) },
      ],
      async (harness) => {
        await signingSecret(harness.stateDir);
        // From here the owner runs on its own quick timer, as on the person's Mac: the test ticks nothing.
        await harness.lane.restart({ tickMs: 50 });
        const [eventId] = await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now())]);
        const state = (subscriberId: string) =>
          (
            harness.database
              .prepare('SELECT state FROM event_deliveries WHERE event_id = ? AND subscriber_id = ?')
              .get(eventId as string, subscriberId) as { state: string }
          ).state;
        for (let waited = 0; state('events-dashboard') !== 'delivered' && waited < 10_000; waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(state('events-dashboard'), 'delivered', 'the live subscriber is not held behind the webhook');
        // The webhook's attempt was claimed in the same pass; its request may land a moment after the live frame.
        for (let waited = 0; held.size === 0 && waited < 10_000; waited += 20)
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(held.size, 1, 'the webhook holds its request open, unanswered');
        assert.equal(state('crm-hook'), 'disclosing', 'and its attempt is still going');
        // The owner's later ticks go on while it hangs: the scheduler is not waiting on it.
        const before = harness.database.prepare('SELECT COUNT(*) AS count FROM event_stream_log').get() as {
          count: number;
        };
        await harness.raise((run, workflow) => [issueCreated(run, workflow, Date.now(), 2)]);
        for (
          let waited = 0;
          (harness.database.prepare('SELECT COUNT(*) AS count FROM event_stream_log').get() as { count: number })
            .count === before.count && waited < 10_000;
          waited += 20
        )
          await new Promise((resolve) => setTimeout(resolve, 20));
        assert.equal(
          (harness.database.prepare('SELECT COUNT(*) AS count FROM event_stream_log').get() as { count: number }).count,
          before.count + 1,
          'a later event reaches the live subscriber too',
        );
        for (const socket of held) socket.destroy();
      },
    );
  } finally {
    await server.close();
  }
});

test('D5: a burst of six reaches each subscriber in order at once, not one event per tick, on the owner’s normal tick', {
  skip: WINDOWS_SKIP,
}, async () => {
  const hook = await receiver([200]);
  const port = await freePort();
  try {
    await withLiveEvents(
      [
        { document: webhookSubscriber({ url: hook.url }) },
        { document: sseSubscriber({ port, patterns: ['acme.*.*.*'] }) },
      ],
      async (harness) => {
        await signingSecret(harness.stateDir);
        // From here the owner runs on its own timer, at its normal interval (5 s): the test ticks nothing.
        await harness.lane.restart({ tickMs: undefined });
        const live = await openSse({
          port,
          subscriberId: 'events-dashboard',
          token: harness.tokens.get('events-dashboard') ?? '',
        });
        try {
          const ids = await harness.raise((run, workflow) =>
            [1, 2, 3, 4, 5, 6].map((index) => issueCreated(run, workflow, Date.now(), index)),
          );
          // The owner's next tick starts each subscriber's first; the rest follow it at once, one at a time each.
          // Bounded well short of the six ticks one event per tick took (30 s).
          const deadline = Date.now() + 15_000;
          while ((hook.requests.length < 6 || live.frames().length < 6) && Date.now() < deadline)
            await new Promise((resolve) => setTimeout(resolve, 20));
          assert.deepEqual(
            hook.requests.map((request) => request.headers['webhook-id']),
            ids,
            'all six by webhook, in order',
          );
          assert.deepEqual(
            live.frames().map((frame) => frame.id),
            ids,
            'and all six live, in order',
          );
          const spread = (times: readonly number[]) => Math.max(...times) - Math.min(...times);
          const hooked = spread(hook.requests.map((request) => request.at));
          const delivered = spread(
            (
              harness.database
                .prepare("SELECT delivered_at FROM event_deliveries WHERE subscriber_id = 'events-dashboard'")
                .all() as Array<{ delivered_at: number }>
            ).map((row) => row.delivered_at),
          );
          assert.ok(hooked < 2_000, `the webhook had them within ${hooked} ms of each other`);
          assert.ok(delivered < 2_000, `the live subscriber within ${delivered} ms`);
        } finally {
          live.close();
        }
      },
    );
  } finally {
    await hook.server.close();
  }
});
