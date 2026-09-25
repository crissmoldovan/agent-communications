import { execFile, spawn } from 'node:child_process';
import { access, constants, lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import { knownClientConfigs, listRegisteredServers, type RegisteredServer } from './mcp-clients.ts';

/*
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
  /**
   * What `npx` runs that package with, before the server's own flags.
   *
   * `@agentcomms/gmail-mcp` is nothing but the server, so it takes the flags directly and this is empty.
   * `@agentcomms/slack` is the whole CLI. The shared code used to drop `mcp` for every product, so a Slack entry
   * started `agent-slack --workspace acme` with no command — "unknown option", or the usage text when unpinned —
   * and exited at once, which a client reports only as a server that failed to start.
   */
  readonly npxArgs?: readonly string[] | undefined;
  /**
   * Trailing path segments, beyond the ones every product has, that also start this server.
   *
   * Every product is started by its own `dist/cli.mjs`, from a runtime or a checkout. Gmail also publishes a
   * separate `agent-gmail-mcp` bin, which a hand-written entry may use and which is still ours.
   */
  readonly entryFiles?: readonly (readonly string[])[] | undefined;
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
   * Anything already registered with the client being installed that is worth warning about.
   *
   * Gmail warns about third-party servers whose send tools no approval gates; Slack about other Slack servers,
   * which post with their own token and none of this package's approval steps.
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
  /**
   * Replace an existing entry of the same name. Needed to upgrade, because the entry pins an exact version.
   *
   * Only ever an entry this product wrote: see `claimName`.
   */
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
  /** What to paste, in the client's own format: TOML for codex, `servers` for VS Code, `mcpServers` elsewhere. */
  snippet: string;
  /** Why nothing was written although writing was asked for — the client's CLI is not on PATH. */
  notApplied?: string | undefined;
  /** Where the entry that was replaced was saved first, owner-only. */
  backupPath?: string | undefined;
  verified: boolean;
  verifyDetail?: string | undefined;
  /** What the product thought worth saying about other servers this client already has registered. */
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

function unscoped(packageName: string): string {
  return packageName.split('/').at(-1) ?? packageName;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The directory the managed launcher installs one product's exact version into: `<data>/runtime/<version>-<name>`.
 *
 * Exported so that everything which reads these paths back — both doctors, `prune`, the tests — builds them here
 * rather than with its own `join`. The layout changed once already, from `runtime/<version>` when Gmail was the
 * only product, and the Gmail doctor went on parsing the old one: every install made after the change was
 * reported as stale, with a fix that re-created the same path, for ever. A test written with a hand-made `join`
 * of the old layout kept passing throughout.
 */
export function managedRuntimeDir(dataDir: string, packageName: string, version: string): string {
  return join(dataDir, 'runtime', `${version}-${unscoped(packageName)}`);
}

/** The CLI inside a managed runtime, which is what a managed entry registers. */
export function managedRuntimeEntry(dataDir: string, packageName: string, version: string): string {
  return join(
    managedRuntimeDir(dataDir, packageName, version),
    'node_modules',
    ...packageName.split('/'),
    'dist',
    'cli.mjs',
  );
}

/**
 * The version a managed-runtime path pins, in either layout, or null when the path is not one.
 *
 * Both `runtime/0.4.0/…` (every Gmail install before the move) and `runtime/0.4.0-gmail/…` (every install
 * since) are read, and a prerelease keeps its own hyphen: `0.5.0-rc.1-gmail` is `0.5.0-rc.1`. Either separator,
 * and allowed to start the string, so a Windows or a relative path is not missed.
 */
export function managedRuntimeVersion(path: string, packageName: string): string | null {
  const scope = packageName.split('/').map(escapeRegExp).join('[/\\\\]');
  const pattern = new RegExp(
    `(?:^|[/\\\\])runtime[/\\\\]([^/\\\\]+?)(?:-${escapeRegExp(unscoped(packageName))})?[/\\\\]node_modules[/\\\\]${scope}[/\\\\]`,
  );
  return pattern.exec(path)?.[1] ?? null;
}

/**
 * The version one argument of a registered entry pins, or null when it pins none.
 *
 * Two launchers pin, and they look nothing alike: `managed` writes a runtime path, `npx` a package spec. Reading
 * only the first reported an `npx`-pinned install as current for ever. `local` pins nothing and is ignored.
 */
export function pinnedVersion(
  argument: string,
  product: Pick<McpProduct, 'packageName' | 'npxPackage'>,
): string | null {
  const names = [...new Set([product.packageName, product.npxPackage])].map(escapeRegExp).join('|');
  const spec = new RegExp(`^(?:${names})@(\\d[^\\s]*)$`);
  return managedRuntimeVersion(argument, product.packageName) ?? spec.exec(argument)?.[1] ?? null;
}

/**
 * Whether a registered entry starts this product's server.
 *
 * Decides what `--force` may replace, so it errs towards "not ours". An npm package read off the command line
 * settles it when there is one; otherwise an argument has to *end* in one of the paths this product is started
 * by, compared as whole runs of segments — `@agentcomms/gmail-evil/dist/cli.mjs`, `@agentcomms/gmail/dist/
 * index.mjs` and `packages/gmail/src/nested/cli.ts` are all near misses, and each was once accepted by a looser
 * match somewhere in this repository.
 */
export function isProductServer(
  server: Pick<RegisteredServer, 'command' | 'args' | 'packageName'>,
  product: Pick<McpProduct, 'packageName' | 'npxPackage' | 'entryFiles'>,
): boolean {
  if (server.packageName)
    return server.packageName === product.packageName || server.packageName === product.npxPackage;
  const short = unscoped(product.packageName);
  const entries: readonly (readonly string[])[] = [
    ['packages', short, 'src', 'cli.ts'],
    ['packages', short, 'dist', 'cli.mjs'],
    ['node_modules', ...product.packageName.split('/'), 'dist', 'cli.mjs'],
    ...(product.entryFiles ?? []),
  ];
  return [server.command, ...server.args].some((part) => {
    const segments = part.split(/[\\/]+/).filter(Boolean);
    return entries.some(
      (entry) =>
        segments.length >= entry.length &&
        entry.every((wanted, index) => segments[segments.length - entry.length + index] === wanted),
    );
  });
}

/**
 * The first file a registered entry starts that is no longer there, or null.
 *
 * The interpreter, when the entry names it by path, and the script it runs. A runtime deleted by hand, or a
 * Node removed by a version manager, leaves an entry that looks right and a client that says only "failed".
 */
export async function missingEntryFile(server: Pick<RegisteredServer, 'command' | 'args'>): Promise<string | null> {
  const wanted: { path: string; mode: number }[] = [];
  if (server.command && isAbsolute(server.command)) wanted.push({ path: server.command, mode: constants.X_OK });
  const script = server.args.find((argument) => isAbsolute(argument) && /\.(?:c|m)?[jt]s$/.test(argument));
  if (script) wanted.push({ path: script, mode: constants.R_OK });
  for (const { path, mode } of wanted) {
    try {
      await access(path, mode);
    } catch {
      return path;
    }
  }
  return null;
}

/**
 * The managed runtime for exactly this version, when one is already in place and can be reused.
 *
 * Its own manifest has to pin the exact version, and the package inside has to *be* that version. Finding
 * `cli.mjs` was the whole test before, and a runtime directory made by hand — pinned `^0.4.0`, and so free to hold
 * any 0.4.x — was reused as if this installer had made it: an entry "pinned" to a version it did not contain.
 */
export async function reusableRuntime(dataDir: string, packageName: string, version: string): Promise<string | null> {
  const root = managedRuntimeDir(dataDir, packageName, version);
  const entry = managedRuntimeEntry(dataDir, packageName, version);
  try {
    await stat(entry);
    const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    if (manifest.dependencies?.[packageName] !== version) return null;
    const installed = JSON.parse(
      await readFile(join(root, 'node_modules', ...packageName.split('/'), 'package.json'), 'utf8'),
    ) as { version?: unknown };
    return installed.version === version ? entry : null;
  } catch {
    return null;
  }
}

/** Installs the exact running version into its own directory, so an upgrade elsewhere cannot change what clients run. */
async function installManagedRuntime(context: InstallContext, product: McpProduct, version: string): Promise<string> {
  const { dataDir } = context.core.paths;
  const ready = await reusableRuntime(dataDir, product.packageName, version);
  if (ready) return ready;
  const root = managedRuntimeDir(dataDir, product.packageName, version);
  await mkdir(root, { recursive: true });
  // Written fresh even over an existing directory: a hand-made manifest's range must not survive into this one.
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
  const installed = await reusableRuntime(dataDir, product.packageName, version);
  if (!installed) {
    throw new CommsError('UNEXPECTED', `npm did not leave exactly ${product.packageName}@${version} in ${root}`, {
      hint: 'Remove that directory and run the install again, or use `--launcher npx`.',
    });
  }
  return installed;
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
  apply: boolean,
): Promise<{ entry: ServerEntry; launcher: Launcher; runtimeMissing: boolean }> {
  const launcher = options.launcher ?? 'managed';
  const node = await resolveNode(context.env);
  const env = minimalEnv(context, node);
  const serverArgs = product.serverArgs(options);

  if (launcher === 'npx') {
    const npx = (await whichExecutable('npx', context.env)) ?? 'npx';
    return {
      entry: {
        command: npx,
        args: ['-y', `${product.npxPackage}@${product.version}`, ...(product.npxArgs ?? []), ...serverArgs],
        env,
      },
      launcher,
      runtimeMissing: false,
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
    return {
      entry: { command: node, args: [...flags, entryPath, 'mcp', ...serverArgs], env },
      launcher,
      runtimeMissing: false,
    };
  }
  /*
   * `--print` installs nothing. It used to run the whole `npm install` before looking at whether it was only
   * printing, so "show me what you would write" downloaded a package into the data directory and left it there.
   * The path is the same either way, because it is computed rather than discovered.
   */
  if (!apply) {
    const { dataDir } = context.core.paths;
    const ready = await reusableRuntime(dataDir, product.packageName, product.version);
    return {
      entry: {
        command: node,
        args: [ready ?? managedRuntimeEntry(dataDir, product.packageName, product.version), 'mcp', ...serverArgs],
        env,
      },
      launcher,
      runtimeMissing: ready === null,
    };
  }
  const installed = await installManagedRuntime(context, product, product.version);
  return { entry: { command: node, args: [installed, 'mcp', ...serverArgs], env }, launcher, runtimeMissing: false };
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

/**
 * The entry as VS Code's user `mcp.json` documents it: a top-level `servers` object, and `type` on every entry.
 *
 * The shared writer used `mcpServers` and no `type`, which is the portable `.mcp.json` shape rather than the one
 * VS Code's own configuration reference describes for this file.
 */
function vscodeEntry(entry: ServerEntry): Record<string, unknown> {
  return { type: 'stdio', ...entry };
}

function tomlKey(key: string): string {
  return /^[A-Za-z0-9_-]+$/.test(key) ? key : JSON.stringify(key);
}

/**
 * The client's own format, because a snippet is something a person pastes.
 *
 * `--client codex --print` printed a JSON `mcpServers` object, which codex's `config.toml` cannot hold: advice
 * that fails on the first paste. JSON's string escapes are all valid in a TOML basic string, so values are
 * quoted with `JSON.stringify`.
 */
function snippetFor(client: SupportedClient, name: string, entry: ServerEntry): string {
  if (client === 'codex') {
    const table = `mcp_servers.${tomlKey(name)}`;
    const lines = [
      `[${table}]`,
      `command = ${JSON.stringify(entry.command)}`,
      `args = [${entry.args.map((argument) => JSON.stringify(argument)).join(', ')}]`,
    ];
    const env = Object.entries(entry.env);
    if (env.length > 0) {
      lines.push('', `[${table}.env]`, ...env.map(([key, value]) => `${tomlKey(key)} = ${JSON.stringify(value)}`));
    }
    return `${lines.join('\n')}\n`;
  }
  if (client === 'vscode') return `${JSON.stringify({ servers: { [name]: vscodeEntry(entry) } }, null, 2)}\n`;
  return `${JSON.stringify({ mcpServers: { [name]: entry } }, null, 2)}\n`;
}

/**
 * What is registered under this name with this client already, and whether it may be replaced.
 *
 * Two rules, the same for every client:
 *
 *  - **An entry this product did not write is never replaced, whatever `--force` says.** The default names are
 *    generic — `slack`, `gmail` — and so are other people's servers. The reference Slack server is set up with
 *    its token in exactly this entry's `env`, and `agent-slack mcp install` overwrote it, token and all, with no
 *    warning and no copy: on the file clients without `--force`, on codex because codex itself overwrites, and
 *    on Claude Code the moment somebody followed the "pass --force" hint. `--force` means "replace my older
 *    install", and nothing wider.
 *  - **Our own entry is replaced only with `--force`.** It used to depend on the client: Claude Code refused,
 *    while the file clients and codex overwrote silently. Now the flag means one thing everywhere.
 *
 * Project-scoped entries are not looked at: every write here targets user scope, so they are not what would be
 * replaced.
 */
function claimName(
  product: McpProduct,
  options: InstallOptions,
  name: string,
  existing: readonly RegisteredServer[],
): RegisteredServer[] {
  const taken = existing.filter(
    (server) => server.client === options.client && server.name === name && server.scope !== 'project',
  );
  const foreign = taken.find((server) => !isProductServer(server, product));
  if (foreign) {
    // Never the arguments or the env: either may hold somebody's token.
    const what = foreign.packageName ?? foreign.url ?? (foreign.command || 'something else');
    throw new CommsError(
      'CONFIG',
      `${options.client} already has an MCP server called "${name}", and it is not this one (it runs ${what})`,
      {
        hint: `Register this one under another name: \`${product.binary} mcp install --client ${options.client} --name ${product.binary}\`. --force does not replace a server this did not install.`,
      },
    );
  }
  if (taken.length > 0 && !options.force) {
    throw new CommsError('CONFIG', `${options.client} already has this server registered as "${name}"`, {
      hint: `Pass --force to replace it — that is how an upgrade reaches a client: \`${product.binary} mcp install --client ${options.client} --force\`.`,
    });
  }
  return taken;
}

/** Saves the entries about to be replaced, owner-only, and returns where. */
async function backUp(
  context: InstallContext,
  client: SupportedClient,
  name: string,
  previous: readonly RegisteredServer[],
  now: Date,
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(
    context.core.paths.dataDir,
    'mcp-backups',
    `${stamp}-${client}-${name.replace(/[^A-Za-z0-9_-]/g, '_')}.json`,
  );
  // writeFileAtomic creates the file 0600 and the directory 0700: an entry's env can hold a credential.
  await writeFileAtomic(
    path,
    `${JSON.stringify({ client, name, replacedAt: now.toISOString(), entries: previous }, null, 2)}\n`,
  );
  return path;
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
  const apply = options.apply ?? true;

  const existing = await listRegisteredServers(context.env);
  // The client being installed, only. Every other client's findings were being reported here too, with removal
  // advice that said "the file above" and meant a different file.
  const warnings = (product.warnAbout?.(existing.filter((server) => server.client === options.client)) ?? []).filter(
    Boolean,
  );

  const cliName = options.client === 'claude-code' ? 'claude' : options.client === 'codex' ? 'codex' : null;
  const binary = cliName ? await whichExecutable(cliName, context.env) : null;
  const configPath =
    options.client === 'json' || options.client === 'claude-code'
      ? undefined
      : knownClientConfigs(context.env).find((candidate) => candidate.client === options.client)?.path;
  const writes = apply && (cliName ? binary !== null : configPath !== undefined);

  // Before anything is installed or written: a refusal should cost nothing.
  const previous = writes ? claimName(product, options, name, existing) : [];
  if (!writes) {
    // Nothing is written, so nothing is refused — but a snippet pasted by hand would replace somebody's server.
    const foreign = existing.find(
      (server) =>
        server.client === options.client &&
        server.name === name &&
        server.scope !== 'project' &&
        !isProductServer(server, product),
    );
    if (foreign) {
      warnings.push(
        `${options.client} already has a different server called "${name}"; pasting this would replace it. Use --name to choose another name.`,
      );
    }
  }

  const { entry, launcher, runtimeMissing } = await buildEntry(context, product, options, apply);
  const snippet = snippetFor(options.client, name, entry);
  const backupPath =
    previous.length > 0 ? await backUp(context, options.client, name, previous, new Date()) : undefined;

  let method: InstallResult['method'] = 'printed';
  let applied = false;
  let notApplied: string | undefined;

  if (cliName && binary && writes) {
    const codexEnv = (values: Record<string, string> | undefined) =>
      Object.entries(values ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
    const args =
      options.client === 'claude-code'
        ? ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', 'user']
        : ['mcp', 'add', name, ...codexEnv(entry.env), '--', entry.command, ...entry.args];

    /*
     * The entry records an exact version — `runtime/<version>-<name>/…`, pinned on purpose so an upgrade elsewhere
     * cannot change what a client runs. So a published upgrade reaches nobody until someone re-registers, and
     * that is `--force`: remove, then add. `claimName` has already refused unless the entry is ours and `--force`
     * was given, so a removal here only ever removes this product's own older entry.
     */
    const replacing = previous.find((server) => server.client === options.client);
    if (replacing) {
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

      try {
        await run(binary, args);
      } catch (error) {
        // What was there goes back if the replacement does not land. Otherwise `--force` removes a working entry
        // and leaves the client with no server at all — strictly worse than the stale one it was asked to replace.
        const restore =
          options.client === 'claude-code'
            ? [
                'mcp',
                'add-json',
                name,
                // The env too: ours carries AGENT_COMMS_CONFIG_DIR, and an entry restored without it points the
                // client at the wrong directory — a server that starts, finds nothing, and says nothing about why.
                JSON.stringify({
                  command: replacing.command,
                  args: replacing.args,
                  ...(replacing.env ? { env: replacing.env } : {}),
                }),
                '--scope',
                'user',
              ]
            : ['mcp', 'add', name, ...codexEnv(replacing.env), '--', replacing.command, ...replacing.args];

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
              : `Re-register it with \`${product.binary} mcp install --client ${options.client}\`. The old entry is in ${backupPath}.`,
            cause: error,
          },
        );
      }
    } else {
      try {
        await run(binary, args);
      } catch (error) {
        const message = error instanceof CommsError ? error.message : String(error);
        if (/already exists/i.test(message)) {
          // Registered somewhere this could not read, so there is no telling whose it is — and so no removing it.
          throw new CommsError(
            'CONFIG',
            `${cliName} already has an MCP server called "${name}", somewhere this could not read`,
            {
              hint: `Look at it with \`${cliName} mcp get ${name}\`. If it is an older ${product.binary}, remove it with \`${cliName} mcp remove ${name}\` and run this again; if not, choose another --name.`,
              cause: error,
            },
          );
        }
        throw error;
      }
    }
    method = 'cli';
    applied = true;
  } else if (cliName && apply) {
    notApplied = `${cliName} was not found on PATH, so nothing was registered`;
  } else if (configPath && writes) {
    await mergeIntoJsonConfig(configPath, options.client, name, entry);
    method = 'file';
    applied = true;
  }

  let verified = false;
  let verifyDetail: string | undefined;
  if (!options.noVerify) {
    if (runtimeMissing) {
      verifyDetail = 'the managed runtime is not installed, and --print installs nothing';
    } else {
      const check = await verifyEntry(entry, product);
      verified = check.ok;
      verifyDetail = check.detail;
    }
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
    notApplied,
    backupPath,
    verified,
    verifyDetail,
    warnings,
  };
}

/** Merges the entry into a client's JSON config, keeping everything else in the file exactly as it was. */
async function mergeIntoJsonConfig(
  path: string,
  client: SupportedClient,
  name: string,
  entry: ServerEntry,
): Promise<void> {
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
  if (client === 'vscode') {
    // Our own older entry, written under the wrong key by an earlier version, goes rather than sitting beside the
    // new one. `claimName` has already refused if anything under this name was somebody else's.
    const legacy = current.mcpServers as Record<string, unknown> | undefined;
    if (legacy && typeof legacy === 'object' && name in legacy) {
      const { [name]: _replaced, ...rest } = legacy;
      if (Object.keys(rest).length > 0) current.mcpServers = rest;
      else delete current.mcpServers;
    }
    const servers = (current.servers as Record<string, unknown> | undefined) ?? {};
    current.servers = { ...servers, [name]: vscodeEntry(entry) };
  } else {
    const key = 'mcpServers' in current || !('servers' in current) ? 'mcpServers' : 'servers';
    const servers = (current[key] as Record<string, unknown> | undefined) ?? {};
    current[key] = { ...servers, [name]: entry };
  }
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

export interface PruneResult {
  /** The only directory anything is ever removed from. */
  runtimeDir: string;
  dryRun: boolean;
  /** Removed — or, with `dryRun`, what would be. */
  removed: { path: string; version: string }[];
  kept: { path: string; version: string; reason: string }[];
  /** Why nothing was removed at all, when something stopped the whole run. */
  refused?: string | undefined;
}

/** Every running process's command line, or null when they cannot be listed. */
export async function runningCommandLines(): Promise<string[] | null> {
  // No `ps` on Windows, and a guess is not good enough for a decision to delete: null keeps everything.
  if (process.platform === 'win32') return null;
  return new Promise((resolvePromise) => {
    execFile('ps', ['-A', '-o', 'args='], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? null : stdout.split('\n').filter(Boolean));
    });
  });
}

const RUNTIME_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/**
 * Removes this product's managed runtimes that no client registers and no process is running.
 *
 * Every upgrade installs a new `runtime/<version>-<name>` and leaves the old one where it was — a machine that had
 * been through six releases held five orphans at 4–5 MB each. Deleting a runtime a client still starts turns a
 * working server into one that fails with nothing in the client to say why, so everything that could mean "in
 * use" keeps it:
 *
 *  - only directories directly inside `<data>/runtime`, named like a version, that hold this product's package —
 *    never a symbolic link, never another product's runtime, never anything else in that directory;
 *  - never this release's own;
 *  - never one any registered entry names, in any client and any scope;
 *  - never one a running process names. When the processes cannot be listed, nothing is removed at all.
 */
export async function pruneManagedRuntimes(
  context: InstallContext,
  product: Pick<McpProduct, 'packageName' | 'version'>,
  options: { dryRun?: boolean; processes?: () => Promise<readonly string[] | null> } = {},
): Promise<PruneResult> {
  const runtimeDir = join(context.core.paths.dataDir, 'runtime');
  const result: PruneResult = { runtimeDir, dryRun: options.dryRun === true, removed: [], kept: [] };

  let names: string[];
  try {
    names = await readdir(runtimeDir);
  } catch {
    return result;
  }

  const candidates: { path: string; version: string; aliases: string[] }[] = [];
  const suffix = `-${unscoped(product.packageName)}`;
  for (const name of names.sort()) {
    if (!RUNTIME_NAME.test(name)) continue;
    const path = join(runtimeDir, name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      if (!(await lstat(join(path, 'node_modules', ...product.packageName.split('/')))).isDirectory()) continue;
    } catch {
      continue;
    }
    const version = name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
    const real = await realpath(path).catch(() => path);
    candidates.push({ path, version, aliases: [...new Set([path, real])] });
  }
  if (candidates.length === 0) return result;

  const processes = await (options.processes ?? runningCommandLines)();
  if (processes === null) {
    result.refused = 'the running processes on this machine could not be listed, so none of these can be shown unused';
    result.kept = candidates.map(({ path, version }) => ({ path, version, reason: 'not checked' }));
    return result;
  }
  const registered = await listRegisteredServers(context.env);
  const mentions = (aliases: string[], text: string) =>
    aliases.some((alias) => text === alias || text.includes(`${alias}${sep}`) || text.includes(`${alias}/`));

  const current = managedRuntimeDir(context.core.paths.dataDir, product.packageName, product.version);
  for (const { path, version, aliases } of candidates) {
    const owner = registered.find((server) => [server.command, ...server.args].some((part) => mentions(aliases, part)));
    const reason =
      path === current
        ? 'this release'
        : owner
          ? `registered with ${owner.client} as "${owner.name}"`
          : processes.some((line) => mentions(aliases, line))
            ? 'a running process uses it'
            : null;
    if (reason) {
      result.kept.push({ path, version, reason });
      continue;
    }
    // `rm` does not follow a link, so even a directory swapped for one since the scan loses only the link.
    if (!result.dryRun) await rm(path, { recursive: true });
    result.removed.push({ path, version });
  }
  return result;
}
