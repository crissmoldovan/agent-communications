import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { GmailMaterialiser } from '../src/sources/materialise.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

test('ING-B1: a lazy Gmail 404 terminalises vanished without another full-message fetch', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let reads = 0;
      const materialiser = new GmailMaterialiser({
        store,
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        source: {
          getMessage: async () => {
            reads += 1;
            throw new CommsError('NOT_FOUND', 'not found');
          },
        },
        assertDisclosable: async () => undefined,
        encryptState: async (value) => Buffer.from(JSON.stringify(value)),
        decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_000_000,
      });
      const request = {
        occurrenceKey: '101:message:gone',
        messageId: 'gone',
        ruleId: 'rule-1',
        ruleVersion: 1,
        materializationKey: 'body',
        stageExpiresAt: 1_760_000_060_000,
      } as const;

      assert.deepEqual(await materialiser.materialise(request), { state: 'vanished' });
      assert.deepEqual(await materialiser.materialise(request), { state: 'vanished' });
      assert.equal(reads, 1);
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('ING-B1: a failed lazy Gmail read keeps a capped retry and terminalises unresolvable once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-retry-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let reads = 0;
      const materialiser = new GmailMaterialiser({
        store,
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        source: {
          getMessage: async () => {
            reads += 1;
            throw new CommsError('TRANSIENT', 'temporary provider failure');
          },
        },
        assertDisclosable: async () => undefined,
        encryptState: async (value) => Buffer.from(JSON.stringify(value)),
        decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => now,
      });
      const request = {
        occurrenceKey: '101:message:retry',
        messageId: 'retry',
        ruleId: 'rule-1',
        ruleVersion: 1,
        materializationKey: 'body',
        stageExpiresAt: now + 2 * 86_400_000,
      } as const;

      assert.deepEqual(await materialiser.materialise(request), { state: 'pending', retryAt: now + 1_000 });
      assert.deepEqual(await materialiser.materialise(request), { state: 'pending', retryAt: now + 1_000 });
      assert.equal(reads, 1, 'a durable retry state avoids an eager retry');
      now += 86_400_000;
      assert.deepEqual(await materialiser.materialise(request), { state: 'unresolvable' });
      assert.deepEqual(await materialiser.materialise(request), { state: 'unresolvable' });
      assert.equal(reads, 1, 'a terminal resolution forbids later fetches');
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as { count: number }
        ).count,
        1,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('SEC-B1: lazy Gmail materialisation calls the disclosure fence before a full-message read', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-fence-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let reads = 0;
      const materialiser = new GmailMaterialiser({
        store,
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        source: {
          getMessage: async () => {
            reads += 1;
            return {};
          },
        },
        assertDisclosable: async () => {
          throw new CommsError('APPROVAL_VOID', 'the exact lineage is revoked');
        },
        encryptState: async (value) => Buffer.from(JSON.stringify(value)),
        decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
      });

      await assert.rejects(
        materialiser.materialise({
          occurrenceKey: '101:message:fenced',
          messageId: 'fenced',
          ruleId: 'rule-1',
          ruleVersion: 1,
          materializationKey: 'body',
          stageExpiresAt: Date.now() + 60_000,
        }),
        (error: unknown) => error instanceof CommsError && error.code === 'APPROVAL_VOID',
      );
      assert.equal(reads, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('STG-B1: a lazy Gmail read reaches retention-expired at the original stage deadline without a source gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-expiry-'));
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      const materialiser = new GmailMaterialiser({
        store,
        accountId: 'ibx_ABCDEFGHIJKLMNOP',
        source: {
          getMessage: async () => {
            throw new CommsError('TRANSIENT', 'the provider is temporarily unavailable');
          },
        },
        assertDisclosable: async () => undefined,
        encryptState: async (value) => Buffer.from(JSON.stringify(value)),
        decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => now,
      });
      const request = {
        occurrenceKey: '101:message:expires',
        messageId: 'expires',
        ruleId: 'rule-1',
        ruleVersion: 1,
        materializationKey: 'body',
        stageExpiresAt: now + 500,
      } as const;

      assert.deepEqual(await materialiser.materialise(request), { state: 'pending', retryAt: now + 500 });
      now += 500;
      assert.deepEqual(await materialiser.materialise(request), { state: 'retention-expired' });
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as {
            count: number;
          }
        ).count,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
