import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { sqlTargetLane } from '../domain/lanes.ts';
import type { EventDatabase } from '../store/database.ts';
import type { AgentSessionService } from './agent-sessions.ts';
import { RELAY_RUN_END_TYPES, RelayError } from './relay-client.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

/**
 * The busy queue (0.33.0 design §3.5): a session delivery that met a busy session — the relay answered 409, or said the
 * session had a live run — waits here, oldest first per relay session, until the relay's event stream says that
 * session's run ended. Then the next one is let go: its delivery is due again, and the dispatcher posts it. The relay
 * never queues a prompt itself, so this is the only queue.
 *
 * A row is content-free: ids and times. The delivery keeps its own sealed record and its own retention, and the row
 * goes when the delivery stops being one that may still be tried — delivered, dropped, expired, cancelled — whichever
 * path ends it (migration 29's triggers).
 */

export interface SessionQueueItemV1 {
  readonly deliveryId: string;
  readonly relaySessionId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  /** The lane the target finds its session by, when it does; null for a session found by its folder. */
  readonly lane: string | null;
  readonly queuedAt: string;
  /** Let go: the session's run ended, and the delivery is due again. */
  readonly released: boolean;
  readonly expiresAt: string;
}

export interface SessionQueueListResultV1 {
  readonly items: readonly SessionQueueItemV1[];
}

export interface SessionQueueDropResultV1 {
  readonly deliveryId: string;
  readonly dropped: true;
}

/** What an agent window may see of the busy queue (routing B4): only its own lane's items, or none. */
export interface SessionQueueScope {
  readonly lane: string | null;
}

interface Row {
  readonly delivery_id: string;
  readonly relay_session_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly queued_at: number;
  readonly released_at: number | null;
  readonly expires_at: number;
  readonly lane: string | null;
}

const DELIVERY_ID = /^[0-9A-Za-z_-]{1,128}$/u;

export class SessionQueue {
  readonly #store: EventDatabase;
  readonly #now: () => number;

  constructor(options: { readonly store: EventDatabase; readonly now?: (() => number) | undefined }) {
    this.#store = options.store;
    this.#now = options.now ?? Date.now;
  }

  /** Every waiting item, oldest first; a window's scope keeps only its own lane's. */
  list(scope?: SessionQueueScope): SessionQueueListResultV1 {
    const rows = this.#store.database
      .prepare(
        `SELECT q.delivery_id, q.relay_session_id, q.rule_id, q.rule_version, q.target_id, q.target_version,
                q.queued_at, q.released_at, d.expires_at, ${sqlTargetLane('tv.document')} AS lane
           FROM session_queue q
           JOIN deliveries d ON d.id = q.delivery_id
           LEFT JOIN target_versions tv ON tv.target_id = q.target_id AND tv.version = q.target_version
          ORDER BY q.queued_at, q.delivery_id`,
      )
      .all() as unknown as Row[];
    const visible = scope === undefined ? rows : rows.filter((row) => row.lane !== null && row.lane === scope.lane);
    return {
      items: visible.map((row) => ({
        deliveryId: row.delivery_id,
        relaySessionId: row.relay_session_id,
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        targetId: row.target_id,
        targetVersion: row.target_version,
        lane: row.lane,
        queuedAt: new Date(row.queued_at).toISOString(),
        released: row.released_at !== null,
        expiresAt: new Date(row.expires_at).toISOString(),
      })),
    };
  }

