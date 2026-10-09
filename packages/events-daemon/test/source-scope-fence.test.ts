import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { isSourceScopeFenced } from '../src/sources/source-scope-fence.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D3: every claimed new-only source scope fences exactly itself, while an old drain does not', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-source-fence-');
  const store = await openEventDatabase({ stateDir });
  try {
    const db = store.database;
    const scopes = [
      { source: 'gmail' as const, accountId: 'acct-gmail', scopeId: 'mailbox' },
      { source: 'slack' as const, accountId: 'acct-slack', scopeId: 'conversation:C001' },
      { source: 'resend' as const, accountId: 'acct-resend', scopeId: 'received' },
      { source: 'resend' as const, accountId: 'acct-resend', scopeId: 'status' },
      { source: 'whatsapp' as const, accountId: 'acct-whatsapp', scopeId: 'chat:one' },
    ];
    for (const [index, scope] of scopes.entries()) {
      const intentId = `new-only-${index}`;
      db.prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
         VALUES (?, 'rule', '{}', 'digest', '{}', '[]', '[]', 'pending-completion', 1, 9999999999999, 1, 1)`,
      ).run(intentId);
      db.prepare(
        `INSERT INTO activation_baselines
         (intent_id, source, account_id, position_scope, encrypted_position, response_at)
         VALUES (?, ?, ?, ?, X'00', 1)`,
      ).run(intentId, scope.source, scope.accountId, scope.scopeId);
      assert.equal(isSourceScopeFenced(db, scope), true, `${scope.source}/${scope.scopeId} is fenced`);
    }
    assert.equal(
      isSourceScopeFenced(db, { source: 'slack', accountId: 'acct-slack', scopeId: 'conversation:C002' }),
      false,
      'one Slack conversation cannot fence another',
    );

    const drained = scopes[3] as (typeof scopes)[number];
    db.prepare(
      `INSERT INTO activation_intents
       (id, kind, document, digest, effect, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
       VALUES ('old-drain', 'rule', '{}', 'digest', '{}', '[]', '[]', 'pending-completion', 1, 9999999999999, 1, 1)`,
    ).run();
    db.prepare(
      `INSERT INTO activation_baselines
       (intent_id, source, account_id, position_scope, encrypted_position, response_at)
       VALUES ('old-drain', ?, ?, ?, X'00', 1)`,
    ).run(drained.source, drained.accountId, 'drain-status');
    db.prepare(
      `INSERT INTO replacement_drains (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope)
       VALUES ('old-drain', ?, ?, 'drain-status', 1, 1)`,
    ).run(drained.source, drained.accountId);
    assert.equal(
      isSourceScopeFenced(db, { ...drained, scopeId: 'drain-status' }),
      false,
      'a drain-bearing old scope continues toward P',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
