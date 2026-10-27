import type { DatabaseSync } from 'node:sqlite';
import {
  type AgenticConditionV1,
  type CanonicalCondition,
  canonicalJson,
  checkFlow,
  type FlowDocumentV1,
  type FlowStep,
  getPointer,
  type JsonValue,
  type StepId,
} from '@agentcomms/events';
import type { CanonicalFullRuleDocument, TargetDocument } from './activation-documents.ts';
import { type CanonicalJudgeDocument, canonicalJudge } from './judges.ts';
import { EventDomainError, type EventDomainErrorCode } from './lifecycle.ts';
import { linearChangeSlots } from './linear-change-target.ts';
import { linearTemplateSlots } from './linear-target.ts';

/*
 * A workflow's flow in the event service (workflows design §4.1, W1–W6, W12, W24, W34, W36): `checkFlow` first, which
 * is pure and shared with the app, then what only the event service can say about a flow — against the workflow's own
 * targets and mapping when the document is canonicalised, and against the other active workflows when it is activated.
 * Every refusal is content-free and names the step it is in. Nothing here reads what a sender wrote: the only names
 * are the workflow author's.
 */

/** The canonical rule a flow is checked inside: every field but `flow`, already canonical. */
export type RuleWithoutFlow = Omit<CanonicalFullRuleDocument, 'flow'>;

/** The most a workflow document with a flow may be, as canonical JSON (the app's bound, inside a 64 KiB frame). */
export const FLOW_DOCUMENT_MAX_BYTES = 49_152;

/** The mapped field names a slot cannot take in a workflow with a flow: they name the run's own values there. */
const CLOSED_SLOT_ROOTS: readonly string[] = ['steps', 'trigger', 'run'];

/** The closed outputs a template slot (`{{steps.<step>.<name>}}`) or a context part may name, by step kind. */
const SLOT_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  condition: [],
  split: [],
  notify: [],
  judge: ['score'],
  route: ['project', 'projectName', 'reason', 'score'],
  'find-session': ['session', 'provider'],
  'start-session': ['session', 'provider', 'mode'],
  // Never the worktree's path: a folder names a client, and slots reach Linear and notices (W26).
  worktree: ['branch'],
  wait: ['reported', 'summary'],
  raise: ['event', 'name'],
});

/** A deliver step's slot outputs, by its target's kind (plan I5): an issue's parts by name, as `{{steps.issue.identifier}}`. */
const DELIVER_SLOT_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  session: ['delivery', 'session', 'turn'],
  linear: ['delivery', 'id', 'identifier', 'url'],
  'linear-change': ['delivery', 'state'],
  webhook: ['delivery', 'status'],
  sse: ['delivery'],
  queue: ['delivery'],
  'dry-run': ['delivery'],
});

/** The stored output keys a condition step may read (`/steps/<step>/<key>`), by step kind (plan I5). */
const CONDITION_OUTPUTS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  condition: [],
  split: [],
  notify: ['raised'],
  judge: ['score'],
  route: ['project', 'projectName', 'reason', 'score'],
  'find-session': ['session', 'provider'],
  'start-session': ['session', 'provider', 'mode', 'refusal'],
  worktree: ['branch', 'refusal'],
  deliver: ['delivery', 'session', 'turn', 'ahead', 'issue', 'changed', 'state', 'status'],
  wait: ['for', 'reported'],
  raise: ['event', 'name'],
});

/** Closed outputs whose values are a fixed set of words: an operand over one must be one of them (§4.1). */
const CLOSED_WORDS: Readonly<Record<string, Readonly<Record<string, readonly string[]>>>> = Object.freeze({
  route: { reason: ['hint:sender-domain', 'hint:slack-conversation', 'hint:person', 'judge'] },
  'find-session': { provider: ['claude', 'codex'] },
  'start-session': { provider: ['claude', 'codex'], mode: ['manual', 'acceptEdits', 'plan'] },
  wait: { for: ['turn-end', 'session-idle', 'time'] },
});

