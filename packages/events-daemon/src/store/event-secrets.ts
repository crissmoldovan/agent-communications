import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
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
import { EVENT_SECRET_PROVIDERS, type EventSecretProvider } from '../domain/providers.ts';
import type { WebhookSubscriberDocument } from '../domain/webhook-subscriber.ts';
import { canonicalSecretWebhookUrl, type WebhookTargetDocument } from '../domain/webhook-target.ts';
import type { EventPaths } from '../runtime/paths.ts';
import type { WriterQuiescer } from '../runtime/writer-quiescer.ts';
import { type AadComponent, encodeAad } from './aad.ts';
import { decryptPackedRecord, deriveTableKey, packedRecordKeyId } from './crypto.ts';
import type { EncryptedRecordLocation } from './records.ts';

export type EventSecretStoreKind = 'keychain' | 'file';

export class EventSecretError extends Error {
  readonly code:
    | 'EVENT_MASTER_LOST'
    | 'EVENT_MASTER_UNKNOWN'
    | 'EVENT_SECRET_SELECTOR'
    | 'EVENT_SECRET_REFERENCE'
    | 'EVENT_SECRET_OWNER_STALE'
    | 'RETIRED_MASTER_REFERENCED';

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
  /** The selector committed, but no source cleanup ran because a selected copy no longer matches its verified bytes. */
  readonly code?: 'SELECTED_COPY_CHANGED_AFTER_MIGRATION' | undefined;
}

export type EventSecretOwnerKind = 'target' | 'subscriber' | 'judge' | 'provider';
export type EventSecretPurpose = 'secret-url' | 'webhook-signing' | 'sse-bearer' | 'judge-key' | 'provider-key';

export {
  EVENT_SECRET_PROVIDER_WORDS,
  EVENT_SECRET_PROVIDERS,
  type EventSecretProvider,
  isEventSecretProvider,
} from '../domain/providers.ts';

/**
 * A provider slot's exact owner. A provider has no immutable document row, so its owner is version 1 and its digest is
 * the digest of its canonical identity: the same value every time, and never one a judge, target or subscriber has.
 */
export function providerSecretOwner(provider: EventSecretProvider): EventSecretOwner {
  if (!(EVENT_SECRET_PROVIDERS as readonly string[]).includes(provider))
    throw new EventSecretError('EVENT_SECRET_REFERENCE', 'the AI provider is not one with a key slot');
  return {
    kind: 'provider',
    id: provider,
    version: 1,
    digest: sha256Hex(canonicalJson({ kind: 'provider', provider, version: 1 })),
  };
}

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

/** Internal-only resolved material. Callers must use it only at the owned byte boundary and never serialize it. */
export interface EventSecretMaterial extends Omit<EventSecretGeneration, 'lifecycle'> {
  readonly lifecycle: 'current' | 'overlap';
  readonly material: string;
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
  /** Subscriber and hosted-key rotations invalidate rather than overlap the prior generation. */
  readonly retirePrevious?: boolean | undefined;
  /** Create/set operations require an entirely empty immutable slot, not merely no current generation. */
  readonly requireEmpty?: boolean | undefined;
}

export interface StoreSecretWebhookUrlOptions
  extends Omit<StoreEventSecretGenerationOptions, 'owner' | 'purpose' | 'material'> {
  readonly document: WebhookTargetDocument;
  readonly completeUrl: string;
}

/** A webhook subscriber's new version with a secret URL (0.36.0, W29): its document, and the complete hidden URL. */
export interface CreateSecretUrlSubscriberVersionOptions {
  readonly document: WebhookSubscriberDocument;
  readonly completeUrl: string;
  readonly cipher: EventSecretReferenceCipher;
}

