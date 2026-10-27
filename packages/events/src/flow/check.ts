/**
 * `checkFlow` (workflows design §4.1): what a flow must be before anything else looks at it, pure, as the event
 * service's canonicalisers are. It copies the flow through canonical JSON, then builds the canonical result field by
 * field, refusing any key a shape does not have. What needs the event service — its accounts, folders, targets,
 * Linear and the other active workflows — is activation's to refuse, after this.
 *
 * It refuses: a malformed shape, a reserved or malformed step id, more than 32 steps, a start or an arrow to nothing,
 * an outcome the step cannot have, a cycle, a step no arrow reaches, a split of fewer than 2 or more than 8 branches or
 * whose branches meet, an `emit` word the step's kind does not have (Appendix W.3), events without `flow.events`, a
 * Raise named with a standard word, a limit outside its bounds, a malformed `on.raised` pattern, a label over 60
 * characters, and `{ thread: true }` anywhere but `find-session` (W36). Sender text never decides anything here: the
 * only names are the ones the workflow's author wrote.
 */
import type { AgenticConditionV1, CanonicalCondition, Scalar } from '../conditions/types.ts';
import { CONTEXT_LIMITS } from '../context/index.ts';
import { toAsciiDomain } from '../idna/domain.ts';
import { canonicalJson } from '../json.ts';
import { formatPointer, parsePointer } from '../pointer.ts';
import { codePointLength, compareUtf8, isWellFormed, utf8ByteLength } from '../text.ts';
import { eventsFor, RUN_EVENTS, type RunEvent, STANDARD_STEP_EVENTS, schemaOf } from '../workflow-events/catalogue.ts';
import { isEventSegment, RESERVED_NAMESPACES } from '../workflow-events/names.ts';
import { cycleStep, outcomesOf, reachableFrom, splitMeeting, stepOrder } from './graph.ts';
import {
  FLOW_BOUNDS,
  FLOW_LIMIT_CEILINGS,
  type FlowDocumentV1,
  type FlowEvents,
  type FlowLimits,
  type FlowOn,
  type FlowProblem,
  type FlowProblemCode,
  type FlowStep,
  type Place,
  RESERVED_STEP_IDS,
  type RouteCandidate,
  STEP_KINDS,
  type StepId,
} from './types.ts';

type Fields = Readonly<Record<string, unknown>>;

const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PROJECT_ID = /^[a-z0-9-]{1,64}$/;
const GIT_BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const BRANCH_LITERAL = /^[A-Za-z0-9/._-]*$/;
/** A closed slot: the run, a step's closed output, or a chained run's trigger data. */
const CLOSED_SLOT =
  /^(?:run|steps\.[a-z][a-z0-9-]{0,31}\.[a-zA-Z][a-zA-Z0-9]{0,63}|trigger(?:\.[a-zA-Z][a-zA-Z0-9-]{0,63}){1,4})$/;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what the check refuses.
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: the controls are what the check refuses.
const LINE_CONTROL = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/u;
const LIMIT_KEYS: readonly (keyof FlowLimits)[] = [
  'runsPerHour',
  'concurrentRuns',
  'sessionsPerHour',
  'worktreesPerDay',
  'linearWritesPerHour',
  'eventsPerHour',
  'runMs',
];
const REPORT_WORDS: readonly string[] = ['done', 'needs-the-person', 'not-mine', 'blocked'];
const DELIVER_KINDS: readonly string[] = ['session', 'linear', 'linear-change', 'webhook', 'sse', 'queue', 'dry-run'];
const CONDITION_DEPTH = 8;
const CONDITION_NODES = 64;
const SCALAR_BYTES = 1024;
const IN_VALUES = 256;
const POINTERS_MAX = 32;
const CANDIDATES_MAX = 8;
const FOLDER_BYTES = 1024;
const SESSION_STEPS_MAX = 8;
const BRANCH_TEMPLATE_MAX = 200;

/** Where the checks of one step or part report. */
class Report {
  readonly problems: FlowProblem[] = [];
  add(code: FlowProblemCode, message: string, stepId: StepId | null, pointer: string | null): undefined {
    this.problems.push({ code, message, stepId, pointer });
    return undefined;
  }
}

function isRecord(value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const isStepId = (value: unknown): value is StepId =>
  typeof value === 'string' && STEP_ID.test(value) && !(RESERVED_STEP_IDS as readonly string[]).includes(value);

const positiveInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 1;

const pointerOf = (...tokens: string[]): string => formatPointer(tokens);

/** Author text: non-blank, within `limit` UTF-16 code units, with no control character but a line break. */
function authorText(value: unknown, limit: number): string | undefined {
  if (typeof value !== 'string' || value.trim().length === 0 || value.length > limit) return undefined;
  if (CONTROL.test(value) || !isWellFormed(value)) return undefined;
  return value;
}

/** An absolute folder: POSIX, at most 1 KiB, with no control character and no `.` or `..` step. */
function folder(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.startsWith('/') || utf8ByteLength(value) > FOLDER_BYTES) return undefined;
  if (LINE_CONTROL.test(value) || !isWellFormed(value)) return undefined;
  if (value.split('/').some((step) => step === '.' || step === '..')) return undefined;
  return value;
}

/** Pointers into the run's mapped data: well-formed, not the whole data, each once, at most 32. */
function pointers(value: unknown, min: number): readonly string[] | undefined {
  if (!Array.isArray(value) || value.length < min || value.length > POINTERS_MAX) return undefined;
  const seen = new Set<string>();
  for (const pointer of value) {
    if (typeof pointer !== 'string' || pointer === '' || !parsePointer(pointer).ok || seen.has(pointer))
      return undefined;
    seen.add(pointer);
  }
  return value as readonly string[];
}

