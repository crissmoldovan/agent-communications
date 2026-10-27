/**
 * The designer's palette (workflows design §11.3, the prototype's WorkflowDesigner palette): every step a person can
 * drag onto the canvas, grouped as the prototype draws them, and what each one becomes when it is dropped. A drop is a
 * pure change of the document (`applyNodeDrop`): a fresh step id, the kind's defaults with what the workflow already
 * says filled in — the project a route step chooses, the Linear issue a change follows, the session a wait is for — and
 * no arrows, so the step stays invalid until it is wired and its settings pass the checks.
 *
 * A step that delivers gets a target of its own, version 1, made as the rule editor makes one (`newTarget`); a session
 * target in a flow is the session the flow chose (`find: { flow: true }`, W5). A webhook is one already set up at the
 * terminal, chosen in the step's settings: its address and key are never made here.
 */
import { freshTargetId, isObject, type Json, type JsonObject, newTarget, targetsIn } from '../rule-editor/model.ts';
import { applyNodeDrop, type BoxTone, flowOfDocument, freshStepId, stepDefaults, targetOf } from './canvas.ts';
import type { StepId, StepKind } from './flow.ts';

/** What a palette item carries on a drag: its id, under the app's own type, so nothing else's drop is read as a step. */
export const PALETTE_MIME = 'application/x-agentcomms-step';

export interface PaletteItem {
  readonly id: string;
  readonly kind: StepKind;
  readonly label: string;
  readonly tone: BoxTone;
}

const item = (id: string, kind: StepKind, label: string, tone: BoxTone = 'processing'): PaletteItem => ({
  id,
  kind,
  label,
  tone,
});

/** The palette's groups, in the prototype's order (`WorkflowDesigner.dc.html` 850; spec §11.3 and W36). */
export const PALETTE_GROUPS: readonly { readonly name: string; readonly items: readonly PaletteItem[] }[] = [
  {
    name: 'Decide',
    items: [
      item('condition', 'condition', 'Condition'),
      item('judge', 'judge', 'Ask a judge'),
      item('route', 'route', 'Which project?'),
      item('split', 'split', 'Side by side'),
    ],
  },
  {
    name: 'Sessions',
    items: [
      item('find-session', 'find-session', 'Find a session'),
      item('find-thread', 'find-session', 'Find this conversation’s session'),
      item('start-session', 'start-session', 'Start a session', 'output'),
      item('worktree', 'worktree', 'Make a worktree', 'output'),
      item('deliver-session', 'deliver', 'Deliver to a session', 'output'),
    ],
  },
  {
    name: 'Linear',
    items: [
      item('linear-create', 'deliver', 'Create', 'output'),
      item('linear-update', 'deliver', 'Update', 'output'),
      item('linear-comment', 'deliver', 'Comment', 'output'),
      item('linear-close', 'deliver', 'Close', 'output'),
    ],
  },
  {
    name: 'Hand over, and tell',
    items: [
      item('queue', 'deliver', 'Put it in the Queue', 'output'),
      item('webhook', 'deliver', 'Send to a webhook', 'output'),
      item('notify', 'notify', 'Notify me'),
      item('raise', 'raise', 'Raise an event', 'output'),
    ],
  },
  {
    name: 'Wait',
    items: [
      item('wait-turn', 'wait', 'For a session’s turn to end'),
      item('wait-free', 'wait', 'For a session to be free'),
      item('wait-time', 'wait', 'For a time'),
    ],
  },
];

/** A palette item, by the id a drag carried; null for anything else. */
export function paletteItem(id: string): PaletteItem | null {
  for (const group of PALETTE_GROUPS) for (const each of group.items) if (each.id === id) return each;
  return null;
}

const DAY = 86_400_000;
const HOUR = 3_600_000;

/** The prototype's waits: a free session 2 hours, a turn's end 1 day, a time 1 hour (plan E1). */
export const WAIT_DEFAULTS = { sessionIdle: 2 * HOUR, turnEnd: DAY, time: HOUR } as const;

/** The pointers of every field the workflow keeps (its `mapping`'s leaves): what its later steps may read. */
export function mappedPointers(document: JsonObject): string[] {
  const found: string[] = [];
  const walk = (node: Json | undefined, path: string[]) => {
    if (!isObject(node)) return;
    if (typeof node.$path === 'string') {
      found.push(`/${path.map((token) => token.replaceAll('~', '~0').replaceAll('/', '~1')).join('/')}`);
      return;
    }
    for (const [key, child] of Object.entries(node)) walk(child, [...path, key]);
  };
  walk(document.mapping, []);
  return found;
}

/** The flow's steps, in no particular order, each with its id. */
function stepsWith(document: JsonObject): [StepId, JsonObject][] {
  const steps = flowOfDocument(document).flow.steps as unknown as Record<string, Json>;
  return Object.entries(steps ?? {}).flatMap(([id, step]) =>
    isObject(step) ? [[id, step] as [StepId, JsonObject]] : [],
  );
}

/** The last step (by id order) the predicate takes, or null. */
function lastWhere(document: JsonObject, take: (step: JsonObject) => boolean): StepId | null {
  const found = stepsWith(document).filter(([, step]) => take(step));
  return found.length === 0 ? null : (found[found.length - 1]?.[0] ?? null);
}

/** A deliver step to a target of `kind`. */
const deliversTo = (document: JsonObject, kind: string) => (step: JsonObject) =>
  step.kind === 'deliver' && targetOf(document, step)?.kind === kind;

