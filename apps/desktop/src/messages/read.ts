/**
 * What the Messages screen reads (spec 2026-10-26-owner-feedback-0320 §3.6), field by field into the few shapes the
 * join takes: the event service's `messages list --json` and `message show <eventId> --json`, core's `activity
 * items --json`, and — from core 0.35.0 (design 2026-10-26-taking-messages §9) — core's `takes list --json` and
 * `taking --json`. Every reader is lenient about what it does not need and strict about what it joins on: an entry with
 * no id, or a line with no time, is left out rather than guessed at.
 *
 * A take's note is an agent's words, which may carry a sender's: it arrives enveloped, and is kept as it came, a string
 * the screen shows only through `UntrustedText`, to the person alone. A holder's folder and client are the person's
 * view of their own windows (T7), and are shown as text through `UntrustedText` too.
 *
 * Nothing here makes markup. What a sender wrote — the kept sender and subject, an activity line's subject and sender —
 * arrives inside the untrusted-content envelope and is kept as it came, a string the screen shows only through
 * `OutsideText`. A rule's id, a target's id and a judge's question are the rule author's, and are shown through
 * `UntrustedText`.
 */
import { isLaneName, isSessionKey } from '../grammar.ts';
import { type RunListEntryV1, type RunShowResultV1, readRunsList } from '../workflows/types.ts';

/** Milliseconds since the epoch. */
export type Millis = number;

/** What a rule's judge answered, when it asked one. */
export interface JudgeAnswer {
  id: string | null;
  /** `typesafe` (Jev), `local-endpoint`, `laya`, or another kind as the service names it. */
  kind: string | null;
  answer: 'yes' | 'no' | null;
  confidence: number | null;
  /** The rule's own question: the rule author's words. */
  question: string | null;
  /** A local endpoint's score, which is no probability. */
  uncalibrated: boolean;
}

/** One rule's decision on the event. */
export interface DecisionView {
  ruleId: string;
  ruleVersion: number | null;
  /** `matched`, `no-match`, `mapping-rejected`, `retention-expired` or `hold`. */
  outcome: string;
  judge: JudgeAnswer | null;
  /** When it was decided, if the service says. */
  at: Millis | null;
}

/** One delivery a decision made. */
export interface DeliveryView {
  deliveryId: string;
  /** `queue`, `dry-run`, `webhook` or `sse`. */
  targetKind: string;
  targetId: string;
  lane: string | null;
  state: string;
  at: Millis | null;
}

export const HISTORY_KINDS = ['woken', 'read', 'done', 'dismissed', 'reopened'] as const;
export type HistoryKind = (typeof HISTORY_KINDS)[number];

/** One line of a queue item's history: what happened to it, and who — the person, or an agent window by its key. */
export interface HistoryLine {
  at: Millis;
  kind: HistoryKind;
  actor: 'person' | 'window';
  /** The window's activity session key; null for the person. */
  windowKey: string | null;
}

export type QueueState = 'open' | 'done' | 'dismissed';

export interface QueueItemView {
  itemId: string;
  state: QueueState;
  stateAt: Millis | null;
  lane: string | null;
  /** Oldest first. */
  history: HistoryLine[];
}

/** Who a message is from and what it says it is about: each the sender's text, enveloped as it came. */
export interface SenderView {
  name: string | null;
  address: string | null;
  subject: string | null;
}

/** Where a message came from, by the source's own ids. */
export interface MessageSource {
  messageId: string | null;
  channelId: string | null;
  ts: string | null;
  /** A Resend email's id, which a take names it by (0.35.0). */
  emailId?: string | null;
}

/** One event the event service observed. */
export interface MessageEvent {
  eventId: string;
  /** Whether the id is one `message show` takes. */
  openable: boolean;
  type: string;
  channel: string;
  accountId: string;
  /** The account's name, when the answer carries one. */
  accountAlias: string | null;
  occurredAt: Millis | null;
  observedAt: Millis | null;
  source: MessageSource;
  /** The id the activity log names the same message by: a Gmail message id, or Slack's `<channelId>/<ts>`. */
  sourceId: string | null;
  decisions: DecisionView[];
  deliveries: DeliveryView[];
  queueItem: QueueItemView | null;
  kept: SenderView | null;
}

/** Where a page ended, as `--before` takes it: the event service's cursor (`<observedAt ms>:<eventId>`), or a time. */
export type PageCursor = Millis | string;

