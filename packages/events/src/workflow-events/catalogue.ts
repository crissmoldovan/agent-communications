/**
 * The step event catalogue, version 1 (workflows design, Appendix W.3; normative): for each `dataschema`, the standard
 * words its kind can raise, its own words, and the closed `outputs` its events carry. It is separate from Appendix A,
 * which stays the contract for source events, and it is closed: no implementation may add an event, an output or an
 * outcome word, or widen a type, without catalogue version 2.
 *
 * The literal is transcribed by hand from Appendix W.3, in the table's order, and pinned byte for byte by
 * `test/fixtures/workflow-events-v1.json`.
 */
import type { FlowStep } from '../flow/types.ts';
import { EventsError } from '../result.ts';

/** The standard words (W.3): first claimed, settled, failed, waiting, no longer reachable, retrying. */
export const STANDARD_STEP_EVENTS: readonly ['started', 'succeeded', 'failed', 'waiting', 'skipped', 'retrying'] =
  Object.freeze(['started', 'succeeded', 'failed', 'waiting', 'skipped', 'retrying'] as const);

/** A run's own words, raised when the run enters that state, and ticked in `flow.events.run`. */
export const RUN_EVENTS: readonly ['started', 'held', 'finished', 'failed', 'cancelled', 'expired'] = Object.freeze([
  'started',
  'held',
  'finished',
  'failed',
  'cancelled',
  'expired',
] as const);

/** One of a run's own words. */
export type RunEvent = (typeof RUN_EVENTS)[number];

/** A step event's `dataschema`, after `urn:agentcomms:workflow-events:v1:`. */
export type WorkflowEventSchema =
  | 'run'
  | 'step.condition'
  | 'step.judge'
  | 'step.route'
  | 'step.find-session'
  | 'step.start-session'
  | 'step.worktree'
  | 'step.deliver.session'
  | 'step.deliver.linear'
  | 'step.deliver.linear-change'
  | 'step.deliver.webhook'
  | 'step.deliver.sse'
  | 'step.deliver.queue'
  | 'step.deliver.dry-run'
  | 'step.wait'
  | 'step.notify'
  | 'step.split'
  | 'raise';

type CatalogueEntry = { standard: readonly string[]; own: readonly string[]; outputs: readonly string[] };

const ALL_SIX = STANDARD_STEP_EVENTS;

function entry(standard: readonly string[], own: readonly string[], outputs: readonly string[]): CatalogueEntry {
  return Object.freeze({
    standard: Object.freeze([...standard]),
    own: Object.freeze([...own]),
    outputs: Object.freeze([...outputs]),
  });
}

/**
 * Appendix W.3, exactly. `raise` has no standard words and no fixed own word: its one event is the Raise step's
 * `name`, which `eventsFor` gives for that step. `step.wait`'s own words are every `for`'s, in the table's order:
 * a turn's end (`finished`, `timed-out`), a free session (`free`, `timed-out`) and a time (`elapsed`).
 */
export const WORKFLOW_EVENT_CATALOGUE_V1: Readonly<
  Record<WorkflowEventSchema, { standard: readonly string[]; own: readonly string[]; outputs: readonly string[] }>
> = Object.freeze({
  run: entry([], RUN_EVENTS, ['steps', 'endCode']),
  'step.condition': entry(['started', 'succeeded', 'skipped'], ['matched', 'not-matched'], []),
  'step.judge': entry(ALL_SIX, ['yes', 'no', 'unsure'], ['score']),
  'step.route': entry(ALL_SIX, ['matched', 'none', 'unsure'], ['project', 'projectName', 'reason', 'score']),
  'step.find-session': entry(
    ['started', 'succeeded', 'failed', 'skipped', 'retrying'],
    ['found', 'busy', 'not-found', 'watched'],
    ['session', 'provider'],
  ),
  'step.start-session': entry(ALL_SIX, ['session-started', 'refused'], ['session', 'provider', 'mode', 'refusal']),
  'step.worktree': entry(ALL_SIX, ['made', 'refused'], ['branch', 'refusal']),
  'step.deliver.session': entry(ALL_SIX, ['given', 'left-in-queue'], ['delivery', 'session', 'turn', 'ahead']),
  'step.deliver.linear': entry(ALL_SIX, ['created'], ['delivery', 'issue']),
  'step.deliver.linear-change': entry(
    ALL_SIX,
    ['changed', 'commented', 'closed'],
    ['delivery', 'issue', 'changed', 'state'],
  ),
  'step.deliver.webhook': entry(ALL_SIX, ['delivered'], ['delivery', 'status']),
  'step.deliver.sse': entry(ALL_SIX, ['delivered'], ['delivery']),
  'step.deliver.queue': entry(ALL_SIX, ['delivered'], ['delivery']),
  'step.deliver.dry-run': entry(ALL_SIX, ['delivered'], ['delivery']),
  'step.wait': entry(
    ['started', 'succeeded', 'waiting', 'skipped'],
    ['finished', 'timed-out', 'free', 'elapsed'],
    ['for', 'reported'],
  ),
  'step.notify': entry(['started', 'succeeded', 'skipped'], ['notified'], ['raised']),
  'step.split': entry(['started', 'succeeded', 'skipped'], [], ['branches']),
  raise: entry([], [], ['name', 'fields']),
});

