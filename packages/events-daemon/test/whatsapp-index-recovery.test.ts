import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { withEventSnapshot } from '../../whatsapp/src/operations/events.ts';
import { newHarness } from '../../whatsapp/test/support/harness.ts';
import { type WhatsAppEventSnapshot, WhatsAppSourceWorker } from '../src/sources/whatsapp.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D6: a source rebuild repeats the committed raw-key comparison and does not duplicate its ledger', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-index-recovery-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    const snapshot = async <T>(work: (snapshot: WhatsAppEventSnapshot) => Promise<T> | T): Promise<T> =>
      work({
        visibility: { version: 1, digest: 'e'.repeat(64), seesMessage: () => true },
        messages: [
          { chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false },
        ],
      });
    const options = {
      store,
      accountId: 'wa_recovery',
      snapshot,
      stage: async () => Buffer.from('first representation'),
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    };
    await new WhatsAppSourceWorker(options).scan();
    // This stands in for a channel-only index reset: it has no D database handle and therefore cannot clear the head.
    await new WhatsAppSourceWorker(options).scan();
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_rule_admissions').get() as { n: number }).n,
      1,
    );
    assert.equal(
      (
        store.database.prepare('SELECT committed_generation FROM whatsapp_snapshot_heads').get() as {
          committed_generation: number;
        }
      ).committed_generation,
      2,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D6: a tuple that reappears after an index-only reset advances the snapshot without a second admission', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-reappears-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    let present = true;
    let staged = 0;
    const options = {
      store,
      accountId: 'wa_reappears',
      snapshot: async <T>(work: (snapshot: WhatsAppEventSnapshot) => Promise<T> | T): Promise<T> =>
        work({
          visibility: { version: 1, digest: 'f'.repeat(64), seesMessage: () => true },
          messages: present
            ? [{ chatJid: 'chat@example.test', senderJidRaw: 'sender@example.test', stanzaId: 'one', fromMe: false }]
            : [],
        }),
      stage: async () => {
        staged += 1;
        return Buffer.from('first representation');
      },
      rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
    };
    await new WhatsAppSourceWorker(options).scan();
    present = false;
    await new WhatsAppSourceWorker(options).scan();
    // A channel reset is source-local. Reusing the worker after it stands in for raw rows rebuilt under new Z_PK values.
    present = true;
    await new WhatsAppSourceWorker(options).scan();
    assert.equal(staged, 1);
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

test('D6: the real channel-only index reset cannot clear a committed D-owned head or either ledger', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-whatsapp-channel-reset-');
  const harness = await newHarness({ env: { AGENT_COMMS_STATE_DIR: stateDir } });
  const store = await openEventDatabase({ stateDir });
  try {
    await harness.ready();
    const accountId = String(harness.coreConfig().accounts['acme/whatsapp']?.id);
    store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('rule@1', 'rule', '{}', 'rule-digest');
    const worker = () =>
      new WhatsAppSourceWorker({
        store,
        accountId,
        snapshot: async (work) => withEventSnapshot(harness.context(), { accountId }, work),
        stage: async () => Buffer.from('first representation'),
        rules: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 500, activationId: 'activation' }],
      });
    await worker().scan();
    const before = {
      head: store.database.prepare('SELECT committed_generation FROM whatsapp_snapshot_heads').get(),
      occurrences: store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_occurrences').get(),
      admissions: store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_rule_admissions').get(),
    };
    await harness.resetAndRebuildAllIndexState();
    assert.deepEqual(
      store.database.prepare('SELECT committed_generation FROM whatsapp_snapshot_heads').get(),
      before.head,
    );
    assert.deepEqual(
      store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_occurrences').get(),
      before.occurrences,
    );
    assert.deepEqual(
      store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_rule_admissions').get(),
      before.admissions,
    );
    await worker().scan();
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_occurrences').get() as { n: number }).n,
      (before.occurrences as { n: number }).n,
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS n FROM whatsapp_rule_admissions').get() as { n: number }).n,
      (before.admissions as { n: number }).n,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
    await rm(harness.root, { recursive: true, force: true });
  }
});
