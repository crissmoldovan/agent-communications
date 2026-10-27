/**
 * Taking messages (design 2026-10-26-taking-messages, T1–T11): one session takes an inbound message before it acts on
 * it, and once one has, no other session acts on it. A session can hand a message back ("not mine", with a reason),
 * mark it done, and ask who has it; the person can see every take, end one, give a message to a window, or keep it.
 *
 * - **Where (T1):** `<state>/takes/<accountId>/<sha256(message key)>.json`, one record per message, owner-only (600) in
 *   owner-only folders (700). Each is read, checked and written under its own lock (`<file>.lock`), so the first take
 *   wins however many processes race for it, and written whole with `writeFileAtomic`.
 * - **Who (T2):** a take is held by a session — an agent window — worked out by the server or the command itself from
 *   core's activity session and `CLAUDE_CODE_SESSION_ID` (`takerIdentity`), and never from an argument. A command at the
 *   person's own terminal, which joined no agent window and has no session id, is the person: never held to taking. The
 *   same command in a shell a known coding agent marks is not the person, and nothing it does can be matched to a take
 *   (`TakeUnmatched`): it is held to every gate, and takes nothing (security review of 0.35.0, M4).
 * - **What ends a take (T3):** a hand-back, the person's release, or a lapse — `ended` when the holder's parent is gone,
 *   `expired` sixty minutes after the holder's last act on the message, unless an approval prepared under the take
 *   still waits. Worked out by whoever meets the record, and written down under the lock by the next writer, at the
 *   time it happened.
 * - **Offers (T4):** a message offered to one window is reserved for it; it must still take it. The person's **Give
 *   to…** offers one for fifteen minutes; a rule's delivery offers one through the event service (`offer`), while its
 *   item waits for the window and for fifteen minutes after the window was handed it (`handOffer`). A delivery's offer
 *   never takes a message from anyone, and the event service never writes `taken`.
 * - **What an agent learns (T7, T8):** closed words — `you`, `another session`, `the person`, `done`, and the closed
 *   hand-back reasons. Never another session's folder, client, key or session id, and never a hand-back's note, which an
 *   agent wrote and may have copied a sender's words into: notes are the person's, shown enveloped.
 * - **Nothing a sender wrote is stored (§4):** ids and closed words only, every record rebuilt field by field on read and
 *   on write, so a field this release does not know never survives a write.
 * - **Retention:** a record is deleted thirty days after it last changed, once a day, by the first process that writes
 *   one; an account no longer connected loses its folder then too.
 *
 * Taking guards against two sessions acting on one message, not against what is sent: every act still needs the
 * behaviour rules, the send policy and the person's approval. And it is a speed bump, not a boundary — every process
 * here runs as the person, and an agent's own shell can run the person's commands (§10).
 */
import { createHash } from 'node:crypto';
import { readdir, readFile, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type ActivityParent,
  type ActivitySession,
  type ActivitySurface,
  type ClientInfo,
  type ProcessProbe,
  psProbe,
  type SessionIdentityOptions,
  sessionIdentity,
} from './activity.ts';
import { agentMarker } from './cli-runtime.ts';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { withFileLock } from './lock.ts';
import { MCP_SERVER_MARKER, mcpServerOf } from './mcp-marker.ts';
import { wrapUntrusted } from './untrusted.ts';

// ── The vocabulary ─────────────────────────────────────────────────────────────────────────────────────────────

export const TAKE_CHANNELS: readonly ['gmail', 'slack', 'resend'] = Object.freeze([
  'gmail',
  'slack',
  'resend',
] as const);
export type TakeChannel = (typeof TAKE_CHANNELS)[number];

export const TAKE_STATES: readonly ['open', 'offered', 'taken', 'done'] = Object.freeze([
  'open',
  'offered',
  'taken',
  'done',
] as const);
export type TakeState = (typeof TAKE_STATES)[number];

/** T8: why a session hands a message back, in closed words other sessions may see. */
export const HAND_BACK_REASONS: readonly ['not-mine', 'wrong-account', 'needs-the-person', 'duplicate', 'other'] =
  Object.freeze(['not-mine', 'wrong-account', 'needs-the-person', 'duplicate', 'other'] as const);
export type HandBackReason = (typeof HAND_BACK_REASONS)[number];

/** What one line of a record's history says happened. */
export const TAKE_LINE_KINDS: readonly [
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
] = Object.freeze([
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
] as const);
export type TakeLineKind = (typeof TAKE_LINE_KINDS)[number];

/** Why another session's act is refused (`TAKEN_ELSEWHERE`): held, offered to another, done, or the person's. */
export type TakenElsewhereReason = 'HELD' | 'OFFERED' | 'DONE' | 'PERSON';

/** T3: a take lapses this long after the holder's last act on the message (open question 2: sixty minutes). */
export const TAKE_LEASE_MS: number = 60 * 60 * 1000;
/**
 * T4: an offer lasts this long (open question 3: fifteen minutes) — the person's from when they give it, a delivery's
 * from when its window was handed the message.
 */
export const TAKE_OFFER_MS: number = 15 * 60 * 1000;
/** §4: a record is deleted this many days after it last changed. */
export const TAKE_RETENTION_DAYS = 30;
/** §4: the newest lines of a record's history kept. */
export const MAX_TAKE_HISTORY = 50;
/** T8: the most a note may be, in characters. */
export const MAX_TAKE_NOTE_CHARS = 200;
/** §5: the most messages one `taken` asks about. */
export const MAX_TAKEN_MESSAGES = 50;

/**
 * A provider's id as a record keeps one (activity's `providerId` grammar): id characters only, at most 200, so no
 * sender text can ride in one.
 */
