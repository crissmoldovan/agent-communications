/**
 * The `flow` section of the workflow text (workflows design §4.4, W17): its line with the limits, its `events` and
 * `on raised` lines, and one `step` per step, each with its arrows. The parser reads words, not the workflow: whether
 * the steps, targets, projects and events exist and fit is `checkFlow`'s and the event service's to say.
 *
 * Arrows: a step that writes no `otherwise` of its own goes on to the next step written — `{ otherwise: <that step> }`
 * — whether or not it writes other arrows; the last step written, and a step that writes `then stop`, go nowhere
 * else. `then → <step|end>` and `otherwise → <step|end>` are the same arrow, and `->` may be typed for `→`.
 */
import { FLOW_BOUNDS, FLOW_LIMIT_DEFAULTS, STEP_OUTCOMES } from '../flow/types.ts';
import { canonicalJson, type JsonValue } from '../json.ts';
import { setOwn } from '../own-property.ts';
import { Cursor, RuleTextFailure, subLine, type TextLine } from './lines.ts';
import { providerWord } from './session.ts';
import {
  ARROW,
  FLOW_LIMIT_WORDS,
  isStepOwnLine,
  PATTERN_CHARACTER,
  STEP_PHRASES,
  series,
  suggestion,
} from './vocabulary.ts';

type Record_ = Record<string, JsonValue>;
type Readers = Readonly<Record<string, readonly [phrase: string, read: () => void]>>;
type BlockReaders = readonly (readonly [
  words: readonly string[],
  read: (cursor: Cursor, child: TextLine) => void,
  takesLines?: 'takes lines',
])[];

/**
 * The clauses a workflow's step adds to the line of the target it delivers to: `to <steps>` after a session, `on
 * <step>` after a Linear change. Each reads its words with the target line's own cursor.
 */
export type StepClauses = (cursor: Cursor, kind: 'session' | 'linear-change') => Readers;

/** What the flow parser borrows from `parse.ts`, passed in so the two modules do not import each other. */
export interface FlowParseHelpers {
  readonly clauses: (cursor: Cursor, what: string, readers: Readers) => void;
  readonly block: (line: TextLine, what: string, readers: BlockReaders) => void;
  readonly field: (cursor: Cursor, what: string) => string;
  readonly noChildren: (line: TextLine, what: string) => void;
  readonly names: (cursor: Cursor, what: string) => string[];
  readonly duration: (cursor: Cursor, what: string) => number;
  readonly condition: (cursor: Cursor, line: TextLine) => JsonValue;
  readonly ask: (cursor: Cursor, line: TextLine) => JsonValue;
  readonly askBody: (line: TextLine, agentic: Record_, judge: Record_, what: string) => void;
  readonly target: (line: TextLine, step: StepClauses) => JsonValue;
}

/** What the flow section says: the flow, and the targets its steps wrote in full, in the order written. */
export interface FlowSection {
  readonly flow: Record_;
  readonly targets: JsonValue[];
  /** Whether any step wrote its target in full; when none did, `raw /targets` may give the targets. */
  readonly targetsWritten: boolean;
}

/** One step as written. */
interface WrittenStep {
  readonly id: string;
  readonly line: TextLine;
  /** The step's document; a `raw` step's is exactly its JSON. */
  readonly step: JsonValue;
  readonly raw: boolean;
  /** Whether the step said where its other outcomes go: an `otherwise` or `then` arrow, or `then stop`. */
  readonly otherwise: boolean;
  /** The target a deliver step wrote in full, or `reference` when it named one by id. */
  readonly target?: JsonValue | 'reference';
}

function fail(line: TextLine, message: string): never {
  throw new RuleTextFailure(line.number, line.column, message);
}

/**
 * Reads the `flow` section: `cursor` is at its keyword, and its lines are indented under `line`. A refusal in one step
 * is recorded by `attempt` and the next step is still read.
 */
