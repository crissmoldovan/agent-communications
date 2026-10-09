import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { ImmutableVersions } from '../src/domain/versions.ts';
import { secretWebhookUrlDescriptor } from '../src/domain/webhook-target.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStoreKind,
  eventKeychainNamespace,
  migrateEventSecrets,
  openEventSecretStore,
  selectEventSecretStore,
  storeEventSecretGeneration,
  storeSecretWebhookUrl,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

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

class JournalSecretStore extends MemorySecretStore {
  readonly journal: string[];
  #pauseNextRead = false;
  #releaseRead: (() => void) | undefined;
  #startedRead: (() => void) | undefined;
  readonly readStarted = new Promise<void>((resolve) => {
    this.#startedRead = resolve;
  });

  constructor(kind: EventSecretStoreKind, journal: string[]) {
    super(kind);
    this.journal = journal;
  }

  pauseNextRead(): void {
    this.#pauseNextRead = true;
  }

  continueRead(): void {
    this.#releaseRead?.();
  }

  override async get(ref: string): Promise<string | null> {
    this.journal.push(`${this.kind}:get:${ref}`);
    if (this.#pauseNextRead) {
      this.#pauseNextRead = false;
      this.#startedRead?.();
      await new Promise<void>((resolve) => {
        this.#releaseRead = resolve;
      });
    }
    return super.get(ref);
  }

  override async set(ref: string, value: string): Promise<void> {
    this.journal.push(`${this.kind}:set:${ref}`);
    await super.set(ref, value);
  }

  override async delete(ref: string): Promise<boolean> {
    this.journal.push(`${this.kind}:delete:${ref}`);
    return super.delete(ref);
  }
}

