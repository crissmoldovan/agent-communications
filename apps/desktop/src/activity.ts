/**
 * The activity log, as the Activity screen reads it (design 2026-10-25-activity §4.5, S1, S2): core's `activity
 * sessions --json` and `activity show --json`, read field by field into the few shapes the screen shows, and each call
 * said in a few plain words.
 *
 * Nothing here makes markup. What a sender wrote — a subject, a sender's name or address, a file's name, a
 * conversation's name — arrives inside core's untrusted-content envelope and is kept as it came, in a part of its own
 * (`outside`), which the screen shows as plain text marked From outside. A plain address core left bare is still a
 * sender's, and goes in such a part too; the screen shows it as text with no mark, since it holds no envelope.
 */
import { productLabel } from './components/ApprovalCard.tsx';
import { isSessionKey } from './grammar.ts';
import {
  ACTIVITY_CHANNELS,
  type ActivityChannel,
  type ActivityKind,
  type ActivityOutcome,
  type ActivitySince,
} from './ipc.ts';

// ── What the screen reads ──────────────────────────────────────────────────────────────────────────────────────

export const ACTIVITY_KINDS: readonly ActivityKind[] = ['read', 'write', 'told', 'approval'];
export const ACTIVITY_OUTCOMES: readonly ActivityOutcome[] = ['ok', 'refused', 'failed'];

/** One session, as `activity sessions` lists it and `activity show` heads its timeline. */
export interface SessionView {
  key: string;
  /** True when its processes were grouped under one agent window (S2); a claim the screen makes only then. */
  grouped: boolean;
  surfaces: string[];
  /** The folder with the home as `~`, or null when it could not be read. */
  folder: string | null;
  /** The client as it said it is, never proof of what it is (§4.3). */
  client: { name: string; version: string | null } | null;
  firstSeen: string;
  lastSeen: string;
  processes: number;
  channels: string[];
  accounts: string[];
  kinds: Record<ActivityKind, number>;
  outcomes: Record<ActivityOutcome, number>;
}

/** One thing a call touched, each sender-written field as it came (enveloped, or a bare plain address). */
export interface ItemView {
  id: string;
  subject: string | null;
  fromName: string | null;
  fromAddress: string | null;
  name: string | null;
  size: number | null;
  conversation: string | null;
}

/** One call, as `activity show` gives it. */
export interface LineView {
  at: string;
  channel: string;
  account: { id: string; alias: string };
  operation: string;
  kind: string;
  outcome: string;
  reason: string | null;
  items: ItemView[];
  count: number | null;
  counts: [string, number][];
  query: string | null;
  recipients: string[];
  approvalId: string | null;
  told: { rule: string; target: string } | null;
}

export interface SessionsView {
  since: string | null;
  sessions: SessionView[];
}

