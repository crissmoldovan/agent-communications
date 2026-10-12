import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { commitDecisionOutbox } from '../src/runtime/decisions.ts';
import {
  claimHeldDecision,
  expireHeldDecisions,
  holdDeadline,
  recoverExpiredHoldClaims,
  sqliteTransactionNow,
} from '../src/runtime/holds.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('E8: a hold uses the SQLite transaction clock and retention wins its deadline tie', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-hold-clock-');
  const store = await openEventDatabase({ stateDir });
  try {
    const captured = store.immediate(() => sqliteTransactionNow(store.database));
    assert.ok(captured > 0, 'the clock is read by SQLite inside the immediate transaction');
    assert.deepEqual(
      holdDeadline({ holdCreatedAt: 10_000, holdMs: 500, stagedAt: 9_500, ingestMs: 1_000 }),
      { holdExpiresAt: 10_500, holdBoundBy: 'ingest-retention' },
      'a tie retains the ingest-retention bound so expiry has one stable reason',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E8: the decision owner captures a hold clock in SQLite and retains its projection', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-hold-create-');
  const store = await openEventDatabase({ stateDir });
  try {
    const stagedAt = store.immediate(() => sqliteTransactionNow(store.database));
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 4 WHERE singleton = 1');
    store.database
      .prepare(
        "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-e8-hold', ?, 'gmail.message.received', 1, 'ibx_E8HOLD', 'e8-hold', ?, ?, ?)",
      )
      .run(store.installationId, stagedAt, stagedAt, stagedAt);
    store.database.exec(
      "INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at) VALUES ('rule-e8-hold:1', 'rule-e8-hold', 1, '{}', 'digest', 'active', 'approval-e8-hold', 'activation-e8-hold', 1);",
    );
    store.database
      .prepare(
        "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-e8-hold', 'rule-e8-hold', 1, ?, X'01')",
      )
      .run(stagedAt + 60_000);

    commitDecisionOutbox(store, {
      id: 'decision-e8-hold',
      eventId: 'event-e8-hold',
      accountId: 'ibx_E8HOLD',
      ruleId: 'rule-e8-hold',
      ruleVersion: 1,
      outcome: 'hold',
      hold: { holdMs: 60_000, ingestMs: 60_000 },
      metadataExpiresAt: stagedAt + 60_000,
      switchGeneration: 4,
      deliveries: [],
      retainProjection: true,
    });

    const hold = store.database
      .prepare('SELECT hold_created_at, hold_expires_at, hold_bound_by FROM decisions WHERE id = ?')
      .get('decision-e8-hold') as {
      hold_created_at: number | null;
      hold_expires_at: number | null;
      hold_bound_by: string | null;
    };
    assert.ok(hold.hold_created_at !== null, 'the creation time comes from the decision transaction');
    assert.equal(hold.hold_expires_at, stagedAt + 60_000, 'the ingestion deadline is the durable retaining bound');
    assert.equal(hold.hold_bound_by, 'ingest-retention');
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ?')
          .get('event-e8-hold') as {
          count: number;
        }
      ).count,
      1,
      'a nonterminal hold retains exactly its projection',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E8 P1: the final hold writer terminalises from its SQLite transaction time when ingest has already ended', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-hold-write-clock-');
  const store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 4 WHERE singleton = 1');
    store.database
      .prepare(
        "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-e8-hold-write-clock', ?, 'gmail.message.received', 1, 'ibx_E8HOLD', 'e8-hold-write-clock', 0, 0, 0)",
      )
      .run(store.installationId);
    store.database.exec(
      "INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at) VALUES ('rule-e8-hold-write-clock:1', 'rule-e8-hold-write-clock', 1, '{}', 'digest', 'active', 'approval-e8-hold', 'activation-e8-hold', 1);",
    );
    store.database
      .prepare(
        "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-e8-hold-write-clock', 'rule-e8-hold-write-clock', 1, ?, X'01')",
      )
      .run(dbNow + 60_000);

    commitDecisionOutbox(store, {
      id: 'decision-e8-hold-write-clock',
      eventId: 'event-e8-hold-write-clock',
      accountId: 'ibx_E8HOLD',
      ruleId: 'rule-e8-hold-write-clock',
      ruleVersion: 1,
      outcome: 'hold',
      hold: { holdMs: 60_000, ingestMs: 60_000 },
      metadataExpiresAt: dbNow + 60_000,
      switchGeneration: 4,
      deliveries: [],
      retainProjection: true,
      encryptedMetadata: Buffer.from('late-hold-metadata'),
    });

    const decision = store.database
      .prepare('SELECT outcome, hold_expires_at, encrypted_record FROM decisions WHERE id = ?')
      .get('decision-e8-hold-write-clock') as {
      outcome: string;
      hold_expires_at: number | null;
      encrypted_record: Uint8Array | null;
    };
    assert.equal(decision.outcome, 'retention-expired');
    assert.equal(decision.hold_expires_at, null);
    assert.equal(decision.encrypted_record, null, 'an expiry terminalisation keeps no late judge metadata');
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ?')
          .get('event-e8-hold-write-clock') as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