  /** Drops a waiting item: its delivery is cancelled and its sealed record purged at once — a tightening. */
  drop(deliveryId: unknown): SessionQueueDropResultV1 {
    if (typeof deliveryId !== 'string' || !DELIVERY_ID.test(deliveryId))
      throw new CommsError('USAGE', 'a waiting item is named by its delivery id');
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const row = database
        .prepare(
          `SELECT d.state FROM session_queue q JOIN deliveries d ON d.id = q.delivery_id WHERE q.delivery_id = ?`,
        )
        .get(deliveryId) as { state: string } | undefined;
      if (row === undefined) throw new CommsError('NOT_FOUND', 'no item with this id waits for a busy session');
      if (row.state === 'disclosing')
        throw new CommsError('TRANSIENT', 'this item is being passed to its session right now; look again in a moment');
      const changed = database
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
                  last_error_code = 'DROPPED_BY_PERSON'
            WHERE id = ? AND state IN ('queued', 'retryable')`,
        )
        .run(deliveryId).changes;
      if (changed !== 1) throw new CommsError('NOT_FOUND', 'no item with this id waits for a busy session');
      for (const target of removeRetainedDeliveryTargetReference(database, deliveryId))
        purgeUnreferencedSystemTargets(database, { ...target, now: this.#now() });
      return { deliveryId, dropped: true };
    });
  }

  /** The relay sessions that have an item waiting to be let go. */
  waitingSessions(): readonly string[] {
    return (
      this.#store.database
        .prepare(
          'SELECT DISTINCT relay_session_id FROM session_queue WHERE released_at IS NULL ORDER BY relay_session_id',
        )
        .all() as Array<{ relay_session_id: string }>
    ).map((row) => row.relay_session_id);
  }

  /**
   * Lets the session's next item go, if one waits and none already let go is still on its way: its delivery is due now.
   * Returns the delivery let go, or null.
   */
  release(relaySessionId: string): string | null {
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const inFlight = database
        .prepare('SELECT 1 AS present FROM session_queue WHERE relay_session_id = ? AND released_at IS NOT NULL')
        .get(relaySessionId);
      if (inFlight !== undefined) return null;
      const head = database
        .prepare(
          `SELECT delivery_id FROM session_queue WHERE relay_session_id = ? AND released_at IS NULL
            ORDER BY queued_at, delivery_id LIMIT 1`,
        )
        .get(relaySessionId) as { delivery_id: string } | undefined;
      if (head === undefined) return null;
      const now = this.#now();
      database.prepare('UPDATE session_queue SET released_at = ? WHERE delivery_id = ?').run(now, head.delivery_id);
      database
        .prepare("UPDATE deliveries SET next_at = ? WHERE id = ? AND state IN ('queued', 'retryable')")
        .run(now, head.delivery_id);
      return head.delivery_id;
    });
  }
}

/**
 * Puts a claimed delivery in the busy queue, inside the dispatcher's settling transaction: a new item takes its place
 * at the back; one let go that met a busy session again keeps the place it had.
 */
export function enqueueSessionDeliveryInTransaction(
  database: DatabaseSync,
  input: {
    readonly deliveryId: string;
    readonly relaySessionId: string;
    readonly ruleId: string;
    readonly ruleVersion: number;
    readonly targetId: string;
    readonly targetVersion: number;
    readonly now: number;
  },
): void {
  database
    .prepare(
      `INSERT INTO session_queue
         (delivery_id, relay_session_id, rule_id, rule_version, target_id, target_version, queued_at, released_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
       ON CONFLICT (delivery_id) DO UPDATE SET relay_session_id = excluded.relay_session_id, released_at = NULL`,
    )
    .run(
      input.deliveryId,
      input.relaySessionId,
      input.ruleId,
      input.ruleVersion,
      input.targetId,
      input.targetVersion,
      input.now,
    );
}

export interface SessionQueueFollowerOptions {
  readonly queue: SessionQueue;
  readonly sessions: AgentSessionService;
  /** Told when an item is let go, so the owner can pass it on without waiting for its next tick. */
  readonly onReleased?: (() => void) | undefined;
  readonly reconcileMs?: number | undefined;
  readonly retryMs?: number | undefined;
}

/**
 * Follows the relay's event stream while anything waits, and lets the next item go when a waiting session's run ends
 * (completed, failed, cancelled or interrupted). It resumes a dropped stream with `Last-Event-ID`, drops a repeated
 * record by its id, and, on every (re)connect and every `reconcileMs`, asks each waiting session's snapshot whether it
 * still has a live run — so a run end it missed, across a restart or a journal reset, still lets the next item go.
 */
export class SessionQueueFollower {
  readonly #queue: SessionQueue;
  readonly #sessions: AgentSessionService;
  readonly #onReleased: (() => void) | undefined;
  readonly #reconcileMs: number;
  readonly #retryMs: number;
  readonly #seen = new Set<string>();
  #running: Promise<void> | undefined;
  #abort: AbortController | undefined;
  #stopped = false;
  #lastCursor: number | undefined;
  #journal: string | null = null;

  constructor(options: SessionQueueFollowerOptions) {
    this.#queue = options.queue;
    this.#sessions = options.sessions;
    this.#onReleased = options.onReleased;
    this.#reconcileMs = options.reconcileMs ?? 30_000;
    this.#retryMs = options.retryMs ?? 5_000;
  }

  /** Starts following if anything waits and it is not already; never throws. */
  notify(): void {
    if (this.#stopped || this.#running !== undefined) return;
    if (this.#queue.waitingSessions().length === 0) return;
    this.#running = this.#loop().finally(() => {
      this.#running = undefined;
      // Something may have been queued while the loop was ending.
      if (!this.#stopped && this.#queue.waitingSessions().length > 0) this.notify();
    });
  }

  /** Asks each waiting session whether its run is over, letting the next item go for each that is free. */
  async reconcile(): Promise<number> {
    const ready = await this.#sessions.relay();
    let cursor = 0;
    for (const sessionId of this.#queue.waitingSessions()) {
      const snapshot = await ready.client.snapshot(sessionId);
      if (snapshot !== null) cursor = Math.max(cursor, snapshot.cursor);
      // A session that is gone lets its item go too: the dispatcher finds, or starts, another.
      if (snapshot === null || snapshot.session.activeRunId === undefined) this.#release(sessionId);
    }
    return cursor;
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    this.#abort?.abort();
    await this.#running;
  }

  /** Whether a follow stream is open now (tests wait on it). */
  get following(): boolean {
    return this.#abort !== undefined && !this.#abort.signal.aborted;
  }

  #release(sessionId: string): void {
    if (this.#queue.release(sessionId) !== null) this.#onReleased?.();
  }

  async #loop(): Promise<void> {
    while (!this.#stopped && this.#queue.waitingSessions().length > 0) {
      const abort = new AbortController();
      this.#abort = abort;
      const timer = setInterval(() => {
        void this.reconcile().catch(() => undefined);
      }, this.#reconcileMs);
      timer.unref?.();
      try {
        const ready = await this.#sessions.relay();
        const cursor = await this.reconcile();
        const after = this.#lastCursor ?? cursor;
        this.#lastCursor = await ready.client.follow({
          after,
          ...(this.#lastCursor === undefined ? {} : { lastEventId: this.#lastCursor }),
          types: RELAY_RUN_END_TYPES,
          signal: abort.signal,
          seen: this.#seen,
          handlers: {
            onOpen: (journal) => {
              // A cursor means something only within its journal: a reset relay starts again from the snapshots.
              if (this.#journal !== null && journal !== null && journal !== this.#journal) this.#lastCursor = undefined;
              this.#journal = journal;
            },
            onEvent: (event) => {
              if ((RELAY_RUN_END_TYPES as readonly string[]).includes(event.type)) this.#release(event.sessionId);
              // Nothing waits any more: the stream has done its work.
              if (this.#queue.waitingSessions().length === 0) abort.abort();
            },
          },
        });
      } catch (error) {
        if (!(error instanceof RelayError) && !(error instanceof CommsError)) throw error;
        if (!this.#stopped) await pause(this.#retryMs, abort.signal);
      } finally {
        clearInterval(timer);
        this.#abort = undefined;
      }
      // A stream the relay keeps dropping is followed again, but never in a tight loop.
      if (!this.#stopped) await pause(250, new AbortController().signal);
    }
  }
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}