export interface TimelineView {
  session: SessionView;
  lines: LineView[];
  /** More calls matched than core listed. */
  more: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;

function countsOf<K extends string>(value: unknown, names: readonly K[]): Record<K, number> {
  const given = isRecord(value) ? value : {};
  return Object.fromEntries(names.map((name) => [name, whole(given[name]) ?? 0])) as Record<K, number>;
}

/**
 * A session, read: null for one with no key core would make, since its key is what opening it sends back, or with no
 * time it was seen.
 */
function sessionOf(value: unknown): SessionView | null {
  if (!isRecord(value)) return null;
  const key = text(value.key);
  const firstSeen = text(value.firstSeen);
  const lastSeen = text(value.lastSeen);
  if (key === null || !isSessionKey(key) || firstSeen === null || lastSeen === null) return null;
  const client = isRecord(value.client) && typeof value.client.name === 'string' ? value.client : null;
  const counts = isRecord(value.counts) ? value.counts : {};
  return {
    key,
    grouped: value.grouped === true,
    surfaces: strings(value.surfaces),
    folder: text(value.folderShown),
    client: client === null ? null : { name: client.name as string, version: text(client.version) },
    firstSeen,
    lastSeen,
    processes: whole(value.processes) ?? 1,
    channels: strings(value.channels),
    accounts: strings(value.accounts),
    kinds: countsOf(counts.kind, ACTIVITY_KINDS),
    outcomes: countsOf(counts.outcome, ACTIVITY_OUTCOMES),
  };
}

/** `activity sessions --json`, read: null when it is not that answer at all. */
export function readSessions(value: unknown): SessionsView | null {
  if (!isRecord(value) || !Array.isArray(value.sessions)) return null;
  return {
    since: text(value.since),
    sessions: value.sessions.flatMap((each) => sessionOf(each) ?? []),
  };
}

function itemOf(value: unknown): ItemView | null {
  if (!isRecord(value) || typeof value.id !== 'string') return null;
  const from = isRecord(value.from) ? value.from : {};
  return {
    id: value.id,
    subject: text(value.subject),
    fromName: text(from.name),
    fromAddress: text(from.address),
    name: text(value.name),
    size: whole(value.size),
    conversation: text(value.conversation),
  };
}

function lineOf(value: unknown): LineView | null {
  if (!isRecord(value)) return null;
  const at = text(value.at);
  const operation = text(value.operation);
  if (at === null || operation === null) return null;
  const account = isRecord(value.account) ? value.account : {};
  const told = isRecord(value.told) ? value.told : null;
  const counts = isRecord(value.counts) ? value.counts : {};
  return {
    at,
    channel: text(value.channel) ?? '',
    account: { id: text(account.id) ?? '', alias: text(account.alias) ?? '' },
    operation,
    kind: text(value.kind) ?? 'read',
    outcome: text(value.outcome) ?? 'ok',
    reason: text(value.reason),
    items: Array.isArray(value.items) ? value.items.flatMap((each) => itemOf(each) ?? []) : [],
    count: whole(value.count),
    counts: Object.entries(counts).flatMap(([name, count]) => {
      const n = whole(count);
      return n === null ? [] : [[name, n] as [string, number]];
    }),
    query: text(value.query),
    recipients: strings(value.recipients),
    approvalId: text(value.approvalId),
    told: told === null ? null : { rule: text(told.rule) ?? '', target: text(told.target) ?? '' },
  };
}

/** `activity show --json`, read: null when it is not that answer at all. */
export function readTimeline(value: unknown): TimelineView | null {
  if (!isRecord(value) || !Array.isArray(value.lines)) return null;
  const session = sessionOf(value.session);
  if (session === null) return null;
  return {
    session,
    lines: value.lines.flatMap((each) => lineOf(each) ?? []),
    more: value.more === true,
  };
}

// ── The range ──────────────────────────────────────────────────────────────────────────────────────────────────

/** The three ranges the screen offers (§4.5), in its order. */
export type Range = 'today' | '7d' | '30d';

export const RANGES: readonly { value: Range; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
];

/** The start of the person's day, `now`'s local midnight, in whole seconds since the epoch. */
export function startOfToday(now: Date = new Date()): number {
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.floor(midnight.getTime() / 1000);
}

/** A range as the call carries it: today as the start of the person's day, which Rust writes for `--since`. */
export function sinceOf(range: Range, now: Date = new Date()): ActivitySince {
  return range === 'today' ? { today: startOfToday(now) } : range;
}

// ── The filters ────────────────────────────────────────────────────────────────────────────────────────────────

export interface Filters {
  channel: ActivityChannel | null;
  account: string | null;
  kind: ActivityKind | null;
  outcome: ActivityOutcome | null;
}

export const NO_FILTERS: Filters = { channel: null, account: null, kind: null, outcome: null };

/** The channels a session can be filtered by: those it has that `--channel` takes, in the order the app lists them. */
export function filterChannels(session: SessionView): ActivityChannel[] {
  return ACTIVITY_CHANNELS.filter((channel) => session.channels.includes(channel));
}

/** What each kind is called in a filter and a count. */
export const KIND_WORDS: Readonly<Record<ActivityKind, string>> = {
  read: 'Read',
  write: 'Wrote',
  told: 'Told',
  approval: 'Approvals',
};

/** What each outcome is called. */
export const OUTCOME_WORDS: Readonly<Record<ActivityOutcome, string>> = {
  ok: 'Done',
  refused: 'Refused',
  failed: 'Failed',
};

/** A channel's name on screen: core is agent-communications. */
export function channelLabel(channel: string): string {
  if (channel === 'events') return 'Event service';
  return productLabel(channel === '' ? null : channel);
}

// ── Who ran a session ──────────────────────────────────────────────────────────────────────────────────────────

/** Who ran a session, in a few words: its client as it said, the event service, a command, or nobody named. */
export function runnerOf(session: SessionView): { said: string; asTheClientSays: boolean } {
  if (session.client !== null) {
    const said = session.client.version ? `${session.client.name} ${session.client.version}` : session.client.name;
    return { said, asTheClientSays: true };
  }
  if (session.surfaces.includes('daemon')) return { said: 'The event service', asTheClientSays: false };
  if (session.surfaces.length > 0 && session.surfaces.every((surface) => surface === 'cli')) {
    return { said: 'A command', asTheClientSays: false };
  }
  return { said: 'No client named', asTheClientSays: false };
}

// ── A call, in words ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * A run of a line's words: the app's own `text`, a `literal` value set in mono (an id, a query, an address core left
 * bare), or what a sender wrote, `outside`, as it came.
 */
