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

/** Each step's settings, and the workflow's (spec §11.3, the prototype's settings panel). */
export const SETTINGS_COPY = {
  events: 'Events',
  runEvents: 'The run’s own events',
  eventsOff: 'Each is off until you tick it. What you tick is part of what you approve.',
  nameEvents: 'Name its events',
  nameEventsBody:
    'Events are named namespace.workflow.step.event, and this workflow’s id cannot be part of one. Give it a name to tick its events.',
  segment: 'Lowercase letters, digits, _ and -, starting with a letter: at most 32.',
  raisedAs: 'Raised as',
  namespace: 'Namespace',
  namespaceWrong: 'Lowercase letters, digits, _ and -, starting with a letter; never agentcomms or com.',
  workflowName: 'The workflow, in its events’ names',
  rename: 'Use these names',
  label: 'Label',
  labelHint: 'Your words on its box: one line, at most 60 characters.',
  labelWrong: 'One line, at most 60 characters.',
  comesFrom: 'Comes from',
  goesOnTo: 'Goes on to',
  nothingYet: 'Nothing yet: connect its input.',
  stops: 'stops',
  acts: 'Acts outside Agent Comms: listed when you approve',
  stays: 'Stays in Agent Comms',
  toFix: 'To fix',
  asText: 'Edited as text',
  asTextBody: 'This part has no control here. It stays as it is; change it in Text.',
  workflowSettings: 'Workflow settings',
  workflowSettingsBody:
    'For the whole workflow: its limits, where its events are named, what starts it, and a dry run.',
  straightLine:
    'A straight line: a step or a branch makes its next version a workflow with steps, approved like any other.',
  limits: 'Limits',
  limitWords: {
    runsPerHour: 'Runs an hour',
    concurrentRuns: 'Runs at a time',
    sessionsPerHour: 'Sessions it starts, an hour',
    worktreesPerDay: 'Worktrees it makes, a day',
    linearWritesPerHour: 'Linear changes, an hour',
    eventsPerHour: 'Events it raises, an hour',
    runMs: 'A run lasts at most, in hours',
  },
  chain: 'Started by another workflow',
  chainBody:
    'Patterns of events another workflow raises, one per line, such as acme.client-asks.issue.created. Its own messages still pass its own trigger and judge.',
  chainPatterns: 'Patterns',
  within: 'Waits for one at most',
  shadow: 'Shadow',
  shadowBody: 'Every effect is written as a dry run instead, and nothing reaches anyone.',
  condition: {
    field: 'Field',
    test: 'Test',
    value: 'Value',
  },
  judge: {
    judge: 'Judge',
    question: 'Question',
    yesAt: 'Yes when at least',
    unsure: 'If it’s unsure',
    unsureWords: { 'no-match': 'Take it as no', hold: 'Hold it for me' },
    looksAt: 'It looks at',
    none: 'Choose a judge',
    noJudges: 'Set up a judge in Events → Judges first.',
  },
  route: {
    projects: 'Projects',
    noProjects: 'No project yet: add one in Projects.',
    by: 'Decided by',
    byWords: { hints: 'Your hints', 'hints judge': 'Your hints, then a judge', judge: 'A judge' },
  },
  place: {
    where: 'Where',
    words: {
      project: 'In a project',
      worktree: 'In a worktree',
      folder: 'In a folder',
      lane: 'In a lane',
      thread: 'This conversation',
    },
    route: 'Which project step',
    worktree: 'Which worktree step',
    folder: 'Folder',
    lane: 'Lane',
    threadBody:
      'The session that took an earlier message in this conversation. Only Claude Code records which session took a message.',
    with: 'With',
    providers: { claude: 'Claude Code', codex: 'Codex' },
    onlyIdle: 'Only an idle one',
    mode: 'Mode',
    modes: { manual: 'Asks first', acceptEdits: 'May edit files', plan: 'Only plans' },
    acceptEditsOnly: 'May edit files only in a worktree this run made.',
  },
  worktree: {
    project: 'Of the project chosen by',
    branch: 'Branch',
    from: 'From',
    fromDefault: 'Its default branch',
    cleanup: 'Afterwards',
    cleanupWords: { keep: 'Keep it', 'remove-if-clean': 'Remove it if nothing in it is uncommitted' },
  },
  deliver: {
    target: 'Its target',
    noTarget: 'Choose what it delivers to.',
    webhook: 'Webhook',
    noWebhooks: 'No webhook is set up yet: a webhook’s address and key are set at your terminal.',
    sessions: 'To the session found or started by',
    report: 'It asks the session to say',
    reportWords: { done: 'done', 'needs-the-person': 'needs you', 'not-mine': 'not mine', blocked: 'blocked' },
    issue: 'The issue made by',
    comment: 'Comment',
    state: 'Moves it to',
  },
  wait: {
    for: 'Waits for',
    forWords: { turnEnd: 'A turn to end', sessionIdle: 'A session to be free', time: 'A time' },
    turnOf: 'The turn given by',
    sessionOf: 'The session found by',
    after: 'For',
    atMost: 'At most',
  },
  notify: { text: 'It says' },
  raise: {
    name: 'Event',
    nameWrong: 'Lowercase letters, digits, _ and -, starting with a letter; not a standard word.',
    fields: 'What the sender wrote, for subscribers allowed it',
  },
  split: { branches: 'Side by side, it starts' },
  remove: 'Remove this step',
} as const;
