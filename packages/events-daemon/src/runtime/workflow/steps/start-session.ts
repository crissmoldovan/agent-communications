import { isInside } from '../../agent-sessions.ts';
import { RelayError } from '../../relay-client.ts';
import type { Output, StepContext, StepExecutor, StepResult } from '../contracts.ts';
import type { SessionStepDeps } from './find-session.ts';
import { newestFirst, relayRetry, resolvePlace } from './session-place.ts';

/**
 * Start a session (workflows design §6.3, §7.4, W6): `POST /v1/sessions { provider, cwd, requestedMode, title }` in the
 * place the step names — a project's checkout, a worktree this run made, or a folder — charged to the version's
 * `sessionsPerHour`, which holds the step when it is reached and never drops it. The folder is checked here as at
 * activation: its realpath inside the relay's allowed roots and outside Agent Comms' own folders, or the step is
 * `refused` and nothing is started. `acceptEdits` is taken only in a worktree this run made.
 *
 * A run starts at most one session per start step. The relay takes no create key, so the title carries this run's
 * marker — `Agent Comms · <workflow> · <run, 8 characters>` — and every attempt first lists the sessions: one with the
 * marker in this folder is the one an earlier attempt made before its answer was lost, and it is adopted, never made
 * again. Of two with the marker, the newer is adopted and the other named (`alsoStarted`), for the run view.
 */

/** The title a run's session is started under: its marker. */
export function sessionTitle(ctx: StepContext): string {
  return `Agent Comms · ${ctx.rule.ruleId} · ${ctx.run.id.slice(4, 12)}`;
}

function refused(provider: string, mode: string, refusal: string): StepResult {
  const output: Output = { session: null, provider, mode, refusal };
  return { kind: 'settled', outcome: 'refused', output };
}

function started(provider: string, mode: string, session: string, others: readonly string[]): StepResult {
  const output: Output = {
    session,
    provider,
    mode,
    refusal: null,
    ...(others.length === 0 ? {} : { alsoStarted: [...others] }),
  };
  return { kind: 'settled', outcome: 'started', output };
}

async function start(ctx: StepContext, deps: SessionStepDeps): Promise<StepResult> {
  const step = ctx.step;
  if (step.kind !== 'start-session') return { kind: 'failed', code: 'STEP_KIND' };
  const { provider, mode } = step;
  if (mode === 'acceptEdits' && !('worktree' in step.in))
    return refused(provider, mode, 'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE');
  const place = await resolvePlace(ctx, step.in);
  if (place.kind === 'nowhere') return refused(provider, mode, place.why);
  if (place.kind !== 'folders') return refused(provider, mode, 'PLACE');
  const cwd = place.checkout ?? place.folders[0];
  if (cwd === undefined) return refused(provider, mode, 'FOLDER_MISSING');
  if (deps.deniedFolders().some((folder) => isInside(cwd, folder) || isInside(folder, cwd)))
    return refused(provider, mode, 'AGENT_COMMS_FOLDER');
  const title = sessionTitle(ctx);
  try {
    const ready = await deps.relay();
    const { client } = ready;
    const roots = await deps.sessionRoots(ready);
    if (!roots.some((root) => isInside(cwd, root))) return refused(provider, mode, 'OUTSIDE_ALLOWED_ROOTS');
    // An earlier attempt may have made it, and lost the answer: adopt it rather than make a second.
    const marked = (await client.sessions())
      .filter((session) => session.title === title && session.cwd === cwd && session.provider === provider)
      .sort(newestFirst);
    const [adopted, ...others] = marked;
    if (adopted !== undefined)
      return started(
        provider,
        mode,
        adopted.id,
        others.map((session) => session.id),
      );
    const charged = ctx.charge('session-start');
    if (!charged.ok) return { kind: 'wait', wait: 'limit', key: null, wakeAt: charged.until };
    await ctx.fence();
    const session = await client.createSession({ provider, cwd, requestedMode: mode, title });
    return started(provider, mode, session.id, []);
  } catch (error) {
    if (!(error instanceof RelayError)) throw error;
    // The relay's own no — outside its roots, not offered (501), not available (503) — is the step's refusal.
    if (error.reason === 'RELAY_REFUSED' && error.status !== 401 && error.status !== 403)
      return refused(provider, mode, 'RELAY_REFUSED');
    if (error.reason === 'RELAY_FAILED' && (error.status === 501 || error.status === 503))
      return refused(provider, mode, `RELAY_${error.status}`);
    return relayRetry(ctx, error);
  }
}

/** The start-session step's executor. */
export function createStartSessionExecutor(deps: SessionStepDeps): StepExecutor<'start-session'> {
  return { kind: 'start-session', run: (ctx) => start(ctx, deps), resume: (ctx) => start(ctx, deps) };
}
