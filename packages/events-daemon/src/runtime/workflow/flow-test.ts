import type { DatabaseSync } from 'node:sqlite';
import { CommsError, newBoundary, wrapUntrusted } from '@agentcomms/core';
import {
  buildSessionPrompt,
  catalogueEntry,
  compileMapping,
  contextFieldValues,
  FAILURE_OUTCOMES,
  type FlowDocumentV1,
  type FlowStep,
  type JsonValue,
  nextSteps,
  type Place,
  type ResolvedContextPart,
  type RulePart,
  STEP_OUTCOMES,
  type StepId,
  type StepKind,
  stepOrder,
  workflowEventType,
} from '@agentcomms/events';
import { type CanonicalFullRuleDocument, canonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import { assertFlowChainAvailable, assertFlowEventNameFree } from '../../domain/flow.ts';
import { EventDomainError } from '../../domain/lifecycle.ts';
import { mappedFields, renderLinearIssue } from '../../domain/linear-target.ts';
import { SESSION_MODE_WORDS, SESSION_PROVIDER_NAMES } from '../../domain/session-target.ts';
import { type CatalogueExampleSelector, exactCatalogueExample, runCatalogueRuleTest } from '../b3-retained-control.ts';
import { createWorkflowEventSink, type PreparedWorkflowEvent } from '../events/sink.ts';
import { evaluateRuleProjection } from '../mapping.ts';
import type { Output, RunMessage, RunView, StepTransition, WaitKind } from './contracts.ts';
import { runMessageOf } from './run-message.ts';

/*
 * Trying a workflow (workflows design §7.7; plan B7). `workflow check` says what is wrong with a document and writes
 * nothing. `workflow test` walks a flow over a catalogue example, each step answering with the outcome named for it, or
 * its first, and does no I/O. `workflow test-retained` and a shadow version walk the same way, except that the steps
 * that only read — a condition, a judge, Which project?, a find — may answer for real. Every effect is a "would": its
 * line, the prompt and issue it would have written, with their envelopes, and each event it would raise, with its data.
 * Nothing here starts, makes, writes, notifies or raises anything.
 */

/** `workflow check`'s result (plan I6): `ok`, and every problem, each with its closed code. */
export interface RuleCheckResultV1 {
  readonly ok: boolean;
  readonly problems: readonly {
    readonly code: string;
    readonly message: string;
    readonly stepId: string | null;
    readonly pointer: string | null;
  }[];
}

/** One step of a try: its outcome, what it would have done, the prompt and issue as written, and its events. */
export interface FlowTestStepV1 {
  readonly stepId: string;
  readonly kind: StepKind;
  readonly outcome: string;
  readonly would: readonly RulePart[];
  readonly prompt?: string;
  readonly issue?: { readonly title: string; readonly description: string };
  readonly events: readonly { readonly type: string; readonly data: JsonValue }[];
}

/** `workflow test`'s result for a workflow with a flow (plan I6): the path the try took and each step on it. */
export interface FlowTestResultV1 {
  readonly ruleId: string;
  readonly version: number;
  readonly path: readonly string[];
  readonly steps: readonly FlowTestStepV1[];
}

/** What a step that only reads answered for real (test-retained, shadow), or null to take the named or first outcome. */
export type FlowAnswer = (input: {
  readonly run: RunView;
  /** The message a retained try is about, as a run's record would keep it (W36), else null. */
  readonly message: RunMessage | null;
  /** The run's mapped values, as its record holds them. */
  readonly fields: Readonly<Record<string, JsonValue>>;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly outputs: ReadonlyMap<StepId, Output>;
}) => Promise<{ readonly outcome: string; readonly output: Output } | null>;

/** The run id a try names in the events it would raise: no run is made. */
export const TRY_RUN_ID = 'wfr_00000000000000000000000000';

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const value = (text: string): RulePart => ({ text, kind: 'value' });
const untrusted = (text: string): RulePart => ({ text, kind: 'untrusted' });

/** The kinds that only read: in a try on a retained message, and in a shadow, they may answer for real. */
export const TRY_READING_KINDS: ReadonlySet<StepKind> = new Set(['condition', 'judge', 'route', 'find-session']);

const TURN_END_OUTCOMES = [
  'completed',
  'failed',
  'stopped',
  'done',
  'needs-the-person',
  'not-mine',
  'blocked',
  'timed-out',
];

/** The outcomes a step can have: its kind's, narrowed by its own fields (as `@agentcomms/events`' graph narrows them). */
export function stepOutcomes(step: FlowStep): readonly string[] {
  if (step.kind === 'split') return ['split'];
  if (step.kind === 'wait') {
    if ('sessionIdle' in step.for) return ['free', 'timed-out'];
    if ('time' in step.for) return ['elapsed', 'timed-out'];
    return TURN_END_OUTCOMES;
  }
  if (step.kind === 'find-session' && step.only === 'idle') return ['idle', 'none'];
  return STEP_OUTCOMES[step.kind];
}

/** A step's outcome that means it did what it does: its first. */
export function successOutcome(step: FlowStep): string {
  return stepOutcomes(step)[0] as string;
}

/**
 * `--outcome <step>=<outcome>`, checked against the flow: each names one of its steps and one of that step's outcomes.
 * A workflow without a flow takes none.
 */
export function flowTestOutcomes(flow: FlowDocumentV1 | undefined, raw: unknown): Readonly<Record<StepId, string>> {
  if (raw === undefined) return {};
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    throw new CommsError('USAGE', 'the outcomes are step ids and their outcomes');
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 0 && flow === undefined)
    throw new CommsError('USAGE', 'only a workflow with a flow takes --outcome: its steps answer with them');
  const outcomes: Record<StepId, string> = {};
  for (const [stepId, outcome] of entries) {
    const step = flow?.steps[stepId];
    if (step === undefined || !Object.hasOwn(flow?.steps ?? {}, stepId))
      throw new CommsError('USAGE', `the workflow has no step ${stepId}`);
    if (typeof outcome !== 'string' || !stepOutcomes(step).includes(outcome))
      throw new CommsError(
        'USAGE',
        `the step ${stepId} answers ${stepOutcomes(step).join(', ')}, not ${String(outcome)}`,
      );
    Object.defineProperty(outcomes, stepId, { value: outcome, enumerable: true });
  }
  return outcomes;
}

