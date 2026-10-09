import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { rawWhatsAppMessageId, WhatsAppSourceWorker } from '../src/sources/whatsapp.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D6: a WhatsApp source commits one raw-key occurrence and ignores sent or unknown rows', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-source-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    let stagedBeforeHead = false;
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_source',
      now: () => 1_000,
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'a'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'two', fromMe: true },
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'three', fromMe: null },
          ],
        }),
      stage: async (message) => {
        stagedBeforeHead = store.database.prepare('SELECT 1 FROM whatsapp_snapshot_heads').get() === undefined;
        return Buffer.from(message.stanzaId);
      },
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    });

    assert.equal(
      rawWhatsAppMessageId('chat@example.test', 'sender@example.test', 'one'),
      '["wa-msg","chat@example.test","sender@example.test","one"]',
    );
    await worker.scan();
    assert.equal(stagedBeforeHead, true);
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_rule_admissions').get() as { n: number }).n,
      1,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: raw sender differences are distinct identities even when a stanza id is the same', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-sender-key-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_sender_key',
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'b'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'one@example.test', stanzaId: 'shared', fromMe: false },
            { chatJid: 'chat@example.test', senderJidRaw: 'two@example.test', stanzaId: 'shared', fromMe: false },
          ],
        }),
      stage: async () => Buffer.from('first representation'),
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    });
    await worker.scan();
    const ids = store.database
      .prepare('SELECT message_id FROM whatsapp_occurrences ORDER BY message_id')
      .all()
      .map((row) => (row as { message_id: string }).message_id);
    assert.deepEqual(ids, [
      '["wa-msg","chat@example.test","one@example.test","shared"]',
      '["wa-msg","chat@example.test","two@example.test","shared"]',
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: the shortest owed retention fixes the first-representation deadline', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('events-whatsapp-deadline-');
  const store = await openEventDatabase({ stateDir });
  try {
    for (const [id, rule] of [
      ['rule-a@1', 'rule-a'],
      ['rule-b@1', 'rule-b'],
    ] as const) {
      store.database
        .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run(id, rule, '{}', `${rule}-digest`);
    }
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_deadline',
      now: () => 1_000,
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'c'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
          ],
        }),
      stage: async () => Buffer.from('first representation'),
      rules: () => [
        { ruleId: 'rule-a', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation-a' },
        { ruleId: 'rule-b', ruleVersion: 1, ingestRetentionMs: 100, activationId: 'activation-b' },
      ],
    });
    await worker.scan();
    assert.deepEqual(
      {
        ...(store.database.prepare('SELECT stage_expires_at FROM whatsapp_occurrences').get() as Record<
          string,
          unknown
        >),
      },
      { stage_expires_at: 1_100 },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: a fenced matching WhatsApp scope delays an account snapshot tuple without observing it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-overlap-fence-');
  const store = await openEventDatabase({ stateDir });
  const chatJid = 'chat-a@example.test';
  let fenced = true;
  try {
    for (const ruleId of ['rule-all', 'rule-chat']) {
      store.database
        .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
        .run(`${ruleId}@1`, ruleId, '{}', `${ruleId}-digest`);
    }
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_overlap_fence',
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'd'.repeat(64), seesMessage: () => true },
          messages: [{ chatJid, senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false }],
        }),
      stage: async () => Buffer.from('first representation'),
      rules: () => [
        {
          ruleId: 'rule-all',
          ruleVersion: 1,
          ingestRetentionMs: 500,
          activationId: 'activation-all',
          options: { channel: 'whatsapp' as const, chats: 'all-allowed' as const },
          activationPointIdentities: new Map([['all-allowed', new Set<string>()]]),
        },
        {
          ruleId: 'rule-chat',
          ruleVersion: 1,
          ingestRetentionMs: 500,
          activationId: 'activation-chat',
          options: { channel: 'whatsapp' as const, chats: [chatJid] },
          activationPointIdentities: new Map([[`chat:${chatJid}`, new Set<string>()]]),
        },
      ],
      scopeIsFenced: (scopeId: string) => fenced && scopeId === `chat:${chatJid}`,
    });
    await worker.scan();
    assert.equal(
      (store.database.prepare('SELECT count(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      0,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS n FROM whatsapp_rule_admissions').get() as { n: number }).n,
      0,
    );

    fenced = false;
    await worker.scan();
    assert.equal(
      (store.database.prepare('SELECT count(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS n FROM whatsapp_rule_admissions').get() as { n: number }).n,
      2,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
