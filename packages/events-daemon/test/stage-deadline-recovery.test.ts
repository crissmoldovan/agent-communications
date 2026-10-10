import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D4a: the generic sweep refuses to purge an opaque non-WhatsApp stage without its source continuation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-stage-expiry-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`
      INSERT INTO source_scan_state
        (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
        VALUES ('stage-expiry', 'resend', 'account-1', 'received', 10, 20, X'010203', 10);
      INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version)
        VALUES ('stage-expiry', 'rule-1', 1);
    `);

    const before = new EventExpiry(store, () => 19).sweep();
    assert.equal(before.sourceStages, 0);
    assert.notEqual(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'stage-expiry'").get(),
      undefined,
    );

    const atDeadline = new EventExpiry(store, () => 20).sweep();
    assert.equal(atDeadline.sourceStages, 0);
    assert.notEqual(
      store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'stage-expiry'").get(),
      undefined,
      'only a registered source-specific expiry may decrypt the stage, preserve its continuation, and purge it',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
