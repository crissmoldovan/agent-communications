import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { type EventOwner, startEventOwner } from '../src/runtime/owner.ts';
import { createB2RetainedContentParticipants } from '../src/runtime/phase-d-b2-retention.ts';
import { NoopDSourceRetentionHooks } from '../src/runtime/phase-d-whatsapp-seam.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'account-retention';
const RULE = 'rule-retention';

class RecordingNoopHooks extends NoopDSourceRetentionHooks {
  readonly listParticipants: unknown[] = [];
  readonly retentionParticipants: unknown[] = [];

  override registerWhatsAppListChangeParticipant(participant: unknown): void {
    this.listParticipants.push(participant);
  }

  override registerRetentionTighteningParticipant(participant: unknown): void {
    this.retentionParticipants.push(participant);
  }
}

async function createStore(prefix: string): Promise<{ readonly stateDir: string; readonly store: EventDatabase }> {
  const stateDir = await shortTempDir(prefix);
  return { stateDir, store: await openEventDatabase({ stateDir }) };
}

function addDShapedDeliveryColumns(store: EventDatabase): void {
  // Phase D owns its real migration.  This fixture models only the nullable columns the participant must use there.
  store.database.exec(`
    ALTER TABLE deliveries ADD COLUMN whatsapp_message_id TEXT;
    ALTER TABLE deliveries ADD COLUMN whatsapp_visibility_version INTEGER;
    CREATE TABLE test_d_visibility (account_id TEXT PRIMARY KEY, version INTEGER NOT NULL, digest TEXT NOT NULL);
  `);
}

function seedRetainedContent(store: EventDatabase): void {
  store.database.exec(`
    INSERT INTO ingest
      (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
    VALUES
      ('event-retention-1', 'installation', 'example.event', 1, '${ACCOUNT}', 'dedupe-1', 1, 1, 1),
      ('event-retention-2', 'installation', 'example.event', 1, '${ACCOUNT}', 'dedupe-2', 1, 1, 1),
      ('event-retention-3', 'installation', 'example.event', 1, '${ACCOUNT}', 'dedupe-3', 1, 1, 1),
      ('event-unrelated', 'installation', 'example.event', 1, 'account-unrelated', 'dedupe-u', 1, 1, 1);
    INSERT INTO rule_versions
      (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
    VALUES
      ('rule-retention@1', '${RULE}', 1, '{}', 'digest-1', 'superseded', 'approval', 'activation', 1),
      ('rule-retention@2', '${RULE}', 2, '{}', 'digest-2', 'active', 'approval', 'activation', 1),
      ('rule-retention@3', '${RULE}', 3, '{}', 'digest-3', 'superseded', 'approval', 'activation', 1),
      ('rule-unrelated@1', 'rule-unrelated', 1, '{}', 'digest-u', 'active', 'approval', 'activation', 1);
    INSERT INTO decisions
      (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
    VALUES
      ('decision-retention-1', 'event-retention-1', '${ACCOUNT}', '${RULE}', 1, 'matched', 99999, 'retained'),
      ('decision-retention-2', 'event-retention-2', '${ACCOUNT}', '${RULE}', 2, 'matched', 99999, 'retained'),
      ('decision-retention-3', 'event-retention-3', '${ACCOUNT}', '${RULE}', 3, 'matched', 99999, 'retained'),
      ('decision-unrelated', 'event-unrelated', 'account-unrelated', 'rule-unrelated', 1, 'matched', 99999, 'retained');
    INSERT INTO deliveries
      (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
       encrypted_record, expires_at, state, switch_generation, dead_lettered_at, dead_letter_expires_at,
       whatsapp_message_id, whatsapp_visibility_version)
    VALUES
      ('delivery-retention-1', 'decision-retention-1', '${ACCOUNT}', '${RULE}', 1, 'webhook:one:1', 'one', 1,
       X'01', 99999, 'dead-lettered', 1, 700, 1800, 'message-hidden', 9),
      ('delivery-retention-2', 'decision-retention-2', '${ACCOUNT}', '${RULE}', 2, 'webhook:two:1', 'two', 1,
       X'02', 99999, 'dead-lettered', 1, 950, 2800, 'message-visible', 9),
      ('delivery-retention-3', 'decision-retention-3', '${ACCOUNT}', '${RULE}', 3, 'webhook:three:1', 'three', 1,
       X'03', 99999, 'dead-lettered', 1, 900, 2800, 'message-revoked', 9),
      ('delivery-unrelated', 'decision-unrelated', 'account-unrelated', 'rule-unrelated', 1, 'webhook:four:1', 'four', 1,
       X'04', 99999, 'dead-lettered', 1, 950, 2800, 'message-unrelated', 9);
    INSERT INTO stream_log
      (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
       event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
       expires_at, switch_generation)
    VALUES
      ('stream-retention-1', 'delivery-retention-1', '${RULE}', 1, 'one', 1, 'subscriber', 1,
       'event-retention-1', '${ACCOUNT}', 'message-hidden', 9, X'11', 700, 1800, 1),
      ('stream-retention-2', 'delivery-retention-2', '${RULE}', 2, 'two', 1, 'subscriber', 1,
       'event-retention-2', '${ACCOUNT}', 'message-visible', 9, X'12', 950, 2800, 1),
      ('stream-retention-3', 'delivery-retention-3', '${RULE}', 3, 'three', 1, 'subscriber', 1,
       'event-retention-3', '${ACCOUNT}', 'message-revoked', 9, X'13', 900, 2800, 1),
      ('stream-unrelated', 'delivery-unrelated', 'rule-unrelated', 1, 'four', 1, 'subscriber', 1,
       'event-unrelated', 'account-unrelated', 'message-unrelated', 9, X'14', 950, 2800, 1);
  `);
}

