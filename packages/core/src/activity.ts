import { execFile } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { access, constants, open, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  type ActivitySettings,
  DEFAULT_ACTIVITY_RETENTION_DAYS,
  isActivityRetention,
  MAX_ACTIVITY_RETENTION_DAYS,
  MIN_ACTIVITY_RETENTION_DAYS,
} from './activity-settings.ts';
import { CONNECTION_ID_ENV, CONNECTION_ID_PATTERN, connectionById, GATEWAY_PID_ENV } from './connections.ts';
import type { Core } from './core.ts';
import { CommsError } from './errors.ts';
import { appendPrivateLine, ensurePrivateDir, FILE_MODE, isGroupOrWorldAccessible, writeFileAtomic } from './fs.ts';

/**
 * The activity log (design 2026-10-25-activity, §4 with S1–S5): one line for every call an agent session makes that
 * reads or writes account data, tied to the session that made it — what it touched, never what it said.
 *
 * - **Where:** `<state>/activity/YYYY-MM-DD.jsonl` (the UTC day of the line), each file owner-only (600) in an
 *   owner-only folder (700), each line appended whole with `appendPrivateLine`, as the audit log's are. Daily files,
 *   so retention drops whole days (`prune`).
 * - **What a line holds:** `ActivityLine`, and nothing else. Every line is rebuilt field by field from the fields a
 *   line has (`activityLineOf`), so a channel that hands over a whole message — body, text, HTML, attachment bytes —
 *   still writes only its id, subject and sender: the type says so, and the copy makes it so. Subjects and names are
 *   kept as received, cut to their bounds, and shown only inside the untrusted-content envelope.
 * - **Never in the way:** `append` never throws into its caller. A line that cannot be written is said once per
 *   process on stderr, remembered for `doctor`, and the call it describes goes on (§4.6).
 * - **The audit log is unchanged.** It stays small, content-free and shareable; this one is private.
 */

// ── What a line is ─────────────────────────────────────────────────────────────────────────────────────────────

/** What the call did with account data: read it, wrote it, was told of it (an event delivery, S1), or approved it. */
export const ACTIVITY_KINDS: readonly ['read', 'write', 'told', 'approval'] = Object.freeze([
  'read',
  'write',
  'told',
  'approval',
] as const);
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** How it ended: done, refused by a policy, an approval or a rule, or failed. */
export const ACTIVITY_OUTCOMES: readonly ['ok', 'refused', 'failed'] = Object.freeze([
  'ok',
  'refused',
  'failed',
] as const);
export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/** Which kind of process recorded it: an MCP server, a CLI call, or the event service's own work. */
export const ACTIVITY_SURFACES: readonly ['mcp', 'cli', 'daemon'] = Object.freeze(['mcp', 'cli', 'daemon'] as const);
export type ActivitySurface = (typeof ACTIVITY_SURFACES)[number];

/** The most items one line lists; past that it lists the first fifty and `count` says how many there were. */
export const MAX_ACTIVITY_ITEMS = 50;
/** How much of a subject a line keeps, in characters. */
export const MAX_SUBJECT_CHARS = 200;
/**
 * The most a line may take as written, its newline included: 16 KiB, well inside the one write `appendPrivateLine`
 * makes of it, so a line is always whole or absent, whatever its items hold. Past it, `fitted` cuts it.
 */
export const MAX_ACTIVITY_LINE_BYTES: number = 16 * 1024;

/** An MCP client's `clientInfo`, as the client reported it: what it said, never proof of what it is (§4.3). */
export interface ClientInfo {
  readonly name: string;
  readonly version?: string | undefined;
}

/** The account a call acted on: its immutable id, and its name at the time. */
export interface ActivityAccount {
  readonly id: string;
  readonly alias: string;
}

/** Who sent a message, as its sender wrote it. */
export interface ActivitySender {
  readonly name?: string | undefined;
  readonly address?: string | undefined;
}

/**
 * One thing a call touched: a message, a thread, a file. Its id, and for a message its subject and sender, for a
 * download its file name and size, for a chat message the conversation it is in. Never a body, a preview or bytes.
 */
export interface ActivityItem {
  readonly id: string;
  readonly subject?: string | undefined;
  readonly from?: ActivitySender | undefined;
  /** A file's name. */
  readonly name?: string | undefined;
  /** A file's size, in bytes. */
  readonly size?: number | undefined;
  /** Where it is: a Slack channel's name, say. */
  readonly conversation?: string | undefined;
}

/** A process as `ps` names it: its id, when it started (as `ps` prints it, an identity rather than a time), its name. */
export interface ActivityParent {
  readonly pid: number;
  readonly startedAt: string;
  readonly name: string;
}

/**
 * Which session made a call (S2). A session is an agent window: the processes one parent started in one folder.
 *
 * - `key` names the session: a hash of the parent's id, its start and the folder when `grouped`; otherwise a key of
 *   this process's own, which no other process shares.
 * - `process` is a random id this process made when it started, and `pid` its process id.
 * - `folder` is the working folder, as a real path (shown with the home as `~` only at display time), or null when it
 *   could not be read.
 * - `parent` is the parent that grouped it — for a CLI call that joined a window, that window's parent.
 * - `ancestors` (CLI calls only) names up to three processes above it, nearest first, so a person typing in a terminal
 *   can be told from an agent's shell.
 */
export interface ActivitySession {
  readonly key: string;
  readonly process: string;
  readonly pid: number;
  readonly client?: ClientInfo | undefined;
  readonly folder: string | null;
  readonly parent?: ActivityParent | undefined;
  readonly ancestors?: readonly string[] | undefined;
  readonly grouped: boolean;
  readonly surface: ActivitySurface;
  /**
   * The MCP connection the call came through (single-server design D11): its id, which the gateway handed the part,
   * and its name at the time, as account aliases are kept. Absent for a call through no gateway.
   */
  readonly connection?: ActivityConnection | undefined;
}

/** A connection, as a line names it: by id, and by the name it had when the line was written. */
export interface ActivityConnection {
  readonly id: string;
  readonly name: string;
}

/** What a `told` line says of a delivery (S1): the rule that matched and the target it reached. No sender, no payload. */
export interface ActivityTold {
  readonly rule: string;
  readonly target: string;
}

/**
 * The message a draft or a send answers (design 2026-10-26-owner-feedback-0320 §3.6): the provider's id of it, and of
 * its thread when known. Ids only — what links a reply to the message it answers, never anything either one says.
 */
export interface ActivityReplyTo {
  readonly messageId: string;
  readonly threadId?: string | undefined;
}

/** What an acknowledgement did (0.32.0): posted a reply, or added a reaction. */
export type ActivityAct = 'reply' | 'reaction';

/**
 * One call, as the log keeps it (§4.2, S1, S2, S4). Content never: what was touched, by id, subject and sender, and
 * how it ended.
 *
 * - `operation` is the capability id (`gmail.search`), `channel` the channel's word (`gmail`).
 * - `items` lists at most fifty things touched; `count` says how many there were in all.
 * - `counts` holds named counts where a channel records no identities (WhatsApp's `chats` and `messages`, S4).
 * - `query` is a search's words — an agent wrote them, not a sender.
 * - `recipients` and `approvalId` are a write's, as the audit records them.
 * - `told` is a delivery's (S1).
 * - `replyTo`, `draftId` and `threadId` link a reply to what it answers (0.32.0 §3.6): the message a reply draft or a
 *   send prepared as a reply answers, the draft a line made, prepared or sent, and the thread a send went into.
 * - `channelId` and `thread` are Slack's (0.32.0 §3.6): the conversation a post went to or a history read read, by its
 *   id — the name a read keeps is not what an event names — and the parent ts a post went into, null for a new message.
 * - `act` is what an acknowledgement did (0.32.0): `reply` or `reaction`.
 */
export interface ActivityLine {
  readonly at: string;
  readonly channel: string;
  readonly account: ActivityAccount;
  readonly operation: string;
  readonly kind: ActivityKind;
  readonly outcome: ActivityOutcome;
  readonly reason?: string | undefined;
  readonly session: ActivitySession;
  readonly ms: number;
  readonly items?: readonly ActivityItem[] | undefined;
  readonly count?: number | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly query?: string | undefined;
  readonly recipients?: readonly string[] | undefined;
  readonly approvalId?: string | undefined;
  readonly told?: ActivityTold | undefined;
  readonly replyTo?: ActivityReplyTo | undefined;
  readonly draftId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly thread?: string | null | undefined;
  readonly act?: ActivityAct | undefined;
  /**
   * The line was cut to `MAX_ACTIVITY_LINE_BYTES`: items, then recipients, dropped from the end, and long words
   * shortened. `count` still says how many items there were.
   */
  readonly truncated?: true | undefined;
}

/** A line to append: `at` is now when left out. */
export type ActivityLineInput = Omit<ActivityLine, 'at'> & { readonly at?: string | undefined };

// ── Bounds ─────────────────────────────────────────────────────────────────────────────────────────────────────

const BOUNDS = {
  id: 200,
  name: 200,
  address: 320,
  fileName: 255,
  conversation: 200,
  query: 500,
  reason: 300,
  word: 100,
  alias: 128,
  folder: 4096,
  startedAt: 64,
  version: 64,
} as const;
const MAX_RECIPIENTS = 50;
const MAX_COUNTS = 10;
const SESSION_KEY = /^[0-9a-f]{16}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
const DAY_MS = 24 * 60 * 60 * 1000;