/** What the palette knows beside the document: the target ids already taken, and the webhooks set up at the terminal. */
export interface DropContext {
  readonly takenTargetIds: ReadonlySet<string>;
  readonly webhooks: readonly JsonObject[];
}

/** A step and a target for item `id`, before it is added: the defaults with what the workflow already says. */
function made(
  document: JsonObject,
  id: string,
  context: DropContext,
): { kind: StepKind; step: JsonObject; target?: JsonObject } | null {
  const chosen = paletteItem(id);
  if (chosen === null) return null;
  const ruleId = typeof document.ruleId === 'string' ? document.ruleId : 'workflow';
  const taken = new Set([
    ...context.takenTargetIds,
    ...targetsIn(document).flatMap((target) => (typeof target.targetId === 'string' ? [target.targetId] : [])),
  ]);
  const route = lastWhere(document, (step) => step.kind === 'route');
  const worktree = lastWhere(document, (step) => step.kind === 'worktree');
  const issue = lastWhere(document, deliversTo(document, 'linear'));
  const base = stepDefaults(chosen.kind) as unknown as JsonObject;
  const inputs = mappedPointers(document);
  const deliver = (target: JsonObject, extra: JsonObject = {}) => ({
    kind: 'deliver' as const,
    step: {
      kind: 'deliver',
      target: { targetId: target.targetId as string, version: target.version as number },
      ...extra,
      next: {},
    },
    target,
  });
  const linearChange = (change: JsonObject) => {
    const team = issue === null ? null : targetOf(document, stepsWith(document).find(([at]) => at === issue)?.[1]);
    const target: JsonObject = {
      targetId: freshTargetId(ruleId, 'linear-change', taken),
      version: 1,
      kind: 'linear-change',
      team: isObject(team?.team) ? team.team : { id: '', key: '' },
      ...change,
    };
    return deliver(target, issue === null ? {} : { to: { issue } });
  };
  switch (id) {
    case 'judge':
      return { kind: 'judge', step: { ...base, ask: { ...(base.ask as JsonObject), inputs } } };
    case 'route':
      return { kind: 'route', step: { ...base, inputs } };
    case 'find-session':
      return { kind: 'find-session', step: { ...base, in: route === null ? { folder: '' } : { project: route } } };
    case 'find-thread':
      return { kind: 'find-session', step: { ...base, in: { thread: true }, provider: 'claude' } };
    case 'start-session':
      return {
        kind: 'start-session',
        step: {
          ...base,
          in: worktree !== null ? { worktree } : route !== null ? { project: route } : { folder: '' },
        },
      };
    case 'worktree':
      return {
        kind: 'worktree',
        step: {
          ...base,
          project: route ?? '',
          branch: issue === null ? 'ac/{{run}}' : `ac/{{steps.${issue}.identifier}}`,
        },
      };
    case 'deliver-session': {
      const sessions = stepsWith(document)
        .filter(([, step]) => step.kind === 'find-session' || step.kind === 'start-session')
        .map(([at]) => at)
        .slice(0, 8);
      const target: JsonObject = {
        ...newTarget('session', freshTargetId(ruleId, 'session', taken)),
        find: { flow: true },
        ifNone: 'queue-only',
        context: inputs.length === 0 ? [] : [{ fields: inputs }],
      };
      return deliver(target, sessions.length === 0 ? {} : { to: { session: sessions } });
    }
    case 'linear-create':
      return deliver(newTarget('linear', freshTargetId(ruleId, 'linear', taken)));
    case 'linear-update':
      return linearChange({ assignee: 'me' });
    case 'linear-comment':
      return linearChange({ comment: { text: '' } });
    case 'linear-close':
      return linearChange({ state: { id: '', name: 'Done', type: 'completed' } });
    case 'queue':
      return deliver(newTarget('queue', freshTargetId(ruleId, 'queue', taken)));
    case 'webhook': {
      const known = context.webhooks[0];
      return known === undefined
        ? { kind: 'deliver', step: base }
        : {
            kind: 'deliver',
            step: {
              kind: 'deliver',
              target: { targetId: known.targetId as string, version: known.version as number },
              next: {},
            },
            target: known,
          };
    }
    case 'wait-turn': {
      const given = lastWhere(document, deliversTo(document, 'session'));
      return { kind: 'wait', step: { ...base, for: { turnEnd: given ?? '' }, timeoutMs: WAIT_DEFAULTS.turnEnd } };
    }
    case 'wait-free': {
      const found = lastWhere(document, (step) => step.kind === 'find-session');
      return {
        kind: 'wait',
        step: { ...base, for: { sessionIdle: found ?? '' }, timeoutMs: WAIT_DEFAULTS.sessionIdle },
      };
    }
    default:
      return { kind: chosen.kind, step: base };
  }
}

/**
 * The document with palette item `id` dropped on it as a new step, and that step's id; null for an id that is no item.
 * A webhook already among the workflow's targets is not added twice.
 */
export function dropItem(
  document: JsonObject,
  id: string,
  context: DropContext,
): { document: JsonObject; stepId: StepId } | null {
  const step = made(document, id, context);
  if (step === null) return null;
  const stepId = freshStepId(document, step.kind);
  const known =
    step.target !== undefined &&
    targetsIn(document).some(
      (target) => target.targetId === step.target?.targetId && target.version === step.target?.version,
    );
  return {
    document: applyNodeDrop(document, step.kind, stepId, {
      step: step.step,
      ...(step.target === undefined || known ? {} : { target: step.target }),
    }),
    stepId,
  };
}
