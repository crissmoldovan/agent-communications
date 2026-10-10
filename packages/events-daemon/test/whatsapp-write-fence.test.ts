import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { WhatsAppSourceWorker } from '../src/sources/whatsapp.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D6: a post-await write fence abandons a prepared WhatsApp candidate before it becomes a head', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-write-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_fence',
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'd'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
          ],
        }),
      stage: async () => Buffer.from('staged before the fence'),
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
      assertWrite: () => {
        throw new Error('account removed after source read');
      },
    });
    await assert.rejects(() => worker.scan(), /account removed/u);
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_heads').get(), undefined);
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_keys').get(), undefined);
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_occurrences').get(), undefined);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: a list change after first representation but before the head transaction abandons the candidate', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-list-write-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    const worker = new WhatsAppSourceWorker({
      store,
      accountId: 'wa_list_fence',
      snapshot: async (work) =>
        work({
          visibility: { version: 1, digest: 'd'.repeat(64), seesMessage: () => true },
          messages: [
            { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
          ],
        }),
      stage: async () => {
        store.immediate(() => {
          store.database
            .prepare('UPDATE whatsapp_visibility SET version = 2, lists_digest = ? WHERE account_id = ?')
            .run('e'.repeat(64), 'wa_list_fence');
        });
        return Buffer.from('staged before the list changed');
      },
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    });
    await assert.rejects(
      () => worker.scan(),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_VOID',
    );
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_heads').get(), undefined);
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_snapshot_keys').get(), undefined);
    assert.equal(store.database.prepare('SELECT 1 FROM whatsapp_occurrences').get(), undefined);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
