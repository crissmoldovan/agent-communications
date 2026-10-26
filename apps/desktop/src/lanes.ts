/**
 * The event service's lanes, as the Queue screen reads them (design 2026-10-25-routing §2, and §6: B1, B4, B5 and the
 * CLI's JSON): `lane list --json` and `lane unbind --json`, read field by field into the few shapes the screen shows;
 * which recent agent windows the picker offers, from core's `activity sessions`; and which lane each queue item is in.
 *
 * Nothing here makes markup. `lane list` is content-free: a lane, its rules, its channels and its binding are the
 * person's and the app's words, never a sender's. A window's client is what the client said it is, never proof.
 */
import type { SessionView } from './activity.ts';
import { isLaneName, isRuleId, isSessionKey, isWindowId } from './grammar.ts';
import type { QueueCounts, QueueItem } from './queue.ts';

/** The agent window a lane is bound to, as `lane list` names it. */
export interface LaneWindow {
  /** Its Claude Code session id, when it has one. */
  sessionId: string | null;
  /** Its activity session's key (0.29.0's grouping), when it has one. */
  activityKey: string | null;
  /** Its folder, with the home as `~`, or null when it was not read. */
  folder: string | null;
  /** The client as it said it is, never proof of what it is. */
  client: { name: string; version: string | null } | null;
}

/** A lane's binding: the window, and since when (an ISO time, or null when the answer had none). */
export interface LaneBinding {
  window: LaneWindow;
  since: string | null;
}