/** The workflow's target a deliver step names. */
function targetOf(rule: CanonicalFullRuleDocument, step: Extract<FlowStep, { kind: 'deliver' }>) {
  return rule.targets.find(
    (target) => target.targetId === step.target.targetId && target.version === step.target.version,
  );
}

/** Where a session step works, in words: a project's folders, a run-made worktree, a folder, a lane, a conversation. */
function placeParts(place: Place, outputs: ReadonlyMap<StepId, Output>): RulePart[] {
  if ('project' in place) {
    const chosen = outputs.get(place.project);
    const name = typeof chosen?.projectName === 'string' ? chosen.projectName : null;
    return name === null
      ? [plain('in a folder of the project the step '), value(place.project), plain(' chooses')]
      : [plain('in a folder of the project '), value(name)];
  }
  if ('worktree' in place) return [plain('in the worktree the step '), value(place.worktree), plain(' makes')];
  if ('folder' in place) return [plain('in '), untrusted(place.folder)];
  if ('lane' in place) return [plain('behind the agent window bound to lane '), value(place.lane)];
  return [plain('that took this conversation')];
}

/** The type a step's event has, `<namespace>.<workflow>.<step>.<event>`, when the flow names its events. */
function eventType(flow: FlowDocumentV1, stepId: string, event: string): string {
  const named = flow.events;
  return named === undefined ? `${stepId}.${event}` : workflowEventType(named.namespace, named.workflow, stepId, event);
}

