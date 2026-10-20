import assert from 'node:assert/strict';
import { type ChildProcess, fork } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { storeInternals } from '../src/approval-internals.ts';
import {
  MAINTENANCE_BUDGET_MS,
  MAINTENANCE_INTERVAL_MS,
  MAINTENANCE_SLOTS,
  type MaintenanceStatus,
  PRUNE_STATE_FILE,
  parsePruneState,
  RETENTION_MS,
} from '../src/approval-maintenance.ts';
import { asV2, decodeStored } from '../src/approval-stored.ts';
import { type ApprovalRecord, type ApprovalState, ApprovalStore } from '../src/approvals.ts';
import { type Core, openCore } from '../src/core.ts';
import { CORE_CALLER } from '../src/handoffs.ts';
import { createCoreMcpServer } from '../src/mcp/server.ts';
import { waitForApproval } from '../src/operations/approval-wait.ts';
import { V1_CREATED_AT, v1SendRecord } from './fixtures/approval-v1-0.13.0.ts';
import {
  artifactOf,
  errno,
  type Instrumented,
  instrumentedIo,
  isMaintenanceLock,
  isRecordFile,
  isRecordLock,
} from './helpers/approval-io.ts';
import { type LiveConfig, liveConfig } from './helpers/live-config.ts';
import { tempDir } from './helpers/temp.ts';
import { ACCOUNT, CHANGE_BINDING, downloadBinding, edited, OWNER, T0, v2Record } from './helpers/v2-records.ts';

/*
 * Bounded daily retention (CUE-404 Task 20; design 2026-10-05 §D9, "Rate-limited retention before enumeration"):
 * `ensurePruned()` runs at most one batch a day per state directory, never waits on a lock, stops at 200 slots and five
 * seconds, and deletes only valid finished records ninety days past their finish — a durable audit row first, then the
 * claim marker, then the record — keeping every active record and every piece of evidence it cannot judge.
 *
 * Every step goes through an instrumented file system (`helpers/approval-io.ts`), so the tests count, order, delay,
 * fail and crash each one; other processes are real children holding real locks.
 */

const DAY = 86_400_000;
const NOW = T0 + 200 * DAY;
/** File times: far in the past, one second apart, so the order of slots is the order of these numbers. */
const MTIME_BASE = Date.parse('2026-01-01T00:00:00.000Z');
const idOf = (n: number) => `ap_${String(n).padStart(26, '0')}`;
const iso = (ms: number) => new Date(ms).toISOString();

interface World {
  readonly dir: string;
  readonly approvals: string;
  readonly clock: { t: number };
  readonly fs: Instrumented;
  readonly store: ApprovalStore;
  /**
   * Another store over the same directory — another process's, or this one reopened — with its own instrumented I/O,
   * on this world's clock unless given its own.
   */
  open(options?: { loadConfig?: LiveConfig['loadConfig']; clock?: { t: number } }): {
    fs: Instrumented;
    store: ApprovalStore;
  };
}

function world(at: number = NOW, options: { loadConfig?: LiveConfig['loadConfig']; dir?: string } = {}): World {
  const dir = options.dir ?? tempDir();
  const approvals = join(dir, 'approvals');
  mkdirSync(approvals, { recursive: true });
  const clock = { t: at };
  const open = (opened: { loadConfig?: LiveConfig['loadConfig']; clock?: { t: number } } = {}) => {
    const own = opened.clock ?? clock;
    const fs = instrumentedIo({ stateDir: dir, now: () => own.t });
    const loadConfig = opened.loadConfig ?? options.loadConfig;
    const store = new ApprovalStore(dir, {
      now: () => new Date(own.t),
      io: fs.io,
      audit: fs.audit,
      ...(loadConfig === undefined ? {} : { loadConfig }),
    });
    return { fs, store };
  };
  const first = open();
  return { dir, approvals, clock, fs: first.fs, store: first.store, open };
}

/** Writes `record` (or raw text) as `<id>.json`, its modification time `mtimeMs`. */
function put(w: World, approvalId: string, record: object | string, mtimeMs: number = MTIME_BASE): string {
  const path = join(w.approvals, `${approvalId}.json`);
  writeFileSync(path, typeof record === 'string' ? record : `${JSON.stringify(record, null, 2)}\n`);
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
  return approvalId;
}

function putClaim(w: World, approvalId: string, mtimeMs: number = MTIME_BASE): void {
  const path = join(w.approvals, `${approvalId}.claim`);
  writeFileSync(path, JSON.stringify({ pid: 1, at: iso(T0) }));
  utimesSync(path, new Date(mtimeMs), new Date(mtimeMs));
}

const has = (w: World, approvalId: string, suffix = '.json') => existsSync(join(w.approvals, `${approvalId}${suffix}`));
const bytes = (w: World, approvalId: string) => readFileSync(join(w.approvals, `${approvalId}.json`), 'utf8');
const statePath = (w: World) => join(w.approvals, PRUNE_STATE_FILE);
const stateText = (w: World) => (existsSync(statePath(w)) ? readFileSync(statePath(w), 'utf8') : null);
const stateOf = (w: World) => parsePruneState(stateText(w));
function writeState(w: World, state: unknown): void {
  writeFileSync(statePath(w), typeof state === 'string' ? state : `${JSON.stringify(state, null, 2)}\n`);
}
/** Makes the day's batch due again: as if the last one began more than a day ago. */
const makeDue = (w: World) => rmSync(statePath(w), { force: true });

/** The approval ids whose record a run opened, in order. */
const opened = (fs: Instrumented) => fs.started('read', isRecordFile).map((op) => artifactOf(op.path)?.approvalId);

/** A finished send record at T0, by state: its terminal time (`v2Record`'s timeline). */
const FINISHED: ReadonlyArray<readonly [ApprovalState, number]> = [
  ['used', T0 + 90_000],
  ['failed', T0 + 90_000],
  ['unknown', T0 + 180_000],
  ['revoked', T0 + 30_000],
  ['expired', T0 + 600_000],
];

/** The operations on one approval's artifacts, as `kind:artifact`, in the order they started. */
function stepsOf(fs: Instrumented, approvalId: string): string[] {
  return fs.log
    .filter((op) => op.phase === 'start')
    .flatMap((op) => {
      if (op.kind === 'append') return op.path.endsWith(`:${approvalId}`) ? ['append'] : [];
      const found = artifactOf(op.path);
      return found?.approvalId === approvalId ? [`${op.kind}:${found.artifact}`] : [];
    });
}

// ── What is kept, and what is deleted ─────────────────────────────────────────────────────────────────────────────

test('each finished state is kept until ninety days past its finish, and deleted at equality after a locked re-read (D9r-o)', async () => {
  for (const [state, finished] of FINISHED) {
    for (const offset of [-1, 0]) {
      const w = world(finished + RETENTION_MS + offset);
      const id = put(w, idOf(1), v2Record({ kind: 'send', state, approvalId: idOf(1) }));
      const status = await w.store.ensurePruned();
      assert.equal(status.attempted, true, state);
      assert.deepEqual(status.errors, [], state);
      if (offset < 0) {
        assert.equal(has(w, id), true, `${state} one millisecond before its boundary is kept`);
        assert.equal(status.pruned, 0);
        assert.equal(w.fs.rows.length, 0);
        continue;
      }
      assert.equal(has(w, id), false, `${state} at its boundary is deleted`);
      assert.equal(status.pruned, 1);
      assert.deepEqual(stepsOf(w.fs, id), [
        'stat:json',
        'lock.create:lock',
        'read:json',
        'append',
        'unlink:claim',
        'unlink:json',
        'lock.read:lock',
        'lock.remove:lock',
      ]);
      const row = w.fs.rows[0];
      assert.equal(row?.operation, 'approval.retained');
      assert.equal(row?.approvalId, id);
      assert.equal(row?.inboxId, OWNER);
      assert.deepEqual(row?.retained, {
        kind: 'send',
        state,
        finishedAt: iso(finished),
        ...(state === 'used' ? { providerId: 'sent-1' } : {}),
      });
      // Nothing a sender wrote, and no address.
      assert.doesNotMatch(JSON.stringify(row), /sam@partner\.test|Re: plan/);
    }
  }
});

