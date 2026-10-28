/**
 * A workflow's flow as the numbered effects its approval lists (workflows design §10.2, W6): one line per step that
 * does something — Which project?, a start, a worktree, a delivery, a notice, a Raise, and any step that emits events —
 * in `stepOrder`, after the workflow's own words (`describeRule`). The steps that only decide or wait (a condition, a
 * judge, a find, a wait, a split) are named inside the "If …" of each line they lead to, so every effect says when it
 * happens; a deciding step that leads to no effect still has a line of its own, so no step is left out. A chained
 * workflow, a shadow and the run's own events have a line each, and the last line says the flow's limits (0.37.0 §6).
 *
 * The parts are `describeRule`'s: `plain` (these words), `value` (ids, names and events the workflow holds) and
 * `untrusted` (the author's text: labels, templates, questions, notices, folders, condition operands). Pure and
 * isomorphic, like the rest of this package.
 */
import type { CanonicalCondition } from '../conditions/types.ts';
import { outcomesOf, stepOrder } from '../flow/graph.ts';
import type { FlowDocumentV1, FlowLimits, FlowStep, Place, StepId } from '../flow/types.ts';
import { parsePointer } from '../pointer.ts';
import { formatDuration } from '../rule-text/vocabulary.ts';
import { WORKFLOW_EVENT_CATALOGUE_V1, type WorkflowEventSchema } from '../workflow-events/catalogue.ts';
import {
  type DescribableRuleDocument,
  type DescribableTarget,
  type FieldLabels,
  fieldPart,
  judgeName,
  predicate,
  type RulePart,
  target as targetPhrase,
} from './describe-rule.ts';

/** One numbered line of a workflow's approval: the steps it is about (its own first), and its words as parts. */
export interface FlowLine {
  readonly number: number;
  readonly stepIds: readonly string[];
  readonly parts: readonly RulePart[];
}

const plain = (text: string): RulePart => ({ text, kind: 'plain' });
const value = (text: string): RulePart => ({ text, kind: 'value' });
const untrusted = (text: string): RulePart => ({ text, kind: 'untrusted' });

/**
 * What a session may do without asking, in the D2 preview's words: the event service's `SESSION_MODE_WORDS`
 * (`packages/events-daemon/src/domain/session-target.ts`), copied, since this package cannot import the service.
 */
const SESSION_MODE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  manual: 'it asks before it acts',
  acceptEdits: 'it may edit files without asking, and asks before anything else',
  plan: 'it only plans, and changes nothing',
});

const PROVIDER_NAMES: Readonly<Record<string, string>> = Object.freeze({ claude: 'Claude Code', codex: 'Codex' });

/** The kinds whose step always has a line: each does something outside the run. */
const EFFECT_KINDS: ReadonlySet<string> = new Set(['route', 'start-session', 'worktree', 'deliver', 'notify', 'raise']);

/** The kinds that decide which way a run goes: their outcomes are what an "If …" names. */
const DECIDING_KINDS: ReadonlySet<string> = new Set(['condition', 'judge', 'route', 'find-session', 'wait']);

/** The outcome of each effect that means it did what it does: a run that passes it is on its way to what follows. */
const SUCCESSES: Readonly<Record<string, string>> = Object.freeze({
  'start-session': 'started',
  worktree: 'made',
  deliver: 'done',
  notify: 'sent',
  raise: 'raised',
});

/** What each closed output of a step's events is, in words (Appendix W.3). */
const OUTPUT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  steps: 'the steps it ran',
  endCode: 'how it ended',
  score: 'the score',
  project: "the project's id",
  projectName: "the project's name",
  reason: 'the reason',
  session: "the session's id",
  provider: 'its provider',
  mode: 'its mode',
  refusal: 'why it was refused',
  branch: 'the branch',
  delivery: "the delivery's id",
  turn: "the turn's id",
  ahead: 'how many are ahead of it',
  issue: "the issue's id, identifier and link",
  changed: 'what it changed',
  state: 'the state',
  status: 'the status the receiver answered',
  for: 'what it waited for',
  reported: 'the word the session reported',
  raised: 'that it was raised',
  branches: 'its branches',
  name: "the event's name",
});

const RUN_EVENT_WORDS: Readonly<Record<string, string>> = Object.freeze({
  started: 'starts',
  held: 'is held',
  finished: 'finishes',
  failed: 'fails',
  cancelled: 'is cancelled',
  expired: 'expires',
});

/** Parts joined as a list: `a`, `a and b`, `a, b and c`. */
function list(items: readonly (readonly RulePart[])[], last: string): RulePart[] {
  return items.flatMap((item, index) => [
    ...(index === 0 ? [] : [plain(index === items.length - 1 ? last : ', ')]),
    ...item,
  ]);
}

