import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { keepSenderDomain } from '../src/runtime/sender-domains.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/*
 * Security review of 0.33.0, finding 9: a judged decision's sending domain, which Analyse counts, lived inside the
 * decision's metadata for its 90 days, far past the 7 days the rule keeps content. It is now kept apart and sealed,
 * until its projection's deadline, and goes sooner with its decision's metadata or its decision.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const SEALED = Buffer.from('sealed-domain-bytes');

let sequence = 0;

function decision(store: EventDatabase, metadataExpiresAt = NOW + 90 * DAY): string {
  sequence += 1;
  const eventId = sequence.toString(16).padStart(32, '0');
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, 'ibx_SENDERDOMAINS0001', ?, ?, ?, ?)`,
    )
    .run(eventId, store.installationId, canonicalJson([String(sequence), `m-${sequence}`, 'received']), NOW, NOW, NOW);
  const id = `decision-domain-${sequence}`;
  store.database
    .prepare(
      `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record)
       VALUES (?, ?, 'ibx_SENDERDOMAINS0001', 'invoices', 1, 'no-match', ?, 'retained', X'01')`,
    )
    .run(id, eventId, metadataExpiresAt);
  return id;
}

const domains = (store: EventDatabase) =>
  (
    store.database.prepare('SELECT decision_id FROM decision_sender_domains ORDER BY decision_id').all() as {
      decision_id: string;
    }[]
  ).map((row) => row.decision_id);

test('SENDER-DOMAINS: a domain is kept until its projection’s deadline, not the 90 days of the decision’s metadata', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-sender-domains-');
  const store = await openEventDatabase({ stateDir });
  try {
    const kept = decision(store);
    keepSenderDomain(store.database, {
      decisionId: kept,
      ruleId: 'invoices',
      ruleVersion: 1,
      expiresAt: NOW + 7 * DAY,
      sealed: SEALED,
    });
    assert.deepEqual(domains(store), [kept]);
    new EventExpiry(store, () => NOW + 7 * DAY - 1).sweep();
    assert.deepEqual(domains(store), [kept], 'kept until its deadline');
    new EventExpiry(store, () => NOW + 7 * DAY).sweep();
    assert.deepEqual(domains(store), [], 'gone at the projection’s deadline');
    const metadata = store.database
      .prepare('SELECT metadata_state, encrypted_record FROM decisions WHERE id = ?')
      .get(kept) as { metadata_state: string; encrypted_record: Uint8Array | null };
    assert.equal(metadata.metadata_state, 'retained', 'while the decision’s content-free metadata stays its 90 days');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SENDER-DOMAINS: a domain goes at once with its decision’s metadata, or its decision, and a missing decision keeps none', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-sender-domains-purge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const cleared = decision(store);
    const deleted = decision(store);
    for (const decisionId of [cleared, deleted, 'decision-never-written'])
      keepSenderDomain(store.database, {
        decisionId,
        ruleId: 'invoices',
        ruleVersion: 1,
        expiresAt: NOW + 7 * DAY,
        sealed: SEALED,
      });
    assert.deepEqual(domains(store), [cleared, deleted].sort(), 'a decision that was not written keeps no domain');
    // Every path that clears a decision's record — expiry, account removal, a replacement — takes its domain with it.
    store.database.prepare('UPDATE decisions SET encrypted_record = NULL WHERE id = ?').run(cleared);
    assert.deepEqual(domains(store), [deleted]);
    store.database.prepare('DELETE FROM decisions WHERE id = ?').run(deleted);
    assert.deepEqual(domains(store), []);
    // A decision whose record is already cleared keeps none either.
    const empty = decision(store);
    store.database.prepare('UPDATE decisions SET encrypted_record = NULL WHERE id = ?').run(empty);
    keepSenderDomain(store.database, {
      decisionId: empty,
      ruleId: 'invoices',
      ruleVersion: 1,
      expiresAt: NOW + 7 * DAY,
      sealed: SEALED,
    });
    assert.deepEqual(domains(store), []);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SENDER-DOMAINS: a retention tightening shortens a kept domain with its projection, and a looser one never extends it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-sender-domains-tighten-');
  const store = await openEventDatabase({ stateDir });
  try {
    const kept = decision(store);
    keepSenderDomain(store.database, {
      decisionId: kept,
      ruleId: 'invoices',
      ruleVersion: 1,
      expiresAt: NOW + 7 * DAY,
      sealed: SEALED,
    });
    const retention = {
      ingestMs: 2 * DAY,
      holdMs: 2 * DAY,
      deliveryMs: 7 * DAY,
      dryrunMs: DAY,
      sseReplayMs: 7 * DAY,
      deadLetterMs: 7 * DAY,
      decisionMetadataMs: 90 * DAY,
    };
    const expires = () =>
      (
        store.database.prepare('SELECT expires_at FROM decision_sender_domains WHERE decision_id = ?').get(kept) as {
          expires_at: number;
        }
      ).expires_at;
    shortenRuleRetentionDeadlines({
      database: store.database,
      ruleId: 'invoices',
      child: { retention } as CanonicalFullRuleDocument,
      now: NOW,
    });
    assert.equal(expires(), NOW + 2 * DAY, 'the staged time plus the shortened ingest retention');
    shortenRuleRetentionDeadlines({
      database: store.database,
      ruleId: 'invoices',
      child: { retention: { ...retention, ingestMs: 10 * DAY, holdMs: 10 * DAY } } as CanonicalFullRuleDocument,
      now: NOW,
    });
    assert.equal(expires(), NOW + 2 * DAY, 'never extended');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
