import { execFile, spawn } from 'node:child_process';
import { access, constants, lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inlineCommand } from './cli-runtime.ts';
import { externalCommand } from './command-brands.ts';
import { CommsError, type ErrorCode, EXIT_CODES } from './errors.ts';
import { appendPrivateLine, replaceFileInPlace, writeFileAtomic } from './fs.ts';
import {
  exchangePointer,
  type LauncherPointer,
  launcherCanStart,
  launcherCli,
  launcherExists,
  launcherName,
  launcherPaths,
  launcherRuntimeVersion,
  readPointer,
  registeredLauncher,
  restorePointer,
  writeLauncher,
} from './launcher.ts';
import { type ManagedShimWriteResult, removeManagedShimsForRuntimes, type writeManagedShim } from './managed-shims.ts';
import {
  codexServerFromGet,
  commandLinePackage,
  displayUrl,
  knownClientConfigs,
  type RegisteredServer,
  scanRegisteredServers,
  type UnreadableConfig,
} from './mcp-clients.ts';
import { nodeProgram } from './node-program.ts';
import { homeDirectory, homeForDiscovery, shortenHome, withoutPathOptions } from './paths.ts';
import { absoluteSearchPath, childEnvironment } from './system-programs.ts';
import { compareVersions } from './versions.ts';

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
  /** The binary a person types, for hints: `agent-gmail`. An entry that starts it is this product's. */
  readonly binary: string;
  /**
   * Other published commands that start this server, beside `binary`: Gmail's `agent-gmail-mcp`.
   *
   * A hand-written entry may start the server by any of them — the Slack README says `agent-slack mcp` runs it —
   * and such an entry is ours. Read only from an entry's command, never its arguments: `npx -y agent-slack` would
   * fetch whatever the registry holds under that name.
   */
  readonly bins?: readonly string[] | undefined;
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
  /**
   * Extra arguments after `mcp`, from the caller's options — `--inbox work`, `--workspace acme/slack`.
   *
   * These are also the `mcp install` command's own flags for the same thing, which is what lets a refusal's hint
   * repeat them: see `installCommand`.
   */
  serverArgs(options: InstallOptions): string[];
  /**
   * The pin and `--read-only` an entry's arguments carry, read back as the options `serverArgs` takes.
   *
   * `--force` builds the replacement from the caller's options alone, so an upgrade that left the pin out turned
   * an entry pinned to one mailbox, and `--read-only`, into one that reached every mailbox with every tool — and
   * said nothing. What the entry being replaced narrowed is read back here and kept: see `keepNarrowing`.
   */
  narrowingOf(args: readonly string[]): Narrowing;
  /**
   * Anything already registered with the client being installed that is worth warning about.
   *
   * Gmail warns about third-party servers whose send tools no approval gates; Slack about other Slack servers,
   * which post with their own token and none of this package's approval steps.
   */
  warnAbout?(servers: readonly RegisteredServer[], platform?: NodeJS.Platform | undefined): string[];
}

export type Launcher = 'managed' | 'npx' | 'local';

export type SupportedClient = 'claude-code' | 'claude-desktop' | 'codex' | 'cursor' | 'gemini' | 'vscode' | 'json';

export interface InstallOptions {
  client: SupportedClient;
  name?: string | undefined;
  /** The pin of every channel after Gmail and Slack: `--account <organisation/channel>` (design 2026-09-26). */
  account?: string | undefined;
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

/** What narrows what a server may reach: its pin to one account, and `--read-only`. */
export type Narrowing = Pick<InstallOptions, 'account' | 'inbox' | 'workspace' | 'readOnly'>;

/** The install options that pin a server to one account: the generic one, and Gmail's and Slack's own names. */
export const PIN_OPTIONS: readonly ('account' | 'inbox' | 'workspace')[] = Object.freeze([
  'account',
  'inbox',
  'workspace',
]);

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
  /**
   * Whether the entry was started, and how that went: `failed` is a check that ran and did not complete a
   * handshake, `skipped` one that did not run (`--no-verify`, or a `--print` with no runtime to start).
   *
   * `verified: false` meant both, and both were printed as "Not checked" and ended the command with 0. So
   * `--force` could replace a working entry with one that exits at once, say it had not checked, and report
   * success to every script that looks at the exit status.
   */
  verification: 'passed' | 'failed' | 'skipped';
  verifyDetail?: string | undefined;
  /** What the product thought worth saying about other servers this client already has registered. */
  warnings: string[];
  /**
   * The managed CLI shim written beside this install, absent for npx, local and --print. The operation writes it
   * (`withManagedShim`), since finding the command takes the locator, which the installer may not import.
   */
  shim?: ManagedShimWriteResult | undefined;
  /** A shim write that failed after the registration outcome was already known. */
  shimFailure?: string | undefined;
  /** Why a managed install deliberately offered no shim on this platform. */
  shimNotice?: string | undefined;
}

/** Looks for an executable on PATH, the way a shell would. */
export async function whichExecutable(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return executableIn(name, (env.PATH ?? '').split(delimiter), env);
}

/**
 * Where a client's own command is usually installed, looked in after PATH: `~/.local/bin`, where Anthropic's native
 * installer puts `claude`, then `/opt/homebrew/bin` and `/usr/local/bin`, where Homebrew puts `claude` and `codex` on
 * Apple Silicon and on Intel.
 *
 * An install run from inside an MCP server has the PATH written into that server's entry at registration —
 * `node`'s own directory, `/usr/local/bin`, `/usr/bin`, `/bin` — and nothing of the person's shell. `claude` from
 * Homebrew on an Apple Silicon Mac, or from the native installer anywhere, is on none of those, so a registration
 * asked for from chat found no `claude`, registered nothing, and printed the entry instead. That PATH is left as it
 * is: it is in every entry already registered, and changing it would rewrite them all.
 *
 * The home is the environment's own `HOME`, never `os.homedir()`, so a test's temporary home is the only home looked
 * in. `AGENT_COMMS_CLIENT_CLI_DIRS` replaces the two system directories — a list, separated as PATH is, and empty for
 * none — which is how the tests keep every lookup inside their own directories: a `claude` or `codex` really
 * installed on the machine running them would otherwise be found, and run, by a test that meant to have none.
 *
 * Only absolute directories are looked in. A relative one would be read against whatever directory the server was
 * started from, so the command found — and run — would depend on where that was. And none on Windows: a client there
 * is a `.cmd` shim, which this cannot start without a shell, so a fallback could only find something it cannot run.
 */
export function clientCliDirectories(env: NodeJS.ProcessEnv): string[] {
  if (process.platform === 'win32') return [];
  const home = env.HOME ? homeForDiscovery(env.HOME, "a client's command in ~/.local/bin", env) : env.HOME;
  const system =
    env.AGENT_COMMS_CLIENT_CLI_DIRS !== undefined
      ? env.AGENT_COMMS_CLIENT_CLI_DIRS.split(delimiter)
      : ['/opt/homebrew/bin', '/usr/local/bin'];
  return [...(home ? [join(home, '.local', 'bin')] : []), ...system].filter(
    (directory) => directory !== '' && isAbsolute(directory),
  );
}

/**
 * A client's own command — `claude`, `codex` — on PATH, or else where it is usually installed: see
 * `clientCliDirectories`. Every place that looks for a client's command looks through here, so the one that plans a
 * registration and the one that makes it cannot disagree about whether it is there.
 */
export async function findClientCli(name: string, env: NodeJS.ProcessEnv): Promise<string | null> {
  return (await whichExecutable(name, env)) ?? executableIn(name, clientCliDirectories(env), env);
}

/** Where `findClientCli` looked, as a sentence ends: "on PATH or in ~/.local/bin, /opt/homebrew/bin or /usr/local/bin". */
export function clientCliSearch(env: NodeJS.ProcessEnv): string {
  const directories = clientCliDirectories(env);
  if (directories.length === 0) return 'on PATH';
  const last = directories.at(-1) as string;
  const rest = directories.slice(0, -1);
  return `on PATH or in ${rest.length > 0 ? `${rest.join(', ')} or ${last}` : last}`;
}

/**
 * The first of `directories` that holds an executable `name`. PATH is read by the caller, once: a test that counts
 * how often the installer looks at PATH counts exactly the looks it means.
 *
 * Only absolute directories are looked in, whoever the caller. An empty entry of PATH is the current folder to a
 * shell, and a relative one is read against it: the `node`, `npx` or `claude` found there — and then run, or written
 * into a client's config to be run — would be whatever is in the folder this was started from, which is where a
 * download may have saved a stranger's file.
 */
async function executableIn(
  name: string,
  directories: readonly string[],
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  const paths = absoluteSearchPath(directories);
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
    // Clients start servers with a minimal environment. Suite identity travels in argv; this keeps only what the
    // interpreter and, on Linux, the system keychain need from the launching environment.
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
  core: { paths: { configDir: string; stateDir: string; dataDir: string; secretsDir: string } };
  /** The shell the commands it prints are quoted for: this machine's, unless a test asks for another by name. */
  platform?: NodeJS.Platform | undefined;
  /** Test seam for a filesystem shim failure after a temporary client config has been written. */
  writeShim?: typeof writeManagedShim | undefined;
}

/** The complete suite identity every installer-written server registration carries. Downloads are operation-local. */
function registrationPathArgs(context: InstallContext): string[] {
  const { configDir, stateDir, dataDir, secretsDir } = context.core.paths;
  return ['--config-dir', configDir, '--state-dir', stateDir, '--data-dir', dataDir, '--secrets-dir', secretsDir];
}

