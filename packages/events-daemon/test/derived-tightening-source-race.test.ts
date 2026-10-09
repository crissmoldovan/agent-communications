import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { transferStageDebtToDerivedRule } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D3: a source stage transfers parent debt to a derived tightening before the parent can be purged', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-derived-debt-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    db.prepare(
      `INSERT INTO source_scan_state (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
       VALUES ('stage-1', 'whatsapp', 'acct-whatsapp', 'chat:one', 1, 1000, X'00', 1)`,
    ).run();
    db.prepare('INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)').run(
      'stage-1',
      'rule',
      1,
    );
    transferStageDebtToDerivedRule(db, { ruleId: 'rule', parentVersion: 1, childVersion: 2 });
    assert.equal(
      (
        db
          .prepare(
            'SELECT COUNT(*) AS count FROM source_stage_rule_debts WHERE stage_id = ? AND rule_id = ? AND rule_version = 2',
          )
          .get('stage-1', 'rule') as { count: number }
      ).count,
      1,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