export interface MessagesPage {
  messages: MessageEvent[];
  /** The `--before` that reads the next, older page; null when there is none the app can ask for. */
  before: PageCursor | null;
  /** More events are older than this page, whether or not the app can page to them. */
  more: boolean;
}

/** An agent window, as an activity line names it. */
export interface WindowRef {
  key: string;
  /** Its folder as recorded (a real path), or null. */
  folder: string | null;
  client: { name: string; version: string | null } | null;
}

/** One activity line, under the id of the item it was listed under. */
export interface ItemLine {
  /** The id `activity items` listed it under. */
  itemId: string;
  session: WindowRef;
  operation: string;
  /** The channel's word: `gmail`, `slack`, …, from the line or its operation. */
  channel: string;
  at: Millis;
  outcome: string;
  /** `read`, `write`, `approval` or `told`, when the line says. */
  kind: string | null;
  subject: string | null;
  from: { name: string | null; address: string | null } | null;
  replyTo: { messageId: string; threadId: string | null } | null;
  /**
   * The thread a Slack post went into: as `activity items` names it, the parent message, `<channelId>/<ts>` — or its
   * ts alone, as a line itself keeps it. Null for a new message, or when the line does not say.
   */
  thread: string | null;
  draftId: string | null;
  threadId: string | null;
  channelId: string | null;
  /** What a Slack acknowledgement did, when the line says. */
  act: 'reply' | 'reaction' | null;
  account: { id: string; alias: string | null } | null;
}

/** `activity items`, by item id. */
export type ActivityItems = ReadonlyMap<string, readonly ItemLine[]>;

// ── Small readers ──────────────────────────────────────────────────────────────────────────────────────────────

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const word = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/** A moment as the services write one: milliseconds, a string of them, or an ISO time. */
export function millisOf(value: unknown): Millis | null {
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  if (typeof value !== 'string' || value === '') return null;
  if (/^\d+$/.test(value)) return millisOf(Number(value));
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) || parsed <= 0 ? null : parsed;
}

/** An event id, as `message show` takes one: 32 lowercase hex digits. */
export function isEventId(value: string): boolean {
  return /^[0-9a-f]{32}$/.test(value);
}

/** A message as `activity items --ids` takes one: a Gmail message's id, or Slack's `<channel>/<ts>`. */
export function isItemId(value: string): boolean {
  return /^[0-9A-Za-z_-]{1,128}$/.test(value) || SLACK_ITEM.test(value);
}

const SLACK_ITEM = /^[CDG][A-Z0-9]{2,31}\/[0-9]{1,12}\.[0-9]{6}$/;

/** A Slack item id, split: its conversation and its ts; null for any other id. */
export function slackParts(id: string): { channelId: string; ts: string } | null {
  if (!SLACK_ITEM.test(id)) return null;
  const [channelId = '', ts = ''] = id.split('/');
  return { channelId, ts };
}

// ── The event service ──────────────────────────────────────────────────────────────────────────────────────────

function judgeOf(value: unknown): JudgeAnswer | null {
  if (value === 'yes' || value === 'no') {
    return { id: null, kind: null, answer: value, confidence: null, question: null, uncalibrated: false };
  }
  if (!isRecord(value)) return null;
  const answer = value.answer === 'yes' || value.answer === 'no' ? value.answer : null;
  return {
    id: word(value.id) ?? word(value.judgeId),
    kind: word(value.kind),
    answer,
    confidence: finite(value.confidence),
    question: word(value.question),
    // The event service says whether the number is a probability (`calibrated`); a local endpoint's score is not.
    uncalibrated: value.uncalibrated === true || value.calibrated === false,
  };
}

function decisionOf(value: unknown): DecisionView | null {
  if (!isRecord(value)) return null;
  const ruleId = word(value.ruleId);
  const outcome = word(value.outcome);
  if (ruleId === null || outcome === null) return null;
  return {
    ruleId,
    ruleVersion: whole(value.ruleVersion),
    outcome,
    judge: judgeOf(value.judge),
    at: millisOf(value.decidedAt ?? value.at),
  };
}

/** A lane's name, as a string or `{ name }`: only a name a lane can have. */
function laneOf(value: unknown): string | null {
  const name = isRecord(value) ? text(value.name) : text(value);
  return name !== null && isLaneName(name) ? name : null;
}

