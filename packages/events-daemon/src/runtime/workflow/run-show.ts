import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { type FlowDocumentV1, STEP_KINDS, type StepKind, stepOrder } from '@agentcomms/events';
import { canonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import { personSetupApprover } from '../../domain/judge-setup.ts';
import type { EventDatabase } from '../../store/database.ts';
import type { Output, RunView, WaitKind } from './contracts.ts';
import type { RunCancelResultV1 } from './engine.ts';
import type { RunRow, StepRow } from './runs.ts';

/*
 * A workflow's runs as the person sees them (workflows design §7.6, §11.2; plan B6, I6): `runs list`, `runs show` and
 * `runs cancel`, CLI and app only. Every one is the person's: the owner takes them only without a window's caller and
 * from a person's origin, as projects are, and no MCP tool reads or cancels a run. What they read is content-free — the
 * run's state, its steps' closed outcomes and outputs, its waits and the events it raised — except for the folders a
 * step's output names (a worktree's path), which `runs show` gives the person and no event ever carries (W26).
 *
 * A run keeps its version's graph: `runs show` names its `ruleVersion`, and each step it lists is that version's, of
 * that version's kind, even after the workflow is edited (the review focus of the plan).
 */

/** A run's states (spec §7.1, `workflow_runs.state`). */
export const RUN_STATES: readonly ['held', 'running', 'waiting', 'done', 'failed', 'cancelled', 'expired'] =
  Object.freeze(['held', 'running', 'waiting', 'done', 'failed', 'cancelled', 'expired'] as const);
export type RunState = (typeof RUN_STATES)[number];

/** A step's states in a run (spec §7.1, `workflow_steps.state`). */
export const RUN_STEP_STATES: readonly ['ready', 'running', 'waiting', 'done', 'failed', 'skipped', 'cancelled'] =
  Object.freeze(['ready', 'running', 'waiting', 'done', 'failed', 'skipped', 'cancelled'] as const);
export type RunStepState = (typeof RUN_STEP_STATES)[number];

/** What a run waits on (`workflow_waits.kind`). */
export const RUN_WAIT_KINDS: readonly ['turn-end', 'session-idle', 'time', 'limit'] = Object.freeze([
  'turn-end',
  'session-idle',
  'time',
  'limit',
] as const);

/** A raised event's states (`workflow_events.state`). */
export const RUN_EVENT_STATES: readonly ['open', 'done', 'expired', 'cancelled'] = Object.freeze([
  'open',
  'done',
  'expired',
  'cancelled',
] as const);

/**
 * The closed codes a run ends with (`workflow_runs.end_code`) when the run itself ends it, not a step: its deadline,
 * the person, the switch, a revoked version, an account removed, and 64 executed steps. A run that ends failed on a
 * step carries that step's own code, or `STEP_FAILED` for an unhandled failure outcome; one whose authority the fence
 * found gone at a step carries the fence's reason (`RULE_REVOKED` and its kin). A run done carries none.
 */
export const RUN_END_CODES: readonly [
  'RUN_EXPIRED',
  'CANCELLED_BY_PERSON',
  'DISABLED_ALL',
  'AUTHORIZATION_REVOKED',
  'ACCOUNT_REMOVED',
  'STEP_LIMIT',
  'STEP_FAILED',
] = Object.freeze([
  'RUN_EXPIRED',
  'CANCELLED_BY_PERSON',
  'DISABLED_ALL',
  'AUTHORIZATION_REVOKED',
  'ACCOUNT_REMOVED',
  'STEP_LIMIT',
  'STEP_FAILED',
] as const);

/** The most runs `runs list` gives, newest first. */
export const RUNS_LIST_MAX = 200;

/** A run id: `wfr_` and 26 lowercase Crockford base-32 characters. */
export const RUN_ID_PATTERN: RegExp = /^wfr_[0-9a-hjkmnp-tv-z]{26}$/u;

/** A run's live wait, as the run view says it: "Waiting for acme-site · Claude Code, 1 ahead". */
export interface RunWaitingV1 {
  readonly stepId: string;
  readonly kind: WaitKind;
  readonly since: number;
  readonly ahead: number | null;
  readonly needsYouInClaudeStream: boolean;
}

/** One run, as `runs list` lists it (plan I6). */
export interface RunListEntryV1 {
  readonly runId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly state: RunState;
  readonly startedAt: number;
  readonly updatedAt: number;
  readonly endCode: string | null;
  readonly eventId: string;
  readonly parentRunId: string | null;
  readonly depth: number;
  readonly shadow: boolean;
  readonly waiting: RunWaitingV1 | null;
}

/** `runs list`: newest first, at most 200. */
export interface RunsListResultV1 {
  readonly runs: readonly RunListEntryV1[];
}

/** One step of a run, of the run's own version. */
export interface RunStepV1 {
  readonly stepId: string;
  readonly kind: StepKind;
  readonly state: RunStepState;
  readonly outcome: string | null;
  readonly attempts: number;
  readonly startedAt: number | null;
  readonly settledAt: number | null;
  readonly output: Output | null;
  readonly lastErrorCode: string | null;
  readonly deliveryId: string | null;
  readonly wait: { readonly kind: WaitKind; readonly since: number; readonly wakeAt: number } | null;
}

/** One event a run raised, and who it was delivered to. */
export interface RunEventV1 {
  readonly eventId: string;
  readonly type: string;
  readonly raisedAt: number;
  readonly state: (typeof RUN_EVENT_STATES)[number];
  readonly deliveries: readonly {
    readonly subscriberId: string;
    readonly subscriberVersion: number;
    readonly state: string;
  }[];
}

/** `runs show`: the run, the path it took, each step it reached, and the events it raised (plan I6). */
export interface RunShowResultV1 extends RunListEntryV1 {
  readonly path: readonly string[];
  readonly notRaised: number;
  readonly steps: readonly RunStepV1[];
  readonly events: readonly RunEventV1[];
}

export type { RunCancelResultV1 };

/** A run's version's flow, read once per call: the graph the run started on (W10). */
type FlowOf = (row: Pick<RunRow, 'rule_id' | 'rule_version'>) => FlowDocumentV1 | null;

function flowReader(database: DatabaseSync): FlowOf {
  const flows = new Map<string, FlowDocumentV1 | null>();
  return (row) => {
    const key = `${row.rule_id}@${row.rule_version}`;
    if (flows.has(key)) return flows.get(key) ?? null;
    const stored = database
      .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
      .get(row.rule_id, row.rule_version) as { document: string } | undefined;
    let flow: FlowDocumentV1 | null = null;
    try {
      flow = stored === undefined ? null : (canonicalFullRuleDocument(JSON.parse(stored.document)).flow ?? null);
    } catch {
      flow = null;
    }
    flows.set(key, flow);
    return flow;
  };
}

function isWaitKind(value: unknown): value is WaitKind {
  return typeof value === 'string' && (RUN_WAIT_KINDS as readonly string[]).includes(value);
}

function isStepKind(value: unknown): value is StepKind {
  return typeof value === 'string' && (STEP_KINDS as readonly string[]).includes(value);
}

function outputOf(row: Pick<StepRow, 'output'>): Output | null {
  if (row.output === null) return null;
  try {
    const value = JSON.parse(row.output) as unknown;
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Output) : null;
  } catch {
    return null;
  }
}