/** The text of parts, to compare two phrases. */
const textOf = (parts: readonly RulePart[]) => parts.map((part) => part.text).join('');

/** Parts with their first letter made upper case, for a line that starts with them. */
function capitalised(parts: readonly RulePart[]): RulePart[] {
  const [first, ...rest] = parts;
  if (first === undefined || first.text === '') return [...parts];
  // ASCII only, with no host locale: these words are this module's own, and start with a letter a to z.
  const code = first.text.charCodeAt(0);
  const upper = code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : first.text.charAt(0);
  return [{ ...first, text: `${upper}${first.text.slice(1)}` }, ...rest];
}

/** A describable rule document with its flow. */
type FlowRule = DescribableRuleDocument & { readonly flow: FlowDocumentV1 };

/** An arrow into a step: the step it leaves, and the outcome, or null for a split's branch. */
interface Arrow {
  readonly from: StepId;
  readonly outcome: string | null;
}

/** What every line's words need: the workflow, its steps, the arrows into each, and the reader's labels. */
interface Scope {
  readonly rule: FlowRule;
  readonly steps: Readonly<Record<StepId, FlowStep>>;
  readonly into: ReadonlyMap<StepId, readonly Arrow[]>;
  readonly labels: FieldLabels | undefined;
}

/** The workflow's numbered effects (§10.2), in `stepOrder`, numbered from 1, and its limits last. */
export function describeFlow(
  rule: DescribableRuleDocument & { flow: FlowDocumentV1 },
  labels?: FieldLabels,
): FlowLine[] {
  const flow = rule.flow;
  const steps = flow.steps;
  const order = stepOrder(flow);
  const into = new Map<StepId, Arrow[]>();
  for (const id of order) {
    const step = steps[id];
    if (step === undefined) continue;
    const add = (to: string, arrow: Arrow) => {
      if (to === 'end' || !Object.hasOwn(steps, to)) return;
      into.set(to, [...(into.get(to) ?? []), arrow]);
    };
    if (step.kind === 'split') for (const branch of step.branches) add(branch, { from: id, outcome: null });
    else
      for (const outcome of possibleOutcomes(step, { rule, steps })) {
        const to = arrowFor(step, outcome);
        if (to !== undefined) add(to, { from: id, outcome });
      }
  }
  const scope: Scope = { rule, steps, into, labels };
  const own = (id: StepId) => {
    const step = steps[id] as FlowStep;
    return EFFECT_KINDS.has(step.kind) || step.emit !== undefined;
  };
  const named = new Set<StepId>();
  const stopsSaid = new Set<StepId>();
  const lines = new Map<StepId, { stepIds: StepId[]; parts: RulePart[] }>();
  const write = (id: StepId) => {
    const step = steps[id] as FlowStep;
    const clause = ifClause(id, scope);
    for (const deciding of clause.named) named.add(deciding);
    const parts: RulePart[] = [
      ...(step.label === undefined ? [] : [untrusted(step.label), plain(': ')]),
      ...(clause.parts.length === 0
        ? capitalised(doing(id, step, scope))
        : [plain('If '), ...clause.parts, plain(', '), ...doing(id, step, scope)]),
      plain('.'),
      ...emitted(id, step, scope),
      ...stops(step, scope, false),
    ];
    stopsSaid.add(id);
    // A deciding step named here, with outcomes that go nowhere, says so on the first line that names it.
    for (const deciding of clause.named)
      if (!stopsSaid.has(deciding) && !own(deciding)) {
        parts.push(...stops(steps[deciding] as FlowStep, scope, true));
        stopsSaid.add(deciding);
      }
    lines.set(id, { stepIds: [id, ...order.filter((other) => clause.named.has(other) && other !== id)], parts });
  };
  for (const id of order) if (Object.hasOwn(steps, id) && own(id)) write(id);
  // A step that only decides or waits, and that no line names, has a line of its own: nothing is left out.
  for (const id of order) if (Object.hasOwn(steps, id) && !own(id) && !named.has(id)) write(id);
  const ordered: { stepIds: readonly StepId[]; parts: readonly RulePart[] }[] = [
    ...flowLines(scope),
    ...order.flatMap((id) => {
      const line = lines.get(id);
      return line === undefined ? [] : [line];
    }),
    ...runLines(scope),
    limitsLine(scope.rule.flow.limits),
  ];
  return ordered.map((line, index) => ({ number: index + 1, stepIds: line.stepIds, parts: line.parts }));
}

