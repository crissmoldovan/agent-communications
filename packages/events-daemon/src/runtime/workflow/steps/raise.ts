import type { FlowStep } from '@agentcomms/events';
import type { StepContext, StepExecutor, StepResult } from '../contracts.ts';
import { newEventId } from '../ids.ts';

/**
 * Raise an event (workflows design W28, §6.9): one outcome, `raised`, at once. It never waits and never fails. Its
 * output is the event's id and the step's name; the sink writes the event in the transaction that settles the step,
 * with its declared fields sealed beside it, and delivery happens later, apart from the run (W33).
 */
function raised(ctx: StepContext): StepResult {
  const step = ctx.step as Extract<FlowStep, { kind: 'raise' }>;
  return { kind: 'settled', outcome: 'raised', output: { event: newEventId(), name: step.name } };
}

export const raiseExecutor: StepExecutor<'raise'> = Object.freeze({
  kind: 'raise',
  run: async (ctx: StepContext): Promise<StepResult> => raised(ctx),
  // Nothing waits, so nothing wakes it; a resume settles as a run does.
  resume: async (ctx: StepContext): Promise<StepResult> => raised(ctx),
});
