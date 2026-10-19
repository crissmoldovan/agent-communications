import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { TEST_CLOUD_EVENT_BYTES } from '@agentcomms/events';
import { B3TargetTestControl } from '../src/runtime/b3-target-test-control.ts';
import { addActiveRuleTargetReferences } from '../src/runtime/target-version-references.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

function installLiveDryRunTarget(store: EventDatabase, targetId: string, versions: readonly number[]): void {
  store.database.exec('UPDATE event_settings SET enabled = 1 WHERE singleton = 1');
  const insertTarget = store.database.prepare(
    'INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)',
  );
  const insertRule = store.database.prepare(
    `INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
     VALUES (?, ?, ?, '{}', 'digest', 'active', 'approval', 'activation', 1)`,
  );
  for (const version of versions) {
    const target = { targetId, version, kind: 'dry-run', retentionMs: 60_000 };
    const ruleId = `rule-${targetId}-${version}`;
    insertTarget.run(
      `${targetId}@${version}`,
      targetId,
      version,
      canonicalJson(target),
      sha256Hex(canonicalJson(target)),
    );
    insertRule.run(`${ruleId}@${version}`, ruleId, version);
    addActiveRuleTargetReferences(store.database, {
      ruleId,
      ruleVersion: version,
      targets: [{ targetId, targetVersion: version }],
      createdAt: 1,
    });
  }
}

function targetTestControl(
  store: EventDatabase,
  options: {
    readonly now?: () => number;
    readonly transport: (input: { readonly bytes: string }) => Promise<void>;
  },
): B3TargetTestControl {
  return new B3TargetTestControl({
    store,
    ports: {
      quiescer: testWriterQuiescer(),
      secrets: {} as never,
      assertObjectSecretReady: async () => ({ ready: true as const }),
    },
    transport: async ({ bytes }) => options.transport({ bytes }),
    now: options.now,
  });
}