test('pending, approved and fresh sending records are never deleted; a stale send becomes unknown, and a lapsed one expired, before they are judged (D9r-o)', async () => {
  const w = world(NOW);
  // Active, and their files the oldest there are.
  const pending = put(
    w,
    idOf(1),
    v2Record({ kind: 'send', state: 'pending', start: NOW - 60_000, approvalId: idOf(1) }),
  );
  const approved = put(
    w,
    idOf(2),
    v2Record({
      kind: 'send',
      state: 'approved',
      via: 'terminal',
      route: 'confirm',
      start: NOW - 120_000,
      approvalId: idOf(2),
    }),
  );
  const sending = put(
    w,
    idOf(3),
    v2Record({ kind: 'send', state: 'sending', start: NOW - 90_000, approvalId: idOf(3) }),
  );
  const change = put(
    w,
    idOf(4),
    v2Record({ kind: 'change', state: 'pending', start: NOW - 60_000, approvalId: idOf(4) }),
  );
  const question = put(
    w,
    idOf(5),
    v2Record({ kind: 'download', state: 'pending', start: NOW - 60_000, approvalId: idOf(5) }),
  );
  const before = [pending, approved, sending, change, question].map((id) => bytes(w, id));
  // A send whose claimant stopped an hour ago: `unknown` now, but not ninety days past it.
  const stale = put(
    w,
    idOf(6),
    v2Record({ kind: 'send', state: 'sending', start: NOW - 3_600_000, approvalId: idOf(6) }),
  );
  // One that stopped two hundred days ago, and a question that lapsed then: finished long since, once derived.
  const ancient = put(w, idOf(7), v2Record({ kind: 'send', state: 'sending', approvalId: idOf(7) }));
  const lapsed = put(w, idOf(8), v2Record({ kind: 'send', state: 'pending', approvalId: idOf(8) }));

  const status = await w.store.ensurePruned();
  assert.deepEqual(status.errors, []);
  assert.deepEqual(
    [pending, approved, sending, change, question].map((id) => bytes(w, id)),
    before,
    'active records are left exactly as they were',
  );
  assert.equal(asV2(decodeStored(stale, bytes(w, stale), null, new Date(NOW)))?.state, 'unknown');
  assert.equal(has(w, ancient), false);
  assert.equal(has(w, lapsed), false);
  // Written as what it became before anything was judged, and recorded as that.
  for (const [id, became] of [
    [ancient, 'unknown'],
    [lapsed, 'expired'],
  ] as const) {
    const steps = stepsOf(w.fs, id);
    assert.ok(steps.indexOf('write:json') > steps.indexOf('read:json'), id);
    assert.ok(steps.indexOf('write:json') < steps.indexOf('append'), id);
    assert.equal(w.fs.rows.find((row) => row.approvalId === id)?.retained?.state, became);
  }
  assert.equal(status.pruned, 2);
});

test('maintenance never moves an unknown record: left exactly as it is until its boundary, and recorded as unknown (D1sl-g)', async () => {
  const w = world(NOW);
  const recent = put(
    w,
    idOf(1),
    v2Record({ kind: 'send', state: 'unknown', start: NOW - 3_600_000, approvalId: idOf(1) }),
  );
  const heartbeat = put(
    w,
    idOf(2),
    v2Record({ kind: 'send', state: 'unknown', heartbeat: true, start: NOW - 3_600_000, approvalId: idOf(2) }),
  );
  const old = put(w, idOf(3), v2Record({ kind: 'send', state: 'unknown', approvalId: idOf(3) }));
  const before = [recent, heartbeat].map((id) => bytes(w, id));
  await w.store.ensurePruned();
  assert.deepEqual(
    [recent, heartbeat].map((id) => bytes(w, id)),
    before,
  );
  assert.equal(w.fs.started('write', isRecordFile).length, 0, 'no unknown record is rewritten');
  assert.equal(has(w, old), false);
  assert.equal(w.fs.rows[0]?.retained?.state, 'unknown');
});

test('corrupt records — attributable or not — and unreadable files are kept, however old (D9r-p)', async () => {
  const w = world(NOW + 10_000 * DAY);
  const used = v2Record({ kind: 'send', state: 'used', approvalId: idOf(1) });
  const files: Record<string, string | object> = {
    // Corrupt for another reason than its binding: its owner is known, what it finished as is not.
    [idOf(1)]: edited(used, { sentMessageId: undefined }),
    // Its binding does not verify: whose it is cannot be trusted.
    [idOf(2)]: edited(v2Record({ kind: 'send', state: 'used', approvalId: idOf(2) }), {
      inboxId: 'ibx_BBBBBBBBBBBBBBBB',
    }),
    [idOf(3)]: `{ "approvalId": "${idOf(3)}", "inboxId": "${OWNER}", "state": "us`,
    [idOf(4)]: 'not json at all',
    [idOf(5)]: JSON.stringify({ approvalId: idOf(5) }),
    // In another record's file.
    [idOf(6)]: v2Record({ kind: 'send', state: 'used', approvalId: idOf(60) }),
  };
  for (const [id, content] of Object.entries(files)) put(w, id, content);
  putClaim(w, idOf(1));
  const before = Object.keys(files).map((id) => bytes(w, id));
  const status = await w.store.ensurePruned();
  assert.equal(status.processed, 6);
  assert.equal(status.pruned, 0);
  assert.deepEqual(
    Object.keys(files).map((id) => bytes(w, id)),
    before,
  );
  assert.equal(has(w, idOf(1), '.claim'), true, 'a marker beside a kept record stays');
  assert.equal(w.fs.started('unlink').length, 0);
  assert.equal(w.fs.rows.length, 0);
});

// ── `usedAt`, through the store's own transitions ─────────────────────────────────────────────────────────────────

