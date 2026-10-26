import assert from 'node:assert/strict';
import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { QueueStore } from '../src/runtime/queue.ts';
import { queueItemHistory, recordQueueHistory } from '../src/runtime/queue-history.ts';
import { type EventDatabase, openEventDatabase } from '../src/store/database.ts';
import {
  bindDavid,
  cli,
  DAVID,
  deliver,
  lane,
  OTHER,
  readDatabase,
  setUp,
  structured,
  tool,
  withLaneOwner,
} from './support/lane-harness.ts';
import { resultText } from './support/raw-mcp.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

/**
 * A queue item's history (0.32.0 spec §3.6): what happened to it after it arrived — a window woken for it, a window
 * reading it, and Done, Dismiss and Reopen, with who did each: the window, over MCP, or the person, at the CLI or in
 * the app. It lives in the event service's own database, goes with its item, is never returned over MCP, and never
 * reaches core's activity log, so an agent's own activity view never names an item in a lane bound elsewhere (B4).
 */

const DAY = 86_400_000;
const NOW = Date.parse('2026-10-26T12:00:00.000Z');
const ITEM = 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1D';

/** One open queue item and the event, decision and delivery it came from: the rows a history line belongs to. */
function seedItem(store: EventDatabase, id = ITEM): void {
  const tag = id.slice(-8);
  store.database
    .prepare(
      `INSERT INTO ingest (event_id, installation_id, type, version, account_id, dedupe_key, occurred_at, observed_at, staged_at)
       VALUES (?, ?, 'gmail.message.received', 1, 'ibx_QUEUEHISTORY0001', ?, ?, ?, ?)`,
    )
    .run(`event-${tag}`, store.installationId, `["1","m-${tag}","received"]`, NOW, NOW, NOW);
  store.database
    .prepare(
      `INSERT INTO decisions (id, event_id, account_id, rule_id, rule_version, outcome, metadata_expires_at, metadata_state)
       VALUES (?, ?, 'ibx_QUEUEHISTORY0001', 'rule-history', 1, 'matched', ?, 'retained')`,
    )
    .run(`decision-${tag}`, `event-${tag}`, NOW + 90 * DAY);
  store.database
    .prepare(
      `INSERT INTO deliveries
         (id, decision_id, account_id, rule_id, rule_version, target_key, target_id, target_version, target_kind,
          encrypted_record, expires_at, state, switch_generation)
       VALUES (?, ?, 'ibx_QUEUEHISTORY0001', 'rule-history', 1, 'queue:queue-history:1', 'queue-history', 1, 'queue',
               NULL, ?, 'delivered', 1)`,
    )
    .run(`delivery-${tag}`, `decision-${tag}`, NOW + 7 * DAY);
  store.database
    .prepare(
      `INSERT INTO queue_items
         (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id, channel,
          state, state_at, arrived_at, appended_at, retention_ms, expires_at, row_expires_at, released, encrypted_record)
       VALUES (?, ?, ?, ?, 'rule-history', 1, 'queue-history', 1, 'ibx_QUEUEHISTORY0001', 'gmail', 'open', ?, ?, ?, ?, ?, ?,
               0, NULL)`,
    )
    .run(id, `delivery-${tag}`, `decision-${tag}`, `event-${tag}`, NOW, NOW, NOW, DAY, NOW + DAY, NOW + 2 * DAY);
}

async function withStore(work: (store: EventDatabase, queue: QueueStore) => Promise<void> | void): Promise<void> {
  const stateDir = await shortTempDir('aev-queue-history-');
  const store = await openEventDatabase({ stateDir });
  try {
    const queue = new QueueStore({
      store,
      cipher: { decrypt: async (_location: unknown, bytes: Uint8Array) => Buffer.from(bytes) },
      approvals: { get: async () => null },
      config: { load: async () => ({}) } as never,
      now: () => NOW,
    });
    await work(store, queue);
  } finally {
    store.close();
    await rm(stateDir, { recursive: true, force: true });
  }
}

