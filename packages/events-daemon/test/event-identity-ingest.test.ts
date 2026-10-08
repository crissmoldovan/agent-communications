import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { gmailMessageReceivedV1 } from '@agentcomms/events';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { EventProjectionStore } from '../src/runtime/projections.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
  readonly values = new Map<string, string>();
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
  invalidate(): void {}
}

test('EVAL-B1: equal event identity repeats retain one projection for exactly one event/rule/version tuple', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-identity-');
  const store = await openEventDatabase({ stateDir });
  try {
    await selectEventSecretStore(store.database, 'file');
    const secrets = await openEventSecretStore({
      database: store.database,
      paths: store.paths,
      configDir: '/srv/config',
      stores: { file: new MemorySecretStore() },
    });
    const cipher = new EventRecordCipher(store.database, secrets);
    const accountId = 'ibx_ABCDEFGHIJKLMNOP';
    const target = { targetId: 'target-identity', version: 1, kind: 'dry-run' as const, retentionMs: 3_600_000 };
    const rule = {
      ruleId: 'rule-identity',
      version: 1,
      source: {
        channel: 'gmail' as const,
        accountIds: [accountId],
        options: { channel: 'gmail' as const, labels: 'inbox' as const, includeSpamTrash: false },
      },
      event: { type: 'gmail.message.received', version: 1 },
      condition: { path: '/subject', op: 'exists' },
      mapping: { subject: { $path: '/subject' } },
      targets: [target],
      subscribers: [],
      judges: [],
      deliveryRateCap: 1,
      retention: {
        ingestMs: 3_600_000,
        holdMs: 3_600_000,
        deliveryMs: 3_600_000,
        dryrunMs: 3_600_000,
        sseReplayMs: 3_600_000,
        deadLetterMs: 3_600_000,
        decisionMetadataMs: 3_600_000,
      },
    };
    const versions = new ImmutableVersions(store.database);
    versions.createTarget(target);
    versions.createRule(rule);
    const event = {
      ...gmailMessageReceivedV1.examples[0],
      id: '22222222222222222222222222222222',
      account: { name: 'Inbox', id: accountId, channel: 'gmail' as const },
    };
    const insert = store.database.prepare(
      'INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at) VALUES (?, ?, ?, 1, ?, ?, 1, 1, 1)',
    ) as unknown as { run(...values: unknown[]): void };
    insert.run(event.id, store.installationId, event.type, accountId, 'same-history-message');
    const projections = new EventProjectionStore({ store, cipher });
    await projections.insert({ eventId: event.id, rule: rule as never, event, stagedAt: 1 });
    await projections.insert({ eventId: event.id, rule: rule as never, event, stagedAt: 1 });
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM ingest_rules').get() as { count: number }).count,
      1,
    );
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
});
