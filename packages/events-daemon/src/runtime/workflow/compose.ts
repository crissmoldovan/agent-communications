import type { ApprovalStore, ConfigStore, Notifier } from '@agentcomms/core';
import type { EventDatabase } from '../../store/database.ts';
import type { ProjectionCipher } from '../projections.ts';
import type { WriterQuiescer } from '../writer-quiescer.ts';
import {
  type FlowActivationCheck,
  NO_WORKFLOW_EVENTS,
  type PreparedEvents,
  type StepTransition,
  type WorkflowComposition,
  type WorkflowEventSink,
} from './contracts.ts';
import { WorkflowEngine, type WorkflowFailpoint } from './engine.ts';
import { createStepExecutors } from './executors.ts';
import { conditionExecutor } from './steps/condition.ts';
import { notifyExecutor } from './steps/notify.ts';
import { splitExecutor } from './steps/split.ts';

/*
 * The one place the owner makes its workflow engine (workflows plan B2): Track B's own executors — condition, split
 * and notify here; judge, deliver and wait as B3 and B4 add them — then each track's composition: its executors, its
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
  /** Test seam only: a crash at a point of a step's life. */
  readonly failpoint?: ((point: WorkflowFailpoint) => void) | undefined;
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
  executors.register(conditionExecutor);
  executors.register(splitExecutor);
  executors.register(notifyExecutor(deps.notifier));
  for (const part of parts) for (const executor of part.executors) executors.register(executor);
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
    failpoint: deps.failpoint,
  });
}
