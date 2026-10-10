import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { assertLiveEventAccount, liveEventAccountIds, purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { removeTarget } from '../src/runtime/revocations.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const REMOVED = 'acc_removed_phase_d';
const KEPT = 'acc_kept_phase_d';

function count(
  database: { prepare(sql: string): { get(...values: readonly unknown[]): unknown } },
  sql: string,
  ...values: readonly unknown[]
): number {
  return (database.prepare(`SELECT count(*) AS count FROM ${sql}`).get(...values) as { count: number }).count;
}

function ruleDocument(ruleId: string, accountId: string, targetId: string): string {
  return JSON.stringify({
    ruleId,
    version: 1,
    source: { channel: 'whatsapp', accountIds: [accountId], options: { channel: 'whatsapp', chats: ['chat-1'] } },
    targets: [{ targetId, version: 1, kind: 'dry-run' }],
  });
}

function insertRule(
  database: { prepare(sql: string): { run(...values: readonly unknown[]): unknown } },
  input: {
    readonly ruleId: string;
    readonly accountId: string;
    readonly targetId: string;
  },
): void {
  database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, 'digest', 'active', 'approval', ?, 1)`,
    )
    .run(
      `${input.ruleId}@1`,
      input.ruleId,
      ruleDocument(input.ruleId, input.accountId, input.targetId),
      `${input.ruleId}@1`,
    );
  database
    .prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, ?, 1)",
    )
    .run(input.ruleId, `${input.ruleId}@1`);
}

function seedWhatsAppState(
  database: { prepare(sql: string): { run(...values: readonly unknown[]): unknown } },
  accountId: string,
  ruleId: string,
): void {
  database
    .prepare('INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at) VALUES (?, 1, ?, 1)')
    .run(accountId, 'a'.repeat(64));
  database
    .prepare(
      'INSERT INTO whatsapp_snapshot_heads (account_id, committed_generation, visibility_version) VALUES (?, 1, 1)',
    )
    .run(accountId);
  database
    .prepare(
      `INSERT INTO whatsapp_snapshot_keys
       (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
       VALUES (?, 1, 1, 'chat-1', 'sender-1', 'stanza-1')`,
    )
    .run(accountId);
  database
    .prepare(
      `INSERT INTO whatsapp_occurrences
       (account_id, message_id, first_seen_generation, first_seen_at, visibility_version)
       VALUES (?, 'message-1', 1, 1, 1)`,
    )
    .run(accountId);
  database
    .prepare(
      `INSERT INTO whatsapp_rule_admissions
       (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
       VALUES (?, 'message-1', ?, 1, 'admitted', 'act-1', 1, 1)`,
    )
    .run(accountId, ruleId);
}

test('D9: live-account checks select the source-specific core registry entry and fail closed on a cross-channel id', async () => {
  const config = {
    load: async () => ({
      inboxes: { gmail: { id: 'ibx_gmail', provider: 'gmail' } },
      accounts: {
        slack: { id: 'acc_slack', platform: 'slack' },
        resend: { id: 'acc_resend', platform: 'resend' },
        whatsapp: { id: 'acc_whatsapp', platform: 'whatsapp' },
      },
    }),
  };
  await assertLiveEventAccount(config as never, { source: 'gmail', accountId: 'ibx_gmail' });
  await assertLiveEventAccount(config as never, { source: 'slack', accountId: 'acc_slack' });
  await assertLiveEventAccount(config as never, { source: 'resend', accountId: 'acc_resend' });
  await assertLiveEventAccount(config as never, { source: 'whatsapp', accountId: 'acc_whatsapp' });
  assert.deepEqual(await liveEventAccountIds(config as never, 'gmail'), new Set(['ibx_gmail']));
  assert.deepEqual(await liveEventAccountIds(config as never, 'slack'), new Set(['acc_slack']));
  await assert.rejects(
    () => assertLiveEventAccount(config as never, { source: 'slack', accountId: 'acc_resend' }),
    (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'ACCOUNT_REMOVED',
  );
});

test('D9: account removal purges every D-owned row for that source/account while retaining content-free terminal and gap audit history', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d-account-');
  const store = await openEventDatabase({ stateDir });
  try {
    const database = store.database;
    insertRule(database, { ruleId: 'rule-removed', accountId: REMOVED, targetId: 'target-removed' });
    insertRule(database, { ruleId: 'rule-kept', accountId: KEPT, targetId: 'target-kept' });
    for (const accountId of [REMOVED, KEPT]) {
      database
        .prepare(
          `INSERT INTO activation_intents
           (id, kind, document, digest, effect, required_points, acquisition_scopes, status, created_at, updated_at)
           VALUES (?, 'rule', '{}', 'digest', '{}', '[]', '[]', 'cancelled', 1, 1)`,
        )
        .run(`intent-${accountId}`);
      database
        .prepare(
          `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
           VALUES (?, 'slack', ?, 'conversation-1', X'01', 1)`,
        )
        .run(`stage-${accountId}`, accountId);
      database
        .prepare(
          `INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at)
           VALUES ('slack', ?, 'conversation-1', 'cursor', 1)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
           VALUES (?, 'slack', ?, 'conversation-1', X'01', 1)`,
        )
        .run(`intent-${accountId}`, accountId);
      database
        .prepare(
          `INSERT INTO replacement_drains (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope)
           VALUES (?, 'slack', ?, 'conversation-1', 1, 1)`,
        )
        .run(`intent-${accountId}`, accountId);
      database
        .prepare(
          `INSERT INTO slack_reply_drains
           (intent_id, account_id, conversation_id, thread_ts, cursor, covered_through)
           VALUES (?, ?, 'conversation-1', '1.000001', 'cursor', '1.000001')`,
        )
        .run(`intent-${accountId}`, accountId);
      database
        .prepare(
          `INSERT INTO resend_status_state (account_id, email_id, last_event, observed_at, expires_at)
           VALUES (?, '00000000-0000-4000-8000-000000000001', 'delivered', 1, 604800001)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO resend_status_high_water (account_id, high_water_at, scan_generation, updated_at)
           VALUES (?, '2026-10-10T12:00:00.000Z', 1, 1)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO rule_activation_points
           (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
           VALUES (?, ?, 1, 'slack', ?, 'conversation-1', X'01', 1)`,
        )
        .run(`${accountId}-point`, accountId === REMOVED ? 'rule-removed' : 'rule-kept', accountId);
      database
        .prepare(
          `INSERT INTO source_occurrence_resolutions (source, account_id, occurrence_key, outcome, resolved_at)
           VALUES ('slack', ?, 'occurrence-1', 'retention-expired', 1)`,
        )
        .run(accountId);
      database
        .prepare(
          `INSERT INTO source_projection_resolutions
           (source, account_id, occurrence_key, rule_id, rule_version, materialization_key, outcome, resolved_at)
           VALUES ('slack', ?, 'occurrence-1', ?, 1, 'body', 'retention-expired', 1)`,
        )
        .run(accountId, accountId === REMOVED ? 'rule-removed' : 'rule-kept');
      seedWhatsAppState(database, accountId, accountId === REMOVED ? 'rule-removed' : 'rule-kept');
    }
    database.exec(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES ('event-removed', 'install', 'whatsapp.message.received', 1, '${REMOVED}', 'dedupe', 1, 1, 1);
       INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
         VALUES ('held-removed', 'event-removed', '${REMOVED}', 'rule-removed', 1, 'hold', 9, 99, 'retained', X'01');
       INSERT INTO operational_records (id, kind, created_at) VALUES ('gap-removed', 'agentcomms.source.gap', 1);`,
    );

    store.immediate(() => purgeRemovedAccountWork(database, { source: 'whatsapp', accountId: REMOVED }, 5));

    for (const table of [
      'whatsapp_visibility',
      'whatsapp_snapshot_heads',
      'whatsapp_snapshot_keys',
      'whatsapp_occurrences',
      'whatsapp_rule_admissions',
    ]) {
      assert.equal(
        count(database, `${table} WHERE account_id = ?`, REMOVED),
        0,
        `${table} is purged for the removed account`,
      );
      assert.equal(count(database, `${table} WHERE account_id = ?`, KEPT), 1, `${table} remains for the other account`);
    }
    assert.equal(
      count(database, 'source_scan_state WHERE source = ? AND account_id = ?', 'slack', REMOVED),
      1,
      'only the matching source is selected',
    );
    assert.equal(count(database, 'source_scan_state WHERE source = ? AND account_id = ?', 'whatsapp', REMOVED), 0);
    assert.equal(
      count(database, 'slack_reply_drains WHERE account_id = ?', REMOVED),
      1,
      'a different source keeps its own durable state',
    );
    assert.equal(
      count(database, 'resend_status_state WHERE account_id = ?', REMOVED),
      1,
      'a different source keeps its own durable state',
    );
    assert.equal(
      count(database, 'resend_status_high_water WHERE account_id = ?', REMOVED),
      1,
      'a different source keeps its status high-water witness',
    );
    const held = database
      .prepare('SELECT outcome, encrypted_record FROM decisions WHERE id = ?')
      .get('held-removed') as {
      outcome: string;
      encrypted_record: Uint8Array | null;
    };
    assert.deepEqual(
      { outcome: held.outcome, encrypted: held.encrypted_record },
      { outcome: 'cancelled', encrypted: null },
    );
    assert.equal(count(database, "operational_records WHERE id = 'gap-removed'"), 1, 'content-free gap audit remains');

    store.immediate(() => purgeRemovedAccountWork(database, { source: 'slack', accountId: REMOVED }, 5));
    store.immediate(() => purgeRemovedAccountWork(database, { source: 'resend', accountId: REMOVED }, 5));
    assert.equal(count(database, 'source_scan_state WHERE source = ? AND account_id = ?', 'slack', REMOVED), 0);
    assert.equal(count(database, 'slack_reply_drains WHERE account_id = ?', REMOVED), 0);
    assert.equal(count(database, 'resend_status_state WHERE account_id = ?', REMOVED), 0);
    assert.equal(count(database, 'resend_status_high_water WHERE account_id = ?', REMOVED), 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D9: target removal purges D rule-version work but keeps the account-global WhatsApp occurrence ledger', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d-target-');
  const store = await openEventDatabase({ stateDir });
  try {
    const database = store.database;
    const ruleId = 'rule-target-removed';
    const targetId = 'target-target-removed';
    insertRule(database, { ruleId, accountId: REMOVED, targetId });
    database
      .prepare(
        `INSERT INTO target_versions (id, target_id, version, document, digest)
         VALUES (?, ?, 1, '{"targetId":"target-target-removed","version":1,"kind":"dry-run"}', 'digest')`,
      )
      .run(`${targetId}@1`, targetId);
    seedWhatsAppState(database, REMOVED, ruleId);
    database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, created_at, updated_at)
         VALUES ('replacement-target', 'rule', '{}', 'digest', '{}', ?, '[]', '[]', 'cancelled', 1, 1)`,
      )
      .run(`${ruleId}@1`);
    database
      .prepare(
        `INSERT INTO slack_reply_drains
         (intent_id, account_id, conversation_id, thread_ts, cursor, covered_through)
         VALUES ('replacement-target', ?, 'conversation-1', '1.000001', 'cursor', '1.000001')`,
      )
      .run(REMOVED);
    database
      .prepare(
        `INSERT INTO rule_activation_points
         (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
         VALUES ('point-target', ?, 1, 'whatsapp', ?, 'chat-1', X'01', 1)`,
      )
      .run(ruleId, REMOVED);

    await removeTarget(store, { cancelForRevocation: async () => undefined } as never, targetId);

    assert.equal(count(database, 'whatsapp_rule_admissions WHERE rule_id = ? AND rule_version = 1', ruleId), 0);
    assert.equal(
      count(database, 'whatsapp_occurrences WHERE account_id = ?', REMOVED),
      1,
      'the account-global source identity is not rule work',
    );
    assert.equal(count(database, 'slack_reply_drains WHERE intent_id = ?', 'replacement-target'), 0);
    assert.equal(count(database, 'rule_activation_points WHERE rule_id = ? AND rule_version = 1', ruleId), 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
