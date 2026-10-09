import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { commitDecisionOutbox } from '../src/runtime/decisions.ts';
import type { PreparedDelivery } from '../src/runtime/deliveries.ts';
import {
  activeRuleTargetReferences,
  retainedDeliveryTargetReferences,
} from '../src/runtime/target-version-references.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

async function fixture() {
  const stateDir = await shortTempDir('events-b2-outbox-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
  store.database
    .prepare(
      `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-b2', ?, 'com.agentcomms.gmail.message.received.v1', 1, 'account-b2', 'dedupe-b2', 1, 1, 1)`,
    )
    .run(store.installationId);
  store.database
    .prepare(
      `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
       VALUES ('event-b2', 'rule-b2', 1, 99_999, X'01')`,
    )
    .run();
  store.database.exec(
    `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES ('rule-b2@1', 'rule-b2', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
     INSERT INTO target_versions (id, target_id, version, document, digest)
     VALUES
       ('target-dry@1', 'target-dry', 1, '{}', 'digest'),
       ('target-webhook@1', 'target-webhook', 1, '{}', 'digest'),
       ('target-sse@1', 'target-sse', 1, '{}', 'digest');`,
  );
  return { stateDir, store };
}

const prepared: readonly PreparedDelivery[] = [
  {
    id: 'delivery-dry',
    targetKey: 'dryrun:target-dry:1',
    target: { kind: 'dry-run', targetId: 'target-dry', targetVersion: 1, representation: 'plain' },
    representation: 'plain',
    cloudEventBytes: '{"id":"delivery-dry"}',
    encryptedRecord: Buffer.from('dry-run bytes'),
    expiresAt: 50_000,
  },
  {
    id: 'delivery-webhook',
    targetKey: 'webhook:target-webhook:1',
    target: { kind: 'webhook', targetId: 'target-webhook', targetVersion: 1, representation: 'enveloped' },
    representation: 'enveloped',
    cloudEventBytes: '{"id":"delivery-webhook"}',
    encryptedRecord: Buffer.from('webhook bytes'),
    expiresAt: 50_000,
  },
  {
    id: 'delivery-sse',
    targetKey: 'sse:target-sse:1:subscriber-b2:3',
    target: {
      kind: 'sse',
      targetId: 'target-sse',
      targetVersion: 1,
      subscriberId: 'subscriber-b2',
      subscriberVersion: 3,
      representation: 'enveloped',
    },
    representation: 'enveloped',
    cloudEventBytes: '{"id":"delivery-sse"}',
    encryptedRecord: Buffer.from('sse bytes'),
    expiresAt: 50_000,
  },
];

test('B2-T4: the decision transaction persists each prepared target representation, exact lineage, and retained reference', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    commitDecisionOutbox(setup.store, {
      id: 'decision-b2',
      eventId: 'event-b2',
      accountId: 'account-b2',
      ruleId: 'rule-b2',
      ruleVersion: 1,
      outcome: 'matched',
      metadataExpiresAt: 99_999,
      switchGeneration: 7,
      deliveries: prepared,
    });

    const rows = setup.store.database
      .prepare(
        `SELECT id, target_key, target_kind, target_representation, subscriber_id, subscriber_version,
                encrypted_record, attempt_id, lease_token, ordering_sequence
         FROM deliveries ORDER BY id`,
      )
      .all() as Array<Record<string, unknown>>;
    assert.deepEqual(
      rows.map((row) => ({
        id: row.id,
        key: row.target_key,
        kind: row.target_kind,
        representation: row.target_representation,
        subscriberId: row.subscriber_id,
        subscriberVersion: row.subscriber_version,
        record: Buffer.from(row.encrypted_record as Uint8Array).toString(),
        attemptId: row.attempt_id,
        leaseToken: row.lease_token,
        orderingSequence: row.ordering_sequence,
      })),
      [
        {
          id: 'delivery-dry',
          key: 'dryrun:target-dry:1',
          kind: 'dry-run',
          representation: 'plain',
          subscriberId: null,
          subscriberVersion: null,
          record: 'dry-run bytes',
          attemptId: null,
          leaseToken: null,
          orderingSequence: 0,
        },
        {
          id: 'delivery-sse',
          key: 'sse:target-sse:1:subscriber-b2:3',
          kind: 'sse',
          representation: 'enveloped',
          subscriberId: 'subscriber-b2',
          subscriberVersion: 3,
          record: 'sse bytes',
          attemptId: null,
          leaseToken: null,
          orderingSequence: 0,
        },
        {
          id: 'delivery-webhook',
          key: 'webhook:target-webhook:1',
          kind: 'webhook',
          representation: 'enveloped',
          subscriberId: null,
          subscriberVersion: null,
          record: 'webhook bytes',
          attemptId: null,
          leaseToken: null,
          orderingSequence: 0,
        },
      ],
    );
    assert.deepEqual(retainedDeliveryTargetReferences(setup.store.database, 'delivery-sse'), [
      { targetId: 'target-sse', targetVersion: 1, ruleId: 'rule-b2', ruleVersion: 1 },
    ]);
    assert.deepEqual(activeRuleTargetReferences(setup.store.database, 'rule-b2', 1), []);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
