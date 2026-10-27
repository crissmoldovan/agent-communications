/**
 * The canvas as pure functions of the workflow (workflows design W20, §11.3): the document is the one thing the
 * designer holds, and every change the canvas makes is a function from the old document to a new one — a step dropped,
 * an arrow drawn, a step deleted, an event ticked. Where the boxes sit is kept apart, by workflow id and box id: a drag
 * changes the kept positions and never a byte of the document, so moving a box makes no new version.
 *
 * A workflow with a `flow` is drawn as that flow; a straight line, which has none, as the graph `flowOf` derives,
 * without writing it (W2). Its first change that the straight line cannot say — a step dropped, an arrow drawn, an event
 * ticked — writes the flow, so that version is a workflow with a flow, approved like any other.
 *
 * Tolerant of a draft: a step with a field missing, an arrow to nothing, an empty start are drawn as they are, and
 * `checkFlow` says what is wrong; nothing here throws on a document a person is still editing.
 */
import type { Edge, Node } from '@xyflow/react';
import { copyOf, isObject, type Json, type JsonObject, targetsIn } from '../rule-editor/model.ts';
import { DELIVER_TITLES, FIND_TITLES, GATE_TITLES, outcomeWords, STEP_TITLES, WAIT_TITLES } from './copy.ts';
import {
  connectionAllowed,
  FLOW_BOUNDS,
  type FlowDocumentV1,
  type FlowStep,
  flowOf,
  outcomesOf,
  STEP_KINDS,
  type StepId,
  type StepKind,
} from './flow.ts';
import { boxHeight, layout, NODE_HEIGHT, NODE_WIDTH, type Point, type Positions } from './layout.ts';

export type { Point, Positions } from './layout.ts';

/** The gate's boxes, by id: never a step id, which has no `:`. */
export const GATE = {
  trigger: 'gate:trigger',
  condition: 'gate:condition',
  judge: 'gate:judge',
  keep: 'gate:keep',
} as const;
export type GatePart = keyof typeof GATE;

/** A step's handle that adds a branch to a split. */
export const BRANCHES = 'branches';

/** Where a box takes its arrows in, and where the gate's boxes send theirs out. */
export const IN = 'in';
export const OUT = 'out';

/** A tone of `NodeCard`: what starts it, what stays in Agent Comms, and what acts outside it. */
export type BoxTone = 'input' | 'processing' | 'output';

/** One of a step's outcomes, as its box draws it: wired to a step, or a "Stops" mark where nothing is. */
export interface HandleView {
  readonly id: string;
  readonly words: string;
  readonly wired: boolean;
  readonly stops: boolean;
}

export interface StepBox extends Record<string, unknown> {
  readonly role: 'step';
  readonly stepId: StepId;
  readonly kind: StepKind | null;
  readonly title: string;
  /** The author's label, their text. */
  readonly label: string | null;
  readonly tone: BoxTone;
  readonly handles: readonly HandleView[];
  /** How many events are ticked: the mark a step that emits shows. */
  readonly emits: number;
  /** How many things `checkFlow` and the designer's checks found wrong with it. */
  readonly problems: number;
  /** Whether the flow starts here. */
  readonly entry: boolean;
}

export interface GateBox extends Record<string, unknown> {
  readonly role: 'gate';
  readonly part: GatePart;
  readonly title: string;
  readonly tone: BoxTone;
  /** Whether its arrow out goes anywhere: the keep box's goes to the flow's start. */
  readonly wired: boolean;
}

export type CanvasNode = Node<StepBox, 'step'> | Node<GateBox, 'gate'>;

export interface WireData extends Record<string, unknown> {
  live?: boolean;
  muted?: boolean;
  tone?: 'accent' | 'ok' | 'busy' | 'warn' | 'danger' | 'info';
}
export type CanvasEdge = Edge<WireData, 'signal'>;

type Steps = Record<StepId, JsonObject>;

const STEP_ID = /^[a-z][a-z0-9-]{0,31}$/;

/** The kinds that reach outside Agent Comms: drawn as outputs, and listed when the person approves. */
const ACTS: ReadonlySet<string> = new Set(['deliver', 'start-session', 'worktree', 'raise']);

const isKind = (value: unknown): value is StepKind => (STEP_KINDS as readonly unknown[]).includes(value);

/** The document's targets, by `<id>@<version>`, to their kind. */
export function targetKinds(document: JsonObject): Record<string, string> {
  const kinds: Record<string, string> = {};
  for (const target of targetsIn(document))
    if (typeof target.targetId === 'string' && typeof target.version === 'number' && typeof target.kind === 'string')
      Object.defineProperty(kinds, `${target.targetId}@${target.version}`, {
        value: target.kind,
        enumerable: true,
        writable: true,
        configurable: true,
      });
  return kinds;
}

