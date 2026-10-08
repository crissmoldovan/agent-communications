import assert from 'node:assert/strict';
import { readFile, rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { DeliveryDispatcher, type DispatchResult } from '../src/runtime/dispatcher.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'account-1';

async function fixture() {
  const stateDir = await shortTempDir('events-routing-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 1 WHERE singleton = 1');
  const insert = (id: string, targetKey: string) => {
    store.database
      .prepare(
        `INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'gmail.message.received', 1, ?, ?, 1, 1, 1)`,
      )
      .run(`event-${id}`, store.installationId, ACCOUNT, `dedupe-${id}`);
    store.database
      .prepare(
        `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, 'rule-1', 1, 'matched', ?, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT, Date.now() + 60_000);
    store.database
      .prepare(
        `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation, next_at)
         VALUES (?, ?, ?, 'rule-1', 1, ?, 'target-1', 1, ?, ?, 'queued', 1, 0)`,
      )
      .run(id, `decision-${id}`, ACCOUNT, targetKey, Buffer.from(`prepared:${id}`), Date.now() + 60_000);
  };
  return { stateDir, store, insert };
}

function handler(kind: string, calls: string[]) {
  return {
    async dispatch(deliveryId: string): Promise<DispatchResult> {
      calls.push(`${kind}:${deliveryId}`);
      return { state: 'terminal', deliveryId };
    },
  };
}

test('B2-T2: generic dispatch selects exactly one target handler and refuses an unknown persisted kind', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('delivery-dryrun', 'dryrun:target-1:1');
    setup.insert('delivery-webhook', 'webhook:target-1:1');
    setup.insert('delivery-sse', 'sse:target-1:1:subscriber-1:1');
    setup.insert('delivery-unknown', 'queue:target-1:1');
    const calls: string[] = [];
    const dispatcher = new DeliveryDispatcher({
      store: setup.store,
      dryrun: handler('dryrun', calls),
      webhook: handler('webhook', calls),
      sse: handler('sse', calls),
    });

    await dispatcher.dispatch('delivery-dryrun');
    await dispatcher.dispatch('delivery-webhook');
    await dispatcher.dispatch('delivery-sse');
    assert.deepEqual(calls, ['dryrun:delivery-dryrun', 'webhook:delivery-webhook', 'sse:delivery-sse']);
    await assert.rejects(
      dispatcher.dispatch('delivery-unknown'),
      (error: unknown) => error instanceof CommsError && error.code === 'BAD_DATA',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T2: an owner scheduler tick routes every B2 kind without rebuilding its prepared bytes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('delivery-dryrun', 'dryrun:target-1:1');
    setup.insert('delivery-webhook', 'webhook:target-1:1');
    setup.insert('delivery-sse', 'sse:target-1:1:subscriber-1:1');
    const before = new Map(
      (
        setup.store.database.prepare('SELECT id, encrypted_record FROM deliveries').all() as Array<{
          id: string;
          encrypted_record: Uint8Array;
        }>
      ).map((row) => [row.id, Buffer.from(row.encrypted_record)]),
    );
    const calls: string[] = [];
    const dispatcher = new DeliveryDispatcher({
      store: setup.store,
      dryrun: handler('dryrun', calls),
      webhook: handler('webhook', calls),
      sse: handler('sse', calls),
    });
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store),
      activations: { resumeClaimedCompletions: async () => undefined } as never,
      dispatcher,
      expiry: new EventExpiry(setup.store),
      cipher: {} as never,
      approvals: {} as never,
      config: { load: async () => ({ inboxes: { local: { id: ACCOUNT, provider: 'gmail' } } }) } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('routing rows must not start a source poll');
      },
      mailboxLock: {} as never,
    });

    await scheduler.tick();
    assert.deepEqual(calls, ['dryrun:delivery-dryrun', 'sse:delivery-sse', 'webhook:delivery-webhook']);
    for (const row of setup.store.database
      .prepare('SELECT id, encrypted_record FROM deliveries ORDER BY id')
      .all() as Array<{ id: string; encrypted_record: Uint8Array }>) {
      assert.deepEqual(Buffer.from(row.encrypted_record), before.get(row.id), `${row.id} keeps its prepared bytes`);
    }
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('B2-T2: public target acceptance remains dry-run-only while owner scheduling depends on the generic facade', async () => {
  const [documents, scheduler, owner] = await Promise.all([
    readFile(new URL('../src/domain/activation-documents.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/scheduler.ts', import.meta.url), 'utf8'),
    readFile(new URL('../src/runtime/owner.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(documents, /B1 supports only dry-run target documents/);
  assert.doesNotMatch(scheduler, /DryRunDispatcher/);
  assert.match(scheduler, /DeliveryDispatcher/);
  assert.match(owner, /new DeliveryDispatcher/);
});
