/**
 * Writes a workflow's `flow` as the text's `flow` section (workflows design §4.4), which `flow-parse.ts` reads back to
 * the same flow. Steps are written in `stepOrder`: from `start`, depth first, each kind's arrows in its outcomes'
 * order. A step leaves out exactly the `otherwise` the parser fills — the next step written — and says `then stop` when
 * it has none and is not the last. A step the words cannot say is `step <id>: raw <JSON>`; a flow they cannot say at
 * all is left to `raw /flow`, and its targets to `then`.
 */
import { stepOrder } from '../flow/graph.ts';
import {
  FLOW_BOUNDS,
  FLOW_LIMIT_DEFAULTS,
  type FlowDocumentV1,
  type FlowStep,
  STEP_KINDS,
  STEP_OUTCOMES,
} from '../flow/types.ts';
import { canonicalJson, type JsonValue } from '../json.ts';
import { PROVIDER_WORDS } from './session.ts';
import {
  FLOW_LIMIT_WORDS,
  formatDuration,
  formatField,
  formatName,
  formatNames,
  hasKeys,
  isCount,
  isFieldText,
  isRecord,
  isStepOwnLine,
  isStringArray,
  NAME_RESERVED,
  series,
} from './vocabulary.ts';

type Doc = Readonly<Record<string, JsonValue>>;

/** What the flow printer borrows from `print.ts`, passed in so the two modules do not import each other. */
export interface FlowPrintHelpers {
  /** A condition's lines: the first after `lead`, at `level`; any group's members indented below it. */
  readonly conditionLines: (condition: JsonValue, level: number, lead: string) => string[];
  /** An `ask` section's lines, or undefined when the judge has a shape they cannot say. */
  readonly askLines: (agentic: JsonValue) => string[] | undefined;
  /** A target's lines at level 1, its options below; `  raw <JSON>` when the words cannot say it. */
  readonly targetLines: (target: JsonValue, inStep: boolean) => string[];
}

/** The flow section's lines, and whether its steps say the workflow's targets; undefined when it cannot be said. */
export function flowSectionLines(
  doc: Doc,
  helpers: FlowPrintHelpers,
): { readonly lines: string[]; readonly targets: boolean } | undefined {
  const flow = doc.flow;
  if (!isRecord(flow) || !hasKeys(flow, ['flowVersion', 'start', 'steps', 'limits'], ['events', 'on', 'shadow']))
    return undefined;
  if (flow.flowVersion !== 1 || (flow.shadow !== undefined && flow.shadow !== true)) return undefined;
  const head = flowHead(flow.limits, flow.shadow === true);
  if (head === undefined) return undefined;
  const lines = [head];
  if (flow.events !== undefined) {
    const events = eventsLine(flow.events);
    if (events === undefined) return undefined;
    lines.push(events);
  }
  if (flow.on !== undefined) {
    const on = onLine(flow.on);
    if (on === undefined) return undefined;
    lines.push(on);
  }
  const steps = flow.steps;
  if (!isRecord(steps) || Object.keys(steps).length === 0) return undefined;
  if (!Object.keys(steps).every(isStepWord) || typeof flow.start !== 'string') return undefined;
  const order = stepOrder({ ...(flow as object), steps: graphView(steps) } as FlowDocumentV1);
  if (order[0] !== flow.start) return undefined;
  const full = writeSteps(steps, order, doc.targets, 'full', helpers);
  if (full !== undefined) return { lines: [...lines, ...full], targets: true };
  const named = writeSteps(steps, order, doc.targets, 'reference', helpers) as string[];
  return { lines: [...lines, ...named], targets: false };
}

/** A step id the `step <id>:` line can carry: a bare word with no colon, and not `end`, which an arrow names. */
function isStepWord(id: string): boolean {
  return /^[A-Za-z0-9_./@+~-]+$/u.test(id) && id !== 'end';
}

/**
 * The steps as the graph functions read them, whatever shape a draft is in: an unknown kind reads as a step with no
 * outcomes, and arrows, branches and waits that are not well formed as none.
 */