/** Where `outcome` goes from `step`: its own arrow, else `otherwise`, else nowhere (undefined). */
function arrowFor(step: FlowStep, outcome: string): string | undefined {
  if (step.kind === 'split') return undefined;
  const next = step.next as Readonly<Record<string, string>>;
  return Object.hasOwn(next, outcome) ? next[outcome] : next.otherwise;
}

/**
 * The outcomes a step can have in this flow: its kind's, narrowed by its own fields (`outcomesOf`); a wait for a turn by
 * whether the delivery asks its session to report (§6.5); a delivery's left in the Queue only for a session.
 */
function possibleOutcomes(step: FlowStep, scope: Pick<Scope, 'rule' | 'steps'>): readonly string[] {
  if (step.kind === 'deliver' && targetOf(scope, step)?.kind !== 'session') return ['done', 'failed'];
  if (step.kind === 'wait' && 'turnEnd' in step.for) {
    const delivery = scope.steps[step.for.turnEnd];
    const report = delivery?.kind === 'deliver' ? delivery.report : undefined;
    return report === undefined ? ['completed', 'failed', 'stopped', 'timed-out'] : [...report, 'failed', 'timed-out'];
  }
  return outcomesOf(step);
}

/** A target of the workflow's, by the version a deliver step names. */
function targetOf(
  scope: Pick<Scope, 'rule'>,
  step: Extract<FlowStep, { kind: 'deliver' }>,
): DescribableTarget | undefined {
  return scope.rule.targets.find(
    (entry) => entry.targetId === step.target.targetId && entry.version === step.target.version,
  );
}

/**
 * The "If …" of a step's line: the outcomes of the deciding steps that lead to it, through any effect that did what it
 * does on the way (a worktree made, a session started), joined by "or". None when the step is the flow's start, or a
 * path reaches it with nothing decided.
 */
function ifClause(id: StepId, scope: Scope): { parts: RulePart[]; named: Set<StepId> } {
  const phrases: RulePart[][] = [];
  const named = new Set<StepId>();
  const seen = new Set<StepId>();
  let always = false;
  const walk = (to: StepId) => {
    if (seen.has(to)) return;
    seen.add(to);
    const arrows = scope.into.get(to) ?? [];
    if (arrows.length === 0) always = true;
    for (const arrow of arrows) {
      const from = scope.steps[arrow.from] as FlowStep;
      if (arrow.outcome === null) walk(arrow.from);
      else if (!DECIDING_KINDS.has(from.kind) && SUCCESSES[from.kind] === arrow.outcome) walk(arrow.from);
      else {
        const phrase = outcomePhrase(from, arrow.outcome, scope);
        if (!phrases.some((said) => textOf(said) === textOf(phrase))) phrases.push(phrase);
        named.add(arrow.from);
      }
    }
  };
  walk(id);
  return { parts: always ? [] : list(phrases, ', or '), named: always ? new Set() : named };
}

/** Where a session is found or started, in words: "in the project route chose", "in the worktree tree made". */
function placeWords(place: Place): RulePart[] {
  if ('thread' in place) return [plain('that took an earlier message in this conversation')];
  if ('project' in place) return [plain('in the project '), value(place.project), plain(' chose')];
  if ('worktree' in place) return [plain('in the worktree '), value(place.worktree), plain(' made')];
  if ('folder' in place) return [plain('working in '), untrusted(place.folder)];
  return [plain('bound to lane '), value(place.lane)];
}

/** A condition step's path, named: a mapped field, a step's closed output, or the raised event's data. */
function conditionPath(pointer: string, scope: Scope): RulePart[] {
  const tokens = parsePointer(pointer);
  if (!tokens.ok) return [untrusted(pointer)];
  const [root, ...rest] = tokens.value;
  if (root === 'fields') {
    const field = `/${rest.map((token) => token.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`;
    return [fieldPart(field, scope.rule, scope.labels)];
  }
  if (root === 'steps' && rest.length >= 2)
    return [plain('the step '), value(rest[0] as string), plain("'s "), plain(rest.slice(1).join(' '))];
  if (root === 'trigger') return [plain("the raised event's "), untrusted(rest.join('.'))];
  return [untrusted(pointer)];
}

/** The fields a judge or a route looks at, named. */
function fieldsLooked(inputs: readonly string[], scope: Scope): RulePart[] {
  return list(
    inputs.map((pointer) => [fieldPart(pointer, scope.rule, scope.labels)]),
    ' and ',
  );
}