function refuse(code: EventDomainErrorCode, message: string, details?: Readonly<Record<string, unknown>>): never {
  throw new EventDomainError(code, message, details);
}

type Steps = Readonly<Record<StepId, FlowStep>>;

/** Every step `step` has an arrow to, each once: a split's branches, otherwise each of its arrows. */
function arrowsOut(step: FlowStep): readonly StepId[] {
  if (step.kind === 'split') return step.branches;
  return [...new Set(Object.values(step.next as Readonly<Record<string, string>>))].filter((next) => next !== 'end');
}

/** For each step, the steps a run can pass through before it: those that reach it by arrows. */
function ancestors(steps: Steps): ReadonlyMap<StepId, ReadonlySet<StepId>> {
  const parents = new Map<StepId, StepId[]>();
  for (const [id, step] of Object.entries(steps))
    for (const next of arrowsOut(step)) parents.set(next, [...(parents.get(next) ?? []), id]);
  const found = new Map<StepId, Set<StepId>>();
  for (const id of Object.keys(steps)) {
    const seen = new Set<StepId>();
    const stack = [...(parents.get(id) ?? [])];
    while (stack.length > 0) {
      const at = stack.pop() as StepId;
      if (seen.has(at)) continue;
      seen.add(at);
      stack.push(...(parents.get(at) ?? []));
    }
    found.set(id, seen);
  }
  return found;
}

/** What one check of a flow needs: its steps, who comes before whom, and the workflow's targets by `id@version`. */
interface FlowScope {
  readonly flow: FlowDocumentV1;
  readonly steps: Steps;
  readonly before: ReadonlyMap<StepId, ReadonlySet<StepId>>;
  readonly targets: ReadonlyMap<string, TargetDocument>;
}

function targetOf(scope: FlowScope, step: Extract<FlowStep, { kind: 'deliver' }>): TargetDocument {
  return scope.targets.get(`${step.target.targetId}@${step.target.version}`) as TargetDocument;
}

/** Refuses a reference from `from` to a step that is not of `kinds`, or that a run cannot have passed before it. */
function referenced(
  scope: FlowScope,
  from: StepId,
  to: StepId,
  kinds: readonly FlowStep['kind'][],
  what: string,
): FlowStep {
  const step = scope.steps[to];
  if (step === undefined || !kinds.includes(step.kind))
    return refuse(
      'FLOW_TO_KIND',
      `the step ${from} names ${to} as ${what}, and ${to} is not a ${kinds.join(' or ')} step`,
    );
  if (!(scope.before.get(from)?.has(to) ?? false))
    return refuse('FLOW_TO_KIND', `the step ${from} names ${to} as ${what}, and ${to} does not come before it`);
  return step;
}

/** A closed slot's step and name, checked: its step comes before `from`, and the name is one of its closed outputs. */
function checkClosedSlot(scope: FlowScope, from: StepId, slot: string, where: string, summaryAllowed: boolean): void {
  if (slot === 'run') return;
  const [root, stepId, name, ...rest] = slot.split('.');
  if (root === 'trigger') {
    if (scope.flow.on === undefined)
      refuse('FLOW_TO_KIND', `${where} names {{${slot}}}, and only a workflow that starts on a raised event has one`);
    return;
  }
  if (root !== 'steps' || stepId === undefined || name === undefined || rest.length > 0)
    refuse('FLOW_TO_KIND', `${where} names {{${slot}}}: a step's output is {{steps.<step>.<output>}}`);
  const step = referenced(
    scope,
    from,
    stepId,
    Object.keys(SLOT_OUTPUTS).concat('deliver') as FlowStep['kind'][],
    `{{${slot}}} in ${where}`,
  );
  const names =
    step.kind === 'deliver'
      ? (DELIVER_SLOT_OUTPUTS[targetOf(scope, step).kind] ?? [])
      : (SLOT_OUTPUTS[step.kind] ?? []);
  if (!names.includes(name))
    refuse(
      'FLOW_TO_KIND',
      `${where} names {{${slot}}}, and the step ${stepId} has ${names.length === 0 ? 'no output a slot can name' : `the outputs ${names.join(', ')}`}`,
    );
  if (name === 'summary') {
    if (!summaryAllowed)
      refuse(
        'FLOW_TO_KIND',
        `${where} names {{${slot}}}: a session's summary is written by an agent, and only a Linear comment may name it`,
      );
    if (step.kind !== 'wait' || !('turnEnd' in step.for))
      refuse('FLOW_TO_KIND', `${where} names {{${slot}}}, and only a wait for a turn's end has a summary`);
  }
}