test('B3 target test sends exactly ten fixed synthetic attempts across versions, rejects caller content, and refuses the eleventh before transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-test-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 7 WHERE singleton = 1');
    const target = { targetId: 'target-test', version: 1, kind: 'dry-run', retentionMs: 60_000 };
    const rule = {
      ruleId: 'rule-test',
      version: 1,
      source: {
        channel: 'gmail',
        accountIds: ['ibx_ABCDEFGHIJKLMNOP'],
        options: { channel: 'gmail', labels: 'inbox', includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      mapping: { subject: { $path: '/subject' } },
      targets: [target],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 60_000,
        holdMs: 60_000,
        deliveryMs: 60_000,
        dryrunMs: 60_000,
        sseReplayMs: 60_000,
        deadLetterMs: 60_000,
        decisionMetadataMs: 60_000,
      },
    };
    const targetV2 = { targetId: 'target-test', version: 2, kind: 'dry-run', retentionMs: 60_000 };
    const ruleV2 = { ...rule, version: 2, targets: [targetV2] };
    store.database
      .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 1, ?, ?)')
      .run('target-test@1', 'target-test', canonicalJson(target), sha256Hex(canonicalJson(target)));
    store.database
      .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, 2, ?, ?)')
      .run('target-test@2', 'target-test', canonicalJson(targetV2), sha256Hex(canonicalJson(targetV2)));
    store.database
      .prepare(`INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES (?, ?, 1, ?, ?, 'active', 'approval', 'activation', 1)`)
      .run('rule-test@1', 'rule-test', canonicalJson(rule), sha256Hex(canonicalJson(rule)));
    store.database
      .prepare(`INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES (?, ?, 2, ?, ?, 'active', 'approval', 'activation', 1)`)
      .run('rule-test@2', 'rule-test', canonicalJson(ruleV2), sha256Hex(canonicalJson(ruleV2)));
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-test',
      ruleVersion: 1,
      targets: [{ targetId: 'target-test', targetVersion: 1 }],
      createdAt: 1,
    });
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-test',
      ruleVersion: 2,
      targets: [{ targetId: 'target-test', targetVersion: 2 }],
      createdAt: 1,
    });
    const sent: string[] = [];
    const control = new B3TargetTestControl({
      store,
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      transport: async ({ bytes }) => {
        sent.push(bytes);
      },
    });
    await assert.rejects(
      () =>
        control.test({
          kind: 'active',
          targetId: 'target-test',
          targetVersion: 1,
          content: 'caller-controlled',
        } as never),
      /caller content|exact selector/i,
    );
    assert.equal(sent.length, 0, 'a caller-supplied body must be refused before the transport');
    for (let attempt = 0; attempt < 10; attempt += 1)
      await control.test({ kind: 'active', targetId: 'target-test', targetVersion: attempt % 2 === 0 ? 1 : 2 });
    await assert.rejects(() => control.test({ kind: 'active', targetId: 'target-test', targetVersion: 1 }), /limit/i);
    assert.deepEqual(sent, Array(10).fill(TEST_CLOUD_EVENT_BYTES));
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test refuses an unreferenced exact version before its synthetic transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-unreferenced-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest)
      VALUES ('target-unreferenced@1', 'target-unreferenced', 1, '{"targetId":"target-unreferenced","version":1,"kind":"dry-run","retentionMs":60000}', 'digest');`);
    let sends = 0;
    const control = new B3TargetTestControl({
      store,
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      transport: async () => {
        sends += 1;
      },
    });
    await assert.rejects(
      () => control.test({ kind: 'active', targetId: 'target-unreferenced', targetVersion: 1 }),
      /active exact rule reference/i,
    );
    assert.equal(sends, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CUE-475: a target test while collection is switched off says to switch it on, and sends nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-switched-off-');
  const store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'target-off', [1]);
    store.database.exec('UPDATE event_settings SET enabled = 0 WHERE singleton = 1');
    let sends = 0;
    const control = targetTestControl(store, {
      transport: async () => {
        sends += 1;
      },
    });
    await assert.rejects(
      () => control.test({ kind: 'active', targetId: 'target-off', targetVersion: 1 }),
      /collection is switched off: switch it on with enable-all first, or approve without the test/,
    );
    assert.equal(sends, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test refuses a revoked bound target instead of inferring safety from its active rule pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-revoked-');
  const store = await openEventDatabase({ stateDir });
  try {
    store.database.exec(`UPDATE event_settings SET enabled = 1 WHERE singleton = 1;
      INSERT INTO target_versions (id, target_id, version, document, digest, revoked_at)
      VALUES ('target-revoked@1', 'target-revoked', 1, '{"targetId":"target-revoked","version":1,"kind":"dry-run","retentionMs":60000}', 'digest', 2);
      INSERT INTO rule_versions (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
      VALUES ('rule-revoked@1', 'rule-revoked', 1, '{}', 'digest', 'active', 'approval', 'activation', 1);`);
    addActiveRuleTargetReferences(store.database, {
      ruleId: 'rule-revoked',
      ruleVersion: 1,
      targets: [{ targetId: 'target-revoked', targetVersion: 1 }],
      createdAt: 1,
    });
    let sends = 0;
    const control = new B3TargetTestControl({
      store,
      ports: {
        quiescer: testWriterQuiescer(),
        secrets: {} as never,
        assertObjectSecretReady: async () => ({ ready: true as const }),
      },
      transport: async () => {
        sends += 1;
      },
    });
    await assert.rejects(
      () => control.test({ kind: 'active', targetId: 'target-revoked', targetVersion: 1 }),
      /exact target version is not live/i,
    );
    assert.equal(sends, 0);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test commits its durable charge before synthetic transport', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-charge-before-transport-');
  const store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'charge-before-transport', [1]);
    const observedCharges: number[] = [];
    const control = targetTestControl(store, {
      now: () => 1_000,
      transport: async ({ bytes }) => {
        assert.equal(bytes, TEST_CLOUD_EVENT_BYTES);
        observedCharges.push(
          (
            store.database
              .prepare('SELECT COUNT(*) AS count FROM target_test_charges WHERE target_id = ?')
              .get('charge-before-transport') as { count: number }
          ).count,
        );
      },
    });
    await control.test({ kind: 'active', targetId: 'charge-before-transport', targetVersion: 1 });
    assert.deepEqual(observedCharges, [1]);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test retains a failed synthetic attempt in its durable cap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-failed-charge-');
  const store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'failed-charge', [1]);
    const failed = targetTestControl(store, {
      now: () => 1_000,
      transport: async () => {
        throw new Error('synthetic transport failure');
      },
    });
    await assert.rejects(
      () => failed.test({ kind: 'active', targetId: 'failed-charge', targetVersion: 1 }),
      /synthetic transport failure/,
    );
    let sends = 0;
    const recovered = targetTestControl(store, {
      now: () => 1_000,
      transport: async () => {
        sends += 1;
      },
    });
    for (let attempt = 0; attempt < 9; attempt += 1)
      await recovered.test({ kind: 'active', targetId: 'failed-charge', targetVersion: 1 });
    await assert.rejects(
      () => recovered.test({ kind: 'active', targetId: 'failed-charge', targetVersion: 1 }),
      /limit/i,
    );
    assert.equal(sends, 9);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test durable cap survives a daemon restart', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-restart-charge-');
  let store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'restart-charge', [1]);
    const firstControl = targetTestControl(store, { now: () => 1_000, transport: async () => undefined });
    for (let attempt = 0; attempt < 10; attempt += 1)
      await firstControl.test({ kind: 'active', targetId: 'restart-charge', targetVersion: 1 });
    store.close();
    store = await openEventDatabase({ stateDir });
    const restartedControl = targetTestControl(store, { now: () => 1_000, transport: async () => undefined });
    await assert.rejects(
      () => restartedControl.test({ kind: 'active', targetId: 'restart-charge', targetVersion: 1 }),
      /limit/i,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test shares the durable cap across target versions but not other targets', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-wide-charge-');
  const store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'shared-charge', [1, 2]);
    installLiveDryRunTarget(store, 'other-charge', [1]);
    const sent: string[] = [];
    const control = targetTestControl(store, {
      now: () => 1_000,
      transport: async ({ bytes }) => {
        sent.push(bytes);
      },
    });
    for (let attempt = 0; attempt < 10; attempt += 1)
      await control.test({ kind: 'active', targetId: 'shared-charge', targetVersion: attempt % 2 === 0 ? 1 : 2 });
    await assert.rejects(() => control.test({ kind: 'active', targetId: 'shared-charge', targetVersion: 1 }), /limit/i);
    await control.test({ kind: 'active', targetId: 'other-charge', targetVersion: 1 });
    assert.deepEqual(sent, Array(11).fill(TEST_CLOUD_EVENT_BYTES));
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 target test prunes expired durable charges as its rolling hour advances', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-b3-target-window-charge-');
  const store = await openEventDatabase({ stateDir });
  try {
    installLiveDryRunTarget(store, 'rolling-charge', [1]);
    let now = 1_000;
    const control = targetTestControl(store, { now: () => now, transport: async () => undefined });
    for (let attempt = 0; attempt < 10; attempt += 1)
      await control.test({ kind: 'active', targetId: 'rolling-charge', targetVersion: 1 });
    await assert.rejects(
      () => control.test({ kind: 'active', targetId: 'rolling-charge', targetVersion: 1 }),
      /limit/i,
    );
    now += 60 * 60 * 1_000 + 1;
    await control.test({ kind: 'active', targetId: 'rolling-charge', targetVersion: 1 });
    assert.deepEqual(
      store.database
        .prepare('SELECT charged_at FROM target_test_charges WHERE target_id = ? ORDER BY charged_at')
        .all('rolling-charge')
        .map((row) => ({ ...(row as { charged_at: number }) })),
      [{ charged_at: now }],
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