/** The target a deliver step names, from the document's `targets`; null when it names none there. */
export function targetOf(document: JsonObject, step: Json | undefined): JsonObject | null {
  if (!isObject(step) || !isObject(step.target)) return null;
  const { targetId, version } = step.target;
  return targetsIn(document).find((target) => target.targetId === targetId && target.version === version) ?? null;
}

/**
 * The flow the canvas draws: the document's own (`derived: false`), or the straight line's, derived (`derived: true`).
 * Never written into the document.
 */
export function flowOfDocument(document: JsonObject): { flow: FlowDocumentV1; derived: boolean } {
  const targets = targetsIn(document).map((target) => ({
    targetId: typeof target.targetId === 'string' ? target.targetId : '',
    version: typeof target.version === 'number' ? target.version : 0,
    kind: typeof target.kind === 'string' ? target.kind : '',
  }));
  return isObject(document.flow)
    ? flowOf({ targets, flow: document.flow as unknown as FlowDocumentV1 })
    : flowOf({ targets });
}

/** A copy of the document with a flow of its own to change: its flow, or the straight line's, written out. */
function editable(document: JsonObject): { next: JsonObject; flow: JsonObject; steps: Steps } {
  const next = copyOf(document);
  const flow = isObject(next.flow)
    ? next.flow
    : (JSON.parse(JSON.stringify(flowOfDocument(document).flow)) as JsonObject);
  if (!isObject(flow.steps)) flow.steps = {};
  next.flow = flow;
  return { next, flow, steps: flow.steps as Steps };
}

const stepsOf = (flow: FlowDocumentV1): Readonly<Record<string, unknown>> =>
  isObject(flow.steps as unknown) ? (flow.steps as unknown as Record<string, unknown>) : {};

const arrowsOf = (step: JsonObject): Record<string, Json> => (isObject(step.next) ? step.next : {});

/** What a step is called on its box: its kind's name, a deliver step by its target, a find and a wait by their place. */
export function stepTitle(document: JsonObject, step: Json | undefined): string {
  if (!isObject(step) || !isKind(step.kind)) return 'A step';
  switch (step.kind) {
    case 'deliver': {
      const target = targetOf(document, step);
      const kind = typeof target?.kind === 'string' ? target.kind : '';
      if (kind === 'linear-change' && target !== null) {
        const state = isObject(target.state) ? target.state.type : null;
        if (state === 'completed' || state === 'canceled') return DELIVER_TITLES['linear-close'] as string;
        const only = Object.keys(target).filter((key) => !['targetId', 'version', 'kind', 'team'].includes(key));
        return (
          only.length === 1 && only[0] === 'comment'
            ? DELIVER_TITLES['linear-comment']
            : DELIVER_TITLES['linear-update']
        ) as string;
      }
      return DELIVER_TITLES[kind] ?? STEP_TITLES.deliver;
    }
    case 'find-session':
      if (isObject(step.in) && step.in.thread === true) return FIND_TITLES.thread;
      return step.only === 'idle' ? FIND_TITLES.idle : STEP_TITLES['find-session'];
    case 'wait': {
      const waitsFor = isObject(step.for) ? Object.keys(step.for)[0] : undefined;
      return waitsFor === 'turnEnd' || waitsFor === 'sessionIdle' || waitsFor === 'time'
        ? WAIT_TITLES[waitsFor]
        : STEP_TITLES.wait;
    }
    default:
      return STEP_TITLES[step.kind];
  }
}

/** A step's handles: one per outcome it can have and `otherwise`, or a split's one for its branches. */
function handlesOf(step: JsonObject, steps: Readonly<Record<string, unknown>>): HandleView[] {
  const reaches = (to: Json | undefined) => typeof to === 'string' && to !== 'end' && Object.hasOwn(steps, to);
  if (step.kind === 'split') {
    const branches = Array.isArray(step.branches) ? step.branches : [];
    return [{ id: BRANCHES, words: outcomeWords(BRANCHES), wired: branches.some(reaches), stops: false }];
  }
  const arrows = arrowsOf(step);
  const covered = reaches(arrows.otherwise);
  const outcomes = isKind(step.kind) ? outcomesOf(step as unknown as FlowStep) : [];
  const handles: HandleView[] = outcomes.map((outcome) => {
    const own = Object.hasOwn(arrows, outcome) ? arrows[outcome] : undefined;
    const wired = reaches(own);
    return { id: outcome, words: outcomeWords(outcome), wired, stops: !wired && (own === 'end' || !covered) };
  });
  handles.push({ id: 'otherwise', words: outcomeWords('otherwise'), wired: covered, stops: false });
  return handles;
}