function unscoped(packageName: string): string {
  return packageName.split('/').at(-1) ?? packageName;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * An MCP client's own command about one of its entries — `claude mcp get <name>`, `codex mcp remove <name>` — in
 * backticks for a hint, or, when there is none to give, `instead`.
 *
 * The client's program, so an external command (`externalCommand`), and the name is whatever the entry is called. A
 * name that is also one of this suite's commands — the core server's own default, `agentcomms`, is one — is refused
 * there, because such a word is how a suite command would get round the locator; the hint then says the same thing in
 * words rather than printing a command with that name in it.
 */
function clientCommandHint(words: readonly string[], platform: NodeJS.Platform | undefined, instead: string): string {
  try {
    return inlineCommand(
      externalCommand(
        words,
        "the MCP client's own command reads or removes an entry of its own configuration",
        platform,
      ),
    );
  } catch {
    return instead;
  }
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
 * and allowed to start the string, so a Windows or a relative path is not missed. On Windows (`platform`), whose
 * paths are not case-sensitive, the folder names are read without case; the version keeps the case it has.
 */
export function managedRuntimeVersion(path: string, packageName: string, platform?: NodeJS.Platform): string | null {
  const scope = packageName.split('/').map(escapeRegExp).join('[/\\\\]');
  const pattern = new RegExp(
    `(?:^|[/\\\\])runtime[/\\\\]([^/\\\\]+?)(?:-${escapeRegExp(unscoped(packageName))})?[/\\\\]node_modules[/\\\\]${scope}[/\\\\]`,
    platform === 'win32' ? 'i' : '',
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
  platform?: NodeJS.Platform,
): string | null {
  const names = [...new Set([product.packageName, product.npxPackage])].map(escapeRegExp).join('|');
  const spec = new RegExp(`^(?:${names})@(\\d[^\\s]*)$`, platform === 'win32' ? 'i' : '');
  return managedRuntimeVersion(argument, product.packageName, platform) ?? spec.exec(argument)?.[1] ?? null;
}

/**
 * Whether a registered entry starts this product's server.
 *
 * Decides what `--force` may replace, so it errs towards "not ours". An npm package read off the command line
 * settles it when there is one; otherwise an argument has to *end* in one of the paths this product is started
 * by, compared as whole runs of segments — `@agentcomms/gmail-evil/dist/cli.mjs`, `@agentcomms/gmail/dist/
 * index.mjs` and `packages/gmail/src/nested/cli.ts` are all near misses, and each was once accepted by a looser
 * match somewhere in this repository.
 *
 * Only the entry's own words are read: the suite's path options and their values are taken out first, because a pinned
 * folder that ends in `packages/slack/src/cli.ts` is a folder, not Slack (`withoutPathOptions`). On Windows
 * (`platform`), whose file names are not case-sensitive, the command's name and every path segment are compared
 * without case, as Windows itself finds them; everywhere else exactly. Left out, it compares exactly.
 */
export function isProductServer(
  server: Pick<RegisteredServer, 'command' | 'args' | 'packageName'>,
  product: Pick<McpProduct, 'packageName' | 'npxPackage' | 'entryFiles' | 'binary' | 'bins'>,
  platform?: NodeJS.Platform,
): boolean {
  const fold = platform === 'win32' ? (text: string) => text.toLowerCase() : (text: string) => text;
  /*
   * The product's stable launcher (design 2026-10-16, U6), in the data directory the entry itself pins: what every
   * managed install writes from 0.20.0. Its program is `<data>/launch/<name>`, nothing a package or a path below says.
   */
  const stable = registeredLauncher(server, platform);
  if (stable !== null) return fold(stable.name) === fold(unscoped(product.packageName));
  /*
   * The product's own command, by name or at the end of a path — `agent-slack`, `/usr/local/bin/agent-slack`,
   * `node_modules/.bin/agent-slack`, `agent-slack.cmd` on Windows. Missing it made a hand-written entry that
   * starts our own server "another Slack server with no approval step", with a fix that removed it.
   */
  const launched = fold((server.command.split(/[\\/]+/).at(-1) ?? '').replace(/\.(?:cmd|exe|bat|ps1)$/i, ''));
  if (launched && [product.binary, ...(product.bins ?? [])].map(fold).includes(launched)) return true;
  if (server.packageName) {
    const named = fold(server.packageName);
    return named === fold(product.packageName) || named === fold(product.npxPackage);
  }
  const short = unscoped(product.packageName);
  const entries: readonly (readonly string[])[] = [
    ['packages', short, 'src', 'cli.ts'],
    ['packages', short, 'dist', 'cli.mjs'],
    ['node_modules', ...product.packageName.split('/'), 'dist', 'cli.mjs'],
    ...(product.entryFiles ?? []),
  ];
  return [server.command, ...withoutPathOptions(server.args).words].some((part) => {
    const segments = part
      .split(/[\\/]+/)
      .filter(Boolean)
      .map(fold);
    return entries.some(
      (entry) =>
        segments.length >= entry.length &&
        entry.every((wanted, index) => segments[segments.length - entry.length + index] === fold(wanted)),
    );
  });
}

/**
 * The first file a registered entry starts that is no longer there, or null.
 *
 * The interpreter, when the entry names it by path, and the script it runs. A runtime deleted by hand, or a
 * Node removed by a version manager, leaves an entry that looks right and a client that says only "failed".
 */
export async function missingEntryFile(
  server: Pick<RegisteredServer, 'command' | 'args'>,
  platform?: NodeJS.Platform,
): Promise<string | null> {
  const wanted: { path: string; mode: number }[] = [];
  if (server.command && isAbsolute(server.command)) wanted.push({ path: server.command, mode: constants.X_OK });
  const script = server.args.find((argument) => isAbsolute(argument) && /\.(?:c|m)?[jt]s$/.test(argument));
  if (script) wanted.push({ path: script, mode: constants.R_OK });
  // The stable launcher, and what it starts: Node runs it on Windows, so it is read there and run elsewhere.
  const stable = registeredLauncher(server, platform);
  if (stable !== null && stable.launcher !== server.command)
    wanted.push({ path: stable.launcher, mode: constants.R_OK });
  for (const { path, mode } of wanted) {
    try {
      await access(path, mode);
    } catch {
      return path;
    }
  }
  return stable === null ? null : launcherRuntimeMissing(stable.dataDir, stable.name);
}

/**
 * The CLI a stable launcher would start that is not there, or null when it can start one: its pointer's runtime, or —
 * when that one is gone — the previous one it falls back to. A launcher with no pointer, or one that cannot be read,
 * starts nothing, and the pointer is what is missing.
 */
async function launcherRuntimeMissing(dataDir: string, name: string): Promise<string | null> {
  let pointer: LauncherPointer | undefined;
  try {
    pointer = await readPointer(dataDir, name);
  } catch {
    return launcherPaths(dataDir, name).pointer;
  }
  if (pointer === undefined) return launcherPaths(dataDir, name).pointer;
  if (await launcherCanStart(pointer.current, name)) return null;
  if (pointer.previous !== undefined && (await launcherCanStart(pointer.previous, name))) return null;
  return launcherCli(pointer.current, name);
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

/**
 * Installs one exact version into its own directory, so an upgrade elsewhere cannot change what clients run; a runtime
 * already there for exactly that version is reused. Exported for `agentcomms update`, which installs each runtime a
 * registration will need as a step of its own before it registers anything.
 */
export async function installManagedRuntime(
  context: InstallContext,
  product: McpProduct,
  version: string,
): Promise<string> {
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
  /*
   * npm is given the folder's real path. Given one reached through a symbolic link — macOS's /var, a linked home — it
   * writes its lockfile's keys relative to the real one (`../../…/node_modules/@agentcomms/gmail`), and the check that
   * the runtime holds the verified tarball, which reads `node_modules/<package>`, could not find it.
   */
  const prefix = await realpath(root);
  // No package's script runs as it installs: one would run as the person before anything has checked that what npm
  // installed is the tarball whose provenance was verified. Nothing this suite publishes, nor anything it depends on,
  // needs one (test/install-scripts.test.ts holds that).
  await run(context.env, process.execPath, [
    npmCli,
    'install',
    '--prefix',
    prefix,
    '--save-exact',
    '--ignore-scripts',
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
export async function findNpmCli(): Promise<string> {
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

/**
 * A command run to its end, in `env`: the environment the install resolved its target from — which client config,
 * which client CLI, which node — and not this process's, which may be another. On Windows it also tells the command
 * never to take a program from its current folder: `npm` and a client's command both start programs of their own by
 * name.
 */
function run(env: NodeJS.ProcessEnv, command: string, args: string[]): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'], env: childEnvironment(env) });
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

/**
 * The entry for one server, starting the command its preflight resolved (`resolved`): what the plan named and the
 * person approved. Nothing here looks on PATH again — a node or an npx that turned up since would be another command
 * than the one the preview said.
 */
async function buildEntry(
  context: InstallContext,
  product: McpProduct,
  options: InstallOptions,
  apply: boolean,
  resolved: Pick<InstallPreflight, 'node' | 'command'>,
): Promise<{ entry: ServerEntry; launcher: Launcher; runtimeMissing: boolean }> {
  const launcher = options.launcher ?? 'managed';
  const { node } = resolved;
  const env = minimalEnv(context, node);
  const pathArgs = registrationPathArgs(context);
  const serverArgs = product.serverArgs(options);

  if (launcher === 'npx') {
    return {
      entry: {
        command: resolved.command,
        args: [
          '-y',
          `${product.npxPackage}@${product.version}`,
          ...pathArgs,
          ...(product.npxArgs ?? []),
          ...serverArgs,
        ],
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
      entry: { command: node, args: [...flags, entryPath, ...pathArgs, 'mcp', ...serverArgs], env },
      launcher,
      runtimeMissing: false,
    };
  }
  /*
   * A managed entry starts the stable launcher (design 2026-10-16, U6), never a versioned runtime: an update switches
   * the launcher's pointer and leaves the entry, and every client's configuration, as it is.
   *
   * `--print` installs nothing. It used to run the whole `npm install` before looking at whether it was only
   * printing, so "show me what you would write" downloaded a package into the data directory and left it there.
   * The entry is the same either way, because it is computed rather than discovered; it starts something only when
   * the launcher is there and points at exactly this release's runtime.
   */
  const { dataDir } = context.core.paths;
  const entry = { ...managedEntryShape(context, product, node, [...pathArgs, 'mcp', ...serverArgs]), env };
  if (!apply) {
    const name = launcherName(product.packageName);
    const ready = await reusableRuntime(dataDir, product.packageName, product.version);
    const pointer = await readPointer(dataDir, name).catch(() => undefined);
    const pointed =
      ready !== null &&
      (await launcherExists(dataDir, name)) &&
      pointer?.current === managedRuntimeDir(dataDir, product.packageName, product.version);
    return { entry, launcher, runtimeMissing: !pointed };
  }
  // The launcher and its pointer are written by `mcpInstall` once nothing can refuse the install any more.
  await installManagedRuntime(context, product, product.version);
  return { entry, launcher, runtimeMissing: false };
}

/**
 * Points this product's stable launcher at the runtime of the release being installed — every registration of it on
 * this machine starts that from its next start — and writes the launcher afresh, with the Node the preview named.
 * Returns how to put the pointer back (`restorePointer`) if what comes after does not land.
 */
async function pointLauncher(
  context: InstallContext,
  product: Pick<McpProduct, 'packageName' | 'version'>,
  node: string,
): Promise<{ name: string; runtime: string; before: LauncherPointer | undefined }> {
  const { dataDir } = context.core.paths;
  const name = launcherName(product.packageName);
  const runtime = managedRuntimeDir(dataDir, product.packageName, product.version);
  await writeLauncher(dataDir, name, node, { platform: platformOf(context) });
  const before = await exchangePointer(dataDir, name, runtime);
  return { name, runtime, before };
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
  _platform: NodeJS.Platform | undefined,
): RegisteredServer[] {
  const taken = existing.filter(
    (server) => server.client === options.client && server.name === name && server.scope !== 'project',
  );
  const foreign = taken.find((server) => !isProductServer(server, product));
  if (foreign) {
    // Never the arguments or the env, and of a URL only where it points: any of them may hold somebody's token.
    const what =
      foreign.packageName ??
      (foreign.url ? displayUrl(foreign.url) : undefined) ??
      (foreign.command || 'something else');
    const other = name === product.binary ? `${product.binary}-${product.defaultServerName}` : product.binary;
    throw refusedWithRemedy(
      'CONFIG',
      `${options.client} already has an MCP server called "${name}", and it is not this one (it runs ${what})`,
      {
        binary: product.binary,
        words: installWords(product, options, other, []),
        say: (command) =>
          `Register this one under another name: ${command}. --force does not replace a server this did not install.`,
      },
    );
  }
  if (taken.length > 0 && !options.force) {
    /*
     * Asked for a server pinned to one account, where ours under the name serves another: replacing it would take that
     * one's server away. The way to reach both is a second entry under a name of its own (#47) — the command that
     * replaces this one, below, registered the other account again and left the one asked for reached by nothing.
     */
    for (const pin of PIN_OPTIONS) {
      const wanted = options[pin];
      const served = taken.map((server) => product.narrowingOf(server.args)[pin]).find(Boolean);
      if (!wanted || !served || served === wanted) continue;
      const second = `${product.defaultServerName}-${wanted.split('/')[0]}`;
      throw refusedWithRemedy('CONFIG', `${options.client} already has this server registered as "${name}"`, {
        binary: product.binary,
        words: installWords(product, options, second === name ? `${name}-2` : second, []),
        say: (command) =>
          `That entry serves ${served}; to serve ${wanted} as well, register a second entry under its own name: ${command}.`,
      });
    }
    /*
     * The command that replaces this entry as it is, read off the entry the way the doctors' repair reads it.
     * Built from the caller's flags alone, it told somebody who had left the pin out to run a command that dropped
     * it; the caller's own flags still win, and only what they left out comes from the entry.
     */
    const npx = taken.some((server) => server.args.some((argument) => argument.startsWith(`${product.npxPackage}@`)));
    const again = {
      ...keepNarrowing(product, options, taken).options,
      launcher: options.launcher ?? (npx ? ('npx' as const) : undefined),
    };
    throw refusedWithRemedy('CONFIG', `${options.client} already has this server registered as "${name}"`, {
      binary: product.binary,
      words: installWords(product, again, name, ['--force']),
      say: (command) => `Pass --force to replace it — that is how an upgrade reaches a client: ${command}.`,
    });
  }
  return taken;
}

/**
 * The options an install that replaces `previous` goes ahead with, and the flags it kept from them.
 *
 * The caller's own, plus the pin and `--read-only` of the entry being replaced wherever the caller left those
 * out. Never widened by omission: `mcp install --client claude-code --force` — the upgrade every document gives,
 * and what `setup --replace-server` runs — over an entry pinned to one mailbox and `--read-only` registered one
 * that reached every mailbox with every tool, and said nothing. A flag the caller gives wins. There is no flag
 * that widens; somebody who wants the wider server removes the old entry with the client's own command first,
 * which is a decision rather than a default.
 */
function keepNarrowing(
  product: McpProduct,
  options: InstallOptions,
  previous: readonly RegisteredServer[],
): { options: InstallOptions; kept: string[] } {
  const kept: Narrowing = {};
  for (const server of previous) {
    const narrowing = product.narrowingOf(server.args);
    for (const pin of PIN_OPTIONS) {
      const value = narrowing[pin];
      if (!options[pin] && !kept[pin] && value) kept[pin] = value;
    }
    if (!options.readOnly && narrowing.readOnly) kept.readOnly = true;
  }
  return { options: { ...options, ...kept }, kept: product.serverArgs({ client: options.client, ...kept }) };
}

/**
 * The `mcp install` that repeats this one under `name`, with every flag that decides what the server may reach: its
 * words after the program.
 *
 * The hints used to be `mcp install --client <c> --force` whatever had been asked. Refused for `--name slack-acme
 * --workspace acme/slack`, the hint registered a second server under the default name, pinned to nothing — every
 * workspace on the machine; for Gmail it dropped `--inbox` and `--read-only` the same way. Doctor's repair already
 * rebuilds these flags for exactly that reason. The product's `serverArgs` are the install command's own flags for
 * the pin and the narrowing, so they are repeated as they are.
 */
function installWords(product: McpProduct, options: InstallOptions, name: string, extra: string[]): string[] {
  const words = ['mcp', 'install', '--client', options.client];
  if (name !== product.defaultServerName) words.push('--name', name);
  words.push(...product.serverArgs(options));
  if (options.launcher && options.launcher !== 'managed') words.push('--launcher', options.launcher);
  words.push(...extra);
  return words;
}

/**
 * What a refusal of `mcp install` says to run instead: another `mcp install` of the same product. This module locates
 * no command — it may not import the locator (CUE-403) — so it says which product, the words after its program and the
 * sentence around the command, and the operation that called it puts the located command in (`installRemedyOf`,
 * read by `operations/servers.ts`). A pin kept from the entry being replaced was read from the client's file, which
 * may hold anything; the located command shows it as words to type where no Windows line is safe.
 */
export interface InstallRemedy {
  /** The product whose `mcp install` it is, by the command its manifest names. */
  readonly binary: string;
  /** Its words after the program: `mcp install --client …`. */
  readonly words: readonly string[];
  /** The sentence the command goes in. */
  readonly say: (command: string) => string;
}

const REMEDIES = new WeakMap<object, InstallRemedy>();

/** The remedy a refusal of `mcp install` carries, for the operation that called it to locate; undefined for any other. */
export function installRemedyOf(error: unknown): InstallRemedy | undefined {
  return typeof error === 'object' && error !== null ? REMEDIES.get(error) : undefined;
}

/**
 * A refusal whose remedy is another install: until the caller locates it, its hint says the words in prose — never a
 * command with a bare program.
 */
function refusedWithRemedy(
  code: ErrorCode,
  message: string,
  remedy: InstallRemedy,
  options: { cause?: unknown } = {},
): CommsError {
  const error = new CommsError(code, message, {
    hint: remedy.say(`its own \`mcp install\` with ${remedy.words.slice(2).join(' ')}`),
    ...(options.cause === undefined ? {} : { cause: options.cause }),
  });
  REMEDIES.set(error, remedy);
  return error;
}

/**
 * A command's exit status and what it printed, kept here and never shown: codex prints an entry's env. Started as
 * `run` starts one — in the environment the target was resolved from — so that on Windows it takes no program from its
 * current folder either.
 */
function capture(
  env: NodeJS.ProcessEnv,
  command: string,
  args: string[],
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], env: childEnvironment(env) });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolvePromise({ code, stdout, stderr }));
  });
}

/**
 * What codex itself has registered under this name: the entry, or null when it has none.
 *
 * Asked of codex rather than read from a file, because codex is what `codex mcp add` overwrites — silently, env
 * and all — and its config can be somewhere or in a shape no scan of `~/.codex/config.toml` finds. Both happened:
 * a `CODEX_HOME` set elsewhere and an inline `[mcp_servers]` table each hid somebody's Slack server, and the
 * install replaced it, bot token included, without `--force` and without a copy. An answer that cannot be read,
 * or a failure that is not "no such server", stops the install: not knowing is not the same as nothing there.
 * Nothing codex prints is repeated, because its answer carries the entry's env.
 */
async function codexRegistration(
  env: NodeJS.ProcessEnv,
  cliPath: string,
  name: string,
  path: string,
  platform: NodeJS.Platform | undefined,
): Promise<RegisteredServer | null> {
  const unknown = () =>
    new CommsError('CONFIG', `codex would not say what it has registered as "${name}", so nothing was written`, {
      hint: `Look with ${clientCommandHint(['codex', 'mcp', 'get', name], platform, `codex's own \`mcp get\`, for the entry called "${name}"`)}. If it is not an older copy of this server, choose another --name; \`--print\` shows the entry to add by hand.`,
    });
  let answer: Awaited<ReturnType<typeof capture>>;
  try {
    answer = await capture(env, cliPath, ['mcp', 'get', name, '--json']);
  } catch (error) {
    /*
     * Codex did not run at all, which is a different fact from codex not saying, and the one a person can act on.
     * On Windows it is the usual case: codex is a `.cmd` script, which cannot be started without a shell.
     */
    const code = (error as NodeJS.ErrnoException).code ?? 'an error';
    throw new CommsError('CONFIG', `codex could not be started (${code}), so nothing was written`, {
      hint: `Check that \`codex --version\` runs from this shell. \`--print\` shows the entry, to add with \`codex mcp add\` yourself.`,
    });
  }
  if (answer.code !== 0) {
    if (/no mcp server named/i.test(`${answer.stderr}\n${answer.stdout}`)) return null;
    throw unknown();
  }
  try {
    return codexServerFromGet(name, answer.stdout, path);
  } catch {
    throw unknown();
  }
}

/**
 * Where the installer records each managed runtime it registered or handed out, and the config it went into.
 *
 * `--client json`, `--print`, and a client whose own CLI was not on PATH all end with an entry a person puts
 * wherever they keep one, and nothing reads that place back. `mcp prune` keeps every runtime handed out that way,
 * so a pasted entry is not left pointing at a directory that has been deleted. It also reads every config
 * recorded here, written or not, beside the ones its own environment names: see `HandedOut.config`.
 */
export function handedOutRuntimesPath(dataDir: string): string {
  return join(dataDir, 'mcp-handed-out.jsonl');
}

interface HandedOut {
  at: string;
  client: string;
  name: string;
  runtime: string;
  /**
   * The client config the entry was written to or belongs in, as this install resolved it: under
   * `CLAUDE_CONFIG_DIR` or `CODEX_HOME` when those were set. Absent for `--client json`, which names none, and
   * in every record made before this was.
   *
   * Prune reads only the configs its own environment names. A second Claude account chosen per shell keeps its
   * servers in a `.claude.json` a prune run from any other shell never opened, so it found nothing there and
   * deleted a runtime that account still started — one this installer had registered itself.
   */
  config?: string | undefined;
  /**
   * Written into that config, rather than printed. An applied entry is in a file prune can read, so it keeps its
   * runtime only while that file still names it; a printed one is kept for as long as the record says.
   */
  applied?: boolean | undefined;
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
 * Where an install with these options goes: the client's own CLI and the file it keeps its servers in, and whether
 * anything will be written there at all — `--print`, `--client json` and a client whose CLI cannot be found all end
 * with an entry printed rather than registered. The CLI is looked for on PATH and then where it is usually installed:
 * see `findClientCli`.
 *
 * Exported because a registration is a change a person approves, and what they are shown has to be what then
 * happens. The core server plans an install with this before asking, and the install itself decides with it, so the
 * preview cannot say "registers" for an install that only prints, or say nothing for one that writes.
 */
export async function installTarget(
  context: InstallContext,
  options: Pick<InstallOptions, 'client' | 'apply'>,
): Promise<{
  cliName: 'claude' | 'codex' | null;
  cliPath: string | null;
  own: string | undefined;
  configPath: string | undefined;
  writes: boolean;
}> {
  const apply = options.apply ?? true;
  const cliName = options.client === 'claude-code' ? 'claude' : options.client === 'codex' ? 'codex' : null;
  const cliPath = cliName ? await findClientCli(cliName, context.env) : null;
  // The file this client keeps its servers in, as this environment resolves it — for Claude Code and codex, the
  // one their own CLI writes. `--client json` has none.
  const own = knownClientConfigs(context.env).find((file) => file.client === options.client)?.path;
  const configPath = options.client === 'claude-code' ? undefined : own;
  const writes = apply && (cliName ? cliPath !== null : configPath !== undefined);
  return { cliName, cliPath, own, configPath, writes };
}

/**
 * What a server may be called: 1 to 64 letters, digits, dots, underscores and hyphens.
 *
 * The name goes into the preview a person approves — `registers the Gmail MCP server with cursor as "gmail"` — and
 * into a client's config. Unchecked, it was text the caller chose inside a sentence the person trusts: a name of
 * `gmail", pinned to the mailbox work, read-only, "` made the preview say the server was pinned and read-only while
 * the entry written was neither, and a name of a few hundred characters pushed the rest of the preview past where it
 * is cut off. Every client accepts this much, and it is enough for any name worth choosing.
 */
export const SERVER_NAME_PATTERN: RegExp = /^[A-Za-z0-9_.-]{1,64}$/;

export const SERVER_NAME_MESSAGE = 'a server name is 1 to 64 letters, digits, dots, underscores or hyphens';

/** Refuses a server name outside `SERVER_NAME_PATTERN`, without repeating it: it may be built to mislead. */
export function checkServerName(name: string): void {
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new CommsError('USAGE', SERVER_NAME_MESSAGE, {
      hint: 'Choose a name like `gmail-work` or `slack_acme`. It is what the client shows, and it is in the preview a person approves.',
    });
  }
}

/** What an install found before it wrote anything: see `preflightInstall`. */
export interface InstallPreflight {
  scan: Awaited<ReturnType<typeof scanRegisteredServers>>;
  target: Awaited<ReturnType<typeof installTarget>>;
  /** This product's own entries under the name, which the install replaces. Empty when it adds. */
  previous: RegisteredServer[];
  /** The options the install goes ahead with: the caller's, plus what the entry it replaces narrowed. */
  effective: InstallOptions;
  /** The server flags kept from that entry, as `serverArgs` writes them. */
  kept: string[];
  /**
   * The node the entry runs under — the one on this environment's PATH, or this process's — whose folder its own PATH
   * starts with. Resolved here, once: the plan names it, and the install writes exactly it.
   */
  node: string;
  /** What the entry starts: that node, or for the npx launcher the npx on this environment's PATH. */
  command: string;
}

/**
 * Everything an install checks before it writes, and what it would then do — writing nothing.
 *
 * An unreadable client config, a name held by somebody else's server, and a name this product already holds without
 * `--force` are each refused here. The install itself runs this first; the core server also runs it while planning a
 * registration, so a registration that is going to be refused is refused before a person is asked to approve it,
 * and what they are shown — replacing an entry, keeping its pin — is what the install then does.
 */
export async function preflightInstall(
  context: InstallContext,
  product: McpProduct,
  options: InstallOptions,
): Promise<InstallPreflight> {
  const name = options.name ?? product.defaultServerName;
  // The last line of defence: every install, printed or written, from any caller, comes through here first.
  checkServerName(name);
  const scan = await scanRegisteredServers(context.env);
  const existing = scan.servers;
  const target = await installTarget(context, options);
  const { cliPath, own, configPath, writes } = target;

  // Before anything is installed or written: a refusal should cost nothing.
  if (writes) {
    // The client's own file, when it is there and unreadable: nothing in it can be checked, so nothing in it may
    // be replaced. A project's `.mcp.json` elsewhere is not what a user-scope write would touch.
    const blind = scan.unreadable.find((file) => file.path === own);
    if (blind) {
      throw new CommsError(
        'CONFIG',
        `${blind.path} could not be read (${blind.reason}), so what is already registered there cannot be checked; nothing was written`,
        { hint: 'Fix the file, or add the entry by hand: `--print` shows it without writing anything.' },
      );
    }
  }
  let previous = writes ? claimName(product, options, name, existing, context.platform) : [];
  if (writes && cliPath && options.client === 'codex') {
    const reported = await codexRegistration(context.env, cliPath, name, configPath ?? 'codex', context.platform);
    if (reported) previous = claimName(product, options, name, [reported], context.platform);
  }
  const { options: effective, kept } = keepNarrowing(product, options, previous);
  const launcher = options.launcher ?? 'managed';
  /*
   * After the client's own CLI is looked for, so that look stays the first this makes of PATH. A managed entry starts
   * the stable launcher, which runs this Node as the locator names it — as PATH spells it, a link left a link (CUE-492)
   * — so that the shim beside it, which starts the same launcher, runs the same Node the person's command would.
   */
  const node = launcher === 'managed' ? nodeProgram(context.env, platformOf(context)) : await resolveNode(context.env);
  const command =
    launcher === 'npx'
      ? await resolveNpx(context.env, node)
      : launcher === 'managed'
        ? managedEntryShape(context, product, node, []).command
        : node;
  return { scan, target, previous, effective, kept, node, command };
}

function platformOf(context: Pick<InstallContext, 'platform'>): NodeJS.Platform {
  return context.platform ?? process.platform;
}

/** A product's stable launcher in this installation's data directory: `<data>/launch/<name>`. */
export function productLauncher(dataDir: string, product: Pick<McpProduct, 'packageName'>): string {
  return launcherPaths(dataDir, launcherName(product.packageName)).launcher;
}

/**
 * A managed entry: the stable launcher with `words`. On POSIX it is the program; on Windows Node is, with the launcher
 * as its first word, since a client starts no script there without a shell (see `launcher.ts`).
 */
function managedEntryShape(
  context: InstallContext,
  product: Pick<McpProduct, 'packageName'>,
  node: string,
  words: readonly string[],
): { command: string; args: string[] } {
  const launcher = productLauncher(context.core.paths.dataDir, product);
  return platformOf(context) === 'win32'
    ? { command: node, args: [launcher, ...words] }
    : { command: launcher, args: [...words] };
}

/**
 * The `npx` an npx entry starts, as a full path: from PATH, or beside the `node` found, where npm installs it.
 *
 * Never the bare name. An entry that says only `npx` is resolved by the client, later, in its own environment — its
 * PATH, and on Windows its current folder — so the approval would bind a word, and the program run would be whichever
 * the client found. With no `npx` either way, nothing is written.
 */
async function resolveNpx(env: NodeJS.ProcessEnv, node: string): Promise<string> {
  const found = (await whichExecutable('npx', env)) ?? (await executableIn('npx', [dirname(node)], env));
  if (found !== null) return found;
  throw new CommsError('CONFIG', 'npx could not be found, on PATH or beside node, so nothing was written', {
    hint: 'Install Node.js with npm, which brings npx, or register with the managed launcher — the default — which needs no npx.',
  });
}

/**
 * Where an install puts the entry and what the entry starts, as one sentence of the preview a person approves: the
 * client's own config file and the command, each with the home written `~`. In the approval's digest with the rest, so
 * a claim from an environment that resolves another file or another command — `CLAUDE_CONFIG_DIR` set to another
 * account's, a PATH that finds another node — is another change, and refused.
 */
export function entryDestination(
  client: string,
  target: Pick<InstallPreflight['target'], 'own' | 'configPath'>,
  command: string,
  env: NodeJS.ProcessEnv,
): string {
  const home = homeDirectory(env);
  const file = target.own ?? target.configPath;
  const where = file === undefined ? `${client}'s own configuration` : shortenHome(file, home);
  return `the entry goes in ${where}, and ${client} will start it with ${shortenHome(command, home)}`;
}

/**
 * What a preflight found an install would do — everything that decides it — carried from the plan a person was shown
 * into the install itself.
 *
 * A registration is planned, agreed to (or found to need nobody's agreement), and applied a moment later, and the
 * machine can move in between: a client's CLI turns up on PATH, and an install planned to print — which asks nobody —
 * would register; an entry the plan replaced, keeping its pin, is removed by somebody else, and the install would
 * register the server unpinned under an approval that said it was pinned. So the install is handed what was planned,
 * checks that its own preflight arrives at exactly that, and refuses when it does not: see `mcpInstall`.
 */
export interface PlannedInstall {
  /** Whether it registers the server, or only prints the entry. */
  readonly writes: boolean;
  /** Where it goes: the client's CLI it registers through, by path, and the client's own file. */
  readonly cliName: 'claude' | 'codex' | null;
  readonly cliPath: string | null;
  readonly configPath: string | null;
  readonly own: string | null;
  /** This product's own entries under the name that it replaces, each whole. Empty when it adds. */
  readonly replaces: readonly string[];
  /** The pin and `--read-only` the server is started with: the caller's, and what it keeps from what it replaces. */
  readonly narrowing: Required<Pick<Narrowing, 'readOnly'>> & Record<'account' | 'inbox' | 'workspace', string | null>;
  /** The node the entry runs under, and what it starts: see `InstallPreflight`. */
  readonly node: string;
  readonly command: string;
}

/** The plan a preflight arrived at, in the form `mcpInstall` compares: see `PlannedInstall`. */
export function plannedInstall(preflight: InstallPreflight): PlannedInstall {
  const { target, previous, effective, node, command } = preflight;
  return {
    writes: target.writes,
    cliName: target.cliName,
    cliPath: target.cliPath,
    configPath: target.configPath ?? null,
    own: target.own ?? null,
    // Whole, env included: an entry swapped for another of ours under the same name is another entry to replace.
    replaces: previous
      .map((server) =>
        JSON.stringify([
          server.client,
          server.path,
          server.scope ?? 'user',
          server.name,
          server.command,
          server.args,
          server.url ?? null,
          server.env ?? null,
        ]),
      )
      .sort(),
    narrowing: {
      account: effective.account ?? null,
      inbox: effective.inbox ?? null,
      workspace: effective.workspace ?? null,
      readOnly: effective.readOnly === true,
    },
    node,
    command,
  };
}

/**
 * How what an install would do now differs from what was planned, one clause each; empty when it does not.
 *
 * Never an entry's arguments or env, which can hold somebody's token: only which part of the plan moved.
 */
function planDrift(
  product: McpProduct,
  client: SupportedClient,
  name: string,
  planned: PlannedInstall,
  now: PlannedInstall,
): string[] {
  const drift: string[] = [];
  const cli = now.cliName ?? planned.cliName;
  if (planned.writes !== now.writes) {
    if (cli !== null) {
      drift.push(
        now.writes
          ? `${cli} was not on PATH when this was planned, and is now, so it would register the server rather than print its entry`
          : `${cli} was on PATH when this was planned, and is not now, so it would only print the entry`,
      );
    } else {
      drift.push(now.writes ? 'it would write the entry rather than print it' : 'it would only print the entry');
    }
  } else if (planned.cliPath !== now.cliPath) {
    drift.push(`it would register through another ${cli ?? 'client CLI'} than the one planned: ${now.cliPath}`);
  }
  if (planned.configPath !== now.configPath || planned.own !== now.own) {
    drift.push(
      `${client}'s config is now ${now.own ?? now.configPath ?? 'nowhere'}, not ${planned.own ?? planned.configPath ?? 'nowhere'}`,
    );
  }
  if (JSON.stringify(planned.replaces) !== JSON.stringify(now.replaces)) {
    drift.push(`what is registered as "${name}" is not what it was planned to replace`);
  }
  if (JSON.stringify(planned.narrowing) !== JSON.stringify(now.narrowing)) {
    const flags = (narrowing: PlannedInstall['narrowing']) =>
      product.serverArgs({ client, ...pinsOf(narrowing) }).join(' ') || 'no pin';
    drift.push(`the server would start with ${flags(now.narrowing)}, not ${flags(planned.narrowing)}`);
  }
  if (planned.command !== now.command) {
    drift.push(`it would start the server with ${now.command}, not ${planned.command}`);
  } else if (planned.node !== now.node) {
    drift.push(`it would run under the node at ${now.node}, not ${planned.node}`);
  }
  return drift;
}

/** The planned pin and `--read-only`, as the options that start the server: each one given, none left to be found. */
function pinsOf(narrowing: PlannedInstall['narrowing']): Narrowing {
  return {
    account: narrowing.account ?? undefined,
    inbox: narrowing.inbox ?? undefined,
    workspace: narrowing.workspace ?? undefined,
    readOnly: narrowing.readOnly,
  };
}

/**
 * Writes (or prints) the entry for one client, then starts the server through exactly that entry and completes an
 * `initialize` and `tools/list`. An entry that looks right but does not start is the failure people actually hit.
 *
 * `planned` is what a plan shown to a person — or one that asked nobody — said this install does: see
 * `PlannedInstall`. When it is given, the install's own preflight has to arrive at exactly that, or it is refused with
 * nothing written; and the server is started with the pins the plan named, given outright, as `agentcomms update`
 * gives them.
 */
export async function mcpInstall(
  context: InstallContext,
  product: McpProduct,
  options: InstallOptions,
  planned?: PlannedInstall,
): Promise<InstallResult> {
  const name = options.name ?? product.defaultServerName;
  const apply = options.apply ?? true;

  const preflight = await preflightInstall(context, product, options);
  if (planned !== undefined) {
    const drift = planDrift(product, options.client, name, planned, plannedInstall(preflight));
    if (drift.length > 0) {
      throw new CommsError(
        'CONFIG',
        `this registration changed between being planned and being applied: ${drift.join('; ')}. So nothing was written`,
        {
          hint: 'Run the same install again: it is planned afresh from what is there now, and asks again for anything that needs agreeing to.',
        },
      );
    }
  }
  const { scan, target, previous, kept } = preflight;
  const effective =
    planned === undefined ? preflight.effective : { ...preflight.effective, ...pinsOf(planned.narrowing) };
  const existing = scan.servers;
  const { cliName, cliPath, own, configPath, writes } = target;
  // The client being installed, only. Every other client's findings were being reported here too, with removal
  // advice that said "the file above" and meant a different file.
  const warnings = (
    product.warnAbout?.(
      existing.filter((server) => server.client === options.client),
      context.platform,
    ) ?? []
  ).filter(Boolean);

  // What the entry being replaced narrowed, kept wherever this install left it out, and said.
  if (kept.length > 0) {
    const byHand = `delete "${name}" from ${configPath}`;
    const removal =
      options.client === 'claude-code'
        ? clientCommandHint(['claude', 'mcp', 'remove', name, '--scope', 'user'], context.platform, byHand)
        : options.client === 'codex'
          ? clientCommandHint(['codex', 'mcp', 'remove', name], context.platform, byHand)
          : byHand;
    warnings.push(
      `Kept ${kept.join(' ')} from the "${name}" entry this replaced, because this install did not say otherwise. To register it wider on purpose, remove that entry first (${removal}), then install without them.`,
    );
  }
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

  // The command the preflight resolved — and, when a plan was given, the one it named: the drift check above held them
  // to each other.
  const { entry, launcher, runtimeMissing } = await buildEntry(context, product, effective, apply, preflight);
  const snippet = snippetFor(options.client, name, entry);
  const backupPath =
    previous.length > 0 ? await backUp(context, options.client, name, previous, new Date()) : undefined;

  /*
   * Every managed entry is recorded with the config it goes into, for `mcp prune`: see `HandedOut.config`. One
   * about to be written is recorded first, so a record that cannot be made stops the install with the client's
   * config untouched; a record whose write then fails only points prune at a file that does not name it.
   */
  const ledger = handedOutRuntimesPath(context.core.paths.dataDir);
  const record: HandedOut | undefined =
    launcher === 'managed'
      ? {
          at: new Date().toISOString(),
          client: options.client,
          name,
          runtime: managedRuntimeDir(context.core.paths.dataDir, product.packageName, product.version),
          ...(own ? { config: own } : {}),
        }
      : undefined;
  if (record && writes) {
    try {
      await appendPrivateLine(ledger, JSON.stringify({ ...record, applied: true }));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'an error';
      throw new CommsError(
        'CONFIG',
        `${ledger} could not be written (${code}), so \`mcp prune\` would not know where this entry went; nothing was registered`,
        { hint: 'Run this where the data directory can be written, or add the entry by hand: `--print` shows it.' },
      );
    }
  }

  let method: InstallResult['method'] = 'printed';
  let applied = false;
  let notApplied: string | undefined;

  /*
   * A managed entry starts the stable launcher, so from here on that launcher points at this release's runtime — for
   * every registration of the product on this machine, which is what an install of a release means. If the entry does
   * not land, or lands and does not start, the pointer goes back to what it was: an install that failed leaves the
   * other clients starting what they started before.
   */
  const pointed = launcher === 'managed' && apply ? await pointLauncher(context, product, preflight.node) : null;
  const unpoint = async (): Promise<boolean> =>
    pointed !== null &&
    (await restorePointer(context.core.paths.dataDir, pointed.name, pointed.before, pointed.runtime).catch(
      () => false,
    ));

  try {
    if (cliName && cliPath && writes) {
      const codexEnv = (values: Record<string, string> | undefined) =>
        Object.entries(values ?? {}).flatMap(([key, value]) => ['--env', `${key}=${value}`]);
      const args =
        options.client === 'claude-code'
          ? ['mcp', 'add-json', name, JSON.stringify(entry), '--scope', 'user']
          : ['mcp', 'add', name, ...codexEnv(entry.env), '--', entry.command, ...entry.args];

      /*
       * Replacing an entry is `--force`: remove, then add. A managed entry starts the stable launcher, whose pointer
       * an update switches without coming here; an entry from before it named an exact runtime, and is moved to the
       * launcher this way once. `claimName` has already refused unless the entry is ours and `--force` was given, so a
       * removal here only ever removes this product's own older entry.
       */
      const replacing = previous.find((server) => server.client === options.client);
      if (replacing) {
        const removal =
          options.client === 'claude-code' ? ['mcp', 'remove', name, '--scope', 'user'] : ['mcp', 'remove', name];
        try {
          await run(context.env, cliPath, removal);
        } catch (error) {
          // Nothing registered under that name is the state we wanted anyway. Anything else is a real failure and
          // must not be swallowed: proceeding would add beside an entry we failed to remove.
          const message = error instanceof CommsError ? error.message : String(error);
          if (!/no (mcp )?server|not found|does not exist/i.test(message)) throw error;
        }

        try {
          await run(context.env, cliPath, args);
        } catch (error) {
          // What was there goes back if the replacement does not land. Otherwise `--force` removes a working entry
          // and leaves the client with no server at all — strictly worse than the stale one it was asked to replace.
          const restore =
            options.client === 'claude-code'
              ? [
                  'mcp',
                  'add-json',
                  name,
                  // The env too: an entry restored without its own launch environment may not find the same
                  // interpreter or, on Linux, the same system keychain session.
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
            await run(context.env, cliPath, restore);
          } catch {
            restored = false;
          }
          if (restored) {
            throw new CommsError('CONFIG', `could not register "${name}"; the previous entry was put back`, {
              hint: 'Check the client is not running, then try again.',
              cause: error,
            });
          }
          throw refusedWithRemedy(
            'CONFIG',
            `could not register "${name}", and the previous entry could not be put back either — ${cliName} now has no server called "${name}"`,
            {
              binary: product.binary,
              words: installWords(product, effective, name, []),
              say: (command) => `Re-register it with ${command}. The old entry is in ${backupPath}.`,
            },
            { cause: error },
          );
        }
      } else {
        try {
          await run(context.env, cliPath, args);
        } catch (error) {
          const message = error instanceof CommsError ? error.message : String(error);
          if (/already exists/i.test(message)) {
            // Registered somewhere this could not read, so there is no telling whose it is — and so no removing it.
            throw new CommsError(
              'CONFIG',
              `${cliName} already has an MCP server called "${name}", somewhere this could not read`,
              {
                hint: `Look at it with ${clientCommandHint([cliName, 'mcp', 'get', name], context.platform, `${cliName}'s own \`mcp get\`, for the entry called "${name}"`)}. If it is an older copy of this server, remove it with ${clientCommandHint([cliName, 'mcp', 'remove', name], context.platform, `${cliName}'s own \`mcp remove\``)} and run this again; if not, choose another --name.`,
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
      notApplied = `${cliName} was not found ${clientCliSearch(context.env)}, so nothing was registered`;
    } else if (configPath && writes) {
      await mergeIntoJsonConfig(configPath, options.client, name, entry);
      method = 'file';
      applied = true;
    }
  } catch (error) {
    await unpoint();
    throw error;
  }

  if (record && !applied) {
    /*
     * Printed rather than written, so where it ends up is out of sight: remember the runtime it names for `prune`.
     *
     * Only as far as that can be done, though. `--print` is where every refusal sends somebody, including an agent
     * in a sandbox whose writable roots leave out the data directory, and there the record failed with a bare
     * EACCES and took the entry with it. The entry is what was asked for; the record is a courtesy to `prune`.
     */
    try {
      await appendPrivateLine(ledger, JSON.stringify(record));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? 'an error';
      warnings.push(
        `This entry could not be recorded in ${ledger} (${code}), so \`mcp prune\` will not know about it and may remove ${record.runtime} while the entry still names it. Check \`mcp prune --dry-run\` before pruning.`,
      );
    }
  }

  let verified = false;
  let verification: InstallResult['verification'] = 'skipped';
  let verifyDetail: string | undefined;
  if (!options.noVerify) {
    if (runtimeMissing) {
      verifyDetail =
        "the stable launcher does not start this release's managed runtime yet, and --print installs nothing";
    } else {
      const check = await verifyEntry(entry, product);
      verified = check.ok;
      verification = check.ok ? 'passed' : 'failed';
      verifyDetail = check.detail;
      if (!check.ok && pointed !== null && (await unpoint())) {
        verifyDetail =
          pointed.before === undefined
            ? `${check.detail}; so the stable launcher's pointer was taken away again, as there was none before this install`
            : `${check.detail}; so the stable launcher was pointed back at ${pointed.before.current}, which it starts until this is fixed`;
      }
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
    verification,
    verifyDetail,
    warnings,
  };
}

/**
 * The exit status an install ends with, the same in both CLIs: non-zero when nothing was registered although that
 * was asked for, and when the entry was started and did not work.
 *
 * A registration that does not start is the failure people actually hit, and it used to end with 0 — after
 * `--force` had already removed the working entry it replaced.
 */
export function installExitStatus(result: Pick<InstallResult, 'notApplied' | 'verification'>): number {
  return result.notApplied || result.verification === 'failed' ? EXIT_CODES.UNAVAILABLE : EXIT_CODES.OK;
}

/**
 * The same verdict for a surface that has no exit status to end with — the core server's `comms_server_install`: the
 * error an install is wherever `installExitStatus` is not 0, and null wherever it is.
 *
 * Its code, `PROVIDER_UNAVAILABLE`, is the one that exits with `installExitStatus`'s status, so the tool and the
 * command say one thing. The whole result goes in its details, as the command prints it: the entry to add by hand is
 * `snippet`, and a `--print` of an entry that starts — or was not started — is no error at all.
 */
export function installFailure(result: InstallResult): CommsError | null {
  if (installExitStatus(result) === EXIT_CODES.OK) return null;
  const details = { ...result } as unknown as Record<string, unknown>;
  const where = result.configPath ?? `the MCP configuration of ${result.client}`;
  if (result.notApplied) {
    return new CommsError(
      'PROVIDER_UNAVAILABLE',
      `registering "${result.name}" with ${result.client}: ${result.notApplied}`,
      {
        hint: `The entry is in details.snippet: add it to ${where} by hand, or put the client's own command where the message says this looked, and ask again. Nothing was registered, so restarting ${result.client} changes nothing.`,
        details,
      },
    );
  }
  const why = result.verifyDetail ?? 'no reason given';
  if (result.applied) {
    return new CommsError(
      'PROVIDER_UNAVAILABLE',
      `registered "${result.name}" with ${result.client}, but it did not start when it was tried: ${why}`,
      {
        hint: `Restarting ${result.client} will not load it until what stopped it is fixed.${result.backupPath ? ` The entry it replaced is in ${result.backupPath}, to put back by hand.` : ''}`,
        details,
      },
    );
  }
  return new CommsError(
    'PROVIDER_UNAVAILABLE',
    `the entry for "${result.name}" did not start when it was tried: ${why}`,
    {
      hint: 'Nothing was written. Fix what stopped it, and ask for the entry again.',
      details,
    },
  );
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
      // Comments are fine to VS Code and Gemini, and are what a rewrite through `JSON.stringify` would drop.
      throw new CommsError('CONFIG', `${path} is not plain JSON, so it was left alone rather than rewritten`, {
        hint: 'Add the entry by hand (`--print` shows it), or remove any comments and trailing commas and run this again.',
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
  // Through a link, with the mode it had, in a directory left as it was: the file is the client's, not ours.
  await replaceFileInPlace(path, `${JSON.stringify(current, null, 2)}\n`);
}

// ── Uninstall ───────────────────────────────────────────────────────────────────────────────────────────────

/** One entry an uninstall took out, or left: its name in the client's file, the file, and why it was left. */
export interface UninstalledEntry {
  name: string;
  path: string;
}

export interface KeptEntry extends UninstalledEntry {
  /** In words that never quote the file: why it is still there, and how to take it out. */
  reason: string;
}

export interface UninstallResult {
  client: SupportedClient;
  /** Each entry of the product taken out of the client's own configuration, user scope. */
  removed: UninstalledEntry[];
  /** Each entry of the product still there, with why: a project's own, or one that could not be taken out here. */
  kept: KeptEntry[];
  /** The client's configs that could not be read: what they register is not known, so nothing in them was touched. */
  unreadable: UnreadableConfig[];
  /** Where the removed entries were saved, owner-only, to put back by hand; absent when nothing was removed. */
  backupPath: string | undefined;
}

/**
 * Takes one product's server out of one client's own configuration (design 2026-10-26-owner-feedback-0320 §3.3): every
 * entry, at user scope, that starts this product (`isProductServer`) — whatever it is called — and nothing else.
 *
 * - **How:** Claude Code's and codex's entries with their own command (`claude mcp remove <name> --scope user`,
 *   `codex mcp remove <name>`), as an install adds them; every other client's file rewritten in place with those
 *   entries alone left out — read again just before, so an entry that changed since the scan is judged as it is now,
 *   and only a plain JSON file: one with comments is the client's, and a rewrite would drop them.
 * - **Left, and said:** a project's own entry (its `.mcp.json`, or Claude Code's per-project list), which belongs to
 *   that project; an entry whose client's command is not here, or failed; one in a file that is not plain JSON.
 * - **Kept, to put back:** what was removed is saved first, owner-only — an entry's env can hold a credential.
 *
 * Taking a server away is a tightening, so nobody is asked; the client sees it once it restarts. `--client json` is a
 * snippet printed, never registered, so there is nothing of it to take out.
 */
export async function mcpUninstall(
  context: InstallContext,
  product: Pick<McpProduct, 'packageName' | 'npxPackage' | 'entryFiles' | 'binary' | 'bins'>,
  client: SupportedClient,
  now: Date = new Date(),
): Promise<UninstallResult> {
  if (client === 'json') {
    throw new CommsError('USAGE', '--client json prints an entry and registers none, so there is nothing to remove', {
      hint: 'Name the client the entry was pasted into, or take it out of that file by hand.',
    });
  }
  const platform = platformOf(context);
  const scan = await scanRegisteredServers(context.env);
  const unreadable = scan.unreadable.filter((file) => file.client === client);
  const mine = scan.servers.filter((server) => server.client === client && isProductServer(server, product, platform));
  const kept: KeptEntry[] = [];
  const toRemove: RegisteredServer[] = [];
  for (const server of mine) {
    if (server.scope === 'project') {
      kept.push({
        name: server.name,
        path: server.path,
        reason: `a project's own entry, kept: take it out of ${server.path}, or with ${client} in that project`,
      });
    } else {
      toRemove.push(server);
    }
  }
  const backupPath = toRemove.length > 0 ? await backUpRemoved(context, client, toRemove, now) : undefined;
  const removed: UninstalledEntry[] = [];
  const target = await installTarget(context, { client });
  if (target.cliName !== null) {
    const words = (name: string) =>
      target.cliName === 'claude' ? ['mcp', 'remove', name, '--scope', 'user'] : ['mcp', 'remove', name];
    for (const server of toRemove) {
      const command = clientCommandHint(
        [target.cliName, ...words(server.name)],
        platform,
        `${target.cliName}'s own \`mcp remove\` for "${server.name}"`,
      );
      if (target.cliPath === null) {
        kept.push({
          name: server.name,
          path: server.path,
          reason: `${target.cliName} was not found ${clientCliSearch(context.env)}: remove it with ${command}`,
        });
        continue;
      }
      try {
        await run(context.env, target.cliPath, words(server.name));
        removed.push({ name: server.name, path: server.path });
      } catch (error) {
        const message = error instanceof CommsError ? error.message : String(error);
        // Gone already is what was asked for; anything else is said, never taken for done.
        if (/no (mcp )?server|not found|does not exist/i.test(message)) {
          removed.push({ name: server.name, path: server.path });
        } else {
          kept.push({ name: server.name, path: server.path, reason: `${command} did not remove it: ${message}` });
        }
      }
    }
  } else {
    const byFile = new Map<string, RegisteredServer[]>();
    for (const server of toRemove) byFile.set(server.path, [...(byFile.get(server.path) ?? []), server]);
    for (const [path, servers] of byFile) {
      const outcome = await removeFromJsonConfig(path, servers, product, platform);
      removed.push(...outcome.removed);
      kept.push(...outcome.kept);
    }
  }
  return { client, removed, kept, unreadable, backupPath };
}

/** Saves the entries an uninstall is about to take out, owner-only, and returns where. */
async function backUpRemoved(
  context: InstallContext,
  client: SupportedClient,
  entries: readonly RegisteredServer[],
  now: Date,
): Promise<string> {
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const path = join(context.core.paths.dataDir, 'mcp-backups', `${stamp}-${client}-uninstall.json`);
  // writeFileAtomic creates the file 0600 and the directory 0700: an entry's env can hold a credential.
  await writeFileAtomic(
    path,
    `${JSON.stringify({ client, removedAt: now.toISOString(), entries: entries.map((entry) => ({ ...entry })) }, null, 2)}\n`,
  );
  return path;
}

/**
 * Takes `servers` out of one client's JSON file, keeping everything else in it exactly as it was: each from the top
 * level's `mcpServers` or `servers`, where clients keep them, and only while the entry there still starts this
 * product. A file that is not plain JSON is left alone.
 */
async function removeFromJsonConfig(
  path: string,
  servers: readonly RegisteredServer[],
  product: Pick<McpProduct, 'packageName' | 'npxPackage' | 'entryFiles' | 'binary' | 'bins'>,
  platform: NodeJS.Platform,
): Promise<{ removed: UninstalledEntry[]; kept: KeptEntry[] }> {
  const keep = (reason: string) => ({
    removed: [],
    kept: servers.map((server) => ({ name: server.name, path, reason })),
  });
  let current: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new SyntaxError('not an object');
    current = parsed as Record<string, unknown>;
  } catch {
    // Comments are fine to VS Code and Gemini, and are what a rewrite through `JSON.stringify` would drop.
    return keep(`${path} is not plain JSON, so it was left as it was: remove the entry from it by hand`);
  }
  const removed: UninstalledEntry[] = [];
  const kept: KeptEntry[] = [];
  for (const server of servers) {
    const holder = ['mcpServers', 'servers']
      .map((key) => current[key])
      .find(
        (list): list is Record<string, unknown> =>
          typeof list === 'object' && list !== null && !Array.isArray(list) && Object.hasOwn(list, server.name),
      );
    const entry = holder?.[server.name] as { command?: unknown; args?: unknown } | undefined;
    const still =
      entry !== undefined &&
      isProductServer(
        {
          command: typeof entry.command === 'string' ? entry.command : '',
          args: Array.isArray(entry.args) ? entry.args.map(String) : [],
          packageName: commandLinePackage(
            typeof entry.command === 'string' ? entry.command : '',
            Array.isArray(entry.args) ? entry.args.map(String) : [],
          ),
        },
        product,
        platform,
      );
    if (holder === undefined || !still) {
      kept.push({
        name: server.name,
        path,
        reason: 'it is not where this takes entries from, or it changed since it was read: look at the file by hand',
      });
      continue;
    }
    delete holder[server.name];
    removed.push({ name: server.name, path });
  }
  // Through a link, with the mode it had, in a directory left as it was: the file is the client's, not ours.
  if (removed.length > 0) await replaceFileInPlace(path, `${JSON.stringify(current, null, 2)}\n`);
  return { removed, kept };
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
  /** Owned CLI shims removed with those runtimes, and foreign files deliberately kept. */
  shims: { removed: string[]; kept: string[] };
  /** Why nothing was removed at all, when something stopped the whole run. */
  refused?: string | undefined;
}

/** Where `ps` is looked for, in order: the system's own directories, never PATH. */
const PS_DIRECTORIES = ['/bin', '/usr/bin'] as const;

/**
 * Every running process's command line, or null when they cannot be listed.
 *
 * `ps` is started by its full path, `/bin/ps` or else `/usr/bin/ps`, never by its bare name: a name is looked up, and
 * a lookup can reach the folder this was started from — where a download may have saved a stranger's `ps`, which would
 * then run, and whose answer would decide what is deleted. With neither there, the processes cannot be listed.
 *
 * `directories` and `list` are for tests: where to look for `ps`, and what runs the one found.
 */
export async function runningCommandLines(
  options: {
    directories?: readonly string[] | undefined;
    list?: ((ps: string) => Promise<string[] | null>) | undefined;
  } = {},
): Promise<string[] | null> {
  // No `ps` on Windows, and a guess is not good enough for a decision to delete: null keeps everything.
  if (process.platform === 'win32') return null;
  const ps = await executableIn('ps', options.directories ?? PS_DIRECTORIES, process.env);
  if (ps === null) return null;
  return (options.list ?? commandLinesFrom)(ps);
}

/** What `ps` at this path says is running: one command line per process, or null when it fails. */
function commandLinesFrom(ps: string): Promise<string[] | null> {
  return new Promise((resolvePromise) => {
    execFile(ps, ['-A', '-o', 'args='], { maxBuffer: 32 * 1024 * 1024 }, (error, stdout) => {
      resolvePromise(error ? null : stdout.split('\n').filter(Boolean));
    });
  });
}

const RUNTIME_NAME = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]*)?$/;

/** Whether a runtime's own manifest, the one the installer writes, names this package as what it installs. */
async function pinsPackage(runtime: string, packageName: string): Promise<boolean> {
  try {
    const manifest = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, unknown>;
    };
    return typeof manifest.dependencies?.[packageName] === 'string';
  } catch {
    return false;
  }
}

/**
 * This product's managed runtimes on disk, oldest name first: every directory directly inside `<data>/runtime`,
 * named like a version, that holds this product's package — never a symbolic link, never another product's runtime,
 * never anything else in that directory.
 *
 * One reading, shared by `pruneManagedRuntimes`, which deletes from it, and the core server's list of what is
 * installed, which only reports it. Two readings of one directory would be two answers to "is this installed", and
 * the one prune acted on need not be the one a person was shown.
 */
export async function listManagedRuntimes(
  dataDir: string,
  packageName: string,
): Promise<{ path: string; version: string }[]> {
  const runtimeDir = join(dataDir, 'runtime');
  let names: string[];
  try {
    names = await readdir(runtimeDir);
  } catch {
    return [];
  }
  const found: { path: string; version: string }[] = [];
  const suffix = `-${unscoped(packageName)}`;
  for (const name of names.sort()) {
    if (!RUNTIME_NAME.test(name)) continue;
    const path = join(runtimeDir, name);
    try {
      if (!(await lstat(path)).isDirectory()) continue;
      if (!(await lstat(join(path, 'node_modules', ...packageName.split('/')))).isDirectory()) continue;
    } catch {
      continue;
    }
    // Holding the package is not enough: another product's runtime carries it as a dependency, as the events service's
    // carries every channel. A runtime is this product's when its name says so, or, in the old Gmail layout with no
    // suffix, when the installer's own manifest pins this package.
    if (!name.endsWith(suffix) && !(await pinsPackage(path, packageName))) continue;
    found.push({ path, version: name.endsWith(suffix) ? name.slice(0, -suffix.length) : name });
  }
  return found;
}

/**
 * Removes this product's managed runtimes that no client config it can read names, that it never printed an
 * entry for, and that no process is running.
 *
 * Every upgrade installs a new `runtime/<version>-<name>` and leaves the old one where it was — a machine that had
 * been through six releases held five orphans at 4–5 MB each. Deleting a runtime a client still starts turns a
 * working server into one that fails with nothing in the client to say why, so everything that could mean "in
 * use" keeps it:
 *
 *  - only directories directly inside `<data>/runtime`, named like a version, that hold this product's package —
 *    never a symbolic link, never another product's runtime, never anything else in that directory;
 *  - never this release's own;
 *  - never one newer than this release, or than the runtime its stable launcher starts: what an update is installing,
 *    or checking before it switches, is newer than anything a pointer names yet. The update lock keeps a person's
 *    prune from running beside an update (`serverPruneChange`); this keeps that runtime even when no lock is held —
 *    an update interrupted half-way, a prune that is not a person's;
 *  - never one an entry names in a client config `scanRegisteredServers` reads, in any scope — the ones this
 *    environment names, and every one an install recorded registering into, wherever `CLAUDE_CONFIG_DIR` or
 *    `CODEX_HOME` pointed then. When one of those files is there and cannot be read, nothing is removed at all: a
 *    file skipped in silence looked exactly like one that registered nothing, and one comment in a VS Code
 *    `mcp.json` was enough to lose a runtime. A recorded file that is gone keeps nothing;
 *  - never one it handed out as an entry to paste (`--client json`, `--print`), which no scan can follow — unless
 *    `includePrinted` says those entries are gone, which only the person who pasted them can know. What that
 *    removes leaves the record with it. When the record cannot be read, nothing is removed;
 *  - never one a running process names. When the processes cannot be listed, nothing is removed at all.
 *
 * What it cannot see is an entry in a file it does not read — a workspace `.vscode/mcp.json`, a config a client
 * was pointed at on its command line — put there by hand, or pasted from a `--print` that warned its record could
 * not be written. The documents say so rather than promise more.
 *
 * `only`, when given, is the most it may remove: the runtimes a person approved removing, from a dry run shown to
 * them. Anything else it would have removed is kept, and says why. Removal is approved as a list of paths, and a
 * runtime that became unused after that list was shown is not on it.
 */
export async function pruneManagedRuntimes(
  context: InstallContext,
  product: Pick<McpProduct, 'packageName' | 'version'>,
  options: {
    dryRun?: boolean;
    includePrinted?: boolean;
    processes?: () => Promise<readonly string[] | null>;
    only?: readonly string[] | undefined;
  } = {},
): Promise<PruneResult> {
  const runtimeDir = join(context.core.paths.dataDir, 'runtime');
  const result: PruneResult = {
    runtimeDir,
    dryRun: options.dryRun === true,
    removed: [],
    kept: [],
    shims: { removed: [], kept: [] },
  };

  const candidates: { path: string; version: string; aliases: string[] }[] = [];
  for (const { path, version } of await listManagedRuntimes(context.core.paths.dataDir, product.packageName)) {
    const real = await realpath(path).catch(() => path);
    candidates.push({ path, version, aliases: [...new Set([path, real])] });
  }
  if (candidates.length === 0) return result;

  // Each of these stops the whole run the same way: what it could not see is what might have been in use.
  const refuse = (why: string) => {
    result.refused = why;
    result.kept = candidates.map(({ path, version }) => ({ path, version, reason: 'not checked' }));
    return result;
  };
  const processes = await (options.processes ?? runningCommandLines)();
  if (processes === null) {
    return refuse('the running processes on this machine could not be listed, so none of these can be shown unused');
  }
  const ledger = handedOutRuntimesPath(context.core.paths.dataDir);
  const handedOut = await readHandedOut(ledger);
  if (handedOut === null) {
    return refuse(`${ledger} could not be read, so none of these can be shown never to have been handed out`);
  }
  // Every config an install recorded, beside the ones this environment names: `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
  // are set per shell, and the shell running this need not be the one that registered anything.
  const recorded = handedOut.flatMap((record) =>
    record.config ? [{ client: record.client, path: record.config }] : [],
  );
  const scan = await scanRegisteredServers(context.env, process.platform, recorded);
  if (scan.unreadable.length > 0) {
    const files = scan.unreadable.map((file) => `${file.path} (${file.reason})`).join('; ');
    return refuse(`${files} could not be read, so none of these can be shown unregistered`);
  }
  const registered = scan.servers;
  const known = new Set(knownClientConfigs(context.env).map((file) => file.path));
  const mentions = (aliases: string[], text: string) =>
    aliases.some((alias) => text === alias || text.includes(`${alias}${sep}`) || text.includes(`${alias}/`));

  /*
   * What the stable launcher starts, and what it falls back to and a rollback goes back to: in use by every registration
   * that starts the launcher, though none of them names a runtime. A pointer that cannot be read keeps everything.
   */
  const name = launcherName(product.packageName);
  let pointer: LauncherPointer | undefined;
  try {
    pointer = await readPointer(context.core.paths.dataDir, name);
  } catch {
    const at = launcherPaths(context.core.paths.dataDir, name).pointer;
    return refuse(`${at} could not be read, so none of these can be shown not to be what the stable launcher starts`);
  }
  const pointed = (aliases: string[]): string | null => {
    const named = (runtime: string | undefined) =>
      runtime !== undefined && aliases.some((alias) => resolve(alias) === resolve(runtime));
    if (named(pointer?.current)) return 'the stable launcher starts it';
    if (named(pointer?.previous)) {
      return "the stable launcher's previous runtime: what it falls back to, and what a rollback goes back to";
    }
    return null;
  };

  const current = managedRuntimeDir(context.core.paths.dataDir, product.packageName, product.version);
  const starts = pointer === undefined ? null : launcherRuntimeVersion(pointer.current, name);
  /** Why a runtime newer than this release, or than what the launcher starts, stays; null for any other. */
  const newer = (version: string): string | null => {
    const installing = 'an update may be installing it, or checking it before it switches';
    if (compareVersions(version, product.version) === 1) {
      return `newer than this release, ${product.version}: ${installing}`;
    }
    if (starts !== null && compareVersions(version, starts) === 1) {
      return `newer than ${starts}, which the stable launcher starts: ${installing}`;
    }
    return null;
  };
  for (const { path, version, aliases } of candidates) {
    const owner = registered.find((server) => [server.command, ...server.args].some((part) => mentions(aliases, part)));
    // An applied record holds nothing by itself: its config is read above, and names the runtime or does not.
    const printed = options.includePrinted
      ? undefined
      : handedOut.find((record) => !record.applied && mentions(aliases, record.runtime));
    const reason =
      path === current
        ? 'this release'
        : (pointed(aliases) ??
          newer(version) ??
          (owner
            ? // Where, when it is not a file this shell would think of: otherwise the runtime looks kept for nothing.
              `registered with ${owner.client} as "${owner.name}"${known.has(owner.path) ? '' : ` in ${owner.path}`}`
            : printed
              ? `printed for ${printed.client} as "${printed.name}" on ${printed.at.slice(0, 10)}, and where that entry went cannot be read; once it is gone, \`mcp prune --include-printed\` removes this`
              : processes.some((line) => mentions(aliases, line))
                ? 'a running process uses it'
                : null));
    if (reason) {
      result.kept.push({ path, version, reason });
      continue;
    }
    if (options.only !== undefined && !options.only.includes(path)) {
      result.kept.push({ path, version, reason: 'not in the removal that was approved; prune again to include it' });
      continue;
    }
    // `rm` does not follow a link, so even a directory swapped for one since the scan loses only the link.
    if (!result.dryRun) await rm(path, { recursive: true });
    result.removed.push({ path, version });
  }
  /*
   * The record forgets what was just removed, and only that. Gmail and Slack share it, and a line for the other
   * product's runtime — or for one still kept here — is still somebody's pasted entry.
   */
  if (options.includePrinted && !result.dryRun && result.removed.length > 0) {
    const gone = result.removed.map((item) => item.path);
    const left = handedOut.filter((record) => !gone.some((path) => mentions([path], record.runtime)));
    if (left.length !== handedOut.length) {
      await writeFileAtomic(ledger, left.map((record) => `${JSON.stringify(record)}\n`).join(''));
    }
  }
  if (result.removed.length > 0) {
    result.shims = await removeManagedShimsForRuntimes(
      { env: context.env, dataDir: context.core.paths.dataDir, platform: context.platform },
      result.removed.map((item) => item.path),
      { dryRun: result.dryRun },
    );
  }
  return result;
}

/** Every runtime the installer handed out, or null when the record is there and cannot be read. */
async function readHandedOut(path: string): Promise<HandedOut[] | null> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? [] : null;
  }
  const records: HandedOut[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as Partial<HandedOut>;
      if (typeof record.runtime !== 'string') return null;
      records.push({
        at: String(record.at ?? ''),
        client: String(record.client ?? ''),
        name: String(record.name ?? ''),
        runtime: record.runtime,
        // Only when present, so a record rewritten after `--include-printed` is the line it was.
        ...(typeof record.config === 'string' ? { config: record.config } : {}),
        ...(record.applied === true ? { applied: true } : {}),
      });
    } catch {
      return null;
    }
  }
  return records;
}