/** `value` cut to `max` characters — whole characters, never half a surrogate pair — ending in `…` when cut. */
function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (value.length <= max) return value;
  // Read no more than the bound needs: a subject of megabytes is not split into characters whole.
  const chars = Array.from(value.slice(0, max * 2 + 2));
  return chars.length <= max ? chars.join('') : `${chars.slice(0, max - 1).join('')}…`;
}

function whole(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.round(value) : undefined;
}

function isoDay(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function own<T extends object>(value: unknown): T | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as T) : undefined;
}

function itemOf(raw: unknown): ActivityItem | null {
  const item = own<Record<string, unknown>>(raw);
  const id = cut(item?.id, BOUNDS.id);
  if (item === undefined || id === undefined) return null;
  const sender = own<Record<string, unknown>>(item.from);
  const from =
    sender === undefined
      ? undefined
      : {
          ...(typeof sender.name === 'string' ? { name: cut(sender.name, BOUNDS.name) } : {}),
          ...(typeof sender.address === 'string' ? { address: cut(sender.address, BOUNDS.address) } : {}),
        };
  const size = whole(item.size);
  return {
    id,
    ...(typeof item.subject === 'string' ? { subject: cut(item.subject, MAX_SUBJECT_CHARS) } : {}),
    ...(from !== undefined && Object.keys(from).length > 0 ? { from } : {}),
    ...(typeof item.name === 'string' ? { name: cut(item.name, BOUNDS.fileName) } : {}),
    ...(size !== undefined ? { size } : {}),
    ...(typeof item.conversation === 'string' ? { conversation: cut(item.conversation, BOUNDS.conversation) } : {}),
  };
}

function clientOf(raw: unknown): ClientInfo | undefined {
  const client = own<Record<string, unknown>>(raw);
  const name = cut(client?.name, BOUNDS.word);
  if (name === undefined || name === '') return undefined;
  const version = cut(client?.version, BOUNDS.version);
  return { name, ...(version ? { version } : {}) };
}

/** A parent in this exact key order — the order `sessionOfAncestor` finds it by. */
function parentOf(raw: unknown): ActivityParent | undefined {
  const parent = own<Record<string, unknown>>(raw);
  const pid = whole(parent?.pid);
  const startedAt = cut(parent?.startedAt, BOUNDS.startedAt);
  if (pid === undefined || startedAt === undefined) return undefined;
  return { pid, startedAt, name: cut(parent?.name, BOUNDS.word) ?? '' };
}

function sessionOf(raw: unknown): ActivitySession {
  const session = own<Record<string, unknown>>(raw) ?? {};
  const key = typeof session.key === 'string' && SESSION_KEY.test(session.key) ? session.key : null;
  const surface = (ACTIVITY_SURFACES as readonly unknown[]).includes(session.surface)
    ? (session.surface as ActivitySurface)
    : 'mcp';
  const client = clientOf(session.client);
  const parent = parentOf(session.parent);
  const ancestors = Array.isArray(session.ancestors)
    ? session.ancestors.slice(0, 3).flatMap((name) => (typeof name === 'string' ? [cut(name, BOUNDS.word) ?? ''] : []))
    : undefined;
  const connection = connectionOf(session.connection);
  return {
    // A key that is not one is no session's: this line stands alone rather than in someone else's.
    key: key ?? randomKey(),
    process: cut(session.process, BOUNDS.word) ?? PROCESS_ID,
    pid: whole(session.pid) ?? 0,
    ...(client === undefined ? {} : { client }),
    folder: typeof session.folder === 'string' ? (cut(session.folder, BOUNDS.folder) ?? null) : null,
    ...(parent === undefined ? {} : { parent }),
    ...(ancestors === undefined ? {} : { ancestors }),
    grouped: key !== null && session.grouped === true,
    surface,
    ...(connection === undefined ? {} : { connection }),
  };
}

/** A connection a line names, kept only with an id that is a connection's and a name. */
function connectionOf(raw: unknown): ActivityConnection | undefined {
  const connection = own<Record<string, unknown>>(raw);
  const id = connection?.id;
  const name = cut(connection?.name, BOUNDS.name);
  if (typeof id !== 'string' || !CONNECTION_ID_PATTERN.test(id) || name === undefined || name === '') return undefined;
  return { id, name };
}

/**
 * The line as it is written: every field copied from what a line has, each cut to its bound, in one fixed order.
 * Anything else the input carries — a body, a text, an HTML part, bytes — is not copied, whatever it is called.
 */
export function activityLineOf(input: ActivityLineInput, now: Date = new Date()): ActivityLine {
  return fitted(boundedLine(input, now));
}

/** How many bytes a line takes as written, its newline included. */
function bytesOf(line: ActivityLine): number {
  return Buffer.byteLength(JSON.stringify(line)) + 1;
}

/**
 * The line, cut until it fits in `MAX_ACTIVITY_LINE_BYTES`, and marked `truncated` when it was: items from the end
 * first — `count` keeps how many there were — then recipients from the end, then the longer words shortened, and
 * last the words that are not the line's own dropped. Text a sender wrote can be many times its length as JSON (a
 * control character is six bytes), so the bounds on each field alone do not bound the line.
 */
function fitted(line: ActivityLine): ActivityLine {
  if (bytesOf(line) <= MAX_ACTIVITY_LINE_BYTES) return line;
  const items = [...(line.items ?? [])];
  const recipients = [...(line.recipients ?? [])];
  let cutLine: ActivityLine = { ...line, truncated: true };
  const fits = () => bytesOf(cutLine) <= MAX_ACTIVITY_LINE_BYTES;
  while (items.length > 0 && !fits()) {
    items.pop();
    cutLine = { ...cutLine, items: [...items] };
  }
  while (recipients.length > 0 && !fits()) {
    recipients.pop();
    cutLine = { ...cutLine, recipients: [...recipients] };
  }
  if (fits()) return cutLine;
  const short = (text: string | undefined, max: number) => (text === undefined ? undefined : cut(text, max));
  const { ancestors: _ancestors, ...session } = cutLine.session;
  cutLine = {
    ...cutLine,
    channel: short(cutLine.channel, 40) ?? '',
    operation: short(cutLine.operation, 64) ?? '',
    account: { id: short(cutLine.account.id, 64) ?? '', alias: short(cutLine.account.alias, 64) ?? '' },
    session: {
      ...session,
      folder: cutLine.session.folder === null ? null : (short(cutLine.session.folder, 256) ?? null),
      ...(session.client === undefined
        ? {}
        : {
            client: {
              name: short(session.client.name, 40) ?? '',
              ...(session.client.version === undefined ? {} : { version: short(session.client.version, 20) }),
            },
          }),
      ...(session.parent === undefined
        ? {}
        : { parent: { ...session.parent, name: short(session.parent.name, 40) ?? '' } }),
    },
    ...(cutLine.reason === undefined ? {} : { reason: short(cutLine.reason, 100) }),
    ...(cutLine.query === undefined ? {} : { query: short(cutLine.query, 100) }),
    ...(cutLine.told === undefined
      ? {}
      : { told: { rule: short(cutLine.told.rule, 60) ?? '', target: short(cutLine.told.target, 60) ?? '' } }),
  };
  if (fits()) return cutLine;
  const { reason: _reason, query: _query, told: _told, counts: _counts, ...rest } = cutLine;
  return { ...rest, truncated: true };
}

/**
 * A provider's id as a link field keeps one: a string of id characters, at most `BOUNDS.id` long — never a word with
 * spaces or markup in it, so a link can never carry what a sender wrote. Undefined for anything else.
 */
function providerId(value: unknown): string | undefined {
  return typeof value === 'string' && value.length <= BOUNDS.id && /^[A-Za-z0-9._:/@+=-]+$/.test(value)
    ? value
    : undefined;
}

/** `replyTo` as a line keeps it: a message id, and its thread's when there is one; undefined without a message id. */
function replyToOf(raw: unknown): ActivityReplyTo | undefined {
  const link = own<Record<string, unknown>>(raw);
  const messageId = providerId(link?.messageId);
  if (messageId === undefined) return undefined;
  const threadId = providerId(link?.threadId);
  return { messageId, ...(threadId === undefined ? {} : { threadId }) };
}

