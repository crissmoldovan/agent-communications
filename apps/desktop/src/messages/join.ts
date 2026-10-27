/**
 * The Messages screen's join (spec 2026-10-26-owner-feedback-0320 §3.6, "the app joins them"), pure: the event
 * service's events and core's activity lines, read for the same window, joined on the id both name a message by — a
 * Gmail message id, or Slack's `<channelId>/<ts>` — and each message's status, the furthest step it reached.
 *
 * What links a reply to what it answers:
 * - **Gmail:** a reply draft's line (`gmail.draft.reply`, or a send prepared as a reply) names the message in
 *   `replyTo`, and its draft by `draftId` (or as its item); the send's line (`gmail.send.execute`) names the same draft.
 * - **Slack:** a post's line names the message it went under in `thread`: `<channelId>/<ts>`, as `activity items`
 *   normalises it, or the parent's ts alone, in the conversation of `channelId` or of its item.
 *
 * `activity items` lists a line under every item it names — the reply draft under the message it answers too, a send
 * under its draft, a post under its thread — so each line counts once, however many items it is listed under.
 * - **A Slack acknowledgement** is listed under the message it acknowledged, and — when it replied — under the reply
 *   too, a later ts in the same conversation, so the earliest is the message. Its `act` says whether it replied or
 *   reacted; an older line without one replied when it is listed under two messages.
 *
 * A message only an agent read, with no event, is included: an item an ok read names that is none of an agent's own
 * drafts, sends, posts or acknowledgement replies.
 *
 * **Takes (0.35.0, design 2026-10-26-taking-messages §9):** core's `takes list` names each record by
 * `<channel>:<accountId>:<id>`, the ids the event service and `activity items` already use, so a message finds its take
 * without a mapping. Each line of a take's history is a step of its own, and the record says who has it now. A message
 * only a take names — no event saw it, and no activity line read it — is included too. With taking required for its
 * account (`taking`), a message a rule delivered to a lane, a session or the Queue that nobody took within the
 * account's window counts as not taken, as the event service's sweep counts it (§8).
 *
 * **Workflow runs (0.36.0, workflows design §11.2):** each run about the message — read from `runs list`, joined by
 * event id — is steps of its own, by what each step settled with: Which project? choosing one is `routed`, with its
 * closed reason; a Linear issue made is `issue-made`; a session found idle or busy, or started, `session-found` and
 * `session-started`; a worktree made, `worktree-made`; the message given to a session, `given`; the session's turn
 * ending, `turn-ended`; a closing Linear change, `issue-closed`; each event raised, `event-raised`; and the run's end,
 * `run-ended`. A run only listed, not shown, says its end alone. Every one is a closed word or the person's own (a
 * project's name): never what the message says.
 */
import type {
  ActivityItems,
  HandBackReason,
  HistoryLine,
  ItemLine,
  MessageEvent,
  MessageRun,
  Millis,
  QueueItemView,
  SenderView,
  TakeLineKind,
  TakeLineView,
  TakeView,
  TakeWindowView,
  TakingSettingView,
  WindowRef,
} from './read.ts';
import { isShownRun, slackParts } from './read.ts';

/** What happened to a message, one step at a time. */
export type TouchKind =
  | 'woken'
  | 'read'
  | 'drafted'
  | 'prepared'
  | 'sent'
  | 'acknowledged'
  | 'done'
  | 'dismissed'
  | 'reopened'
  // A take's steps (0.35.0): offered to a window, taken, handed back, marked done by its holder, lapsed (its lease ran
  // out, or its window ended), and the person's Take back, Give to… and I'll handle it.
  | 'offered'
  | 'taken'
  | 'handed-back'
  | 'take-done'
  | 'expired'
  | 'ended'
  | 'released'
  | 'given'
  | 'kept'
  // A workflow run's steps (0.36.0): the project chosen, the issue made, the session found, started or given the
  // message (`given`, as a person's Give to… is), the worktree made, the turn ended, the issue closed, each event
  // raised, and the run's end.
  | 'routed'
  | 'issue-made'
  | 'session-found'
  | 'session-started'
  | 'worktree-made'
  | 'turn-ended'
  | 'issue-closed'
  | 'event-raised'
  | 'run-ended';

/** What a workflow run's step says beyond when (0.36.0): each a closed word, an id, or the person's own words. */
export interface RunStep {
  runId: string;
  ruleId: string;
  ruleVersion: number;
  /** The step's id, or null for the run's own end. */
  stepId: string | null;
  /** The word the step settled with (`chosen`, `busy`, `done`…), or the run's state for its end. */
  outcome: string | null;
  /** Which project? only: the project's name, the person's words, and why it was chosen, in the service's closed word. */
  project?: string | null;
  reason?: string | null;
  score?: number | null;
  /** A Linear issue's identifier, as Linear names it (`ACME-123`). */
  issue?: string | null;
  /** A session's provider: `claude` or `codex`. */
  provider?: string | null;
  /** A worktree's branch, and its folder: the person's own view, never an event's. */
  branch?: string | null;
  folder?: string | null;
  /** A raised event's name: `<namespace>.<workflow>.<step>.<event>`, closed segments. */
  eventType?: string | null;
  /** The run's end code, for its end. */
  endCode?: string | null;
  /** The delivery a deliver step made, by its id. */
  deliveryId?: string | null;
  /**
   * Told by a listed run's summary (B6), not by its steps: the card says it, without a time of its own; the story reads
   * the run in full.
   */
  fromSummary?: boolean;
}

