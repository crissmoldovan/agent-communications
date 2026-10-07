import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { type AadComponent, encodeAad } from '../src/store/aad.ts';
import { decryptPackedRecord, encryptPackedRecord, PackedRecordError, packedRecordKeyId } from '../src/store/crypto.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { type EventSecretStore, openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
import { EventRecordCipher, RecordStorageError } from '../src/store/records.ts';

interface AadVector {
  readonly name: string;
  readonly table: string;
  readonly column: string;
  readonly key: readonly (string | { readonly integer: number })[];
  readonly hex: string;
}

async function vectors(): Promise<readonly AadVector[]> {
  const url = new URL('./fixtures/aad-v1.json', import.meta.url);
  return JSON.parse(await readFile(url, 'utf8')) as AadVector[];
}

test('CRY-B1: canonical AAD matches every D8 byte vector and preserves SQLite storage classes', async () => {
  for (const vector of await vectors()) {
    const key: AadComponent[] = vector.key.map((part) =>
      typeof part === 'string' ? { type: 'text', value: part } : { type: 'integer', value: part.integer },
    );
    assert.equal(encodeAad(vector.table, vector.column, key).toString('hex'), vector.hex, vector.name);
  }

  assert.notDeepEqual(
    encodeAad('ingest_rules', 'encryptedProjection', [
      { type: 'integer', value: 1 },
      { type: 'text', value: 'rule' },
      { type: 'integer', value: 2 },
    ]),
    encodeAad('ingest_rules', 'encryptedProjection', [
      { type: 'text', value: '1' },
      { type: 'text', value: 'rule' },
      { type: 'integer', value: 2 },
    ]),
  );
});

test('CRY-B1: packed v1 records bind their authenticated bytes to the declared row identity', () => {
  const key = Buffer.alloc(32, 7);
  const nonce = Buffer.alloc(12, 9);
  const aad = encodeAad('ingest_rules', 'encryptedProjection', [
    { type: 'text', value: 'event' },
    { type: 'text', value: 'rule' },
    { type: 'integer', value: 1 },
  ]);
  const record = encryptPackedRecord({ keyId: 'master-1', key, aad, plaintext: Buffer.from('fixture payload'), nonce });

  assert.equal(record[0], 1, 'v1 prefix');
  assert.equal(record[1], 'master-1'.length, 'key identifier length');
  assert.equal(record.subarray(2, 10).toString('ascii'), 'master-1');
  assert.deepEqual(record.subarray(10, 22), nonce, '96-bit nonce follows the identifier');
  assert.deepEqual(
    decryptPackedRecord({ record, keyForId: (id) => (id === 'master-1' ? key : null), aad }),
    Buffer.from('fixture payload'),
  );

  assert.throws(
    () =>
      decryptPackedRecord({
        record,
        keyForId: () => key,
        aad: encodeAad('ingest_rules', 'encryptedProjection', [
          { type: 'text', value: 'event' },
          { type: 'text', value: 'rule' },
          { type: 'integer', value: 2 },
        ]),
      }),
    PackedRecordError,
    'moving a packed record to another primary key must fail authentication',
  );
  const wrongColumn = Buffer.from(aad);
  wrongColumn[wrongColumn.indexOf(Buffer.from('encryptedProjection'))] = 'x'.charCodeAt(0);
  for (const mismatchedAad of [
    encodeAad('decisions', 'encryptedRecord', [{ type: 'text', value: 'event' }]),
    wrongColumn,
    encodeAad('ingest_rules', 'encryptedProjection', [
      { type: 'text', value: 'event' },
      { type: 'text', value: 'rule' },
      { type: 'text', value: '1' },
    ]),
  ]) {
    assert.throws(() => decryptPackedRecord({ record, keyForId: () => key, aad: mismatchedAad }), PackedRecordError);
  }
  assert.throws(
    () => decryptPackedRecord({ record: Buffer.from('not a packed record'), keyForId: () => key, aad }),
    PackedRecordError,
  );
});

