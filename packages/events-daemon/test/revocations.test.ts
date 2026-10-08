import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { disableRule, removeTarget } from '../src/runtime/revocations.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-r', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const rule = (version: number) => ({
  ruleId: 'rule-r',
  version,
  source: {
    channel: 'gmail' as const,
    accountIds: ['account-1'],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { constant: 'safe' },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60 - version,
  retention: {
    ingestMs: 604_800_000,
    holdMs: 604_800_000,
    deliveryMs: 604_800_000,
    dryrunMs: 86_400_000,
    sseReplayMs: 604_800_000,
    deadLetterMs: 604_800_000,
    decisionMetadataMs: 7_776_000_000,
  },
});

/** rule-r@1 superseded with retained work, rule-r@2 active behind the pointer. */
async function seeded() {
  const stateDir = await shortTempDir('aev-revoke-');
  const store = await openEventDatabase({ stateDir });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createRule(rule(1));
  versions.createRule(rule(2));
  store.database.exec(
    "UPDATE rule_versions SET state = 'superseded', approval_id = 'ap_1', authorization_activation_id = 'act_1', activated_at = 1, superseded_at = 2 WHERE rule_id = 'rule-r' AND version = 1",
  );
  store.database.exec(
    "UPDATE rule_versions SET state = 'active', approval_id = 'ap_2', authorization_activation_id = 'act_r', activated_at = 2 WHERE rule_id = 'rule-r' AND version = 2",
  );
  store.database.exec(
    "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-r', 2, 'act_r', 1)",
  );
  const cancelled: unknown[] = [];
  const revoker = { cancelForRevocation: async (input: unknown) => void cancelled.push(input) };
  const states = () =>
    store.database
      .prepare(
        "SELECT version, state, revoked_at IS NOT NULL AS revoked FROM rule_versions WHERE rule_id = 'rule-r' ORDER BY version",
      )
      .all()
      .map((row) => ({ ...row }));
  const pointers = () =>
    (
      store.database.prepare("SELECT COUNT(*) AS count FROM active_versions WHERE kind = 'rule'").get() as {
        count: number;
      }
    ).count;
  return { stateDir, store, revoker, cancelled, states, pointers };
}

test('TGT-B1: disabling a rule revokes every live version, superseded ones with retained work included', {
  skip: WINDOWS_SKIP,
}, async () => {
  const world = await seeded();
  try {
    assert.deepEqual(await disableRule(world.store, world.revoker, 'rule-r'), { ruleId: 'rule-r', disabled: true });
    assert.deepEqual(
      world.cancelled,
      [{ ruleId: 'rule-r' }],
      'a claimed completion bound to the rule is cancelled first',
    );
    assert.deepEqual(world.states(), [
      { version: 1, state: 'revoked', revoked: 1 },
      { version: 2, state: 'revoked', revoked: 1 },
    ]);
    assert.equal(world.pointers(), 0);
  } finally {
    world.store.close();
    await rm(world.stateDir, { recursive: true, force: true });
  }
});

test('TGT-B1: removing a target revokes it and every live rule version bound to it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const world = await seeded();
  try {
    assert.deepEqual(await removeTarget(world.store, world.revoker, 'target-r'), {
      targetId: 'target-r',
      removed: true,
    });
    assert.deepEqual(world.cancelled, [{ targetId: 'target-r' }]);
    const revocation = world.store.database
      .prepare("SELECT kind, object_id, version FROM object_revocations WHERE object_id = 'target-r'")
      .get() as Record<string, unknown>;
    assert.deepEqual({ ...revocation }, { kind: 'target', object_id: 'target-r', version: 1 });
    assert.deepEqual(world.states(), [
      { version: 1, state: 'revoked', revoked: 1 },
      { version: 2, state: 'revoked', revoked: 1 },
    ]);
    assert.equal(world.pointers(), 0);
  } finally {
    world.store.close();
    await rm(world.stateDir, { recursive: true, force: true });
  }
});

test('TGT-B1: a revocation purges only the versions it revokes; another live version keeps its authorised work', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-revoke-scope-');
  const store = await openEventDatabase({ stateDir });
  try {
    const versions = new ImmutableVersions(store.database);
    const other = { ...target, targetId: 'target-s' };
    versions.createTarget(target);
    versions.createTarget(other);
    versions.createRule(rule(1));
    versions.createRule({ ...rule(2), targets: [other] });
    store.database.exec(
      "UPDATE rule_versions SET state = 'superseded', approval_id = 'ap_1', authorization_activation_id = 'act_1', activated_at = 1, superseded_at = 2 WHERE rule_id = 'rule-r' AND version = 1",
    );
    store.database.exec(
      "UPDATE rule_versions SET state = 'active', approval_id = 'ap_2', authorization_activation_id = 'act_r', activated_at = 2 WHERE rule_id = 'rule-r' AND version = 2",
    );
    store.database.exec(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', 'rule-r', 2, 'act_r', 1)",
    );
    store.database.exec(
      "INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES ('event-1', 'i', 'gmail.message.received', 1, 'account-1', 'd', 1, 1, 1)",
    );
    for (const version of [1, 2]) {
      store.database
        .prepare(
          "INSERT INTO ingest_rules (event_id, rule_id, rule_version, decision_deadline, encrypted_projection) VALUES ('event-1', 'rule-r', ?, 99, ?)",
        )
        .run(version, new Uint8Array([version]));
    }
    await removeTarget(store, { cancelForRevocation: async () => undefined }, 'target-r');
    const left = store.database
      .prepare("SELECT rule_version FROM ingest_rules WHERE rule_id = 'rule-r' ORDER BY rule_version")
      .all()
      .map((row) => (row as { rule_version: number }).rule_version);
    assert.deepEqual(left, [2], 'only the revoked version 1 lost its projection');
    const states = store.database
      .prepare("SELECT version, state FROM rule_versions WHERE rule_id = 'rule-r' ORDER BY version")
      .all()
      .map((row) => ({ ...(row as object) }));
    assert.deepEqual(states, [
      { version: 1, state: 'revoked' },
      { version: 2, state: 'active' },
    ]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
