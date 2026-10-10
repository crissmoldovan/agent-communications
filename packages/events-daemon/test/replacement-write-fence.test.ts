import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { assertSourceWriteStillLive, sourceRuleSetSnapshot } from '../src/sources/contracts.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D3: a post-await replacement write refuses if the exact source rule set changed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-replacement-write-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    db.exec('UPDATE event_settings SET enabled = 1');
    const scope = { source: 'whatsapp' as const, accountId: 'acct-whatsapp', scopeId: 'chat:one' };
    const snapshot = {
      generation: 0,
      enabled: 1,
      startedAt: 1,
      rules: sourceRuleSetSnapshot([{ ruleId: 'rule', ruleVersion: 1 }]),
    };
    assert.throws(
      () => assertSourceWriteStillLive(db, scope, snapshot, () => [{ ruleId: 'rule', ruleVersion: 2 }]),
      /stale source write/,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
