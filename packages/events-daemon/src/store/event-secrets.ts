import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  canonicalJson,
  FileSecretStore,
  KeychainSecretStore,
  type KeyringModule,
  keychainNamespace,
  loadKeyringModule,
  type SecretStore,
  sha256Hex,
  withFileLock,
} from '@agentcomms/core';
import { canonicalSecretWebhookUrl, type WebhookTargetDocument } from '../domain/webhook-target.ts';
import type { EventPaths } from '../runtime/paths.ts';
import type { EncryptedRecordLocation } from './records.ts';

export type EventSecretStoreKind = 'keychain' | 'file';

export class EventSecretError extends Error {
  readonly code:
    | 'EVENT_MASTER_LOST'
    | 'EVENT_MASTER_UNKNOWN'
    | 'EVENT_SECRET_SELECTOR'
    | 'EVENT_SECRET_REFERENCE'
    | 'EVENT_SECRET_OWNER_STALE';

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
  readonly referenceCipher?: EventSecretReferenceCipher | undefined;
}

export interface EventSecretMigrationResult {
  readonly moved: number;
  readonly leftovers: readonly string[];
}

export type EventSecretOwnerKind = 'target' | 'subscriber';
export type EventSecretPurpose = 'secret-url' | 'webhook-signing' | 'sse-bearer';

export interface EventSecretOwner {
  readonly kind: EventSecretOwnerKind;
  readonly id: string;
  readonly version: number;
  readonly digest: string;
}

export interface EventSecretReferenceCipher {
  encrypt(location: EncryptedRecordLocation, plaintext: Uint8Array): Promise<Buffer>;
  decrypt(location: EncryptedRecordLocation, stored: unknown): Promise<Buffer>;
}

export interface EventSecretGeneration {
  readonly owner: EventSecretOwner;
  readonly purpose: EventSecretPurpose;
  readonly generation: number;
  readonly lifecycle: 'current' | 'overlap' | 'retired';
  readonly expiresAt: number | null;
  readonly secretDigest: string;
}

export interface StoreEventSecretGenerationOptions {
  readonly database: DatabaseSync;
  readonly paths: EventPaths;
  readonly store: EventSecretStore;
  readonly cipher: EventSecretReferenceCipher;
  readonly owner: EventSecretOwner;
  readonly purpose: EventSecretPurpose;
  readonly material: string;
  readonly expectedPriorGeneration: number | null;
  readonly overlapExpiresAt?: number | undefined;
}

export interface StoreSecretWebhookUrlOptions
  extends Omit<StoreEventSecretGenerationOptions, 'owner' | 'purpose' | 'material'> {
  readonly document: WebhookTargetDocument;
  readonly completeUrl: string;
}

interface StoredGeneration extends EventSecretGeneration {
  readonly encryptedRef: Uint8Array;
}

const lockScope = new AsyncLocalStorage<ReadonlySet<string>>();

/** Shares the one process- and filesystem-wide lock across master, generation and migration work. */
async function withEventSecretsLock<T>(paths: EventPaths, work: () => Promise<T>): Promise<T> {
  const lockPath = join(paths.root, 'secrets.lock');
  if (lockScope.getStore()?.has(lockPath)) return work();
  return withFileLock(lockPath, async () => lockScope.run(new Set([...(lockScope.getStore() ?? []), lockPath]), work), {
    timeoutMs: 5000,
    staleMs: 30000,
  });
}

function generationLocation(
  owner: Pick<EventSecretOwner, 'kind' | 'id' | 'version'>,
  purpose: EventSecretPurpose,
  generation: number,
): EncryptedRecordLocation {
  return {
    table: 'event_secret_generations',
    column: 'encryptedReference',
    key: [
      { type: 'text', value: owner.kind },
      { type: 'text', value: owner.id },
      { type: 'integer', value: owner.version },
      { type: 'text', value: purpose },
      { type: 'integer', value: generation },
    ],
  };
}

function assertPurpose(owner: EventSecretOwner, purpose: EventSecretPurpose): void {
  const valid =
    (owner.kind === 'target' && (purpose === 'secret-url' || purpose === 'webhook-signing')) ||
    (owner.kind === 'subscriber' && purpose === 'sse-bearer');
  if (!valid) {
    throw new EventSecretError(
      'EVENT_SECRET_REFERENCE',
      'the secret purpose does not belong to the exact object version',
    );
  }
}

