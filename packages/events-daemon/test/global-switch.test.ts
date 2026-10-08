import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

type LifecycleModule = typeof import('../src/runtime/lifecycle.ts');

async function lifecycleModule(): Promise<LifecycleModule | null> {
  return import('../src/runtime/lifecycle.ts').catch(() => null);
}

test('TGT-B1: pause retains state, while disable-all purges B1 content as D12 says and fences stale generations', {
  skip: WINDOWS_SKIP,
}, async () => {
  const lifecycle = await lifecycleModule();
  assert.ok(lifecycle, 'Task 6 supplies the durable lifecycle switch');
  if (!lifecycle) return;

  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-switch-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const switches = new lifecycle.EventLifecycle(opened);
      opened.database
        .prepare(
          "INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES ('scan-1', 'gmail', 'account-1', 'mailbox', ?, 1)",
        )
        .run(new Uint8Array([1]));
      opened.database
        .prepare(
          "INSERT INTO cursors (source, account_id, cursor_scope, cursor, updated_at) VALUES ('gmail', 'account-1', 'mailbox', 'cursor-1', 1)",
        )
        .run();
      opened.database
        .prepare(
          "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-1', 'installation-1', 'example.event', 1, 'account-1', 'dedupe-1', 1, 1, 1)",
        )
        .run();
      opened.database
        .prepare(
          "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-1', 'rule-1', 1, 2, ?)",
        )
        .run(new Uint8Array([2]));
      opened.database
        .prepare(
          "INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state) VALUES ('decision-1', 'event-1', 'account-1', 'rule-1', 1, 'matched', 3, 'retained')",
        )
        .run();
      opened.database
        .prepare(
          "INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation) VALUES ('delivery-1', 'decision-1', 'account-1', 'rule-1', 1, 'dryrun:target-1:1', 'target-1', 1, ?, 4, 'queued', 0)",
        )
        .run(new Uint8Array([3]));
      for (const [id, state] of [
        ['delivery-2', 'retryable'],
        ['delivery-3', 'disclosing'],
        ['delivery-4', 'dead-lettered'],
        ['delivery-5', 'delivered'],
      ] as const) {
        opened.database
          .prepare(
            "INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, encrypted_record, expires_at, state, switch_generation, cap_charged_at) VALUES (?, 'decision-1', 'account-1', 'rule-1', 1, ?, 'target-1', 1, ?, 4, ?, 0, 1)",
          )
          .run(id, `dryrun:target-${id}:1`, new Uint8Array([5]), state);
      }
      opened.database
        .prepare(
          "INSERT INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at) VALUES ('delivery-5', 'rule-1', 1, 1)",
        )
        .run();
      opened.database
        .prepare(
          "INSERT INTO dryrun_log (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at) VALUES ('delivery-1', 'rule-1', 1, 'target-1', 1, 'event-1', 'account-1', ?, 1, 4)",
        )
        .run(new Uint8Array([4]));
      await switches.pause();
      assert.equal(
        (opened.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }).count,
        1,
        'operational pause retains durable work',
      );
      const before = switches.status();
      assert.equal(before.paused, true);
      const disabled = await switches.disableAll();
      assert.equal(disabled.enabled, false);
      assert.equal(disabled.switchGeneration, before.switchGeneration + 1);
      assert.equal(
        (opened.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }).count,
        0,
      );
      assert.equal(disabled.paused, true, 'pause is a separate durable state; disable-all leaves it as it was');
      const count = (table: string) =>
        (opened.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
      for (const table of ['ingest_rules', 'dryrun_log']) assert.equal(count(table), 0, `disable-all purges ${table}`);
      assert.equal(count('cursors'), 1, 'the mailbox cursor survives: an enable-all baseline does not replace it (D8)');
      assert.equal(count('ingest'), 1, 'the content-free ingest identity stays the idempotency boundary');
      assert.equal(count('decisions'), 1, 'a terminal decision is kept');
      assert.equal(count('delivery_cap_charges'), 1, 'cap charges survive, so a later enable-all cannot reset the cap');
      const deliveries = Object.fromEntries(
        (
          opened.database.prepare('SELECT id, state, encrypted_record FROM deliveries ORDER BY id').all() as Array<{
            id: string;
            state: string;
            encrypted_record: Uint8Array | null;
          }>
        ).map((row) => [row.id, { state: row.state, purged: row.encrypted_record === null }]),
      );
      assert.deepEqual(deliveries, {
        'delivery-1': { state: 'cancelled', purged: true },
        'delivery-2': { state: 'cancelled', purged: true },
        'delivery-3': { state: 'in-flight-at-disable', purged: true },
        'delivery-4': { state: 'dead-lettered', purged: true },
        'delivery-5': { state: 'delivered', purged: false },
      });
      assert.throws(
        () => opened.database.prepare("UPDATE deliveries SET state = 'queued' WHERE id = 'delivery-1'").run(),
        /CHECK constraint/,
        'work that may still disclose cannot exist without its payload',
      );
      opened.database.prepare('UPDATE event_settings SET enabled = 1 WHERE singleton = 1').run();
      assert.throws(
        () =>
          switches.commitAtGeneration(before.switchGeneration, () => {
            opened.database
              .prepare(
                "INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES ('scan-stale', 'gmail', 'account-1', 'mailbox', ?, 1)",
              )
              .run(new Uint8Array([2]));
          }),
        /generation|disabled/i,
      );
      assert.equal(
        (opened.database.prepare('SELECT COUNT(*) AS count FROM source_scan_state').get() as { count: number }).count,
        0,
        'a stale writer cannot recreate work after the global disable transaction',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
