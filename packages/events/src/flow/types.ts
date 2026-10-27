/**
 * A workflow's flow (workflows design §4.1, W1–W4, W23–W36): the graph a rule version may hold in place of its
 * straight fan-out. Pure data, shared by the event service, which runs it, and the desktop app, which draws it. A
 * workflow without a `flow` is today's straight line, unchanged; `flowOf` draws it, and nothing stores that drawing.
 *
 * A step has a kind, its fields, and a closed set of outcomes; each outcome has an arrow to a step or to `end`, and
 * `otherwise` names every outcome not given. An outcome without an arrow ends that branch. The graph is acyclic, holds
 * 1 to 32 steps, and two branches of one `split` never meet again. `checkFlow` holds all of that.
 */
import type { AgenticConditionV1, CanonicalCondition } from '../conditions/types.ts';
import type { RunEvent } from '../workflow-events/catalogue.ts';

/** A step's id: `^[a-z][a-z0-9-]{0,31}$`, and not one of `RESERVED_STEP_IDS`. Stable from version to version. */
export type StepId = string;

/** Ids no step may take: `run` names a run's own events, `trigger` a chained run's start, `end` and `otherwise` arrows. */
export const RESERVED_STEP_IDS: readonly ['run', 'trigger', 'end', 'otherwise'] = Object.freeze([
  'run',
  'trigger',
  'end',
  'otherwise',
] as const);

/** Every kind of step 0.36 runs. */
export const STEP_KINDS: readonly [
  'condition',
  'judge',
  'route',
  'find-session',
  'start-session',
  'worktree',
  'deliver',
  'wait',
  'notify',
  'split',
  'raise',
] = Object.freeze([
  'condition',
  'judge',
  'route',
  'find-session',
  'start-session',
  'worktree',
  'deliver',
  'wait',
  'notify',
  'split',
  'raise',
] as const);

export type StepKind = (typeof STEP_KINDS)[number];

/**
 * Each kind's closed outcomes, in the order the printer and the designer list their arrows. A split has none: it
 * starts every branch. A wait's are every `for`'s together: a turn's end (`completed`, `failed`, `stopped`, or the
 * word its session reported), a free session (`free`), a time (`elapsed`), and `timed-out` for each.
 */
export const STEP_OUTCOMES: Readonly<Record<Exclude<StepKind, 'split'>, readonly string[]>> = Object.freeze({
  condition: Object.freeze(['yes', 'no']),
  judge: Object.freeze(['yes', 'no', 'unsure']),
  route: Object.freeze(['chosen', 'none', 'unsure']),
  'find-session': Object.freeze(['idle', 'busy', 'none', 'watched']),
  'start-session': Object.freeze(['started', 'refused']),
  worktree: Object.freeze(['made', 'refused']),
  deliver: Object.freeze(['done', 'left-in-queue', 'failed']),
  wait: Object.freeze([
    'completed',
    'failed',
    'stopped',
    'done',
    'needs-the-person',
    'not-mine',
    'blocked',
    'free',
    'elapsed',
    'timed-out',
  ]),
  notify: Object.freeze(['sent']),
  raise: Object.freeze(['raised']),
});

/** The outcomes that are failures (W.3's `failed`): a refused start or worktree, and a failed delivery. */
export const FAILURE_OUTCOMES: Readonly<Partial<Record<StepKind, readonly string[]>>> = Object.freeze({
  'start-session': Object.freeze(['refused']),
  worktree: Object.freeze(['refused']),
  deliver: Object.freeze(['failed']),
});

/** Where an arrow goes: a step, or `end`. */
export type Next = StepId | 'end';

/** A step's arrows: each outcome to a step or `end`; `otherwise` for every outcome not given. */
export type Arrows<O extends string> = Readonly<Partial<Record<O | 'otherwise', Next>>>;

/** Fields every step may carry: the author's label (at most 60 characters) and the events ticked (sorted, unique). */
export interface StepCommon {
  readonly label?: string;
  readonly emit?: readonly string[];
}

/** A project a route step may choose, bound into the approved document by value (W12). */
export interface RouteCandidate {
  projectId: string;
  name: string;
  folders: readonly string[];
  worktreeRoot: string | null;
}

/**
 * Where a session is found or started: in the project a route step chose, in a worktree a worktree step made, in a
 * folder, in the window bound to a lane, or — for `find-session` only, with Claude — the session that took an earlier
 * message in this message's conversation (W36).
 */
export type Place =
  | { readonly project: StepId }
  | { readonly worktree: StepId }
  | { readonly folder: string }
  | { readonly lane: string }
  | { readonly thread: true };

/** A wait's outcomes, every `for`'s together. */
export type WaitOutcome =
  | 'completed'
  | 'failed'
  | 'stopped'
  | 'timed-out'
  | 'done'
  | 'needs-the-person'
  | 'not-mine'
  | 'blocked'
  | 'free'
  | 'elapsed';