export const TAKE_ID_PATTERN: RegExp = /^[A-Za-z0-9._:/@+=-]{1,200}$/;
/** A mail's Message-ID, bare: as Gmail's reply proof reads one (`messageIdOf`). */
const RFC822_ID = /^[A-Za-z0-9!#$%&*+/=?^_|~.-]{1,256}@[A-Za-z0-9._-]{1,255}$/;
const ACCOUNT_ID = /^(?:ibx|acc)_[A-Z0-9]{16}$/;
const SESSION_KEY = /^[0-9a-f]{16}$/;
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PROCESS_ID = /^[0-9a-f]{1,64}$/;
const APPROVAL_ID = /^ap_[A-Za-z0-9]{1,64}$/;
const ISO_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const RECORD_FILE = /^[0-9a-f]{64}\.json$/;
/** A rule's id as an offer records it: the person's own word, with no control character. */
const OFFER_RULE = /^[^\p{Cc}]{1,100}$/u;
const MAX_FOLDER = 4096;
const MAX_WORD = 100;
const MAX_VERSION = 64;
const MAX_ANCESTORS = 3;
const DAY_MS = 24 * 60 * 60 * 1000;
/** How long a look at whether a holder's parent is still running may take. */
const PROBE_MS = 1000;

export function isTakeChannel(value: unknown): value is TakeChannel {
  return typeof value === 'string' && (TAKE_CHANNELS as readonly string[]).includes(value);
}

export function isHandBackReason(value: unknown): value is HandBackReason {
  return typeof value === 'string' && (HAND_BACK_REASONS as readonly string[]).includes(value);
}

export function isTakeState(value: unknown): value is TakeState {
  return typeof value === 'string' && (TAKE_STATES as readonly string[]).includes(value);
}

/** A Claude Code session id, as `CLAUDE_CODE_SESSION_ID` carries it: a lowercase UUID. */
export function isClaudeCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

/** An activity session key: 16 lowercase hex characters (activity design S2). */
export function isSessionKey(value: unknown): value is string {
  return typeof value === 'string' && SESSION_KEY.test(value);
}

// ── What a record is ───────────────────────────────────────────────────────────────────────────────────────────

/** A message, as a take names it: its channel, its account by id, and the provider's id of it. */
export interface TakeMessageRef {
  readonly channel: TakeChannel;
  readonly accountId: string;
  /** Gmail's message id; Slack's `<channelId>/<ts>`; Resend's received email id (event-source.ts 17–21). */
  readonly id: string;
}

/** A message as a take records it: where it is, its thread, and for mail its Message-ID, so a reply finds its take. */
export interface TakeMessage extends TakeMessageRef {
  /** Gmail's thread id; Slack's `<channelId>/<parent ts>`; null when it has none. */
  readonly thread: string | null;
  readonly rfc822Id?: string | undefined;
}

/**
 * A session, as a take holds it (T2): its activity key and whether that key is an agent window's, this process's
 * random id, its Claude Code session id when it has one, the parent that grouped it, its folder and its client.
 * `folder` and `client` are for the person's view only, and nothing matches on `client`.
 */
export interface TakeHolder {
  readonly key: string;
  readonly grouped: boolean;
  readonly process: string;
  readonly sessionId: string | null;
  readonly parent: ActivityParent | null;
  readonly folder: string | null;
  readonly client: ClientInfo | null;
}

/** The person, holding a message they said they will handle themselves (`takes keep`). */
export interface TakePerson {
  readonly person: true;
}

/**
 * An agent's own shell that is no session (security review of 0.35.0, M4): a command that joined no agent window and
 * has no Claude Code session id, run where a known coding agent's marker is set (`agentMarker`) or inside an MCP
 * server's process. It is not the person, so every gate holds for it; and nothing it does can be matched to a take —
 * each command is a process of its own — so it holds nothing, is offered nothing and takes nothing. Where a take is
 * required it acts on no message, and is told why.
 */
export interface TakeUnmatched {
  readonly unmatched: true;
  /** What says an agent runs it: the marker's name — `CODEX_SANDBOX`, `CLAUDECODE` — or `AGENTCOMMS_MCP_SERVER`. */
  readonly marker: string;
}

/**
 * Who is acting: an agent session; an agent's shell that is no session (`TakeUnmatched`); or — `null` — the person at
 * their own terminal, never held to taking (T2, T6). A command an agent runs in its shell joins its window, and is that
 * session.
 */
export type TakeCaller = TakeHolder | TakeUnmatched | null;

/** Whether a caller is an agent's shell that is no session (M4). */
export function isUnmatched(caller: TakeCaller | undefined): caller is TakeUnmatched {
  return typeof caller === 'object' && caller !== null && 'unmatched' in caller && caller.unmatched === true;
}

/** The session a caller is, when a take can be matched to it: neither the person nor an agent's shell that is none. */
function sessionOf(caller: TakeCaller): TakeHolder | null {
  return caller === null || isUnmatched(caller) ? null : caller;
}

/** The window an offer reserves a message for: by its Claude Code session id, its activity key, or both (T4). */
export interface TakeWindow {
  readonly sessionId: string | null;
  readonly key: string | null;
  readonly parent: ActivityParent | null;
  readonly folder: string | null;
  readonly client: ClientInfo | null;
}

export interface TakeOffer {
  readonly to: TakeWindow;
  /** When it lapses; null while the item a delivery's offer came with still waits for the window. */
  readonly until: string | null;
  readonly by: { readonly rule: string; readonly delivery: string } | TakePerson;
}

/** A terminal a person's act came from: its folder and the processes above it, so the story says where (§10). */
export interface TakeTerminal {
  readonly folder: string | null;
  readonly ancestors: readonly string[];
}

/** One line of a record's history. */
export interface TakeLine {
  readonly at: string;
  readonly kind: TakeLineKind;
  readonly by: 'window' | 'person' | 'service';
  /** The window the line is about — the holder's, the offered one's — by its activity key, or null. */
  readonly windowKey: string | null;
  /** That window as the person sees it: its session id, folder and client. Never shown to an agent. */
  readonly window?:
    | { readonly sessionId: string | null; readonly folder: string | null; readonly client: ClientInfo | null }
    | undefined;
  /** A person's act: the terminal it came from. */
  readonly terminal?: TakeTerminal | undefined;
  readonly reason?: HandBackReason | undefined;
  /** ≤ 200 characters, agent-written: the person's alone, and enveloped wherever shown. */
  readonly note?: string | undefined;
  readonly ack?:
    | { readonly outcome: 'sent' | 'failed' | 'unknown' | 'not-made'; readonly why?: string | undefined }
    | undefined;
}

export interface TakeRecord {
  readonly v: 1;
  readonly message: TakeMessage;
  readonly state: TakeState;
  readonly holder: TakeHolder | TakePerson | null;
  readonly offer: TakeOffer | null;
  readonly takenAt: string | null;
  /** The holder's last act on the message: the lease runs sixty minutes from here (T3). */
  readonly lastActAt: string | null;
  /** Approvals prepared under the take, still waiting: while one does, the take does not expire. */
  readonly pins: readonly string[];
  /** The newest fifty lines, oldest first. */
  readonly history: readonly TakeLine[];
  readonly updatedAt: string;
}

// ── Reading a record back, field by field ──────────────────────────────────────────────────────────────────────

function own(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function cut(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const chars = Array.from(value.length > max * 2 ? value.slice(0, max * 2) : value);
  return chars.length <= max ? value : chars.slice(0, max).join('');
}

function timeOf(value: unknown): string | undefined {
  return typeof value === 'string' && ISO_TIME.test(value) && !Number.isNaN(Date.parse(value)) ? value : undefined;
}

function idOf(value: unknown): string | undefined {
  return typeof value === 'string' && TAKE_ID_PATTERN.test(value) ? value : undefined;
}

/** A Message-ID as a record keeps one: bare, without its angle brackets, or undefined when it is not a plain one. */
export function rfc822IdOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const bare = /^<([^<>\s]+)>$/.exec(trimmed)?.[1] ?? trimmed;
  return RFC822_ID.test(bare) ? bare : undefined;
}

function clientOf(raw: unknown): ClientInfo | null {
  const client = own(raw);
  const name = cut(client?.name, MAX_WORD);
  if (name === undefined || name === '') return null;
  const version = cut(client?.version, MAX_VERSION);
  return { name, ...(version === undefined ? {} : { version }) };
}

function parentOf(raw: unknown): ActivityParent | null {
  const parent = own(raw);
  const pid = parent?.pid;
  const startedAt = cut(parent?.startedAt, MAX_VERSION);
  const name = cut(parent?.name, MAX_WORD);
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
  if (startedAt === undefined || name === undefined) return null;
  return { pid, startedAt, name };
}

function folderOf(raw: unknown): string | null {
  return cut(raw, MAX_FOLDER) ?? null;
}

function holderOf(raw: unknown): TakeHolder | null {
  const holder = own(raw);
  if (holder === undefined) return null;
  const key = isSessionKey(holder.key) ? holder.key : undefined;
  const process = typeof holder.process === 'string' && PROCESS_ID.test(holder.process) ? holder.process : undefined;
  if (key === undefined || process === undefined || typeof holder.grouped !== 'boolean') return null;
  return {
    key,
    grouped: holder.grouped,
    process,
    sessionId: isClaudeCodeSessionId(holder.sessionId) ? holder.sessionId : null,
    parent: parentOf(holder.parent),
    folder: folderOf(holder.folder),
    client: clientOf(holder.client),
  };
}

function heldOf(raw: unknown): TakeHolder | TakePerson | null | undefined {
  if (raw === null) return null;
  if (own(raw)?.person === true) return { person: true };
  return holderOf(raw) ?? undefined;
}

function windowOf(raw: unknown): TakeWindow | null {
  const window = own(raw);
  if (window === undefined) return null;
  const sessionId = isClaudeCodeSessionId(window.sessionId) ? window.sessionId : null;
  const key = isSessionKey(window.key) ? window.key : null;
  if (sessionId === null && key === null) return null;
  return {
    sessionId,
    key,
    parent: parentOf(window.parent),
    folder: folderOf(window.folder),
    client: clientOf(window.client),
  };
}

function offerOf(raw: unknown): TakeOffer | null | undefined {
  if (raw === null) return null;
  const offer = own(raw);
  const to = windowOf(offer?.to);
  if (offer === undefined || to === null) return undefined;
  const until = offer.until === null ? null : timeOf(offer.until);
  if (until === undefined) return undefined;
  const by = own(offer.by);
  if (by?.person === true) return { to, until, by: { person: true } };
  const rule = cut(by?.rule, MAX_WORD);
  const delivery = cut(by?.delivery, MAX_WORD);
  if (rule === undefined || delivery === undefined) return undefined;
  return { to, until, by: { rule, delivery } };
}

function lineOf(raw: unknown): TakeLine | null {
  const line = own(raw);
  const at = timeOf(line?.at);
  const kind = line?.kind;
  const by = line?.by;
  if (line === undefined || at === undefined) return null;
  if (typeof kind !== 'string' || !(TAKE_LINE_KINDS as readonly string[]).includes(kind)) return null;
  if (by !== 'window' && by !== 'person' && by !== 'service') return null;
  const window = own(line.window);
  const terminal = own(line.terminal);
  const ack = own(line.ack);
  const ackOutcome = ack?.outcome;
  const note = cut(line.note, MAX_TAKE_NOTE_CHARS);
  return {
    at,
    kind: kind as TakeLineKind,
    by,
    windowKey: isSessionKey(line.windowKey) ? line.windowKey : null,
    ...(window === undefined
      ? {}
      : {
          window: {
            sessionId: isClaudeCodeSessionId(window.sessionId) ? window.sessionId : null,
            folder: folderOf(window.folder),
            client: clientOf(window.client),
          },
        }),
    ...(terminal === undefined
      ? {}
      : {
          terminal: {
            folder: folderOf(terminal.folder),
            ancestors: Array.isArray(terminal.ancestors)
              ? terminal.ancestors
                  .slice(0, MAX_ANCESTORS)
                  .flatMap((name) => (typeof name === 'string' ? [cut(name, MAX_WORD) as string] : []))
              : [],
          },
        }),
    ...(isHandBackReason(line.reason) ? { reason: line.reason } : {}),
    ...(note === undefined || note === '' ? {} : { note }),
    ...(ackOutcome === 'sent' || ackOutcome === 'failed' || ackOutcome === 'unknown' || ackOutcome === 'not-made'
      ? {
          ack: {
            outcome: ackOutcome,
            ...(typeof ack?.why === 'string' ? { why: cut(ack.why, MAX_WORD) as string } : {}),
          },
        }
      : {}),
  };
}

function messageOf(raw: unknown): TakeMessage | null {
  const message = own(raw);
  if (message === undefined || !isTakeChannel(message.channel)) return null;
  const accountId =
    typeof message.accountId === 'string' && ACCOUNT_ID.test(message.accountId) ? message.accountId : undefined;
  const id = idOf(message.id);
  if (accountId === undefined || id === undefined) return null;
  const thread = message.thread === null || message.thread === undefined ? null : (idOf(message.thread) ?? null);
  const rfc822Id = rfc822IdOf(message.rfc822Id);
  return { channel: message.channel, accountId, id, thread, ...(rfc822Id === undefined ? {} : { rfc822Id }) };
}

/**
 * A record as this release keeps it, rebuilt field by field — or null when it is not one: a field that would change
 * what it means (its state, its holder, its offer, its times) cannot be read. Anything else is dropped.
 */
export function takeRecordOf(raw: unknown): TakeRecord | null {
  const record = own(raw);
  if (record === undefined || record.v !== 1 || !isTakeState(record.state)) return null;
  const message = messageOf(record.message);
  const holder = heldOf(record.holder ?? null);
  const offer = offerOf(record.offer ?? null);
  const updatedAt = timeOf(record.updatedAt);
  if (message === null || holder === undefined || offer === undefined || updatedAt === undefined) return null;
  const takenAt = record.takenAt === null || record.takenAt === undefined ? null : timeOf(record.takenAt);
  const lastActAt = record.lastActAt === null || record.lastActAt === undefined ? null : timeOf(record.lastActAt);
  if (takenAt === undefined || lastActAt === undefined) return null;
  const state = record.state;
  // What each state needs to mean what it says.
  if ((state === 'taken' || state === 'done') && holder === null) return null;
  if (state === 'taken' && !('person' in (holder as object)) && lastActAt === null) return null;
  if (state === 'offered' && offer === null) return null;
  const pins = Array.isArray(record.pins)
    ? [...new Set(record.pins.filter((pin): pin is string => typeof pin === 'string' && APPROVAL_ID.test(pin)))]
    : [];
  const history = Array.isArray(record.history)
    ? record.history.flatMap((line) => {
        const read = lineOf(line);
        return read === null ? [] : [read];
      })
    : [];
  return {
    v: 1,
    message,
    state,
    holder: state === 'open' || state === 'offered' ? null : holder,
    offer: state === 'offered' ? offer : null,
    takenAt: state === 'taken' || state === 'done' ? takenAt : null,
    lastActAt: state === 'taken' || state === 'done' ? lastActAt : null,
    pins: state === 'taken' ? pins : [],
    history: history.slice(-MAX_TAKE_HISTORY),
    updatedAt,
  };
}

// ── Who is who ─────────────────────────────────────────────────────────────────────────────────────────────────

export function isPerson(held: TakeHolder | TakePerson | null | undefined): held is TakePerson {
  return typeof held === 'object' && held !== null && 'person' in held && held.person === true;
}

/**
 * T2: whether `caller` is the session that holds a take. When both have a Claude Code session id, that decides — two
 * different ids never match, whatever their keys. Otherwise the same process, or the same key when both are an agent
 * window's (grouped): a key of a process's own matches only that process.
 */
export function sameSession(holder: TakeHolder, caller: TakeHolder): boolean {
  if (holder.sessionId !== null && caller.sessionId !== null) return holder.sessionId === caller.sessionId;
  if (holder.process === caller.process) return true;
  return holder.grouped && caller.grouped && holder.key === caller.key;
}

/** T4: whether `caller` is the window an offer is for, by the same rule as a holder (T2). */
export function offeredTo(window: TakeWindow, caller: TakeHolder): boolean {
  if (window.sessionId !== null && caller.sessionId !== null) return window.sessionId === caller.sessionId;
  return window.key !== null && caller.grouped && window.key === caller.key;
}

function holdsIt(record: TakeRecord, caller: TakeCaller): boolean {
  const session = sessionOf(caller);
  return session !== null && record.holder !== null && !isPerson(record.holder) && sameSession(record.holder, session);
}

/** A session as a take holds it, from the activity session it was worked out as and its Claude Code session id. */
export function holderOfSession(session: ActivitySession, sessionId: string | null): TakeHolder {
  return {
    key: session.key,
    grouped: session.grouped,
    process: session.process,
    sessionId,
    parent: session.parent ?? null,
    folder: session.folder,
    client: session.client ?? null,
  };
}

/** The Claude Code session id this process was started with, when it is one. */
export function claudeCodeSessionId(env: NodeJS.ProcessEnv): string | null {
  const raw = env.CLAUDE_CODE_SESSION_ID?.trim().toLowerCase();
  return isClaudeCodeSessionId(raw) ? raw : null;
}

export interface TakerIdentityOptions {
  /** The environment `CLAUDE_CODE_SESSION_ID` is read from; the process's own by default. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  /** The MCP connection's own session id, where its transport has one (`SessionIdentityOptions.connection`). */
  readonly connection?: string | undefined;
  /** For a test: the activity session, worked out by the test. */
  readonly identity?: (() => Promise<ActivitySession>) | undefined;
  /** For a test: the seams `sessionIdentity` takes. */
  readonly session?: SessionIdentityOptions | undefined;
}

/**
 * Who this call is, as a take holds it (T2): core's activity session — an MCP server's agent window, or a command's
 * window when it runs in one — and the Claude Code session id from the environment, which the event service's server
 * read alone until now. Never from an argument.
 *
 * `null` for the person: a command that joined no agent window and has no session id, at their own terminal. They are
 * never held to taking (T6). A server is never the person, and neither is that same command where a known coding
 * agent's marker is set, or inside an MCP server's process: it is `TakeUnmatched` (M4), held to every gate.
 */
export async function takerIdentity(
  core: { readonly activity: SessionIdentityOptions['log'] },
  surface: Exclude<ActivitySurface, 'daemon'>,
  clientInfo?: ClientInfo | undefined,
  options: TakerIdentityOptions = {},
): Promise<TakeCaller> {
  const env = options.env ?? process.env;
  const sessionId = claudeCodeSessionId(env);
  const session =
    options.identity === undefined
      ? await sessionIdentity(surface, clientInfo, {
          ...options.session,
          log: core.activity,
          ...(options.connection === undefined ? {} : { connection: options.connection }),
        })
      : await options.identity();
  if (surface === 'cli' && !session.grouped && sessionId === null) {
    // M4: no window, no session id — the person, unless an agent's marker, or an MCP server's, says otherwise.
    const marker = agentMarker(env) ?? (mcpServerOf(env) === undefined ? null : MCP_SERVER_MARKER);
    return marker === null ? null : { unmatched: true, marker };
  }
  const caller = holderOfSession(session, sessionId);
  // A command that joined no window names the process above it — the shell it ran in, which ends as soon as it has —
  // not the window's: it holds no parent, and its take lapses by its lease alone.
  return surface === 'cli' && !session.grouped ? { ...caller, parent: null } : caller;
}

/**
 * The holder after the same session acts again (T2): what this caller says of itself, and — where it says less, as a
 * command in the window's shell does — what was known of the session before: an agent window's grouped key, its
 * parent, its folder and its client. So a renewal from a shell never loses the window a take would end with.
 */
export function refreshedHolder(held: TakeHolder | TakePerson | null, caller: TakeHolder): TakeHolder {
  if (held === null || isPerson(held)) return caller;
  const keepKey = held.grouped && !caller.grouped;
  return {
    key: keepKey ? held.key : caller.key,
    grouped: keepKey ? held.grouped : caller.grouped,
    process: keepKey ? held.process : caller.process,
    sessionId: caller.sessionId ?? held.sessionId,
    parent: caller.parent ?? held.parent,
    folder: caller.folder ?? held.folder,
    client: caller.client ?? held.client,
  };
}

/** The terminal a person's act comes from, for its line: its folder and the processes above it (§10). Never throws. */
export async function takeTerminal(
  core: { readonly activity: SessionIdentityOptions['log'] },
  options: { readonly identity?: (() => Promise<ActivitySession>) | undefined } = {},
): Promise<TakeTerminal> {
  try {
    const session =
      options.identity === undefined
        ? await sessionIdentity('cli', undefined, { log: core.activity })
        : await options.identity();
    return { folder: session.folder, ancestors: [...(session.ancestors ?? [])].slice(0, MAX_ANCESTORS) };
  } catch {
    return { folder: null, ancestors: [] };
  }
}

// ── What a record says to a caller ─────────────────────────────────────────────────────────────────────────────

/** Who has a message, in T7's closed words. */
export type TakenBy = 'you' | 'another session' | 'the person';

/**
 * Who has a message, as an agent sees it (T7, §6): its state, who holds it and since when, who it is offered to and
 * until when, and the closed reasons it was handed back for — never a note, a folder, a client, a key or a session id.
 * `leaseUntil` is the caller's own take's: when it lapses with no further act, or null while an approval holds it.
 * `null` for a message nobody has taken, offered or handed back.
 */
export type TakenView = {
  readonly state: TakeState;
  readonly by?: TakenBy | undefined;
  readonly since?: string | undefined;
  readonly leaseUntil?: string | null | undefined;
  readonly offered?: { readonly to: 'you' | 'another session'; readonly until: string | null } | undefined;
  readonly handedBack?: readonly HandBackReason[] | undefined;
} | null;

function leaseUntilOf(record: TakeRecord): string | null {
  if (record.state !== 'taken' || record.lastActAt === null || isPerson(record.holder)) return null;
  if (record.pins.length > 0) return null;
  return new Date(Date.parse(record.lastActAt) + TAKE_LEASE_MS).toISOString();
}

function handedBackOf(record: TakeRecord): HandBackReason[] {
  // Since the message was last taken or kept: what the current state comes after.
  let from = 0;
  record.history.forEach((line, index) => {
    if (line.kind === 'taken' || line.kind === 'kept') from = index + 1;
  });
  const reasons = record.history
    .slice(from)
    .flatMap((line) => (line.kind === 'handed-back' && line.reason !== undefined ? [line.reason] : []));
  return [...new Set(reasons)];
}

/** A record as `caller` may see it (T7). */
export function takenViewOf(record: TakeRecord | null, caller: TakeCaller): TakenView {
  if (record === null) return null;
  const handedBack = handedBackOf(record);
  const back = handedBack.length > 0 ? { handedBack } : {};
  switch (record.state) {
    case 'open':
      return handedBack.length > 0 ? { state: 'open', ...back } : null;
    case 'offered': {
      const offer = record.offer as TakeOffer;
      const session = sessionOf(caller);
      const mine = session !== null && offeredTo(offer.to, session);
      return { state: 'offered', offered: { to: mine ? 'you' : 'another session', until: offer.until }, ...back };
    }
    default: {
      const by: TakenBy = isPerson(record.holder) ? 'the person' : holdsIt(record, caller) ? 'you' : 'another session';
      return {
        state: record.state,
        by,
        ...(record.takenAt === null ? {} : { since: record.takenAt }),
        ...(by === 'you' && record.state === 'taken' ? { leaseUntil: leaseUntilOf(record) } : {}),
        ...back,
      };
    }
  }
}

// ── Refusals ───────────────────────────────────────────────────────────────────────────────────────────────────

/** A time as the person reads it on this machine's clock: `11:20`. */
export function clockTime(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return iso;
  return `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`;
}

/** What a refusal needs to say of the act: the account by name, the message as shown, the act, and how to take it. */
export interface TakeAct {
  /** The account by name: `acme/slack`. */
  readonly account: string;
  /** The message as a refusal names it: `C0123/1729936800.000100`, or Gmail's id. */
  readonly shown: string;
  /** The act, by its capability id: `slack.react`, `gmail.draft.reply`. */
  readonly act: string;
  /** How this surface takes it: `slack_take (step "take")`, or the command. */
  readonly takeWith: string;
}

/** §6: `TAKE_REQUIRED` — the account asks a session to take a message first, and this one has not. */
export function takeRequired(act: TakeAct, offeredUntil?: string | null | undefined): CommsError {
  const offered =
    offeredUntil === undefined
      ? ''
      : offeredUntil === null
        ? ' It is offered to this session: take it before acting, or hand it back.'
        : ` It is offered to this session until ${clockTime(offeredUntil)}: take it before acting, or hand it back.`;
  return new CommsError(
    'TAKE_REQUIRED',
    `${act.account} asks a session to take a message before acting on it, and this session has not taken ${act.shown}`,
    {
      hint: `Take it with ${act.takeWith} if it is yours; otherwise leave it, or hand it back.${offered}`,
      details: { reason: 'NOT_TAKEN', act: act.act, message: act.shown },
    },
  );
}

/**
 * M4: `TAKE_REQUIRED` for an agent's shell that is no session — it cannot take the message, so it is told why, and where
 * it can act on it instead.
 */
export function unmatchedTakeRequired(act: TakeAct, caller: TakeUnmatched): CommsError {
  return new CommsError(
    'TAKE_REQUIRED',
    `${act.account} asks a session to take a message before acting on it, and this command runs in an agent’s shell that joined no agent window and has no Claude Code session id, so no take can be matched to it`,
    {
      hint: `Act on ${act.shown} through ${act.account}’s tools over MCP, in the agent’s window, taking it there first; or leave it for the person.`,
      details: { reason: 'NO_SESSION', act: act.act, message: act.shown, marker: caller.marker },
    },
  );
}

/** M4: a take step from an agent's shell that is no session: a take made there could be matched to nothing it does next. */
export function unmatchedTakesNothing(caller: TakeUnmatched): CommsError {
  return new CommsError(
    'USAGE',
    'this command runs in an agent’s shell that joined no agent window and has no Claude Code session id, so a take made here could be matched to nothing it does next',
    {
      hint: 'Take it with this channel’s take tool over MCP, in the agent’s window; or leave it for the person.',
      details: { reason: 'NO_SESSION', marker: caller.marker },
    },
  );
}

/** `TAKE_REQUIRED` for this caller: a session that has not taken the message, or an agent's shell that can take none. */
function requiredOf(act: TakeAct, caller: TakeHolder | TakeUnmatched): CommsError {
  return isUnmatched(caller) ? unmatchedTakeRequired(act, caller) : takeRequired(act);
}

const ELSEWHERE_HINT = 'Leave it. The person can give it to this session in Agent Comms → Messages.';

/** §6: `TAKEN_ELSEWHERE` — someone else has this message. It never names the other session (T7). */
export function takenElsewhere(reason: TakenElsewhereReason, until?: string | null | undefined): CommsError {
  const message =
    reason === 'HELD'
      ? 'another session has taken this message'
      : reason === 'OFFERED'
        ? until === null || until === undefined
          ? 'this message is offered to another session'
          : `this message is offered to another session until ${clockTime(until)}`
        : reason === 'DONE'
          ? 'another session marked this message done'
          : 'the person is handling this message';
  return new CommsError('TAKEN_ELSEWHERE', message, {
    hint: ELSEWHERE_HINT,
    details: { reason, ...(reason === 'OFFERED' && until !== undefined ? { until } : {}) },
  });
}

/** Why `caller` may not act on `record`, or null when nothing someone else holds stands in the way. */
function elsewhere(record: TakeRecord, caller: TakeCaller): CommsError | null {
  switch (record.state) {
    case 'open':
      return null;
    case 'offered': {
      const offer = record.offer as TakeOffer;
      const session = sessionOf(caller);
      return session !== null && offeredTo(offer.to, session) ? null : takenElsewhere('OFFERED', offer.until);
    }
    default:
      if (isPerson(record.holder)) return takenElsewhere('PERSON');
      if (holdsIt(record, caller)) return null;
      return takenElsewhere(record.state === 'done' ? 'DONE' : 'HELD');
  }
}

// ── The store ──────────────────────────────────────────────────────────────────────────────────────────────────

/** Whether a holder's parent is still the process it was: `gone` once it has ended, or its pid is another's. */
export type ParentCheck = (parent: ActivityParent) => Promise<'alive' | 'gone' | 'unknown'>;

export interface TakeStoreOptions {
  readonly now?: (() => Date) | undefined;
  /**
   * Whether an approval a take was pinned by still waits — pending, or approved and not yet claimed. Left out, every
   * pin counts as waiting: no take expires under one until its state changes.
   */
  readonly pinLive?: ((approvalId: string) => Promise<boolean>) | undefined;
  /** For a test: how a process is read (`psProbe`), whether a pid is running, and the system. */
  readonly probe?: ProcessProbe | undefined;
  readonly running?: ((pid: number) => boolean) | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  /** The ids of every connected account, for the daily prune to drop the folders of the rest. */
  readonly accountIds?: (() => Promise<ReadonlySet<string> | null>) | undefined;
}

/** Whether `pid` is a running process, as `kill(pid, 0)` says: false only for one that is not there. */
function runningPid(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

/** The message key (§4): `<channel>:<accountId>:<id>`, as the event service's dedupe key and `activity items` name it. */
export function takeMessageKey(ref: TakeMessageRef): string {
  return `${ref.channel}:${ref.accountId}:${ref.id}`;
}

/** Checks a reference as a channel hands it over, before any file is named from it. */
export function checkedTakeRef(ref: TakeMessageRef): TakeMessageRef {
  if (!isTakeChannel(ref.channel))
    throw new CommsError('USAGE', `"${String(ref.channel).slice(0, 20)}" takes no messages`);
  if (typeof ref.accountId !== 'string' || !ACCOUNT_ID.test(ref.accountId)) {
    throw new CommsError('USAGE', 'a take names its account by id');
  }
  if (typeof ref.id !== 'string' || !TAKE_ID_PATTERN.test(ref.id)) {
    throw new CommsError('USAGE', `"${String(ref.id).slice(0, 40)}" is not a message id`, {
      hint: 'A Gmail message id, a Slack message as <channelId>/<ts>, or a Resend received email id.',
    });
  }
  return { channel: ref.channel, accountId: ref.accountId, id: ref.id };
}

/** The window an offer reserves a message for, as a record keeps it: by a session id or a key, or refused as USAGE. */
function checkedWindow(window: TakeWindow): TakeWindow {
  const kept = windowOf(window);
  if (kept === null) {
    throw new CommsError('USAGE', 'an offer names its window by a Claude Code session id or an activity session key');
  }
  return kept;
}

/** The rule and delivery a delivery's offer came with, as ids, or refused as USAGE. */
function checkedSource(by: { readonly rule: string; readonly delivery: string }): {
  readonly rule: string;
  readonly delivery: string;
} {
  if (typeof by?.rule !== 'string' || !OFFER_RULE.test(by.rule)) {
    throw new CommsError('USAGE', 'an offer names the rule it came with by its id');
  }
  if (typeof by.delivery !== 'string' || by.delivery.length > MAX_WORD || !TAKE_ID_PATTERN.test(by.delivery)) {
    throw new CommsError('USAGE', 'an offer names the delivery it came with by its id');
  }
  return { rule: by.rule, delivery: by.delivery };
}

/** Whether an offer is the waiting one `delivery` made: no time yet, its item still waiting for the window. */
function waitingOfferOf(record: TakeRecord | null, delivery: string): TakeOffer | null {
  if (record === null || record.state !== 'offered' || record.offer === null) return null;
  const offer = record.offer;
  if ('person' in offer.by || offer.by.delivery !== delivery || offer.until !== null) return null;
  return offer;
}

/** A note as a record keeps it: trimmed, at most 200 characters, or refused as USAGE when longer. */
export function checkedNote(note: unknown): string | undefined {
  if (note === undefined || note === null) return undefined;
  if (typeof note !== 'string') throw new CommsError('USAGE', 'a note is text');
  const trimmed = note.trim();
  if (trimmed === '') return undefined;
  if (Array.from(trimmed).length > MAX_TAKE_NOTE_CHARS) {
    throw new CommsError('USAGE', `a note is at most ${MAX_TAKE_NOTE_CHARS} characters`, {
      hint: 'It is for the person, who reads it in the message’s story. Other sessions never see it.',
    });
  }
  return trimmed;
}

/** What a take, a hand-back or a done did: the record as it now stands, and the caller's view of it. */
export interface TakeOutcome {
  readonly record: TakeRecord;
  readonly view: TakenView;
  /** For a take: false when the caller held it already and only renewed it. */
  readonly changed: boolean;
}

/** What a gated act found: the preview's line when the caller holds the message, and whether it does. */
export interface TakeGatePass {
  readonly held: boolean;
  /** "Taken by this session at 11:02." — or null when the act passed without a take. */
  readonly line: string | null;
}

/** One record as `list` gives it, with the file's state when it cannot be read. */
export type ListedTake =
  | { readonly record: TakeRecord }
  | { readonly unreadable: { readonly accountId: string; readonly file: string } };

function windowLine(holder: TakeHolder): Pick<TakeLine, 'windowKey' | 'window'> {
  return {
    windowKey: holder.key,
    window: { sessionId: holder.sessionId, folder: holder.folder, client: holder.client },
  };
}

function withLine(record: TakeRecord, line: TakeLine): TakeLine[] {
  return [...record.history, line].slice(-MAX_TAKE_HISTORY);
}

/** A record no take has written yet: open, with no history. */
function blank(message: TakeMessage, at: string): TakeRecord {
  return {
    v: 1,
    message,
    state: 'open',
    holder: null,
    offer: null,
    takenAt: null,
    lastActAt: null,
    pins: [],
    history: [],
    updatedAt: at,
  };
}

/** A record put back to open: no holder, no offer, no pins. */
function opened(record: TakeRecord, line: TakeLine, at: string): TakeRecord {
  return {
    ...record,
    state: 'open',
    holder: null,
    offer: null,
    takenAt: null,
    lastActAt: null,
    pins: [],
    history: withLine(record, line),
    updatedAt: at,
  };
}

export class TakeStore {
  readonly directory: string;
  readonly #now: () => Date;
  readonly #pinLive: ((approvalId: string) => Promise<boolean>) | undefined;
  readonly #probe: ProcessProbe;
  readonly #running: (pid: number) => boolean;
  readonly #platform: NodeJS.Platform;
  readonly #accountIds: (() => Promise<ReadonlySet<string> | null>) | undefined;
  #prunedDay: string | null = null;

  constructor(stateDir: string, options: TakeStoreOptions = {}) {
    this.directory = join(stateDir, 'takes');
    this.#now = options.now ?? (() => new Date());
    this.#pinLive = options.pinLive;
    this.#probe = options.probe ?? psProbe;
    this.#running = options.running ?? runningPid;
    this.#platform = options.platform ?? process.platform;
    this.#accountIds = options.accountIds;
  }

  #path(ref: TakeMessageRef): string {
    const checked = checkedTakeRef(ref);
    const name = createHash('sha256').update(takeMessageKey(checked)).digest('hex');
    return join(this.directory, checked.accountId, `${name}.json`);
  }

  /**
   * The record for a message, as the file holds it — null when there is none. One this release cannot read counts as
   * held by another session (`unreadable`): what it said is not known, and the person's `takes release` writes it anew.
   */
  async #readFile(path: string): Promise<TakeRecord | null | 'unreadable'> {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      return 'unreadable';
    }
    try {
      return takeRecordOf(JSON.parse(text)) ?? 'unreadable';
    } catch {
      return 'unreadable';
    }
  }

  /** The record as it stands, lapses worked out on the lease alone (no process is looked at), or null. */
  async read(ref: TakeMessageRef): Promise<TakeRecord | null | 'unreadable'> {
    const found = await this.#readFile(this.#path(ref));
    if (found === null || found === 'unreadable') return found;
    return (await this.#settle(found, null)).record;
  }

  /**
   * Works out what has lapsed (T3, T4), at the time it happened: an offer past its time; a take with no approval
   * waiting under it, sixty minutes after its last act; and — only when `probing`, for a caller that is not the holder —
   * a take whose holder's parent has gone.
   */
  async #settle(
    record: TakeRecord,
    probing: Map<string, Promise<'alive' | 'gone' | 'unknown'>> | null,
  ): Promise<{ record: TakeRecord; changed: boolean }> {
    const now = this.#now();
    const until = record.state === 'offered' ? (record.offer?.until ?? null) : null;
    if (until !== null && Date.parse(until) <= now.getTime()) {
      const line: TakeLine = { at: until, kind: 'expired', by: 'service', windowKey: record.offer?.to.key ?? null };
      return { record: opened(record, line, now.toISOString()), changed: true };
    }
    if (record.state !== 'taken' || record.holder === null || isPerson(record.holder))
      return { record, changed: false };
    const holder = record.holder;
    let pins = [...record.pins];
    if (pins.length > 0 && this.#pinLive !== undefined) {
      const live: string[] = [];
      for (const pin of pins) if (await this.#pinLive(pin).catch(() => true)) live.push(pin);
      pins = live;
    }
    const pinsChanged = pins.length !== record.pins.length;
    const lastAct = Date.parse(record.lastActAt as string);
    if (pins.length === 0 && lastAct + TAKE_LEASE_MS <= now.getTime()) {
      const line: TakeLine = {
        at: new Date(lastAct + TAKE_LEASE_MS).toISOString(),
        kind: 'expired',
        by: 'service',
        ...windowLine(holder),
      };
      return { record: opened(record, line, now.toISOString()), changed: true };
    }
    if (probing !== null && holder.parent !== null && (await this.#parentState(holder.parent, probing)) === 'gone') {
      const line: TakeLine = { at: now.toISOString(), kind: 'ended', by: 'service', ...windowLine(holder) };
      return { record: opened(record, line, now.toISOString()), changed: true };
    }
    return pinsChanged
      ? { record: { ...record, pins, updatedAt: now.toISOString() }, changed: true }
      : { record, changed: false };
  }

  /** T3's `ended`: the holder's parent gone, or its pid now another process's. Looked at once per parent per call. */
  #parentState(
    parent: ActivityParent,
    seen: Map<string, Promise<'alive' | 'gone' | 'unknown'>>,
  ): Promise<'alive' | 'gone' | 'unknown'> {
    const key = `${parent.pid}\0${parent.startedAt}`;
    let held = seen.get(key);
    if (held === undefined) {
      held = (async () => {
        // On Windows no parent is read (activity.ts): a take there lapses by its lease alone (§12).
        if (this.#platform === 'win32') return 'unknown';
        if (!this.#running(parent.pid)) return 'gone';
        const facts = await this.#probe(parent.pid, PROBE_MS).catch(() => null);
        if (facts === null) return 'unknown';
        return facts.startedAt === parent.startedAt ? 'alive' : 'gone';
      })();
      seen.set(key, held);
    }
    return held;
  }

  /**
   * Reads, settles and writes one record under its lock. `decide` gets the record as it now stands — lapses worked out,
   * a holder's parent looked at when `probe` — and returns the record to write (or the same one, for none) and what to
   * return. A refusal it throws writes only what settling found.
   */
  async #update<T>(
    message: TakeMessage | TakeMessageRef,
    probe: boolean,
    decide: (current: TakeRecord | null, at: string) => { next: TakeRecord | null; result: T },
    /** What a record that cannot be read is: refused as held by another session, or — for the person — replaced. */
    unreadable: 'refuse' | 'replace' = 'refuse',
  ): Promise<T> {
    const path = this.#path(message);
    const value = await withFileLock(`${path}.lock`, async () => {
      const found = await this.#readFile(path);
      const at = this.#now().toISOString();
      let current: TakeRecord | null;
      let settledChanged = false;
      if (found === 'unreadable') {
        if (unreadable === 'refuse') throw takenElsewhere('HELD');
        // What it said is not known: the person's act writes it anew, as a record whose state nobody holds.
        const ref = checkedTakeRef(message);
        current = {
          ...blank({ ...ref, thread: 'thread' in message ? message.thread : null }, at),
          state: 'taken',
          holder: { person: true },
          takenAt: at,
          lastActAt: at,
        };
        settledChanged = true;
      } else if (found === null) current = null;
      else {
        const settled = await this.#settle(found, probe ? new Map() : null);
        current = settled.record;
        settledChanged = settled.changed;
      }
      let decided: { next: TakeRecord | null; result: T };
      try {
        decided = decide(current, at);
      } catch (error) {
        if (settledChanged && current !== null) await this.#write(path, current);
        throw error;
      }
      if (decided.next !== null && (decided.next !== current || settledChanged)) await this.#write(path, decided.next);
      return decided.result;
    });
    void this.#maybePrune();
    return value;
  }

  async #write(path: string, record: TakeRecord): Promise<void> {
    // Rebuilt field by field once more on the way out: nothing but what a record holds is ever written.
    const kept = takeRecordOf(JSON.parse(JSON.stringify(record)));
    if (kept === null)
      throw new CommsError('UNEXPECTED', 'a take record was about to be written that could not be read back');
    await writeFileAtomic(path, `${JSON.stringify(kept)}\n`);
  }

  // ── A session's acts ────────────────────────────────────────────────────────────────────────────────────────

  /**
   * A session takes a message (T2–T4), or renews its own take: the first take wins. The channel has checked the
   * message with its provider first — it exists and is inbound (T5) — and hands it over with its thread.
   *
   * Refused with `TAKEN_ELSEWHERE` while another session holds it, it is offered to another, another marked it done,
   * or the person keeps it. A take of one's own done message takes it again.
   */
  async take(message: TakeMessage, caller: TakeHolder): Promise<TakeOutcome> {
    const checked = {
      ...checkedTakeRef(message),
      thread: message.thread,
      ...(message.rfc822Id === undefined ? {} : { rfc822Id: message.rfc822Id }),
    };
    return this.#update<TakeOutcome>(checked, true, (current, at) => {
      const record = current ?? blank(checked, at);
      const refusal = elsewhere(record, caller);
      if (refusal !== null) throw refusal;
      const renewing = record.state === 'taken' && holdsIt(record, caller);
      const next: TakeRecord = renewing
        ? { ...record, holder: refreshedHolder(record.holder, caller), lastActAt: at, updatedAt: at }
        : {
            ...record,
            message: {
              ...record.message,
              thread: checked.thread ?? record.message.thread,
              ...(checked.rfc822Id === undefined ? {} : { rfc822Id: checked.rfc822Id }),
            },
            state: 'taken',
            holder: caller,
            offer: null,
            takenAt: at,
            lastActAt: at,
            pins: [],
            history: withLine(record, { at, kind: 'taken', by: 'window', ...windowLine(caller) }),
            updatedAt: at,
          };
      return { next, result: { record: next, view: takenViewOf(next, caller), changed: !renewing } };
    });
  }

  /**
   * The holder hands a message back (T3, T8): open again, with its closed reason for everyone and its note for the
   * person alone. The window an offer is for may hand the offer back too. Anyone else is refused: `TAKEN_ELSEWHERE`
   * while someone else has it, `TAKE_REQUIRED` when nobody does.
   */
  async handBack(
    ref: TakeMessageRef,
    caller: TakeHolder,
    reason: HandBackReason,
    note: string | undefined,
    act: TakeAct,
  ): Promise<TakeOutcome> {
    if (!isHandBackReason(reason)) {
      throw new CommsError('USAGE', `a hand-back's reason is one of ${HAND_BACK_REASONS.join(', ')}`);
    }
    const kept = checkedNote(note);
    return this.#update<TakeOutcome>(ref, true, (current, at) => {
      if (current === null || current.state === 'open') throw takeRequired(act);
      const refusal = elsewhere(current, caller);
      if (refusal !== null) throw refusal;
      if (current.state === 'done') throw takenElsewhere('DONE');
      const line: TakeLine = {
        at,
        kind: 'handed-back',
        by: 'window',
        ...windowLine(caller),
        reason,
        ...(kept === undefined ? {} : { note: kept }),
      };
      const next = opened(current, line, at);
      return { next, result: { record: next, view: takenViewOf(next, caller), changed: true } };
    });
  }

  /** The holder marks a message done (T3): others stay refused. Only the holder may; a note is the person's. */
  async finish(ref: TakeMessageRef, caller: TakeHolder, note: string | undefined, act: TakeAct): Promise<TakeOutcome> {
    const kept = checkedNote(note);
    return this.#update<TakeOutcome>(ref, true, (current, at) => {
      if (current === null || current.state === 'open') throw takeRequired(act);
      if (current.state === 'offered') {
        const offer = current.offer as TakeOffer;
        throw offeredTo(offer.to, caller) ? takeRequired(act, offer.until) : takenElsewhere('OFFERED', offer.until);
      }
      const refusal = elsewhere(current, caller);
      if (refusal !== null) throw refusal;
      if (current.state === 'done')
        return { next: current, result: { record: current, view: takenViewOf(current, caller), changed: false } };
      const next: TakeRecord = {
        ...current,
        state: 'done',
        lastActAt: at,
        pins: [],
        history: withLine(current, {
          at,
          kind: 'done',
          by: 'window',
          ...windowLine(caller),
          ...(kept === undefined ? {} : { note: kept }),
        }),
        updatedAt: at,
      };
      return { next, result: { record: next, view: takenViewOf(next, caller), changed: true } };
    });
  }

  /**
   * §6: an act that answers a message — a reply, a reaction, an acknowledgement — at prepare and again at the claim.
   *
   * The person (`caller` null) is never held to taking. A session passes when it holds the message, which renews its
   * lease and, given `approvalId`, pins the take while that approval waits. Otherwise it is refused with
   * `TAKEN_ELSEWHERE` when anyone else has the message — whether or not taking is required, a take is respected
   * wherever one exists — and with `TAKE_REQUIRED` when `required` and this session has not taken it: an offer to it
   * included, since the offered session must still take it (T4). An agent's shell that is no session (M4) holds
   * nothing: it is refused wherever anyone has the message, and wherever a take is required.
   */
  async gate(
    ref: TakeMessageRef,
    caller: TakeCaller,
    act: TakeAct,
    options: { readonly required: boolean; readonly approvalId?: string | undefined },
  ): Promise<TakeGatePass> {
    if (caller === null) return { held: false, line: null };
    const session = sessionOf(caller);
    const path = this.#path(ref);
    // Nothing recorded: nobody has it, and nothing is written to say so.
    if ((await this.#readFile(path)) === null) {
      if (options.required) throw requiredOf(act, caller);
      return { held: false, line: null };
    }
    const pin =
      options.approvalId !== undefined && APPROVAL_ID.test(options.approvalId) ? options.approvalId : undefined;
    return this.#update<TakeGatePass>(ref, true, (current, at) => {
      if (current === null || current.state === 'open') {
        if (options.required) throw requiredOf(act, caller);
        return { next: current, result: { held: false, line: null } };
      }
      if (current.state === 'offered') {
        const offer = current.offer as TakeOffer;
        if (session === null || !offeredTo(offer.to, session)) throw takenElsewhere('OFFERED', offer.until);
        if (options.required) throw takeRequired(act, offer.until);
        return { next: current, result: { held: false, line: null } };
      }
      const refusal = elsewhere(current, caller);
      if (refusal !== null) throw refusal;
      // Only the holder comes this far, and an agent's shell that is no session holds nothing.
      if (session === null) throw takenElsewhere('HELD');
      const line = `Taken by this session at ${clockTime(current.takenAt ?? at)}.`;
      if (current.state === 'done') return { next: current, result: { held: true, line } };
      const pins = pin === undefined || current.pins.includes(pin) ? [...current.pins] : [...current.pins, pin];
      const next: TakeRecord = {
        ...current,
        holder: refreshedHolder(current.holder, session),
        lastActAt: at,
        pins,
        updatedAt: at,
      };
      return { next, result: { held: true, line } };
    });
  }

  /**
   * T6: housekeeping — organising, binning — needs no take, but is refused on a message someone else has. The person is
   * never refused; an agent's shell that is no session (M4) is refused on any message anyone has. Nothing is written but
   * what a lapse found.
   */
  async refuseHeldElsewhere(refs: readonly TakeMessageRef[], caller: TakeCaller): Promise<void> {
    if (caller === null) return;
    for (const ref of refs) {
      const path = this.#path(ref);
      const found = await this.#readFile(path);
      if (found === null) continue;
      if (found === 'unreadable') throw takenElsewhere('HELD');
      // A quick look first; only a record someone else seems to hold is looked at under its lock, with its holder's parent.
      if (elsewhere((await this.#settle(found, null)).record, caller) === null) continue;
      await this.#update(ref, true, (current) => {
        const refusal = current === null ? null : elsewhere(current, caller);
        if (refusal !== null) throw refusal;
        return { next: current, result: undefined };
      });
    }
  }

  /**
   * Who has each message (T7), for a read's `taken` and for `taken`: one file look per message, lapses worked out on the
   * lease alone, nothing written. An unreadable record reads as held by another session.
   */
  async views(refs: readonly TakeMessageRef[], caller: TakeCaller): Promise<Map<string, TakenView>> {
    const views = new Map<string, TakenView>();
    for (const ref of refs) {
      if (views.has(ref.id)) continue;
      let found: TakeRecord | null | 'unreadable';
      try {
        found = await this.read(ref);
      } catch {
        found = null;
      }
      views.set(
        ref.id,
        found === 'unreadable' ? { state: 'taken', by: 'another session' } : takenViewOf(found, caller),
      );
    }
    return views;
  }

  /**
   * The messages in one account this session holds or is offered (`taken` with no ids), newest first. The person, and
   * an agent's shell that is no session, hold none here.
   */
  async mine(channel: TakeChannel, accountId: string, caller: TakeCaller): Promise<{ id: string; view: TakenView }[]> {
    const session = sessionOf(caller);
    if (session === null) return [];
    const listed = await this.list({ accountId });
    return listed
      .flatMap((entry) => ('record' in entry && entry.record.message.channel === channel ? [entry.record] : []))
      .filter((record) => {
        if (record.state === 'offered') return record.offer !== null && offeredTo(record.offer.to, session);
        return holdsIt(record, session);
      })
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .map((record) => ({ id: record.message.id, view: takenViewOf(record, caller) }));
  }

  /**
   * Whether an account has any take record at all: one directory look. A channel asks it before reading its provider
   * for the message an act answers, so an account where nobody takes anything is asked nothing more than before.
   */
  async recordsIn(accountId: string): Promise<boolean> {
    if (!ACCOUNT_ID.test(accountId)) return false;
    try {
      return (await readdir(join(this.directory, accountId))).some((name) => RECORD_FILE.test(name));
    } catch {
      return false;
    }
  }

  /** The record a mail's Message-ID was taken under in one account, if any: how a reply by In-Reply-To finds its take. */
  async findByRfc822(channel: TakeChannel, accountId: string, rfc822Id: string): Promise<TakeMessageRef | null> {
    const wanted = rfc822IdOf(rfc822Id);
    if (wanted === undefined) return null;
    for (const entry of await this.list({ accountId })) {
      if ('record' in entry && entry.record.message.channel === channel && entry.record.message.rfc822Id === wanted) {
        return entry.record.message;
      }
    }
    return null;
  }

  // ── The person's acts ───────────────────────────────────────────────────────────────────────────────────────

  /** `takes release`: ends a take, an offer or a done, or the person's own keep, at once. Open already is no change. */
  async release(ref: TakeMessageRef, terminal: TakeTerminal): Promise<{ record: TakeRecord | null; changed: boolean }> {
    return this.#update<{ record: TakeRecord | null; changed: boolean }>(
      ref,
      false,
      (current, at) => {
        if (current === null) throw notTaken(ref);
        if (current.state === 'open') return { next: current, result: { record: current, changed: false } };
        const holder = current.holder !== null && !isPerson(current.holder) ? current.holder : null;
        const line: TakeLine = {
          at,
          kind: 'released',
          by: 'person',
          windowKey: holder?.key ?? current.offer?.to.key ?? null,
          terminal,
        };
        const next = opened(current, line, at);
        return { next, result: { record: next, changed: true } };
      },
      'replace',
    );
  }

  /**
   * `takes give`: offers the message to one window for fifteen minutes (T4), ending anyone's take. The window must
   * still take it.
   */
  async give(
    message: TakeMessage,
    window: TakeWindow,
    terminal: TakeTerminal,
  ): Promise<{ record: TakeRecord; changed: boolean }> {
    const checked = { ...checkedTakeRef(message), thread: message.thread };
    return this.#update<{ record: TakeRecord; changed: boolean }>(
      checked,
      false,
      (current, at) => {
        const record = current ?? blank(checked, at);
        const until = new Date(Date.parse(at) + TAKE_OFFER_MS).toISOString();
        const next: TakeRecord = {
          ...record,
          state: 'offered',
          holder: null,
          offer: { to: window, until, by: { person: true } },
          takenAt: null,
          lastActAt: null,
          pins: [],
          history: withLine(record, {
            at,
            kind: 'given',
            by: 'person',
            windowKey: window.key,
            window: { sessionId: window.sessionId, folder: window.folder, client: window.client },
            terminal,
          }),
          updatedAt: at,
        };
        return { next, result: { record: next, changed: true } };
      },
      'replace',
    );
  }

  /** `takes keep`: the person handles the message themselves, and every session is refused (`PERSON`). */
  async keep(message: TakeMessage, terminal: TakeTerminal): Promise<{ record: TakeRecord; changed: boolean }> {
    const checked = { ...checkedTakeRef(message), thread: message.thread };
    return this.#update<{ record: TakeRecord; changed: boolean }>(
      checked,
      false,
      (current, at) => {
        const record = current ?? blank(checked, at);
        if (record.state === 'taken' && isPerson(record.holder))
          return { next: record, result: { record, changed: false } };
        const next: TakeRecord = {
          ...record,
          state: 'taken',
          holder: { person: true },
          offer: null,
          takenAt: at,
          lastActAt: at,
          pins: [],
          history: withLine(record, { at, kind: 'kept', by: 'person', windowKey: null, terminal }),
          updatedAt: at,
        };
        return { next, result: { record: next, changed: true } };
      },
      'replace',
    );
  }

  // ── A delivery's offers: the event service's (T4, §8) ──────────────────────────────────────────────────────────

  /**
   * T4: a rule's delivery offers a message to the window it was delivered to — a lane's bound window, or the session its
   * prompt was posted to. While the offer lasts it is exclusive: any other session's take or act is refused, and the
   * window must still take the message itself. `until` is null while the item waits for the window; `handOffer` starts
   * its fifteen minutes when the window is handed it. The event service writes it best-effort, after its delivery
   * commits.
   *
   * It never takes a message from anyone: one a session holds or has done, one the person keeps, one already offered —
   * by the person or by another delivery — or one whose record cannot be read is left as it is (`changed: false`), and
   * so is this delivery's own offer, made before. Only an open message — nobody's yet, handed back, released or lapsed —
   * is offered. A holder whose parent has gone is looked at first, as when another session meets the take (T3).
   */
  async offer(
    message: TakeMessage,
    window: TakeWindow,
    by: { readonly rule: string; readonly delivery: string },
    until: string | null,
  ): Promise<{ record: TakeRecord | null; changed: boolean }> {
    const checked: TakeMessage = {
      ...checkedTakeRef(message),
      thread: message.thread === null ? null : (idOf(message.thread) ?? null),
    };
    const to = checkedWindow(window);
    const source = checkedSource(by);
    if (until !== null && timeOf(until) === undefined) {
      throw new CommsError('USAGE', 'an offer lasts until a time, or while its item waits (null)');
    }
    try {
      return await this.#update<{ record: TakeRecord | null; changed: boolean }>(checked, true, (current, at) => {
        if (current !== null && current.state !== 'open')
          return { next: current, result: { record: current, changed: false } };
        const record = current ?? blank(checked, at);
        const next: TakeRecord = {
          ...record,
          state: 'offered',
          holder: null,
          offer: { to, until, by: source },
          takenAt: null,
          lastActAt: null,
          pins: [],
          history: withLine(record, {
            at,
            kind: 'offered',
            by: 'service',
            windowKey: to.key,
            window: { sessionId: to.sessionId, folder: to.folder, client: to.client },
          }),
          updatedAt: at,
        };
        return { next, result: { record: next, changed: true } };
      });
    } catch (error) {
      // A record that cannot be read counts as held by another session: the offer leaves it as it is.
      if (error instanceof CommsError && error.code === 'TAKEN_ELSEWHERE') return { record: null, changed: false };
      throw error;
    }
  }

  /**
   * T4: the window `delivery` offered a message to was handed it — woken for it, or its prompt posted — and the offer
   * now lasts until `until`, fifteen minutes on. Only that delivery's offer, and only while it still waits: an offer
   * handed over once is not moved again. Anything else is left as it is, and a message with no record makes none.
   */
  async handOffer(
    ref: TakeMessageRef,
    delivery: string,
    until: string,
  ): Promise<{ record: TakeRecord | null; changed: boolean }> {
    if (timeOf(until) === undefined) throw new CommsError('USAGE', 'an offer lasts until a time');
    return this.#onWaitingOffer(ref, delivery, (current, offer, at) => ({
      ...current,
      offer: { ...offer, until },
      updatedAt: at,
    }));
  }

  /**
   * T4: the item `delivery`'s offer waited with no longer waits for its window — it was closed, it is gone, or its lane
   * is bound to another window now — so the offer lapses at once, and the message is open: the history says `expired`,
   * by the service. Only that delivery's offer, and only while it still waits; an offer handed over lapses at its time.
   */
  async lapseOffer(ref: TakeMessageRef, delivery: string): Promise<{ record: TakeRecord | null; changed: boolean }> {
    return this.#onWaitingOffer(ref, delivery, (current, offer, at) =>
      opened(current, { at, kind: 'expired', by: 'service', windowKey: offer.to.key }, at),
    );
  }

  async #onWaitingOffer(
    ref: TakeMessageRef,
    delivery: string,
    change: (current: TakeRecord, offer: TakeOffer, at: string) => TakeRecord,
  ): Promise<{ record: TakeRecord | null; changed: boolean }> {
    const path = this.#path(ref);
    // Nothing recorded: nothing was offered, and nothing is made to say so.
    if ((await this.#readFile(path)) === null) return { record: null, changed: false };
    try {
      return await this.#update<{ record: TakeRecord | null; changed: boolean }>(ref, false, (current, at) => {
        const offer = waitingOfferOf(current, delivery);
        if (current === null || offer === null) return { next: current, result: { record: current, changed: false } };
        const next = change(current, offer, at);
        return { next, result: { record: next, changed: true } };
      });
    } catch (error) {
      if (error instanceof CommsError && error.code === 'TAKEN_ELSEWHERE') return { record: null, changed: false };
      throw error;
    }
  }

  /**
   * §8, T3: the event service's sweep writes every lapse down, under each record's lock, at the time it happened —
   * `ended` for a take whose holder's parent has gone, `expired` for one past its lease and for an offer past its time —
   * so the story, and "nobody took it", count from then rather than from whenever someone next meets the record. A take
   * still held, an offer still waiting for its window, and the person's keep stand. Returns how many of each it wrote.
   * Each holder's parent is looked at once per sweep, and a record that cannot be written now is left for the next.
   */
  async lapse(): Promise<{ ended: number; expired: number }> {
    const counted = { ended: 0, expired: 0 };
    const probing = new Map<string, Promise<'alive' | 'gone' | 'unknown'>>();
    let accounts: string[];
    try {
      accounts = (await readdir(this.directory)).filter((name) => ACCOUNT_ID.test(name));
    } catch {
      return counted;
    }
    for (const accountId of accounts.sort()) {
      let files: string[];
      try {
        files = (await readdir(join(this.directory, accountId))).filter((name) => RECORD_FILE.test(name));
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const path = join(this.directory, accountId, file);
        const found = await this.#readFile(path);
        if (found === null || found === 'unreadable') continue;
        // Only a session's take, or an offer with a time, can lapse by itself.
        const may =
          (found.state === 'taken' && found.holder !== null && !isPerson(found.holder)) ||
          (found.state === 'offered' && found.offer?.until !== null);
        if (!may) continue;
        await withFileLock(`${path}.lock`, async () => {
          const again = await this.#readFile(path);
          if (again === null || again === 'unreadable') return;
          const settled = await this.#settle(again, probing);
          if (!settled.changed) return;
          await this.#write(path, settled.record);
          if (again.state === 'open' || settled.record.state !== 'open') return;
          const kind = settled.record.history.at(-1)?.kind;
          if (kind === 'ended') counted.ended += 1;
          else if (kind === 'expired') counted.expired += 1;
        }).catch(() => undefined);
      }
    }
    return counted;
  }

  /**
   * Every record held, or one account's, lapses worked out on the lease alone; a file that cannot be read is listed as
   * such. Nothing is written.
   */
  async list(options: { readonly accountId?: string | undefined } = {}): Promise<ListedTake[]> {
    let accounts: string[];
    try {
      accounts =
        options.accountId === undefined
          ? (await readdir(this.directory)).filter((name) => ACCOUNT_ID.test(name))
          : [options.accountId];
    } catch {
      return [];
    }
    const listed: ListedTake[] = [];
    for (const accountId of accounts.sort()) {
      if (!ACCOUNT_ID.test(accountId)) continue;
      let files: string[];
      try {
        files = (await readdir(join(this.directory, accountId))).filter((name) => RECORD_FILE.test(name));
      } catch {
        continue;
      }
      for (const file of files.sort()) {
        const found = await this.#readFile(join(this.directory, accountId, file));
        if (found === null) continue;
        if (found === 'unreadable') listed.push({ unreadable: { accountId, file } });
        else listed.push({ record: (await this.#settle(found, null)).record });
      }
    }
    return listed;
  }

  // ── Retention ───────────────────────────────────────────────────────────────────────────────────────────────

  /** Once a day per process, after a write: never awaited by the act, and never failing it. */
  async #maybePrune(): Promise<void> {
    const day = this.#now().toISOString().slice(0, 10);
    if (this.#prunedDay === day) return;
    this.#prunedDay = day;
    await this.prune().catch(() => undefined);
  }

  /**
   * §4: deletes every record thirty days past its last change, and the folder of every account no longer connected —
   * when the connected ones can be read. An unreadable record is judged by its file's time. Returns what it deleted.
   */
  async prune(): Promise<{ records: number; accounts: string[] }> {
    const cutoff = this.#now().getTime() - TAKE_RETENTION_DAYS * DAY_MS;
    let held: ReadonlySet<string> | null = null;
    try {
      held = (await this.#accountIds?.()) ?? null;
    } catch {
      held = null;
    }
    let accounts: string[];
    try {
      accounts = (await readdir(this.directory)).filter((name) => ACCOUNT_ID.test(name));
    } catch {
      return { records: 0, accounts: [] };
    }
    let records = 0;
    const removed: string[] = [];
    for (const accountId of accounts) {
      const folder = join(this.directory, accountId);
      if (held !== null && !held.has(accountId)) {
        await rm(folder, { recursive: true, force: true });
        removed.push(accountId);
        continue;
      }
      let files: string[];
      try {
        files = (await readdir(folder)).filter((name) => RECORD_FILE.test(name));
      } catch {
        continue;
      }
      for (const file of files) {
        const path = join(folder, file);
        const found = await this.#readFile(path);
        let changed: number;
        if (found === null) continue;
        if (found === 'unreadable')
          changed = await stat(path).then(
            (info) => info.mtimeMs,
            () => Number.NaN,
          );
        else changed = Date.parse(found.updatedAt);
        if (Number.isNaN(changed) || changed > cutoff) continue;
        await withFileLock(`${path}.lock`, async () => {
          // Looked at again under the lock: a take made since keeps it.
          const again = await this.#readFile(path);
          const at = again === null ? Number.NaN : again === 'unreadable' ? changed : Date.parse(again.updatedAt);
          if (!Number.isNaN(at) && at <= cutoff) {
            await rm(path, { force: true });
            records += 1;
          }
        }).catch(() => undefined);
      }
    }
    return { records, accounts: removed };
  }
}

/** A message no take has ever been recorded for: nothing to release. */
function notTaken(ref: TakeMessageRef): CommsError {
  return new CommsError('NOT_FOUND', `nobody has taken, been offered or handed back ${ref.id}`, {
    hint: 'There is nothing to release: no session holds it.',
  });
}

// ── The person's view ──────────────────────────────────────────────────────────────────────────────────────────

/**
 * A record as the person sees it (§9, T7): everything, with each note — agent-written, so perhaps a sender's words —
 * in the untrusted-content envelope, one boundary per answer.
 */
export function personTakeView(record: TakeRecord, boundary: string): TakeRecord {
  return {
    ...record,
    history: record.history.map((line) =>
      line.note === undefined ? line : { ...line, note: wrapUntrusted(line.note, { field: 'take-note' }, boundary) },
    ),
  };
}
