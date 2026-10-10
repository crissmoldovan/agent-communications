import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import { HumanSecret } from '../src/domain/human-secret.ts';
import { B3SecretControl } from '../src/runtime/b3-secret-control.ts';
import { SubscriberStreams } from '../src/runtime/subscriber-streams.ts';
import { WriterQuiescer } from '../src/runtime/writer-quiescer.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { type EventSecretStoreKind, openEventSecretStore, selectEventSecretStore } from '../src/store/event-secrets.ts';
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
    representation: 'enveloped',
  };
}

test('B3 secret slots create and rotate only exact immutable owners with content-free receipts', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-secret-'));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const target = canonicalJson(targetDocument('target-secret', 1));
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-secret@1', 'target-secret', 1, target, sha256Hex(target));
      const subscriber = canonicalJson({
        subscriberId: 'subscriber-secret',
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
        .run('subscriber-secret@1', 'subscriber-secret', 1, subscriber, sha256Hex(subscriber));
      const judge = canonicalJson({
        judgeId: 'judge-secret',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev',
      });
      opened.database
        .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('judge-secret@1', 'judge-secret', 1, judge, sha256Hex(judge));
      await selectEventSecretStore(opened.database, 'file');
      const backend = new MemorySecretStore();
      const secrets = await openEventSecretStore({
        database: opened.database,
        paths: opened.paths,
        configDir: '/synthetic/config',
        stores: { file: backend },
      });
      const quiescer = new WriterQuiescer();
      const streams = new SubscriberStreams();
      let closed = 0;
      assert.equal(
        streams.register({
          subscriberId: 'subscriber-secret',
          subscriberVersion: 1,
          generation: 1,
          currentGeneration: 1,
          close: () => {
            closed += 1;
          },
        }),
        true,
      );
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher: new EventRecordCipher(opened.database, secrets, quiescer),
        quiescer,
        subscriberStreams: streams,
      });

      const signing = await control.targetSecretCreate({ targetId: 'target-secret', version: 1 });
      assert.deepEqual(Object.keys(signing).sort(), ['generation', 'kind', 'targetId', 'version']);
      const signingRotated = await control.targetSecretRotate({ targetId: 'target-secret', version: 1 });
      assert.equal(signingRotated.generation, 2);
      const token = await control.subscriberTokenCreate({ subscriberId: 'subscriber-secret', version: 1 });
      assert.equal(token.kind, 'subscriber-token');
      assert.equal(
        (await control.subscriberTokenRotate({ subscriberId: 'subscriber-secret', version: 1 })).generation,
        2,
      );
      assert.equal(closed, 1, 'subscriber token rotation closes streams admitted under the prior generation');
      assert.equal(
        (
          await control.judgeKeySet({
            judgeId: 'judge-secret',
            version: 1,
            hidden: HumanSecret.fromTrustedInput('synthetic-key'),
          })
        ).kind,
        'judge-key',
      );
      assert.equal(
        (
          await control.judgeKeyRotate({
            judgeId: 'judge-secret',
            version: 1,
            hidden: HumanSecret.fromTrustedInput('synthetic-key-two'),
          })
        ).generation,
        2,
      );
      assert.ok(
        [...backend.values.values()].some((value) => value === 'synthetic-key-two'),
        'only the selected backend holds hidden input',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 secret URL factory creates a new incomplete version and never infers or overwrites latest', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-url-'));
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
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher: new EventRecordCipher(opened.database, secrets, quiescer),
        quiescer,
      });
      const receipt = await control.targetUrlSet({
        targetId: 'target-url',
        inertDraft: {
          kind: 'webhook',
          approvedAddressSet: ['8.8.8.8'],
          signing: 'standard-webhooks',
          ordering: 'strict',
          retryLimit: 20,
          representation: 'plain',
        },
        newVersion: 1,
        hiddenUrl: 'https://receiver.invalid/path?synthetic=one',
      });
      assert.deepEqual(Object.keys(receipt).sort(), ['host', 'port', 'scheme', 'sha256']);
      await assert.rejects(
        () =>
          control.targetUrlSet({
            targetId: 'target-url',
            predecessorVersion: 1,
            newVersion: 1,
            hiddenUrl: 'https://receiver.invalid/path?synthetic=two',
          }),
        /new version|exist|immutable/i,
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
