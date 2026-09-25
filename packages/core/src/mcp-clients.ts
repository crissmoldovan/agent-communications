import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
// A relative import, never the package's own name: core importing `@agentcomms/core` only resolved through
// Node's self-reference to the *built* package, so running core from source loaded its own stale dist.
import { homeDirectory } from './paths.ts';

/**
 * Where the MCP clients on this machine keep their server lists. Read to answer two questions: is our own server
 * registered in a way that will actually start, and **is another server for the same service registered that can
 * act with no approval step?**
 *
 * The second question matters more than it looks. Every promise these packages make about sending or posting
 * assumes they own the only route to it; a second server with an ungated `send_email` or `post_message` tool makes
 * those promises false, and the agent will happily use whichever tool it finds.
 */
export interface ClientConfigFile {
  client: string;
  path: string;
}

export interface RegisteredServer {
  client: string;
  path: string;
  name: string;
  command: string;
  args: string[];
  /**
   * The address of a remote server, for an entry that has one instead of a command.
   *
   * Read because the official Slack server is exactly such an entry — `https://mcp.slack.com/mcp` — and a scan
   * that looked only at `command` and `args` could not see the one other Slack server most people will have.
   */
  url?: string | undefined;
  /** The entry's own `type` (`stdio`, `http`, `sse`), when it declares one. */
  type?: string | undefined;
  /** The npm package the entry launches, when one can be read from the command line. */
  packageName?: string | undefined;
  /**
   * The entry's own environment, when it declares one.
   *
   * Carried because an entry cannot be put back without it: ours sets `AGENT_COMMS_CONFIG_DIR`, and a server
   * restored without that looks in the wrong directory and reports no mailboxes — a silent wrong answer where the
   * missing entry it replaced was at least an obvious one.
   */
  env?: Record<string, string> | undefined;
  /**
   * `project` for an entry Claude Code keeps under `projects`, `user` otherwise.
   *
   * Every command this package issues targets user scope. Without knowing the difference, a repair aimed at a
   * project-scoped entry removes nothing, adds a second entry at user scope, and reports success — leaving the
   * stale one still in force for that project.
   */
  scope?: 'user' | 'project' | undefined;
}

/** The config file each supported client keeps its servers in, whether or not it exists. */
export function knownClientConfigs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClientConfigFile[] {
  const home = homeDirectory(env);
  const files: ClientConfigFile[] = [
    { client: 'claude-code', path: join(home, '.claude.json') },
    { client: 'cursor', path: join(home, '.cursor', 'mcp.json') },
    { client: 'codex', path: join(home, '.codex', 'config.toml') },
    { client: 'gemini', path: join(home, '.gemini', 'settings.json') },
  ];
  if (platform === 'darwin') {
    files.push(
      {
        client: 'claude-desktop',
        path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      },
      { client: 'vscode', path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json') },
    );
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    files.push(
      { client: 'claude-desktop', path: join(appData, 'Claude', 'claude_desktop_config.json') },
      { client: 'vscode', path: join(appData, 'Code', 'User', 'mcp.json') },
    );
  } else {
    files.push(
      { client: 'claude-desktop', path: join(home, '.config', 'Claude', 'claude_desktop_config.json') },
      { client: 'vscode', path: join(home, '.config', 'Code', 'User', 'mcp.json') },
    );
  }
  return files;
}

interface ServerEntry {
  command?: unknown;
  args?: unknown;
  env?: unknown;
  url?: unknown;
  serverUrl?: unknown;
  httpUrl?: unknown;
  type?: unknown;
}

/** The remote address, under whichever key the client uses: `url` for most, `serverUrl` and `httpUrl` for some. */
function urlOf(entry: ServerEntry): string | undefined {
  for (const value of [entry.url, entry.serverUrl, entry.httpUrl]) if (typeof value === 'string') return value;
  return undefined;
}

function collectFromJson(text: string, client: string, path: string): RegisteredServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: RegisteredServer[] = [];
  const visit = (node: unknown, scope: 'user' | 'project'): void => {
    if (!node || typeof node !== 'object') return;
    const record = node as Record<string, unknown>;
    for (const key of ['mcpServers', 'servers']) {
      const servers = record[key];
      if (servers && typeof servers === 'object') {
        for (const [name, entry] of Object.entries(servers as Record<string, ServerEntry>)) {
          if (!entry || typeof entry !== 'object') continue;
          found.push({
            client,
            path,
            name,
            scope,
            command: typeof entry.command === 'string' ? entry.command : '',
            args: Array.isArray(entry.args) ? entry.args.map(String) : [],
            ...(urlOf(entry) ? { url: urlOf(entry) } : {}),
            ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
            ...(entry.env && typeof entry.env === 'object'
              ? {
                  env: Object.fromEntries(
                    Object.entries(entry.env as Record<string, unknown>).map(([key, value]) => [key, String(value)]),
                  ),
                }
              : {}),
          });
        }
      }
    }
    // Claude Code keeps per-project server lists under `projects`; the same shape, one level down.
    for (const [key, value] of Object.entries(record)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        visit(value, key === 'projects' ? 'project' : scope);
      }
    }
  };
  visit(parsed, 'user');
  return dedupe(found);
}

