/**
 * What the event service answers workflows' calls with (0.36.0, plan 2026-10-27-workflows-0360 I6 and I8), transcribed,
 * and the readers that take a call's `data` to one of them. Each reader refuses a shape it does not know — a missing or
 * mistyped field, a closed word it has not heard of — by throwing `UnknownShapeError`, so a screen shows "could not be
 * read" rather than guessing. A field it does not know is left out of what it gives back. Ids, names, folders, a
 * profile and anything a model wrote are data to show as such: nothing here renders or acts on them.
 */
import type { RulePart } from '../events-rules.ts';
import { DESCRIBE_PROVIDERS, type DescribeProvider, RUN_STATES, type RunState } from '../ipc.ts';
import type { Json } from '../rule-editor/model.ts';
import type { RuleTextError } from '../rule-text.ts';

/** The step kinds a flow has (spec §4.1), in its order. */
export const STEP_KINDS = [
  'condition',
  'judge',
  'route',
  'find-session',
  'start-session',
  'worktree',
  'deliver',
  'wait',
  'notify',
  'split',
  'raise',
] as const;
export type StepKind = (typeof STEP_KINDS)[number];

/** A run's step, as the event service records it (spec §4.3, `workflow_steps.state`). */
export const STEP_STATES = ['ready', 'running', 'waiting', 'done', 'failed', 'skipped', 'cancelled'] as const;
export type StepState = (typeof STEP_STATES)[number];

/** What a run waits on (spec §4.3, `workflow_waits.kind`). */
export const WAIT_KINDS = ['turn-end', 'session-idle', 'time', 'limit'] as const;
export type WaitKind = (typeof WAIT_KINDS)[number];

/** A raised event's state (spec §4.3, `workflow_events.state`). */
export const EVENT_STATES = ['open', 'done', 'expired', 'cancelled'] as const;
export type EventState = (typeof EVENT_STATES)[number];

/** The step event catalogue's schemas, version 1 (spec Appendix W.3). */
export const WORKFLOW_EVENT_SCHEMAS = [
  'run',
  'step.condition',
  'step.judge',
  'step.route',
  'step.find-session',
  'step.start-session',
  'step.worktree',
  'step.deliver.session',
  'step.deliver.linear',
  'step.deliver.linear-change',
  'step.deliver.webhook',
  'step.deliver.sse',
  'step.deliver.queue',
  'step.deliver.dry-run',
  'step.wait',
  'step.notify',
  'step.split',
  'raise',
] as const;
export type WorkflowEventSchema = (typeof WORKFLOW_EVENT_SCHEMAS)[number];

/** A settled step's closed output (I5): JSON by its kind's keys. */
export type Output = Readonly<Record<string, Json>>;

export interface RunWaitingV1 {
  stepId: string;
  kind: WaitKind;
  since: number;
  ahead: number | null;
  needsYouInClaudeStream: boolean;
}

/** One run, as `runs list --json` lists it. */
export interface RunListEntryV1 {
  runId: string;
  ruleId: string;
  ruleVersion: number;
  state: RunState;
  startedAt: number;
  updatedAt: number;
  endCode: string | null;
  eventId: string;
  parentRunId: string | null;
  depth: number;
  shadow: boolean;
  waiting: RunWaitingV1 | null;
}

/** `runs list --json`: newest first, at most 200. */
export interface RunsListResultV1 {
  runs: RunListEntryV1[];
}

export interface RunStepV1 {
  stepId: string;
  kind: StepKind;
  state: StepState;
  outcome: string | null;
  attempts: number;
  startedAt: number | null;
  settledAt: number | null;
  output: Output | null;
  lastErrorCode: string | null;
  deliveryId: string | null;
  wait: { kind: WaitKind; since: number; wakeAt: number } | null;
}

export interface RunEventDeliveryV1 {
  subscriberId: string;
  subscriberVersion: number;
  state: string;
}

export interface RunEventV1 {
  eventId: string;
  type: string;
  raisedAt: number;
  state: EventState;
  deliveries: RunEventDeliveryV1[];
}

/** `runs show <run> --json`: the run, the path it took, each step, and the events it raised. */
export interface RunShowResultV1 extends RunListEntryV1 {
  path: string[];
  notRaised: number;
  steps: RunStepV1[];
  events: RunEventV1[];
}

