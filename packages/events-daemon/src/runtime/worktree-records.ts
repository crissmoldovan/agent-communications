import { lstat } from 'node:fs/promises';
import type { EventDatabase } from '../store/database.ts';
import type { GitRunner } from './git.ts';

/**
 * The worktree rows of purged runs (0.37.0 §2). An ended run's history goes with its decision's metadata (W7), but a
 * `workflow_worktrees` row in state `made` or `kept` stays: its folder may still be on disk, and Projects reads it
 * (`madeWorktreesOf`). Once its run is purged, the history sweep looks at it here:
 * - a folder that no longer exists loses its row, with no git;
 * - one that is no longer a worktree of the checkout the row names — by `git worktree list --porcelain` of that
 *   checkout, through the event service's git runner (`git.ts`), once per checkout a sweep — loses it too;
 * - a worktree still on disk keeps its row, and Projects keeps showing it: it is the person's to remove;
 * - a row whose folder or checkout can't be read stays for the next sweep.
 *
 * At most 100 rows a sweep, taken in the order of their paths from where the last sweep stopped, so rows that stay never
 * hold the rest back. The history sweep starts one when none runs and the last started 10 minutes ago or more, and does
 * not wait for it: git and the disk are read apart from the owner's tick, as the engine's steps are (§1). A sweep only
 * deletes content-free rows, so it holds no writer lease, and a key rotation never waits for its git.
 */

/** The rows one sweep looks at, at most; the next sweep takes the rest. */
export const WORKTREE_RECORDS_BATCH = 100;
/** How long after one sweep started the history sweep starts the next. */
export const WORKTREE_RECORDS_EVERY_MS: number = 10 * 60_000;

export interface WorktreeRecordSweepOptions {
  readonly store: EventDatabase;
  /** git, as the event service runs it: no shell, no `GIT_*`, no hooks, bounded. */
  readonly git: GitRunner;
  readonly now?: (() => number) | undefined;
}

/** What one sweep did, in counts only. */
export interface WorktreeRecordSweepReport {
  /** The rows it looked at. */
  readonly looked: number;
  /** Rows deleted: the folder is gone, or no longer a worktree of its checkout. */
  readonly deleted: number;
  /** Rows kept: a worktree of its checkout, still on disk. */
  readonly kept: number;
  /** Rows kept because their folder or checkout could not be read: the next sweep looks again. */
  readonly unread: number;
}

const NOTHING: WorktreeRecordSweepReport = Object.freeze({ looked: 0, deleted: 0, kept: 0, unread: 0 });

interface RecordRow {
  readonly run_id: string;
  readonly step_id: string;
  readonly checkout: string;
  readonly path: string;
}

/** Each worktree a porcelain listing names, by its path. */
function listedPaths(porcelain: string): ReadonlySet<string> {
  const paths = new Set<string>();
  for (const line of porcelain.split('\n')) if (line.startsWith('worktree ')) paths.add(line.slice('worktree '.length));
  return paths;
}

/** Whether a path is there: gone (nothing at it, or a parent that is no folder), there, or unread (anything else). */
async function presence(path: string): Promise<'gone' | 'there' | 'unread'> {
  try {
    await lstat(path);
    return 'there';
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return code === 'ENOENT' || code === 'ENOTDIR' ? 'gone' : 'unread';
  }
}

export class WorktreeRecordSweep {
  readonly #store: EventDatabase;
  readonly #git: GitRunner;
  readonly #now: () => number;
  #sweeping: Promise<WorktreeRecordSweepReport> | undefined;
  #startedAt: number | undefined;
  /** The last path the last full batch looked at; the next sweep goes on after it. */
  #after: string | null = null;
  #stopped = false;

  constructor(options: WorktreeRecordSweepOptions) {
    this.#store = options.store;
    this.#git = options.git;
    this.#now = options.now ?? Date.now;
  }

  /**
   * What the history sweep calls (`EventExpiry.sweepAll`): starts a sweep when none runs, it is not stopped, and the last
   * started `WORKTREE_RECORDS_EVERY_MS` ago or more. Returns at once.
   */
  pump(): void {
    if (this.#stopped || this.#sweeping !== undefined) return;
    if (this.#startedAt !== undefined && this.#now() - this.#startedAt < WORKTREE_RECORDS_EVERY_MS) return;
    void this.sweep();
  }

  /** Waits for a sweep in flight, if one is. */
  async idle(): Promise<void> {
    await this.#sweeping;
  }

  /** Starts no more, and waits for a sweep in flight: call it before the event database closes. */
  async stop(): Promise<void> {
    this.#stopped = true;
    await this.idle();
  }

  /** One sweep, now: one at a time, and it never throws. */
  sweep(): Promise<WorktreeRecordSweepReport> {
    if (this.#sweeping !== undefined) return this.#sweeping;
    this.#startedAt = this.#now();
    const running = this.#sweep()
      .catch(() => NOTHING)
      .finally(() => {
        this.#sweeping = undefined;
      });
    this.#sweeping = running;
    return running;
  }

  async #sweep(): Promise<WorktreeRecordSweepReport> {
    const rows = this.#store.database
      .prepare(
        `SELECT run_id, step_id, checkout, path FROM workflow_worktrees
          WHERE state IN ('made', 'kept')
            AND NOT EXISTS (SELECT 1 FROM workflow_runs AS run WHERE run.id = workflow_worktrees.run_id)
            AND path > ?
          ORDER BY path
          LIMIT ?`,
      )
      .all(this.#after ?? '', WORKTREE_RECORDS_BATCH) as unknown as RecordRow[];
    // A full batch goes on after its last row next time; a short one was the end, and the next starts again.
    this.#after = rows.length === WORKTREE_RECORDS_BATCH ? (rows.at(-1) as RecordRow).path : null;
    let deleted = 0;
    let kept = 0;
    let unread = 0;
    const byCheckout = new Map<string, RecordRow[]>();
    for (const row of rows) {
      const found = await presence(row.path);
      if (found === 'gone') deleted += this.#delete(row);
      else if (found === 'unread') unread += 1;
      else byCheckout.set(row.checkout, [...(byCheckout.get(row.checkout) ?? []), row]);
    }
    for (const [checkout, group] of byCheckout) {
      const listed = await this.#git.run(['worktree', 'list', '--porcelain'], checkout);
      // A checkout git can't read — gone, moved, not a repository, too slow — keeps its rows for the next sweep.
      if (listed.code !== 0) {
        unread += group.length;
        continue;
      }
      const worktrees = listedPaths(listed.stdout);
      for (const row of group)
        if (worktrees.has(row.path)) kept += 1;
        else deleted += this.#delete(row);
    }
    return { looked: rows.length, deleted, kept, unread };
  }

  /** Deletes a row that is still one of a purged run's, `made` or `kept`; 1 when it did. */
  #delete(row: RecordRow): number {
    return Number(
      this.#store.immediate(
        () =>
          this.#store.database
            .prepare(
              `DELETE FROM workflow_worktrees
                WHERE run_id = ? AND step_id = ? AND path = ? AND state IN ('made', 'kept')
                  AND NOT EXISTS (SELECT 1 FROM workflow_runs AS run WHERE run.id = workflow_worktrees.run_id)`,
            )
            .run(row.run_id, row.step_id, row.path).changes,
      ),
    );
  }
}
