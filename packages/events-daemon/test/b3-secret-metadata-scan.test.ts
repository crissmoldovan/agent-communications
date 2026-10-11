import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { SecretStore } from '@agentcomms/core';
import { AuditLog, canonicalJson, sha256Hex } from '@agentcomms/core';
import { type EventsCliDeps, type EventsCliStreams, run } from '../src/cli/program.ts';
import { HumanSecret } from '../src/domain/human-secret.ts';
import { B3SecretControl } from '../src/runtime/b3-secret-control.ts';
import { createOwnerB3ControlService } from '../src/runtime/owner.ts';
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

function tty(): EventsCliStreams {
  return {
    stdin: Object.assign(new PassThrough(), { isTTY: true }),
    stdout: Object.assign(new PassThrough(), { isTTY: true }),
    stderr: Object.assign(new PassThrough(), { isTTY: true }),
  };
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

/** Captures the actual Commander stdout/stderr boundary; no receipt is reconstructed by the test. */
async function runTerminalCommand(
  argv: readonly string[],
  input: EventsCliDeps & { readonly streams: EventsCliStreams },
): Promise<{ readonly code: number; readonly output: string }> {
  const { streams } = input;
  let output = '';
  for (const stream of [streams.stdout, streams.stderr] as const) {
    stream.on('data', (chunk) => {
      output += String(chunk);
    });
  }
  const code = await run(argv, input);
  await new Promise<void>((resolve) => setImmediate(resolve));
  return { code, output };
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

test('B3 secret persistence scan captures every Task 6 CLI output, audit row, and process-log boundary', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-cli-scan-'));
  const sentinels = [
    'b3-cli-sentinel-judge-set-7d10',
    'b3-cli-sentinel-judge-rotate-22b4',
    'b3-cli-sentinel-url-4c91',
  ] as const;
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const target = canonicalJson(targetDocument('target-cli-scan', 1));
      opened.database
        .prepare('INSERT INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('target-cli-scan@1', 'target-cli-scan', 1, target, sha256Hex(target));
      const subscriber = canonicalJson({
        subscriberId: 'subscriber-cli-scan',
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
        .run('subscriber-cli-scan@1', 'subscriber-cli-scan', 1, subscriber, sha256Hex(subscriber));
      const judge = canonicalJson({
        judgeId: 'judge-cli-scan',
        version: 1,
        kind: 'typesafe',
        provider: 'typesafe',
        model: 'jev',
      });
      opened.database
        .prepare('INSERT INTO judge_versions (id, judge_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
        .run('judge-cli-scan@1', 'judge-cli-scan', 1, judge, sha256Hex(judge));
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
      const control = new B3SecretControl({
        database: opened.database,
        paths: opened.paths,
        secrets,
        cipher: new EventRecordCipher(opened.database, secrets, quiescer),
        quiescer,
        secretMaterial: {
          nextSigningSecret: () => 'generated-terminal-value-not-under-scan',
          nextSubscriberToken: () => 'generated-terminal-value-not-under-scan',
        },
      });
      const audit = new AuditLog(stateDir, () => new Date('2026-10-11T00:00:00.000Z'));
      const owner = createOwnerB3ControlService({
        store: opened,
        ports: {
          quiescer,
          secrets: control,
          assertObjectSecretReady: async () => ({ ready: true as const }),
        },
        activations: { issueApprovalViewChallenge: async () => null },
        cipher: { encrypt: async () => Buffer.alloc(0) },
        audit,
      });
      const supplied = [...sentinels];
      const command = (argv: readonly string[]) => {
        const streams = tty();
        return runTerminalCommand(argv, {
          streams,
          env: {},
          b3Registrar: { owner },
          readSecret: async (prompt) => {
            const next = supplied.shift();
            if (next === undefined) throw new Error('only URL/judge commands request synthetic hidden bytes');
            return prompt === 'Webhook URL' ? `https://receiver.invalid/path?secret=${next}` : next;
          },
        });
      };
      const captured = await captureProcessOutput(async () => [
        await command(['target', 'secret', 'create', 'target-cli-scan', '--version', '1']),
        await command(['target', 'secret', 'rotate', 'target-cli-scan', '--version', '1']),
        await command(['subscriber', 'token', 'create', 'subscriber-cli-scan', '--version', '1']),
        await command(['subscriber', 'token', 'rotate', 'subscriber-cli-scan', '--version', '1']),
        await command(['judge', 'key', 'set', 'judge-cli-scan', '--version', '1']),
        await command(['judge', 'key', 'rotate', 'judge-cli-scan', '--version', '1']),
        await command([
          'target',
          'url',
          'set',
          'target-url-cli-scan',
          '--draft',
          '{"kind":"webhook","approvedAddressSet":["8.8.8.8"],"signing":"standard-webhooks","ordering":"strict","retryLimit":20,"representation":"plain"}',
          '--new-version',
          '1',
        ]),
        await command(['secrets', 'migrate', '--to', 'keychain']),
      ]);
      assert.deepEqual(
        captured.value.map(({ code }) => code),
        [0, 0, 0, 0, 0, 0, 0, 0],
        'all eight secret leaves run through Commander and owner',
      );
      assert.deepEqual(supplied, [], 'only the three input-bearing commands consumed hidden test values');
      const auditRows = await audit.tail({ limit: 20 });
      assert.equal(auditRows.length, 8, 'each Task 6 secret command emits one actual content-free audit receipt');
      assert.deepEqual(
        await scanEventSecretPersistence({
          paths: opened.paths,
          prohibited: sentinels,
          receiptSinks: {
            output: captured.value.map(({ output }) => output),
            audit: auditRows.map((row) => JSON.stringify(row)),
            log: captured.log,
          },
        }),
        [],
        'real CLI output, audit rows, logs, SQLite, WAL and SHM never retain hidden URL/key input',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 secret audit records the exact owner identity and a closed success or failure outcome for every operation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-secret-audit-'));
  const at = '2026-10-11T00:00:00.000Z';
  const audit = new AuditLog(stateDir, () => new Date(at));
  const cases = [
    {
      operation: 'targetSecretCreate' as const,
      args: { targetId: 'target-audit', version: 2 },
      ids: { targetId: 'target-audit', version: '2' },
      result: { kind: 'target-secret' as const, targetId: 'target-audit', version: 2, generation: 1 },
    },
    {
      operation: 'targetSecretRotate' as const,
      args: { targetId: 'target-audit', version: 2 },
      ids: { targetId: 'target-audit', version: '2' },
      result: { kind: 'target-secret' as const, targetId: 'target-audit', version: 2, generation: 2 },
    },
    {
      operation: 'targetUrlSet' as const,
      args: {
        targetId: 'target-url-audit',
        inertDraft: { kind: 'webhook' },
        newVersion: 3,
        hidden: 'audit-hidden-url',
      },
      ids: { targetId: 'target-url-audit', version: '3' },
      result: { scheme: 'https', host: 'receiver.invalid', port: 443, sha256: 'a'.repeat(64) },
    },
    {
      operation: 'subscriberTokenCreate' as const,
      args: { subscriberId: 'subscriber-audit', version: 4 },
      ids: { subscriberId: 'subscriber-audit', version: '4' },
      result: { kind: 'subscriber-token' as const, subscriberId: 'subscriber-audit', version: 4, generation: 1 },
    },
    {
      operation: 'subscriberTokenRotate' as const,
      args: { subscriberId: 'subscriber-audit', version: 4 },
      ids: { subscriberId: 'subscriber-audit', version: '4' },
      result: { kind: 'subscriber-token' as const, subscriberId: 'subscriber-audit', version: 4, generation: 2 },
    },
    {
      operation: 'judgeKeySet' as const,
      args: { judgeId: 'judge-audit', version: 5, hidden: 'audit-hidden-key' },
      ids: { judgeId: 'judge-audit', version: '5' },
      result: { kind: 'judge-key' as const, judgeId: 'judge-audit', version: 5, generation: 1 },
    },
    {
      operation: 'judgeKeyRotate' as const,
      args: { judgeId: 'judge-audit', version: 5, hidden: 'audit-hidden-key' },
      ids: { judgeId: 'judge-audit', version: '5' },
      result: { kind: 'judge-key' as const, judgeId: 'judge-audit', version: 5, generation: 2 },
    },
    {
      operation: 'migrateSecrets' as const,
      args: { to: 'keychain' },
      ids: undefined,
      result: { moved: 0, leftovers: [] },
    },
  ] as const;
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const ownerFor = (outcome: 'ok' | 'failed', result: (typeof cases)[number]['result']) =>
        createOwnerB3ControlService({
          store: opened,
          ports: {
            quiescer: new WriterQuiescer(),
            secrets: {
              targetSecretCreate: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              targetSecretRotate: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              targetUrlSet: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              subscriberTokenCreate: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              subscriberTokenRotate: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              judgeKeySet: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              judgeKeyRotate: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
              migrateTo: async () => {
                if (outcome === 'failed') throw new Error('synthetic secret failure');
                return result;
              },
            } as never,
            assertObjectSecretReady: async () => ({ ready: true as const }),
          },
          activations: { issueApprovalViewChallenge: async () => null },
          cipher: { encrypt: async () => Buffer.alloc(0) },
          audit,
        });

      for (const entry of cases) {
        await ownerFor('ok', entry.result).handle({
          operation: entry.operation,
          args: entry.args,
          origin: 'interactive-terminal',
        });
        await assert.rejects(
          () =>
            ownerFor('failed', entry.result).handle({
              operation: entry.operation,
              args: entry.args,
              origin: 'interactive-terminal',
            }),
          /synthetic secret failure/,
          `${entry.operation} propagates its real failure after the content-free audit row is appended`,
        );
      }

      const rows = await audit.tail({ limit: 32 });
      assert.deepEqual(
        rows,
        cases.flatMap((entry) => [
          {
            at,
            inboxId: '',
            operation: `events.${entry.operation}`,
            outcome: 'ok',
            ...(entry.ids === undefined ? {} : { ids: entry.ids }),
          },
          {
            at,
            inboxId: '',
            operation: `events.${entry.operation}`,
            outcome: 'failed',
            ...(entry.ids === undefined ? {} : { ids: entry.ids }),
          },
        ]),
        'each row has only the operation, exact safe owner identity where applicable, closed outcome, and audit time',
      );
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 secret audit records a valid subject id but omits an invalid version from a malformed terminal request', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-secret-audit-malformed-'));
  const at = '2026-10-11T00:00:00.000Z';
  const audit = new AuditLog(stateDir, () => new Date(at));
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const owner = createOwnerB3ControlService({
        store: opened,
        ports: {
          quiescer: new WriterQuiescer(),
          secrets: {
            targetSecretCreate: async () => {
              throw new Error('the malformed request must fail before a secret operation');
            },
          } as never,
          assertObjectSecretReady: async () => ({ ready: true as const }),
        },
        activations: { issueApprovalViewChallenge: async () => null },
        cipher: { encrypt: async () => Buffer.alloc(0) },
        audit,
      });
      await assert.rejects(
        () =>
          owner.handle({
            operation: 'targetSecretCreate',
            args: { targetId: 'target-audit', version: 'not-a-version', hidden: 'untrusted-hidden-value' },
            origin: 'interactive-terminal',
          }),
        /target version/i,
      );
      assert.deepEqual(await audit.tail({ limit: 2 }), [
        {
          at,
          inboxId: '',
          operation: 'events.targetSecretCreate',
          outcome: 'failed',
          ids: { targetId: 'target-audit' },
        },
      ]);
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('B3 secret audit records refused app, window, and secrets origins before secret-store activity', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'aev-b3-secret-audit-origin-'));
  const at = '2026-10-11T00:00:00.000Z';
  const audit = new AuditLog(stateDir, () => new Date(at));
  let secretStoreCalls = 0;
  try {
    const opened = await openEventDatabase({ stateDir });
    try {
      const owner = createOwnerB3ControlService({
        store: opened,
        ports: {
          quiescer: new WriterQuiescer(),
          secrets: {
            async targetSecretCreate() {
              secretStoreCalls += 1;
              return { kind: 'target-secret', targetId: 'target-audit', version: 2, generation: 1 };
            },
          } as never,
          assertObjectSecretReady: async () => ({ ready: true as const }),
        },
        activations: { issueApprovalViewChallenge: async () => null },
        cipher: { encrypt: async () => Buffer.alloc(0) },
        audit,
      });
      for (const origin of ['app', 'window', 'secrets'] as const)
        assert.deepEqual(
          await owner.handle({
            operation: 'targetSecretCreate',
            args: { targetId: 'target-audit', version: 2, hidden: 'caller-supplied-hidden-value' },
            origin,
          }),
          { kind: 'unavailable', code: 'APP_SECRET_CAPABILITY_UNAVAILABLE' },
          `${origin} is refused before secret parsing or store activity`,
        );
      assert.equal(secretStoreCalls, 0, 'a refused control origin never reaches the secret store');
      assert.deepEqual(await audit.tail({ limit: 4 }), [
        ...['app', 'window', 'secrets'].map(() => ({
          at,
          inboxId: '',
          operation: 'events.targetSecretCreate',
          outcome: 'refused',
          reason: 'APP_SECRET_CAPABILITY_UNAVAILABLE',
          ids: { targetId: 'target-audit', version: '2' },
        })),
      ]);
    } finally {
      opened.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
