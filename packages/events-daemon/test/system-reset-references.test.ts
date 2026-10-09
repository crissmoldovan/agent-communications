import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { createSystemResetOutbox } from '../src/runtime/system-reset-outbox.ts';
import {
  addActiveRuleTargetReferences,
  addRetainedDeliveryTargetReference,
  hasLiveSystemTargetReference,
  purgeUnreferencedSystemTarget,
  removeActiveRuleTargetReferences,
} from '../src/runtime/target-version-references.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('B2-T4: a reset remains until its final active or retained exact-version reference disappears', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b2-refs-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(
      `INSERT INTO target_versions (id, target_id, version, document, digest)
       VALUES ('target-ref@1', 'target-ref', 1, '{}', 'digest');
       INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES
         ('rule-ref@1', 'rule-ref', 1, '{}', 'digest', 'active', 'approval', 'activation', 1),
         ('rule-ref@2', 'rule-ref', 2, '{}', 'digest', 'superseded', 'approval', 'activation', 1);
       INSERT INTO ingest
         (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES ('event-ref', 'install', 'example.event', 1, 'account-ref', 'dedupe', 1, 1, 1);
       INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES ('decision-ref', 'event-ref', 'account-ref', 'rule-ref', 2, 'matched', 99_999, 'retained');
       INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version,
          encrypted_record, expires_at, state, switch_generation)
       VALUES ('delivery-ref', 'decision-ref', 'account-ref', 'rule-ref', 2, 'webhook:target-ref:1',
               'target-ref', 1, X'01', 99_999, 'queued', 1);`,
    );
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-ref',
      ruleVersion: 1,
      targets: [{ targetId: 'target-ref', targetVersion: 1 }],
      createdAt: 1,
    });
    addRetainedDeliveryTargetReference(store.database, {
      deliveryId: 'delivery-ref',
      ruleId: 'rule-ref',
      ruleVersion: 2,
      targetId: 'target-ref',
      targetVersion: 1,
      createdAt: 1,
    });
    createSystemResetOutbox(store, {
      id: 'system-ref',
      resetEpoch: 9,
      targetId: 'target-ref',
      targetVersion: 1,
      encryptedRecord: Buffer.from('reset'),
      createdAt: 1,
    });

    assert.equal(
      hasLiveSystemTargetReference(store.database, { resetEpoch: 9, targetId: 'target-ref', targetVersion: 1, now: 2 }),
      true,
    );
    removeActiveRuleTargetReferences(store.database, 'rule-ref', 1);
    assert.equal(
      purgeUnreferencedSystemTarget(store.database, {
        resetEpoch: 9,
        targetId: 'target-ref',
        targetVersion: 1,
        now: 2,
      }),
      false,
      'retained authorised superseded work keeps the reset',
    );
    store.database
      .prepare("UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL WHERE id = 'delivery-ref'")
      .run();
    assert.equal(
      purgeUnreferencedSystemTarget(store.database, {
        resetEpoch: 9,
        targetId: 'target-ref',
        targetVersion: 1,
        now: 2,
      }),
      true,
    );
    assert.equal(
      (
        store.database.prepare("SELECT count(*) AS count FROM reset_barriers WHERE target_id = 'target-ref'").get() as {
          count: number;
        }
      ).count,
      0,
    );
    assert.equal(
      (
        store.database.prepare("SELECT count(*) AS count FROM system_reset_outbox WHERE id = 'system-ref'").get() as {
          count: number;
        }
      ).count,
      0,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
