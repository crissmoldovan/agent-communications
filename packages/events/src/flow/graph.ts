/**
 * The graph a flow's arrows draw (workflows design W4, §4.4, §7.1): where an outcome goes, the printer's step order,
 * the steps a settle closes, and whether an arrow may be drawn. Pure, and tolerant of a draft the designer is still
 * editing: a missing arrow or a step that is not there is simply not followed.
 */
import { compareUtf8 } from '../text.ts';
import { type FlowDocumentV1, type FlowStep, STEP_OUTCOMES, type StepId } from './types.ts';

type Steps = Readonly<Record<StepId, FlowStep>>;

/** A wait's outcomes by what it waits for, in `STEP_OUTCOMES.wait`'s order. */
const WAIT_OUTCOMES: Readonly<Record<'turnEnd' | 'sessionIdle' | 'time', readonly string[]>> = Object.freeze({
  turnEnd: Object.freeze([
    'completed',
    'failed',
    'stopped',
    'done',
    'needs-the-person',
    'not-mine',
    'blocked',
    'timed-out',
  ]),
  sessionIdle: Object.freeze(['free', 'timed-out']),
  time: Object.freeze(['elapsed', 'timed-out']),
});

/**
 * The outcomes this step can have: its kind's, narrowed by its own fields — a wait by what it waits for, and a find
 * with `only: 'idle'` to `idle` and `none`. A split has none.
 */
export function outcomesOf(step: FlowStep): readonly string[] {
  if (step.kind === 'split') return [];
  if (step.kind === 'wait') {
    const waitsFor = Object.keys(step.for ?? {})[0] as keyof typeof WAIT_OUTCOMES | undefined;
    return (waitsFor !== undefined && WAIT_OUTCOMES[waitsFor]) || STEP_OUTCOMES.wait;
  }
  if (step.kind === 'find-session' && step.only === 'idle') return ['idle', 'none'];
  return STEP_OUTCOMES[step.kind] ?? [];
}

function arrowsOf(step: FlowStep): Readonly<Record<string, string>> {
  if (step.kind === 'split') return {};
  const next = (step as { readonly next?: unknown }).next;
  return typeof next === 'object' && next !== null && !Array.isArray(next)
    ? (next as Readonly<Record<string, string>>)
    : {};
}

/** Where `outcome` goes from `step`: its arrow, else `otherwise`, else nowhere. A split goes to every branch. */
export function nextSteps(step: FlowStep, outcome: string): readonly StepId[] {
  if (step.kind === 'split') return [...new Set((step.branches ?? []).filter((branch) => branch !== 'end'))];
  const arrows = arrowsOf(step);
  const target = Object.hasOwn(arrows, outcome) ? arrows[outcome] : arrows.otherwise;
  return target === undefined || target === 'end' ? [] : [target];
}

/**
 * Every step `step` can go on to, each once: its outcomes' in its kind's order (through `otherwise` where an outcome
 * has no arrow of its own), then any other arrow it holds, by outcome name. A split's are its branches.
 */
export function successors(step: FlowStep): readonly StepId[] {
  if (step.kind === 'split') return nextSteps(step, '');
  const found: StepId[] = [];
  const add = (target: string | undefined): void => {
    if (target !== undefined && target !== 'end' && !found.includes(target)) found.push(target);
  };
  const arrows = arrowsOf(step);
  for (const outcome of outcomesOf(step)) add(Object.hasOwn(arrows, outcome) ? arrows[outcome] : arrows.otherwise);
  for (const outcome of Object.keys(arrows).sort(compareUtf8)) add(arrows[outcome]);
  return found;
}

/** The steps reachable from `from`, each included, following only steps the flow holds. */
export function reachableFrom(steps: Steps, from: Iterable<StepId>): Set<StepId> {
  const seen = new Set<StepId>();
  const stack = [...from].filter((id) => Object.hasOwn(steps, id));
  while (stack.length > 0) {
    const id = stack.pop() as StepId;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const next of successors(steps[id] as FlowStep)) if (Object.hasOwn(steps, next)) stack.push(next);
  }
  return seen;
}