/** Whether a slot names the run's own values rather than a mapped field: `{{run}}`, `{{steps.…}}`, `{{trigger.…}}`. */
export function isClosedSlot(slot: string): boolean {
  const root = slot.split('.')[0] as string;
  return CLOSED_SLOT_ROOTS.includes(root);
}

/** The slots a text names: `{{…}}`, in order, each once. */
function textSlots(text: string): readonly string[] {
  return linearTemplateSlots({ text });
}

function conditionLeaves(
  condition: CanonicalCondition,
): readonly Exclude<CanonicalCondition, { all: unknown } | { any: unknown } | { not: unknown }>[] {
  if ('all' in condition) return condition.all.flatMap(conditionLeaves);
  if ('any' in condition) return condition.any.flatMap(conditionLeaves);
  if ('not' in condition) return conditionLeaves(condition.not);
  return [condition];
}

/** A condition step's paths: a step's output comes before it, is one of its outputs, and is compared with its words. */
function checkCondition(scope: FlowScope, id: StepId, when: CanonicalCondition): void {
  for (const leaf of conditionLeaves(when)) {
    const tokens = leaf.path.split('/').slice(1);
    if (tokens[0] === 'trigger' && scope.flow.on === undefined)
      refuse(
        'FLOW_TO_KIND',
        `the condition ${id} reads ${leaf.path}, and only a workflow that starts on a raised event has one`,
      );
    if (tokens[0] !== 'steps') continue;
    const [, stepId, output] = tokens as [string, string, string];
    const step = referenced(scope, id, stepId, Object.keys(CONDITION_OUTPUTS) as FlowStep['kind'][], `${leaf.path}`);
    const outputs = CONDITION_OUTPUTS[step.kind] ?? [];
    if (!outputs.includes(output))
      refuse(
        'FLOW_TO_KIND',
        `the condition ${id} reads ${leaf.path}, and the step ${stepId} has ${outputs.length === 0 ? 'no output' : `the outputs ${outputs.join(', ')}`}`,
      );
    const words =
      step.kind === 'route' && output === 'project'
        ? step.candidates.map((candidate) => candidate.projectId)
        : CLOSED_WORDS[step.kind]?.[output];
    if (words === undefined || tokens.length > 3) continue;
    const operands = 'values' in leaf ? leaf.values : 'value' in leaf ? [leaf.value] : [];
    for (const operand of operands)
      if (leaf.op !== 'exists' && !words.includes(operand as string))
        refuse(
          'FLOW_TO_KIND',
          `the condition ${id} compares ${leaf.path} with ${JSON.stringify(operand)}, which it never is: it is one of ${words.join(', ')}`,
        );
  }
}