/** The line every field of it bounded, before the line as a whole is (`fitted`). */
function boundedLine(input: ActivityLineInput, now: Date): ActivityLine {
  const raw = input as unknown as Record<string, unknown>;
  const at = typeof raw.at === 'string' && ISO_TIME.test(raw.at) ? raw.at : now.toISOString();
  const account = own<Record<string, unknown>>(raw.account);
  const items = Array.isArray(raw.items) ? raw.items : undefined;
  const kept = items?.slice(0, MAX_ACTIVITY_ITEMS).flatMap((item) => itemOf(item) ?? []);
  const given = whole(raw.count);
  const count = items === undefined ? given : Math.max(items.length, given ?? 0);
  const counts = own<Record<string, unknown>>(raw.counts);
  const keptCounts =
    counts === undefined
      ? undefined
      : Object.fromEntries(
          Object.entries(counts)
            .filter(([name, value]) => /^[a-z][A-Za-z]{0,31}$/.test(name) && whole(value) !== undefined)
            .slice(0, MAX_COUNTS)
            .map(([name, value]) => [name, whole(value) as number]),
        );
  const recipients = Array.isArray(raw.recipients)
    ? raw.recipients
        .slice(0, MAX_RECIPIENTS)
        .flatMap((address) => (typeof address === 'string' ? [cut(address, BOUNDS.address) as string] : []))
    : undefined;
  const told = own<Record<string, unknown>>(raw.told);
  const reason = cut(raw.reason, BOUNDS.reason);
  const query = cut(raw.query, BOUNDS.query);
  const approvalId =
    typeof raw.approvalId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(raw.approvalId) ? raw.approvalId : undefined;
  const replyTo = replyToOf(raw.replyTo);
  const draftId = providerId(raw.draftId);
  const threadId = providerId(raw.threadId);
  const channelId = providerId(raw.channelId);
  // Null is a statement — a new message, in no thread — and kept as one; anything else that is not an id goes.
  const thread = raw.thread === null ? null : providerId(raw.thread);
  const act = raw.act === 'reply' || raw.act === 'reaction' ? (raw.act as ActivityAct) : undefined;
  return {
    at,
    channel: cut(raw.channel, BOUNDS.word) ?? '',
    account: { id: cut(account?.id, BOUNDS.alias) ?? '', alias: cut(account?.alias, BOUNDS.alias) ?? '' },
    operation: cut(raw.operation, BOUNDS.word) ?? '',
    kind: (ACTIVITY_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as ActivityKind) : 'read',
    outcome: (ACTIVITY_OUTCOMES as readonly unknown[]).includes(raw.outcome) ? (raw.outcome as ActivityOutcome) : 'ok',
    ...(reason ? { reason } : {}),
    session: sessionOf(raw.session),
    ms: whole(raw.ms) ?? 0,
    ...(kept === undefined ? {} : { items: kept }),
    ...(count === undefined ? {} : { count }),
    ...(keptCounts === undefined || Object.keys(keptCounts).length === 0 ? {} : { counts: keptCounts }),
    ...(query === undefined ? {} : { query }),
    ...(recipients === undefined ? {} : { recipients }),
    ...(approvalId === undefined ? {} : { approvalId }),
    ...(told === undefined
      ? {}
      : { told: { rule: cut(told.rule, BOUNDS.name) ?? '', target: cut(told.target, BOUNDS.name) ?? '' } }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(draftId === undefined ? {} : { draftId }),
    ...(threadId === undefined ? {} : { threadId }),
    ...(channelId === undefined ? {} : { channelId }),
    ...(thread === undefined ? {} : { thread }),
    ...(act === undefined ? {} : { act }),
    ...(raw.truncated === true ? { truncated: true as const } : {}),
  };
}

/** A line read back from a file: one this release can show, or null for anything else. */
function readLine(text: string): ActivityLine | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const line = own<Record<string, unknown>>(raw);
  if (line === undefined || typeof line.at !== 'string' || !ISO_TIME.test(line.at)) return null;
  const session = own<Record<string, unknown>>(line.session);
  if (typeof session?.key !== 'string' || !SESSION_KEY.test(session.key)) return null;
  // Rebuilt as it was written: a hand edit to the file adds nothing a line does not have.
  return activityLineOf(line as unknown as ActivityLineInput);
}

// ── Sessions, summarised ───────────────────────────────────────────────────────────────────────────────────────

/** How many lines of each kind, and of each outcome. */
export interface ActivityCounts {
  readonly kind: Readonly<Record<ActivityKind, number>>;
  readonly outcome: Readonly<Record<ActivityOutcome, number>>;
}

/**
 * One session as `sessions` lists it: where and by what it ran, when it was first and last seen, how many processes
 * recorded lines for it, and its counts by kind and outcome. Its folder, client and parent are those of its first
 * server process — or of its first line, when only CLI calls recorded any.
 */
export interface ActivitySessionSummary {
  readonly key: string;
  readonly grouped: boolean;
  readonly surfaces: readonly ActivitySurface[];
  readonly folder: string | null;
  readonly client: ClientInfo | null;
  readonly parent: ActivityParent | null;
  readonly firstSeen: string;
  readonly lastSeen: string;
  readonly processes: number;
  readonly channels: readonly string[];
  readonly accounts: readonly string[];
  readonly counts: ActivityCounts;
}

/** What a session's lines add up to, in a form two days' worth can be added together. */
interface Aggregate {
  key: string;
  grouped: boolean;
  surfaces: ActivitySurface[];
  /** The line its folder, client and parent come from: the first of a server process, or the first at all. */
  primary: {
    at: string;
    cli: boolean;
    folder: string | null;
    client: ClientInfo | null;
    parent: ActivityParent | null;
  };
  firstSeen: string;
  lastSeen: string;
  processes: string[];
  channels: string[];
  accounts: string[];
  kind: Record<ActivityKind, number>;
  outcome: Record<ActivityOutcome, number>;
}

function emptyKinds(): Record<ActivityKind, number> {
  return { read: 0, write: 0, told: 0, approval: 0 };
}

function emptyOutcomes(): Record<ActivityOutcome, number> {
  return { ok: 0, refused: 0, failed: 0 };
}

function aggregateOf(line: ActivityLine): Aggregate {
  const kind = emptyKinds();
  kind[line.kind] += 1;
  const outcome = emptyOutcomes();
  outcome[line.outcome] += 1;
  return {
    key: line.session.key,
    grouped: line.session.grouped,
    surfaces: [line.session.surface],
    primary: {
      at: line.at,
      cli: line.session.surface === 'cli',
      folder: line.session.folder,
      client: line.session.client ?? null,
      parent: line.session.parent ?? null,
    },
    firstSeen: line.at,
    lastSeen: line.at,
    processes: [line.session.process],
    channels: line.channel ? [line.channel] : [],
    accounts: line.account.alias ? [line.account.alias] : [],
    kind,
    outcome,
  };
}

function union<T>(a: readonly T[], b: readonly T[]): T[] {
  return [...new Set([...a, ...b])];
}

/** Two aggregates of one session, added together. */
function merge(a: Aggregate, b: Aggregate): Aggregate {
  // A server process's line names the window; among those, or among CLI lines, the earliest.
  const first = (x: Aggregate['primary'], y: Aggregate['primary']) =>
    x.cli !== y.cli ? (x.cli ? y : x) : x.at <= y.at ? x : y;
  const primary = first(a.primary, b.primary);
  const other = primary === a.primary ? b.primary : a.primary;
  const kind = emptyKinds();
  const outcome = emptyOutcomes();
  for (const name of ACTIVITY_KINDS) kind[name] = a.kind[name] + b.kind[name];
  for (const name of ACTIVITY_OUTCOMES) outcome[name] = a.outcome[name] + b.outcome[name];
  return {
    key: a.key,
    grouped: a.grouped || b.grouped,
    surfaces: union(a.surfaces, b.surfaces),
    primary: { ...primary, client: primary.client ?? other.client, parent: primary.parent ?? other.parent },
    firstSeen: a.firstSeen <= b.firstSeen ? a.firstSeen : b.firstSeen,
    lastSeen: a.lastSeen >= b.lastSeen ? a.lastSeen : b.lastSeen,
    processes: union(a.processes, b.processes),
    channels: union(a.channels, b.channels),
    accounts: union(a.accounts, b.accounts),
    kind,
    outcome,
  };
}

function add(groups: Map<string, Aggregate>, aggregate: Aggregate): void {
  const held = groups.get(aggregate.key);
  groups.set(aggregate.key, held === undefined ? aggregate : merge(held, aggregate));
}

function summaryOf(aggregate: Aggregate): ActivitySessionSummary {
  return {
    key: aggregate.key,
    grouped: aggregate.grouped,
    surfaces: [...aggregate.surfaces].sort(),
    folder: aggregate.primary.folder,
    client: aggregate.primary.client,
    parent: aggregate.primary.parent,
    firstSeen: aggregate.firstSeen,
    lastSeen: aggregate.lastSeen,
    processes: aggregate.processes.length,
    channels: [...aggregate.channels].sort(),
    accounts: [...aggregate.accounts].sort(),
    counts: { kind: { ...aggregate.kind }, outcome: { ...aggregate.outcome } },
  };
}

/** A day's aggregates read back from its index: trusted only as far as their shape, and dropped whole otherwise. */
function aggregatesOf(raw: unknown): Aggregate[] | null {
  if (!Array.isArray(raw)) return null;
  const strings = (value: unknown) => Array.isArray(value) && value.every((each) => typeof each === 'string');
  for (const each of raw) {
    const held = own<Aggregate>(each);
    if (
      held === undefined ||
      typeof held.key !== 'string' ||
      !SESSION_KEY.test(held.key) ||
      typeof held.firstSeen !== 'string' ||
      typeof held.lastSeen !== 'string' ||
      own(held.primary) === undefined ||
      own(held.kind) === undefined ||
      own(held.outcome) === undefined ||
      !strings(held.processes) ||
      !strings(held.channels) ||
      !strings(held.accounts) ||
      !strings(held.surfaces)
    ) {
      return null;
    }
  }
  return raw as Aggregate[];
}

// ── The log ────────────────────────────────────────────────────────────────────────────────────────────────────

/** A line that could not be written: when, why, and which process — never anything the line held. */
export interface ActivityFailure {
  readonly at: string;
  readonly code: string;
  readonly message: string;
  readonly pid: number;
}

/** What `doctor` reads of the log: where it is, whether it is private and writable, and the last failure. */
export interface ActivityHealth {
  readonly directory: string;
  /** False when nothing was recorded yet. */
  readonly exists: boolean;
  /** False when something that is not a folder stands where it goes. */
  readonly isDirectory: boolean;
  /** Whether only its owner can read it; null where that cannot be told (Windows), or before it exists. */
  readonly private: boolean | null;
  /** Whether today's file can be written: the file when it exists, its folder otherwise. */
  readonly writable: boolean;
  /** The days held, oldest first. */
  readonly days: readonly string[];
  /** When a line was last written, from the newest file's time; null when there is none. */
  readonly lastWritten: string | null;
  /** The last failure any process recorded, or this one remembers. */
  readonly failure: ActivityFailure | null;
}

