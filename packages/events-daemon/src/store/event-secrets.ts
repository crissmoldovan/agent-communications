import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  FileSecretStore,
  KeychainSecretStore,
  type KeyringModule,
  keychainNamespace,
  loadKeyringModule,
  type SecretStore,
  withFileLock,
} from '@agentcomms/core';
import type { EventPaths } from '../runtime/paths.ts';

export type EventSecretStoreKind = 'keychain' | 'file';

export class EventSecretError extends Error {
  readonly code: 'EVENT_MASTER_LOST' | 'EVENT_MASTER_UNKNOWN' | 'EVENT_SECRET_SELECTOR';

  constructor(code: EventSecretError['code'], message: string) {
    super(message);
    this.name = 'EventSecretError';
    this.code = code;
  }
}

export interface EventMaster {
  readonly keyId: string;
  readonly key: Buffer;
}

export interface OpenEventSecretStoreOptions {
  readonly database: DatabaseSync;
  readonly paths: EventPaths;
  readonly configDir: string;
  readonly keyring?: KeyringModule | null | undefined;
  readonly stores?: Partial<Record<EventSecretStoreKind, SecretStore>> | undefined;
}

export interface EventSecretMigrationOptions {
  readonly database: DatabaseSync;
  readonly paths: EventPaths;
  readonly from: EventSecretStoreKind;
  readonly to: EventSecretStoreKind;
  readonly source: SecretStore;
  readonly target: SecretStore;
}

export interface EventSecretMigrationResult {
  readonly moved: number;
  readonly leftovers: readonly string[];
}

function selectedKind(database: DatabaseSync): EventSecretStoreKind | null {
  const row = database.prepare("SELECT value FROM meta WHERE key = 'event_secret_store'").get() as
    | { value: string }
    | undefined;
  if (row === undefined) return null;
  if (row.value === 'keychain' || row.value === 'file') return row.value;
  throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret selector is not a recognised backend');
}