/**
 * A template's slots, when every one is closed (§4.1, §6.6, §6.8): the run, a step's closed output, or a chained run's
 * trigger data — never a mapped field a sender wrote, and never a session's summary, which only a Linear comment may
 * name. Returns the literal text between the slots, or a message.
 */
function closedSlots(text: string): { literal: string } | { message: string } {
  let literal = '';
  let at = 0;
  while (at < text.length) {
    const open = text.indexOf('{{', at);
    const close = text.indexOf('}}', at);
    if (open === -1) {
      if (close !== -1) return { message: 'a }} closes no {{' };
      literal += text.slice(at);
      break;
    }
    if (close !== -1 && close < open) return { message: 'a }} closes no {{' };
    const end = text.indexOf('}}', open + 2);
    if (end === -1) return { message: 'a {{ slot has no closing }}' };
    literal += text.slice(at, open);
    const name = text.slice(open + 2, end);
    if (!CLOSED_SLOT.test(name))
      return {
        message: `{{${name}}} is not a closed slot: name the run, {{steps.<step>.<output>}} or {{trigger.<output>}}, never a field a sender wrote`,
      };
    if (name.startsWith('steps.') && name.endsWith('.summary'))
      return { message: "a session's summary is written by an agent: only a Linear comment may name it" };
    at = end + 2;
  }
  return { literal };
}

interface ConditionState {
  nodes: number;
}

function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/** A condition step's path: under `/fields`, `/steps/<step>/<output>` or `/trigger`. */
function conditionPath(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const tokens = parsePointer(value);
  if (!tokens.ok) return undefined;
  const [root, ...rest] = tokens.value;
  if (root === 'fields' || root === 'trigger') return rest.length >= 1 ? value : undefined;
  if (root === 'steps') return rest.length >= 2 && STEP_ID.test(rest[0] as string) ? value : undefined;
  return undefined;
}

function operandFits(value: Scalar): boolean {
  return typeof value !== 'string' || utf8ByteLength(value) <= SCALAR_BYTES;
}

/**
 * A condition step's tree (D5's canonical form) over the run's own values: its mapped fields, its steps' closed
 * outputs, a chained run's trigger. Its shape is checked here; whether each operand is one of an output's closed words
 * is activation's, which knows each step's outputs.
 */
function condition(value: unknown, state: ConditionState, depth: number): CanonicalCondition | string {
  if (depth > CONDITION_DEPTH) return `a condition is deeper than ${CONDITION_DEPTH}`;
  state.nodes += 1;
  if (state.nodes > CONDITION_NODES) return `a condition has more than ${CONDITION_NODES} nodes`;
  if (!isRecord(value)) return 'a condition is an object';
  const keys = Object.keys(value);
  const only = (...allowed: string[]) => keys.every((key) => allowed.includes(key));
  if (Object.hasOwn(value, 'all') || Object.hasOwn(value, 'any')) {
    const key = Object.hasOwn(value, 'all') ? 'all' : 'any';
    if (!only(key)) return `${key} is the condition object's only key`;
    const children = value[key];
    if (!Array.isArray(children) || children.length === 0) return `${key} is a non-empty array of conditions`;
    const canonical: CanonicalCondition[] = [];
    for (const child of children) {
      const found = condition(child, state, depth + 1);
      if (typeof found === 'string') return found;
      canonical.push(found);
    }
    const members = canonical as [CanonicalCondition, ...CanonicalCondition[]];
    return key === 'all' ? { all: members } : { any: members };
  }
  if (Object.hasOwn(value, 'not')) {
    if (!only('not')) return "not is the condition object's only key";
    const child = condition(value.not, state, depth + 1);
    return typeof child === 'string' ? child : { not: child };
  }
  const path = conditionPath(value.path);
  if (path === undefined) return "a condition's path is under /fields, /steps/<step>/<output> or /trigger";
  const op = value.op;
  const caseSensitive = (): boolean | undefined =>
    value.caseSensitive === undefined
      ? false
      : typeof value.caseSensitive === 'boolean'
        ? value.caseSensitive
        : undefined;
  switch (op) {
    case 'exists':
      return only('path', 'op') ? { path, op } : 'exists has only path and op';
    case 'equals':
    case 'notEquals':
    case 'contains': {
      if (!only('path', 'op', 'value', 'caseSensitive')) return `${op} has path, op, value and caseSensitive only`;
      const sensitive = caseSensitive();
      if (!scalar(value.value) || sensitive === undefined)
        return `${op} has a scalar value and a boolean caseSensitive`;
      if (!operandFits(value.value)) return `a string operand has at most ${SCALAR_BYTES} UTF-8 bytes`;
      return { path, op, value: value.value, caseSensitive: sensitive };
    }
    case 'startsWith':
    case 'endsWith': {
      if (!only('path', 'op', 'value', 'caseSensitive')) return `${op} has path, op, value and caseSensitive only`;
      const sensitive = caseSensitive();
      if (typeof value.value !== 'string' || sensitive === undefined)
        return `${op} has a text value and a boolean caseSensitive`;
      if (!operandFits(value.value)) return `a string operand has at most ${SCALAR_BYTES} UTF-8 bytes`;
      return { path, op, value: value.value, caseSensitive: sensitive };
    }
    case 'in': {
      if (!only('path', 'op', 'values')) return 'in has only path, op and values';
      const values = value.values;
      if (!Array.isArray(values) || values.length === 0 || values.length > IN_VALUES)
        return `in has 1 to ${IN_VALUES} values`;
      for (const member of values)
        if (!scalar(member) || !operandFits(member)) return 'in has scalar values, each at most 1024 UTF-8 bytes';
      return { path, op, values: values as [Scalar, ...Scalar[]] };
    }
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (!only('path', 'op', 'value')) return `${op} has only path, op and value`;
      const operand = value.value;
      if (!((typeof operand === 'number' && Number.isFinite(operand)) || typeof operand === 'string'))
        return `${op} compares with a number or an instant`;
      if (!operandFits(operand)) return `a string operand has at most ${SCALAR_BYTES} UTF-8 bytes`;
      return { path, op, value: operand };
    }
    case 'domainIs': {
      if (!only('path', 'op', 'value', 'includeSubdomains'))
        return 'domainIs has path, op, value and includeSubdomains only';
      if (typeof value.value !== 'string' || typeof value.includeSubdomains !== 'boolean')
        return 'domainIs has a domain and a boolean includeSubdomains';
      if (!operandFits(value.value)) return `a string operand has at most ${SCALAR_BYTES} UTF-8 bytes`;
      const domain = toAsciiDomain(value.value);
      if (!domain.ok) return domain.issues[0]?.message ?? 'domainIs names a domain';
      return { path, op, value: domain.value, includeSubdomains: value.includeSubdomains };
    }
    default:
      return `the condition operator ${JSON.stringify(op)} is not in D5`;
  }
}

