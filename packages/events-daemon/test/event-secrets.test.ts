import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStoreKind,
  eventKeychainNamespace,
  migrateEventSecrets,
  openEventSecretStore,
  selectEventSecretStore,
} from '../src/store/event-secrets.ts';

class MemorySecretStore implements SecretStore {
  readonly values = new Map<string, string>();
  readonly kind: EventSecretStoreKind;
  failReads = false;

  constructor(kind: EventSecretStoreKind) {
    this.kind = kind;
  }

  async get(ref: string): Promise<string | null> {
    if (this.failReads) throw new Error('keychain unavailable');
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

test('SEC-B1: event masters use the database-selected backend, separate namespace, and rotation ledger', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-secrets-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const file = new MemorySecretStore('file');
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { file },
      });
      const first = await secrets.currentMaster();
      const rotated = await secrets.rotateMaster();

      assert.notEqual(first.keyId, rotated.keyId);
      assert.deepEqual(
        await secrets.master(first.keyId),
        first.key,
        'a retained record can still select an old master',
      );
      assert.deepEqual(await secrets.references(), [...(await secrets.references())].sort());
      assert.equal(file.values.size, 2);
      const selector = opened.database
        .prepare("SELECT COUNT(*) AS count FROM meta WHERE key = 'event_secret_store' AND value = 'file'")
        .get() as { count: number } | undefined;
      assert.ok(selector);
      assert.equal(selector.count, 1);
      assert.match(eventKeychainNamespace('/separate/config'), /:events$/);
      assert.notEqual(eventKeychainNamespace('/separate/config'), 'separate/config');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: an unavailable initial keychain stops selection instead of falling back to files', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-secret-no-fallback-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const keychain = new MemorySecretStore('keychain');
      const file = new MemorySecretStore('file');
      keychain.failReads = true;
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { keychain, file },
      });
      await assert.rejects(secrets.currentMaster(), /keychain unavailable/);
      assert.equal(file.values.size, 0, 'an event master must never silently land in a file backend');
      assert.equal(
        opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get(),
        undefined,
        'a failed default probe does not commit a selector',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: event file secrets use the daemon-owned private directory and hashed owner-only files', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-file-secrets-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
      });
      await secrets.currentMaster();
      const files = await readdir(opened.paths.secretsDir);
      assert.equal(files.length, 1);
      assert.match(files[0] ?? '', /^[0-9a-f]{32}\.json$/);
      if (process.platform !== 'win32') {
        assert.equal((await stat(opened.paths.secretsDir)).mode & 0o777, 0o700);
        assert.equal((await stat(join(opened.paths.secretsDir, files[0] ?? ''))).mode & 0o777, 0o600);
      }
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: event-secret migration uses only database references and rolls copied values back before a selector change', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-secret-migration-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { file },
      });
      const master = await secrets.currentMaster();
      const result = await migrateEventSecrets({
        database: opened.database,
        paths: opened.paths,
        from: 'file',
        to: 'keychain',
        source: file,
        target: keychain,
      });
      assert.equal(result.moved, 1);
      assert.deepEqual(result.leftovers, []);
      assert.equal(file.values.size, 0);
      assert.equal(keychain.values.size, 1);
      assert.equal(await keychain.get(`event-master:${master.keyId}`), master.key.toString('base64'));

      const refusedTarget = new MemorySecretStore('file');
      refusedTarget.set = async () => {
        throw new Error('injected destination failure');
      };
      await assert.rejects(
        migrateEventSecrets({
          database: opened.database,
          paths: opened.paths,
          from: 'keychain',
          to: 'file',
          source: keychain,
          target: refusedTarget,
        }),
        /injected destination failure/,
      );
      assert.equal(refusedTarget.values.size, 0);
      const selector = opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as
        | { value: string }
        | undefined;
      assert.equal(selector?.value, 'keychain');

      const postSwitch = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { keychain, file },
      });
      await postSwitch.rotateMaster();
      keychain.delete = async () => false;
      const cleanup = await migrateEventSecrets({
        database: opened.database,
        paths: opened.paths,
        from: 'keychain',
        to: 'file',
        source: keychain,
        target: file,
      });
      assert.equal(cleanup.moved, 2);
      assert.equal(cleanup.leftovers.length, 2, 'a failed cleanup is returned for a later retry after selector commit');
      const cleanupSelector = opened.database
        .prepare("SELECT value FROM meta WHERE key = 'event_secret_store'")
        .get() as { value: string } | undefined;
      assert.equal(cleanupSelector?.value, 'file');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: the event-secret implementation never reads core configuration’s secret selector', async () => {
  const source = await readFile(new URL('../src/store/event-secrets.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /config\??\.secrets\??\.store/);
});

test('SEC-B1: a released core secret migration cannot enumerate, select, or change event secret values', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-released-core-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const events = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: join(stateDir, 'core-config'),
      });
      const eventMaster = await events.currentMaster();

      const frozenCore = (await import(
        new URL('../../core/test/fixtures/released-0.13.0/core/dist/index.mjs', import.meta.url).href
      )) as {
        openCore(options: { readonly env: Record<string, string> }): {
          readonly config: {
            load(): Promise<Record<string, unknown>>;
            update(
              change: (config: Record<string, unknown>) => Record<string, unknown>,
            ): Promise<Record<string, unknown>>;
          };
        };
      };
      const frozenMigration = (await import(
        new URL('../../core/test/fixtures/released-0.13.0/core/dist/secrets-migrate-DSFfruvx.mjs', import.meta.url).href
      )) as {
        n(
          core: unknown,
          to: 'keychain',
          options: {
            readonly stores: { readonly source: SecretStore; readonly target: SecretStore };
            readonly surface: 'cli';
          },
        ): {
          plan(config: Record<string, unknown>): Promise<unknown>;
          apply(): Promise<unknown>;
        };
      };
      const configDir = join(stateDir, 'released-core-config');
      const core = frozenCore.openCore({
        env: { AGENT_COMMS_CONFIG_DIR: configDir, HOME: configDir, USERPROFILE: configDir },
      });
      await core.config.update((config) => ({ ...config, secrets: { store: 'file' } }));
      const coreFile = new MemorySecretStore('file');
      const coreKeychain = new MemorySecretStore('keychain');
      const migration = frozenMigration.n(core, 'keychain', {
        stores: { source: coreFile, target: coreKeychain },
        surface: 'cli',
      });
      await migration.plan(await core.config.load());
      await migration.apply();

      assert.deepEqual(await events.master(eventMaster.keyId), eventMaster.key);
      assert.equal((await readdir(opened.paths.secretsDir)).length, 1);
      assert.equal(coreFile.values.size, 0);
      assert.equal(coreKeychain.values.size, 0);
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