/** What a take's step says beyond who and when (0.35.0). */
export interface TakeStep {
  /** The window it is about as the take names it: its folder and client too, the person's view (T7). */
  window: TakeWindowView | null;
  /** Why a session handed it back, in core's closed words. */
  reason: HandBackReason | null;
  /** The note a session left, enveloped: the person's alone, shown only through `UntrustedText`. */
  note: string | null;
  /** A person's act: from this app, or from a terminal (in a folder, when it was read). */
  from: 'app' | { terminal: string | null } | null;
  /** For a take: whether a 👀 went under the message with it. */
  eyes: boolean;
}

/** One step after a message arrived: who took it, and when. */
export interface Touch {
  kind: TouchKind;
  at: Millis;
  /** The person, an agent window, or — for a take that lapsed, or an offer a rule made — the service. */
  actor: 'person' | 'window' | 'service';
  /** The agent window, when an activity line names it, or a queue line's key is one an activity line names. */
  window: WindowRef | null;
  /** The window's activity session key, for a window's step. */
  windowKey: string | null;
  /**
   * Where the step was recorded: core's activity log, the queue's history, the message's take (0.35.0), or a workflow's
   * run about it (0.36.0).
   */
  via: 'activity' | 'queue' | 'take' | 'run';
  /** The activity operation, for an activity step. */
  operation: string | null;
  /** The draft a reply step concerns. */
  draftId: string | null;
  /** For a send: Gmail's send, or a Slack post in the thread. */
  channel: string | null;
  /** For an acknowledgement: whether it replied, rather than reacted. */
  replied: boolean;
  /** For a take's step: what its line says (0.35.0). */
  take?: TakeStep | undefined;
  /** For a workflow run's step: what it settled with (0.36.0). */
  run?: RunStep | undefined;
}

/** The furthest step a message reached (§3.6's order). */
export type Status =
  | { kind: 'replied'; at: Millis; via: 'gmail' | 'slack-thread' | 'slack-ack' }
  | { kind: 'acknowledged'; at: Millis }
  | { kind: 'done' | 'dismissed'; at: Millis | null; actor: 'person' | 'window' | null }
  // Taken (0.35.0): who has it — the person, or an agent window, as the take names it — and since when.
  | { kind: 'taken'; at: Millis | null; by: 'person' | 'window'; window: TakeWindowView | null }
  // Handed back, and nobody has it now: the last reason, and how many sessions handed it back.
  | { kind: 'handed-back'; at: Millis; reason: HandBackReason | null; sessions: number }
  | { kind: 'read'; at: Millis }
  | { kind: 'waiting' }
  // Taking is required for its account, and nobody took it within the account's window.
  | { kind: 'not-taken'; since: Millis }
  | { kind: 'not-seen' };

export type StatusKind = Status['kind'];

/**
 * The order the status is decided in: the first a message reached wins. Done and Dismissed share their place; a
 * take's done counts as Done by an agent.
 */
export const STATUS_ORDER: readonly StatusKind[] = [
  'replied',
  'acknowledged',
  'done',
  'dismissed',
  'taken',
  'handed-back',
  'read',
  'waiting',
  'not-taken',
  'not-seen',
];

/** Since when a message has waited with nobody taking it, past its account's window (0.35.0). */
export interface NotTaken {
  /** When it started waiting: it arrived, or it was open again (handed back, taken back, lapsed). */
  since: Millis;
  /** When it counted as not taken: its window after `since`, or at once for a hand-back that needs the person. */
  due: Millis;
  /** Why: it waited past the window, or a session handed it back saying it needs the person. */
  why: 'waited' | 'needs-the-person';
}

/** One message on the screen: its event when the event service saw it, and every step after. */
export interface JoinedMessage {
  /** `event:<eventId>`, or `item:<id>` for a message only an agent read. */
  key: string;
  event: MessageEvent | null;
  /** The id the activity log names it by, or null (WhatsApp, Resend). */
  sourceId: string | null;
  channel: string;
  accountId: string | null;
  accountAlias: string | null;
  /** When it came in; for a message only an agent read, when an agent first read it. */
  at: Millis;
  /** Its sender and subject, as something kept them: the sender's text, enveloped. */
  sender: SenderView | null;
  /** Every step after it arrived, oldest first. */
  touches: Touch[];
  status: Status;
  /** Whether any agent window read it or acted on it (being woken is neither). */
  agentSeen: boolean;
  /** The id a take names it by: Gmail's message id, Slack's `<channelId>/<ts>`, Resend's email id; or null. */
  takeId: string | null;
  /** Its take record, when core has one (0.35.0): who has it, and every take, hand-back and lapse. */
  take: TakeView | null;
  /** Taking required for its account and nobody took it within the window: since when; otherwise null. */
  notTaken: NotTaken | null;
}

// ── Which lines are which ──────────────────────────────────────────────────────────────────────────────────────

/** The operations that read a message, by their capability ids (`capabilities.json`). */
const READS: ReadonlySet<string> = new Set([
  'gmail.message.read',
  'gmail.thread.read',
  'gmail.thread.timeline',
  'gmail.search',
  'gmail.followups',
  'gmail.export',
  'gmail.attachments.find',
  'gmail.attachments.download',
  'slack.read',
  'slack.thread',
  'slack.search',
]);