/** `runs cancel <run> --json`. */
export interface RunCancelResultV1 {
  runId: string;
  state: 'cancelled';
  cancelledDeliveries: number;
  cancelledEvents: number;
  interrupted: boolean;
}

export interface RuleCheckProblemV1 {
  code: string;
  message: string;
  stepId: string | null;
  pointer: string | null;
}

/** `workflow check - --json`. */
export interface RuleCheckResultV1 {
  ok: boolean;
  problems: RuleCheckProblemV1[];
}

export interface FlowTestStepV1 {
  stepId: string;
  kind: StepKind;
  outcome: string;
  would: RulePart[];
  prompt?: string;
  issue?: { title: string; description: string };
  events: { type: string; data: Json }[];
}

/** `workflow test - <example> --json` for a workflow with a flow. */
export interface FlowTestResultV1 {
  ruleId: string;
  version: number;
  path: string[];
  steps: FlowTestStepV1[];
}

export interface ProjectFolderV1 {
  folder: string;
  kind: 'checkout' | 'worktree';
  defaultBranch: string | null;
  worktreeRoot: string | null;
}

export interface ProjectHintsV1 {
  senderDomains: string[];
  slackConversations: string[];
  people: string[];
}

/** One project (spec §8.1), as `project show` and `projects list` give it. */
export interface ProjectV1 {
  projectId: string;
  name: string;
  repo: string;
  profile: string;
  profileBy: 'person' | null;
  profileAt: number | null;
  hints: ProjectHintsV1;
  folders: ProjectFolderV1[];
  createdAt: number;
  updatedAt: number;
}

/** `projects list --json`. */
export interface ProjectsListResultV1 {
  projects: ProjectV1[];
}

export const SCAN_SKIP_REASONS = ['symlink', 'hidden', 'agent-comms', 'unreadable', 'depth'] as const;
export type ScanSkipReason = (typeof SCAN_SKIP_REASONS)[number];

export interface ScanRepoV1 {
  repo: string;
  known: string | null;
  folders: { folder: string; kind: 'checkout' | 'worktree'; defaultBranch: string | null }[];
}

/** `project scan --json`: the checkouts found on this Mac, by repository, and the folders passed over. */
export interface ProjectScanResultV1 {
  roots: string[];
  repos: ScanRepoV1[];
  skipped: { folder: string; reason: ScanSkipReason }[];
}

/** What a subscriber is given (spec §4.2, W30). */
export interface EventSubscriptionV1 {
  namespaces: string[];
  patterns: string[];
  content: 'none' | 'enveloped';
}

/** One subscriber version, as `subscribers list --json` gives it from 0.36.0: today's entry, and what it receives. */
export interface SubscriberEntryV2 {
  subscriberId: string;
  version: number;
  digest: string;
  revokedAt: number | null;
  kind: 'sse' | 'webhook';
  events: EventSubscriptionV1 | null;
  state: 'inert' | 'active' | 'superseded' | null;
  listening: { host: string; port: number } | null;
  listenError: 'PORT_IN_USE' | null;
  /**
   * A webhook subscriber's public address: scheme, host, port and a plain URL's path, never a secret URL's path or a
   * token. Null for a live one; absent from a service before it said so.
   */
  address?: { url: string } | null;
  backlog: number;
  lastDeliveredAt: number | null;
}

/** `workflow-events list --json`: the step event catalogue. */
export interface WorkflowEventsListResultV1 {
  catalogueVersion: 1;
  schemas: { schema: WorkflowEventSchema; standard: string[]; own: string[]; outputs: string[] }[];
}

/** `workflow describe --json`: a draft, where each step came from, the questions back, and its checks. */
export interface WorkflowDescribeResultV1 {
  text: string;
  notes: { step: string; words: string }[];
  unnoted: string[];
  questions: { step: string | null; question: string; choices: string[] }[];
  parse: { ok: boolean; errors: RuleTextError[] };
  check: RuleCheckResultV1 | null;
  model: { provider: DescribeProvider; model: string | null };
}

/** What every reader throws for a shape it does not know. */
export class UnknownShapeError extends Error {
  override name = 'UnknownShapeError';
}

type Fields = Record<string, unknown>;

function refuse(what: string): never {
  throw new UnknownShapeError(`${what} is not a shape the app knows`);
}

function object(value: unknown, what: string): Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Fields) : refuse(what);
}

