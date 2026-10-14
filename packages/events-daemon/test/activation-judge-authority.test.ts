import assert from 'node:assert/strict';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, ConfigStore, emptyConfig } from '@agentcomms/core';
import { EventDomainError } from '../src/domain/lifecycle.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { B3OperatorControl } from '../src/runtime/b3-operator-control.ts';
import { JudgeKinds } from '../src/runtime/judge-kinds.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT_ID = 'ibx_AAAAAAAAAAAAAAAA';
const target = { targetId: 'target-review-authority', version: 1, kind: 'dry-run' as const, retentionMs: 60_000 };
const judge = {
  judgeId: 'judge-review-authority',
  version: 1,
  kind: 'local-endpoint' as const,
  provider: 'ollama',
  model: 'test-authority',
  endpoint: 'http://127.0.0.1:11434/v1/systemone',
  approvedAddressSet: ['127.0.0.1'] as const,
  promptTemplate: 'test-authority-noul-v1',
  protocol: 'noul' as const,
};
const rule = {
  ruleId: 'rule-review-authority',
  version: 1,
  source: {
    channel: 'gmail' as const,
    accountIds: [ACCOUNT_ID],
    options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
  },
  event: { type: 'gmail.message.received', version: 1 },
  condition: { path: '/subject', op: 'exists' },
  agentic: {
    judge,
    question: 'Does this fixed test event match?',
    inputs: ['/subject'],
    threshold: 0.5,
    onUncertain: 'no-match' as const,
    callsPerRollingHour: 10,
    inputTokensPerRolling30Days: 10_000,
    concurrency: 1,
    maxInputTokens: 1_000,
    maxOutputTokens: 64,
  },
  mapping: { constant: 'safe' },
  targets: [target],
  subscribers: [],
  judges: [],
  deliveryRateCap: 10,
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

async function fixture(
  options: {
    readonly afterCoreApproval?: (() => void) | undefined;
    readonly afterCoreClaim?: (() => void) | undefined;
    readonly afterConfigLoad?: (() => void) | undefined;
    readonly afterDisclosureCreated?: (() => void) | undefined;
    readonly beforeFinalise?: (() => void) | undefined;
  } = {},
) {
  const root = await shortTempDir('events-review-authority-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const configDocument = emptyConfig();
  configDocument.inboxes['events/gmail'] = {
    id: ACCOUNT_ID,
    provider: 'gmail',
    email: 'events@example.test',
    identity: 'oidc',
    client: 'client-review-authority',
    tier: 'read',
    contacts: false,
    grantedScopes: [],
    secretRef: `gmail:none:${ACCOUNT_ID}`,
    internalDomains: [],
    createdAt: '2026-10-14T00:00:00.000Z',
  };
  await writeFile(join(configDir, 'config.json'), `${JSON.stringify(configDocument)}\n`);
  const store = await openEventDatabase({ stateDir });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  versions.createJudge(judge);
  versions.createJudgeKind({ id: 'judge-kind:local-endpoint', kind: 'local-endpoint', version: 1 });
  versions.createRule(rule);
  const config = new ConfigStore(configDir);
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: () => config.load() });
  const approvalBridge = {
    createDisclosure: async (...args: Parameters<typeof approvals.createDisclosure>) => {
      const created = await approvals.createDisclosure(...args);
      options.afterDisclosureCreated?.();
      return created;
    },
    approveDisclosure: async (...args: Parameters<typeof approvals.approveDisclosure>) => {
      const approved = await approvals.approveDisclosure(...args);
      options.afterCoreApproval?.();
      return approved;
    },
    claimForDisclosure: async (...args: Parameters<typeof approvals.claimForDisclosure>) => {
      const claimed = await approvals.claimForDisclosure(...args);
      options.afterCoreClaim?.();
      return claimed;
    },
    get: approvals.get.bind(approvals),
    issueDisclosureChallenge: approvals.issueDisclosureChallenge.bind(approvals),
    list: approvals.list.bind(approvals),
  };
  let nextIntent = 0;
  const runtime = new ActivationRuntime({
    store,
    approvals: approvalBridge,
    config: {
      load: async () => {
        const loaded = await config.load();
        options.afterConfigLoad?.();
        return loaded;
      },
    },
    newIntentId: () => {
      nextIntent += 1;
      return `act_review_authority_${nextIntent}`;
    },
    gmailSourceFor: async () => ({
      getProfile: async () => ({
        emailAddress: 'events@example.test',
        messagesTotal: 0,
        threadsTotal: 0,
        historyId: '404',
      }),
    }),
    encryptBaseline: async (_intent, _account, position) => Buffer.from(JSON.stringify(position)),
    decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
    encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    mailboxLock: new MailboxLock(),
    failpoint: (edge) => {
      if (edge === 'before-finalise') options.beforeFinalise?.();
    },
  });
  const control = new B3OperatorControl({
    store,
    ports: { quiescer: new WriterQuiescer() },
    activations: runtime,
    now: () => 1_800_000_000_000,
  });
  return { root, store, runtime, control };
}

