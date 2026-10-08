import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { assertReplacementDrained } from '../src/runtime/replacements.ts';
import { disableRule } from '../src/runtime/revocations.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('APR-B1: a replacement cannot swap before every durable drain is complete', () => {
  const database = {
    prepare() {
      return { get: () => ({ remaining: 1 }) };
    },
  };
  assert.throws(
    () => assertReplacementDrained(database as never, 'act_replacement'),
    (error: unknown) =>
      (error as { code?: string; details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
  );
});

test('APR-B1: a rule revocation purges retained dry-run and source content and cannot leave queued disclosure work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-revocation-purge-');
  const store = await openEventDatabase({ stateDir });
  try {
    const target = { targetId: 'target-purge', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
    const rule = {
      ruleId: 'rule-purge',
      version: 1,
      source: {
        channel: 'gmail' as const,
        accountIds: ['account-purge'],
        options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [target],
      subscribers: [],
      judges: [],
      deliveryRateCap: 60,
      retention: {
        ingestMs: 604_800_000,
        holdMs: 604_800_000,
        deliveryMs: 604_800_000,
        dryrunMs: 86_400_000,
        sseReplayMs: 604_800_000,
        deadLetterMs: 604_800_000,
        decisionMetadataMs: 7_776_000_000,
      },
    };
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_purge', authorization_activation_id = 'act_purge', activated_at = 1 WHERE id = 'rule-purge@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-purge', 1, 'act_purge', 1); INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-purge', 'install', 'gmail.message.received', 1, 'account-purge', 'dedupe', 1, 1, 1); INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-purge', 'rule-purge', 1, 9, X'01'); INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record) VALUES ('decision-purge', 'event-purge', 'account-purge', 'rule-purge', 1, 'allow', 9, 'retained', X'01'); INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation) VALUES ('delivery-purge', 'decision-purge', 'account-purge', 'rule-purge', 1, 'target-purge@1', 'target-purge', 1, X'01', 9, 'queued', 0); INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation) VALUES ('delivery-inflight', 'decision-purge', 'account-purge', 'rule-purge', 1, 'target-purge@2', 'target-purge', 1, X'01', 9, 'disclosing', 0); INSERT INTO dryrun_log (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at) VALUES ('delivery-purge', 'rule-purge', 1, 'target-purge', 1, 'event-purge', 'account-purge', X'01', 1, 9); INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES ('stage-purge', 'gmail', 'account-purge', 'mailbox', X'01', 1); INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES ('stage-purge', 'rule-purge', 1)",
    );

    await disableRule(store, { cancelForRevocation: async () => undefined }, 'rule-purge');

    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM dryrun_log').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }).count,
      0,
    );
    assert.deepEqual(
      store.database
        .prepare('SELECT id, state, encrypted_record FROM deliveries ORDER BY id')
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        { id: 'delivery-inflight', state: 'in-flight-at-disable', encrypted_record: null },
        { id: 'delivery-purge', state: 'cancelled', encrypted_record: null },
      ],
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