/** The operations that make an agent's own message, draft or send: what they name never came in. */
const OWN = /^(?:gmail\.(?:draft\.|send\.)|slack\.(?:post|draft\.|edit|delete|ack$))/;

const SLACK_POSTS: ReadonlySet<string> = new Set(['slack.post', 'slack.post.send']);

const ok = (line: ItemLine) => line.outcome === 'ok';

/** One line, however many items it is listed under: its window, its time, what it did and what it links. */
function identity(line: ItemLine): string {
  return [line.session.key, line.at, line.operation, line.draftId, line.replyTo?.messageId, line.thread].join('|');
}

/** The message a Slack post went under, as `<channelId>/<ts>`; null for a new message or one it cannot name. */
function threadOf(line: ItemLine): string | null {
  if (line.thread === null) return null;
  if (line.thread.includes('/')) return line.thread;
  const channelId = line.channelId ?? slackParts(line.itemId)?.channelId ?? null;
  return channelId === null ? null : `${channelId}/${line.thread}`;
}

/** Whether the line is listed under `itemId` because it links to it — the message a reply answers, a post's thread. */
function linksTo(line: ItemLine, itemId: string): boolean {
  return line.replyTo?.messageId === itemId || threadOf(line) === itemId;
}

function isRead(line: ItemLine): boolean {
  if (!ok(line)) return false;
  return line.kind === null ? READS.has(line.operation) : line.kind === 'read';
}

/** A Slack ts as a number, to tell which of two came later. */
function tsValue(id: string): number {
  return Number(slackParts(id)?.ts ?? Number.NaN);
}

// ── The index ──────────────────────────────────────────────────────────────────────────────────────────────────

/** What the join looks lines up by, worked out once for all the messages. */
interface ActivityIndex {
  byItem: ActivityItems;
  /** Each window an activity line names, by its key. */
  windows: Map<string, WindowRef>;
  /** Each Gmail message's reply lines (a draft or a prepare naming it in `replyTo`), by the message's id. */
  replyLines: Map<string, ItemLine[]>;
  /** Each ok Gmail send, by the draft it sent. */
  sendsByDraft: Map<string, ItemLine[]>;
  /** Each ok Slack post in a thread, by `<channelId>/<parent ts>`. */
  threadPosts: Map<string, ItemLine[]>;
  /** The message each acknowledgement acknowledged, by the acknowledgement's line (`ackKey`). */
  ackTargets: Map<string, string>;
  /** The acknowledged messages whose acknowledgement replied. */
  ackReplied: Set<string>;
  /** Items an agent made: never a message that came in. */
  own: Set<string>;
}

/** The draft a reply line made or prepared: its own `draftId`, or the draft it was listed under. */
function draftOf(line: ItemLine): string {
  return line.draftId ?? line.itemId;
}

