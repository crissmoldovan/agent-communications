/**
 * The Messages screen's join (spec 2026-10-26-owner-feedback-0320 §3.6, "the app joins them"), pure: the event
 * service's events and core's activity lines, read for the same window, joined on the id both name a message by — a
 * Gmail message id, or Slack's `<channelId>/<ts>` — and each message's status, the furthest step it reached.
 *
 * What links a reply to what it answers:
 * - **Gmail:** a reply draft's line (`gmail.draft.reply`, or a send prepared as a reply) names the message in
 *   `replyTo`, and its draft by `draftId` (or as its item); the send's line (`gmail.send.execute`) names the same draft.
 * - **Slack:** a post's line names its parent's ts in `thread`, and its conversation by `channelId` (or its item's).
 * - **A Slack acknowledgement** is listed under the message it acknowledged, and — when it replied — under the reply
 *   too, a later ts in the same conversation; a line that says what it did (`act`) is taken at its word.
 *
 * A message only an agent read, with no event, is included: an item an ok read names that is none of an agent's own
 * drafts, sends, posts or acknowledgement replies.
 */
import type {
  ActivityItems,
  HistoryLine,
  ItemLine,
  MessageEvent,
  Millis,
  QueueItemView,
  SenderView,
  WindowRef,
} from './read.ts';
import { slackParts } from './read.ts';

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
  | 'reopened';

/** One step after a message arrived: who took it, and when. */
export interface Touch {
  kind: TouchKind;
  at: Millis;
  actor: 'person' | 'window';
  /** The agent window, when an activity line names it, or a queue line's key is one an activity line names. */
  window: WindowRef | null;
  /** The window's activity session key, for a window's step. */
  windowKey: string | null;
  /** Where the step was recorded: core's activity log, or the queue's history. */
  via: 'activity' | 'queue';
  /** The activity operation, for an activity step. */
  operation: string | null;
  /** The draft a reply step concerns. */
  draftId: string | null;
  /** For a send: Gmail's send, or a Slack post in the thread. */
  channel: string | null;
  /** For an acknowledgement: whether it replied, rather than reacted. */
  replied: boolean;
}

/** The furthest step a message reached (§3.6's order). */
export type Status =
  | { kind: 'replied'; at: Millis; via: 'gmail' | 'slack-thread' | 'slack-ack' }
  | { kind: 'acknowledged'; at: Millis }
  | { kind: 'done' | 'dismissed'; at: Millis | null; actor: 'person' | 'window' | null }
  | { kind: 'read'; at: Millis }
  | { kind: 'waiting' }
  | { kind: 'not-seen' };

export type StatusKind = Status['kind'];

/** The order the status is decided in: the first a message reached wins. Done and Dismissed share their place. */
export const STATUS_ORDER: readonly StatusKind[] = [
  'replied',
  'acknowledged',
  'done',
  'dismissed',
  'read',
  'waiting',
  'not-seen',
];

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
  /** The acknowledged messages whose acknowledgement replied. */
  ackReplied: Set<string>;
  /** Items an agent made: never a message that came in. */
  own: Set<string>;
}

/** The draft a reply line made or prepared: its own `draftId`, or the draft it was listed under. */
function draftOf(line: ItemLine): string {
  return line.draftId ?? line.itemId;
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [value]);
  else list.push(value);
}

function indexActivity(byItem: ActivityItems): ActivityIndex {
  const windows = new Map<string, WindowRef>();
  const replyLines = new Map<string, ItemLine[]>();
  const sendsByDraft = new Map<string, ItemLine[]>();
  const threadPosts = new Map<string, ItemLine[]>();
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
      if (OWN.test(line.operation) && line.operation !== 'slack.ack') own.add(itemId);
      if (line.replyTo !== null && line.channel === 'gmail') push(replyLines, line.replyTo.messageId, line);
      if (line.operation === 'gmail.send.execute' && ok(line)) push(sendsByDraft, draftOf(line), line);
      if (SLACK_POSTS.has(line.operation) && ok(line) && line.thread !== null) {
        const channelId = line.channelId ?? slackParts(itemId)?.channelId ?? null;
        if (channelId !== null) push(threadPosts, `${channelId}/${line.thread}`, line);
      }
      if (line.operation === 'slack.ack') {
        push(acks, `${line.session.key}|${line.at}|${line.operation}`, line);
        if (line.act === 'reply') ackReplied.add(itemId);
      }
    }
  }
  for (const lines of acks.values()) {
    const ids = [...new Set(lines.map((line) => line.itemId))].filter((id) => slackParts(id) !== null);
    if (ids.length < 2) continue;
    const [first, ...rest] = ids.sort((a, b) => tsValue(a) - tsValue(b));
    if (first === undefined || rest.some((id) => slackParts(id)?.channelId !== slackParts(first)?.channelId)) continue;
    if (lines.some((line) => line.act === 'reaction')) continue;
    ackReplied.add(first);
    for (const id of rest) own.add(id);
  }
  return { byItem, windows, replyLines, sendsByDraft, threadPosts, ackReplied, own };
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

