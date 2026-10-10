import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { SecretStore } from '@agentcomms/core';
import { EventLifecycle } from '../src/runtime/lifecycle.ts';
import { EventScheduler } from '../src/runtime/scheduler.ts';
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

function deferred<T = void>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  return { promise: new Promise<T>((next) => (resolve = next)), resolve };
}

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

test('B3 writer inventory is exact and every discovered cipher or secret-store path is leased', async () => {
  const moduleUrl = new URL('../../../scripts/verify-b3-writer-inventory.mjs', import.meta.url).href;
  const { verifyB3WriterInventory } = (await import(moduleUrl)) as {
    verifyB3WriterInventory(input: { readonly root: string }): Promise<readonly string[]>;
  };
  const problems = await verifyB3WriterInventory({
    root: fileURLToPath(new URL('../../..', import.meta.url)),
  });
  assert.deepEqual(problems, []);
});

test('B3 writer inventory detects a timer-scheduled writer that loses the shared lease', async () => {
  const root = fileURLToPath(new URL('../../..', import.meta.url));
  const scheduler = 'packages/events-daemon/src/runtime/scheduler.ts';
  const records = 'packages/events-daemon/src/store/records.ts';
  const source = await readFile(join(root, scheduler), 'utf8');
  const mutant = source.replace(
    'const work = withEventWriterLease(this.#writerQuiescer, () => this.#tick()).finally',
    'const work = this.#tick().finally',
  );
  assert.notEqual(mutant, source, 'the scheduled-tick mutation must remove the production shared lease');
  const fixture = await mkdtemp(join(tmpdir(), 'aev-b3-writer-inventory-'));
  try {
    await mkdir(join(fixture, 'packages/events-daemon/src/runtime'), { recursive: true });
    await mkdir(join(fixture, 'packages/events-daemon/src/store'), { recursive: true });
    await writeFile(join(fixture, scheduler), mutant);
    await writeFile(join(fixture, records), await readFile(join(root, records), 'utf8'));
    const moduleUrl = new URL('../../../scripts/verify-b3-writer-inventory.mjs', import.meta.url).href;
    const { verifyB3WriterInventory } = (await import(moduleUrl)) as {
      verifyB3WriterInventory(input: {
        readonly root: string;
        readonly inventory: readonly string[];
        readonly files: readonly string[];
      }): Promise<readonly string[]>;
    };
    assert.deepEqual(await verifyB3WriterInventory({ root: fixture, inventory: [scheduler], files: [scheduler] }), [
      `${scheduler}: timer-started writer does not acquire the shared lease before #tick`,
    ]);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test('B3 writer lease prevents an old-key write after the final rotation pass', async () => {
  const quiescer = new WriterQuiescer();
  const encrypted = deferred();
  const allowCommit = deferred();
  const committed = deferred();
  const rotationEntered = deferred();
  let oldKeyWriteLanded = false;

  const writer = withEventWriterLease(quiescer, async () => {
    encrypted.resolve();
    await allowCommit.promise;
    oldKeyWriteLanded = true;
    committed.resolve();
  });
  await encrypted.promise;

  const rotation = quiescer.withExclusive(async () => {
    rotationEntered.resolve();
    assert.equal(
      oldKeyWriteLanded,
      true,
      'an in-flight old-key writer must commit before the final re-encryption pass',
    );
  });

  await Promise.resolve();
  let exclusiveStarted = false;
  void rotation.then(() => {
    exclusiveStarted = true;
  });
  await Promise.resolve();
  assert.equal(exclusiveStarted, false, 'the exclusive rotation lease waits for the in-flight writer');

  allowCommit.resolve();
  await committed.promise;
  await rotationEntered.promise;
  await Promise.all([writer, rotation]);
  assert.equal(oldKeyWriteLanded, true);
});

test('B3 writer lease releases a failed writer in finally', async () => {
  const quiescer = new WriterQuiescer();
  await assert.rejects(
    () =>
      withEventWriterLease(quiescer, async () => {
        throw new Error('synthetic writer failure');
      }),
    /synthetic writer failure/,
  );
  let exclusive = false;
  await quiescer.withExclusive(async () => {
    exclusive = true;
  });
  assert.equal(exclusive, true, 'a thrown writer must not leave the quiescer permanently leased');
});

test('B3 scheduled scheduler tick holds the owner writer lease from encrypt through its commit', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-scheduled-writer-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      await selectEventSecretStore(opened.database, 'file');
      opened.database.prepare('UPDATE event_settings SET enabled = 0').run();
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
      const encrypted = deferred();
      const permitCommit = deferred();
      const committed = deferred();
      let sweepStarted = false;
      const scheduler = new EventScheduler({
        store: opened,
        lifecycle: new EventLifecycle(opened),
        activations: { resumeClaimedCompletions: async () => undefined } as never,
        dispatcher: { dispatch: async () => ({ state: 'missing', deliveryId: 'unused' }) } as never,
        expiry: {
          sweepAll: async () => {
            if (sweepStarted) return;
            sweepStarted = true;
            const record = await cipher.encrypt(
              { table: 'source_scan_state', column: 'encryptedRecord', key: [{ type: 'text', value: 'timer-race' }] },
              Buffer.from('scheduled synthetic value'),
            );
            encrypted.resolve();
            await permitCommit.promise;
            opened.database
              .prepare(
                'INSERT INTO source_scan_state (id, source, account_id, cursor_scope, encrypted_record, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
              )
              .run('timer-race', 'gmail', 'synthetic-account', 'mailbox', record, 1);
            committed.resolve();
          },
        } as never,
        cipher,
        approvals: {} as never,
        config: {
          load: async () => ({ inboxes: { synthetic: { id: 'synthetic-account', provider: 'gmail' } } }),
        } as never,
        taint: {} as never,
        gmailSourceFor: async () => ({}) as never,
        mailboxLock: {} as never,
        writerQuiescer: quiescer,
        tickMs: 1,
      });
      scheduler.start();
      const keepAlive = setInterval(() => undefined, 1_000);
      let rotation: Promise<{ readonly keyId: string; readonly rewritten: number }> | undefined;
      try {
        await encrypted.promise;

        rotation = cipher.rotateAndReencrypt({ batchSize: 1 });
        await new Promise<void>((resolve) => setImmediate(resolve));
        assert.equal(rotationStarted, false, 'the final re-encryption pass must wait for a scheduled tick writer');

        permitCommit.resolve();
        await committed.promise;
        const result = await rotation;
        const row = opened.database
          .prepare('SELECT encrypted_record FROM source_scan_state WHERE id = ?')
          .get('timer-race') as { encrypted_record: Uint8Array } | undefined;
        assert.ok(row);
        assert.equal(
          packedRecordKeyId(row.encrypted_record),
          result.keyId,
          'a scheduled old-key write cannot land after rotation',
        );
      } finally {
        permitCommit.resolve();
        await rotation?.catch(() => undefined);
        clearInterval(keepAlive);
        await scheduler.stop();
      }
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