/** What the step would have done, in parts: an effect's "would", or the answer a deciding step gave. */
function wouldParts(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly flow: FlowDocumentV1;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly outcome: string;
  readonly output: Output;
  readonly named: boolean;
  readonly real: boolean;
  readonly outputs: ReadonlyMap<StepId, Output>;
}): RulePart[] {
  const { step, outcome } = input;
  const answered = (): RulePart[] => [
    plain(input.real ? 'Answers ' : input.named ? 'Answers, as asked, ' : 'Answers, as its first outcome, '),
    value(outcome),
  ];
  const instead = FAILURE_OUTCOMES[step.kind]?.includes(outcome) === true;
  const tail = (): RulePart[] =>
    instead ? [plain(' — answering '), value(outcome), plain(', as asked, instead')] : [];
  switch (step.kind) {
    case 'condition':
    case 'judge':
    case 'find-session':
    case 'wait':
      return answered();
    case 'route': {
      const project = typeof input.output.projectName === 'string' ? input.output.projectName : null;
      return [...answered(), ...(project === null ? [] : [plain(': '), value(project)])];
    }
    case 'split':
      return [plain('Goes on along each of '), value(step.branches.join(', '))];
    case 'start-session':
      return [
        plain(`Would have started a ${SESSION_PROVIDER_NAMES[step.provider] ?? step.provider} session `),
        ...placeParts(step.in, input.outputs),
        plain(`, where ${SESSION_MODE_WORDS[step.mode] ?? step.mode}`),
        ...tail(),
      ];
    case 'worktree':
      return [
        plain('Would have made a worktree of the project the step '),
        value(step.project),
        plain(' chose, on the branch '),
        untrusted(step.branch),
        ...tail(),
      ];
    case 'deliver': {
      const target = targetOf(input.rule, step);
      return [
        plain('Would have delivered to '),
        value(`${step.target.targetId}@${step.target.version}`),
        ...(target === undefined ? [] : [plain(' ('), value(target.kind), plain(')')]),
        ...(step.to !== undefined && 'session' in step.to
          ? [plain(', to the session the step '), value(step.to.session.join(' or ')), plain(' settled with')]
          : []),
        ...(step.to !== undefined && 'issue' in step.to
          ? [plain(', on the issue the step '), value(step.to.issue), plain(' made')]
          : []),
        ...tail(),
      ];
    }
    case 'notify':
      return [plain('Would have shown the notice '), untrusted(step.text)];
    case 'raise':
      return [plain('Would have raised '), value(eventType(input.flow, input.stepId, step.name))];
  }
}

/** What a step's output is in a try: a raise's name, the first project a route could choose; nothing else is made. */
function wouldOutput(step: FlowStep, outcome: string, eventId: string): Output {
  if (step.kind === 'raise') return { event: eventId, name: step.name };
  if (step.kind === 'route' && outcome === 'chosen' && step.candidates[0] !== undefined)
    return { project: step.candidates[0].projectId, projectName: step.candidates[0].name };
  if (step.kind === 'wait') {
    const waitsFor = Object.keys(step.for)[0];
    return {
      for: waitsFor === 'sessionIdle' ? 'session-idle' : waitsFor === 'time' ? 'time' : 'turn-end',
      reported: null,
    };
  }
  return {};
}

/** The data a template's slots read in a try: the mapped values, and the steps' closed outputs under `steps`. */
function slotData(data: JsonValue, outputs: ReadonlyMap<StepId, Output>): JsonValue {
  const base = typeof data === 'object' && data !== null && !Array.isArray(data) ? data : {};
  return { ...base, steps: Object.fromEntries(outputs), run: TRY_RUN_ID };
}

/** The prompt a session would be sent, as written, every sender's text in one envelope's boundary. */
function promptFor(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly target: Extract<CanonicalFullRuleDocument['targets'][number], { kind: 'session' }>;
  readonly data: JsonValue;
  readonly outputs: ReadonlyMap<StepId, Output>;
}): string | undefined {
  const parts: ResolvedContextPart[] = [];
  for (const part of input.target.context) {
    if ('text' in part) parts.push({ kind: 'text', text: part.text });
    else if ('fields' in part)
      parts.push({ kind: 'fields', fields: part.fields, values: contextFieldValues([part], input.data) });
    else if ('step' in part) {
      const found = input.outputs.get(part.step)?.[part.field];
      parts.push(
        found === undefined
          ? { kind: 'step', step: part.step, field: part.field }
          : { kind: 'step', step: part.step, field: part.field, value: found },
      );
    }
    // A file is read, and a model writes, only when a match is passed on: a try reads and asks nothing.
  }
  const boundary = newBoundary();
  const built = buildSessionPrompt({
    ruleId: input.rule.ruleId,
    channel: input.rule.source.channel,
    account: input.rule.source.accountIds[0] ?? '',
    parts,
    instruction: input.target.instruction,
    envelope: (text, source) =>
      wrapUntrusted(text, { field: source === 'message' ? 'event' : source, id: 'workflow-test' }, boundary),
  });
  return built.ok ? built.value : undefined;
}

