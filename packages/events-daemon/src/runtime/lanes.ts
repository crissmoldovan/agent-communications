import { randomBytes } from 'node:crypto';
import { CommsError, homeDirectory, shortenHome } from '@agentcomms/core';
import {
  isActivityKey,
  isClaudeCodeSessionId,
  isIdentifiableWindow,
  isLaneName,
  isLaneWindowId,
  type LaneBindingV1,
  type LaneBindResultV1,
  type LaneListForWindowV1,
  type LaneListResultV1,
  type LaneUnbindResultV1,
  type LaneWindowIdentity,
  lanePointerText,
  sqlTargetLane,
  UNIDENTIFIABLE_WINDOW_REASON,
} from '../domain/lanes.ts';
import type { QueueChannel } from '../domain/queue-target.ts';
import type { EventDatabase } from '../store/database.ts';
import type { LaneWakeMark, QueueItemV1, QueueScope, QueueStore } from './queue.ts';
import { recordQueueHistory } from './queue-history.ts';
import type { RuleShowEntryV1 } from './rule-show.ts';

/**
 * Routing's lanes in the owner (routing design 2026-10-25, §3 and §6): which window the person bound to each lane, who
 * a caller is, what it may see, and the wake — a task store and a long-poll that complete on the lane's next item.
 *
 * - **Binding** is the person's, at a terminal (B1): `bind` resolves a window the event service's MCP server has
 *   reported, by either of its ids, and refuses one that cannot be told apart from others (B6). Unbinding is a
 *   tightening and applies at once.
 * - **The bound window** (§3.3) is the one whose Claude Code session id equals the binding's when either side has one;
 *   when neither has, the one whose grouped activity key equals the binding's.
 * - **A binding ends** on unbind, when no active rule's queue target carries its lane any more, and with disable-all
 *   (the database's own triggers, migration 25), so every path that moves a rule pointer ends it.
 * - **A wake** names the oldest open item of the lane that arrived after the binding (B3) and lies past the binding's
 *   high-water mark (append time, then id), and moves the mark to it. The mark is kept here, in memory: after a restart
 *   a window may be woken again for an item still open, and no item is ever missed. Tasks live here too, and end on
 *   completion, cancellation, unbinding or the service stopping; none times out by itself.
 * - **History** (0.32.0 §3.6): a wake writes `woken` on the item it names, and a read through `events_lane_item` writes
 *   `read`, each with the window's activity session key, in the event service's own database and never in core's
 *   activity log.
 */

const TASK_ID = /^lt_[0-9a-f]{32}$/u;
/** How many watches one binding may hold open at once; a further one ends the oldest. */
const MAX_WORKING_TASKS = 8;
/** How long an ended watch is kept for its window's last poll. */
const ENDED_TASK_KEEP_MS = 60 * 60_000;
const MAX_TASKS = 1_000;
/** How long a reported window is kept for the person to bind it, and how many are kept at most. */
const WINDOW_KEEP_MS = 30 * 86_400_000;
const MAX_WINDOWS = 1_000;
export const LANE_WAIT_MAX_SECONDS = 50;

interface BindingRow {
  readonly lane: string;
  readonly binding_id: string;
  readonly session_id: string | null;
  readonly activity_key: string | null;
  readonly folder: string | null;
  readonly client_name: string | null;
  readonly client_version: string | null;
  readonly since: number;
}

interface WindowRow {
  readonly activity_key: string;
  readonly session_id: string | null;
  readonly grouped: number;
  readonly folder: string | null;
  readonly client_name: string | null;
  readonly client_version: string | null;
}

/** `events_lane_whoami`: this window as the event service sees it, and the id the person binds it with. No content. */
export interface LaneWhoamiV1 {
  readonly window: LaneWindowIdentity;
  readonly identifiable: boolean;
  /** The id to give the person for `lane bind <lane> --window <id>`, or null when this window cannot be bound. */
  readonly bindWith: string | null;
  readonly reason?: string;
  /** The lane this window is bound to, or null. */
  readonly lane: string | null;
}

