import { spawn } from 'node:child_process';
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommsError, writeFileAtomic } from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { findUngatedGmailServers, knownClientConfigs, listRegisteredServers } from '../operations/client-configs.ts';
import { VERSION } from '../version.ts';

/**
 * Registering the server with an MCP client. Two failures seen in the wild shape this:
 *
 *  - clients start servers with a **minimal PATH**, so `node` or `npx` by bare name is not found. Every entry
 *    written here therefore uses an absolute interpreter path and an explicit PATH.
 *  - `process.execPath` is not always the `node` the user has on their PATH (it can be a runtime bundled inside
 *    another app), and a keychain item created by one Node build is not always readable by another. So the entry
 *    prefers the PATH-visible `node`, and only falls back to this process's.
 */
export type Launcher = 'managed' | 'npx' | 'local';

export type SupportedClient = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'gemini' | 'vscode' | 'json';

export interface InstallOptions {
  client: SupportedClient;
  name?: string | undefined;
  inbox?: string | undefined;
  readOnly?: boolean | undefined;
  launcher?: Launcher | undefined;
  /** Skip starting the server to prove the entry works (used when a network install is not possible). */
  noVerify?: boolean | undefined;
  /** Write the file or run the client's CLI; false only prints what would be done. */
  apply?: boolean | undefined;
}

