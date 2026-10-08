import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-enable', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const rule = {
  ruleId: 'rule-enable',
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

async function setup() {
  const root = await shortTempDir('events-enable-');
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
    createdAt: '2026-10-08T00:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createRule(rule);
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => configStore.load() });
  let profileCalls = 0;
  const runtime = new ActivationRuntime({
    store,
    approvals,
    config: configStore,
    newIntentId: (() => {
      const ids = ['act_first', 'act_enable'];
      return () => ids.shift() ?? 'act_extra';
    })(),
    gmailSourceFor: async () => ({
      getProfile: async () => {
        profileCalls += 1;
        return { emailAddress: 'events@example.test', messagesTotal: 0, threadsTotal: 0, historyId: '303' };
      },
    }),
    encryptBaseline: async (_intent, _account, position) => Buffer.from(JSON.stringify(position)),
  });
  // The rule is made active the only way a real one is: an approved, claimed, completed exact activation, whose
  // lineage the shared fence then proves. A row merely marked active would be refused at every boundary.
  const first = await runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version });
  const answer = await approvals.issueDisclosureChallenge(first.approvalId);
  assert.equal((await runtime.approve({ approvalId: first.approvalId, answer })).status, 'completed');
  profileCalls = 0;
  return { root, store, approvals, runtime, profileCalls: () => profileCalls };
}

test('APR-B1: enable-all refuses a changed pointer before authority use and otherwise installs one fresh baseline cut-over', {
  skip: WINDOWS_SKIP,
}, async () => {
  const first = await setup();
  try {
    const prepared = await first.runtime.prepareEnableAll();
    first.store.database
      .prepare("UPDATE active_versions SET current_cutover_id = 'act_other' WHERE kind = 'rule' AND object_id = ?")
      .run(rule.ruleId);
    await assert.rejects(
      () => first.runtime.issueChallenge(prepared.approvalId),
      (error: unknown) => (error as { code?: string }).code === 'APPROVAL_VOID',
    );
    assert.equal(first.profileCalls(), 0);
  } finally {
    first.store.close();
    await rm(first.root, { recursive: true, force: true });
  }

  const second = await setup();
  try {
    const prepared = await second.runtime.prepareEnableAll();
    const challenge = await second.approvals.issueDisclosureChallenge(prepared.approvalId);
    const completed = await second.runtime.approve({ approvalId: prepared.approvalId, answer: challenge });
    assert.equal(completed.status, 'completed');
    assert.equal(second.profileCalls(), 1, 'enable-all samples one new mailbox baseline, never history');
    const settings = second.store.database
      .prepare('SELECT enabled, activation_id FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; activation_id: string };
    assert.equal(settings.enabled, 1);
    assert.equal(settings.activation_id, prepared.intentId);
  } finally {
    second.store.close();
    await rm(second.root, { recursive: true, force: true });
  }
});