async function approve(runtime: ActivationRuntime, prepared: PreparedActivation): Promise<void> {
  const challenge = await runtime.issueChallenge(prepared.approvalId);
  const completed = await runtime.approve({ approvalId: prepared.approvalId, answer: challenge });
  assert.equal(completed.status, 'completed', `${prepared.kind} activation completes in fixture setup`);
}

async function enableKind(setup: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await approve(setup.runtime, await setup.runtime.prepareJudgeKind({ kind: 'local-endpoint', version: 1 }));
}

async function activateRule(setup: Awaited<ReturnType<typeof fixture>>): Promise<void> {
  await approve(
    setup.runtime,
    (await setup.runtime.prepareRule({ ruleId: rule.ruleId, version: 1 })) as PreparedActivation,
  );
}

function revokeJudgeDirectly(
  setup: Awaited<ReturnType<typeof fixture>>,
  source: 'judge-row' | 'object-record' | 'both' = 'both',
): void {
  if (source !== 'object-record')
    setup.store.database
      .prepare('UPDATE judge_versions SET revoked_at = ? WHERE judge_id = ? AND version = ?')
      .run(1_800_000_000_001, judge.judgeId, judge.version);
  if (source !== 'judge-row')
    setup.store.database
      .prepare('INSERT OR REPLACE INTO object_revocations (kind, object_id, version, revoked_at) VALUES (?, ?, ?, ?)')
      .run('judge', judge.judgeId, judge.version, 1_800_000_000_001);
}

function intentStatus(setup: Awaited<ReturnType<typeof fixture>>, intentId: string): string {
  return (
    setup.store.database.prepare('SELECT status FROM activation_intents WHERE id = ?').get(intentId) as {
      status: string;
    }
  ).status;
}

function switchEnabled(setup: Awaited<ReturnType<typeof fixture>>): number {
  return (
    setup.store.database.prepare('SELECT enabled FROM event_settings WHERE singleton = 1').get() as { enabled: number }
  ).enabled;
}

test('E4 review: kind disable cancels enable-all when any bound active rule uses that judge kind', {
  skip: WINDOWS_SKIP,
}, async () => {
  let afterCoreApproval: (() => void) | undefined;
  const setup = await fixture({ afterCoreApproval: () => afterCoreApproval?.() });
  try {
    await enableKind(setup);
    await activateRule(setup);
    const prepared = await setup.runtime.prepareEnableAll();
    const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
    let disabled: ReturnType<JudgeKinds['disable']> | undefined;
    afterCoreApproval = () => {
      disabled = new JudgeKinds({
        store: setup.store,
        activations: setup.runtime,
        now: () => 1_800_000_000_001,
      }).disable('local-endpoint');
    };
    await assert.rejects(
      () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
      /cancelled|void|disabled/iu,
      'the enable-all approval cannot be claimed or finalised after the intervening kind disable',
    );
    assert.ok(disabled !== undefined, 'the kind disable ran after core approval and before the local claim');
    assert.equal(
      disabled.pendingActivationsCancelled,
      1,
      'kind disable cancels the bound enable-all intent inside its transaction',
    );
    assert.equal(intentStatus(setup, prepared.intentId), 'cancelled', 'the enable-all intent is durably cancelled');
    assert.equal(switchEnabled(setup), 0, 'the global switch stays off after its bound kind is disabled');
  } finally {
    setup.store.close();
    await rm(setup.root, { recursive: true, force: true });
  }
});