export interface CreateSecretUrlTargetVersionOptions {
  readonly document: WebhookTargetDocument;
  readonly completeUrl: string;
  readonly cipher: EventSecretReferenceCipher;
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
    (owner.kind === 'subscriber' &&
      (purpose === 'sse-bearer' || purpose === 'webhook-signing' || purpose === 'secret-url')) ||
    (owner.kind === 'judge' && purpose === 'judge-key') ||
    (owner.kind === 'provider' && purpose === 'provider-key');
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
    (ownerKind !== 'target' && ownerKind !== 'subscriber' && ownerKind !== 'judge' && ownerKind !== 'provider') ||
    (purpose !== 'secret-url' &&
      purpose !== 'webhook-signing' &&
      purpose !== 'sse-bearer' &&
      purpose !== 'judge-key' &&
      purpose !== 'provider-key') ||
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

/** A synchronous transaction-safe representation of every reference migration is allowed to move. */
function referenceSnapshot(database: DatabaseSync): string {
  const masters = database
    .prepare('SELECT key_id, secret_ref, retired_at FROM event_secret_masters ORDER BY key_id')
    .all() as Array<{ key_id: string; secret_ref: string; retired_at: number | null }>;
  const generations = database
    .prepare(
      `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
              hex(encrypted_ref) AS encrypted_ref, lifecycle, expires_at
       FROM event_secret_generations ORDER BY owner_kind, owner_id, owner_version, purpose, generation`,
    )
    .all();
  return canonicalJson({ masters, generations });
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
  #kind: EventSecretStoreKind;
  #store: SecretStore;
  readonly #selectorWasAbsent: boolean;
  readonly #openStore: (kind: EventSecretStoreKind) => Promise<SecretStore>;

  constructor(
    database: DatabaseSync,
    paths: EventPaths,
    kind: EventSecretStoreKind,
    store: SecretStore,
    selectorWasAbsent: boolean,
    openStore: (kind: EventSecretStoreKind) => Promise<SecretStore>,
  ) {
    this.#database = database;
    this.#paths = paths;
    this.#kind = kind;
    this.#store = store;
    this.#selectorWasAbsent = selectorWasAbsent;
    this.#openStore = openStore;
  }

  get kind(): EventSecretStoreKind {
    return this.#kind;
  }

  async references(cipher?: EventSecretReferenceCipher): Promise<readonly string[]> {
    return this.withLock(() => referencesFor(this.#database, cipher));
  }

  /** The owner alone opens the other events-only backend; no core selector or namespace participates. */
  async migrateTo(
    to: EventSecretStoreKind,
    referenceCipher: EventSecretReferenceCipher,
  ): Promise<EventSecretMigrationResult> {
    const target = to === this.#kind ? this.#store : await this.#openStore(to);
    const result = await migrateEventSecrets({
      database: this.#database,
      paths: this.#paths,
      from: this.#kind,
      to,
      source: this.#store,
      target,
      referenceCipher,
    });
    // The long-lived owner must use the newly selected backend after the selector commit.  Keeping the old instance
    // would make the next rotation fail closed on selector drift, which in turn would make a named cleanup leftover
    // impossible to retry before rotating.  `migrateEventSecrets` only returns after the selector is destination (or
    // after an idempotent destination cleanup), so this swap never follows a failed copy.
    if (selectedKind(this.#database) === to) {
      this.#kind = to;
      this.#store = target;
    }
    return result;
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
          key: parseMaster(current.secret_ref, await readBackend(this.#store, current.secret_ref)),
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
      return parseMaster(row.secret_ref, await readBackend(this.#store, row.secret_ref));
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

  /**
   * A retired master may be physically deleted only once every packed record
   * and encrypted opaque-reference column proves it no longer names that key.
   * The caller owns the writer-quiescer exclusive lease; this method retains
   * the secrets lock for the entire scan and deletion.
   */
  async destroyRetiredMaster(input: {
    readonly keyId: string;
    readonly cipher: EventSecretReferenceCipher;
    readonly quiescer: WriterQuiescer;
  }): Promise<void> {
    input.quiescer.assertExclusive();
    return this.withLock(async () => {
      this.assertSelectedBackend();
      const row = this.#database
        .prepare('SELECT secret_ref, retired_at FROM event_secret_masters WHERE key_id = ?')
        .get(input.keyId) as { secret_ref: string; retired_at: number | null } | undefined;
      if (row === undefined || row.retired_at === null)
        throw new EventSecretError('EVENT_MASTER_UNKNOWN', 'only a known retired event master may be destroyed');
      const { RECORD_LAYOUTS } = await import('./records.ts');
      for (const layout of RECORD_LAYOUTS) {
        const records = this.#database
          .prepare(`SELECT ${layout.sqlColumn} AS record FROM ${layout.table} WHERE ${layout.sqlColumn} IS NOT NULL`)
          .all() as Array<{ record: unknown }>;
        for (const record of records) {
          if (!(record.record instanceof Uint8Array)) {
            throw new EventSecretError('RETIRED_MASTER_REFERENCED', 'a packed record column is not a BLOB');
          }
          let keyId: string;
          try {
            keyId = packedRecordKeyId(record.record);
          } catch {
            throw new EventSecretError('RETIRED_MASTER_REFERENCED', 'a packed record cannot be proven independent');
          }
          if (keyId === input.keyId) {
            throw new EventSecretError(
              'RETIRED_MASTER_REFERENCED',
              'a packed record still names the retired event master',
            );
          }
        }
      }
      // Decrypting the derived reference set is also a fail-closed validation that no live secret slot was skipped.
      await referencesFor(this.#database, input.cipher);
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const current = this.#database
          .prepare('SELECT retired_at FROM event_secret_masters WHERE key_id = ?')
          .get(input.keyId) as { retired_at: number | null } | undefined;
        if (current === undefined || current.retired_at === null)
          throw new EventSecretError(
            'RETIRED_MASTER_REFERENCED',
            'the retired master changed during its destruction scan',
          );
        // Counter rows retain no content and cannot name a key after the scan
        // proved every packed record has moved off it.
        this.#database.prepare('DELETE FROM nonce_counters WHERE key_id = ?').run(input.keyId);
        this.#database
          .prepare('DELETE FROM event_secret_masters WHERE key_id = ? AND retired_at IS NOT NULL')
          .run(input.keyId);
        this.#database.exec('COMMIT');
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
      if (!(await this.#store.delete(row.secret_ref)))
        throw new EventSecretError('RETIRED_MASTER_REFERENCED', 'the retired event master could not be deleted');
    });
  }

  /**
   * Resolves the current and still-valid overlap generations for one exact immutable owner. The opaque backend
   * reference stays inside this store; only the byte-boundary adapter receives material, and only in memory.
   */
  async readLiveGenerations(input: {
    readonly owner: EventSecretOwner;
    readonly purpose: EventSecretPurpose;
    readonly cipher: EventSecretReferenceCipher;
    readonly now?: number | undefined;
  }): Promise<readonly EventSecretMaterial[]> {
    assertPurpose(input.owner, input.purpose);
    return this.withLock(async () => {
      this.assertSelectedBackend();
      this.assertLiveOwner(input.owner);
      const now = input.now ?? Date.now();
      const rows = this.#database
        .prepare(
          `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
                  encrypted_ref, lifecycle, expires_at
           FROM event_secret_generations
           WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ?
             AND (lifecycle = 'current' OR (lifecycle = 'overlap' AND expires_at > ?))
           ORDER BY generation DESC`,
        )
        .all(input.owner.kind, input.owner.id, input.owner.version, input.purpose, now) as Array<
        Record<string, unknown>
      >;
      const resolved: EventSecretMaterial[] = [];
      for (const row of rows) {
        const generation = asStoredGeneration(row);
        if (generation.owner.digest !== input.owner.digest) {
          throw new EventSecretError(
            'EVENT_SECRET_OWNER_STALE',
            'the secret generation owner digest is no longer exact',
          );
        }
        const reference = await input.cipher.decrypt(
          generationLocation(generation.owner, generation.purpose, generation.generation),
          generation.encryptedRef,
        );
        const ref = reference.toString('utf8');
        if (!/^event-secret:[a-f0-9]{24}$/.test(ref)) {
          throw new EventSecretError(
            'EVENT_SECRET_REFERENCE',
            'event secret generation has an invalid opaque reference',
          );
        }
        const material = await readBackend(this.#store, ref);
        if (material === null || sha256Hex(material) !== generation.secretDigest) {
          throw new EventSecretError(
            'EVENT_SECRET_REFERENCE',
            'event secret generation material is unavailable or changed',
          );
        }
        resolved.push({
          owner: generation.owner,
          purpose: generation.purpose,
          generation: generation.generation,
          lifecycle: generation.lifecycle as 'current' | 'overlap',
          expiresAt: generation.expiresAt,
          secretDigest: generation.secretDigest,
          material,
        });
      }
      return resolved;
    });
  }

  /** Writes a concealed backend value, verifies it, then commits only the exact immutable owner/generation reference. */
  async storeGeneration(
    options: Omit<StoreEventSecretGenerationOptions, 'database' | 'paths' | 'store'>,
  ): Promise<EventSecretGeneration> {
    const {
      owner,
      purpose,
      material,
      expectedPriorGeneration,
      overlapExpiresAt,
      retirePrevious = false,
      requireEmpty = false,
    } = options;
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
      if (requireEmpty) {
        const occupied = this.#database
          .prepare(
            `SELECT 1 AS present FROM event_secret_generations
             WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? LIMIT 1`,
          )
          .get(owner.kind, owner.id, owner.version, purpose);
        if (occupied !== undefined)
          throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the exact immutable secret slot is not empty');
      }
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
      const materialDigest = sha256Hex(material);
      await this.#store.set(ref, material);
      try {
        if ((await readBackend(this.#store, ref)) !== material) {
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
          if (requireEmpty) {
            const occupied = this.#database
              .prepare(
                `SELECT 1 AS present FROM event_secret_generations
                 WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? LIMIT 1`,
              )
              .get(owner.kind, owner.id, owner.version, purpose);
            if (occupied !== undefined)
              throw new EventSecretError(
                'EVENT_SECRET_OWNER_STALE',
                'the exact immutable secret slot changed while writing',
              );
          }
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
          const now = Date.now();
          if (current !== null) {
            if (retirePrevious) {
              this.#database
                .prepare(
                  `UPDATE event_secret_generations SET lifecycle = 'retired', expires_at = ?
                   WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ? AND generation = ?
                     AND lifecycle = 'current'`,
                )
                .run(now, owner.kind, owner.id, owner.version, purpose, current.generation);
            } else {
              const overlap = overlapExpiresAt ?? now + 5 * 60_000;
              if (!Number.isSafeInteger(overlap) || overlap <= now || overlap > now + 5 * 60_000) {
                throw new EventSecretError(
                  'EVENT_SECRET_REFERENCE',
                  'a rotating event secret generation has an overlap expiry within five minutes',
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
              materialDigest,
              encryptedRef,
              now,
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
        secretDigest: materialDigest,
      };
    });
  }

  /**
   * The only factory that can turn hidden URL bytes into a new immutable target
   * version.  It writes and verifies physical material before one compensated
   * SQLite commit; an existing version is never an update target.
   */
  async createSecretUrlTargetVersion(options: CreateSecretUrlTargetVersionOptions): Promise<EventSecretGeneration> {
    if (options.document.url.kind !== 'secret') {
      throw new EventSecretError('EVENT_SECRET_REFERENCE', 'a new secret URL target needs a secret URL descriptor');
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
        'the hidden URL does not match the new immutable descriptor',
      );
    }
    const document = canonicalJson(options.document);
    const owner: EventSecretOwner = {
      kind: 'target',
      id: options.document.targetId,
      version: options.document.version,
      digest: sha256Hex(document),
    };
    return this.withLock(async () => {
      this.assertSelectedBackend();
      const existing = this.#database
        .prepare('SELECT 1 AS present FROM target_versions WHERE target_id = ? AND version = ?')
        .get(owner.id, owner.version);
      if (existing !== undefined)
        throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the requested new target version already exists');
      const ref = `event-secret:${randomBytes(12).toString('hex')}`;
      await this.#store.set(ref, canonical.value);
      try {
        if ((await readBackend(this.#store, ref)) !== canonical.value)
          throw new EventSecretError(
            'EVENT_SECRET_REFERENCE',
            'the new target URL did not read back from the selected backend',
          );
        const encryptedRef = await options.cipher.encrypt(
          generationLocation(owner, 'secret-url', 1),
          Buffer.from(ref, 'utf8'),
        );
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          this.assertSelectedBackend();
          const raced = this.#database
            .prepare('SELECT 1 AS present FROM target_versions WHERE target_id = ? AND version = ?')
            .get(owner.id, owner.version);
          if (raced !== undefined)
            throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the requested new target version already exists');
          this.#database
            .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
            .run(`${owner.id}@${owner.version}`, owner.id, owner.version, document, owner.digest);
          this.#database
            .prepare(
              `INSERT INTO event_secret_generations
               (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
               VALUES ('target', ?, ?, 'secret-url', 1, ?, ?, ?, 'current', NULL, ?)`,
            )
            .run(owner.id, owner.version, owner.digest, sha256Hex(canonical.value), encryptedRef, Date.now());
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
        purpose: 'secret-url',
        generation: 1,
        lifecycle: 'current',
        expiresAt: null,
        secretDigest: sha256Hex(canonical.value),
      };
    });
  }

  /**
   * The only factory that can turn a hidden URL into a new immutable webhook subscriber version (0.36.0, W29), as
   * `createSecretUrlTargetVersion` does for a target: the material is written and read back before one compensated
   * SQLite commit inserts the inert version and its `secret-url` generation together.
   */
  async createSecretUrlSubscriberVersion(
    options: CreateSecretUrlSubscriberVersionOptions,
  ): Promise<EventSecretGeneration> {
    if (options.document.url.kind !== 'secret')
      throw new EventSecretError('EVENT_SECRET_REFERENCE', 'a new secret URL subscriber needs a secret URL descriptor');
    const canonical = canonicalSecretWebhookUrl(options.completeUrl);
    const described = options.document.url;
    if (
      canonical.descriptor.scheme !== described.scheme ||
      canonical.descriptor.host !== described.host ||
      canonical.descriptor.port !== described.port ||
      canonical.descriptor.sha256 !== described.sha256
    )
      throw new EventSecretError(
        'EVENT_SECRET_REFERENCE',
        'the hidden URL does not match the new immutable descriptor',
      );
    const document = canonicalJson(options.document);
    const owner: EventSecretOwner = {
      kind: 'subscriber',
      id: options.document.subscriberId,
      version: options.document.version,
      digest: sha256Hex(document),
    };
    const versionExists = () =>
      this.#database
        .prepare('SELECT 1 AS present FROM subscriber_versions WHERE subscriber_id = ? AND version = ?')
        .get(owner.id, owner.version) !== undefined;
    return this.withLock(async () => {
      this.assertSelectedBackend();
      if (versionExists())
        throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the requested new subscriber version already exists');
      const ref = `event-secret:${randomBytes(12).toString('hex')}`;
      await this.#store.set(ref, canonical.value);
      try {
        if ((await readBackend(this.#store, ref)) !== canonical.value)
          throw new EventSecretError(
            'EVENT_SECRET_REFERENCE',
            'the new subscriber URL did not read back from the selected backend',
          );
        const encryptedRef = await options.cipher.encrypt(
          generationLocation(owner, 'secret-url', 1),
          Buffer.from(ref, 'utf8'),
        );
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          this.assertSelectedBackend();
          if (versionExists())
            throw new EventSecretError(
              'EVENT_SECRET_OWNER_STALE',
              'the requested new subscriber version already exists',
            );
          this.#database
            .prepare(
              `INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest, state)
               VALUES (?, ?, ?, ?, ?, 'inert')`,
            )
            .run(`${owner.id}@${owner.version}`, owner.id, owner.version, document, owner.digest);
          this.#database
            .prepare(
              `INSERT INTO event_secret_generations
               (owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest, encrypted_ref, lifecycle, expires_at, created_at)
               VALUES ('subscriber', ?, ?, 'secret-url', 1, ?, ?, ?, 'current', NULL, ?)`,
            )
            .run(owner.id, owner.version, owner.digest, sha256Hex(canonical.value), encryptedRef, Date.now());
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
        purpose: 'secret-url',
        generation: 1,
        lifecycle: 'current',
        expiresAt: null,
        secretDigest: sha256Hex(canonical.value),
      };
    });
  }

  /**
   * Empties one slot: its current generation, and any overlap, become retired, so no boundary can read them again. The
   * material itself is deleted by the next `reconcileRetiredGenerations`. A slot with nothing current is left as it is.
   */
  async retireCurrentGeneration(input: {
    readonly owner: EventSecretOwner;
    readonly purpose: EventSecretPurpose;
  }): Promise<number | null> {
    assertPurpose(input.owner, input.purpose);
    return this.withLock(async () => {
      this.assertSelectedBackend();
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const current = this.currentGeneration(input.owner, input.purpose);
        this.#database
          .prepare(
            `UPDATE event_secret_generations SET lifecycle = 'retired', expires_at = ?
             WHERE owner_kind = ? AND owner_id = ? AND owner_version = ? AND purpose = ?
               AND lifecycle IN ('current', 'overlap')`,
          )
          .run(Date.now(), input.owner.kind, input.owner.id, input.owner.version, input.purpose);
        this.#database.exec('COMMIT');
        return current?.generation ?? null;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
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
      if ((await readBackend(this.#store, ref)) !== value)
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
      if ((await readBackend(this.#store, ref)) !== encoded) {
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
    if (owner.kind === 'provider') {
      // A provider slot lives as long as the provider is one the release keeps keys for; its owner is fixed.
      const exact = providerSecretOwner(owner.id as EventSecretProvider);
      if (owner.version !== exact.version || owner.digest !== exact.digest)
        throw new EventSecretError('EVENT_SECRET_OWNER_STALE', 'the AI provider key slot owner is not exact');
      return;
    }
    const table =
      owner.kind === 'target'
        ? 'target_versions'
        : owner.kind === 'subscriber'
          ? 'subscriber_versions'
          : 'judge_versions';
    const idColumn = owner.kind === 'target' ? 'target_id' : owner.kind === 'subscriber' ? 'subscriber_id' : 'judge_id';
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

/**
 * Reads what the backend holds now. Core's keychain store answers `get` from a cache its own `set` fills, so a read-back
 * or a migration check through it would otherwise see what this process last wrote rather than the keychain item, which
 * another process, or a keychain reset, may have changed since.
 */
async function readBackend(store: SecretStore, ref: string): Promise<string | null> {
  store.invalidate(ref);
  return store.get(ref);
}

/** Opens only the backend selected by SQLite; an unselected installation tries keychain and never falls back. */
export async function openEventSecretStore(options: OpenEventSecretStoreOptions): Promise<EventSecretStore> {
  const recorded = selectedKind(options.database);
  const kind = recorded ?? 'keychain';
  return new EventSecretStore(
    options.database,
    options.paths,
    kind,
    await storeFor(options, kind),
    recorded === null,
    (requested) => storeFor(options, requested),
  );
}

/**
 * Moves every reference the event database names, under the events-only lock. No core selector, lock or reference
 * discovery participates. Before the selector changes, every copy is verified and any attempted target value is
 * removed again on failure; after it changes, failed source cleanup is returned as a retryable leftover.
 */
export async function migrateEventSecrets(options: EventSecretMigrationOptions): Promise<EventSecretMigrationResult> {
  if (options.from === options.to) return { moved: 0, leftovers: [] };
  // A source and target wired the wrong way round, or one store passed as both, would delete the only copies.
  if (options.source === options.target || options.source.kind !== options.from || options.target.kind !== options.to)
    throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret migration stores do not match its backends');
  return withEventSecretsLock(options.paths, async () => {
    const selected = selectedKind(options.database);
    // Once the selector names the destination, retrying the original request
    // is cleanup-only.  The database is still the authority for the exact
    // opaque references: first prove every selected-backend copy remains
    // readable, then re-check that set before deleting an old copy.  A target
    // loss therefore never turns a harmless old leftover into data loss.
    if (selected === options.to) {
      // The owner still has the pre-migration EventSecretStore instance.  It
      // intentionally refuses selector drift, so cleanup resolves references
      // directly from the selected target copies rather than accidentally
      // reopening the old backend through that stale instance.
      const references = await referencesForSelectedTarget(options.database, options.target);
      const snapshot = referenceSnapshot(options.database);
      // Only copies the old backend still holds are deleted, and only their failures are reported as leftovers.
      const present: string[] = [];
      for (const ref of references) {
        const selectedValue = await readBackend(options.target, ref);
        if (selectedValue === null)
          throw new EventSecretError(
            'EVENT_MASTER_LOST',
            'a selected event secret is unavailable; old migration leftovers are retained',
          );
        // An old copy is deleted only while the selected backend holds exactly the bytes it was copied from. A selected
        // copy changed since the migration verified it leaves every old copy in place: the leftover may be the only
        // correct one.
        const leftover = await readBackend(options.source, ref);
        if (leftover !== null && leftover !== selectedValue)
          throw new EventSecretError(
            'EVENT_SECRET_SELECTOR',
            'a selected event secret no longer matches its migration source; old migration leftovers are retained',
          );
        if (leftover !== null) present.push(ref);
      }
      options.database.exec('BEGIN IMMEDIATE');
      try {
        if (referenceSnapshot(options.database) !== snapshot || selectedKind(options.database) !== options.to)
          throw new EventSecretError(
            'EVENT_SECRET_SELECTOR',
            'event secret references changed before leftover cleanup',
          );
        options.database.exec('COMMIT');
      } catch (error) {
        options.database.exec('ROLLBACK');
        throw error;
      }
      const leftovers: string[] = [];
      for (const ref of present) {
        try {
          if (!(await options.source.delete(ref))) leftovers.push(ref);
        } catch {
          leftovers.push(ref);
        }
      }
      return { moved: 0, leftovers };
    }
    if (selected !== options.from) {
      throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret migration source is not the selected backend');
    }
    const references = await referencesFor(options.database, options.referenceCipher);
    const snapshot = referenceSnapshot(options.database);
    const copied: Array<{ readonly ref: string; readonly value: string }> = [];
    try {
      for (const ref of references) {
        const value = await readBackend(options.source, ref);
        if (value === null) {
          throw new EventSecretError('EVENT_MASTER_LOST', 'a referenced event secret is unavailable');
        }
        copied.push({ ref, value });
        await options.target.set(ref, value);
        if ((await readBackend(options.target, ref)) !== value) {
          throw new EventSecretError(
            'EVENT_SECRET_SELECTOR',
            `event secret ${ref} did not verify in the destination backend`,
          );
        }
      }
      options.database.exec('BEGIN IMMEDIATE');
      try {
        if (referenceSnapshot(options.database) !== snapshot)
          throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret references changed during migration');
        if (selectedKind(options.database) !== options.from)
          throw new EventSecretError('EVENT_SECRET_SELECTOR', 'event secret selector changed during migration');
        setSelector(options.database, options.to);
        options.database.exec('COMMIT');
      } catch (error) {
        options.database.exec('ROLLBACK');
        throw error;
      }
    } catch (error) {
      await Promise.all(copied.map(({ ref }) => options.target.delete(ref).catch(() => false)));
      throw error;
    }
    // Selector commit does not make the earlier destination read-backs permanent. Before the first cleanup delete,
    // read every selected copy again and keep all source copies when any one changed or disappeared in that interval.
    // The stable result code deliberately names only the state transition, never the material that drifted.
    if (!(await copiedTargetValuesMatch(options.target, copied))) {
      return {
        moved: references.length,
        leftovers: references,
        code: 'SELECTED_COPY_CHANGED_AFTER_MIGRATION',
      };
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

/** A post-selector cleanup may delete a source only if its selected counterpart still has the verified exact bytes. */
async function copiedTargetValuesMatch(
  target: SecretStore,
  copied: readonly { readonly ref: string; readonly value: string }[],
): Promise<boolean> {
  try {
    for (const { ref, value } of copied) if ((await readBackend(target, ref)) !== value) return false;
    return true;
  } catch {
    return false;
  }
}

/** Resolves opaque generation references from the selected migration target without retaining an old-store handle. */
async function referencesForSelectedTarget(database: DatabaseSync, target: SecretStore): Promise<readonly string[]> {
  const masters = database
    .prepare('SELECT key_id, secret_ref FROM event_secret_masters ORDER BY key_id')
    .all() as Array<{ key_id: string; secret_ref: string }>;
  const masterByKey = new Map<string, Buffer>();
  for (const master of masters) {
    const encoded = await readBackend(target, master.secret_ref);
    if (encoded === null)
      throw new EventSecretError('EVENT_MASTER_LOST', 'a selected event master is unavailable during leftover cleanup');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32)
      throw new EventSecretError('EVENT_MASTER_LOST', 'a selected event master is malformed during leftover cleanup');
    masterByKey.set(master.key_id, key);
  }
  const rows = database
    .prepare(
      `SELECT owner_kind, owner_id, owner_version, purpose, generation, owner_digest, secret_digest,
              encrypted_ref, lifecycle, expires_at
       FROM event_secret_generations
       ORDER BY owner_kind, owner_id, owner_version, purpose, generation`,
    )
    .all() as Array<Record<string, unknown>>;
  const references = masters.map((master) => master.secret_ref);
  for (const row of rows) {
    const generation = asStoredGeneration(row);
    const keyId = packedRecordKeyId(generation.encryptedRef);
    const master = masterByKey.get(keyId);
    if (master === undefined)
      throw new EventSecretError('EVENT_MASTER_LOST', 'an event secret reference names an unavailable selected master');
    let reference: Buffer;
    try {
      reference = decryptPackedRecord({
        record: generation.encryptedRef,
        keyForId: (selectedKeyId) =>
          selectedKeyId === keyId ? deriveTableKey(master, 'event_secret_generations') : null,
        aad: encodeAad(
          'event_secret_generations',
          'encryptedReference',
          generationLocation(generation.owner, generation.purpose, generation.generation)
            .key as readonly AadComponent[],
        ),
      });
    } catch {
      throw new EventSecretError(
        'EVENT_SECRET_REFERENCE',
        'an event secret reference is unreadable during leftover cleanup',
      );
    }
    const value = reference.toString('utf8');
    if (!/^event-secret:[a-f0-9]{24}$/.test(value))
      throw new EventSecretError(
        'EVENT_SECRET_REFERENCE',
        'an event secret reference is not an opaque event reference',
      );
    references.push(value);
  }
  return [...new Set(references)].sort();
}

/**
 * Content-free persistence check used by B3's synthetic-sentinel tests.  The
 * only allowed copy is the selected secret backend, which is deliberately not
 * among these daemon SQLite files.
 */
export async function scanEventSecretPersistence(input: {
  readonly paths: EventPaths;
  readonly prohibited: readonly string[];
  /** Serialized receipts captured at the real output/audit/log boundary under test. */
  readonly receiptSinks?: Partial<Record<'output' | 'audit' | 'log', readonly string[]>> | undefined;
}): Promise<readonly ('sqlite' | 'wal' | 'shm' | 'output' | 'audit' | 'log')[]> {
  const files: ReadonlyArray<readonly ['sqlite' | 'wal' | 'shm', string]> = [
    ['sqlite', input.paths.database],
    ['wal', input.paths.databaseWal],
    ['shm', input.paths.databaseShm],
  ];
  const findings: Array<'sqlite' | 'wal' | 'shm' | 'output' | 'audit' | 'log'> = [];
  for (const [name, path] of files) {
    const bytes = await readFile(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return Buffer.alloc(0);
      throw error;
    });
    if (input.prohibited.some((value) => bytes.includes(Buffer.from(value, 'utf8')))) findings.push(name);
  }
  for (const name of ['output', 'audit', 'log'] as const) {
    const serialized = input.receiptSinks?.[name] ?? [];
    if (serialized.some((value) => input.prohibited.some((secret) => value.includes(secret)))) findings.push(name);
  }
  return findings;
}
