import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError } from '@agentcomms/core';
import { EventExpiry } from '../src/runtime/expiry.ts';
import { type ResendEventReader, ResendReceivedSource, ResendReceivedStageExpiry } from '../src/sources/resend.ts';
import { SourceScopeLock } from '../src/sources/scope-lock.ts';
import { openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

const ACCOUNT = 'resend-account';
const ANCHOR = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const NEWEST = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const encode = async (value: unknown) => Buffer.from(JSON.stringify(value));
const decode = async (stored: Uint8Array) => JSON.parse(Buffer.from(stored).toString('utf8')) as unknown;

test('a canonical empty baseline stages later received mail before it moves to the first real anchor', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-empty-baseline-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let present = false;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: present ? [{ id: NEWEST }] : [], next: null };
        },
        async getReceived(id) {
          return {
            kind: 'candidate',
            candidate: { emailId: id, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' },
          };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const admitted: string[] = [];
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async (candidate) => {
          admitted.push(candidate.emailId);
          return 'terminal';
        },
      });
      assert.equal(await source.baseline(), 'empty');
      present = true;
      assert.deepEqual(await source.scan(), { pending: false, anchorId: NEWEST });
      assert.deepEqual(admitted, [NEWEST]);
      assert.equal(
        store.database.prepare("SELECT 1 FROM operational_records WHERE kind = 'agentcomms.source.gap'").get(),
        undefined,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Resend received keeps its anchor until every detail is terminal and resumes the staged page without relisting', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-received-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let listCalls = 0;
      let ready = false;
      const reader: ResendEventReader = {
        async listReceived() {
          listCalls += 1;
          return {
            emails: listCalls === 1 ? [{ id: ANCHOR }] : [{ id: NEWEST }, { id: ANCHOR }],
            next: null,
          };
        },
        async getReceived(id) {
          return id === NEWEST
            ? { kind: 'candidate', candidate: { emailId: id, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' } }
            : { kind: 'vanished' };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const admitted: string[] = [];
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async (candidate) => {
          admitted.push(candidate.emailId);
          return ready ? 'terminal' : 'pending';
        },
        now: () => 1_760_000_000_000,
      });

      assert.equal(await source.baseline(), ANCHOR);
      assert.deepEqual(await source.scan(), { pending: true, anchorId: ANCHOR });
      assert.equal(listCalls, 2);
      assert.equal(source.anchorId(), ANCHOR);
      ready = true;
      assert.deepEqual(await source.scan(), { pending: false, anchorId: NEWEST });
      assert.equal(listCalls, 2, 'the durable page resumes without a fresh list response');
      assert.equal(source.anchorId(), NEWEST);
      assert.deepEqual(admitted, [NEWEST, NEWEST]);
      assert.equal(
        (
          store.database
            .prepare(
              "SELECT stage_expires_at FROM source_scan_state WHERE source = 'resend' AND cursor_scope = 'received'",
            )
            .get() as {
            stage_expires_at: number | null;
          }
        ).stage_expires_at,
        null,
        'the durable cursor keeps only content-free scan state after completion',
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Resend received records one bounded anchor-loss gap and rebaselines after ten pages', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-anchor-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let page = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          page += 1;
          return {
            emails: [{ id: `${page.toString().padStart(8, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa` }],
            next: `after-${page}`,
          };
        },
        async getReceived(id) {
          return {
            kind: 'candidate',
            candidate: { emailId: id, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' },
          };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 1_000 }],
        admit: async () => 'terminal',
        now: () => 1_760_000_000_000,
      });
      await source.seedAnchor(ANCHOR);
      await source.scan();
      assert.equal(source.anchorId(), '00000001-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as {
            count: number;
          }
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

test('Resend received keeps its first shortest stage deadline through detail materialisation and expires content-free', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-deadline-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [{ id: NEWEST }, { id: ANCHOR }], next: null };
        },
        async getReceived() {
          now += 10;
          return {
            kind: 'candidate',
            candidate: { emailId: NEWEST, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' },
          };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [
          { ruleId: 'short', ruleVersion: 1, ingestRetentionMs: 100 },
          { ruleId: 'long', ruleVersion: 1, ingestRetentionMs: 1_000 },
        ],
        admit: async () => 'pending',
        now: () => now,
      });
      await source.seedAnchor(ANCHOR);
      assert.deepEqual(await source.scan(), { pending: true, anchorId: ANCHOR });
      const stage = store.database
        .prepare("SELECT staged_at, stage_expires_at FROM source_scan_state WHERE source = 'resend'")
        .get() as {
        staged_at: number;
        stage_expires_at: number;
      };
      assert.equal(stage.staged_at, 1_760_000_000_000);
      assert.equal(stage.stage_expires_at, 1_760_000_000_100);
      now = stage.stage_expires_at;
      assert.equal(await source.expireDue(), 1);
      assert.equal(
        (
          store.database
            .prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'resend' AND occurrence_key = ?")
            .get(NEWEST) as {
            outcome: string;
          }
        ).outcome,
        'retention-expired',
      );
      assert.equal(
        (
          store.database.prepare("SELECT stage_expires_at FROM source_scan_state WHERE source = 'resend'").get() as {
            stage_expires_at: number | null;
          }
        ).stage_expires_at,
        null,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('P1: common expiry keeps a paused Resend received continuation and resolves the received email id', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-common-expiry-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let details = 0;
      let admissions = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [{ id: NEWEST }, { id: ANCHOR }], next: null };
        },
        async getReceived(id) {
          details += 1;
          return {
            kind: 'candidate',
            candidate: { emailId: id, subject: 'safe', receivedAt: '2026-10-09T08:00:00.000Z' },
          };
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 100 }],
        admit: async () => {
          admissions += 1;
          return 'pending';
        },
        now: () => now,
      });
      await source.seedAnchor(ANCHOR);
      assert.deepEqual(await source.scan(), { pending: true, anchorId: ANCHOR });
      now += 100;
      store.database.prepare('UPDATE event_settings SET paused = 1 WHERE singleton = 1').run();
      assert.equal(
        (
          await new EventExpiry(
            store,
            () => now,
            new ResendReceivedStageExpiry({
              store,
              decrypt: decode,
              encrypt: encode,
              lock: new SourceScopeLock(),
              now: () => now,
            }),
          ).sweepAll()
        ).sourceStages,
        1,
      );
      assert.deepEqual(
        (
          store.database
            .prepare(
              "SELECT occurrence_key, outcome FROM source_occurrence_resolutions WHERE source = 'resend' AND account_id = ?",
            )
            .all(ACCOUNT) as Array<{ occurrence_key: string; outcome: string }>
        ).map((row) => ({ ...row })),
        [{ occurrence_key: NEWEST, outcome: 'retention-expired' }],
        'expiry resolves the received occurrence, never the encrypted stage id',
      );
      store.database.prepare('UPDATE event_settings SET paused = 0 WHERE singleton = 1').run();
      assert.deepEqual(await source.scan(), { pending: false, anchorId: NEWEST });
      assert.equal(details, 1, 'resume continues from the retained anchor without another detail read');
      assert.equal(admissions, 1, 'the terminal retained occurrence is never admitted again');
    } finally {
      store.close();
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
});