function streamIds(store: EventDatabase): string[] {
  return (store.database.prepare('SELECT id FROM stream_log ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

test('B2-T8a: the pre-D owner leaves the no-op participant registry empty and loads no D composition', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  const source = await import('node:fs/promises').then(({ readFile }) =>
    readFile(new URL('../src/runtime/owner.ts', import.meta.url), 'utf8'),
  );
  assert.doesNotMatch(source, /createPhaseDWhatsAppOwnerComposition|whatsapp-visibility/);
  assert.doesNotMatch(
    source,
    /retentionHooks\.register(?:WhatsAppListChangeParticipant|RetentionTighteningParticipant)/,
  );

  for (const suffix of ['one', 'two']) {
    const stateDir = await shortTempDir(`events-b2-retention-owner-${suffix}-`);
    const hooks = new RecordingNoopHooks();
    try {
      let owner: EventOwner | null = null;
      try {
        owner = await startEventOwner({ stateDir, dSourceRetentionHooks: hooks });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EPERM') {
          t.skip(
            'the development sandbox blocks Unix-domain listeners; the coordinator runs this owner proof outside it',
          );
          return;
        }
        throw error;
      }
      try {
        assert.deepEqual(hooks.listParticipants, []);
        assert.deepEqual(hooks.retentionParticipants, []);
      } finally {
        await owner?.stop();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('B2-T8a: list participant purges only matching retained content in the caller transaction and rolls back with it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const factoryStore = await createStore('events-b2-retention-factory-');
  const transactionStore = await createStore('events-b2-retention-transaction-');
  try {
    addDShapedDeliveryColumns(transactionStore.store);
    seedRetainedContent(transactionStore.store);
    const participants = createB2RetainedContentParticipants({ database: factoryStore.store });

    transactionStore.store.database.exec('BEGIN IMMEDIATE');
    try {
      assert.equal(
        participants.list.purgeNewlyHiddenInTransaction(transactionStore.store.database, {
          accountId: ACCOUNT,
          newlyHiddenMessageIds: ['message-hidden'],
          visibilityVersion: 10,
          changedAt: '1970-01-01T00:00:01.000Z',
        }),
        undefined,
      );
      transactionStore.store.database
        .prepare('INSERT INTO test_d_visibility (account_id, version, digest) VALUES (?, ?, ?)')
        .run(ACCOUNT, 10, 'digest-after-list-change');
      transactionStore.store.database.exec('COMMIT');
    } catch (error) {
      transactionStore.store.database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(streamIds(transactionStore.store), [
      'stream-retention-2',
      'stream-retention-3',
      'stream-unrelated',
    ]);
    assert.deepEqual(
      {
        ...(transactionStore.store.database
          .prepare("SELECT encrypted_record FROM deliveries WHERE id = 'delivery-retention-1'")
          .get() as { encrypted_record: Uint8Array | null }),
      },
      { encrypted_record: null },
    );
    assert.equal(
      (
        transactionStore.store.database
          .prepare('SELECT version FROM test_d_visibility WHERE account_id = ?')
          .get(ACCOUNT) as {
          version: number;
        }
      ).version,
      10,
    );
    assert.equal(
      (factoryStore.store.database.prepare('SELECT count(*) AS count FROM stream_log').get() as { count: number })
        .count,
      0,
      'the factory database is never used in place of the supplied open transaction',
    );

    transactionStore.store.database.exec('BEGIN IMMEDIATE');
    try {
      participants.list.purgeNewlyHiddenInTransaction(transactionStore.store.database, {
        accountId: ACCOUNT,
        newlyHiddenMessageIds: ['message-visible'],
        visibilityVersion: 11,
        changedAt: '1970-01-01T00:00:01.100Z',
      });
      transactionStore.store.database
        .prepare('UPDATE test_d_visibility SET version = ?, digest = ? WHERE account_id = ?')
        .run(11, 'must-roll-back', ACCOUNT);
      throw new Error('crash before the shared transaction commits');
    } catch {
      transactionStore.store.database.exec('ROLLBACK');
    }
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(streamIds(transactionStore.store), [
      'stream-retention-2',
      'stream-retention-3',
      'stream-unrelated',
    ]);
    assert.deepEqual(
      Buffer.from(
        (
          transactionStore.store.database
            .prepare("SELECT encrypted_record FROM deliveries WHERE id = 'delivery-retention-2'")
            .get() as { encrypted_record: Uint8Array }
        ).encrypted_record,
      ),
      Buffer.from([2]),
    );
    assert.equal(
      (
        transactionStore.store.database
          .prepare('SELECT version FROM test_d_visibility WHERE account_id = ?')
          .get(ACCOUNT) as {
          version: number;
        }
      ).version,
      10,
    );
  } finally {
    factoryStore.store.close();
    transactionStore.store.close();
    await rm(factoryStore.stateDir, { recursive: true, force: true });
    await rm(transactionStore.stateDir, { recursive: true, force: true });
  }
});

test('B2-T8a: retention participant shortens active and superseded rows from their durable clocks and purges revocation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const { stateDir, store } = await createStore('events-b2-retention-tightening-');
  try {
    addDShapedDeliveryColumns(store);
    seedRetainedContent(store);
    const participants = createB2RetainedContentParticipants({ database: store });
    store.database.exec('BEGIN IMMEDIATE');
    try {
      assert.equal(
        participants.retention.shortenOrPurgeInTransaction(store.database, {
          ruleId: RULE,
          affectedVersionIds: ['rule-retention@1', 'rule-retention@2'],
          revokedVersionId: 'rule-retention@3',
          at: '1970-01-01T00:00:01.000Z',
          changes: [
            { retention: 'sse-replay', durationMs: 100 },
            { retention: 'dead-letter', durationMs: 100 },
          ],
        }),
        undefined,
      );
      store.database.exec('COMMIT');
    } catch (error) {
      store.database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(streamIds(store), ['stream-retention-2', 'stream-unrelated']);
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT state, encrypted_record, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = 'delivery-retention-1'",
          )
          .get() as Record<string, unknown>),
      },
      { state: 'retention-expired', encrypted_record: null, dead_lettered_at: 700, dead_letter_expires_at: 800 },
      'the superseded version uses the original persisted dead-letter clock and expires in the shared transaction',
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare(
            "SELECT state, dead_lettered_at, dead_letter_expires_at FROM deliveries WHERE id = 'delivery-retention-2'",
          )
          .get() as Record<string, unknown>),
      },
      { state: 'dead-lettered', dead_lettered_at: 950, dead_letter_expires_at: 1050 },
    );
    assert.deepEqual(
      Buffer.from(
        (
          store.database.prepare("SELECT encrypted_record FROM deliveries WHERE id = 'delivery-retention-2'").get() as {
            encrypted_record: Uint8Array;
          }
        ).encrypted_record,
      ),
      Buffer.from([2]),
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare("SELECT encrypted_record FROM deliveries WHERE id = 'delivery-retention-3'")
          .get() as Record<string, unknown>),
      },
      { encrypted_record: null },
      'the revoked version purges even though it was absent from the retention changes',
    );
    assert.deepEqual(
      {
        ...(store.database.prepare("SELECT expires_at FROM stream_log WHERE id = 'stream-retention-2'").get() as Record<
          string,
          unknown
        >),
      },
      { expires_at: 1050 },
    );
    assert.deepEqual(
      {
        ...(store.database.prepare("SELECT expires_at FROM stream_log WHERE id = 'stream-unrelated'").get() as Record<
          string,
          unknown
        >),
      },
      { expires_at: 2800 },
    );

    store.database.exec('BEGIN IMMEDIATE');
    try {
      participants.retention.shortenOrPurgeInTransaction(store.database, {
        ruleId: RULE,
        affectedVersionIds: ['rule-retention@2'],
        revokedVersionId: 'rule-retention@3',
        at: '1970-01-01T00:00:01.001Z',
        changes: [{ retention: 'ingest', durationMs: 1 }],
      });
      store.database.exec('COMMIT');
    } catch (error) {
      store.database.exec('ROLLBACK');
      throw error;
    }
    assert.deepEqual(
      {
        ...(store.database.prepare("SELECT expires_at FROM stream_log WHERE id = 'stream-retention-2'").get() as Record<
          string,
          unknown
        >),
      },
      { expires_at: 1050 },
      'unrelated retention kinds do not modify B2 retained rows',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

const finalDCompositionExists = existsSync(new URL('../src/runtime/whatsapp-visibility.ts', import.meta.url));

test('B2-T8a: final-D production composition and crash/restart retention contract', {
  skip: finalDCompositionExists
    ? false
    : 'Phase D Task 7 has not supplied the concrete WhatsApp visibility fence and owner composition yet',
}, () => {
  assert.fail('Phase D Task 7 must replace this guard with its concrete production-composition crash matrix');
});