/** A judge a flow step calls (D5's static record), without the event's catalogue: its inputs are the run's values. */
function agentic(value: unknown): AgenticConditionV1 | string {
  if (!isRecord(value)) return 'a judge is an agentic condition object';
  const allowed = [
    'judge',
    'question',
    'inputs',
    'threshold',
    'onUncertain',
    'callsPerRollingHour',
    'inputTokensPerRolling30Days',
    'concurrency',
    'maxInputTokens',
    'maxOutputTokens',
  ];
  const unknown = Object.keys(value).find((key) => !allowed.includes(key));
  if (unknown !== undefined) return `a judge has no ${unknown}`;
  const judge = value.judge;
  if (
    !isRecord(judge) ||
    typeof judge.judgeId !== 'string' ||
    judge.judgeId.length === 0 ||
    !positiveInteger(judge.version)
  )
    return 'a judge embeds its complete judge document, with its id and version';
  if (typeof value.question !== 'string') return "a judge's question is text";
  const inputs = pointers(value.inputs, 0);
  if (inputs === undefined) return "a judge's inputs are JSON Pointers into the run's values, each once";
  if (
    typeof value.threshold !== 'number' ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 0 ||
    value.threshold > 1
  )
    return "a judge's threshold is a number from 0 through 1";
  const onUncertain = value.onUncertain ?? 'no-match';
  if (onUncertain !== 'no-match' && onUncertain !== 'hold') return "a judge's onUncertain is no-match or hold";
  for (const key of [
    'callsPerRollingHour',
    'inputTokensPerRolling30Days',
    'concurrency',
    'maxInputTokens',
    'maxOutputTokens',
  ] as const)
    if (!positiveInteger(value[key])) return `a judge's ${key} is a positive whole number`;
  return {
    judge: judge as AgenticConditionV1['judge'],
    question: value.question,
    inputs,
    threshold: value.threshold,
    onUncertain,
    callsPerRollingHour: value.callsPerRollingHour as number,
    inputTokensPerRolling30Days: value.inputTokensPerRolling30Days as number,
    concurrency: value.concurrency as number,
    maxInputTokens: value.maxInputTokens as number,
    maxOutputTokens: value.maxOutputTokens as number,
  };
}

/** What every step check needs from the flow around it. */
interface StepScope {
  readonly id: StepId;
  readonly steps: Fields;
  readonly limits: FlowLimits | undefined;
  readonly targetKinds: Readonly<Record<string, string>>;
  readonly report: Report;
}

const KIND_KEYS: Readonly<Record<string, readonly string[]>> = {
  condition: ['when', 'next'],
  judge: ['ask', 'next'],
  route: ['candidates', 'by', 'judge', 'inputs', 'next'],
  'find-session': ['in', 'provider', 'only', 'next'],
  'start-session': ['in', 'provider', 'mode', 'next'],
  worktree: ['project', 'base', 'branch', 'cleanup', 'next'],
  deliver: ['target', 'to', 'report', 'next'],
  wait: ['for', 'timeoutMs', 'next'],
  notify: ['text', 'next'],
  split: ['branches'],
  raise: ['name', 'fields', 'next'],
};

function place(value: unknown, kind: string, scope: StepScope): Place | undefined {
  const at = pointerOf('steps', scope.id, 'in');
  const shape = (message: string) => scope.report.add('FLOW_SHAPE', message, scope.id, at);
  if (!isRecord(value) || Object.keys(value).length !== 1)
    return shape('a place is one of { project }, { worktree }, { folder }, { lane } or { thread: true }');
  if (Object.hasOwn(value, 'thread')) {
    if (value.thread !== true) return shape('a thread place is { thread: true }');
    if (kind !== 'find-session')
      return scope.report.add(
        'FLOW_PLACE',
        'only find-session looks in this conversation: a conversation has no folder to start a session in',
        scope.id,
        at,
      );
    return { thread: true };
  }
  if (Object.hasOwn(value, 'project'))
    return isStepId(value.project) ? { project: value.project } : shape("a project place names a route step's id");
  if (Object.hasOwn(value, 'worktree'))
    return isStepId(value.worktree)
      ? { worktree: value.worktree }
      : shape("a worktree place names a worktree step's id");
  if (Object.hasOwn(value, 'folder')) {
    const found = folder(value.folder);
    return found === undefined ? shape('a folder place is an absolute folder') : { folder: found };
  }
  if (Object.hasOwn(value, 'lane')) {
    const lane = authorText(value.lane, 128);
    return lane === undefined || /[\r\n]/u.test(lane) ? shape('a lane place names its lane') : { lane };
  }
  return shape('a place is one of { project }, { worktree }, { folder }, { lane } or { thread: true }');
}