function text(value: unknown, what: string): string {
  return typeof value === 'string' ? value : refuse(what);
}

function textOrNull(value: unknown, what: string): string | null {
  return value === null ? null : text(value, what);
}

/** A whole number from 0, as every count, time and version here is. */
function whole(value: unknown, what: string): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : refuse(what);
}

function wholeOrNull(value: unknown, what: string): number | null {
  return value === null ? null : whole(value, what);
}

function flag(value: unknown, what: string): boolean {
  return typeof value === 'boolean' ? value : refuse(what);
}

function word<const W extends string>(value: unknown, words: readonly W[], what: string): W {
  return typeof value === 'string' && (words as readonly string[]).includes(value) ? (value as W) : refuse(what);
}

function list<T>(value: unknown, what: string, read: (item: unknown, what: string) => T): T[] {
  return Array.isArray(value) ? value.map((item, index) => read(item, `${what}[${index}]`)) : refuse(what);
}

function texts(value: unknown, what: string): string[] {
  return list(value, what, text);
}

function json(value: unknown, what: string): Json {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : refuse(what);
  if (Array.isArray(value)) return value.map((item, index) => json(item, `${what}[${index}]`));
  const fields = object(value, what);
  return Object.fromEntries(Object.entries(fields).map(([key, item]) => [key, json(item, `${what}.${key}`)]));
}

function output(value: unknown, what: string): Output | null {
  if (value === null) return null;
  const read = json(object(value, what), what);
  return read as Output;
}

function readWaiting(value: unknown, what: string): RunWaitingV1 | null {
  if (value === null) return null;
  const fields = object(value, what);
  return {
    stepId: text(fields.stepId, `${what}.stepId`),
    kind: word(fields.kind, WAIT_KINDS, `${what}.kind`),
    since: whole(fields.since, `${what}.since`),
    ahead: wholeOrNull(fields.ahead, `${what}.ahead`),
    needsYouInClaudeStream: flag(fields.needsYouInClaudeStream, `${what}.needsYouInClaudeStream`),
  };
}

function readRunEntry(value: unknown, what: string): RunListEntryV1 {
  const fields = object(value, what);
  return {
    runId: text(fields.runId, `${what}.runId`),
    ruleId: text(fields.ruleId, `${what}.ruleId`),
    ruleVersion: whole(fields.ruleVersion, `${what}.ruleVersion`),
    state: word(fields.state, RUN_STATES, `${what}.state`),
    startedAt: whole(fields.startedAt, `${what}.startedAt`),
    updatedAt: whole(fields.updatedAt, `${what}.updatedAt`),
    endCode: textOrNull(fields.endCode, `${what}.endCode`),
    eventId: text(fields.eventId, `${what}.eventId`),
    parentRunId: textOrNull(fields.parentRunId, `${what}.parentRunId`),
    depth: whole(fields.depth, `${what}.depth`),
    shadow: flag(fields.shadow, `${what}.shadow`),
    waiting: readWaiting(fields.waiting, `${what}.waiting`),
  };
}

/** `runs list --json`. */
export function readRunsList(data: unknown): RunsListResultV1 {
  const fields = object(data, 'runs list');
  return { runs: list(fields.runs, 'runs list.runs', readRunEntry) };
}

function readStep(value: unknown, what: string): RunStepV1 {
  const fields = object(value, what);
  const wait =
    fields.wait === null
      ? null
      : (() => {
          const at = object(fields.wait, `${what}.wait`);
          return {
            kind: word(at.kind, WAIT_KINDS, `${what}.wait.kind`),
            since: whole(at.since, `${what}.wait.since`),
            wakeAt: whole(at.wakeAt, `${what}.wait.wakeAt`),
          };
        })();
  return {
    stepId: text(fields.stepId, `${what}.stepId`),
    kind: word(fields.kind, STEP_KINDS, `${what}.kind`),
    state: word(fields.state, STEP_STATES, `${what}.state`),
    outcome: textOrNull(fields.outcome, `${what}.outcome`),
    attempts: whole(fields.attempts, `${what}.attempts`),
    startedAt: wholeOrNull(fields.startedAt, `${what}.startedAt`),
    settledAt: wholeOrNull(fields.settledAt, `${what}.settledAt`),
    output: output(fields.output, `${what}.output`),
    lastErrorCode: textOrNull(fields.lastErrorCode, `${what}.lastErrorCode`),
    deliveryId: textOrNull(fields.deliveryId, `${what}.deliveryId`),
    wait,
  };
}