/** A deciding step's outcome, or an effect's that is not what it does, as the "If …" says it. */
function outcomePhrase(step: FlowStep, outcome: string, scope: Scope): RulePart[] {
  switch (step.kind) {
    case 'condition': {
      const said = predicate(step.when as CanonicalCondition, (pointer) => conditionPath(pointer, scope));
      return outcome === 'yes' ? [...said] : [plain('not ('), ...said, plain(')')];
    }
    case 'judge': {
      const looking =
        step.ask.inputs.length === 0 ? [] : [plain(', looking at '), ...fieldsLooked(step.ask.inputs, scope)];
      const verb = outcome === 'yes' ? " says yes to '" : outcome === 'no' ? " says no to '" : " is unsure about '";
      return [value(judgeName(step.ask.judge)), ...looking, plain(verb), untrusted(step.ask.question), plain("'")];
    }
    case 'route':
      return [
        plain(
          outcome === 'chosen'
            ? 'a project is chosen'
            : outcome === 'none'
              ? 'no project fits'
              : 'it is unsure which project',
        ),
      ];
    case 'find-session': {
      if ('thread' in step.in) {
        const who = 'the session that took an earlier message in this conversation';
        if (outcome === 'idle') return [plain('a session already took an earlier message in this conversation')];
        if (outcome === 'busy') return [plain(`${who} is busy`)];
        if (outcome === 'watched') return [plain(`${who} is only watched`)];
        return [plain('no session took an earlier message in this conversation')];
      }
      const where = placeWords(step.in);
      if (outcome === 'idle') return [plain('a session is idle '), ...where];
      if (outcome === 'busy') return [plain('the session '), ...where, plain(' is busy')];
      if (outcome === 'watched') return [plain('the session '), ...where, plain(' is only watched')];
      return step.only === 'idle'
        ? [plain('no session is idle '), ...where]
        : [plain('no session is found '), ...where];
    }
    case 'wait': {
      const within = plain(` within ${formatDuration(step.timeoutMs)}`);
      if ('sessionIdle' in step.for) {
        const session = [plain('the session '), value(step.for.sessionIdle), plain(' found')];
        return outcome === 'free'
          ? [...session, plain(' becomes free'), within]
          : [...session, plain(" isn't free"), within];
      }
      if ('time' in step.for)
        return outcome === 'elapsed'
          ? [plain(`${formatDuration(step.for.time.afterMs)} have passed`)]
          : [plain('the wait times out')];
      const turn = [plain('the turn '), value(step.for.turnEnd), plain(' started')];
      if (outcome === 'completed') return [...turn, plain(' ends')];
      if (outcome === 'failed') return [...turn, plain(' fails')];
      if (outcome === 'stopped') return [...turn, plain(' is stopped')];
      if (outcome === 'timed-out') return [...turn, plain(" doesn't end"), within];
      return [plain('the session reports '), value(outcome)];
    }
    case 'start-session':
      return [plain("the session can't be started")];
    case 'worktree':
      return [plain("the worktree can't be made")];
    case 'deliver': {
      if (outcome === 'left-in-queue') return [plain('it is left in the Queue')];
      if (outcome === 'done') return [plain('delivering to '), value(step.target.targetId), plain(' is done')];
      return [plain('delivering to '), value(step.target.targetId), plain(' fails')];
    }
    default:
      return [plain(outcome)];
  }
}

/**
 * "If none, it stops.": each outcome of `step` that has no arrow, but what an effect does when it works, which ends
 * its branch as it should. `folded` names the step, for a deciding step said inside another step's line.
 */
function stops(step: FlowStep, scope: Scope, folded: boolean): RulePart[] {
  if (step.kind === 'split') return [];
  const ending = possibleOutcomes(step, scope).filter(
    (outcome) => arrowFor(step, outcome) === undefined && SUCCESSES[step.kind] !== outcome,
  );
  if (ending.length === 0) return [];
  const words = ending.map((outcome): RulePart[] =>
    folded ? outcomePhrase(step, outcome, scope) : [plain(ownStopWords(step, outcome))],
  );
  return [plain(' If '), ...list(words, ' or '), plain(', it stops.')];
}

/** An outcome of a line's own step, said as "If <these words>, it stops." */
function ownStopWords(step: FlowStep, outcome: string): string {
  switch (outcome) {
    case 'none':
      return 'none';
    case 'unsure':
      return 'it is unsure';
    case 'chosen':
      return 'it chooses one';
    case 'refused':
      return step.kind === 'worktree' ? "it can't be made" : "it can't be started";
    case 'failed':
      return 'it fails';
    case 'left-in-queue':
      return 'it is left in the Queue';
    case 'idle':
      return 'a session is idle';
    case 'busy':
      return 'the session is busy';
    case 'watched':
      return 'the session is only watched';
    case 'timed-out':
      return 'it times out';
    case 'free':
      return 'the session becomes free';
    case 'elapsed':
      return 'the time has passed';
    case 'completed':
      return 'the turn ends';
    case 'stopped':
      return 'the turn is stopped';
    case 'yes':
      return 'it says yes';
    case 'no':
      return 'it says no';
    default:
      return `the session reports ${outcome}`;
  }
}

