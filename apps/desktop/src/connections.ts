/**
 * Connections (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.3): which apps on this machine have which of Agent Comms'
 * servers, read from core's `channels --json` (`channelsAvailable`), and when each app's windows last said they used an
 * account here, from `activity sessions`. Which entries start an older Agent Comms is `update --check`'s answer
 * (0.34.0), by the yardstick `update` itself uses — npm's latest release — not the core answering.
 *
 * Nothing here makes markup. A window's client name is what the window said it is (MCP's `clientInfo`), never proof:
 * a small table maps the names apps are known to give to the app, and any other name maps to none.
 */
import type { SessionView } from './activity.ts';
import { atLeast } from './gates.ts';
import { MCP_CLIENTS, MCP_SERVERS, type McpClient, type McpServer, type McpServers } from './ipc.ts';
import { shownFolder } from './lanes.ts';

/** Each app's name, as the table heads its row. */
export const APP_LABELS: Readonly<Record<McpClient, string>> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  codex: 'Codex',
  cursor: 'Cursor',
  gemini: 'Gemini',
  vscode: 'VS Code',
};

/** The apps the table always shows, in core's order. Gemini and VS Code join them once they have a registration. */
export const ALWAYS_SHOWN: readonly McpClient[] = ['claude-code', 'claude-desktop', 'codex', 'cursor'];

/** Each server's name, as the table heads its column. */
export const SERVER_LABELS: Readonly<Record<McpServer, string>> = {
  core: 'Core',
  gmail: 'Gmail',
  slack: 'Slack',
  resend: 'Resend',
  whatsapp: 'WhatsApp',
  events: 'Events',
};

/**
 * The names apps give their windows (MCP's `clientInfo.name`), lowercased, and the app each is. Approximate (spec
 * §3.3, L): Claude Code and Claude Desktop say these names; the others are the names those apps are known to give.
 */
export const CLIENT_NAMES: ReadonlyMap<string, McpClient> = new Map<string, McpClient>([
  ['claude-code', 'claude-code'],
  ['claude-ai', 'claude-desktop'],
  ['claude-desktop', 'claude-desktop'],
  ['codex', 'codex'],
  ['codex-mcp-client', 'codex'],
  ['cursor', 'cursor'],
  ['cursor-vscode', 'cursor'],
  ['gemini', 'gemini'],
  ['gemini-cli', 'gemini'],
  ['gemini-cli-mcp-client', 'gemini'],
  ['vscode', 'vscode'],
  ['visual studio code', 'vscode'],
  ['visual-studio-code', 'vscode'],
]);

/** The app a window's self-reported client name is, or null for a name the table does not hold. */
export function appOfClient(name: string | null | undefined): McpClient | null {
  if (typeof name !== 'string') return null;
  return CLIENT_NAMES.get(name.trim().toLowerCase()) ?? null;
}

/** One app and one server's cell. */
export interface Cell {
  /** Whether any entry starts this server for this app. */
  registered: boolean;
  /** Whether one of those entries starts it as it should: its file there, and not older than the latest release. */
  ok: boolean;
  /** What else is true of its entries: `older (<version>)`, `file missing`, or `project: <folder>`. */
  notes: string[];
}

/** One app's row. */
export interface AppRow {
  client: McpClient;
  label: string;
  cells: Record<McpServer, Cell>;
  /** The servers it has any entry for, in the table's order. */
  servers: McpServer[];
  /** Where its entries reach: every folder (a user entry), some folders (only a project's), or nowhere. */
  reach: 'every-folder' | 'some-folders' | 'none';
  /** What `update --check` says of its entries, said in plain words: "Starts an older Agent Comms (…)"; or null. */
  older: string | null;
}

/** A client config core found and could not read: what it registers is not known. */
export interface UnreadableView {
  client: string;
  label: string;
  path: string;
  reason: string;
}

export interface ConnectionsView {
  /** The version of the core that answered. */
  core: string | null;
  apps: AppRow[];
  unreadable: UnreadableView[];
  /** The newest version any entry starts: which Agent Comms the apps start (the test build's banner says it). */
  started: string | null;
}

/**
 * What `update --check --json` (core 0.34.0) says is behind npm's latest release here, as Connections reads it: each
 * app's entries that start an older Agent Comms, by server, at the version each starts; and whether anything at all is
 * behind — an entry, a runtime or a global package — which is what Bring everything up to date brings.
 */