/** The issue a Linear step would have made, as written: each slot in its labelled quote. */
function issueFor(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly target: Extract<CanonicalFullRuleDocument['targets'][number], { kind: 'linear' }>;
  readonly data: JsonValue;
  readonly outputs: ReadonlyMap<StepId, Output>;
}): { readonly title: string; readonly description: string } | undefined {
  const definition = catalogueEntry(input.rule.event.type, input.rule.event.version);
  if (!definition.ok) return undefined;
  const compiled = compileMapping(definition.value as never, input.rule.mapping);
  if (!compiled.ok) return undefined;
  return renderLinearIssue({
    target: input.target,
    ruleId: input.rule.ruleId,
    ruleVersion: input.rule.version,
    deliveryId: 'workflow-test',
    data: slotData(input.data, input.outputs),
    fields: mappedFields(compiled.value),
  });
}

/** A sink that seals nothing: it says which events a transition would raise, and with what data, writing nothing. */
function eventPreview(installationId: string) {
  let counter = 0;
  const sink = createWorkflowEventSink({
    cipher: { encrypt: async () => Buffer.alloc(0) },
    installationId,
    newEventId: () => {
      counter += 1;
      return `wfe_${String(counter).padStart(26, '0')}`;
    },
  });
  return async (transitions: readonly StepTransition[]) =>
    ((await sink.prepare(transitions)).rows as readonly PreparedWorkflowEvent[]).map((row) => ({
      type: row.type,
      data: row.data as unknown as JsonValue,
    }));
}

/** The transitions a step goes through, as the engine would commit them: started, waiting for a wait, then settled. */
function stepTransitions(input: {
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly outcome: string;
  readonly output: Output;
  readonly path: readonly StepId[];
  readonly at: number;
}): readonly StepTransition[] {
  const flow = input.rule.flow as FlowDocumentV1;
  const base = {
    run: input.run,
    rule: input.rule,
    stepId: input.stepId,
    outcome: null,
    output: null,
    attempt: 1,
    index: stepOrder(flow).indexOf(input.stepId) + 1,
    path: input.path.filter((id) => id !== input.stepId),
    durationMs: null,
    error: null,
    nextAt: null,
    wait: null,
    at: input.at,
  } as const;
  const failure = FAILURE_OUTCOMES[input.step.kind]?.includes(input.outcome) === true;
  const forWait = input.output.for;
  const waitKind: WaitKind = forWait === 'session-idle' || forWait === 'turn-end' ? forWait : 'time';
  const transitions: StepTransition[] = [{ ...base, transition: 'started' }];
  if (input.step.kind === 'wait')
    transitions.push({ ...base, transition: 'waiting', wait: { kind: waitKind, since: input.at } });
  transitions.push({
    ...base,
    transition: failure ? 'failed' : 'succeeded',
    outcome: input.outcome,
    output: input.output,
    path: input.path,
    durationMs: 0,
  });
  return transitions;
}

/**
 * One step of a try, or of a shadow run, as the person reads it: what it would have done, the prompt or issue it would
 * have written, with their envelopes, and the events it would raise, with their data. It writes nothing.
 */
export async function renderTryStep(input: {
  readonly run: RunView;
  readonly rule: CanonicalFullRuleDocument;
  readonly stepId: StepId;
  readonly step: FlowStep;
  readonly outcome: string;
  readonly output: Output;
  /** The run's mapped values: the prompt's fields and the issue's slots. */
  readonly data: JsonValue;
  readonly outputs: ReadonlyMap<StepId, Output>;
  readonly path: readonly StepId[];
  readonly named: boolean;
  readonly real: boolean;
  readonly installationId: string;
  readonly at: number;
}): Promise<FlowTestStepV1> {
  const flow = input.rule.flow as FlowDocumentV1;
  const { step, outcome } = input;
  const failure = FAILURE_OUTCOMES[step.kind]?.includes(outcome) === true;
  let prompt: string | undefined;
  let issue: { readonly title: string; readonly description: string } | undefined;
  if (step.kind === 'deliver' && !failure) {
    const target = targetOf(input.rule, step);
    if (target?.kind === 'session')
      prompt = promptFor({ rule: input.rule, target, data: input.data, outputs: input.outputs });
    if (target?.kind === 'linear')
      issue = issueFor({ rule: input.rule, target, data: input.data, outputs: input.outputs });
  }
  const events = await eventPreview(input.installationId)(stepTransitions(input));
  return {
    stepId: input.stepId,
    kind: step.kind,
    outcome,
    would: wouldParts({
      rule: input.rule,
      flow,
      stepId: input.stepId,
      step,
      outcome,
      output: input.output,
      named: input.named,
      real: input.real,
      outputs: input.outputs,
    }),
    ...(prompt === undefined ? {} : { prompt }),
    ...(issue === undefined ? {} : { issue }),
    events,
  };
}

