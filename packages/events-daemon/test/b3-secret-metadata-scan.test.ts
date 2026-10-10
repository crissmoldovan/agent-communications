import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { HumanSecret } from '../src/domain/human-secret.ts';
import { B3SecretControl } from '../src/runtime/b3-secret-control.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import {
  type EventSecretStoreKind,
  openEventSecretStore,
  scanEventSecretPersistence,
  selectEventSecretStore,
} from '../src/store/event-secrets.ts';
import { EventRecordCipher } from '../src/store/records.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

class MemorySecretStore implements SecretStore {
  readonly kind: EventSecretStoreKind;
  readonly values = new Map<string, string>();
  readonly writes = new Set<string>();
  constructor(kind: EventSecretStoreKind) {
    this.kind = kind;
  }
  async get(ref: string): Promise<string | null> {
    return this.values.get(ref) ?? null;
  }
  async set(ref: string, value: string): Promise<void> {
    this.writes.add(value);
    this.values.set(ref, value);
  }
  async delete(ref: string): Promise<boolean> {
    return this.values.delete(ref);
  }
  invalidate(): void {}
}

/**
 * Observes everything this process writes to stdout and stderr (console included) while `work` runs, passing every
 * write through. The event daemon logs only through these streams, so this is its real log boundary.
 */
async function captureProcessOutput<T>(work: () => Promise<T>): Promise<{ readonly value: T; readonly log: string[] }> {
  const log: string[] = [];
  const streams = [process.stdout, process.stderr] as const;
  const originals = streams.map((stream) => stream.write);
  streams.forEach((stream, index) => {
    const original = originals[index] as typeof stream.write;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      log.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8'));
      return (original as (...args: unknown[]) => boolean).call(stream, chunk, ...rest);
    }) as typeof stream.write;
  });
  try {
    return { value: await work(), log };
  } finally {
    streams.forEach((stream, index) => {
      stream.write = originals[index] as typeof stream.write;
    });
  }
}

function targetDocument(targetId: string, version: number): Record<string, unknown> {
  return {
    targetId,
    version,
    kind: 'webhook',
    url: { kind: 'plain', value: 'https://receiver.invalid/events' },
    approvedAddressSet: ['8.8.8.8'],
    signing: 'standard-webhooks',
    ordering: 'strict',
    retryLimit: 20,
    representation: 'plain',
  };
}

test('B3 metadata scan finds no synthetic secret in SQLite, WAL, free pages, or receipt sinks for every secret operation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-scan-'));
  const sentinels = [
    'b3-sentinel-target-create-02d9',
    'b3-sentinel-target-rotate-3a61',
    'b3-sentinel-subscriber-create-4e2c',
    'b3-sentinel-subscriber-rotate-53fa',
    'b3-sentinel-judge-set-67b4',
    'b3-sentinel-judge-rotate-7c18',
    'b3-sentinel-secret-url-8d22',
  ] as const;
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const target = canonicalJson(targetDocument('target-scan', 1));
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-scan@1', 'target-scan', 1, target, sha256Hex(target));
      const subscriber = canonicalJson({
        subscriberId: 'subscriber-scan',
        version: 1,
        kind: 'sse',
        authority: { host: '127.0.0.1', port: 43101 },
        origins: ['https://console.invalid'],
        retentionMs: 60_000,
      });
      opened.database
        .prepare(
          'INSERT INTO subscriber_versions (id, subscriber_id, version, document, digest) VALUES (?, ?, ?, ?, ?)',
        )
        .run('subscriber-scan@1', 'subscriber-scan', 1, subscriber, sha256Hex(subscriber));
      const judge = canonicalJson({
        judgeId: 'judge-scan',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev',
      });
      opened.database
        .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('judge-scan@1', 'judge-scan', 1, judge, sha256Hex(judge));
      await selectEventSecretStore(opened.database, 'file');
      const file = new MemorySecretStore('file');
      const keychain = new MemorySecretStore('keychain');
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file, keychain },
      });
      const quiescer = new WriterQuiescer();
      let nextSigning = 0;
      let nextToken = 2;
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher: new EventRecordCipher(opened.database, secrets, quiescer),
        quiescer,
        secretMaterial: {
          nextSigningSecret: () => sentinels[nextSigning++] as string,
          nextSubscriberToken: () => sentinels[nextToken++] as string,
        },
      });
      const { value: receipts, log } = await captureProcessOutput(async () => [
        await control.targetSecretCreate({ targetId: 'target-scan', version: 1 }),
        await control.targetSecretRotate({ targetId: 'target-scan', version: 1 }),
        await control.subscriberTokenCreate({ subscriberId: 'subscriber-scan', version: 1 }),
        await control.subscriberTokenRotate({ subscriberId: 'subscriber-scan', version: 1 }),
        await control.judgeKeySet({
          judgeId: 'judge-scan',
          version: 1,
          hidden: HumanSecret.fromTrustedInput(sentinels[4]),
        }),
        await control.judgeKeyRotate({
          judgeId: 'judge-scan',
          version: 1,
          hidden: HumanSecret.fromTrustedInput(sentinels[5]),
        }),
        await control.targetUrlSet({
          targetId: 'target-url-scan',
          inertDraft: {
            kind: 'webhook',
            approvedAddressSet: ['8.8.8.8'],
            signing: 'standard-webhooks',
            ordering: 'strict',
            retryLimit: 20,
            representation: 'plain',
          },
          newVersion: 1,
          hiddenUrl: `https://receiver.invalid/path?secret=${sentinels[6]}`,
        }),
        await control.migrateSecrets({ from: 'file', to: 'keychain', source: file, target: keychain }),
      ]);
      for (const [index, sentinel] of sentinels.entries())
        assert.ok(
          [...file.writes].some((value) => value.includes(sentinel)),
          `synthetic sentinel ${index} reaches only the designated fake backend during its operation`,
        );
      // Only boundaries that exist are scanned: the receipts the operations returned, and everything the process wrote
      // while they ran. Task 2 adds no audit writer to the daemon; the paired surfaces that add one scan it there.
      const receiptSinks = {
        output: receipts.map((receipt) => JSON.stringify(receipt)),
        log,
      };
      assert.deepEqual(
        await scanEventSecretPersistence({ paths: opened.paths, prohibited: sentinels, receiptSinks }),
        [],
        'every production receipt and process write is content-free and every SQLite byte range is sentinel-free',
      );
      for (const sink of ['output', 'log'] as const) {
        assert.deepEqual(
          await scanEventSecretPersistence({
            paths: opened.paths,
            prohibited: sentinels,
            receiptSinks: { ...receiptSinks, [sink]: [...receiptSinks[sink], `leaked ${sentinels[0]}`] },
          }),
          [sink],
          `a sentinel in the ${sink} sink alone is found`,
        );
      }
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
