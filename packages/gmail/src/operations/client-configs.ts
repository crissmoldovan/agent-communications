import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homeDirectory } from '@agent-communications/core';

/**
 * Where the MCP clients on this machine keep their server lists. Read to answer two questions: is our own server
 * registered in a way that will actually start, and **is another Gmail server registered that can send mail?**
 *
 * The second question matters more than it looks. Every promise this package makes about sending assumes it owns the
 * only path to Gmail's send endpoints; a second server with an ungated `send_email` tool makes those promises false,
 * and the agent will happily use whichever tool it finds.
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
  /** The npm package the entry launches, when one can be read from the command line. */
  packageName?: string | undefined;
}

export interface LegacyServerFinding extends RegisteredServer {
  /** The npm package that makes this a finding; `name` stays the client's own name for the entry. */
  packageName: string;
  /** Why it is a problem, in one sentence. */
  reason: string;
  removal: string;
}

/** Gmail MCP servers known to expose ungated send tools. Matched against the whole command line. */
const UNGATED_GMAIL_SERVERS: Array<{
  pattern: RegExp;
  name: string;
  removal: (client: string, server: string) => string;
}> = [
  {
    pattern: /@artymclabin\/gmail-mcp/,
    name: '@artymclabin/gmail-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
  {
    pattern: /@gongrzhe\/server-gmail-autoauth-mcp|(?<![\w@/-])server-gmail-autoauth-mcp/,
    name: '@gongrzhe/server-gmail-autoauth-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
  {
    pattern: /@shinzolabs\/gmail-mcp/,
    name: '@shinzolabs/gmail-mcp',
    removal: (client, server) => removalCommand(client, server),
  },
];

function removalCommand(client: string, server: string): string {
  switch (client) {
    case 'claude-code':
      return `claude mcp remove ${server}`;
    case 'codex':
      return `codex mcp remove ${server}`;
    default:
      return `remove the "${server}" entry from the file above, then restart ${client}`;
  }
}

/** The config files worth looking at, whether or not they exist. */
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
}

function collectFromJson(text: string, client: string, path: string): RegisteredServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  const found: RegisteredServer[] = [];
  const visit = (node: unknown): void => {
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
            command: typeof entry.command === 'string' ? entry.command : '',
            args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          });
        }
      }
    }
    // Claude Code keeps per-project server lists under `projects`; the same shape, one level down.
    for (const value of Object.values(record)) {
      if (value && typeof value === 'object' && !Array.isArray(value)) visit(value);
    }
  };
  visit(parsed);
  return dedupe(found);
}

/** Codex keeps servers in TOML; only the shape we need is read, without a TOML dependency. */
function collectFromToml(text: string, client: string, path: string): RegisteredServer[] {
  const found: RegisteredServer[] = [];
  let current: RegisteredServer | null = null;
  for (const line of text.split(/\r?\n/)) {
    const section = /^\s*\[mcp_servers\.([^\]]+)\]\s*$/.exec(line);
    if (section) {
      if (current) found.push(current);
      current = { client, path, name: (section[1] ?? '').replace(/^"|"$/g, ''), command: '', args: [] };
      continue;
    }
    if (/^\s*\[/.test(line)) {
      if (current) found.push(current);
      current = null;
      continue;
    }
    if (!current) continue;
    const command = /^\s*command\s*=\s*"([^"]*)"/.exec(line);
    if (command?.[1] !== undefined) current.command = command[1];
    const args = /^\s*args\s*=\s*\[(.*)\]/.exec(line);
    if (args?.[1] !== undefined) {
      current.args = [...args[1].matchAll(/"([^"]*)"/g)].map((match) => match[1] ?? '');
    }
  }
  if (current) found.push(current);
  return dedupe(found);
}

function dedupe(servers: RegisteredServer[]): RegisteredServer[] {
  const seen = new Map<string, RegisteredServer>();
  for (const server of servers) {
    seen.set(`${server.path}::${server.name}::${server.command}::${server.args.join(' ')}`, server);
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

/**
 * Gmail servers other than ours that can send mail. Reported by `doctor` and after an import, because with one of
 * these connected an agent can send without any of this package's approval steps.
 */
export function findUngatedGmailServers(servers: readonly RegisteredServer[]): LegacyServerFinding[] {
  const findings: LegacyServerFinding[] = [];
  for (const server of servers) {
    const line = [server.command, ...server.args].join(' ');
    for (const known of UNGATED_GMAIL_SERVERS) {
      if (!known.pattern.test(line)) continue;
      findings.push({
        ...server,
        packageName: known.name,
        reason: `${known.name} exposes send tools that no approval step gates`,
        removal: known.removal(server.client, server.name),
      });
      break;
    }
  }
  return findings;
}
