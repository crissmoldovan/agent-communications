import type { FlowStep, JsonValue } from '@agentcomms/events';
import type { EventDatabase } from '../../../store/database.ts';
import type { ReadyRelay } from '../../agent-sessions.ts';
import type { ProjectionCipher } from '../../projections.ts';
import type { RelaySnapshotV1 } from '../../relay-client.ts';
import type { StepContext, StepExecutor, StepResult, WakeReason } from '../contracts.ts';
import { addRunSummary } from '../runs.ts';

/*
 * The wait step (workflows design W9, §6.5, §7.3; plan B4): a turn's end, a free session, or a time — each a row, not a
 * process, and each with its timeout within the run's deadline. A turn's end is the turn the deliver step it names
 * gave: `completed`, `failed` or `stopped`; or, when that step asked for a report, the word the session reported, or
 * `failed` when the turn ended without one — and the session's summary, which an agent wrote, is sealed in the run's
 * record and never in the step's output. A free session is `free` when the session the find step it names chose has no
 * live turn. A time is `elapsed`. Each is `timed-out` at its timeout. The relay's stream ends turn and session waits
 * (`RelayWaits`); a wait that finds the relay down keeps waiting, and the follower finds what it missed.
 */

/** The most of a session's summary that is kept. */
const SUMMARY_MAX = 2_000;

type WaitStep = Extract<FlowStep, { kind: 'wait' }>;

export interface WaitDeps {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  /** The person's relay, ready; it throws when it cannot be used. */
  readonly relay: () => Promise<ReadyRelay>;
}

function text(value: JsonValue | undefined): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** When the step's timeout ends: its first claim plus its timeout, within the run's deadline. */
function deadline(deps: WaitDeps, ctx: StepContext, step: WaitStep): number {
  const row = deps.store.database
    .prepare('SELECT started_at FROM workflow_steps WHERE run_id = ? AND step_id = ?')
    .get(ctx.run.id, ctx.stepId) as { started_at: number | null } | undefined;
  return Math.min((row?.started_at ?? ctx.now()) + step.timeoutMs, ctx.run.expiresAt);
}

async function snapshotOf(
  deps: WaitDeps,
  session: string,
): Promise<{ ready: ReadyRelay; snapshot: RelaySnapshotV1 | null } | null> {
  try {
    const ready = await deps.relay();
    return { ready, snapshot: await ready.client.snapshot(session) };
  } catch {
    return null;
  }
}

/** How the turn ended, once it has: the session's reported word when the step asked for one, else its status. */
async function turnEnded(
  deps: WaitDeps,
  ctx: StepContext,
  step: WaitStep,
  turnEnd: string,
  turn: string,
  session: string,
): Promise<StepResult> {
  const seen = await snapshotOf(deps, session);
  // The relay cannot say now: the step waits on, to its deadline, and the follower finds the end when it is back.
  if (seen === null) return { kind: 'wait', wait: 'turn-end', key: turn, wakeAt: deadline(deps, ctx, step) };
  const { ready, snapshot } = seen;
  if (snapshot !== null && snapshot.session.activeRunId === turn)
    return { kind: 'wait', wait: 'turn-end', key: turn, wakeAt: deadline(deps, ctx, step) };
  const status = snapshot?.runs.find((run) => run.id === turn)?.status ?? null;
  const deliver = ctx.rule.flow?.steps[turnEnd];
  const report = deliver?.kind === 'deliver' ? deliver.report : undefined;
  if (report !== undefined) {
    let reported: string | null = null;
    try {
      const final = (await ready.client.structuredFinal(session, turn)) as {
        readonly outcome?: unknown;
        readonly summary?: unknown;
      } | null;
      if (typeof final?.outcome === 'string' && (report as readonly string[]).includes(final.outcome)) {
        reported = final.outcome;
        if (typeof final.summary === 'string' && final.summary.length > 0)
          await addRunSummary(deps.store, deps.cipher, ctx.run.id, ctx.stepId, final.summary.slice(0, SUMMARY_MAX));
      }
    } catch {
      // A result the relay cannot give now is a turn that ended without a report: `failed`, never a reported word.
    }
    return reported === null
      ? { kind: 'settled', outcome: 'failed', output: { for: 'turn-end', reported: null } }
      : { kind: 'settled', outcome: reported, output: { for: 'turn-end', reported } };
  }
  const outcome = status === 'completed' ? 'completed' : status === 'failed' ? 'failed' : 'stopped';
  return { kind: 'settled', outcome, output: { for: 'turn-end', reported: null } };
}

async function waited(deps: WaitDeps, ctx: StepContext, wake: WakeReason | null): Promise<StepResult> {
  if (ctx.step.kind !== 'wait') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
  const step = ctx.step;
  const waitsFor = step.for;
  if ('time' in waitsFor) {
    if (wake?.kind === 'time')
      return {
        kind: 'settled',
        outcome: waitsFor.time.afterMs <= step.timeoutMs ? 'elapsed' : 'timed-out',
        output: { for: 'time', reported: null },
      };
    const started = deadline(deps, ctx, step) - step.timeoutMs;
    return {
      kind: 'wait',
      wait: 'time',
      key: null,
      wakeAt: Math.min(started + Math.min(waitsFor.time.afterMs, step.timeoutMs), ctx.run.expiresAt),
    };
  }
  if (wake?.kind === 'time') {
    const kind = 'turnEnd' in waitsFor ? 'turn-end' : 'session-idle';
    return { kind: 'settled', outcome: 'timed-out', output: { for: kind, reported: null } };
  }
  if ('sessionIdle' in waitsFor) {
    const session = text(ctx.output(waitsFor.sessionIdle)?.session);
    if (session === null) return { kind: 'failed', code: 'NO_SESSION' };
    // The relay's record that a turn ended is only a cue: the session as the relay holds it now says whether it is free,
    // so a record repeated, or one a turn that started since outlived, frees nothing.
    const seen = await snapshotOf(deps, session);
    // No live turn — the session is gone, or it has none — is free; its deliver step then finds what is there.
    if (seen !== null && (seen.snapshot === null || seen.snapshot.session.activeRunId === undefined))
      return { kind: 'settled', outcome: 'free', output: { for: 'session-idle', reported: null } };
    // Busy, or the relay down: it waits, to its deadline, for the session to come free.
    return { kind: 'wait', wait: 'session-idle', key: session, wakeAt: deadline(deps, ctx, step) };
  }
  const given = ctx.output(waitsFor.turnEnd);
  const turn = text(given?.turn);
  const session = text(given?.session);
  // The deliver step gave no turn — the message waited in the Queue, or failed: there is no turn to wait for.
  if (turn === null || session === null)
    return { kind: 'settled', outcome: 'failed', output: { for: 'turn-end', reported: null } };
  return turnEnded(deps, ctx, step, waitsFor.turnEnd, turn, session);
}

/** The wait step's executor: the relay for a turn's end or a free session, the clock for a time. */
export function createWaitExecutor(deps: WaitDeps): StepExecutor<'wait'> {
  return {
    kind: 'wait',
    run: (ctx: StepContext) => waited(deps, ctx, null),
    resume: (ctx: StepContext, wake: WakeReason) => waited(deps, ctx, wake),
  };
}
