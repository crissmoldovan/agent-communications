/**
 * What a workflow's approval says beside its numbered effects (workflows design §10.2, W6, W20): what changed since the
 * version that runs, step by step, and when the effects are too many to check at a glance. The numbered lines are
 * `describeFlow`'s, the event service's own words for the same document; nothing here is approved, and nothing here
 * reads a position.
 */
import { changedSections, type RulePart } from '../events-rules.ts';
import { canonical, isObject, type JsonObject } from '../rule-editor/model.ts';
import { flowOfDocument, stepTitle } from './canvas.ts';
import { describeFlow, type FlowDocumentV1, type FlowLine } from './flow.ts';

/** More effects than this, and the approval says to split the workflow (spec §10.2, plan E5). */
export const PREVIEW_LINES_MAX = 20;

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const value = (text: string): RulePart => ({ text, kind: 'value' });

/** The numbered effects of a workflow with a flow, as the event service's preview lists them; none for a straight line. */
export function approvalLines(rule: JsonObject): FlowLine[] {
  if (!isObject(rule.flow)) return [];
  return describeFlow(rule as unknown as Parameters<typeof describeFlow>[0]);
}

type Steps = Readonly<Record<string, JsonObject>>;

const stepsOf = (flow: FlowDocumentV1): Steps =>
  (isObject(flow.steps as unknown) ? flow.steps : {}) as unknown as Steps;

/** One step's change: its events alone, or anything else. */
function stepChange(id: string, before: JsonObject, after: JsonObject): RulePart[] {
  const { emit: _beforeEmit, ...beforeRest } = before;
  const { emit: _afterEmit, ...afterRest } = after;
  return canonical(beforeRest) === canonical(afterRest)
    ? [plain('Changes the events '), value(id), plain(' raises')]
    : [plain('Changes the step '), value(id)];
}

/**
 * What changed from the version that runs (`before`, null when there is none) to `after`, a line each: the gate's
 * parts by the panels' names, then each step added, removed or changed by its id, then the flow's own settings. A
 * straight line before is compared as the graph it already was (W2).
 */
export function flowChanges(before: JsonObject | null, after: JsonObject): RulePart[][] {
  if (before === null) return [];
  const lines: RulePart[][] = [];
  for (const section of changedSections(before, after))
    if (section !== 'where they go') lines.push([plain(`Changes ${section}`)]);
  const was = flowOfDocument(before).flow;
  const now = flowOfDocument(after).flow;
  const old = stepsOf(was);
  const steps = stepsOf(now);
  for (const id of Object.keys(steps))
    if (!Object.hasOwn(old, id))
      lines.push([plain('Adds the step '), value(id), plain(`: ${stepTitle(after, steps[id])}`)]);
  for (const id of Object.keys(old)) if (!Object.hasOwn(steps, id)) lines.push([plain('Removes the step '), value(id)]);
  for (const id of Object.keys(steps)) {
    const a = old[id];
    const b = steps[id];
    if (a !== undefined && b !== undefined && canonical(a) !== canonical(b)) lines.push(stepChange(id, a, b));
  }
  if (was.start !== now.start && typeof now.start === 'string')
    lines.push([plain('Starts at the step '), value(now.start)]);
  if (canonical(was.limits) !== canonical(now.limits)) lines.push([plain('Changes its limits')]);
  if (canonical(was.events ?? null) !== canonical(now.events ?? null))
    lines.push([plain('Changes where its events are named, or which of the run’s own it raises')]);
  if (canonical(was.on ?? null) !== canonical(now.on ?? null))
    lines.push([plain('Changes which raised events start it')]);
  if ((was.shadow === true) !== (now.shadow === true))
    lines.push([
      plain(now.shadow === true ? 'Runs in shadow: every effect is a dry run instead' : 'No longer runs in shadow'),
    ]);
  return lines;
}

/** The catalogue example a try walks the workflow over: its trigger event's first (`type@version:0`). */
export function exampleOf(document: JsonObject): string | null {
  const event = isObject(document.event) ? document.event : {};
  return typeof event.type === 'string' && typeof event.version === 'number'
    ? `${event.type}@${event.version}:0`
    : null;
}