/** A step's arrows: each key an outcome it can have or `otherwise`, each value a step of the flow or `end`. */
function arrows(value: unknown, outcomes: readonly string[], scope: StepScope): Record<string, string> | undefined {
  const at = pointerOf('steps', scope.id, 'next');
  if (!isRecord(value)) return scope.report.add('FLOW_SHAPE', 'a step has its arrows in next', scope.id, at);
  let ok = true;
  const next: Record<string, string> = {};
  for (const [outcome, target] of Object.entries(value)) {
    if (outcome !== 'otherwise' && !outcomes.includes(outcome)) {
      ok = false;
      scope.report.add(
        'FLOW_OUTCOME',
        `${outcome} is not an outcome of this step: it has ${[...outcomes, 'otherwise'].join(', ')}`,
        scope.id,
        pointerOf('steps', scope.id, 'next', outcome),
      );
      continue;
    }
    if (target !== 'end' && !(typeof target === 'string' && Object.hasOwn(scope.steps, target))) {
      ok = false;
      scope.report.add(
        'FLOW_ARROW',
        `the arrow for ${outcome} goes to ${JSON.stringify(target)}, which is not a step of this flow or end`,
        scope.id,
        pointerOf('steps', scope.id, 'next', outcome),
      );
      continue;
    }
    Object.defineProperty(next, outcome, { value: target, enumerable: true, writable: true, configurable: true });
  }
  return ok ? next : undefined;
}

function candidates(value: unknown, scope: StepScope): readonly RouteCandidate[] | undefined {
  const at = pointerOf('steps', scope.id, 'candidates');
  const shape = (message: string) => scope.report.add('FLOW_SHAPE', message, scope.id, at);
  if (!Array.isArray(value) || value.length === 0 || value.length > CANDIDATES_MAX)
    return shape(`a route chooses among 1 to ${CANDIDATES_MAX} projects`);
  const seen = new Set<string>();
  const found: RouteCandidate[] = [];
  for (const candidate of value) {
    if (
      !isRecord(candidate) ||
      Object.keys(candidate).some((key) => !['projectId', 'name', 'folders', 'worktreeRoot'].includes(key))
    )
      return shape('a candidate is exactly { projectId, name, folders, worktreeRoot }');
    if (typeof candidate.projectId !== 'string' || !PROJECT_ID.test(candidate.projectId))
      return shape("a candidate's projectId is 1 to 64 lowercase letters, digits and -");
    if (seen.has(candidate.projectId)) return shape(`a route names the project ${candidate.projectId} once`);
    seen.add(candidate.projectId);
    const name = authorText(candidate.name, 80);
    if (name === undefined || /[\r\n]/u.test(name))
      return shape("a candidate's name is one line of 1 to 80 characters");
    const folders = candidate.folders;
    if (!Array.isArray(folders) || folders.length === 0) return shape('a candidate lists its approved folders');
    const canonical = folders.map(folder);
    if (canonical.some((entry) => entry === undefined) || new Set(canonical).size !== canonical.length)
      return shape("a candidate's folders are absolute folders, each once");
    const root = candidate.worktreeRoot;
    if (root !== null && folder(root) === undefined)
      return shape("a candidate's worktreeRoot is an absolute folder, or null for <checkout>-wt");
    found.push({
      projectId: candidate.projectId,
      name,
      folders: [...(canonical as string[])].sort(compareUtf8),
      worktreeRoot: root as string | null,
    });
  }
  return found;
}

