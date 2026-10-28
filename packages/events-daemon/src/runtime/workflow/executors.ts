import { CommsError } from '@agentcomms/core';
import { STEP_KINDS, type StepKind } from '@agentcomms/events';
import type { StepExecutor, StepExecutors } from './contracts.ts';

/*
 * The executors the engine runs, one per step kind (workflows plan I4). Each track registers its own through its
 * composition; a kind is registered once, so no composition can quietly replace another's. A kind no composition
 * registered is refused when a step of it runs, and that step fails closed.
 */

/** The code a step of a kind nothing registered fails with. */
export const STEP_KIND_UNAVAILABLE = 'STEP_KIND_UNAVAILABLE';

export function createStepExecutors(): StepExecutors {
  const executors = new Map<StepKind, StepExecutor>();
  return {
    register(executor: StepExecutor): void {
      if (!(STEP_KINDS as readonly string[]).includes(executor.kind))
        throw new CommsError('CONFIG', `${String(executor.kind)} is not a step kind`);
      if (executors.has(executor.kind))
        throw new CommsError('CONFIG', `the ${executor.kind} step has its executor already`);
      executors.set(executor.kind, executor);
    },
    get(kind: StepKind): StepExecutor {
      const executor = executors.get(kind);
      if (executor === undefined)
        throw new CommsError('CONFIG', `no executor runs ${kind} steps in this event service`, {
          details: { reason: STEP_KIND_UNAVAILABLE, kind },
        });
      return executor;
    },
  };
}