test('E4 review: enable-all rechecks every bound rule kind at live binding, local claim and final pointer commit', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const phase of ['live-binding', 'local-claim', 'final-pointer'] as const) {
    let afterCoreClaim: (() => void) | undefined;
    let beforeFinalise: (() => void) | undefined;
    const setup = await fixture({
      afterCoreClaim: () => afterCoreClaim?.(),
      beforeFinalise: () => beforeFinalise?.(),
    });
    try {
      await enableKind(setup);
      await activateRule(setup);
      const prepared = await setup.runtime.prepareEnableAll();
      if (phase === 'live-binding') {
        setup.store.database
          .prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = 'local-endpoint'")
          .run();
        await assert.rejects(
          () => setup.runtime.issueChallenge(prepared.approvalId),
          /disabled|void/iu,
          `${phase}: challenge binding refuses a disabled kind`,
        );
      } else {
        const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
        const disable = () =>
          setup.store.database
            .prepare("DELETE FROM active_versions WHERE kind = 'judge-kind' AND object_id = 'local-endpoint'")
            .run();
        if (phase === 'local-claim') afterCoreClaim = disable;
        else beforeFinalise = disable;
        await assert.rejects(
          () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
          /disabled|void/iu,
          `${phase}: enable-all refuses after its bound kind loses authority`,
        );
      }
      assert.equal(switchEnabled(setup), 0, `${phase}: no stale enable-all path turns on the global switch`);
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});

test('E4 review: prepare rechecks bound rule authority inside the intent insertion transaction after awaited setup', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const kind of ['rule', 'enable-all'] as const) {
    for (const phase of ['before-intent', 'before-approval-link'] as const) {
      let afterConfigLoad: (() => void) | undefined;
      let afterDisclosureCreated: (() => void) | undefined;
      const setup = await fixture({
        afterConfigLoad: () => afterConfigLoad?.(),
        afterDisclosureCreated: () => afterDisclosureCreated?.(),
      });
      try {
        await enableKind(setup);
        if (kind === 'enable-all') await activateRule(setup);
        const disable = () => {
          new JudgeKinds({
            store: setup.store,
            activations: setup.runtime,
            now: () => 1_800_000_000_001,
          }).disable('local-endpoint');
        };
        if (phase === 'before-intent') afterConfigLoad = disable;
        else afterDisclosureCreated = disable;
        await assert.rejects(
          () =>
            kind === 'rule'
              ? setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version })
              : setup.runtime.prepareEnableAll(),
          /cancelled|disabled|void/iu,
          `${kind} ${phase}: preparation refuses authority revoked across its awaited setup`,
        );
        const intent = setup.store.database
          .prepare('SELECT status, approval_id FROM activation_intents WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
          .get(kind) as { status: string; approval_id: string | null } | undefined;
        if (phase === 'before-intent') {
          assert.equal(intent, undefined, `${kind} ${phase}: revoked authority is fenced before an intent is written`);
        } else {
          assert.equal(intent?.status, 'cancelled', `${kind} ${phase}: the written intent is settled as cancelled`);
          assert.notEqual(
            intent?.approval_id,
            null,
            `${kind} ${phase}: the created disclosure remains linked to its cancelled local intent`,
          );
        }
      } finally {
        setup.store.close();
        await rm(setup.root, { recursive: true, force: true });
      }
    }
  }
});

test('E4 review: prepare rechecks the complete pointer plan before intent and after disclosure writes', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const kind of ['rule', 'enable-all'] as const) {
    for (const phase of ['before-intent', 'before-approval-link'] as const) {
      let afterConfigLoad: (() => void) | undefined;
      let afterDisclosureCreated: (() => void) | undefined;
      const setup = await fixture({
        afterConfigLoad: () => afterConfigLoad?.(),
        afterDisclosureCreated: () => afterDisclosureCreated?.(),
      });
      try {
        await enableKind(setup);
        if (kind === 'enable-all') await activateRule(setup);
        const driftPlan = () => {
          if (kind === 'rule') {
            setup.store.database
              .prepare(
                "INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at) VALUES ('rule', ?, ?, NULL, ?)",
              )
              .run(rule.ruleId, rule.version, 1_800_000_000_001);
            return;
          }
          setup.store.database
            .prepare("UPDATE active_versions SET current_cutover_id = NULL WHERE kind = 'rule' AND object_id = ?")
            .run(rule.ruleId);
        };
        if (phase === 'before-intent') afterConfigLoad = driftPlan;
        else afterDisclosureCreated = driftPlan;
        await assert.rejects(
          () =>
            kind === 'rule'
              ? setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version })
              : setup.runtime.prepareEnableAll(),
          /plan|pointer|changed|void/iu,
          `${kind} ${phase}: preparation refuses a pointer plan changed across its awaited work`,
        );
        const intent = setup.store.database
          .prepare('SELECT status, approval_id FROM activation_intents WHERE kind = ? ORDER BY created_at DESC LIMIT 1')
          .get(kind) as { status: string; approval_id: string | null } | undefined;
        if (phase === 'before-intent') {
          assert.equal(intent, undefined, `${kind} ${phase}: pointer drift is fenced before an intent is written`);
        } else {
          assert.equal(intent?.status, 'cancelled', `${kind} ${phase}: the written intent is settled as cancelled`);
          assert.notEqual(
            intent?.approval_id,
            null,
            `${kind} ${phase}: the created disclosure remains linked to its cancelled local intent`,
          );
        }
      } finally {
        setup.store.close();
        await rm(setup.root, { recursive: true, force: true });
      }
    }
  }
});

