import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { startSseServer } from '../src/runtime/sse-server.ts';
import {
  addActiveRuleTargetReferences,
  addRetainedDeliveryTargetReference,
} from '../src/runtime/target-version-references.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

function subscriberRemovalPorts(
  closeSubscriberStreams: (input: { readonly subscriberId: string; readonly subscriberVersion: number }) => void = () =>
    undefined,
): { readonly quiescer: WriterQuiescer } {
  return { quiescer: new WriterQuiescer(), closeSubscriberStreams } as never;
}

function seedRevocableSubscriberWork(store: EventDatabase, input: { readonly authorityPort?: number } = {}): void {
  const subscriber = canonicalJson({
    subscriberId: 'subscriber-purge',
    version: 1,
    kind: 'sse',
    authority: { host: '127.0.0.1', port: input.authorityPort ?? 43103 },
    origins: ['https://console.invalid'],
    retentionMs: 60_000,
  });
  const target = {
    targetId: 'target-purge',
    version: 1,
    kind: 'sse',
    subscriberId: 'subscriber-purge',
    subscriberVersion: 1,
    representation: 'plain',
  };
  const targetDocument = canonicalJson(target);
  const rule = canonicalJson({
    ruleId: 'rule-purge',
    version: 1,
    source: { channel: 'slack', accountIds: ['account-purge'], options: { channel: 'slack', channels: ['C2'] } },
    targets: [target],
    subscribers: [JSON.parse(subscriber)],
    judges: [],
  });
  store.immediate(() => {
    store.database
      .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('subscriber-purge@1', 'subscriber-purge', subscriber, sha256Hex(subscriber));
    store.database
      .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('target-purge@1', 'target-purge', targetDocument, sha256Hex(targetDocument));
    store.database
      .prepare(
        `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('rule-purge@1', 'rule-purge', 1, ?, ?, 'active', 'approval-purge', 'activation-purge', 1)`,
      )
      .run(rule, sha256Hex(rule));
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-purge',
      ruleVersion: 1,
      targets: [{ targetId: 'target-purge', targetVersion: 1 }],
      createdAt: 1,
    });
    for (const [id, state] of [
      ['retry-purge', 'retryable'],
      ['claimed-purge', 'disclosing'],
      ['dead-purge', 'dead-lettered'],
    ] as const) {
      store.database
        .prepare(
          `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
           VALUES (?, ?, 'slack.message.posted', 1, 'account-purge', ?, 1, 1, 1)`,
        )
        .run(`event-${id}`, store.installationId, `scope:account-purge:${id}`);
      store.database
        .prepare(
          `INSERT INTO decisions
           (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record)
           VALUES (?, ?, 'account-purge', 'rule-purge', 1, 'deliver', 9999999999999, 'retained', X'03')`,
        )
        .run(`decision-${id}`, `event-${id}`);
      store.database
        .prepare(
          `INSERT INTO deliveries
           (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, subscriber_id,
            subscriber_version, encrypted_record, expires_at, state, switch_generation, lease_until)
           VALUES (?, ?, 'account-purge', 'rule-purge', 1, 'sse:target-purge:1', 'target-purge', 1, 'subscriber-purge',
            1, X'04', 9999999999999, ?, 0, 777)`,
        )
        .run(id, `decision-${id}`, state);
      addRetainedDeliveryTargetReference(store.database, {
        deliveryId: id,
        targetId: 'target-purge',
        targetVersion: 1,
        ruleId: 'rule-purge',
        ruleVersion: 1,
        createdAt: 1,
      });
    }
    store.database
      .prepare(
        `INSERT INTO stream_log
         (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, event_id,
          account_id, encrypted_record, delivered_at, expires_at, switch_generation)
         VALUES ('stream-purge', 'dead-purge', 'rule-purge', 1, 'target-purge', 1, 'subscriber-purge', 1, 'event-dead-purge',
          'account-purge', X'05', 1, 2, 0)`,
      )
      .run();
  });
}

async function freeLoopbackPort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error === undefined ? resolve() : reject(error))),
  );
  if (address === null || typeof address === 'string') throw new Error('loopback port probe has no TCP address');
  return address.port;
}

