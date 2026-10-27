import { getPointer, type JsonValue } from '@agentcomms/events';
import type { StepContext, StepExecutor, StepResult } from '../contracts.ts';

/*
 * The judge step (workflows design §4.1, W3; plan B3): the step's question, on its own judge, budget and bar, over the
 * step's inputs alone — pointers into the run's mapped fields. `yes` at its bar, `no` below it, `unsure` in the band
 * below it where the step holds, and `unsure` too when the judge cannot answer: a failure is never a yes. A judge whose
 * budget is spent waits on the limit, and asks again when the window frees. Its output is its score.
 */

async function judged(ctx: StepContext): Promise<StepResult> {
  if (ctx.step.kind !== 'judge') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
  const ask = ctx.step.ask;
  const fields = await ctx.fields();
  const inputs: Record<string, JsonValue> = {};
  for (const pointer of ask.inputs) {
    const found = getPointer(fields as JsonValue, pointer);
    if (found.found) inputs[pointer] = found.value as JsonValue;
  }
  // What reaches the judge leaves the event service: the version's authority is checked again first.
  await ctx.fence();
  const answer = await ctx.judge(ask, inputs);
  if (answer.kind === 'wait') return { kind: 'wait', wait: 'limit', key: null, wakeAt: answer.until };
  if (answer.kind === 'failed') return { kind: 'settled', outcome: 'unsure', output: { score: null } };
  return { kind: 'settled', outcome: answer.said, output: { score: answer.score } };
}

/** The judge step's executor. A wait for the budget starts the step again when it frees. */
export const judgeExecutor: StepExecutor<'judge'> = Object.freeze({
  kind: 'judge' as const,
  run: judged,
  resume: (ctx: StepContext) => judged(ctx),
});