/** A deliver step against its target: the target is the workflow's, `to` names steps of the right kind, `report` fits. */
function checkDeliver(scope: FlowScope, id: StepId, step: Extract<FlowStep, { kind: 'deliver' }>): void {
  const target = targetOf(scope, step);
  const to = step.to;
  const flowSession = target.kind === 'session' && 'flow' in target.find;
  if (flowSession) {
    if (to === undefined || !('session' in to))
      refuse(
        'FLOW_TO_KIND',
        `the step ${id} gives ${target.targetId} the session the flow chose: name its find or start steps in to.session`,
      );
    for (const chosen of to.session) {
      const found = referenced(scope, id, chosen, ['find-session', 'start-session'], 'the session it gives to');
      if ((found.kind === 'find-session' || found.kind === 'start-session') && found.provider !== target.provider)
        refuse(
          'FLOW_TO_KIND',
          `the step ${id} gives a ${target.provider} session's target the session ${chosen} finds or starts with ${found.provider}`,
        );
    }
  } else if (target.kind === 'linear-change') {
    if (to === undefined || !('issue' in to))
      refuse('FLOW_TO_KIND', `the step ${id} changes a Linear issue: name the step that created it in to.issue`);
    const creator = referenced(scope, id, to.issue, ['deliver'], 'the issue it changes');
    if (creator.kind !== 'deliver' || targetOf(scope, creator).kind !== 'linear')
      refuse('FLOW_TO_KIND', `the step ${id} changes the issue of ${to.issue}, which creates no Linear issue`);
  } else if (to !== undefined)
    refuse(
      'FLOW_TO_KIND',
      `the step ${id} names ${'session' in to ? 'a session' : 'an issue'} in to, and its target ${target.targetId} is a ${target.kind} target, which takes none`,
    );
  if (step.report !== undefined) {
    if (target.kind !== 'session')
      refuse('FLOW_TO_KIND', `the step ${id} asks for a report, and only a session reports`);
    if (target.provider !== 'claude')
      refuse(
        'REPORT_NEEDS_CLAUDE',
        `the step ${id} asks ${target.targetId}'s Codex session for a report, and only Claude Code reports how its turn ended`,
      );
  }
  // What the target writes may name a step's output: each one comes before this step.
  if (target.kind === 'linear')
    for (const part of ['title', 'description'] as const)
      for (const slot of linearTemplateSlots(target[part]))
        if (isClosedSlot(slot))
          checkClosedSlot(scope, id, slot, `the Linear target ${target.targetId}'s ${part}`, false);
  if (target.kind === 'linear-change')
    for (const slot of linearChangeSlots(target))
      if (isClosedSlot(slot)) checkClosedSlot(scope, id, slot, `the Linear change ${target.targetId}'s comment`, true);
  if (target.kind === 'session')
    for (const part of target.context)
      if ('step' in part)
        checkClosedSlot(
          scope,
          id,
          `steps.${part.step}.${part.field}`,
          `the session target ${target.targetId}'s context`,
          false,
        );
}

/** Each kind's references to other steps, and the activation-free refusals of §4.1, W6 and W36. */
function checkStep(scope: FlowScope, id: StepId, step: FlowStep): void {
  switch (step.kind) {
    case 'condition':
      checkCondition(scope, id, step.when);
      return;
    case 'find-session':
    case 'start-session': {
      const where = step.in;
      if ('project' in where) referenced(scope, id, where.project, ['route'], 'the project it looks in');
      if ('worktree' in where) referenced(scope, id, where.worktree, ['worktree'], 'the worktree it looks in');
      if (step.kind === 'find-session' && 'thread' in where && step.provider !== 'claude')
        refuse(
          'FIND_THREAD_NEEDS_CLAUDE',
          `the step ${id} looks for the session that took this conversation with Codex, and only a Claude Code session is recorded with the conversations it takes`,
        );
      if (step.kind === 'start-session' && step.mode === 'acceptEdits' && !('worktree' in where))
        refuse(
          'ACCEPT_EDITS_OUTSIDE_RUN_WORKTREE',
          `the step ${id} starts a session that may edit files without asking, and in 0.36 that is allowed only in a worktree this run made: start it in { worktree: <a worktree step> }`,
        );
      return;
    }
    case 'worktree':
      referenced(scope, id, step.project, ['route'], 'the project it makes a worktree of');
      for (const slot of textSlots(step.branch)) checkClosedSlot(scope, id, slot, `the step ${id}'s branch`, false);
      return;
    case 'deliver':
      checkDeliver(scope, id, step);
      return;
    case 'wait': {
      const waitsFor = step.for;
      if ('turnEnd' in waitsFor) {
        const deliver = referenced(scope, id, waitsFor.turnEnd, ['deliver'], 'the turn it waits for');
        if (deliver.kind === 'deliver' && targetOf(scope, deliver).kind !== 'session')
          refuse(
            'FLOW_TO_KIND',
            `the step ${id} waits for the turn of ${waitsFor.turnEnd}, which gives no session a turn`,
          );
      }
      if ('sessionIdle' in waitsFor)
        referenced(scope, id, waitsFor.sessionIdle, ['find-session'], 'the session it waits for');
      return;
    }
    case 'notify':
      for (const slot of textSlots(step.text)) checkClosedSlot(scope, id, slot, `the step ${id}'s notice`, false);
      return;
    default:
      return;
  }
}