/** The gate's boxes the document has: its trigger, its condition, its judge when it asks one, and what it keeps. */
export function gateParts(document: JsonObject): GatePart[] {
  return ['trigger', 'condition', ...(isObject(document.agentic) ? (['judge'] as const) : []), 'keep'];
}

/**
 * The canvas: a box per gate part and per step, each where `positions` kept it or where `layout` puts it, a wire per
 * arrow, and the gate's last box wired to the flow's start. `problems` counts what is wrong with each step.
 */
export function toGraph(
  document: JsonObject,
  positions: Positions,
  options: { problems?: ReadonlyMap<string, number>; selected?: string | null } = {},
): { nodes: CanvasNode[]; edges: CanvasEdge[] } {
  const { flow } = flowOfDocument(document);
  const steps = stepsOf(flow);
  const ids = Object.keys(steps);
  const gates = gateParts(document);
  const handles = new Map<string, HandleView[]>();
  for (const id of ids) {
    const raw = steps[id];
    handles.set(id, handlesOf(isObject(raw) ? (raw as JsonObject) : {}, steps));
  }
  // A step's box is its header, a row for its id and label, and a row per outcome.
  const heightOf = (id: string) => (handles.has(id) ? boxHeight(1 + (handles.get(id)?.length ?? 0)) : NODE_HEIGHT);
  const placed = layout(
    flow,
    positions,
    gates.map((part) => GATE[part]),
    heightOf,
  );
  const where = (id: string): Point => placed[id] ?? { x: 0, y: 0 };
  const start = typeof flow.start === 'string' && Object.hasOwn(steps, flow.start) ? flow.start : null;
  const nodes: CanvasNode[] = gates.map((part, index) => ({
    id: GATE[part],
    type: 'gate',
    position: where(GATE[part]),
    width: NODE_WIDTH,
    height: NODE_HEIGHT,
    deletable: false,
    selected: options.selected === GATE[part],
    data: {
      role: 'gate',
      part,
      title: GATE_TITLES[part],
      tone: part === 'trigger' ? 'input' : 'processing',
      wired: index < gates.length - 1 || start !== null,
    },
  }));
  const edges: CanvasEdge[] = [];
  gates.forEach((part, index) => {
    const following = gates[index + 1];
    const to = following === undefined ? start : GATE[following];
    if (to === null) return;
    edges.push({
      id: `${GATE[part]}->${to}`,
      source: GATE[part],
      sourceHandle: OUT,
      target: to,
      targetHandle: IN,
      type: 'signal',
      deletable: false,
      ...(part === 'condition' ? { label: 'matches' } : part === 'judge' ? { label: outcomeWords('yes') } : {}),
    });
  });
  for (const id of ids) {
    const raw = steps[id];
    const step: JsonObject = isObject(raw) ? (raw as JsonObject) : {};
    const kind = isKind(step.kind) ? step.kind : null;
    const emit = Array.isArray(step.emit) ? step.emit.length : 0;
    nodes.push({
      id,
      type: 'step',
      position: where(id),
      width: NODE_WIDTH,
      height: heightOf(id),
      selected: options.selected === id,
      data: {
        role: 'step',
        stepId: id,
        kind,
        title: stepTitle(document, step),
        label: typeof step.label === 'string' ? step.label : null,
        tone: kind !== null && ACTS.has(kind) ? 'output' : 'processing',
        handles: handles.get(id) ?? [],
        emits: emit,
        problems: options.problems?.get(id) ?? 0,
        entry: id === start,
      },
    });
    if (kind === 'split') {
      const branches = Array.isArray(step.branches) ? step.branches : [];
      for (const branch of branches)
        if (typeof branch === 'string' && Object.hasOwn(steps, branch))
          edges.push({
            id: `${id}:${BRANCHES}->${branch}`,
            source: id,
            sourceHandle: BRANCHES,
            target: branch,
            targetHandle: IN,
            type: 'signal',
          });
      continue;
    }
    for (const [outcome, to] of Object.entries(arrowsOf(step)))
      if (typeof to === 'string' && to !== 'end' && Object.hasOwn(steps, to))
        edges.push({
          id: `${id}:${outcome}->${to}`,
          source: id,
          sourceHandle: outcome,
          target: to,
          targetHandle: IN,
          type: 'signal',
          label: outcomeWords(outcome),
          data: outcome === 'otherwise' ? { muted: true } : {},
        });
  }
  return { nodes, edges };
}

