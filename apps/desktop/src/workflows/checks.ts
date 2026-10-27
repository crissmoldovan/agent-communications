/**
 * What the designer finds wrong with a workflow before it may be saved (workflows design §11.3): the event service's own
 * `checkFlow` over its flow — a step no arrow reaches, a cycle, a split whose branches meet, an event a step cannot
 * raise, a field missing — and what the designer knows beside it: a condition that looks for nothing, a step that
 * delivers to a target the workflow does not hold, a Linear team or state not chosen. Each names its step. A straight
 * line, with no flow, is checked as the rule editor checks it (`draftChecks`), not here.
 *
 * None of this is the event service's last word: it checks the version again when it is saved and enabled.
 */
import { isObject, type Json, type JsonObject, targetsIn } from '../rule-editor/model.ts';
import { targetKinds, targetOf } from './canvas.ts';
import { checkFlow } from './flow.ts';

export interface DesignerProblem {
  readonly stepId: string | null;
  readonly message: string;
}

/** The leaves of a condition, each a test of a field. */
function leaves(condition: Json | undefined): JsonObject[] {
  if (!isObject(condition)) return [];
  if (Array.isArray(condition.all)) return condition.all.flatMap(leaves);
  if (Array.isArray(condition.any)) return condition.any.flatMap(leaves);
  if (condition.not !== undefined) return leaves(condition.not);
  return [condition];
}

const VALUED = new Set(['contains', 'equals', 'notEquals', 'startsWith', 'endsWith', 'domainIs']);

/** The designer's own checks of one step, beside `checkFlow`'s. */
function stepChecks(document: JsonObject, stepId: string, step: JsonObject): DesignerProblem[] {
  const problems: DesignerProblem[] = [];
  const say = (message: string) => problems.push({ stepId, message });
  if (step.kind === 'condition')
    for (const leaf of leaves(step.when))
      if (typeof leaf.op === 'string' && VALUED.has(leaf.op) && leaf.value === '')
        say('Say what the condition looks for.');
  if (step.kind === 'deliver' && isObject(step.target) && step.target.targetId !== '') {
    const target = targetOf(document, step);
    if (target === null) say('It delivers to a target this workflow does not hold.');
    else if (target.kind === 'linear' || target.kind === 'linear-change') {
      const team = isObject(target.team) ? target.team : {};
      if (team.id === '' || team.key === '') say('Choose the Linear team.');
      if (isObject(target.state) && target.state.id === '') say('Choose the Linear state it moves the issue to.');
      if (isObject(target.comment) && target.comment.text === '') say('Write the comment.');
    }
  }
  return problems;
}

/** Everything wrong with `document`'s flow, each with its step; empty for a straight line, or a flow that passes. */
export function designerChecks(document: JsonObject): DesignerProblem[] {
  if (!isObject(document.flow)) return [];
  const problems: DesignerProblem[] = [];
  const checked = checkFlow(document.flow, targetKinds(document));
  if (!checked.ok) for (const problem of checked.problems) problems.push(problem);
  const steps = isObject(document.flow.steps) ? document.flow.steps : {};
  for (const [stepId, step] of Object.entries(steps))
    if (isObject(step)) problems.push(...stepChecks(document, stepId, step));
  const source = isObject(document.source) ? document.source : {};
  if (!Array.isArray(source.accountIds) || source.accountIds.length === 0)
    problems.push({ stepId: null, message: 'Name the account it watches.' });
  if (targetsIn(document).some((target) => typeof target.targetId !== 'string' || target.targetId === ''))
    problems.push({ stepId: null, message: 'A target has no id.' });
  return problems;
}

/** How many problems each step has, by its id. */
export function problemsByStep(problems: readonly DesignerProblem[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const problem of problems)
    if (problem.stepId !== null) counts.set(problem.stepId, (counts.get(problem.stepId) ?? 0) + 1);
  return counts;
}
