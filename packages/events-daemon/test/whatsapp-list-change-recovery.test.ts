import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { RetainedContentHooks } from '../src/runtime/retained-content-hooks.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { WhatsAppSourceWorker } from '../src/sources/whatsapp.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const accountId = 'acc_whatsapp_list_recovery';
const messageId = '["wa-msg","chat@example.test","sender@example.test","one"]';

const purgeFaults = [
  ['before applied version write', 'whatsapp_visibility', 'BEFORE UPDATE'],
  ['after digest/version write', 'whatsapp_visibility', 'AFTER UPDATE'],
  ['between snapshot and occurrence purge', 'whatsapp_occurrences', 'BEFORE UPDATE'],
  ['between occurrence and stage purge', 'source_scan_state', 'BEFORE DELETE'],
  ['between stage and admission purge', 'whatsapp_rule_admissions', 'BEFORE UPDATE'],
  ['between admission and projection purge', 'ingest_rules', 'BEFORE DELETE'],
  ['between projection and dry-run purge', 'dryrun_log', 'BEFORE DELETE'],
  ['between dry-run and delivery purge', 'deliveries', 'BEFORE UPDATE'],
  ['between delivery and decision purge', 'decisions', 'BEFORE UPDATE'],
] as const;

function fence(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  hooks?: RetainedContentHooks,
): WhatsAppVisibilityFence {
  return new WhatsAppVisibilityFence({
    store,
    retainedContentHooks: hooks,
    now: () => 2,
    withCurrentEventVisibility: async (_input, work) =>
      work({ version: 1, digest: 'b'.repeat(64), seesMessage: () => false }),
  });
}

function seed(store: Awaited<ReturnType<typeof openEventDatabase>>): void {
  store.database.exec(`
    INSERT INTO whatsapp_visibility (account_id, version, lists_digest, changed_at)
      VALUES ('${accountId}', 1, '${'a'.repeat(64)}', 1);
    INSERT INTO whatsapp_snapshot_heads (account_id, committed_generation, visibility_version)
      VALUES ('${accountId}', 1, 1);
    INSERT INTO whatsapp_snapshot_keys
      (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
      VALUES ('${accountId}', 1, 1, 'chat@example.test', 'sender@example.test', 'one');
    INSERT INTO source_scan_state
      (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
      VALUES ('stage', 'whatsapp', '${accountId}', 'chat:chat@example.test', 1, 100, X'01', 1);
    INSERT INTO ingest
      (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
      VALUES ('event', '${store.installationId}', 'whatsapp.message.received', 1, '${accountId}', 'dedupe', 1, 1, 1);
    INSERT INTO whatsapp_occurrences
      (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at, event_id)
      VALUES ('${accountId}', '${messageId.replaceAll("'", "''")}', 1, 1, 1, 'stage', 100, 'event');
    INSERT INTO rule_versions (id, rule_id, version, document, digest)
      VALUES ('rule@1', 'rule', 1, '{}', 'digest');
    INSERT INTO whatsapp_rule_admissions
      (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
      VALUES ('${accountId}', '${messageId.replaceAll("'", "''")}', 'rule', 1, 'admitted', 'activation', 1, 1);
    INSERT INTO ingest_rules
      (event_id, rule_id, rule_version, decision_deadline, encrypted_projection, whatsapp_visibility_version, whatsapp_message_id)
      VALUES ('event', 'rule', 1, 100, X'01', 1, '${messageId.replaceAll("'", "''")}');
    INSERT INTO decisions
      (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record, whatsapp_message_id)
      VALUES ('decision', 'event', '${accountId}', 'rule', 1, 'allow', 100, 'retained', X'01', '${messageId.replaceAll("'", "''")}');
    INSERT INTO deliveries
      (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record,
       expires_at, state, switch_generation, whatsapp_visibility_version, whatsapp_message_id)
      VALUES ('delivery', 'decision', '${accountId}', 'rule', 1, 'dryrun:target:1', 'target', 1, X'01', 100,
              'queued', 1, 1, '${messageId.replaceAll("'", "''")}');
    INSERT INTO dryrun_log
      (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
       delivered_at, expires_at, whatsapp_message_id)
      VALUES ('delivery', 'rule', 1, 'target', 1, 'event', '${accountId}', X'01', 1, 100,
              '${messageId.replaceAll("'", "''")}');
  `);
}

function assertRecovered(store: Awaited<ReturnType<typeof openEventDatabase>>): void {
  assert.deepEqual(
    {
      ...(store.database.prepare('SELECT version, lists_digest FROM whatsapp_visibility').get() as Record<
        string,
        unknown
      >),
    },
    { version: 2, lists_digest: 'b'.repeat(64) },
  );
  for (const table of ['whatsapp_snapshot_keys', 'source_scan_state', 'ingest_rules', 'dryrun_log'] as const)
    assert.equal(store.database.prepare(`SELECT 1 FROM ${table}`).get(), undefined, `${table} was purged on retry`);
  assert.deepEqual(
    {
      ...(store.database
        .prepare('SELECT staged_payload_ref, stage_expires_at FROM whatsapp_occurrences')
        .get() as Record<string, unknown>),
    },
    { staged_payload_ref: null, stage_expires_at: null },
  );
  assert.deepEqual(
    { ...(store.database.prepare('SELECT admission FROM whatsapp_rule_admissions').get() as Record<string, unknown>) },
    { admission: 'suppressed' },
  );
  assert.deepEqual(
    {
      ...(store.database.prepare('SELECT state, encrypted_record FROM deliveries').get() as Record<string, unknown>),
    },
    { state: 'cancelled', encrypted_record: null },
  );
  assert.deepEqual(
    {
      ...(store.database.prepare('SELECT outcome, encrypted_record FROM decisions').get() as Record<string, unknown>),
    },
    { outcome: 'cancelled', encrypted_record: null },
  );
}