/** What the step does, as the line says it after "If …, ": imperative, starting lower case. */
function doing(id: StepId, step: FlowStep, scope: Scope): RulePart[] {
  switch (step.kind) {
    case 'route':
      return route(step, scope);
    case 'find-session': {
      const provider = PROVIDER_NAMES[step.provider] ?? step.provider;
      if ('thread' in step.in)
        return [
          plain(
            `look for the ${step.only === 'idle' ? 'idle ' : ''}session that took an earlier message in this conversation, with `,
          ),
          value(provider),
        ];
      return [
        plain(step.only === 'idle' ? 'look for an idle session ' : 'look for a session '),
        ...placeWords(step.in),
        plain(', with '),
        value(provider),
      ];
    }
    case 'start-session': {
      const mode = SESSION_MODE_WORDS[step.mode];
      return [
        plain('start a '),
        value(PROVIDER_NAMES[step.provider] ?? step.provider),
        plain(' session '),
        ...placeWords(step.in),
        ...('project' in step.in ? projectFolders(step.in.project, scope) : []),
        ...(mode === undefined
          ? [plain(', in the mode '), untrusted(step.mode)]
          : [plain(` ${mode.replace(/^it /u, 'that ')}`)]),
      ];
    }
    case 'worktree':
      return worktree(step, scope);
    case 'deliver':
      return deliver(step, scope);
    case 'wait': {
      const up = plain(`, up to ${formatDuration(step.timeoutMs)}`);
      if ('sessionIdle' in step.for)
        return [plain('wait for the session '), value(step.for.sessionIdle), plain(' found to be free'), up];
      if ('turnEnd' in step.for)
        return [plain('wait for the turn '), value(step.for.turnEnd), plain(' started to end'), up];
      return [plain(`wait ${formatDuration(step.for.time.afterMs)}`), up];
    }
    case 'notify':
      return [plain("tell you '"), untrusted(step.text), plain("'")];
    case 'raise':
      return raise(id, step, scope);
    case 'condition':
      return [plain('check whether '), ...predicate(step.when, (pointer) => conditionPath(pointer, scope))];
    case 'judge': {
      const looking =
        step.ask.inputs.length === 0 ? [] : [plain(', looking at '), ...fieldsLooked(step.ask.inputs, scope)];
      return [
        plain('ask '),
        value(judgeName(step.ask.judge)),
        plain(" '"),
        untrusted(step.ask.question),
        plain("'"),
        ...looking,
      ];
    }
    case 'split':
      return [
        plain('go on along '),
        ...list(
          step.branches.map((branch) => [value(branch)]),
          ' and ',
        ),
        plain(' at once'),
      ];
  }
}

/** The folders of the projects a route step may choose: " (in /a or /b)". */
function projectFolders(routeId: StepId, scope: Scope): RulePart[] {
  const route = scope.steps[routeId];
  if (route?.kind !== 'route') return [];
  const folders = route.candidates.flatMap((candidate) => candidate.folders);
  if (folders.length === 0) return [];
  return [
    plain(' ('),
    ...list(
      folders.map((folder) => [untrusted(folder)]),
      ' or ',
    ),
    plain(')'),
  ];
}

/** Which project?: the candidates and their folders, how it chooses, and what its judge looks at. */
function route(step: Extract<FlowStep, { kind: 'route' }>, scope: Scope): RulePart[] {
  const candidates = list(
    step.candidates.map((candidate) => [
      value(candidate.name),
      ...(candidate.folders.length === 0
        ? []
        : [
            plain(' ('),
            ...list(
              candidate.folders.map((folder) => [untrusted(folder)]),
              ' and ',
            ),
            plain(')'),
          ]),
    ]),
    ' and ',
  );
  const byHints = step.by.includes('hints');
  const judge = step.judge;
  const asking =
    judge === undefined
      ? []
      : [
          plain(byHints ? ', then by asking ' : ', by asking '),
          value(judgeName(judge.judge)),
          plain(" '"),
          untrusted(judge.question),
          plain("' of each"),
          ...(judge.inputs.length === 0 ? [] : [plain(', looking at '), ...fieldsLooked(judge.inputs, scope)]),
        ];
  return [plain('choose a project among '), ...candidates, ...(byHints ? [plain(', by its hints')] : []), ...asking];
}