class MemorySecretStore implements SecretStore {
  readonly kind = 'file' as const;
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

test('CRY-B1: durable nonce counters and BLOB-only records prevent plaintext and nonce reuse', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-record-'));
  const fixture = Buffer.from('event-fixture-plaintext-must-not-reach-sqlite');
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const file = new MemorySecretStore();
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { file },
      });
      const cipher = new EventRecordCipher(opened.database, secrets);
      const location = {
        table: 'source_scan_state',
        column: 'encryptedRecord',
        key: [{ type: 'text' as const, value: 'scan-1' }],
      };
      const encrypted = await cipher.encrypt(location, fixture);
      opened.database
        .prepare(
          'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('scan-1', 'gmail', 'account-1', 'mailbox', encrypted, 1);
      assert.deepEqual(await cipher.decrypt(location, encrypted), fixture);
      await assert.rejects(cipher.decrypt(location, 'not a BLOB'), RecordStorageError);

      const master = await secrets.currentMaster();
      const rotation = await cipher.rotateAndReencrypt({ batchSize: 1 });
      const rotated = opened.database
        .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
        .get('scan-1') as { encrypted_record: Uint8Array } | undefined;
      assert.ok(rotated);
      assert.equal(rotation.rewritten, 1);
      assert.notEqual(packedRecordKeyId(rotated.encrypted_record), master.keyId);
      assert.deepEqual(await cipher.decrypt(location, rotated.encrypted_record), fixture);

      const rotatedMaster = await secrets.currentMaster();
      const unreadable = await cipher.encrypt(location, Buffer.from('unreadable'));
      file.values.delete(`event-master:${rotatedMaster.keyId}`);
      await assert.rejects(
        cipher.decrypt(location, unreadable),
        (error: unknown) => error instanceof RecordStorageError && error.code === 'RECORD_UNREADABLE_RESET_REQUIRED',
      );
      file.values.set(`event-master:${rotatedMaster.keyId}`, rotatedMaster.key.toString('base64'));
      const unknownKey = encryptPackedRecord({
        keyId: 'unknown-master',
        key: Buffer.alloc(32, 3),
        aad: encodeAad(location.table, location.column, location.key),
        plaintext: Buffer.from('unknown'),
      });
      await assert.rejects(
        cipher.decrypt(location, unknownKey),
        (error: unknown) =>
          error instanceof RecordStorageError &&
          error.code === 'RECORD_UNREADABLE_RESET_REQUIRED' &&
          error.message.includes('unknown-key'),
      );
      const tampered = Buffer.from(rotated.encrypted_record);
      const lastByte = tampered.length - 1;
      assert.ok(lastByte >= 0);
      tampered[lastByte] = (tampered[lastByte] ?? 0) ^ 0x01;
      await assert.rejects(
        cipher.decrypt(location, tampered),
        (error: unknown) =>
          error instanceof RecordStorageError &&
          error.code === 'RECORD_UNREADABLE_RESET_REQUIRED' &&
          error.message.includes('authentication-failed'),
      );
      opened.database
        .prepare('UPDATE nonce_counters SET invocations = ? WHERE key_id = ? AND table_name = ?')
        .run(0xffffffff, rotatedMaster.keyId, 'source_scan_state');
      await assert.rejects(cipher.encrypt(location, Buffer.from('again')), /rotate/);
    } finally {
      opened.close();
    }

    const databaseBytes = await readFile(join(stateDir, 'events', 'events.sqlite'));
    const walBytes = await readFile(join(stateDir, 'events', 'events.sqlite-wal')).catch(() => Buffer.alloc(0));
    assert.equal(databaseBytes.includes(fixture), false);
    assert.equal(walBytes.includes(fixture), false);
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('CRY-B1: rotation never writes an older record back over a row a worker replaced while it was re-encrypting', async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-rotation-race-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/separate/config',
        stores: { file: new MemorySecretStore() },
      });
      const worker = new EventRecordCipher(opened.database, secrets);
      const location = {
        table: 'source_scan_state',
        column: 'encryptedRecord',
        key: [{ type: 'text' as const, value: 'scan-race' }],
      };
      opened.database
        .prepare(
          'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run('scan-race', 'gmail', 'account-1', 'mailbox', await worker.encrypt(location, Buffer.from('before')), 1);

      // The worker replaces the row while rotation awaits the old master, between rotation's read and its write.
      let raced = false;
      const racing = {
        currentMaster: () => secrets.currentMaster(),
        rotateMaster: () => secrets.rotateMaster(),
        master: async (keyId: string) => {
          const key = await secrets.master(keyId);
          if (!raced) {
            raced = true;
            const replacement = await worker.encrypt(location, Buffer.from('written during rotation'));
            opened.database
              .prepare('UPDATE source_scan_state SET encrypted_record = ? WHERE id = ?')
              .run(replacement, 'scan-race');
          }
          return key;
        },
      } as unknown as EventSecretStore;
      const rotation = await new EventRecordCipher(opened.database, racing).rotateAndReencrypt();

      assert.equal(raced, true);
      assert.equal(rotation.rewritten, 0, 'the replaced row is not counted as rewritten');
      const row = opened.database
        .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
        .get('scan-race') as { encrypted_record: Uint8Array } | undefined;
      assert.ok(row);
      assert.equal(
        packedRecordKeyId(row.encrypted_record),
        rotation.keyId,
        "the worker's record, under the new master",
      );
      assert.equal((await worker.decrypt(location, row.encrypted_record)).toString(), 'written during rotation');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