/** Every step the activity log and the queue's history recorded for the message `id` names. */
function touchesOf(id: string | null, queueItem: QueueItemView | null, index: ActivityIndex): Touch[] {
  const touches: Touch[] = (queueItem?.history ?? []).map((line) => queueTouch(line, index));
  if (id !== null) {
    for (const line of index.byItem.get(id) ?? []) {
      if (isRead(line)) touches.push(activityTouch('read', line));
      else if (line.operation === 'slack.ack' && ok(line)) {
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
 * replied), Acknowledged (by reaction), Done or Dismissed with who, Read by an agent (or a reply drafted to it), Waiting
 * for you (an open item no agent has read), or Not seen.
 */
export function statusOf(touches: readonly Touch[], queueItem: QueueItemView | null): Status {
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
  // Drafting a reply to it, or asking to send one, is as far as reading it: the agent had it in hand.
  const read = touches.find((touch) => touch.kind === 'read' || touch.kind === 'drafted' || touch.kind === 'prepared');
  if (read !== undefined) return { kind: 'read', at: read.at };
  if (queueItem !== null && queueItem.state === 'open') return { kind: 'waiting' };
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

function eventMessage(event: MessageEvent, index: ActivityIndex, aliases: ReadonlyMap<string, string>): JoinedMessage {
  const lines = event.sourceId === null ? [] : (index.byItem.get(event.sourceId) ?? []);
  const touches = touchesOf(event.sourceId, event.queueItem, index);
  const lineAlias = lines.find((line) => line.account?.id === event.accountId && line.account.alias !== null)?.account
    ?.alias;
  return {
    key: `event:${event.eventId}`,
    event,
    sourceId: event.sourceId,
    channel: event.channel,
    accountId: event.accountId === '' ? null : event.accountId,
    accountAlias: event.accountAlias ?? aliases.get(event.accountId) ?? lineAlias ?? null,
    at: event.occurredAt ?? event.observedAt ?? 0,
    sender: event.kept ?? senderFromLines(lines),
    touches,
    status: statusOf(touches, event.queueItem),
    agentSeen: seenByAgent(touches),
  };
}

function agentOnlyMessage(
  id: string,
  lines: readonly ItemLine[],
  index: ActivityIndex,
  aliases: ReadonlyMap<string, string>,
): JoinedMessage | null {
  const reads = lines.filter(isRead);
  const first = reads[0];
  if (first === undefined || index.own.has(id)) return null;
  const channel = first.channel;
  if (channel !== 'gmail' && channel !== 'slack') return null;
  const touches = touchesOf(id, null, index);
  const account = lines.find((line) => line.account !== null)?.account ?? null;
  return {
    key: `item:${id}`,
    event: null,
    sourceId: id,
    channel,
    accountId: account?.id ?? null,
    accountAlias: account === null ? null : (account.alias ?? aliases.get(account.id) ?? null),
    at: first.at,
    sender: senderFromLines(lines),
    touches,
    status: statusOf(touches, null),
    agentSeen: seenByAgent(touches),
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
  const index = indexActivity(activity);
  const seen = new Set<string>();
  const messages: JoinedMessage[] = [];
  for (const event of events) {
    if (messages.some((each) => each.key === `event:${event.eventId}`)) continue;
    if (event.sourceId !== null) seen.add(event.sourceId);
    messages.push(eventMessage(event, index, aliases));
  }
  const cutoff = options.cutoff ?? null;
  for (const [id, lines] of activity) {
    if (seen.has(id)) continue;
    const message = agentOnlyMessage(id, lines, index, aliases);
    if (message !== null && (cutoff === null || message.at >= cutoff)) messages.push(message);
  }
  return messages.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

// ── Filters ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The screen's four views: all, waiting for you, handled by an agent, no agent has seen. */
export type Show = 'all' | 'waiting' | 'handled' | 'unseen';

export const SHOWS: readonly Show[] = ['all', 'waiting', 'handled', 'unseen'];

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
    SHOWS.map((show) => [show, inAccount.filter((message) => shows(message, show)).length]),
  ) as Record<Show, number>;
}

/** The accounts the picker offers: each one a message names, in order. */
export function accountChoices(messages: readonly JoinedMessage[]): string[] {
  return [...new Set(messages.flatMap((message) => accountOf(message) ?? []))].sort();
}