/** The steps of `steps` in the run's version's printed order, then any it does not name, by id. */
function inOrder(flow: FlowDocumentV1 | null, steps: readonly StepRow[]): readonly StepRow[] {
  const order = flow === null ? [] : stepOrder(flow);
  const at = (id: string) => {
    const index = order.indexOf(id);
    return index === -1 ? order.length : index;
  };
  return [...steps].sort(
    (left, right) => at(left.step_id) - at(right.step_id) || (left.step_id < right.step_id ? -1 : 1),
  );
}

/**
 * What a live run waits on, if anything: its first waiting step, in its version's order, with a wait row (a turn's
 * end, a free session, a time, a reached limit), or whose delivery waits in a busy session's queue. `since` is when the
 * step began (the run's start for a held run's start step), or when its delivery joined the queue; `ahead` is the
 * step's own count, when its output keeps one, else the queue's items before it plus the turn the session is on.
 */
function waitingOf(database: DatabaseSync, run: RunRow, steps: readonly StepRow[]): RunWaitingV1 | null {
  if (run.state !== 'held' && run.state !== 'running' && run.state !== 'waiting') return null;
  for (const step of steps) {
    if (step.state !== 'waiting') continue;
    const output = outputOf(step);
    const counted = typeof output?.ahead === 'number' && Number.isSafeInteger(output.ahead) ? output.ahead : null;
    const needsYou = output?.needsYouInClaudeStream === true;
    const wait = database
      .prepare('SELECT kind FROM workflow_waits WHERE run_id = ? AND step_id = ?')
      .get(run.id, step.step_id) as { kind: string } | undefined;
    if (wait !== undefined && isWaitKind(wait.kind))
      return {
        stepId: step.step_id,
        kind: wait.kind,
        since: step.started_at ?? run.started_at,
        ahead: counted,
        needsYouInClaudeStream: needsYou,
      };
    if (step.delivery_id === null) continue;
    const queued = database
      .prepare('SELECT relay_session_id, queued_at FROM session_queue WHERE delivery_id = ? AND released_at IS NULL')
      .get(step.delivery_id) as { relay_session_id: string; queued_at: number } | undefined;
    if (queued === undefined) continue;
    const before = database
      .prepare(
        `SELECT COUNT(*) AS count FROM session_queue
          WHERE relay_session_id = ? AND released_at IS NULL
            AND (queued_at < ? OR (queued_at = ? AND delivery_id < ?))`,
      )
      .get(queued.relay_session_id, queued.queued_at, queued.queued_at, step.delivery_id) as { count: number };
    return {
      stepId: step.step_id,
      kind: 'session-idle',
      since: queued.queued_at,
      ahead: counted ?? before.count + 1,
      needsYouInClaudeStream: needsYou,
    };
  }
  return null;
}

