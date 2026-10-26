import type { DatabaseSync } from 'node:sqlite';
import type { JudgeKind } from '../domain/lifecycle.ts';
import { JUDGE_KINDS } from '../domain/lifecycle.ts';
import type { SourceOptions } from '../domain/source-options.ts';
import { LAYA_MODEL_FAILURE_CODES, type LayaModelFailureCode, type LayaModelState } from '../runtime/laya/contracts.ts';
import { type WriterQuiescer, withEventWriterLease } from '../runtime/writer-quiescer.ts';
import { type AadComponent, encodeAad } from './aad.ts';
import {
  decryptPackedRecord,
  deriveTableKey,
  encryptPackedRecord,
  PackedRecordError,
  packedRecordKeyId,
} from './crypto.ts';
import { type EventMaster, EventSecretError, type EventSecretStore } from './event-secrets.ts';

const MAX_INVOCATIONS_PER_TABLE_KEY = 0xffffffff;

export class RecordStorageError extends Error {
  readonly code: 'NONCE_LIMIT' | 'RECORD_STORAGE_CLASS' | 'RECORD_UNREADABLE_RESET_REQUIRED' | 'ROTATION_INCOMPLETE';

  constructor(code: RecordStorageError['code'], message: string) {
    super(message);
    this.name = 'RecordStorageError';
    this.code = code;
  }
}

export type UnreadableRecordReason = 'authentication-failed' | 'master-lost' | 'unknown-key';

/** Maps ciphertext/key failures to the reset path; callers must never substitute plaintext for these records. */
export function unreadableRecordReason(error: unknown): UnreadableRecordReason | null {
  if (error instanceof EventSecretError) {
    if (error.code === 'EVENT_MASTER_LOST') return 'master-lost';
    if (error.code === 'EVENT_MASTER_UNKNOWN') return 'unknown-key';
  }
  if (error instanceof PackedRecordError) {
    if (error.code === 'AUTHENTICATION_FAILED') return 'authentication-failed';
    if (error.code === 'UNKNOWN_KEY') return 'unknown-key';
  }
  return null;
}

export interface EncryptedRecordLocation {
  readonly table: string;
  readonly column: string;
  readonly key: readonly AadComponent[];
}

export interface RecordLayout {
  readonly table: string;
  readonly column: string;
  readonly sqlColumn: string;
  readonly keyColumns: readonly string[];
}

/** A source/account pair is always explicit at the store boundary; aliases and provider objects never become keys. */
export interface SourceAccountRecord {
  readonly source: SourceOptions['channel'];
  readonly accountId: string;
}

/** The closed source/account/test/kind selector algebra for all future judge-ledger mutations. */
export type JudgeWorkScope =
  | {
      readonly scope: 'source-owned';
      readonly source: SourceOptions['channel'];
      readonly accountId: string;
      readonly eventId?: string;
      readonly ruleId?: string;
      readonly ruleVersion?: number;
      readonly judgeId?: string;
      readonly judgeVersion?: number;
      readonly decisionId?: string;
      readonly reservationId?: string;
    }
  | {
      readonly scope: 'synthetic-test';
      readonly testWorkId: string;
      readonly judgeId: string;
      readonly judgeVersion: number;
    }
  | { readonly scope: 'judge-kind'; readonly judgeKind: JudgeKind };

export type JudgeReservationState = 'reserved' | 'in-flight' | 'settled' | 'released';

export interface JudgeBudgetReservationRecord {
  readonly id: string;
  readonly workId: string;
  readonly scope: Exclude<JudgeWorkScope, { readonly scope: 'judge-kind' }>;
  readonly judgeKind: JudgeKind;
  readonly budgetVersion: number;
  readonly provider: string | null;
  readonly state: JudgeReservationState;
  readonly estimatedInputTokens: number;
  readonly actualInputTokens: number | null;
  readonly concurrencyOwned: boolean;
  readonly reservedAt: number;
  readonly inFlightAt: number | null;
  readonly settledAt: number | null;
  readonly releasedAt: number | null;
  readonly switchGeneration: number;
}