/** What a wake says, structured as well as written (§2): never a sender, subject or text. */
export interface LanePointerResultV1 {
  readonly lane: string;
  readonly item: string;
  readonly channel: QueueChannel;
  readonly rule: { readonly id: string };
  readonly waiting: number;
  readonly text: string;
}

/** A watch, as the owner holds it; the MCP server writes it in the tasks extension's shapes. */
export interface LaneTaskV1 {
  readonly taskId: string;
  readonly status: 'working' | 'completed' | 'cancelled';
  readonly createdAt: string;
  readonly lastUpdatedAt: string;
  readonly statusMessage?: string;
  readonly pointer?: LanePointerResultV1;
}

export type LaneWaitResultV1 = { readonly waiting: true } | { readonly pointer: LanePointerResultV1 };

interface Task {
  readonly taskId: string;
  readonly lane: string;
  readonly bindingId: string;
  readonly owner: Pick<LaneWindowIdentity, 'sessionId' | 'activityKey' | 'grouped'>;
  readonly createdAt: number;
  status: LaneTaskV1['status'];
  lastUpdatedAt: number;
  statusMessage?: string;
  pointer?: LanePointerResultV1;
}

interface Waiter {
  readonly check: () => void;
  readonly stop: (error: CommsError) => void;
}

export interface LaneServiceOptions {
  readonly store: EventDatabase;
  readonly queue: Pick<QueueStore, 'laneItem' | 'laneWake' | 'openByLane'>;
  readonly now?: (() => number) | undefined;
  /** How often a long-poll looks again without being told of an append (an item reopened, say). */
  readonly recheckMs?: number | undefined;
  /** The person's home folder, shown as `~` in a binding's folder; the process's own by default. */
  readonly home?: string | undefined;
}

function usage(message: string, reason?: string): never {
  throw new CommsError('USAGE', message, reason === undefined ? {} : { details: { reason } });
}

/** A lane name, or the contract's bad-argument refusal (64) before anything is asked. */
export function requireLaneName(value: unknown): string {
  if (!isLaneName(value)) usage('a lane name is 1 to 40 lowercase letters, digits and hyphens');
  return value;
}

/** A window id — a Claude Code session id or an activity session key — or the bad-argument refusal (64). */
export function requireLaneWindowId(value: unknown): string {
  if (!isLaneWindowId(value))
    usage(
      'a window id is a Claude Code session id (a UUID) or an activity session key (16 hex characters)',
      'WINDOW_ID_INVALID',
    );
  return value;
}

function iso(at: number): string {
  return new Date(at).toISOString();
}

/** The same refusal for every lane a window is not bound to: it names no window, and no item (§3.5). */
function notBoundHere(lane: string): never {
  throw new CommsError('APPROVAL_REQUIRED', `lane ${lane} is not bound to this window`, {
    hint: 'Only the agent window the person binds to a lane may watch or read it, and the person binds one at a terminal with lane bind and the id events_lane_whoami gives.',
    details: { reason: 'LANE_NOT_BOUND_HERE' },
  });
}

function noLaneHere(): never {
  throw new CommsError('APPROVAL_REQUIRED', 'this window is not bound to a lane', {
    hint: 'An item in a lane is read only by the agent window the person binds to that lane, at a terminal; events_lane_whoami gives this window’s id.',
    details: { reason: 'LANE_NOT_BOUND_HERE' },
  });
}

function noSuchWatch(): never {
  throw new CommsError('NOT_FOUND', 'there is no such watch in this window', {
    hint: 'A watch ends when it completes, is cancelled, its lane is unbound or the event service stops: call events_watch again.',
  });
}

function waitCancelled(): CommsError {
  return new CommsError('TRANSIENT', 'the wait was cancelled: its caller has gone');
}

function stopped(): CommsError {
  return new CommsError('NOT_FOUND', 'the local event service stopped, so this wait ended', {
    hint: 'Call events_wait again once the event service is running.',
  });
}

function sameWindow(owner: Task['owner'], caller: LaneWindowIdentity): boolean {
  return isBoundWindow({ session_id: owner.sessionId, activity_key: owner.grouped ? owner.activityKey : null }, caller);
}

/**
 * §3.3: the session id decides when either side has one; otherwise a grouped activity key, and only a grouped one.
 * A binding that recorded both — a Claude Code window with a grouped key — needs both to match (review of 0.31.0).
 */