function asStoredGeneration(row: Record<string, unknown>): StoredGeneration {
  const ownerKind = row.owner_kind;
  const purpose = row.purpose;
  const lifecycle = row.lifecycle;
  if (
    (ownerKind !== 'target' && ownerKind !== 'subscriber') ||
    (purpose !== 'secret-url' && purpose !== 'webhook-signing' && purpose !== 'sse-bearer') ||
    (lifecycle !== 'current' && lifecycle !== 'overlap' && lifecycle !== 'retired') ||
    typeof row.owner_id !== 'string' ||
    typeof row.owner_version !== 'number' ||
    typeof row.owner_digest !== 'string' ||
    typeof row.generation !== 'number' ||
    typeof row.secret_digest !== 'string' ||
    !(row.encrypted_ref instanceof Uint8Array)
  ) {
    throw new EventSecretError('EVENT_SECRET_REFERENCE', 'event secret generation ledger has an invalid row');
  }
  return {
    owner: { kind: ownerKind, id: row.owner_id, version: row.owner_version, digest: row.owner_digest },
    purpose,
    generation: row.generation,
    lifecycle,
    expiresAt: typeof row.expires_at === 'number' ? row.expires_at : null,
    secretDigest: row.secret_digest,
    encryptedRef: row.encrypted_ref,
  };
}

