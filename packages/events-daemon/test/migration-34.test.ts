import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { KeychainSecretStore } from '@agentcomms/core';
import { NO_WORKFLOW_EVENTS } from '../src/runtime/workflow/contracts.ts';
import { newEventId, newRunId } from '../src/runtime/workflow/ids.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { applyMigrations, EVENT_MIGRATIONS, refuseNewerSchema } from '../src/store/migrations.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import { standInHome, standInKeyring, standInSecrets } from './support/stand-ins.ts';
import { OWNER_EXAMPLE, stepContext } from './support/step-context.ts';

/**
 * Migration 34 (workflows design §4.3): runs, waits, effects, worktrees, projects, events, subscriptions and chain
 * requests. Deliveries and the secret slots are rebuilt, keeping every row; everything new is content-free except the
 * sealed records, which a finished run and a settled event no longer hold.
 */

const ACCOUNT = 'ibx_WORKFLOWMIGRATE';
const SESSION = 'sess_0f8fad5b-d9cb-469f-a165-70867728950e';
const RUN = 'wfr_0123456789abcdefghjkmnpqrs';
const EVENT = 'wfe_0123456789abcdefghjkmnpqrs';

const migrateTo = (database: DatabaseSync, version: number) =>
  applyMigrations(
    database,
    EVENT_MIGRATIONS.filter((migration) => migration.version <= version),
  );

const tableExists = (database: DatabaseSync, table: string) =>
  database.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;

const columns = (database: DatabaseSync, table: string): readonly string[] =>
  (database.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{ name: string }>).map((column) => column.name);

/** What deliveries carries beside itself: its indexes and triggers, written by a migration. */
const deliveryArtifacts = (database: DatabaseSync) =>
  database
    .prepare(
      "SELECT type, name FROM sqlite_master WHERE tbl_name = 'deliveries' AND type <> 'table' AND sql IS NOT NULL ORDER BY name",
    )
    .all() as Array<{ type: string; name: string }>;

/** Rows as plain objects: node:sqlite gives each a null prototype. */
const rows = (database: DatabaseSync, sql: string): readonly Record<string, unknown>[] =>
  database
    .prepare(sql)
    .all()
    .map((row) => ({ ...(row as Record<string, unknown>) }));

const countDeliveries = (database: DatabaseSync) =>
  (database.prepare('SELECT COUNT(*) AS count FROM deliveries').get() as { count: number }).count;

/** A v33 store with a decision, a session delivery waiting in its busy queue, a Linear delivery and a subscriber. */
function openAt33WithRows(): DatabaseSync {
  const database = new DatabaseSync(':memory:');
  database.exec('PRAGMA foreign_keys = ON');
  migrateTo(database, 33);
  database.exec(
    `INSERT INTO ingest
       (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
     VALUES ('event-w', 'installation', 'slack.message.posted', 1, '${ACCOUNT}', 'dedupe-w', 1, 1, 1);
     INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
     VALUES ('decision-w', 'event-w', '${ACCOUNT}', 'client-asks', 5, 'matched', 999, 'retained');
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        target_representation, encrypted_record, expires_at, state, switch_generation)
     VALUES ('delivery-session', 'decision-w', '${ACCOUNT}', 'client-asks', 5, 'session:give:2', 'give', 2, 'session',
             'enveloped', X'04', 999, 'queued', 3);
     INSERT INTO deliveries
       (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
        encrypted_record, expires_at, state, switch_generation, linear_issue_id, linear_identifier, linear_url)
     VALUES ('delivery-linear', 'decision-w', '${ACCOUNT}', 'client-asks', 5, 'linear:issues:1', 'issues', 1, 'linear',
             NULL, 999, 'delivered', 3, '0b6a6f0e-8a8e-4c55-9d7c-6a1c0f8b8c11', 'ACME-1',
             'https://linear.app/acme/issue/ACME-1');
     INSERT INTO session_queue (delivery_id, relay_session_id, rule_id, rule_version, target_id, target_version, queued_at)
     VALUES ('delivery-session', '${SESSION}', 'client-asks', 5, 'give', 2, 5);
     INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest)
     VALUES ('sub-1@1', 'sub-1', 1, '{}', 'digest-1'), ('sub-1@2', 'sub-1', 2, '{}', 'digest-2');`,
  );
  return database;
}

function insertDelivery(
  database: DatabaseSync,
  row: { readonly target_kind: string; readonly run_id: string | null; readonly step_id: string | null },
): void {
  database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation, run_id, step_id)
       VALUES (?, 'decision-w', ?, 'client-asks', 5, ?, 'done', 1, ?, X'05', 999, 'queued', 3, ?, ?)`,
    )
    .run(
      `delivery-${row.target_kind}-${row.step_id ?? 'none'}`,
      ACCOUNT,
      `${row.target_kind}:done:1#${row.step_id ?? 'none'}`,
      row.target_kind,
      row.run_id,
      row.step_id,
    );
}