async function transitions(w: World): Promise<{ send: string; change: string; download: string; sentAt: string }> {
  const config = liveConfig(w.dir, {
    sendPolicy: 'chat',
    changePolicy: 'chat',
    inboxes: { 'acme/gmail': { id: OWNER } },
    accounts: { 'acme/slack': { id: ACCOUNT } },
  });
  const { store } = w.open({ loadConfig: config.loadConfig });
  const expect = { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' };
  const send = await store.create({
    channel: 'gmail',
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftId: 'r-draft-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect,
  });
  w.clock.t += 1_000;
  const claimed = await store.claimForSend(send.approvalId, {
    inboxId: OWNER,
    inboxSub: 'sub-1',
    draftMessageId: 'msg-v1',
    contentDigest: 'a'.repeat(64),
    expect,
  });
  w.clock.t += 1_000;
  const used = await store.complete(send.approvalId, claimed.claimToken, { sentMessageId: 'm-1' });
  assert.equal(used.usedAt, used.sentAt, 'a used send’s usedAt is its sentAt');
  const change = await store.createChange({ channel: 'core', change: CHANGE_BINDING, policy: 'chat' });
  w.clock.t += 1_000;
  await store.claimForChange(change.approvalId, { change: CHANGE_BINDING, policy: 'chat' });
  const binding = downloadBinding();
  const question = await store.createDownload({ channel: 'gmail', download: binding, policy: 'chat' });
  w.clock.t += 1_000;
  // Answered in the chat: claimed straight from pending, with no evidence kept.
  await store.claimForDownload(question.approvalId, {
    target: binding.target,
    operation: binding.operation,
    request: binding.request,
    files: binding.files,
    names: binding.names,
  });
  return {
    send: send.approvalId,
    change: change.approvalId,
    download: question.approvalId,
    sentAt: used.sentAt as string,
  };
}

test('a used send (usedAt = sentAt), change and download are kept until usedAt + 90 days and deleted at equality; a direct-chat download stays valid throughout (D9r-q, R15b)', async () => {
  const w = world(NOW);
  const ids = await transitions(w);
  const usedAt = (id: string) => Date.parse(asV2(decodeStored(id, bytes(w, id), null, new Date(NOW)))?.usedAt ?? '');
  const finishes = { send: usedAt(ids.send), change: usedAt(ids.change), download: usedAt(ids.download) };
  assert.equal(finishes.send, Date.parse(ids.sentAt));
  // A direct-chat answer carries no evidence, and is a valid record, not a corrupt one.
  const question = decodeStored(ids.download, bytes(w, ids.download), null, new Date(NOW));
  assert.equal(question.form, 'v2');
  assert.equal(asV2(question)?.approvedVia, undefined);

  for (const kind of ['send', 'change', 'download'] as const) {
    const id = ids[kind];
    w.clock.t = finishes[kind] + RETENTION_MS - 1;
    makeDue(w);
    await w.store.ensurePruned();
    assert.equal(has(w, id), true, `${kind}: kept just before its boundary`);
    assert.equal(decodeStored(id, bytes(w, id), null, new Date(w.clock.t)).form, 'v2', `${kind}: still valid`);
    w.clock.t = finishes[kind] + RETENTION_MS;
    makeDue(w);
    await w.store.ensurePruned();
    assert.equal(has(w, id), false, `${kind}: deleted at its boundary`);
    assert.equal(has(w, id, '.claim'), false, `${kind}: its claim marker with it`);
  }
  assert.deepEqual(
    w.fs.rows.map((row) => [row.retained?.kind, row.retained?.state, row.retained?.finishedAt]),
    [
      ['send', 'used', iso(finishes.send)],
      ['change', 'used', iso(finishes.change)],
      ['download', 'used', iso(finishes.download)],
    ],
  );
  assert.equal(w.fs.rows[0]?.retained?.providerId, 'm-1');
});

test('a legacy used record without usedAt is kept until updatedAt + 90 days when that is safe, for retention only; an unsafe one is kept (D9r-r)', async () => {
  const updated = Date.parse(V1_CREATED_AT) + 5 * 60_000;
  const legacy = (approvalId: string, extra: Record<string, unknown> = {}) => ({
    ...v1SendRecord({
      approvalId,
      inboxId: OWNER,
      draftId: 'r-1',
      draftMessageId: 'm-1',
      digest: 'd'.repeat(64),
      expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' },
      state: 'used',
      updatedAt: iso(updated),
      sentMessageId: 'old-1',
    }),
    ...extra,
  });
  for (const offset of [-1, 0]) {
    const w = world(updated + RETENTION_MS + offset);
    const safe = put(w, idOf(1), legacy(idOf(1), { approvedAt: iso(updated - 60_000), sentAt: iso(updated) }));
    const unsafe = {
      [idOf(2)]: legacy(idOf(2), { updatedAt: iso(Date.parse(V1_CREATED_AT) - 1) }),
      [idOf(3)]: legacy(idOf(3), { sentAt: iso(updated + 1) }),
      [idOf(4)]: legacy(idOf(4), { sendingAt: 'not a time' }),
      [idOf(5)]: legacy(idOf(5), { updatedAt: 'later' }),
    };
    for (const [id, record] of Object.entries(unsafe)) put(w, id, record);
    // Another legacy state holds no terminal time at all.
    const expired = put(w, idOf(6), legacy(idOf(6), { state: 'pending', updatedAt: V1_CREATED_AT }));
    const before = bytes(w, safe);
    await w.store.ensurePruned();
    if (offset < 0) {
      assert.equal(bytes(w, safe), before, 'kept, and never rewritten');
      // The fallback is for retention only: the record still reads as an earlier release’s, with no usedAt.
      const read = await w.store.get(safe);
      assert.equal(read?.form, 'legacy');
      assert.equal((read as unknown as { view: Record<string, unknown> }).view.usedAt, undefined);
    } else {
      assert.equal(has(w, safe), false);
      assert.deepEqual(w.fs.rows[0]?.retained, {
        kind: 'send',
        state: 'used',
        finishedAt: iso(updated),
        providerId: 'old-1',
        legacy: true,
      });
    }
    for (const id of [...Object.keys(unsafe), expired]) assert.equal(has(w, id), true, `${id} has no safe finish`);
  }
});

// ── The deletion's order, and every way it can be cut short ─────────────────────────────────────────────────────

test('the order is the durable append, then the claim marker the claim path made, then the record — and no unlink starts before the append is done (D9r-s)', async () => {
  const w = world(NOW);
  const ids = await transitions(w);
  assert.equal(has(w, ids.send, '.claim'), true, 'today’s claim path made its marker');
  w.clock.t = Date.parse(ids.sentAt) + RETENTION_MS;
  makeDue(w);
  await w.store.ensurePruned();
  const ops = w.fs.log.filter((op) => {
    if (op.kind === 'append') return true;
    const found = artifactOf(op.path);
    return op.kind === 'unlink' && found?.approvalId === ids.send;
  });
  assert.deepEqual(
    ops.map((op) => `${op.kind}:${op.phase}:${op.kind === 'append' ? op.path : artifactOf(op.path)?.artifact}`),
    [
      `append:start:audit:durable:${ids.send}`,
      `append:end:audit:durable:${ids.send}`,
      'unlink:start:claim',
      'unlink:end:claim',
      'unlink:start:json',
      'unlink:end:json',
    ],
  );
  assert.equal(has(w, ids.send, '.claim'), false);
  assert.equal(has(w, ids.send), false);
});

/** A world holding one used send past its boundary, with its claim marker, and short lock timings to restart after a crash. */
function prunable(): { w: World; id: string } {
  const w = world(NOW);
  storeInternals(w.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
  const id = put(w, idOf(1), v2Record({ kind: 'send', state: 'used', approvalId: idOf(1) }));
  putClaim(w, id);
  return { w, id };
}

/** Restarts after a crash: past the lock's stale interval, a day later, a store of its own. */
async function restart(w: World): Promise<{ fs: Instrumented; status: MaintenanceStatus }> {
  await sleep(150);
  w.clock.t += MAINTENANCE_INTERVAL_MS;
  const next = w.open();
  storeInternals(next.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
  return { fs: next.fs, status: await next.store.ensurePruned() };
}

/** Whether, in `fs`'s run, any unlink of a record's artifacts started before an append that completed. */
function unlinkBeforeAppend(fs: Instrumented): boolean {
  const appended = fs.log.findIndex((op) => op.kind === 'append' && op.phase === 'end');
  const unlinked = fs.log.findIndex((op) => op.kind === 'unlink' && op.phase === 'start');
  return unlinked !== -1 && (appended === -1 || unlinked < appended);
}

test('a crash before or after each of the three steps: no unlink precedes the durable append, and the restart finishes the job (D9r-t)', async () => {
  const points: ReadonlyArray<{ name: string; at: (op: { kind: string; path: string }) => boolean; after: boolean }> = [
    { name: 'before the append', at: (op) => op.kind === 'append', after: false },
    { name: 'after the append', at: (op) => op.kind === 'append', after: true },
    { name: 'after the claim unlink', at: (op) => op.kind === 'unlink' && op.path.endsWith('.claim'), after: true },
    { name: 'after the record unlink', at: (op) => op.kind === 'unlink' && op.path.endsWith('.json'), after: true },
  ];
  for (const point of points) {
    const { w, id } = prunable();
    w.fs.crashAt(point.at, { after: point.after });
    await w.store.ensurePruned();
    assert.equal(w.fs.dead, true, point.name);
    assert.equal(unlinkBeforeAppend(w.fs), false, point.name);
    const afterCrash = { json: has(w, id), claim: has(w, id, '.claim'), rows: w.fs.rows.length };
    assert.deepEqual(
      afterCrash,
      {
        'before the append': { json: true, claim: true, rows: 0 },
        'after the append': { json: true, claim: true, rows: 1 },
        'after the claim unlink': { json: true, claim: false, rows: 1 },
        'after the record unlink': { json: false, claim: false, rows: 1 },
      }[point.name],
      point.name,
    );
    const again = await restart(w);
    assert.equal(again.status.attempted, true, point.name);
    assert.deepEqual(again.status.errors, [], point.name);
    assert.equal(unlinkBeforeAppend(again.fs), false, point.name);
    assert.equal(has(w, id), false, `${point.name}: the record is gone after the restart`);
    assert.equal(has(w, id, '.claim'), false, `${point.name}: and its marker`);
    // A surviving record is retried, which may record it twice: a duplicate row, never a lost one.
    const rows = afterCrash.rows + again.fs.rows.length;
    assert.equal(rows, afterCrash.json ? afterCrash.rows + 1 : 1, point.name);
  }
});

test('an append that fails leaves both artifacts; a claim unlink that fails leaves the record; a record unlink that fails leaves it for later; a stray marker is removed in its slot (D9r-u)', async () => {
  const cases: ReadonlyArray<{
    name: string;
    fail: (op: { kind: string; path: string }) => boolean;
    left: { json: boolean; claim: boolean };
    step: string;
  }> = [
    { name: 'append', fail: (op) => op.kind === 'append', left: { json: true, claim: true }, step: 'append' },
    {
      name: 'claim unlink',
      fail: (op) => op.kind === 'unlink' && op.path.endsWith('.claim'),
      left: { json: true, claim: true },
      step: 'claim-unlink',
    },
    {
      name: 'record unlink',
      fail: (op) => op.kind === 'unlink' && op.path.endsWith('.json'),
      left: { json: true, claim: false },
      step: 'record-unlink',
    },
  ];
  for (const each of cases) {
    const { w, id } = prunable();
    w.fs.before = (op) => {
      if (each.fail(op)) throw errno(each.name === 'append' ? 'EIO' : 'EPERM');
    };
    const status = await w.store.ensurePruned();
    assert.deepEqual(
      status.errors.map((error) => [error.step, error.approvalId]),
      [[each.step, id]],
      each.name,
    );
    assert.equal(status.pruned, 0, each.name);
    assert.deepEqual({ json: has(w, id), claim: has(w, id, '.claim') }, each.left, each.name);
    // The next day's batch finishes it.
    w.clock.t += MAINTENANCE_INTERVAL_MS;
    w.fs.before = undefined;
    assert.equal((await w.store.ensurePruned()).pruned, 1, each.name);
    assert.equal(has(w, id), false, each.name);
  }

  // A marker with no record beside it: removed when its slot comes round, and counted as one.
  const w = world(NOW);
  putClaim(w, idOf(7));
  const kept = put(w, idOf(8), v2Record({ kind: 'send', state: 'used', start: NOW - DAY, approvalId: idOf(8) }));
  putClaim(w, kept);
  const status = await w.store.ensurePruned();
  assert.equal(has(w, idOf(7), '.claim'), false);
  assert.equal(has(w, kept, '.claim'), true, 'a marker beside a record is the record’s, judged with it');
  assert.equal(status.processed, 2);
  assert.deepEqual(stepsOf(w.fs, idOf(7)), [
    'stat:claim',
    'lock.create:lock',
    'read:json',
    'unlink:claim',
    'lock.read:lock',
    'lock.remove:lock',
  ]);
});

// ── When a batch runs ────────────────────────────────────────────────────────────────────────────────────────────

const ME = 'ibx_MMMMMMMMMMMMMMMM';

function coreWorld(): { core: Core; clock: { t: number }; env: Record<string, string>; config: LiveConfig } {
  const home = tempDir('comms-retention-');
  const config = liveConfig(home, { sendPolicy: 'chat', changePolicy: 'chat', inboxes: { 'me/gmail': { id: ME } } });
  const clock = { t: NOW };
  const env = {
    HOME: home,
    USERPROFILE: home,
    AGENT_COMMS_CONFIG_DIR: config.dir,
    AGENT_COMMS_CLIENT_CLI_DIRS: '',
    AGENT_COMMS_UPDATE_CHECK: 'off',
  };
  const core = openCore({ env, now: () => new Date(clock.t), caller: CORE_CALLER });
  return { core, clock, env, config };
}

function sendFor(core: Core, draftId = 'r-1'): Promise<ApprovalRecord> {
  return core.approvals.create({
    channel: 'gmail',
    inboxId: ME,
    inboxSub: 'sub-1',
    draftId,
    draftMessageId: 'msg-1',
    contentDigest: 'a'.repeat(64),
    sendEpoch: 0,
    policy: 'chat',
    requiredPolicy: 'chat',
    riskFlags: [],
    expect: { to: ['sam@partner.test'], cc: [], bcc: [], subject: 'Re: plan' },
  });
}

test('one long-lived MCP context and its one store cross several daily boundaries: creation, list and status each run the day’s batch (D9r-a)', async () => {
  const { core, clock, env } = coreWorld();
  const { server } = await createCoreMcpServer({ core, env, keyring: null, platform: 'darwin' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '0' });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const state = () =>
    parsePruneState(
      existsSync(join(core.approvals.directory, PRUNE_STATE_FILE))
        ? readFileSync(join(core.approvals.directory, PRUNE_STATE_FILE), 'utf8')
        : null,
    );
  try {
    mkdirSync(core.approvals.directory, { recursive: true });
    const first = await sendFor(core);
    assert.equal(state().lastAttemptAt, NOW, 'the first creation ran the batch');
    const days: Array<[string, () => Promise<unknown>]> = [
      ['a creation', () => sendFor(core, 'r-2')],
      ['a list', () => client.callTool({ name: 'comms_approvals_list', arguments: {} })],
      [
        'a status',
        () =>
          client.callTool({ name: 'comms_approval_wait', arguments: { approvalId: first.approvalId, waitSeconds: 0 } }),
      ],
      ['a change', () => core.approvals.createChange({ channel: 'core', change: CHANGE_BINDING, policy: 'chat' })],
      [
        'a question',
        () =>
          core.approvals.createDownload({
            channel: 'gmail',
            download: downloadBinding({ target: { kind: 'inbox', name: 'me/gmail', id: ME } }),
            policy: 'chat',
          }),
      ],
      ['a wait', () => waitForApproval(core, first.approvalId, { waitSeconds: 0 })],
    ];
    for (const [what, call] of days) {
      // Later the same day: nothing more.
      clock.t += 60 * 60_000;
      await call();
      assert.notEqual(state().lastAttemptAt, clock.t, `${what} the same day starts no second batch`);
      // A day on, the same object: the batch runs again.
      clock.t += MAINTENANCE_INTERVAL_MS;
      await call();
      assert.equal(state().lastAttemptAt, clock.t, `${what} a day later runs it`);
    }
  } finally {
    await Promise.all([client.close(), server.close()]);
  }
});

const CHILD = fileURLToPath(new URL('./fixtures/maintenance-child.ts', import.meta.url));

async function child(): Promise<{
  ask: (message: Record<string, unknown>) => Promise<Record<string, unknown>>;
  close: () => void;
}> {
  const proc: ChildProcess = fork(CHILD, [], {
    execArgv: ['--experimental-strip-types', '--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const waiting = new Map<string, (message: Record<string, unknown>) => void>();
  let ready!: () => void;
  const started = new Promise<void>((settle) => {
    ready = settle;
  });
  proc.on('message', (message: Record<string, unknown>) => {
    if (message.op === 'ready') return ready();
    const settle = waiting.get(String(message.id));
    waiting.delete(String(message.id));
    settle?.(message);
  });
  await started;
  let next = 0;
  return {
    ask: (message) => {
      next += 1;
      const id = String(next);
      return new Promise((settle) => {
        waiting.set(id, settle);
        proc.send({ ...message, id });
      });
    },
    close: () => proc.kill(),
  };
}

test('one batch a day per state directory, with callers at once in this process and another, and after reopening (D9r-b, D9r-w)', async () => {
  const other = await child();
  try {
    for (let round = 0; round < 6; round += 1) {
      const w = world(NOW);
      for (let n = 1; n <= 20; n += 1)
        put(w, idOf(n), v2Record({ kind: 'send', state: 'used', approvalId: idOf(n) }), MTIME_BASE + n * 1000);
      const stores = [w.store, w.open().store, w.open().store];
      const [theirs, ...ours] = await Promise.all([
        other.ask({ op: 'prune', stateDir: w.dir, now: NOW }),
        ...stores.flatMap((store) => [store.ensurePruned(), store.ensurePruned()]),
      ]);
      const statuses = [theirs?.status as MaintenanceStatus, ...(ours as MaintenanceStatus[])];
      assert.equal(statuses.filter((status) => status.attempted).length, 1, `round ${round}: exactly one batch`);
      for (const status of statuses.filter((each) => !each.attempted)) {
        assert.ok(status.skipped === 'busy' || status.skipped === 'not-due', `round ${round}: ${status.skipped}`);
      }
      // Whoever ran it, it ran once: every record pruned once, one row each.
      for (let n = 1; n <= 20; n += 1) assert.equal(has(w, idOf(n)), false);
      // Later that day, reopened and used again: no second batch.
      w.clock.t += MAINTENANCE_INTERVAL_MS - 1;
      const reopened = w.open();
      for (let call = 0; call < 3; call += 1) {
        assert.equal((await reopened.store.ensurePruned()).skipped, 'not-due');
      }
      assert.equal(reopened.fs.started('readdir').length, 0, 'nothing enumerated');
      assert.equal(stateOf(w).lastAttemptAt, NOW);
    }
  } finally {
    other.close();
  }
});

test('a missing, truncated or schema-invalid state is never attempted, and is replaced with a valid one even when the batch then fails (D9r-c)', async () => {
  const shapes: ReadonlyArray<string | null> = [
    null,
    '',
    `{"version":1,"lastAttemptAt":"${iso(NOW - 1000)}","cursor":nu`,
    '[]',
    'null',
    '{}',
    JSON.stringify({ version: 2, lastAttemptAt: iso(NOW - 1000), cursor: null }),
    JSON.stringify({ version: 1, lastAttemptAt: 'yesterday', cursor: null }),
    JSON.stringify({ version: 1, lastAttemptAt: NOW - 1000, cursor: null }),
    JSON.stringify({ version: 1, lastAttemptAt: '2026-10-05T09:00:00Z', cursor: null }),
    JSON.stringify({ version: 1, cursor: null }),
  ];
  for (const shape of shapes) {
    const w = world(NOW);
    put(w, idOf(1), v2Record({ kind: 'send', state: 'used', approvalId: idOf(1) }));
    if (shape !== null) writeState(w, shape);
    // The batch fails at once, after the attempt was committed.
    w.fs.before = (op) => {
      if (op.kind === 'readdir') throw errno('EIO');
    };
    const status = await w.store.ensurePruned();
    assert.equal(status.attempted, true, String(shape));
    assert.deepEqual(status.errors, [{ step: 'enumerate', code: 'EIO' }], String(shape));
    assert.deepEqual(
      JSON.parse(stateText(w) ?? 'null'),
      { version: 1, lastAttemptAt: iso(NOW), cursor: null },
      String(shape),
    );
    // And the next call that day starts nothing.
    assert.equal((await w.store.ensurePruned()).skipped, 'not-due', String(shape));
  }
});

/** Three records kept by the batch, oldest first by file time, and a day-old valid timestamp. */
function threeKept(): { w: World; ids: string[] } {
  const w = world(NOW);
  const ids = [1, 2, 3].map((n) =>
    put(
      w,
      idOf(n),
      v2Record({ kind: 'send', state: 'used', start: NOW - DAY, approvalId: idOf(n) }),
      MTIME_BASE + n * 1000,
    ),
  );
  return { w, ids };
}

test('a valid timestamp with a malformed cursor keeps the timestamp and restarts from the oldest record (D9r-d)', async () => {
  const cursors: unknown[] = [
    'ap_00000000000000000000000002',
    [],
    {},
    { mtimeMs: -1, approvalId: idOf(2) },
    { mtimeMs: Number.POSITIVE_INFINITY, approvalId: idOf(2) },
    { mtimeMs: '2000', approvalId: idOf(2) },
    { mtimeMs: MTIME_BASE + 2000 },
    { mtimeMs: MTIME_BASE + 2000, approvalId: 'ap_lowercase-is-no-id' },
    { mtimeMs: MTIME_BASE + 2000, approvalId: 42 },
  ];
  for (const cursor of cursors) {
    const { w, ids } = threeKept();
    // Not due: the timestamp is kept and the cursor is not looked at.
    writeState(w, { version: 1, lastAttemptAt: iso(NOW - 60_000), cursor });
    const recent = stateText(w);
    assert.equal((await w.store.ensurePruned()).skipped, 'not-due');
    assert.equal(stateText(w), recent);
    // Due: the timestamp is valid, the cursor is not — so the batch starts from the oldest record.
    writeState(w, { version: 1, lastAttemptAt: iso(NOW - DAY), cursor });
    const status = await w.store.ensurePruned();
    assert.equal(status.attempted, true, JSON.stringify(cursor));
    assert.deepEqual(opened(w.fs), ids, JSON.stringify(cursor));
  }
  // Against the same records, a valid cursor resumes strictly after the slot it names.
  const { w, ids } = threeKept();
  writeState(w, {
    version: 1,
    lastAttemptAt: iso(NOW - DAY),
    cursor: { mtimeMs: MTIME_BASE + 2000, approvalId: ids[1] },
  });
  await w.store.ensurePruned();
  assert.deepEqual(opened(w.fs), [ids[2]]);
});

test('a recorded attempt within five minutes in the future is skew and kept; one further ahead, or a clock gone backwards, is now, normalised durably (D9r-e)', async () => {
  // Inside the allowance: kept as it is, and not due.
  const near = world(NOW);
  writeState(near, { version: 1, lastAttemptAt: iso(NOW + 5 * 60_000), cursor: null });
  const kept = stateText(near);
  assert.equal((await near.store.ensurePruned()).skipped, 'not-due');
  assert.equal(stateText(near), kept);
  near.clock.t = NOW + 5 * 60_000 + MAINTENANCE_INTERVAL_MS;
  assert.equal((await near.store.ensurePruned()).attempted, true, 'due one interval after the recorded time');

  // Beyond it: taken as now and written as now; due one ordinary interval later, never at the untrusted time.
  const far = world(NOW);
  writeState(far, { version: 1, lastAttemptAt: iso(NOW + 5 * 60_000 + 1), cursor: null });
  assert.equal((await far.store.ensurePruned()).skipped, 'not-due');
  assert.equal(stateOf(far).lastAttemptAt, NOW);
  assert.equal(far.fs.started('write').length, 1);
  far.clock.t = NOW + MAINTENANCE_INTERVAL_MS;
  assert.equal((await far.store.ensurePruned()).attempted, true);

  // A clock that went back an hour after a batch: normalised to its now, and due a day after that.
  const back = world(NOW);
  assert.equal((await back.store.ensurePruned()).attempted, true);
  back.clock.t = NOW - 60 * 60_000;
  assert.equal((await back.store.ensurePruned()).skipped, 'not-due');
  assert.equal(stateOf(back).lastAttemptAt, NOW - 60 * 60_000);
  back.clock.t = NOW - 60 * 60_000 + MAINTENANCE_INTERVAL_MS;
  assert.equal((await back.store.ensurePruned()).attempted, true);
});

// ── How much one batch does ──────────────────────────────────────────────────────────────────────────────────────

/** `n` records the batch keeps (used a day ago), file times ascending with their number. */
function kept(w: World, n: number, first = 1): string[] {
  const ids: string[] = [];
  for (let i = first; i < first + n; i += 1) {
    ids.push(
      put(
        w,
        idOf(i),
        v2Record({ kind: 'send', state: 'used', start: NOW - DAY, approvalId: idOf(i) }),
        MTIME_BASE + i * 1000,
      ),
    );
  }
  return ids;
}

test('more than 200 slots: a batch stops at exactly 200, later batches resume after the cursor, and a full pass clears it (D9r-f)', async () => {
  const w = world(NOW);
  const ids = kept(w, 250);
  const first = await w.store.ensurePruned();
  assert.equal(first.processed, MAINTENANCE_SLOTS);
  assert.equal(first.complete, false);
  assert.deepEqual(opened(w.fs), ids.slice(0, 200));
  assert.deepEqual(stateOf(w).cursor, { mtimeMs: MTIME_BASE + 200 * 1000, approvalId: ids[199] });

  w.clock.t += MAINTENANCE_INTERVAL_MS;
  const resumed = w.open();
  const second = await resumed.store.ensurePruned();
  assert.equal(second.processed, 50);
  assert.equal(second.complete, true);
  assert.deepEqual(opened(resumed.fs), ids.slice(200));
  assert.equal(stateOf(w).cursor, null, 'a pass that reaches the end clears the cursor');

  w.clock.t += MAINTENANCE_INTERVAL_MS;
  const again = w.open();
  await again.store.ensurePruned();
  assert.deepEqual(opened(again.fs), ids.slice(0, 200), 'the next cycle starts from the oldest again');
});

test('with the clock advancing during the work, no step starts after five seconds and the cursor holds only what was finished (D9r-g)', async () => {
  const w = world(NOW);
  // Every third record is due for deletion; the rest are kept.
  const ids = Array.from({ length: 120 }, (_, i) =>
    put(
      w,
      idOf(i + 1),
      v2Record({ kind: 'send', state: 'used', start: i % 3 === 0 ? T0 : NOW - DAY, approvalId: idOf(i + 1) }),
      MTIME_BASE + (i + 1) * 1000,
    ),
  );
  const prunable = (index: number) => index % 3 === 0;
  const started = w.clock.t;
  w.fs.before = () => {
    w.clock.t += 25;
  };
  const status = await w.store.ensurePruned();
  assert.equal(status.complete, false);
  // Each step — a stat, a record lock's try, a record's read, a deletion's first step — starts before the deadline.
  // (A deletion begun in time runs its three steps to the end: stopping between them is safe, but only wastes them.)
  const steps = w.fs.log.filter(
    (op) =>
      op.phase === 'start' &&
      (op.kind === 'stat' ||
        op.kind === 'append' ||
        (op.kind === 'read' && isRecordFile(op.path)) ||
        (op.kind === 'lock.create' && isRecordLock(op.path))),
  );
  assert.ok(steps.length > 0);
  for (const op of steps) assert.ok(op.at < started + 5_000, `${op.kind} ${op.path} started at +${op.at - started} ms`);
  // The cursor: the last slot whose work ran to its end, and nothing after it done.
  const done = status.processed;
  assert.ok(done > 0 && done < ids.length);
  assert.deepEqual(stateOf(w).cursor, { mtimeMs: MTIME_BASE + done * 1000, approvalId: ids[done - 1] });
  ids.forEach((id, index) => {
    const finished = index < done;
    if (prunable(index)) assert.equal(has(w, id), !finished, `${id}`);
    else
      assert.equal(
        w.fs.log.some((op) => op.kind === 'read' && op.phase === 'end' && op.path.endsWith(`${id}.json`)),
        finished,
        `${id}`,
      );
  });
});

test('200 record locks held by another process: each tried once without waiting; creation and status go on within five seconds; the earliest busy record is next (D9r-h)', async () => {
  /*
   * Counted, and timed on the stores' own clocks: the wall clock measured only this machine's speed, and a Windows
   * runner took four seconds for the 200 tries this allowed two. "Without waiting" is what the design says it is (§D9: a
   * non-blocking try, no polling sleep, never the ordinary five-second lock timeout): each busy lock is created once and
   * never taken over. A lock that waited would try again, and the waiting lock, `withFileLock`, does not go through the
   * counted operations at all. "Within five seconds" is the batch's work-start budget: for the creation and the status,
   * the core's clock moves on 10 ms with every file operation, a machine too slow for 200 tries in five seconds, and no
   * step of either batch starts after five seconds on it.
   */
  const { core, clock, config } = coreWorld();
  mkdirSync(core.approvals.directory, { recursive: true });
  const w = world(NOW, { dir: join(core.paths.stateDir) });
  // The core's own store, through counted file operations, on the core's clock.
  const fs = instrumentedIo({ stateDir: core.paths.stateDir, now: () => clock.t });
  core.approvals = new ApprovalStore(core.paths.stateDir, {
    now: () => new Date(clock.t),
    loadConfig: config.loadConfig,
    io: fs.io,
    audit: fs.audit,
    handoffs: core.handoffs,
  });
  const ids = kept(w, MAINTENANCE_SLOTS);
  const lockOf = (id: string) => join(w.approvals, `${id}.json.lock`);
  const locks = new Set(ids.map(lockOf));
  const busy = new Set(ids);
  /** The core's batch since `from`: each busy lock tried once at most, and no step started after its five seconds. */
  const withinBudget = (from: number, what: string) => {
    const ops = fs.log.slice(from).filter((op) => op.phase === 'start');
    // Its deadline is set as it begins, just before this first look at the prune state.
    const begun = ops.find((op) => op.kind === 'read' && op.path.endsWith(PRUNE_STATE_FILE));
    assert.ok(begun, `${what} ran the day's batch`);
    const tries = ops.filter((op) => op.kind === 'lock.create' && locks.has(op.path));
    const steps = [
      ...tries,
      ...ops.filter((op) => op.kind === 'stat' && busy.has(artifactOf(op.path)?.approvalId ?? '')),
    ];
    assert.ok(
      tries.length > 0 && tries.length < MAINTENANCE_SLOTS,
      `${what}: the budget ended it, ${tries.length} tried`,
    );
    assert.equal(new Set(tries.map((op) => op.path)).size, tries.length, `${what}: each busy lock tried once at most`);
    for (const op of steps) {
      assert.ok(op.at < begun.at + MAINTENANCE_BUDGET_MS, `${what}: ${op.kind} started at +${op.at - begun.at} ms`);
    }
    assert.equal(
      ops.filter((op) => op.kind === 'read' && busy.has(artifactOf(op.path)?.approvalId ?? '')).length,
      0,
      `${what}: no busy record is opened`,
    );
  };
  const other = await child();
  try {
    const held = await other.ask({ op: 'hold', paths: ids.map(lockOf) });
    assert.equal(held.held, MAINTENANCE_SLOTS);
    const status = await w.store.ensurePruned();
    assert.equal(status.skippedBusy, MAINTENANCE_SLOTS);
    assert.equal(status.processed, 0);
    for (const id of ids) {
      assert.equal(w.fs.started('lock.create', (path) => path === lockOf(id)).length, 1, `${id} tried once`);
    }
    assert.equal(w.fs.started('lock.rename').length, 0, 'no busy lock is taken over');
    assert.equal(opened(w.fs).length, 0, 'no busy record is opened');
    assert.equal(stateOf(w).cursor, null, 'the cursor stays before the earliest busy slot');

    // A creation and a status that run the batch go on, all locks still held, on a machine too slow for all 200.
    fs.before = () => {
      clock.t += 10;
    };
    makeDue(w);
    clock.t = NOW;
    let from = fs.log.length;
    const made = await sendFor(core);
    withinBudget(from, 'creation');
    makeDue(w);
    from = fs.log.length;
    const looked = await waitForApproval(core, made.approvalId, { waitSeconds: 0 });
    withinBudget(from, 'status');
    assert.equal(looked.state, 'pending');
    assert.ok(
      ids.every((id) => has(w, id)),
      'every busy record remains',
    );
  } finally {
    await other.ask({ op: 'release' });
    other.close();
  }
  // Released, and a day after the last batch began: the earliest busy record is the first one looked at.
  w.clock.t = clock.t + MAINTENANCE_INTERVAL_MS;
  const next = w.open();
  await next.store.ensurePruned();
  assert.equal(opened(next.fs)[0], ids[0]);
});

test('old active, corrupt and unreadable records do not starve the slots after them (D9r-i)', async () => {
  const w = world(NOW);
  for (let n = 1; n <= MAINTENANCE_SLOTS; n += 1) {
    const kind = n % 3;
    const content =
      kind === 0
        ? `{ "approvalId": "${idOf(n)}", "sta`
        : kind === 1
          ? edited(v2Record({ kind: 'send', state: 'used', approvalId: idOf(n) }), { sentMessageId: undefined })
          : v2Record({ kind: 'send', state: 'sending', start: NOW - 90_000, approvalId: idOf(n) });
    put(w, idOf(n), content, MTIME_BASE + n * 1000);
  }
  const later = [1, 2, 3, 4, 5].map((n) =>
    put(
      w,
      idOf(1000 + n),
      v2Record({ kind: 'send', state: 'used', approvalId: idOf(1000 + n) }),
      MTIME_BASE + (1000 + n) * 1000,
    ),
  );
  const first = await w.store.ensurePruned();
  assert.equal(first.processed, MAINTENANCE_SLOTS);
  assert.equal(first.pruned, 0);
  w.clock.t += MAINTENANCE_INTERVAL_MS;
  const second = await w.store.ensurePruned();
  assert.equal(second.pruned, 5);
  for (const id of later) assert.equal(has(w, id), false);
});

// ── Lock ownership ───────────────────────────────────────────────────────────────────────────────────────────────

test('a batch held past the stale interval keeps its lock by renewal: another process never takes it, and only the first batch prunes and commits its cursor (D9r-j)', async (t) => {
  /*
   * On the test's time, not the wall clock's: a lock's age is `Date.now()` against its file's times, and its renewal a
   * timer, so both are mocked and move only when the test says. On the wall clock, a stall of a fifth of a second
   * between a renewal and the other process's look was enough to make a live holder look abandoned.
   */
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const w = world(NOW);
  storeInternals(w.store).timings = { staleMs: 300, renewMs: 80, recordStaleMs: 30_000 };
  const ids = kept(w, 3);
  const old = put(w, idOf(9), v2Record({ kind: 'send', state: 'used', approvalId: idOf(9) }), MTIME_BASE + 9_000);
  writeState(w, { version: 1, lastAttemptAt: iso(NOW - DAY), cursor: { mtimeMs: 0, approvalId: idOf(0) } });
  // The first batch's first record read is an operation already started that takes a long time.
  let release!: () => void;
  const held = new Promise<void>((settle) => {
    release = settle;
  });
  let reached!: () => void;
  const hanging = new Promise<void>((settle) => {
    reached = settle;
  });
  let hung = false;
  w.fs.before = async (op) => {
    if (!hung && op.kind === 'read' && isRecordFile(op.path)) {
      hung = true;
      reached();
      await held;
    }
  };
  const running = w.store.ensurePruned();
  await hanging;
  // 700 ms held, one renewal interval at a time, each renewal's touch landed before the next is due.
  const touches = (phase: 'start' | 'end') =>
    w.fs.log.filter((op) => op.kind === 'lock.touch' && op.phase === phase).length;
  for (let elapsed = 0; elapsed + 80 <= 700; elapsed += 80) {
    t.mock.timers.tick(80);
    while (touches('end') < touches('start')) await new Promise((settle) => setImmediate(settle));
  }
  t.mock.timers.tick(700 % 80);
  // A process for which the next batch is due — a day on — so it does try the lock.
  const second = w.open({ clock: { t: NOW + DAY } });
  storeInternals(second.store).timings = { staleMs: 300, renewMs: 80, recordStaleMs: 30_000 };
  const theirs = await second.store.ensurePruned();
  release();
  const ours = await running;
  assert.equal(theirs.attempted, false);
  assert.equal(theirs.skipped, 'busy', 'the lock was renewed, so it was not abandoned');
  assert.equal(second.fs.started('lock.rename').length, 0, 'no takeover was tried');
  assert.equal(second.fs.started('unlink').length + second.fs.started('write').length, 0);
  assert.equal(w.fs.started('lock.touch', isMaintenanceLock).length, 8, 'renewed every 80 ms while it held on');
  assert.deepEqual(ours.errors, []);
  assert.equal(ours.complete, true);
  assert.equal(ours.pruned, 1);
  assert.equal(has(w, old), false);
  assert.deepEqual(
    ids.map((id) => has(w, id)),
    [true, true, true],
  );
  assert.equal(stateOf(w).cursor, null, 'its cursor, committed by it');
});

test('a token replaced before a per-record check stops the former holder starting another record, and before the final check, writing its cursor (D9r-k)', async () => {
  // Replaced after the second record: the third is never started.
  const w = world(NOW);
  const ids = kept(w, 5);
  writeState(w, { version: 1, lastAttemptAt: iso(NOW - DAY), cursor: { mtimeMs: 0, approvalId: idOf(0) } });
  const lockPath = join(w.approvals, '.maintenance.lock');
  const takeOver = () =>
    writeFileSync(lockPath, JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'fake-other-holder' }));
  w.fs.before = (op) => {
    if (op.kind === 'lock.remove' && op.path === join(w.approvals, `${ids[1]}.json.lock`)) takeOver();
  };
  const status = await w.store.ensurePruned();
  assert.deepEqual(opened(w.fs), ids.slice(0, 2));
  assert.deepEqual(status.errors, [{ step: 'lock-lost', code: 'ELOCKLOST' }]);
  assert.deepEqual(stateOf(w).cursor, { mtimeMs: 0, approvalId: idOf(0) }, 'the cursor is not written');
  assert.equal(existsSync(lockPath), true, 'the new holder’s lock is left alone');

  // Replaced after the last record, before the final check: every record done, and still no cursor written.
  const last = world(NOW);
  const all = kept(last, 3);
  writeState(last, { version: 1, lastAttemptAt: iso(NOW - DAY), cursor: { mtimeMs: 0, approvalId: idOf(0) } });
  last.fs.before = (op) => {
    if (op.kind === 'lock.remove' && op.path === join(last.approvals, `${all[2]}.json.lock`)) {
      writeFileSync(
        join(last.approvals, '.maintenance.lock'),
        JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'fake-other-holder' }),
      );
    }
  };
  const ended = await last.store.ensurePruned();
  assert.deepEqual(opened(last.fs), all);
  assert.deepEqual(ended.errors, [{ step: 'lock-lost', code: 'ELOCKLOST' }]);
  assert.deepEqual(stateOf(last).cursor, { mtimeMs: 0, approvalId: idOf(0) });
});

test('a takeover after the final check can still lose to the stale cursor rename: an earlier cursor costs a rescan, a later one a skip, the end reset recovers, and nothing is ever pruned unlocked (D9r-l)', async () => {
  const w = world(NOW);
  const all = [1, 2, 3, 4, 5].map((n) =>
    put(
      w,
      idOf(n),
      v2Record({ kind: 'send', state: 'used', start: NOW - DAY, approvalId: idOf(n) }),
      MTIME_BASE + n * 1000,
    ),
  );
  const position = (n: number) => ({ mtimeMs: MTIME_BASE + n * 1000, approvalId: idOf(n) });
  // Two more, finished long ago: the first batch deletes them.
  for (const n of [6, 7])
    put(w, idOf(n), v2Record({ kind: 'send', state: 'used', approvalId: idOf(n) }), MTIME_BASE + n * 1000);
  // The stale holder: replaced the moment it starts the cursor's rename, which still lands (the window accepted).
  writeState(w, { version: 1, lastAttemptAt: iso(NOW - DAY), cursor: position(0) });
  let writes = 0;
  const secondWrite = () => {
    writes += 1;
    return writes === 2;
  };
  w.fs.before = (op) => {
    if (op.kind === 'write' && op.path.endsWith(PRUNE_STATE_FILE) && secondWrite()) {
      writeFileSync(
        join(w.approvals, '.maintenance.lock'),
        JSON.stringify({ pid: 1, at: new Date().toISOString(), token: 'fake-other-holder' }),
      );
    }
  };
  assert.equal((await w.store.ensurePruned()).pruned, 2);
  assert.equal(stateOf(w).cursor, null, 'the stale holder’s cursor landed');
  rmSync(join(w.approvals, '.maintenance.lock'), { force: true });

  const runs: Instrumented[] = [w.fs];
  const run = async (cursor: ReturnType<typeof position> | null) => {
    writeState(w, { version: 1, lastAttemptAt: iso(w.clock.t - DAY), cursor });
    const next = w.open();
    runs.push(next.fs);
    await next.store.ensurePruned();
    return opened(next.fs);
  };
  // A newer holder had reached 4; the stale one wrote 1 over it: the next batch merely looks at 2–4 again.
  assert.deepEqual(await run(position(1)), all.slice(1));
  // The stale one wrote 4 over a newer 1: a record due for deletion between 2 and 3 is skipped this time...
  const between = put(w, idOf(30), v2Record({ kind: 'send', state: 'used', approvalId: idOf(30) }), MTIME_BASE + 2_500);
  assert.deepEqual(await run(position(4)), all.slice(4));
  assert.equal(has(w, between), true);
  assert.equal(stateOf(w).cursor, null, '...and the end of the directory clears the cursor...');
  // ...so the next cycle reaches it, and deletes it.
  assert.deepEqual(await run(stateOf(w).cursor), [all[0], all[1], between, all[2], all[3], all[4]]);
  assert.equal(has(w, between), false);

  // Every deletion in every run came after its own lock and its own read in that run, with the lock still held.
  for (const fs of runs) {
    for (const unlink of fs.started('unlink', isRecordFile)) {
      const id = artifactOf(unlink.path)?.approvalId;
      const before = fs.log.filter((op) => op.seq < unlink.seq && artifactOf(op.path)?.approvalId === id);
      const locked = before.findLastIndex((op) => op.kind === 'lock.create' && op.phase === 'end');
      const read = before.findLastIndex((op) => op.kind === 'read' && op.phase === 'end');
      const released = before.findLastIndex((op) => op.kind === 'lock.remove');
      assert.ok(locked !== -1 && read > locked && released < locked, `${id}: pruned under its own lock`);
    }
  }
});

// ── Crashes around the state's two commits ───────────────────────────────────────────────────────────────────────

test('a crash right after the attempt’s commit: no retry for a day, and the old cursor kept (D9r-m)', async () => {
  const w = world(NOW);
  storeInternals(w.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
  kept(w, 3);
  writeState(w, {
    version: 1,
    lastAttemptAt: iso(NOW - DAY),
    cursor: { mtimeMs: MTIME_BASE + 1000, approvalId: idOf(1) },
  });
  w.fs.crashAt((op) => op.kind === 'readdir');
  await w.store.ensurePruned();
  assert.equal(w.fs.dead, true);
  assert.deepEqual(stateOf(w), {
    lastAttemptAt: NOW,
    cursor: { mtimeMs: MTIME_BASE + 1000, approvalId: idOf(1) },
  });
  await sleep(150);
  for (const later of [60 * 60_000, MAINTENANCE_INTERVAL_MS - 1]) {
    w.clock.t = NOW + later;
    const reopened = w.open();
    storeInternals(reopened.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
    assert.equal((await reopened.store.ensurePruned()).skipped, 'not-due');
  }
  w.clock.t = NOW + MAINTENANCE_INTERVAL_MS;
  const due = w.open();
  storeInternals(due.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
  await due.store.ensurePruned();
  assert.deepEqual(opened(due.fs), [idOf(2), idOf(3)], 'resumed from the kept cursor');
});

test('a crash just before the cursor’s commit repeats safe work; just after, resumes after the committed slot; a torn cursor write is never attempted (D9r-n)', async () => {
  for (const after of [false, true]) {
    const w = world(NOW);
    storeInternals(w.store).timings = { staleMs: 100, renewMs: 40, recordStaleMs: 100 };
    const ids = kept(w, MAINTENANCE_SLOTS + 5);
    let writes = 0;
    const secondWrite = () => {
      writes += 1;
      return writes === 2;
    };
    w.fs.crashAt((op) => op.kind === 'write' && op.path.endsWith(PRUNE_STATE_FILE) && secondWrite(), { after });
    await w.store.ensurePruned();
    assert.equal(w.fs.dead, true);
    assert.deepEqual(stateOf(w).cursor, after ? { mtimeMs: MTIME_BASE + 200_000, approvalId: ids[199] } : null);
    const again = await restart(w);
    assert.deepEqual(opened(again.fs), after ? ids.slice(200) : ids.slice(0, 200));
  }
  // A cursor write torn part-way reads as schema-invalid: never attempted, so due at once, from the oldest.
  const w = world(NOW);
  const ids = kept(w, 3);
  writeState(w, `{\n  "version": 1,\n  "lastAttemptAt": "${iso(NOW - 60_000)}",\n  "cursor": {\n    "mtimeMs": 1`);
  const status = await w.store.ensurePruned();
  assert.equal(status.attempted, true);
  assert.deepEqual(opened(w.fs), ids);
});