/** What `show` filters by. `account` is a name or an id; `since` an ISO time. */
export interface ActivityFilters {
  readonly kind?: ActivityKind | undefined;
  readonly channel?: string | undefined;
  readonly account?: string | undefined;
  readonly outcome?: ActivityOutcome | undefined;
  readonly since?: string | undefined;
  /** The most lines to return, newest first: 1000 when left out. */
  readonly limit?: number | undefined;
}

/** One session's lines, newest first, filtered; and what all of its lines in the time asked add up to. */
export interface ActivityShown {
  readonly lines: ActivityLine[];
  /** True when more lines matched than `limit`. */
  readonly more: boolean;
  /** The session over the time asked, before the other filters; null when it has no line there at all. */
  readonly summary: ActivitySessionSummary | null;
}

export interface ActivityLogOptions {
  now?: (() => Date) | undefined;
  /**
   * The settings in force, read afresh for every line, so turning recording off applies at once in every process.
   * Left out, on and 30 days. A reader that throws — a configuration that cannot be read — is read as off.
   */
  settings?: (() => Promise<ActivitySettings>) | undefined;
  /** Where the once-a-process line about a failure goes: stderr when left out. */
  warn?: ((line: string) => void) | undefined;
}

const FAILURE_FILE = 'activity-failure.json';
const INDEX_DIR = '.index';
/**
 * Each day's server windows: one small line for each server process's window on that day — its key, parent and
 * folder — so a CLI call finds the window it runs in without reading the day (`sessionOfAncestor`).
 */
const PARENTS_DIR = '.parents';
const DEFAULT_SHOW_LIMIT = 1000;
const ON_BY_DEFAULT: ActivitySettings = Object.freeze({
  record: 'on',
  retentionDays: DEFAULT_ACTIVITY_RETENTION_DAYS,
  problems: [],
});
const UNREADABLE: ActivitySettings = Object.freeze({
  record: 'off',
  retentionDays: MAX_ACTIVITY_RETENTION_DAYS,
  problems: ['the configuration could not be read, so nothing is recorded'],
});

/** The once-a-process line, when the stderr default is used: one process, one line, however many logs it opens. */
let warnedOnStderr = false;

function codeOf(error: unknown): string {
  if (error instanceof CommsError) return error.code;
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' ? code : 'error';
}

function messageOf(error: unknown): string {
  return cut(error instanceof Error ? error.message : String(error), BOUNDS.reason) ?? 'unknown';
}

export class ActivityLog {
  readonly directory: string;
  readonly #failureFile: string;
  readonly #now: () => Date;
  readonly #settings: () => Promise<ActivitySettings>;
  readonly #warn: ((line: string) => void) | undefined;
  #failure: ActivityFailure | null = null;
  #failureWrittenAt = 0;
  #warned = false;
  #prunedDay: string | null = null;
  /** The days this process has made sure of a parents file for, and the windows it has noted there, by day. */
  readonly #parentsReady = new Set<string>();
  readonly #parentsNoted = new Set<string>();

  constructor(stateDir: string, options: ActivityLogOptions = {}) {
    this.directory = join(stateDir, 'activity');
    this.#failureFile = join(stateDir, FAILURE_FILE);
    this.#now = options.now ?? (() => new Date());
    this.#settings = options.settings ?? (async () => ON_BY_DEFAULT);
    this.#warn = options.warn;
  }

  /** The last line this process could not write, or null. */
  get lastFailure(): ActivityFailure | null {
    return this.#failure;
  }