/**
 * A workflow's flow, canonical, inside its own canonical rule: `checkFlow`'s form, with every embedded judge in the
 * event service's canonical form, refused unless every target it delivers to is the workflow's and every target the
 * workflow names is delivered to, every step it names is of the right kind and comes before it, every slot names an
 * output, `acceptEdits` is only in a run-made worktree, a report only from Claude Code, a conversation's session only
 * with Claude Code, and its chained start never names its own events.
 */
export function canonicalFlowInRule(rule: RuleWithoutFlow, raw: unknown): FlowDocumentV1 {
  const targetKinds: Record<string, string> = {};
  for (const target of rule.targets) targetKinds[`${target.targetId}@${target.version}`] = target.kind;
  const checked = checkFlow(raw, targetKinds);
  if (!checked.ok) {
    const first = checked.problems[0];
    return refuse('FLOW_INVALID', `the workflow's flow: ${first?.message ?? 'is not valid'}`, {
      problems: checked.problems.map((problem) => ({
        code: problem.code,
        message: problem.message,
        stepId: problem.stepId,
        pointer: problem.pointer,
      })),
    });
  }
  const flow = withCanonicalJudges(checked.flow);
  const mapping = rule.mapping;
  if (typeof mapping === 'object' && mapping !== null && !Array.isArray(mapping))
    for (const key of CLOSED_SLOT_ROOTS)
      if (Object.hasOwn(mapping, key))
        refuse(
          'VERSION_DOCUMENT_INVALID',
          `a workflow with a flow maps no field named ${key}: in its slots, ${key} names the run's own values`,
        );
  const scope: FlowScope = {
    flow,
    steps: flow.steps,
    before: ancestors(flow.steps),
    targets: new Map(rule.targets.map((target) => [`${target.targetId}@${target.version}`, target])),
  };
  // Every target a step delivers to is the workflow's, before any step's check reads one.
  const used = new Set<string>();
  const ids = Object.keys(flow.steps).sort();
  for (const id of ids) {
    const step = flow.steps[id] as FlowStep;
    if (step.kind !== 'deliver') continue;
    const key = `${step.target.targetId}@${step.target.version}`;
    if (!scope.targets.has(key))
      refuse(
        'FLOW_TARGET_UNKNOWN',
        `the step ${id} delivers to ${step.target.targetId} version ${step.target.version}, which is not one of this workflow's targets`,
      );
    used.add(key);
  }
  for (const id of ids) checkStep(scope, id, flow.steps[id] as FlowStep);
  for (const target of rule.targets)
    if (!used.has(`${target.targetId}@${target.version}`))
      refuse(
        'FLOW_TARGET_UNUSED',
        `the workflow names the target ${target.targetId} version ${target.version}, and no step of its flow delivers to it`,
      );
  if (flow.on !== undefined && flow.events !== undefined) {
    const own = `${flow.events.namespace}.${flow.events.workflow}.`;
    const self = flow.on.raised.find((pattern) => pattern.startsWith(own));
    if (self !== undefined)
      refuse(
        'CHAIN_SELF',
        `the workflow starts on ${self}, which is its own events: a workflow never starts on what it raises`,
      );
  }
  return flow;
}