test('E4 review: a pending agentic rule cannot activate after its embedded judge is revoked', {
  skip: WINDOWS_SKIP,
}, async () => {
  const removedBeforePrepare = await fixture();
  try {
    await removedBeforePrepare.control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } });
    await enableKind(removedBeforePrepare);
    await assert.rejects(
      () => removedBeforePrepare.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version }),
      (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
      'a revoked embedded judge is rejected before rule activation preparation',
    );
    assert.equal(
      new ImmutableVersions(removedBeforePrepare.store.database).activeVersion('rule', rule.ruleId),
      null,
      'the post-removal rule never gains an active pointer',
    );
  } finally {
    removedBeforePrepare.store.close();
    await rm(removedBeforePrepare.root, { recursive: true, force: true });
  }

  for (const revocationSource of ['judge-row', 'object-record'] as const) {
    const setup = await fixture();
    try {
      await enableKind(setup);
      revokeJudgeDirectly(setup, revocationSource);
      await assert.rejects(
        () => setup.runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version }),
        (error: unknown) => error instanceof EventDomainError && error.code === 'VERSION_DOCUMENT_INVALID',
        `${revocationSource}: either durable judge-revocation record independently blocks preparation`,
      );
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }

  const pending = await fixture();
  try {
    await enableKind(pending);
    const prepared = (await pending.runtime.prepareRule({
      ruleId: rule.ruleId,
      version: rule.version,
    })) as PreparedActivation;
    await pending.control.handle({ operation: 'removeJudge', args: { judgeId: judge.judgeId } });
    assert.equal(
      intentStatus(pending, prepared.intentId),
      'cancelled',
      'judge removal cancels the matching pending rule activation inside its transaction',
    );
  } finally {
    pending.store.close();
    await rm(pending.root, { recursive: true, force: true });
  }

  for (const phase of ['live-binding', 'local-claim', 'final-pointer'] as const) {
    let afterCoreClaim: (() => void) | undefined;
    let beforeFinalise: (() => void) | undefined;
    const setup = await fixture({
      afterCoreClaim: () => afterCoreClaim?.(),
      beforeFinalise: () => beforeFinalise?.(),
    });
    try {
      await enableKind(setup);
      const prepared = (await setup.runtime.prepareRule({
        ruleId: rule.ruleId,
        version: rule.version,
      })) as PreparedActivation;
      if (phase === 'live-binding') {
        revokeJudgeDirectly(setup);
        await assert.rejects(
          () => setup.runtime.issueChallenge(prepared.approvalId),
          /revoked|void|invalid/iu,
          `${phase}: challenge binding refuses the revoked embedded judge`,
        );
      } else {
        const challenge = await setup.runtime.issueChallenge(prepared.approvalId);
        if (phase === 'local-claim') afterCoreClaim = () => revokeJudgeDirectly(setup);
        else beforeFinalise = () => revokeJudgeDirectly(setup);
        await assert.rejects(
          () => setup.runtime.approve({ approvalId: prepared.approvalId, answer: challenge }),
          /revoked|void|invalid/iu,
          `${phase}: rule activation refuses after its embedded judge is revoked`,
        );
      }
      assert.equal(
        new ImmutableVersions(setup.store.database).activeVersion('rule', rule.ruleId),
        null,
        `${phase}: a revoked judge cannot reach the final active-rule pointer`,
      );
    } finally {
      setup.store.close();
      await rm(setup.root, { recursive: true, force: true });
    }
  }
});
