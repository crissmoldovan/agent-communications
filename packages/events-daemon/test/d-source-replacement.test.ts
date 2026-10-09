import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, emptyConfig } from '@agentcomms/core';
import type { CanonicalFullRuleDocument } from '../src/domain/activation-documents.ts';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { purgeRemovedAccountWork } from '../src/runtime/account-fence.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { createPhaseDWhatsAppOwnerComposition } from '../src/runtime/phase-d-whatsapp-owner-composition.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
import { assertSourceWriteStillLive, StaleSourceWriteError, sourceRuleSetSnapshot } from '../src/sources/contracts.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { LocalEventSourceRegistry, phaseDSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const target = {
  targetId: 'target-d-source-replacement',
  version: 1,
  kind: 'dry-run' as const,
  retentionMs: 86_400_000,
};
const retention = {
  ingestMs: 604_800_000,
  holdMs: 604_800_000,
  deliveryMs: 604_800_000,
  dryrunMs: 86_400_000,
  sseReplayMs: 604_800_000,
  deadLetterMs: 604_800_000,
  decisionMetadataMs: 7_776_000_000,
};

type ReplacementCase = Readonly<{
  readonly name: string;
  readonly source: 'slack' | 'resend' | 'whatsapp';
  readonly eventType: string;
  readonly oldAccounts: readonly string[];
  readonly newAccounts: readonly string[];
  readonly oldOptions: CanonicalFullRuleDocument['source']['options'];
  readonly newOptions: CanonicalFullRuleDocument['source']['options'];
  readonly oldOnly: Readonly<{ accountId: string; scopeId: string }>;
  readonly newOnly: Readonly<{ accountId: string; scopeId: string }>;
  readonly shared: Readonly<{ accountId: string; scopeId: string }>;
}>;

const cases: readonly ReplacementCase[] = [
  {
    name: 'Slack',
    source: 'slack',
    eventType: 'slack.message.posted',
    oldAccounts: ['acc_SLACK_REPLACEMENT'],
    newAccounts: ['acc_SLACK_REPLACEMENT'],
    oldOptions: { channel: 'slack', conversations: ['C-old', 'C-shared'] },
    newOptions: { channel: 'slack', conversations: ['C-new', 'C-shared'] },
    oldOnly: { accountId: 'acc_SLACK_REPLACEMENT', scopeId: 'slack:acc_SLACK_REPLACEMENT:C-old' },
    newOnly: { accountId: 'acc_SLACK_REPLACEMENT', scopeId: 'slack:acc_SLACK_REPLACEMENT:C-new' },
    shared: { accountId: 'acc_SLACK_REPLACEMENT', scopeId: 'slack:acc_SLACK_REPLACEMENT:C-shared' },
  },
  {
    name: 'Resend received',
    source: 'resend',
    eventType: 'resend.email.received',
    oldAccounts: ['acc_RESEND_RECEIVED_OLD', 'acc_RESEND_RECEIVED_SHARED'],
    newAccounts: ['acc_RESEND_RECEIVED_NEW', 'acc_RESEND_RECEIVED_SHARED'],
    oldOptions: { channel: 'resend', kinds: ['received'] },
    newOptions: { channel: 'resend', kinds: ['received'] },
    oldOnly: { accountId: 'acc_RESEND_RECEIVED_OLD', scopeId: 'received' },
    newOnly: { accountId: 'acc_RESEND_RECEIVED_NEW', scopeId: 'received' },
    shared: { accountId: 'acc_RESEND_RECEIVED_SHARED', scopeId: 'received' },
  },
  {
    name: 'Resend status',
    source: 'resend',
    eventType: 'resend.email.status_changed',
    oldAccounts: ['acc_RESEND_STATUS_OLD', 'acc_RESEND_STATUS_SHARED'],
    newAccounts: ['acc_RESEND_STATUS_NEW', 'acc_RESEND_STATUS_SHARED'],
    oldOptions: { channel: 'resend', kinds: ['status'] },
    newOptions: { channel: 'resend', kinds: ['status'] },
    oldOnly: { accountId: 'acc_RESEND_STATUS_OLD', scopeId: 'status' },
    newOnly: { accountId: 'acc_RESEND_STATUS_NEW', scopeId: 'status' },
    shared: { accountId: 'acc_RESEND_STATUS_SHARED', scopeId: 'status' },
  },
  {
    name: 'WhatsApp',
    source: 'whatsapp',
    eventType: 'whatsapp.message.received',
    oldAccounts: ['acc_WHATSAPP_REPLACEMENT'],
    newAccounts: ['acc_WHATSAPP_REPLACEMENT'],
    oldOptions: { channel: 'whatsapp', chats: ['chat-old', 'chat-shared'] },
    newOptions: { channel: 'whatsapp', chats: ['chat-new', 'chat-shared'] },
    oldOnly: { accountId: 'acc_WHATSAPP_REPLACEMENT', scopeId: 'chat:chat-old' },
    newOnly: { accountId: 'acc_WHATSAPP_REPLACEMENT', scopeId: 'chat:chat-new' },
    shared: { accountId: 'acc_WHATSAPP_REPLACEMENT', scopeId: 'chat:chat-shared' },
  },
];

