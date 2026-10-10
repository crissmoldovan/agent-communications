import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

function seedSubscriberBoundWork(
  store: EventDatabase,
  input: { readonly ruleId: string; readonly subscriberId: string; readonly accountId: string },
): void {
  const subscriber = canonicalJson({
    subscriberId: input.subscriberId,
    version: 1,
    kind: 'sse',
    authority: { host: '127.0.0.1', port: input.subscriberId === 'subscriber-remove' ? 43101 : 43102 },
    origins: ['https://console.invalid'],
    retentionMs: 60_000,
  });
  const target = {
    targetId: `target-${input.ruleId}`,
    version: 1,
    kind: 'sse',
    subscriberId: input.subscriberId,
    subscriberVersion: 1,
    representation: 'plain',
  };
  const rule = canonicalJson({
    ruleId: input.ruleId,
    version: 1,
    source: { channel: 'slack', accountIds: [input.accountId], options: { channel: 'slack', channels: ['C1'] } },
    targets: [target],
    subscribers: [JSON.parse(subscriber)],
    judges: [],
  });
  store.immediate(() => {
    store.database
      .prepare('INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run(`${input.subscriberId}@1`, input.subscriberId, subscriber, sha256Hex(subscriber));
    const targetDocument = canonicalJson(target);
    store.database
      .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run(`${target.targetId}@1`, target.targetId, targetDocument, sha256Hex(targetDocument));
    store.database
      .prepare(
        `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES (?, ?, 1, ?, ?, 'superseded', ?, ?, 1)`,
      )
      .run(
        `${input.ruleId}@1`,
        input.ruleId,
        rule,
        sha256Hex(rule),
        `approval-${input.ruleId}`,
        `activation-${input.ruleId}`,
      );
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'slack.message.posted', 1, ?, ?, 1, 1, 1)`,
      )
      .run(
        `event-${input.ruleId}`,
        store.installationId,
        input.accountId,
        `same-external-message-id:${input.accountId}`,
      );
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'deliver', 9999999999999, 'retained')`,
      )
      .run(`decision-${input.ruleId}`, `event-${input.ruleId}`, input.accountId, input.ruleId);
    store.database
      .prepare(
        `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, subscriber_id,
          subscriber_version, encrypted_record, expires_at, state, switch_generation)
         VALUES (?, ?, ?, ?, 1, ?, ?, 1, ?, 1, X'01', 9999999999999, 'retryable', 0)`,
      )
      .run(
        `delivery-${input.ruleId}`,
        `decision-${input.ruleId}`,
        input.accountId,
        input.ruleId,
        `sse:${target.targetId}:1`,
        target.targetId,
        input.subscriberId,
      );
    store.database
      .prepare(
        `INSERT INTO stream_log
         (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version, event_id,
          account_id, encrypted_record, delivered_at, expires_at, switch_generation)
         VALUES (?, ?, ?, 1, ?, 1, ?, 1, ?, ?, X'02', 1, 2, 0)`,
      )
      .run(
        `stream-${input.ruleId}`,
        `delivery-${input.ruleId}`,
        input.ruleId,
        target.targetId,
        input.subscriberId,
        `event-${input.ruleId}`,
        input.accountId,
      );
  });
}

test('B3 subscriber removal is scoped to its exact immutable bindings and preserves unrelated superseded work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-scope-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      seedSubscriberBoundWork(store, { ruleId: 'rule-remove', subscriberId: 'subscriber-remove', accountId: 'acc-A' });
      seedSubscriberBoundWork(store, { ruleId: 'rule-keep', subscriberId: 'subscriber-keep', accountId: 'acc-B' });
      const control = new B3OperatorControl({
        store,
        ports: { quiescer: new WriterQuiescer(), closeSubscriberStreams: () => undefined } as never,
      });
      assert.deepEqual(
        await control.handle({ operation: 'removeSubscriber', args: { subscriberId: 'subscriber-remove' } }),
        {
          subscriberId: 'subscriber-remove',
          removed: true,
        },
      );
      const removed = store.database
        .prepare('SELECT state, encrypted_record FROM deliveries WHERE id = ?')
        .get('delivery-rule-remove') as { state: string; encrypted_record: Uint8Array | null };
      assert.equal(removed.state, 'cancelled');
      assert.equal(removed.encrypted_record, null);
      const removedStream = store.database
        .prepare('SELECT count(*) AS count FROM stream_log WHERE delivery_id = ?')
        .get('delivery-rule-remove') as {
        count: number;
      };
      assert.equal(removedStream.count, 0);
      const preserved = store.database
        .prepare('SELECT state, encrypted_record FROM deliveries WHERE id = ?')
        .get('delivery-rule-keep') as { state: string; encrypted_record: Uint8Array | null };
      assert.equal(preserved.state, 'retryable');
      assert.deepEqual(
        preserved.encrypted_record,
        new Uint8Array([1]),
        'the colliding external message identity in another account/source remains retained under its valid superseded rule',
      );
      const removedSubscriber = store.database
        .prepare('SELECT revoked_at FROM subscriber_versions WHERE subscriber_id = ? AND version = 1')
        .get('subscriber-remove') as { revoked_at: number | null };
      assert.notEqual(removedSubscriber.revoked_at, null);
      const preservedSubscriber = store.database
        .prepare('SELECT revoked_at FROM subscriber_versions WHERE subscriber_id = ? AND version = 1')
        .get('subscriber-keep') as { revoked_at: number | null };
      assert.equal(preservedSubscriber.revoked_at, null);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