  /**
   * Appends one line, unless recording is off. True when it was written. Never throws: a line that cannot be written
   * is said once per process (`warn`, stderr by default), recorded beside the log for `doctor`, and returns false.
   *
   * The first call a process makes on each day — this, or any read — first prunes days older than the retention in
   * force, whether or not recording is on: the log's daily maintenance, best effort.
   */
  async append(input: ActivityLineInput): Promise<boolean> {
    const settings = await this.#maintained();
    if (settings.record !== 'on') return false;
    try {
      const line = activityLineOf(input, this.#now());
      await appendPrivateLine(join(this.directory, `${line.at.slice(0, 10)}.jsonl`), JSON.stringify(line));
      await this.#noteParent(line);
      if (this.#failure !== null) {
        // Recording again: what this process recorded of its failure is no longer true.
        this.#failure = null;
        await rm(this.#failureFile, { force: true }).catch(() => undefined);
      }
    } catch (error) {
      await this.#failed(error);
      return false;
    }
    return true;
  }

  async #failed(error: unknown): Promise<void> {
    const now = this.#now();
    const failure: ActivityFailure = {
      at: now.toISOString(),
      code: codeOf(error),
      message: messageOf(error),
      pid: process.pid,
    };
    this.#failure = failure;
    const said = `agent-communications: activity is not being recorded: ${failure.message}`;
    if (this.#warn !== undefined) {
      if (!this.#warned) this.#warn(said);
    } else if (!warnedOnStderr) {
      warnedOnStderr = true;
      process.stderr.write(`${said}\n`);
    }
    this.#warned = true;
    // Beside the log rather than in it, which may be what cannot be written; at most once a minute a process.
    if (now.getTime() - this.#failureWrittenAt < 60_000) return;
    this.#failureWrittenAt = now.getTime();
    await writeFileAtomic(this.#failureFile, `${JSON.stringify(failure)}\n`).catch(() => undefined);
  }

  /**
   * The day's parents file, made on a process's first line of the day — so a reader can tell a day with no window
   * from one an earlier build wrote, with no index — and a grouped server's window noted in it once a day. Best
   * effort: without it a CLI call reads the day itself.
   */
  async #noteParent(line: ActivityLine): Promise<void> {
    const day = line.at.slice(0, 10);
    const path = join(this.directory, PARENTS_DIR, `${day}.jsonl`);
    try {
      if (!this.#parentsReady.has(day)) {
        await ensurePrivateDir(join(this.directory, PARENTS_DIR));
        await (await open(path, 'a', FILE_MODE)).close();
        this.#parentsReady.add(day);
      }
      const { session } = line;
      if (session.surface !== 'mcp' || !session.grouped || session.parent === undefined) return;
      const noted = `${day}\0${session.key}`;
      if (this.#parentsNoted.has(noted)) return;
      await appendPrivateLine(
        path,
        JSON.stringify({ key: session.key, parent: session.parent, folder: session.folder }),
      );
      this.#parentsNoted.add(noted);
    } catch {
      // The day is still read the old way.
    }
  }

  /** The windows noted on `day`, or null when the day has no parents file (an earlier build wrote it, or none). */
  async #parentsOf(day: string): Promise<{ key: string; parent: ActivityParent; folder: string | null }[] | null> {
    let text: string;
    try {
      text = await readFile(join(this.directory, PARENTS_DIR, `${day}.jsonl`), 'utf8');
    } catch {
      return null;
    }
    return text.split('\n').flatMap((raw) => {
      if (!raw) return [];
      try {
        const held = own<Record<string, unknown>>(JSON.parse(raw));
        const parent = parentOf(held?.parent);
        const key = held?.key;
        if (typeof key !== 'string' || !SESSION_KEY.test(key) || parent === undefined) return [];
        return [{ key, parent, folder: typeof held?.folder === 'string' ? held.folder : null }];
      } catch {
        return [];
      }
    });
  }

  /** The settings in force, read afresh; a reader that throws reads as `UNREADABLE` — off, and every day kept. */
  async #settingsNow(): Promise<ActivitySettings> {
    try {
      return await this.#settings();
    } catch {
      return UNREADABLE;
    }
  }

  /**
   * The settings in force, after the day's maintenance: the first call a process makes on a day — an append or a read,
   * recording on or off — deletes the days past the retention. Never throws.
   */
  async #maintained(): Promise<ActivitySettings> {
    const settings = await this.#settingsNow();
    const today = isoDay(this.#now().getTime());
    if (this.#prunedDay !== today) {
      this.#prunedDay = today;
      await this.prune(settings.retentionDays).catch(() => undefined);
    }
    return settings;
  }

  /** The first day the retention in force keeps: any day before it is never shown, deleted yet or not. */
  #cutoff(retentionDays: number): string {
    return isoDay(this.#now().getTime() - retentionDays * DAY_MS);
  }

  /** The days held, oldest first. */
  async days(): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.directory);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return [];
      throw error;
    }
    return names.flatMap((name) => DAY_FILE.exec(name)?.[1] ?? []).sort();
  }

  /**
   * Deletes every day whose last line is older than `retentionDays` days: a day goes once all of it is that old, so
   * every line is kept at least that long and at most a day longer. Whole days only; every other day is left whole.
   */
  async prune(retentionDays: number): Promise<{ deleted: string[] }> {
    if (!isActivityRetention(retentionDays)) {
      throw new CommsError(
        'USAGE',
        `the activity log keeps a whole number of days, ${MIN_ACTIVITY_RETENTION_DAYS} to ${MAX_ACTIVITY_RETENTION_DAYS}, not ${String(retentionDays)}`,
      );
    }
    const cutoff = this.#cutoff(retentionDays);
    const deleted: string[] = [];
    for (const day of await this.days()) {
      if (day >= cutoff) continue;
      await rm(join(this.directory, `${day}.jsonl`), { force: true });
      await rm(join(this.directory, INDEX_DIR, `${day}.json`), { force: true }).catch(() => undefined);
      await rm(join(this.directory, PARENTS_DIR, `${day}.jsonl`), { force: true }).catch(() => undefined);
      deleted.push(day);
    }
    return { deleted };
  }

  async #lines(day: string): Promise<ActivityLine[]> {
    const text = await this.#text(day);
    return text === null ? [] : text.split('\n').flatMap((raw) => (raw ? (readLine(raw) ?? []) : []));
  }

  async #text(day: string): Promise<string | null> {
    try {
      return await readFile(join(this.directory, `${day}.jsonl`), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
  }

  /**
   * A whole past day's sessions, from its index when the index was made from the file as it is now, else from the
   * file — and the index written again, best effort. Today's is never indexed: it is still being written.
   */
  async #dayAggregates(day: string): Promise<Aggregate[]> {
    const file = join(this.directory, `${day}.jsonl`);
    const index = join(this.directory, INDEX_DIR, `${day}.json`);
    let mark: string;
    try {
      const info = await stat(file);
      mark = `${info.size}:${info.mtimeMs}`;
    } catch {
      return [];
    }
    try {
      const held = JSON.parse(await readFile(index, 'utf8')) as {
        version?: unknown;
        mark?: unknown;
        sessions?: unknown;
      };
      const sessions = held.version === 1 && held.mark === mark ? aggregatesOf(held.sessions) : null;
      if (sessions !== null) return sessions;
    } catch {
      // No index yet, or one that cannot be read: made again below.
    }
    const groups = new Map<string, Aggregate>();
    for (const line of await this.#lines(day)) add(groups, aggregateOf(line));
    const sessions = [...groups.values()];
    await writeFileAtomic(index, `${JSON.stringify({ version: 1, mark, sessions })}\n`).catch(() => undefined);
    return sessions;
  }

  /**
   * Every session with a line at or after `since` (every day the retention keeps, when left out), newest first. A day
   * past the retention is never read, whether or not it has been deleted yet.
   */
  async sessions(options: { since?: string | undefined } = {}): Promise<ActivitySessionSummary[]> {
    const since = options.since;
    const today = isoDay(this.#now().getTime());
    const cutoff = this.#cutoff((await this.#maintained()).retentionDays);
    const groups = new Map<string, Aggregate>();
    for (const day of await this.days()) {
      if (day < cutoff) continue;
      if (since !== undefined && `${day}T23:59:59.999Z` < since) continue;
      const whole = since === undefined || since <= `${day}T00:00:00.000Z`;
      if (whole && day < today) {
        for (const aggregate of await this.#dayAggregates(day)) add(groups, aggregate);
        continue;
      }
      for (const line of await this.#lines(day)) {
        if (since === undefined || line.at >= since) add(groups, aggregateOf(line));
      }
    }
    return [...groups.values()]
      .map(summaryOf)
      .sort((a, b) => (a.lastSeen === b.lastSeen ? a.key.localeCompare(b.key) : a.lastSeen < b.lastSeen ? 1 : -1));
  }

  /**
   * One session's lines, newest first, that match every filter given; and its summary over the time asked. Only
   * lines whose session key is exactly `key` are ever read into the answer, and none of a day past the retention.
   */
  async show(key: string, filters: ActivityFilters = {}): Promise<ActivityShown> {
    if (!SESSION_KEY.test(key)) throw new CommsError('USAGE', `"${cut(key, 40)}" is not a session key`);
    const cutoff = this.#cutoff((await this.#maintained()).retentionDays);
    const limit = filters.limit ?? DEFAULT_SHOW_LIMIT;
    const since = filters.since;
    // A session key is hex, and a quote inside any string a line holds is written `\"`: this finds only the key.
    const needle = `"key":"${key}"`;
    const lines: ActivityLine[] = [];
    let matched = 0;
    let summary: Aggregate | null = null;
    const days = (await this.days()).filter((day) => day >= cutoff).reverse();
    for (const day of days) {
      if (since !== undefined && `${day}T23:59:59.999Z` < since) break;
      const text = await this.#text(day);
      if (text === null) continue;
      const raws = text.split('\n');
      for (let index = raws.length - 1; index >= 0; index -= 1) {
        const raw = raws[index] as string;
        if (!raw.includes(needle)) continue;
        const line = readLine(raw);
        if (line === null || line.session.key !== key) continue;
        if (since !== undefined && line.at < since) continue;
        const aggregate = aggregateOf(line);
        summary = summary === null ? aggregate : merge(summary, aggregate);
        if (!matches(line, filters)) continue;
        lines.push(line);
        matched += 1;
        // The newest `limit` by time, not the first met: two processes append to one file out of order. Kept to twice
        // the limit as it goes, so a long session is never held whole.
        if (lines.length >= limit * 2) {
          lines.sort(newestFirst);
          lines.length = limit;
        }
      }
    }
    lines.sort(newestFirst);
    if (lines.length > limit) lines.length = limit;
    return { lines, more: matched > limit, summary: summary === null ? null : summaryOf(summary) };
  }

  /**
   * Every session's lines at or after `since` (every day the retention keeps, when left out), oldest first: the
   * person's view, which `activity items` groups by what each line names (0.32.0 §3.6). None of a day past the
   * retention is ever read. `mention` is a quick look before a line is read whole: only lines whose text holds one of
   * those words are read — the caller still decides what each line names.
   */
  async linesSince(
    options: { since?: string | undefined; mention?: readonly string[] | undefined } = {},
  ): Promise<ActivityLine[]> {
    const cutoff = this.#cutoff((await this.#maintained()).retentionDays);
    const { since, mention } = options;
    const found: ActivityLine[] = [];
    for (const day of await this.days()) {
      if (day < cutoff) continue;
      if (since !== undefined && `${day}T23:59:59.999Z` < since) continue;
      const text = await this.#text(day);
      if (text === null) continue;
      for (const raw of text.split('\n')) {
        if (!raw) continue;
        if (mention !== undefined && !mention.some((word) => raw.includes(word))) continue;
        const line = readLine(raw);
        if (line === null || (since !== undefined && line.at < since)) continue;
        found.push(line);
      }
    }
    // Two processes append to one file out of order: by time, and lines of one time in the order they were met.
    return found.sort((a, b) => (a.at === b.at ? 0 : a.at < b.at ? -1 : 1));
  }

  /**
   * The window a CLI call belongs to (S2): the session of a server process, today or yesterday, whose parent is one of
   * `ancestors` — the nearest first. Null when none is. Read from each day's parents file; a day with none — written
   * by an earlier build — is read whole, as before.
   */
  async sessionOfAncestor(
    ancestors: readonly ActivityParent[],
  ): Promise<{ key: string; parent: ActivityParent; folder: string | null } | null> {
    const now = this.#now().getTime();
    const noted: { key: string; parent: ActivityParent; folder: string | null }[] = [];
    const texts: string[] = [];
    for (const day of [isoDay(now), isoDay(now - DAY_MS)]) {
      const parents = await this.#parentsOf(day);
      if (parents !== null) {
        noted.push(...parents);
        continue;
      }
      const text = await this.#text(day).catch(() => null);
      if (text !== null) texts.push(text);
    }
    for (const ancestor of ancestors) {
      const found = noted.find(
        (each) => each.parent.pid === ancestor.pid && each.parent.startedAt === ancestor.startedAt,
      );
      if (found !== undefined) return found;
      // In the order `parentOf` writes a parent's keys; the start is JSON, so its quotes cannot end it early.
      const needle = `"parent":{"pid":${ancestor.pid},"startedAt":${JSON.stringify(ancestor.startedAt)}`;
      for (const text of texts) {
        let from = text.indexOf(needle);
        while (from !== -1) {
          const start = text.lastIndexOf('\n', from) + 1;
          const end = text.indexOf('\n', from);
          const line = readLine(text.slice(start, end === -1 ? text.length : end));
          const parent = line?.session.parent;
          if (
            line?.session.grouped &&
            line.session.surface === 'mcp' &&
            parent?.pid === ancestor.pid &&
            parent.startedAt === ancestor.startedAt
          ) {
            return { key: line.session.key, parent, folder: line.session.folder };
          }
          from = text.indexOf(needle, from + needle.length);
        }
      }
    }
    return null;
  }

  /** The last failure recorded by any process — the newer of the file beside the log and this process's own. */
  async readFailure(): Promise<ActivityFailure | null> {
    let stored: ActivityFailure | null = null;
    try {
      const raw = own<Record<string, unknown>>(JSON.parse(await readFile(this.#failureFile, 'utf8')));
      if (raw !== undefined && typeof raw.at === 'string' && ISO_TIME.test(raw.at)) {
        stored = {
          at: raw.at,
          code: cut(raw.code, BOUNDS.word) ?? 'error',
          message: cut(raw.message, BOUNDS.reason) ?? 'unknown',
          pid: whole(raw.pid) ?? 0,
        };
      }
    } catch {
      // None recorded, or one that cannot be read: nothing to report from it.
    }
    const mine = this.#failure;
    if (mine === null) return stored;
    if (stored === null) return mine;
    return mine.at >= stored.at ? mine : stored;
  }

  /**
   * What `doctor` shows of the log. It creates nothing; like every read it first deletes the days past the retention,
   * once a day per process, so the days it lists past the retention are those that could not be deleted.
   */
  async health(): Promise<ActivityHealth> {
    await this.#maintained();
    const today = isoDay(this.#now().getTime());
    let exists = false;
    let isDirectory = true;
    try {
      const info = await stat(this.directory);
      exists = true;
      isDirectory = info.isDirectory();
    } catch {
      // Not there yet: made by the first line.
    }
    const days = exists && isDirectory ? await this.days().catch(() => []) : [];
    let lastWritten: string | null = null;
    const newest = days.at(-1);
    if (newest !== undefined) {
      lastWritten = await stat(join(this.directory, `${newest}.jsonl`)).then(
        (info) => info.mtime.toISOString(),
        () => null,
      );
    }
    // Today's file when there is one; else the folder it goes in; else the state folder that folder is made in — and
    // when even that is not there yet, the first line makes both.
    const state = join(this.directory, '..');
    const target = days.includes(today)
      ? join(this.directory, `${today}.jsonl`)
      : exists
        ? this.directory
        : existsSync(state)
          ? state
          : null;
    const writable =
      isDirectory &&
      (target === null ||
        (await access(target, constants.W_OK).then(
          () => true,
          () => false,
        )));
    const loose = exists && isDirectory ? await isGroupOrWorldAccessible(this.directory).catch(() => false) : false;
    return {
      directory: this.directory,
      exists,
      isDirectory,
      private: !exists || !isDirectory || process.platform === 'win32' ? null : !loose,
      writable,
      days,
      lastWritten,
      failure: await this.readFailure(),
    };
  }
}

/** Newest first; lines of one time in the order they were met. */
function newestFirst(a: ActivityLine, b: ActivityLine): number {
  return a.at === b.at ? 0 : a.at < b.at ? 1 : -1;
}

function matches(line: ActivityLine, filters: ActivityFilters): boolean {
  if (filters.kind !== undefined && line.kind !== filters.kind) return false;
  if (filters.outcome !== undefined && line.outcome !== filters.outcome) return false;
  if (filters.channel !== undefined && line.channel !== filters.channel) return false;
  if (filters.account !== undefined && line.account.alias !== filters.account && line.account.id !== filters.account) {
    return false;
  }
  return true;
}

// ── Which session ──────────────────────────────────────────────────────────────────────────────────────────────

/** A process's parent, its start and its name, as `ps` reports them. */
export interface ProcessFacts {
  readonly ppid: number;
  readonly startedAt: string;
  readonly name: string;
}

/** Reads one process's facts within `timeoutMs`, or null. */
export type ProcessProbe = (pid: number, timeoutMs: number) => Promise<ProcessFacts | null>;

/** `ps -o ppid=,lstart=,comm=` in the C locale: the parent, the start as five words, and the executable — last. */
const PS_LINE = /^\s*(\d+)\s+([A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{1,2}:\d{2}:\d{2}\s+\d{4})\s+(.+?)\s*$/;

/** One process's line of `ps -o ppid=,lstart=,comm=`, or null for anything else. The name is the executable's own. */
export function parsePsLine(text: string): ProcessFacts | null {
  const first = text.split('\n').find((row) => row.trim() !== '');
  const match = first === undefined ? null : PS_LINE.exec(first);
  if (match === null) return null;
  const command = match[3] as string;
  const name = command.includes('/') ? (command.split('/').at(-1) ?? command) : command;
  return { ppid: Number(match[1]), startedAt: (match[2] as string).replace(/\s+/g, ' '), name };
}

const PS_PROGRAMS = ['/bin/ps', '/usr/bin/ps'];

/**
 * This machine's `ps`, by its full path, in the C locale so the start reads the same in every process, bounded by
 * `timeoutMs`. Never on Windows: no query there answers inside the bound (PowerShell alone takes longer to start),
 * so a Windows process is ungrouped.
 */
export const psProbe: ProcessProbe = (pid, timeoutMs) =>
  new Promise((resolve) => {
    const program = PS_PROGRAMS.find((path) => existsSync(path));
    if (process.platform === 'win32' || program === undefined) {
      resolve(null);
      return;
    }
    try {
      const child = execFile(
        program,
        ['-o', 'ppid=,lstart=,comm=', '-p', String(pid)],
        {
          timeout: Math.max(1, Math.round(timeoutMs)),
          env: { LC_ALL: 'C', LANG: 'C', PATH: '/bin:/usr/bin' },
          maxBuffer: 64 * 1024,
          windowsHide: true,
        },
        (error, stdout) => resolve(error ? null : parsePsLine(String(stdout))),
      );
      child.on('error', () => resolve(null));
    } catch {
      // Starting a process was refused: this one is ungrouped.
      resolve(null);
    }
  });

/** How long a call waits for its session to be worked out: no longer, and it goes on alone for now. */
export const SESSION_IDENTITY_BUDGET_MS = 200;
/** How long a server's or the event service's read of its parent may take, in the background. */
export const SESSION_IDENTITY_BACKGROUND_MS = 2000;
/** How soon after a read that did not finish another is tried: no more than once a minute. */
export const SESSION_IDENTITY_RETRY_MS = 60_000;

export interface SessionIdentityOptions {
  /**
   * For a CLI call: the log whose recent lines are searched for an agent window among its ancestors (S2). Left out,
   * a CLI call is always a session of its own.
   */
  log?: Pick<ActivityLog, 'sessionOfAncestor'> | undefined;
  /**
   * The MCP transport's own session id, where it has one (`ctx.sessionId`; stdio has none): mixed into the key, so two
   * transport sessions through one parent are two sessions. Not an MCP connection of `connections`: that is
   * `ActivitySession.connection` (single-server design D11).
   */
  transportSession?: string | undefined;
  /**
   * The gateway this process was started by, when it is a part of an MCP connection (`GATEWAY_PID_ENV`): its parent is
   * then looked through, so the part takes the gateway's parent — the agent window — as its own (D8). The process's
   * own environment says it when this is left out.
   */
  gatewayPid?: number | undefined;
  /**
   * Where what was worked out is kept: this process's own when left out — or, when any test seam below is given, nowhere,
   * unless a test hands one in.
   */
  cache?: SessionIdentityCache | undefined;
  /**
   * For a test: this process's id, its parent's, its folder, how processes are read, the system, how long the read
   * may take (`SESSION_IDENTITY_BACKGROUND_MS` in the background, `SESSION_IDENTITY_BUDGET_MS` for a CLI call), how
   * long a call waits for it, the home folder, and the clock a retry is timed by.
   */
  pid?: number | undefined;
  ppid?: number | undefined;
  cwd?: (() => string) | undefined;
  probe?: ProcessProbe | undefined;
  platform?: NodeJS.Platform | undefined;
  budgetMs?: number | undefined;
  waitMs?: number | undefined;
  home?: string | undefined;
  now?: (() => number) | undefined;
}

function randomKey(): string {
  return randomBytes(8).toString('hex');
}

interface Ancestry {
  readonly pid: number;
  readonly folder: string | null;
  /** Nearest first; each with the parent it names in turn. */
  readonly chain: readonly (ActivityParent & { readonly ppid: number })[];
  /**
   * True when the read ended for good: it reached its depth, a process with no parent of its own, or a system it does
   * not ask. False when it ran out of time or a read failed — tried again, at most once a minute.
   */
  readonly complete: boolean;
}

/** One background read of a process's parent: when it began, and what it found once it has finished. */
interface AncestryRead {
  readonly at: number;
  readonly promise: Promise<Ancestry>;
  settled: Ancestry | null;
}

/**
 * What a process has worked out of its session: its random ids, its background reads of its parent, and a CLI call's
 * identity. One per process (`sessionIdentity` keeps its own); a test makes its own.
 */
export class SessionIdentityCache {
  /** A random id this process made when it started (§4.3). */
  readonly processId: string = randomBytes(6).toString('hex');
  /** The key of this process's own session, when it is not grouped with others. */
  readonly ownKey: string = randomKey();
}

/** Each cache's background reads, and its CLI identity by log: held here, so the class shows only its ids. */
const READS = new WeakMap<SessionIdentityCache, Map<string, AncestryRead>>();
const CLI_IDENTITIES = new WeakMap<SessionIdentityCache, Map<string, Promise<ActivitySession>>>();

function heldIn<V>(map: WeakMap<SessionIdentityCache, Map<string, V>>, cache: SessionIdentityCache): Map<string, V> {
  let held = map.get(cache);
  if (held === undefined) {
    held = new Map();
    map.set(cache, held);
  }
  return held;
}

const PROCESS_CACHE = new SessionIdentityCache();
/** This process's own random id: a line handed in without one names this process. */
const PROCESS_ID = PROCESS_CACHE.processId;

/** `promise`, or null after `ms`. Its timer is not unref'd: whoever awaits it keeps the process alive till then. */
function within<T>(promise: Promise<T | null>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), Math.max(0, ms));
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

function folderOf(options: SessionIdentityOptions): string | null {
  try {
    return (options.cwd ?? (() => process.cwd()))();
  } catch {
    return null;
  }
}

async function readAncestry(
  options: SessionIdentityOptions,
  depth: number,
  initIsParent: boolean,
  budgetMs: number,
): Promise<Ancestry> {
  const platform = options.platform ?? process.platform;
  const pid = options.pid ?? process.pid;
  const folder = folderOf(options);
  const chain: (ActivityParent & { ppid: number })[] = [];
  if (platform === 'win32') return { pid, folder, chain, complete: true };
  const probe = options.probe ?? psProbe;
  const deadline = Date.now() + budgetMs;
  let next = options.ppid ?? process.ppid;
  // A part of an MCP connection was started by the gateway, which the agent window started (D8): the window is the
  // gateway's parent, so the part's session key is the one a server the window started itself would have.
  const gateway = options.gatewayPid ?? gatewayPidOf(process.env);
  if (gateway !== undefined && next === gateway && !initIsParent) {
    const left = deadline - Date.now();
    if (left <= 0) return { pid, folder, chain, complete: false };
    const facts = await within(probe(next, left), left);
    if (facts === null) return { pid, folder, chain, complete: false };
    next = facts.ppid;
  }
  // Process 1 adopts a process whose parent has gone: it is no window, except to the event service, which it starts.
  while (chain.length < depth && (next > 1 || (initIsParent && next === 1 && chain.length === 0))) {
    const left = deadline - Date.now();
    if (left <= 0) return { pid, folder, chain, complete: false };
    const facts = await within(probe(next, left), left);
    if (facts === null) return { pid, folder, chain, complete: false };
    chain.push({ pid: next, startedAt: facts.startedAt, name: facts.name, ppid: facts.ppid });
    if (next === 1) break;
    next = facts.ppid;
  }
  return { pid, folder, chain, complete: true };
}

/** The gateway's pid a part was started with, or undefined for a process no gateway started. */
function gatewayPidOf(env: NodeJS.ProcessEnv): number | undefined {
  const raw = env[GATEWAY_PID_ENV];
  if (raw === undefined || !/^[1-9][0-9]{0,9}$/.test(raw)) return undefined;
  return Number(raw);
}

/**
 * The MCP connection this process serves as a part of (D11): its id, which the gateway set in the environment, and its
 * name in `config.json` now, kept on the line as it is now. Undefined for a process no gateway started, or one whose
 * connection the configuration no longer has.
 */
async function connectionOfProcess(core: Pick<Core, 'activity'>): Promise<ActivityConnection | undefined> {
  const id = process.env[CONNECTION_ID_ENV];
  if (id === undefined || !CONNECTION_ID_PATTERN.test(id)) return undefined;
  const config = (core as Partial<Pick<Core, 'config'>>).config;
  if (config === undefined) return undefined;
  try {
    const read = connectionById(await config.load(), id);
    return read?.readable ? { id, name: read.record.name } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The background read of this process's parent, begun if none is under way or kept: a read that finished is kept for
 * good, one under way is waited on, and one that ran out of time is begun again once a minute has passed.
 */
function ancestryRead(
  cache: SessionIdentityCache,
  options: SessionIdentityOptions,
  initIsParent: boolean,
): AncestryRead {
  const id = initIsParent ? 'daemon' : 'server';
  const now = (options.now ?? Date.now)();
  const reads = heldIn(READS, cache);
  const held = reads.get(id);
  if (
    held !== undefined &&
    (held.settled === null || held.settled.complete || now - held.at < SESSION_IDENTITY_RETRY_MS)
  ) {
    return held;
  }
  const read: AncestryRead = {
    at: now,
    settled: null,
    promise: readAncestry(options, 1, initIsParent, options.budgetMs ?? SESSION_IDENTITY_BACKGROUND_MS),
  };
  read.promise.then(
    (ancestry) => {
      read.settled = ancestry;
    },
    () => undefined,
  );
  reads.set(id, read);
  return read;
}

/**
 * Begins working out this process's session in the background, as an MCP server or the event service starts, so its
 * first calls find it done: a read of its parent of up to `SESSION_IDENTITY_BACKGROUND_MS`. Returns at once; never
 * throws. A CLI call reads its own, and is not warmed.
 */
export function warmSessionIdentity(surface: ActivitySurface = 'mcp', options: SessionIdentityOptions = {}): void {
  if (surface === 'cli') return;
  try {
    ancestryRead(options.cache ?? PROCESS_CACHE, options, surface === 'daemon');
  } catch {
    // Worked out on the first call instead.
  }
}

function windowKey(parent: ActivityParent, folder: string, connection: string | undefined): string {
  const named = connection === undefined || connection === '' ? '' : `\0${connection}`;
  return createHash('sha256')
    .update(`${parent.pid}\0${parent.startedAt}\0${folder}${named}`)
    .digest('hex')
    .slice(0, 16);
}

/** System folders, each with everything under it: no project is started there. */
const POSIX_SYSTEM_TREES = [
  '/System',
  '/Library',
  '/Applications',
  '/usr',
  '/bin',
  '/sbin',
  '/etc',
  '/dev',
  '/proc',
  '/sys',
  '/boot',
];
/** Folders that hold everyone's projects, or anyone's temporary files — only the folder itself, not what is in it. */
const POSIX_SHARED = ['/tmp', '/var', '/private', '/private/tmp', '/private/var', '/opt', '/Volumes', '/mnt', '/media'];
const WINDOWS_SYSTEM_TREES = ['\\windows', '\\program files', '\\program files (x86)', '\\programdata'];

/**
 * Whether a folder is one that cannot tell projects apart (S3): a filesystem's root, the home folder or a folder above
 * it, a system folder or anything in one, or a shared one such as `/tmp`. A client that starts every server from one
 * process there — a desktop app started in `/`, say — would otherwise make every project it serves one session.
 */
export function sharedFolder(folder: string, home: string, platform: NodeJS.Platform = process.platform): boolean {
  if (platform === 'win32') {
    const plain = (path: string) => path.replace(/\//g, '\\').replace(/\\+$/, '').toLowerCase();
    const at = plain(folder);
    const homeAt = plain(home);
    if (/^[a-z]:$/.test(at) || at === '') return true;
    if (homeAt !== '' && (at === homeAt || homeAt.startsWith(`${at}\\`))) return true;
    const rest = at.replace(/^[a-z]:/, '');
    return rest === '\\users' || WINDOWS_SYSTEM_TREES.some((tree) => rest === tree || rest.startsWith(`${tree}\\`));
  }
  const plain = (path: string) => (path.length > 1 ? path.replace(/\/+$/, '') : path) || '/';
  const at = plain(folder);
  const homeAt = plain(home);
  if (at === '/') return true;
  if (homeAt !== '/' && (at === homeAt || homeAt.startsWith(`${at}/`))) return true;
  if (POSIX_SHARED.includes(at)) return true;
  return POSIX_SYSTEM_TREES.some((tree) => at === tree || at.startsWith(`${tree}/`));
}

/**
 * Which session this process's calls belong to (S2): its id, its parent's id, start and name, its folder and the
 * session key. Never throws.
 *
 * - **An MCP server** (`mcp`) is grouped with every other server its parent started in the same folder: one agent
 *   window. Its parent is read in the background — begun by `warmSessionIdentity` as the server starts, or by its first
 *   call — for up to two seconds; a call waits for it about 200 ms and, when it is not done, goes on alone for now. A
 *   read that ran out of time is not kept: one a minute or more later tries again. A parent that has gone, a folder
 *   that cannot be read, and a folder that cannot tell projects apart (`sharedFolder`: `/`, the home folder, a system
 *   folder) leave it ungrouped, with a key of its own.
 * - **A CLI call** (`cli`) reads up to three processes above it, within about 200 ms. When one of them is the parent
 *   of a server process that recorded a line today (or yesterday) in `options.log`, the call joins that window's
 *   session; otherwise it is a session of its own. Its `ancestors` name those processes either way.
 * - **The event service** (`daemon`) is grouped by its parent too, process 1 included, whatever its folder — it serves
 *   no project — so it is one session since it started. It waits for the whole read: it records on a timer, and keeps
 *   what it is given.
 * - **On Windows** no process is grouped: a query of a process's parent and start does not answer within the bound.
 *
 * `clientInfo` is what an MCP client said it is; it is stored as that, and nothing depends on it.
 */
export async function sessionIdentity(
  surface: ActivitySurface,
  clientInfo?: ClientInfo | undefined,
  options: SessionIdentityOptions = {},
): Promise<ActivitySession> {
  const seams =
    options.pid !== undefined ||
    options.ppid !== undefined ||
    options.cwd !== undefined ||
    options.probe !== undefined ||
    options.platform !== undefined ||
    options.budgetMs !== undefined ||
    options.waitMs !== undefined ||
    options.home !== undefined ||
    options.now !== undefined;
  const cache = options.cache ?? (seams ? null : PROCESS_CACHE);
  const client = clientOf(clientInfo);
  try {
    if (surface === 'cli' && cache !== null) {
      const directory = (options.log as { directory?: string } | undefined)?.directory ?? '';
      const identities = heldIn(CLI_IDENTITIES, cache);
      let held = identities.get(directory);
      if (held === undefined) {
        held = identityOf(surface, options, cache);
        identities.set(directory, held);
      }
      return { ...(await held), ...(client === undefined ? {} : { client }) };
    }
    const session = await identityOf(surface, options, cache);
    return { ...session, ...(client === undefined ? {} : { client }) };
  } catch {
    return {
      key: cache?.ownKey ?? randomKey(),
      process: cache?.processId ?? PROCESS_ID,
      pid: options.pid ?? process.pid,
      ...(client === undefined ? {} : { client }),
      folder: null,
      grouped: false,
      surface,
    };
  }
}

async function identityOf(
  surface: ActivitySurface,
  options: SessionIdentityOptions,
  cache: SessionIdentityCache | null,
): Promise<ActivitySession> {
  const own = cache?.ownKey ?? randomKey();
  const processId = cache?.processId ?? randomBytes(6).toString('hex');
  const parentOfChain = (chain: Ancestry['chain'], index: number): ActivityParent | undefined => {
    const held = chain[index];
    return held === undefined ? undefined : { pid: held.pid, startedAt: held.startedAt, name: held.name };
  };
  if (surface === 'cli') {
    // A command is short: it reads its own, within the call's bound, and has no later call to try again on.
    const { pid, folder, chain } = await readAncestry(
      options,
      3,
      false,
      options.budgetMs ?? SESSION_IDENTITY_BUDGET_MS,
    );
    const base = { process: processId, pid, folder, surface };
    const ancestors = chain.map((held) => held.name);
    const parents = chain.map((_, index) => parentOfChain(chain, index) as ActivityParent);
    const joined = parents.length > 0 && options.log ? await options.log.sessionOfAncestor(parents) : null;
    if (joined !== null) return { key: joined.key, ...base, parent: joined.parent, ancestors, grouped: true };
    const parent = parentOfChain(chain, 0);
    return { key: own, ...base, ...(parent === undefined ? {} : { parent }), ancestors, grouped: false };
  }
  const initIsParent = surface === 'daemon';
  let ancestry: Ancestry | null;
  if (cache === null) {
    ancestry = await readAncestry(options, 1, initIsParent, options.budgetMs ?? SESSION_IDENTITY_BUDGET_MS);
  } else {
    const read = ancestryRead(cache, options, initIsParent);
    const wait = initIsParent
      ? (options.budgetMs ?? SESSION_IDENTITY_BACKGROUND_MS)
      : (options.waitMs ?? SESSION_IDENTITY_BUDGET_MS);
    ancestry = read.settled ?? (await within(read.promise, wait));
  }
  if (ancestry === null) {
    // Not worked out yet: alone for now, under this process's own key; a later call finds it done.
    return {
      key: own,
      process: processId,
      pid: options.pid ?? process.pid,
      folder: folderOf(options),
      grouped: false,
      surface,
    };
  }
  const { pid, folder, chain } = ancestry;
  const base = { process: processId, pid, folder, surface };
  const parent = parentOfChain(chain, 0);
  const home = options.home ?? homedir();
  // The event service serves no project, so its folder — `/`, as launchd starts it — merges none: it is not held to it.
  const shared = !initIsParent && folder !== null && sharedFolder(folder, home, options.platform ?? process.platform);
  if (parent === undefined || folder === null || shared) {
    return { key: own, ...base, ...(parent === undefined ? {} : { parent }), grouped: false };
  }
  return { key: windowKey(parent, folder, options.transportSession), ...base, parent, grouped: true };
}

// ── For the channels ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * Records one line in `core`'s activity log. Never throws, and never fails the call it describes: a line that cannot
 * be written is reported by the log itself (`ActivityLog.append`). Recording off writes nothing.
 *
 * For a line a channel builds itself — the event service's `told` lines (S1), say. Around an operation, use
 * `withActivity`, which times it and records how it ended.
 */
export async function recordActivity(core: Pick<Core, 'activity'>, line: ActivityLineInput): Promise<void> {
  try {
    await core.activity.append(line);
  } catch {
    // `append` does not throw; a log handed in by a test might.
  }
}

/** Who a call is recorded as: the core whose log it goes to, the channel, the surface and the account. */
export interface ActivityContext {
  readonly core: Pick<Core, 'activity'>;
  /** The channel's word: `gmail`, `slack`, `resend`, `whatsapp`, `events`. */
  readonly channel: string;
  readonly surface: ActivitySurface;
  /** The account the call acts on, as known before it runs; `describe` may name it more exactly after. */
  readonly account: ActivityAccount;
  /** The MCP client's `clientInfo` — a function, since a server knows it only once a client has connected. */
  readonly clientInfo?: ClientInfo | (() => ClientInfo | undefined) | undefined;
  /** The session, when the caller has worked it out already; otherwise `sessionIdentity(surface, clientInfo)`. */
  readonly session?: ActivitySession | undefined;
  /**
   * The MCP transport's own session id, where it has one — a tool handler's `ctx.sessionId`; stdio has none — mixed
   * into the session key (`SessionIdentityOptions.transportSession`).
   */
  readonly transportSession?: string | (() => string | undefined) | undefined;
  /** A search's words, known before it runs. */
  readonly query?: string | undefined;
}

/**
 * What a finished call touched, for its line: never content. Only these fields are written; anything else in the
 * object `describe` returns is dropped (`activityLineOf`).
 */
export interface ActivityDetail {
  readonly account?: ActivityAccount | undefined;
  /** `refused` for a result that is a refusal rather than a throw; `ok` when left out. */
  readonly outcome?: ActivityOutcome | undefined;
  readonly reason?: string | undefined;
  readonly items?: readonly ActivityItem[] | undefined;
  readonly count?: number | undefined;
  readonly counts?: Readonly<Record<string, number>> | undefined;
  readonly query?: string | undefined;
  readonly recipients?: readonly string[] | undefined;
  readonly approvalId?: string | undefined;
  readonly told?: ActivityTold | undefined;
  readonly replyTo?: ActivityReplyTo | undefined;
  readonly draftId?: string | undefined;
  readonly threadId?: string | undefined;
  readonly channelId?: string | undefined;
  readonly thread?: string | null | undefined;
  readonly act?: ActivityAct | undefined;
}

/** The refusals a call can end in — a policy, an approval, a rule, a cap or a usage mistake — rather than a failure. */
const REFUSED_CODES: ReadonlySet<string> = new Set([
  'APPROVAL_REQUIRED',
  'APPROVAL_PENDING',
  'APPROVAL_EXPIRED',
  'APPROVAL_VOID',
  'SEND_REFUSED',
  'POLICY_NEVER',
  'ACT_NOT_ALLOWED',
  'STANDING_REFUSED',
  'STANDING_LIMIT',
  'TAKE_REQUIRED',
  'TAKEN_ELSEWHERE',
  'RATE_CAPPED',
  'LOOSENING_REFUSED',
  'USAGE',
  'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
]);

function failureDetail(error: unknown): ActivityDetail {
  const code = error instanceof CommsError ? error.code : 'UNEXPECTED';
  return { outcome: REFUSED_CODES.has(code) ? 'refused' : 'failed', reason: `${code}: ${messageOf(error)}` };
}

async function recordCall(
  context: ActivityContext,
  operation: string,
  kind: ActivityKind,
  ms: number,
  detail: ActivityDetail,
): Promise<void> {
  try {
    const clientInfo = typeof context.clientInfo === 'function' ? context.clientInfo() : context.clientInfo;
    const session =
      context.session ??
      (await sessionIdentity(context.surface, clientInfo, {
        log: context.core.activity as Pick<ActivityLog, 'sessionOfAncestor'>,
        transportSession:
          typeof context.transportSession === 'function' ? context.transportSession() : context.transportSession,
      }));
    const connection = context.session?.connection ?? (await connectionOfProcess(context.core));
    const query = detail.query ?? context.query;
    await recordActivity(context.core, {
      channel: context.channel,
      account: detail.account ?? context.account,
      operation,
      kind,
      outcome: detail.outcome ?? 'ok',
      ...(detail.reason === undefined ? {} : { reason: detail.reason }),
      session: connection === undefined ? session : { ...session, connection },
      ms,
      ...(detail.items === undefined ? {} : { items: detail.items }),
      ...(detail.count === undefined ? {} : { count: detail.count }),
      ...(detail.counts === undefined ? {} : { counts: detail.counts }),
      ...(query === undefined ? {} : { query }),
      ...(detail.recipients === undefined ? {} : { recipients: detail.recipients }),
      ...(detail.approvalId === undefined ? {} : { approvalId: detail.approvalId }),
      ...(detail.told === undefined ? {} : { told: detail.told }),
      ...(detail.replyTo === undefined ? {} : { replyTo: detail.replyTo }),
      ...(detail.draftId === undefined ? {} : { draftId: detail.draftId }),
      ...(detail.threadId === undefined ? {} : { threadId: detail.threadId }),
      ...(detail.channelId === undefined ? {} : { channelId: detail.channelId }),
      ...(detail.thread === undefined ? {} : { thread: detail.thread }),
      ...(detail.act === undefined ? {} : { act: detail.act }),
    });
  } catch {
    // Recording never fails the call.
  }
}

/**
 * Runs one operation and records its line (§8): times `fn`, and when it returns records `describe(result)` as `ok`
 * (or the outcome `describe` names); when it throws, records `refused` for a policy's, an approval's or a rule's
 * refusal and `failed` for anything else, with the error's code and message as the reason, and throws the same error
 * on. What it returns, or throws, is exactly what `fn` did: recording never changes or fails the call, and a
 * `describe` that throws records the line without its details.
 *
 * `operationId` is the capability id in `capabilities.json` (`gmail.search`); `kind` is `read`, `write`, `told` or
 * `approval`.
 *
 * @example
 *   const found = await withActivity(
 *     { core, channel: 'gmail', surface: 'mcp', account: { id: inbox.id, alias }, clientInfo: () => server.getClientVersion() },
 *     'gmail.search',
 *     'read',
 *     () => search(core, request),
 *     (result) => ({ query: request.query, count: result.total, items: result.messages.map((m) => ({ id: m.id, subject: m.subject, from: m.from })) }),
 *   );
 */
export async function withActivity<T>(
  context: ActivityContext,
  operationId: string,
  kind: ActivityKind,
  fn: () => Promise<T>,
  describe: (result: T) => ActivityDetail,
): Promise<T> {
  const started = performance.now();
  let result: T;
  try {
    result = await fn();
  } catch (error) {
    await recordCall(context, operationId, kind, performance.now() - started, failureDetail(error));
    throw error;
  }
  const ms = performance.now() - started;
  let detail: ActivityDetail = {};
  try {
    detail = describe(result) ?? {};
  } catch {
    detail = {};
  }
  await recordCall(context, operationId, kind, ms, detail);
  return result;
}
