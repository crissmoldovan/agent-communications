import type { DatabaseSync } from 'node:sqlite';
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
  readonly #tableKeys = new Map<string, Buffer>();

  constructor(database: DatabaseSync, secrets: EventSecretStore) {
    this.#database = database;
    this.#secrets = secrets;
  }

  async encrypt(location: EncryptedRecordLocation, plaintext: Uint8Array): Promise<Buffer> {
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
