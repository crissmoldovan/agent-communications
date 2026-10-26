import assert from 'node:assert/strict';
import { rm } from 'node:fs/promises';
import { test } from 'node:test';
import { CommsError, canonicalJson, sha256Hex } from '@agentcomms/core';
import type { LaneWindowIdentity } from '../src/domain/lanes.ts';
import { LaneService } from '../src/runtime/lanes.ts';
import { QueueStore } from '../src/runtime/queue.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * Routing's lanes, at the owner's store (routing design 2026-10-25, §3 and §6): the bindings table, the person's
 * bind and unbind, who "the bound window" is, the B3 and B4 fences on what a window may see, and the task store and
 * long-poll a wake is made of. Every sender-written value is a marker no window-facing answer may carry.
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T09:00:00.000Z');
const SLACK = 'acc_LANESTORESLACK1';
const SECRET_TEXT = 'lane-store secret: the wire goes out Friday';
const SECRET_NAME = 'Lane Store Sender';

const DAVID: LaneWindowIdentity = {
  sessionId: '25f971a3-0c69-44e3-971c-3a4656afa986',
  activityKey: '0123456789abcdef',
  grouped: true,
  folder: '/example/home/work/david-project',
  client: { name: 'claude-code', version: '2.1.310' },
};
const OTHER: LaneWindowIdentity = {
  sessionId: 'f9423d69-c1d7-45a2-a979-a4343c34477f',
  activityKey: 'fedcba9876543210',
  grouped: true,
  folder: '/example/home/work/other-project',
  client: { name: 'claude-code', version: '2.1.310' },
};
/** No session id, and a key of its own process: a server started in the home folder, say (B6). */
const UNGROUPED: LaneWindowIdentity = {
  sessionId: null,
  activityKey: 'aaaaaaaaaaaaaaaa',
  grouped: false,
  folder: '/example/home',
  client: { name: 'cursor', version: '1.0' },
};
/** No session id, but a grouped key: a Cursor or Codex window in a project folder. */
const GROUPED_ONLY: LaneWindowIdentity = {
  sessionId: null,
  activityKey: 'bbbbbbbbbbbbbbbb',
  grouped: true,
  folder: '/example/home/work/codex-project',
  client: { name: 'codex', version: '0.1' },
};

const laneTarget = (lane: string, targetId = `lane-${lane}`, version = 1) => ({
  targetId,
  version,
  kind: 'queue',
  retentionMs: 30 * DAY,
  show: 'summary',
  lane: { name: lane },
});
const plainTarget = { targetId: 'plain-queue', version: 1, kind: 'queue', retentionMs: 30 * DAY, show: 'summary' };

function rule(ruleId: string, target: Record<string, unknown>, version = 1) {
  return {
    ruleId,
    version,
    source: { channel: 'slack', accountIds: [SLACK], options: { channel: 'slack', conversations: ['C1'] } },
    event: { type: 'slack.message.posted', version: 1 },
    condition: { path: '/text', op: 'exists' },
    mapping: { author: { $path: '/author' }, text: { $path: '/text' } },
    targets: [target],
    subscribers: [],
    judges: [],
    deliveryRateCap: 60,
    retention: { decisionMetadataMs: 90 * DAY, queueMs: 10 * DAY },
  };
}

function storeTarget(store: EventDatabase, target: Record<string, unknown>): void {
  const document = canonicalJson(target);
  store.database
    .prepare('INSERT OR IGNORE INTO target_versions (id, target_id, version, document, digest) VALUES (?, ?, ?, ?, ?)')
    .run(
      `${target.targetId}@${target.version}`,
      String(target.targetId),
      Number(target.version),
      document,
      sha256Hex(document),
    );
}