/** The kind-specific fields of one step, canonical, or undefined when they are not. */
function kindFields(kind: string, step: Fields, scope: StepScope): Record<string, unknown> | undefined {
  const { id, report } = scope;
  const at = (...tokens: string[]) => pointerOf('steps', id, ...tokens);
  const shape = (message: string, pointer: string) => report.add('FLOW_SHAPE', message, id, pointer);
  const provider = (): 'claude' | 'codex' | undefined =>
    step.provider === 'claude' || step.provider === 'codex'
      ? step.provider
      : shape("a session's provider is claude or codex", at('provider'));
  switch (kind) {
    case 'condition': {
      const when = condition(step.when, { nodes: 0 }, 1);
      return typeof when === 'string' ? shape(when, at('when')) : { when };
    }
    case 'judge': {
      const ask = agentic(step.ask);
      return typeof ask === 'string' ? shape(ask, at('ask')) : { ask };
    }
    case 'route': {
      const chosen = candidates(step.candidates, scope);
      const by = step.by;
      const ways = Array.isArray(by) && by.every((way) => typeof way === 'string') ? by.join(' ') : undefined;
      if (ways !== 'hints' && ways !== 'judge' && ways !== 'hints judge')
        return shape('a route chooses by hints, by judge, or by hints then by judge', at('by'));
      const usesJudge = ways !== 'hints';
      let judge: AgenticConditionV1 | undefined;
      if (usesJudge) {
        const found = agentic(step.judge);
        if (typeof found === 'string') return shape(found, at('judge'));
        judge = found;
      } else if (step.judge !== undefined) return shape('a route by hints alone has no judge', at('judge'));
      const inputs = pointers(step.inputs, 0);
      if (inputs === undefined)
        return shape("a route's inputs are JSON Pointers into the run's mapped fields, each once", at('inputs'));
      if (chosen === undefined) return undefined;
      return {
        candidates: chosen,
        by: usesJudge ? (ways === 'judge' ? ['judge'] : ['hints', 'judge']) : ['hints'],
        ...(judge === undefined ? {} : { judge }),
        inputs,
      };
    }
    case 'find-session': {
      const where = place(step.in, kind, scope);
      const who = provider();
      if (step.only !== undefined && step.only !== 'idle')
        return shape("a find's only is idle, or it is left out", at('only'));
      if (where === undefined || who === undefined) return undefined;
      return { in: where, provider: who, ...(step.only === 'idle' ? { only: 'idle' } : {}) };
    }
    case 'start-session': {
      const where = place(step.in, kind, scope);
      const who = provider();
      if (step.mode !== 'manual' && step.mode !== 'acceptEdits' && step.mode !== 'plan')
        return shape("a session's mode is manual, acceptEdits or plan", at('mode'));
      if (where === undefined || who === undefined) return undefined;
      return { in: where, provider: who, mode: step.mode };
    }
    case 'worktree': {
      if (!isStepId(step.project)) return shape('a worktree names the route step whose project it uses', at('project'));
      const base = step.base;
      const branchBase =
        base === 'default'
          ? 'default'
          : isRecord(base) &&
              Object.keys(base).length === 1 &&
              typeof base.branch === 'string' &&
              GIT_BRANCH.test(base.branch) &&
              !base.branch.includes('..') &&
              !base.branch.endsWith('/') &&
              !base.branch.endsWith('.lock')
            ? { branch: base.branch }
            : undefined;
      if (branchBase === undefined) return shape("a worktree's base is default or { branch }", at('base'));
      const template = step.branch;
      if (typeof template !== 'string' || template.length === 0 || template.length > BRANCH_TEMPLATE_MAX)
        return shape(`a worktree's branch is a template of at most ${BRANCH_TEMPLATE_MAX} characters`, at('branch'));
      const slots = closedSlots(template);
      if ('message' in slots) return shape(slots.message, at('branch'));
      if (!BRANCH_LITERAL.test(slots.literal))
        return shape("a branch's own words are letters, digits, /, ., _ and -", at('branch'));
      if (step.cleanup !== 'keep' && step.cleanup !== 'remove-if-clean')
        return shape("a worktree's cleanup is keep or remove-if-clean", at('cleanup'));
      return { project: step.project, base: branchBase, branch: template, cleanup: step.cleanup };
    }
    case 'deliver': {
      const target = step.target;
      if (
        !isRecord(target) ||
        Object.keys(target).length !== 2 ||
        typeof target.targetId !== 'string' ||
        target.targetId.length === 0 ||
        !positiveInteger(target.version)
      )
        return shape('a deliver step names exactly { targetId, version }', at('target'));
      let to: { session: readonly StepId[] } | { issue: StepId } | undefined;
      if (step.to !== undefined) {
        const value = step.to;
        if (isRecord(value) && Object.keys(value).length === 1 && Array.isArray(value.session)) {
          const session = value.session;
          if (
            session.length === 0 ||
            session.length > SESSION_STEPS_MAX ||
            !session.every(isStepId) ||
            new Set(session).size !== session.length
          )
            return shape(
              `a delivery to a session names 1 to ${SESSION_STEPS_MAX} find or start steps, each once`,
              at('to'),
            );
          to = { session: [...session] };
        } else if (isRecord(value) && Object.keys(value).length === 1 && isStepId(value.issue))
          to = { issue: value.issue };
        else return shape('a deliver step goes to { session: [steps] } or { issue: step }', at('to'));
      }
      let report: string[] | undefined;
      if (step.report !== undefined) {
        const words = step.report;
        if (
          !Array.isArray(words) ||
          words.length === 0 ||
          !words.every((word) => REPORT_WORDS.includes(word)) ||
          new Set(words).size !== words.length
        )
          return shape(`a session reports ${REPORT_WORDS.join(', ')}, each once`, at('report'));
        report = [...words].sort(compareUtf8);
      }
      return {
        target: { targetId: target.targetId, version: target.version },
        ...(to === undefined ? {} : { to }),
        ...(report === undefined ? {} : { report }),
      };
    }
    case 'wait': {
      const runMs = scope.limits?.runMs ?? FLOW_LIMIT_CEILINGS.runMs;
      const waitsFor = step.for;
      let what: Record<string, unknown> | undefined;
      if (isRecord(waitsFor) && Object.keys(waitsFor).length === 1) {
        if (isStepId(waitsFor.turnEnd)) what = { turnEnd: waitsFor.turnEnd };
        else if (isStepId(waitsFor.sessionIdle)) what = { sessionIdle: waitsFor.sessionIdle };
        else if (isRecord(waitsFor.time) && Object.keys(waitsFor.time).length === 1) {
          const afterMs = waitsFor.time.afterMs;
          if (!positiveInteger(afterMs)) return shape('a time wait waits a positive number of milliseconds', at('for'));
          if (afterMs > runMs)
            return report.add('FLOW_LIMIT', `a wait ends within the run's deadline of ${runMs} ms`, id, at('for'));
          what = { time: { afterMs } };
        }
      }
      if (what === undefined)
        return shape('a wait is for { turnEnd: step }, { sessionIdle: step } or { time: { afterMs } }', at('for'));
      if (!positiveInteger(step.timeoutMs))
        return shape('a wait has a timeout, a positive number of milliseconds', at('timeoutMs'));
      if (step.timeoutMs > runMs)
        return report.add(
          'FLOW_LIMIT',
          `a wait times out within the run's deadline of ${runMs} ms`,
          id,
          at('timeoutMs'),
        );
      return { for: what, timeoutMs: step.timeoutMs };
    }
    case 'notify': {
      const text = authorText(step.text, CONTEXT_LIMITS.textChars);
      if (text === undefined)
        return shape(`a notice is non-empty text of at most ${CONTEXT_LIMITS.textChars} characters`, at('text'));
      const slots = closedSlots(text);
      if ('message' in slots) return shape(slots.message, at('text'));
      return { text };
    }
    case 'split': {
      const branches = step.branches;
      if (
        !Array.isArray(branches) ||
        branches.length < FLOW_BOUNDS.splitMin ||
        branches.length > FLOW_BOUNDS.splitMax ||
        new Set(branches).size !== branches.length
      )
        return report.add(
          'FLOW_SPLIT_BRANCHES',
          `a split starts ${FLOW_BOUNDS.splitMin} to ${FLOW_BOUNDS.splitMax} different branches`,
          id,
          at('branches'),
        );
      const missing = branches.findIndex((branch) => typeof branch !== 'string' || !Object.hasOwn(scope.steps, branch));
      if (missing !== -1)
        return report.add(
          'FLOW_ARROW',
          `the branch ${JSON.stringify(branches[missing])} is not a step of this flow`,
          id,
          at('branches', String(missing)),
        );
      return { branches: [...branches] };
    }
    case 'raise': {
      if (!isEventSegment(step.name))
        return report.add(
          'FLOW_RAISE_NAME',
          "a Raise step's name is a lowercase segment of 1 to 32 letters, digits, _ and -",
          id,
          at('name'),
        );
      if ((STANDARD_STEP_EVENTS as readonly string[]).includes(step.name))
        return report.add('FLOW_RAISE_NAME', `${step.name} is a standard event word, not a Raise name`, id, at('name'));
      let fields: readonly string[] | undefined;
      if (step.fields !== undefined) {
        fields = pointers(step.fields, 1);
        if (fields === undefined)
          return shape(
            "a Raise step's fields are 1 to 32 JSON Pointers into the mapped fields, each once",
            at('fields'),
          );
      }
      return { name: step.name, ...(fields === undefined ? {} : { fields }) };
    }
    default:
      return undefined;
  }
}