export interface ServerEntry {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface InstallResult {
  client: SupportedClient;
  name: string;
  entry: ServerEntry;
  launcher: Launcher;
  /** The file the entry belongs in, when the client keeps one. */
  configPath?: string | undefined;
  /** What was actually done. */
  applied: boolean;
  /** How it was applied, or why it was only printed. */
  method: 'cli' | 'file' | 'printed';
  /** The JSON snippet for clients that are configured by hand. */
  snippet: string;
  verified: boolean;
  verifyDetail?: string | undefined;
  /** Other Gmail servers this client already has registered. */
  warnings: string[];
}

/** Looks for an executable on PATH, the way a shell would. */
export async function whichExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  const paths = (env.PATH ?? '').split(delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? (env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : [''];
  for (const directory of paths) {
    for (const extension of extensions) {
      const candidate = join(directory, name + extension.toLowerCase());
      try {
        await access(candidate, constants.X_OK);
        return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

/** The interpreter to register: the one on PATH when there is one, otherwise this process's. */
export async function resolveNode(env: NodeJS.ProcessEnv): Promise<string> {
  return (await whichExecutable('node', env)) ?? process.execPath;
}

function minimalEnv(context: GmailContext, node: string): Record<string, string> {
  const env: Record<string, string> = {
    // Clients start servers with a minimal environment; the config directory has to be named explicitly, or the
    // server would look in the wrong place and report no inboxes.
    AGENT_COMMS_CONFIG_DIR: context.core.paths.configDir,
    PATH: [dirname(node), '/usr/local/bin', '/usr/bin', '/bin'].join(delimiter),
  };
  if (process.platform === 'linux') {
    // Needed for the system keychain (Secret Service) to be reachable from a background process.
    for (const key of ['DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR']) {
      const value = context.env[key];
      if (value) env[key] = value;
    }
  }
  return env;
}

/** Installs the exact running version into its own directory, so an upgrade elsewhere cannot change what clients run. */
async function installManagedRuntime(context: GmailContext, version: string): Promise<string> {
  const root = join(context.core.paths.dataDir, 'runtime', version);
  const entry = join(root, 'node_modules', '@agentcomms', 'gmail', 'dist', 'cli.mjs');
  try {
    await stat(entry);
    return entry;
  } catch {
    // Not installed yet.
  }
  await mkdir(root, { recursive: true });
  await writeFileAtomic(
    join(root, 'package.json'),
    `${JSON.stringify({ name: 'agent-gmail-runtime', private: true }, null, 2)}\n`,
  );
  const npmCli = await findNpmCli();
  await run(process.execPath, [
    npmCli,
    'install',
    '--prefix',
    root,
    '--save-exact',
    '--no-audit',
    '--no-fund',
    `@agentcomms/gmail@${version}`,
  ]);
  await stat(entry);
  return entry;
}

/** npm's own JS entry, run through this Node: spawning `npm.cmd` without a shell throws on current Node on Windows. */
async function findNpmCli(): Promise<string> {
  const candidates = [
    join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'),
    join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'),
  ];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return resolve(candidate);
    } catch {
      // try the next
    }
  }
  throw new CommsError('CONFIG', 'npm could not be found next to this Node installation', {
    hint: 'Install with `--launcher npx` instead, which runs the published package directly.',
  });
}

function run(command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('exit', (code) => {
      if (code === 0) resolvePromise();
      else reject(new CommsError('PROVIDER_UNAVAILABLE', `${command} failed: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

async function buildEntry(
  context: GmailContext,
  options: InstallOptions,
): Promise<{ entry: ServerEntry; launcher: Launcher }> {
  const launcher = options.launcher ?? 'managed';
  const node = await resolveNode(context.env);
  const env = minimalEnv(context, node);
  const serverArgs = ['mcp'];
  if (options.inbox) serverArgs.push('--inbox', options.inbox);
  if (options.readOnly) serverArgs.push('--read-only');

  if (launcher === 'npx') {
    const npx = (await whichExecutable('npx', context.env)) ?? 'npx';
    return {
      entry: { command: npx, args: ['-y', `@agentcomms/gmail-mcp@${VERSION}`, ...serverArgs.slice(1)], env },
      launcher,
    };
  }
  if (launcher === 'local') {
    // The checkout this command is running from: used in development and by the tests. Resolved from this module's
    // own location, never from `process.argv[1]` — under a test runner that is the test file, and registering it
    // would make the client re-run the tests instead of starting a server.
    const entryPath = await localCliEntry();
    // Running the TypeScript source needs the flag on Node 22.12–22.17, where stripping is not yet on by default.
    const flags = entryPath.endsWith('.ts')
      ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
      : [];
    return { entry: { command: node, args: [...flags, entryPath, ...serverArgs], env }, launcher };
  }
  const installed = await installManagedRuntime(context, VERSION);
  return { entry: { command: node, args: [installed, ...serverArgs], env }, launcher };
}

/** This package's own CLI entry: `src/cli.ts` when running from source, `dist/cli.mjs` when bundled. */
async function localCliEntry(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [join(here, '..', 'cli.ts'), join(here, 'cli.mjs'), join(here, '..', 'cli.mjs')];
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.R_OK);
      return resolve(candidate);
    } catch {
      // try the next layout
    }
  }
  throw new CommsError('UNEXPECTED', "cannot find this package's own command to register");
}

function snippetFor(name: string, entry: ServerEntry): string {
  return `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`;
}

/**
 * Writes (or prints) the entry for one client, then starts the server through exactly that entry and completes an
 * `initialize` and `tools/list`. An entry that looks right but does not start is the failure people actually hit.
 */
export async function mcpInstall(context: GmailContext, options: InstallOptions): Promise<InstallResult> {
  const name = options.name ?? 'gmail';
  const { entry, launcher } = await buildEntry(context, options);
  const snippet = snippetFor(name, entry);
  const apply = options.apply ?? true;

  const existing = await listRegisteredServers(context.env);
  const warnings = findUngatedGmailServers(existing)
    .filter((finding) => finding.client === options.client)
    .map(
      (finding) =>
        `${finding.packageName} is registered with ${finding.client} as "${finding.name}": ${finding.reason}. Remove it: ${finding.removal}`,
    );

  let method: InstallResult['method'] = 'printed';
  let configPath: string | undefined;
  let applied = false;

  if (options.client === 'claude-code' || options.client === 'codex') {
    const cliName = options.client === 'claude-code' ? 'claude' : 'codex';
    const binary = await whichExecutable(cliName, context.env);
    if (binary && apply) {
      const args =
        options.client === 'claude-code'
          ? ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', 'user']
          : ['mcp', 'add', name, '--', entry.command, ...entry.args];
      await run(binary, args);
      method = 'cli';
      applied = true;
    }
  } else if (options.client !== 'json') {
    const file = knownClientConfigs(context.env).find((candidate) => candidate.client === options.client);
    configPath = file?.path;
    if (configPath && apply) {
      await mergeIntoJsonConfig(configPath, name, entry);
      method = 'file';
      applied = true;
    }
  }

  let verified = false;
  let verifyDetail: string | undefined;
  if (!options.noVerify) {
    const check = await verifyEntry(entry);
    verified = check.ok;
    verifyDetail = check.detail;
  }

  return {
    client: options.client,
    name,
    entry,
    launcher,
    configPath,
    applied,
    method,
    snippet,
    verified,
    verifyDetail,
    warnings,
  };
}

/** Merges the entry into a client's JSON config, keeping everything else in the file exactly as it was. */
async function mergeIntoJsonConfig(path: string, name: string, entry: ServerEntry): Promise<void> {
  let current: Record<string, unknown> = {};
  try {
    current = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw new CommsError('CONFIG', `${path} is not valid JSON, so it was left alone`, {
        hint: 'Fix the file, or add the snippet by hand.',
        cause: error,
      });
    }
  }
  const key = 'mcpServers' in current || !('servers' in current) ? 'mcpServers' : 'servers';
  const servers = (current[key] as Record<string, unknown> | undefined) ?? {};
  current[key] = { ...servers, [name]: entry };
  await mkdir(dirname(path), { recursive: true });
  await writeFileAtomic(path, `${JSON.stringify(current, null, 2)}\n`);
}

/** Starts the server exactly as a client would, and completes the handshake. */
export async function verifyEntry(entry: ServerEntry): Promise<{ ok: boolean; detail: string }> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: 'agent-gmail-install-check', version: VERSION });
  const transport = new StdioClientTransport({ command: entry.command, args: entry.args, env: entry.env });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    return { ok: true, detail: `the server started and offered ${tools.tools.length} tools` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  } finally {
    await client.close().catch(() => undefined);
  }
}
