import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { isQueueItemId } from '../src/domain/queue-target.ts';
import { DeliveryDispatcher, type DispatchResult } from '../src/runtime/dispatcher.ts';
import { QueueDispatcher } from '../src/runtime/queue-dispatcher.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { RecordStorageError } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_QUEUEDISPATCH00';
const DAY = 86_400_000;
let clock = 10 * DAY;

function queueRule(input: { readonly queueMs: number; readonly targetRetentionMs: number; readonly cap?: number }) {
  return {
    ruleId: 'rule-queue-dispatch',
    version: 1,
    source: {
      channel: 'gmail',
      accountIds: [ACCOUNT],
      options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
    },
    event: { type: 'gmail.message.received', version: 1 },
    condition: { path: '/subject', op: 'exists' },
    mapping: { from: { $path: '/from' }, subject: { $path: '/subject' } },
    targets: [
      { targetId: 'queue-dispatch', version: 1, kind: 'queue', retentionMs: input.targetRetentionMs, show: 'summary' },
    ],
    subscribers: [],
    judges: [],
    deliveryRateCap: input.cap ?? 1,
    retention: {
      ingestMs: 7 * DAY,
      holdMs: 7 * DAY,
      deliveryMs: 7 * DAY,
      dryrunMs: DAY,
      sseReplayMs: 7 * DAY,
      deadLetterMs: 7 * DAY,
      decisionMetadataMs: 90 * DAY,
      queueMs: input.queueMs,
    },
  };
}

const SENDER = 'queue-dispatch-sender@example.test';
const SUBJECT = 'queue-dispatch subject: please call';

const record = Buffer.from(
  JSON.stringify({
    kind: 'queue-item',
    item: { from: { name: 'Dispatch Sender', address: SENDER }, subject: SUBJECT },
    released: false,
  }),
);

/** A cipher that marks what it seals with the exact AAD location, so the test can see which row it was sealed for. */
const cipher = {
  sealed: [] as Array<{ table: string; column: string; key: string }>,
  async encrypt(location: { table: string; column: string; key: readonly { value: unknown }[] }, bytes: Uint8Array) {
    const key = String(location.key[0]?.value);
    cipher.sealed.push({ table: location.table, column: location.column, key });
    return Buffer.concat([Buffer.from(`sealed:${location.table}:${key}:`), Buffer.from(bytes)]);
  },
  async decrypt(_location: unknown, bytes: Uint8Array) {
    return Buffer.from(bytes);
  },
};

async function fixture(rule: ReturnType<typeof queueRule>) {
  clock = 10 * DAY;
  cipher.sealed.length = 0;
  const stateDir = await shortTempDir('events-queue-dispatch-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const canonical = canonicalJson(rule);
  store.database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'approval', 'activation', 1)`,
    )
    .run(`${rule.ruleId}@1`, rule.ruleId, 1, canonical, sha256Hex(canonical));
  const target = canonicalJson(rule.targets[0]);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('queue-dispatch@1', 'queue-dispatch', 1, target, sha256Hex(target));
  const insert = (id: string, occurredAt = clock - 5_000, bytes: Buffer = record) => {
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
      )
      .run(`event-${id}`, store.installationId, ACCOUNT, id, occurredAt, occurredAt, occurredAt);
    store.database
      .prepare(
        `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'matched', ?, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT, rule.ruleId, clock + 90 * DAY);
    store.database
      .prepare(
        `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
                                target_kind, encrypted_record, expires_at, state, switch_generation)
         VALUES (?, ?, ?, ?, 1, 'queue:queue-dispatch:1', 'queue-dispatch', 1, 'queue', ?, ?, 'queued', 7)`,
      )
      .run(id, `decision-${id}`, ACCOUNT, rule.ruleId, bytes, clock + 7 * DAY);
  };
  const dispatcher = (options: Record<string, unknown> = {}) =>
    new QueueDispatcher({
      store,
      cipher,
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: { 'events/gmail': { id: ACCOUNT, provider: 'gmail' } }, accounts: {} }) },
      now: () => clock,
      fence: async () => ({ switchGeneration: 7 }),
      ...options,
    } as unknown as ConstructorParameters<typeof QueueDispatcher>[0]);
  return { stateDir, store, insert, dispatcher };
}

