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

test('P1-B1: one lazy 404 resolves every affected body projection while leaving no source gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-union-'));
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
            throw new CommsError('NOT_FOUND', 'message removed');
          },
        },
        assertDisclosable: async () => undefined,
        encryptState: async (value) => Buffer.from(JSON.stringify(value)),
        decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        now: () => 1_760_000_000_000,
      });
      const shared = {
        occurrenceKey: '101:message:gone',
        messageId: 'gone',
        materializationKey: '230d8358dc8e8890b4c58deeb62912ee2f20357ae92a5cc861b98e68fe31acb5',
        stageExpiresAt: 1_760_000_060_000,
      } as const;
      assert.deepEqual(
        await materialiser.materialiseAll([
          { ...shared, ruleId: 'metadata-plus-body', ruleVersion: 1 },
          { ...shared, ruleId: 'another-body-rule', ruleVersion: 2 },
        ]),
        [{ state: 'vanished' }, { state: 'vanished' }],
      );
      assert.equal(reads, 1);
      assert.equal(
        (
          store.database.prepare('SELECT count(*) AS count FROM source_projection_resolutions').get() as {
            count: number;
          }
        ).count,
        2,
      );
      assert.equal(
        (store.database.prepare('SELECT count(*) AS count FROM operational_records').get() as { count: number }).count,
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

test('ING-B1: an account removed during a lazy read or its retry encryption writes no resolution or retry state (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const failure of ['not-found', 'transient', 'during-retry-encryption'] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-removed-'));
    try {
      const store = await openEventDatabase({ stateDir });
      try {
        let removed = false;
        const materialiser = new GmailMaterialiser({
          store,
          accountId: 'ibx_ABCDEFGHIJKLMNOP',
          source: {
            getMessage: async () => {
              if (failure !== 'during-retry-encryption') removed = true;
              throw failure === 'not-found'
                ? new CommsError('NOT_FOUND', 'not found')
                : new CommsError('TRANSIENT', 'temporarily unavailable');
            },
          },
          assertDisclosable: async () => undefined,
          encryptState: async (value) => {
            removed = true;
            return Buffer.from(JSON.stringify(value));
          },
          decryptState: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
          accountLive: async () => {
            if (removed)
              throw new CommsError('NOT_FOUND', 'the Gmail account bound to this event work is no longer connected', {
                details: { reason: 'ACCOUNT_REMOVED', accountId: 'ibx_ABCDEFGHIJKLMNOP' },
              });
          },
          now: () => 1_760_000_000_000,
        });
        await assert.rejects(
          () =>
            materialiser.materialise({
              occurrenceKey: '101:message:gone',
              messageId: 'gone',
              ruleId: 'rule-1',
              ruleVersion: 1,
              materializationKey: 'body',
              stageExpiresAt: 1_760_000_060_000,
            }),
          (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
          `${failure}: the removal refuses`,
        );
        const count = (table: string) =>
          (store.database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count;
        assert.equal(count('source_projection_resolutions'), 0, `${failure}: no resolution is written`);
        assert.equal(count('source_scan_state'), 0, `${failure}: no retry state is written`);
      } finally {
        store.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});

test('ING-B1: a removed account gets no expiry or retry-exhausted resolution from a lazy read (D9)', {
  skip: WINDOWS_SKIP,
}, async () => {
  const accountId = 'ibx_ABCDEFGHIJKLMNOP';
  const now = 1_760_000_000_000;
  for (const path of ['stage expired', 'retry exhausted'] as const) {
    const stateDir = await mkdtemp(join(tmpdir(), 'events-daemon-gmail-materialise-expired-'));
    try {
      const store = await openEventDatabase({ stateDir });
      try {
        let removed = path === 'stage expired';
        const request = {
          occurrenceKey: '101:message:old',
          messageId: 'old',
          ruleId: 'rule-1',
          ruleVersion: 1,
          materializationKey: 'body',
          // Already past for the expiry path; still open for the retry path, whose own retry window has closed.
          stageExpiresAt: path === 'stage expired' ? now - 1 : now + 60_000,
        } as const;
        if (path === 'retry exhausted') {
          store.database
            .prepare(
              `INSERT INTO source_scan_state
               (id, source, account_id, cursor_scope, staged_at, stage_expires_at, encrypted_record, updated_at)
               VALUES (?, 'gmail', ?, 'materialisation', NULL, NULL, ?, 1)`,
            )
            .run(
              `gmail-materialisation:${accountId}:${request.occurrenceKey}:${request.materializationKey}`,
              accountId,
              Buffer.from(
                JSON.stringify({
                  first_failed_at: now - 86_400_001,
                  next_retry_at: now - 1,
                  attempts: 9,
                  error_code: 'X',
                }),
              ),
            );
        }
        let reads = 0;
        const materialiser = new GmailMaterialiser({
          store,
          accountId,
          source: {
            getMessage: async () => {
              reads += 1;
              throw new Error('no provider read is expected');
            },
          },
          assertDisclosable: async () => undefined,
          encryptState: async (value) => Buffer.from(JSON.stringify(value)),
          // The removal lands while the retry continuation is decrypted.
          decryptState: async (stored) => {
            removed = true;
            return JSON.parse(Buffer.from(stored).toString('utf8'));
          },
          accountLive: async () => {
            if (removed)
              throw new CommsError('NOT_FOUND', 'the Gmail account bound to this event work is no longer connected', {
                details: { reason: 'ACCOUNT_REMOVED', accountId },
              });
          },
          now: () => now,
        });
        await assert.rejects(
          () => materialiser.materialise(request),
          (error: unknown) => error instanceof CommsError && error.details?.reason === 'ACCOUNT_REMOVED',
          `${path}: the removal refuses`,
        );
        assert.equal(
          (
            store.database.prepare('SELECT COUNT(*) AS count FROM source_projection_resolutions').get() as {
              count: number;
            }
          ).count,
          0,
          `${path}: no resolution is written for a removed account`,
        );
        assert.equal(reads, 0);
      } finally {
        store.close();
      }
    } finally {
      await rm(stateDir, { recursive: true, force: true });
    }
  }
});