/** `positions` with box `id` at `point`, rounded to whole units: the document is not touched. */
export function moveNode(positions: Positions, id: string, point: Point): Positions {
  return { ...positions, [id]: { x: Math.round(point.x), y: Math.round(point.y) } };
}

/** A step id no step has yet: `<kind>-1`, `<kind>-2`… */
export function freshStepId(document: JsonObject, kind: StepKind): StepId {
  const steps = stepsOf(flowOfDocument(document).flow);
  for (let n = 1; ; n += 1) if (!Object.hasOwn(steps, `${kind}-${n}`)) return `${kind}-${n}`;
}

/** A kind's step as a drop makes it: the prototype's defaults, and no arrows. What needs a choice is left to make. */
export function stepDefaults(kind: StepKind): FlowStep {
  const ask = {
    question: '',
    inputs: [],
    threshold: 0.7,
    onUncertain: 'no-match',
    callsPerRollingHour: 60,
    inputTokensPerRolling30Days: 1_000_000,
    concurrency: 1,
    maxInputTokens: 2000,
    maxOutputTokens: 16,
  };
  const steps: Record<StepKind, unknown> = {
    condition: {
      kind,
      when: { path: '/fields/subject', op: 'contains', value: '', caseSensitive: false },
      next: {},
    },
    judge: { kind, ask, next: {} },
    route: { kind, candidates: [], by: ['hints'], inputs: [], next: {} },
    'find-session': { kind, in: { folder: '' }, provider: 'claude', next: {} },
    'start-session': { kind, in: { folder: '' }, provider: 'claude', mode: 'manual', next: {} },
    worktree: { kind, project: '', base: 'default', branch: 'ac/{{run}}', cleanup: 'keep', next: {} },
    deliver: { kind, target: { targetId: '', version: 1 }, next: {} },
    wait: { kind, for: { time: { afterMs: 3_600_000 } }, timeoutMs: 3_600_000, next: {} },
    notify: { kind, text: '', next: {} },
    split: { kind, branches: [] },
    raise: { kind, name: '', next: {} },
  };
  return steps[kind] as FlowStep;
}

/**
 * The document with a step of `kind` added as `id` (a fresh `<kind>-<n>` when none is given): `step` in place of the
 * kind's defaults when the palette knows more, and `target` added to `targets` for a deliver step that needs a new
 * one. It has no arrows; an empty flow starts at it.
 */