/** One lane, as `lane list` gives it. */
export interface LaneView {
  name: string;
  /** Whether the name is one the allow-list takes, so that Unbind and Bind can name it. */
  actionable: boolean;
  /** The ids of the rules that send to it. */
  rules: string[];
  channels: string[];
  open: number;
  binding: LaneBinding | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const strings = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((each): each is string => typeof each === 'string') : [];
const whole = (value: unknown): number | null =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;

/**
 * A folder with the person's home as `~`, as core shows one (`folderShown`): the home itself is `~`, a folder inside
 * it `~/…`, and any other folder is kept as it is. A folder already shown so is kept too.
 */
export function shownFolder(folder: string, home: string | null | undefined): string {
  if (folder === '~' || folder.startsWith('~/')) return folder;
  if (home === null || home === undefined || home === '') return folder;
  const base = home.endsWith('/') || home.endsWith('\\') ? home.slice(0, -1) : home;
  if (base === '') return folder;
  if (folder === base) return '~';
  for (const separator of ['/', '\\']) {
    if (folder.startsWith(`${base}${separator}`)) return `~${separator}${folder.slice(base.length + 1)}`;
  }
  return folder;
}

function windowOf(value: unknown, home: string | null | undefined): LaneWindow {
  const given = isRecord(value) ? value : {};
  const client = isRecord(given.client) && typeof given.client.name === 'string' ? given.client : null;
  const sessionId = text(given.sessionId);
  const activityKey = text(given.activityKey);
  // Core's own `folderShown`, when the answer carries one; otherwise the folder, with the home as `~`.
  const shown = text(given.folderShown);
  const folder = text(given.folder);
  return {
    sessionId: sessionId !== null && isWindowId(sessionId) ? sessionId : null,
    activityKey: activityKey !== null && isSessionKey(activityKey) ? activityKey : null,
    folder: shown ?? (folder === null ? null : shownFolder(folder, home)),
    client: client === null ? null : { name: client.name as string, version: text(client.version) },
  };
}

function bindingOf(value: unknown, home: string | null | undefined): LaneBinding | null {
  if (!isRecord(value)) return null;
  return { window: windowOf(value.window, home), since: text(value.since) };
}

/** A lane, read: null for one with no name. */
function laneOf(value: unknown, home: string | null | undefined): LaneView | null {
  if (!isRecord(value)) return null;
  const name = text(value.name);
  if (name === null || name === '') return null;
  const rules = Array.isArray(value.rules)
    ? value.rules.flatMap((rule) => {
        const id = isRecord(rule) ? text(rule.id) : text(rule);
        return id === null ? [] : [id];
      })
    : [];
  return {
    name,
    actionable: isLaneName(name),
    rules,
    channels: strings(value.channels),
    open: whole(value.open) ?? 0,
    binding: bindingOf(value.binding, home),
  };
}

/**
 * `lane list --json`, read: `{ lanes: [{ name, rules: [{ id }], channels, open, binding: null | { window: { sessionId,
 * activityKey, folder, client }, since } }] }` (the contract of §6), or null when it is not that answer at all. `home`
 * is the person's home folder, to show a window's folder with it as `~`.
 */
export function readLaneList(value: unknown, home?: string | null): LaneView[] | null {
  if (!isRecord(value) || !Array.isArray(value.lanes)) return null;
  return value.lanes.flatMap((each) => laneOf(each, home) ?? []);
}

/** `lane unbind --json`, read: the lane it unbound, or null when it is not `{ lane, unbound: true }`. */
export function readUnbound(value: unknown): string | null {
  if (!isRecord(value) || value.unbound !== true) return null;
  return text(value.lane);
}

/** A client in a few words: its name and version, as it said them. */
export function clientWords(client: LaneWindow['client']): string | null {
  if (client === null) return null;
  return client.version ? `${client.name} ${client.version}` : client.name;
}

/** A lane's rules by name, from the counts that name them, or by id. */
export function ruleNames(lane: LaneView, counts: QueueCounts | null): string[] {
  return lane.rules.map((id) => counts?.byRule.find((rule) => rule.ruleId === id)?.name ?? id);
}

// ── Which lane an item is in ───────────────────────────────────────────────────────────────────────────────────

/**
 * The lane an item is in: the one the event service says, its name or null — a plain queue's item is in no lane even
 * when its rule sends to a lane too. Only an item that says nothing of a lane (a service older than 0.31.0) is told
 * from the one lane whose rules include its rule — never a guess between two. Null when it is in none, or when that
 * cannot be told.
 */
export function itemLane(item: QueueItem, lanes: readonly LaneView[]): string | null {
  if (item.lane !== undefined) return item.lane;
  const feeding = lanes.filter((lane) => lane.rules.includes(item.rule.id));
  return feeding.length === 1 ? (feeding[0] as LaneView).name : null;
}

/** The lanes the screen offers as a filter: those with a name the allow-list takes. */
export function filterLanes(lanes: readonly LaneView[]): LaneView[] {
  return lanes.filter((lane) => lane.actionable);
}

/**
 * The one rule a lane's filter narrows `queue list` by, so its items are not lost past the list's limit: the lane's
 * only rule, when it has exactly one with an id the allow-list takes. Null otherwise: the screen then filters the list
 * it read.
 */
export function narrowingRule(lane: LaneView): string | null {
  const only = lane.rules.length === 1 ? (lane.rules[0] as string) : null;
  return only !== null && isRuleId(only) ? only : null;
}

// ── The picker ─────────────────────────────────────────────────────────────────────────────────────────────────

/** One window the picker offers: its session, and the lane it is bound to already, if any (one lane per window). */
export interface PickableWindow {
  session: SessionView;
  boundTo: string | null;
}

export interface PickerView {
  windows: PickableWindow[];
  /** How many sessions in the range are not offered: those not grouped under one agent window. */
  hidden: number;
}

/**
 * The windows a lane can be bound to (B1, B6): the sessions core grouped under one agent window (`grouped: true`), with
 * a key the allow-list takes, newest first as core lists them. Every other session — a command, the event service, a
 * process on its own — is counted, not offered: the app cannot tell one window of it from another.
 */
export function pickerWindows(sessions: readonly SessionView[], lanes: readonly LaneView[]): PickerView {
  const windows: PickableWindow[] = [];
  let hidden = 0;
  for (const session of sessions) {
    if (!session.grouped || !isSessionKey(session.key)) {
      hidden += 1;
      continue;
    }
    const bound = lanes.find((lane) => lane.binding?.window.activityKey === session.key);
    windows.push({ session, boundTo: bound?.name ?? null });
  }
  return { windows, hidden };
}