test('Resend received resolves a failed detail once at its 24-hour retry boundary and records one content-free gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-retry-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let details = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [{ id: NEWEST }, { id: ANCHOR }], next: null };
        },
        async getReceived() {
          details += 1;
          throw new CommsError('TRANSIENT', 'fixture detail failed');
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 2 * 24 * 60 * 60 * 1_000 }],
        admit: async () => 'terminal',
        now: () => now,
      });
      await source.seedAnchor(ANCHOR);
      assert.deepEqual(await source.scan(), { pending: true, anchorId: ANCHOR });
      now += 24 * 60 * 60 * 1_000;
      assert.deepEqual(await source.scan(), { pending: false, anchorId: NEWEST });
      assert.equal(details, 1, 'the retry horizon terminalises before another provider call');
      assert.equal(
        (
          store.database
            .prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'resend' AND occurrence_key = ?")
            .get(NEWEST) as {
            outcome: string;
          }
        ).outcome,
        'unresolvable',
      );
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as {
            count: number;
          }
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

test('a received-detail retry tied with its stage deadline expires content-free without another provider call or gap', {
  skip: WINDOWS_SKIP,
}, async () => {
  const stateDir = await shortTempDir('events-resend-retry-tie-');
  try {
    const store = await openEventDatabase({ stateDir });
    try {
      let now = 1_760_000_000_000;
      let details = 0;
      const reader: ResendEventReader = {
        async listReceived() {
          return { emails: [{ id: NEWEST }, { id: ANCHOR }], next: null };
        },
        async getReceived() {
          details += 1;
          throw new CommsError('TRANSIENT', 'fixture detail failed');
        },
        async listSent() {
          return { emails: [], next: null };
        },
      };
      const source = new ResendReceivedSource({
        store,
        accountId: ACCOUNT,
        reader,
        encrypt: encode,
        decrypt: decode,
        debts: () => [{ ruleId: 'rule', ruleVersion: 1, ingestRetentionMs: 24 * 60 * 60 * 1_000 }],
        admit: async () => 'terminal',
        now: () => now,
      });
      await source.seedAnchor(ANCHOR);
      await source.scan();
      now += 24 * 60 * 60 * 1_000;
      await source.scan();
      assert.equal(details, 1);
      assert.equal(
        (
          store.database
            .prepare("SELECT outcome FROM source_occurrence_resolutions WHERE source = 'resend' AND occurrence_key = ?")
            .get(NEWEST) as { outcome: string }
        ).outcome,
        'retention-expired',
      );
      assert.equal(
        (
          store.database
            .prepare("SELECT COUNT(*) AS count FROM operational_records WHERE kind = 'agentcomms.source.gap'")
            .get() as { count: number }
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