test('SEC-B1: event masters use the database-selected backend, separate namespace, and rotation ledger', {
  skip: WINDOWS_SKIP,
}, async () => {
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

test('SEC-B1: an unavailable initial keychain stops selection instead of falling back to files', {
  skip: WINDOWS_SKIP,
}, async () => {
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

test('SEC-B1: event file secrets use the daemon-owned private directory and hashed owner-only files', {
  skip: WINDOWS_SKIP,
}, async () => {
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

test('SEC-B1: event-secret migration uses only database references and rolls copied values back before a selector change', {
  skip: WINDOWS_SKIP,
}, async () => {
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

test('B2-T3: event-secret migration copies masters and every current or overlap network generation before selecting its destination', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-network-secret-migration-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      const targetDocument = JSON.stringify({ kind: 'webhook', targetId: 'target-1', version: 1 });
      const subscriberDocument = JSON.stringify({ kind: 'sse', subscriberId: 'subscriber-1', version: 1 });
      const targetDigest = '1'.repeat(64);
      const subscriberDigest = '2'.repeat(64);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-1@1', 'target-1', 1, targetDocument, targetDigest);
      opened.database
        .prepare(
          'INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, ?, ?, ?)',
        )
        .run('subscriber-1@1', 'subscriber-1', 1, subscriberDocument, subscriberDigest);
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file, keychain },
      });
      const cipher = new EventRecordCipher(opened.database, secrets);
      await secrets.currentMaster();
      const target = { kind: 'target' as const, id: 'target-1', version: 1, digest: targetDigest };
      const subscriber = { kind: 'subscriber' as const, id: 'subscriber-1', version: 1, digest: subscriberDigest };
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: target,
        purpose: 'secret-url',
        material: 'hidden-url-value',
        expectedPriorGeneration: null,
      });
      const signing = await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: target,
        purpose: 'webhook-signing',
        material: 'hidden-signing-first',
        expectedPriorGeneration: null,
      });
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: target,
        purpose: 'webhook-signing',
        material: 'hidden-signing-second',
        expectedPriorGeneration: signing.generation,
      });
      const bearer = await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: subscriber,
        purpose: 'sse-bearer',
        material: 'hidden-bearer-first',
        expectedPriorGeneration: null,
      });
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: subscriber,
        purpose: 'sse-bearer',
        material: 'hidden-bearer-second',
        expectedPriorGeneration: bearer.generation,
      });

      const migration = await migrateEventSecrets({
        database: opened.database,
        paths: opened.paths,
        from: 'file',
        to: 'keychain',
        source: file,
        target: keychain,
        referenceCipher: cipher,
      });
      assert.equal(
        migration.moved,
        6,
        'the master plus URL, current and overlap signing/bearer references move together',
      );
      assert.deepEqual(migration.leftovers, []);
      assert.equal(file.values.size, 0);
      const selected = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file, keychain },
      });
      const selectedCipher = new EventRecordCipher(opened.database, selected);
      assert.deepEqual([...keychain.values.keys()].sort(), await selected.references(selectedCipher));
      assert.equal(JSON.stringify(signing).includes('hidden-signing-first'), false);
      assert.equal(JSON.stringify(bearer).includes('hidden-bearer-first'), false);
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T3: the internal secret-URL factory commits only a matching opaque generation and never returns URL material', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-secret-url-factory-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const url = 'https://receiver.example.test/private-path?credential=fixture';
      const document = {
        targetId: 'target-url',
        version: 1,
        kind: 'webhook' as const,
        url: secretWebhookUrlDescriptor(url),
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks' as const,
        ordering: 'strict' as const,
        retryLimit: 20,
        representation: 'enveloped' as const,
      };
      new ImmutableVersions(opened.database).createInternalTarget(document);
      await selectEventSecretStore(opened.database, 'file');
      const file = new MemorySecretStore('file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file },
      });
      const generation = await storeSecretWebhookUrl({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher: new EventRecordCipher(opened.database, secrets),
        document,
        completeUrl: url,
        expectedPriorGeneration: null,
      });
      assert.equal(generation.purpose, 'secret-url');
      assert.equal(JSON.stringify(generation).includes(url), false);
      assert.equal(JSON.stringify(generation).includes('private-path'), false);
      assert.equal(JSON.stringify(generation).includes('credential=fixture'), false);
      assert.equal(JSON.stringify(generation).includes('event-secret:'), false);
      await assert.rejects(
        storeSecretWebhookUrl({
          database: opened.database,
          paths: opened.paths,
          store: secrets,
          cipher: new EventRecordCipher(opened.database, secrets),
          document,
          completeUrl: 'https://receiver.example.test/other-path?credential=fixture',
          expectedPriorGeneration: generation.generation,
        }),
        (error: unknown) => error instanceof Error && !error.message.includes('other-path'),
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T3: migration locks create, rotation and reconciliation; it reads back every copy before selecting or retiring', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-migration-lock-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const journal: string[] = [];
      const file = new JournalSecretStore('file', journal);
      const keychain = new JournalSecretStore('keychain', journal);
      const document = JSON.stringify({ kind: 'webhook', targetId: 'target-lock', version: 1 });
      const digest = '3'.repeat(64);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-lock@1', 'target-lock', 1, document, digest);
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file, keychain },
      });
      const cipher = new EventRecordCipher(opened.database, secrets);
      await secrets.currentMaster();
      const owner = { kind: 'target' as const, id: 'target-lock', version: 1, digest };
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'webhook-signing',
        material: 'first-signing-secret',
        expectedPriorGeneration: null,
      });
      const references = await secrets.references(cipher);
      file.pauseNextRead();
      const moving = migrateEventSecrets({
        database: opened.database,
        paths: opened.paths,
        from: 'file',
        to: 'keychain',
        source: file,
        target: keychain,
        referenceCipher: cipher,
      });
      await file.readStarted;
      const creating = storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'webhook-signing',
        material: 'second-signing-secret',
        expectedPriorGeneration: 1,
      });
      const rotating = secrets.rotateMaster();
      const reconciling = secrets.reconcileRetiredGenerations(cipher);
      const staleStoreRefusals = [creating, rotating, reconciling].map((delayed) =>
        assert.rejects(
          delayed,
          (error: unknown) => error instanceof Error && 'code' in error && error.code === 'EVENT_SECRET_SELECTOR',
        ),
      );
      file.continueRead();
      assert.equal((await moving).moved, references.length);
      await Promise.all(staleStoreRefusals);
      assert.deepEqual([...keychain.values.keys()].sort(), references);
      assert.equal(file.values.size, 0, 'the old backend retires only after a committed selector');
      const firstSourceDelete = journal.findIndex((entry) => entry.startsWith('file:delete:'));
      const finalTargetRead = journal.reduce(
        (last, entry, index) => (entry.startsWith('keychain:get:') ? index : last),
        -1,
      );
      assert.ok(firstSourceDelete > finalTargetRead, 'source retirement follows every target read-back');
      const selector = opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as {
        value: string;
      };
      assert.equal(selector.value, 'keychain');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T3: a failed destination read-back leaves the prior selector and every source reference intact', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-migration-rollback-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const file = new MemorySecretStore('file');
      const corrupt = new MemorySecretStore('keychain');
      corrupt.get = async () => 'corrupt-read-back';
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file },
      });
      await secrets.currentMaster();
      const references = await secrets.references();
      await assert.rejects(
        migrateEventSecrets({
          database: opened.database,
          paths: opened.paths,
          from: 'file',
          to: 'keychain',
          source: file,
          target: corrupt,
        }),
        /did not verify/,
      );
      assert.deepEqual([...file.values.keys()].sort(), references, 'failure never retires a source value first');
      assert.equal(corrupt.values.size, 0, 'an unselected, failed destination is cleaned');
      assert.equal(
        (opened.database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as { value: string })
          .value,
        'file',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B2-T3: reconciliation removes only expired retired generations after their ledger rows no longer name them', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-secret-reconcile-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const file = new MemorySecretStore('file');
      const digest = '4'.repeat(64);
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-reconcile@1', 'target-reconcile', 1, '{"kind":"webhook"}', digest);
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file },
      });
      const cipher = new EventRecordCipher(opened.database, secrets);
      const owner = { kind: 'target' as const, id: 'target-reconcile', version: 1, digest };
      const first = await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'webhook-signing',
        material: 'first',
        expectedPriorGeneration: null,
      });
      const expiry = Date.now() + 1_000;
      await storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner,
        purpose: 'webhook-signing',
        material: 'second',
        expectedPriorGeneration: first.generation,
        overlapExpiresAt: expiry,
      });
      assert.equal((await secrets.references(cipher)).length, 3, 'master, current and overlap remain reachable');
      assert.deepEqual(await secrets.reconcileRetiredGenerations(cipher, expiry), []);
      assert.equal((await secrets.references(cipher)).length, 2, 'only master and current remain reachable');
      assert.equal(file.values.size, 2);
      const retired = opened.database
        .prepare("SELECT COUNT(*) AS count FROM event_secret_generations WHERE lifecycle = 'retired'")
        .get() as { count: number };
      assert.equal(retired.count, 0);
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

test('SEC-B1: a released core secret migration cannot enumerate, select, or change event secret values', {
  skip: WINDOWS_SKIP,
}, async () => {
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
