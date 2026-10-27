/**
 * One run of a workflow, against the version it ran (workflows design §11.2, §7.1, the approved prototype's
 * WorkflowRun), pure: each step's mark — taken, waiting now, not taken, not reached yet, failed — its line in closed
 * words and its time, why a step was not taken, the path in a line, which session a wait is for, and the version's
 * canvas with the taken path lit. It reads the version's own document, never the newest draft: a workflow edited while
 * one of its runs is mid-flight keeps that run's graph (Review Focus).
 *
 * The run view is the person's own: a worktree's folder is said there, with the home as `~`. A run's records carry no
 * sender text; a project's name and a step's label are the person's words, and every other word is the app's own or a
 * closed word the event service wrote.
 */
import { shownFolder } from '../lanes.ts';
import { isObject, type Json, type JsonObject } from '../rule-editor/model.ts';
import {
  BRANCHES,
  type CanvasEdge,
  type CanvasNode,
  flowOfDocument,
  type Positions,
  stepTitle,
  targetOf,
  toGraph,
} from './canvas.ts';
import { outcomeWords } from './copy.ts';
import { stepOrder } from './flow.ts';
import { isLive, routeBecause, sessionWords, waitingWords } from './runs.ts';
import type { Output, RunShowResultV1, RunStepV1 } from './types.ts';

/** Where a step stands in the run: what its box and its line say. */
export type RunMark = 'taken' | 'now' | 'failed' | 'not-taken' | 'not-yet';

export interface RunStepView {
  stepId: string;
  title: string;
  /** The author's label, their words. */
  label: string | null;
  mark: RunMark;
  /** What happened there, in a few words; null for a step not reached. */
  line: string | null;
  /** When it settled, or started; null when it has not. */
  at: number | null;
  attempts: number;
}

export interface RunContext {
  /** A moment as the screen writes it. */
  time: (at: number) => string;
  /** The person's home folder, to show a folder with it as `~`. */
  home: string | null;
}

type Steps = Readonly<Record<string, JsonObject>>;

function stepsOf(document: JsonObject): Steps {
  const { flow } = flowOfDocument(document);
  const steps = (flow as unknown as { steps?: unknown }).steps;
  return isObject(steps) ? (steps as Steps) : {};
}

const text = (value: Json | undefined): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** A run's record of each step, by its id. */
function recordsOf(run: RunShowResultV1): Map<string, RunStepV1> {
  return new Map(run.steps.map((step) => [step.stepId, step]));
}

function markOf(record: RunStepV1 | undefined, live: boolean): RunMark {
  if (record === undefined) return live ? 'not-yet' : 'not-taken';
  switch (record.state) {
    case 'done':
      return 'taken';
    case 'running':
    case 'waiting':
      return 'now';
    case 'failed':
      return 'failed';
    case 'skipped':
    case 'cancelled':
      return 'not-taken';
    case 'ready':
      return live ? 'not-yet' : 'not-taken';
  }
}

/** The output of the first step of `kind` the run settled, or of `stepId` when given. */
function outputOf(run: RunShowResultV1, stepId: string | null): Output | null {
  if (stepId === null) return null;
  return run.steps.find((step) => step.stepId === stepId)?.output ?? null;
}

/** The project a run chose: its route step's name for it, the person's own words. */
function projectOf(run: RunShowResultV1, steps: Steps, routeId: string | null = null): string | null {
  const route =
    routeId !== null && steps[routeId]?.kind === 'route'
      ? outputOf(run, routeId)
      : (run.steps.find((step) => step.kind === 'route' && step.state === 'done')?.output ?? null);
  return route === null ? null : (text(route.projectName) ?? text(route.project));
}

/** The route step a find or start step looks in, when its place is a project. */
function routeOfPlace(step: JsonObject | undefined): string | null {
  return isObject(step?.in) ? text(step.in.project) : null;
}

/**
 * The session a step found, started or was given, as the run names it: its project and provider. A wait names the
 * step it waits on (`for: { sessionIdle: <find> }`, `for: { turnEnd: <deliver> }`); a delivery names the steps whose
 * session it takes (`to.session`).
 */