/** One step, canonical, or undefined when anything in it is wrong (each problem reported). */
function checkStep(value: unknown, scope: StepScope): FlowStep | undefined {
  const { id, report } = scope;
  const at = (...tokens: string[]) => pointerOf('steps', id, ...tokens);
  if (!isRecord(value)) return report.add('FLOW_SHAPE', 'a step is an object', id, at());
  const kind = value.kind;
  if (typeof kind !== 'string' || !(STEP_KINDS as readonly string[]).includes(kind))
    return report.add('FLOW_SHAPE', `a step's kind is one of ${STEP_KINDS.join(', ')}`, id, at('kind'));
  const allowed = ['kind', 'label', 'emit', ...(KIND_KEYS[kind] ?? [])];
  const before = report.problems.length;
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) report.add('FLOW_SHAPE', `a ${kind} step has no ${key}`, id, at(key));
  if (kind !== 'split' && !Object.hasOwn(value, 'next'))
    report.add('FLOW_SHAPE', 'a step has its arrows in next, {} when it ends there', id, at('next'));
  let label: string | undefined;
  if (value.label !== undefined) {
    label = authorText(value.label, FLOW_BOUNDS.labelMax * 2);
    if (label === undefined || /[\r\n]/u.test(label) || codePointLength(label) > FLOW_BOUNDS.labelMax) {
      label = undefined;
      report.add('FLOW_LABEL', `a label is one line of 1 to ${FLOW_BOUNDS.labelMax} characters`, id, at('label'));
    }
  }
  const fields = kindFields(kind, value, scope);
  if (report.problems.length > before || fields === undefined) return undefined;
  const draft = { kind, ...fields } as FlowStep;
  let next: Record<string, string> | undefined;
  if (kind !== 'split') {
    next = arrows(value.next, outcomesOf(draft), scope);
    if (next === undefined) return undefined;
  }
  const emit = emitWords(value.emit, draft, scope);
  if (emit === null) return undefined;
  return {
    ...(draft as object),
    ...(label === undefined ? {} : { label }),
    ...(emit === undefined ? {} : { emit }),
    ...(next === undefined ? {} : { next }),
  } as FlowStep;
}

/**
 * A step's ticked events: words of its schema (Appendix W.3), each once, sorted; absent when none, so a flow with no
 * events keeps its bytes. A Raise step raises its one event whatever is ticked, so it has no `emit`. A deliver step
 * whose target the flow's caller does not know is left to activation, which refuses the target; its words are checked
 * as words only. Null when they are wrong.
 */
