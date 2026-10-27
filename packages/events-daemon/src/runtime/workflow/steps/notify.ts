import { NOTICE_TITLE, type Notifier, truncateDisplay } from '@agentcomms/core';
import { closedSlotText } from '../../../domain/flow.ts';
import { linearTemplateSlots } from '../../../domain/linear-target.ts';
import type { StepContext, StepExecutor, StepResult } from '../contracts.ts';

/*
 * The notify step (workflows design §6.8): a notice on the person's screen, from core's notifier, best effort. It says
 * the person's own words and closed slots only — the run, a step's closed output, a chain's trigger — never a field a
 * sender wrote, since a notice can show on a locked screen; `checkFlow` refuses any other slot. It is raised once per
 * step per run: only on the step's first attempt, which the claim recorded before it, so a retry after a crash says
 * nothing again. It never fails the run, and its output says whether it was raised.
 */

/** The most of a notice's text shown. */
const NOTICE_BODY_MAX = 240;

/** The notice's text: the step's words, each closed slot filled from the run's own values. */
async function noticeText(ctx: StepContext, text: string): Promise<string> {
  const flow = ctx.rule.flow;
  if (flow === undefined) return text;
  const trigger = linearTemplateSlots({ text }).some((slot) => slot.startsWith('trigger.'))
    ? await ctx.trigger()
    : null;
  return text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_slot, name: string) =>
    closedSlotText(name, { runId: ctx.run.id, flow, output: (id) => ctx.output(id), trigger }),
  );
}

/** The notify step's executor over `notifier`, core's on the person's own screen. */
export function notifyExecutor(notifier: Notifier): StepExecutor<'notify'> {
  const raise = async (ctx: StepContext): Promise<StepResult> => {
    if (ctx.step.kind !== 'notify') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
    // Once per step per run: a later attempt follows a claim that may already have raised it.
    if (ctx.attempt.number !== 1) return { kind: 'settled', outcome: 'sent', output: { raised: false } };
    const body = truncateDisplay(
      `Workflow ${ctx.run.ruleId}: ${await noticeText(ctx, ctx.step.text)}`,
      NOTICE_BODY_MAX,
    );
    let raised = false;
    try {
      raised = (await notifier({ title: NOTICE_TITLE, body })).raised;
    } catch {
      // Core's notifier never throws; one that does is a notice not raised, never a failed run.
    }
    return { kind: 'settled', outcome: 'sent', output: { raised } };
  };
  return Object.freeze({ kind: 'notify' as const, run: raise, resume: (ctx: StepContext) => raise(ctx) });
}