function deliveryOf(value: unknown): DeliveryView | null {
  if (!isRecord(value)) return null;
  const deliveryId = word(value.deliveryId);
  if (deliveryId === null) return null;
  return {
    deliveryId,
    targetKind: word(value.targetKind) ?? '',
    targetId: word(value.targetId) ?? '',
    lane: laneOf(value.lane),
    state: word(value.state) ?? '',
    at: millisOf(value.deliveredAt ?? value.createdAt),
  };
}

function historyOf(value: unknown): HistoryLine | null {
  if (!isRecord(value)) return null;
  const at = millisOf(value.at);
  const kind = HISTORY_KINDS.find((each) => each === value.kind);
  const actor = value.actor === 'person' || value.actor === 'window' ? value.actor : null;
  if (at === null || kind === undefined || actor === null) return null;
  const key = text(value.windowKey);
  return { at, kind, actor, windowKey: actor === 'window' && key !== null && isSessionKey(key) ? key : null };
}

function queueItemOf(value: unknown): QueueItemView | null {
  if (!isRecord(value)) return null;
  const itemId = word(value.itemId) ?? word(value.id);
  const state = value.state === 'open' || value.state === 'done' || value.state === 'dismissed' ? value.state : null;
  if (itemId === null || state === null) return null;
  const history = Array.isArray(value.history) ? value.history.flatMap((each) => historyOf(each) ?? []) : [];
  return {
    itemId,
    state,
    stateAt: millisOf(value.stateAt),
    lane: laneOf(value.lane),
    history: history.sort((a, b) => a.at - b.at),
  };
}

/** A sender as a kept summary or a line names one: `{ name, address }`, or a single string, which is its name. */
function senderOf(value: unknown): { name: string | null; address: string | null } | null {
  if (typeof value === 'string') return value === '' ? null : { name: value, address: null };
  if (!isRecord(value)) return null;
  const name = word(value.name);
  const address = word(value.address);
  return name === null && address === null ? null : { name, address };
}

function keptOf(value: unknown): SenderView | null {
  if (!isRecord(value)) return null;
  const from = senderOf(value.from);
  const subject = word(value.subject) ?? word(value.text);
  if (from === null && subject === null) return null;
  return { name: from?.name ?? null, address: from?.address ?? null, subject };
}

function sourceOf(value: unknown): MessageSource {
  const given = isRecord(value) ? value : {};
  const emailId = word(given.emailId);
  return {
    messageId: word(given.messageId),
    channelId: word(given.channelId),
    ts: word(given.ts),
    ...(emailId === null ? {} : { emailId }),
  };
}

/** The id the activity log knows the message by: Gmail's message id, or Slack's `<channelId>/<ts>`. */
function sourceIdOf(channel: string, source: MessageSource): string | null {
  if (channel === 'gmail') return source.messageId;
  if (channel === 'slack')
    return source.channelId !== null && source.ts !== null ? `${source.channelId}/${source.ts}` : null;
  return null;
}

function messageOf(value: unknown): MessageEvent | null {
  if (!isRecord(value)) return null;
  const eventId = word(value.eventId);
  if (eventId === null) return null;
  const type = word(value.type) ?? '';
  const channel = word(value.channel) ?? type.split('.')[0] ?? '';
  const account = isRecord(value.account) ? value.account : {};
  const source = sourceOf(value.source);
  return {
    eventId,
    openable: isEventId(eventId),
    type,
    channel,
    accountId: word(value.accountId) ?? word(account.id) ?? '',
    accountAlias: word(value.accountAlias) ?? word(account.alias),
    occurredAt: millisOf(value.occurredAt),
    observedAt: millisOf(value.observedAt),
    source,
    sourceId: sourceIdOf(channel, source),
    decisions: Array.isArray(value.decisions) ? value.decisions.flatMap((each) => decisionOf(each) ?? []) : [],
    deliveries: Array.isArray(value.deliveries) ? value.deliveries.flatMap((each) => deliveryOf(each) ?? []) : [],
    queueItem: queueItemOf(value.queueItem),
    kept: keptOf(value.kept),
  };
}

/** The event service's cursor: the 13 digits of a time in milliseconds, `:`, and an event id. */
const CURSOR = /^([1-9][0-9]{12}):[0-9a-f]{32}$/;

/** A page's `next`, as `--before` takes it again: the cursor as it came, or a time; null for anything else. */
function cursorOf(value: unknown): PageCursor | null {
  if (typeof value === 'string' && CURSOR.test(value)) return value;
  return millisOf(value);
}

