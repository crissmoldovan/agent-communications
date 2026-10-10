import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { KeyringModule, SecretStore } from '@agentcomms/core';
import { canonicalJson, KeychainSecretStore, sha256Hex } from '@agentcomms/core';
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

/**
 * Stands in for the native keyring that core's real keychain store drives. `items` is what the keychain holds;
 * `persist: false` models a keychain that accepts a write and keeps nothing.
 */
function fakeKeyring(items: Map<string, string>, options: { readonly persist: boolean } = { persist: true }) {
  const module: KeyringModule = {
    AsyncEntry: class {
      readonly #account: string;
      constructor(_service: string, account: string) {
        this.#account = account;
      }
      async getPassword(): Promise<string | undefined> {
        return items.get(this.#account);
      }
      async setPassword(password: string): Promise<void> {
        if (options.persist) items.set(this.#account, password);
      }
      async deletePassword(): Promise<boolean> {
        return items.delete(this.#account);
      }
    } as unknown as KeyringModule['AsyncEntry'],
  };
  return module;
}

/** One target with a stored webhook-signing generation, its event secrets in the file backend. */
async function fileBackedTarget(
  opened: Awaited<ReturnType<typeof openEventDatabase>>,
  keychain: SecretStore,
  id: string,
) {
  const document = canonicalJson({
    targetId: id,
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
    .run(`${id}@1`, id, 1, document, digest);
  const file = new MemorySecretStore('file');
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
    owner: { kind: 'target', id, version: 1, digest },
    purpose: 'webhook-signing',
    material: `synthetic-${id}-sentinel`,
    expectedPriorGeneration: null,
  });
  return {
    file,
    control: new B3SecretControl({ database: opened.database, paths: opened.paths, secrets, cipher, quiescer }),
  };
}

function selectedBackend(opened: Awaited<ReturnType<typeof openEventDatabase>>): string {
  return (opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as { value: string })
    .value;
}

test("B3 event-secret migration read-back reaches the keychain itself, not the store's cache", {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-migrate-readback-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const items = new Map<string, string>();
      const keychain = new KeychainSecretStore(fakeKeyring(items, { persist: false }), 'synthetic-ns:events');
      const { file, control } = await fileBackedTarget(opened, keychain, 'target-readback');
      const before = new Map(file.values);
      await assert.rejects(
        control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain }),
        (error: unknown) =>
          error instanceof EventSecretError &&
          error.code === 'EVENT_SECRET_SELECTOR' &&
          /did not verify in the destination backend/.test(error.message),
        'a keychain that kept nothing fails the read-back even though the store cached its own write',
      );
      assert.equal(selectedBackend(opened), 'file', 'the selector stays on the backend that still holds every secret');
      assert.deepEqual(new Map(file.values), before, 'no old copy is removed');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test("B3 event-secret migration retry checks the keychain itself, not the store's cache", {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-migrate-retry-cache-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const items = new Map<string, string>();
      const keychain = new KeychainSecretStore(fakeKeyring(items), 'synthetic-ns:events');
      const { file, control } = await fileBackedTarget(opened, keychain, 'target-retry-cache');
      const deleteSource = file.delete.bind(file);
      file.delete = async () => false;
      const first = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      const changed = first.leftovers.find((ref) => file.values.get(ref) === 'synthetic-target-retry-cache-sentinel');
      assert.ok(changed !== undefined, 'the signing secret is among the leftovers');
      const account = [...items.keys()].find((key) => key.endsWith(`:${changed}`));
      assert.ok(account !== undefined, 'the keychain holds the signing secret under its reference');
      // Another process, or a keychain reset, changes the item; the store instance still caches what it wrote.
      items.set(account, 'synthetic-wrong-selected-value');
      const before = new Map(file.values);
      file.delete = deleteSource;
      await assert.rejects(
        control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain }),
        (error: unknown) =>
          error instanceof EventSecretError &&
          error.code === 'EVENT_SECRET_SELECTOR' &&
          /no longer matches its migration source/.test(error.message),
        'the retry compares the keychain item, not the cached copy of its own write',
      );
      assert.deepEqual(new Map(file.values), before, 'every old copy, including the only correct one, is retained');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

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
        (error: unknown) =>
          error instanceof EventSecretError &&
          error.code === 'EVENT_SECRET_SELECTOR' &&
          /no longer matches its migration source/.test(error.message),
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
      const again = await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain });
      assert.deepEqual(again.leftovers, [], 'a retry after a clean migration reports nothing already gone');
      await assert.rejects(
        control.migrateSecrets({ from: 'file', to: 'keychain', source: keychain, target: keychain }),
        (error: unknown) => error instanceof EventSecretError && /do not match its backends/.test(error.message),
        'one store passed as both source and target is refused before anything is deleted',
      );
      assert.equal(keychain.values.size > 0, true, 'the selected copies are untouched');
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