function readEvent(value: unknown, what: string): RunEventV1 {
  const fields = object(value, what);
  return {
    eventId: text(fields.eventId, `${what}.eventId`),
    type: text(fields.type, `${what}.type`),
    raisedAt: whole(fields.raisedAt, `${what}.raisedAt`),
    state: word(fields.state, EVENT_STATES, `${what}.state`),
    deliveries: list(fields.deliveries, `${what}.deliveries`, (item, at) => {
      const delivery = object(item, at);
      return {
        subscriberId: text(delivery.subscriberId, `${at}.subscriberId`),
        subscriberVersion: whole(delivery.subscriberVersion, `${at}.subscriberVersion`),
        state: text(delivery.state, `${at}.state`),
      };
    }),
  };
}

/** `runs show <run> --json`. */
export function readRunShow(data: unknown): RunShowResultV1 {
  const fields = object(data, 'runs show');
  return {
    ...readRunEntry(fields, 'runs show'),
    path: texts(fields.path, 'runs show.path'),
    notRaised: whole(fields.notRaised, 'runs show.notRaised'),
    steps: list(fields.steps, 'runs show.steps', readStep),
    events: list(fields.events, 'runs show.events', readEvent),
  };
}

function readProblem(value: unknown, what: string): RuleCheckProblemV1 {
  const fields = object(value, what);
  return {
    code: text(fields.code, `${what}.code`),
    message: text(fields.message, `${what}.message`),
    stepId: textOrNull(fields.stepId, `${what}.stepId`),
    pointer: textOrNull(fields.pointer, `${what}.pointer`),
  };
}

/** `workflow check - --json`. */
export function readCheck(data: unknown): RuleCheckResultV1 {
  const fields = object(data, 'workflow check');
  return {
    ok: flag(fields.ok, 'workflow check.ok'),
    problems: list(fields.problems, 'workflow check.problems', readProblem),
  };
}

const FOLDER_KINDS = ['checkout', 'worktree'] as const;

/** One project, as `project show --json` gives it and `projects list` lists it. */
export function readProject(data: unknown, what = 'project'): ProjectV1 {
  const fields = object(data, what);
  const hints = object(fields.hints, `${what}.hints`);
  return {
    projectId: text(fields.projectId, `${what}.projectId`),
    name: text(fields.name, `${what}.name`),
    repo: text(fields.repo, `${what}.repo`),
    profile: text(fields.profile, `${what}.profile`),
    profileBy: fields.profileBy === null ? null : word(fields.profileBy, ['person'] as const, `${what}.profileBy`),
    profileAt: wholeOrNull(fields.profileAt, `${what}.profileAt`),
    hints: {
      senderDomains: texts(hints.senderDomains, `${what}.hints.senderDomains`),
      slackConversations: texts(hints.slackConversations, `${what}.hints.slackConversations`),
      people: texts(hints.people, `${what}.hints.people`),
    },
    folders: list(fields.folders, `${what}.folders`, (item, at) => {
      const folder = object(item, at);
      return {
        folder: text(folder.folder, `${at}.folder`),
        kind: word(folder.kind, FOLDER_KINDS, `${at}.kind`),
        defaultBranch: textOrNull(folder.defaultBranch, `${at}.defaultBranch`),
        worktreeRoot: textOrNull(folder.worktreeRoot, `${at}.worktreeRoot`),
      };
    }),
    createdAt: whole(fields.createdAt, `${what}.createdAt`),
    updatedAt: whole(fields.updatedAt, `${what}.updatedAt`),
  };
}

/** `projects list --json`. */
export function readProjects(data: unknown): ProjectsListResultV1 {
  const fields = object(data, 'projects list');
  return { projects: list(fields.projects, 'projects list.projects', (item, at) => readProject(item, at)) };
}

