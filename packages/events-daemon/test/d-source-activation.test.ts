import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime, type PreparedActivation } from '../src/runtime/activations.ts';
import { completeSourceReplacementDrain } from '../src/runtime/replacements.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { LocalEventSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const accountId = 'acc_slack_activation';
const target = { targetId: 'target-source-activation', version: 1, kind: 'dry-run' as const, retentionMs: 86_400_000 };
const rule = {
  ruleId: 'rule-source-activation',
  version: 1,
  source: {
    channel: 'slack' as const,
    accountIds: [accountId],
    options: { channel: 'slack' as const, conversations: ['C-activation'] },
  },
  event: { type: 'slack.message.posted', version: 1 },
  condition: { path: '/text', op: 'exists' },
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

test('D7b: a Slack drain cannot finalise from top-level history until its aggregate reply barrier also reaches P', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-d-source-slack-drain-');
  const store = await openEventDatabase({ stateDir });
  try {
    const scope = { source: 'slack' as const, accountId: 'acc_SLACKDRAIN', scopeId: 'slack:acc_SLACKDRAIN:C-drain' };
    store.database
      .prepare(
        `INSERT INTO activation_intents
         (id, kind, document, digest, effect, replacement_of_version, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
         VALUES ('intent-slack', 'rule', '{}', 'digest', '{}', NULL, '[]', '[]', 'pending-completion', 1, 3600001, 1, 1)`,
      )
      .run();
    store.database
      .prepare(
        `INSERT INTO replacement_drains
         (intent_id, source, account_id, position_scope, old_in_scope, new_in_scope)
         VALUES ('intent-slack', ?, ?, ?, 1, 1)`,
      )
      .run(scope.source, scope.accountId, scope.scopeId);

    assert.equal(
      completeSourceReplacementDrain(store.database, {
        intentId: 'intent-slack',
        scope,
        at: 10,
        slack: { historyCovered: true, repliesCovered: false },
      }),
      false,
      'top-level coverage alone is never the Slack drain proof',
    );
    assert.equal(
      (
        store.database.prepare("SELECT drained_at FROM replacement_drains WHERE intent_id = 'intent-slack'").get() as {
          drained_at: number | null;
        }
      ).drained_at,
      null,
    );
    assert.equal(
      completeSourceReplacementDrain(store.database, {
        intentId: 'intent-slack',
        scope,
        at: 11,
        slack: { historyCovered: true, repliesCovered: true },
      }),
      true,
    );
    assert.equal(
      (
        store.database.prepare("SELECT drained_at FROM replacement_drains WHERE intent_id = 'intent-slack'").get() as {
          drained_at: number | null;
        }
      ).drained_at,
      11,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('D7b/S:first activation samples and persists the Slack conversation point instead of a Gmail mailbox point', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-d-source-activation-');
  const stateDir = join(root, 'state');
  const configDir = join(root, 'config');
  await mkdir(configDir, { recursive: true });
  const store = await openEventDatabase({ stateDir });
  try {
    const config = emptyConfig();
    config.accounts.slack = { id: accountId, platform: 'slack' } as never;
    const approvals = new ApprovalStore(join(root, 'approvals'), {
      loadConfig: async () => config,
    });
    let slackBaselines = 0;
    const registry = new LocalEventSourceRegistry([
      {
        source: 'slack',
        canonicalise: (value) => value as never,
        scopesFor: ({ accountId: bound }) => [
          { source: 'slack' as const, accountId: bound, scopeId: `slack:${bound}:C-activation` },
        ],
        withScopes: (lock, scopes, work) => lock.withScopes(scopes, work),
        baseline: (sample) => sample(),
        resume: (step) => step(),
        describeCursor: (value) => value,
        cleanup: (_kind, work) => Promise.resolve(work()),
      },
    ]);
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config: { load: async () => config } as never,
      gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '9' }) }) as never,
      sourceRegistry: registry,
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      encryptBaseline: async (_intent: string, _account: string, point: unknown) => Buffer.from(JSON.stringify(point)),
      decryptBaseline: async (_intent: string, _account: string, stored: Uint8Array) =>
        JSON.parse(Buffer.from(stored).toString('utf8')),
      encryptPoint: async ({ position }: { position: unknown }) => Buffer.from(JSON.stringify(position)),
      decryptPoint: async ({ stored }: { stored: Uint8Array }) => JSON.parse(Buffer.from(stored).toString('utf8')),
      sourceBaselineFor: async (input: { readonly source: string }) => {
        assert.equal(input.source, 'slack');
        slackBaselines += 1;
        return { timestamp: '1700000000.000000', replyDrain: { through: '1700000000.000000' } };
      },
    } as never);
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const prepared = (await runtime.prepareRule({ ruleId: rule.ruleId, version: rule.version })) as PreparedActivation;
    const answer = await approvals.issueDisclosureChallenge(prepared.approvalId);
    await runtime.approve({ approvalId: prepared.approvalId, answer });

    assert.equal(slackBaselines, 1);
    assert.equal(
      JSON.stringify(
        store.database
          .prepare('SELECT source, position_scope FROM rule_activation_points WHERE activation_id = ?')
          .all(prepared.intentId),
      ),
      JSON.stringify([{ source: 'slack', position_scope: `slack:${accountId}:C-activation` }]),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test('D7b: every non-Gmail source takes its adapter-owned point on enabled and disabled first activation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-d-source-activation-all-');
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    const cases = [
      {
        source: 'slack' as const,
        accountId: 'acc_SLACKACTIVATION',
        options: { channel: 'slack' as const, conversations: ['C-source'] },
        event: 'slack.message.posted',
        scopes: ['slack:acc_SLACKACTIVATION:C-source'],
        position: { timestamp: '20.000000', replyDrain: { through: '20.000000', topLevelCovered: false } },
      },
      {
        source: 'resend' as const,
        accountId: 'acc_RESENDACTIVATION',
        options: { channel: 'resend' as const, kinds: ['received'] },
        event: 'resend.email.received',
        scopes: ['received'],
        position: { anchorId: 'empty' },
      },
      {
        source: 'resend' as const,
        accountId: 'acc_RESENDSTATUSACT',
        options: { channel: 'resend' as const, kinds: ['status'] },
        event: 'resend.email.status_changed',
        scopes: ['status'],
        position: { startedAt: '2026-10-09T12:00:00.000Z' },
      },
      {
        source: 'whatsapp' as const,
        accountId: 'acc_WHATSACTIVATION',
        options: { channel: 'whatsapp' as const, chats: 'all-allowed' as const },
        event: 'whatsapp.message.received',
        scopes: ['all-allowed'],
        position: {
          capturedAt: '2026-10-09T12:00:00.000Z',
          baselineGeneration: 7,
          baselineIdentities: ['["wa-msg","chat","sender","stanza"]'],
        },
      },
    ];
    const config = emptyConfig();
    for (const entry of cases)
      config.accounts[entry.accountId] = { id: entry.accountId, platform: entry.source } as never;
    const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: async () => config });
    const registry = new LocalEventSourceRegistry(
      ['slack', 'resend', 'whatsapp'].map((source) => ({
        source,
        canonicalise: (value: unknown) => value as never,
        scopesFor: ({ accountId: bound, options }: { accountId: string; options?: { channel?: string } }) => {
          const entry = cases.find((candidate) => candidate.source === source && candidate.accountId === bound);
          if (!entry || options?.channel !== source) return [];
          return entry.scopes.map((scopeId) => ({ source, accountId: bound, scopeId }));
        },
        withScopes: (lock: SourceScopeLock, scopes: readonly unknown[], work: () => Promise<unknown>) =>
          lock.withScopes(scopes as never, work),
        baseline: <T>(sample: () => Promise<T>) => sample(),
        resume: <T>(step: () => Promise<T>) => step(),
        describeCursor: <T>(cursor: T) => cursor,
        cleanup: <T>(_kind: 'reset' | 'drain' | 'purge', work: () => Promise<T>) => work(),
      })) as never,
    );
    const sampled: Array<{ source: string; scopeId: string }> = [];
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config: { load: async () => config } as never,
      gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '9' }) }) as never,
      sourceRegistry: registry,
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      encryptBaseline: async (_intent, _account, point) => Buffer.from(JSON.stringify(point)),
      decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
      decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
      sourceBaselineFor: async ({ source, accountId: bound, scopeId }) => {
        sampled.push({ source, scopeId });
        const entry = cases.find((candidate) => candidate.source === source && candidate.accountId === bound);
        assert.ok(entry, 'the registry may not invent a source baseline');
        return entry.position;
      },
    });
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    for (const enabled of [true, false]) {
      store.database.prepare('UPDATE event_settings SET enabled = ? WHERE singleton = 1').run(enabled ? 1 : 0);
      for (const [index, entry] of cases.entries()) {
        const ruleId = `rule-${enabled ? 'enabled' : 'disabled'}-${index}`;
        const document = {
          ...rule,
          ruleId,
          source: { channel: entry.source, accountIds: [entry.accountId], options: entry.options },
          event: { type: entry.event, version: 1 },
          condition: { path: '/id', op: 'exists' },
        };
        versions.createRule(document);
        const prepared = (await runtime.prepareRule({ ruleId, version: 1 })) as PreparedActivation;
        await runtime.approve({
          approvalId: prepared.approvalId,
          answer: await approvals.issueDisclosureChallenge(prepared.approvalId),
        });
        assert.deepEqual(
          store.database
            .prepare('SELECT source, position_scope FROM rule_activation_points WHERE activation_id = ?')
            .all(prepared.intentId)
            .map((row) => ({ ...row })),
          entry.scopes.map((position_scope) => ({ source: entry.source, position_scope })),
        );
        if (!enabled) {
          assert.equal(
            store.database
              .prepare('SELECT 1 FROM cursors WHERE source = ? AND account_id = ?')
              .get(entry.source, entry.accountId),
            undefined,
            'a disabled first activation has no pre-existing scan cursor to retain',
          );
        }
      }
    }
    assert.deepEqual(
      sampled.map(({ source, scopeId }) => `${source}:${scopeId}`).sort(),
      cases
        .flatMap((entry) => entry.scopes.map((scope) => `${entry.source}:${scope}`))
        .flatMap((key) => [key, key])
        .sort(),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