export function parseFlowSection(
  cursor: Cursor,
  line: TextLine,
  helpers: FlowParseHelpers,
  attempt: (read: () => void) => void,
): FlowSection {
  cursor.take('flow');
  const limits: Record<string, number> = {};
  let shadow = false;
  const flowLine = () => {
    const said = new Set<string>();
    const one = (what: string, at: number) => {
      if (said.has(what)) cursor.fail(`the flow line says ${what} once`, at);
      said.add(what);
    };
    let inLimits = false;
    while (cursor.comma()) {
      const at = cursor.mark();
      if (cursor.take('at', 'most') || (inLimits && /^[0-9]/u.test(cursor.peekWord() ?? ''))) {
        inLimits = true;
        const limitAt = cursor.mark();
        const count = cursor.integer('the limit');
        const found = FLOW_LIMIT_WORDS.find(
          ([, singular, plural]) => cursor.take(...singular) || cursor.take(...plural),
        );
        if (found === undefined)
          cursor.fail(
            `a flow's limits are ${series(
              FLOW_LIMIT_WORDS.map(([, , plural]) => `<n> ${plural.join(' ')}`),
              'and',
            )}; found ${cursor.describeNext()}`,
          );
        const field = (found as (typeof FLOW_LIMIT_WORDS)[number])[0];
        one(field, limitAt);
        limits[field] = count;
        continue;
      }
      inLimits = false;
      if (cursor.take('each', 'run', 'up', 'to')) {
        one('runMs', at);
        limits.runMs = helpers.duration(cursor, 'how long a run may take');
      } else if (cursor.take('in', 'shadow')) {
        one('in shadow', at);
        shadow = true;
      } else
        cursor.fail(
          `the flow line's options are at most <n> runs an hour and the other limits, each run up to <duration>, and in shadow; found ${cursor.describeNext()}`,
          at,
        );
    }
    cursor.expectEnd('the flow line');
  };
  flowLine();
  if (line.children.length === 0)
    fail(line, 'a flow needs its steps on the lines indented under it: step <id>: <what it does>');
  let events: Record_ | undefined;
  let on: Record_ | undefined;
  const written: WrittenStep[] = [];
  const seen = new Map<string, number>();
  const LINES = ['step', 'events in', 'on raised'];
  let read = 0;
  const readLine = (child: TextLine): void => {
    const inner = new Cursor(child);
    const at = inner.mark();
    if (inner.isNext('step')) {
      const step = stepLine(inner, child, helpers);
      const first = seen.get(step.id);
      if (first !== undefined) inner.fail(`a flow has one step ${step.id}; it is already on line ${first}`, at);
      seen.set(step.id, child.number);
      written.push(step);
    } else if (inner.take('events', 'in')) {
      if (events !== undefined) inner.fail('a flow says where its events are named once', at);
      helpers.noChildren(child, 'the events line');
      events = eventsLine(inner, helpers);
    } else if (inner.take('on', 'raised')) {
      if (on !== undefined) inner.fail('a flow says which raised events start it once', at);
      helpers.noChildren(child, 'the on raised line');
      on = onLine(inner, helpers);
    } else {
      const word = inner.peekWord();
      const close = word === undefined ? undefined : suggestion(word, LINES);
      inner.fail(
        `a flow's lines are step, events in and on raised; found ${inner.describeNext()}${
          close === undefined ? '' : `; did you mean ${JSON.stringify(close)}?`
        }`,
        at,
      );
    }
    read += 1;
  };
  for (const child of line.children) attempt(() => readLine(child));
  if (written.length === 0) {
    // A line that failed is already reported: only a flow whose lines were all read and none a step is short of one.
    if (read === line.children.length)
      fail(line, 'a flow needs at least one step, indented under it: step <id>: <what it does>');
    return { flow: {}, targets: [], targetsWritten: false };
  }
  // The arrow rule: a step that says nothing of its other outcomes goes on to the next step written.
  for (const [index, entry] of written.entries()) {
    const following = written[index + 1];
    if (entry.raw || entry.otherwise || following === undefined) continue;
    const step = entry.step as Record_;
    if (step.kind === 'split') continue;
    (step.next as Record_).otherwise = following.id;
  }
  const steps: Record_ = {};
  for (const entry of written) setOwn(steps, entry.id, entry.step);
  const flow: Record_ = {
    flowVersion: 1,
    start: (written[0] as WrittenStep).id,
    steps,
    limits: { ...FLOW_LIMIT_DEFAULTS, ...limits },
  };
  if (events !== undefined) flow.events = events;
  if (on !== undefined) flow.on = on;
  if (shadow) flow.shadow = true;
  return { flow, ...collectTargets(written) };
}

