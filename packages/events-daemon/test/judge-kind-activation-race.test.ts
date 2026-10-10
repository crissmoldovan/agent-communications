import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = { targetId: 'target-e1-race', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const judge = {
  judgeId: 'judge-e1-race',
  version: 1,
  kind: 'typesafe' as const,
  provider: 'typesafe',
  model: 'jev-1.13.0',
  endpoint: 'https://api.typesafe.ai/v1/systemone',
  promptTemplate: 'typesafe-jev-noul-v1',
  protocol: 'noul' as const,
};
const rule = {
  ruleId: 'rule-e1-race',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: ['ibx_E1RACEAAAAAAAAAA'],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  agentic: {
    judge,
    question: 'Is this an E1 race fixture?',
    inputs: ['/subject'],
    threshold: 0.5,
    onUncertain: 'no-match' as const,
    callsPerRollingHour: 1,
    inputTokensPerRolling30Days: 1,
    concurrency: 1,
    maxInputTokens: 1,
    maxOutputTokens: 1,
  },
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

function disabledJudgeKind(store: Awaited<ReturnType<typeof openEventDatabase>>): void {
  store.database.prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = 'typesafe'").run();
}

async function fixture(
  options: {
    readonly afterDisclosureApproval?: (() => void) | undefined;
    readonly afterDisclosureClaim?: (() => void) | undefined;
    readonly encryptPoint?: ((position: unknown) => Promise<Uint8Array>) | undefined;
  } = {},
) {
  const root = await shortTempDir('events-e1-kind-race-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const config = emptyConfig();
  config.inboxes['events/gmail'] = {
    id: 'ibx_E1RACEAAAAAAAAAA',
    provider: 'gmail',
    email: 'events-e1-race@example.test',
    identity: 'oidc',
    client: 'client-e1-race',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: 'gmail:none:ibx_E1RACEAAAAAAAAAA',
    internalDomains: [],
    createdAt: '2026-10-10T10:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(config)}\n`);
  const store = await openEventDatabase({ stateDir });
  const configStore = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => configStore.load() });
  let profileCalls = 0;
  const runtime = new ActivationRuntime({
    store,
    approvals: {
      createDisclosure: approvals.createDisclosure.bind(approvals),
      approveDisclosure: async (...args) => {
        const approved = await approvals.approveDisclosure(...args);
        options.afterDisclosureApproval?.();
        return approved;
      },
      claimForDisclosure: async (...args) => {
        const claimed = await approvals.claimForDisclosure(...args);
        options.afterDisclosureClaim?.();
        return claimed;
      },
      get: approvals.get.bind(approvals),
      issueDisclosureChallenge: approvals.issueDisclosureChallenge.bind(approvals),
      list: approvals.list.bind(approvals),
    },
    config: configStore,
    gmailSourceFor: async () => ({
      getProfile: async () => {
        profileCalls += 1;
        return { emailAddress: 'events-e1-race@example.test', messagesTotal: 1, threadsTotal: 1, historyId: '202' };
      },
    }),
    encryptBaseline: async (_intentId, _accountId, position) => Buffer.from(JSON.stringify(position)),
    decryptBaseline: async (_intentId, _accountId, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
    encryptPoint: async ({ position }) =>
      options.encryptPoint === undefined ? Buffer.from(JSON.stringify(position)) : options.encryptPoint(position),
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    mailboxLock: new MailboxLock(),
  });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeKind({
    id: 'judge-kind:typesafe',
    kind: 'typesafe',
    version: 1,
    endpoint: 'https://api.typesafe.ai/v1/systemone',
  });
  store.database
    .prepare(
      "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('judge-kind', 'typesafe', 1, 'judge-kind:typesafe@1', 1)",
    )
    .run();
  versions.createRule(rule);
  return { root, store, approvals, runtime, versions, profileCalls: () => profileCalls };
}

async function prepare(setup: Awaited<ReturnType<typeof fixture>>): Promise<PreparedActivation> {
  return (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version })) as PreparedActivation;
}

function disabledKind(error: unknown): boolean {
  return error instanceof EventDomainError && error.code === 'JUDGE_KIND_DISABLED';
}

test('E1 judge-kind claim race: disabling after approval refuses the claim before a baseline or rule pointer', {
  skip: WINDOWS_SKIP,
}, async () => {
  let disable: (() => void) | undefined;
  const setup = await fixture({ afterDisclosureApproval: () => disable?.() });
  disable = () => disabledJudgeKind(setup.store);
  try {
    const prepared = await prepare(setup);
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      disabledKind,
    );
    const approval = await setup.approvals.get(prepared.approvalId);
    assert.equal(
      approval?.form === 'v2' ? approval.record.state : undefined,
      'approved',
      'the core claim is not spent',
    );
    assert.equal(setup.profileCalls(), 0, 'the disabled kind stops before the provider baseline');
    assert.equal(
      setup.versions.activeVersion('rule', rule.ruleId),
      null,
      'a disabled judge kind cannot claim a rule pointer',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E1 judge-kind claimed race: disabling after the core claim refuses its local claim transaction before a baseline', {
  skip: WINDOWS_SKIP,
}, async () => {
  let disable: (() => void) | undefined;
  const setup = await fixture({ afterDisclosureClaim: () => disable?.() });
  disable = () => disabledJudgeKind(setup.store);
  try {
    const prepared = await prepare(setup);
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      disabledKind,
    );
    const approval = await setup.approvals.get(prepared.approvalId);
    assert.equal(
      approval?.form === 'v2' ? approval.record.state : undefined,
      'used',
      'the real core claim won the race',
    );
    assert.equal(setup.profileCalls(), 0, 'the local claim transaction rechecks before the provider baseline');
    assert.equal(
      setup.versions.activeVersion('rule', rule.ruleId),
      null,
      'a disabled judge kind cannot claim a rule pointer',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E1 judge-kind finalisation race: disabling after claim refuses the final pointer transaction', {
  skip: WINDOWS_SKIP,
}, async () => {
  let disable: (() => void) | undefined;
  const setup = await fixture({
    encryptPoint: async (position) => {
      disable?.();
      return Buffer.from(JSON.stringify(position));
    },
  });
  disable = () => disabledJudgeKind(setup.store);
  try {
    const prepared = await prepare(setup);
    const challenge = await setup.approvals.issueDisclosureChallenge(prepared.approvalId);
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      disabledKind,
    );
    assert.equal(setup.profileCalls(), 1, 'the first post-claim baseline is real production activation work');
    assert.equal(setup.versions.activeVersion('rule', rule.ruleId), null, 'the final write rechecks the disabled kind');
    assert.equal(
      (setup.store.database.prepare('SELECT COUNT(*) AS count FROM rule_activation_points').get() as { count: number })
        .count,
      0,
      'the pointer transaction writes no activation point after the disabled-kind guard',
    );
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});
