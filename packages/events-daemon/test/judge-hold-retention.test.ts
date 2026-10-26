import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { claimHeldDecision, sqliteTransactionNow } from '../src/runtime/holds.ts';
import { JudgePurgeParticipant } from '../src/runtime/judge-purge.ts';
import { startEventOwner } from '../src/runtime/owner.ts';
import { shortenRuleRetentionDeadlines } from '../src/runtime/replacements.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { emptyConfigDir } from './support/config-dir.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { noRealHome } from './support/temp-home.ts';

function seedHold(
  store: Awaited<ReturnType<typeof openEventDatabase>>,
  input: Readonly<{ id: string; createdAt: number; deadline: number; stagedAt: number }>,
): void {
  store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 8 WHERE singleton = 1');
  store.database
    .prepare(
      "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, 'gmail.message.received', 1, 'ibx_E8RETENTION', ?, ?, ?, ?)",
    )
    .run(`event:${input.id}`, store.installationId, input.id, input.stagedAt, input.stagedAt, input.stagedAt);
  store.database
    .prepare(
      `INSERT OR IGNORE INTO rule_versions
        (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-e8-retention:1', 'rule-e8-retention', 1, ?, 'digest', 'active', 'approval-e8', 'activation-e8', 1)`,
    )
    .run(
      JSON.stringify({
        source: { channel: 'gmail' },
        retention: {
          ingestMs: 60_000,
          holdMs: 60_000,
          deliveryMs: 60_000,
          dryrunMs: 60_000,
          sseReplayMs: 60_000,
          deadLetterMs: 60_000,
          decisionMetadataMs: 60_000,
        },
      }),
    );
  store.database
    .prepare(
      "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES (?, 'rule-e8-retention', 1, ?, X'01')",
    )
    .run(`event:${input.id}`, input.deadline + 1);
  store.database
    .prepare(
      `INSERT INTO decisions
        (id, event_id, account_id, rule_id, rule_version, outcome, hold_created_at, hold_expires_at, hold_bound_by,
         metadata_expires_at, metadata_state, encrypted_record)
       VALUES (?, ?, 'ibx_E8RETENTION', 'rule-e8-retention', 1, 'hold', ?, ?, 'hold-window', ?, 'retained', X'01')`,
    )
    .run(input.id, `event:${input.id}`, input.createdAt, input.deadline, input.deadline + 60_000);
}

test('E8: expiry uses SQLite time before control despite process-clock rollback and cannot leave a late hold', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-expiry-clock-');
  let store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    seedHold(store, { id: 'hold-e8-clock', createdAt: dbNow - 1_000, deadline: dbNow - 1, stagedAt: dbNow - 2_000 });
    // A restart with an old/rolled-back process clock must not retain or resolve past the DB deadline.
    store.close();
    store = await openEventDatabase({ stateDir });
    new EventExpiry(store, () => 0).sweep();
    assert.equal(
      (store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get('hold-e8-clock') as { outcome: string })
        .outcome,
      'hold-expired',
    );
    assert.deepEqual(claimHeldDecision({ store, decisionId: 'hold-e8-clock', leaseMs: 10_000 }), { kind: 'expired' });

    // Conversely, a skewed-forward process clock must not make the legacy projection sweep purge a hold before
    // SQLite reaches its durable deadline.
    seedHold(store, {
      id: 'hold-e8-fast-process-clock',
      createdAt: dbNow,
      deadline: dbNow + 60_000,
      stagedAt: dbNow,
    });
    new EventExpiry(store, () => dbNow + 120_000).sweep();
    assert.equal(
      (
        store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get('hold-e8-fast-process-clock') as {
          outcome: string;
        }
      ).outcome,
      'hold',
      'only the SQLite-clock hold path may expire a held projection',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E8: tightening recomputes creation-bound hold limits and purge removes the held claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-tightening-');
  const store = await openEventDatabase({ stateDir });
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    seedHold(store, {
      id: 'hold-e8-tighten',
      createdAt: dbNow - 1_000,
      deadline: dbNow + 60_000,
      stagedAt: dbNow - 2_000,
    });
    assert.equal(claimHeldDecision({ store, decisionId: 'hold-e8-tighten', leaseMs: 10_000 }).kind, 'claimed');
    shortenRuleRetentionDeadlines({
      database: store.database,
      ruleId: 'rule-e8-retention',
      now: 0,
      child: {
        retention: {
          ingestMs: 100,
          holdMs: 100,
          deliveryMs: 100,
          dryrunMs: 100,
          sseReplayMs: 100,
          deadLetterMs: 100,
          decisionMetadataMs: 100,
        },
      } as CanonicalFullRuleDocument,
    });
    assert.equal(
      (
        store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get('hold-e8-tighten') as {
          outcome: string;
        }
      ).outcome,
      'retention-expired',
      'ingest retention wins a tightening tie and terminalises inside the pointer transaction',
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM hold_resolution_claims').get() as { count: number }).count,
      0,
      'tightening purge cannot orphan a resolver lease',
    );

    seedHold(store, {
      id: 'hold-e8-purge',
      createdAt: dbNow,
      deadline: dbNow + 60_000,
      stagedAt: dbNow,
    });
    assert.equal(claimHeldDecision({ store, decisionId: 'hold-e8-purge', leaseMs: 10_000 }).kind, 'claimed');
    store.immediate(() =>
      new JudgePurgeParticipant({ database: store.database }).account({
        source: 'gmail',
        accountId: 'ibx_E8RETENTION',
      }),
    );
    assert.equal(
      (store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get('hold-e8-purge') as { outcome: string })
        .outcome,
      'cancelled',
    );
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM hold_resolution_claims').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('E8: owner startup expires a held projection before it exposes its control surface', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-e8-owner-expiry-');
  let store = await openEventDatabase({ stateDir });
  let owner: Awaited<ReturnType<typeof startEventOwner>> | undefined;
  try {
    const dbNow = store.immediate(() => sqliteTransactionNow(store.database));
    seedHold(store, {
      id: 'hold-e8-owner-expiry',
      createdAt: dbNow - 1_000,
      deadline: dbNow - 1,
      stagedAt: dbNow - 2_000,
    });
    store.close();
    owner = await startEventOwner({
      ...noRealHome(stateDir),
      stateDir,
      configDir: await emptyConfigDir(stateDir),
      // The injected process clock is deliberately stale. Only the owner startup transaction's SQLite clock may
      // terminalise the hold before this no-listener control seam is exposed.
      now: () => 0,
      startControlServer: async () => {
        store = await openEventDatabase({ stateDir });
        assert.equal(
          (
            store.database.prepare('SELECT outcome FROM decisions WHERE id = ?').get('hold-e8-owner-expiry') as {
              outcome: string;
            }
          ).outcome,
          'hold-expired',
        );
        store.close();
        return { close: async () => undefined };
      },
    });
  } finally {
    await owner?.stop();
    try {
      store.close();
    } catch {
      // The startup probe and owner each close their own SQLite handles.
    }
    await rm(stateDir, { recursive: true, force: true });
  }
});
