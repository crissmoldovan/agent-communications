import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { stageWhatsAppBaselineSnapshot } from '../src/runtime/source-owner-work.ts';
import { WhatsAppVisibilityFence } from '../src/runtime/whatsapp-visibility.ts';
import { phaseDSourceRegistry } from '../src/sources/registry.ts';
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

test('P1: two WhatsApp raw tuples differing only in trailing whitespace remain distinct byte-for-byte identities', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-raw-space-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('raw-space@1', 'raw-space', '{}', 'raw-space-digest');
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_raw_space',
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'e'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'same', fromMe: false },
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'same ', fromMe: false },
          ],
        }),
      stage: async () => Buffer.from('first representation'),
      rules: () => [{ ruleId: 'raw-space', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    });
    await worker.scan();
    assert.deepEqual(
      (
        store.database.prepare('SELECT message_id FROM whatsapp_occurrences ORDER BY message_id').all() as Array<{
          message_id: string;
        }>
      ).map((row) => row.message_id),
      [
        '["wa-msg","chat@example.test","sender@example.test","same "]',
        '["wa-msg","chat@example.test","sender@example.test","same"]',
      ],
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
  let explicitChatActivationComplete = false;
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
        ...(explicitChatActivationComplete
          ? [
              {
                ruleId: 'rule-chat',
                ruleVersion: 1,
                ingestRetentionMs: 500,
                activationId: 'activation-chat',
                options: { channel: 'whatsapp' as const, chats: [chatJid] },
                activationPointIdentities: new Map([[`chat:${chatJid}`, new Set<string>()]]),
              },
            ]
          : []),
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
    explicitChatActivationComplete = true;
    await worker.scan();
    assert.equal(
      (store.database.prepare('SELECT count(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      1,
    );
    assert.deepEqual(
      store.database
        .prepare(
          `SELECT rule_id, rule_version, admission
             FROM whatsapp_rule_admissions
            ORDER BY rule_id, rule_version`,
        )
        .all()
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [
        { rule_id: 'rule-all', rule_version: 1, admission: 'admitted' },
        { rule_id: 'rule-chat', rule_version: 1, admission: 'admitted' },
      ],
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D5: a replacement baseline stages the old rule’s first representation before excluding the P tuple', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-baseline-stage-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'acc_ABCDEFGHIJKLMNOP';
    const chatJid = 'chat-p@example.test';
    const messageId = rawWhatsAppMessageId(chatJid, 'sender@example.test', 'present-at-p');
    const rule = {
      ruleId: 'old-rule',
      version: 1,
      source: { channel: 'whatsapp', accountIds: [accountId], options: { channel: 'whatsapp', chats: [chatJid] } },
      event: { type: 'whatsapp.message.received', version: 1 },
      retention: { ingestMs: 1_000 },
    };
    store.database.exec('UPDATE event_settings SET enabled = 1, paused = 0, switch_generation = 1');
    store.database
      .prepare(
        `INSERT INTO rule_versions
          (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
         VALUES ('old-rule@1', 'old-rule', 1, ?, 'digest', 'active', 'approval', 'activation-old', 1)`,
      )
      .run(JSON.stringify(rule));
    store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'old-rule', 1, 'activation-old', 1)",
      )
      .run();
    store.database
      .prepare(
        `INSERT INTO rule_activation_points
          (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
         VALUES ('activation-old', 'old-rule', 1, 'whatsapp', ?, ?, ?, 1)`,
      )
      .run(accountId, `chat:${chatJid}`, Buffer.from(JSON.stringify({ baselineIdentities: [] })));
    const visibilityFence = new WhatsAppVisibilityFence({
      store,
      withCurrentEventVisibility: async (_input, work) =>
        work({ version: 1, digest: 'f'.repeat(64), seesMessage: () => true }),
    });
    const baseline = await stageWhatsAppBaselineSnapshot(
      {
        store,
        cipher: {
          encrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
          decrypt: async (_location: unknown, value: Uint8Array) => Buffer.from(value),
        } as never,
        sourceRegistry: phaseDSourceRegistry(),
        whatsappEventOperations: {
          withEventSnapshot: async (_input: unknown, work: (snapshot: unknown) => unknown) =>
            work({
              messages: [
                {
                  chatJid,
                  chatKind: 'unknown',
                  senderJidRaw: 'sender@example.test',
                  stanzaId: 'present-at-p',
                  fromMe: false,
                },
              ],
            } as never),
        } as never,
        whatsappVisibilityFence: visibilityFence,
        now: () => 10,
      },
      accountId,
    );

    assert.deepEqual(baseline.baselineIdentities, [messageId]);
    assert.equal(baseline.baselineGeneration, 1);
    assert.deepEqual(
      store.database
        .prepare(
          'SELECT rule_id, rule_version, admission FROM whatsapp_rule_admissions WHERE account_id = ? AND message_id = ?',
        )
        .all(accountId, messageId)
        .map((row) => ({ ...(row as Record<string, unknown>) })),
      [{ rule_id: 'old-rule', rule_version: 1, admission: 'admitted' }],
      'the replacement rule can exclude the tuple only after the old version owns its first representation',
    );
    assert.ok(
      store.database
        .prepare('SELECT 1 FROM source_scan_state WHERE source = ? AND account_id = ?')
        .get('whatsapp', accountId),
      'the old version has durable ciphertext before the checked snapshot is disposed',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
