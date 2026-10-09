import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { ApprovalStore, emptyConfig } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { ActivationRuntime } from '../src/runtime/activations.ts';
import { MailboxLock } from '../src/sources/mailbox-lock.ts';
import { phaseDSourceRegistry } from '../src/sources/registry.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('D8: an absent cut-over failpoint is behaviour-free and a supplied callback sees the activation durable edges', {
  skip: WINDOWS_SKIP,
}, async () => {
  const root = await shortTempDir('events-cutover-failpoint-');
  const store = await openEventDatabase({ stateDir: join(root, 'state') });
  try {
    const configDir = join(root, 'config');
    await mkdir(configDir, { recursive: true });
    const config = emptyConfig();
    config.accounts.slack = { id: 'acc_CUTOVER_FAILPOINT', platform: 'slack' } as never;
    const approvals = new ApprovalStore(join(root, 'approvals'), { loadConfig: async () => config });
    const edges: string[] = [];
    const runtime = new ActivationRuntime({
      store,
      approvals,
      config: { load: async () => config } as never,
      gmailSourceFor: async () => ({ getProfile: async () => ({ historyId: '1' }) }) as never,
      sourceRegistry: phaseDSourceRegistry(),
      mailboxLock: new MailboxLock(new SourceScopeLock()),
      sourceBaselineFor: async () => ({ timestamp: '1.000000', replyDrain: { through: '1.000000' } }),
      encryptBaseline: async (_intent, _account, point) => Buffer.from(JSON.stringify(point)),
      decryptBaseline: async (_intent, _account, stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
      encryptPoint: async ({ position }) => Buffer.from(JSON.stringify(position)),
      decryptPoint: async ({ stored }) => JSON.parse(Buffer.from(stored).toString('utf8')),
      failpoint: (edge) => edges.push(edge),
    });
    const versions = new ImmutableVersions(store.database);
    versions.createTarget({
      targetId: 'target-cutover-failpoint',
      version: 1,
      kind: 'dry-run',
      retentionMs: 86_400_000,
    });
    versions.createRule({
      ruleId: 'rule-cutover-failpoint',
      version: 1,
      source: {
        channel: 'slack',
        accountIds: ['acc_CUTOVER_FAILPOINT'],
        options: { channel: 'slack', conversations: ['C-failpoint'] },
      },
      event: { type: 'slack.message.posted', version: 1 },
      condition: { path: '/id', op: 'exists' },
      mapping: { constant: 'safe' },
      targets: [{ targetId: 'target-cutover-failpoint', version: 1, kind: 'dry-run', retentionMs: 86_400_000 }],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 86_400_000,
        holdMs: 86_400_000,
        deliveryMs: 86_400_000,
        dryrunMs: 86_400_000,
        sseReplayMs: 86_400_000,
        deadLetterMs: 86_400_000,
        decisionMetadataMs: 86_400_000,
      },
    });
    const prepared = await runtime.prepareRule({ ruleId: 'rule-cutover-failpoint', version: 1 });
    if (!('approvalId' in prepared)) throw new Error('expected an approved activation');
    await runtime.approve({
      approvalId: prepared.approvalId,
      answer: await approvals.issueDisclosureChallenge(prepared.approvalId),
    });
    assert.deepEqual(
      [...edges].sort(),
      ['before-stage', 'after-stage', 'before-move', 'after-move', 'before-finalise'].sort(),
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
