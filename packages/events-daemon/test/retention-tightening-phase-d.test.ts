import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { EventExpiry, SourceStageExpiryGroup } from '../src/runtime/expiry.ts';
import { sqliteTransactionNow } from '../src/runtime/holds.ts';
import { shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { ResendReceivedSource, ResendReceivedStageExpiry } from '../src/sources/resend.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { SlackHistorySource, SlackHistoryStageExpiry } from '../src/sources/slack.ts';
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
  holdMs: 80,
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
    // Holds use SQLite's transaction clock. Keep this legacy fixture due by that clock after the tightening, rather
    // than accidentally treating its historical synthetic timestamps as already expired before the change.
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    const stagedAt = dbNow - 60;
    const initialExpiry = stagedAt + previousRetention.ingestMs;
    const document = JSON.stringify({ retention: previousRetention });
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-retention@1', 'rule-retention', 1, '${document}', 'one'),
        ('rule-retention@2', 'rule-retention', 2, '${document}', 'two');
      INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
        VALUES ('account-1', 1, '0000000000000000000000000000000000000000000000000000000000000000', ${stagedAt});
      INSERT INTO source_scan_state
        (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
        VALUES ('whatsapp-payload', 'whatsapp', 'account-1', 'chat:chat', ${stagedAt}, ${initialExpiry}, X'01', ${stagedAt});
      INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
        VALUES ('whatsapp-payload', 'other-owed-rule', 1);
      INSERT INTO whatsapp_occurrences
        (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
        VALUES ('account-1', '["wa-msg","chat","sender","stanza"]', 1, ${stagedAt}, 1, 'whatsapp-payload', ${initialExpiry});
      INSERT INTO whatsapp_rule_admissions
        (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
        VALUES ('account-1', '["wa-msg","chat","sender","stanza"]', 'rule-retention', 1, 'admitted', 'activation', 1, ${stagedAt});
      INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-due', 'installation', 'slack.message.posted', 1, 'account-1', 'dedupe', ${stagedAt}, ${stagedAt}, ${stagedAt});
      INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
        VALUES ('event-due', 'rule-retention', 1, ${initialExpiry}, X'01');
      INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
        VALUES ('decision-due', 'event-due', 'account-1', 'rule-retention', 1, 'hold', ${initialExpiry}, ${initialExpiry}, 'retained', X'01');
      INSERT INTO deliveries
        (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation)
        VALUES ('delivery-due', 'decision-due', 'account-1', 'rule-retention', 1, 'target@1', 'target', 1, X'01', ${initialExpiry}, 'disclosing', 0);
      INSERT INTO dryrun_log
        (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
        VALUES ('delivery-due', 'rule-retention', 1, 'target', 1, 'event-due', 'account-1', X'01', ${stagedAt}, ${initialExpiry});
    `);

    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-retention',
        child: { retention: tightenedRetention } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );

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
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'whatsapp-payload'").get(),
      undefined,
      'terminalising a WhatsApp occurrence also deletes its encrypted first representation',
    );
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_stage_rule_debts WHERE stage_id = 'whatsapp-payload'").get(),
      undefined,
      'terminalising a WhatsApp occurrence also deletes every debt for that staged representation',
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

test('D4a: a legacy hold whose tightened hold window wins expires content-free as hold-expired', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retention-legacy-hold-d-');
  const store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    const stagedAt = dbNow - 60;
    const document = JSON.stringify({ retention: previousRetention });
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-legacy-hold@1', 'rule-legacy-hold', 1, '${document}', 'one');
      INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-legacy-hold', 'installation', 'slack.message.posted', 1, 'account-1', 'legacy-hold', ${stagedAt}, ${stagedAt}, ${stagedAt});
      INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
        VALUES ('decision-legacy-hold', 'event-legacy-hold', 'account-1', 'rule-legacy-hold', 1, 'hold', ${stagedAt + previousRetention.ingestMs}, ${stagedAt + previousRetention.ingestMs}, 'retained', X'01');
    `);

    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-legacy-hold',
        child: { retention: { ...tightenedRetention, holdMs: 40 } } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );

    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT outcome, hold_expires_at, encrypted_record FROM decisions WHERE id = ?')
          .get('decision-legacy-hold') as Record<string, unknown>),
      },
      { outcome: 'hold-expired', hold_expires_at: null, encrypted_record: null },
      'the tightened hold window is earlier than the ingest cap, so expiry keeps the truthful hold-window outcome',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: every retention tightening recomputes a live legacy hold from its current deadline', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retention-legacy-hold-repeat-d-');
  const store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    const stagedAt = dbNow;
    const document = JSON.stringify({ retention: previousRetention });
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-legacy-repeat@1', 'rule-legacy-repeat', 1, '${document}', 'one');
      INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-legacy-repeat', 'installation', 'slack.message.posted', 1, 'account-1', 'legacy-repeat', ${stagedAt}, ${stagedAt}, ${stagedAt});
      INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
        VALUES ('decision-legacy-repeat', 'event-legacy-repeat', 'account-1', 'rule-legacy-repeat', 1, 'hold', ${stagedAt + previousRetention.ingestMs}, ${stagedAt + previousRetention.ingestMs}, 'retained', X'01');
    `);

    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-legacy-repeat',
        child: { retention: { ...tightenedRetention, holdMs: 800, ingestMs: 900 } } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );
    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-legacy-repeat',
        child: { retention: { ...tightenedRetention, holdMs: 400, ingestMs: 700 } } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );

    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT outcome, hold_expires_at, hold_bound_by FROM decisions WHERE id = ?')
          .get('decision-legacy-repeat') as Record<string, unknown>),
      },
      { outcome: 'hold', hold_expires_at: stagedAt + 400, hold_bound_by: 'hold-window' },
      'the second tightening, not the first bound label, determines the shorter live legacy deadline',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D4a: a legacy hold due only after its second tightening terminalises as hold-expired', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-retention-legacy-hold-second-expiry-d-');
  const store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    const stagedAt = dbNow - 50;
    const document = JSON.stringify({ retention: previousRetention });
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-legacy-second-expiry@1', 'rule-legacy-second-expiry', 1, '${document}', 'one');
      INSERT INTO ingest
        (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
        VALUES ('event-legacy-second-expiry', 'installation', 'slack.message.posted', 1, 'account-1', 'legacy-second-expiry', ${stagedAt}, ${stagedAt}, ${stagedAt});
      INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_expires_at, metadata_expires_at, metadata_state, encrypted_record)
        VALUES ('decision-legacy-second-expiry', 'event-legacy-second-expiry', 'account-1', 'rule-legacy-second-expiry', 1, 'hold', ${stagedAt + previousRetention.ingestMs}, ${stagedAt + previousRetention.ingestMs}, 'retained', X'01');
    `);

    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-legacy-second-expiry',
        child: { retention: { ...tightenedRetention, holdMs: 800, ingestMs: 900 } } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );
    store.immediate(() =>
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId: 'rule-legacy-second-expiry',
        child: { retention: { ...tightenedRetention, holdMs: 20, ingestMs: 600 } } as CanonicalFullRuleDocument,
        now: dbNow,
      }),
    );

    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT outcome, hold_expires_at, hold_bound_by, encrypted_record FROM decisions WHERE id = ?')
          .get('decision-legacy-second-expiry') as Record<string, unknown>),
      },
      { outcome: 'hold-expired', hold_expires_at: null, hold_bound_by: null, encrypted_record: null },
      'the second hold-window bound is due by SQLite time and has the hold-window terminal outcome',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: retention tightening terminalises Slack and Resend stages under their real occurrence keys before either can re-observe', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-source-tightening-expiry-');
  const store = await openEventDatabase({ stateDir });
  try {
    const ruleId = 'rule-source-retention';
    const slackAccount = 'slack-account';
    const conversationId = 'C001';
    const slackScanId = `slack-history-scan:${Buffer.from(JSON.stringify([slackAccount, conversationId])).toString('base64url')}`;
    const slackStageId = `slack-history-page:${Buffer.from(
      JSON.stringify([slackAccount, conversationId, 1, null, 'after-expired']),
    ).toString('base64url')}`;
    const resendAccount = 'resend-account';
    const resendEmailId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    const resendAnchor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
    const encode = async (value: unknown) => Buffer.from(JSON.stringify(value));
    const decode = async (value: Uint8Array) => JSON.parse(Buffer.from(value).toString('utf8')) as unknown;
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('rule-source-retention@1', 'rule-source-retention', 1, '{"retention":${JSON.stringify(previousRetention)}}', 'one'),
        ('rule-source-retention@2', 'rule-source-retention', 2, '{"retention":${JSON.stringify(previousRetention)}}', 'two');
      UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1;
    `);
    store.database
      .prepare(
        `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at)
         VALUES (?, 'slack', ?, ?, ?, 10)`,
      )
      .run(
        slackScanId,
        slackAccount,
        `slack:${slackAccount}:${conversationId}`,
        await encode({
          kind: 'slack-history-scan-v1',
          oldest: '0.000000',
          latest: '9.999999',
          cursor: null,
          generation: 1,
        }),
      );
    store.database
      .prepare(
        `INSERT INTO source_scan_state
          (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
         VALUES (?, 'slack', ?, ?, 10, 1_010, ?, 10)`,
      )
      .run(
        slackStageId,
        slackAccount,
        `slack:${slackAccount}:${conversationId}`,
        await encode({
          kind: 'slack-history-page-v1',
          scanGeneration: 1,
          cursorBefore: null,
          nextCursor: 'after-expired',
          page: {
            messages: [
              { ts: '1.000000', threadTs: null, replyCount: 0, text: '<untrusted-content>expired</untrusted-content>' },
            ],
            nextCursor: 'after-expired',
            retainedHistoryBoundary: false,
          },
          completed: [],
        }),
      );
    store.database
      .prepare(
        `INSERT INTO source_scan_state
          (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
         VALUES (?, 'resend', ?, 'received', 10, 1_010, ?, 10)`,
      )
      .run(
        `resend-received:${resendAccount}`,
        resendAccount,
        await encode({
          anchorId: resendAnchor,
          cycleHeadId: resendEmailId,
          after: null,
          pagesScanned: 1,
          items: [resendEmailId, resendAnchor],
          seenIds: [],
          candidate: { emailId: resendEmailId, subject: 'expired', receivedAt: '2026-10-09T00:00:00.000Z' },
        }),
      );
    for (const stageId of [slackStageId, `resend-received:${resendAccount}`])
      store.database
        .prepare('INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, 1)')
        .run(stageId, ruleId);

    const stages = new SourceStageExpiryGroup([
      new SlackHistoryStageExpiry({
        store,
        lock: new SourceScopeLock(),
        decrypt: decode,
        encrypt: encode,
        now: () => 60,
      }),
      new ResendReceivedStageExpiry({
        store,
        lock: new SourceScopeLock(),
        decrypt: decode,
        encrypt: encode,
        now: () => 60,
      }),
    ]);
    const terminalisations = await stages.prepareRetentionTightening({
      ruleId,
      ingestRetentionMs: 50,
      now: 60,
    });
    assert.equal(terminalisations.length, 2, 'both source-specific terminalisations are prepared before BEGIN');
    store.immediate(() => {
      shortenRuleRetentionDeadlines({
        database: store.database,
        ruleId,
        child: { retention: tightenedRetention } as CanonicalFullRuleDocument,
        now: 60,
      });
      for (const terminalisation of terminalisations) terminalisation.terminaliseInTransaction();
    });

    assert.deepEqual(
      store.database
        .prepare('SELECT source, account_id, occurrence_key FROM source_occurrence_resolutions ORDER BY source')
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        { source: 'resend', account_id: resendAccount, occurrence_key: resendEmailId },
        { source: 'slack', account_id: slackAccount, occurrence_key: JSON.stringify([conversationId, '1.000000']) },
      ],
      'the opaque stage ids never become occurrence identities',
    );
    assert.equal(store.database.prepare('SELECT 1 FROM source_scan_state WHERE id = ?').get(slackStageId), undefined);
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT stage_expires_at FROM source_scan_state WHERE id = ?')
          .get(`resend-received:${resendAccount}`) as Record<string, unknown>),
      },
      { stage_expires_at: null },
    );
    const slackRequests: Array<string | undefined> = [];
    const slackAdmissions: string[] = [];
    const slack = new SlackHistorySource({
      store,
      accountId: slackAccount,
      source: {
        async history(input) {
          slackRequests.push(input.cursor);
          return { messages: [], nextCursor: null, retainedHistoryBoundary: false };
        },
      },
      lock: new SourceScopeLock(),
      accountLive: async () => undefined,
      rules: () => [{ ruleId, ruleVersion: 1, ingestRetentionMs: 50 }],
      admit: async (candidate) => {
        slackAdmissions.push(candidate.message.ts);
        return 'terminal';
      },
      encryptStage: encode,
      decryptStage: decode,
      now: () => 61,
    });
    await slack.scan({ conversationId, latest: '9.999999' });
    assert.deepEqual(slackRequests, [], 'the expired Slack page is not fetched again');
    assert.deepEqual(slackAdmissions, []);
    let resendReads = 0;
    const resendAdmissions: string[] = [];
    const resend = new ResendReceivedSource({
      store,
      accountId: resendAccount,
      reader: {
        async listReceived() {
          resendReads += 1;
          return { emails: [], next: null };
        },
        async getReceived() {
          resendReads += 1;
          return { kind: 'vanished' as const };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      },
      encrypt: encode,
      decrypt: decode,
      debts: () => [{ ruleId, ruleVersion: 1, ingestRetentionMs: 50 }],
      admit: async (candidate) => {
        resendAdmissions.push(candidate.emailId);
        return 'terminal';
      },
      now: () => 61,
    });
    await resend.scan();
    assert.equal(resendReads, 0, 'the resolved received id is consumed without another provider read');
    assert.deepEqual(resendAdmissions, []);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7a: common expiry removes the WhatsApp ciphertext and every debt with its terminal occurrence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-common-expiry-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`
      INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES
        ('other-owed-rule@1', 'other-owed-rule', 1, '{}', 'other'),
        ('expired-rule@1', 'expired-rule', 1, '{}', 'expired');
      INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
        VALUES ('account-expiry', 1, '0000000000000000000000000000000000000000000000000000000000000000', 1);
      INSERT INTO source_scan_state
        (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
        VALUES ('whatsapp-expiry-payload', 'whatsapp', 'account-expiry', 'chat:chat', 1, 10, X'01', 1);
      INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
        VALUES ('whatsapp-expiry-payload', 'other-owed-rule', 1);
      INSERT INTO whatsapp_occurrences
        (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
        VALUES ('account-expiry', '["wa-msg","chat","sender","stanza"]', 1, 1, 1, 'whatsapp-expiry-payload', 10);
      INSERT INTO whatsapp_rule_admissions
        (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
        VALUES ('account-expiry', '["wa-msg","chat","sender","stanza"]', 'expired-rule', 1, 'admitted', 'activation', 1, 1);
    `);

    new EventExpiry(store, () => 10).sweep();

    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT staged_payload_ref, stage_expires_at FROM whatsapp_occurrences WHERE account_id = 'account-expiry'",
          )
          .get() as Record<string, unknown>),
      },
      { staged_payload_ref: null, stage_expires_at: null },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT admission FROM whatsapp_rule_admissions WHERE rule_id = 'expired-rule'")
          .get() as Record<string, unknown>),
      },
      { admission: 'expired' },
    );
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'whatsapp-expiry-payload'").get(),
      undefined,
    );
    assert.equal(
      store.database.prepare("SELECT 1 FROM source_stage_rule_debts WHERE stage_id = 'whatsapp-expiry-payload'").get(),
      undefined,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