export type Part = { text: string } | { literal: string } | { outside: string };

/**
 * What a line says: a refusal or a failure first (`status`, then the reason in `headline`), with what was refused or
 * failed under it (`detail`); anything else is its headline alone.
 */
export interface LineWords {
  status: 'refused' | 'failed' | null;
  headline: Part[];
  detail: Part[] | null;
}

/**
 * What each operation did, by its capability id (`capabilities.json`): the verb, and what it is said about when the
 * line names nothing itself. An operation this release does not know is said by its last word, or by its id.
 */
const OPERATIONS: Readonly<Record<string, string>> = {
  'gmail.search': 'Searched',
  'gmail.message.read': 'Read',
  'gmail.thread.read': 'Read the thread',
  'gmail.thread.timeline': 'Read the timeline of',
  'gmail.attachments.find': 'Looked for attachments',
  'gmail.attachments.download': 'Downloaded',
  'gmail.attachments.download.answer': 'Downloaded',
  'gmail.contacts.search': 'Searched contacts',
  'gmail.followups': 'Checked follow-ups',
  'gmail.export': 'Exported',
  'gmail.draft.create': 'Drafted',
  'gmail.draft.reply': 'Drafted a reply',
  'gmail.draft.list': 'Listed drafts',
  'gmail.draft.get': 'Read the draft',
  'gmail.draft.update': 'Updated the draft',
  'gmail.draft.delete': 'Deleted the draft',
  'gmail.send.prepare': 'Prepared a send',
  'gmail.send.execute': 'Sent',
  'gmail.send.list': 'Listed sends',
  'gmail.send.cancel': 'Cancelled a send',
  'gmail.send.wait': 'Waited for approval',
  'gmail.organise': 'Organised',
  'gmail.organise.undo': 'Undid organising',
  'gmail.trash': 'Moved to the bin',
  'gmail.label.create': 'Created a label',
  'gmail.labels.list': 'Listed labels',
  'gmail.sendas.list': 'Listed send-as addresses',
  'gmail.whoami': 'Checked the account',
  'resend.emails.list': 'Listed sent emails',
  'resend.emails.show': 'Read the sent email',
  'resend.received.list': 'Listed received emails',
  'resend.received.show': 'Read',
  'resend.received.download': 'Downloaded',
  'resend.metrics': 'Read the metrics',
  'resend.suppressions': 'Listed suppressions',
  'resend.domains': 'Listed domains',
  'resend.send.prepare': 'Prepared a send',
  'resend.send.execute': 'Sent',
  'resend.send.status': 'Checked a send',
  'resend.send.wait': 'Waited for approval',
  'resend.scheduled.list': 'Listed scheduled emails',
  'resend.scheduled.cancel': 'Cancelled a scheduled email',
  'slack.channels': 'Listed channels',
  'slack.read': 'Read',
  'slack.thread': 'Read the thread',
  'slack.search': 'Searched',
  'slack.files': 'Listed files',
  'slack.files.download': 'Downloaded',
  'slack.files.download.answer': 'Downloaded',
  'slack.people': 'Looked up people',
  'slack.draft.create': 'Drafted',
  'slack.draft.update': 'Updated the draft',
  'slack.draft.update.nofiles': 'Updated the draft',
  'slack.draft.list': 'Listed drafts',
  'slack.draft.get': 'Read the draft',
  'slack.draft.delete': 'Deleted the draft',
  'slack.post.prepare': 'Prepared a post',
  'slack.post.send': 'Posted',
  'slack.react': 'Prepared a reaction',
  'slack.react.send': 'Reacted',
  'slack.ack': 'Acknowledged',
  'slack.edit.prepare': 'Prepared an edit',
  'slack.edit.send': 'Edited a message',
  'slack.delete.prepare': 'Prepared a delete',
  'slack.delete.send': 'Deleted a message',
  'slack.approval.wait': 'Waited for approval',
  'whatsapp.chats': 'Listed chats',
  'whatsapp.read': 'Read',
  'whatsapp.search': 'Searched',
  'whatsapp.draft': 'Drafted',
  'whatsapp.sync': 'Synced',
};