/** An acknowledgement, however many items it is listed under: its window, its time. */
function ackKey(line: ItemLine): string {
  return `${line.session.key}|${line.at}|${line.operation}`;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

/** Adds a line under `key` once: a line listed under two items is still one line. */
function pushOnce(map: Map<string, ItemLine[]>, key: string, line: ItemLine): void {
  const list = map.get(key) ?? [];
  if (!list.some((each) => identity(each) === identity(line))) map.set(key, [...list, line]);
}

function indexActivity(byItem: ActivityItems): ActivityIndex {
  const windows = new Map<string, WindowRef>();
  const replyLines = new Map<string, ItemLine[]>();
  const sendsByDraft = new Map<string, ItemLine[]>();
  const threadPosts = new Map<string, ItemLine[]>();
  const ackTargets = new Map<string, string>();
  const ackReplied = new Set<string>();
  const own = new Set<string>();
  // One acknowledgement is one line, listed under each item it names: the message, and the reply when it made one.
  const acks = new Map<string, ItemLine[]>();
  for (const [itemId, lines] of byItem) {
    for (const line of lines) {
      if (
        !windows.has(line.session.key) ||
        (line.session.folder !== null && windows.get(line.session.key)?.folder === null)
      ) {
        windows.set(line.session.key, line.session);
      }
      // An agent's own message, draft or send — not one it is listed under because it links to it.
      if (OWN.test(line.operation) && line.operation !== 'slack.ack' && !linksTo(line, itemId)) own.add(itemId);
      if (line.replyTo !== null && line.channel === 'gmail') pushOnce(replyLines, line.replyTo.messageId, line);
      if (line.operation === 'gmail.send.execute' && ok(line)) pushOnce(sendsByDraft, draftOf(line), line);
      const thread = SLACK_POSTS.has(line.operation) && ok(line) ? threadOf(line) : null;
      if (thread !== null) pushOnce(threadPosts, thread, line);
      if (line.operation === 'slack.ack') push(acks, ackKey(line), line);
    }
  }
  /*
   * Each acknowledgement: which message it acknowledged, and whether it replied. Where the line is listed says which —
   * the message, and its reply when it made one, a later ts in the same conversation, so the earliest is the message.
   * What it did is the line's `act` when it says (0.32.0); an older line, which does not, replied when it is listed
   * under two messages of one conversation, and reacted when under one.
   */
  for (const [key, lines] of acks) {
    const ids = [...new Set(lines.map((line) => line.itemId))].sort((a, b) => tsValue(a) - tsValue(b));
    const first = ids[0];
    if (first === undefined) continue;
    const together = ids.every(
      (id) => slackParts(id) !== null && slackParts(id)?.channelId === slackParts(first)?.channelId,
    );
    const act = lines.find((line) => line.act !== null)?.act ?? null;
    const replied = act === null ? together && ids.length > 1 : act === 'reply';
    ackTargets.set(key, first);
    if (replied) ackReplied.add(first);
    if (together) for (const id of ids.slice(1)) own.add(id);
  }
  return { byItem, windows, replyLines, sendsByDraft, threadPosts, ackTargets, ackReplied, own };
}

// ── One message's steps ────────────────────────────────────────────────────────────────────────────────────────

function activityTouch(kind: TouchKind, line: ItemLine, more: Partial<Touch> = {}): Touch {
  return {
    kind,
    at: line.at,
    actor: 'window',
    window: line.session,
    windowKey: line.session.key,
    via: 'activity',
    operation: line.operation,
    draftId: null,
    channel: line.channel,
    replied: false,
    ...more,
  };
}

function queueTouch(line: HistoryLine, index: ActivityIndex): Touch {
  return {
    kind: line.kind,
    at: line.at,
    actor: line.actor,
    window: line.windowKey === null ? null : (index.windows.get(line.windowKey) ?? null),
    windowKey: line.windowKey,
    via: 'queue',
    operation: null,
    draftId: null,
    channel: null,
    replied: false,
  };
}

// ── A message's take (0.35.0) ──────────────────────────────────────────────────────────────────────────────────

/** Each line of a take's history as the step it is: a take's `done` is `take-done`, beside a queue item's `done`. */
const TAKE_TOUCHES: Readonly<Record<Exclude<TakeLineKind, 'acknowledged'>, TouchKind>> = {
  offered: 'offered',
  taken: 'taken',
  'handed-back': 'handed-back',
  done: 'take-done',
  expired: 'expired',
  ended: 'ended',
  released: 'released',
  given: 'given',
  kept: 'kept',
};

/** The app's own process, as a CLI call's ancestors name it: a person's act from the app, not from a terminal. */
const APP_PROCESS = /^(?:agentcomms-desktop|Agent Comms(?: Test)?)$/i;

/** Where a person's act came from: this app, when its process is among the call's ancestors; else a terminal. */
function fromOf(line: TakeLineView): TakeStep['from'] {
  if (line.by !== 'person') return null;
  if (line.terminal === null) return { terminal: null };
  const app = line.terminal.ancestors.some((name) => APP_PROCESS.test(name.split(/[\\/]/).pop()?.trim() ?? ''));
  return app ? 'app' : { terminal: line.terminal.folder };
}

/** Each line of a take's history as a step, oldest first; a 👀 the take made is said on the take it went with. */
function takeTouches(record: TakeView | null, index: ActivityIndex | null): Touch[] {
  if (record === null) return [];
  const touches: Touch[] = [];
  for (const line of record.history) {
    if (line.kind === 'acknowledged') {
      const taken = [...touches].reverse().find((touch) => touch.kind === 'taken');
      if (taken?.take !== undefined && line.ack === 'sent') taken.take = { ...taken.take, eyes: true };
      continue;
    }
    const key = line.window?.key ?? null;
    const known = key === null ? undefined : index?.windows.get(key);
    touches.push({
      kind: TAKE_TOUCHES[line.kind],
      at: line.at,
      actor: line.by,
      window:
        key === null
          ? null
          : {
              key,
              folder: line.window?.folder ?? known?.folder ?? null,
              client: line.window?.client ?? known?.client ?? null,
            },
      windowKey: key,
      via: 'take',
      operation: null,
      draftId: null,
      channel: null,
      replied: false,
      take: { window: line.window, reason: line.reason, note: line.note, from: fromOf(line), eyes: false },
    });
  }
  return touches;
}

// ── A message's workflow runs (0.36.0) ────────────────────────────────────────────────────────────────────────

const RUN_ENDS: ReadonlySet<string> = new Set(['done', 'failed', 'cancelled', 'expired']);

type Fields = Readonly<Record<string, unknown>>;

const fieldText = (output: Fields | null, key: string): string | null => {
  const value = output?.[key];
  return typeof value === 'string' && value !== '' ? value : null;
};

/** An issue's identifier from a step's output: `{ issue: { identifier } }`. */
function issueOf(output: Fields | null): string | null {
  const issue = output?.issue;
  return typeof issue === 'object' && issue !== null ? fieldText(issue as Fields, 'identifier') : null;
}

/** Whether a Linear change's output closed its issue: its state a completed or a cancelled one. */
function closesIssue(output: Fields | null): boolean {
  const state = output?.state;
  const type = typeof state === 'object' && state !== null ? (state as Fields).type : state;
  return type === 'completed' || type === 'canceled' || type === 'cancelled';
}

/**
 * Each step of a workflow run about the message, as touches of its own (§11.2), oldest first. A run that is only
 * listed says its end alone; a shown one says each step it settled and each event it raised.
 */
export function runTouches(run: MessageRun): Touch[] {
  const base = { runId: run.runId, ruleId: run.ruleId, ruleVersion: run.ruleVersion };
  const touch = (kind: TouchKind, at: Millis, step: Omit<RunStep, 'runId' | 'ruleId' | 'ruleVersion'>): Touch => ({
    kind,
    at,
    actor: 'service',
    window: null,
    windowKey: null,
    via: 'run',
    operation: null,
    draftId: null,
    channel: null,
    replied: false,
    run: { ...base, ...step },
  });
  const touches: Touch[] = [];
  if (isShownRun(run)) {
    const worktree = run.steps.find(
      (step) => step.kind === 'worktree' && step.state === 'done' && step.outcome === 'made',
    );
    for (const step of run.steps) {
      if (step.state !== 'done' || step.outcome === null) continue;
      const at = step.settledAt ?? step.startedAt ?? run.startedAt;
      const output = step.output as Fields | null;
      const said = { stepId: step.stepId, outcome: step.outcome, deliveryId: step.deliveryId };
      switch (step.kind) {
        case 'route':
          if (step.outcome === 'chosen')
            touches.push(
              touch('routed', at, {
                ...said,
                project: fieldText(output, 'projectName') ?? fieldText(output, 'project'),
                reason: fieldText(output, 'reason'),
                score: typeof output?.score === 'number' && Number.isFinite(output.score) ? output.score : null,
              }),
            );
          break;
        case 'find-session':
          if (step.outcome === 'idle' || step.outcome === 'busy')
            touches.push(touch('session-found', at, { ...said, provider: fieldText(output, 'provider') }));
          break;
        case 'start-session':
          if (step.outcome === 'started')
            touches.push(
              touch('session-started', at, {
                ...said,
                provider: fieldText(output, 'provider'),
                folder: fieldText(worktree?.output as Fields | null, 'path'),
              }),
            );
          break;
        case 'worktree':
          if (step.outcome === 'made')
            touches.push(
              touch('worktree-made', at, {
                ...said,
                branch: fieldText(output, 'branch'),
                folder: fieldText(output, 'path'),
              }),
            );
          break;
        case 'deliver': {
          if (step.outcome !== 'done') break;
          const issue = issueOf(output);
          if (output !== null && ('changed' in output || 'state' in output)) {
            if (closesIssue(output)) touches.push(touch('issue-closed', at, { ...said, issue }));
          } else if (issue !== null) touches.push(touch('issue-made', at, { ...said, issue }));
          else if (output !== null && 'session' in output)
            touches.push(touch('given', at, { ...said, provider: fieldText(output, 'provider') }));
          break;
        }
        case 'wait':
          if (fieldText(output, 'for') === 'turn-end') touches.push(touch('turn-ended', at, said));
          break;
        default:
          break;
      }
    }
    for (const event of run.events)
      touches.push(touch('event-raised', event.raisedAt, { stepId: null, outcome: null, eventType: event.type }));
  } else if (run.summary !== undefined) {
    // A listed run says its story in a few closed words (B6's summary): the project, the issue, the session, the turn.
    const said = { stepId: null, fromSummary: true } as const;
    const { project, issue, session, turn } = run.summary;
    if (project !== null) touches.push(touch('routed', run.startedAt, { ...said, outcome: 'chosen', project }));
    if (issue !== null) touches.push(touch('issue-made', run.startedAt, { ...said, outcome: 'done', issue }));
    if (session !== null)
      touches.push(
        touch(session === 'started' ? 'session-started' : 'session-found', run.startedAt, { ...said, outcome: null }),
      );
    if (turn !== null) touches.push(touch('turn-ended', run.startedAt, { ...said, outcome: turn }));
  }
  if (RUN_ENDS.has(run.state))
    touches.push(touch('run-ended', run.updatedAt, { stepId: null, outcome: run.state, endCode: run.endCode }));
  return touches.sort((a, b) => a.at - b.at);
}

/** The lines after which nobody has the message: a hand-back, the person's Take back, a lease or an offer run out. */
const REOPENING: ReadonlySet<TakeLineKind> = new Set(['handed-back', 'released', 'expired', 'ended']);

/** The newest line that left the message open. */
function lastReopening(record: TakeView): TakeLineView | undefined {
  return [...record.history].reverse().find((line) => REOPENING.has(line.kind));
}

/** Whether the message is open again because a session handed it back: what the Handed back filter shows. */
export function isHandedBack(record: TakeView | null): boolean {
  return record !== null && record.state === 'open' && lastReopening(record)?.kind === 'handed-back';
}

/** Who handed a message back, each once: by its activity key, or its Claude Code session id. */
function handBacks(record: TakeView): { lines: TakeLineView[]; sessions: number } {
  const lines = record.history.filter((line) => line.kind === 'handed-back');
  const sessions = new Set(lines.map((line, index) => line.window?.key ?? line.window?.sessionId ?? `#${index}`));
  return { lines, sessions: sessions.size };
}

/** The types of event a session takes: a message that came in (§8). */
const INBOUND: ReadonlySet<string> = new Set([
  'gmail.message.received',
  'slack.message.posted',
  'resend.email.received',
]);

/** The targets a rule hands a message to for a session or the person: a queue (a lane is one) or a session. */
const FOR_SOMEONE: ReadonlySet<string> = new Set(['queue', 'session']);

/** The delivery states that never reached their target. */
const NEVER_DELIVERED: ReadonlySet<string> = new Set([
  'dead-lettered',
  'retention-expired',
  'cancelled',
  'content-unreadable',
  'in-flight-at-disable',
  'in-flight-at-account-removal',
]);

const MINUTE_MS = 60_000;

/**
 * Whether nobody took a message in time (§8, as the event service's sweep counts it): taking is required for its
 * account; it came in, and a rule matched it and delivered it to a lane, a session or the Queue; nobody has taken it,
 * marked it done or holds a live offer of it; and the account's window has passed since it arrived or was last open
 * again — at once for a hand-back that says it needs the person.
 */
export function notTakenOf(
  event: MessageEvent | null,
  record: TakeView | null,
  setting: TakingSettingView | undefined,
  now: Millis,
): NotTaken | null {
  if (event === null || setting === undefined || !setting.required || !INBOUND.has(event.type)) return null;
  const matched = event.decisions.some((decision) => decision.outcome === 'matched');
  const delivered = event.deliveries.some(
    (delivery) => FOR_SOMEONE.has(delivery.targetKind) && !NEVER_DELIVERED.has(delivery.state),
  );
  if (!matched || !delivered) return null;
  if (record !== null && (record.state === 'taken' || record.state === 'done')) return null;
  const offeredUntil = record?.state === 'offered' ? (record.offer?.until ?? null) : null;
  if (record?.state === 'offered' && (offeredUntil === null || offeredUntil > now)) return null;
  const arrived = event.occurredAt ?? event.observedAt;
  if (arrived === null) return null;
  let since = arrived;
  let why: NotTaken['why'] = 'waited';
  const reopened = record === null ? undefined : lastReopening(record);
  if (reopened !== undefined && reopened.at >= since) {
    since = reopened.at;
    if (reopened.kind === 'handed-back' && reopened.reason === 'needs-the-person') why = 'needs-the-person';
  }
  if (offeredUntil !== null && offeredUntil > since) {
    since = offeredUntil;
    why = 'waited';
  }
  const due = why === 'needs-the-person' ? since : since + setting.unclaimed.afterMinutes * MINUTE_MS;
  return now >= due ? { since, due, why } : null;
}

/** What a message's status reads of its take: the record, and whether nobody took it in time. */
export interface TakeFacts {
  record: TakeView | null;
  notTaken: NotTaken | null;
}

const NO_TAKE: TakeFacts = { record: null, notTaken: null };

/** Every step the activity log and the queue's history recorded for the message `id` names. */
function touchesOf(id: string | null, queueItem: QueueItemView | null, index: ActivityIndex): Touch[] {
  const touches: Touch[] = (queueItem?.history ?? []).map((line) => queueTouch(line, index));
  if (id !== null) {
    for (const line of index.byItem.get(id) ?? []) {
      if (isRead(line)) touches.push(activityTouch('read', line));
      // An acknowledgement, of this message: not the one it is listed under because its reply is this one.
      else if (line.operation === 'slack.ack' && ok(line) && index.ackTargets.get(ackKey(line)) === id) {
        touches.push(activityTouch('acknowledged', line, { replied: index.ackReplied.has(id) }));
      }
    }
    // Gmail: the reply drafts that answer it, and each send of one.
    const drafts = new Set<string>();
    for (const line of index.replyLines.get(id) ?? []) {
      if (!ok(line)) continue;
      const draftId = draftOf(line);
      drafts.add(draftId);
      touches.push(activityTouch(line.operation === 'gmail.send.prepare' ? 'prepared' : 'drafted', line, { draftId }));
    }
    for (const draftId of drafts) {
      for (const line of index.sendsByDraft.get(draftId) ?? []) touches.push(activityTouch('sent', line, { draftId }));
    }
    // Slack: each post in its thread.
    for (const line of index.threadPosts.get(id) ?? []) touches.push(activityTouch('sent', line));
  }
  return touches.sort((a, b) => a.at - b.at);
}

/**
 * The furthest step reached (§3.6): Replied (a send of a reply, a post in the thread, or an acknowledgement that
 * replied), Acknowledged (by reaction), Done or Dismissed with who — a take's done is Done by an agent — Taken (by an
 * agent, or by you), Handed back, Read by an agent (or a reply drafted to it), Waiting for you (an open item no agent has
 * read), Nobody took it, or Not seen.
 */
export function statusOf(
  touches: readonly Touch[],
  queueItem: QueueItemView | null,
  take: TakeFacts = NO_TAKE,
): Status {
  const sent = touches.find((touch) => touch.kind === 'sent');
  const ackReply = touches.find((touch) => touch.kind === 'acknowledged' && touch.replied);
  const replies = [sent, ackReply].filter((touch): touch is Touch => touch !== undefined).sort((a, b) => a.at - b.at);
  const reply = replies[0];
  if (reply !== undefined) {
    const via = reply.kind === 'acknowledged' ? 'slack-ack' : reply.channel === 'slack' ? 'slack-thread' : 'gmail';
    return { kind: 'replied', at: reply.at, via };
  }
  const ack = touches.find((touch) => touch.kind === 'acknowledged');
  if (ack !== undefined) return { kind: 'acknowledged', at: ack.at };
  if (queueItem !== null && queueItem.state !== 'open') {
    const state = queueItem.state;
    const marked = [...queueItem.history].reverse().find((line) => line.kind === state);
    return { kind: state, at: queueItem.stateAt ?? marked?.at ?? null, actor: marked?.actor ?? null };
  }
  const { record } = take;
  if (record?.state === 'done') {
    const done = [...record.history].reverse().find((line) => line.kind === 'done');
    return { kind: 'done', at: done?.at ?? record.updatedAt, actor: 'window' };
  }
  if (record?.state === 'taken' && record.holder !== null) {
    return record.holder === 'person'
      ? { kind: 'taken', at: record.takenAt, by: 'person', window: null }
      : { kind: 'taken', at: record.takenAt, by: 'window', window: record.holder };
  }
  if (record !== null && isHandedBack(record)) {
    const { lines, sessions } = handBacks(record);
    const last = lines[lines.length - 1] as TakeLineView;
    return { kind: 'handed-back', at: last.at, reason: last.reason, sessions };
  }
  // Drafting a reply to it, or asking to send one, is as far as reading it: the agent had it in hand.
  const read = touches.find((touch) => touch.kind === 'read' || touch.kind === 'drafted' || touch.kind === 'prepared');
  if (read !== undefined) return { kind: 'read', at: read.at };
  if (queueItem !== null && queueItem.state === 'open') return { kind: 'waiting' };
  if (take.notTaken !== null) return { kind: 'not-taken', since: take.notTaken.since };
  return { kind: 'not-seen' };
}

/** Whether an agent window read the message or acted on it: being woken for it is neither. */
function seenByAgent(touches: readonly Touch[]): boolean {
  return touches.some((touch) => touch.actor === 'window' && touch.kind !== 'woken');
}

/** The sender and subject the message's own lines kept, when no event kept them. */
function senderFromLines(lines: readonly ItemLine[]): SenderView | null {
  const subject = lines.find((line) => line.subject !== null)?.subject ?? null;
  const from = lines.find((line) => line.from !== null)?.from ?? null;
  if (subject === null && from === null) return null;
  return { name: from?.name ?? null, address: from?.address ?? null, subject };
}

/** The id a take names an event's message by: Gmail's message id, Slack's `<channelId>/<ts>`, Resend's email id. */
export function takeIdOf(event: MessageEvent): string | null {
  if (event.channel === 'resend') return event.source.emailId ?? null;
  return event.sourceId;
}

/** A message's take record, by its key `<channel>:<accountId>:<id>`; null when there is none, or nothing to find it by. */
function recordOf(
  takes: TakeContext | undefined,
  channel: string,
  accountId: string | null,
  id: string | null,
): TakeView | null {
  if (takes === undefined || accountId === null || accountId === '' || id === null) return null;
  return takes.records.get(`${channel}:${accountId}:${id}`) ?? null;
}

const byTime = (a: Touch, b: Touch) => a.at - b.at;

function eventMessage(
  event: MessageEvent,
  index: ActivityIndex,
  aliases: ReadonlyMap<string, string>,
  takes: TakeContext | undefined,
  runs: readonly MessageRun[] = [],
): JoinedMessage {
  const lines = event.sourceId === null ? [] : (index.byItem.get(event.sourceId) ?? []);
  const takeId = takeIdOf(event);
  const record = recordOf(takes, event.channel, event.accountId, takeId);
  const touches = [
    ...touchesOf(event.sourceId, event.queueItem, index),
    ...takeTouches(record, index),
    ...runs.flatMap(runTouches),
  ].sort(byTime);
  const lineAlias = lines.find((line) => line.account?.id === event.accountId && line.account.alias !== null)?.account
    ?.alias;
  const accountAlias = event.accountAlias ?? aliases.get(event.accountId) ?? lineAlias ?? record?.account ?? null;
  const notTaken =
    takes === undefined || accountAlias === null
      ? null
      : notTakenOf(event, record, takes.settings.get(accountAlias), takes.now);
  return {
    key: `event:${event.eventId}`,
    event,
    sourceId: event.sourceId,
    channel: event.channel,
    accountId: event.accountId === '' ? null : event.accountId,
    accountAlias,
    at: event.occurredAt ?? event.observedAt ?? 0,
    sender: event.kept ?? senderFromLines(lines),
    touches,
    status: statusOf(touches, event.queueItem, { record, notTaken }),
    agentSeen: seenByAgent(touches),
    takeId,
    take: record,
    notTaken,
  };
}

function agentOnlyMessage(
  id: string,
  lines: readonly ItemLine[],
  index: ActivityIndex,
  aliases: ReadonlyMap<string, string>,
  takes: TakeContext | undefined,
): JoinedMessage | null {
  const reads = lines.filter(isRead);
  const first = reads[0];
  if (first === undefined || index.own.has(id)) return null;
  const channel = first.channel;
  if (channel !== 'gmail' && channel !== 'slack') return null;
  const account = lines.find((line) => line.account !== null)?.account ?? null;
  const record = recordOf(takes, channel, account?.id ?? null, id);
  const touches = [...touchesOf(id, null, index), ...takeTouches(record, index)].sort(byTime);
  return {
    key: `item:${id}`,
    event: null,
    sourceId: id,
    channel,
    accountId: account?.id ?? null,
    accountAlias: account === null ? null : (account.alias ?? aliases.get(account.id) ?? record?.account ?? null),
    at: first.at,
    sender: senderFromLines(lines),
    touches,
    status: statusOf(touches, null, { record, notTaken: null }),
    agentSeen: seenByAgent(touches),
    takeId: id,
    take: record,
    notTaken: null,
  };
}

/** A message only a take names (0.35.0): no event saw it come in, and no activity line read it. */
function takeOnlyMessage(record: TakeView, index: ActivityIndex, aliases: ReadonlyMap<string, string>): JoinedMessage {
  const touches = takeTouches(record, index);
  return {
    key: `take:${record.key}`,
    event: null,
    sourceId: record.channel === 'resend' ? null : record.messageId,
    channel: record.channel,
    accountId: record.accountId,
    accountAlias: record.account ?? aliases.get(record.accountId) ?? null,
    at: touches[0]?.at ?? record.updatedAt ?? 0,
    sender: null,
    touches,
    status: statusOf(touches, null, { record, notTaken: null }),
    agentSeen: seenByAgent(touches),
    takeId: record.messageId,
    take: record,
    notTaken: null,
  };
}

/** Core's takes, each account's taking settings, and the moment "nobody took it" is judged at (0.35.0). */
export interface TakeContext {
  /** Each take record, by its message key, `<channel>:<accountId>:<id>`. */
  records: ReadonlyMap<string, TakeView>;
  /** Each account's taking settings, by the account's name. */
  settings: ReadonlyMap<string, TakingSettingView>;
  /** When the takes were read: a message counts as not taken once its window has passed by then. */
  now: Millis;
}

/** The join's view of what `takes list` and `taking` answered, read at `now`. */
export function takeContext(
  takes: readonly TakeView[],
  settings: readonly TakingSettingView[],
  now: Millis,
): TakeContext {
  return {
    records: new Map(takes.map((take) => [take.key, take])),
    settings: new Map(settings.map((setting) => [setting.account, setting])),
    now,
  };
}

export interface JoinOptions {
  /** Account names by account id, from the accounts the app read. */
  aliases?: ReadonlyMap<string, string> | undefined;
  /**
   * While older events wait on another page: the time of the oldest event read. A message only an agent read, from
   * before it, is held back until its page is read, since its event may be there.
   */
  cutoff?: Millis | null | undefined;
  /** Core's takes and each account's taking settings (0.35.0); none before it. */
  takes?: TakeContext | undefined;
  /** Each workflow run about a message (0.36.0), by the event it is about: listed, or shown with its steps. */
  runs?: ReadonlyMap<string, readonly MessageRun[]> | undefined;
}

/**
 * The messages, newest first: each event with every step after it, and each message only an agent read. Pure: the
 * same reads give the same list.
 */
export function join(
  events: readonly MessageEvent[],
  activity: ActivityItems,
  options: JoinOptions = {},
): JoinedMessage[] {
  const aliases = options.aliases ?? new Map<string, string>();
  const { takes } = options;
  const index = indexActivity(activity);
  const seen = new Set<string>();
  const messages: JoinedMessage[] = [];
  for (const event of events) {
    if (messages.some((each) => each.key === `event:${event.eventId}`)) continue;
    if (event.sourceId !== null) seen.add(event.sourceId);
    messages.push(eventMessage(event, index, aliases, takes, options.runs?.get(event.eventId)));
  }
  const cutoff = options.cutoff ?? null;
  for (const [id, lines] of activity) {
    if (seen.has(id)) continue;
    const message = agentOnlyMessage(id, lines, index, aliases, takes);
    if (message !== null && (cutoff === null || message.at >= cutoff)) messages.push(message);
  }
  // A message only a take names: every record no message above found.
  const joined = new Set(messages.flatMap((message) => (message.take === null ? [] : [message.take.key])));
  for (const record of takes?.records.values() ?? []) {
    if (joined.has(record.key)) continue;
    const message = takeOnlyMessage(record, index, aliases);
    if (cutoff === null || message.at >= cutoff) messages.push(message);
  }
  return messages.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// ── Filters ────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The screen's views: all, waiting for you, handled by an agent, no agent has seen; and with taking (core 0.35.0),
 * nobody took it and handed back.
 */
export type Show = 'all' | 'waiting' | 'handled' | 'unseen' | 'not-taken' | 'handed-back';

export const SHOWS: readonly Show[] = ['all', 'waiting', 'handled', 'unseen'];

/** The views with taking (core 0.35.0): the four, then Nobody took it and Handed back. */
export const TAKING_SHOWS: readonly Show[] = [...SHOWS, 'not-taken', 'handed-back'];

/** The account a message is filtered by: its name, or its id when it has none. */
export function accountOf(message: JoinedMessage): string | null {
  return message.accountAlias ?? message.accountId;
}

function shows(message: JoinedMessage, show: Show): boolean {
  switch (show) {
    case 'all':
      return true;
    case 'waiting':
      return message.status.kind === 'waiting';
    case 'handled':
      return message.agentSeen;
    case 'unseen':
      return !message.agentSeen;
    case 'not-taken':
      return message.notTaken !== null;
    case 'handed-back':
      return isHandedBack(message.take);
  }
}

/** The messages one view of one account (or every account, for null) shows. */
export function filterMessages(
  messages: readonly JoinedMessage[],
  filters: { show: Show; account: string | null },
): JoinedMessage[] {
  return messages.filter(
    (message) => shows(message, filters.show) && (filters.account === null || accountOf(message) === filters.account),
  );
}

/** How many messages each view holds, for one account (or every account). */
export function showCounts(messages: readonly JoinedMessage[], account: string | null): Record<Show, number> {
  const inAccount = messages.filter((message) => account === null || accountOf(message) === account);
  return Object.fromEntries(
    TAKING_SHOWS.map((show) => [show, inAccount.filter((message) => shows(message, show)).length]),
  ) as Record<Show, number>;
}

/** The accounts the picker offers: each one a message names, in order. */
export function accountChoices(messages: readonly JoinedMessage[]): string[] {
  return [...new Set(messages.flatMap((message) => accountOf(message) ?? []))].sort();
}
