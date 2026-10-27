import { existsSync } from 'node:fs';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { closedSlotValue } from '../../../domain/flow.ts';
import type { ProjectV1 } from '../../../domain/projects.ts';
import type { EventDatabase } from '../../../store/database.ts';
import { isInside } from '../../agent-sessions.ts';
import type { GitRunner } from '../../git.ts';
import type { Output, StepContext, StepExecutor, StepResult } from '../contracts.ts';
import { candidateChanged } from './route.ts';
import { chosenCandidate } from './session-place.ts';

/**
 * Make a worktree (workflows design §6.6, W14): the one new execution surface, and a local one. Git runs as the person,
 * through the git runner — no shell, no `GIT_*`, `core.hooksPath=/dev/null`, so no hook the repository carries ever
 * runs — as `git worktree add -b <branch> <path> <base>` in the approved checkout of the project the route step chose.
 *
 * The jail: the checkout is one of the version's approved folders, and still the project's; the root — the candidate's
 * worktree root, else `<checkout>-wt` beside it — is no symlink, its own realpath, inside the relay's allowed roots and
 * outside Agent Comms' folders; the path is the root and one slug. After git, `realpath(path)` must be the path, or the
 * worktree is removed (without `--force`) and the step refused. The branch is a template of closed slots only — the
 * run, a step's closed output, a chained run's trigger data — folded to `[a-z0-9/-]` and at most 60 characters, so it
 * never holds what a sender wrote; activation refuses any other slot (`checkFlow`).
 *
 * Idempotency: `workflow_worktrees` records the path, branch and run before git runs. A retry that finds its row adopts
 * the worktree its earlier attempt made; a branch that exists and this run did not make is refused. Cleanup, when the
 * run ends: `keep`, or `remove-if-clean` — `git worktree remove` without `--force`, only when `git status --porcelain`
 * is empty and the branch has no commit its upstream (or, with none, its base) lacks; otherwise it is kept, and why.
 */

/** The longest branch a run makes. */
export const WORKTREE_BRANCH_MAX = 60;
/** Tries while another git holds the index lock. */
export const WORKTREE_INDEX_LOCK_TRIES = 3;

export interface WorktreeStepDeps {
  readonly store: EventDatabase;
  readonly git: GitRunner;
  /** A project as it is now, or null when it is gone. */
  readonly project: (projectId: string) => ProjectV1 | null;
  /** The folders a session may work in: the relay's allowed roots, else the person's. */
  readonly sessionRoots: () => Promise<readonly string[]>;
  /** Agent Comms' own folders. */
  readonly deniedFolders: () => readonly string[];
}

const SLOT = /\{\{([^{}]*)\}\}/gu;
const CLOSED_SLOT =
  /^(?:run|steps\.[a-z][a-z0-9-]{0,31}\.[a-zA-Z][a-zA-Z0-9]{0,63}|trigger(?:\.[a-zA-Z][a-zA-Z0-9-]{0,63}){1,4})$/u;

/** A branch name folded to `[a-z0-9/-]`: no empty step, no leading or trailing `-` or `/`, at most 60 characters. */
export function foldBranch(text: string): string {
  const folded = text
    .toLowerCase()
    .replace(/[^a-z0-9/-]+/gu, '-')
    .split('/')
    .map((step) => step.replace(/-+/gu, '-').replace(/^-|-$/gu, ''))
    .filter((step) => step.length > 0)
    .join('/');
  return folded.slice(0, WORKTREE_BRANCH_MAX).replace(/[-/]+$/u, '');
}

/**
 * The branch a template names, with each slot's value from `slot` — or undefined when a slot is not a closed one (a
 * mapped field a sender wrote, a session's summary), or has no value yet, or the branch folds to nothing.
 */