function seedHeldDecision(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  input: Readonly<{ id: string; deadline: number }>,
): void {
  const stagedAt = input.deadline - 60_000;
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 4 WHERE singleton = 1');
  store.database
    .prepare(
      "INSERT OR IGNORE INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, 'gmail.message.received', 1, 'ibx_E8HOLD', ?, ?, ?, ?)",
    )
    .run(`event:${input.id}`, store.installationId, input.id, stagedAt, stagedAt, stagedAt);
  store.database.exec(
    "INSERT OR IGNORE INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at) VALUES ('rule-e8-hold:1', 'rule-e8-hold', 1, '{}', 'digest', 'active', 'approval-e8-hold', 'activation-e8-hold', 1);",
  );
  store.database
    .prepare(
      "INSERT OR IGNORE INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES (?, 'rule-e8-hold', 1, ?, X'01')",
    )
    .run(`event:${input.id}`, input.deadline);
  store.database
    .prepare(
      "INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, hold_created_at, hold_expires_at, hold_bound_by, metadata_expires_at, metadata_state, encrypted_record) VALUES (?, ?, 'ibx_E8HOLD', 'rule-e8-hold', 1, 'hold', ?, ?, 'hold-window', ?, 'retained', X'01')",
    )
    .run(input.id, `event:${input.id}`, stagedAt, input.deadline, input.deadline + 60_000);
}

test('E8: a DB-time claim is decision-bound, expires for recovery, and cannot claim at the hold deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-hold-lease-');
  const store = await openEventDatabase({ stateDir });
  try {
    const now = store.immediate(() => sqliteTransactionNow(store.database));
    seedHeldDecision(store, { id: 'decision-e8-live', deadline: now + 60_000 });
    const first = claimHeldDecision({ store, decisionId: 'decision-e8-live', leaseMs: 10_000 });
    assert.equal(first.kind, 'claimed');
    if (first.kind !== 'claimed') throw new Error('the first resolver must own its claim');
    assert.equal(first.claim.claimToken.byteLength, 32);
    assert.deepEqual(
      claimHeldDecision({ store, decisionId: 'decision-e8-live', leaseMs: 10_000 }),
      { kind: 'busy' },
      'a second terminal/app resolver cannot share the durable claim',
    );
    store.database
      .prepare('UPDATE hold_resolution_claims SET claimed_at = 0, lease_expires_at = 1 WHERE decision_id = ?')
      .run('decision-e8-live');
    assert.equal(recoverExpiredHoldClaims(store), 1, 'a recovery removes a DB-expired claim');
    assert.equal(claimHeldDecision({ store, decisionId: 'decision-e8-live', leaseMs: 10_000 }).kind, 'claimed');

    seedHeldDecision(store, { id: 'decision-e8-expired', deadline: now - 1 });
    assert.equal(expireHeldDecisions(store), 1);
    assert.deepEqual(
      claimHeldDecision({ store, decisionId: 'decision-e8-expired', leaseMs: 10_000 }),
      { kind: 'expired' },
      'equality with a DB deadline is expiry, never a late claim',
    );
    const expired = store.database
      .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
      .get('decision-e8-expired') as { outcome: string; encrypted_record: Uint8Array | null };
    assert.equal(expired.outcome, 'hold-expired');
    assert.equal(expired.encrypted_record, null, 'expiry leaves a content-free terminal decision');
    assert.equal(
      (
        store.database
          .prepare('SELECT COUNT(*) AS count FROM ingest_rules WHERE event_id = ?')
          .get('event:decision-e8-expired') as {
          count: number;
        }
      ).count,
      0,
      'expiry purges the held projection in its terminal transaction',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
