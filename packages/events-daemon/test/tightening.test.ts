import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { applyDerivedTightening, shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-tightening', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const base: CanonicalFullRuleDocument = {
  ruleId: 'rule-tightening',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: ['account-1'],
    options: { channel: 'gmail' as const, labels: ['Label_a', 'Label_b'], includeSpamTrash: true },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { subject: { $path: '/subject' } },
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

test('APR-B1: a verified Gmail source narrowing atomically inherits points, records its immediate lineage and revokes only the wider version', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-tightening-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(base);
    const child: CanonicalFullRuleDocument = {
      ...base,
      version: 2,
      source: { ...base.source, options: { ...base.source.options, labels: ['Label_a'] } },
    };
    versions.createRule(child);
    store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_root', authorization_activation_id = 'act_root', activated_at = 1 WHERE id = 'rule-tightening@1'; INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-tightening', 1, 'act_root', 1); INSERT INTO rule_activation_points (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at) VALUES ('act_root', 'rule-tightening', 1, 'gmail', 'account-1', 'mailbox', X'00', 1)",
    );

    await applyDerivedTightening({
      database: store.database,
      parent: base,
      child,
      now: 2,
      decryptPoint: async () => ({ historyId: '1' }),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    });

    assert.deepEqual(
      store.database
        .prepare(
          'SELECT version, state, approval_id, authorization_activation_id FROM rule_versions WHERE rule_id = ? ORDER BY version',
        )
        .all('rule-tightening')
        .map((row) => ({ ...row })),
      [
        { version: 1, state: 'revoked', approval_id: 'ap_root', authorization_activation_id: 'act_root' },
        { version: 2, state: 'active', approval_id: 'ap_root', authorization_activation_id: 'rule-tightening@2' },
      ],
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT version_id, parent_approval_id, parent_version_id, edit_kind FROM derived_authorizations')
          .get() as Record<string, unknown>),
      },
      {
        version_id: 'rule-tightening@2',
        parent_approval_id: 'ap_root',
        parent_version_id: 'rule-tightening@1',
        edit_kind: 'narrow-source-options',
      },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            'SELECT activation_id, rule_version, inherited_from_version_id FROM rule_activation_points WHERE rule_version = 2',
          )
          .get() as Record<string, unknown>),
      },
      { activation_id: 'rule-tightening@2', rule_version: 2, inherited_from_version_id: 'rule-tightening@1' },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('APR-B1: a disguised loosening cannot create a derived authorisation', async () => {
  await assert.rejects(
    () =>
      applyDerivedTightening({
        database: {} as never,
        parent: base,
        child: { ...base, version: 2, deliveryRateCap: 61 },
        now: 2,
        decryptPoint: async () => ({ historyId: '1' }),
        encryptPoint: async () => Buffer.from('point'),
      }),
    /not an allowed tightening/u,
  );
});

test('APR-B1: a retention tightening moves every persisted B1 deadline only earlier', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-tightening-retention-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(base);
    const child: CanonicalFullRuleDocument = {
      ...base,
      version: 2,
      retention: {
        ingestMs: 100,
        holdMs: 110,
        deliveryMs: 120,
        dryrunMs: 130,
        sseReplayMs: 140,
        deadLetterMs: 150,
        decisionMetadataMs: 160,
      },
    };
    store.database.exec(
      "INSERT INTO source_scan_state (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at) VALUES ('stage-retention', 'gmail', 'account-1', 'mailbox', 10, 1000, X'01', 10); INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES ('stage-retention', 'rule-tightening', 1); INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-retention', 'install', 'gmail.message.received', 1, 'account-1', 'dedupe', 10, 10, 10); INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-retention', 'rule-tightening', 1, 1000, X'01'); INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record) VALUES ('decision-retention', 'event-retention', 'account-1', 'rule-tightening', 1, 'hold', 1000, 1000, 'retained', X'01'); INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation) VALUES ('delivery-retention', 'decision-retention', 'account-1', 'rule-tightening', 1, 'target-tightening@1', 'target-tightening', 1, X'01', 604800010, 'queued', 0); INSERT INTO dryrun_log (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at) VALUES ('delivery-retention', 'rule-tightening', 1, 'target-tightening', 1, 'event-retention', 'account-1', X'01', 10, 86400010)",
    );

    shortenRuleRetentionDeadlines({ database: store.database, ruleId: base.ruleId, child, now: 0 });

    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?')
          .get('stage-retention') as Record<string, unknown>),
        ...(store.database
          .prepare('SELECT decision_deadline FROM ingest_rules WHERE event_id = ?')
          .get('event-retention') as Record<string, unknown>),
        ...(store.database
          .prepare('SELECT hold_expires_at, metadata_expires_at FROM decisions WHERE id = ?')
          .get('decision-retention') as Record<string, unknown>),
      },
      { stage_expires_at: 110, decision_deadline: 110, hold_expires_at: 120, metadata_expires_at: 170 },
    );
    assert.equal(
      (
        store.database.prepare('SELECT expires_at FROM deliveries WHERE id = ?').get('delivery-retention') as {
          expires_at: number;
        }
      ).expires_at,
      130,
    );
    assert.equal(
      (
        store.database.prepare('SELECT expires_at FROM dryrun_log WHERE delivery_id = ?').get('delivery-retention') as {
          expires_at: number;
        }
      ).expires_at,
      140,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
