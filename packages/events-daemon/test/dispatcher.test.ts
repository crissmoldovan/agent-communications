import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError, canonicalJson, type SecretStore, sha256Hex } from '@agentcomms/core';
import { DryRunDispatcher } from '../src/runtime/dispatcher.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { closeLocalResetBarrier, openLocalResetBarrier } from '../src/runtime/reset.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher, RecordStorageError } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'ibx_ABCDEFGHIJKLMNOP';
let clock = 1_000;

const rule = {
  ruleId: 'rule-dispatch',
  version: 1,
  source: {
    channel: 'gmail',
    accountIds: [ACCOUNT],
    options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { constant: 'safe' },
  targets: [{ targetId: 'target-dispatch', version: 1, kind: 'dry-run', retentionMs: 3_000 }],
  subscribers: [],
  judges: [],
  deliveryRateCap: 1,
  retention: {
    ingestMs: 10_000,
    holdMs: 10_000,
    deliveryMs: 10_000,
    dryrunMs: 3_000,
    sseReplayMs: 10_000,
    deadLetterMs: 10_000,
    decisionMetadataMs: 10_000,
  },
};

const record = Buffer.from(
  JSON.stringify({
    cloudEventBytes: '{"subject":"sender controlled"}',
    untrusted: ['/subject'],
    representation: 'plain',
  }),
);

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref) ?? false;
  }
  invalidate(): void {}
}