/** The output a step would settle with when it is not run: a raise's event and name, a route's first project. */
export function wouldStepOutput(step: FlowStep, outcome: string, eventId: string): Output {
  return wouldOutput(step, outcome, eventId);
}

/**
 * Walks the flow from its start (§7.7): each step answers — for real when `answer` gives a word, else with the outcome
 * named for it, else its first — and its arrows lead on, every branch of a split. Nothing is written.
 */
export async function tryFlow(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly data: JsonValue;
  readonly outcomes?: Readonly<Record<StepId, string>> | undefined;
  readonly answer?: FlowAnswer | undefined;
  readonly installationId: string;
  readonly now: () => number;
  readonly eventId?: string | undefined;
  readonly message?: RunMessage | null | undefined;
}): Promise<FlowTestResultV1> {
  const flow = input.rule.flow;
  if (flow === undefined) throw new CommsError('USAGE', 'only a workflow with a flow is walked');
  const outcomes = input.outcomes ?? {};
  const startedAt = input.now();
  const run: RunView = {
    id: TRY_RUN_ID,
    ruleId: input.rule.ruleId,
    ruleVersion: input.rule.version,
    accountId: input.rule.source.accountIds[0] ?? '',
    eventId: input.eventId ?? 'workflow-test',
    depth: 0,
    parentRunId: null,
    startedAt,
    expiresAt: startedAt + flow.limits.runMs,
    shadow: false,
  };
  const fields =
    typeof input.data === 'object' && input.data !== null && !Array.isArray(input.data)
      ? (input.data as Readonly<Record<string, JsonValue>>)
      : {};
  const preview = eventPreview(input.installationId);
  const runTransition = (kind: 'run-started' | 'run-finished' | 'run-failed', path: readonly StepId[]) =>
    preview([
      {
        run,
        rule: input.rule,
        stepId: null,
        transition: kind,
        outcome: null,
        output: { steps: path.length, endCode: kind === 'run-failed' ? 'STEP_FAILED' : null },
        attempt: 0,
        index: 0,
        path,
        durationMs: null,
        error: kind === 'run-failed' ? 'STEP_FAILED' : null,
        nextAt: null,
        wait: null,
        at: input.now(),
      },
    ]);
  const path: StepId[] = [];
  const outputs = new Map<StepId, Output>();
  const steps: FlowTestStepV1[] = [];
  const queue: StepId[] = [flow.start];
  const seen = new Set<StepId>();
  let failed = false;
  let raised = 0;
  const started = await runTransition('run-started', []);
  while (queue.length > 0) {
    const stepId = queue.shift() as StepId;
    if (seen.has(stepId)) continue;
    seen.add(stepId);
    const step = flow.steps[stepId];
    if (step === undefined || !Object.hasOwn(flow.steps, stepId)) continue;
    const real =
      TRY_READING_KINDS.has(step.kind) && input.answer !== undefined
        ? await input.answer({ run, message: input.message ?? null, fields, stepId, step, outputs })
        : null;
    const named = Object.hasOwn(outcomes, stepId);
    const outcome = real?.outcome ?? (named ? (outcomes[stepId] as string) : successOutcome(step));
    if (step.kind === 'raise') raised += 1;
    const output = real?.output ?? wouldOutput(step, outcome, `wfe_${String(raised).padStart(26, '0')}`);
    outputs.set(stepId, output);
    path.push(stepId);
    const next = nextSteps(step, step.kind === 'split' ? 'split' : outcome).filter(
      (id) => Object.hasOwn(flow.steps, id) && !seen.has(id),
    );
    if (FAILURE_OUTCOMES[step.kind]?.includes(outcome) === true && next.length === 0) failed = true;
    queue.push(...next);
    const rendered = await renderTryStep({
      run,
      rule: input.rule,
      stepId,
      step,
      outcome,
      output,
      data: input.data,
      outputs,
      path: [...path],
      named,
      real: real !== null,
      installationId: input.installationId,
      at: input.now(),
    });
    steps.push(steps.length === 0 ? { ...rendered, events: [...started, ...rendered.events] } : rendered);
  }
  const last = steps.at(-1);
  if (last !== undefined) {
    const ending = await runTransition(failed ? 'run-failed' : 'run-finished', [...path]);
    steps[steps.length - 1] = { ...last, events: [...last.events, ...ending] };
  }
  return { ruleId: input.rule.ruleId, version: input.rule.version, path, steps };
}

