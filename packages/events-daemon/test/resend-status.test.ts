import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import type { ResendEventReader, ResendSentItem } from '../src/sources/resend.ts';
import { type ResendStatusChange, ResendStatusSource } from '../src/sources/resend-status.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'resend-account';
const EMAIL = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const encode = async (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')) as unknown;
const debts = () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }];

function sent(lastEvent: string): ResendSentItem {
  return {
    id: EMAIL,
    lastEvent,
    from: { address: 'sender@fixture.test', name: 'Fixture Sender' },
    to: ['recipient@fixture.test'],
    cc: [],
    bcc: [],
    subject: 'safe',
    createdAt: '2026-10-09T08:00:00.000Z',
    scheduledAt: null,
    messageId: '<fixture@fixture.test>',
  };
}

test('Resend status seeds its first observed state, emits only deltas, and prunes seven-day state', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-status-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let current = 'scheduled';
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [], next: null };
        },
        async getReceived() {
          return { kind: 'vanished' };
        },
        async listSent() {
          return {
            emails: [sent(current)],
            next: null,
          };
        },
      };
      const changes: ResendStatusChange[] = [];
      const source = new ResendStatusSource({
        store,
        accountId: ACCOUNT,
        reader,
        admit: async (change) => {
          changes.push(change);
          return 'terminal';
        },
        encrypt: encode,
        decrypt: decode,
        debts,
        now: () => now,
      });
      await source.baseline();
      await source.scan();
      assert.deepEqual(changes, []);
      current = 'delivered';
      now += 1;
      await source.scan();
      assert.deepEqual(changes, [
        {
          emailId: EMAIL,
          previous: 'scheduled',
          current: 'delivered',
          observedAt: new Date(now).toISOString(),
          scanGeneration: 3,
          from: { address: 'sender@fixture.test', name: 'Fixture Sender' },
          to: ['recipient@fixture.test'],
          cc: [],
          bcc: [],
          subject: 'safe',
          createdAt: '2026-10-09T08:00:00.000Z',
          scheduledAt: null,
          messageId: '<fixture@fixture.test>',
        },
      ]);
      now += 7 * 24 * 60 * 60 * 1_000;
      assert.equal(source.pruneExpired(), 1);
      assert.equal(store.database.prepare('SELECT 1 FROM resend_status_state').get(), undefined);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1-D7: a Resend status turn stops at its page budget and resumes its durable continuation', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-status-page-budget-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      const afters: Array<string | undefined> = [];
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [], next: null };
        },
        async getReceived() {
          return { kind: 'vanished' };
        },
        async listSent(after) {
          afters.push(after);
          return after === undefined
            ? { emails: [sent('scheduled')], next: 'second' }
            : { emails: [sent('scheduled')], next: null };
        },
      };
      const source = new ResendStatusSource({
        store,
        accountId: ACCOUNT,
        reader,
        admit: async () => 'terminal',
        encrypt: encode,
        decrypt: decode,
        debts,
      });

      await source.scan({ maxPages: 1 });
      assert.deepEqual(afters, [undefined]);
      assert.ok(
        store.database
          .prepare(
            "SELECT 1 FROM source_scan_state WHERE source = 'resend' AND account_id = ? AND cursor_scope = 'status-continuation'",
          )
          .get(ACCOUNT),
        'the next-page token is durable before this turn yields',
      );

      await source.scan({ maxPages: 1 });
      assert.deepEqual(afters, [undefined, 'second']);
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('a claimed Resend status baseline fences the provider before status polling', { skip: WINDOWS_SKIP }, async () => {
  const stateDir = await shortTempDir('events-resend-status-fence-');
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
           VALUES ('intent', 'resend', 'resend-account', 'status', X'00', 1)`,
        )
        .run();
      let calls = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [], next: null };
        },
        async getReceived() {
          return { kind: 'vanished' };
        },
        async listSent() {
          calls += 1;
          return { emails: [], next: null };
        },
      };
      const source = new ResendStatusSource({
        store,
        accountId: 'resend-account',
        reader,
        admit: async () => 'terminal',
        encrypt: encode,
        decrypt: decode,
        debts,
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

test('a pending Resend status delta has one shortest stage deadline and expires without an event', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-status-deadline-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let current = 'scheduled';
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [], next: null };
        },
        async getReceived() {
          return { kind: 'vanished' };
        },
        async listSent() {
          return {
            emails: [sent(current)],
            next: null,
          };
        },
      };
      const source = new ResendStatusSource({
        store,
        accountId: ACCOUNT,
        reader,
        admit: async () => 'pending',
        encrypt: encode,
        decrypt: decode,
        debts: () => [
          { ruleId: 'short', ruleVersion: 1, ingestRetentionMs: 100 },
          { ruleId: 'long', ruleVersion: 1, ingestRetentionMs: 1_000 },
        ],
        now: () => now,
      });
      await source.scan();
      current = 'delivered';
      await source.scan();
      const stage = store.database
        .prepare("SELECT stage_expires_at FROM source_scan_state WHERE source = 'resend' AND cursor_scope = 'status'")
        .get() as {
        stage_expires_at: number;
      };
      assert.equal(stage.stage_expires_at, now + 100);
      now = stage.stage_expires_at;
      assert.equal(await source.expireDue(), 1);
      assert.equal(
        (
          store.database.prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'resend'").get() as {
            outcome: string;
          }
        ).outcome,
        'retention-expired',
      );
      assert.equal(
        store.database
          .prepare("SELECT 1 FROM source_scan_state WHERE source = 'resend' AND cursor_scope = 'status'")
          .get(),
        undefined,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});