/**
 * The targets the steps wrote in full, in the order written, each once (by id and version). The same target written
 * on two steps must be written the same way; and when one step writes its target in full, every deliver step does.
 */
function collectTargets(written: readonly WrittenStep[]): { targets: JsonValue[]; targetsWritten: boolean } {
  const targets: JsonValue[] = [];
  const where = new Map<string, { readonly json: string; readonly step: WrittenStep }>();
  const full = written.filter((entry) => entry.target !== undefined && entry.target !== 'reference');
  for (const entry of full) {
    const target = entry.target as Record_;
    const key = `${String(target.targetId)}@${String(target.version)}`;
    const json = canonicalJson(target);
    const first = where.get(key);
    if (first === undefined) {
      where.set(key, { json, step: entry });
      targets.push(target);
    } else if (first.json !== json)
      fail(
        entry.line,
        `step ${entry.id} writes the target ${String(target.targetId)}, version ${String(target.version)}, differently from step ${first.step.id} on line ${first.step.line.number}; a target version is the same wherever it is written`,
      );
  }
  if (full.length > 0) {
    const named = written.find((entry) => entry.target === 'reference');
    if (named !== undefined)
      fail(
        named.line,
        `step ${named.id} names its target by id, while other steps write theirs in full; write it in full, as they do`,
      );
  }
  return { targets, targetsWritten: full.length > 0 };
}

/** `events in <namespace> as <workflow>[, run emits <word> and <word>]` (W24). */
function eventsLine(cursor: Cursor, helpers: FlowParseHelpers): Record_ {
  const events: Record_ = { namespace: cursor.name('the namespace') };
  cursor.expect(['as'], '"as <workflow>" after the namespace');
  events.workflow = cursor.name("the workflow's name in its events");
  if (cursor.comma()) {
    cursor.expect(['run', 'emits'], '", run emits <event> and <event>"');
    events.run = helpers.names(cursor, "a run's event");
  }
  cursor.expectEnd('the events line');
  return events;
}

/** One pattern: quoted text, or its segments and `*`s as they are. */
function pattern(cursor: Cursor): string {
  if (cursor.isString()) return cursor.string('the pattern');
  const found = cursor.run(PATTERN_CHARACTER);
  if (found === undefined)
    return cursor.fail(
      `expected a pattern such as acme.client-asks.issue.created or acme.client-asks.*.*; found ${cursor.describeNext()}`,
    );
  return found;
}

/** `on raised <pattern> and <pattern>[, within <duration>]` (W34): a chained workflow's start. */
function onLine(cursor: Cursor, helpers: FlowParseHelpers): Record_ {
  const raised = [pattern(cursor)];
  while (cursor.take('and')) raised.push(pattern(cursor));
  let withinMs: number = FLOW_BOUNDS.onWithinDefaultMs;
  if (cursor.comma()) {
    cursor.expect(['within'], '", within <duration>" after the patterns');
    withinMs = helpers.duration(cursor, 'how long it waits for a raised event');
  }
  cursor.expectEnd('the on raised line');
  return { raised, withinMs };
}

/** The step kinds by the words their phrase starts with, in the order they are tried. */
const STARTS: readonly (readonly [words: readonly string[], kind: string])[] = [
  [['raw'], 'raw'],
  [['if'], 'condition'],
  [['ask'], 'judge'],
  [['choose', 'a', 'project'], 'route'],
  [['find'], 'find-session'],
  [['start', 'a', 'session'], 'start-session'],
  [['make', 'a', 'worktree'], 'worktree'],
  [['wait', 'for'], 'wait'],
  [['tell', 'me'], 'notify'],
  [['split', 'into'], 'split'],
  [['raise'], 'raise'],
  [['deliver'], 'deliver'],
  [['dry', 'run'], 'deliver'],
  [['queue'], 'deliver'],
  [['webhook'], 'deliver'],
  [['stream'], 'deliver'],
  [['session'], 'deliver'],
  [['linear', 'issue'], 'deliver'],
  [['linear', 'change'], 'deliver'],
];