function entryOf(database: DatabaseSync, run: RunRow, steps: readonly StepRow[]): RunListEntryV1 {
  return {
    runId: run.id,
    ruleId: run.rule_id,
    ruleVersion: run.rule_version,
    state: run.state,
    startedAt: run.started_at,
    updatedAt: run.updated_at,
    endCode: run.end_code,
    eventId: run.event_id,
    parentRunId: run.parent_run_id,
    depth: run.depth,
    shadow: run.shadow === 1,
    waiting: waitingOf(database, run, steps),
  };
}

function stepsOf(database: DatabaseSync, runId: string): readonly StepRow[] {
  return database.prepare('SELECT * FROM workflow_steps WHERE run_id = ?').all(runId) as unknown as StepRow[];
}

/** `runs list`: newest first, at most 200, of one workflow or in one state when asked. */
export function listRuns(
  database: DatabaseSync,
  filter: { readonly ruleId?: string | undefined; readonly state?: RunState | undefined } = {},
): RunsListResultV1 {
  const where: string[] = [];
  const values: string[] = [];
  if (filter.ruleId !== undefined) {
    where.push('rule_id = ?');
    values.push(filter.ruleId);
  }
  if (filter.state !== undefined) {
    where.push('state = ?');
    values.push(filter.state);
  }
  const rows = database
    .prepare(
      `SELECT * FROM workflow_runs ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`}
        ORDER BY started_at DESC, id DESC LIMIT ${RUNS_LIST_MAX}`,
    )
    .all(...values) as unknown as RunRow[];
  const flowOf = flowReader(database);
  return { runs: rows.map((run) => entryOf(database, run, inOrder(flowOf(run), stepsOf(database, run.id)))) };
}

/** `runs show`: one run, of its own version, with its path, its steps and the events it raised. */
export function showRun(database: DatabaseSync, runId: string): RunShowResultV1 {
  const run = database.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as RunRow | undefined;
  if (run === undefined)
    throw new CommsError('NOT_FOUND', 'no run has this id', { details: { reason: 'RUN_UNKNOWN' } });
  const flow = flowReader(database)(run);
  const rows = inOrder(flow, stepsOf(database, run.id));
  const waits = new Map(
    (
      database.prepare('SELECT step_id, kind, wake_at FROM workflow_waits WHERE run_id = ?').all(run.id) as Array<{
        step_id: string;
        kind: string;
        wake_at: number;
      }>
    ).map((wait) => [wait.step_id, wait]),
  );
  const steps: RunStepV1[] = [];
  for (const row of rows) {
    // Each step is the run's version's, of that version's kind: a step the version does not name is not shown.
    const kind = flow?.steps[row.step_id]?.kind;
    if (!isStepKind(kind)) continue;
    const wait = waits.get(row.step_id);
    steps.push({
      stepId: row.step_id,
      kind,
      state: row.state,
      outcome: row.outcome,
      attempts: row.attempts,
      startedAt: row.started_at,
      settledAt: row.settled_at,
      output: outputOf(row),
      lastErrorCode: row.last_error_code,
      deliveryId: row.delivery_id,
      wait:
        wait !== undefined && isWaitKind(wait.kind)
          ? { kind: wait.kind, since: row.started_at ?? run.started_at, wakeAt: wait.wake_at }
          : null,
    });
  }
  const path = rows
    .filter((row) => (row.state === 'done' || row.state === 'failed') && row.settle_seq !== null)
    .sort((left, right) => (left.settle_seq as number) - (right.settle_seq as number))
    .map((row) => row.step_id);
  const events = (
    database
      .prepare('SELECT id, type, raised_at, state FROM workflow_events WHERE run_id = ? ORDER BY sequence')
      .all(run.id) as Array<{ id: string; type: string; raised_at: number; state: RunEventV1['state'] }>
  ).map((event) => ({
    eventId: event.id,
    type: event.type,
    raisedAt: event.raised_at,
    state: event.state,
    deliveries: (
      database
        .prepare(
          `SELECT subscriber_id, subscriber_version, state FROM event_deliveries
            WHERE event_id = ? ORDER BY subscriber_id, subscriber_version`,
        )
        .all(event.id) as Array<{ subscriber_id: string; subscriber_version: number; state: string }>
    ).map((delivery) => ({
      subscriberId: delivery.subscriber_id,
      subscriberVersion: delivery.subscriber_version,
      state: delivery.state,
    })),
  }));
  return {
    ...entryOf(database, run, rows),
    path,
    notRaised: run.events_not_raised,
    steps,
    events,
  };
}

/**
 * `runs cancel --interrupt`'s reach into the relay (spec §7.6): every turn this run's deliveries started in a session,
 * interrupted through `POST /v1/runs/:id/interrupt`. True when the relay interrupted one; false when there was none,
 * none was still live, or the relay could not be reached — the run is cancelled either way.
 */
export function relayTurnInterrupter(deps: {
  readonly store: EventDatabase;
  readonly relay: () => Promise<{ readonly client: { interruptRun(runId: string): Promise<boolean> } }>;
}): (run: RunView) => Promise<boolean> {
  return async (run) => {
    const turns = (
      deps.store.database
        .prepare(
          `SELECT DISTINCT session.run_id AS turn FROM session_deliveries AS session
             JOIN deliveries AS delivery ON delivery.id = session.delivery_id
            WHERE delivery.run_id = ? AND session.run_id IS NOT NULL
            ORDER BY session.run_id`,
        )
        .all(run.id) as Array<{ turn: string }>
    ).map((row) => row.turn);
    if (turns.length === 0) return false;
    let interrupted = false;
    try {
      const ready = await deps.relay();
      for (const turn of turns) if (await ready.client.interruptRun(turn).catch(() => false)) interrupted = true;
    } catch {
      return interrupted;
    }
    return interrupted;
  };
}

/** The run wires (plan I6). */
export const RUN_CONTROL_OPERATIONS: readonly ['runs-list', 'run-show', 'run-cancel'] = Object.freeze([
  'runs-list',
  'run-show',
  'run-cancel',
] as const);

/** What the owner gives `runControl`: its database, and its engine's cancel. */
export interface RunControlDeps {
  readonly store: EventDatabase;
  readonly cancel: (runId: string, input: { readonly interrupt: boolean }) => Promise<RunCancelResultV1>;
}

function runIdOf(value: unknown): string {
  if (typeof value !== 'string' || !RUN_ID_PATTERN.test(value))
    throw new CommsError('USAGE', 'a run id is wfr_ and 26 lowercase letters and digits');
  return value;
}

/**
 * The owner's one call for every run wire: the person's alone. A window's call (`caller`) is refused, and so is any
 * client that is not the person's — the terminal, or the app — as projects are.
 */
export async function runControl(
  deps: RunControlDeps,
  request: {
    readonly operation: string;
    readonly args: Readonly<Record<string, unknown>>;
    readonly origin?: string | undefined;
  },
): Promise<unknown> {
  if (Object.hasOwn(request.args, 'caller'))
    throw new CommsError(
      'APPROVAL_REQUIRED',
      'runs are for a person, at a terminal or in the app, not an agent window',
    );
  if (personSetupApprover(request.origin) === null)
    throw new CommsError('APPROVAL_REQUIRED', 'runs are your own, from the app or your terminal', {
      details: { reason: 'PERSON_SETUP_ONLY' },
    });
  const args = request.args;
  const only = (...keys: string[]) => {
    for (const key of Object.keys(args))
      if (!keys.includes(key)) throw new CommsError('USAGE', `${request.operation} takes no ${key}`);
  };
  switch (request.operation) {
    case 'runs-list': {
      only('ruleId', 'state');
      const ruleId = args.ruleId;
      if (ruleId !== undefined && (typeof ruleId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(ruleId)))
        throw new CommsError('USAGE', 'a workflow id is letters, digits and . _ : -');
      const state = args.state;
      if (state !== undefined && !(RUN_STATES as readonly unknown[]).includes(state))
        throw new CommsError('USAGE', `a run's state is ${RUN_STATES.join(', ')}`);
      return listRuns(deps.store.database, {
        ...(ruleId === undefined ? {} : { ruleId: ruleId as string }),
        ...(state === undefined ? {} : { state: state as RunState }),
      });
    }
    case 'run-show':
      only('runId');
      return showRun(deps.store.database, runIdOf(args.runId));
    case 'run-cancel': {
      only('runId', 'interrupt');
      if (args.interrupt !== undefined && typeof args.interrupt !== 'boolean')
        throw new CommsError('USAGE', 'interrupt is true or false');
      return deps.cancel(runIdOf(args.runId), { interrupt: args.interrupt === true });
    }
    default:
      throw new CommsError('USAGE', 'the local event control operation is not recognised');
  }
}