/** Codex keeps servers in TOML; only the shape we need is read, without a TOML dependency. */
function collectFromToml(text: string, client: string, path: string): RegisteredServer[] {
  const found: RegisteredServer[] = [];
  let current: RegisteredServer | null = null;
  let inEnv = false;
  for (const line of text.split(/\r?\n/)) {
    // Checked before the server-section pattern, which would otherwise match `[mcp_servers.x.env]` and invent a
    // server called `x.env`. A subsection belongs to the server above it; without reading it a codex entry's env
    // is invisible, and an entry cannot be restored without its env.
    const envSection = /^\s*\[mcp_servers\.(.+)\.env\]\s*$/.exec(line);
    if (envSection) {
      inEnv = current !== null && (envSection[1] ?? '').replace(/^"|"$/g, '') === current.name;
      continue;
    }
    const section = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/.exec(line);
    if (section) {
      if (current) found.push(current);
      current = { client, path, name: (section[1] ?? '').replace(/^"|"$/g, ''), command: '', args: [] };
      inEnv = false;
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (current) found.push(current);
      current = null;
      inEnv = false;
      continue;
    }
    if (inEnv && current) {
      const pair = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/.exec(line);
      if (pair?.[1] !== undefined) current.env = { ...current.env, [pair[1]]: pair[2] ?? '' };
      continue;
    }
    if (!current) continue;
    const command = /^\s*command\s*=\s*"([^"]*)"/.exec(line);
    if (command?.[1] !== undefined) current.command = command[1];
    const url = /^\s*url\s*=\s*"([^"]*)"/.exec(line);
    if (url?.[1] !== undefined) current.url = url[1];
    const args = /^\s*args\s*=\s*\[(.*)\]/.exec(line);
    if (args?.[1] !== undefined) {
      current.args = [...args[1].matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
    }
    const inlineEnv = /^\s*env\s*=\s*\{(.*)\}/.exec(line);
    if (inlineEnv?.[1] !== undefined) {
      const pairs = [...inlineEnv[1].matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g)];
      if (pairs.length > 0) {
        current.env = Object.fromEntries(pairs.map((match) => [match[1] ?? '', match[2] ?? '']));
      }
    }
  }
  if (current) found.push(current);
  return dedupe(found);
}

function dedupe(servers: RegisteredServer[]): RegisteredServer[] {
  const seen = new Map<string, RegisteredServer>();
  for (const server of servers) {
    seen.set(
      `${server.path}::${server.name}::${server.command}::${server.args.join(' ')}::${server.url ?? ''}`,
      server,
    );
  }
  return [...seen.values()];
}

/** Every MCP server registered with the clients on this machine. Missing or unreadable files are simply skipped. */
export async function listRegisteredServers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RegisteredServer[]> {
  const servers: RegisteredServer[] = [];
  for (const file of knownClientConfigs(env, platform)) {
    let text: string;
    try {
      text = await readFile(file.path, 'utf8');
    } catch {
      continue;
    }
    const entries = file.path.endsWith('.toml')
      ? collectFromToml(text, file.client, file.path)
      : collectFromJson(text, file.client, file.path);
    for (const entry of entries) {
      servers.push({ ...entry, packageName: packageFrom(entry) });
    }
  }
  return servers;
}

function packageFrom(server: RegisteredServer): string | undefined {
  const line = [server.command, ...server.args].join(' ');
  const match = /(@[\w.-]+\/[\w.-]+|(?<=\s)[\w.-]+-mcp)(?=@|\s|$)/.exec(line);
  return match?.[1];
}