function slot(database: DatabaseSync, ownerKind: string, purpose: string, generation = 1): void {
  database
    .prepare(
      `INSERT INTO event_secret_generations
         (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref,
          lifecycle, expires_at, created_at)
       VALUES (?, 'sub-1', 1, ?, ?, 'owner-digest', ?, X'0102', 'current', NULL, 1)`,
    )
    .run(ownerKind, purpose, generation, `secret-${purpose}-${generation}`);
}

function insertRun(database: DatabaseSync, id: string, state: string, record: Uint8Array | null): void {
  database
    .prepare(
      `INSERT INTO workflow_runs
         (id, decision_id, rule_id, rule_version, account_id, event_id, state, started_at, updated_at, expires_at,
          switch_generation, encrypted_record)
       VALUES (?, 'decision-w', 'client-asks', 5, ?, 'event-w', ?, 1, 1, 999, 3, ?)`,
    )
    .run(id, ACCOUNT, state, record);
}

test('migration 34 makes the workflow, project, event and chain tables', { skip: WINDOWS_SKIP }, () => {
  const db = openAt33WithRows();
  try {
    migrateTo(db, 34);
    for (const table of [
      'workflow_runs',
      'workflow_steps',
      'workflow_waits',
      'workflow_effects',
      'workflow_worktrees',
      'workflow_settings',
      'projects',
      'project_folders',
      'workflow_events',
      'event_deliveries',
      'event_stream_log',
      'workflow_chain_requests',
    ])
      assert.ok(tableExists(db, table), table);
    assert.equal(
      (db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value,
      '34',
    );
    assert.equal(EVENT_MIGRATIONS.find((migration) => migration.version === 34)?.rebuildsParentTable, true);
    assert.deepEqual(
      { ...(db.prepare('SELECT * FROM workflow_settings').get() as Record<string, unknown>) },
      {
        singleton: 1,
        concurrent_runs_max: 16,
        sessions_per_hour_max: 10,
        worktrees_per_day_max: 20,
        events_per_hour_max: 1000,
        updated_at: 0,
      },
      "§7.5's and W33's ceilings, stored so a later command can lower them",
    );
    assert.throws(
      () => db.prepare('UPDATE workflow_settings SET concurrent_runs_max = 17').run(),
      /CHECK constraint failed/u,
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('migration 34 rebuilds deliveries: rows kept, run_id and step_id added, linear-change admitted, triggers back', {
  skip: WINDOWS_SKIP,
}, () => {
  const db = openAt33WithRows();
  try {
    const before = deliveryArtifacts(db);
    const beforeColumns = columns(db, 'deliveries');
    const beforeRows = rows(db, 'SELECT * FROM deliveries ORDER BY rowid');
    const countBefore = countDeliveries(db);
    assert.throws(() => insertDelivery(db, { target_kind: 'linear-change', run_id: null, step_id: null }));
    migrateTo(db, 34);
    assert.deepEqual(
      deliveryArtifacts(db).map((r) => r.name),
      [
        'deliveries_run',
        'deliveries_stable_order',
        'session_queue_goes_with_its_delivery',
        'session_work_goes_with_its_delivery',
      ],
    );
    assert.deepEqual(
      before.map((r) => r.name),
      ['deliveries_stable_order', 'session_queue_goes_with_its_delivery', 'session_work_goes_with_its_delivery'],
    );
    assert.equal(countDeliveries(db), countBefore);
    assert.deepEqual(columns(db, 'deliveries'), [...beforeColumns, 'run_id', 'step_id']);
    assert.deepEqual(
      rows(db, 'SELECT * FROM deliveries ORDER BY rowid'),
      beforeRows.map((row) => ({ ...row, run_id: null, step_id: null })),
      'every row is copied as it was, outside any flow',
    );
    assert.doesNotThrow(() => insertDelivery(db, { target_kind: 'linear-change', run_id: RUN, step_id: 'note' }));
    assert.throws(() => insertDelivery(db, { target_kind: 'linear-change', run_id: RUN, step_id: null }));
    assert.throws(
      () => insertDelivery(db, { target_kind: 'email', run_id: RUN, step_id: 'mail' }),
      /CHECK constraint failed/u,
    );
    db.prepare(
      `UPDATE deliveries SET linear_issue_id = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', linear_identifier = 'ACME-2',
              linear_url = 'https://linear.app/acme/issue/ACME-2' WHERE id = 'delivery-linear-change-note'`,
    ).run();
    assert.throws(
      () =>
        db
          .prepare(
            `UPDATE deliveries SET linear_issue_id = '1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d', linear_identifier = 'ACME-2',
                    linear_url = 'https://linear.app/acme/issue/ACME-2' WHERE id = 'delivery-session'`,
          )
          .run(),
      /CHECK constraint failed/u,
      'an issue is recorded on a Linear delivery only',
    );
    // The busy queue's row still goes with its delivery once the delivery is settled.
    db.prepare(
      "UPDATE deliveries SET state = 'delivered', encrypted_record = NULL WHERE id = 'delivery-session'",
    ).run();
    assert.deepEqual(db.prepare('SELECT delivery_id FROM session_queue').all(), []);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('migration 34 lets a subscriber hold webhook-signing and secret-url, keeping every generation', {
  skip: WINDOWS_SKIP,
}, () => {
  const db = openAt33WithRows();
  try {
    slot(db, 'subscriber', 'sse-bearer');
    slot(db, 'target', 'webhook-signing');
    assert.throws(() => slot(db, 'subscriber', 'webhook-signing'), /CHECK constraint failed/u);
    const before = rows(db, 'SELECT * FROM event_secret_generations ORDER BY rowid');
    migrateTo(db, 34);
    assert.deepEqual(rows(db, 'SELECT * FROM event_secret_generations ORDER BY rowid'), before);
    slot(db, 'subscriber', 'webhook-signing');
    slot(db, 'subscriber', 'secret-url');
    assert.throws(() => slot(db, 'subscriber', 'judge-key'), /CHECK constraint failed/u);
    assert.throws(() => slot(db, 'subscriber', 'sse-bearer'), /UNIQUE constraint failed/u, 'one current generation');
    assert.notEqual(
      db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'event_secret_generations_current'")
        .get(),
      undefined,
      'the one-current-generation index is back',
    );
  } finally {
    db.close();
  }
});

test('one active version per subscriber', { skip: WINDOWS_SKIP }, () => {
  const db = openAt33WithRows();
  try {
    migrateTo(db, 34);
    const setState = (id: string, version: number, state: string) =>
      db
        .prepare('UPDATE subscriber_versions SET state = ? WHERE subscriber_id = ? AND version = ?')
        .run(state, id, version);
    assert.deepEqual(
      rows(db, 'SELECT state, approval_id, activated_at, superseded_at FROM subscriber_versions'),
      [
        { state: null, approval_id: null, activated_at: null, superseded_at: null },
        { state: null, approval_id: null, activated_at: null, superseded_at: null },
      ],
      'a stored subscriber keeps its row as it was',
    );
    setState('sub-1', 1, 'active');
    assert.throws(() => setState('sub-1', 2, 'active'), /UNIQUE constraint failed/u);
    setState('sub-1', 1, 'superseded');
    setState('sub-1', 2, 'active');
    assert.throws(() => setState('sub-1', 1, 'paused'), /CHECK constraint failed/u);
  } finally {
    db.close();
  }
});

test('a finished run holds no sealed record; ids are wfr_ and wfe_ with 26 characters', { skip: WINDOWS_SKIP }, () => {
  const db = openAt33WithRows();
  try {
    migrateTo(db, 34);
    const runId = newRunId();
    const eventId = newEventId();
    assert.match(runId, /^wfr_[0-9a-hjkmnp-tv-z]{26}$/u);
    assert.match(eventId, /^wfe_[0-9a-hjkmnp-tv-z]{26}$/u);
    assert.notEqual(newRunId(), runId);
    insertRun(db, runId, 'running', Uint8Array.of(1, 2));
    assert.throws(
      () => insertRun(db, RUN, 'done', Uint8Array.of(1)),
      /CHECK constraint failed/u,
      'a done run keeps nothing sealed',
    );
    assert.throws(() => insertRun(db, 'run_0123456789abcdefghjkmnpqrs', 'held', null), /CHECK constraint failed/u);
    assert.throws(() => insertRun(db, `${RUN}x`, 'held', null), /CHECK constraint failed/u);
    assert.throws(
      () => db.prepare(`UPDATE workflow_runs SET state = 'done' WHERE id = ?`).run(runId),
      /CHECK constraint failed/u,
    );
    db.prepare(`UPDATE workflow_runs SET state = 'done', encrypted_record = NULL WHERE id = ?`).run(runId);
    assert.throws(
      () => db.prepare('UPDATE workflow_runs SET depth = 1 WHERE id = ?').run(runId),
      /CHECK constraint failed/u,
      'a run at depth 1 has a parent',
    );
    const event = (id: string, state: string, record: Uint8Array | null) =>
      db
        .prepare(
          `INSERT INTO workflow_events
             (id, run_id, step_id, rule_id, rule_version, account_id, type, schema, sequence, raised_at, expires_at,
              state, encrypted_record)
           VALUES (?, ?, 'issue', 'client-asks', 5, ?, 'acme.client-asks.issue.created', 'step.deliver.linear', ?, 1,
                   999, ?, ?)`,
        )
        .run(id, runId, ACCOUNT, id === eventId ? 1 : 2, state, record);
    event(eventId, 'open', Uint8Array.of(9));
    assert.throws(() => event(EVENT, 'done', Uint8Array.of(9)), /CHECK constraint failed/u);
    assert.throws(() => event(EVENT, 'open', null), /CHECK constraint failed/u);
    db.prepare(
      `INSERT INTO workflow_steps (run_id, step_id, state, outcome, output) VALUES (?, 'issue', 'done', 'done', '{}')`,
    ).run(runId);
    assert.throws(
      () =>
        db
          .prepare(`INSERT INTO workflow_steps (run_id, step_id, state, output) VALUES (?, 'find', 'done', '[]')`)
          .run(runId),
      /CHECK constraint failed/u,
      'a done step has an outcome, and an output is an object',
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    db.close();
  }
});

test('an older service refuses the v34 store', { skip: WINDOWS_SKIP }, () => {
  const db = openAt33WithRows();
  try {
    migrateTo(db, 34);
    assert.throws(
      () =>
        refuseNewerSchema(
          db,
          EVENT_MIGRATIONS.filter((migration) => migration.version <= 33),
        ),
      /schema version 34 is newer than this release's schema version 33/u,
    );
    assert.doesNotThrow(() => refuseNewerSchema(db));
  } finally {
    db.close();
  }
});

test('stand-ins: no real home, the file secret store, an in-memory keyring', { skip: WINDOWS_SKIP }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'aev-stand-ins-'));
  try {
    const home = await standInHome(root);
    for (const folder of [home.homeDirectory, home.configDir, home.dataDir]) {
      assert.ok(folder.startsWith(root), `${folder} is under the test's own folder`);
      assert.ok(existsSync(folder), folder);
      assert.deepEqual(await readdir(folder), [], 'each stand-in folder starts empty');
    }
    const opened = await openEventDatabase({ stateDir: join(root, 'state') });
    try {
      await standInSecrets(opened.database);
      assert.deepEqual(
        { ...(opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as object) },
        { value: 'file' },
      );
    } finally {
      opened.close();
    }
    const items = new Map<string, string>();
    const keychain = new KeychainSecretStore(standInKeyring(items), 'synthetic-ns:events');
    await keychain.set('ref-1', 'value-1');
    assert.equal(await keychain.get('ref-1'), 'value-1');
    assert.equal(items.size, 1, 'what the keyring keeps stays in the map the test holds');
    const forgetfulKeyring = standInKeyring(new Map(), { persist: false });
    await new KeychainSecretStore(forgetfulKeyring, 'synthetic-ns:events').set('ref-2', 'value-2');
    assert.equal(await new KeychainSecretStore(forgetfulKeyring, 'synthetic-ns:events').get('ref-2'), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('stepContext stands in for one attempt, recording what the executor charged, judged and fenced', async () => {
  const ctx = stepContext({ stepId: 'tree', outputs: { issue: { delivery: 'd-1', identifier: 'ACME-1' } } });
  assert.equal(ctx.step.kind, 'worktree');
  assert.equal(ctx.rule, OWNER_EXAMPLE);
  assert.equal(ctx.run.ruleId, 'client-asks');
  assert.deepEqual(ctx.output('issue'), { delivery: 'd-1', identifier: 'ACME-1' });
  assert.equal(ctx.output('route'), null);
  assert.deepEqual(ctx.charge('worktree'), { ok: true });
  const route = OWNER_EXAMPLE.flow.steps.route;
  assert.ok(route?.kind === 'route' && route.judge !== undefined);
  const ask = route.judge;
  assert.deepEqual(await ctx.judge(ask, { '/text': 'x' }, 'Is it?'), { kind: 'answer', said: 'yes', score: 0.9 });
  await ctx.fence();
  assert.deepEqual(ctx.charged, ['worktree']);
  assert.equal(ctx.judged[0]?.question, 'Is it?');
  assert.equal(ctx.fenced.count, 1);
  const refused = stepContext({
    stepId: 'start',
    charge: () => ({ ok: false, until: 5 }),
    fence: () => {
      throw new Error('APPROVAL_VOID');
    },
  });
  assert.deepEqual(refused.charge('session-start'), { ok: false, until: 5 });
  await assert.rejects(refused.fence(), /APPROVAL_VOID/u);
  assert.deepEqual(await NO_WORKFLOW_EVENTS.prepare([]), { rows: [] });
});
