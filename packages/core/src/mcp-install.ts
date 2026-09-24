import { spawn } from 'node:child_process';
import { access, constants, mkdir, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { knownClientConfigs, listRegisteredServers, type RegisteredServer } from './mcp-clients.ts';

/**
 * Registering the server with an MCP client. Two failures seen in the wild shape this:
 *
 *  - clients start servers with a **minimal PATH**, so `node` or `npx` by bare name is not found. Every entry
 *    written here therefore uses an absolute interpreter path and an explicit PATH.
 *  - `process.execPath` is not always the `node` the user has on their PATH (it can be a runtime bundled inside
 *    another app), and a keychain item created by one Node build is not always readable by another. So the entry
 *    prefers the PATH-visible `node`, and only falls back to this process's.
 */
/**
 * What is being registered.
 *
 * The client-config machinery below is the same for every product — where each client keeps its servers, how a
 * minimal PATH breaks a bare `node`, which npm binary works on Windows. Only these few facts differ, so they are
 * a parameter rather than a second copy of four hundred lines. `@agentcomms/slack` had no `mcp install` at all
 * for exactly as long as this file lived inside the Gmail package.
 */
export interface McpProduct {
  /** `@agentcomms/gmail`. Installed into the managed runtime, and pinned in the entry. */
  readonly packageName: string;
  /** The binary a person types, for hints: `agent-gmail`. */
  readonly binary: string;
  /** The default name the client shows: `gmail`. */
  readonly defaultServerName: string;
  /** The package `npx` runs, when that launcher is chosen. Often a thin `-mcp` wrapper. */
  readonly npxPackage: string;
  /** The version being installed; the entry pins it exactly. */
  readonly version: string;
  /**
   * `import.meta.url` of a module inside the calling package.
   *
   * Only used by the `local` launcher, and it has to come from the caller: resolving it here would find core.
   */
  readonly moduleUrl: string;
  /** Extra arguments after `mcp`, from the caller's options — `--inbox work`, `--workspace acme/slack`. */
  serverArgs(options: InstallOptions): string[];
  /**
   * Anything already registered that is worth warning about.
   *
   * Gmail warns about third-party servers whose send tools no approval gates. Slack has no equivalent: a
   * `read` workspace's token cannot post at all, so there is nothing to warn about.
   */
  warnAbout?(servers: readonly RegisteredServer[]): string[];
}

export type Launcher = 'managed' | 'npx' | 'local';

export type SupportedClient = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'gemini' | 'vscode' | 'json';

export interface InstallOptions {
  client: SupportedClient;
  name?: string | undefined;
  /** Gmail's pin. */
  inbox?: string | undefined;
  /** Slack's pin. */
  workspace?: string | undefined;
  readOnly?: boolean | undefined;
  launcher?: Launcher | undefined;
  /** Skip starting the server to prove the entry works (used when a network install is not possible). */
  noVerify?: boolean | undefined;
  /** Write the file or run the client's CLI; false only prints what would be done. */
  apply?: boolean | undefined;
  /** Replace an existing entry of the same name. Needed to upgrade, because the entry pins an exact version. */
  force?: boolean | undefined;
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

function minimalEnv(context: InstallContext, node: string): Record<string, string> {
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

/** What this needs from whichever package is calling: its environment and where its data lives. */
export interface InstallContext {
  env: NodeJS.ProcessEnv;
  core: { paths: { dataDir: string; configDir: string } };
}

/** Installs the exact running version into its own directory, so an upgrade elsewhere cannot change what clients run. */
async function installManagedRuntime(context: InstallContext, product: McpProduct, version: string): Promise<string> {
  const scope = product.packageName.split('/');
  const root = join(context.core.paths.dataDir, 'runtime', `${version}-${scope[1] ?? 'server'}`);
  const entry = join(root, 'node_modules', ...scope, 'dist', 'cli.mjs');
  try {
    await stat(entry);
    return entry;
  } catch {
    // Not installed yet.
  }
  await mkdir(root, { recursive: true });
  await writeFileAtomic(
    join(root, 'package.json'),
    `${JSON.stringify({ name: `${product.binary}-runtime`, private: true }, null, 2)}\n`,
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
    `${product.packageName}@${version}`,
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
  context: InstallContext,
  product: McpProduct,
  options: InstallOptions,
): Promise<{ entry: ServerEntry; launcher: Launcher }> {
  const launcher = options.launcher ?? 'managed';
  const node = await resolveNode(context.env);
  const env = minimalEnv(context, node);
  const serverArgs = ['mcp', ...product.serverArgs(options)];

  if (launcher === 'npx') {
    const npx = (await whichExecutable('npx', context.env)) ?? 'npx';
    return {
      entry: { command: npx, args: ['-y', `${product.npxPackage}@${product.version}`, ...serverArgs.slice(1)], env },
      launcher,
    };
  }
  if (launcher === 'local') {
    // The checkout this command is running from: used in development and by the tests. Resolved from this module's
    // own location, never from `process.argv[1]` — under a test runner that is the test file, and registering it
    // would make the client re-run the tests instead of starting a server.
    const entryPath = await localCliEntry(product.moduleUrl);
    // Running the TypeScript source needs the flag on Node 22.12–22.17, where stripping is not yet on by default.
    const flags = entryPath.endsWith('.ts')
      ? ['--experimental-strip-types', '--disable-warning=ExperimentalWarning']
      : [];
    return { entry: { command: node, args: [...flags, entryPath, ...serverArgs], env }, launcher };
  }
  const installed = await installManagedRuntime(context, product, product.version);
  return { entry: { command: node, args: [installed, ...serverArgs], env }, launcher };
}

/**
 * The calling package's own CLI entry: `src/cli.ts` from source, `dist/cli.mjs` when bundled.
 *
 * `moduleUrl` comes from the product, not from this file. While this code lived inside the Gmail package,
 * `import.meta.url` was the Gmail package and resolving from it was right; the moment it moved to core the same
 * line started registering **core's** CLI as the Gmail server — a `local` install that pointed at the wrong
 * program entirely. The product knows where it lives; this does not.
 */
export async function localCliEntry(moduleUrl: string): Promise<string> {
  const here = dirname(fileURLToPath(moduleUrl));
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
export async function mcpInstall(
  context: InstallContext,
  product: McpProduct,
  options: InstallOptions,
): Promise<InstallResult> {
  const name = options.name ?? product.defaultServerName;
  // Resolved here, whatever `--no-verify` says: a server pinned to a name that does not exist — or to one that was
  // renamed — starts, fails, and says so only in a client's log. Refused now, with the name it is called today.
  const { entry, launcher } = await buildEntry(context, product, options);
  const snippet = snippetFor(name, entry);
  const apply = options.apply ?? true;

  const existing = await listRegisteredServers(context.env);
  // The product decides what is worth warning about; this only passes on what it says.
  const warnings = (product.warnAbout?.(existing) ?? []).filter(Boolean);

  let method: InstallResult['method'] = 'printed';
  let configPath: string | undefined;
  let applied = false;

  if (options.client === 'claude-code' || options.client === 'codex') {
    const cliName = options.client === 'claude-code' ? 'claude' : 'codex';
    const binary = await whichExecutable(cliName, context.env);
    if (binary && apply) {
      const codexEnv = (values: Record<string, string> | undefined) =>
        Object.entries(values ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
      const args =
        options.client === 'claude-code'
          ? ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', 'user']
          : ['mcp', 'add', name, ...codexEnv(entry.env), '--', entry.command, ...entry.args];

      /*
       * These CLIs refuse to overwrite an entry that already exists, and the entry records an exact version —
       * `runtime/<version>/…`, pinned on purpose so an upgrade elsewhere cannot change what a client runs. The two
       * together mean a published upgrade reaches nobody until someone re-registers, and the obvious command for
       * that fails with "already exists" and no route forward. A release sat unused on a machine for exactly this
       * reason.
       *
       * So `--force` removes first. Not the default: replacing a working server entry is the sort of thing to ask
       * for, and the failure without it now says how.
       */
      if (options.force) {
        // What is there now, so it can go back if the replacement does not land. `--force` otherwise removes a
        // working entry and, on any failure after that, leaves the client with no server at all — strictly worse
        // than the stale one it was asked to replace.
        // User scope only: every command below targets it, so a project-scoped entry of the same name is not the
        // one being replaced and must not be treated as the thing to restore.
        const previous = existing.find(
          (server) => server.client === options.client && server.name === name && server.scope !== 'project',
        );
        const removal =
          options.client === 'claude-code' ? ['mcp', 'remove', name, '--scope', 'user'] : ['mcp', 'remove', name];
        try {
          await run(binary, removal);
        } catch (error) {
          // Nothing registered under that name is the state we wanted anyway. Anything else is a real failure and
          // must not be swallowed: proceeding would add beside an entry we failed to remove.
          const message = error instanceof CommsError ? error.message : String(error);
          if (!/no (mcp )?server|not found|does not exist/i.test(message)) throw error;
        }

        if (previous) {
          try {
            await run(binary, args);
          } catch (error) {
            const restore =
              options.client === 'claude-code'
                ? [
                    'mcp',
                    'add-json',
                    name,
                    // The env too: ours carries AGENT_COMMS_CONFIG_DIR, and an entry restored without it points the
                    // client at the wrong directory — a server that starts, finds no mailboxes, and says nothing
                    // about why. A silent wrong answer is worse than the missing entry it was replacing.
                    JSON.stringify({
                      command: previous.command,
                      args: previous.args,
                      ...(previous.env ? { env: previous.env } : {}),
                    }),
                    '--scope',
                    'user',
                  ]
                : ['mcp', 'add', name, ...codexEnv(previous.env), '--', previous.command, ...previous.args];

            // Only claim the entry is back if it is. Saying so after a failed restore leaves somebody believing
            // their working server survived, when in fact nothing is registered at all.
            let restored = true;
            try {
              await run(binary, restore);
            } catch {
              restored = false;
            }
            throw new CommsError(
              'CONFIG',
              restored
                ? `could not register "${name}"; the previous entry was put back`
                : `could not register "${name}", and the previous entry could not be put back either — ${cliName} now has no server called "${name}"`,
              {
                hint: restored
                  ? 'Check the client is not running, then try again.'
                  : `Re-register it with \`${product.binary} mcp install --client ${options.client}\`.`,
                cause: error,
              },
            );
          }
          method = 'cli';
          applied = true;
        }
      }

      if (!applied) {
        try {
          await run(binary, args);
        } catch (error) {
          const message = error instanceof CommsError ? error.message : String(error);
          if (/already exists/i.test(message)) {
            throw new CommsError('CONFIG', `${cliName} already has an MCP server called "${name}"`, {
              hint: `Pass --force to replace it, or remove it first: \`${cliName} mcp remove ${name}\`.`,
              cause: error,
            });
          }
          throw error;
        }
        method = 'cli';
        applied = true;
      }
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
    const check = await verifyEntry(entry, product);
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
export async function verifyEntry(
  entry: ServerEntry,
  product: Pick<McpProduct, 'binary' | 'version'>,
): Promise<{ ok: boolean; detail: string }> {
  const { Client } = await import('@modelcontextprotocol/client');
  const { StdioClientTransport } = await import('@modelcontextprotocol/client/stdio');
  const client = new Client({ name: `${product.binary}-install-check`, version: product.version });
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