/** A step on a cycle, or null when the arrows draw none. */
export function cycleStep(steps: Steps): StepId | null {
  const state = new Map<StepId, 'open' | 'done'>();
  for (const root of Object.keys(steps).sort(compareUtf8)) {
    if (state.has(root)) continue;
    const stack: { id: StepId; next: readonly StepId[]; at: number }[] = [];
    const enter = (id: StepId) => {
      state.set(id, 'open');
      stack.push({ id, next: successors(steps[id] as FlowStep).filter((to) => Object.hasOwn(steps, to)), at: 0 });
    };
    enter(root);
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { id: StepId; next: readonly StepId[]; at: number };
      if (top.at >= top.next.length) {
        state.set(top.id, 'done');
        stack.pop();
        continue;
      }
      const to = top.next[top.at] as StepId;
      top.at += 1;
      const seen = state.get(to);
      if (seen === 'open') return to;
      if (seen === undefined) enter(to);
    }
  }
  return null;
}

/** A split whose branches meet again, with a step two of them reach, or null when none do. */
export function splitMeeting(steps: Steps): { split: StepId; step: StepId } | null {
  for (const id of Object.keys(steps).sort(compareUtf8)) {
    const step = steps[id] as FlowStep;
    if (step.kind !== 'split') continue;
    const reachedBy = new Map<StepId, StepId>();
    for (const branch of nextSteps(step, '')) {
      for (const reached of reachableFrom(steps, [branch])) {
        const other = reachedBy.get(reached);
        if (other !== undefined && other !== branch) return { split: id, step: reached };
        reachedBy.set(reached, branch);
      }
    }
  }
  return null;
}

/**
 * The printer's order (§4.4): depth first from `start`, the arrows in each kind's outcome order, where a step that
 * several arrows reach is written once every step before it is. A step the flow cannot reach, or one on a cycle, comes
 * last, by id. It reads no position.
 */
export function stepOrder(flow: FlowDocumentV1): readonly StepId[] {
  const steps = flow.steps ?? {};
  const ids = Object.keys(steps).sort(compareUtf8);
  const reachable = reachableFrom(steps, [flow.start]);
  const waiting = new Map<StepId, number>();
  for (const id of reachable)
    for (const next of successors(steps[id] as FlowStep))
      if (next !== id && reachable.has(next)) waiting.set(next, (waiting.get(next) ?? 0) + 1);
  const order: StepId[] = [];
  const written = new Set<StepId>();
  const write = (id: StepId): void => {
    written.add(id);
    order.push(id);
    for (const next of successors(steps[id] as FlowStep)) {
      if (next === id || !reachable.has(next) || written.has(next)) continue;
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      if (left === 0) write(next);
    }
  };
  if (reachable.has(flow.start)) write(flow.start);
  for (const id of ids) if (!written.has(id)) order.push(id);
  return order;
}

/**
 * The steps a run can no longer reach (§7.1): not `live` (ready, running or waiting), not `settled` (done, failed,
 * skipped or cancelled), and not reachable from any live step. In the printer's order.
 */
export function unreachableAfter(
  flow: FlowDocumentV1,
  live: ReadonlySet<StepId>,
  settled: ReadonlySet<StepId>,
): StepId[] {
  const reachable = reachableFrom(flow.steps ?? {}, live);
  return stepOrder(flow).filter((id) => !live.has(id) && !settled.has(id) && !reachable.has(id));
}

/**
 * Whether the designer may draw an arrow from `from`'s outcome to `to`: the outcome is the step's (a split takes a
 * new branch), `to` is a step of the flow or `end` (never a split's branch), and the graph it makes has no cycle and no
 * split whose branches meet.
 */
export function connectionAllowed(
  flow: FlowDocumentV1,
  from: { stepId: StepId; outcome: string },
  to: StepId,
): boolean {
  const steps = flow.steps ?? {};
  if (!Object.hasOwn(steps, from.stepId)) return false;
  if (to !== 'end' && !Object.hasOwn(steps, to)) return false;
  const step = steps[from.stepId] as FlowStep;
  let changed: FlowStep;
  if (step.kind === 'split') {
    if (to === 'end') return false;
    const branches = step.branches ?? [];
    changed = { ...step, branches: branches.includes(to) ? branches : [...branches, to] };
  } else {
    if (from.outcome !== 'otherwise' && !outcomesOf(step).includes(from.outcome)) return false;
    changed = { ...step, next: { ...arrowsOf(step), [from.outcome]: to } } as FlowStep;
  }
  const after: Record<StepId, FlowStep> = { ...steps, [from.stepId]: changed };
  return cycleStep(after) === null && splitMeeting(after) === null;
}