/** A worktree: whose checkout, under which folder, on which branch, from which base, and how git runs. */
function worktree(step: Extract<FlowStep, { kind: 'worktree' }>, scope: Scope): RulePart[] {
  const route = scope.steps[step.project];
  const roots =
    route?.kind === 'route'
      ? route.candidates.flatMap((candidate) =>
          candidate.worktreeRoot === null
            ? candidate.folders.map((folder) => `${folder}-wt`)
            : [candidate.worktreeRoot],
        )
      : [];
  return [
    plain('make a worktree of the project '),
    value(step.project),
    plain(' chose'),
    ...(roots.length === 0
      ? []
      : [
          plain(', in '),
          ...list(
            roots.map((root) => [untrusted(root)]),
            ' or ',
          ),
        ]),
    plain(", on a branch named '"),
    untrusted(step.branch),
    plain("'"),
    ...(step.base === 'default' ? [] : [plain(' from '), value(step.base.branch)]),
    plain(", by running git as you, without the repository's hooks"),
    plain(
      step.cleanup === 'keep'
        ? ', and keep it'
        : ', and remove it when the run ends if nothing in it changed and nothing on its branch is unpushed',
    ),
  ];
}

/** A Raise step: its event, what it carries, and to whom (W27, W28). */
function raise(id: StepId, step: Extract<FlowStep, { kind: 'raise' }>, scope: Scope): RulePart[] {
  const carried =
    step.fields === undefined || step.fields.length === 0
      ? [plain(': nothing a sender wrote')]
      : [
          plain('; what senders wrote in '),
          ...fieldsLooked(step.fields, scope),
          plain(' goes with it only to subscribers allowed what senders write, inside the envelope'),
        ];
  const named = [plain('raise '), value(eventType(scope, id, step.name))];
  return step.fields === undefined || step.fields.length === 0
    ? [...named, ...carried, ...audience(scope)]
    : [...named, ...audience(scope), ...carried];
}

/** A step's event's namespaced name (W24), or the step and word when the flow names no events. */
function eventType(scope: Scope, step: string, event: string): string {
  const events = scope.rule.flow.events;
  return events === undefined ? `${step}.${event}` : `${events.namespace}.${events.workflow}.${step}.${event}`;
}

/** Who receives a raised event: the subscribers given its namespace, and the workflows that start on it. */
function audience(scope: Scope): RulePart[] {
  const namespace = scope.rule.flow.events?.namespace;
  return [
    plain(', to subscribers given '),
    ...(namespace === undefined ? [plain('its namespace')] : [value(namespace)]),
    plain(' and to workflows that start on it'),
  ];
}

/** "It raises …, with …: nothing a sender wrote, to subscribers given acme and to workflows that start on it." */
function emitted(id: StepId, step: FlowStep, scope: Scope): RulePart[] {
  if (step.emit === undefined || step.emit.length === 0) return [];
  const schema = schemaFor(step, scope);
  const outputs = schema === undefined ? [] : WORKFLOW_EVENT_CATALOGUE_V1[schema].outputs;
  const words = outputs.map((output) => OUTPUT_WORDS[output] ?? output);
  return [
    plain(' It raises '),
    ...list(
      step.emit.map((event) => [value(eventType(scope, id, event))]),
      ' and ',
    ),
    ...(words.length === 0
      ? []
      : [plain(`, with ${words.length === 1 ? words[0] : `${words.slice(0, -1).join(', ')} and ${words.at(-1)}`}`)]),
    plain(': nothing a sender wrote'),
    ...audience(scope),
    plain('.'),
  ];
}

/** The schema of a step's events (Appendix W.3), by its kind, and a delivery's by its target's. */
function schemaFor(step: FlowStep, scope: Scope): WorkflowEventSchema | undefined {
  if (step.kind === 'raise') return 'raise';
  if (step.kind !== 'deliver') return `step.${step.kind}` as WorkflowEventSchema;
  const kind = targetOf(scope, step)?.kind;
  const schema = `step.deliver.${kind}` as WorkflowEventSchema;
  return kind !== undefined && Object.hasOwn(WORKFLOW_EVENT_CATALOGUE_V1, schema) ? schema : undefined;
}

/** A delivery: to a session, a Linear issue or change, or one of today's targets, and what it gives. */
function deliver(step: Extract<FlowStep, { kind: 'deliver' }>, scope: Scope): RulePart[] {
  const found = targetOf(scope, step) as (DescribableTarget & Readonly<Record<string, unknown>>) | undefined;
  if (found === undefined) return [plain('deliver it to '), value(step.target.targetId)];
  if (found.kind === 'session') return session(step, found, scope);
  if (found.kind === 'linear') return linearIssue(found);
  if (found.kind === 'linear-change') return linearChange(step, found);
  return [...targetPhrase(found)];
}