function emitWords(value: unknown, step: FlowStep, scope: StepScope): readonly string[] | undefined | null {
  const at = pointerOf('steps', scope.id, 'emit');
  if (value === undefined) return undefined;
  if (step.kind === 'raise') {
    scope.report.add('FLOW_EMIT_UNKNOWN', 'a Raise step always raises its own event, and ticks no other', scope.id, at);
    return null;
  }
  if (!Array.isArray(value)) {
    scope.report.add('FLOW_SHAPE', "a step's emit is a list of event words", scope.id, at);
    return null;
  }
  let known: readonly string[] | undefined;
  if (step.kind === 'deliver') {
    const kind = scope.targetKinds[`${step.target.targetId}@${step.target.version}`];
    if (kind !== undefined && DELIVER_KINDS.includes(kind)) known = eventsFor(schemaOf(step, kind), step);
  } else known = eventsFor(schemaOf(step), step);
  for (const [index, word] of value.entries()) {
    if (!isEventSegment(word) || (known !== undefined && !known.includes(word))) {
      scope.report.add(
        'FLOW_EMIT_UNKNOWN',
        known === undefined
          ? `${JSON.stringify(word)} is not an event word`
          : `${JSON.stringify(word)} is not an event of this step: it can raise ${known.join(', ')}`,
        scope.id,
        `${at}/${index}`,
      );
      return null;
    }
  }
  if (new Set(value).size !== value.length) {
    scope.report.add('FLOW_SHAPE', "a step's emit names each event once", scope.id, at);
    return null;
  }
  return value.length === 0 ? undefined : [...(value as string[])].sort(compareUtf8);
}

function checkLimits(value: unknown, report: Report): FlowLimits | undefined {
  if (!isRecord(value)) return report.add('FLOW_SHAPE', 'a flow writes its limits out in full', null, '/limits');
  let ok = true;
  for (const key of Object.keys(value))
    if (!(LIMIT_KEYS as readonly string[]).includes(key)) {
      ok = false;
      report.add('FLOW_SHAPE', `a flow's limits have no ${key}`, null, pointerOf('limits', key));
    }
  const limits: Record<string, number> = {};
  for (const key of LIMIT_KEYS) {
    const limit = value[key];
    if (!positiveInteger(limit) || limit > FLOW_LIMIT_CEILINGS[key]) {
      ok = false;
      report.add(
        'FLOW_LIMIT',
        `${key} is a whole number from 1 to ${FLOW_LIMIT_CEILINGS[key]}`,
        null,
        pointerOf('limits', key),
      );
    } else limits[key] = limit;
  }
  return ok ? (limits as unknown as FlowLimits) : undefined;
}

function checkEvents(value: unknown, report: Report): FlowEvents | undefined | null {
  if (value === undefined) return undefined;
  const shape = (message: string, pointer: string): null => {
    report.add('FLOW_SHAPE', message, null, pointer);
    return null;
  };
  if (!isRecord(value)) return shape("a flow's events are { namespace, workflow, run? }", '/events');
  const unknown = Object.keys(value).find((key) => !['namespace', 'workflow', 'run'].includes(key));
  if (unknown !== undefined) return shape(`a flow's events have no ${unknown}`, pointerOf('events', unknown));
  if (!isEventSegment(value.namespace))
    return shape('a namespace is a lowercase segment of 1 to 32 letters, digits, _ and -', '/events/namespace');
  if ((RESERVED_NAMESPACES as readonly string[]).includes(value.namespace))
    return shape(`the namespace ${value.namespace} is reserved for Agent Comms`, '/events/namespace');
  if (!isEventSegment(value.workflow))
    return shape(
      "a workflow's event name is a lowercase segment of 1 to 32 letters, digits, _ and -",
      '/events/workflow',
    );
  let run: string[] | undefined;
  if (value.run !== undefined) {
    const words = value.run;
    if (!Array.isArray(words)) return shape("a run's events are a list of words", '/events/run');
    const unknownWord = words.findIndex((word) => !(RUN_EVENTS as readonly unknown[]).includes(word));
    if (unknownWord !== -1) {
      report.add(
        'FLOW_EMIT_UNKNOWN',
        `${JSON.stringify(words[unknownWord])} is not a run event: a run raises ${RUN_EVENTS.join(', ')}`,
        null,
        `/events/run/${unknownWord}`,
      );
      return null;
    }
    if (new Set(words).size !== words.length) return shape("a run's events name each once", '/events/run');
    if (words.length > 0) run = [...(words as string[])].sort(compareUtf8);
  }
  return {
    namespace: value.namespace,
    workflow: value.workflow,
    ...(run === undefined ? {} : { run: run as readonly RunEvent[] }),
  };
}

/** A chained workflow's patterns (W34): four segments, the namespace and workflow literal, each once, 1 to 8. */
function checkOn(value: unknown, report: Report): FlowOn | undefined | null {
  if (value === undefined) return undefined;
  const pattern = (message: string, pointer: string): null => {
    report.add('FLOW_ON_PATTERN', message, null, pointer);
    return null;
  };
  if (!isRecord(value) || Object.keys(value).some((key) => key !== 'raised' && key !== 'withinMs'))
    return pattern('a chained workflow starts on { raised: [patterns], withinMs }', '/on');
  const raised = value.raised;
  if (!Array.isArray(raised) || raised.length === 0 || raised.length > FLOW_BOUNDS.onRaisedMax)
    return pattern(`a chained workflow names 1 to ${FLOW_BOUNDS.onRaisedMax} patterns`, '/on/raised');
  for (const [index, entry] of raised.entries()) {
    const segments = typeof entry === 'string' ? entry.split('.') : [];
    const [namespace, workflow] = segments;
    const at = `/on/raised/${index}`;
    if (segments.length !== 4 || !segments.every((segment) => segment === '*' || isEventSegment(segment)))
      return pattern(
        `${JSON.stringify(entry)} is not a pattern: four segments, each a segment or * standing alone for one`,
        at,
      );
    if (!isEventSegment(namespace) || !isEventSegment(workflow))
      return pattern('a chained workflow names the namespace and workflow it starts from, never *', at);
    if ((RESERVED_NAMESPACES as readonly string[]).includes(namespace))
      return pattern(`the namespace ${namespace} is reserved for Agent Comms`, at);
  }
  if (new Set(raised).size !== raised.length)
    return pattern('a chained workflow names each pattern once', '/on/raised');
  if (!positiveInteger(value.withinMs)) {
    report.add(
      'FLOW_LIMIT',
      "a chained workflow's withinMs is a positive number of milliseconds",
      null,
      '/on/withinMs',
    );
    return null;
  }
  return { raised: [...(raised as string[])].sort(compareUtf8), withinMs: value.withinMs };
}

