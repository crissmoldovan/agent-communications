import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { TargetResumeControl } from '../src/runtime/b3-target-test-control.ts';
import { addActiveRuleTargetReferences } from '../src/runtime/target-version-references.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

test('B3 target resume replaces only a degraded terminal reset with a fresh twenty-attempt 24-hour record', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-resume-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1, switch_generation = 9 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest) VALUES ('target-resume@1', 'target-resume', 1, '{"targetId":"target-resume","version":1,"kind":"dry-run","retentionMs":60000}', 'digest');
      INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('rule-resume@1', 'rule-resume', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
      INSERT INTO system_reset_outbox (id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit, expires_at, state, switch_generation, created_at)
      VALUES ('old-reset', 4, 'target-resume', 1, NULL, 20, 20, 86401000, 'dead-lettered', 9, 1000);
      INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, system_outbox_id, degraded_at)
      VALUES (4, 'target-resume', 1, 'degraded', 'old-reset', 2000);`);
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-resume',
      ruleVersion: 1,
      targets: [{ targetId: 'target-resume', targetVersion: 1 }],
      createdAt: 1,
    });
    const control = new TargetResumeControl({
      store,
      resetSealer: async ({ plaintext }) => Buffer.from(plaintext),
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      now: () => 10_000,
      newId: () => 'fresh-reset',
    });
    assert.deepEqual(await control.resume({ targetId: 'target-resume', targetVersion: 1 }), {
      id: 'fresh-reset',
      resetEpoch: 4,
    });
    const row = store.database
      .prepare('SELECT id, attempts, attempt_limit, expires_at, state FROM system_reset_outbox')
      .get() as Record<string, unknown>;
    assert.deepEqual(
      { ...row },
      { id: 'fresh-reset', attempts: 0, attempt_limit: 20, expires_at: 10_000 + 86_400_000, state: 'queued' },
    );
    assert.deepEqual(
      {
        ...(store.database
          .prepare('SELECT state, system_outbox_id FROM reset_barriers WHERE reset_epoch = 4')
          .get() as Record<string, unknown>),
      },
      { state: 'closed', system_outbox_id: 'fresh-reset' },
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target resume never rewrites retryable reset work as a new notice', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('events-b3-resume-retryable-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1, switch_generation = 3 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest) VALUES ('target-retry@1', 'target-retry', 1, '{"targetId":"target-retry","version":1,"kind":"dry-run","retentionMs":60000}', 'digest');
      INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('rule-retry@1', 'rule-retry', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
      INSERT INTO system_reset_outbox (id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit, next_at, expires_at, state, switch_generation, created_at)
      VALUES ('retryable-reset', 2, 'target-retry', 1, X'01', 1, 20, 1, 86400001, 'retryable', 3, 1);
      INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, system_outbox_id, degraded_at)
      VALUES (2, 'target-retry', 1, 'degraded', 'retryable-reset', 2);`);
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-retry',
      ruleVersion: 1,
      targets: [{ targetId: 'target-retry', targetVersion: 1 }],
      createdAt: 1,
    });
    const control = new TargetResumeControl({
      store,
      resetSealer: async ({ plaintext }) => Buffer.from(plaintext),
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
    });
    await assert.rejects(
      () => control.resume({ targetId: 'target-retry', targetVersion: 1 }),
      /resumable degraded terminal/i,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM system_reset_outbox').get() as { count: number }).count,
      1,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target resume refuses a revoked exact target before it can seal a replacement notice', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-resume-revoked-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1, switch_generation = 4 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest, revoked_at)
      VALUES ('target-resume-revoked@1', 'target-resume-revoked', 1, '{"targetId":"target-resume-revoked","version":1,"kind":"dry-run","retentionMs":60000}', 'digest', 2);
      INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('rule-resume-revoked@1', 'rule-resume-revoked', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
      INSERT INTO system_reset_outbox (id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit, expires_at, state, switch_generation, created_at)
      VALUES ('old-revoked', 3, 'target-resume-revoked', 1, NULL, 20, 20, 86401000, 'dead-lettered', 4, 1000);
      INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, system_outbox_id, degraded_at)
      VALUES (3, 'target-resume-revoked', 1, 'degraded', 'old-revoked', 2000);`);
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-resume-revoked',
      ruleVersion: 1,
      targets: [{ targetId: 'target-resume-revoked', targetVersion: 1 }],
      createdAt: 1,
    });
    let seals = 0;
    const control = new TargetResumeControl({
      store,
      resetSealer: async ({ plaintext }) => {
        seals += 1;
        return Buffer.from(plaintext);
      },
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
    });
    await assert.rejects(
      () => control.resume({ targetId: 'target-resume-revoked', targetVersion: 1 }),
      /resumable degraded terminal/i,
    );
    assert.equal(seals, 0, 'a revoked target cannot create even an encrypted replacement notice');
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target resume purges an orphaned degraded barrier when its final exact reference vanishes during encryption', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-resume-orphan-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1, switch_generation = 5 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest) VALUES ('target-orphan@1', 'target-orphan', 1, '{"targetId":"target-orphan","version":1,"kind":"dry-run","retentionMs":60000}', 'digest');
      INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('rule-orphan@1', 'rule-orphan', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
      INSERT INTO system_reset_outbox (id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit, expires_at, state, switch_generation, created_at)
      VALUES ('old-orphan', 7, 'target-orphan', 1, NULL, 20, 20, 86401000, 'dead-lettered', 5, 1000);
      INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, system_outbox_id, degraded_at)
      VALUES (7, 'target-orphan', 1, 'degraded', 'old-orphan', 2);`);
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-orphan',
      ruleVersion: 1,
      targets: [{ targetId: 'target-orphan', targetVersion: 1 }],
      createdAt: 1,
    });
    const control = new TargetResumeControl({
      store,
      resetSealer: async ({ plaintext }) => {
        store.database.prepare("DELETE FROM target_version_references WHERE rule_id = 'rule-orphan'").run();
        return Buffer.from(plaintext);
      },
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      now: () => 10_000,
    });
    await assert.rejects(
      () => control.resume({ targetId: 'target-orphan', targetVersion: 1 }),
      /final exact-version reference/i,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM reset_barriers').get() as { count: number }).count,
      0,
    );
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM system_reset_outbox').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
