import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { type ClaimedDelivery, completeDeliveryClaim } from '../src/runtime/delivery-claim.ts';
import { deadLetterDelivery, EventExpiry } from '../src/runtime/expiry.ts';
import { shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { settleWebhookOutcome } from '../src/runtime/webhook-dispatcher.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  createRetentionDeadlines,
  dryrunDeadline,
  MAX_DRYRUN_RETENTION_MS,
  MAX_SSE_REPLAY_RETENTION_MS,
  shortenDeadline,
  sseReplayDeadline,
  stageDeadline,
} from '../src/store/retention.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('RET-B1: event-content deadlines are fixed from their specified clock start and dry-run never exceeds 24 hours', () => {
  const created = createRetentionDeadlines({
    stagedAt: 1_000,
    ingestRetentionMs: 10_000,
    deliveryCreatedAt: 9_000,
    deliveryRetentionMs: 2_000,
    dryrunAppendedAt: 11_000,
    dryrunRetentionMs: 3_000,
  });
  assert.equal(created.stageExpiresAt, 11_000);
  assert.equal(created.decisionDeadline, 11_000, 'projection deadline starts at first durable staging');
  assert.equal(created.deliveryExpiresAt, 11_000, 'delivery starts its independently approved clock at creation');
  assert.equal(created.dryrunExpiresAt, 14_000);
  assert.equal(stageDeadline(1_000, [10_000, 4_000]), 5_000, 'shared staging takes the shortest owed retention');
  assert.equal(sseReplayDeadline(11_000, 3_000), 14_000);
  assert.equal(shortenDeadline(14_000, 12_000), 12_000);
  assert.equal(shortenDeadline(12_000, 14_000), 12_000, 'a deadline can never be extended by retry or read');
  assert.throws(() => dryrunDeadline(0, MAX_DRYRUN_RETENTION_MS + 1), /24 hours/);
  assert.throws(() => sseReplayDeadline(0, MAX_SSE_REPLAY_RETENTION_MS + 1), /seven days/);
});

test('B2-T4: dead-letter time is fixed once, survives restart, only tightens, and purges at that fixed deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-dead-letter-');
  const retention = {
    ingestMs: 1_000,
    holdMs: 1_000,
    deliveryMs: 1_000,
    dryrunMs: 1_000,
    sseReplayMs: 1_000,
    deadLetterMs: 900,
    decisionMetadataMs: 1_000,
  };
  const child = { retention: { ...retention, deadLetterMs: 50 } } as CanonicalFullRuleDocument;
  let store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-dead', 'install', 'example.event', 1, 'account-dead', 'dedupe', 1, 1, 1);
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-dead@1', 'rule-dead', 1, '${JSON.stringify({ retention })}', 'digest', 'active', 'approval', 'activation', 1);
       INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-dead', 'event-dead', 'account-dead', 'rule-dead', 1, 'matched', 9_999, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation)
       VALUES ('delivery-dead', 'decision-dead', 'account-dead', 'rule-dead', 1, 'webhook:target-dead:1',
               'target-dead', 1, X'01', 1_100, 'retryable', 1);`,
    );
    deadLetterDelivery(store, { deliveryId: 'delivery-dead', deadLetterRetentionMs: 900, now: 200 });
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = ?')
          .get('delivery-dead') as { dead_lettered_at: number; dead_letter_expires_at: number }),
      },
      { dead_lettered_at: 200, dead_letter_expires_at: 1_100 },
    );
    store.close();
    store = await openEventDatabase({ stateDir });
    shortenRuleRetentionDeadlines({ database: store.database, ruleId: 'rule-dead', child, now: 220 });
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = ?')
          .get('delivery-dead') as { state: string; dead_lettered_at: number; dead_letter_expires_at: number }),
      },
      { state: 'dead-lettered', dead_lettered_at: 200, dead_letter_expires_at: 250 },
    );
    shortenRuleRetentionDeadlines({
      database: store.database,
      ruleId: 'rule-dead',
      child: { retention: { ...retention, deadLetterMs: 9_000 } } as CanonicalFullRuleDocument,
      now: 230,
    });
    assert.equal(
      (
        store.database.prepare('SELECT dead_letter_expires_at FROM deliveries WHERE id = ?').get('delivery-dead') as {
          dead_letter_expires_at: number;
        }
      ).dead_letter_expires_at,
      250,
      'a later retry or looser document cannot extend the dead-letter deadline',
    );
    new EventExpiry(store, () => 250).sweep();
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            'SELECT state, encrypted_record, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = ?',
          )
          .get('delivery-dead') as {
          state: string;
          encrypted_record: Uint8Array | null;
          dead_lettered_at: number;
          dead_letter_expires_at: number;
        }),
      },
      { state: 'retention-expired', encrypted_record: null, dead_lettered_at: 200, dead_letter_expires_at: 250 },
    );
    deadLetterDelivery(store, { deliveryId: 'delivery-dead', deadLetterRetentionMs: 900, now: 500 });
    assert.equal(
      (
        store.database.prepare('SELECT dead_letter_expires_at FROM deliveries WHERE id = ?').get('delivery-dead') as {
          dead_letter_expires_at: number;
        }
      ).dead_letter_expires_at,
      250,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T5: expiry wins over a stale claimed delivery and leaves it unable to settle', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-claim-expiry-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-expired-claim', 'installation', 'example.event', 1, 'account-expired', 'dedupe-expired', 1, 1, 1);
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-expired@1', 'rule-expired', 1, '{"deliveryRateCap":1}', 'digest', 'active', 'approval', 'activation', 1);
       INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES ('target-expired@1', 'target-expired', 1, '{}', 'digest');
       INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-expired', 'event-expired-claim', 'account-expired', 'rule-expired', 1, 'matched', 999, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation, attempt_id, lease_token, lease_until)
       VALUES ('delivery-expired', 'decision-expired', 'account-expired', 'rule-expired', 1,
          'webhook:target-expired:1', 'target-expired', 1, X'01', 100, 'disclosing', 1,
          'attempt-expired', 'fake-lease-expired', 200);`,
    );
    new EventExpiry(store, () => 100).sweep();
    const stale: ClaimedDelivery = {
      id: 'delivery-expired',
      decisionId: 'decision-expired',
      accountId: 'account-expired',
      ruleId: 'rule-expired',
      ruleVersion: 1,
      targetId: 'target-expired',
      targetVersion: 1,
      encryptedRecord: Buffer.from([1]),
      expiresAt: 100,
      switchGeneration: 1,
      orderingSequence: 0,
      attemptId: 'attempt-expired',
      leaseToken: 'fake-lease-expired',
      leaseUntil: 200,
    };
    assert.equal(completeDeliveryClaim(store, stale, { state: 'delivered', clearRecord: true }), false);
    assert.equal(
      settleWebhookOutcome({
        store,
        claim: stale,
        outcome: { kind: 'response', status: 204, success: true },
        now: 100,
      }),
      false,
      'an HTTP outcome after expiry cannot recreate the purged record or settle the stale lease',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT state, encrypted_record, next_at FROM deliveries WHERE id = 'delivery-expired'")
          .get() as Record<string, unknown>),
      },
      { state: 'retention-expired', encrypted_record: null, next_at: null },
    );
    assert.deepEqual(
      (
        store.database.prepare("SELECT code FROM work_attempts WHERE work_id = 'delivery-expired'").all() as Array<{
          code: string;
        }>
      ).map((row) => ({ ...row })),
      [{ code: 'external-outcome-unrecalled-discarded' }],
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