/** `project scan --json`. */
export function readScan(data: unknown): ProjectScanResultV1 {
  const fields = object(data, 'project scan');
  return {
    roots: texts(fields.roots, 'project scan.roots'),
    repos: list(fields.repos, 'project scan.repos', (item, at) => {
      const repo = object(item, at);
      return {
        repo: text(repo.repo, `${at}.repo`),
        known: textOrNull(repo.known, `${at}.known`),
        folders: list(repo.folders, `${at}.folders`, (each, where) => {
          const folder = object(each, where);
          return {
            folder: text(folder.folder, `${where}.folder`),
            kind: word(folder.kind, FOLDER_KINDS, `${where}.kind`),
            defaultBranch: textOrNull(folder.defaultBranch, `${where}.defaultBranch`),
          };
        }),
      };
    }),
    skipped: list(fields.skipped, 'project scan.skipped', (item, at) => {
      const skipped = object(item, at);
      return {
        folder: text(skipped.folder, `${at}.folder`),
        reason: word(skipped.reason, SCAN_SKIP_REASONS, `${at}.reason`),
      };
    }),
  };
}

function readSubscription(value: unknown, what: string): EventSubscriptionV1 | null {
  if (value === null) return null;
  const fields = object(value, what);
  return {
    namespaces: texts(fields.namespaces, `${what}.namespaces`),
    patterns: texts(fields.patterns, `${what}.patterns`),
    content: word(fields.content, ['none', 'enveloped'] as const, `${what}.content`),
  };
}

function readSubscriber(value: unknown, what: string): SubscriberEntryV2 {
  const fields = object(value, what);
  const listening =
    fields.listening === null
      ? null
      : (() => {
          const at = object(fields.listening, `${what}.listening`);
          return { host: text(at.host, `${what}.listening.host`), port: whole(at.port, `${what}.listening.port`) };
        })();
  return {
    subscriberId: text(fields.subscriberId, `${what}.subscriberId`),
    version: whole(fields.version, `${what}.version`),
    digest: text(fields.digest, `${what}.digest`),
    revokedAt: wholeOrNull(fields.revokedAt, `${what}.revokedAt`),
    kind: word(fields.kind, ['sse', 'webhook'] as const, `${what}.kind`),
    events: readSubscription(fields.events, `${what}.events`),
    state:
      fields.state === null ? null : word(fields.state, ['inert', 'active', 'superseded'] as const, `${what}.state`),
    listening,
    listenError:
      fields.listenError === null ? null : word(fields.listenError, ['PORT_IN_USE'] as const, `${what}.listenError`),
    ...(fields.address === undefined
      ? {}
      : {
          address:
            fields.address === null
              ? null
              : { url: text(object(fields.address, `${what}.address`).url, `${what}.address.url`) },
        }),
    backlog: whole(fields.backlog, `${what}.backlog`),
    lastDeliveredAt: wholeOrNull(fields.lastDeliveredAt, `${what}.lastDeliveredAt`),
  };
}

/** `subscribers list --json`: one entry for each subscriber version. */
export function readSubscribers(data: unknown): SubscriberEntryV2[] {
  return list(data, 'subscribers list', readSubscriber);
}

/** `workflow describe --json`. Everything in it a model wrote is outside text, for the screen to show as such. */
export function readDescribe(data: unknown): WorkflowDescribeResultV1 {
  const fields = object(data, 'workflow describe');
  const parse = object(fields.parse, 'workflow describe.parse');
  const model = object(fields.model, 'workflow describe.model');
  return {
    text: text(fields.text, 'workflow describe.text'),
    notes: list(fields.notes, 'workflow describe.notes', (item, at) => {
      const note = object(item, at);
      return { step: text(note.step, `${at}.step`), words: text(note.words, `${at}.words`) };
    }),
    unnoted: texts(fields.unnoted, 'workflow describe.unnoted'),
    questions: list(fields.questions, 'workflow describe.questions', (item, at) => {
      const question = object(item, at);
      return {
        step: textOrNull(question.step, `${at}.step`),
        question: text(question.question, `${at}.question`),
        choices: texts(question.choices, `${at}.choices`),
      };
    }),
    parse: {
      ok: flag(parse.ok, 'workflow describe.parse.ok'),
      errors: list(parse.errors, 'workflow describe.parse.errors', (item, at) => {
        const error = object(item, at);
        return {
          line: whole(error.line, `${at}.line`),
          column: whole(error.column, `${at}.column`),
          message: text(error.message, `${at}.message`),
        };
      }),
    },
    check: fields.check === null ? null : readCheck(fields.check),
    model: {
      provider: word(model.provider, DESCRIBE_PROVIDERS, 'workflow describe.model.provider'),
      model: textOrNull(model.model, 'workflow describe.model.model'),
    },
  };
}
