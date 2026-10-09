import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { SseDispatcher } from '../src/runtime/sse-dispatcher.ts';
import { StreamReplay } from '../src/runtime/stream-replay.ts';
import { SubscriberStreams } from '../src/runtime/subscriber-streams.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'account-sse';
const subscriber = {
  subscriberId: 'subscriber-sse',
  version: 1,
  kind: 'sse' as const,
  authority: { host: '127.0.0.1' as const, port: 4444 },
  origins: ['https://app.example.test'],
  retentionMs: 500,
};
const target = {
  targetId: 'target-sse',
  version: 1,
  kind: 'sse' as const,
  subscriberId: subscriber.subscriberId,
  subscriberVersion: subscriber.version,
  representation: 'plain' as const,
};

async function fixture() {
  const stateDir = await shortTempDir('events-sse-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const rule = {
    ruleId: 'rule-sse',
    version: 1,
    targets: [target],
    subscribers: [subscriber],
    deliveryRateCap: 20,
    retention: { sseReplayMs: 500 },
  };
  const ruleJson = canonicalJson(rule);
  const targetJson = canonicalJson(target);
  const subscriberJson = canonicalJson(subscriber);
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-sse@1', 'rule-sse', 1, ?, ?, 'active', 'approval', 'activation', 1)`,
    )
    .run(ruleJson, sha256Hex(ruleJson));
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
    .run('target-sse@1', target.targetId, targetJson, sha256Hex(targetJson));
  store.database
    .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
    .run('subscriber-sse@1', subscriber.subscriberId, subscriberJson, sha256Hex(subscriberJson));
  store.database
    .prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-sse', ?, 'example.event', 1, ?, 'dedupe-sse', 1, 1, 1)`,
    )
    .run(store.installationId, ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO decisions
       (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-sse', 'event-sse', ?, 'rule-sse', 1, 'matched', 9999, 'retained')`,
    )
    .run(ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, subscriber_id, subscriber_version, encrypted_record, expires_at, state, switch_generation)
       VALUES ('delivery-sse', 'decision-sse', ?, 'rule-sse', 1, 'sse:target-sse:1:subscriber-sse:1',
               'target-sse', 1, 'sse', 'plain', 'subscriber-sse', 1, ?, 5000, 'queued', 7)`,
    )
    .run(
      ACCOUNT,
      Buffer.from(JSON.stringify({ cloudEventBytes: '{"id":"event-sse"}', untrusted: [], representation: 'plain' })),
    );
  return { stateDir, store };
}

test('B2-T8: SSE append and delivery settlement share one transaction, charge once, and replay without another charge', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const cipher = {
      async encrypt(_: unknown, bytes: Uint8Array) {
        return Buffer.from(bytes);
      },
      async decrypt(_: unknown, bytes: Uint8Array) {
        return Buffer.from(bytes);
      },
    };
    const dispatcher = new SseDispatcher({
      store: setup.store,
      cipher,
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      now: () => 100,
    });
    assert.deepEqual(await dispatcher.dispatch('delivery-sse'), { state: 'delivered', deliveryId: 'delivery-sse' });
    const stream = setup.store.database
      .prepare('SELECT delivery_id, event_id, account_id, encrypted_record, delivered_at, expires_at FROM stream_log')
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...stream, encrypted_record: Buffer.from(stream.encrypted_record as Uint8Array) },
      {
        delivery_id: 'delivery-sse',
        event_id: 'event-sse',
        account_id: ACCOUNT,
        encrypted_record: Buffer.from('{"id":"event-sse"}'),
        delivered_at: 100,
        expires_at: 600,
      },
    );
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number })
        .count,
      1,
    );
    assert.deepEqual(
      {
        ...(setup.store.database
          .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-sse'")
          .get() as object),
      },
      { state: 'delivered', encrypted_record: null },
    );

    const frames: string[] = [];
    const replay = new StreamReplay({
      store: setup.store,
      cipher,
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      now: () => 101,
    });
    await replay.replay({
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      afterId: null,
      writeFrame: (frame) => frames.push(frame),
    });
    assert.deepEqual(frames, ['id: delivery-sse\ndata: {"id":"event-sse"}\n\n']);
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number })
        .count,
      1,
      'a replay never consumes an additional delivery-cap slot',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T8: bearer rotation accepts only current plus an unexpired previous generation and closes old streams under its mutex', () => {
  let now = 1_000;
  const streams = new SubscriberStreams({ now: () => now });
  const closed: string[] = [];
  assert.equal(
    streams.register({
      subscriberId: 'subscriber-sse',
      subscriberVersion: 1,
      generation: 1,
      close: () =>
        closed.push(
          streams.isCurrent({ subscriberId: 'subscriber-sse', subscriberVersion: 1, generation: 1 }) ? 'stale' : 'one',
        ),
    }),
    true,
  );
  assert.equal(
    streams.authenticate({
      bearer: 'previous',
      generations: [
        { generation: 2, lifecycle: 'current', material: 'current' },
        { generation: 1, lifecycle: 'overlap', material: 'previous', expiresAt: now + 300_000 },
      ],
    }),
    1,
  );
  streams.rotate({ subscriberId: 'subscriber-sse', subscriberVersion: 1, generation: 2 });
  assert.deepEqual(closed, ['one']);
  assert.equal(
    streams.register({ subscriberId: 'subscriber-sse', subscriberVersion: 1, generation: 1, close: () => undefined }),
    false,
    'a close callback cannot re-register the invalidated generation',
  );
  assert.equal(
    streams.authenticate({
      bearer: 'retired',
      generations: [{ generation: 1, lifecycle: 'overlap', material: 'retired', expiresAt: now + 10 }],
    }),
    null,
    'an overlap without one exact current slot is not a valid bearer set',
  );
  now += 300_001;
  assert.equal(
    streams.authenticate({
      bearer: 'previous',
      generations: [{ generation: 1, lifecycle: 'overlap', material: 'previous', expiresAt: 301_000 }],
    }),
    null,
  );
});

test('B2-T8: the persisted current generation, not arrival order, decides; an overlap stream ends with its overlap', () => {
  let now = 1_000;
  const streams = new SubscriberStreams({ now: () => now });
  const key = { subscriberId: 'subscriber-sse', subscriberVersion: 1 } as const;
  const generations = [
    { generation: 2, lifecycle: 'current' as const, material: 'current' },
    { generation: 1, lifecycle: 'overlap' as const, material: 'previous', expiresAt: now + 300_000 },
  ];
  const previous = streams.admit({ bearer: 'previous', generations });
  assert.deepEqual(previous, { generation: 1, currentGeneration: 2, authorizedUntil: now + 300_000 });
  const current = streams.admit({ bearer: 'current', generations });
  assert.deepEqual(current, { generation: 2, currentGeneration: 2 });
  if (previous === null || current === null) throw new Error('both bearers are admitted');

  // The overlap stream arrives first; it must not make generation 1 the current one and lock generation 2 out.
  let overlapClosed = 0;
  assert.equal(streams.register({ ...key, ...previous, close: () => (overlapClosed += 1) }), true);
  assert.equal(streams.register({ ...key, ...current, close: () => undefined }), true);
  assert.equal(streams.isCurrent({ ...key, ...current }), true);
  assert.equal(streams.isCurrent({ ...key, ...previous }), true, 'the previous bearer is live inside its overlap');
  assert.equal(
    streams.isCurrent({ ...key, generation: 1 }),
    false,
    'without its overlap bound, generation 1 is not current',
  );
  assert.equal(
    streams.register({ ...key, generation: 1, close: () => undefined, currentGeneration: 1 }),
    false,
    'an admission read before a rotation this process has seen is stale',
  );
  now += 300_000;
  assert.equal(streams.isCurrent({ ...key, ...previous }), false, 'the overlap stream ends exactly at its expiry');
  assert.equal(streams.isCurrent({ ...key, ...current }), true);

  // A rotation persisted elsewhere is applied at the next admission: older streams are closed, as rotate does.
  const later = new SubscriberStreams({ now: () => now });
  let staleClosed = 0;
  assert.equal(later.register({ ...key, generation: 2, currentGeneration: 2, close: () => (staleClosed += 1) }), true);
  assert.equal(later.register({ ...key, generation: 3, currentGeneration: 3, close: () => undefined }), true);
  assert.equal(staleClosed, 1);
  assert.equal(later.isCurrent({ ...key, generation: 2 }), false);
  assert.equal(overlapClosed, 0, 'expiry alone ends authority; the listener closes the socket on its next write');
});

test('B2-T8: stream bytes are purged by their replay deadline and disable-all in the same authority transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database.exec(`INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
       event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
       expires_at, switch_generation)
      VALUES ('stream-expiring', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
              'event-sse', '${ACCOUNT}', NULL, NULL, X'01', 100, 200, 7)`);
    assert.equal(new EventExpiry(setup.store, () => 200).sweep().streamRecords, 1);
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM stream_log').get() as { count: number }).count,
      0,
    );

    setup.store.database
      .prepare(
        `INSERT INTO stream_log
         (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
          event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
          expires_at, switch_generation)
         VALUES ('stream-disable', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
                 'event-sse', ?, NULL, NULL, X'01', 100, 500, 7)`,
      )
      .run(ACCOUNT);
    await new EventLifecycle(setup.store, () => 201).disableAll();
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM stream_log').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T8: replay refuses an expired retained row before it decrypts or writes a frame', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database.exec(`INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
       event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
       expires_at, switch_generation)
      VALUES ('stream-replay-expired', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
              'event-sse', '${ACCOUNT}', NULL, NULL, X'01', 100, 101, 7)`);
    let decrypts = 0;
    const replay = new StreamReplay({
      store: setup.store,
      cipher: {
        async decrypt() {
          decrypts += 1;
          return Buffer.from('{"id":"event-sse"}');
        },
      },
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      fence: async () => undefined,
      now: () => 101,
    });
    const frames: string[] = [];
    assert.equal(
      await replay.replay({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        afterId: null,
        writeFrame: (frame) => frames.push(frame),
      }),
      0,
    );
    assert.equal(decrypts, 0);
    assert.deepEqual(frames, []);
    assert.equal(
      (
        setup.store.database
          .prepare("SELECT count(*) AS count FROM stream_log WHERE id = 'stream-replay-expired'")
          .get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T8: replay rechecks retained authority after decryption and before the sealed frame write', {
  skip: WINDOWS_SKIP,
}, async () => {
  const cases: readonly Readonly<{
    readonly name: string;
    readonly loseAuthority: (store: Awaited<ReturnType<typeof fixture>>['store']) => void;
  }>[] = [
    {
      name: 'pause',
      loseAuthority: (store) => store.database.exec('UPDATE event_settings SET paused = 1'),
    },
    {
      name: 'disable',
      loseAuthority: (store) => store.database.exec('UPDATE event_settings SET enabled = 0, switch_generation = 8'),
    },
    {
      name: 'rule revocation',
      loseAuthority: (store) =>
        store.database.exec("UPDATE rule_versions SET state = 'revoked' WHERE id = 'rule-sse@1'"),
    },
    {
      name: 'expiry',
      loseAuthority: (store) => store.database.exec("UPDATE stream_log SET expires_at = 100 WHERE id = 'stream-race'"),
    },
  ];
  for (const scenario of cases) {
    const setup = await fixture();
    try {
      setup.store.database.exec(`INSERT INTO stream_log
        (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
         event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
         expires_at, switch_generation)
        VALUES ('stream-race', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
                'event-sse', '${ACCOUNT}', NULL, NULL, X'01', 100, 500, 7)`);
      const frames: string[] = [];
      const replay = new StreamReplay({
        store: setup.store,
        cipher: {
          async decrypt() {
            scenario.loseAuthority(setup.store);
            return Buffer.from('{"id":"event-sse"}');
          },
        },
        approvals: { get: async () => null },
        config: { load: async () => ({ inboxes: { inbox: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
        fence: async () => undefined,
        now: () => 100,
      });
      assert.equal(
        await replay.replay({
          subscriberId: subscriber.subscriberId,
          subscriberVersion: subscriber.version,
          afterId: null,
          writeFrame: (frame) => frames.push(frame),
        }),
        0,
        scenario.name,
      );
      assert.deepEqual(frames, [], scenario.name);
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }
});

test('B2-T8: an account removal observed after replay decrypt purges retained bytes before a frame can leave', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database.exec(`INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
       event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
       expires_at, switch_generation)
      VALUES ('stream-account-race', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
              'event-sse', '${ACCOUNT}', NULL, NULL, X'01', 100, 500, 7)`);
    let accountPresent = true;
    const replay = new StreamReplay({
      store: setup.store,
      cipher: {
        async decrypt() {
          accountPresent = false;
          return Buffer.from('{"id":"event-sse"}');
        },
      },
      approvals: { get: async () => null },
      config: {
        load: async () => ({
          inboxes: accountPresent ? { inbox: { id: ACCOUNT, provider: 'gmail' } } : {},
        }),
      } as never,
      fence: async () => undefined,
      now: () => 100,
    });
    const frames: string[] = [];
    assert.equal(
      await replay.replay({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        afterId: null,
        writeFrame: (frame) => frames.push(frame),
      }),
      0,
    );
    assert.deepEqual(frames, []);
    assert.equal(
      (
        setup.store.database
          .prepare("SELECT count(*) AS count FROM stream_log WHERE id = 'stream-account-race'")
          .get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T8: account removal purges its retained stream bytes in the same cleanup transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database.exec(`INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
       event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
       expires_at, switch_generation)
      VALUES ('stream-account-removed', 'delivery-sse', 'rule-sse', 1, 'target-sse', 1, 'subscriber-sse', 1,
              'event-sse', '${ACCOUNT}', NULL, NULL, X'01', 100, 500, 7)`);
    setup.store.immediate(() => purgeRemovedAccountWork(setup.store.database, ACCOUNT, 101));
    assert.equal(
      (setup.store.database.prepare('SELECT count(*) AS count FROM stream_log').get() as { count: number }).count,
      0,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
