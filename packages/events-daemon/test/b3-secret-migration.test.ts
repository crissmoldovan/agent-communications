import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { B3SecretControl } from '../src/runtime/b3-secret-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  EventSecretError,
  type EventSecretStoreKind,
  openEventSecretStore,
  selectEventSecretStore,
  storeEventSecretGeneration,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly kind: EventSecretStoreKind;
  constructor(kind: EventSecretStoreKind) {
    this.kind = kind;
  }
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

test('B3 event-secret migration moves only daemon references and leaves the core selector untouched', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-migrate-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        targetId: 'target-migrate',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://receiver.invalid/events' },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'plain',
      });
      const digest = sha256Hex(document);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-migrate@1', 'target-migrate', 1, document, digest);
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file, keychain },
      });
      const quiescer = new WriterQuiescer();
      const cipher = new EventRecordCipher(opened.database, secrets, quiescer);
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: { kind: 'target', id: 'target-migrate', version: 1, digest },
        purpose: 'webhook-signing',
        material: 'synthetic-migration-secret',
        expectedPriorGeneration: null,
      });
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher,
        quiescer,
      });
      const result = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      assert.ok(result.moved >= 2, 'master and exact slot references move together');
      assert.deepEqual(result.leftovers, []);
      assert.equal(file.values.size, 0);
      assert.ok(keychain.values.size >= 2);
      assert.equal(
        (opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as { value: string })
          .value,
        'keychain',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 event-secret migration retry keeps every leftover when a selected copy no longer matches it', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-migrate-leftover-mismatch-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        targetId: 'target-leftover-mismatch',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://receiver.invalid/events' },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'plain',
      });
      const digest = sha256Hex(document);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-leftover-mismatch@1', 'target-leftover-mismatch', 1, document, digest);
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file, keychain },
      });
      const quiescer = new WriterQuiescer();
      const cipher = new EventRecordCipher(opened.database, secrets, quiescer);
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: { kind: 'target', id: 'target-leftover-mismatch', version: 1, digest },
        purpose: 'webhook-signing',
        material: 'synthetic-leftover-mismatch-sentinel',
        expectedPriorGeneration: null,
      });
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher,
        quiescer,
      });
      const deleteSource = file.delete.bind(file);
      file.delete = async () => false;
      const first = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      assert.ok(first.leftovers.length > 0, 'failed post-selector cleanup is reported as named opaque leftovers');
      const before = new Map(file.values);
      // The signing secret's own copy, not the master's: a changed master already fails to decrypt the references.
      const changed = first.leftovers.find((ref) => file.values.get(ref) === 'synthetic-leftover-mismatch-sentinel');
      assert.ok(changed !== undefined && keychain.values.has(changed), 'the signing secret is among the leftovers');
      keychain.values.set(changed, 'synthetic-wrong-selected-value');

      file.delete = deleteSource;
      await assert.rejects(
        control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain }),
        (error: unknown) => error instanceof EventSecretError && error.code === 'EVENT_SECRET_SELECTOR',
        'a retry refuses cleanup while a selected copy differs from its migration source',
      );
      assert.deepEqual(new Map(file.values), before, 'every old copy, including the only correct one, is retained');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 event-secret migration retries post-selector cleanup of the same named opaque leftovers', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-migrate-leftover-retry-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        targetId: 'target-leftover-retry',
        version: 1,
        kind: 'webhook',
        url: { kind: 'plain', value: 'https://receiver.invalid/events' },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'plain',
      });
      const digest = sha256Hex(document);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-leftover-retry@1', 'target-leftover-retry', 1, document, digest);
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file, keychain },
      });
      const quiescer = new WriterQuiescer();
      const cipher = new EventRecordCipher(opened.database, secrets, quiescer);
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: { kind: 'target', id: 'target-leftover-retry', version: 1, digest },
        purpose: 'webhook-signing',
        material: 'synthetic-leftover-retry-sentinel',
        expectedPriorGeneration: null,
      });
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher,
        quiescer,
      });
      const deleteSource = file.delete.bind(file);
      file.delete = async () => false;
      const first = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      assert.ok(first.leftovers.length > 0, 'failed post-selector cleanup is reported as named opaque leftovers');
      assert.equal(
        file.values.size,
        first.leftovers.length,
        'the only retained source values are the reported leftovers',
      );

      file.delete = deleteSource;
      const retry = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      assert.deepEqual(retry.leftovers, [], 'the same migration request cleans post-selector leftovers on retry');
      assert.equal(file.values.size, 0, 'retry leaves no source-backend material behind');
      assert.equal(
        (opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as { value: string })
          .value,
        'keychain',
        'retry never moves the selector back to the old backend',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
