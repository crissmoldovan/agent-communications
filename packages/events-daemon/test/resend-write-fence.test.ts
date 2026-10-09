import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { type ResendEventReader, ResendReceivedSource } from '../src/sources/resend.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

test('a Resend detail that returns after its write fence moved cannot stage or advance the anchor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-fence-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const anchor = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
      const newest = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
      let stale = false;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [{ id: newest }, { id: anchor }], next: null };
        },
        async getReceived() {
          stale = true;
          return {
            kind: 'candidate',
            candidate: { emailId: newest, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' },
          };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: 'resend-account',
        reader,
        encrypt: async (value) => Buffer.from(JSON.stringify(value)),
        decrypt: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
        assertWriteStillLive: () => {
          if (stale) throw new Error('stale write');
        },
        now: () => 1_760_000_000_000,
      });
      await source.seedAnchor(anchor);
      await assert.rejects(source.scan(), /stale write/);
      assert.equal(source.anchorId(), anchor);
      assert.ok(
        store.database.prepare("SELECT 1 FROM source_scan_state WHERE source = 'resend'").get(),
        'the safe pre-detail list stage remains resumable, but no stale detail can replace it',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a claimed Resend received baseline fences the provider before a scan starts', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-scope-fence-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      store.database
        .prepare(
          `INSERT INTO activation_intents
           (id, kind, document, digest, effect, required_points, acquisition_scopes, status, claimed_at, completion_deadline, created_at, updated_at)
           VALUES ('intent', 'rule', '{}', 'digest', '{}', '[]', '[]', 'pending-completion', 1, 9999999999999, 1, 1)`,
        )
        .run();
      store.database
        .prepare(
          `INSERT INTO activation_baselines (intent_id, source, account_id, position_scope, encrypted_position, response_at)
           VALUES ('intent', 'resend', 'resend-account', 'received', X'00', 1)`,
        )
        .run();
      let calls = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          calls += 1;
          return { emails: [], next: null };
        },
        async getReceived() {
          throw new Error('not reached');
        },
        async listSent() {
          throw new Error('not reached');
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: 'resend-account',
        reader,
        encrypt: async (value) => Buffer.from(JSON.stringify(value)),
        decrypt: async (stored) => JSON.parse(Buffer.from(stored).toString('utf8')),
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
      });
      await assert.rejects(source.scan(), /fenced/);
      assert.equal(calls, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
