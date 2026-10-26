import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * 0.32.0, owner feedback §3.5: deliveries a person can read. `deliveries list` rows gain the target's kind, the last
 * answer, the decision and event they came from, and when they were delivered where a table keeps that, all additive
 * and content-free.
 */

const ACCOUNT = 'ibx_READABLEDELIVER1';

type Store = Awaited<ReturnType<typeof openEventDatabase>>;

function seedEvent(store: Store, suffix: string): void {
  store.database
    .prepare(
      `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, ?, ?, 1000, 1100, 1100)`,
    )
    .run(`event-${suffix}`, store.installationId, ACCOUNT, `["7","g-${suffix}","received"]`);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES (?, ?, ?, 'rule-readable', 1, 'matched', 999999, 'retained')`,
    )
    .run(`decision-${suffix}`, `event-${suffix}`, ACCOUNT);
}

function seedDryRun(store: Store): void {
  seedEvent(store, 'dry');
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, attempts, next_at, expires_at, state, switch_generation)
       VALUES ('delivery-dry', 'decision-dry', ?, 'rule-readable', 1, 'dryrun:dry-readable:1', 'dry-readable', 1,
               'dry-run', NULL, 1, NULL, 90000, 'delivered', 3)`,
    )
    .run(ACCOUNT);
  store.database
    .prepare(
      `INSERT INTO dryrun_log
         (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record,
          delivered_at, expires_at)
       VALUES ('delivery-dry', 'rule-readable', 1, 'dry-readable', 1, 'event-dry', ?, X'01', 2000, 3000)`,
    )
    .run(ACCOUNT);
}

function seedWebhook(store: Store): void {
  seedEvent(store, 'hook');
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, attempts, next_at, expires_at, state, switch_generation, last_error_code, last_status)
       VALUES ('delivery-hook', 'decision-hook', ?, 'rule-readable', 1, 'webhook:hook-readable:1', 'hook-readable', 1,
               'webhook', X'02', 2, 5000, 90000, 'retryable', 3, 'WEBHOOK_STATUS', 503)`,
    )
    .run(ACCOUNT);
}

async function withControl(work: (store: Store, control: B3OperatorControl) => Promise<void>): Promise<void> {
  const stateDir = await shortTempDir('aev-readable-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      await work(store, new B3OperatorControl({ store, ports: { quiescer: new WriterQuiescer() } }));
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('0.32 B2: deliveries list rows carry the target kind, the last answer, the decision and event, and the delivered time', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withControl(async (store, control) => {
    seedDryRun(store);
    seedWebhook(store);
    const rows = (await control.handle({ operation: 'deliveriesList', args: {} })) as Array<Record<string, unknown>>;
    assert.deepEqual(rows, [
      {
        deliveryId: 'delivery-dry',
        accountId: ACCOUNT,
        ruleId: 'rule-readable',
        ruleVersion: 1,
        targetId: 'dry-readable',
        targetVersion: 1,
        subscriberId: null,
        subscriberVersion: null,
        attempts: 1,
        nextAt: null,
        expiresAt: 90000,
        state: 'delivered',
        switchGeneration: 3,
        deadLetterExpiresAt: null,
        targetKind: 'dry-run',
        lastErrorCode: null,
        lastStatus: null,
        decisionId: 'decision-dry',
        eventId: 'event-dry',
        deliveredAt: 2000,
      },
      {
        deliveryId: 'delivery-hook',
        accountId: ACCOUNT,
        ruleId: 'rule-readable',
        ruleVersion: 1,
        targetId: 'hook-readable',
        targetVersion: 1,
        subscriberId: null,
        subscriberVersion: null,
        attempts: 2,
        nextAt: 5000,
        expiresAt: 90000,
        state: 'retryable',
        switchGeneration: 3,
        deadLetterExpiresAt: null,
        targetKind: 'webhook',
        lastErrorCode: 'WEBHOOK_STATUS',
        lastStatus: 503,
        decisionId: 'decision-hook',
        eventId: 'event-hook',
        deliveredAt: null,
      },
    ]);
    // A dry-run entry past its 24 hours is gone: the delivery stays, and no longer says when it was delivered.
    store.database.exec("DELETE FROM dryrun_log WHERE delivery_id = 'delivery-dry'");
    const after = (await control.handle({ operation: 'deliveriesList', args: {} })) as Array<Record<string, unknown>>;
    assert.equal(after[0]?.deliveredAt, null);
  });
});