export function branchOf(template: string, slot: (name: string) => string | null): string | undefined {
  let missing = false;
  const text = template.replace(SLOT, (_whole, name: string) => {
    if (!CLOSED_SLOT.test(name) || name.endsWith('.summary')) {
      missing = true;
      return '';
    }
    const value = slot(name);
    if (value === null) missing = true;
    return value ?? '';
  });
  if (missing || text.includes('{{') || text.includes('}}')) return undefined;
  const branch = foldBranch(text);
  return branch.length === 0 ? undefined : branch;
}

/**
 * A slot's value in this run: the run's id, a settled step's closed output, or the chained run's trigger data — through
 * the one slot resolver every step and target uses (`closedSlotValue`), as text, or null when it has none.
 */
async function slotValues(ctx: StepContext, template: string): Promise<(name: string) => string | null> {
  const trigger = template.includes('{{trigger.') ? await ctx.trigger() : null;
  const flow = ctx.rule.flow;
  return (name) => {
    if (flow === undefined) return null;
    const value = closedSlotValue(name, { runId: ctx.run.id, flow, output: (id) => ctx.output(id), trigger });
    return typeof value === 'string'
      ? value
      : typeof value === 'number' && Number.isFinite(value)
        ? String(value)
        : null;
  };
}

interface WorktreeRow {
  readonly checkout: string;
  readonly path: string;
  readonly branch: string;
  readonly state: 'recording' | 'made' | 'refused' | 'kept' | 'removed';
  readonly reason: string | null;
}

function rowOf(store: EventDatabase, ctx: StepContext): WorktreeRow | undefined {
  return store.database
    .prepare('SELECT checkout, path, branch, state, reason FROM workflow_worktrees WHERE run_id = ? AND step_id = ?')
    .get(ctx.run.id, ctx.stepId) as WorktreeRow | undefined;
}

/** A recording row's outcome, once: what the attempt made, or why it refused. */
function settleRow(store: EventDatabase, ctx: StepContext, state: 'made' | 'refused', reason: string | null): void {
  store.immediate(() =>
    store.database
      .prepare(
        `UPDATE workflow_worktrees SET state = ?, reason = ?, settled_at = ?
          WHERE run_id = ? AND step_id = ? AND state = 'recording'`,
      )
      .run(state, reason, ctx.now(), ctx.run.id, ctx.stepId),
  );
}

function made(branch: string, path: string): StepResult {
  const output: Output = { branch, path, refusal: null };
  return { kind: 'settled', outcome: 'made', output };
}

function refused(branch: string | null, refusal: string): StepResult {
  const output: Output = { branch, path: null, refusal };
  return { kind: 'settled', outcome: 'refused', output };
}

async function isRealFolder(path: string): Promise<boolean> {
  const found = await lstat(path).catch(() => undefined);
  if (found === undefined || found.isSymbolicLink() || !found.isDirectory()) return false;
  return (await realpath(path).catch(() => null)) === path;
}

/** The worktrees git lists for a checkout: each path and its branch. */
async function worktreesOf(
  git: GitRunner,
  checkout: string,
): Promise<readonly { path: string; branch: string | null }[]> {
  const listed = await git.run(['worktree', 'list', '--porcelain'], checkout);
  if (listed.code !== 0) return [];
  return listed.stdout.split(/\n\s*\n/u).flatMap((block) => {
    const path = /^worktree (.+)$/mu.exec(block)?.[1];
    const branch = /^branch refs\/heads\/(.+)$/mu.exec(block)?.[1] ?? null;
    return path === undefined ? [] : [{ path, branch }];
  });
}

