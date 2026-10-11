import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { projectB3Doctor } from '../src/runtime/b3-doctor-projection.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { LocalEventSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { createSlackLocalEventSource } from '../src/sources/slack.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

const accountId = 'acc_DOCTORREAPPROVAL';
const companionAccountId = 'acc_DOCTORCOMPANION';
const ruleId = 'rule-doctor-reapproval';
const sourceScope = `slack:${accountId}:C-reapproval`;
const companionScope = `slack:${companionAccountId}:C-reapproval`;

function document(): string {
  return canonicalJson({
    ruleId,
    version: 1,
    source: {
      channel: 'slack',
      accountIds: [accountId, companionAccountId],
      options: { channel: 'slack', conversations: ['C-reapproval'] },
    },
    event: { type: 'slack.message.posted', version: 1 },
    condition: { path: '/id', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [],
    subscribers: [],
    judges: [],
    retention: { ingestMs: 1 },
  });
}

function installActiveRule(database: Awaited<ReturnType<typeof openEventDatabase>>['database']): void {
  const rule = document();
  database
    .prepare(
      `INSERT INTO rule_versions
       (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, 1, ?, ?, 'active', 'approval-doctor-reapproval', 'activation-approved-original', 1)`,
    )
    .run(`${ruleId}@1`, ruleId, rule, sha256Hex(rule));
  database
    .prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, 1, ?, 1)",
    )
    .run(ruleId, 'activation-approved-original');
  database
    .prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES (?, ?, 1, 'slack', ?, ?, ?, 1)`,
    )
    .run(
      'activation-approved-original',
      ruleId,
      accountId,
      sourceScope,
      Buffer.from(JSON.stringify({ timestamp: '1.000000' })),
    );
  database
    .prepare(
      `INSERT INTO rule_activation_points
       (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
       VALUES (?, ?, 1, 'slack', ?, ?, ?, 1)`,
    )
    .run(
      'activation-approved-original',
      ruleId,
      companionAccountId,
      companionScope,
      Buffer.from(JSON.stringify({ timestamp: '1.000000' })),
    );
}

test('B3 doctor K6 re-added account stays awaiting reapproval through restart until a fresh point', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-b3-doctor-k6-');
  let store = await openEventDatabase({ stateDir });
  try {
    installActiveRule(store.database);
    store.database.prepare('UPDATE event_settings SET enabled = 1 WHERE singleton = 1').run();

    // Account removal is authoritative: it cancels orphans and removes the former cut-over before the stable id is
    // re-added. Closing and reopening below deliberately creates a fresh daemon/scheduler rather than retaining any
    // in-memory ready scope or cursor state.
    purgeRemovedAccountWork(store.database, { source: 'slack', accountId }, 10);
    store.close();
    store = await openEventDatabase({ stateDir });

    let now = 100;
    let calls = 0;
    const config = {
      inboxes: {},
      accounts: { readded: { id: accountId, platform: 'slack' } },
    };
    const makeScheduler = () =>
      new EventScheduler({
        store,
        lifecycle: new EventLifecycle(store, () => now),
        activations: { resumeClaimedCompletions: async () => undefined } as never,
        dispatcher: {
          recoverLeases: async () => undefined,
          dispatch: async () => {
            calls += 100;
          },
        } as never,
        expiry: { sweepAll: async () => undefined } as never,
        cipher: { decrypt: async (_location: unknown, record: Uint8Array) => Buffer.from(record) } as never,
        writerQuiescer: testWriterQuiescer(),
        approvals: {} as never,
        config: { load: async () => config } as never,
        taint: {} as never,
        gmailSourceFor: async () => {
          throw new Error('K6 has no Gmail work');
        },
        sourceWorkFor: async () => {
          calls += 1;
          return undefined;
        },
        mailboxLock: new MailboxLock(new SourceScopeLock()),
        sourceRegistry: new LocalEventSourceRegistry([createSlackLocalEventSource()]),
        pollIntervalMs: 1,
        now: () => now,
      });

    const awaiting = await projectB3Doctor({
      database: store.database,
      installationId: store.installationId,
      lifecycle: { enabled: true, paused: false, switchGeneration: 0 },
      protocolVersions: [1],
      now: () => now,
      ports: { assertObjectSecretReady: async () => undefined } as never,
      config: { load: async () => config } as never,
      approvals: { get: async () => null } as never,
      decryptSourceState: async () => null,
    });
    assert.deepEqual(awaiting.awaitingReapproval, [{ accountId, scopeId: sourceScope, status: 'awaitingReapproval' }]);

    await makeScheduler().tick();
    assert.equal(calls, 0, 'the restarted daemon neither polls, backfills, judges, nor delivers the re-added account');
    assert.equal(
      store.database
        .prepare('SELECT 1 FROM cursors WHERE source = ? AND account_id = ? AND cursor_scope = ?')
        .get('slack', accountId, sourceScope),
      undefined,
      'the re-added account cannot install a cursor from its former point',
    );

    // This durable point is the output of a newly approved activation. It replaces the former cut-over rather than
    // restoring it, so the scheduler can start only from the new boundary.
    store.database
      .prepare(
        "UPDATE active_versions SET current_cutover_id = 'activation-approved-fresh' WHERE kind = 'rule' AND object_id = ?",
      )
      .run(ruleId);
    store.database
      .prepare(
        `INSERT INTO rule_activation_points
         (activation_id, rule_id, rule_version, source, account_id, position_scope, encrypted_position, created_at)
         VALUES ('activation-approved-fresh', ?, 1, 'slack', ?, ?, ?, 101)`,
      )
      .run(ruleId, accountId, sourceScope, Buffer.from(JSON.stringify({ timestamp: '2.000000' })));
    now = 101;
    await makeScheduler().tick();
    assert.equal(calls, 1, 'only the fresh approved point admits the first provider turn');

    const fresh = await projectB3Doctor({
      database: store.database,
      installationId: store.installationId,
      lifecycle: { enabled: true, paused: false, switchGeneration: 0 },
      protocolVersions: [1],
      now: () => now,
      ports: { assertObjectSecretReady: async () => undefined } as never,
      config: { load: async () => config } as never,
      approvals: { get: async () => null } as never,
      decryptSourceState: async () => null,
    });
    assert.deepEqual(fresh.awaitingReapproval, [], 'the fresh point clears the dark reapproval state through doctor');
    assert.ok(
      fresh.points.some(
        (point) =>
          point.activationId === 'activation-approved-fresh' &&
          point.accountId === accountId &&
          point.scopeId === sourceScope,
      ),
      'doctor reports the exact fresh account/scope point without its position data',
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