const KIND_WORDS: Readonly<Record<string, string>> = {
  condition: 'an if step',
  judge: 'an ask step',
  route: 'a route',
  'find-session': 'a find',
  'start-session': 'a start',
  worktree: 'a worktree step',
  deliver: 'a deliver step',
  wait: 'a wait',
  notify: 'a tell me step',
  split: 'a split',
  raise: 'a raise step',
};

/** `step <id>: <what it does>`, with its lines: its kind's, then its label, events and arrows. */
function stepLine(cursor: Cursor, line: TextLine, helpers: FlowParseHelpers): WrittenStep {
  cursor.take('step');
  const idAt = cursor.mark();
  const word = cursor.word();
  if (word === undefined || !word.endsWith(':') || word.length === 1 || word.slice(0, -1).includes(':'))
    cursor.fail('a step starts with its id and a colon: step <id>: <what it does>', idAt);
  const id = (word as string).slice(0, -1);
  const at = cursor.mark();
  const start = STARTS.find(([words]) => cursor.isNext(...words));
  if (start === undefined) {
    const next = cursor.peekWord();
    const close = next === undefined ? undefined : suggestion(next, STEP_PHRASES);
    return cursor.fail(
      `a step says what it does: ${series(STEP_PHRASES, 'or')}; found ${cursor.describeNext()}${
        close === undefined ? '' : `; did you mean ${JSON.stringify(close)}?`
      }`,
      at,
    );
  }
  const kind = start[1];
  if (kind === 'raw') {
    cursor.takeRaw();
    const step = cursor.json('the raw step');
    cursor.expectEnd('the raw step');
    helpers.noChildren(line, 'a raw step');
    return { id, line, step, raw: true, otherwise: true };
  }
  const own: TextLine[] = [];
  const content: TextLine[] = [];
  for (const child of line.children) (isStepOwnLine(child.text, kind) ? own : content).push(child);
  const phrase = subLine(line, at, content);
  const read = readKind(kind, new Cursor(phrase), phrase, helpers);
  const step: Record_ = read.step;
  let otherwise = false;
  const next: Record_ = {};
  let emit: string[] | undefined;
  let label: string | undefined;
  let report: string[] | undefined;
  for (const child of own) {
    helpers.noChildren(child, 'this line');
    const inner = new Cursor(child);
    const lineAt = inner.mark();
    const arrow = ARROW.exec(child.text);
    if (arrow !== null) {
      if (kind === 'split') inner.fail('a split has no arrows: it goes on to every one of its branches', lineAt);
      const outcome = arrow[1] as string;
      const target = new Cursor(subLine(child, arrow[0].length, []));
      const to = target.name('where the arrow goes: a step, or end');
      target.expectEnd('the arrow');
      if (outcome === 'otherwise' || outcome === 'then') {
        if (otherwise) inner.fail(`${KIND_WORDS[kind]} says where its other outcomes go once`, lineAt);
        otherwise = true;
        next.otherwise = to;
        continue;
      }
      const outcomes = STEP_OUTCOMES[kind as keyof typeof STEP_OUTCOMES] ?? [];
      if (!outcomes.includes(outcome)) {
        const close = suggestion(outcome, outcomes);
        inner.fail(
          `${outcome} is not an outcome of ${KIND_WORDS[kind]}: it has ${series([...outcomes], 'and')}, and otherwise${
            close === undefined ? '' : `; did you mean ${JSON.stringify(close)}?`
          }`,
          lineAt,
        );
      }
      if (Object.hasOwn(next, outcome)) inner.fail(`${KIND_WORDS[kind]} has one arrow for ${outcome}`, lineAt);
      next[outcome] = to;
      continue;
    }
    if (inner.take('then', 'stop') || inner.take('otherwise', 'stop')) {
      if (kind === 'split') inner.fail('a split has no arrows: it goes on to every one of its branches', lineAt);
      if (otherwise) inner.fail(`${KIND_WORDS[kind]} says where its other outcomes go once`, lineAt);
      otherwise = true;
      inner.expectEnd('stop');
      continue;
    }
    if (inner.take('emits')) {
      if (emit !== undefined) inner.fail('a step lists the events it emits once', lineAt);
      emit = helpers.names(inner, 'an event');
      inner.expectEnd('the events');
      continue;
    }
    if (inner.take('label')) {
      if (label !== undefined) inner.fail('a step has one label', lineAt);
      label = inner.string('the label');
      inner.expectEnd('the label');
      continue;
    }
    inner.take('report');
    if (report !== undefined) inner.fail('a delivery says what its session reports once', lineAt);
    report = helpers.names(inner, 'a word the session reports');
    inner.expectEnd('the words it reports');
  }
  if (report !== undefined) step.report = report;
  if (label !== undefined) step.label = label;
  if (emit !== undefined) step.emit = emit;
  if (kind !== 'split') step.next = next;
  return {
    id,
    line,
    step,
    raw: false,
    otherwise,
    ...(read.target === undefined ? {} : { target: read.target }),
  };
}