async function worktree(ctx: StepContext, deps: WorktreeStepDeps): Promise<StepResult> {
  const step = ctx.step;
  if (step.kind !== 'worktree') return { kind: 'failed', code: 'STEP_KIND' };
  const store = deps.store;
  const now = ctx.now();
  const settle = (state: 'made' | 'refused', reason: string | null) => settleRow(store, ctx, state, reason);
  const refuse = (branch: string | null, reason: string, recorded: boolean): StepResult => {
    if (recorded) settle('refused', reason);
    return refused(branch, reason);
  };

  // An earlier attempt's row: its outcome, or the worktree it was making.
  const earlier = rowOf(store, ctx);
  if (earlier?.state === 'refused') return refused(earlier.branch, earlier.reason ?? 'REFUSED');
  if (earlier !== undefined && earlier.state !== 'recording') return made(earlier.branch, earlier.path);

  const candidate = chosenCandidate(ctx, step.project);
  if (candidate === null) return refuse(null, 'NO_PROJECT', earlier !== undefined);
  const project = deps.project(candidate.projectId);
  if (project === null || candidateChanged(candidate, project))
    return refuse(null, 'PROJECT_CHANGED', earlier !== undefined);
  const checkoutFolder = project.folders.find(
    (folder) => folder.kind === 'checkout' && candidate.folders.includes(folder.folder),
  );
  if (checkoutFolder === undefined) return refuse(null, 'NO_CHECKOUT', earlier !== undefined);
  const checkout = checkoutFolder.folder;
  if (!(await isRealFolder(checkout))) return refuse(null, 'CHECKOUT_MOVED', earlier !== undefined);

  const branch = earlier?.branch ?? branchOf(step.branch, await slotValues(ctx, step.branch));
  if (branch === undefined) return refuse(null, 'BRANCH_SLOT', false);
  const root = candidate.worktreeRoot ?? `${checkout}-wt`;
  const path = earlier?.path ?? join(root, branch.replaceAll('/', '-'));
  if (dirname(path) !== root || basename(path).length === 0) return refuse(branch, 'PATH', earlier !== undefined);

  // The jail: the root is a real folder of its own, inside the allowed roots, outside Agent Comms' folders.
  const denied = deps.deniedFolders();
  if (denied.some((folder) => isInside(root, folder) || isInside(folder, root)))
    return refuse(branch, 'AGENT_COMMS_FOLDER', earlier !== undefined);
  const roots = await deps.sessionRoots();
  if (!roots.some((allowed) => isInside(root, allowed)))
    return refuse(branch, 'OUTSIDE_ALLOWED_ROOTS', earlier !== undefined);
  const rootFound = await lstat(root).catch(() => undefined);
  if (rootFound?.isSymbolicLink() === true) return refuse(branch, 'ROOT_SYMLINK', earlier !== undefined);
  if (rootFound !== undefined && !(await isRealFolder(root)))
    return refuse(branch, 'ROOT_NOT_REAL', earlier !== undefined);
  if (rootFound === undefined && !(await isRealFolder(dirname(root))))
    return refuse(branch, 'ROOT_NOT_REAL', earlier !== undefined);

  if (earlier === undefined) {
    // A branch that is there already, and that this run did not record, is someone else's.
    const exists = await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], checkout);
    if (exists.code === 0) return refused(branch, 'BRANCH_EXISTS');
    const charged = ctx.charge('worktree');
    if (!charged.ok) return { kind: 'wait', wait: 'limit', key: null, wakeAt: charged.until };
    // Recorded before git runs: a retry finds this row and adopts what the attempt made.
    const recorded = store.immediate(() => {
      const taken = store.database.prepare('SELECT 1 FROM workflow_worktrees WHERE path = ?').get(path);
      if (taken !== undefined) return false;
      store.database
        .prepare(
          `INSERT INTO workflow_worktrees (run_id, step_id, project_id, checkout, path, branch, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'recording', ?)`,
        )
        .run(ctx.run.id, ctx.stepId, candidate.projectId, checkout, path, branch, now);
      return true;
    });
    if (!recorded) return refused(branch, 'PATH_IN_USE');
  } else {
    // The earlier attempt may have made it before its answer was lost.
    const listed = await worktreesOf(deps.git, checkout);
    if (listed.some((entry) => entry.path === path && entry.branch === branch)) return adopt(ctx, deps, branch, path);
  }

  await ctx.fence();
  if (rootFound === undefined) await mkdir(root).catch(() => undefined);
  const branchThere =
    (await deps.git.run(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], checkout)).code === 0;
  const base = step.base === 'default' ? (checkoutFolder.defaultBranch ?? 'HEAD') : step.base.branch;
  // This run's branch, made by an attempt that stopped before its worktree: it is checked out, not made again.
  const add = branchThere
    ? await deps.git.run(['worktree', 'add', path, branch], checkout)
    : await deps.git.run(['worktree', 'add', '-b', branch, path, base], checkout);
  if (add.code !== 0) {
    if (existsSync(join(checkout, '.git', 'index.lock')) && ctx.attempt.number < WORKTREE_INDEX_LOCK_TRIES)
      return { kind: 'retry', at: ctx.now() + 2_000, code: 'INDEX_LOCKED' };
    return refuse(branch, existsSync(join(checkout, '.git', 'index.lock')) ? 'INDEX_LOCKED' : 'GIT_FAILED', true);
  }
  return adopt(ctx, deps, branch, path);
}