/** A walk that never started: the workflow's own gate said no to the message, so no run would be made. */
function noRun(rule: CanonicalFullRuleDocument): FlowTestResultV1 {
  return { ruleId: rule.ruleId, version: rule.version, path: [], steps: [] };
}

/**
 * `workflow test` (§7.7), the owner's path: a workflow without a flow is tested as before; one with a flow is walked over
 * the catalogue example, its mapped values as a match would map them, each step answering with the outcome named for
 * it, or its first. No I/O.
 */
export async function runRuleTest(input: {
  readonly document: unknown;
  readonly catalogue: CatalogueExampleSelector;
  readonly outcomes?: unknown;
  readonly installationId: string;
  readonly now: () => number;
}): Promise<unknown> {
  const rule = canonicalFullRuleDocument(input.document);
  const outcomes = flowTestOutcomes(rule.flow, input.outcomes);
  if (rule.flow === undefined) return runCatalogueRuleTest({ document: input.document, catalogue: input.catalogue });
  const event = exactCatalogueExample(input.catalogue, rule);
  const evaluated = evaluateRuleProjection(rule, event);
  if (evaluated === null || 'rejected' in evaluated) return noRun(rule);
  return tryFlow({
    rule,
    data: evaluated.mapped.data as JsonValue,
    outcomes,
    installationId: input.installationId,
    now: input.now,
  });
}

/** A try on a retained message (§7.7): its mapped values, and the steps that only read answering for real. */
export async function tryRetainedFlow(input: {
  readonly rule: CanonicalFullRuleDocument;
  readonly event: Record<string, unknown>;
  readonly eventId?: string | undefined;
  readonly answer: FlowAnswer;
  readonly installationId: string;
  readonly now: () => number;
}): Promise<FlowTestResultV1> {
  const evaluated = evaluateRuleProjection(input.rule, input.event);
  if (evaluated === null || 'rejected' in evaluated) return noRun(input.rule);
  return tryFlow({
    rule: input.rule,
    data: evaluated.mapped.data as JsonValue,
    answer: input.answer,
    installationId: input.installationId,
    now: input.now,
    eventId: input.eventId,
    // The message's own ids, as a run of a flow that finds by thread keeps them, so such a find answers for real.
    message: runMessageOf(input.rule, input.event) ?? null,
  });
}

/**
 * `workflow check` (plan B7, I6): the document as the event service reads it — canonical, its flow checked by
 * `checkFlow` and against its own workflow, its events' name free among the active workflows — with every problem
 * found. It reads, and writes nothing.
 */
export function checkRuleDocument(database: DatabaseSync, document: unknown): RuleCheckResultV1 {
  try {
    const rule = canonicalFullRuleDocument(document);
    assertFlowEventNameFree(database, rule);
    assertFlowChainAvailable(rule);
    return { ok: true, problems: [] };
  } catch (error) {
    if (error instanceof EventDomainError) {
      const listed = error.details?.problems;
      if (error.code === 'FLOW_INVALID' && Array.isArray(listed))
        return {
          ok: false,
          problems: listed.map((problem) => {
            const entry = problem as Readonly<Record<string, unknown>>;
            return {
              code: String(entry.code),
              message: String(entry.message),
              stepId: typeof entry.stepId === 'string' ? entry.stepId : null,
              pointer: typeof entry.pointer === 'string' ? entry.pointer : null,
            };
          }),
        };
      return { ok: false, problems: [{ code: error.code, message: error.message, stepId: null, pointer: null }] };
    }
    if (error instanceof CommsError)
      return {
        ok: false,
        problems: [{ code: 'VERSION_DOCUMENT_INVALID', message: error.message, stepId: null, pointer: null }],
      };
    throw error;
  }
}