function isBoundWindow(binding: Pick<BindingRow, 'session_id' | 'activity_key'>, caller: LaneWindowIdentity): boolean {
  const key = binding.activity_key !== null && caller.grouped && binding.activity_key === caller.activityKey;
  if (binding.session_id !== null || caller.sessionId !== null) {
    if (binding.session_id === null || binding.session_id !== caller.sessionId) return false;
    return binding.activity_key === null || key;
  }
  return key;
}

function bindingView(row: BindingRow, home: string): LaneBindingV1 {
  return {
    window: {
      sessionId: row.session_id,
      activityKey: row.activity_key,
      folder: row.folder,
      // As core's activity shows a folder: the home folder as `~` (the person's view; the owner runs as the person).
      folderShown: row.folder === null ? null : shortenHome(row.folder, home, process.platform),
      client:
        row.client_name === null
          ? null
          : { name: row.client_name, ...(row.client_version === null ? {} : { version: row.client_version }) },
    },
    since: iso(row.since),
  };
}

/** Every lane an active rule's queue target carries, with the rule and its source channel (B5). */
const CARRIED_LANES = `SELECT ${sqlTargetLane('target.value')} AS lane, pointer.object_id AS rule_id,
         json_extract(stored.document, '$.source.channel') AS channel
    FROM active_versions AS pointer
    JOIN rule_versions AS stored ON stored.rule_id = pointer.object_id AND stored.version = pointer.version
    JOIN json_each(stored.document, '$.targets') AS target
   WHERE pointer.kind = 'rule'
     AND ${sqlTargetLane('target.value')} IS NOT NULL`;

export class LaneService {
  readonly #store: EventDatabase;
  readonly #queue: LaneServiceOptions['queue'];
  readonly #now: () => number;
  readonly #recheckMs: number;
  readonly #home: string;
  readonly #tasks = new Map<string, Task>();
  /**
   * Per binding, its high-water mark: the last item a wake named. Wakes name only items past it, oldest first, so none
   * is named twice however many are open. In memory, so a restart wakes again from the binding rather than misses.
   */
  readonly #marks = new Map<string, LaneWakeMark>();
  readonly #waiters = new Set<Waiter>();
  #stopped = false;

  constructor(options: LaneServiceOptions) {
    this.#store = options.store;
    this.#queue = options.queue;
    this.#now = options.now ?? Date.now;
    this.#recheckMs = options.recheckMs ?? 1_000;
    this.#home = options.home ?? homeDirectory();
  }