function session(
  step: Extract<FlowStep, { kind: 'deliver' }>,
  found: DescribableTarget & Readonly<Record<string, unknown>>,
  scope: Scope,
): RulePart[] {
  const chosen =
    step.to !== undefined && 'session' in step.to
      ? [
          plain('the session '),
          ...list(
            step.to.session.map((id) => [value(id)]),
            ' or ',
          ),
          plain(' chose'),
        ]
      : found.find?.folder !== undefined
        ? [plain('the session working in '), untrusted(found.find.folder)]
        : found.find?.lane !== undefined
          ? [plain('the session bound to lane '), value(found.find.lane)]
          : [plain('the session '), value(found.targetId)];
  const provider = PROVIDER_NAMES[found.provider ?? ''];
  const context = Array.isArray(found.context) ? (found.context as readonly Readonly<Record<string, unknown>>[]) : [];
  const given = context.flatMap((part): RulePart[][] => {
    if (Array.isArray(part.fields)) return [fieldsLooked(part.fields as string[], scope)];
    if (typeof part.text === 'string') return [[plain("the words '"), untrusted(part.text), plain("'")]];
    if (typeof part.file === 'string') return [[plain('the file '), untrusted(part.file)]];
    if (typeof part.step === 'string' && typeof part.field === 'string')
      return [[plain('the step '), value(part.step), plain(`'s ${part.field}`)]];
    if (typeof part.generate === 'object' && part.generate !== null) {
      const generate = part.generate as Readonly<Record<string, unknown>>;
      return [
        [
          plain('words '),
          value(String(generate.model)),
          plain(' writes from '),
          ...fieldsLooked((generate.from as string[]) ?? [], scope),
        ],
      ];
    }
    return [];
  });
  const instruction = typeof found.instruction === 'string' ? found.instruction : undefined;
  return [
    plain('give '),
    ...chosen,
    ...(provider === undefined ? [] : [plain(' ('), value(provider), plain(')')]),
    plain(' the message'),
    ...(given.length === 0 ? [] : [plain(': '), ...list(given, ', and ')]),
    ...(instruction === undefined ? [] : [plain(", ending '"), untrusted(instruction), plain("'")]),
    ...(step.report === undefined || step.report.length === 0
      ? []
      : [
          plain(', and ask it to report '),
          ...list(
            step.report.map((word) => [value(word)]),
            ' or ',
          ),
        ]),
  ];
}

function assigneeWords(assignee: unknown): RulePart[] {
  if (assignee === 'me') return [plain('you')];
  if (assignee === null) return [plain('nobody')];
  if (typeof assignee === 'object' && assignee !== null && typeof (assignee as { id?: unknown }).id === 'string')
    return [plain('the user '), value((assignee as { id: string }).id)];
  return [];
}

function labelNames(labels: unknown): RulePart[][] {
  return Array.isArray(labels)
    ? labels.flatMap((label) =>
        typeof label === 'object' && label !== null && typeof (label as { name?: unknown }).name === 'string'
          ? [[value((label as { name: string }).name)]]
          : [],
      )
    : [];
}

/** A Linear issue: its team, its title as written, its labels and who it is assigned to. */
function linearIssue(found: DescribableTarget & Readonly<Record<string, unknown>>): RulePart[] {
  const key = found.team?.key;
  const title = found.title as { text?: unknown } | undefined;
  const labels = labelNames(found.labels);
  const assigned = assigneeWords(found.assignee);
  return [
    plain('create an issue in '),
    value('Linear'),
    ...(typeof key === 'string' && key !== '' ? [plain(', team '), value(key)] : []),
    ...(typeof title?.text === 'string' ? [plain(", titled '"), untrusted(title.text), plain("'")] : []),
    ...(labels.length === 0 ? [] : [plain(', labelled '), ...list(labels, ' and ')]),
    ...(assigned.length === 0 || found.assignee === null ? [] : [plain(', assigned to '), ...assigned]),
  ];
}