test('D9: a list-change interruption before its applied version or between every D purge set rolls back and converges on retry', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [name, table, timing] of purgeFaults) {
    const stateDir = await shortTempDir('events-wa-list-retry-');
    let store = await openEventDatabase({ stateDir });
    try {
      seed(store);
      store.database.exec(
        `CREATE TRIGGER injected_list_change_fault ${timing} ON ${table}
         BEGIN SELECT RAISE(ABORT, 'simulated ${name.replaceAll("'", "''")}'); END`,
      );
      await assert.rejects(() => fence(store).withCurrentVisibility({ accountId }, () => undefined), /simulated/u);
      assert.deepEqual(
        {
          ...(store.database.prepare('SELECT version, lists_digest FROM whatsapp_visibility').get() as Record<
            string,
            unknown
          >),
        },
        { version: 1, lists_digest: 'a'.repeat(64) },
        `${name} rolls back the journal with every D-owned purge`,
      );
      store.close();
      store = await openEventDatabase({ stateDir });
      store.database.exec('DROP TRIGGER injected_list_change_fault');
      await fence(store).withCurrentVisibility({ accountId }, () => undefined);
      assertRecovered(store);
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('D9: a retained-content participant interruption rolls back the D journal, then the same on-disk database converges', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-wa-list-participant-retry-');
  let store = await openEventDatabase({ stateDir });
  try {
    seed(store);
    const hooks = new RetainedContentHooks();
    hooks.registerWhatsAppListChangeParticipant({
      purgeNewlyHiddenInTransaction: () => {
        throw new Error('simulated participant interruption');
      },
    });
    await assert.rejects(
      () => fence(store, hooks).withCurrentVisibility({ accountId }, () => undefined),
      /participant interruption/u,
    );
    store.close();
    store = await openEventDatabase({ stateDir });
    await fence(store).withCurrentVisibility({ accountId }, () => undefined);
    assertRecovered(store);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D9: candidate-stage and either side of a head switch reopen to one authoritative head or no candidate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const crashes = [
    ['after candidate stage', 'BEFORE INSERT ON source_scan_state'],
    ['before head switch', 'BEFORE INSERT ON whatsapp_snapshot_heads'],
    ['after head switch', 'AFTER INSERT ON whatsapp_snapshot_heads'],
  ] as const;
  for (const [phase, timing] of crashes) {
    const stateDir = await shortTempDir('events-wa-candidate-retry-');
    let store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run('candidate-rule@1', 'candidate-rule', '{}', 'digest');
      const worker = new WhatsAppSourceWorker({
        store,
        accountId,
        snapshot: async (work) =>
          work({
            visibility: { version: 1, digest: 'c'.repeat(64), seesMessage: () => true },
            messages: [
              { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
            ],
          }),
        stage: async () => Buffer.from('candidate stage'),
        rules: () => [
          { ruleId: 'candidate-rule', ruleVersion: 1, ingestRetentionMs: 1_000, activationId: 'activation' },
        ],
      });
      store.database.exec(
        `CREATE TRIGGER injected_candidate_fault ${timing}
         BEGIN SELECT RAISE(ABORT, 'simulated ${phase}'); END`,
      );
      await assert.rejects(() => worker.scan(), new RegExp(phase, 'u'));
      store.close();
      store = await openEventDatabase({ stateDir });
      store.database.exec('DROP TRIGGER injected_candidate_fault');
      const retry = new WhatsAppSourceWorker({
        store,
        accountId,
        snapshot: async (work) =>
          work({
            visibility: { version: 1, digest: 'c'.repeat(64), seesMessage: () => true },
            messages: [
              { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
            ],
          }),
        stage: async () => Buffer.from('candidate stage'),
        rules: () => [
          { ruleId: 'candidate-rule', ruleVersion: 1, ingestRetentionMs: 1_000, activationId: 'activation' },
        ],
      });
      await retry.scan();
      assert.deepEqual(
        {
          ...(store.database
            .prepare('SELECT committed_generation FROM whatsapp_snapshot_heads WHERE account_id = ?')
            .get(accountId) as Record<string, unknown>),
        },
        { committed_generation: 1 },
      );
      assert.equal(
        (store.database.prepare('SELECT count(*) AS count FROM whatsapp_occurrences').get() as { count: number }).count,
        1,
      );
    } finally {
      store.close();
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('D9: a sealed synthetic frame consults the one live-list gate immediately before its synchronous callback', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-wa-synthetic-frame-');
  const store = await openEventDatabase({ stateDir });
  try {
    let visible = true;
    let digest = 'd'.repeat(64);
    const current = new WhatsAppVisibilityFence({
      store,
      withCurrentEventVisibility: async (_input, work) => work({ version: 1, digest, seesMessage: () => visible }),
    });
    let writes = 0;
    assert.equal(
      await current.withCurrentSseFrameVisibility(
        { accountId, whatsappMessageId: messageId },
        async () => {},
        () => ++writes,
      ),
      1,
    );
    visible = false;
    digest = 'e'.repeat(64);
    assert.equal(
      await current.withCurrentSseFrameVisibility(
        { accountId, whatsappMessageId: messageId },
        async () => {},
        () => ++writes,
      ),
      undefined,
    );
    assert.equal(writes, 1);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