/** The step's own reading, by kind, of its phrase and the lines under it that are not its label, events or arrows. */
function readKind(
  kind: string,
  cursor: Cursor,
  line: TextLine,
  helpers: FlowParseHelpers,
): { step: Record_; target?: JsonValue | 'reference' } {
  const none = () => {
    const [child] = line.children;
    if (child !== undefined)
      fail(child, `${KIND_WORDS[kind]}'s lines are its label, the events it emits and its arrows; found this one`);
  };
  switch (kind) {
    case 'condition': {
      cursor.take('if');
      return { step: { kind, when: helpers.condition(cursor, line) } };
    }
    case 'judge':
      return { step: { kind, ask: helpers.ask(cursor, line) } };
    case 'route':
      return { step: route(cursor, line, helpers) };
    case 'find-session': {
      cursor.take('find');
      const step: Record_ = { kind };
      if (cursor.take('the')) {
        if (cursor.take('idle')) step.only = 'idle';
        cursor.expect(
          ['session', 'that', 'took', 'this', 'conversation'],
          '"session that took this conversation" after "find the"',
        );
        step.in = { thread: true };
      } else {
        if (cursor.take('an', 'idle', 'session')) step.only = 'idle';
        else
          cursor.expect(
            ['a', 'session'],
            '"a session", "an idle session" or "the session that took this conversation"',
          );
        step.in = place(cursor);
      }
      sessionClauses(cursor, step, helpers, false);
      none();
      return { step };
    }
    case 'start-session': {
      cursor.take('start', 'a', 'session');
      const step: Record_ = { kind, in: place(cursor) };
      sessionClauses(cursor, step, helpers, true);
      none();
      return { step };
    }
    case 'worktree': {
      cursor.take('make', 'a', 'worktree');
      cursor.expect(['of'], '"of <route step>\'s project" after make a worktree');
      const project = cursor.name('the route step whose project it uses');
      if (!cursor.symbol("'s")) cursor.fail(`expected "'s project" after the route step's id`);
      cursor.expect(['project'], `"project" after "'s"`);
      const step: Record_ = { kind, project };
      helpers.clauses(cursor, 'a worktree', {
        branch: [
          'branch "<template>"',
          () => {
            cursor.take('branch');
            step.branch = cursor.string("the worktree's branch");
          },
        ],
        from: [
          'from <branch>',
          () => {
            cursor.take('from');
            step.base = { branch: cursor.name('the branch it starts from') };
          },
        ],
        removed: [
          'removed if clean',
          () => {
            cursor.expect(['removed', 'if', 'clean'], '"removed if clean"');
            step.cleanup = 'remove-if-clean';
          },
        ],
      });
      none();
      return { step: { ...step, base: step.base ?? 'default', cleanup: step.cleanup ?? 'keep' } };
    }
    case 'wait': {
      cursor.take('wait', 'for');
      const step: Record_ = { kind };
      if (/^[0-9]/u.test(cursor.peekWord() ?? ''))
        step.for = { time: { afterMs: helpers.duration(cursor, 'how long it waits') } };
      else {
        const id = cursor.name('the step it waits on');
        if (!cursor.symbol("'s"))
          cursor.fail(`expected "'s turn to end" or "'s session to be free" after the step's id`);
        if (cursor.take('turn', 'to', 'end')) step.for = { turnEnd: id };
        else if (cursor.take('session', 'to', 'be', 'free')) step.for = { sessionIdle: id };
        else cursor.fail(`expected "turn to end" or "session to be free"; found ${cursor.describeNext()}`);
      }
      helpers.clauses(cursor, 'a wait', {
        up: [
          'up to <duration>',
          () => {
            cursor.expect(['up', 'to'], '"up to <duration>"');
            step.timeoutMs = helpers.duration(cursor, 'how long it waits at most');
          },
        ],
      });
      none();
      return { step };
    }
    case 'notify': {
      cursor.take('tell', 'me');
      const text = cursor.string('the notice');
      cursor.expectEnd('the notice');
      none();
      return { step: { kind, text } };
    }
    case 'split': {
      cursor.take('split', 'into');
      const branches = helpers.names(cursor, 'a branch');
      cursor.expectEnd('the branches');
      none();
      return { step: { kind, branches } };
    }
    case 'raise': {
      cursor.take('raise');
      const step: Record_ = { kind, name: cursor.name("the event's name") };
      cursor.expectEnd("the event's name");
      helpers.block(line, 'a raise step', [
        [
          ['fields'],
          (inner) => {
            const fields = [helpers.field(inner, 'a field it carries')];
            while (inner.comma()) fields.push(helpers.field(inner, 'a field it carries'));
            step.fields = fields;
          },
        ],
      ]);
      return { step };
    }
    default:
      return deliver(cursor, line, helpers);
  }
}