/** An operation's last word, when the table has not got it: enough to say what kind of thing it did. */
const LAST_WORDS: Readonly<Record<string, string>> = {
  search: 'Searched',
  read: 'Read',
  get: 'Read',
  show: 'Looked at',
  list: 'Listed',
  find: 'Looked for',
  download: 'Downloaded',
  export: 'Exported',
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  prepare: 'Prepared',
  execute: 'Sent',
  send: 'Sent',
  wait: 'Waited for approval',
  cancel: 'Cancelled',
  approve: 'Approved',
};

/** The verb a line starts with, or null when nothing names one: the screen then shows the operation's id. */
function verbOf(operation: string): string | null {
  const known = OPERATIONS[operation];
  if (known !== undefined) return known;
  const last = operation.split('.').at(-1) ?? '';
  return LAST_WORDS[last] ?? null;
}

const plural = (count: number, one: string, many: string = `${one}s`): string => `${count} ${count === 1 ? one : many}`;

/** A file's size, as a person reads one: bytes, KB or MB. */
export function sizeWords(bytes: number): string {
  if (bytes < 1024) return plural(bytes, 'byte');
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** `a, b and 3 more`: the first two of what a sender wrote, each a part of its own, and how many past them. */
function firstFew(values: string[], total: number): Part[] {
  const shown = values.slice(0, 2);
  const parts: Part[] = [];
  shown.forEach((value, index) => {
    if (index > 0) parts.push({ text: index === shown.length - 1 && total <= shown.length ? ' and ' : ', ' });
    parts.push({ outside: value });
  });
  const rest = total - shown.length;
  if (rest > 0) parts.push({ text: ` and ${rest} more` });
  return parts;
}

/** Who sent an item: their name, else their address, as they wrote it. */
function senderOf(item: ItemView): string | null {
  return item.fromName ?? item.fromAddress;
}

/** The one value every item shares, or null. */
function shared(values: (string | null)[]): string | null {
  const first = values[0];
  if (first === undefined || first === null) return null;
  return values.every((value) => value === first) ? first : null;
}

/** What a call did, in a few words: the verb, what it touched, and how many. */
function actionOf(line: LineView): Part[] {
  const verb = verbOf(line.operation);
  const channel = channelLabel(line.channel);
  const alias = line.account.alias || line.account.id;
  const total = line.count ?? line.items.length;
  if (line.kind === 'approval' || (line.approvalId !== null && line.recipients.length === 0 && verb === null)) {
    return [{ text: `${verb ?? 'Approval'} ` }, ...(line.approvalId === null ? [] : [{ literal: line.approvalId }])];
  }
  if (verb === null) return [{ text: `${channel}: ` }, { literal: line.operation }];
  // A search: what it looked for, where, and what it found.
  if (line.query !== null) {
    // An agent wrote the query, not a sender: it is the app's to show as it is.
    return [
      { text: `${verb} ${channel}${alias ? ` (${alias})` : ''} for ‘${line.query}’` },
      ...(line.count === null ? [] : [{ text: ` — ${plural(line.count, 'result')}` }]),
    ];
  }
  // A send, a draft, a post: who it is to, and what it is about.
  if (line.recipients.length > 0) {
    const subject = shared(line.items.map((item) => item.subject));
    const to: Part[] = [];
    line.recipients.slice(0, 3).forEach((recipient, index) => {
      if (index > 0) to.push({ text: ', ' });
      to.push({ outside: recipient });
    });
    if (line.recipients.length > 3) to.push({ text: ` and ${line.recipients.length - 3} more` });
    return [{ text: `${verb} to ` }, ...to, ...(subject === null ? [] : [{ text: ' — ' }, { outside: subject }])];
  }
  const files = line.items.filter((item) => item.name !== null);
  if (files.length > 0) {
    if (files.length === 1 && total <= 1) {
      const file = files[0] as ItemView;
      return [
        { text: `${verb} ` },
        { outside: file.name as string },
        ...(file.size === null ? [] : [{ text: ` (${sizeWords(file.size)})` }]),
      ];
    }
    return [
      { text: `${verb} ${plural(total, 'file')}: ` },
      ...firstFew(
        files.map((file) => file.name as string),
        total,
      ),
    ];
  }
  const where = shared(line.items.map((item) => item.conversation));
  const inWhere: Part[] = where === null ? [] : [{ text: ' in ' }, { outside: where }];
  const subjects = line.items.filter((item) => item.subject !== null);
  if (subjects.length > 0) {
    const first = subjects[0] as ItemView;
    const one = shared(subjects.map((item) => item.subject));
    if (one !== null) {
      // One subject: a message, or a thread's messages. Who sent it only when it is the one message.
      const from = verb === 'Read' && total <= 1 ? senderOf(first) : null;
      return [
        { text: `${verb} ` },
        { outside: one },
        ...(from === null ? [] : [{ text: ' from ' }, { outside: from }]),
        ...inWhere,
        ...(total > 1 ? [{ text: ` — ${plural(total, 'message')}` }] : []),
      ];
    }
    return [
      { text: verb === 'Read' ? `Read ${plural(total, 'message')}: ` : `${verb} (${plural(total, 'message')}): ` },
      ...firstFew(
        subjects.map((item) => item.subject as string),
        total,
      ),
    ];
  }
  if (line.items.length > 0 && (where !== null || line.items.some((item) => senderOf(item) !== null))) {
    // Messages without a subject — a chat's: how many, and where; from whom only when every one is listed and has
    // one sender, since a call that read more lists only some.
    const from = total <= line.items.length ? shared(line.items.map(senderOf)) : null;
    return [
      { text: `${verb} ${plural(total, 'message')}` },
      ...(from === null ? [] : [{ text: ' from ' }, { outside: from }]),
      ...inWhere,
    ];
  }
  const counted = new Map(line.counts);
  const messages = counted.get('messages');
  const chats = counted.get('chats');
  if (messages !== undefined && chats !== undefined) {
    return [{ text: `${verb} ${plural(messages, 'message')} in ${plural(chats, 'chat')}` }];
  }
  if (line.counts.length > 0) {
    return [{ text: `${verb} — ${line.counts.map(([name, count]) => `${name} ${count}`).join(', ')}` }];
  }
  if (line.count !== null) return [{ text: `${verb} (${line.count})` }];
  return [{ text: verb }];
}

/** A delivery the event service made (S1): how many events, from which rule, to which target. */
function toldOf(line: LineView): Part[] {
  const told = line.told ?? { rule: '', target: '' };
  const events = line.count === null ? 'events' : plural(line.count, 'event');
  return [
    {
      text: `${line.outcome === 'ok' ? 'Delivered' : 'Could not deliver'} ${events} from ‘${told.rule}’ to ${told.target}`,
    },
  ];
}

/**
 * A line in words (§4.5): "Searched Gmail (personal) for ‘invoice’ — 12 results", "Read [Invoice March] from [David]",
 * "Sent to jo@example.com", "Delivered 3 events from ‘David on Slack’ to webhook" — each [part] a sender's, which the
 * screen boxes and marks, so it is told from the app's words without quotes. A refusal or a failure leads with
 * that and its reason, and says what was refused or failed under it.
 */
export function lineWords(line: LineView): LineWords {
  const action = line.kind === 'told' ? toldOf(line) : actionOf(line);
  if (line.outcome === 'ok') return { status: null, headline: action, detail: null };
  const status = line.outcome === 'refused' ? 'refused' : 'failed';
  // A delivery that failed says so itself; its reason goes under it.
  if (line.kind === 'told') {
    return { status, headline: action, detail: line.reason === null ? null : [{ text: line.reason }] };
  }
  return { status, headline: line.reason === null ? [] : [{ text: line.reason }], detail: action };
}

/** What a refusal or a failure is called at the head of its line. */
export const STATUS_WORDS: Readonly<Record<'refused' | 'failed', string>> = {
  refused: 'Refused',
  failed: 'Failed',
};

/** Whether any part of a line's words is a sender's. */
export function hasOutside(words: LineWords): boolean {
  return [...words.headline, ...(words.detail ?? [])].some((part) => 'outside' in part);
}

// ── The timeline, by minute ────────────────────────────────────────────────────────────────────────────────────

export interface Minute {
  /** The minute's start, as an ISO time. */
  at: string;
  lines: LineView[];
}

/** Lines, newest first, grouped by the minute they fall in — in this machine's time — newest minute first. */
export function byMinute(lines: readonly LineView[]): Minute[] {
  const minutes: Minute[] = [];
  for (const line of lines) {
    const time = new Date(line.at);
    const start = Number.isNaN(time.getTime())
      ? line.at
      : new Date(Math.floor(time.getTime() / 60_000) * 60_000).toISOString();
    const last = minutes.at(-1);
    if (last !== undefined && last.at === start) last.lines.push(line);
    else minutes.push({ at: start, lines: [line] });
  }
  return minutes;
}