/** The time a page ended at, by its cursor. */
export function cursorMillis(cursor: PageCursor): Millis {
  return typeof cursor === 'number' ? cursor : Number(CURSOR.exec(cursor)?.[1] ?? 0);
}

/**
 * `messages list --json`, read: `{ messages: [...], next }`, or null when it is not that answer at all. `next` is the
 * cursor to the next page, `<observedAt ms>:<eventId>` (or a time), which the next read passes as `--before`.
 */
export function readMessagesPage(value: unknown): MessagesPage | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const more = value.next !== null && value.next !== undefined && value.next !== false;
  return {
    messages: value.messages.flatMap((each) => messageOf(each) ?? []),
    before: more ? cursorOf(value.next) : null,
    more,
  };
}

/** `message show <eventId> --json`, read: the entry itself, or `{ message }`; null when it is neither. */
export function readMessageShow(value: unknown): MessageEvent | null {
  if (isRecord(value) && isRecord(value.message)) return messageOf(value.message);
  return messageOf(value);
}

// ── Core's activity ────────────────────────────────────────────────────────────────────────────────────────────

function windowOf(value: unknown): WindowRef | null {
  if (!isRecord(value)) return null;
  const key = text(value.key);
  if (key === null || !isSessionKey(key)) return null;
  const client = isRecord(value.client) && typeof value.client.name === 'string' ? value.client : null;
  return {
    key,
    folder: word(value.folder),
    client: client === null ? null : { name: client.name as string, version: word(client.version) },
  };
}

function lineOf(itemId: string, value: unknown): ItemLine | null {
  if (!isRecord(value)) return null;
  const session = windowOf(value.session);
  const operation = word(value.operation);
  const at = millisOf(value.at);
  if (session === null || operation === null || at === null) return null;
  const replyTo = isRecord(value.replyTo) ? value.replyTo : null;
  const replyMessage = replyTo === null ? null : word(replyTo.messageId);
  const account = isRecord(value.account) ? value.account : null;
  const accountId = account === null ? null : word(account.id);
  return {
    itemId,
    session,
    operation,
    channel: word(value.channel) ?? operation.split('.')[0] ?? '',
    at,
    outcome: word(value.outcome) ?? 'ok',
    kind: word(value.kind),
    subject: word(value.subject),
    from: senderOf(value.from),
    replyTo: replyMessage === null ? null : { messageId: replyMessage, threadId: word(replyTo?.threadId) },
    thread: word(value.thread),
    draftId: word(value.draftId),
    threadId: word(value.threadId),
    channelId: word(value.channelId),
    act: value.act === 'reply' || value.act === 'reaction' ? value.act : null,
    account: accountId === null || account === null ? null : { id: accountId, alias: word(account.alias) },
  };
}

/** `activity items --json`, read: `{ items: { [id]: [line, …] } }`, or null when it is not that answer at all. */
export function readActivityItems(value: unknown): ActivityItems | null {
  if (!isRecord(value) || !isRecord(value.items)) return null;
  const items = new Map<string, ItemLine[]>();
  for (const [id, lines] of Object.entries(value.items)) {
    if (id === '' || !Array.isArray(lines)) continue;
    const read = lines.flatMap((each) => lineOf(id, each) ?? []).sort((a, b) => a.at - b.at);
    if (read.length > 0) items.set(id, read);
  }
  return items;
}

// ── Core's takes (0.35.0) ──────────────────────────────────────────────────────────────────────────────────────

export const TAKE_STATES = ['open', 'offered', 'taken', 'done'] as const;
export type TakeState = (typeof TAKE_STATES)[number];

/** Why a session handed a message back: core's closed words (T8). */
export const HAND_BACK_REASONS = ['not-mine', 'wrong-account', 'needs-the-person', 'duplicate', 'other'] as const;
export type HandBackReason = (typeof HAND_BACK_REASONS)[number];

/** What one line of a take's history says happened (§4). */
export const TAKE_LINE_KINDS = [
  'offered',
  'taken',
  'handed-back',
  'done',
  'expired',
  'ended',
  'released',
  'given',
  'kept',
  'acknowledged',
] as const;
export type TakeLineKind = (typeof TAKE_LINE_KINDS)[number];

/** An agent window as a take names it: its activity key, its Claude Code session id, its folder and client. */
export interface TakeWindowView {
  /** Its activity session key, or null when the take names it by its Claude Code session id alone. */
  key: string | null;
  sessionId: string | null;
  /** Its folder as recorded (a real path), or null. */
  folder: string | null;
  client: { name: string; version: string | null } | null;
}