export function applyNodeDrop(
  document: JsonObject,
  kind: StepKind,
  id?: StepId,
  options: { step?: JsonObject; target?: JsonObject } = {},
): JsonObject {
  const stepId = id ?? freshStepId(document, kind);
  const { next, flow, steps } = editable(document);
  const empty = Object.keys(steps).length === 0;
  Object.defineProperty(steps, stepId, {
    value: copyOf((options.step ?? stepDefaults(kind)) as unknown as JsonObject),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  if (empty || typeof flow.start !== 'string' || flow.start === '') flow.start = stepId;
  if (options.target !== undefined) next.targets = [...targetsIn(next), copyOf(options.target)];
  return next;
}

/**
 * The document with an arrow from `from`'s `outcome` to `to`, or null when the arrow may not be drawn: an outcome the
 * step does not have, a second arrow from one outcome, a cycle, two branches of one split meeting (`connectionAllowed`,
 * the event service's own check), a split's ninth branch, or the gate wired twice. From the gate's last box, the arrow
 * is the flow's start.
 */
export function applyConnect(document: JsonObject, from: string, outcome: string, to: string): JsonObject | null {
  const { flow } = flowOfDocument(document);
  const steps = stepsOf(flow);
  if (to === from || !Object.hasOwn(steps, to)) return null;
  if (from === GATE.keep || from === GATE.judge || from === GATE.condition) {
    const last = GATE[gateParts(document).at(-1) ?? 'keep'];
    if (from !== last || (typeof flow.start === 'string' && Object.hasOwn(steps, flow.start))) return null;
    const { next, flow: written } = editable(document);
    written.start = to;
    return next;
  }
  const step = steps[from];
  if (!isObject(step)) return null;
  if (step.kind === 'split') {
    const branches = Array.isArray(step.branches) ? step.branches : [];
    if (outcome !== BRANCHES || branches.includes(to) || branches.length >= FLOW_BOUNDS.splitMax) return null;
  } else {
    const outcomes = isKind(step.kind) ? outcomesOf(step as unknown as FlowStep) : [];
    if (outcome !== 'otherwise' && !outcomes.includes(outcome)) return null;
    const own = arrowsOf(step)[outcome];
    if (own !== undefined && own !== 'end') return null;
  }
  if (!connectionAllowed(flow, { stepId: from, outcome }, to)) return null;
  const { next, steps: written } = editable(document);
  const changed = written[from] as JsonObject;
  if (changed.kind === 'split') changed.branches = [...(Array.isArray(changed.branches) ? changed.branches : []), to];
  else changed.next = { ...arrowsOf(changed), [outcome]: to };
  return next;
}

/**
 * The document without the wire from `from`'s `outcome` to `to`: the arrow is gone, so the outcome follows `otherwise`
 * or stops there; a split loses that branch. The gate's wire to the start is not one a person removes.
 */
export function applyDisconnect(document: JsonObject, from: string, outcome: string, to: string): JsonObject {
  if (!Object.hasOwn(stepsOf(flowOfDocument(document).flow), from)) return document;
  const { next, steps } = editable(document);
  const step = steps[from] as JsonObject;
  if (step.kind === 'split') {
    if (Array.isArray(step.branches)) step.branches = step.branches.filter((branch) => branch !== to);
  } else {
    const arrows = arrowsOf(step);
    if (arrows[outcome] === to) delete arrows[outcome];
    step.next = arrows;
  }
  return next;
}

/** Whether `from`'s `outcome` may be wired to `to`: what `isValidConnection` asks. */
export function connectable(document: JsonObject, from: string, outcome: string, to: string): boolean {
  return applyConnect(document, from, outcome, to) !== null;
}

/**
 * The document without step `stepId`: each arrow into it now ends there (`end`), a split's branch to it is gone, and
 * its target leaves `targets` when no other step delivers to it. A flow that started there has no start until the
 * person wires one.
 */
export function applyDelete(document: JsonObject, stepId: StepId): JsonObject {
  if (!Object.hasOwn(stepsOf(flowOfDocument(document).flow), stepId)) return document;
  const { next, flow, steps } = editable(document);
  const removed = steps[stepId] as JsonObject;
  delete steps[stepId];
  for (const step of Object.values(steps)) {
    if (!isObject(step)) continue;
    if (step.kind === 'split') {
      if (Array.isArray(step.branches)) step.branches = step.branches.filter((branch) => branch !== stepId);
      continue;
    }
    const arrows = arrowsOf(step);
    for (const [outcome, to] of Object.entries(arrows)) if (to === stepId) arrows[outcome] = 'end';
  }
  if (flow.start === stepId) flow.start = '';
  const target = isObject(removed.target) ? removed.target : null;
  if (removed.kind === 'deliver' && target !== null) {
    const used = Object.values(steps).some(
      (step) =>
        isObject(step) &&
        step.kind === 'deliver' &&
        isObject(step.target) &&
        step.target.targetId === target.targetId &&
        step.target.version === target.version,
    );
    if (!used)
      next.targets = targetsIn(next).filter(
        (each) => !(each.targetId === target.targetId && each.version === target.version),
      );
  }
  return next;
}

/** The document with event `word` ticked (`on`) or not on step `stepId`: `emit` sorted, and gone when empty (W23). */
export function applyEmit(document: JsonObject, stepId: StepId, word: string, on: boolean): JsonObject {
  if (!Object.hasOwn(stepsOf(flowOfDocument(document).flow), stepId)) return document;
  const { next, steps } = editable(document);
  const step = steps[stepId] as JsonObject;
  const ticked = new Set(Array.isArray(step.emit) ? step.emit.filter((each) => typeof each === 'string') : []);
  if (on) ticked.add(word);
  else ticked.delete(word);
  if (ticked.size === 0) delete step.emit;
  else step.emit = [...ticked].sort();
  return next;
}

/** The document with step `stepId` as `change` makes it: the settings' one way in. */
export function applyStep(document: JsonObject, stepId: StepId, change: (step: JsonObject) => JsonObject): JsonObject {
  if (!Object.hasOwn(stepsOf(flowOfDocument(document).flow), stepId)) return document;
  const { next, steps } = editable(document);
  Object.defineProperty(steps, stepId, {
    value: change(copyOf(steps[stepId] as JsonObject)),
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return next;
}

/** The document with its flow as `change` makes it (limits, events, chain, shadow): written out for a straight line. */
export function applyFlow(document: JsonObject, change: (flow: JsonObject) => JsonObject): JsonObject {
  const { next, flow } = editable(document);
  next.flow = change(flow);
  return next;
}

/** Whether `id` is one a step may take: what a box's id is checked against before it is kept. */
export function isStepId(id: string): boolean {
  return STEP_ID.test(id) && !['run', 'trigger', 'end', 'otherwise'].includes(id);
}
