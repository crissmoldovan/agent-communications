import type { DatabaseSync } from 'node:sqlite';
import type { FlowLimits } from '@agentcomms/events';
import type { EffectKind } from './contracts.ts';

/*
 * A workflow's hour and day limits (workflows design §7.5, W33): each effect a run makes is one row in
 * `workflow_effects`, counted in its window for the workflow — its `limits`, part of the approved document — and, for
 * sessions, worktrees and events, across every workflow under `workflow_settings`' ceilings. A reached limit holds a
 * step until the window frees; it never drops one. Every count and charge is inside the caller's transaction.
 */

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

interface Window {
  /** The flow's own limit for this kind. */
  readonly limit: keyof FlowLimits;
  readonly windowMs: number;
  /** The ceiling across all workflows, in `workflow_settings`, when there is one. */
  readonly ceiling: 'sessions_per_hour_max' | 'worktrees_per_day_max' | 'events_per_hour_max' | null;
}

const WINDOWS: Readonly<Record<EffectKind, Window>> = Object.freeze({
  run: { limit: 'runsPerHour', windowMs: HOUR_MS, ceiling: null },
  'session-start': { limit: 'sessionsPerHour', windowMs: HOUR_MS, ceiling: 'sessions_per_hour_max' },
  worktree: { limit: 'worktreesPerDay', windowMs: DAY_MS, ceiling: 'worktrees_per_day_max' },
  'linear-write': { limit: 'linearWritesPerHour', windowMs: HOUR_MS, ceiling: null },
  event: { limit: 'eventsPerHour', windowMs: HOUR_MS, ceiling: 'events_per_hour_max' },
});

export type LimitAnswer = { readonly ok: true } | { readonly ok: false; readonly until: number };

/** When a window that holds `max` or more of the charges `sql` reads, oldest first, frees room for one more; or null. */
function freedAt(
  database: DatabaseSync,
  sql: string,
  args: readonly (string | number)[],
  max: number,
  windowMs: number,
) {
  // The charge that must leave the window before one more fits is the (count - max + 1)th oldest.
  const rows = database.prepare(sql).all(...args) as Array<{ at: number }>;
  if (rows.length < max) return null;
  const leaving = rows[rows.length - max] as { at: number };
  return leaving.at + windowMs;
}

/**
 * Whether one more `kind` effect fits now, for `ruleId` under `limits` and across all workflows under the ceilings,
 * without charging it; when it does not, the instant the binding window frees one.
 */
export function limitInTransaction(
  database: DatabaseSync,
  ruleId: string,
  kind: EffectKind,
  limits: FlowLimits,
  now: number,
): LimitAnswer {
  const window = WINDOWS[kind];
  const since = now - window.windowMs;
  const ownMax = limits[window.limit];
  const own = freedAt(
    database,
    'SELECT at FROM workflow_effects WHERE kind = ? AND rule_id = ? AND at > ? ORDER BY at ASC',
    [kind, ruleId, since],
    ownMax,
    window.windowMs,
  );
  let until = own;
  if (window.ceiling !== null) {
    const settings = database
      .prepare(`SELECT ${window.ceiling} AS ceiling FROM workflow_settings WHERE singleton = 1`)
      .get() as { ceiling: number } | undefined;
    const ceiling = settings?.ceiling ?? 0;
    const all =
      ceiling === 0
        ? now + window.windowMs
        : freedAt(
            database,
            'SELECT at FROM workflow_effects WHERE kind = ? AND at > ? ORDER BY at ASC',
            [kind, since],
            ceiling,
            window.windowMs,
          );
    if (all !== null) until = until === null ? all : Math.max(until, all);
  }
  return until === null ? { ok: true } : { ok: false, until: Math.max(until, now + 1) };
}

/**
 * Charges one `kind` effect to `ruleId` when it fits (§7.5), inside the caller's transaction; otherwise says when it
 * will. Charges older than every window are pruned as it goes, so the table holds at most a day of them.
 */
export function chargeInTransaction(
  database: DatabaseSync,
  ruleId: string,
  kind: EffectKind,
  limits: FlowLimits,
  now: number,
): LimitAnswer {
  database.prepare('DELETE FROM workflow_effects WHERE kind = ? AND at <= ?').run(kind, now - WINDOWS[kind].windowMs);
  const answer = limitInTransaction(database, ruleId, kind, limits, now);
  if (!answer.ok) return answer;
  database.prepare('INSERT INTO workflow_effects (rule_id, kind, at) VALUES (?, ?, ?)').run(ruleId, kind, now);
  return answer;
}

/**
 * Whether one more run of `ruleId` may be live (running or waiting) at once: its own `concurrentRuns`, and the
 * ceiling across all workflows.
 */
export function concurrencyAllowsInTransaction(database: DatabaseSync, ruleId: string, limits: FlowLimits): boolean {
  const own = database
    .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE rule_id = ? AND state IN ('running', 'waiting')")
    .get(ruleId) as { count: number };
  if (own.count >= limits.concurrentRuns) return false;
  return globalConcurrencyAllowsInTransaction(database);
}

/** Whether one more run of any workflow may be live, under `workflow_settings.concurrent_runs_max`. */
export function globalConcurrencyAllowsInTransaction(database: DatabaseSync): boolean {
  const all = database
    .prepare("SELECT COUNT(*) AS count FROM workflow_runs WHERE state IN ('running', 'waiting')")
    .get() as { count: number };
  const settings = database.prepare('SELECT concurrent_runs_max FROM workflow_settings WHERE singleton = 1').get() as
    | { concurrent_runs_max: number }
    | undefined;
  return all.count < (settings?.concurrent_runs_max ?? 0);
}