/** Where a session is found or started (§4.1): a route's project, a worktree step's, a folder, or a lane's window. */
function place(cursor: Cursor): Record_ {
  if (cursor.take('working', 'in')) return { folder: cursor.name('the folder') };
  cursor.expect(['in'], `where: in <route step>'s project, in <worktree step>, working in <folder> or in lane <name>`);
  const id = cursor.name('a step, or lane <name>');
  if (cursor.symbol("'s")) {
    cursor.expect(['project'], `"project" after "'s"`);
    return { project: id };
  }
  if (id === 'lane' && !cursor.atEnd() && !cursor.nextIs(',')) return { lane: cursor.name('the lane') };
  return { worktree: id };
}

/** A find's or a start's clauses: `with <provider>`, and a start's `mode <mode>`. */
function sessionClauses(cursor: Cursor, step: Record_, helpers: FlowParseHelpers, start: boolean): void {
  helpers.clauses(cursor, start ? 'a start' : 'a find', {
    with: [
      'with claude-code or codex',
      () => {
        cursor.take('with');
        step.provider = providerWord(cursor);
      },
    ],
    ...(start
      ? {
          mode: [
            'mode <mode>',
            () => {
              cursor.take('mode');
              step.mode = cursor.name('the mode');
            },
          ] as const,
        }
      : {}),
  });
}

/**
 * Which project? (§6.1): `choose a project among <name> and <name>, by hints then by <judge> version <n>`, with the
 * fields it looks at, each project's id and folders, and the judge's lines under `asking`.
 */
