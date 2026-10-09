import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { initialCursorStillCurrent, publishedSourcePointSet } from '../src/sources/source-scope-fence.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D3: an initial cursor re-reads its source point set and its scope fence inside the insert transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-initial-cursor-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    const scope = { source: 'slack' as const, accountId: 'acct-slack', scopeId: 'conversation:C001' };
    db.prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('act-one', 'rule-one', 1, 'slack', 'acct-slack', 'conversation:C001', X'01', 1)`,
    ).run();
    db.prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-one', 1, 'act-one', 1)",
    ).run();
    const before = publishedSourcePointSet(db, scope);
    assert.equal(initialCursorStillCurrent(db, scope, before), true);
    db.prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES ('act-two', 'rule-two', 1, 'slack', 'acct-slack', 'conversation:C001', X'02', 2)`,
    ).run();
    db.prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-two', 1, 'act-two', 2)",
    ).run();
    assert.equal(
      initialCursorStillCurrent(db, scope, before),
      false,
      'a point published while decrypting makes the cursor stale',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
