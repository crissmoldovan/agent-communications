import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { assertObjectSecretReady, ObjectSecretReadinessError } from '../src/runtime/object-secret-readiness.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStoreKind,
  openEventSecretStore,
  selectEventSecretStore,
  storeEventSecretGeneration,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';
import { testWriterQuiescer } from './support/writer-quiescer.ts';

class MemorySecretStore implements SecretStore {
  readonly kind: EventSecretStoreKind = 'file';
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

test('B3 secret readiness refuses an incomplete exact target version and accepts its completed slots', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-ready-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        targetId: 'target-ready',
        version: 1,
        kind: 'webhook',
        url: { kind: 'secret', scheme: 'https', host: 'receiver.invalid', port: 443, sha256: 'a'.repeat(64) },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'enveloped',
      });
      const digest = sha256Hex(document);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-ready@1', 'target-ready', 1, document, digest);
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file: new MemorySecretStore() },
      });
      const cipher = new EventRecordCipher(opened.database, secrets, testWriterQuiescer());

      await assert.rejects(
        () =>
          assertObjectSecretReady({
            database: opened.database,
            secrets,
            cipher,
            owner: { kind: 'target', id: 'target-ready', version: 1 },
          }),
        (error: unknown) => error instanceof ObjectSecretReadinessError && error.code === 'OBJECT_SECRET_INCOMPLETE',
      );

      const owner = { kind: 'target' as const, id: 'target-ready', version: 1, digest };
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'secret-url',
        material: 'https://receiver.invalid/synthetic-secret',
        expectedPriorGeneration: null,
      });
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'webhook-signing',
        material: 'whsec_synthetic',
        expectedPriorGeneration: null,
      });

      assert.deepEqual(
        await assertObjectSecretReady({
          database: opened.database,
          secrets,
          cipher,
          owner: { kind: 'target', id: 'target-ready', version: 1 },
        }),
        { ready: true },
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 secret readiness treats only an exact hosted judge key slot as complete', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-judge-ready-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        judgeId: 'judge-ready',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev',
      });
      const digest = sha256Hex(document);
      opened.database
        .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('judge-ready@1', 'judge-ready', 1, document, digest);
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file: new MemorySecretStore() },
      });
      const cipher = new EventRecordCipher(opened.database, secrets, testWriterQuiescer());
      const owner = { kind: 'judge' as const, id: 'judge-ready', version: 1, digest };
      await assert.rejects(
        () => assertObjectSecretReady({ database: opened.database, secrets, cipher, owner }),
        (error: unknown) => error instanceof ObjectSecretReadinessError && error.code === 'OBJECT_SECRET_INCOMPLETE',
      );
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'judge-key',
        material: 'synthetic-judge-key',
        expectedPriorGeneration: null,
      });
      assert.deepEqual(await assertObjectSecretReady({ database: opened.database, secrets, cipher, owner }), {
        ready: true,
      });
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
