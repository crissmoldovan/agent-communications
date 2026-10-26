import type { DatabaseSync } from 'node:sqlite';

/**
 * A queue item's history (0.32.0 spec §3.6): what happened to it after it arrived, and who did it.
 *
 * - **Kinds.** `woken`: a wake named it to the lane's bound window (`events_watch` completing, or `events_wait`
 *   returning). `read`: that window read it with `events_lane_item`. `done`, `dismissed`, `reopened`: its state changed.
 * - **Actors.** `window`: an agent window, over the event service's MCP server, named by its activity session key — the
 *   key core's activity log groups that window's calls under. `person`: the CLI or the app, which name no window.
 * - **Where it lives.** In the event service's database only, beside its item, and it goes with its item: every path
 *   that deletes an item row deletes its lines too (migration 26's trigger). Its content-free lines never reach core's
 *   activity log, so an agent's own activity view never names an item of a lane bound to another window (routing B4),
 *   and no MCP tool returns them: they are the person's, through `messages list` and `message show`.
 */

export const QUEUE_HISTORY_KINDS: readonly ['woken', 'read', 'done', 'dismissed', 'reopened'] = Object.freeze([
  'woken',
  'read',
  'done',
  'dismissed',
  'reopened',
] as const);
export type QueueHistoryKind = (typeof QUEUE_HISTORY_KINDS)[number];

export const QUEUE_HISTORY_ACTORS: readonly ['person', 'window'] = Object.freeze(['person', 'window'] as const);
export type QueueHistoryActor = (typeof QUEUE_HISTORY_ACTORS)[number];

/** Who changed an item: the person (the CLI, the app), or an agent window by its activity session key (MCP). */
export type QueueActor =
  | { readonly actor: 'person' }
  | {
      readonly actor: 'window' /** The window's activity session key: 16 hex characters. */;
      readonly windowKey: string;
    };

export const PERSON: QueueActor = Object.freeze({ actor: 'person' });

/** One line, as `messages list` and `message show` give it: content-free, a time in milliseconds. */
export interface QueueHistoryLineV1 {
  readonly at: number;
  readonly kind: QueueHistoryKind;
  readonly actor: QueueHistoryActor;
  readonly windowKey: string | null;
}

/**
 * How many lines an item keeps, newest first. A window that reads one item in a loop adds a line per read; past this,
 * the oldest lines go, so an item's history stays bounded whatever an agent does.
 */
export const QUEUE_HISTORY_MAX_LINES = 500;

/**
 * Writes one line for an item that still exists — a line for an item purged meanwhile is not written — and drops the
 * item's lines beyond its newest `QUEUE_HISTORY_MAX_LINES`. Runs inside the caller's transaction when it has one.
 */
export function recordQueueHistory(
  database: DatabaseSync,
  line: { readonly itemId: string; readonly at: number; readonly kind: QueueHistoryKind; readonly by: QueueActor },
): void {
  const windowKey = line.by.actor === 'window' ? line.by.windowKey : null;
  const written = database
    .prepare(
      `INSERT INTO queue_item_history (item_id, at, kind, actor, window_key)
       SELECT ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM queue_items WHERE id = ?)`,
    )
    .run(line.itemId, line.at, line.kind, line.by.actor, windowKey, line.itemId);
  if (Number(written.changes) === 0) return;
  database
    .prepare(
      `DELETE FROM queue_item_history WHERE item_id = ? AND rowid NOT IN (
         SELECT rowid FROM queue_item_history WHERE item_id = ? ORDER BY at DESC, rowid DESC LIMIT ?
       )`,
    )
    .run(line.itemId, line.itemId, QUEUE_HISTORY_MAX_LINES);
}

interface HistoryRow {
  readonly item_id: string;
  readonly at: number;
  readonly kind: QueueHistoryKind;
  readonly actor: QueueHistoryActor;
  readonly window_key: string | null;
}

function line(row: HistoryRow): QueueHistoryLineV1 {
  return { at: row.at, kind: row.kind, actor: row.actor, windowKey: row.window_key };
}

/** Every line an item keeps, oldest first. */
export function queueItemHistory(database: DatabaseSync, itemId: string): QueueHistoryLineV1[] {
  return (
    database
      .prepare(
        'SELECT item_id, at, kind, actor, window_key FROM queue_item_history WHERE item_id = ? ORDER BY at, rowid',
      )
      .all(itemId) as unknown as HistoryRow[]
  ).map(line);
}

/**
 * For each item, the newest line of each kind it has, oldest first: what a list needs to say how far an item got — who
 * last read it, who last marked it, when it was last woken — without every line of every item.
 */
export function latestQueueHistory(
  database: DatabaseSync,
  itemIds: readonly string[],
): ReadonlyMap<string, QueueHistoryLineV1[]> {
  const result = new Map<string, QueueHistoryLineV1[]>();
  if (itemIds.length === 0) return result;
  const rows = database
    .prepare(
      `SELECT item_id, at, kind, actor, window_key FROM (
         SELECT item_id, at, kind, actor, window_key, rowid AS seq,
                ROW_NUMBER() OVER (PARTITION BY item_id, kind ORDER BY at DESC, rowid DESC) AS rank
           FROM queue_item_history
          WHERE item_id IN (SELECT value FROM json_each(?))
       ) WHERE rank = 1 ORDER BY item_id, at, seq`,
    )
    .all(JSON.stringify(itemIds)) as unknown as HistoryRow[];
  for (const row of rows) {
    const lines = result.get(row.item_id) ?? [];
    lines.push(line(row));
    result.set(row.item_id, lines);
  }
  return result;
}