test('QH: the history table takes only its closed kinds and actors; a window’s line names its key, the person’s none', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore((store) => {
    seedItem(store);
    const insert = (kind: string, actor: string, windowKey: string | null) =>
      store.database
        .prepare('INSERT INTO queue_item_history (item_id, at, kind, actor, window_key) VALUES (?, ?, ?, ?, ?)')
        .run(ITEM, NOW, kind, actor, windowKey);
    insert('woken', 'window', DAVID.activityKey);
    insert('done', 'person', null);
    assert.throws(() => insert('replied', 'window', DAVID.activityKey), /CHECK/u, 'kind is closed');
    assert.throws(() => insert('done', 'agent', DAVID.activityKey), /CHECK/u, 'actor is closed');
    assert.throws(() => insert('done', 'window', null), /CHECK/u, 'a window’s line names its window');
    assert.throws(() => insert('done', 'person', DAVID.activityKey), /CHECK/u, 'the person’s line names no window');
    assert.throws(() => insert('read', 'person', null), /CHECK/u, 'only a window is woken or reads');
    assert.throws(() => insert('read', 'window', 'not-a-key'), /CHECK/u, 'a window key is an activity session key');
  });
});

test('QH: a state change writes one line with its actor, and none when nothing changed; a line for a purged item is not written', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore((store, queue) => {
    seedItem(store);
    queue.done(ITEM, undefined, { actor: 'window', windowKey: DAVID.activityKey });
    queue.done(ITEM, undefined, { actor: 'window', windowKey: DAVID.activityKey });
    queue.reopen(ITEM);
    queue.dismiss(ITEM, undefined, { actor: 'person' });
    assert.deepEqual(queueItemHistory(store.database, ITEM), [
      { at: NOW, kind: 'done', actor: 'window', windowKey: DAVID.activityKey },
      { at: NOW, kind: 'reopened', actor: 'person', windowKey: null },
      { at: NOW, kind: 'dismissed', actor: 'person', windowKey: null },
    ]);
    recordQueueHistory(store.database, {
      itemId: 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1E',
      at: NOW,
      kind: 'read',
      by: { actor: 'window', windowKey: DAVID.activityKey },
    });
    assert.deepEqual(queueItemHistory(store.database, 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1E'), [], 'no item, no line');
  });
});

test('QH: an item’s history goes when its item is purged, by queue clear or any other delete', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore((store, queue) => {
    seedItem(store);
    seedItem(store, 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1F');
    queue.done(ITEM);
    queue.done('qi_01JBQZ8Y6W3T5N0M4K2H7G9F1F', undefined, { actor: 'window', windowKey: DAVID.activityKey });
    queue.reopen('qi_01JBQZ8Y6W3T5N0M4K2H7G9F1F');
    assert.equal(queue.clear().cleared, 1);
    assert.deepEqual(queueItemHistory(store.database, ITEM), [], 'cleared with its item');
    assert.equal(queueItemHistory(store.database, 'qi_01JBQZ8Y6W3T5N0M4K2H7G9F1F').length, 2, 'an open item keeps it');
    store.database.prepare('DELETE FROM queue_items WHERE id = ?').run('qi_01JBQZ8Y6W3T5N0M4K2H7G9F1F');
    assert.equal(
      (store.database.prepare('SELECT COUNT(*) AS count FROM queue_item_history').get() as { count: number }).count,
      0,
      'every purge path deletes the row, and the row takes its history',
    );
  });
});

test('QH: an item keeps at most its newest 500 lines, so a window reading in a loop cannot grow it without end', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withStore((store) => {
    seedItem(store);
    for (let index = 0; index < 510; index += 1)
      recordQueueHistory(store.database, {
        itemId: ITEM,
        at: NOW + index,
        kind: 'read',
        by: { actor: 'window', windowKey: DAVID.activityKey },
      });
    const lines = queueItemHistory(store.database, ITEM);
    assert.equal(lines.length, 500);
    assert.equal(lines[0]?.at, NOW + 10, 'the oldest lines go first');
    assert.equal(lines.at(-1)?.at, NOW + 509);
  });
});

function historyRows(stateDir: string, itemId: string) {
  return readDatabase(stateDir, (database) =>
    database
      .prepare('SELECT kind, actor, window_key FROM queue_item_history WHERE item_id = ? ORDER BY at, rowid')
      .all(itemId)
      .map((row) => ({ ...(row as Record<string, unknown>) })),
  );
}

