import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { assertLiveGmailAccount, purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('TGT-B1: the account fence loads core configuration at each boundary and never retains an account identity', async () => {
  let present = true;
  let loads = 0;
  const config = {
    load: async () => {
      loads += 1;
      return { inboxes: present ? { events: { id: 'account-1', provider: 'gmail' } } : {} };
    },
  };
  await assertLiveGmailAccount(config as never, 'account-1');
  present = false;
  await assert.rejects(
    () => assertLiveGmailAccount(config as never, 'account-1'),
    (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
  );
  assert.equal(loads, 2, 'each boundary reads current configuration rather than a daemon identity cache');
});

test('TGT-B1: an account removal purges its points, resolutions and pending ingest, and revokes the rules only it bound (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-account-purge-');
  const store = await openEventDatabase({ stateDir });
  const removed = 'ibx_REMOVEDREMOVEDRE';
  const kept = 'ibx_KEPTKEPTKEPTKEPT';
  try {
    const db = store.database;
    const rule = db.prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, 'digest', 'active', 'approval', ?, 1)`,
    );
    rule.run('solo@1', 'solo', JSON.stringify({ source: { accountIds: [removed] } }), 'solo@1');
    rule.run('multi@1', 'multi', JSON.stringify({ source: { accountIds: [removed, kept] } }), 'multi@1');
    const pointer = db.prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, ?, 1)",
    );
    pointer.run('solo', 'solo@1');
    pointer.run('multi', 'multi@1');
    const point = db.prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES (?, ?, 1, 'gmail', ?, 'mailbox', X'01', 1)`,
    );
    point.run('solo@1', 'solo', removed);
    point.run('multi@1', 'multi', removed);
    point.run('multi@1', 'multi', kept);
    const resolution = db.prepare(
      `INSERT INTO source_occurrence_resolutions (source, account_id, occurrence_key, outcome, resolved_at)
       VALUES ('gmail', ?, ?, 'vanished', 1)`,
    );
    resolution.run(removed, 'occurrence-removed');
    resolution.run(kept, 'occurrence-kept');
    db.prepare(
      `INSERT INTO source_projection_resolutions
       (source, account_id, occurrence_key, rule_id, rule_version, materialization_key, outcome, resolved_at)
       VALUES ('gmail', ?, 'occurrence-removed', 'multi', 1, 'body', 'vanished', 1)`,
    ).run(removed);
    const ingest = db.prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, 1, 1, 1)`,
    );
    ingest.run('event-pending', store.installationId, removed, 'pending');
    ingest.run('event-decided', store.installationId, removed, 'decided');
    ingest.run('event-kept', store.installationId, kept, 'kept');
    db.prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision', 'event-decided', ?, 'multi', 1, 'delivered', 10, 'retained')`,
    ).run(removed);

    store.immediate(() => purgeRemovedAccountWork(db, removed, 5));

    const count = (sql: string, ...values: string[]) =>
      (db.prepare(`SELECT COUNT(*) AS count FROM ${sql}`).get(...values) as { count: number }).count;
    assert.equal(count('rule_activation_points WHERE account_id = ?', removed), 0, 'no point survives for a reconnect');
    assert.equal(count('rule_activation_points WHERE account_id = ?', kept), 1, 'the other account keeps its point');
    assert.equal(count('source_occurrence_resolutions WHERE account_id = ?', removed), 0);
    assert.equal(count('source_occurrence_resolutions WHERE account_id = ?', kept), 1);
    assert.equal(count('source_projection_resolutions WHERE account_id = ?', removed), 0);
    assert.equal(count("ingest WHERE event_id = 'event-pending'"), 0, 'undecided ingest is purged');
    assert.equal(count("ingest WHERE event_id = 'event-decided'"), 1, "a terminal decision's identity stays");
    assert.equal(count("ingest WHERE event_id = 'event-kept'"), 1);
    const state = (id: string) =>
      (db.prepare('SELECT state FROM rule_versions WHERE id = ?').get(id) as { state: string }).state;
    assert.equal(state('solo@1'), 'revoked', 'a version only the removed account bound is revoked');
    assert.equal(count("active_versions WHERE object_id = 'solo'"), 0, 'and its pointer is gone');
    assert.equal(state('multi@1'), 'active', 'a version that binds another account stays live for it');
    assert.equal(count("active_versions WHERE object_id = 'multi'"), 1);
    assert.equal(count('account_revocations WHERE account_id = ?', removed), 1);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
