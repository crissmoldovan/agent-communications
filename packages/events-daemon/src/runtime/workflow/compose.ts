import type { ApprovalStore, ConfigStore, Notifier } from '@agentcomms/core';
import type { EventDatabase } from '../../store/database.ts';
import type { ReadyRelay } from '../agent-sessions.ts';
import type { ProjectionCipher } from '../projections.ts';
import type { WriterQuiescer } from '../writer-quiescer.ts';
import {
  type FlowActivationCheck,
  NO_WORKFLOW_EVENTS,
  type PreparedEvents,
  type RunView,
  type StepContext,
  type StepExecutor,
  type StepTransition,
  type WorkflowComposition,
  type WorkflowEventSink,
} from './contracts.ts';
import { type JudgedAttempt, WorkflowEngine, type WorkflowFailpoint } from './engine.ts';
import { createStepExecutors } from './executors.ts';
import { conditionExecutor } from './steps/condition.ts';
import { createDeliverExecutor, createFlowDeliveries } from './steps/deliver.ts';
import { judgeExecutor } from './steps/judge.ts';
import { notifyExecutor } from './steps/notify.ts';
import { splitExecutor } from './steps/split.ts';
import { createWaitExecutor } from './steps/wait.ts';

/*
 * The one place the owner makes its workflow engine (workflows plan B2): Track B's own executors — condition, judge,
 * deliver, wait, split and notify — then each track's composition: its executors, its
 * event sink, its hook for a run's end and its activation checks. A kind is registered once, so one composition can
 * never replace another's executor.
 */

/** What the owner gives the engine: its database, cipher, fences' stores, clock, lease and the person's notifier. */
export interface WorkflowOwnerDeps {
  readonly store: EventDatabase;
  readonly cipher: ProjectionCipher;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly notifier: Notifier;
  readonly writerQuiescer?: WriterQuiescer | undefined;
  readonly now?: (() => number) | undefined;
  /** `runs cancel --interrupt` (plan B6): interrupts the turns a run's deliveries started, through the relay. */
  readonly interrupt?: ((run: RunView) => Promise<boolean>) | undefined;
  /** Test seam only: a crash at a point of a step's life. */
  readonly failpoint?: ((point: WorkflowFailpoint) => void) | undefined;
  /**
   * Test seam only: executors that stand in for a kind's own — a test's route or deliver — in place of whichever
   * composition registers that kind.
   */
  readonly standIns?: readonly StepExecutor[] | undefined;
  /** B3's judging call, for one attempt of one step. */
  readonly judgeFor?: ((attempt: JudgedAttempt) => StepContext['judge']) | undefined;
  /** The person's claude-stream relay, for a wait on a turn's end or a free session (B4). */
  readonly relay?: (() => Promise<ReadyRelay>) | undefined;
  /** Told when a step starts waiting on the relay, so its follower follows (B4). */
  readonly onRelayWait?: (() => void) | undefined;
}

/** Several compositions' sinks as one: each prepares its own rows, and each writes them in the same transaction. */
function joinedSink(sinks: readonly WorkflowEventSink[]): WorkflowEventSink {
  if (sinks.length === 0) return NO_WORKFLOW_EVENTS;
  if (sinks.length === 1) return sinks[0] as WorkflowEventSink;
  return {
    async prepare(transitions: readonly StepTransition[]): Promise<PreparedEvents> {
      const prepared: PreparedEvents[] = [];
      for (const sink of sinks) prepared.push(await sink.prepare(transitions));
      return { rows: prepared };
    },
    commitInTransaction(database, prepared): void {
      for (const [index, sink] of sinks.entries())
        sink.commitInTransaction(database, (prepared.rows[index] as PreparedEvents | undefined) ?? { rows: [] });
    },
  };
}

export function composeWorkflows(deps: WorkflowOwnerDeps, parts: readonly WorkflowComposition[]): WorkflowEngine {
  const executors = createStepExecutors();
  const stoodIn = new Set((deps.standIns ?? []).map((executor) => executor.kind));
  for (const executor of deps.standIns ?? []) executors.register(executor);
  const register = (executor: StepExecutor) => {
    if (!stoodIn.has(executor.kind)) executors.register(executor);
  };
  register(conditionExecutor);
  register(judgeExecutor);
  register(createDeliverExecutor({ store: deps.store }));
  register(
    createWaitExecutor({
      store: deps.store,
      cipher: deps.cipher,
      relay:
        deps.relay ??
        (async () => {
          throw new Error('no relay is composed for this engine');
        }),
    }),
  );
  register(splitExecutor);
  register(notifyExecutor(deps.notifier));
  for (const part of parts) for (const executor of part.executors) register(executor);
  const sinks = parts.flatMap((part) => (part.sink === undefined ? [] : [part.sink]));
  const activationChecks: FlowActivationCheck[] = parts.flatMap((part) => [...(part.activationChecks ?? [])]);
  return new WorkflowEngine({
    store: deps.store,
    cipher: deps.cipher,
    approvals: deps.approvals,
    config: deps.config,
    executors,
    sink: joinedSink(sinks),
    onRunEnded: parts.flatMap((part) => (part.onRunEnded === undefined ? [] : [part.onRunEnded])),
    activationChecks,
    writerQuiescer: deps.writerQuiescer,
    now: deps.now,
    interrupt: deps.interrupt,
    failpoint: deps.failpoint,
    judgeFor: deps.judgeFor,
    deliveries: createFlowDeliveries({ store: deps.store, cipher: deps.cipher, now: deps.now ?? Date.now }),
    onRelayWait: deps.onRelayWait,
  });
}