function seedSubscriberIntent(
  store: EventDatabase,
  input: {
    readonly id: string;
    readonly status: 'pending' | 'pending-completion';
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly reference?: 'subscriber' | 'target';
  },
): void {
  const reference = input.reference ?? 'subscriber';
  const document = canonicalJson({
    documentVersion: 1,
    kind: 'rule',
    rule: {
      subscribers:
        reference === 'subscriber' ? [{ subscriberId: input.subscriberId, version: input.subscriberVersion }] : [],
      targets:
        reference === 'target'
          ? [
              {
                targetId: 'target-activation-intent',
                subscriberId: input.subscriberId,
                subscriberVersion: input.subscriberVersion,
              },
            ]
          : [],
    },
  });
  store.immediate(() => {
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES (?, 'rule', ?, ?, '{}', '[]', '[]', ?, 1, 1)`,
      )
      .run(input.id, document, sha256Hex(document), input.status);
    store.database
      .prepare(
        `INSERT INTO activation_baselines
         (intent_id, source, account_id, position_scope, encrypted_position, response_at)
         VALUES (?, 'slack', 'account-purge', 'conversation:C2', X'06', 1)`,
      )
      .run(input.id);
  });
}

test('B3 subscriber removal cancels and purges pending and claimed exact subscriber activation intents', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-subscriber-intents-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedRevocableSubscriberWork(store);
      seedSubscriberIntent(store, {
        id: 'intent-pending-removed-subscriber',
        status: 'pending',
        subscriberId: 'subscriber-purge',
        subscriberVersion: 1,
      });
      seedSubscriberIntent(store, {
        id: 'intent-claimed-removed-subscriber',
        status: 'pending-completion',
        subscriberId: 'subscriber-purge',
        subscriberVersion: 1,
        reference: 'target',
      });
      const control = new B3OperatorControl({ store, ports: subscriberRemovalPorts() });
      await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-purge' } });
      for (const intentId of ['intent-pending-removed-subscriber', 'intent-claimed-removed-subscriber']) {
        const intent = store.database
          .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
          .get(intentId) as { status: string; failure_code: string | null };
        assert.equal(intent.status, 'cancelled', intentId);
        assert.equal(intent.failure_code, 'AUTHORIZATION_REVOKED', intentId);
        const baselines = store.database
          .prepare('SELECT count(*) AS count FROM activation_baselines WHERE intent_id = ?')
          .get(intentId) as { count: number };
        assert.equal(baselines.count, 0, `${intentId} has no retained activation baseline after revocation`);
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 subscriber removal retains a pending activation with another exact live subscriber reference', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-subscriber-intent-live-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedRevocableSubscriberWork(store);
      const liveSubscriber = canonicalJson({
        subscriberId: 'subscriber-still-live',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 43104 },
        origins: ['https://console.invalid'],
        retentionMs: 60_000,
      });
      store.database
        .prepare(
          'INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)',
        )
        .run('subscriber-still-live@1', 'subscriber-still-live', liveSubscriber, sha256Hex(liveSubscriber));
      seedSubscriberIntent(store, {
        id: 'intent-still-live-subscriber',
        status: 'pending',
        subscriberId: 'subscriber-still-live',
        subscriberVersion: 1,
      });
      const control = new B3OperatorControl({ store, ports: subscriberRemovalPorts() });
      await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-purge' } });
      const intent = store.database
        .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
        .get('intent-still-live-subscriber') as { status: string; failure_code: string | null };
      assert.equal(intent.status, 'pending');
      assert.equal(intent.failure_code, null);
      const baselines = store.database
        .prepare('SELECT count(*) AS count FROM activation_baselines WHERE intent_id = ?')
        .get('intent-still-live-subscriber') as { count: number };
      assert.equal(baselines.count, 1, 'an unrelated exact live subscriber binding retains its pending activation');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 subscriber removal closes every exact live SSE stream through the owner registry port', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const stateDir = await shortTempDir('aev-b3-subscriber-stream-');
  let store: EventDatabase | undefined;
  let server: Awaited<ReturnType<typeof startSseServer>> | undefined;
  let client: ReturnType<typeof request> | undefined;
  try {
    try {
      const port = await freeLoopbackPort();
      store = await openEventDatabase({ stateDir });
      seedRevocableSubscriberWork(store, { authorityPort: port });
      const subscriber = store.database
        .prepare('SELECT document, digest FROM subscriber_versions WHERE subscriber_id = ? AND version = 1')
        .get('subscriber-purge') as { document: string; digest: string };
      store.database
        .prepare(
          `INSERT INTO event_secret_generations
           (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle,
            expires_at, created_at)
           VALUES ('subscriber', 'subscriber-purge', 1, 'sse-bearer', 1, ?, 'synthetic-bearer-digest', X'00', 'current', NULL, 1)`,
        )
        .run(subscriber.digest);
      server = await startSseServer({
        store,
        subscriberId: 'subscriber-purge',
        subscriberVersion: 1,
        cipher: {
          encrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
          decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes),
        },
        approvals: { get: async () => null },
        config: { load: async () => ({}) } as never,
        readBearerGenerations: async () => [{ generation: 1, lifecycle: 'current', material: 'synthetic-bearer' }],
        fence: async () => undefined,
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EPERM') {
        t.skip(
          'the development sandbox blocks loopback listeners; the coordinator runs this listener proof outside it',
        );
        return;
      }
      throw error;
    }
    const port = server.authority.port;
    let ended = false;
    client = request({
      host: '127.0.0.1',
      port,
      path: '/v1/streams/subscriber-purge',
      headers: { host: `127.0.0.1:${port}`, authorization: 'Bearer synthetic-bearer' },
    });
    const opened = new Promise<void>((resolve, reject) => {
      client?.once('response', (incoming) => {
        incoming.once('end', () => {
          ended = true;
        });
        // An unread body never emits 'end': read the stream so its server-side close is observable.
        incoming.resume();
        resolve();
      });
      client?.once('error', reject);
    });
    client.end();
    await opened;
    const control = new B3OperatorControl({
      store,
      ports: subscriberRemovalPorts(({ subscriberId, subscriberVersion }) =>
        server?.rotate({ subscriberId, subscriberVersion, generation: 0 }),
      ),
    });
    await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-purge' } });
    for (let waited = 0; !ended && waited < 2_000; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(ended, true, 'the real loopback SSE client is closed in the subscriber revocation transaction');
    const entries = store.database
      .prepare('SELECT count(*) AS count FROM stream_log WHERE subscriber_id = ? AND subscriber_version = 1')
      .get('subscriber-purge') as { count: number };
    assert.equal(entries.count, 0, 'the revoked subscriber version has no replay entries');
  } finally {
    client?.destroy();
    await server?.close();
    store?.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 subscriber removal invokes the owner stream registry for its exact revoked version', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-subscriber-stream-owner-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedRevocableSubscriberWork(store);
      const closed: Array<{ subscriberId: string; subscriberVersion: number }> = [];
      const control = new B3OperatorControl({
        store,
        ports: subscriberRemovalPorts((entry) => {
          closed.push(entry);
        }),
      });
      await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-purge' } });
      assert.deepEqual(closed, [{ subscriberId: 'subscriber-purge', subscriberVersion: 1 }]);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 subscriber removal cancels every orphaned retained or claimed row in one closure transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-purge-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedRevocableSubscriberWork(store);
      const control = new B3OperatorControl({ store, ports: subscriberRemovalPorts() });
      assert.deepEqual(
        await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-purge' } }),
        {
          subscriberId: 'subscriber-purge',
          removed: true,
        },
      );
      const retry = store.database
        .prepare('SELECT state, encrypted_record, next_at, lease_until FROM deliveries WHERE id = ?')
        .get('retry-purge') as {
        state: string;
        encrypted_record: Uint8Array | null;
        next_at: number | null;
        lease_until: number | null;
      };
      assert.equal(retry.state, 'cancelled');
      assert.equal(retry.encrypted_record, null);
      assert.equal(retry.next_at, null);
      assert.equal(retry.lease_until, null);
      const claimed = store.database
        .prepare('SELECT state, encrypted_record, next_at, lease_until FROM deliveries WHERE id = ?')
        .get('claimed-purge') as {
        state: string;
        encrypted_record: Uint8Array | null;
        next_at: number | null;
        lease_until: number | null;
      };
      assert.equal(claimed.state, 'in-flight-at-disable');
      assert.equal(claimed.encrypted_record, null);
      assert.equal(claimed.next_at, null);
      assert.equal(claimed.lease_until, null);
      const dead = store.database.prepare('SELECT encrypted_record FROM deliveries WHERE id = ?').get('dead-purge') as {
        encrypted_record: Uint8Array | null;
      };
      assert.equal(dead.encrypted_record, null);
      const streams = store.database
        .prepare('SELECT count(*) AS count FROM stream_log WHERE rule_id = ?')
        .get('rule-purge') as {
        count: number;
      };
      assert.equal(streams.count, 0);
      const references = store.database
        .prepare('SELECT count(*) AS count FROM target_version_references WHERE rule_id = ? AND rule_version = 1')
        .get('rule-purge') as { count: number };
      assert.equal(references.count, 0, 'revocation removes both active and retained exact-version target references');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