function rule(entry: ReplacementCase, version: number, old: boolean): CanonicalFullRuleDocument {
  return {
    ruleId: `rule-d-source-${entry.name.toLowerCase().replaceAll(' ', '-')}`,
    version,
    source: {
      channel: entry.source,
      accountIds: [...(old ? entry.oldAccounts : entry.newAccounts)].sort(),
      options: old ? entry.oldOptions : entry.newOptions,
    } as CanonicalFullRuleDocument['source'],
    event: { type: entry.eventType, version: 1 },
    condition: { path: '/id', op: 'exists' },
    mapping: { constant: 'safe' },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention,
  };
}

function position(entry: ReplacementCase, scopeId: string): unknown {
  if (entry.source === 'slack') return { timestamp: '10.000000', replyDrain: { through: '10.000000' } };
  if (entry.source === 'resend' && scopeId === 'received') return { anchorId: `p-${scopeId}` };
  if (entry.source === 'resend') return { startedAt: '2026-10-09T12:00:00.000Z' };
  return { capturedAt: '2026-10-09T12:00:00.000Z', baselineGeneration: 1, baselineIdentities: [] };
}

async function setup(
  entry: ReplacementCase,
  options: Readonly<{
    afterBaseline?: () => void;
    encryptBaseline?: () => void;
    encryptPoint?: () => void;
    now?: () => number;
  }> = {},
) {
  const root = await shortTempDir('events-d-source-replacement-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const store = await openEventDatabase({ stateDir });
  const config = emptyConfig();
  for (const accountId of new Set([...entry.oldAccounts, ...entry.newAccounts]))
    config.accounts[`account-${accountId}`] = { id: accountId, platform: entry.source } as never;
  const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: async () => config });
  const registered = phaseDSourceRegistry().require(entry.source);
  const registry = new LocalEventSourceRegistry([
    {
      ...registered,
      withScopes: async (lock, scopes, work) => {
        const result = await registered.withScopes(lock, scopes, work);
        options.afterBaseline?.();
        return result;
      },
    },
  ]);
  const runtime = new ActivationRuntime({
    store,
    approvals,
    config: { load: async () => config },
    gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '1' }) }) as never,
    sourceRegistry: registry,
    mailboxLock: new MailboxLock(new SourceScopeLock()),
    sourceBaselineFor: async ({ scopeId }) => position(entry, scopeId),
    encryptBaseline: async (_intent, _account, value) => {
      options.encryptBaseline?.();
      return Buffer.from(JSON.stringify(value));
    },
    decryptBaseline: async (_intent, _account, value) => JSON.parse(Buffer.from(value).toString('utf8')),
    encryptPoint: async ({ position: value }) => {
      options.encryptPoint?.();
      return Buffer.from(JSON.stringify(value));
    },
    decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
    now: options.now,
  });
  const versions = new ImmutableVersions(store.database);
  versions.createTarget(target);
  return { root, store, config, approvals, runtime, versions };
}

