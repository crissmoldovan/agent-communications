/**
 * What the Messages screen reads (spec 2026-10-26-owner-feedback-0320 §3.6), field by field into the few shapes the
 * join takes: the event service's `messages list --json` and `message show <eventId> --json`, and core's `activity
 * items --json`. Every reader is lenient about what it does not need and strict about what it joins on: an entry with
 * no id, or a line with no time, is left out rather than guessed at.
 *
 * Nothing here makes markup. What a sender wrote — the kept sender and subject, an activity line's subject and sender —
 * arrives inside the untrusted-content envelope and is kept as it came, a string the screen shows only through
 * `OutsideText`. A rule's id, a target's id and a judge's question are the rule author's, and are shown through
 * `UntrustedText`.
 */
import { isLaneName, isSessionKey } from '../grammar.ts';

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
export interface EventSource {
  messageId: string | null;
  channelId: string | null;
  ts: string | null;
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
  source: EventSource;
  /** The id the activity log names the same message by: a Gmail message id, or Slack's `<channelId>/<ts>`. */
  sourceId: string | null;
  decisions: DecisionView[];
  deliveries: DeliveryView[];
  queueItem: QueueItemView | null;
  kept: SenderView | null;
}

export interface MessagesPage {
  messages: MessageEvent[];
  /** The `--before` that reads the next, older page; null when there is none the app can ask for. */
  before: Millis | null;
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
  /** A Slack post's parent ts: null for a new message, or when the line does not say. */
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
    uncalibrated: value.uncalibrated === true,
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

function sourceOf(value: unknown): EventSource {
  const given = isRecord(value) ? value : {};
  return { messageId: word(given.messageId), channelId: word(given.channelId), ts: word(given.ts) };
}

/** The id the activity log knows the message by: Gmail's message id, or Slack's `<channelId>/<ts>`. */
function sourceIdOf(channel: string, source: EventSource): string | null {
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

/**
 * `messages list --json`, read: `{ messages: [...], next }`, or null when it is not that answer at all. `next` is the
 * cursor to the next page: a time in milliseconds, which the next read passes as `--before`.
 */
export function readMessagesPage(value: unknown): MessagesPage | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const more = value.next !== null && value.next !== undefined && value.next !== false;
  return {
    messages: value.messages.flatMap((each) => messageOf(each) ?? []),
    before: more ? millisOf(value.next) : null,
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
