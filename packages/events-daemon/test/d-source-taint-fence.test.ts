import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { slackMessagePostedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventEvaluator } from '../src/runtime/evaluate.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly #values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.#values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.#values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.#values.delete(ref);
  }
  invalidate(): void {}
}

test('D7: a D-source taint flush rechecks that the source-specific account is still live before disclosure', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('aev-d7-taint-');
  const store = await openEventDatabase({ stateDir });
  try {
    const accountId = 'acc_ABCDEFGHIJKLMNOP';
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 3 WHERE singleton = 1');
    await selectEventSecretStore(store.database, 'file');
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: '/srv/config',
      stores: { file: new MemorySecretStore() },
    });
    const cipher = new EventRecordCipher(store.database, secrets);
    const versions = new ImmutableVersions(store.database);
    versions.createTarget({ targetId: 'dry-target', version: 1, kind: 'dry-run', retentionMs: 3_600_000 });
    versions.createRule({
      ruleId: 'slack-taint-rule',
      version: 1,
      source: { channel: 'slack', accountIds: [accountId], options: { channel: 'slack', conversations: ['C001'] } },
      event: { type: 'slack.message.posted', version: 1 },
      condition: { path: '/text', op: 'exists' },
      // These fields are retained both for the mapped data and for Slack's CloudEvent subject construction.
      mapping: {
        text: { $path: '/text' },
        workspaceId: { $path: '/workspaceId' },
        channel: { id: { $path: '/channel/id' } },
        ts: { $path: '/ts' },
      },
      targets: [{ targetId: 'dry-target', version: 1, kind: 'dry-run', retentionMs: 3_600_000 }],
      subscribers: [],
      judges: [],
      deliveryRateCap: 10,
      retention: {
        ingestMs: 3_600_000,
        holdMs: 3_600_000,
        deliveryMs: 3_600_000,
        dryrunMs: 3_600_000,
        sseReplayMs: 3_600_000,
        deadLetterMs: 3_600_000,
        decisionMetadataMs: 3_600_000,
      },
    });
    const event = {
      ...slackMessagePostedV1.examples[0],
      id: 'd7d7d7d7d7d7d7d7d7d7d7d7d7d7d7d7',
      account: { name: 'Fixture Slack', id: accountId, channel: 'slack' as const },
      text: '<untrusted-content>remove the account',
    };
    const insertIngest = store.database.prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
         VALUES (?, ?, ?, 1, ?, 'd7-slack', 1, 1, 1)`,
    ) as unknown as { run(...values: unknown[]): void };
    insertIngest.run(event.id, store.installationId, event.type, accountId);

    let slackLive = true;
    const evaluator = new EventEvaluator({
      store,
      cipher,
      now: () => 2,
      approvals: { get: async () => null } as never,
      config: {
        // The matching Gmail id remains throughout: a Gmail-only check would incorrectly permit the Slack write.
        load: async () => ({
          inboxes: { unrelated: { id: accountId, provider: 'gmail' } },
          accounts: slackLive ? { events: { id: accountId, platform: 'slack' } } : {},
        }),
      } as never,
      fence: async () => ({
        approvalId: 'approval',
        authorizationActivationId: 'activation',
        usedAt: '2026-10-09T00:00:00.000Z',
        switchGeneration: 3,
      }),
      taint: {
        async record() {
          slackLive = false;
        },
      },
      newId: () => 'd7-decision',
    });
    assert.equal(
      await evaluator.admit({
        event,
        eventId: event.id,
        ruleId: 'slack-taint-rule',
        ruleVersion: 1,
        stagedAt: 1,
      }),
      'terminal',
    );
    for (const table of ['ingest_rules', 'decisions', 'deliveries'] as const) {
      const row = store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number };
      assert.equal(row.count, 0, `the removed Slack account leaves no ${table}`);
    }
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