function graphView(steps: Doc): Record<string, FlowStep> {
  const view: Record<string, FlowStep> = {};
  for (const [id, value] of Object.entries(steps)) {
    const step = isRecord(value) ? value : {};
    const kind = (STEP_KINDS as readonly unknown[]).includes(step.kind) ? (step.kind as string) : 'notify';
    const next: Record<string, string> = {};
    if (isRecord(step.next))
      for (const [outcome, target] of Object.entries(step.next)) if (typeof target === 'string') next[outcome] = target;
    const branches = Array.isArray(step.branches)
      ? step.branches.filter((branch): branch is string => typeof branch === 'string')
      : [];
    Object.defineProperty(view, id, {
      value: {
        kind,
        next,
        branches,
        for: isRecord(step.for) ? step.for : {},
        ...(step.only === 'idle' ? { only: 'idle' } : {}),
      } as unknown as FlowStep,
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return view;
}

/** `flow[, at most …][, each run up to …][, in shadow]`: the limits that differ from the defaults. */
function flowHead(limits: JsonValue | undefined, shadow: boolean): string | undefined {
  if (!isRecord(limits) || !hasKeys(limits, Object.keys(FLOW_LIMIT_DEFAULTS))) return undefined;
  if (Object.values(limits).some((limit) => !isCount(limit))) return undefined;
  const most: string[] = [];
  for (const [field, singular, plural] of FLOW_LIMIT_WORDS) {
    const limit = limits[field] as number;
    if (limit !== FLOW_LIMIT_DEFAULTS[field]) most.push(`${limit} ${(limit === 1 ? singular : plural).join(' ')}`);
  }
  const runMs = limits.runMs as number;
  return [
    'flow',
    ...(most.length === 0 ? [] : [`at most ${most.join(', ')}`]),
    ...(runMs === FLOW_LIMIT_DEFAULTS.runMs ? [] : [`each run up to ${formatDuration(runMs)}`]),
    ...(shadow ? ['in shadow'] : []),
  ].join(', ');
}

function eventsLine(events: JsonValue): string | undefined {
  if (!isRecord(events) || !hasKeys(events, ['namespace', 'workflow'], ['run'])) return undefined;
  const { namespace, workflow, run } = events;
  if (typeof namespace !== 'string' || typeof workflow !== 'string') return undefined;
  if (run !== undefined && !isStringArray(run)) return undefined;
  return `  events in ${formatName(namespace)} as ${formatName(workflow)}${run === undefined ? '' : `, run emits ${formatNames(run)}`}`;
}

/** A pattern: bare when it is made of a pattern's characters, quoted otherwise. */
function formatPattern(pattern: string): string {
  return /^[A-Za-z0-9_.*-]+$/u.test(pattern) && !NAME_RESERVED.has(pattern) ? pattern : JSON.stringify(pattern);
}

function onLine(on: JsonValue): string | undefined {
  if (!isRecord(on) || !hasKeys(on, ['raised', 'withinMs']) || !isStringArray(on.raised) || !isCount(on.withinMs))
    return undefined;
  const within = on.withinMs === FLOW_BOUNDS.onWithinDefaultMs ? '' : `, within ${formatDuration(on.withinMs)}`;
  return `  on raised ${on.raised.map(formatPattern).join(' and ')}${within}`;
}

/**
 * Every step's lines, in `order`. In `full`, each deliver step writes its target in full, which works only when the
 * targets the steps write, in order and each once, are exactly the workflow's: undefined otherwise. In `reference`,
 * a deliver step names its target by id, and `raw /targets` gives them.
 */
function writeSteps(
  steps: Doc,
  order: readonly string[],
  targets: JsonValue | undefined,
  mode: 'full' | 'reference',
  helpers: FlowPrintHelpers,
): string[] | undefined {
  const written: JsonValue[] = [];
  const targetOf = (reference: Doc): JsonValue | undefined => {
    if (!Array.isArray(targets)) return undefined;
    const found = targets.filter(
      (target) => isRecord(target) && target.targetId === reference.targetId && target.version === reference.version,
    );
    if (found.length !== 1) return undefined;
    const [target] = found as [JsonValue];
    if (!written.includes(target)) written.push(target);
    return target;
  };
  const lines: string[] = [];
  for (const [index, id] of order.entries()) {
    const step = steps[id] as JsonValue;
    const said = stepLines(id, step, { next: order[index + 1], mode, targetOf, helpers });
    if (said !== undefined) lines.push(...said);
    // A delivery that cannot write its target in full: every delivery names its target by id instead.
    else if (mode === 'full' && isRecord(step) && step.kind === 'deliver') return undefined;
    else lines.push(rawStep(id, step));
  }
  if (mode === 'reference') return lines;
  if (!Array.isArray(targets) || written.length !== targets.length) return undefined;
  return written.every((target, index) => target === targets[index]) ? lines : undefined;
}

const rawStep = (id: string, step: JsonValue) => `  step ${id}: raw ${canonicalJson(step)}`;

interface StepContext {
  /** The step written after this one, whose id an unwritten `otherwise` goes to; undefined for the last. */
  readonly next: string | undefined;
  readonly mode: 'full' | 'reference';
  /** The workflow's target a deliver step names, when exactly one is that version. */
  readonly targetOf: (reference: Doc) => JsonValue | undefined;
  readonly helpers: FlowPrintHelpers;
}

/** The keys each kind of step may have beyond its kind, label, emit and next. */
const KIND_KEYS: Readonly<Record<string, readonly string[]>> = {
  condition: ['when'],
  judge: ['ask'],
  route: ['candidates', 'by', 'judge', 'inputs'],
  'find-session': ['in', 'provider', 'only'],
  'start-session': ['in', 'provider', 'mode'],
  worktree: ['project', 'base', 'branch', 'cleanup'],
  deliver: ['target', 'to', 'report'],
  wait: ['for', 'timeoutMs'],
  notify: ['text'],
  split: ['branches'],
  raise: ['name', 'fields'],
};

/**
 * One step's lines, or undefined when the words cannot say it — always, then, for a deliver step in `full` whose
 * target cannot be written on it, so the caller writes every target by id instead.
 */
function stepLines(id: string, step: JsonValue, context: StepContext): string[] | undefined {
  if (!isRecord(step) || typeof step.kind !== 'string' || !Object.hasOwn(KIND_KEYS, step.kind)) return undefined;
  const kind = step.kind;
  const split = kind === 'split';
  if (!hasKeys(step, ['kind', ...(split ? [] : ['next'])], ['label', 'emit', ...(KIND_KEYS[kind] ?? [])]))
    return undefined;
  const { label, emit } = step;
  if (label !== undefined && typeof label !== 'string') return undefined;
  if (emit !== undefined && !isStringArray(emit)) return undefined;
  const said = kindLines(kind, step, context);
  if (said === undefined) return undefined;
  // A kind's own line the parser would read as the step's — an arrow, emits, a label — cannot be written as it is.
  if (said.lines.some((line) => /^ {4}\S/u.test(line) && isStepOwnLine(line.slice(4), kind))) return undefined;
  const arrows = split ? [] : arrowLines(kind, step.next as JsonValue, context.next);
  if (arrows === undefined) return undefined;
  return [
    `  step ${id}: ${said.head}`,
    ...said.lines,
    ...(said.report === undefined ? [] : [`    report ${formatNames(said.report)}`]),
    ...(label === undefined ? [] : [`    label ${JSON.stringify(label)}`]),
    ...(emit === undefined ? [] : [`    emits ${formatNames(emit)}`]),
    ...arrows,
  ];
}

/**
 * The step's arrows, in its kind's outcome order, then where its other outcomes go: left out when that is the next
 * step written, `then stop` when they go nowhere and another step follows.
 */
function arrowLines(kind: string, next: JsonValue, following: string | undefined): string[] | undefined {
  if (!isRecord(next)) return undefined;
  const outcomes = STEP_OUTCOMES[kind as keyof typeof STEP_OUTCOMES] ?? [];
  const keys = Object.keys(next);
  if (!keys.every((key) => key === 'otherwise' || outcomes.includes(key))) return undefined;
  if (!Object.values(next).every((target) => typeof target === 'string' && target !== '')) return undefined;
  const to = (target: string) => (target === 'end' ? 'end' : formatName(target));
  const lines = outcomes
    .filter((outcome) => Object.hasOwn(next, outcome))
    .map((o) => `    ${o} → ${to(next[o] as string)}`);
  const word = lines.length === 0 ? 'then' : 'otherwise';
  if (Object.hasOwn(next, 'otherwise')) {
    const otherwise = next.otherwise as string;
    if (following === undefined || otherwise !== following) lines.push(`    ${word} → ${to(otherwise)}`);
  } else if (following !== undefined) lines.push(`    ${word} stop`);
  return lines;
}

interface KindLines {
  /** The phrase after `step <id>: `. */
  readonly head: string;
  /** The lines under it, at level 2 and deeper. */
  readonly lines: readonly string[];
  /** A delivery's `report` words, written after the target's lines. */
  readonly report?: readonly string[];
}

/** Indents lines written for level 1 (an `ask`'s, a condition's members) by one more level. */
const deeper = (lines: readonly string[], by = '  ') => lines.map((line) => (line === '' ? line : `${by}${line}`));

function kindLines(kind: string, step: Doc, context: StepContext): KindLines | undefined {
  switch (kind) {
    case 'condition': {
      if (!Object.hasOwn(step, 'when')) return undefined;
      const [first, ...rest] = context.helpers.conditionLines(step.when as JsonValue, 0, 'if ');
      return { head: first as string, lines: deeper(rest) };
    }
    case 'judge': {
      if (!Object.hasOwn(step, 'ask')) return undefined;
      const lines = context.helpers.askLines(step.ask as JsonValue);
      if (lines === undefined) return undefined;
      const [first, ...rest] = lines;
      return { head: first as string, lines: deeper(rest) };
    }
    case 'route':
      return routeLines(step, context.helpers);
    case 'find-session': {
      const where = placeText(step.in, true);
      const provider = providerClause(step.provider);
      if (where === undefined || provider === undefined) return undefined;
      if (step.only !== undefined && step.only !== 'idle') return undefined;
      const idle = step.only === 'idle';
      const head =
        where === 'thread'
          ? `find the ${idle ? 'idle ' : ''}session that took this conversation`
          : `find ${idle ? 'an idle session' : 'a session'} ${where}`;
      return { head: `${head}${provider}`, lines: [] };
    }
    case 'start-session': {
      const where = placeText(step.in, false);
      const provider = providerClause(step.provider);
      if (where === undefined || provider === undefined) return undefined;
      if (step.mode !== undefined && typeof step.mode !== 'string') return undefined;
      const mode = step.mode === undefined ? '' : `, mode ${formatName(step.mode)}`;
      return { head: `start a session ${where}${provider}${mode}`, lines: [] };
    }
    case 'worktree': {
      const { project, base, branch, cleanup } = step;
      if (typeof project !== 'string' || (branch !== undefined && typeof branch !== 'string')) return undefined;
      let from: string;
      if (base === 'default') from = '';
      else if (isRecord(base) && hasKeys(base, ['branch']) && typeof base.branch === 'string')
        from = `, from ${formatName(base.branch)}`;
      else return undefined;
      if (cleanup !== 'keep' && cleanup !== 'remove-if-clean') return undefined;
      return {
        head: `make a worktree of ${formatName(project)}'s project${
          branch === undefined ? '' : `, branch ${JSON.stringify(branch)}`
        }${from}${cleanup === 'remove-if-clean' ? ', removed if clean' : ''}`,
        lines: [],
      };
    }
    case 'deliver':
      return deliverLines(step, context);
    case 'wait': {
      const waitsFor = step.for;
      let what: string;
      if (!isRecord(waitsFor) || Object.keys(waitsFor).length !== 1) return undefined;
      if (typeof waitsFor.turnEnd === 'string') what = `${formatName(waitsFor.turnEnd)}'s turn to end`;
      else if (typeof waitsFor.sessionIdle === 'string')
        what = `${formatName(waitsFor.sessionIdle)}'s session to be free`;
      else if (isRecord(waitsFor.time) && hasKeys(waitsFor.time, ['afterMs']) && isCount(waitsFor.time.afterMs))
        what = formatDuration(waitsFor.time.afterMs);
      else return undefined;
      if (step.timeoutMs !== undefined && !isCount(step.timeoutMs)) return undefined;
      const up = step.timeoutMs === undefined ? '' : `, up to ${formatDuration(step.timeoutMs)}`;
      return { head: `wait for ${what}${up}`, lines: [] };
    }
    case 'notify':
      return typeof step.text === 'string' ? { head: `tell me ${JSON.stringify(step.text)}`, lines: [] } : undefined;
    case 'split':
      return isStringArray(step.branches) ? { head: `split into ${formatNames(step.branches)}`, lines: [] } : undefined;
    case 'raise': {
      if (typeof step.name !== 'string') return undefined;
      const { fields } = step;
      if (fields !== undefined && !(isStringArray(fields) && fields.every(isFieldText))) return undefined;
      return {
        head: `raise ${formatName(step.name)}`,
        lines: fields === undefined ? [] : [`    fields ${fields.map(formatField).join(', ')}`],
      };
    }
    default:
      return undefined;
  }
}

/** A place's words after `find a session` or `start a session`; `thread` for this conversation (a find's only). */
function placeText(place: JsonValue | undefined, find: boolean): string | undefined {
  if (!isRecord(place) || Object.keys(place).length !== 1) return undefined;
  if (find && place.thread === true) return 'thread';
  if (typeof place.project === 'string') return `in ${formatName(place.project)}'s project`;
  if (typeof place.worktree === 'string') return `in ${formatName(place.worktree)}`;
  if (typeof place.folder === 'string') return `working in ${formatName(place.folder)}`;
  if (typeof place.lane === 'string') return `in lane ${formatName(place.lane)}`;
  return undefined;
}

function providerClause(provider: JsonValue | undefined): string | undefined {
  if (provider === undefined) return '';
  return typeof provider === 'string' && Object.hasOwn(PROVIDER_WORDS, provider)
    ? `, with ${PROVIDER_WORDS[provider]}`
    : undefined;
}

/** Which project?: its line, the fields it looks at, each project's id and folders, and its judge under `asking`. */
function routeLines(step: Doc, helpers: FlowPrintHelpers): KindLines | undefined {
  const { candidates, by, judge, inputs } = step;
  if (!Array.isArray(candidates) || candidates.length === 0) return undefined;
  const names: string[] = [];
  const projects: string[] = [];
  for (const candidate of candidates) {
    if (!isRecord(candidate) || !hasKeys(candidate, ['projectId', 'name', 'folders', 'worktreeRoot'])) return undefined;
    const { projectId, name, folders, worktreeRoot } = candidate;
    if (typeof projectId !== 'string' || typeof name !== 'string' || names.includes(name)) return undefined;
    if (!Array.isArray(folders) || !folders.every((folder) => typeof folder === 'string')) return undefined;
    if (worktreeRoot !== null && typeof worktreeRoot !== 'string') return undefined;
    names.push(name);
    const clauses = [
      ...(projectId === name ? [] : [`id ${formatName(projectId)}`]),
      ...(folders.length === 0 ? [] : [`in ${formatNames(folders as string[])}`]),
      ...(worktreeRoot === null ? [] : [`worktrees in ${formatName(worktreeRoot)}`]),
    ];
    if (clauses.length > 0) projects.push(`    project ${formatName(name)}, ${clauses.join(', ')}`);
  }
  if (inputs !== undefined && !(Array.isArray(inputs) && inputs.every(isFieldText))) return undefined;
  const ways = by === undefined ? undefined : Array.isArray(by) ? by.join(' ') : null;
  if (ways === null || (ways !== undefined && !['hints', 'judge', 'hints judge'].includes(ways))) return undefined;
  const byJudge = ways === 'judge' || ways === 'hints judge';
  let asking: string[] = [];
  let judged = '';
  if (byJudge) {
    if (!isRecord(judge) || !isRecord(judge.judge)) return undefined;
    const lines = helpers.askLines(judge);
    if (lines === undefined) return undefined;
    const { judgeId, version, provider } = judge.judge;
    judged = `${formatName(judgeId as string)} version ${version as number}${
      provider === undefined ? '' : ` via ${formatName(provider as string)}`
    }`;
    asking = lines.length > 1 ? ['    asking', ...deeper(lines.slice(1), '    ')] : [];
  } else if (judge !== undefined) return undefined;
  const way =
    ways === undefined ? '' : `, by ${ways === 'judge' ? judged : `hints${byJudge ? ` then by ${judged}` : ''}`}`;
  return {
    head: `choose a project among ${formatNames(names)}${way}`,
    lines: [
      ...(inputs === undefined
        ? []
        : [
            `    looking at ${inputs.length === 0 ? 'nothing' : inputs.map((input) => formatField(input as string)).join(', ')}`,
          ]),
      ...projects,
      ...asking,
    ],
  };
}

/** Where a delivery goes, after its target: `, to <steps>` (a session) or `, on <step>` (a Linear change). */
function toClause(to: JsonValue | undefined): { readonly text: string; readonly kind?: string } | undefined {
  if (to === undefined) return { text: '' };
  if (!isRecord(to) || Object.keys(to).length !== 1) return undefined;
  if (isStringArray(to.session)) return { text: `, to ${series(to.session.map(formatName), 'or')}`, kind: 'session' };
  if (typeof to.issue === 'string') return { text: `, on ${formatName(to.issue)}`, kind: 'linear-change' };
  return undefined;
}

function deliverLines(step: Doc, context: StepContext): KindLines | undefined {
  const { target, report } = step;
  if (!isRecord(target) || !hasKeys(target, ['targetId', 'version'])) return undefined;
  if (typeof target.targetId !== 'string' || !isCount(target.version)) return undefined;
  if (report !== undefined && !isStringArray(report)) return undefined;
  const to = toClause(step.to);
  if (to === undefined) return undefined;
  const reported = report === undefined ? {} : { report };
  if (context.mode === 'reference')
    return {
      head: `deliver ${formatName(target.targetId)}, version ${target.version}${to.text}`,
      lines: [],
      ...reported,
    };
  const found = context.targetOf(target);
  if (!isRecord(found)) return undefined;
  if (to.kind !== undefined && found.kind !== to.kind) return undefined;
  const lines = context.helpers.targetLines(found, true);
  const [first, ...rest] = lines;
  if (first === undefined || first.startsWith('  raw ')) return undefined;
  return { head: `${first.slice(2)}${to.text}`, lines: rest, ...reported };
}
