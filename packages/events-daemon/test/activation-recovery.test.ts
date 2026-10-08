import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-1', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const rule = {
  ruleId: 'rule-1',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: ['ibx_AAAAAAAAAAAAAAAA'],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  mapping: { constant: 'safe' },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 60,
  retention: {
    ingestMs: 604_800_000,
    holdMs: 604_800_000,
    deliveryMs: 604_800_000,
    dryrunMs: 86_400_000,
    sseReplayMs: 604_800_000,
    deadLetterMs: 604_800_000,
    decisionMetadataMs: 7_776_000_000,
  },
};

function clock(start = Date.parse('2026-10-08T10:00:00.000Z')) {
  let value = start;
  return { now: () => value, advance: (milliseconds: number) => (value += milliseconds) };
}

async function fixture() {
  const root = await shortTempDir('events-act-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: 'ibx_AAAAAAAAAAAAAAAA',
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-1',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:none:ibx_AAAAAAAAAAAAAAAA',
    internalDomains: [],
    createdAt: '2026-10-08T10:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const time = clock();
  const store = await openEventDatabase({ stateDir });
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), {
    now: () => new Date(time.now()),
    loadConfig: () => configStore.load(),
  });
  let profileCalls = 0;
  const runtime = new ActivationRuntime({
    store,
    approvals,
    config: configStore,
    now: time.now,
    newIntentId: () => 'act_01HZZZZZZZZZZZZZZZZZZZZZZZ',
    gmailSourceFor: async () => ({
      getProfile: async () => {
        profileCalls += 1;
        return { emailAddress: 'events@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '202' };
      },
      listHistory: async () => {
        throw new Error('activation baselines must not scan history');
      },
      getMessageMetadata: async () => {
        throw new Error('activation baselines must not read message metadata');
      },
    }),
    encryptBaseline: async (_intentId, _accountId, position) => Buffer.from(JSON.stringify(position)),
  });
  return { root, store, approvals, runtime, time, profileCalls: () => profileCalls };
}

test('APR-B1: first Gmail activation creates and claims authority before one profile baseline and one pointer commit', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);

    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    assert.equal(setup.profileCalls(), 0, 'preparing does not call a provider before authority is used');
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    const complete = await setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge });

    assert.equal(complete.status, 'completed');
    assert.equal(setup.profileCalls(), 1, 'one Gmail profile baseline is sampled after claim');
    const intent = setup.store.database
      .prepare('SELECT status, claimed_at, completion_deadline FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string; claimed_at: number; completion_deadline: number };
    assert.equal(intent.status, 'completed');
    assert.equal(intent.claimed_at, Date.parse(complete.usedAt));
    assert.equal(intent.completion_deadline, Date.parse(complete.usedAt) + 3_600_000);
    assert.deepEqual(versions.activeVersion('rule', rule.ruleId), { version: 1, currentCutoverId: prepared.intentId });
    const point = setup.store.database
      .prepare('SELECT encrypted_position FROM rule_activation_points WHERE activation_id = ?')
      .get(prepared.intentId) as { encrypted_position: Uint8Array } | undefined;
    assert.ok(point, 'finalisation writes an immutable per-rule point');
    assert.equal(Buffer.from(point.encrypted_position).toString('utf8'), '{"historyId":"202"}');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a first activation voids before claim if another pointer appears after preparation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    setup.store.database
      .prepare(
        "UPDATE rule_versions SET state = 'active', approval_id = 'ap_other', authorization_activation_id = 'act_other', activated_at = 1 WHERE rule_id = ? AND version = ?",
      )
      .run(rule.ruleId, rule.version);
    setup.store.database
      .prepare(
        "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, ?, 'act_other', 1)",
      )
      .run(rule.ruleId, rule.version);

    await assert.rejects(
      () => setup.runtime.issueChallenge(prepared.approvalId),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_VOID',
    );
    assert.equal(setup.profileCalls(), 0);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: recovery uses the original core usedAt and fails an expired completion before another provider call', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    const used = await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    assert.ok(used.usedAt);
    setup.time.advance(3_600_001);

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status, claimed_at, completion_deadline, failure_code FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as {
      status: string;
      claimed_at: number;
      completion_deadline: number;
      failure_code: string;
    };
    assert.equal(intent.status, 'failed');
    assert.equal(intent.claimed_at, Date.parse(used.usedAt));
    assert.equal(intent.completion_deadline, Date.parse(used.usedAt) + 3_600_000);
    assert.equal(intent.failure_code, 'COMPLETION_TIMEOUT');
    assert.equal(setup.profileCalls(), 0, 'recovery does not call Gmail after the one-hour completion deadline');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: recovery claims a terminal-approved disclosure left between approval and claim', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string };
    assert.equal(intent.status, 'completed');
    assert.equal(setup.profileCalls(), 1);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a target revocation cancels its claimed completion before it can take a baseline or install a pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    await setup.runtime.cancelForRevocation({ targetId: target.targetId });

    await setup.runtime.recover();

    const intent = setup.store.database
      .prepare('SELECT status FROM activation_intents WHERE id = ?')
      .get(prepared.intentId) as { status: string };
    assert.equal(intent.status, 'cancelled');
    assert.equal(setup.profileCalls(), 0);
    assert.equal(versions.activeVersion('rule', rule.ruleId), null);
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('APR-B1: a non-revoking pointer mutation is fenced while a used intent is completing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const setup = await fixture();
  try {
    const versions = new ImmutableVersions(setup.store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await setup.approvals.approveDisclosure(prepared.approvalId, prepared.binding, challenge, 'terminal');
    const used = await setup.approvals.claimForDisclosure(prepared.approvalId, prepared.binding);
    assert.ok(used.usedAt);
    setup.store.database
      .prepare("UPDATE activation_intents SET status = 'pending-completion', claimed_at = ? WHERE id = ?")
      .run(Date.parse(used.usedAt), prepared.intentId);

    await assert.rejects(
      () => setup.runtime.assertNoCompletingMutation(),
      (error: unknown) =>
        (error as { code?: string; details?: { reason?: string } }).code === 'TRANSIENT' &&
        (error as { details?: { reason?: string } }).details?.reason === 'ACTIVATION_COMPLETING',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
