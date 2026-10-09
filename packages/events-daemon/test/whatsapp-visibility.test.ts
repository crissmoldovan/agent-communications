import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { RetainedContentHooks } from '../src/runtime/retained-content-hooks.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const id = '["wa-msg","chat@example.test","sender@example.test","one"]';

test('D6: an unreadable list hides all and does not create a visibility journal row', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-visibility-');
  const store = await openEventDatabase({ stateDir });
  try {
    const fence = new WhatsAppVisibilityFence({
      store,
      withCurrentEventVisibility: async () => {
        throw new Error('list unreadable');
      },
    });
    await assert.rejects(
      () => fence.withCurrentVisibility({ accountId: 'wa_visibility' }, () => undefined),
      /unreadable/u,
    );
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_visibility').get(), undefined);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: a narrowed live list advances the journal and removes newly hidden snapshot membership', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-visibility-');
  const store = await openEventDatabase({ stateDir });
  try {
    let visible = true;
    const fence = new WhatsAppVisibilityFence({
      store,
      now: () => 2_000,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: visible ? 'a'.repeat(64) : 'b'.repeat(64), seesMessage: () => visible }),
    });
    await fence.withCurrentVisibility({ accountId: 'wa_visibility' }, () => undefined);
    store.database
      .prepare(
        'INSERT INTO whatsapp_snapshot_heads (account_id, committed_generation, visibility_version) VALUES (?, 1, 1)',
      )
      .run('wa_visibility');
    store.database
      .prepare(
        `INSERT INTO whatsapp_snapshot_keys (account_id, generation, visibility_version, chat_jid, sender_jid_raw, stanza_id)
         VALUES (?, 1, 1, 'chat@example.test', 'sender@example.test', 'one')`,
      )
      .run('wa_visibility');
    store.database
      .prepare(
        `INSERT INTO whatsapp_occurrences
          (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
         VALUES (?, ?, 1, 1, 1, 'stage', 100)`,
      )
      .run('wa_visibility', id);
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    store.database
      .prepare(
        `INSERT INTO whatsapp_rule_admissions
          (account_id, message_id, rule_id, rule_version, admission, activation_id, visibility_version, admitted_at)
         VALUES (?, ?, 'rule', 1, 'admitted', 'activation', 1, 1)`,
      )
      .run('wa_visibility', id);
    store.database
      .prepare(
        `INSERT INTO ingest
          (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES ('event', 'installation', 'whatsapp.message.received', 1, ?, 'dedupe', 1, 1, 1)`,
      )
      .run('wa_visibility');
    store.database
      .prepare('UPDATE whatsapp_occurrences SET event_id = ? WHERE account_id = ? AND message_id = ?')
      .run('event', 'wa_visibility', id);
    store.database
      .prepare(
        `INSERT INTO ingest_rules
          (event_id, rule_id, rule_version, decision_deadline, encrypted_projection, whatsapp_visibility_version, whatsapp_message_id)
         VALUES ('event', 'rule', 1, 100, X'01', 1, ?)`,
      )
      .run(id);
    store.database
      .prepare(
        `INSERT INTO decisions
          (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state, encrypted_record, whatsapp_message_id)
         VALUES ('decision', 'event', ?, 'rule', 1, 'allow', 100, 'retained', X'01', ?)`,
      )
      .run('wa_visibility', id);
    store.database
      .prepare(
        `INSERT INTO deliveries
          (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
           encrypted_record, expires_at, state, switch_generation, whatsapp_visibility_version, whatsapp_message_id)
         VALUES ('delivery', 'decision', ?, 'rule', 1, 'dryrun:target:1', 'target', 1, X'01', 100, 'queued', 0, 1, ?)`,
      )
      .run('wa_visibility', id);
    store.database
      .prepare(
        `INSERT INTO dryrun_log
          (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
           delivered_at, expires_at, whatsapp_message_id)
         VALUES ('delivery', 'rule', 1, 'target', 1, 'event', ?, X'01', 1, 100, ?)`,
      )
      .run('wa_visibility', id);
    visible = false;
    await fence.withCurrentVisibility({ accountId: 'wa_visibility' }, () => undefined);
    assert.equal(
      (store.database.prepare('SELECT version FROM whatsapp_visibility').get() as { version: number }).version,
      2,
    );
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_keys').get(), undefined);
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT staged_payload_ref, stage_expires_at FROM whatsapp_occurrences')
          .get() as Record<string, unknown>),
      },
      { staged_payload_ref: null, stage_expires_at: null },
    );
    assert.deepEqual(
      {
        ...(store.database.prepare('SELECT admission FROM whatsapp_rule_admissions').get() as Record<string, unknown>),
      },
      { admission: 'suppressed' },
    );
    assert.equal(store.database.prepare('SELECT 1 FROM dryrun_log').get(), undefined);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: a retained-content participant failure rolls back the list journal and D-owned hidden-data purge together', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-visibility-participant-');
  const store = await openEventDatabase({ stateDir });
  try {
    let visible = true;
    const hooks = new RetainedContentHooks();
    hooks.registerWhatsAppListChangeParticipant({
      purgeNewlyHiddenInTransaction: () => {
        throw new Error('participant refuses purge');
      },
    });
    const fence = new WhatsAppVisibilityFence({
      store,
      retainedContentHooks: hooks,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: visible ? 'a'.repeat(64) : 'b'.repeat(64), seesMessage: () => visible }),
    });
    await fence.withCurrentVisibility({ accountId: 'wa_visibility_rollback' }, () => undefined);
    store.database
      .prepare(
        `INSERT INTO whatsapp_occurrences
          (account_id, message_id, first_seen_generation, first_seen_at, visibility_version, staged_payload_ref, stage_expires_at)
         VALUES (?, ?, 1, 1, 1, 'stage', 100)`,
      )
      .run('wa_visibility_rollback', id);
    visible = false;
    await assert.rejects(
      () => fence.withCurrentVisibility({ accountId: 'wa_visibility_rollback' }, () => undefined),
      /participant refuses/u,
    );
    assert.deepEqual(
      {
        ...(store.database.prepare('SELECT version, lists_digest FROM whatsapp_visibility').get() as Record<
          string,
          unknown
        >),
      },
      { version: 1, lists_digest: 'a'.repeat(64) },
    );
    assert.deepEqual(
      {
        ...(store.database.prepare('SELECT staged_payload_ref FROM whatsapp_occurrences').get() as Record<
          string,
          unknown
        >),
      },
      { staged_payload_ref: 'stage' },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
