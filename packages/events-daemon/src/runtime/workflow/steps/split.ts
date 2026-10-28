import type { StepContext, StepExecutor, StepResult } from '../contracts.ts';

/*
 * The split step (workflows design W4): it starts every branch it names, 2 to 8, which never meet again; the run ends
 * when every branch has. It has no effect, no outcome a person chooses between, and an empty output.
 */

/** The outcome a split settles with: it goes to every branch, whatever it is. */
export const SPLIT_OUTCOME = 'split';

async function split(ctx: StepContext): Promise<StepResult> {
  if (ctx.step.kind !== 'split') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
  return { kind: 'settled', outcome: SPLIT_OUTCOME, output: {} };
}

/** The split step's executor: settled at once; the engine makes each branch ready. */
export const splitExecutor: StepExecutor<'split'> = Object.freeze({
  kind: 'split' as const,
  run: split,
  resume: (ctx: StepContext) => split(ctx),
});
