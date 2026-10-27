import { isPromptableSession, type RelayClient, RelayError, type RelaySessionV1 } from '../../relay-client.ts';
import type { Output, StepContext, StepExecutor, StepResult } from '../contracts.ts';
import { lastActive, newestFirst, relayRetry, resolvePlace } from './session-place.ts';

/**
 * Find a session (workflows design §6.2): a relay session in the place the step names, run by its provider. Of
 * several, the most recently active wins; with `only: 'idle'` a busy one is passed over, so the step finds `idle` or
 * `none` — the prototype's "Find another session". `busy` is a session with a live run, `watched` a window the relay
 * only watches, which takes no prompt. It reads only: it starts nothing and prompts nothing. A relay that cannot be
 * used is tried again, 12 times in all, then the step fails with the relay's reason.
 *
 * The output is find's closed one: the relay session's id, or null, and the provider. No folder.
 */

/** Snapshots read per find, at most: claude-stream lists no status or cwd filter, so each candidate costs one. */
export const FIND_CANDIDATES_MAX = 8;

/** The person's relay, checked ready: what a session step asks of it. */
export interface StepRelay {
  readonly client: Pick<RelayClient, 'sessions' | 'snapshot' | 'createSession'>;
}

export interface SessionStepDeps {
  /** The person's relay, checked ready; refused with a `RelayError` when it cannot be used. */
  readonly relay: () => Promise<StepRelay>;
  /** The folders a session may work in: the relay's allowed roots (asked of `ready`), else the person's. */
  readonly sessionRoots: (ready?: StepRelay) => Promise<readonly string[]>;
  /** Agent Comms' own folders: no session works in them. */
  readonly deniedFolders: () => readonly string[];
  /** The window bound to a lane: its Claude Code session id, and since when; null when none is. */
  readonly laneBinding: (lane: string) => { readonly sessionId: string | null; readonly since: number } | null;
}

function found(outcome: 'idle' | 'busy' | 'none' | 'watched', session: string | null, provider: string): StepResult {
  const output: Output = { session, provider };
  return { kind: 'settled', outcome, output };
}

async function find(ctx: StepContext, deps: SessionStepDeps): Promise<StepResult> {
  const step = ctx.step;
  if (step.kind !== 'find-session') return { kind: 'failed', code: 'STEP_KIND' };
  const none = () => found('none', null, step.provider);
  const place = await resolvePlace(ctx, step.in);
  if (place.kind === 'nowhere') return none();
  // The session that took this conversation (W36) comes with 0.35's takes: until then it finds none.
  if (place.kind === 'thread') return none();
  try {
    const { client } = await deps.relay();
    const sessions = await client.sessions();
    let matching: RelaySessionV1[];
    if (place.kind === 'lane') {
      const binding = deps.laneBinding(place.lane);
      // No window, a window with no Claude Code session id, or a run from before the binding: no session.
      if (binding === null || binding.sessionId === null || ctx.run.startedAt < binding.since) return none();
      matching = sessions.filter(
        (session) => session.nativeSessionId === binding.sessionId && session.provider === step.provider,
      );
    } else {
      const folders = new Set(place.folders);
      matching = sessions.filter((session) => session.provider === step.provider && folders.has(session.cwd));
    }
    const snapshots = [];
    for (const candidate of matching.filter(isPromptableSession).slice(0, FIND_CANDIDATES_MAX)) {
      const snapshot = await client.snapshot(candidate.id);
      if (snapshot !== null && isPromptableSession(snapshot.session)) snapshots.push(snapshot);
    }
    snapshots.sort(
      (left, right) => lastActive(right) - lastActive(left) || (left.session.id < right.session.id ? -1 : 1),
    );
    if (step.only === 'idle') {
      const idle = snapshots.find((snapshot) => snapshot.session.activeRunId === undefined);
      return idle === undefined ? none() : found('idle', idle.session.id, step.provider);
    }
    const best = snapshots[0];
    if (best !== undefined)
      return found(best.session.activeRunId === undefined ? 'idle' : 'busy', best.session.id, step.provider);
    const watched = matching.filter((session) => session.attached === 'observer').sort(newestFirst)[0];
    return watched === undefined ? none() : found('watched', watched.id, step.provider);
  } catch (error) {
    if (error instanceof RelayError) return relayRetry(ctx, error);
    throw error;
  }
}

/** The find-session step's executor. */
export function createFindSessionExecutor(deps: SessionStepDeps): StepExecutor<'find-session'> {
  return { kind: 'find-session', run: (ctx) => find(ctx, deps), resume: (ctx) => find(ctx, deps) };
}
