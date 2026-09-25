import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
// A relative import, never the package's own name: core importing `@agentcomms/core` only resolved through
// Node's self-reference to the *built* package, so running core from source loaded its own stale dist.
import { homeDirectory } from './paths.ts';
import { parseToml, TomlError } from './toml.ts';

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
  /**
   * How the client itself reads the file.
   *
   * VS Code's `mcp.json` is JSON with comments and trailing commas, and Gemini CLI strips comments from its
   * settings before parsing them. A file of either with one `// note` in it is a working config to its client,
   * and it read here as nothing registered at all — which `mcp prune` took as licence to delete what it named.
   */
  format: 'json' | 'jsonc' | 'toml';
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

/**
 * The config file each supported client keeps its servers in, whether or not it exists.
 *
 * Where the client itself would look, which is not always the default: codex keeps everything under `CODEX_HOME`
 * and Claude Code its `.claude.json` under `CLAUDE_CONFIG_DIR`, when either is set. Reading `~/.codex` regardless
 * found nothing on a machine that had moved it, so an install wrote over somebody's server there and `prune`
 * deleted runtimes it still named.
 */
export function knownClientConfigs(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): ClientConfigFile[] {
  const home = homeDirectory(env);
  const claudeDir = env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : home;
  const codexDir = env.CODEX_HOME ? resolve(env.CODEX_HOME) : join(home, '.codex');
  const files: ClientConfigFile[] = [
    { client: 'claude-code', path: join(claudeDir, '.claude.json'), format: 'json' },
    { client: 'cursor', path: join(home, '.cursor', 'mcp.json'), format: 'json' },
    { client: 'codex', path: join(codexDir, 'config.toml'), format: 'toml' },
    { client: 'gemini', path: join(home, '.gemini', 'settings.json'), format: 'jsonc' },
  ];
  if (platform === 'darwin') {
    files.push(
      {
        client: 'claude-desktop',
        path: join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
        format: 'json',
      },
      {
        client: 'vscode',
        path: join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
        format: 'jsonc',
      },
    );
  } else if (platform === 'win32') {
    const appData = env.APPDATA ?? join(home, 'AppData', 'Roaming');
    files.push(
      { client: 'claude-desktop', path: join(appData, 'Claude', 'claude_desktop_config.json'), format: 'json' },
      { client: 'vscode', path: join(appData, 'Code', 'User', 'mcp.json'), format: 'jsonc' },
    );
  } else {
    files.push(
      { client: 'claude-desktop', path: join(home, '.config', 'Claude', 'claude_desktop_config.json'), format: 'json' },
      { client: 'vscode', path: join(home, '.config', 'Code', 'User', 'mcp.json'), format: 'jsonc' },
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

/**
 * Another server's address, as far as it is safe to print: scheme and host.
 *
 * For a remote server the URL is often the credential, and it was printed whole in `mcp install`'s warnings, in
 * its refusals and in `doctor`, which agents are told to run with `--json` and so copy into their transcripts.
 * Some vendors put the key in the query; others put it in the path — a per-user id that is the only thing standing
 * between anyone holding the URL and that person's connected accounts. So the path goes as well as the userinfo,
 * the query and the fragment: the entry's name and client, printed beside this, say which server is meant. What
 * cannot be parsed as a URL is not printed at all.
 */
export function displayUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    if (!parsed.host) return undefined;
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return undefined;
  }
}

/**
 * JSON with comments and trailing commas, read the way VS Code reads its own settings.
 *
 * Comments become spaces and a comma before a closing bracket is dropped, both only outside strings — a URL in
 * an argument is full of `//`. What is left has to be plain JSON, or it throws like `JSON.parse`.
 */
export function parseJsonc(text: string): unknown {
  let stripped = '';
  let pos = 0;
  while (pos < text.length) {
    const char = text[pos] ?? '';
    if (char === '"') {
      let end = pos + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      stripped += text.slice(pos, end + 1);
      pos = end + 1;
    } else if (char === '/' && text[pos + 1] === '/') {
      while (pos < text.length && text[pos] !== '\n') pos += 1;
    } else if (char === '/' && text[pos + 1] === '*') {
      const end = text.indexOf('*/', pos + 2);
      if (end === -1) throw new SyntaxError('a comment that never ends');
      stripped += ' ';
      pos = end + 2;
    } else {
      stripped += char;
      pos += 1;
    }
  }
  let json = '';
  for (pos = 0; pos < stripped.length; pos += 1) {
    const char = stripped[pos] ?? '';
    if (char === '"') {
      let end = pos + 1;
      while (end < stripped.length && stripped[end] !== '"') end += stripped[end] === '\\' ? 2 : 1;
      json += stripped.slice(pos, end + 1);
      pos = end;
    } else if (char === ',') {
      let next = pos + 1;
      while (/\s/.test(stripped[next] ?? '')) next += 1;
      if (stripped[next] !== ']' && stripped[next] !== '}') json += char;
    } else {
      json += char;
    }
  }
  return JSON.parse(json);
}

function collectFromJson(
  parsed: unknown,
  client: string,
  path: string,
  topScope: 'user' | 'project' = 'user',
): RegisteredServer[] {
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
  visit(parsed, topScope);
  return dedupe(found);
}

/**
 * Codex's servers, from its `config.toml` as `parseToml` reads it.
 *
 * Every spelling of an entry is the same table once parsed — `[mcp_servers.x]` sections, an `[mcp_servers]` table
 * of inline ones, dotted keys — and a subsection such as `[mcp_servers.x.env]` belongs to its server rather than
 * becoming one. An `mcp_servers` that is not a table of tables is not something codex would start either, and is
 * refused as unreadable rather than guessed at.
 */
function collectFromToml(text: string, client: string, path: string): RegisteredServer[] {
  const servers = parseToml(text).mcp_servers;
  if (servers === undefined) return [];
  if (!isRecord(servers)) throw new TomlError('mcp_servers is not a table');
  const found: RegisteredServer[] = [];
  for (const [name, entry] of Object.entries(servers)) {
    if (!isRecord(entry)) throw new TomlError(`mcp_servers.${name} is not a table`);
    if (entry.args !== undefined && !Array.isArray(entry.args))
      throw new TomlError(`mcp_servers.${name}.args is not an array`);
    if (entry.env !== undefined && !isRecord(entry.env)) throw new TomlError(`mcp_servers.${name}.env is not a table`);
    found.push({
      client,
      path,
      name,
      command: typeof entry.command === 'string' ? entry.command : '',
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      ...(typeof entry.url === 'string' ? { url: entry.url } : {}),
      ...(isRecord(entry.env)
        ? { env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)])) }
        : {}),
    });
  }
  return found;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * What `codex mcp get <name> --json` says is registered, as an entry the rest of this reads.
 *
 * Codex's own answer, because codex is what `codex mcp add` would overwrite: its config can live where no scan
 * looks, and in shapes a scan could misread. The entry is under `transport` in the codex versions this was
 * written against; the top level is read too, so a flatter answer is not mistaken for no command at all. An
 * answer with neither a command nor a URL throws, and the caller treats that as not knowing.
 */