/** One step: its kind's fields, its arrows, and the common label and events. */
export type FlowStep = StepCommon &
  (
    | { readonly kind: 'condition'; readonly when: CanonicalCondition; readonly next: Arrows<'yes' | 'no'> }
    | { readonly kind: 'judge'; readonly ask: AgenticConditionV1; readonly next: Arrows<'yes' | 'no' | 'unsure'> }
    | {
        readonly kind: 'route';
        readonly candidates: readonly RouteCandidate[];
        readonly by: readonly ('hints' | 'judge')[];
        readonly judge?: AgenticConditionV1;
        readonly inputs: readonly string[];
        readonly next: Arrows<'chosen' | 'none' | 'unsure'>;
      }
    | {
        readonly kind: 'find-session';
        readonly in: Place;
        readonly provider: 'claude' | 'codex';
        readonly only?: 'idle';
        readonly next: Arrows<'idle' | 'busy' | 'none' | 'watched'>;
      }
    | {
        readonly kind: 'start-session';
        readonly in: Place;
        readonly provider: 'claude' | 'codex';
        readonly mode: 'manual' | 'acceptEdits' | 'plan';
        readonly next: Arrows<'started' | 'refused'>;
      }
    | {
        readonly kind: 'worktree';
        readonly project: StepId;
        readonly base: 'default' | { readonly branch: string };
        readonly branch: string;
        readonly cleanup: 'keep' | 'remove-if-clean';
        readonly next: Arrows<'made' | 'refused'>;
      }
    | {
        readonly kind: 'deliver';
        readonly target: { readonly targetId: string; readonly version: number };
        readonly to?: { readonly session: readonly StepId[] } | { readonly issue: StepId };
        readonly report?: readonly ('done' | 'needs-the-person' | 'not-mine' | 'blocked')[];
        readonly next: Arrows<'done' | 'left-in-queue' | 'failed'>;
      }
    | {
        readonly kind: 'wait';
        readonly for:
          | { readonly turnEnd: StepId }
          | { readonly sessionIdle: StepId }
          | { readonly time: { readonly afterMs: number } };
        readonly timeoutMs: number;
        readonly next: Arrows<WaitOutcome>;
      }
    | { readonly kind: 'notify'; readonly text: string; readonly next: Arrows<'sent'> }
    | { readonly kind: 'split'; readonly branches: readonly StepId[] }
    | {
        readonly kind: 'raise';
        readonly name: string;
        readonly fields?: readonly string[];
        readonly next: Arrows<'raised'>;
      }
  );

/** A flow's per-hour, per-day and per-run limits, written out in full so the digest binds them. */
export interface FlowLimits {
  /** Default 10, at most 60. */
  runsPerHour: number;
  /** Default 2, at most 8. */
  concurrentRuns: number;
  /** Default 2, at most 10. */
  sessionsPerHour: number;
  /** Default 5, at most 20. */
  worktreesPerDay: number;
  /** Default 30, at most 120. */
  linearWritesPerHour: number;
  /** Default 120, at most 600 (W33). */
  eventsPerHour: number;
  /** A run's deadline: default 3 days, at most 30. */
  runMs: number;
}

/** Where a workflow's events are named (W24), and which of the run's own it raises. */
export interface FlowEvents {
  readonly namespace: string;
  readonly workflow: string;
  readonly run?: readonly RunEvent[];
}

/** A chained workflow's start (W34): the raised events that start it, and how long it waits for one. */
export interface FlowOn {
  readonly raised: readonly string[];
  readonly withinMs: number;
}

/** The `flow` a workflow document may hold (§4.1). */
export interface FlowDocumentV1 {
  readonly flowVersion: 1;
  readonly start: StepId;
  /** 1 to 32 steps. */
  readonly steps: Readonly<Record<StepId, FlowStep>>;
  readonly limits: FlowLimits;
  /** Required when any step emits or raises, or a run event is ticked. */
  readonly events?: FlowEvents;
  readonly on?: FlowOn;
  /** Every effect becomes a dry-run record (§7.7). */
  readonly shadow?: true;
}

/** The limits a flow has when its author says nothing (Q11, W33). */
export const FLOW_LIMIT_DEFAULTS: FlowLimits = Object.freeze({
  runsPerHour: 10,
  concurrentRuns: 2,
  sessionsPerHour: 2,
  worktreesPerDay: 5,
  linearWritesPerHour: 30,
  eventsPerHour: 120,
  runMs: 259_200_000,
});

/** The most each limit may be. */
export const FLOW_LIMIT_CEILINGS: FlowLimits = Object.freeze({
  runsPerHour: 60,
  concurrentRuns: 8,
  sessionsPerHour: 10,
  worktreesPerDay: 20,
  linearWritesPerHour: 120,
  eventsPerHour: 600,
  runMs: 2_592_000_000,
});

/** The graph's fixed bounds (W4, W23, W34, §7.5). */
export const FLOW_BOUNDS: {
  steps: 32;
  executedPerRun: 64;
  splitMin: 2;
  splitMax: 8;
  labelMax: 60;
  onRaisedMax: 8;
  chainDepthMax: 3;
  onWithinDefaultMs: 86_400_000;
} = Object.freeze({
  steps: 32,
  executedPerRun: 64,
  splitMin: 2,
  splitMax: 8,
  labelMax: 60,
  onRaisedMax: 8,
  chainDepthMax: 3,
  onWithinDefaultMs: 86_400_000,
} as const);

/** Why `checkFlow` refused a flow. */
export type FlowProblemCode =
  | 'FLOW_CYCLE'
  | 'FLOW_UNREACHABLE'
  | 'FLOW_SPLIT_MEETS'
  | 'FLOW_SPLIT_BRANCHES'
  | 'FLOW_TOO_MANY_STEPS'
  | 'FLOW_STEP_ID'
  | 'FLOW_START'
  | 'FLOW_ARROW'
  | 'FLOW_OUTCOME'
  | 'FLOW_EMIT_UNKNOWN'
  | 'FLOW_EVENTS_MISSING'
  | 'FLOW_RAISE_NAME'
  | 'FLOW_LIMIT'
  | 'FLOW_ON_PATTERN'
  | 'FLOW_LABEL'
  | 'FLOW_SHAPE'
  /** `{ thread: true }` anywhere but `find-session` (W36). */
  | 'FLOW_PLACE';

/** One thing wrong with a flow: its code, the words to show, the step it is in, and where (an RFC 6901 pointer). */
export interface FlowProblem {
  code: FlowProblemCode;
  message: string;
  stepId: StepId | null;
  pointer: string | null;
}