export function sessionOf(
  document: JsonObject,
  run: RunShowResultV1,
  stepId: string,
): { project: string | null; provider: Json | null } {
  const steps = stepsOf(document);
  const seen = new Set<string>();
  const find = (id: string): { project: string | null; provider: Json | null } | null => {
    if (seen.has(id)) return null;
    seen.add(id);
    const step = steps[id];
    if (step === undefined) return null;
    if (step.kind === 'find-session' || step.kind === 'start-session') {
      const output = outputOf(run, id);
      const provider = output?.provider ?? step.provider ?? null;
      return { project: projectOf(run, steps, routeOfPlace(step)), provider };
    }
    if (step.kind === 'wait' && isObject(step.for)) {
      const on = text(step.for.sessionIdle) ?? text(step.for.turnEnd);
      return on === null ? null : find(on);
    }
    if (step.kind === 'deliver' && isObject(step.to) && Array.isArray(step.to.session)) {
      const tried = step.to.session.flatMap((each) => (typeof each === 'string' ? [each] : []));
      const settled = tried.find((each) => typeof outputOf(run, each)?.session === 'string') ?? tried[0];
      return settled === undefined ? null : find(settled);
    }
    return null;
  };
  return find(stepId) ?? { project: projectOf(run, steps), provider: null };
}

/** A step's line once it settled, by its kind and the closed words of its output. */
function settledLine(
  document: JsonObject,
  run: RunShowResultV1,
  step: JsonObject,
  record: RunStepV1,
  context: RunContext,
): string {
  const outcome = record.outcome ?? '';
  const output = record.output ?? {};
  const said = outcomeWords(outcome);
  switch (record.kind) {
    case 'condition':
      return said;
    case 'judge': {
      const score = output.score;
      return typeof score === 'number' && Number.isFinite(score) ? `${said}, ${score.toFixed(2)}` : said;
    }
    case 'route': {
      if (outcome !== 'chosen') return outcome === 'none' ? 'No project fitted' : 'Not sure which project';
      const project = text(output.projectName) ?? text(output.project) ?? 'A project';
      const because = routeBecause(output.reason, project, output.score);
      return because === null ? project : `${project}, because ${because.long}`;
    }
    case 'find-session': {
      if (outcome === 'none') return 'No session found';
      const who = sessionWords(projectOf(run, stepsOf(document), routeOfPlace(step)), output.provider);
      return outcome === 'watched' ? `Found ${who}, open in claude-stream` : `Found ${who}, ${said}`;
    }
    case 'start-session': {
      if (outcome === 'refused')
        return text(output.refusal) === null ? 'Refused' : `Refused: ${text(output.refusal) as string}`;
      return `Started ${sessionWords(projectOf(run, stepsOf(document), routeOfPlace(step)), output.provider)}`;
    }
    case 'worktree': {
      if (outcome === 'refused')
        return text(output.refusal) === null ? 'Refused' : `Refused: ${text(output.refusal) as string}`;
      const branch = text(output.branch);
      const path = text(output.path);
      const where = path === null ? '' : ` in ${shownFolder(path, context.home)}`;
      return branch === null ? `Made a worktree${where}` : `Made ${branch}${where}`;
    }
    case 'deliver': {
      if (outcome === 'failed') return 'Could not deliver';
      if (outcome === 'left-in-queue') return 'Left in the Queue';
      const target = targetOf(document, step);
      const kind = typeof target?.kind === 'string' ? target.kind : '';
      const issue = isObject(output.issue) ? text(output.issue.identifier) : null;
      if (kind === 'linear') return issue === null ? 'Made a Linear issue' : `Made ${issue}`;
      if (kind === 'linear-change') {
        const state = isObject(target?.state) ? target.state.type : null;
        const verb = state === 'completed' || state === 'canceled' ? 'Closed' : 'Updated';
        return issue === null ? `${verb} the Linear issue` : `${verb} ${issue}`;
      }
      if (kind === 'session') {
        const session = sessionOf(document, run, record.stepId);
        return `Given to ${sessionWords(session.project, session.provider)}`;
      }
      if (kind === 'webhook')
        return typeof output.status === 'number' ? `Sent to the webhook: ${output.status}` : 'Sent to the webhook';
      if (kind === 'queue') return 'Put in the Queue';
      if (kind === 'sse') return 'Streamed to its subscriber';
      if (kind === 'dry-run') return 'Written in the dry-run log';
      return 'Delivered';
    }
    case 'wait': {
      const waitsFor = isObject(step.for) ? Object.keys(step.for)[0] : undefined;
      if (outcome === 'timed-out') return 'Timed out';
      if (waitsFor === 'turnEnd') return `The turn ended: ${said}`;
      if (waitsFor === 'sessionIdle') return outcome === 'free' ? 'The session was free' : said;
      return outcome === 'elapsed' ? 'The time came' : said;
    }
    case 'notify':
      return 'Told you';
    case 'raise': {
      const name = text(output.name) ?? text(step.name);
      return name === null ? 'Raised its event' : `Raised ${name}`;
    }
    case 'split':
      return 'Went on side by side';
  }
}

