import type { QueueChannel } from './queue-target.ts';

/**
 * Routing's first slice (routing design 2026-10-25, §3 and §6): a lane is a queue target the person named, and the one
 * agent window the person binds to it is woken for each new item and may read it. These are the lane's closed
 * vocabularies: its name, a window's id, and the pointer the wake carries.
 */

/** A lane's name: what the person calls a stream of matches, such as `david` or `billing` (§3.1). */
const LANE_NAME = /^[a-z0-9-]{1,40}$/u;

export function isLaneName(value: unknown): value is string {
  return typeof value === 'string' && LANE_NAME.test(value);
}

/** A Claude Code session id, as `CLAUDE_CODE_SESSION_ID` carries it: a lowercase UUID. */
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Core's activity session key: 16 lowercase hex characters (activity design S2). */
const ACTIVITY_KEY = /^[0-9a-f]{16}$/u;

export function isClaudeCodeSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID.test(value);
}

export function isActivityKey(value: unknown): value is string {
  return typeof value === 'string' && ACTIVITY_KEY.test(value);
}

/** The id the person binds with (B1): a Claude Code session id, or an activity session key. */
export function isLaneWindowId(value: unknown): value is string {
  return isClaudeCodeSessionId(value) || isActivityKey(value);
}

/** What an MCP client said it is: stored as that, never proof (activity design §4.3). */
export interface LaneClientInfo {
  readonly name: string;
  readonly version?: string | undefined;
}

/**
 * Who is asking, as the event service's MCP server works it out for its own process (§3.3, B6): the Claude Code session
 * id from its environment, when there is one, and core's activity session — its key, whether that key is grouped (one
 * agent window) or this process's own, its folder, and the client as it says it is. Self-reported by a process running
 * as the person: it keeps one project's agent from another's lane, not from the person.
 */
export interface LaneWindowIdentity {
  readonly sessionId: string | null;
  readonly activityKey: string;
  readonly grouped: boolean;
  readonly folder: string | null;
  readonly client: LaneClientInfo | null;
}

const MAX_FOLDER = 4096;
const MAX_WORD = 100;
const MAX_VERSION = 64;

function cut(value: string, max: number): string {
  const characters = Array.from(value);
  return characters.length <= max ? value : characters.slice(0, max).join('');
}

/** Reads a window identity off a control request, or null for anything that is not one. */
export function parseLaneWindowIdentity(value: unknown): LaneWindowIdentity | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record))
    if (!['sessionId', 'activityKey', 'grouped', 'folder', 'client'].includes(key)) return null;
  const sessionId = record.sessionId ?? null;
  if (sessionId !== null && !isClaudeCodeSessionId(sessionId)) return null;
  if (!isActivityKey(record.activityKey)) return null;
  if (typeof record.grouped !== 'boolean') return null;
  const folder = record.folder ?? null;
  if (folder !== null && (typeof folder !== 'string' || folder.length === 0)) return null;
  const client = record.client ?? null;
  let parsedClient: LaneClientInfo | null = null;
  if (client !== null) {
    if (typeof client !== 'object' || Array.isArray(client)) return null;
    const { name, version } = client as Record<string, unknown>;
    if (typeof name !== 'string' || name.length === 0) return null;
    if (version !== undefined && typeof version !== 'string') return null;
    parsedClient = {
      name: cut(name, MAX_WORD),
      ...(version === undefined || version === '' ? {} : { version: cut(version, MAX_VERSION) }),
    };
  }
  return {
    sessionId: sessionId as string | null,
    activityKey: record.activityKey,
    grouped: record.grouped,
    folder: folder === null ? null : cut(folder as string, MAX_FOLDER),
    client: parsedClient,
  };
}

/**
 * Whether a window can be told apart from every other (B6): it has a Claude Code session id, or a grouped activity key.
 * Grouping already leaves out Windows, and a server started in `/`, the home folder or a system folder (activity S3).
 */
export function isIdentifiableWindow(window: Pick<LaneWindowIdentity, 'sessionId' | 'grouped'>): boolean {
  return window.sessionId !== null || window.grouped;
}

/** Why a window cannot bind, in the person's words: what makes a window identifiable, and what this one lacks. */
export const UNIDENTIFIABLE_WINDOW_REASON =
  'it has no Claude Code session id, and its activity session is not grouped: on Windows, or for a server started in /, the home folder or a system folder, one window cannot be told apart from another';

/** The binding of a lane to a window, as `lane list` and `lane bind` give it (the §6 JSON contract). */
export interface LaneBindingV1 {
  readonly window: {
    readonly sessionId: string | null;
    readonly activityKey: string | null;
    readonly folder: string | null;
    /** The folder as core's activity shows it, with the home folder as `~`, or null with no folder. */
    readonly folderShown: string | null;
    readonly client: { readonly name: string; readonly version?: string } | null;
  };
  readonly since: string;
}

export interface LaneListEntryV1 {
  readonly name: string;
  readonly rules: readonly { readonly id: string }[];
  readonly channels: readonly string[];
  readonly open: number;
  readonly binding: LaneBindingV1 | null;
}

/** `lane list --json`: every lane an active rule carries (the person's view). */
export interface LaneListResultV1 {
  readonly lanes: readonly LaneListEntryV1[];
}

/** `events_lane_list` (B4): lane names, and whether this window is bound to each; never another window. */
export interface LaneListForWindowV1 {
  readonly lanes: readonly { readonly name: string; readonly boundToThisWindow: boolean }[];
}

export interface LaneBindResultV1 {
  readonly lane: string;
  readonly binding: LaneBindingV1;
}

export interface LaneUnbindResultV1 {
  readonly lane: string;
  readonly unbound: true;
}

/** The channels' names as a pointer writes them. */
export const LANE_POINTER_CHANNEL_NAMES: Readonly<Record<QueueChannel, string>> = Object.freeze({
  gmail: 'Gmail',
  slack: 'Slack',
  resend: 'Resend',
  whatsapp: 'WhatsApp',
});

/** A rule id as the pointer writes it: as it is when it is a plain id, quoted with every control escaped otherwise. */
function pointerRuleId(ruleId: string): string {
  return /^[A-Za-z0-9][A-Za-z0-9._:@-]{0,63}$/u.test(ruleId) ? ruleId : JSON.stringify(cut(ruleId, 64));
}

/** What a wake says (§2): how many items wait, which one to read, from which channel and rule — never sender text. */
export interface LanePointer {
  readonly lane: string;
  readonly itemId: string;
  readonly channel: QueueChannel;
  readonly ruleId: string;
  /** How many open items in the lane this window has not been woken for, the named one included. */
  readonly waiting: number;
}

/**
 * The pointer a wake carries (§2, §3.4). It lands in a privileged spot — a task result the model starts a turn on — so
 * it is only what the service itself writes: the lane, the item's id, its channel and its rule. No sender, subject or
 * text; those come only through `events_lane_item`, enveloped.
 */
export function lanePointerText(pointer: LanePointer): string {
  const where = `(${LANE_POINTER_CHANNEL_NAMES[pointer.channel]}, rule ${pointerRuleId(pointer.ruleId)})`;
  const read = `read it with events_lane_item, item ${pointer.itemId}.`;
  const again = `Then call events_watch for lane ${pointer.lane} again to keep watching.`;
  return pointer.waiting <= 1
    ? `1 new item in lane ${pointer.lane} ${where}: ${read} ${again}`
    : `${pointer.waiting} new items in lane ${pointer.lane}; the first ${where}: ${read} ${again}`;
}