function activate(store: EventDatabase, document: ReturnType<typeof rule>): void {
  storeTarget(store, document.targets[0] as Record<string, unknown>);
  const canonical = canonicalJson(document);
  store.database
    .prepare(
      `INSERT INTO rule_versions
         (id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, activated_at)
       VALUES (?, ?, ?, ?, ?, 'active', 'approval', 'activation', 1)`,
    )
    .run(`${document.ruleId}@${document.version}`, document.ruleId, document.version, canonical, sha256Hex(canonical));
  store.database
    .prepare(
      `INSERT INTO active_versions (kind, object_id, version, current_cutover_id, activated_at)
       VALUES ('rule', ?, ?, 'activation', 1)
       ON CONFLICT (kind, object_id) DO UPDATE SET version = excluded.version`,
    )
    .run(document.ruleId, document.version);
}

let sequence = 0;

function seed(
  store: EventDatabase,
  input: {
    readonly ruleId: string;
    readonly targetId: string;
    readonly arrivedAt: number;
    readonly state?: 'open' | 'done' | 'dismissed';
  },
): string {
  sequence += 1;
  const tag = String(sequence).padStart(5, '0');
  const id = `qi_${tag.padStart(26, '0')}`;
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'slack.message.posted', 1, ?, ?, ?, ?, ?)`,
    )
    .run(`event-${tag}`, store.installationId, SLACK, tag, input.arrivedAt, input.arrivedAt, input.arrivedAt);
  store.database
    .prepare(
      `INSERT INTO decisions
         (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES (?, ?, ?, ?, 1, 'matched', ?, 'retained')`,
    )
    .run(`decision-${tag}`, `event-${tag}`, SLACK, input.ruleId, NOW + 90 * DAY);
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation)
       VALUES (?, ?, ?, ?, 1, ?, ?, 1, 'queue', NULL, ?, 'delivered', 3)`,
    )
    .run(
      `delivery-${tag}`,
      `decision-${tag}`,
      SLACK,
      input.ruleId,
      `queue:${input.targetId}:1`,
      input.targetId,
      NOW + 7 * DAY,
    );
  const appendedAt = input.arrivedAt + 1_000;
  store.database
    .prepare(
      `INSERT INTO queue_items
         (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id, channel,
          state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at, released, encrypted_record)
       VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, 'slack', ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(
      id,
      `delivery-${tag}`,
      `decision-${tag}`,
      `event-${tag}`,
      input.ruleId,
      input.targetId,
      SLACK,
      input.state ?? 'open',
      appendedAt,
      input.arrivedAt,
      appendedAt,
      10 * DAY,
      appendedAt + 10 * DAY,
      appendedAt + 20 * DAY,
      Buffer.from(JSON.stringify({ from: { name: SECRET_NAME }, text: SECRET_TEXT })),
    );
  return id;
}

async function withLanes(
  work: (input: {
    readonly store: EventDatabase;
    readonly lanes: LaneService;
    readonly queue: QueueStore;
    readonly clock: { value: number };
  }) => Promise<void>,
): Promise<void> {
  const stateDir = await shortTempDir('events-lane-store-');
  const store = await openEventDatabase({ stateDir });
  const clock = { value: NOW };
  const queue = new QueueStore({
    store,
    cipher: { decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes) },
    approvals: { get: async () => null },
    config: {
      load: async () => ({ inboxes: {}, accounts: { 'team/slack': { id: SLACK, platform: 'slack' } } }),
    } as never,
    fence: async () => ({ switchGeneration: 3 }),
    now: () => clock.value,
  });
  const lanes = new LaneService({ store, queue, now: () => clock.value, recheckMs: 20, home: '/example/home' });
  try {
    store.database.exec('UPDATE event_settings SET enabled = 1, switch_generation = 3');
    activate(store, rule('david-on-slack', laneTarget('david')));
    activate(store, rule('billing-on-slack', laneTarget('billing')));
    activate(store, rule('plain-on-slack', plainTarget));
    await work({ store, lanes, queue, clock });
  } finally {
    lanes.close();
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

function refused(code: string, pattern: RegExp) {
  return (error: unknown) => {
    assert.ok(error instanceof CommsError, String(error));
    assert.equal(error.code, code, error.message);
    assert.match(error.message, pattern);
    return true;
  };
}

const ENVELOPE =
  /^<untrusted-content boundary="[^"]+" field="[a-z-]+">\n[\s\S]*\n<\/untrusted-content boundary="[^"]+">$/u;

test('LANE-B: the person binds a reported window by either id; one window per lane, one lane per window (B1)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ lanes, clock }) => {
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    lanes.seen(UNGROUPED);
    lanes.seen(GROUPED_ONLY);
    const bound = lanes.bind('david', DAVID.activityKey);
    assert.deepEqual(bound, {
      lane: 'david',
      binding: {
        window: {
          sessionId: DAVID.sessionId,
          activityKey: DAVID.activityKey,
          folder: DAVID.folder,
          folderShown: '~/work/david-project',
          client: { name: 'claude-code', version: '2.1.310' },
        },
        since: new Date(NOW).toISOString(),
      },
    });
    assert.throws(() => lanes.bind('david', OTHER.sessionId), refused('BAD_DATA', /lane david is already bound/u));
    assert.throws(() => lanes.bind('billing', DAVID.sessionId), refused('BAD_DATA', /already bound to lane david/u));
    assert.throws(() => lanes.bind('nobody', OTHER.sessionId), refused('NOT_FOUND', /no active rule.*lane nobody/u));
    assert.throws(() => lanes.bind('Not A Lane', OTHER.sessionId), refused('USAGE', /lane name/u));
    assert.throws(() => lanes.bind('billing', 'window-1'), refused('USAGE', /session id.*activity session key/u));
    assert.throws(
      () => lanes.bind('billing', '1111111111111111'),
      refused('USAGE', /no agent window with that id/u),
      'a window the event service has never heard from cannot be bound',
    );
    assert.throws(
      () => lanes.bind('billing', UNGROUPED.activityKey),
      refused('USAGE', /cannot be told apart/u),
      'an ungrouped window with no session id is not identifiable (B6)',
    );
    clock.value = NOW + 5_000;
    const grouped = lanes.bind('billing', GROUPED_ONLY.activityKey);
    assert.equal(grouped.binding.window.sessionId, null);
    assert.equal(grouped.binding.window.activityKey, GROUPED_ONLY.activityKey);
    assert.equal(grouped.binding.since, new Date(NOW + 5_000).toISOString());

    const list = lanes.list();
    assert.deepEqual(
      list.lanes.map((lane) => [lane.name, lane.rules, lane.channels, lane.open, lane.binding?.window.activityKey]),
      [
        ['billing', [{ id: 'billing-on-slack' }], ['slack'], 0, GROUPED_ONLY.activityKey],
        ['david', [{ id: 'david-on-slack' }], ['slack'], 0, DAVID.activityKey],
      ],
    );
    assert.deepEqual(lanes.listFor(DAVID), {
      lanes: [
        { name: 'billing', boundToThisWindow: false },
        { name: 'david', boundToThisWindow: true },
      ],
    });
    assert.doesNotMatch(JSON.stringify(lanes.listFor(OTHER)), /bbbbbbbbbbbbbbbb|codex|example/u, 'names no window');
  });
});

test('LANE-B: who the bound window is — the session id when either side has one, else a grouped key (§3.3)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ lanes }) => {
    lanes.seen(DAVID);
    lanes.seen(GROUPED_ONLY);
    lanes.bind('david', DAVID.sessionId as string);
    lanes.bind('billing', GROUPED_ONLY.activityKey);
    assert.equal(lanes.whoami(DAVID).lane, 'david');
    assert.equal(lanes.whoami({ ...DAVID, activityKey: '9999999999999999' }).lane, 'david', 'the session id decides');
    assert.equal(lanes.whoami({ ...DAVID, sessionId: null }).lane, null, 'no session id is not this binding’s window');
    assert.equal(lanes.whoami(GROUPED_ONLY).lane, 'billing');
    assert.equal(lanes.whoami({ ...GROUPED_ONLY, grouped: false }).lane, null, 'only a grouped key identifies');
    assert.equal(
      lanes.whoami({ ...GROUPED_ONLY, sessionId: OTHER.sessionId }).lane,
      null,
      'a window with a session id is not a session-less binding’s',
    );
    const me = lanes.whoami(UNGROUPED);
    assert.equal(me.identifiable, false);
    assert.equal(me.bindWith, null);
    assert.match(me.reason ?? '', /cannot be told apart/u);
    assert.equal(lanes.whoami(DAVID).bindWith, DAVID.sessionId);
    assert.equal(lanes.whoami(GROUPED_ONLY).bindWith, GROUPED_ONLY.activityKey);
  });
});

test('LANE-B: unbinding applies at once; a window may unbind only its own lane, and is told nothing of others', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ lanes }) => {
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    lanes.bind('david', DAVID.sessionId as string);
    assert.throws(() => lanes.unbind('david', OTHER), refused('APPROVAL_REQUIRED', /not bound to this window/u));
    assert.doesNotMatch(
      (() => {
        try {
          lanes.unbind('david', OTHER);
        } catch (error) {
          return JSON.stringify({ message: (error as CommsError).message, hint: (error as CommsError).hint });
        }
        return '';
      })(),
      /25f971a3|0123456789abcdef|david-project/u,
      'the refusal names no window',
    );
    assert.deepEqual(lanes.unbind('david', DAVID), { lane: 'david', unbound: true });
    assert.equal(lanes.whoami(DAVID).lane, null, 'at once');
    assert.deepEqual(lanes.unbind('david'), { lane: 'david', unbound: true }, 'unbinding an unbound lane is no change');
    lanes.bind('david', OTHER.sessionId as string);
    assert.deepEqual(lanes.unbind('david'), { lane: 'david', unbound: true }, 'the person unbinds any lane');
    assert.throws(() => lanes.unbind('nobody'), refused('NOT_FOUND', /lane nobody/u));
  });
});

test('LANE-B: a binding follows its lane across a new approved target version, and ends when no active rule carries it (B5)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ store, lanes }) => {
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    lanes.bind('david', DAVID.sessionId as string);
    activate(store, rule('david-on-slack', laneTarget('david', 'lane-david', 2), 2));
    assert.equal(lanes.whoami(DAVID).lane, 'david', 'a new version of the lane’s target keeps its binding');
    activate(store, rule('david-on-slack', plainTarget, 3));
    assert.equal(lanes.whoami(DAVID).lane, null, 'no active rule carries the lane: the binding ended');
    activate(store, rule('david-on-slack', laneTarget('david', 'lane-david', 4), 4));
    assert.equal(lanes.whoami(DAVID).lane, null, 'a lane carried again does not bring an ended binding back');

    lanes.bind('billing', OTHER.sessionId as string);
    store.database.prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = 'billing-on-slack'").run();
    assert.equal(lanes.whoami(OTHER).lane, null, 'disabling or removing the rule ends it');

    lanes.bind('david', DAVID.sessionId as string);
    store.database.exec('UPDATE event_settings SET enabled = 0, switch_generation = switch_generation + 1');
    assert.equal(lanes.whoami(DAVID).lane, null, 'disable-all revokes every lane’s binding');
  });
});

test('LANE-B: a window not bound to a lane sees none of its items in the queue tools; the bound one sees its own since binding (B3, B4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ store, lanes, queue, clock }) => {
    const before = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW - DAY });
    const plain = seed(store, { ruleId: 'plain-on-slack', targetId: 'plain-queue', arrivedAt: NOW - DAY });
    const billing = seed(store, { ruleId: 'billing-on-slack', targetId: 'lane-billing', arrivedAt: NOW + 1_000 });
    lanes.seen(DAVID);
    lanes.bind('david', DAVID.sessionId as string);
    const after = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 2_000 });
    clock.value = NOW + 10_000;

    const ids = async (window: LaneWindowIdentity | undefined) =>
      (await queue.items({ state: 'all' }, window === undefined ? undefined : lanes.scopeFor(window))).items
        .map((item) => item.id)
        .sort();
    assert.deepEqual(await ids(undefined), [before, plain, billing, after].sort(), 'the person sees everything');
    assert.deepEqual(await ids(OTHER), [plain], 'an unbound window sees no lane’s items');
    assert.deepEqual(await ids(DAVID), [plain, after].sort(), 'the bound window sees its lane since it was bound');
    const lanesOf = Object.fromEntries(
      (await queue.items({ state: 'all' }, lanes.scopeFor(DAVID))).items.map((item) => [item.id, item.lane]),
    );
    assert.deepEqual(lanesOf, { [plain]: null, [after]: 'david' }, 'each item names its lane, or none');

    const counts = (window: LaneWindowIdentity) => queue.counts(lanes.scopeFor(window));
    assert.equal(counts(OTHER).open, 1);
    assert.equal(counts(DAVID).open, 2);
    assert.equal(queue.counts().open, 4);
    for (const hidden of [before, billing, after])
      assert.throws(() => queue.done(hidden, lanes.scopeFor(OTHER)), refused('NOT_FOUND', /no such queue item/u));
    assert.throws(() => queue.done(before, lanes.scopeFor(DAVID)), refused('NOT_FOUND', /no such queue item/u));
    assert.equal(queue.done(after, lanes.scopeFor(DAVID)).item.state, 'done');
    assert.equal(queue.reopen(after, lanes.scopeFor(DAVID)).item.state, 'open');
  });
});

test('LANE-B: only the bound window reads a lane item, only one that arrived after the binding, and an unbound window learns nothing (B2, B3, §3.5)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ store, lanes, clock }) => {
    const before = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW - DAY });
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    lanes.bind('david', DAVID.sessionId as string);
    const after = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 2_000 });
    const plain = seed(store, { ruleId: 'plain-on-slack', targetId: 'plain-queue', arrivedAt: NOW + 2_000 });
    clock.value = NOW + 10_000;

    const read = await lanes.item(after, DAVID);
    assert.equal(read.item.id, after);
    assert.match(String(read.item.text), ENVELOPE, 'sender text arrives in its envelope');
    assert.ok(String(read.item.text).includes(SECRET_TEXT));

    const unbound = async (id: string) => {
      try {
        await lanes.item(id, OTHER);
      } catch (error) {
        assert.ok(error instanceof CommsError);
        return `${error.code}|${error.message}|${error.hint ?? ''}`;
      }
      assert.fail('an unbound window read a lane item');
    };
    const refusals = new Set([
      await unbound(after),
      await unbound(before),
      await unbound(plain),
      await unbound('qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
    ]);
    assert.equal(refusals.size, 1, 'the same refusal whether or not the item exists, or is in a lane');
    assert.doesNotMatch([...refusals][0] as string, /david|qi_/u, 'it names no lane and no item');

    const ownLane = async (id: string) => {
      try {
        await lanes.item(id, DAVID);
      } catch (error) {
        assert.ok(error instanceof CommsError);
        return `${error.code}|${error.message}`;
      }
      assert.fail(`the bound window read ${id}`);
    };
    const own = new Set([await ownLane(before), await ownLane(plain), await ownLane('qi_ZZZZZZZZZZZZZZZZZZZZZZZZZZ')]);
    assert.equal(own.size, 1, 'an item before the binding, outside the lane or missing: one refusal');
    assert.match([...own][0] as string, /^NOT_FOUND\|/u);
  });
});

test('LANE-B: a watch is a task that completes on the next new item with a content-free pointer, once per item (§3.4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ store, lanes, clock }) => {
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    assert.throws(
      () => lanes.watch('david', DAVID),
      refused('APPROVAL_REQUIRED', /lane david is not bound to this window/u),
    );
    lanes.bind('david', DAVID.sessionId as string);
    assert.throws(() => lanes.watch('david', OTHER), refused('APPROVAL_REQUIRED', /not bound to this window/u));
    seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW - DAY });

    const task = lanes.watch('david', DAVID);
    assert.equal(task.status, 'working', 'an item from before the binding wakes nothing (B3)');
    assert.match(task.taskId, /^lt_[0-9a-f]{32}$/u);
    assert.throws(() => lanes.taskGet(task.taskId, OTHER), refused('NOT_FOUND', /no such watch/u));
    clock.value = NOW + 5_000;
    const item = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 4_000 });
    lanes.notifyAppended();
    const done = lanes.taskGet(task.taskId, DAVID);
    assert.equal(done.status, 'completed');
    assert.deepEqual(done.pointer, {
      lane: 'david',
      item,
      channel: 'slack',
      rule: { id: 'david-on-slack' },
      waiting: 1,
      text: `1 new item in lane david (Slack, rule david-on-slack): read it with events_lane_item, item ${item}. Then call events_watch for lane david again to keep watching.`,
    });
    assert.doesNotMatch(JSON.stringify(done), new RegExp(`${SECRET_TEXT}|${SECRET_NAME}`, 'u'), 'no sender text');
    assert.deepEqual(lanes.taskGet(task.taskId, DAVID), done, 'a completed task stays as it was');

    const next = lanes.watch('david', DAVID);
    assert.equal(next.status, 'working', 'the window is not woken twice for one item');
    const second = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 4_500 });
    const third = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 4_600 });
    const woke = lanes.taskGet(next.taskId, DAVID);
    assert.equal(woke.status, 'completed');
    assert.equal(woke.pointer?.item, second);
    assert.equal(woke.pointer?.waiting, 2);
    const atOnce = lanes.watch('david', DAVID);
    assert.equal(atOnce.status, 'completed', 'a watch completes at once when an item is waiting');
    assert.equal(atOnce.pointer?.item, third);

    const cancelled = lanes.watch('david', DAVID);
    assert.deepEqual(lanes.taskCancel(cancelled.taskId, DAVID), {});
    assert.equal(lanes.taskGet(cancelled.taskId, DAVID).status, 'cancelled');
  });
});

test('LANE-B: unbinding cancels the lane’s tasks, and the service stopping ends them (§3.4)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ lanes }) => {
    lanes.seen(DAVID);
    lanes.bind('david', DAVID.sessionId as string);
    const task = lanes.watch('david', DAVID);
    lanes.unbind('david');
    const ended = lanes.taskGet(task.taskId, DAVID);
    assert.equal(ended.status, 'cancelled');
    assert.match(ended.statusMessage ?? '', /unbound/u);
    lanes.bind('david', DAVID.sessionId as string);
    const again = lanes.watch('david', DAVID);
    const waiting = lanes.wait('david', 30, DAVID);
    lanes.close();
    assert.throws(() => lanes.taskGet(again.taskId, DAVID), refused('NOT_FOUND', /no such watch/u));
    await assert.rejects(waiting, refused('NOT_FOUND', /stopped/u));
  });
});

test('LANE-B: a long-poll returns the pointer on a new item, or waiting at the end of its time (§3.6)', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLanes(async ({ store, lanes, clock }) => {
    lanes.seen(DAVID);
    lanes.seen(OTHER);
    await assert.rejects(lanes.wait('david', 1, DAVID), refused('APPROVAL_REQUIRED', /not bound to this window/u));
    lanes.bind('david', DAVID.sessionId as string);
    await assert.rejects(lanes.wait('david', 1, OTHER), refused('APPROVAL_REQUIRED', /not bound to this window/u));
    for (const seconds of [0, 51, 1.5, '10'])
      await assert.rejects(lanes.wait('david', seconds, DAVID), refused('USAGE', /1 to 50/u), String(seconds));
    const started = Date.now();
    assert.deepEqual(await lanes.wait('david', 1, DAVID), { waiting: true });
    assert.ok(Date.now() - started >= 900, 'it waited its second');

    const pending = lanes.wait('david', 30, DAVID);
    clock.value = NOW + 5_000;
    const item = seed(store, { ruleId: 'david-on-slack', targetId: 'lane-david', arrivedAt: NOW + 4_000 });
    lanes.notifyAppended();
    const answer = await pending;
    assert.equal('pointer' in answer ? answer.pointer.item : null, item);
    const unbound = lanes.wait('david', 30, DAVID);
    lanes.unbind('david');
    await assert.rejects(unbound, refused('APPROVAL_REQUIRED', /not bound to this window/u), 'unbinding ends a wait');
  });
});