async function referencesFor(
  database: DatabaseSync,
  cipher: EventSecretReferenceCipher | undefined,
): Promise<readonly string[]> {
  const masters = (
    database.prepare('SELECT secret_ref FROM event_secret_masters').all() as Array<{ secret_ref: string }>
  ).map((row) => row.secret_ref);
  const rows = database
    .prepare(
      `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
              encrypted_ref, lifecycle, expires_at
       FROM event_secret_generations WHERE lifecycle IN ('current', 'overlap')`,
    )
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return [...new Set(masters)].sort();
  if (cipher === undefined) {
    throw new EventSecretError(
      'EVENT_SECRET_REFERENCE',
      'event secret generations need the record cipher for reference reconciliation',
    );
  }
  const references = [...masters];
  for (const row of rows) {
    const generation = asStoredGeneration(row);
    const reference = await cipher.decrypt(
      generationLocation(generation.owner, generation.purpose, generation.generation),
      generation.encryptedRef,
    );
    const value = reference.toString('utf8');
    if (!/^event-secret:[a-f0-9]{24}$/.test(value)) {
      throw new EventSecretError('EVENT_SECRET_REFERENCE', 'event secret generation has an invalid opaque reference');
    }
    references.push(value);
  }
  return [...new Set(references)].sort();
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

  async references(cipher?: EventSecretReferenceCipher): Promise<readonly string[]> {
    return this.withLock(() => referencesFor(this.#database, cipher));
  }

  async currentMaster(): Promise<EventMaster> {
    return this.withLock(async () => {
      this.assertSelectedBackend();
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
      this.assertSelectedBackend();
      const row = this.#database.prepare('SELECT secret_ref FROM event_secret_masters WHERE key_id = ?').get(keyId) as
        | { secret_ref: string }
        | undefined;
      if (row === undefined) throw new EventSecretError('EVENT_MASTER_UNKNOWN', `event master ${keyId} is unknown`);
      return parseMaster(row.secret_ref, await this.#store.get(row.secret_ref));
    });
  }

  async rotateMaster(): Promise<EventMaster> {
    return this.withLock(async () => {
      this.assertSelectedBackend();
      const current = this.#database
        .prepare('SELECT key_id FROM event_secret_masters WHERE retired_at IS NULL ORDER BY created_at DESC LIMIT 1')
        .get() as { key_id: string } | undefined;
      return this.createMaster(current?.key_id);
    });
  }

  /** Writes a concealed backend value, verifies it, then commits only the exact immutable owner/generation reference. */
  async storeGeneration(
    options: Omit<StoreEventSecretGenerationOptions, 'database' | 'paths' | 'store'>,
  ): Promise<EventSecretGeneration> {
    const { owner, purpose, material, expectedPriorGeneration, overlapExpiresAt } = options;
    assertPurpose(owner, purpose);
    if (typeof material !== 'string' || material.length === 0) {
      throw new EventSecretError('EVENT_SECRET_REFERENCE', 'event secret generation material is non-empty');
    }
    if (
      !Number.isSafeInteger(owner.version) ||
      owner.version < 1 ||
      !/^[a-f0-9]{64}$/.test(owner.digest) ||
      (expectedPriorGeneration !== null &&
        (!Number.isSafeInteger(expectedPriorGeneration) || expectedPriorGeneration < 1))
    ) {
      throw new EventSecretError('EVENT_SECRET_REFERENCE', 'event secret generation has an exact immutable owner');
    }
    return this.withLock(async () => {
      this.assertSelectedBackend();
      const previous = this.currentGeneration(owner, purpose);
      if ((previous?.generation ?? null) !== expectedPriorGeneration) {
        throw new EventSecretError(
          'EVENT_SECRET_OWNER_STALE',
          'the expected prior secret generation is no longer current',
        );
      }
      const maximum = this.#database
        .prepare(
          `SELECT MAX(generation) AS maximum FROM event_secret_generations
           WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ?`,
        )
        .get(owner.kind, owner.id, owner.version, purpose) as { maximum: number | null } | undefined;
      const generation = (maximum?.maximum ?? 0) + 1;
      const ref = `event-secret:${randomBytes(12).toString('hex')}`;
      await this.#store.set(ref, material);
      try {
        if ((await this.#store.get(ref)) !== material) {
          throw new EventSecretError(
            'EVENT_SECRET_REFERENCE',
            'event secret generation did not read back from the selected backend',
          );
        }
        const encryptedRef = await options.cipher.encrypt(
          generationLocation(owner, purpose, generation),
          Buffer.from(ref, 'utf8'),
        );
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          this.assertSelectedBackend();
          this.assertLiveOwner(owner);
          const current = this.currentGeneration(owner, purpose);
          if (
            (current?.generation ?? null) !== expectedPriorGeneration ||
            (current !== null && current.owner.digest !== owner.digest)
          ) {
            throw new EventSecretError(
              'EVENT_SECRET_OWNER_STALE',
              'the expected prior secret generation changed while writing',
            );
          }
          if (current !== null) {
            const overlap = overlapExpiresAt ?? Date.now() + 5 * 60_000;
            if (!Number.isSafeInteger(overlap) || overlap <= Date.now()) {
              throw new EventSecretError(
                'EVENT_SECRET_REFERENCE',
                'a rotating event secret generation has a future overlap expiry',
              );
            }
            const overlaps = this.#database
              .prepare(
                `SELECT COUNT(*) AS count FROM event_secret_generations
                 WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND lifecycle = 'overlap'`,
              )
              .get(owner.kind, owner.id, owner.version, purpose) as { count: number } | undefined;
            if ((overlaps?.count ?? 0) !== 0) {
              throw new EventSecretError(
                'EVENT_SECRET_REFERENCE',
                'an event secret slot already has its bounded overlap generation',
              );
            }
            this.#database
              .prepare(
                `UPDATE event_secret_generations SET lifecycle = 'overlap', expires_at = ?
                 WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND generation = ?
                   AND lifecycle = 'current'`,
              )
              .run(overlap, owner.kind, owner.id, owner.version, purpose, current.generation);
          }
          this.#database
            .prepare(
              `INSERT INTO event_secret_generations
               (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'current', NULL, ?)`,
            )
            .run(
              owner.kind,
              owner.id,
              owner.version,
              purpose,
              generation,
              owner.digest,
              sha256Hex(material),
              encryptedRef,
              Date.now(),
            );
          this.#database.exec('COMMIT');
        } catch (error) {
          this.#database.exec('ROLLBACK');
          throw error;
        }
      } catch (error) {
        await this.#store.delete(ref).catch(() => false);
        throw error;
      }
      return {
        owner,
        purpose,
        generation,
        lifecycle: 'current',
        expiresAt: null,
        secretDigest: sha256Hex(material),
      };
    });
  }

  /** Reconciles only proven-retired opaque references after their database rows are no longer reachable. */
  async reconcileRetiredGenerations(
    cipher: EventSecretReferenceCipher,
    now: number = Date.now(),
  ): Promise<readonly string[]> {
    return this.withLock(async () => {
      this.assertSelectedBackend();
      this.#database
        .prepare(
          "UPDATE event_secret_generations SET lifecycle = 'retired' WHERE lifecycle = 'overlap' AND expires_at <= ?",
        )
        .run(now);
      const rows = this.#database
        .prepare(
          `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
                  encrypted_ref, lifecycle, expires_at
           FROM event_secret_generations WHERE lifecycle = 'retired'`,
        )
        .all() as Array<Record<string, unknown>>;
      const stale = await Promise.all(
        rows.map(async (row) => {
          const generation = asStoredGeneration(row);
          const ref = await cipher.decrypt(
            generationLocation(generation.owner, generation.purpose, generation.generation),
            generation.encryptedRef,
          );
          const value = ref.toString('utf8');
          if (!/^event-secret:[a-f0-9]{24}$/.test(value)) {
            throw new EventSecretError(
              'EVENT_SECRET_REFERENCE',
              'event secret generation has an invalid opaque reference',
            );
          }
          return { generation, ref: value };
        }),
      );
      const liveReferences = new Set(await referencesFor(this.#database, cipher));
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.assertSelectedBackend();
        for (const entry of stale) {
          this.#database
            .prepare(
              `DELETE FROM event_secret_generations
               WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND generation = ?
                 AND lifecycle = 'retired'`,
            )
            .run(
              entry.generation.owner.kind,
              entry.generation.owner.id,
              entry.generation.owner.version,
              entry.generation.purpose,
              entry.generation.generation,
            );
        }
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
      const leftovers: string[] = [];
      for (const entry of stale) {
        if (liveReferences.has(entry.ref)) continue;
        try {
          if (!(await this.#store.delete(entry.ref))) leftovers.push(entry.ref);
        } catch {
          leftovers.push(entry.ref);
        }
      }
      return leftovers;
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

  private currentGeneration(owner: EventSecretOwner, purpose: EventSecretPurpose): EventSecretGeneration | null {
    const row = this.#database
      .prepare(
        `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
                encrypted_ref, lifecycle, expires_at
         FROM event_secret_generations
         WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND lifecycle = 'current'`,
      )
      .get(owner.kind, owner.id, owner.version, purpose) as Record<string, unknown> | undefined;
    if (row === undefined) return null;
    const generation = asStoredGeneration(row);
    return {
      owner: generation.owner,
      purpose: generation.purpose,
      generation: generation.generation,
      lifecycle: generation.lifecycle,
      expiresAt: generation.expiresAt,
      secretDigest: generation.secretDigest,
    };
  }

  private assertLiveOwner(owner: EventSecretOwner): void {
    const table = owner.kind === 'target' ? 'target_versions' : 'subscriber_versions';
    const idColumn = owner.kind === 'target' ? 'target_id' : 'subscriber_id';
    const row = this.#database
      .prepare(`SELECT digest, revoked_at FROM ${table} WHERE ${idColumn} = ? AND version = ?`)
      .get(owner.id, owner.version) as { digest: string; revoked_at: number | null } | undefined;
    if (row === undefined || row.revoked_at !== null || row.digest !== owner.digest) {
      throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the exact secret owner version is no longer live');
    }
  }

  /** A queued stale store may never write/delete after migration selected the other independent backend. */
  private assertSelectedBackend(): void {
    const selected = selectedKind(this.#database);
    if (selected !== null && selected !== this.#kind) {
      throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret backend changed; reopen the selected backend');
    }
  }

  private async withLock<T>(work: () => Promise<T>): Promise<T> {
    return withEventSecretsLock(this.#paths, work);
  }
}

/** Task B2's internal-only factory returns an opaque generation, never the stored material or reference. */
export async function storeEventSecretGeneration(
  options: StoreEventSecretGenerationOptions,
): Promise<EventSecretGeneration> {
  return options.store.storeGeneration(options);
}

/** Stores a secret webhook URL only after its canonical authority/fingerprint exactly matches the inert target version. */
export async function storeSecretWebhookUrl(options: StoreSecretWebhookUrlOptions): Promise<EventSecretGeneration> {
  if (options.document.url.kind !== 'secret') {
    throw new EventSecretError('EVENT_SECRET_REFERENCE', 'a secret webhook URL needs a secret-URL target version');
  }
  const canonical = canonicalSecretWebhookUrl(options.completeUrl);
  if (
    canonical.descriptor.scheme !== options.document.url.scheme ||
    canonical.descriptor.host !== options.document.url.host ||
    canonical.descriptor.port !== options.document.url.port ||
    canonical.descriptor.sha256 !== options.document.url.sha256
  ) {
    throw new EventSecretError(
      'EVENT_SECRET_REFERENCE',
      'the complete webhook URL does not match its immutable public descriptor',
    );
  }
  return storeEventSecretGeneration({
    ...options,
    owner: {
      kind: 'target',
      id: options.document.targetId,
      version: options.document.version,
      digest: sha256Hex(canonicalJson(options.document)),
    },
    purpose: 'secret-url',
    material: canonical.value,
  });
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
  return withEventSecretsLock(options.paths, async () => {
    if (selectedKind(options.database) !== options.from) {
      throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret migration source is not the selected backend');
    }
    const references = await referencesFor(options.database, options.referenceCipher);
    const copied: string[] = [];
    try {
      for (const ref of references) {
        const value = await options.source.get(ref);
        if (value === null) {
          throw new EventSecretError('EVENT_MASTER_LOST', 'a referenced event secret is unavailable');
        }
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