/** The flow with each embedded judge document in the event service's canonical form, so its digest binds that. */
function withCanonicalJudges(flow: FlowDocumentV1): FlowDocumentV1 {
  const steps: Record<StepId, FlowStep> = {};
  for (const [id, step] of Object.entries(flow.steps)) {
    let canonical: FlowStep = step;
    // The daemon's judge document is the stored one, so it is what the digest binds; its type is wider than the wire's.
    const judge = (document: unknown) => canonicalJudge(document) as unknown as AgenticConditionV1['judge'];
    if (step.kind === 'judge') canonical = { ...step, ask: { ...step.ask, judge: judge(step.ask.judge) } };
    if (step.kind === 'route' && step.judge !== undefined)
      canonical = { ...step, judge: { ...step.judge, judge: judge(step.judge.judge) } };
    Object.defineProperty(steps, id, { value: canonical, enumerable: true, writable: true, configurable: true });
  }
  return JSON.parse(canonicalJson({ ...flow, steps })) as FlowDocumentV1;
}

/**
 * Every judge a workflow's flow embeds (workflows design W3, plan B3): each judge step's and each route's, in the
 * printer's order, every copy — so each is checked against its stored version — beside the gate's own `agentic` one.
 */
export function flowJudgeDocuments(rule: Pick<CanonicalFullRuleDocument, 'flow'>): readonly CanonicalJudgeDocument[] {
  const flow = rule.flow;
  if (flow === undefined) return [];
  const judges: CanonicalJudgeDocument[] = [];
  for (const id of Object.keys(flow.steps).sort()) {
    const step = flow.steps[id] as FlowStep;
    if (step.kind === 'judge') judges.push(step.ask.judge as unknown as CanonicalJudgeDocument);
    if (step.kind === 'route' && step.judge !== undefined)
      judges.push(step.judge.judge as unknown as CanonicalJudgeDocument);
  }
  return judges;
}

/**
 * The judge versions a workflow's flow binds into its approval, each once and none the gate's judge already binds:
 * what a disclosure binding derives beside the rule's own.
 */