export interface UpdateCheckView {
  /** Core's latest release, as npm names it, or null when the report does not say. */
  latest: string | null;
  /** Each app's older entries: the server, and the oldest version one of its entries starts. */
  older: Partial<Record<McpClient, Partial<Record<McpServer, string>>>>;
  anyBehind: boolean;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const isClient = (value: unknown): value is McpClient => MCP_CLIENTS.includes(value as McpClient);
const isServer = (value: unknown): value is McpServer => MCP_SERVERS.includes(value as McpServer);

/** The folder a project's `.mcp.json` is in; null for any other file, which does not say which project it is. */
function projectFolder(path: string, home: string | null | undefined): string | null {
  const match = /^(.+)[\\/]\.mcp\.json$/.exec(path);
  return match?.[1] === undefined ? null : shownFolder(match[1], home);
}

const empty = (): Cell => ({ registered: false, ok: false, notes: [] });

/** Whether `version` is older than `than`, as Rust's `version::at_least` reads them; false when either is unreadable. */
const olderThan = (version: string, than: string): boolean => atLeast(than, version) && !atLeast(version, than);

/** The newest of `versions`, or null. */
function newest(versions: readonly string[]): string | null {
  return versions.reduce<string | null>((best, each) => (best === null || olderThan(best, each) ? each : best), null);
}

/** The oldest of `versions`, or null. */
function oldest(versions: readonly string[]): string | null {
  return versions.reduce<string | null>((best, each) => (best === null || olderThan(each, best) ? each : best), null);
}

/** The core package's name, under which `update --check` reports core's latest release. */
const CORE_PACKAGE = '@agentcomms/core';

/**
 * `update --check --json` (core 0.34.0, `UpdateReport`), read into what Connections shows: its registration items that
 * are behind, by app and server. Null when it is not that answer at all.
 */
export function readUpdateCheck(value: unknown): UpdateCheckView | null {
  if (!isRecord(value) || !Array.isArray(value.behind)) return null;
  const latestOf = isRecord(value.latest) ? text(value.latest[CORE_PACKAGE]) : null;
  const older: UpdateCheckView['older'] = {};
  for (const item of value.behind) {
    if (!isRecord(item) || item.kind !== 'registration') continue;
    if (!isClient(item.client) || !isServer(item.channel)) continue;
    const version = text(item.version);
    if (version === null) continue;
    const byServer = older[item.client] ?? {};
    older[item.client] = byServer;
    const seen = byServer[item.channel];
    byServer[item.channel] = seen === undefined ? version : (oldest([seen, version]) ?? version);
  }
  return { latest: latestOf, older, anyBehind: value.behind.length > 0 };
}

/**
 * What an app's older entries mean, in plain words: "Starts an older Agent Comms (0.30.0); this Mac has 0.34.0." — this
 * Mac's being the core that answered, when the entry is older than it, and otherwise the latest release.
 */
export function olderLine(version: string, core: string | null, latest: string | null): string {
  if (core !== null && olderThan(version, core))
    return `Starts an older Agent Comms (${version}); this Mac has ${core}.`;
  return latest === null
    ? `Starts an older Agent Comms (${version}).`
    : `Starts an older Agent Comms (${version}); the latest is ${latest}.`;
}

/** The servers to give `mcp install` for `servers`: one on its own, several as a list (core 0.34.0). */
export function installServers(servers: readonly McpServer[]): McpServers {
  const [only] = servers;
  return servers.length === 1 && only !== undefined ? only : [...servers];
}

/** Server names as a person lists them: "Gmail", "Gmail and Slack", "Core, Gmail and Events". */
export function serverNames(servers: readonly McpServer[]): string {
  const names = servers.map((server) => SERVER_LABELS[server]);
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

/**
 * `channels --json`, read into the table: a row for each app the table always shows and each other with a
 * registration, a cell for each of the six servers. `home` is the person's home folder, to show folders with it as
 * `~`; `check` is `update --check`'s answer, once there is one (0.34.0), which marks the entries that start an older
 * Agent Comms. Null when it is not that answer at all.
 */
export function readChannels(
  value: unknown,
  home?: string | null,
  check?: UpdateCheckView | null,
): ConnectionsView | null {
  if (!isRecord(value) || !Array.isArray(value.channels)) return null;
  const cells = new Map<McpClient, Record<McpServer, Cell>>();
  const user = new Set<McpClient>();
  const started: string[] = [];
  for (const channel of value.channels) {
    if (!isRecord(channel) || !isServer(channel.channel) || !Array.isArray(channel.registered)) continue;
    const server = channel.channel;
    for (const entry of channel.registered) {
      if (!isRecord(entry) || !isClient(entry.client)) continue;
      const client = entry.client;
      const row =
        cells.get(client) ??
        (Object.fromEntries(MCP_SERVERS.map((each) => [each, empty()])) as Record<McpServer, Cell>);
      cells.set(client, row);
      const cell = row[server];
      const missing = text(entry.missing) !== null;
      const version = text(entry.version);
      if (version !== null) started.push(version);
      // Older by `update --check`'s yardstick: an entry at the version the check found behind, or one older still.
      const behindAt = check?.older[client]?.[server];
      const older = behindAt !== undefined && version !== null && !olderThan(behindAt, version);
      const project = entry.scope === 'project';
      cell.registered = true;
      if (!missing && !older) cell.ok = true;
      if (!project) user.add(client);
      const notes: string[] = [];
      if (older) notes.push(`older (${version})`);
      if (missing) notes.push('file missing');
      if (project) {
        const folder = projectFolder(text(entry.path) ?? '', home);
        notes.push(folder === null ? 'project' : `project: ${folder}`);
      }
      for (const note of notes) if (!cell.notes.includes(note)) cell.notes.push(note);
    }
  }
  const apps = MCP_CLIENTS.filter((client) => ALWAYS_SHOWN.includes(client) || cells.has(client)).map(
    (client): AppRow => {
      const row =
        cells.get(client) ??
        (Object.fromEntries(MCP_SERVERS.map((each) => [each, empty()])) as Record<McpServer, Cell>);
      const servers = MCP_SERVERS.filter((server) => row[server].registered);
      const behind = oldest(Object.values(check?.older[client] ?? {}));
      return {
        client,
        label: APP_LABELS[client],
        cells: row,
        servers,
        reach: user.has(client) ? 'every-folder' : servers.length > 0 ? 'some-folders' : 'none',
        older: behind === null ? null : olderLine(behind, text(value.core), check?.latest ?? null),
      };
    },
  );
  const unreadable = (Array.isArray(value.unreadable) ? value.unreadable : []).flatMap((each): UnreadableView[] => {
    if (!isRecord(each)) return [];
    const client = text(each.client) ?? '';
    const path = text(each.path);
    if (path === null) return [];
    return [
      {
        client,
        label: isClient(client) ? APP_LABELS[client] : client,
        path: shownFolder(path, home),
        reason: text(each.reason) ?? '',
      },
    ];
  });
  return { core: text(value.core), apps, unreadable, started: newest(started) };
}

/** Whether a session is an agent window: one an MCP client started, which is what an app's window is. */
const isWindow = (session: SessionView): boolean => session.surfaces.includes('mcp');

const newestFirst = (a: SessionView, b: SessionView): number => Date.parse(b.lastSeen) - Date.parse(a.lastSeen);

/**
 * When each app was last used: the newest time an agent window that said it was that app was seen. An app no window
 * reported has none, and a window whose name the table does not hold counts for no app.
 */
export function lastUsedByApp(sessions: readonly SessionView[]): Partial<Record<McpClient, string>> {
  const last: Partial<Record<McpClient, string>> = {};
  for (const session of sessions) {
    if (!isWindow(session)) continue;
    const client = appOfClient(session.client?.name);
    if (client === null) continue;
    const seen = last[client];
    if (seen === undefined || Date.parse(session.lastSeen) > Date.parse(seen)) last[client] = session.lastSeen;
  }
  return last;
}

/** One agent window used recently, as "Used recently" lists it. */
export interface RecentWindow {
  key: string;
  /** Its folder with the home as `~`, or null when it was not read. */
  folder: string | null;
  /** The app its name maps to, or null. */
  app: McpClient | null;
  /** The name it gave itself, as it came: a window's own word, shown as text. */
  client: string | null;
  channels: string[];
  at: string;
}

/** The agent windows used recently, newest first, at most `limit`. */
export function recentWindows(sessions: readonly SessionView[], limit = 5): RecentWindow[] {
  return sessions
    .filter(isWindow)
    .sort(newestFirst)
    .slice(0, limit)
    .map((session) => ({
      key: session.key,
      folder: session.folder,
      app: appOfClient(session.client?.name),
      client: session.client?.name ?? null,
      channels: session.channels.map((channel) => (isServer(channel) ? SERVER_LABELS[channel] : channel)),
      at: session.lastSeen,
    }));
}

/** What saving one app's ticks does: the servers to add, and the ones to take away, each in the table's order. */
export function changePlan(row: AppRow, ticked: readonly McpServer[]): { add: McpServer[]; remove: McpServer[] } {
  return {
    add: MCP_SERVERS.filter((server) => ticked.includes(server) && !row.servers.includes(server)),
    remove: MCP_SERVERS.filter((server) => !ticked.includes(server) && row.servers.includes(server)),
  };
}
