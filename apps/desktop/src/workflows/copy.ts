/**
 * The designer's words (workflows design §11.3, the approved prototype's WorkflowDesigner, in sentence case): what
 * each step is called, what each of its outcomes is called on a wire, and the names of the gate's boxes. Plain words
 * only; what a workflow's author wrote — a label, a template, a step id — is shown as their text, never from here.
 */
import type { StepKind } from './flow.ts';

/** Each kind of step, as a box and the palette call it. A deliver step is named by its target's kind (below). */
export const STEP_TITLES: Readonly<Record<StepKind, string>> = {
  condition: 'Condition',
  judge: 'Ask a judge',
  route: 'Which project?',
  'find-session': 'Find a session',
  'start-session': 'Start a session',
  worktree: 'Make a worktree',
  deliver: 'Deliver',
  wait: 'Wait',
  notify: 'Notify me',
  split: 'Side by side',
  raise: 'Raise an event',
};

/** A deliver step, by what its target is. */
export const DELIVER_TITLES: Readonly<Record<string, string>> = {
  session: 'Deliver to a session',
  linear: 'Create a Linear issue',
  'linear-update': 'Update the Linear issue',
  'linear-comment': 'Comment on the Linear issue',
  'linear-close': 'Close the Linear issue',
  queue: 'Put it in the Queue',
  webhook: 'Send to a webhook',
  sse: 'Stream it to subscribers',
  'dry-run': 'Write it in the dry-run log',
};

/** A find in this conversation (W36), and a find that takes only an idle session. */
export const FIND_TITLES = {
  thread: 'Find this conversation’s session',
  idle: 'Find an idle session',
} as const;

/** A wait, by what it waits for. */
export const WAIT_TITLES = {
  turnEnd: 'Wait for the turn to end',
  sessionIdle: 'Wait for the session to be free',
  time: 'Wait for a time',
} as const;

/** The gate's boxes: what starts the workflow, which messages go on, its judge, and what it keeps (W3). */
export const GATE_TITLES = {
  trigger: 'When',
  condition: 'Which messages',
  judge: 'Ask a judge',
  keep: 'Keep',
} as const;

/** An outcome, as a wire's label says it. A word not here is shown as it is. */
export const OUTCOME_WORDS: Readonly<Record<string, string>> = {
  yes: 'yes',
  no: 'no',
  unsure: 'unsure',
  chosen: 'a project',
  none: 'none',
  idle: 'idle',
  busy: 'busy',
  watched: 'watched',
  started: 'started',
  refused: 'refused',
  made: 'made',
  done: 'done',
  'left-in-queue': 'left in the Queue',
  failed: 'failed',
  completed: 'completed',
  stopped: 'stopped',
  'needs-the-person': 'needs you',
  'not-mine': 'not mine',
  blocked: 'blocked',
  free: 'free',
  elapsed: 'elapsed',
  'timed-out': 'timed out',
  sent: 'sent',
  raised: 'raised',
  otherwise: 'otherwise',
  branches: 'side by side',
};

/** An outcome's words. */
export function outcomeWords(outcome: string): string {
  return OUTCOME_WORDS[outcome] ?? outcome;
}

/** The words on the canvas itself. */
export const CANVAS_COPY = {
  stops: 'Stops',
  emits: (count: number) => (count === 1 ? 'Raises 1 event' : `Raises ${count} events`),
  problems: (count: number) => (count === 1 ? '1 thing to fix' : `${count} things to fix`),
  canvas: 'The workflow’s steps',
  remove: 'Remove this step',
} as const;
