import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStoreKind,
  openEventSecretStore,
  selectEventSecretStore,
  storeEventSecretGeneration,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

class PausableSecretStore implements SecretStore {
  readonly kind: EventSecretStoreKind = 'file';
  readonly values = new Map<string, string>();
  #release: (() => void) | undefined;
  #written: (() => void) | undefined;
  readonly written = new Promise<void>((resolve) => {
    this.#written = resolve;
  });
  readonly release = new Promise<void>((resolve) => {
    this.#release = resolve;
  });

  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }

  async set(ref: string, value: string): Promise<void> {
    this.values.set(ref, value);
    this.#written?.();
    await this.release;
  }

  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }

  continue(): void {
    this.#release?.();
  }

  invalidate(): void {}
}

test('B2-T3: an awaited secret write re-reads the exact live owner before it commits an opaque generation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-secret-slot-race-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const document = canonicalJson({
        targetId: 'target-race',
        version: 1,
        kind: 'webhook',
        url: { kind: 'secret', scheme: 'https', host: 'receiver.example.test', port: 443, sha256: 'f'.repeat(64) },
        approvedAddressSet: ['8.8.8.8'],
        signing: 'standard-webhooks',
        ordering: 'strict',
        retryLimit: 20,
        representation: 'enveloped',
      });
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-race@1', 'target-race', 1, document, sha256Hex(document));
      await selectEventSecretStore(opened.database, 'file');
      const backend = new PausableSecretStore();
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/srv/test',
        stores: { file: backend },
      });
      const cipher = new EventRecordCipher(opened.database, secrets);
      const writing = storeEventSecretGeneration({
        database: opened.database,
        paths: opened.paths,
        store: secrets,
        cipher,
        owner: { kind: 'target', id: 'target-race', version: 1, digest: sha256Hex(document) },
        purpose: 'secret-url',
        material: 'https://receiver.example.test/credential',
        expectedPriorGeneration: null,
      });
      await backend.written;
      opened.database.prepare('UPDATE target_versions SET revoked_at = ? WHERE id = ?').run(1, 'target-race@1');
      backend.continue();
      await assert.rejects(writing, /owner|live|version/i);
      assert.equal(
        [...backend.values.keys()].filter((ref) => ref.startsWith('event-secret:')).length,
        0,
        'the uncommitted backend value is retired after the owner loses authority',
      );
      const rows = opened.database.prepare('SELECT COUNT(*) AS count FROM event_secret_generations').get() as {
        count: number;
      };
      assert.equal(rows.count, 0);
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