export interface HoldResolutionClaimRecord {
  readonly decisionId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly claimToken: Uint8Array;
  readonly claimedAt: number;
  readonly leaseExpiresAt: number;
}

export interface JudgeTestChargeRecord {
  readonly judgeId: string;
  readonly judgeVersion: number;
  readonly chargedAt: number;
  readonly workId: string;
}

/** D8's content-free local model progress row.  It deliberately has no tree, source, input or output field. */
export interface LayaModelRecord {
  readonly manifestId: string;
  readonly state: LayaModelState;
  readonly bytesVerified: number;
  readonly verifiedAt: number | null;
  readonly failureCode: LayaModelFailureCode | null;
  readonly updatedAt: number;
}

export interface WriteLayaModelRecord {
  readonly manifestId: string;
  readonly state: LayaModelState;
  readonly bytesVerified: number;
  readonly verifiedAt?: number | null | undefined;
  readonly failureCode?: LayaModelFailureCode | null | undefined;
  readonly now: number;
}

function layaModelText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${name} is a non-empty string`);
  return value;
}

function layaModelInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw new Error(`${name} is a non-negative safe integer`);
  return value as number;
}

function layaModelState(value: unknown): LayaModelState {
  if (
    value === 'installing' ||
    value === 'downloading' ||
    value === 'ready' ||
    value === 'failed' ||
    value === 'removed'
  )
    return value;
  throw new Error('the model state is closed');
}

function layaModelFailureCode(value: unknown, name: string): LayaModelFailureCode | null {
  if (value === null || value === undefined) return null;
  if ((LAYA_MODEL_FAILURE_CODES as readonly string[]).includes(value as string)) return value as LayaModelFailureCode;
  throw new Error(`${name} is closed`);
}

/**
 * The model-state repository is intentionally not an enablement mechanism.  Callers hold an immediate transaction;
 * the pointer is re-read in that same transaction directly before the write so a pre-claim or disabled lifecycle
 * cannot leave a model row behind.
 */
export class LayaModelRepository {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  write(input: WriteLayaModelRecord): LayaModelRecord {
    const pointer = this.#database
      .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
      .get(JUDGE_KINDS[1]) as { version: number } | undefined;
    if (pointer === undefined)
      throw new Error('the active Laya judge-kind pointer is required before model state changes');
    const record: LayaModelRecord = {
      manifestId: layaModelText(input.manifestId, 'the model manifest id'),
      state: layaModelState(input.state),
      bytesVerified: layaModelInteger(input.bytesVerified, 'the verified model bytes'),
      verifiedAt:
        input.verifiedAt === undefined || input.verifiedAt === null
          ? null
          : layaModelInteger(input.verifiedAt, 'the model verification time'),
      failureCode: layaModelFailureCode(input.failureCode, 'the model failure code'),
      updatedAt: layaModelInteger(input.now, 'the model update time'),
    };
    const enabled = this.#database
      .prepare(
        `SELECT versions.document
         FROM active_versions AS active
         JOIN judge_kind_versions AS versions
           ON versions.kind = active.object_id AND versions.version = active.version
         WHERE active.kind = 'judge-kind' AND active.object_id = ? AND versions.revoked_at IS NULL`,
      )
      .get(JUDGE_KINDS[1]) as { document: string } | undefined;
    let enabledManifestId: string | undefined;
    try {
      const document = JSON.parse(enabled?.document ?? 'null') as { manifest?: { manifestId?: unknown } };
      const manifestId = document.manifest?.manifestId;
      if (typeof manifestId === 'string' && manifestId.length > 0) enabledManifestId = manifestId;
    } catch {
      // The closed error below deliberately does not reflect corrupted document bytes.
    }
    if (enabledManifestId === undefined) throw new Error('the active Laya judge-kind pointer has no reviewed manifest');
    if (record.manifestId !== enabledManifestId)
      throw new Error('the model manifest must match the active Laya judge-kind pointer');
    this.#database
      .prepare(
        `INSERT INTO laya_models
          (manifest_id, state, bytes_verified, verified_at, failure_code, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(manifest_id) DO UPDATE SET
           state = excluded.state,
           bytes_verified = excluded.bytes_verified,
           verified_at = excluded.verified_at,
           failure_code = excluded.failure_code,
           updated_at = excluded.updated_at`,
      )
      .run(
        record.manifestId,
        record.state,
        record.bytesVerified,
        record.verifiedAt,
        record.failureCode,
        record.updatedAt,
      );
    return record;
  }

  /**
   * `judge model remove` is the one model-state change made while Laya is disabled, so it carries the opposite fence:
   * the same transaction re-reads the pointer and refuses if a later enablement claimed it. It records only the
   * reviewed manifest id and the closed `removed` state.
   */
  markRemovedWhileDisabled(input: { readonly manifestId: string; readonly now: number }): LayaModelRecord {
    const pointer = this.#database
      .prepare("SELECT version FROM active_versions WHERE kind = 'judge-kind' AND object_id = ?")
      .get(JUDGE_KINDS[1]) as { version: number } | undefined;
    if (pointer !== undefined) throw new Error('a Laya model is removed only while its judge kind is disabled');
    const record: LayaModelRecord = {
      manifestId: layaModelText(input.manifestId, 'the model manifest id'),
      state: 'removed',
      bytesVerified: 0,
      verifiedAt: null,
      failureCode: null,
      updatedAt: layaModelInteger(input.now, 'the model update time'),
    };
    this.#database
      .prepare(
        `INSERT INTO laya_models
          (manifest_id, state, bytes_verified, verified_at, failure_code, updated_at)
         VALUES (?, 'removed', 0, NULL, NULL, ?)
         ON CONFLICT(manifest_id) DO UPDATE SET
           state = 'removed', bytes_verified = 0, verified_at = NULL, failure_code = NULL,
           updated_at = excluded.updated_at`,
      )
      .run(record.manifestId, record.updatedAt);
    return record;
  }

  get(manifestId: string): LayaModelRecord | null {
    const row = this.#database
      .prepare(
        `SELECT manifest_id, state, bytes_verified, verified_at, failure_code, updated_at
         FROM laya_models WHERE manifest_id = ?`,
      )
      .get(layaModelText(manifestId, 'the model manifest id')) as
      | {
          manifest_id: unknown;
          state: unknown;
          bytes_verified: unknown;
          verified_at: unknown;
          failure_code: unknown;
          updated_at: unknown;
        }
      | undefined;
    if (row === undefined) return null;
    return {
      manifestId: layaModelText(row.manifest_id, 'stored model manifest id'),
      state: layaModelState(row.state),
      bytesVerified: layaModelInteger(row.bytes_verified, 'stored verified model bytes'),
      verifiedAt: row.verified_at === null ? null : layaModelInteger(row.verified_at, 'stored verification time'),
      failureCode: layaModelFailureCode(row.failure_code, 'stored model failure code'),
      updatedAt: layaModelInteger(row.updated_at, 'stored model update time'),
    };
  }
}

/** Typed D-owned state records keep provider cursors and raw identities out of untyped store calls. */
export interface SlackReplyDrainRecord extends SourceAccountRecord {
  readonly source: 'slack';
  readonly intentId: string;
  readonly conversationId: string;
  readonly threadTs: string;
  readonly cursor: string | null;
  readonly coveredThrough: string;
  readonly drainedAt: number | null;
}

export interface ResendStatusStateRecord extends SourceAccountRecord {
  readonly source: 'resend';
  readonly emailId: string;
  readonly lastEvent:
    | 'scheduled'
    | 'sent'
    | 'delivered'
    | 'delivery_delayed'
    | 'bounced'
    | 'complained'
    | 'opened'
    | 'clicked'
    | 'failed'
    | 'suppressed'
    | 'canceled'
    | 'queued';
  readonly observedAt: number;
  readonly expiresAt: number;
}

export interface WhatsAppOccurrenceRecord extends SourceAccountRecord {
  readonly source: 'whatsapp';
  readonly messageId: string;
  readonly firstSeenGeneration: number;
  readonly firstSeenAt: number;
  readonly visibilityVersion: number;
  readonly stagedPayloadRef: string | null;
  readonly stageExpiresAt: number | null;
  readonly eventId: string | null;
}

/** Each encrypted column, with its table's primary key in the order the v1 migration declares it — the AAD order. */
export const RECORD_LAYOUTS: readonly RecordLayout[] = [
  { table: 'source_scan_state', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['id'] },
  {
    table: 'rule_activation_points',
    column: 'encryptedPosition',
    sqlColumn: 'encrypted_position',
    keyColumns: ['activation_id', 'rule_id', 'rule_version', 'account_id', 'position_scope'],
  },
  {
    table: 'activation_baselines',
    column: 'encryptedPosition',
    sqlColumn: 'encrypted_position',
    keyColumns: ['intent_id', 'source', 'account_id', 'position_scope'],
  },
  {
    table: 'ingest_rules',
    column: 'encryptedProjection',
    sqlColumn: 'encrypted_projection',
    keyColumns: ['event_id', 'rule_id', 'rule_version'],
  },
  { table: 'decisions', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['id'] },
  { table: 'deliveries', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['id'] },
  { table: 'dryrun_log', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['delivery_id'] },
  { table: 'stream_log', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['id'] },
  {
    table: 'event_secret_generations',
    column: 'encryptedReference',
    sqlColumn: 'encrypted_ref',
    keyColumns: ['owner_kind', 'owner_id', 'owner_version', 'purpose', 'generation'],
  },
  {
    table: 'system_reset_outbox',
    column: 'encryptedRecord',
    sqlColumn: 'encrypted_record',
    keyColumns: ['id'],
  },
  { table: 'queue_items', column: 'encryptedRecord', sqlColumn: 'encrypted_record', keyColumns: ['id'] },
  // A judged decision's sending domain, for Analyse (security review of 0.33.0, finding 9).
  {
    table: 'decision_sender_domains',
    column: 'encryptedDomain',
    sqlColumn: 'encrypted_domain',
    keyColumns: ['decision_id'],
  },
];

type SqlValue = string | number | bigint | Uint8Array | null;

export interface RotationResult {
  readonly keyId: string;
  readonly rewritten: number;
}

/** Encrypts and decrypts B1 table records while reserving the D8 nonce-invocation budget in SQLite. */
/** A rotation pass that still meets an older key this many times is refused, never looped. */
const MAX_ROTATION_PASSES = 32;

export class EventRecordCipher {
  readonly #database: DatabaseSync;
  readonly #secrets: EventSecretStore;
  readonly #quiescer: WriterQuiescer;
  readonly #tableKeys = new Map<string, Buffer>();

  constructor(database: DatabaseSync, secrets: EventSecretStore, quiescer: WriterQuiescer) {
    this.#database = database;
    this.#secrets = secrets;
    this.#quiescer = quiescer;
  }

  /** The B3 secret service must share this exact owner-wide lease, never a look-alike lock. */
  get writerQuiescer(): WriterQuiescer {
    return this.#quiescer;
  }

  async encrypt(location: EncryptedRecordLocation, plaintext: Uint8Array): Promise<Buffer> {
    return withEventWriterLease(this.#quiescer, () => this.encryptHeld(location, plaintext));
  }

  private async encryptHeld(location: EncryptedRecordLocation, plaintext: Uint8Array): Promise<Buffer> {
    const master = await this.#secrets.currentMaster();
    this.reserveInvocation(master.keyId, location.table);
    return encryptPackedRecord({
      keyId: master.keyId,
      key: this.tableKey(master.keyId, master.key, location.table),
      aad: encodeAad(location.table, location.column, location.key),
      plaintext,
    });
  }

  async decrypt(location: EncryptedRecordLocation, stored: unknown): Promise<Buffer> {
    return withEventWriterLease(this.#quiescer, () => this.decryptHeld(location, stored));
  }

  private async decryptHeld(location: EncryptedRecordLocation, stored: unknown): Promise<Buffer> {
    if (!(stored instanceof Uint8Array)) {
      throw new RecordStorageError('RECORD_STORAGE_CLASS', 'encrypted event records must be SQLite BLOB values');
    }
    const record = Buffer.from(stored);
    try {
      const keyId = packedRecordKeyId(record);
      const master = await this.#secrets.master(keyId);
      return decryptPackedRecord({
        record,
        keyForId: (selected) => (selected === keyId ? this.tableKey(keyId, master, location.table) : null),
        aad: encodeAad(location.table, location.column, location.key),
      });
    } catch (error) {
      const reason = unreadableRecordReason(error);
      if (reason === null) throw error;
      throw new RecordStorageError(
        'RECORD_UNREADABLE_RESET_REQUIRED',
        `encrypted event record is unreadable (${reason}); installation reset is required`,
      );
    }
  }

  /**
   * Re-encrypts every B1 packed column in small SQLite write batches under a newly generated master.
   *
   * Precondition, owed by its caller: no writer may hold ciphertext between `encrypt()` and its own write across the
   * rotation. A record a worker encrypted under the old master before `rotateMaster()` and wrote after the last pass
   * would stay under the retired key (still readable: retired masters are kept). B1 exposes no caller; the B3 operation
   * that does must stop the owner's writers and await their in-flight work first, and destroying a retired master must
   * refuse while any record still names it (plan, "PR #59 review (Blocks)" row).
   */
  async rotateAndReencrypt(options: { readonly batchSize?: number | undefined } = {}): Promise<RotationResult> {
    return this.#quiescer.withExclusive(() => this.rotateAndReencryptHeld(options));
  }

  private async rotateAndReencryptHeld(
    options: { readonly batchSize?: number | undefined } = {},
  ): Promise<RotationResult> {
    const batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize < 1)
      throw new RecordStorageError('NONCE_LIMIT', 'rotation batch size must be positive');
    const master = await this.#secrets.rotateMaster();
    let rewritten = 0;
    for (const layout of RECORD_LAYOUTS) {
      rewritten += await this.reencryptLayout(layout, master, batchSize);
    }
    return { keyId: master.keyId, rewritten };
  }

  private reserveInvocation(keyId: string, table: string): void {
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const row = this.#database
        .prepare('SELECT invocations FROM nonce_counters WHERE key_id = ? AND table_name = ?')
        .get(keyId, table) as { invocations: number } | undefined;
      if ((row?.invocations ?? 0) >= MAX_INVOCATIONS_PER_TABLE_KEY) {
        throw new RecordStorageError(
          'NONCE_LIMIT',
          'the event table key reached its nonce limit; rotate the master key before encrypting again',
        );
      }
      this.#database
        .prepare(
          `INSERT INTO nonce_counters (key_id, table_name, invocations) VALUES (?, ?, 1)
           ON CONFLICT(key_id, table_name) DO UPDATE SET invocations = nonce_counters.invocations + 1`,
        )
        .run(keyId, table);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  private tableKey(keyId: string, master: Uint8Array, table: string): Buffer {
    const cacheKey = `${keyId}\u0000${table}`;
    const cached = this.#tableKeys.get(cacheKey);
    if (cached !== undefined) return cached;
    const derived = deriveTableKey(master, table);
    this.#tableKeys.set(cacheKey, derived);
    return derived;
  }

  private async reencryptLayout(layout: RecordLayout, master: EventMaster, batchSize: number): Promise<number> {
    let rewritten = 0;
    const selectedColumns = [...layout.keyColumns, layout.sqlColumn].join(', ');
    const orderedColumns = layout.keyColumns.join(', ');
    const first = this.#database.prepare(
      `SELECT ${selectedColumns} FROM ${layout.table} WHERE ${layout.sqlColumn} IS NOT NULL ORDER BY ${orderedColumns} LIMIT ?`,
    );
    // Keyset pagination: each batch starts strictly after the last primary key read, so a row a worker deletes or
    // replaces while a batch awaits cannot shift a later row out of the pass (an OFFSET would skip it).
    const next = this.#database.prepare(
      `SELECT ${selectedColumns} FROM ${layout.table}
       WHERE ${layout.sqlColumn} IS NOT NULL AND (${orderedColumns}) > (${layout.keyColumns.map(() => '?').join(', ')})
       ORDER BY ${orderedColumns} LIMIT ?`,
    );
    const where = layout.keyColumns.map((column) => `${column} = ?`).join(' AND ');
    const update = this.#database.prepare(
      `UPDATE ${layout.table} SET ${layout.sqlColumn} = ? WHERE ${where} AND ${layout.sqlColumn} = ?`,
    );
    // Passes repeat until one meets no row under an older key: a record a worker encrypted under the old master
    // before the rotation and wrote during a pass is met by the next one. New writes use the new master, so the passes
    // end; the cap only turns a writer that keeps reintroducing the old key into a refusal rather than a loop.
    for (let pass = 0; ; pass += 1) {
      if (pass === MAX_ROTATION_PASSES) {
        throw new RecordStorageError(
          'ROTATION_INCOMPLETE',
          `${layout.table}.${layout.sqlColumn} still held a record under an older key after ${MAX_ROTATION_PASSES} passes`,
        );
      }
      let sawOlder = false;
      let last: readonly SqlValue[] | undefined;
      for (;;) {
        const rows = (last === undefined ? first.all(batchSize) : next.all(...last, batchSize)) as Array<
          Record<string, unknown>
        >;
        if (rows.length === 0) break;
        last = this.keyValues(layout, rows[rows.length - 1] as Record<string, unknown>);
        const updates: Array<{
          readonly record: Buffer;
          readonly read: Uint8Array;
          readonly keys: readonly SqlValue[];
        }> = [];
        for (const row of rows) {
          const stored = row[layout.sqlColumn];
          if (!(stored instanceof Uint8Array)) {
            throw new RecordStorageError('RECORD_STORAGE_CLASS', `${layout.table}.${layout.sqlColumn} is not a BLOB`);
          }
          if (packedRecordKeyId(stored) === master.keyId) continue;
          sawOlder = true;
          const location = this.locationFor(layout, row);
          const plaintext = await this.decrypt(location, stored);
          updates.push({
            record: await this.encrypt(location, plaintext),
            read: stored,
            keys: this.keyValues(layout, row),
          });
        }
        if (updates.length === 0) continue;
        // Only a row still holding the bytes read above is rewritten. The reads and encryptions await, so a worker may
        // have replaced or purged the row meanwhile; writing the older content back over it would undo that work.
        this.#database.exec('BEGIN IMMEDIATE');
        try {
          for (const item of updates) {
            if (Number(update.run(item.record, ...item.keys, item.read).changes) === 1) rewritten += 1;
          }
          this.#database.exec('COMMIT');
        } catch (error) {
          this.#database.exec('ROLLBACK');
          throw error;
        }
      }
      if (!sawOlder) return rewritten;
    }
  }

  private locationFor(layout: RecordLayout, row: Record<string, unknown>): EncryptedRecordLocation {
    return {
      table: layout.table,
      column: layout.column,
      key: layout.keyColumns.map((column) => this.component(row[column], `${layout.table}.${column}`)),
    };
  }

  private keyValues(layout: RecordLayout, row: Record<string, unknown>): readonly SqlValue[] {
    return layout.keyColumns.map((column) => this.sqlValue(row[column], `${layout.table}.${column}`));
  }

  private component(value: unknown, name: string): AadComponent {
    if (typeof value === 'string') return { type: 'text', value };
    if (typeof value === 'number' || typeof value === 'bigint') return { type: 'integer', value };
    if (value instanceof Uint8Array) return { type: 'blob', value };
    throw new RecordStorageError('RECORD_STORAGE_CLASS', `${name} is not a valid primary-key storage class`);
  }

  private sqlValue(value: unknown, name: string): SqlValue {
    if (
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'bigint' ||
      value instanceof Uint8Array ||
      value === null
    ) {
      return value;
    }
    throw new RecordStorageError('RECORD_STORAGE_CLASS', `${name} is not a SQLite value`);
  }
}