/** One line of a take's history, oldest first. */
export interface TakeLineView {
  at: Millis;
  kind: TakeLineKind;
  by: 'window' | 'person' | 'service';
  /** The window the line is about — the holder's, the offered one's — or null. */
  window: TakeWindowView | null;
  /** A person's act: the folder of the terminal it came from, and the processes above it, nearest first. */
  terminal: { folder: string | null; ancestors: string[] } | null;
  reason: HandBackReason | null;
  /** An agent's note, enveloped: the person's alone, shown only through `UntrustedText`. */
  note: string | null;
  /** What a 👀 on taking came to. */
  ack: 'sent' | 'failed' | 'unknown' | 'not-made' | null;
}

/** One take record, as `takes list` gives it to the person. */
export interface TakeView {
  /** `<channel>:<accountId>:<id>`: what the join finds it by. */
  key: string;
  channel: 'gmail' | 'slack' | 'resend';
  accountId: string;
  /** The account's name now, or null for one no connected account holds. */
  account: string | null;
  /** The message's id: Gmail's, Slack's `<channelId>/<ts>`, or Resend's email id. */
  messageId: string;
  state: TakeState;
  /** Who has it: the person, an agent window, or nobody. */
  holder: 'person' | TakeWindowView | null;
  /** Who it is offered to and until when, while it is; by a rule's delivery or by the person. */
  offer: { to: TakeWindowView; until: Millis | null; rule: string | null; byPerson: boolean } | null;
  takenAt: Millis | null;
  /** When the take lapses with no further act, or null. */
  leaseUntil: Millis | null;
  history: TakeLineView[];
  updatedAt: Millis | null;
}

export interface TakesRead {
  takes: TakeView[];
  /** Records core could not read: each counts as held by another session until the person releases it. */
  unreadable: number;
}

/** Each account's taking settings, as `taking` gives them (§4). */
export interface TakingSettingView {
  account: string;
  channel: 'gmail' | 'slack' | 'resend';
  required: boolean;
  acknowledge: 'eyes' | 'nothing';
  unclaimed: { afterMinutes: number; notify: boolean };
  /** False when nothing is set for it, and these are the defaults. */
  stored: boolean;
}

export interface TakingRead {
  accounts: TakingSettingView[];
  /** Values core read as something stricter, each in a sentence. */
  problems: string[];
}

const TAKE_CHANNELS = ['gmail', 'slack', 'resend'] as const;
type TakeChannel = (typeof TAKE_CHANNELS)[number];

function closed<T extends string>(list: readonly T[], value: unknown): T | null {
  return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : null;
}

function clientOf(value: unknown): { name: string; version: string | null } | null {
  if (!isRecord(value) || typeof value.name !== 'string' || value.name === '') return null;
  return { name: value.name, version: word(value.version) };
}

/** A window a take names: by its activity key, its session id, or both; null when it names neither. */
function takeWindowOf(key: unknown, value: unknown): TakeWindowView | null {
  const given = isRecord(value) ? value : {};
  const keyText = text(key) ?? text(given.key);
  const windowKey = keyText !== null && isSessionKey(keyText) ? keyText : null;
  const sessionId = word(given.sessionId);
  if (windowKey === null && sessionId === null) return null;
  return { key: windowKey, sessionId, folder: word(given.folder), client: clientOf(given.client) };
}

function takeLineOf(value: unknown): TakeLineView | null {
  if (!isRecord(value)) return null;
  const at = millisOf(value.at);
  const kind = closed(TAKE_LINE_KINDS, value.kind);
  const by = closed(['window', 'person', 'service'] as const, value.by);
  if (at === null || kind === null || by === null) return null;
  const terminal = isRecord(value.terminal) ? value.terminal : null;
  const ack = isRecord(value.ack)
    ? closed(['sent', 'failed', 'unknown', 'not-made'] as const, value.ack.outcome)
    : null;
  return {
    at,
    kind,
    by,
    window: takeWindowOf(value.windowKey, value.window),
    terminal:
      terminal === null
        ? null
        : {
            folder: word(terminal.folder),
            ancestors: Array.isArray(terminal.ancestors)
              ? terminal.ancestors.flatMap((each) => (typeof each === 'string' ? [each] : []))
              : [],
          },
    reason: closed(HAND_BACK_REASONS, value.reason),
    note: word(value.note),
    ack,
  };
}

