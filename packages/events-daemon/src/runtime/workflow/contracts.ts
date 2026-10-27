import type { DatabaseSync } from 'node:sqlite';
import type { AgenticConditionV1, FlowStep, JsonValue, StepId, StepKind } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';

/*
 * The engine's contracts (workflows design §5, plan I4): what the engine, each step kind's executor, the event sink and
 * every track's composition agree on. Types only, and `NO_WORKFLOW_EVENTS`: the engine runs steps through one executor
 * per kind, every state change in one transaction, and each track plugs in through a `WorkflowComposition`.
 */

/** What a workflow's hour and day counters count (`workflow_effects.kind`). */
export type EffectKind = 'run' | 'session-start' | 'worktree' | 'linear-write' | 'event';

/** What a waiting step waits for (`workflow_waits.kind`): a turn's end, a free session, a time, or a reached limit. */
export type WaitKind = 'turn-end' | 'session-idle' | 'time' | 'limit';

/** A settled step's closed output (plan I5): ids and closed words only, never a sender's text. */
export type Output = Readonly<Record<string, JsonValue>>;

/**
 * The message a run is about, as its sealed record keeps it when its flow looks for the session that took the
 * conversation (W36): the channel's own ids — Gmail's message id, Slack's `<channel>/<ts>`, Resend's email id — and its
 * thread (Gmail's thread id, Slack's `<channel>/<parent ts>`), or null. Never anything a sender wrote.
 */
export interface RunMessage {
  readonly id: string;
  readonly thread: string | null;
}

/** A run as an executor sees it: content-free. */
export interface RunView {
  id: string;
  ruleId: string;
  ruleVersion: number;
  accountId: string;
  eventId: string;
  depth: number;
  parentRunId: string | null;
  startedAt: number;
  expiresAt: number;
  shadow: boolean;
}

/** A judge's answer to a step: a word and its score, a wait for its budget, or a closed failure. */
export type JudgeAnswer =
  | { kind: 'answer'; said: 'yes' | 'no' | 'unsure'; score: number | null }
  | { kind: 'wait'; until: number }
  | { kind: 'failed'; code: string };

/** What an executor is given for one attempt of one step. */
export interface StepContext {
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly attempt: { id: string; number: number };
  readonly now: () => number;
  /** The run's mapped values, unsealed. */
  fields(): Promise<Readonly<Record<string, JsonValue>>>;
  /** A chained run's `/trigger`, else null. */
  trigger(): Promise<Output | null>;
  /** The message this run is about, when its record keeps it (a flow that finds by thread, W36); else null. */
  message?(): Promise<RunMessage | null>;
  /** A settled step's closed output. */
  output(stepId: StepId): Output | null;
  charge(kind: 'session-start' | 'worktree' | 'linear-write'): { ok: true } | { ok: false; until: number };
  judge(ask: AgenticConditionV1, inputs: Readonly<Record<string, JsonValue>>, question?: string): Promise<JudgeAnswer>;
  /** Throws CommsError APPROVAL_VOID when the version's authority, or its account, is gone. */
  fence(): Promise<void>;
}

/** What an attempt comes to: an outcome, a wait, a delivery to insert, a retry, or a failure. */
export type StepResult =
  | { kind: 'settled'; outcome: string; output: Output }
  | { kind: 'wait'; wait: WaitKind; key: string | null; wakeAt: number; output?: Output }
  /** Deliver steps only: B inserts the row and waits for it to settle. */
  | { kind: 'deliver'; delivery: FlowDeliveryRequest }
  | { kind: 'retry'; at: number; code: string }
  | { kind: 'failed'; code: string };

/** Why a waiting step is woken. */
export type WakeReason =
  | { kind: 'time' }
  | { kind: 'limit' }
  | { kind: 'relay'; event: 'run-ended' | 'session-idle'; key: string; detail: Output }
  | { kind: 'delivery'; deliveryId: string; state: string; code: string | null };

/** One step kind's executor. */
export interface StepExecutor<K extends StepKind = StepKind> {
  readonly kind: K;
  run(ctx: StepContext): Promise<StepResult>;
  resume(ctx: StepContext, wake: WakeReason): Promise<StepResult>;
  /** When the run ends: a worktree's cleanup, a wait's listener. Never throws. */
  finish?(ctx: StepContext, runState: 'done' | 'failed' | 'cancelled' | 'expired'): Promise<void>;
}

/** The executors the engine runs, one per kind. */
export interface StepExecutors {
  register(executor: StepExecutor): void;
  get(kind: StepKind): StepExecutor;
}

/** A run's own transitions, each of which may raise a run event (W.3). */
export type RunTransition =
  | 'run-started'
  | 'run-held'
  | 'run-finished'
  | 'run-failed'
  | 'run-cancelled'
  | 'run-expired';

/** One transition of a step, or of the run (`stepId` null), as the engine commits it. */
export interface StepTransition {
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId | null;
  readonly transition: 'started' | 'succeeded' | 'failed' | 'waiting' | 'skipped' | 'retrying' | RunTransition;
  readonly outcome: string | null;
  readonly output: Output | null;
  readonly attempt: number;
  readonly index: number;
  readonly path: readonly StepId[];
  readonly durationMs: number | null;
  readonly error: string | null;
  readonly nextAt: number | null;
  readonly wait: { kind: WaitKind; since: number } | null;
  readonly at: number;
}

/** What the sink prepared for a batch of transitions. Opaque to the engine. */
export interface PreparedEvents {
  readonly rows: readonly unknown[];
}

/**
 * Where every transition's ticked events go (§9.1): built and sealed before the engine's transaction, and written
 * inside it, so an event is raised exactly when its transition commits.
 */
export interface WorkflowEventSink {
  /** Builds and seals, outside any transaction. */
  prepare(transitions: readonly StepTransition[]): Promise<PreparedEvents>;
  commitInTransaction(database: DatabaseSync, prepared: PreparedEvents): void;
}

/** The sink when nothing raises events: it prepares no rows and writes nothing. */
export const NO_WORKFLOW_EVENTS: WorkflowEventSink = Object.freeze({
  prepare: async (_transitions: readonly StepTransition[]): Promise<PreparedEvents> => ({ rows: [] }),
  commitInTransaction: (_database: DatabaseSync, _prepared: PreparedEvents): void => {},
});

/** A deliver step's delivery, for the engine to insert as one delivery row of its run. */
export interface FlowDeliveryRequest {
  stepId: StepId;
  target: { targetId: string; version: number };
  session?: string;
  issue?: { id: string; identifier: string; url: string };
  report?: readonly string[];
}

/** Throws EventDomainError to refuse; runs inside B1's assertFlowActivation, after its own checks. */
export type FlowActivationCheck = (rule: CanonicalFullRuleDocument, database: DatabaseSync) => void | Promise<void>;

/** What each track hands the owner. */
export interface WorkflowComposition {
  executors: readonly StepExecutor[];
  sink?: WorkflowEventSink;
  onRunEnded?: (run: RunView) => Promise<void>;
  activationChecks?: readonly FlowActivationCheck[];
}