function route(cursor: Cursor, line: TextLine, helpers: FlowParseHelpers): Record_ {
  cursor.take('choose', 'a', 'project');
  cursor.expect(['among'], '"among <project> and <project>"');
  const at = cursor.mark();
  const named = helpers.names(cursor, "a project's name");
  const duplicate = named.find((name, index) => named.indexOf(name) !== index);
  if (duplicate !== undefined) cursor.fail(`a route names the project ${duplicate} once`, at);
  const step: Record_ = { kind: 'route' };
  let judge: Record_ | undefined;
  helpers.clauses(cursor, 'a route', {
    by: [
      'by hints, then by <judge> version <n>',
      () => {
        cursor.take('by');
        const ways: string[] = [];
        const readJudge = () => {
          judge = { judgeId: cursor.name('the judge') };
          cursor.expect(['version'], '"version <n>" after the judge');
          judge.version = cursor.integer("the judge's version");
          if (cursor.take('via')) judge.provider = cursor.name('the provider');
          ways.push('judge');
        };
        const saved = cursor.save();
        if (!cursor.isString() && cursor.take('hints') && !cursor.isNext('version')) {
          ways.push('hints');
          if (cursor.take('then', 'by')) readJudge();
        } else {
          cursor.restore(saved);
          readJudge();
        }
        step.by = ways;
      },
    ],
  });
  const details = new Map<string, Record_>();
  let agentic: Record_ | undefined;
  for (const child of line.children) {
    const inner = new Cursor(child);
    const lineAt = inner.mark();
    if (inner.take('looking', 'at')) {
      helpers.noChildren(child, 'looking at');
      if (Object.hasOwn(step, 'inputs')) inner.fail('a route says what it looks at once', lineAt);
      if (inner.take('nothing')) step.inputs = [];
      else {
        const inputs = [helpers.field(inner, 'a field it looks at')];
        while (inner.comma()) inputs.push(helpers.field(inner, 'a field it looks at'));
        step.inputs = inputs;
      }
      inner.expectEnd('the fields');
    } else if (inner.take('project')) {
      helpers.noChildren(child, 'a project');
      const nameAt = inner.mark();
      const name = inner.name("the project's name");
      if (!named.includes(name))
        inner.fail(`${name} is not among the projects the route's line names: ${series(named, 'and')}`, nameAt);
      if (details.has(name)) inner.fail(`a route gives project ${name}'s line once`, nameAt);
      const candidate: Record_ = { projectId: name, name, folders: [], worktreeRoot: null };
      helpers.clauses(inner, 'a project', {
        id: [
          'id <project id>',
          () => {
            inner.take('id');
            candidate.projectId = inner.name("the project's id");
          },
        ],
        in: [
          'in <folder> and <folder>',
          () => {
            inner.take('in');
            candidate.folders = helpers.names(inner, 'a folder');
          },
        ],
        worktrees: [
          'worktrees in <folder>',
          () => {
            inner.expect(['worktrees', 'in'], '"worktrees in <folder>"');
            candidate.worktreeRoot = inner.name("the project's worktree folder");
          },
        ],
      });
      details.set(name, candidate);
    } else if (inner.take('asking')) {
      inner.expectEnd('asking');
      if (agentic !== undefined) inner.fail('a route gives its judge once', lineAt);
      if (judge === undefined)
        inner.fail(
          'asking describes the judge a route chooses by; name it on the line: by <judge> version <n>',
          lineAt,
        );
      if (child.children.length === 0) fail(child, "asking needs the judge's lines indented under it");
      agentic = { judge: judge as Record_ };
      helpers.askBody(child, agentic, judge as Record_, 'asking');
    } else
      inner.fail(
        `a route's lines are looking at, project and asking, then its label, events and arrows; found ${inner.describeNext()}`,
        lineAt,
      );
  }
  step.candidates = named.map(
    (name) => details.get(name) ?? { projectId: name, name, folders: [], worktreeRoot: null },
  );
  if (judge !== undefined) step.judge = agentic ?? { judge };
  return step;
}

/** A deliver step: a target written in full, or named by id (`deliver <id>, version <n>`), and where it goes. */
function deliver(
  cursor: Cursor,
  line: TextLine,
  helpers: FlowParseHelpers,
): { step: Record_; target: JsonValue | 'reference' } {
  const step: Record_ = { kind: 'deliver' };
  const clauses: StepClauses = (inner, kind) =>
    kind === 'session'
      ? {
          to: [
            'to <step>, <step> or <step>',
            () => {
              inner.take('to');
              const steps = [inner.name('a find or start step')];
              for (;;) {
                if (inner.take('or')) {
                  steps.push(inner.name('a find or start step'));
                  break;
                }
                if (!inner.comma()) break;
                steps.push(inner.name('a find or start step'));
              }
              step.to = { session: steps };
            },
          ],
        }
      : {
          on: [
            'on <create step>',
            () => {
              inner.take('on');
              step.to = { issue: inner.name('the step that made the issue') };
            },
          ],
        };
  if (cursor.take('deliver')) {
    const targetId = cursor.name("the target's id");
    cursor.expect([',', 'version'], `", version <n>" after the target's id`);
    step.target = { targetId, version: cursor.integer("the target's version") };
    helpers.clauses(cursor, 'a delivery', { ...clauses(cursor, 'session'), ...clauses(cursor, 'linear-change') });
    const [child] = line.children;
    if (child !== undefined)
      fail(
        child,
        "a delivery that names its target by id has no lines of the target's under it; raw /targets gives it",
      );
    return { step, target: 'reference' };
  }
  const target = helpers.target(line, clauses) as Record_;
  if (typeof target.targetId !== 'string' || typeof target.version !== 'number')
    fail(line, "a step's target says its id and version: <kind> <id>, version <n>");
  step.target = { targetId: target.targetId, version: target.version };
  return { step, target };
}