/** The worktree is where it was computed to be, or it is removed and the step refused; then the row says made. */
async function adopt(ctx: StepContext, deps: WorktreeStepDeps, branch: string, path: string): Promise<StepResult> {
  const where = await realpath(path).catch(() => null);
  const store = deps.store;
  const settle = (state: 'made' | 'refused', reason: string | null) => settleRow(store, ctx, state, reason);
  if (where !== path) {
    const row = rowOf(store, ctx);
    if (row !== undefined) await deps.git.run(['worktree', 'remove', path], row.checkout);
    settle('refused', 'PATH_NOT_REAL');
    return refused(branch, 'PATH_NOT_REAL');
  }
  settle('made', null);
  return made(branch, path);
}

/** Cleanup when the run ends: `remove-if-clean` removes a clean, fully pushed worktree; anything else is kept. */
async function finish(ctx: StepContext, deps: WorktreeStepDeps): Promise<void> {
  try {
    const step = ctx.step;
    if (step.kind !== 'worktree' || step.cleanup !== 'remove-if-clean') return;
    const row = rowOf(deps.store, ctx);
    if (row === undefined || row.state !== 'made') return;
    const keep = (reason: string) =>
      deps.store.immediate(() =>
        deps.store.database
          .prepare(
            `UPDATE workflow_worktrees SET state = 'kept', reason = ?, settled_at = ?
              WHERE run_id = ? AND step_id = ? AND state = 'made'`,
          )
          .run(reason, ctx.now(), ctx.run.id, ctx.stepId),
      );
    if (!existsSync(row.path)) return void keep('GONE');
    const status = await deps.git.run(['status', '--porcelain'], row.path);
    if (status.code !== 0) return void keep('STATUS_FAILED');
    if (status.stdout.trim().length > 0) return void keep('DIRTY');
    // A commit only this branch has — on no other branch and no remote, its upstream among them — is unpushed work.
    const ahead = await deps.git.run(
      ['rev-list', '--count', 'HEAD', '--not', `--exclude=${row.branch}`, '--branches', '--remotes'],
      row.path,
    );
    if (ahead.code !== 0 || Number(ahead.stdout.trim()) > 0) return void keep('UNPUSHED');
    const removed = await deps.git.run(['worktree', 'remove', row.path], row.checkout);
    if (removed.code !== 0) return void keep('REMOVE_FAILED');
    deps.store.immediate(() =>
      deps.store.database
        .prepare(
          `UPDATE workflow_worktrees SET state = 'removed', reason = NULL, settled_at = ?
            WHERE run_id = ? AND step_id = ? AND state = 'made'`,
        )
        .run(ctx.now(), ctx.run.id, ctx.stepId),
    );
  } catch {
    // Cleanup never fails a run: the worktree stays, and the row says made.
  }
}

/** The worktree step's executor. */
export function createWorktreeExecutor(deps: WorktreeStepDeps): StepExecutor<'worktree'> {
  return {
    kind: 'worktree',
    run: (ctx) => worktree(ctx, deps),
    resume: (ctx) => worktree(ctx, deps),
    finish: (ctx) => finish(ctx, deps),
  };
}