  /**
   * Records a window the event service's MCP server reported, so the person can bind it by either id (B1). A report
   * may refresh a recorded window's folder, client and time, never its identity: one that names another Claude Code
   * session id for a recorded activity key — or none for one that had one, or flips whether it was grouped — is
   * refused and changes nothing, so no process can redirect a binding the person makes by that key (review of 0.31.0).
   */
  seen(window: LaneWindowIdentity): void {
    const now = this.#now();
    this.#store.immediate(() => {
      const recorded = this.#store.database
        .prepare('SELECT session_id, grouped FROM lane_windows WHERE activity_key = ?')
        .get(window.activityKey) as { session_id: string | null; grouped: number } | undefined;
      if (
        recorded !== undefined &&
        (recorded.session_id !== window.sessionId || recorded.grouped !== (window.grouped ? 1 : 0))
      )
        throw new CommsError(
          'BAD_DATA',
          'this activity session was reported before with another Claude Code session id or grouping, so the event service refused this report and changed nothing',
          {
            hint: 'A window keeps the ids it was first reported with; a report that changes them is not that window.',
            details: { reason: 'WINDOW_REPORT_CONFLICT' },
          },
        );
      this.#store.database
        .prepare(
          `INSERT INTO lane_windows (activity_key, session_id, grouped, folder, client_name, client_version, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (activity_key) DO UPDATE SET session_id = excluded.session_id, grouped = excluded.grouped,
             folder = excluded.folder, client_name = excluded.client_name, client_version = excluded.client_version,
             last_seen_at = excluded.last_seen_at`,
        )
        .run(
          window.activityKey,
          window.sessionId,
          window.grouped ? 1 : 0,
          window.folder,
          window.client?.name ?? null,
          window.client?.name === undefined ? null : (window.client.version ?? null),
          now,
        );
      this.#store.database.prepare('DELETE FROM lane_windows WHERE last_seen_at < ?').run(now - WINDOW_KEEP_MS);
      this.#store.database
        .prepare(
          'DELETE FROM lane_windows WHERE activity_key NOT IN (SELECT activity_key FROM lane_windows ORDER BY last_seen_at DESC LIMIT ?)',
        )
        .run(MAX_WINDOWS);
    });
  }

  /** `events_lane_whoami`: this window, whether it can be bound, the id to bind it by, and its lane (B1, B6). */
  whoami(window: LaneWindowIdentity): LaneWhoamiV1 {
    this.seen(window);
    const identifiable = isIdentifiableWindow(window);
    return {
      window,
      identifiable,
      bindWith: window.sessionId ?? (window.grouped ? window.activityKey : null),
      ...(identifiable ? {} : { reason: `this window cannot be bound: ${UNIDENTIFIABLE_WINDOW_REASON}` }),
      lane: this.#bindingFor(window)?.lane ?? null,
    };
  }

  /** `lane list` for the person: every lane an active rule carries, its rules, channels, open items and binding. */
  list(): LaneListResultV1 {
    const carried = this.#carried();
    const open = this.#queue.openByLane();
    const bindings = new Map(this.#bindings().map((row) => [row.lane, row]));
    return {
      lanes: [...carried.entries()]
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([name, entry]) => {
          const binding = bindings.get(name);
          return {
            name,
            rules: [...entry.rules].sort().map((id) => ({ id })),
            channels: [...entry.channels].sort(),
            open: open.get(name) ?? 0,
            binding: binding === undefined ? null : bindingView(binding, this.#home),
          };
        }),
    };
  }

  /** `lane list` over MCP (B4): names, and whether this window is bound to each; never another window. */
  listFor(window: LaneWindowIdentity): LaneListForWindowV1 {
    this.seen(window);
    const mine = this.#bindingFor(window)?.lane ?? null;
    return {
      lanes: [...this.#carried().keys()].sort().map((name) => ({ name, boundToThisWindow: name === mine })),
    };
  }

  /**
   * `lane bind <lane> --window <id>`: the person's act at a terminal (B1). The id is a Claude Code session id or an
   * activity session key of a window the event service's MCP server has reported; the binding keeps both of its ids.
   */
  bind(laneValue: unknown, windowId: unknown): LaneBindResultV1 {
    const lane = requireLaneName(laneValue);
    requireLaneWindowId(windowId);
    if (!this.#carried().has(lane))
      throw new CommsError('NOT_FOUND', `no active rule's queue target carries lane ${lane}`, {
        hint: 'A lane is a queue target with lane: { name }, sent to by a rule you approve.',
      });
    const window = this.#reportedWindow(windowId as string);
    if (window === undefined)
      usage(
        'no agent window with that id has reached the event service: ask the agent in that window to call events_lane_whoami, and bind the id it gives',
        'WINDOW_UNKNOWN',
      );
    const sessionId = window.session_id;
    const grouped = window.grouped === 1;
    if (sessionId === null && !grouped)
      usage(`that window cannot be bound: ${UNIDENTIFIABLE_WINDOW_REASON}`, 'WINDOW_UNIDENTIFIABLE');
    const activityKey = grouped ? window.activity_key : null;
    const since = this.#now();
    const row: BindingRow = {
      lane,
      binding_id: randomBytes(16).toString('hex'),
      session_id: sessionId,
      activity_key: activityKey,
      folder: window.folder,
      client_name: window.client_name,
      client_version: window.client_name === null ? null : window.client_version,
      since,
    };
    this.#store.immediate(() => {
      const database = this.#store.database;
      if (database.prepare('SELECT 1 AS found FROM lane_bindings WHERE lane = ?').get(lane) !== undefined)
        throw new CommsError('BAD_DATA', `lane ${lane} is already bound to a window`, {
          hint: 'Unbind it first: lane unbind, at a terminal or in the app.',
          details: { reason: 'LANE_ALREADY_BOUND' },
        });
      const other = database
        .prepare(
          'SELECT lane FROM lane_bindings WHERE (session_id IS NOT NULL AND session_id = ?) OR (activity_key IS NOT NULL AND activity_key = ?)',
        )
        .get(sessionId, activityKey) as { lane: string } | undefined;
      if (other !== undefined)
        throw new CommsError('BAD_DATA', `that window is already bound to lane ${other.lane}`, {
          hint: 'A window is bound to one lane at a time: unbind the other first.',
          details: { reason: 'WINDOW_ALREADY_BOUND' },
        });
      database
        .prepare(
          `INSERT INTO lane_bindings
             (lane, binding_id, session_id, activity_key, folder, client_name, client_version, since)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          row.lane,
          row.binding_id,
          row.session_id,
          row.activity_key,
          row.folder,
          row.client_name,
          row.client_version,
          row.since,
        );
    });
    return { lane, binding: bindingView(row, this.#home) };
  }

  /**
   * `lane unbind <lane>`: a tightening, applied at once. The person unbinds any lane; over MCP a window unbinds only its
   * own, and is told nothing of another's. The lane's watches end, cancelled, and its long-polls are refused.
   */
  unbind(laneValue: unknown, caller?: LaneWindowIdentity): LaneUnbindResultV1 {
    const lane = requireLaneName(laneValue);
    const binding = this.#bindings().find((row) => row.lane === lane);
    if (caller !== undefined) {
      this.seen(caller);
      if (binding === undefined || !isBoundWindow(binding, caller)) notBoundHere(lane);
    } else if (binding === undefined && !this.#carried().has(lane)) {
      throw new CommsError(
        'NOT_FOUND',
        `no active rule's queue target carries lane ${lane}, and nothing is bound to it`,
      );
    }
    if (binding !== undefined) {
      this.#store.immediate(() =>
        this.#store.database
          .prepare('DELETE FROM lane_bindings WHERE lane = ? AND binding_id = ?')
          .run(lane, binding.binding_id),
      );
      this.#marks.delete(binding.binding_id);
    }
    this.#settleAll();
    return { lane, unbound: true };
  }

  /**
   * An agent window's delivery list (B4): a lane target's deliveries only for the window bound to that lane. Each row
   * names its exact target version, whose document says whether it is a lane, as the person approved it.
   */
  visibleDeliveries(rows: unknown, caller: LaneWindowIdentity): unknown {
    if (!Array.isArray(rows)) return rows;
    const lanes = new Map(
      (
        this.#store.database
          .prepare(
            `SELECT target_id, version, ${sqlTargetLane('document')} AS lane FROM target_versions WHERE ${sqlTargetLane('document')} IS NOT NULL`,
          )
          .all() as Array<{ target_id: string; version: number; lane: string }>
      ).map((row) => [`${row.target_id}@${row.version}`, row.lane]),
    );
    const mine = this.#bindingFor(caller)?.lane ?? null;
    return rows.filter((row) => {
      const target = row as { readonly targetId?: unknown; readonly targetVersion?: unknown };
      const lane = lanes.get(`${String(target.targetId)}@${String(target.targetVersion)}`);
      return lane === undefined || lane === mine;
    });
  }

  /**
   * Whether an agent may stop this delivery (review of 0.32.0, finding 4). Stopping a delivery that will be tried again
   * is the person's, as `queue clear` is: an agent window may stop only one in the lane it is bound to, and the CLI
   * inside an MCP server's process (no window) none. A finished delivery stays finished, so its drop — a dead letter's
   * payload — goes on to the operation's own answer, as before; one being sent may still turn into one that will be
   * tried again, so it is refused here too.
   */
  assertAgentMayStop(deliveryId: unknown, caller: LaneWindowIdentity | undefined): void {
    if (typeof deliveryId !== 'string') return;
    const row = this.#store.database
      .prepare(
        `SELECT delivery.state, ${sqlTargetLane('target.document')} AS lane
           FROM deliveries AS delivery
           LEFT JOIN target_versions AS target
             ON target.target_id = delivery.target_id AND target.version = delivery.target_version
          WHERE delivery.id = ?`,
      )
      .get(deliveryId) as { state: string; lane: string | null } | undefined;
    if (row === undefined || !['queued', 'retryable', 'disclosing'].includes(row.state)) return;
    const mine = caller === undefined ? null : (this.#bindingFor(caller)?.lane ?? null);
    if (row.lane !== null && row.lane === mine) return;
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'stopping a delivery that will be tried again is for a person, at a terminal or in the app — an agent window may stop one only in the lane it is bound to',
      {
        hint: 'The person stops it in the app (Events → Deliveries) or at their terminal.',
        details: { reason: 'PERSON_ONLY_STOP' },
      },
    );
  }

  /**
   * `rule show` for an agent window (review of 0.32.0, finding 8): a version's `counts7d` says how much reached its
   * lane, so a version with a lane target other than the window's own is shown without it. Everything else — the
   * document, its times and its summary — is the window's to read, as before.
   */
  ruleVersionsForWindow(entries: readonly RuleShowEntryV1[], caller: LaneWindowIdentity): readonly unknown[] {
    const mine = this.#bindingFor(caller)?.lane ?? null;
    return entries.map((entry) => {
      const targets = (entry.document as { readonly targets?: unknown }).targets;
      const foreign =
        Array.isArray(targets) &&
        targets.some((target) => {
          const lane = (target as { readonly lane?: { readonly name?: unknown } } | null)?.lane?.name;
          return typeof lane === 'string' && lane !== mine;
        });
      if (!foreign) return entry;
      const { counts7d: _hidden, ...rest } = entry;
      return rest;
    });
  }

  /** What an MCP caller may see of the queue (B3, B4): items outside lanes, and its own lane's since it was bound. */
  scopeFor(window: LaneWindowIdentity): QueueScope {
    const binding = this.#bindingFor(window);
    return binding === undefined
      ? { lane: null, since: Number.MAX_SAFE_INTEGER }
      : { lane: binding.lane, since: binding.since };
  }

  /** `events_watch`: a task that completes on the lane's next item, or at once when one is waiting (§3.4). */
  watch(laneValue: unknown, caller: LaneWindowIdentity): LaneTaskV1 {
    const lane = requireLaneName(laneValue);
    this.seen(caller);
    const binding = this.#bindingFor(caller);
    if (binding === undefined || binding.lane !== lane) notBoundHere(lane);
    this.#prune();
    const working = [...this.#tasks.values()].filter(
      (task) => task.bindingId === binding.binding_id && task.status === 'working',
    );
    for (const task of working.slice(0, Math.max(0, working.length - MAX_WORKING_TASKS + 1)))
      this.#end(task, 'cancelled', 'a newer watch of this lane replaced this one');
    const now = this.#now();
    const task: Task = {
      taskId: `lt_${randomBytes(16).toString('hex')}`,
      lane,
      bindingId: binding.binding_id,
      owner: { sessionId: caller.sessionId, activityKey: caller.activityKey, grouped: caller.grouped },
      createdAt: now,
      status: 'working',
      lastUpdatedAt: now,
      statusMessage: `waiting for a new item in lane ${lane}`,
    };
    this.#tasks.set(task.taskId, task);
    this.#settle(task);
    return view(task);
  }

  /** `tasks/get`, for the window that made the watch. */
  taskGet(taskId: unknown, caller: LaneWindowIdentity): LaneTaskV1 {
    const task = this.#task(taskId, caller);
    this.#settle(task);
    return view(task);
  }

  /** `tasks/cancel`: acknowledged with an empty result, as the extension asks; the watch ends cancelled. */
  taskCancel(taskId: unknown, caller: LaneWindowIdentity): Record<string, never> {
    const task = this.#task(taskId, caller);
    if (task.status === 'working') this.#end(task, 'cancelled', 'the watch was cancelled');
    return {};
  }

  /** `events_wait`: until the lane's next item or `seconds` (1–50), whichever is first (§3.6). */
  async wait(
    laneValue: unknown,
    seconds: unknown,
    caller: LaneWindowIdentity,
    signal?: AbortSignal,
  ): Promise<LaneWaitResultV1> {
    const lane = requireLaneName(laneValue);
    if (!Number.isSafeInteger(seconds) || (seconds as number) < 1 || (seconds as number) > LANE_WAIT_MAX_SECONDS)
      usage(`seconds is a whole number from 1 to ${LANE_WAIT_MAX_SECONDS}`);
    this.seen(caller);
    const bound = (): BindingRow | undefined => {
      const binding = this.#bindingFor(caller);
      return binding !== undefined && binding.lane === lane ? binding : undefined;
    };
    const first = bound();
    if (first === undefined) return notBoundHere(lane);
    // A caller that has gone takes no item: an aborted wait ends before it looks, and as soon as it is aborted.
    if (signal?.aborted) throw waitCancelled();
    const woke = this.#wake(first, caller.activityKey);
    if (woke !== null) return { pointer: woke };
    if (this.#stopped) throw stopped();
    return new Promise<LaneWaitResultV1>((resolve, reject) => {
      let settled = false;
      const finish = (outcome: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        clearInterval(recheck);
        signal?.removeEventListener('abort', onAbort);
        this.#waiters.delete(waiter);
        outcome();
      };
      const waiter: Waiter = {
        check: () => {
          const binding = bound();
          if (binding === undefined || binding.binding_id !== first.binding_id) {
            finish(() => {
              try {
                notBoundHere(lane);
              } catch (error) {
                reject(error);
              }
            });
            return;
          }
          const pointer = this.#wake(binding, caller.activityKey);
          if (pointer !== null) finish(() => resolve({ pointer }));
        },
        stop: (error) => finish(() => reject(error)),
      };
      const onAbort = () => finish(() => reject(waitCancelled()));
      const deadline = setTimeout(() => finish(() => resolve({ waiting: true })), (seconds as number) * 1_000);
      const recheck = setInterval(() => waiter.check(), this.#recheckMs);
      signal?.addEventListener('abort', onAbort, { once: true });
      this.#waiters.add(waiter);
    });
  }

  /** `events_lane_item`: one item of the caller's lane, since its binding, enveloped as `queue show` gives it. */
  async item(itemId: unknown, caller: LaneWindowIdentity): Promise<{ readonly item: QueueItemV1 }> {
    this.seen(caller);
    const binding = this.#bindingFor(caller);
    if (binding === undefined) return noLaneHere();
    const read = await this.#queue.laneItem(itemId, binding.lane, binding.since);
    // Only an item the window was given is read; a refusal above names nothing and records nothing.
    this.#record(read.item.id, 'read', caller.activityKey);
    return read;
  }

  /** The queue's delivery boundary appended an item: settle every watch and long-poll now rather than on its next look. */
  notifyAppended(): void {
    if (this.#stopped) return;
    this.#settleAll();
  }

  /** The service is stopping: every watch and long-poll ends with it. */
  close(): void {
    this.#stopped = true;
    this.#tasks.clear();
    this.#marks.clear();
    for (const waiter of [...this.#waiters]) waiter.stop(stopped());
  }

  #settleAll(): void {
    for (const task of this.#tasks.values()) this.#settle(task);
    for (const waiter of [...this.#waiters]) waiter.check();
  }

  #task(taskId: unknown, caller: LaneWindowIdentity): Task {
    if (typeof taskId !== 'string' || !TASK_ID.test(taskId)) return noSuchWatch();
    const task = this.#tasks.get(taskId);
    if (task === undefined || !sameWindow(task.owner, caller)) return noSuchWatch();
    return task;
  }

  #settle(task: Task): void {
    if (task.status !== 'working') return;
    const binding = this.#bindings().find((row) => row.lane === task.lane);
    if (binding === undefined || binding.binding_id !== task.bindingId) {
      this.#end(task, 'cancelled', `lane ${task.lane} was unbound from this window, so this watch ended`);
      return;
    }
    const pointer = this.#wake(binding, task.owner.activityKey);
    if (pointer === null) return;
    task.pointer = pointer;
    this.#end(task, 'completed', pointer.text);
  }

  #end(task: Task, status: 'completed' | 'cancelled', message: string): void {
    task.status = status;
    task.statusMessage = message;
    task.lastUpdatedAt = this.#now();
  }

  /**
   * The oldest open item of the binding's lane, after its `since` and past its mark — and the mark moves to it, and the
   * item's history says the window with `windowKey` was woken for it.
   */
  #wake(binding: BindingRow, windowKey: string): LanePointerResultV1 | null {
    const { next, waiting } = this.#queue.laneWake(binding.lane, binding.since, this.#marks.get(binding.binding_id));
    if (next === undefined) return null;
    // The line first: a write that fails leaves the mark where it was, so the item wakes the window on its next look.
    this.#record(next.id, 'woken', windowKey);
    this.#marks.set(binding.binding_id, { appendedAt: next.appendedAt, id: next.id });
    const pointer = { lane: binding.lane, itemId: next.id, channel: next.channel, ruleId: next.ruleId, waiting };
    return {
      lane: binding.lane,
      item: next.id,
      channel: next.channel,
      rule: { id: next.ruleId },
      waiting,
      text: lanePointerText(pointer),
    };
  }

  /** One line of an item's history, by the window with this activity session key. */
  #record(itemId: string, kind: 'woken' | 'read', windowKey: string): void {
    const at = this.#now();
    this.#store.immediate(() =>
      recordQueueHistory(this.#store.database, { itemId, at, kind, by: { actor: 'window', windowKey } }),
    );
  }

  #prune(): void {
    const now = this.#now();
    for (const [id, task] of this.#tasks)
      if (task.status !== 'working' && now - task.lastUpdatedAt > ENDED_TASK_KEEP_MS) this.#tasks.delete(id);
    if (this.#tasks.size < MAX_TASKS) return;
    const ended = [...this.#tasks.values()]
      .filter((task) => task.status !== 'working')
      .sort((left, right) => left.lastUpdatedAt - right.lastUpdatedAt);
    for (const task of ended.slice(0, this.#tasks.size - MAX_TASKS + 1)) this.#tasks.delete(task.taskId);
  }

  #bindings(): readonly BindingRow[] {
    return this.#store.database
      .prepare(
        'SELECT lane, binding_id, session_id, activity_key, folder, client_name, client_version, since FROM lane_bindings ORDER BY lane',
      )
      .all() as unknown as BindingRow[];
  }

  #bindingFor(caller: LaneWindowIdentity): BindingRow | undefined {
    return this.#bindings().find((row) => isBoundWindow(row, caller));
  }

  #carried(): ReadonlyMap<string, { readonly rules: Set<string>; readonly channels: Set<string> }> {
    const lanes = new Map<string, { rules: Set<string>; channels: Set<string> }>();
    for (const row of this.#store.database.prepare(CARRIED_LANES).all() as Array<{
      lane: string;
      rule_id: string;
      channel: string;
    }>) {
      const entry = lanes.get(row.lane) ?? { rules: new Set<string>(), channels: new Set<string>() };
      entry.rules.add(row.rule_id);
      entry.channels.add(row.channel);
      lanes.set(row.lane, entry);
    }
    return lanes;
  }

  /** A reported window by the id the person gave: the most recently seen one with that session id, or that key. */
  #reportedWindow(id: string): WindowRow | undefined {
    const columns = 'activity_key, session_id, grouped, folder, client_name, client_version';
    if (isClaudeCodeSessionId(id))
      return this.#store.database
        .prepare(
          `SELECT ${columns} FROM lane_windows WHERE session_id = ? ORDER BY grouped DESC, last_seen_at DESC LIMIT 1`,
        )
        .get(id) as WindowRow | undefined;
    if (isActivityKey(id))
      return this.#store.database.prepare(`SELECT ${columns} FROM lane_windows WHERE activity_key = ?`).get(id) as
        | WindowRow
        | undefined;
    return undefined;
  }
}

function view(task: Task): LaneTaskV1 {
  return {
    taskId: task.taskId,
    status: task.status,
    createdAt: iso(task.createdAt),
    lastUpdatedAt: iso(task.lastUpdatedAt),
    ...(task.statusMessage === undefined ? {} : { statusMessage: task.statusMessage }),
    ...(task.pointer === undefined ? {} : { pointer: task.pointer }),
  };
}