test('QH-E: a wake writes woken and events_lane_item writes read, with the bound window’s key; Done and Dismiss name the window over MCP and the person at the CLI', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    const other = await harness.window(OTHER);
    structured(await tool(other, 'events_lane_whoami'));
    await bindDavid(harness, david);

    const watch = await tool(david, 'events_watch', { lane: 'david' });
    assert.equal(watch.result?.status, 'working');
    await deliver(harness, 'Can you sign the David contract by Friday?');
    const done = await david.request('tasks/get', { taskId: String(watch.result?.taskId) });
    assert.equal(done.result?.status, 'completed');
    const item = String(
      (done.result?.result as { structuredContent: { item: string } } | undefined)?.structuredContent.item,
    );
    assert.deepEqual(historyRows(harness.stateDir, item), [
      { kind: 'woken', actor: 'window', window_key: DAVID.activityKey },
    ]);

    structured(await tool(david, 'events_lane_item', { item }));
    assert.equal((await tool(other, 'events_lane_item', { item })).result?.isError, true);
    structured(await tool(david, 'events_queue_done', { itemId: item }));
    assert.deepEqual(historyRows(harness.stateDir, item).slice(1), [
      { kind: 'read', actor: 'window', window_key: DAVID.activityKey },
      { kind: 'done', actor: 'window', window_key: DAVID.activityKey },
    ]);

    const reopened = await cli(harness.stateDir, ['queue', 'reopen', item, '--json']);
    assert.equal(reopened.code, 0, reopened.err);
    structured(await tool(david, 'events_queue_dismiss', { itemId: item }));
    assert.equal((await cli(harness.stateDir, ['queue', 'reopen', item, '--json'])).code, 0);
    assert.equal((await cli(harness.stateDir, ['queue', 'done', item, '--json'])).code, 0);
    assert.deepEqual(historyRows(harness.stateDir, item).slice(3), [
      { kind: 'reopened', actor: 'person', window_key: null },
      { kind: 'dismissed', actor: 'window', window_key: DAVID.activityKey },
      { kind: 'reopened', actor: 'person', window_key: null },
      { kind: 'done', actor: 'person', window_key: null },
    ]);

    // No MCP tool returns history: nothing either window was told names a line, an actor or a window's key of it.
    const listed = (await david.request('tools/list')).result as { tools: Array<{ name: string }> };
    assert.ok(!listed.tools.some((entry) => /message|history/u.test(entry.name)), 'no tool reads the story');
    structured(await tool(david, 'events_queue_items', { state: 'all' }));
    structured(await tool(david, 'events_queue_counts'));
    const told = [...david.wire, ...other.wire].join('\n');
    // (A tool's description may say "woken"; a history line would say "kind":"woken".)
    for (const word of ['"history"', '"actor"', '"kind":"woken"', '"kind":"read"', 'window_key', '"windowKey"'])
      assert.ok(!told.includes(word), `no MCP result carries ${word}`);

    // Not in core's activity log: no line there names the item, so no window's activity view can.
    const activity = join(harness.stateDir, 'activity');
    const days = await readdir(activity).catch(() => [] as string[]);
    for (const day of days)
      assert.ok(!(await readFile(join(activity, day), 'utf8')).includes(item), `${day} names no queue item`);

    // Done items go with queue clear, and their history with them.
    assert.equal((await cli(harness.stateDir, ['queue', 'clear', '--json'])).code, 0);
    assert.deepEqual(historyRows(harness.stateDir, item), []);
    assert.match(resultText(await tool(david, 'events_queue_done', { itemId: item })), /no such queue item/u);
  });
});

test('QH-E: events_wait’s wake writes woken too, and a wake that names nothing writes nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withLaneOwner(async (harness) => {
    await setUp(harness, [lane(1)]);
    const david = await harness.window(DAVID);
    await bindDavid(harness, david);
    assert.deepEqual(structured(await tool(david, 'events_wait', { lane: 'david', seconds: 1 })), { waiting: true });
    assert.equal(
      readDatabase(harness.stateDir, (database) =>
        Number((database.prepare('SELECT COUNT(*) AS count FROM queue_item_history').get() as { count: number }).count),
      ),
      0,
    );
    await deliver(harness, 'David waits for this one');
    const woke = structured(await tool(david, 'events_wait', { lane: 'david', seconds: 5 })) as { item: string };
    assert.deepEqual(historyRows(harness.stateDir, woke.item), [
      { kind: 'woken', actor: 'window', window_key: DAVID.activityKey },
    ]);
  });
});
