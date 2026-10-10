import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { WriterQuiescer, withEventWriterLease } from '../src/runtime/writer-quiescer.ts';
import { packedRecordKeyId } from '../src/store/crypto.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStore,
  type EventSecretStoreKind,
  openEventSecretStore,
  selectEventSecretStore,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly kind: EventSecretStoreKind = 'file';
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

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  return { promise: new Promise<void>((next) => (resolve = next)), resolve };
}

test('B3 master rotation waits for an old-key writer before its final re-encryption pass', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-master-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file: new MemorySecretStore() },
      });
      const quiescer = new WriterQuiescer();
      let rotationStarted = false;
      const rotatingSecrets = {
        currentMaster: () => secrets.currentMaster(),
        master: (keyId: string) => secrets.master(keyId),
        async rotateMaster() {
          rotationStarted = true;
          return secrets.rotateMaster();
        },
      } as unknown as EventSecretStore;
      const cipher = new EventRecordCipher(opened.database, rotatingSecrets, quiescer);
      const location = {
        table: 'source_scan_state',
        column: 'encryptedRecord',
        key: [{ type: 'text' as const, value: 'late-old-key' }],
      };
      const encrypted = deferred();
      const permitCommit = deferred();
      const committed = deferred();
      const writer = withEventWriterLease(quiescer, async () => {
        const oldKeyRecord = await cipher.encrypt(location, Buffer.from('synthetic old master record'));
        encrypted.resolve();
        await permitCommit.promise;
        opened.database
          .prepare(
            'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run('late-old-key', 'gmail', 'synthetic-account', 'mailbox', oldKeyRecord, 1);
        committed.resolve();
      });
      await encrypted.promise;

      const rotation = cipher.rotateAndReencrypt({ batchSize: 1 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      let leaseAssertion: unknown;
      try {
        assert.equal(
          rotationStarted,
          false,
          'the exclusive rekey cannot rotate a master while an old-key writer is held',
        );
        const beforeCommit = opened.database
          .prepare("SELECT COUNT(*) AS count FROM source_scan_state WHERE id = 'late-old-key'")
          .get() as { count: number };
        assert.equal(
          beforeCommit.count,
          0,
          'rotation cannot begin its final pass while the old-key writer holds its lease',
        );
      } catch (error) {
        leaseAssertion = error;
      } finally {
        permitCommit.resolve();
        await committed.promise;
      }
      const result = await rotation;
      assert.equal(rotationStarted, true);
      await writer;
      if (leaseAssertion !== undefined) throw leaseAssertion;
      const row = opened.database
        .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
        .get('late-old-key') as { encrypted_record: Uint8Array } | undefined;
      assert.ok(row);
      assert.equal(packedRecordKeyId(row.encrypted_record), result.keyId, 'no old-key write survives the final pass');
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 master destruction refuses a retired key still named by a packed record', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-retired-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file: new MemorySecretStore() },
      });
      const quiescer = new WriterQuiescer();
      const cipher = new EventRecordCipher(opened.database, secrets, quiescer);
      const location = {
        table: 'source_scan_state',
        column: 'encryptedRecord',
        key: [{ type: 'text' as const, value: 'old-key-row' }],
      };
      const old = await secrets.currentMaster();
      opened.database
        .prepare(
          'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .run(
          'old-key-row',
          'gmail',
          'synthetic-account',
          'mailbox',
          await cipher.encrypt(location, Buffer.from('synthetic')),
          1,
        );
      await secrets.rotateMaster();
      await quiescer.withExclusive(() =>
        assert.rejects(
          () => secrets.destroyRetiredMaster({ keyId: old.keyId, cipher, quiescer }),
          (error: unknown) => (error as { readonly code?: unknown }).code === 'RETIRED_MASTER_REFERENCED',
        ),
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