/** A step's line: what it did, what it waits for now, or why it failed. */
function lineOf(
  document: JsonObject,
  run: RunShowResultV1,
  step: JsonObject,
  record: RunStepV1 | undefined,
  context: RunContext,
): string | null {
  if (record === undefined) return null;
  switch (record.state) {
    case 'done':
      return settledLine(document, run, step, record, context);
    case 'waiting': {
      const waiting =
        run.waiting?.stepId === record.stepId
          ? run.waiting
          : record.wait === null
            ? null
            : { kind: record.wait.kind, ahead: null };
      if (waiting === null) return 'Waiting';
      return waitingWords(waiting, sessionOf(document, run, record.stepId), {
        wakeAt: record.wait?.wakeAt ?? null,
        time: context.time,
      });
    }
    case 'running':
      return record.attempts > 1 ? `Trying again: try ${record.attempts}` : 'Running';
    case 'failed':
      return record.lastErrorCode === null ? 'Failed' : `Failed: ${record.lastErrorCode}`;
    case 'cancelled':
      return 'Cancelled with the run';
    case 'skipped':
    case 'ready':
      return null;
  }
}

/** Each step of the version, in the printer's order, with where it stands in the run. */
export function runSteps(document: JsonObject, run: RunShowResultV1, context: RunContext): RunStepView[] {
  const { flow } = flowOfDocument(document);
  const steps = stepsOf(document);
  const records = recordsOf(run);
  const live = isLive(run.state);
  const order = [...stepOrder(flow)];
  for (const id of Object.keys(steps)) if (!order.includes(id)) order.push(id);
  return order.map((stepId) => {
    const step = steps[stepId] ?? {};
    const record = records.get(stepId);
    return {
      stepId,
      title: stepTitle(document, step),
      label: text(step.label),
      mark: markOf(record, live),
      line: lineOf(document, run, step, record, context),
      at: record?.settledAt ?? record?.startedAt ?? null,
      attempts: record?.attempts ?? 0,
    };
  });
}

/** The outcome a step's arrow `outcome` stands for, given the outcome it came out with. */
function follows(step: JsonObject, came: string | null, outcome: string): boolean {
  if (came === null) return false;
  const next = isObject(step.next) ? step.next : {};
  if (outcome === 'otherwise') return !Object.hasOwn(next, came) || came === 'otherwise';
  return outcome === came;
}

/** Each step that leads to `stepId`: by an arrow of one of its outcomes, or as a branch of a split. */
function predecessors(steps: Steps, stepId: string): string[] {
  return Object.entries(steps).flatMap(([id, step]) => {
    if (step.kind === 'split') return Array.isArray(step.branches) && step.branches.includes(stepId) ? [id] : [];
    const next = isObject(step.next) ? step.next : {};
    return Object.values(next).includes(stepId) ? [id] : [];
  });
}

/**
 * Why each step the run did not take was passed over, in closed words: the nearest step on its path before it, and
 * the outcome that led elsewhere ("Find a session came out busy"); or that the run ended first.
 */
