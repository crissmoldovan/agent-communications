/**
 * Connections (0.32.0, spec 2026-10-26-owner-feedback-0320 §3.3): which apps on this machine have which of Agent Comms'
 * servers, read from core's `channels --json` (`channelsAvailable`), and when each app's windows last said they used an
 * account here, from `activity sessions`.
 *
 * Nothing here makes markup. A window's client name is what the window said it is (MCP's `clientInfo`), never proof:
 * a small table maps the names apps are known to give to the app, and any other name maps to none.
 */
import type { SessionView } from './activity.ts';
import { MCP_CLIENTS, MCP_SERVERS, type McpClient, type McpServer } from './ipc.ts';
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
  /** Whether one of those entries starts it as it should: its file there, and not behind core. */
  ok: boolean;
  /** What else is true of its entries: `behind core`, `file missing`, or `project: <folder>`. */
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

/**
 * `channels --json`, read into the table: a row for each app the table always shows and each other with a
 * registration, a cell for each of the six servers. `home` is the person's home folder, to show folders with it as
 * `~`. Null when it is not that answer at all.
 */
export function readChannels(value: unknown, home?: string | null): ConnectionsView | null {
  if (!isRecord(value) || !Array.isArray(value.channels)) return null;
  const cells = new Map<McpClient, Record<McpServer, Cell>>();
  const user = new Set<McpClient>();
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
      const behind = entry.behindCore === true;
      const project = entry.scope === 'project';
      cell.registered = true;
      if (!missing && !behind) cell.ok = true;
      if (!project) user.add(client);
      const notes: string[] = [];
      if (behind) notes.push('behind core');
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
      return {
        client,
        label: APP_LABELS[client],
        cells: row,
        servers,
        reach: user.has(client) ? 'every-folder' : servers.length > 0 ? 'some-folders' : 'none',
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
  return { core: text(value.core), apps, unreadable };
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