function holderOf(value: unknown): TakeView['holder'] {
  if (!isRecord(value)) return null;
  if (value.person === true) return 'person';
  return takeWindowOf(value.key, value);
}

function offerOf(value: unknown): TakeView['offer'] {
  if (!isRecord(value)) return null;
  const to = isRecord(value.to) ? takeWindowOf(value.to.key, value.to) : null;
  if (to === null) return null;
  const by = isRecord(value.by) ? value.by : {};
  return { to, until: millisOf(value.until), rule: word(by.rule), byPerson: by.person === true };
}

function takeOf(value: unknown): TakeView | null {
  if (!isRecord(value) || !isRecord(value.message)) return null;
  const message = value.message;
  const channel = closed<TakeChannel>(TAKE_CHANNELS, message.channel);
  const accountId = word(message.accountId);
  const messageId = word(message.id);
  const state = closed(TAKE_STATES, value.state);
  if (channel === null || accountId === null || messageId === null || state === null) return null;
  const history = Array.isArray(value.history) ? value.history.flatMap((each) => takeLineOf(each) ?? []) : [];
  return {
    key: `${channel}:${accountId}:${messageId}`,
    channel,
    accountId,
    account: word(value.account),
    messageId,
    state,
    holder: holderOf(value.holder),
    offer: offerOf(value.offer),
    takenAt: millisOf(value.takenAt),
    leaseUntil: millisOf(value.leaseUntil),
    history: history.sort((a, b) => a.at - b.at),
    updatedAt: millisOf(value.updatedAt),
  };
}

/** `takes list --json`, read: `{ takes: [...], unreadable: [...] }`, or null when it is not that answer at all. */
export function readTakesList(value: unknown): TakesRead | null {
  if (!isRecord(value) || !Array.isArray(value.takes)) return null;
  return {
    takes: value.takes.flatMap((each) => takeOf(each) ?? []),
    unreadable: Array.isArray(value.unreadable) ? value.unreadable.length : 0,
  };
}

function takingAccountOf(value: unknown): TakingSettingView | null {
  if (!isRecord(value)) return null;
  const account = word(value.account);
  const channel = closed<TakeChannel>(TAKE_CHANNELS, value.channel);
  if (account === null || channel === null) return null;
  const unclaimed = isRecord(value.unclaimed) ? value.unclaimed : {};
  return {
    account,
    channel,
    // A value that cannot be read counts as the stricter one, as core reads it (§4).
    required: value.required !== false,
    acknowledge: value.acknowledge === 'eyes' ? 'eyes' : 'nothing',
    unclaimed: { afterMinutes: whole(unclaimed.afterMinutes) ?? 5, notify: unclaimed.notify !== false },
    stored: value.stored === true,
  };
}

/** `taking --json`, read: `{ accounts: [...], problems: [...] }`, or null when it is not that answer at all. */
export function readTaking(value: unknown): TakingRead | null {
  if (!isRecord(value) || !Array.isArray(value.accounts)) return null;
  return {
    accounts: value.accounts.flatMap((each) => takingAccountOf(each) ?? []),
    problems: Array.isArray(value.problems)
      ? value.problems.flatMap((each) => (typeof each === 'string' ? [each] : []))
      : [],
  };
}

// ── Workflow runs (0.36.0) ─────────────────────────────────────────────────────────────────────────────────────

/**
 * A workflow's run about a message (workflows design §11.2): as `runs list --json` lists it, or as `runs show --json`
 * shows it with its steps and the events it raised. Its records are content-free: ids, closed words, times, and a
 * project's name, which is the person's.
 */
export type MessageRun = RunListEntryV1 | RunShowResultV1;

/** Whether a run is shown, with its steps, rather than only listed. */
export function isShownRun(run: MessageRun): run is RunShowResultV1 {
  return 'steps' in run;
}

/**
 * `runs list --json`, read and joined by the event each run is about (§11.2: "read from `runs list --json`, joined by
 * event id"), oldest run first; null when it is not that answer at all.
 */
export function readRunsByEvent(value: unknown): ReadonlyMap<string, readonly RunListEntryV1[]> | null {
  let runs: readonly RunListEntryV1[];
  try {
    runs = readRunsList(value).runs;
  } catch {
    return null;
  }
  const byEvent = new Map<string, RunListEntryV1[]>();
  for (const run of [...runs].sort((a, b) => a.startedAt - b.startedAt))
    byEvent.set(run.eventId, [...(byEvent.get(run.eventId) ?? []), run]);
  return byEvent;
}