async function fixture() {
  clock = 1_000;
  const stateDir = await shortTempDir('events-dispatch-');
  const store = await openEventDatabase({ stateDir });
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7');
  const canonical = canonicalJson(rule);
  store.database
    .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('rule-dispatch@1', rule.ruleId, rule.version, canonical, sha256Hex(canonical));
  const target = canonicalJson(rule.targets[0]);
  store.database
    .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run('target-dispatch@1', 'target-dispatch', 1, target, sha256Hex(target));
  const insert = (id: string, expiresAt = 10_000) => {
    store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, 'gmail.message.received', 1, ?, ?, ?, ?, ?)`,
      )
      .run(`event-${id}`, store.installationId, ACCOUNT, id, clock, clock, clock);
    store.database
      .prepare(
        `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
         VALUES (?, ?, ?, ?, 1, 'delivered', ?, 'retained')`,
      )
      .run(`decision-${id}`, `event-${id}`, ACCOUNT, rule.ruleId, expiresAt);
    store.database
      .prepare(
        `INSERT INTO deliveries (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
                                encrypted_record, expires_at, state, switch_generation)
         VALUES (?, ?, ?, ?, 1, 'dryrun:target-dispatch:1', 'target-dispatch', 1, ?, ?, 'queued', 7)`,
      )
      .run(id, `decision-${id}`, ACCOUNT, rule.ruleId, record, expiresAt);
  };
  const cipher = {
    async encrypt(_: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
    async decrypt(_: unknown, bytes: Uint8Array) {
      return Buffer.from(bytes);
    },
  };
  const dispatcher = (options: Record<string, unknown> = {}) =>
    new DryRunDispatcher({
      store,
      cipher,
      approvals: { get: async () => null },
      config: { load: async () => ({ inboxes: {} }) },
      now: () => clock,
      fence: async () => ({ switchGeneration: 7 }),
      ...options,
    } as unknown as ConstructorParameters<typeof DryRunDispatcher>[0]);
  return { stateDir, store, insert, dispatcher };
}

function count(store: Awaited<ReturnType<typeof openEventDatabase>>, table: string): number {
  return (store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count;
}

test('DEL-B1: one immediate boundary appends encrypted local work, charges its rolling cap, and settles delivery', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('one');
    setup.insert('two');
    assert.deepEqual(await setup.dispatcher().dispatch('one'), { state: 'delivered', deliveryId: 'one' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1);
    assert.equal(count(setup.store, 'dryrun_log'), 1);
    assert.deepEqual(await setup.dispatcher().dispatch('two'), { state: 'waiting-cap', deliveryId: 'two' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1, 'a full cap does not charge queued work');
    assert.equal(count(setup.store, 'dryrun_log'), 1, 'a full cap does not append retained content');
    assert.equal(
      (setup.store.database.prepare("SELECT state FROM deliveries WHERE id = 'two'").get() as { state: string }).state,
      'queued',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('DEL-B1: interruption before commit rolls back charge and append, and a recovered lease charges exactly once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('crash', 100_000);
    await assert.rejects(
      setup
        .dispatcher({
          beforeCommit: () => {
            throw new Error('simulated interruption');
          },
        })
        .dispatch('crash'),
    );
    assert.equal(count(setup.store, 'delivery_cap_charges'), 0);
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    clock += 31_000;
    assert.deepEqual(await setup.dispatcher().dispatch('crash'), { state: 'delivered', deliveryId: 'crash' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1);
    assert.equal(count(setup.store, 'dryrun_log'), 1);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('CAP-B1: a rolling-window slot later releases one queued delivery, while an expired cap-blocked row loses its bytes', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('cap-first', 4_000_000);
    setup.insert('cap-later', 4_000_000);
    setup.insert('cap-expiry', 2_000);
    assert.deepEqual(await setup.dispatcher().dispatch('cap-first'), { state: 'delivered', deliveryId: 'cap-first' });
    assert.deepEqual(await setup.dispatcher().dispatch('cap-later'), { state: 'waiting-cap', deliveryId: 'cap-later' });
    assert.deepEqual(await setup.dispatcher().dispatch('cap-expiry'), {
      state: 'waiting-cap',
      deliveryId: 'cap-expiry',
    });
    clock += 3_600_001;
    assert.deepEqual(await setup.dispatcher().dispatch('cap-later'), { state: 'delivered', deliveryId: 'cap-later' });
    const expired = setup.store.database
      .prepare("SELECT state, encrypted_record FROM deliveries WHERE id = 'cap-expiry'")
      .get() as { state: string; encrypted_record: Uint8Array | null };
    assert.equal(expired.state, 'retention-expired');
    assert.equal(expired.encrypted_record, null);
    assert.equal(count(setup.store, 'delivery_cap_charges'), 2, 'the expiring queued row never consumed a cap charge');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('DEL-B1: dispatch and read refuse at the fence before decrypting sender content', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('fenced');
    let decrypts = 0;
    const refusing = setup.dispatcher({
      cipher: {
        async encrypt(_: unknown, bytes: Uint8Array) {
          return Buffer.from(bytes);
        },
        async decrypt() {
          decrypts += 1;
          return record;
        },
      },
      fence: async () => {
        throw new Error('authority revoked');
      },
    });
    await assert.rejects(refusing.dispatch('fenced'), /authority revoked/);
    assert.equal(decrypts, 0);
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    assert.equal(
      (setup.store.database.prepare("SELECT state FROM deliveries WHERE id = 'fenced'").get() as { state: string })
        .state,
      'queued',
    );
    assert.deepEqual(await setup.dispatcher().dispatch('fenced'), { state: 'delivered', deliveryId: 'fenced' });
    await assert.rejects(refusing.read('fenced'), /authority revoked/);
    assert.equal(decrypts, 0, 'the renderer path must not decrypt after its direct fence refuses');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('P1-B1: an account-removed dispatch refusal terminalises the lease and atomically purges account payloads', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('removed');
    setup.store.database.exec(
      `INSERT INTO source_scan_state
         (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
       VALUES ('stage-removed', 'gmail', '${ACCOUNT}', 'mailbox', 1, 10000, X'01', 1);
       INSERT INTO dryrun_log
         (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
       VALUES ('removed', 'rule-dispatch', 1, 'target-dispatch', 1, 'event-removed', '${ACCOUNT}', X'01', 1, 2000)`,
    );
    const dispatcher = setup.dispatcher({
      fence: async () => {
        throw new CommsError('NOT_FOUND', 'the account was removed', {
          details: { reason: 'ACCOUNT_REMOVED', accountId: ACCOUNT },
        });
      },
    });
    assert.deepEqual(await dispatcher.dispatch('removed'), { state: 'terminal', deliveryId: 'removed' });
    const removed = setup.store.database
      .prepare("SELECT state, encrypted_record, lease_until FROM deliveries WHERE id = 'removed'")
      .get() as { state: string; encrypted_record: Uint8Array | null; lease_until: number | null };
    assert.equal(removed.state, 'in-flight-at-account-removal');
    assert.equal(removed.encrypted_record, null);
    assert.equal(removed.lease_until, null);
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    assert.equal(count(setup.store, 'source_scan_state'), 0);
    assert.equal(count(setup.store, 'ingest_rules'), 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('P1-B1: an account-removed dry-run read purges the retained row and its delivery ciphertext', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('removed-read');
    assert.deepEqual(await setup.dispatcher().dispatch('removed-read'), {
      state: 'delivered',
      deliveryId: 'removed-read',
    });
    const removed = setup.dispatcher({
      fence: async () => {
        throw new CommsError('NOT_FOUND', 'the account was removed', {
          details: { reason: 'ACCOUNT_REMOVED', accountId: ACCOUNT },
        });
      },
    });
    await assert.rejects(
      removed.read('removed-read'),
      (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
    );
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    assert.equal(
      (
        setup.store.database.prepare("SELECT encrypted_record FROM deliveries WHERE id = 'removed-read'").get() as {
          encrypted_record: Uint8Array | null;
        }
      ).encrypted_record,
      null,
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('P1-B1: a scheduler tick sees a removed config account and cancels queued work before it can be claimed', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('removed-on-tick');
    setup.store.database.exec(
      `INSERT INTO source_scan_state
         (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
       VALUES ('stage-removed-on-tick', 'gmail', '${ACCOUNT}', 'mailbox', 1, 10000, X'01', 1);
       INSERT INTO dryrun_log
         (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
       VALUES ('removed-on-tick', 'rule-dispatch', 1, 'target-dispatch', 1, 'event-removed-on-tick', '${ACCOUNT}', X'01', 1, 2000)`,
    );
    const scheduler = new EventScheduler({
      store: setup.store,
      lifecycle: new EventLifecycle(setup.store, () => clock),
      activations: {} as never,
      dispatcher: {} as never,
      expiry: new EventExpiry(setup.store, () => clock),
      cipher: {} as never,
      approvals: {} as never,
      config: { load: async () => ({ inboxes: {} }) } as never,
      taint: {} as never,
      gmailSourceFor: async () => {
        throw new Error('a removed account must not poll');
      },
      mailboxLock: {} as never,
      now: () => clock,
    });
    await scheduler.tick();
    assert.equal(
      (
        setup.store.database.prepare("SELECT state FROM deliveries WHERE id = 'removed-on-tick'").get() as {
          state: string;
        }
      ).state,
      'cancelled',
    );
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    assert.equal(count(setup.store, 'source_scan_state'), 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('DEL-B1: the dispatcher writes packed encrypted dry-run bytes and decrypts only after its read fence', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('encrypted');
    await selectEventSecretStore(setup.store.database, 'file');
    const cipher = new EventRecordCipher(
      setup.store.database,
      await openEventSecretStore({
        database: setup.store.database,
        paths: setup.store.paths,
        configDir: '/srv/config',
        stores: { file: new MemorySecretStore() },
      }),
    );
    const encrypted = await cipher.encrypt(
      { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text', value: 'encrypted' }] },
      record,
    );
    setup.store.database.prepare("UPDATE deliveries SET encrypted_record = ? WHERE id = 'encrypted'").run(encrypted);
    const dispatcher = setup.dispatcher({ cipher });
    assert.deepEqual(await dispatcher.dispatch('encrypted'), { state: 'delivered', deliveryId: 'encrypted' });
    const stored = setup.store.database
      .prepare("SELECT encrypted_record FROM dryrun_log WHERE delivery_id = 'encrypted'")
      .get() as {
      encrypted_record: Uint8Array;
    };
    assert.doesNotMatch(Buffer.from(stored.encrypted_record).toString('utf8'), /sender controlled/);
    assert.equal((await dispatcher.read('encrypted')).record.cloudEventBytes, '{"subject":"sender controlled"}');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('RET-B1: expiry removes queued payloads and retained local ciphertext before a later read can render it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('expiry');
    assert.deepEqual(await setup.dispatcher().dispatch('expiry'), { state: 'delivered', deliveryId: 'expiry' });
    clock += 3_001;
    const result = new EventExpiry(setup.store, () => clock).sweep();
    assert.equal(result.localRecords, 1);
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    await assert.rejects(
      setup.dispatcher().read('expiry'),
      (error: unknown) => (error as { code?: string }).code === 'NOT_FOUND',
    );
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('RST-B1: a closed local reset barrier keeps ordinary content queued until its persisted notice opens it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('reset');
    const barrier = closeLocalResetBarrier(setup.store, {
      targetId: 'target-dispatch',
      targetVersion: 1,
      noticeId: 'reset-notice-1',
      now: clock,
    });
    assert.deepEqual(await setup.dispatcher().dispatch('reset'), { state: 'waiting-reset', deliveryId: 'reset' });
    assert.equal(count(setup.store, 'dryrun_log'), 0);
    assert.equal(
      count(setup.store, 'reset_notices'),
      1,
      'the content-free notice is durable before ordinary work can resume',
    );
    openLocalResetBarrier(setup.store, barrier);
    assert.deepEqual(await setup.dispatcher().dispatch('reset'), { state: 'delivered', deliveryId: 'reset' });
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('RST-B1: an unreadable encrypted delivery closes a fresh local barrier before another ordinary append', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.insert('lost-master');
    const unreadable = setup.dispatcher({
      cipher: {
        async encrypt(_: unknown, bytes: Uint8Array) {
          return Buffer.from(bytes);
        },
        async decrypt() {
          throw new RecordStorageError('RECORD_UNREADABLE_RESET_REQUIRED', 'master is unavailable');
        },
      },
    });
    assert.deepEqual(await unreadable.dispatch('lost-master'), { state: 'unreadable', deliveryId: 'lost-master' });
    const barrier = setup.store.database
      .prepare(
        "SELECT state FROM reset_barriers WHERE target_id = 'target-dispatch' AND target_version = 1 ORDER BY reset_epoch DESC LIMIT 1",
      )
      .get() as { state: string };
    assert.equal(barrier.state, 'closed');
    setup.insert('after-reset');
    assert.deepEqual(await setup.dispatcher().dispatch('after-reset'), {
      state: 'waiting-reset',
      deliveryId: 'after-reset',
    });
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test("CAP-B1: a lowered cap counts the rule's whole rolling window, earlier versions' charges included (D2)", {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    // Version 1 has already delivered once in this hour; version 2, its tightening, keeps the cap at 1.
    setup.insert('earlier');
    assert.deepEqual(await setup.dispatcher().dispatch('earlier'), { state: 'delivered', deliveryId: 'earlier' });
    const v2 = canonicalJson({ ...rule, version: 2 });
    setup.store.database
      .prepare('INSERT INTO rule_versions (id, rule_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
      .run('rule-dispatch@2', rule.ruleId, 2, v2, sha256Hex(v2));
    setup.insert('later');
    setup.store.database.exec("UPDATE decisions SET rule_version = 2 WHERE id = 'decision-later'");
    setup.store.database.exec("UPDATE deliveries SET rule_version = 2 WHERE id = 'later'");
    assert.deepEqual(await setup.dispatcher().dispatch('later'), { state: 'waiting-cap', deliveryId: 'later' });
    assert.equal(count(setup.store, 'delivery_cap_charges'), 1, 'the new version starts no fresh window');
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});

test('RET-B1: the sweep purges an expired projection with its content-free retention-expired decision (D8)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    setup.store.database
      .prepare(
        `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES ('event-projection', ?, 'gmail.message.received', 1, ?, 'projection', 1, 1, 1)`,
      )
      .run(setup.store.installationId, ACCOUNT);
    setup.store.database
      .prepare(
        `INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection)
         VALUES ('event-projection', 'rule-dispatch', 1, 5_000, X'01')`,
      )
      .run();
    clock = 6_000;
    const swept = new EventExpiry(setup.store, () => clock).sweep();
    assert.equal(swept.projections, 1);
    const decision = setup.store.database
      .prepare("SELECT outcome, metadata_expires_at FROM decisions WHERE event_id = 'event-projection'")
      .get() as { outcome: string; metadata_expires_at: number };
    assert.equal(decision.outcome, 'retention-expired');
    assert.equal(decision.metadata_expires_at, 6_000 + rule.retention.decisionMetadataMs);
    assert.equal(count(setup.store, 'ingest_rules'), 0);
  } finally {
    setup.store.close();
    await rm(setup.stateDir, { recursive: true, force: true });
  }
});