/** A Linear change (§6.7): the issue its create step made, and its comment, state, labels and assignee. */
function linearChange(
  step: Extract<FlowStep, { kind: 'deliver' }>,
  found: DescribableTarget & Readonly<Record<string, unknown>>,
): RulePart[] {
  const issue = step.to !== undefined && 'issue' in step.to ? step.to.issue : undefined;
  const changes: RulePart[][] = [];
  const comment = found.comment as { text?: unknown } | undefined;
  if (typeof comment?.text === 'string') {
    const agentWritten = /\{\{\s*steps\.[a-z][a-z0-9-]*\.summary\s*\}\}/u.test(comment.text);
    changes.push([
      plain("comment '"),
      untrusted(comment.text),
      plain(agentWritten ? "' (a session's summary, labelled as written by an agent, not checked)" : "'"),
    ]);
  }
  const state = found.state as { name?: unknown } | undefined;
  if (typeof state?.name === 'string') changes.push([plain('move it to '), value(state.name)]);
  const labels = found.labels as { add?: unknown; remove?: unknown } | undefined;
  const add = labelNames(labels?.add);
  const remove = labelNames(labels?.remove);
  if (add.length > 0) changes.push([plain('add the labels '), ...list(add, ' and ')]);
  if (remove.length > 0) changes.push([plain('remove the labels '), ...list(remove, ' and ')]);
  if (Object.hasOwn(found, 'assignee')) changes.push([plain('assign it to '), ...assigneeWords(found.assignee)]);
  const key = found.team?.key;
  return [
    plain('change the issue '),
    ...(issue === undefined ? [] : [value(issue), plain(' made')]),
    plain(' in '),
    value('Linear'),
    ...(typeof key === 'string' && key !== '' ? [plain(', team '), value(key)] : []),
    ...(changes.length === 0 ? [] : [plain(': '), ...list(changes, ' and ')]),
  ];
}

/** The lines about the whole workflow that come first: a chain's start, and a shadow. */
function flowLines(scope: Scope): { stepIds: readonly StepId[]; parts: readonly RulePart[] }[] {
  const flow = scope.rule.flow;
  const lines: { stepIds: readonly StepId[]; parts: readonly RulePart[] }[] = [];
  if (flow.on !== undefined) {
    const workflows = [...new Set(flow.on.raised.map((pattern) => pattern.split('.')[1] ?? pattern))];
    lines.push({
      stepIds: [],
      parts: [
        plain('It starts only when '),
        ...list(
          workflows.map((name) => [value(name)]),
          ' or ',
        ),
        plain(' raises '),
        ...list(
          flow.on.raised.map((pattern) => [value(pattern)]),
          ' or ',
        ),
        plain(
          ` about the same message, and keeps what it needs of each message for up to ${formatDuration(flow.on.withinMs)} in case it does.`,
        ),
      ],
    });
  }
  if (flow.shadow === true)
    lines.push({
      stepIds: [],
      parts: [
        plain(
          'It runs in shadow: every start, worktree, Linear write, prompt, notice and raised event below is only recorded as a dry run, and its waits end at once.',
        ),
      ],
    });
  return lines;
}

/** The run's own events (W23), ticked in the workflow's settings: the last line. */
function runLines(scope: Scope): { stepIds: readonly StepId[]; parts: readonly RulePart[] }[] {
  const events = scope.rule.flow.events;
  if (events?.run === undefined || events.run.length === 0) return [];
  const run = events.run;
  return [
    {
      stepIds: [],
      parts: [
        plain('When a run '),
        ...list(
          run.map((word) => [plain(RUN_EVENT_WORDS[word] ?? word)]),
          ' or ',
        ),
        plain(', it raises '),
        ...list(
          run.map((word) => [value(`${events.namespace}.${events.workflow}.run.${word}`)]),
          ' or ',
        ),
        plain(', with the steps it ran and how it ended: nothing a sender wrote'),
        ...audience(scope),
        plain('.'),
      ],
    },
  ];
}

/** A count and its noun: `1 run`, `6 runs`. */
const counted = (count: number, one: string, more: string) => `${count} ${count === 1 ? one : more}`;

/**
 * The flow's limits (§10.2, 0.37.0 §6): the last line, every one of `flow.limits` as written, defaults too, in a fixed
 * order — the runs an hour and at a time; the sessions started, Linear writes and events an hour; the worktrees a day;
 * and when a run ends. Each is a number `checkFlow` bounds, never the author's text, so the line is plain words.
 */
function limitsLine(limits: FlowLimits): { stepIds: readonly StepId[]; parts: readonly RulePart[] } {
  return {
    stepIds: [],
    parts: [
      plain(
        `At most ${counted(limits.runsPerHour, 'run', 'runs')} an hour, ${limits.concurrentRuns} at a time; ` +
          `at most ${counted(limits.sessionsPerHour, 'session', 'sessions')} started, ` +
          `${counted(limits.linearWritesPerHour, 'Linear write', 'Linear writes')} and ` +
          `${counted(limits.eventsPerHour, 'event', 'events')} an hour; ` +
          `at most ${counted(limits.worktreesPerDay, 'worktree', 'worktrees')} a day; ` +
          `a run ends after ${formatDuration(limits.runMs)}.`,
      ),
    ],
  };
}