export function codexServerFromGet(name: string, stdout: string, path: string): RegisteredServer {
  const answer: unknown = JSON.parse(stdout);
  if (!isRecord(answer)) throw new SyntaxError('not an object');
  const entry = isRecord(answer.transport) ? answer.transport : answer;
  const command = typeof entry.command === 'string' ? entry.command : '';
  const url = typeof entry.url === 'string' ? entry.url : undefined;
  if (!command && !url) throw new SyntaxError('neither a command nor a URL');
  const server: RegisteredServer = {
    client: 'codex',
    path,
    name,
    scope: 'user',
    command,
    args: Array.isArray(entry.args) ? entry.args.map(String) : [],
    ...(url ? { url } : {}),
    ...(isRecord(entry.env)
      ? { env: Object.fromEntries(Object.entries(entry.env).map(([key, value]) => [key, String(value)])) }
      : {}),
  };
  return { ...server, packageName: packageFrom(server) };
}

/**
 * One entry per place it is registered.
 *
 * The scope is part of the key. Without it the same entry at the top of `.claude.json` and under one of its
 * `projects` came back as the project copy alone, so `--force` — which works at user scope — found nothing of its
 * own to replace, and Claude Code then refused the add because the user-scope copy it could not see was there.
 */
function dedupe(servers: RegisteredServer[]): RegisteredServer[] {
  const seen = new Map<string, RegisteredServer>();
  for (const server of servers) {
    seen.set(
      `${server.path}::${server.scope ?? ''}::${server.name}::${server.command}::${server.args.join(' ')}::${server.url ?? ''}`,
      server,
    );
  }
  return [...seen.values()];
}

/** A client config that is there and could not be read — so what it registers is not known. */
export interface UnreadableConfig {
  client: string;
  path: string;
  /** Why, in words that never quote the file: a line of somebody's config can hold a token. */
  reason: string;
}

export interface ServerScan {
  servers: RegisteredServer[];
  unreadable: UnreadableConfig[];
}

