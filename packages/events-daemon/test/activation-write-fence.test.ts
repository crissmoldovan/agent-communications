import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { assertSourceWriteStillLive, sourceRuleSetSnapshot } from '../src/sources/contracts.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D3: a post-await baseline write refuses once a newly claimed baseline fences its source scope', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-activation-write-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    db.exec('UPDATE event_settings SET enabled = 1');
    const scope = { source: 'resend' as const, accountId: 'acct-resend', scopeId: 'received' };
    const snapshot = { generation: 0, enabled: 1, startedAt: 1, rules: sourceRuleSetSnapshot([]) };
    assert.doesNotThrow(() => assertSourceWriteStillLive(db, scope, snapshot, () => []));
    db.exec('UPDATE event_settings SET switch_generation = 1');
    assert.throws(() => assertSourceWriteStillLive(db, scope, snapshot, () => []), /stale source write/);
    db.exec('UPDATE event_settings SET switch_generation = 0');
    db.prepare('INSERT INTO account_revocations (account_id, revoked_at) VALUES (?, ?)').run(scope.accountId, 1);
    assert.throws(() => assertSourceWriteStillLive(db, scope, snapshot, () => []), /stale source write/);
    db.prepare('DELETE FROM account_revocations WHERE account_id = ?').run(scope.accountId);
    db.prepare(
      `INSERT INTO activation_intents
       (id, kind, document, digest, effect, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
       VALUES ('claim', 'rule', '{}', 'digest', '{}', '[]', '[]', 'pending-completion', 1, 9999999999999, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
       VALUES ('claim', 'resend', 'acct-resend', 'received', X'00', 1)`,
    ).run();
    assert.throws(() => assertSourceWriteStillLive(db, scope, snapshot, () => []), /stale source write/);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
