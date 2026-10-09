import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const previousRetention = {
  ingestMs: 1_000,
  holdMs: 1_000,
  deliveryMs: 1_000,
  dryrunMs: 1_000,
  sseReplayMs: 1_000,
  deadLetterMs: 1_000,
  decisionMetadataMs: 1_000,
};

const tightenedRetention = {
  ingestMs: 50,
  holdMs: 40,
  deliveryMs: 30,
  dryrunMs: 20,
  sseReplayMs: 10,
  deadLetterMs: 10,
  decisionMetadataMs: 10,
};

test('D4a: a due retention tightening purges every D-owned staged and retained payload in its one transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retention-d-');
  const store = await openEventDatabase({ stateDir });
  try {
    const document = JSON.stringify({ retention: previousRetention });
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-retention@1', 'rule-retention', 1, '${document}', 'one'),
        ('rule-retention@2', 'rule-retention', 2, '${document}', 'two');
      INSERT INTO source_scan_state
        (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
        VALUES ('stage-due', 'slack', 'account-1', 'conversation:C001', 10, 1_010, X'01', 10);
      INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
        VALUES ('stage-due', 'rule-retention', 1);
      INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
        VALUES ('account-1', 1, '0000000000000000000000000000000000000000000000000000000000000000', 10);
      INSERT INTO whatsapp_occurrences
        (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
        VALUES ('account-1', '["wa-msg","chat","sender","stanza"]', 1, 10, 1, 'payload', 1_010);
      INSERT INTO whatsapp_rule_admissions
        (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
        VALUES ('account-1', '["wa-msg","chat","sender","stanza"]', 'rule-retention', 1, 'admitted', 'activation', 1, 10);
      INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-due', 'installation', 'slack.message.posted', 1, 'account-1', 'dedupe', 10, 10, 10);
      INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
        VALUES ('event-due', 'rule-retention', 1, 1_010, X'01');
      INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
        VALUES ('decision-due', 'event-due', 'account-1', 'rule-retention', 1, 'hold', 1_010, 1_010, 'retained', X'01');
      INSERT INTO deliveries
        (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation)
        VALUES ('delivery-due', 'decision-due', 'account-1', 'rule-retention', 1, 'target@1', 'target', 1, X'01', 1_010, 'disclosing', 0);
      INSERT INTO dryrun_log
        (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
        VALUES ('delivery-due', 'rule-retention', 1, 'target', 1, 'event-due', 'account-1', X'01', 10, 1_010);
    `);

    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-retention',
        child: { retention: tightenedRetention } as CanonicalFullRuleDocument,
        now: 60,
      }),
    );

    assert.equal(store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'stage-due'").get(), undefined);
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT staged_payload_ref, stage_expires_at FROM whatsapp_occurrences WHERE account_id = 'account-1'",
          )
          .get() as Record<string, unknown>),
      },
      { staged_payload_ref: null, stage_expires_at: null },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT admission FROM whatsapp_rule_admissions WHERE rule_id = 'rule-retention'")
          .get() as Record<string, unknown>),
      },
      { admission: 'expired' },
    );
    assert.equal(store.database.prepare("SELECT 1 FROM ingest_rules WHERE event_id = 'event-due'").get(), undefined);
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT outcome, metadata_state, encrypted_record FROM decisions WHERE id = 'decision-due'")
          .get() as Record<string, unknown>),
      },
      { outcome: 'retention-expired', metadata_state: 'purged', encrypted_record: null },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'delivery-due'")
          .get() as Record<string, unknown>),
      },
      { state: 'retention-expired', encrypted_record: null },
    );
    assert.equal(
      store.database.prepare("SELECT 1 FROM dryrun_log WHERE delivery_id = 'delivery-due'").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