function count(store: Awaited<ReturnType<typeof openEventDatabase>>, table: string): number {
  return (store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

test('QUEUE-A: a match to a queue target appends one encrypted item, charges the cap once and finishes the delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture(queueRule({ queueMs: 7 * DAY, targetRetentionMs: 7 * DAY }));
  try {
    setup.insert('one');
    setup.insert('two');
    assert.deepEqual(await setup.dispatcher().dispatch('one'), { state: 'delivered', deliveryId: 'one' });
    assert.equal(count(setup.store, 'queue_items'), 1);
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1);
    const delivery = setup.store.database
      .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'one'")
      .get() as { state: string; encrypted_record: Uint8Array | null };
    assert.equal(delivery.state, 'delivered');
    assert.equal(delivery.encrypted_record, null, 'the delivered payload is purged in the same transaction');
    const item = setup.store.database.prepare('SELECT * FROM queue_items').get() as Record<string, unknown>;
    assert.ok(isQueueItemId(item.id), String(item.id));
    assert.equal(item.delivery_id, 'one');
    assert.equal(item.decision_id, 'decision-one');
    assert.equal(item.state, 'open');
    assert.equal(item.channel, 'gmail');
    assert.equal(item.account_id, ACCOUNT);
    assert.equal(item.arrived_at, clock - 5_000, 'arrival is the message time, not the append time');
    assert.equal(item.appended_at, clock);
    assert.equal(item.released, 0);
    const stored = Buffer.from(item.encrypted_record as Uint8Array).toString('utf8');
    assert.ok(stored.startsWith(`sealed:queue_items:${item.id}:`), 'the item is sealed for its own row');
    assert.deepEqual(JSON.parse(stored.slice(`sealed:queue_items:${item.id}:`.length)), {
      from: { name: 'Dispatch Sender', address: SENDER },
      subject: SUBJECT,
    });

    // The cap counts deliveries: a full cap neither charges nor appends.
    assert.deepEqual(await setup.dispatcher().dispatch('two'), { state: 'waiting-cap', deliveryId: 'two' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1);
    assert.equal(count(setup.store, 'queue_items'), 1);
    // Delivered work is terminal: dispatching it again appends nothing more.
    assert.equal((await setup.dispatcher().dispatch('one')).state, 'terminal');
    assert.equal(count(setup.store, 'queue_items'), 1);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('QUEUE-A: an interruption before the append commits leaves no item, and recovery charges nothing twice', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture(queueRule({ queueMs: 7 * DAY, targetRetentionMs: 7 * DAY }));
  try {
    setup.insert('crash');
    await assert.rejects(
      setup
        .dispatcher({
          beforeCommit: () => {
            throw new Error('simulated interruption');
          },
        })
        .dispatch('crash'),
      /simulated interruption/,
    );
    assert.equal(count(setup.store, 'queue_items'), 0, 'nothing was appended');
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1, 'the claim keeps its one charge');
    clock += 60_000;
    assert.deepEqual(await setup.dispatcher().dispatch('crash'), { state: 'delivered', deliveryId: 'crash' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1, 'the retry reuses the charge');
    assert.equal(count(setup.store, 'queue_items'), 1);

    // A process that stopped mid-append leaves its lease; recovery claims it once and appends nothing twice.
    setup.insert('stranded');
    setup.store.database
      .prepare(
        `UPDATE deliveries SET state = 'disclosing', attempts = 1, attempt_id = 'a', lease_token = 't', lease_until = ?
         WHERE id = 'stranded'`,
      )
      .run(clock - 1);
    setup.store.database
      .prepare(
        "INSERT INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at) VALUES ('stranded', ?, 1, ?)",
      )
      .run('rule-queue-dispatch', clock - 3_600_001);
    const results: readonly DispatchResult[] = await setup.dispatcher().recoverLeases();
    assert.deepEqual(results, [{ state: 'delivered', deliveryId: 'stranded' }]);
    assert.equal(count(setup.store, 'delivery_cap_charges'), 2, 'the stranded delivery keeps its one earlier charge');
    assert.equal(count(setup.store, 'queue_items'), 2);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("QUEUE-A: an item's deadline is the lesser of the rule's queueMs and the target's retentionMs (Q2)", {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [queueMs, targetRetentionMs, expected] of [
    [3 * DAY, 7 * DAY, 3 * DAY],
    [10 * DAY, 2 * DAY, 2 * DAY],
    [5 * DAY, 5 * DAY, 5 * DAY],
  ] as const) {
    const setup = await fixture(queueRule({ queueMs, targetRetentionMs }));
    try {
      setup.insert('deadline');
      assert.equal((await setup.dispatcher().dispatch('deadline')).state, 'delivered');
      const item = setup.store.database
        .prepare('SELECT appended_at, retention_ms, expires_at, row_expires_at FROM queue_items')
        .get() as { appended_at: number; retention_ms: number; expires_at: number; row_expires_at: number };
      assert.equal(item.retention_ms, expected);
      assert.equal(item.expires_at, item.appended_at + expected, `${queueMs}/${targetRetentionMs}`);
      assert.equal(item.row_expires_at, item.expires_at + expected, 'the content-free row stays one retention more');
    } finally {
      setup.store.close();
      await rm(setup.stateDir, { recursive: true, force: true });
    }
  }
});

test('QUEUE-A: the routing facade sends a queue delivery to the queue handler, and refuses one with no handler', async () => {
  const calls: string[] = [];
  const handler = (kind: string) => ({
    async dispatch(deliveryId: string): Promise<DispatchResult> {
      calls.push(`${kind}:${deliveryId}`);
      return { state: 'terminal', deliveryId };
    },
  });
  const store = {
    database: { prepare: () => ({ get: () => ({ target_key: 'queue:queue-dispatch:1' }) }) },
  } as never;
  const routed = new DeliveryDispatcher({
    store,
    dryrun: handler('dryrun'),
    webhook: handler('webhook'),
    sse: handler('sse'),
    queue: handler('queue'),
  });
  await routed.dispatch('queued');
  assert.deepEqual(calls, ['queue:queued']);
  const unrouted = new DeliveryDispatcher({
    store,
    dryrun: handler('dryrun'),
    webhook: handler('webhook'),
    sse: handler('sse'),
  });
  await assert.rejects(unrouted.dispatch('queued'), /queue/);
  assert.deepEqual(calls, ['queue:queued'], 'no other adapter can claim a queue delivery');
});

test('QUEUE-A: an unreadable queue delivery ends content-unreadable without a barrier, and the next match still lands', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture(queueRule({ queueMs: 7 * DAY, targetRetentionMs: 7 * DAY, cap: 10 }));
  try {
    setup.insert('corrupt', clock - 9_000, Buffer.from('{"kind":"queue-item","item":"not an item"}'));
    setup.insert('unauthenticated', clock - 8_000);
    setup.insert('next', clock - 7_000);
    const failing = {
      ...cipher,
      async decrypt(location: { key: readonly { value: unknown }[] }, bytes: Uint8Array) {
        if (location.key[0]?.value === 'unauthenticated')
          throw new RecordStorageError('RECORD_UNREADABLE_RESET_REQUIRED', 'synthetic authentication failure');
        return Buffer.from(bytes);
      },
    };
    for (const id of ['corrupt', 'unauthenticated']) {
      assert.deepEqual(await setup.dispatcher({ cipher: failing }).dispatch(id), {
        state: 'unreadable',
        deliveryId: id,
      });
      assert.deepEqual(
        {
          ...(setup.store.database.prepare('SELECT state, encrypted_record FROM deliveries WHERE id = ?').get(id) as
            | Record<string, unknown>
            | undefined),
        },
        { state: 'content-unreadable', encrypted_record: null },
        `${id}: terminal, its record purged`,
      );
    }
    assert.equal(count(setup.store, 'reset_barriers'), 0, 'no barrier closes the queue');
    assert.deepEqual(await setup.dispatcher({ cipher: failing }).dispatch('next'), {
      state: 'delivered',
      deliveryId: 'next',
    });
    const items = setup.store.database.prepare('SELECT delivery_id, state FROM queue_items').all() as Array<{
      delivery_id: string;
      state: string;
    }>;
    assert.deepEqual(
      items.map((row) => ({ ...row })),
      [{ delivery_id: 'next', state: 'open' }],
      'the next match is an open item',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

// 0.32.0 (owner feedback §3.5): a delivered row has no next try, so the app has no 1970 date to show for it.
test('0.32 B1: a delivered queue row clears next_at, so it has no next try to show', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture(queueRule({ queueMs: 7 * DAY, targetRetentionMs: 7 * DAY }));
  try {
    setup.insert('one');
    setup.store.database.exec("UPDATE deliveries SET next_at = 0 WHERE id = 'one'");
    assert.deepEqual(await setup.dispatcher().dispatch('one'), { state: 'delivered', deliveryId: 'one' });
    const row = setup.store.database.prepare("SELECT state, next_at FROM deliveries WHERE id = 'one'").get() as {
      state: string;
      next_at: number | null;
    };
    assert.deepEqual({ ...row }, { state: 'delivered', next_at: null });
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