/** A file's text, null when it is not there, and a reason when it is there and cannot be read. */
async function readIfThere(path: string): Promise<string | null | { reason: string }> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    return { reason: `it could not be opened (${code ?? 'unknown error'})` };
  }
}

function parseConfig(text: string, format: ClientConfigFile['format']): unknown {
  const body = text.startsWith('\uFEFF') ? text.slice(1) : text;
  return format === 'jsonc' ? parseJsonc(body) : JSON.parse(body);
}

/**
 * Every MCP server registered with the clients on this machine, and every client config that could not be read.
 *
 * The second list is the point. A file this skipped used to look exactly like a file with nothing in it, and
 * `mcp prune` deletes what nothing registers: a VS Code `mcp.json` with one comment in it was enough to lose a
 * runtime a client still started. A caller that decides something from absence has to be able to tell the two
 * apart. The reasons never quote the file — JSON's own parse errors do, and a line of a config can hold a token.
 *
 * Claude Code's project servers are read too: those it keeps under `projects` in its own file, and the
 * `.mcp.json` at the root of each project it lists there. A project that no longer exists is not a file that
 * cannot be read. What stays out of sight is any other file a client might be pointed at — a workspace
 * `.vscode/mcp.json` or `.cursor/mcp.json`, a config passed on a command line — and an entry pasted from
 * `--client json`, which is why `prune` also keeps what the installer printed.
 *
 * `also` names further configs to read as the client named would: `prune` passes every one the installer recorded
 * writing to, which a shell with another `CLAUDE_CONFIG_DIR` or `CODEX_HOME` would not otherwise find. One for a
 * client this does not know is read as JSON with comments, which reads every JSON config and calls anything else
 * unreadable — a reason for `prune` to stop, rather than a file skipped in silence.
 */
export async function scanRegisteredServers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  also: readonly Pick<ClientConfigFile, 'client' | 'path'>[] = [],
): Promise<ServerScan> {
  const servers: RegisteredServer[] = [];
  const unreadable: UnreadableConfig[] = [];
  const add = (entries: RegisteredServer[]) => {
    for (const entry of entries) servers.push({ ...entry, packageName: packageFrom(entry) });
  };

  const files = knownClientConfigs(env, platform);
  for (const { client, path } of also) {
    const format = files.find((file) => file.client === client)?.format ?? 'jsonc';
    if (!files.some((file) => file.path === path)) files.push({ client, path, format });
  }
  for (const file of files) {
    const text = await readIfThere(file.path);
    if (text === null) continue;
    if (typeof text !== 'string') {
      unreadable.push({ client: file.client, path: file.path, ...text });
      continue;
    }
    if (file.format === 'toml') {
      try {
        add(collectFromToml(text, file.client, file.path));
      } catch (error) {
        const where = error instanceof TomlError ? `: ${error.message}` : '';
        unreadable.push({ client: file.client, path: file.path, reason: `it is not TOML this can read${where}` });
      }
      continue;
    }
    let parsed: unknown;
    try {
      parsed = parseConfig(text, file.format);
    } catch {
      unreadable.push({
        client: file.client,
        path: file.path,
        reason: file.format === 'jsonc' ? 'it is not JSON, even allowing comments' : 'it is not valid JSON',
      });
      continue;
    }
    add(collectFromJson(parsed, file.client, file.path));

    if (file.client !== 'claude-code' || !isRecord(parsed) || !isRecord(parsed.projects)) continue;
    for (const root of Object.keys(parsed.projects)) {
      if (!isAbsolute(root)) continue;
      const path = join(root, '.mcp.json');
      const project = await readIfThere(path);
      if (project === null) continue;
      if (typeof project !== 'string') {
        unreadable.push({ client: file.client, path, ...project });
        continue;
      }
      try {
        add(collectFromJson(parseConfig(project, 'json'), file.client, path, 'project'));
      } catch {
        unreadable.push({ client: file.client, path, reason: 'it is not valid JSON' });
      }
    }
  }
  return { servers, unreadable };
}

/**
 * Every MCP server registered with the clients on this machine. Files that are missing or cannot be read are
 * skipped: for a list of what is there that is the right answer, and for a decision made from what is *not*
 * there it is the wrong one — use `scanRegisteredServers`, which says which files those were.
 */
export async function listRegisteredServers(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): Promise<RegisteredServer[]> {
  return (await scanRegisteredServers(env, platform)).servers;
}

function packageFrom(server: RegisteredServer): string | undefined {
  const line = [server.command, ...server.args].join(' ');
  const match = /(@[\w.-]+\/[\w.-]+|(?<=\s)[\w.-]+-mcp)(?=@|\s|$)/.exec(line);
  return match?.[1];
}
