import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import type { FlowDocumentV1, Place, RouteCandidate } from '@agentcomms/events';
import type { RelayError, RelaySessionV1, RelaySnapshotV1 } from '../../relay-client.ts';
import { SESSION_RETRY_LIMIT } from '../../session-dispatcher.ts';
import type { StepContext, StepResult } from '../contracts.ts';

/**
 * Where a workflow's session step looks (workflows design §6.2, §6.3): the folders a place names, worked out from the
 * run's own closed outputs and its approved version — never from anything a sender wrote. A project is the candidate
 * the route step chose, with every folder the version approved for it, and every worktree this run made of it; a
 * worktree is the one a worktree step made; a folder is itself. Each is its realpath, as the relay reports a session's
 * `cwd`. A lane is the window bound to it; this conversation (`{ thread: true }`) is the session that took it.
 */

const MAX_BACKOFF_MS = 30 * 60_000;

/** What a place resolves to. */
export type ResolvedPlace =
  | { readonly kind: 'folders'; readonly folders: readonly string[]; readonly checkout: string | null }
  | { readonly kind: 'lane'; readonly lane: string }
  | { readonly kind: 'thread' }
  | { readonly kind: 'nowhere'; readonly why: string };

function flowOf(ctx: StepContext): FlowDocumentV1 | undefined {
  return (ctx.rule as { readonly flow?: FlowDocumentV1 }).flow;
}

/** The candidate a route step chose in this run, as its version approved it, or null. */
export function chosenCandidate(ctx: StepContext, routeStepId: string): RouteCandidate | null {
  const route = flowOf(ctx)?.steps[routeStepId];
  if (route === undefined || route.kind !== 'route') return null;
  const chosen = ctx.output(routeStepId)?.project;
  if (typeof chosen !== 'string') return null;
  return route.candidates.find((candidate) => candidate.projectId === chosen) ?? null;
}

/** The path a worktree step of this run made, or null. */
export function madeWorktree(ctx: StepContext, worktreeStepId: string): string | null {
  const step = flowOf(ctx)?.steps[worktreeStepId];
  if (step === undefined || step.kind !== 'worktree') return null;
  const path = ctx.output(worktreeStepId)?.path;
  return typeof path === 'string' && path.startsWith('/') ? path : null;
}

async function real(path: string): Promise<string | null> {
  try {
    return await realpath(path);
  } catch {
    return null;
  }
}

/** Whether `folder` is a checkout: its `.git` is a folder (a worktree's is a file). */
async function isCheckout(folder: string): Promise<boolean> {
  return (await lstat(join(folder, '.git')).catch(() => undefined))?.isDirectory() === true;
}

export async function resolvePlace(ctx: StepContext, place: Place): Promise<ResolvedPlace> {
  if ('thread' in place) return { kind: 'thread' };
  if ('lane' in place) return { kind: 'lane', lane: place.lane };
  if ('folder' in place) {
    const folder = await real(place.folder);
    return folder === null
      ? { kind: 'nowhere', why: 'FOLDER_MISSING' }
      : { kind: 'folders', folders: [folder], checkout: null };
  }
  if ('worktree' in place) {
    const made = madeWorktree(ctx, place.worktree);
    const folder = made === null ? null : await real(made);
    return folder === null
      ? { kind: 'nowhere', why: 'NO_WORKTREE' }
      : { kind: 'folders', folders: [folder], checkout: null };
  }
  const candidate = chosenCandidate(ctx, place.project);
  if (candidate === null) return { kind: 'nowhere', why: 'NO_PROJECT' };
  const folders: string[] = [];
  let checkout: string | null = null;
  for (const folder of candidate.folders) {
    const found = await real(folder);
    if (found === null || folders.includes(found)) continue;
    folders.push(found);
    if (checkout === null && (await isCheckout(found))) checkout = found;
  }
  // And the worktrees this run made of that project.
  for (const [stepId, step] of Object.entries(flowOf(ctx)?.steps ?? {})) {
    if (step.kind !== 'worktree' || step.project !== place.project) continue;
    const made = madeWorktree(ctx, stepId);
    const found = made === null ? null : await real(made);
    if (found !== null && !folders.includes(found)) folders.push(found);
  }
  return folders.length === 0 ? { kind: 'nowhere', why: 'FOLDER_MISSING' } : { kind: 'folders', folders, checkout };
}

/** When a relay session was last active: now, while it runs; else its newest start or end. */
export function lastActive(snapshot: RelaySnapshotV1): number {
  if (snapshot.session.activeRunId !== undefined) return Number.POSITIVE_INFINITY;
  const times = [snapshot.session.createdAt, ...snapshot.runs.flatMap((run) => [run.createdAt, run.endedAt ?? ''])]
    .map((value) => Date.parse(value))
    .filter((value) => Number.isFinite(value));
  return Math.max(0, ...times);
}

export function newestFirst(left: RelaySessionV1, right: RelaySessionV1): number {
  return (
    Date.parse(right.createdAt) - Date.parse(left.createdAt) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0)
  );
}

/**
 * A relay that cannot be used, again later: with the session target's backoff, 12 tries in all
 * (`session-dispatcher.ts`), and then `failed` with the relay's closed reason.
 */
export function relayRetry(ctx: StepContext, error: RelayError): StepResult {
  if (ctx.attempt.number >= SESSION_RETRY_LIMIT) return { kind: 'failed', code: error.reason };
  const at = ctx.now() + Math.min(1_000 * 2 ** Math.max(0, ctx.attempt.number - 1), MAX_BACKOFF_MS);
  return { kind: 'retry', at, code: error.reason };
}
