import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import {
  claimSystemResetOutbox,
  completeSystemResetClaim,
  createSystemResetOutbox,
  SYSTEM_RESET_ATTEMPT_LIMIT,
  SYSTEM_RESET_RETENTION_MS,
  systemResetControlData,
} from '../src/runtime/system-reset-outbox.ts';
import { addActiveRuleTargetReferences } from '../src/runtime/target-version-references.ts';
import { encodeAad } from '../src/store/aad.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('B2-T4: reset work is cap-free system work with a dedicated AAD and preserves the B1 local notice link', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-reset-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES
         ('target-reset@2', 'target-reset', 2, '{}', 'digest'),
         ('target-unreferenced@1', 'target-unreferenced', 1, '{}', 'digest');
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-reset@1', 'rule-reset', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);
       INSERT INTO reset_notices (id, reset_epoch, target_id, target_version, created_at)
       VALUES ('local-notice', 4, 'target-reset', 2, 1);
       INSERT INTO reset_barriers (reset_epoch, target_id, target_version, state, reset_delivery_id)
       VALUES (4, 'target-reset', 2, 'closed', 'local-notice');`,
    );
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-reset',
      ruleVersion: 1,
      targets: [{ targetId: 'target-reset', targetVersion: 2 }],
      createdAt: 1,
    });
    assert.throws(
      () =>
        createSystemResetOutbox(store, {
          id: 'system-reset-unreferenced',
          resetEpoch: 4,
          targetId: 'target-unreferenced',
          targetVersion: 1,
          encryptedRecord: Buffer.from('reset without authority'),
          createdAt: 1_000,
        }),
      /no live exact target reference/,
      'a reset cannot manufacture a barrier for an inert target version',
    );
    createSystemResetOutbox(store, {
      id: 'system-reset-1',
      resetEpoch: 4,
      targetId: 'target-reset',
      targetVersion: 2,
      encryptedRecord: Buffer.from('fixed reset bytes'),
      createdAt: 1_000,
    });
    assert.deepEqual(
      systemResetControlData({
        resetEpoch: 4,
        newInstallationId: 'new-installation',
        previousInstallationId: 'previous-installation',
        reasonCode: 'MASTER_LOST',
      }),
      {
        resetEpoch: 4,
        newInstallationId: 'new-installation',
        previousInstallationId: 'previous-installation',
        reasonCode: 'MASTER_LOST',
        eventIdsRestart: true,
      },
      'a reset carries only its D6 control data',
    );
    const row = store.database
      .prepare(
        `SELECT id, reset_epoch, target_id, target_version, encrypted_record, attempts, attempt_limit,
                created_at, expires_at, state
         FROM system_reset_outbox WHERE id = 'system-reset-1'`,
      )
      .get() as Record<string, unknown>;
    assert.deepEqual(
      {
        ...row,
        encrypted_record: Buffer.from(row.encrypted_record as Uint8Array).toString(),
      },
      {
        id: 'system-reset-1',
        reset_epoch: 4,
        target_id: 'target-reset',
        target_version: 2,
        encrypted_record: 'fixed reset bytes',
        attempts: 0,
        attempt_limit: SYSTEM_RESET_ATTEMPT_LIMIT,
        created_at: 1_000,
        expires_at: 1_000 + SYSTEM_RESET_RETENTION_MS,
        state: 'queued',
      },
    );
    const barrier = store.database
      .prepare(
        'SELECT reset_delivery_id, system_outbox_id FROM reset_barriers WHERE reset_epoch = 4 AND target_id = ? AND target_version = 2',
      )
      .get('target-reset') as { reset_delivery_id: string; system_outbox_id: string };
    assert.deepEqual(
      { ...barrier },
      { reset_delivery_id: 'local-notice', system_outbox_id: 'system-reset-1' },
      'the local B1 notice is independent from the system-reset delivery',
    );
    for (const table of ['decisions', 'deliveries', 'delivery_cap_charges'] as const) {
      assert.equal(
        (store.database.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count,
        0,
        `a reset never manufactures ordinary ${table}`,
      );
    }
    assert.ok(
      encodeAad('system_reset_outbox', 'encryptedRecord', [{ type: 'text', value: 'system-reset-1' }]).byteLength > 0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T5: reset recovery replaces the attempt token without creating an ordinary cap charge', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-reset-claim-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES ('target-reset-claim@1', 'target-reset-claim', 1, '{}', 'digest');
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES ('rule-reset-claim@1', 'rule-reset-claim', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);`,
    );
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-reset-claim',
      ruleVersion: 1,
      targets: [{ targetId: 'target-reset-claim', targetVersion: 1 }],
      createdAt: 1,
    });
    createSystemResetOutbox(store, {
      id: 'system-reset-claim',
      resetEpoch: 1,
      targetId: 'target-reset-claim',
      targetVersion: 1,
      encryptedRecord: Buffer.from('fixed reset bytes'),
      createdAt: 1,
    });
    const first = claimSystemResetOutbox({
      store,
      outboxId: 'system-reset-claim',
      now: 10,
      leaseMs: 5,
      newAttemptId: () => 'attempt-reset-1',
      newLeaseToken: () => 'token-reset-1',
    });
    assert.equal(first.kind, 'claimed');
    const recovered = claimSystemResetOutbox({
      store,
      outboxId: 'system-reset-claim',
      now: 15,
      leaseMs: 5,
      newAttemptId: () => 'attempt-reset-2',
      newLeaseToken: () => 'token-reset-2',
    });
    assert.equal(recovered.kind, 'claimed');
    assert.equal(
      completeSystemResetClaim(store, first.claim, { state: 'delivered' }),
      false,
      'the former reset owner cannot settle the recovered attempt',
    );
    assert.equal(completeSystemResetClaim(store, recovered.claim, { state: 'delivered' }), true);
    assert.equal(
      (store.database.prepare('SELECT count(*) AS count FROM delivery_cap_charges').get() as { count: number }).count,
      0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