async function approve(runtime: ActivationRuntime, approvals: ApprovalStore, ruleId: string, version: number) {
  const prepared = (await runtime.prepareRule({ ruleId, version })) as PreparedActivation;
  return runtime.approve({
    approvalId: prepared.approvalId,
    answer: await approvals.issueDisclosureChallenge(prepared.approvalId),
  });
}

test('D7b: every non-Gmail replacement gives old-only, new-only and shared scopes their exact drain contract', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const entry of cases) {
    const fixture = await setup(entry);
    try {
      fixture.versions.createRule(rule(entry, 1, true));
      fixture.versions.createRule(rule(entry, 2, false));
      await approve(fixture.runtime, fixture.approvals, rule(entry, 1, true).ruleId, 1);
      fixture.store.database.prepare('UPDATE event_settings SET enabled = 1 WHERE singleton = 1').run();

      await assert.rejects(
        () => approve(fixture.runtime, fixture.approvals, rule(entry, 2, false).ruleId, 2),
        (error: unknown) => (error as { details?: { reason?: string } }).details?.reason === 'REPLACEMENT_DRAINING',
        `${entry.name} waits for its old version`,
      );
      const drains = fixture.store.database
        .prepare(
          `SELECT account_id, position_scope, old_in_scope, new_in_scope, drained_at
             FROM replacement_drains ORDER BY account_id, position_scope`,
        )
        .all() as Array<Record<string, unknown>>;
      assert.deepEqual(
        {
          ...(drains.find(
            (row) => row.account_id === entry.oldOnly.accountId && row.position_scope === entry.oldOnly.scopeId,
          ) as Record<string, unknown>),
        },
        {
          account_id: entry.oldOnly.accountId,
          position_scope: entry.oldOnly.scopeId,
          old_in_scope: 1,
          new_in_scope: 0,
          drained_at: null,
        },
        `${entry.name} old-only scope drains old work`,
      );
      assert.equal(
        drains.find(
          (row) => row.account_id === entry.newOnly.accountId && row.position_scope === entry.newOnly.scopeId,
        ),
        undefined,
        `${entry.name} new-only scope has a P but owes no old drain`,
      );
      assert.deepEqual(
        {
          ...(drains.find(
            (row) => row.account_id === entry.shared.accountId && row.position_scope === entry.shared.scopeId,
          ) as Record<string, unknown>),
        },
        {
          account_id: entry.shared.accountId,
          position_scope: entry.shared.scopeId,
          old_in_scope: 1,
          new_in_scope: 1,
          drained_at: null,
        },
        `${entry.name} shared scope has exactly one old drain`,
      );
      assert.ok(
        fixture.store.database
          .prepare('SELECT 1 FROM activation_baselines WHERE account_id = ? AND position_scope = ?')
          .get(entry.newOnly.accountId, entry.newOnly.scopeId),
        `${entry.name} new-only scope is independently baselined at P`,
      );

      fixture.store.database
        .prepare(
          `INSERT INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES ('old-only-stage', ?, ?, ?, 1, 2, X'00', 1)`,
        )
        .run(entry.source, entry.oldOnly.accountId, entry.oldOnly.scopeId);
      fixture.store.database
        .prepare('INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, ?)')
        .run('old-only-stage', rule(entry, 1, true).ruleId, 1);
      fixture.store.database.prepare('UPDATE replacement_drains SET drained_at = 5').run();
      await fixture.runtime.recover();
      assert.equal(fixture.versions.activeVersion('rule', rule(entry, 1, true).ruleId)?.version, 2);
      assert.equal(
        fixture.store.database.prepare("SELECT 1 FROM source_scan_state WHERE id = 'old-only-stage'").get(),
        undefined,
        `${entry.name} swap drops an unowed old-only stage`,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('D7b: a disabled non-Gmail replacement is immediately drain-settled and carries no admission debt', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const entry of cases) {
    const fixture = await setup(entry);
    try {
      fixture.versions.createRule(rule(entry, 1, true));
      fixture.versions.createRule(rule(entry, 2, false));
      await approve(fixture.runtime, fixture.approvals, rule(entry, 1, true).ruleId, 1);
      // The default global switch is disabled. Completion must therefore not wait for a provider worker.
      await approve(fixture.runtime, fixture.approvals, rule(entry, 2, false).ruleId, 2);
      assert.equal(fixture.versions.activeVersion('rule', rule(entry, 1, true).ruleId)?.version, 2, entry.name);
      assert.equal(
        (fixture.store.database.prepare('SELECT COUNT(*) AS count FROM replacement_drains').get() as { count: number })
          .count,
        0,
        `${entry.name} has no uncompleted drain after the disabled swap`,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('D7b: every non-Gmail derived tightening transfers the staged debt, preserves its inherited point, and fences an old scan', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const entry of cases) {
    const accountId = `acc_${entry.source.toUpperCase()}_TIGHTENING`;
    const parent: ReplacementCase = {
      ...entry,
      oldAccounts: [accountId],
      newAccounts: [accountId],
      oldOptions:
        entry.source === 'slack'
          ? { channel: 'slack', conversations: ['C-a', 'C-b'] }
          : entry.source === 'resend'
            ? { channel: 'resend', kinds: ['received', 'status'] }
            : { channel: 'whatsapp', chats: ['chat-a', 'chat-b'] },
      newOptions:
        entry.source === 'slack'
          ? { channel: 'slack', conversations: ['C-a'] }
          : entry.source === 'resend'
            ? { channel: 'resend', kinds: ['received'] }
            : { channel: 'whatsapp', chats: ['chat-a'] },
      oldOnly: {
        accountId,
        scopeId:
          entry.source === 'resend' ? 'status' : entry.source === 'slack' ? `slack:${accountId}:C-b` : 'chat:chat-b',
      },
      newOnly: {
        accountId,
        scopeId:
          entry.source === 'resend' ? 'received' : entry.source === 'slack' ? `slack:${accountId}:C-a` : 'chat:chat-a',
      },
      shared: {
        accountId,
        scopeId:
          entry.source === 'resend' ? 'received' : entry.source === 'slack' ? `slack:${accountId}:C-a` : 'chat:chat-a',
      },
    };
    const fixture = await setup(parent);
    try {
      fixture.versions.createRule(rule(parent, 1, true));
      fixture.versions.createRule(rule(parent, 2, false));
      await approve(fixture.runtime, fixture.approvals, rule(parent, 1, true).ruleId, 1);
      const parentPoint = fixture.store.database
        .prepare('SELECT encrypted_position FROM rule_activation_points WHERE rule_id = ? AND rule_version = 1 LIMIT 1')
        .get(rule(parent, 1, true).ruleId) as { encrypted_position: Uint8Array };
      fixture.store.database
        .prepare(
          `INSERT INTO source_scan_state
           (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
           VALUES ('derived-stage', ?, ?, ?, 1, 2, X'00', 1)`,
        )
        .run(parent.source, accountId, parent.shared.scopeId);
      fixture.store.database
        .prepare('INSERT INTO source_stage_rule_debts (stage_id, rule_id, rule_version) VALUES (?, ?, 1)')
        .run('derived-stage', rule(parent, 1, true).ruleId);

      const snapshot = {
        generation: 0,
        enabled: 0,
        startedAt: 0,
        rules: sourceRuleSetSnapshot([{ ruleId: rule(parent, 1, true).ruleId, ruleVersion: 1 }]),
      };
      const result = await fixture.runtime.prepareRule({ ruleId: rule(parent, 2, false).ruleId, version: 2 });
      assert.equal('derived' in result && result.derived, true, entry.name);
      const childPoint = fixture.store.database
        .prepare('SELECT encrypted_position FROM rule_activation_points WHERE rule_id = ? AND rule_version = 2 LIMIT 1')
        .get(rule(parent, 1, true).ruleId) as { encrypted_position: Uint8Array };
      assert.deepEqual(
        childPoint.encrypted_position,
        parentPoint.encrypted_position,
        `${entry.name} inherits the exact point`,
      );
      assert.equal(
        fixture.store.database
          .prepare('SELECT 1 FROM source_stage_rule_debts WHERE stage_id = ? AND rule_version = 1')
          .get('derived-stage'),
        undefined,
      );
      assert.ok(
        fixture.store.database
          .prepare('SELECT 1 FROM source_stage_rule_debts WHERE stage_id = ? AND rule_version = 2')
          .get('derived-stage'),
        `${entry.name} transfers the stage debt to the child`,
      );
      assert.throws(
        () =>
          assertSourceWriteStillLive(
            fixture.store.database,
            { source: parent.source, accountId, scopeId: parent.shared.scopeId },
            snapshot,
            () => [{ ruleId: rule(parent, 2, false).ruleId, ruleVersion: 2 }],
          ),
        StaleSourceWriteError,
        `${entry.name} stale scan writes nothing after the derived pointer move`,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('K6/D7b: a removed then re-added non-Gmail account remains dark until another approved point is installed', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const entry of cases) {
    const removed = `acc_${entry.source.toUpperCase()}_REMOVED`;
    const retained = `acc_${entry.source.toUpperCase()}_RETAINED`;
    const readd: ReplacementCase = {
      ...entry,
      oldAccounts: [removed, retained].sort(),
      newAccounts: [removed, retained].sort(),
      oldOptions:
        entry.source === 'slack'
          ? { channel: 'slack', conversations: ['C-k6'] }
          : entry.source === 'resend'
            ? entry.oldOptions
            : { channel: 'whatsapp', chats: ['chat-k6'] },
      newOptions:
        entry.source === 'slack'
          ? { channel: 'slack', conversations: ['C-k6'] }
          : entry.source === 'resend'
            ? entry.oldOptions
            : { channel: 'whatsapp', chats: ['chat-k6'] },
      oldOnly: {
        accountId: removed,
        scopeId:
          entry.source === 'resend'
            ? entry.oldOnly.scopeId
            : entry.source === 'slack'
              ? `slack:${removed}:C-k6`
              : 'chat:chat-k6',
      },
      newOnly: {
        accountId: retained,
        scopeId:
          entry.source === 'resend'
            ? entry.oldOnly.scopeId
            : entry.source === 'slack'
              ? `slack:${retained}:C-k6`
              : 'chat:chat-k6',
      },
      shared: {
        accountId: retained,
        scopeId:
          entry.source === 'resend'
            ? entry.oldOnly.scopeId
            : entry.source === 'slack'
              ? `slack:${retained}:C-k6`
              : 'chat:chat-k6',
      },
    };
    const fixture = await setup(readd);
    try {
      fixture.versions.createRule(rule(readd, 1, true));
      await approve(fixture.runtime, fixture.approvals, rule(readd, 1, true).ruleId, 1);
      fixture.store.database.prepare('UPDATE event_settings SET enabled = 1 WHERE singleton = 1').run();
      delete fixture.config.accounts[`account-${removed}`];
      fixture.store.immediate(() =>
        purgeRemovedAccountWork(fixture.store.database, { source: readd.source, accountId: removed }, 1),
      );
      fixture.config.accounts[`account-${removed}`] = { id: removed, platform: readd.source } as never;

      const calls: string[] = [];
      const scheduler = new EventScheduler({
        store: fixture.store,
        lifecycle: new EventLifecycle(fixture.store),
        activations: { resumeClaimedCompletions: async () => undefined } as never,
        dispatcher: { recoverLeases: async () => undefined } as never,
        expiry: { sweepAll: async () => undefined } as never,
        cipher: {
          decrypt: async (_location: unknown, record: Uint8Array) => Buffer.from(record),
        } as never,
        approvals: {} as never,
        config: { load: async () => fixture.config } as never,
        taint: {} as never,
        gmailSourceFor: async () => {
          throw new Error('K6 source test never polls Gmail');
        },
        sourceWorkFor: async (scope) => {
          calls.push(`${scope.accountId}:${scope.scopeId}`);
          return undefined;
        },
        mailboxLock: new MailboxLock(new SourceScopeLock()),
        sourceRegistry: phaseDSourceRegistry(),
        whatsappVisibilityFence: createPhaseDWhatsAppOwnerComposition({
          database: fixture.store,
          eventOperations: {
            withCurrentEventVisibility: async (_input, work) =>
              work({ version: 1, digest: 'k6-fence', seesMessage: () => true }),
          },
        }).visibilityFence,
        now: () => 10_000,
      });
      await scheduler.tick();
      assert.equal(
        calls.some((call) => call.startsWith(`${removed}:`)),
        false,
        `${entry.name} re-add has no old cut-over point and is dark`,
      );
      assert.ok(
        calls.some((call) => call.startsWith(`${retained}:`)),
        `${entry.name} retains only the live account point`,
      );
      assert.equal(
        fixture.store.database
          .prepare('SELECT 1 FROM rule_activation_points WHERE source = ? AND account_id = ?')
          .get(readd.source, removed),
        undefined,
      );
    } finally {
      fixture.store.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }
});

test('D7b: each non-Gmail source settles content-free at all three completion-deadline boundaries', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const entry of cases) {
    for (const boundary of ['baseline-write', 'after-baseline', 'finalise'] as const) {
      let now = Date.now();
      let encryptedPoints = 0;
      const deadlineEntry: ReplacementCase = {
        ...entry,
        oldAccounts: [`acc_${entry.source.toUpperCase()}_DEADLINE`],
        newAccounts: [`acc_${entry.source.toUpperCase()}_DEADLINE`],
        oldOptions:
          entry.source === 'slack'
            ? { channel: 'slack', conversations: ['C-deadline'] }
            : entry.source === 'resend'
              ? entry.oldOptions
              : { channel: 'whatsapp', chats: ['chat-deadline'] },
        newOptions:
          entry.source === 'slack'
            ? { channel: 'slack', conversations: ['C-deadline'] }
            : entry.source === 'resend'
              ? entry.oldOptions
              : { channel: 'whatsapp', chats: ['chat-deadline'] },
      };
      const fixture = await setup(deadlineEntry, {
        now: () => now,
        encryptBaseline: () => {
          if (boundary === 'baseline-write') now = Date.now() + 3_600_001;
        },
        afterBaseline: () => {
          if (boundary === 'after-baseline') now = Date.now() + 3_600_001;
        },
        encryptPoint: () => {
          encryptedPoints += 1;
          if (boundary === 'finalise') now = Date.now() + 3_600_001;
        },
      });
      try {
        fixture.versions.createRule(rule(deadlineEntry, 1, true));
        const prepared = (await fixture.runtime.prepareRule({
          ruleId: rule(deadlineEntry, 1, true).ruleId,
          version: 1,
        })) as PreparedActivation;
        const answer = await fixture.approvals.issueDisclosureChallenge(prepared.approvalId);
        await assert.rejects(
          () => fixture.runtime.approve({ approvalId: prepared.approvalId, answer }),
          () => true,
          `${entry.name} ${boundary} must settle at its completion deadline`,
        );
        assert.deepEqual(
          {
            ...(fixture.store.database
              .prepare('SELECT status, failure_code FROM activation_intents WHERE id = ?')
              .get(prepared.intentId) as Record<string, unknown>),
          },
          { status: 'failed', failure_code: 'COMPLETION_TIMEOUT' },
          `${entry.name} ${boundary}`,
        );
        assert.equal(
          fixture.store.database
            .prepare('SELECT 1 FROM rule_activation_points WHERE activation_id = ?')
            .get(prepared.intentId),
          undefined,
          `${entry.name} ${boundary} leaves no point`,
        );
        if (boundary === 'baseline-write') {
          assert.equal(
            fixture.store.database
              .prepare('SELECT 1 FROM activation_baselines WHERE intent_id = ?')
              .get(prepared.intentId),
            undefined,
            `${entry.name} baseline transaction writes no baseline after its deadline`,
          );
        }
        if (boundary === 'after-baseline') {
          assert.equal(encryptedPoints, 0, `${entry.name} after-baseline deadline never prepares a point`);
        }
        assert.equal(
          fixture.store.database.prepare('SELECT 1 FROM cursors WHERE source = ?').get(deadlineEntry.source),
          undefined,
          `${entry.name} ${boundary} leaves no cursor`,
        );
        assert.equal(
          fixture.store.database.prepare('SELECT 1 FROM whatsapp_snapshot_heads').get(),
          undefined,
          `${entry.name} ${boundary} leaves no source head`,
        );
      } finally {
        fixture.store.close();
        await rm(fixture.root, { recursive: true, force: true });
      }
    }
  }
});