export function boundFlowJudges(
  rule: Pick<CanonicalFullRuleDocument, 'flow' | 'agentic'>,
): readonly CanonicalJudgeDocument[] {
  const seen = new Set<string>();
  if (rule.agentic !== undefined) seen.add(`${rule.agentic.judge.judgeId}@${rule.agentic.judge.version}`);
  const bound: CanonicalJudgeDocument[] = [];
  for (const judge of flowJudgeDocuments(rule)) {
    const key = `${judge.judgeId}@${judge.version}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bound.push(judge);
  }
  return bound;
}

/** Refuses a workflow document with a flow that is over 48 KiB as canonical JSON (§4.1). */
export function assertFlowDocumentSize(rule: CanonicalFullRuleDocument): void {
  if (rule.flow === undefined) return;
  const bytes = Buffer.byteLength(canonicalJson(rule));
  if (bytes > FLOW_DOCUMENT_MAX_BYTES)
    refuse(
      'DOCUMENT_TOO_LARGE',
      `the workflow is ${bytes} bytes as canonical JSON, and a workflow with a flow is at most ${FLOW_DOCUMENT_MAX_BYTES}: split it into two`,
    );
}

/**
 * Refuses, in a workflow without a flow, the targets only a flow can deliver to: a session target that gives the
 * session the flow chose, and a Linear change, which acts on the issue an earlier step made (W5).
 */
export function assertNoFlowOnlyTargets(targets: readonly TargetDocument[]): void {
  for (const target of targets) {
    if (target.kind === 'session' && 'flow' in target.find)
      refuse(
        'FLOW_ONLY_TARGET',
        `the session target ${target.targetId} gives the session a flow chose, and this workflow has no flow`,
      );
    if (target.kind === 'linear-change')
      refuse(
        'FLOW_ONLY_TARGET',
        `the Linear change ${target.targetId} changes the issue an earlier step made, and this workflow has no flow`,
      );
  }
}

/**
 * A `namespace.workflow` names one workflow among the active ones (W24): a workflow whose events are named as another
 * active workflow's is refused, naming the pair. Checked as a lane is, at every gate that re-plans an activation.
 */
export function assertFlowEventNameFree(database: DatabaseSync, rule: CanonicalFullRuleDocument): void {
  const events = rule.flow?.events;
  if (events === undefined) return;
  const holder = database
    .prepare(
      `SELECT pointer.object_id AS rule_id
         FROM active_versions AS pointer
         JOIN rule_versions AS stored ON stored.rule_id = pointer.object_id AND stored.version = pointer.version
        WHERE pointer.kind = 'rule' AND pointer.object_id <> ?
          AND json_extract(stored.document, '$.flow.events.namespace') = ?
          AND json_extract(stored.document, '$.flow.events.workflow') = ?
        ORDER BY pointer.object_id
        LIMIT 1`,
    )
    .get(rule.ruleId, events.namespace, events.workflow) as { rule_id: string } | undefined;
  if (holder !== undefined)
    refuse(
      'EVENT_NAME_IN_USE',
      `${events.namespace}.${events.workflow} already names another active workflow's events; a workflow's events name it alone`,
    );
}

/**
 * Chaining (W34) can slip from 0.36 on its own: until the evaluator waits for raised events, a workflow that starts on
 * one is refused at activation, and nothing else depends on it.
 */
export const FLOW_CHAINS_AVAILABLE = false;

/** Refuses, at activation, a workflow that starts on a raised event while chains are not available. */
export function assertFlowChainAvailable(rule: CanonicalFullRuleDocument): void {
  if (rule.flow?.on !== undefined && !FLOW_CHAINS_AVAILABLE)
    refuse(
      'CHAIN_NOT_AVAILABLE',
      'a workflow that starts on a raised event needs chains, which this event service does not run yet',
    );
}

/** What a closed slot is filled from, for one run: its id, its settled steps' closed outputs, and its trigger. */
export interface ClosedSlotValues {
  readonly runId: string;
  readonly flow: FlowDocumentV1;
  readonly output: (stepId: StepId) => Readonly<Record<string, JsonValue>> | null;
  readonly trigger: Readonly<Record<string, JsonValue>> | null;
}

/**
 * The value a closed slot names in one run (§4.1; the one slot resolver every step and target uses): `{{run}}` is the
 * run's id; `{{steps.<step>.<name>}}` that step's closed output by name — or, as a Linear step nests its issue under
 * `issue` (plan I5), the issue's `id`, `identifier` or `url`; `{{trigger.…}}` a chained run's trigger data. Undefined
 * when there is none yet, and always for a session's summary, which only a Linear change renders, sealed.
 */
export function closedSlotValue(slot: string, values: ClosedSlotValues): JsonValue | undefined {
  if (slot === 'run') return values.runId;
  const [root, ...rest] = slot.split('.');
  if (root === 'trigger') {
    const got = values.trigger === null ? undefined : getPointer(values.trigger as JsonValue, `/${rest.join('/')}`);
    return got?.found ? got.value : undefined;
  }
  if (root !== 'steps' || rest.length !== 2) return undefined;
  const [stepId, name] = rest as [string, string];
  if (name === 'summary') return undefined;
  const output = values.output(stepId);
  if (output === null) return undefined;
  if (Object.hasOwn(output, name)) return output[name];
  const issue = output.issue;
  return typeof issue === 'object' && issue !== null && !Array.isArray(issue)
    ? (issue as Readonly<Record<string, JsonValue>>)[name]
    : undefined;
}

/** A closed slot's value as text: a string as it is, anything else as JSON, and nothing for none (§4.1). */
export function closedSlotText(slot: string, values: ClosedSlotValues): string {
  const found = closedSlotValue(slot, values);
  if (found === undefined || found === null) return '';
  return typeof found === 'string' ? found : canonicalJson(found);
}
