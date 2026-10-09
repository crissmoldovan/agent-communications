import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D4a: startup/tick expiry deletes a due source stage before a source can resume it and leaves a content-free terminal row', {
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
    assert.equal(atDeadline.sourceStages, 1);
    assert.equal(store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'stage-expiry'").get(), undefined);
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT outcome, error_code FROM source_occurrence_resolutions WHERE source = 'resend' AND occurrence_key = 'stage-expiry'",
          )
          .get() as Record<string, unknown>),
      },
      { outcome: 'retention-expired', error_code: 'STAGE_EXPIRED' },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