function setSelector(database: DatabaseSync, kind: EventSecretStoreKind): void {
  database
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('event_secret_store', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(kind);
}

/** The core keychain namespace deliberately gains an events-only suffix. */
export function eventKeychainNamespace(configDir: string): string {
  return `${keychainNamespace(configDir)}:events`;
}

/** Selects the daemon backend in its database; core configuration is never read or changed. */
export async function selectEventSecretStore(database: DatabaseSync, kind: EventSecretStoreKind): Promise<void> {
  const masters = database.prepare('SELECT COUNT(*) AS count FROM event_secret_masters').get() as
    | { count: number }
    | undefined;
  if ((masters?.count ?? 0) !== 0 && selectedKind(database) !== kind) {
    throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret backend can change only through its migration');
  }
  setSelector(database, kind);
}

async function storeFor(options: OpenEventSecretStoreOptions, kind: EventSecretStoreKind): Promise<SecretStore> {
  const injected = options.stores?.[kind];
  if (injected !== undefined) return injected;
  if (kind === 'file') return new FileSecretStore(options.paths.secretsDir);
  const keyring = options.keyring === undefined ? await loadKeyringModule() : options.keyring;
  if (keyring === null) {
    throw new EventSecretError(
      'EVENT_SECRET_SELECTOR',
      'event secrets default to the system keychain, which is unavailable',
    );
  }
  return new KeychainSecretStore(keyring, eventKeychainNamespace(options.configDir));
}

function parseMaster(ref: string, value: string | null): Buffer {
  if (value === null) throw new EventSecretError('EVENT_MASTER_LOST', `event master ${ref} is unavailable`);
  const key = Buffer.from(value, 'base64');
  if (key.byteLength !== 32 || key.toString('base64') !== value) {
    throw new EventSecretError('EVENT_MASTER_LOST', `event master ${ref} is invalid`);
  }
  return key;
}

/**
 * The daemon's independent master-key ledger. It uses core's hardened physical backends but owns selection,
 * references, locking and migration boundaries itself.
 */
export class EventSecretStore {
  readonly #database: DatabaseSync;
  readonly #paths: EventPaths;
  readonly #kind: EventSecretStoreKind;
  readonly #store: SecretStore;
  readonly #selectorWasAbsent: boolean;

  constructor(
    database: DatabaseSync,
    paths: EventPaths,
    kind: EventSecretStoreKind,
    store: SecretStore,
    selectorWasAbsent: boolean,
  ) {
    this.#database = database;
    this.#paths = paths;
    this.#kind = kind;
    this.#store = store;
    this.#selectorWasAbsent = selectorWasAbsent;
  }

  get kind(): EventSecretStoreKind {
    return this.#kind;
  }

  async references(): Promise<readonly string[]> {
    const rows = this.#database
      .prepare('SELECT secret_ref FROM event_secret_masters ORDER BY secret_ref')
      .all() as Array<{
      secret_ref: string;
    }>;
    return rows.map((row) => row.secret_ref);
  }

  async currentMaster(): Promise<EventMaster> {
    return this.withLock(async () => {
      const current = this.#database
        .prepare(
          'SELECT key_id, secret_ref FROM event_secret_masters WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1',
        )
        .get() as { key_id: string; secret_ref: string } | undefined;
      if (current !== undefined)
        return {
          keyId: current.key_id,
          key: parseMaster(current.secret_ref, await this.#store.get(current.secret_ref)),
        };
      if (this.#selectorWasAbsent) await this.probeInitialBackend();
      return this.createMaster(undefined);
    });
  }

  async master(keyId: string): Promise<Buffer> {
    return this.withLock(async () => {
      const row = this.#database.prepare('SELECT secret_ref FROM event_secret_masters WHERE key_id = ?').get(keyId) as
        | { secret_ref: string }
        | undefined;
      if (row === undefined) throw new EventSecretError('EVENT_MASTER_UNKNOWN', `event master ${keyId} is unknown`);
      return parseMaster(row.secret_ref, await this.#store.get(row.secret_ref));
    });
  }

  async rotateMaster(): Promise<EventMaster> {
    return this.withLock(async () => {
      const current = this.#database
        .prepare('SELECT key_id FROM event_secret_masters WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1')
        .get() as { key_id: string } | undefined;
      return this.createMaster(current?.key_id);
    });
  }

  private async probeInitialBackend(): Promise<void> {
    const ref = `event-master-probe:${randomBytes(12).toString('hex')}`;
    const value = randomBytes(32).toString('base64');
    await this.#store.set(ref, value);
    try {
      if ((await this.#store.get(ref)) !== value)
        throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event keychain probe did not read back its value');
    } finally {
      await this.#store.delete(ref).catch(() => undefined);
    }
  }

  private async createMaster(retire: string | undefined): Promise<EventMaster> {
    const keyId = `evt_${randomBytes(12).toString('hex')}`;
    const ref = `event-master:${keyId}`;
    const key = randomBytes(32);
    const encoded = key.toString('base64');
    await this.#store.set(ref, encoded);
    try {
      if ((await this.#store.get(ref)) !== encoded) {
        throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event master did not read back from its selected backend');
      }
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const now = Date.now();
        this.#database
          .prepare('INSERT INTO event_secret_masters (key_id, secret_ref, created_at) VALUES (?, ?, ?)')
          .run(keyId, ref, now);
        if (retire !== undefined) {
          this.#database.prepare('UPDATE event_secret_masters SET retired_at = ? WHERE key_id = ?').run(now, retire);
        }
        if (this.#selectorWasAbsent) setSelector(this.#database, this.#kind);
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      await this.#store.delete(ref).catch(() => undefined);
      throw error;
    }
    return { keyId, key };
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    return withFileLock(join(this.#paths.root, 'secrets.lock'), work, { timeoutMs: 5000, staleMs: 30000 });
  }
}

/** Opens only the backend selected by SQLite; an unselected installation tries keychain and never falls back. */
export async function openEventSecretStore(options: OpenEventSecretStoreOptions): Promise<EventSecretStore> {
  const recorded = selectedKind(options.database);
  const kind = recorded ?? 'keychain';
  return new EventSecretStore(options.database, options.paths, kind, await storeFor(options, kind), recorded === null);
}

/**
 * Moves every reference the event database names, under the events-only lock. No core selector, lock or reference
 * discovery participates. Before the selector changes, every copy is verified and any attempted target value is
 * removed again on failure; after it changes, failed source cleanup is returned as a retryable leftover.
 */
export async function migrateEventSecrets(options: EventSecretMigrationOptions): Promise<EventSecretMigrationResult> {
  if (options.from === options.to) return { moved: 0, leftovers: [] };
  return withFileLock(join(options.paths.root, 'secrets.lock'), async () => {
    if (selectedKind(options.database) !== options.from) {
      throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret migration source is not the selected backend');
    }
    const references = (
      options.database.prepare('SELECT secret_ref FROM event_secret_masters ORDER BY secret_ref').all() as Array<{
        secret_ref: string;
      }>
    ).map((row) => row.secret_ref);
    const copied: string[] = [];
    try {
      for (const ref of references) {
        const value = await options.source.get(ref);
        if (value === null) throw new EventSecretError('EVENT_MASTER_LOST', `event master ${ref} is unavailable`);
        copied.push(ref);
        await options.target.set(ref, value);
        if ((await options.target.get(ref)) !== value) {
          throw new EventSecretError(
            'EVENT_SECRET_SELECTOR',
            `event secret ${ref} did not verify in the destination backend`,
          );
        }
      }
      options.database.exec('BEGIN IMMEDIATE');
      try {
        setSelector(options.database, options.to);
        options.database.exec('COMMIT');
      } catch (error) {
        options.database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      await Promise.all(copied.map((ref) => options.target.delete(ref).catch(() => false)));
      throw error;
    }
    const leftovers: string[] = [];
    for (const ref of references) {
      try {
        if (!(await options.source.delete(ref))) leftovers.push(ref);
      } catch {
        leftovers.push(ref);
      }
    }
    return { moved: references.length, leftovers };
  });
}