export function notTaken(document: JsonObject, run: RunShowResultV1): { stepId: string; title: string; why: string }[] {
  const steps = stepsOf(document);
  const records = recordsOf(run);
  const live = isLive(run.state);
  const views = Object.keys(steps).filter((id) => markOf(records.get(id), live) === 'not-taken');
  const order = [...stepOrder(flowOfDocument(document).flow)];
  views.sort((a, b) => order.indexOf(a) - order.indexOf(b));
  return views.map((stepId) => {
    const title = stepTitle(document, steps[stepId]);
    if (records.get(stepId)?.state === 'cancelled') return { stepId, title, why: 'The run was cancelled first.' };
    const seen = new Set<string>([stepId]);
    let frontier = [stepId];
    while (frontier.length > 0) {
      const next: string[] = [];
      for (const id of frontier)
        for (const before of predecessors(steps, id)) {
          if (seen.has(before)) continue;
          seen.add(before);
          const record = records.get(before);
          if (record?.state === 'done' && record.outcome !== null) {
            const what = stepTitle(document, steps[before]);
            return { stepId, title, why: `${what} came out ${outcomeWords(record.outcome)}.` };
          }
          next.push(before);
        }
      frontier = next;
    }
    const ended =
      run.state === 'cancelled'
        ? 'The run was cancelled first.'
        : run.state === 'expired'
          ? 'The run ran out of time first.'
          : run.state === 'failed'
            ? 'The run failed first.'
            : 'Nothing on the way led to it.';
    return { stepId, title, why: ended };
  });
}

/** The path the run took, in a line: each step on it and what it came out with. */
export function pathLine(document: JsonObject, run: RunShowResultV1): string {
  const steps = stepsOf(document);
  const records = recordsOf(run);
  return run.path
    .map((id) => {
      const record = records.get(id);
      const title = stepTitle(document, steps[id]);
      if (record === undefined) return title;
      if (record.state === 'waiting' || record.state === 'running') return `${title}: now`;
      if (record.state === 'failed') return `${title}: failed`;
      return record.outcome === null ? title : `${title}: ${outcomeWords(record.outcome)}`;
    })
    .join(' → ');
}

/** What a box on the run's canvas carries beside the designer's: its mark and its line. */
export interface RunBox {
  mark: RunMark;
  line: string | null;
}

/**
 * The version's canvas with the run on it: each step's box marked, the wires the run went along lit (the one into the
 * step it is at now live), and the rest muted. The gate's boxes are all taken, since a run starts only past them.
 */
export function runGraph(
  document: JsonObject,
  run: RunShowResultV1,
  positions: Positions,
  context: RunContext,
): { nodes: CanvasNode[]; edges: CanvasEdge[]; marks: ReadonlyMap<string, RunBox> } {
  const graph = toGraph(document, positions);
  const steps = stepsOf(document);
  const records = recordsOf(run);
  const views = new Map(runSteps(document, run, context).map((view) => [view.stepId, view]));
  const marks = new Map<string, RunBox>();
  for (const node of graph.nodes) {
    if (node.type === 'gate') marks.set(node.id, { mark: 'taken', line: null });
    else {
      const view = views.get(node.id);
      marks.set(node.id, { mark: view?.mark ?? 'not-yet', line: view?.line ?? null });
    }
  }
  const reached = (id: string) => {
    const mark = marks.get(id)?.mark;
    return mark === 'taken' || mark === 'now' || mark === 'failed';
  };
  const edges = graph.edges.map((edge): CanvasEdge => {
    const into = marks.get(edge.target)?.mark;
    let lit = false;
    if (edge.source.startsWith('gate:')) lit = reached(edge.target) || edge.target.startsWith('gate:');
    else {
      const step = steps[edge.source];
      const record = records.get(edge.source);
      if (step !== undefined && record?.state === 'done' && reached(edge.target))
        lit = edge.sourceHandle === BRANCHES || follows(step, record.outcome, edge.sourceHandle ?? '');
    }
    const data = lit
      ? into === 'now'
        ? { live: true, tone: 'accent' as const }
        : { tone: 'ok' as const }
      : { muted: true };
    return { ...edge, data, selectable: false, deletable: false };
  });
  const nodes = graph.nodes.map((node) => ({ ...node, selectable: false, deletable: false, draggable: false }));
  return { nodes, edges, marks };
}