/** The target kinds a deliver step's schema names, `step.deliver.<kind>`. */
const DELIVER_KINDS: readonly string[] = Object.freeze([
  'session',
  'linear',
  'linear-change',
  'webhook',
  'sse',
  'queue',
  'dry-run',
]);

/**
 * The schema of a step's events: `run` for the run's own (`step` null), `raise` for a Raise step, and
 * `step.deliver.<kind>` for a deliver step, whose kind is its target's. A deliver step without a known target kind has
 * no schema, and is refused.
 */
export function schemaOf(step: FlowStep | null, targetKind?: string): WorkflowEventSchema {
  if (step === null) return 'run';
  if (step.kind === 'raise') return 'raise';
  if (step.kind === 'deliver') {
    if (targetKind === undefined || !DELIVER_KINDS.includes(targetKind))
      throw new EventsError(
        'WORKFLOW_EVENT_INVALID',
        `a deliver step's events follow its target's kind: ${DELIVER_KINDS.join(', ')}`,
      );
    return `step.deliver.${targetKind}` as WorkflowEventSchema;
  }
  return `step.${step.kind}` as WorkflowEventSchema;
}

/** A wait's own words by what it waits for (W.3). */
const WAIT_WORDS: Readonly<Record<'turnEnd' | 'sessionIdle' | 'time', readonly string[]>> = Object.freeze({
  turnEnd: Object.freeze(['finished', 'timed-out']),
  sessionIdle: Object.freeze(['free', 'timed-out']),
  time: Object.freeze(['elapsed']),
});

/**
 * Every event a step of this schema can raise: its standard words, then its own, in W.3's order. Given the step, a
 * wait's own words narrow to what it waits for, and a Raise step's one event is its `name`.
 */
export function eventsFor(schema: WorkflowEventSchema, step?: FlowStep): readonly string[] {
  const known = WORKFLOW_EVENT_CATALOGUE_V1[schema];
  if (known === undefined) throw new EventsError('WORKFLOW_EVENT_INVALID', `${schema} is not a step event schema`);
  if (schema === 'raise') return step?.kind === 'raise' ? [step.name] : [];
  if (schema === 'step.wait' && step?.kind === 'wait') {
    const waitsFor = Object.keys(step.for)[0] as keyof typeof WAIT_WORDS | undefined;
    const own = waitsFor === undefined ? undefined : WAIT_WORDS[waitsFor];
    if (own !== undefined) return [...known.standard, ...own];
  }
  return [...known.standard, ...known.own];
}

/** A Linear change's done, by what it did (W.3): closed, then changed, then commented. */
function linearChangeWord(detail?: { changed?: readonly string[]; stateType?: string }): string {
  if (detail?.stateType === 'completed' || detail?.stateType === 'canceled') return 'closed';
  const changed = detail?.changed ?? [];
  if (changed.length > 0 && changed.every((what) => what === 'comment')) return 'commented';
  return 'changed';
}

const OUTCOME_WORDS: Readonly<Partial<Record<WorkflowEventSchema, Readonly<Record<string, string>>>>> = Object.freeze({
  run: {
    running: 'started',
    held: 'held',
    done: 'finished',
    failed: 'failed',
    cancelled: 'cancelled',
    expired: 'expired',
  },
  'step.condition': { yes: 'matched', no: 'not-matched' },
  'step.judge': { yes: 'yes', no: 'no', unsure: 'unsure' },
  'step.route': { chosen: 'matched', none: 'none', unsure: 'unsure' },
  'step.find-session': { idle: 'found', busy: 'busy', none: 'not-found', watched: 'watched' },
  'step.start-session': { started: 'session-started', refused: 'refused' },
  'step.worktree': { made: 'made', refused: 'refused' },
  'step.deliver.session': { done: 'given', 'left-in-queue': 'left-in-queue' },
  'step.deliver.linear': { done: 'created' },
  'step.deliver.webhook': { done: 'delivered' },
  'step.deliver.sse': { done: 'delivered' },
  'step.deliver.queue': { done: 'delivered' },
  'step.deliver.dry-run': { done: 'delivered' },
  'step.wait': {
    completed: 'finished',
    failed: 'finished',
    stopped: 'finished',
    done: 'finished',
    'needs-the-person': 'finished',
    'not-mine': 'finished',
    blocked: 'finished',
    free: 'free',
    elapsed: 'elapsed',
    'timed-out': 'timed-out',
  },
  'step.notify': { sent: 'notified' },
});

/**
 * The own word a step raises with an outcome (W.3's mapping): `idle` is `found`, `none` is `not-found`, `yes` and
 * `chosen` are `matched`, deliver's `done` is `given`, `created` or `delivered`, a Linear change's `done` is `closed`,
 * `changed` or `commented` by what it did, and every turn-end outcome but `timed-out` is `finished`. For `run`, the
 * outcome is the run's state. Null when the outcome has no own word: a failure that only `failed` reports, a split, a
 * Raise step (whose event is its name).
 */
export function eventForOutcome(
  schema: WorkflowEventSchema,
  outcome: string,
  detail?: { changed?: readonly string[]; stateType?: string },
): string | null {
  if (schema === 'step.deliver.linear-change') return outcome === 'done' ? linearChangeWord(detail) : null;
  const words = OUTCOME_WORDS[schema];
  if (words === undefined || !Object.hasOwn(words, outcome)) return null;
  return words[outcome] ?? null;
}