const TOP_KEYS: readonly string[] = ['flowVersion', 'start', 'steps', 'limits', 'events', 'on', 'shadow'];

/**
 * Checks a flow and returns its canonical form, or every problem found. `targetKinds` maps `"<targetId>@<version>"`
 * to that target's kind, so a deliver step's `emit` is checked against its schema (W.3).
 */
export function checkFlow(
  flow: unknown,
  targetKinds: Readonly<Record<string, string>>,
): { ok: true; flow: FlowDocumentV1 } | { ok: false; problems: readonly FlowProblem[] } {
  const report = new Report();
  const refuse = () => ({ ok: false as const, problems: report.problems });
  let copy: unknown;
  try {
    copy = JSON.parse(canonicalJson(flow));
  } catch {
    report.add('FLOW_SHAPE', 'a flow is JSON', null, '');
    return refuse();
  }
  if (!isRecord(copy)) {
    report.add('FLOW_SHAPE', 'a flow is an object', null, '');
    return refuse();
  }
  for (const key of Object.keys(copy))
    if (!TOP_KEYS.includes(key)) report.add('FLOW_SHAPE', `a flow has no ${key}`, null, pointerOf(key));
  if (copy.flowVersion !== 1) report.add('FLOW_SHAPE', 'a flow is flowVersion 1', null, '/flowVersion');
  if (copy.shadow !== undefined && copy.shadow !== true)
    report.add('FLOW_SHAPE', 'shadow is true, or left out', null, '/shadow');
  const steps = copy.steps;
  if (!isRecord(steps)) {
    report.add('FLOW_SHAPE', 'a flow holds its steps in steps, by id', null, '/steps');
    return refuse();
  }
  const ids = Object.keys(steps);
  if (ids.length > FLOW_BOUNDS.steps)
    report.add(
      'FLOW_TOO_MANY_STEPS',
      `a flow has at most ${FLOW_BOUNDS.steps} steps; this has ${ids.length}`,
      null,
      '/steps',
    );
  if (ids.length === 0) report.add('FLOW_SHAPE', 'a flow has at least one step', null, '/steps');
  for (const id of ids)
    if (!isStepId(id))
      report.add(
        'FLOW_STEP_ID',
        (RESERVED_STEP_IDS as readonly string[]).includes(id)
          ? `${id} is reserved, and no step may take it`
          : `${JSON.stringify(id)} is not a step id: 1 to 32 lowercase letters, digits and -, starting with a letter`,
        id,
        pointerOf('steps', id),
      );
  const limits = checkLimits(copy.limits, report);
  const events = checkEvents(copy.events, report);
  const canonical: Record<StepId, FlowStep> = {};
  let everyStep = true;
  for (const id of ids) {
    const step = checkStep(steps[id], { id, steps, limits, targetKinds, report });
    if (step === undefined) everyStep = false;
    else Object.defineProperty(canonical, id, { value: step, enumerable: true, writable: true, configurable: true });
  }
  const on = checkOn(copy.on, report);
  if (events === undefined) {
    const emitting = ids.find((id) => {
      const step = canonical[id];
      return step !== undefined && (step.kind === 'raise' || step.emit !== undefined);
    });
    if (emitting !== undefined)
      report.add(
        'FLOW_EVENTS_MISSING',
        'a flow that emits or raises events says where they are named: events { namespace, workflow }',
        emitting,
        '/events',
      );
  }
  const start = copy.start;
  if (typeof start !== 'string' || !Object.hasOwn(steps, start))
    report.add(
      'FLOW_START',
      `the flow starts at ${JSON.stringify(start)}, which is not one of its steps`,
      null,
      '/start',
    );
  else if (everyStep) {
    const cycle = cycleStep(canonical);
    if (cycle !== null)
      report.add(
        'FLOW_CYCLE',
        `the arrows go round in a circle through ${cycle}: a workflow never loops`,
        cycle,
        pointerOf('steps', cycle),
      );
    else {
      const reached = reachableFrom(canonical, [start]);
      const order = stepOrder({ steps: canonical, start } as FlowDocumentV1);
      for (const id of order)
        if (!reached.has(id))
          report.add('FLOW_UNREACHABLE', `no arrow reaches ${id} from ${start}`, id, pointerOf('steps', id));
      const meeting = splitMeeting(canonical);
      if (meeting !== null)
        report.add(
          'FLOW_SPLIT_MEETS',
          `two branches of the split ${meeting.split} both reach ${meeting.step}: a split's branches never meet again`,
          meeting.split,
          pointerOf('steps', meeting.split),
        );
    }
  }
  if (report.problems.length > 0 || limits === undefined || events === null || on === null) return refuse();
  const result = {
    flowVersion: 1,
    start,
    steps: canonical,
    limits,
    ...(events === undefined ? {} : { events }),
    ...(on === undefined ? {} : { on }),
    ...(copy.shadow === true ? { shadow: true } : {}),
  };
  return { ok: true, flow: JSON.parse(canonicalJson(result)) as FlowDocumentV1 };
}
