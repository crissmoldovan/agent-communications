import { access, constants, readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GatedChange } from '../change-flow.ts';
import { CHANNEL_LABELS, CHANNEL_SERVERS, CHANNELS, type Channel, isChannel } from '../channel-servers.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { type RegisteredServer, scanRegisteredServers, type UnreadableConfig } from '../mcp-clients.ts';
import {
  checkServerName,
  type InstallContext,
  type InstallOptions,
  type InstallResult,
  isProductServer,
  type Launcher,
  listManagedRuntimes,
  localCliEntry,
  type McpProduct,
  managedRuntimeDir,
  managedRuntimeVersion,
  mcpInstall,
  missingEntryFile,
  type PruneResult,
  pinnedVersion,
  preflightInstall,
  pruneManagedRuntimes,
  reusableRuntime,
  type SupportedClient,
  whichExecutable,
} from '../mcp-install.ts';
import { resolveName } from '../names.ts';
import { VERSION } from '../version.ts';

/**
 * Registering, pruning and listing the MCP servers of every channel, from the core.
 *
 * `agentcomms mcp install` registers the core server; `comms_server_install` registers any of the three; and
 * `agent-gmail mcp install` and `agent-slack mcp install` register their own. All four are the one change here, over
 * the shared installer (`mcp-install.ts`), and all go through the change flow: registering a server is a loosening in
 * the design's terms (§3.1) — it hands a client a new set of tools — and so is asked for once and applied on the
 * second call with the approval. Printing an entry registers nothing and asks nobody.
 *
 * One change rather than one per surface, because the approval is bound to what it says it does. An approval an agent
 * got from `comms_server_install` is claimed by `agent-gmail mcp install --approval <id>` for the same request, and the
 * other way round; two copies of the planning would be two wordings, and a person's yes to one would be refused by
 * the other — or worse, a channel's own command would register with no approval at all, which is what it did.
 *
 * The version installed is this core's own, or the calling channel's when it passes its product. The packages are
 * released together, at one version, so the core that is asked to install Gmail installs the Gmail of its own release.
 */

export const CLIENTS: readonly SupportedClient[] = Object.freeze([
  'claude-code',
  'claude-desktop',
  'codex',
  'cursor',
  'gemini',
  'vscode',
  'json',
]);

export const LAUNCHERS: readonly Launcher[] = Object.freeze(['managed', 'npx', 'local']);

/**
 * Where this core's own package is, found by walking up to its manifest.
 *
 * Read from the file rather than counted in `..`s, because the same code runs from `src/operations/servers.ts` in a
 * checkout and from a bundled chunk directly in `dist/` once published, and the two are a different number of
 * directories from the package root.
 */
async function corePackageRoot(): Promise<string> {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { name?: unknown };
      if (manifest.name === CHANNEL_SERVERS.core.packageName) return dir;
    } catch {
      // not the package root yet
    }
    dir = dirname(dir);
  }
  throw new CommsError('UNEXPECTED', 'cannot find the @agentcomms/core package this is running from');
}

const exists = (path: string) =>
  access(path, constants.R_OK).then(
    () => true,
    () => false,
  );

/**
 * A module URL inside a channel's package, for the `local` launcher, which registers a checkout's own code.
 *
 * The launcher resolves the CLI from the product's `moduleUrl`, and a channel's module is not reachable from core:
 * core depends on none of them. So the channel is looked for beside this core — `packages/gmail` next to
 * `packages/core` in a checkout — and from source when this core runs from source, as the channel CLIs do.
 */
async function localModuleUrl(channel: Channel): Promise<string> {
  const coreRoot = await corePackageRoot();
  const unscopedName = CHANNEL_SERVERS[channel].packageName.split('/').at(-1) ?? channel;
  const root = channel === 'core' ? coreRoot : join(dirname(coreRoot), unscopedName);
  const source = join(root, 'src', 'cli.ts');
  const built = join(root, 'dist', 'cli.mjs');
  const fromSource = fileURLToPath(import.meta.url).endsWith('.ts');
  for (const cli of fromSource ? [source, built] : [built, source]) {
    if (!(await exists(cli))) continue;
    // `localCliEntry` looks for `../cli.ts` from a module in a subdirectory of `src`, and `cli.mjs` beside one in
    // `dist`; only the directory of the URL is read.
    return pathToFileURL(cli === source ? join(root, 'src', 'mcp', 'module.ts') : join(root, 'dist', 'module.mjs'))
      .href;
  }
  throw new CommsError(
    'USAGE',
    `\`--launcher local\` registers a checkout's own code, and there is no ${CHANNEL_SERVERS[channel].packageName} beside this one`,
    { hint: `Looked in ${root}. Use the managed launcher, or run the install from that checkout.` },
  );
}

/** The product the shared installer registers, for one channel at this core's version. */
export async function channelProduct(channel: Channel, launcher: Launcher | undefined): Promise<McpProduct> {
  return {
    ...CHANNEL_SERVERS[channel],
    version: VERSION,
    // Only the `local` launcher reads `moduleUrl`, and only it needs a checkout beside this one; the others must not
    // be refused for the lack of one.
    moduleUrl: launcher === 'local' ? await localModuleUrl(channel) : '',
  };
}

/**
 * The calling channel's own product, checked to be that channel's.
 *
 * `agent-gmail mcp install` passes `GMAIL_MCP` and `agent-slack mcp install` passes `SLACK_MCP`, because each carries
 * what core cannot know: the version it is, and where its own code is for `--launcher local` — core depends on
 * neither package, and once a channel is bundled there is no checkout beside it to look in. It has to be that
 * channel's product. The preview says which server is
 * registered, from the channel; a product for another package would register something else under those words, and
 * the person would have approved a sentence that was not true.
 */
function ownProduct<P extends Pick<McpProduct, 'packageName'>>(channel: Channel, own: P | undefined): P | undefined {
  if (own !== undefined && own.packageName !== CHANNEL_SERVERS[channel].packageName) {
    throw new CommsError(
      'UNEXPECTED',
      `${own.packageName} is not the ${CHANNEL_LABELS[channel]} server's package, so it cannot register that server`,
    );
  }
  return own;
}

// ── Install ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerInstallRequest {
  channel: Channel;
  client: SupportedClient;
  name?: string | undefined;
  /** Gmail's pin: serve one mailbox. */
  inbox?: string | undefined;
  /** Slack's pin: serve one workspace. */
  workspace?: string | undefined;
  /** Gmail only: leave out every tool that changes a mailbox. */
  readOnly?: boolean | undefined;
  launcher?: Launcher | undefined;
  force?: boolean | undefined;
  /** Only print the entry: nothing is written, and nothing is asked. */
  print?: boolean | undefined;
  noVerify?: boolean | undefined;
}

export type ServerInstallResult = InstallResult & {
  /** What the person has to do before the server's tools appear, or null when nothing was registered. */
  restart: string | null;
};

/**
 * Refuses what the channel's own `mcp install` has no flag for, rather than ignoring it.
 *
 * `agent-slack mcp install --inbox work` is an unknown option, and a tool that quietly dropped `inbox` for Slack would
 * register a server reaching every workspace for a caller who believed they had pinned it.
 */
function checkRequest(request: ServerInstallRequest): void {
  if (!isChannel(request.channel)) {
    throw new CommsError('USAGE', `"${String(request.channel)}" is not a channel`, {
      hint: `One of: ${CHANNELS.join(', ')}.`,
    });
  }
  if (!CLIENTS.includes(request.client)) {
    throw new CommsError('USAGE', `"${String(request.client)}" is not a client this can register with`, {
      hint: `One of: ${CLIENTS.join(', ')}.`,
    });
  }
  if (request.launcher !== undefined && !LAUNCHERS.includes(request.launcher)) {
    throw new CommsError('USAGE', `"${String(request.launcher)}" is not a launcher`, {
      hint: `One of: ${LAUNCHERS.join(', ')}.`,
    });
  }
  // Where the name enters, for every surface — the tool and all three `mcp install` commands — before anything is
  // planned or asked: it is quoted in the preview, so a name that reads as a pin is a preview that lies.
  if (request.name !== undefined) checkServerName(request.name);
  const refuse = (what: string, only: Channel) => {
    throw new CommsError(
      'USAGE',
      `${what} is an option of the ${CHANNEL_LABELS[only]} server; the ${CHANNEL_LABELS[request.channel]} server has no such option`,
    );
  };
  if (request.inbox !== undefined && request.channel !== 'gmail') refuse('`inbox`', 'gmail');
  if (request.readOnly && request.channel !== 'gmail') refuse('`readOnly`', 'gmail');
  if (request.workspace !== undefined && request.channel !== 'slack') refuse('`workspace`', 'slack');
}

/**
 * The pin, resolved before anything is written, as each channel's own installer does.
 *
 * A server pinned to a mailbox or workspace that does not exist — or to one renamed since — starts, fails, and says so
 * only in a client's log. A former name is refused with the name it has now.
 */
function checkPin(config: Config, request: ServerInstallRequest): void {
  if (request.inbox !== undefined) resolveName(config, 'inbox', request.inbox);
  if (request.workspace !== undefined) {
    const { account } = resolveName(config, 'account', request.workspace);
    if (account.platform !== 'slack') {
      throw new CommsError('USAGE', `"${request.workspace}" is not a Slack workspace`);
    }
  }
}

function installOptions(request: ServerInstallRequest): InstallOptions {
  return {
    client: request.client,
    name: request.name,
    inbox: request.inbox,
    workspace: request.workspace,
    readOnly: request.readOnly,
    launcher: request.launcher,
    noVerify: request.noVerify,
    apply: request.print !== true,
    force: request.force,
  };
}

/**
 * Registering one channel's server with one client, as a change.
 *
 * The effects are what a person is agreeing to, one sentence each, and everything that decides what the server may
 * reach is in them — which server, which client, under which name, pinned to what, replacing what, started how. The
 * approval is bound to those sentences, so a second call that differs in any of them is a different change and is
 * refused. What `installTarget` says will only be printed has no effect and asks nobody; a managed runtime not yet on
 * this machine is fetched from npm, which is said too.
 *
 * `own` is the calling channel's product, from its own `mcp install`: see `ownProduct`. The sentences depend on the
 * request and the machine, not on which surface prepared them, so an approval prepared by one is claimed by the
 * other. The one sentence that names code — `--launcher local`, which starts a checkout — names the file that will be
 * started; a core running from another build of the checkout than the channel's command names another file, and that
 * is another registration, refused as one.
 */
export function serverInstallChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerInstallRequest,
  own?: McpProduct,
): GatedChange<ServerInstallResult> {
  checkRequest(request);
  ownProduct(request.channel, own);
  const context: InstallContext = { env, core };
  const facts = CHANNEL_SERVERS[request.channel];
  const label = CHANNEL_LABELS[request.channel];
  const name = request.name ?? facts.defaultServerName;
  const launcher = request.launcher ?? 'managed';
  const productNow = async (): Promise<McpProduct> => own ?? (await channelProduct(request.channel, request.launcher));
  return {
    plan: async (config) => {
      checkPin(config, request);
      const product = await productNow();
      const { version } = product;
      // Refuses here what the install would refuse, before anybody is asked; and says what a replacement keeps.
      const { target, previous, effective, kept } = await preflightInstall(context, product, installOptions(request));
      const effects: string[] = [];
      if (target.writes) {
        const pins = [
          effective.inbox !== undefined ? `pinned to the mailbox ${effective.inbox}` : '',
          effective.workspace !== undefined ? `pinned to the workspace ${effective.workspace}` : '',
          effective.readOnly ? 'read-only' : '',
        ].filter(Boolean);
        const replacing =
          previous.length > 0
            ? `, replacing its own earlier entry of that name${kept.length > 0 ? ` and keeping ${kept.join(' ')} from it` : ''}`
            : '';
        effects.push(
          `registers the ${label} MCP server with ${request.client} as "${name}"${pins.length > 0 ? `, ${pins.join(', ')}` : ''}${replacing}`,
        );
        /*
         * What it may reach, said when it is everything rather than left to be inferred from a pin not mentioned.
         * A preview that names only the narrowing a server has reads the same to a person skimming it whether that
         * narrowing is there or not; the widest registration is the one that most needs to say so.
         */
        const everyMailbox = request.channel === 'gmail' && effective.inbox === undefined;
        const everyTool = request.channel === 'gmail' && effective.readOnly !== true;
        if (everyMailbox) {
          effects.push(`not pinned: it reaches every mailbox on this machine${everyTool ? ', with every tool' : ''}`);
        } else if (everyTool) {
          effects.push(`not read-only: it has every tool for ${effective.inbox}, including those that change it`);
        }
        if (request.channel === 'slack' && effective.workspace === undefined) {
          effects.push('not pinned: it reaches every workspace on this machine');
        }
        if (launcher === 'npx') {
          effects.push(`${request.client} will fetch ${facts.npxPackage}@${version} from npm each time it starts it`);
        } else if (launcher === 'local') {
          effects.push(`${request.client} will start it from ${await localCliEntry(product.moduleUrl)}`);
        }
      }
      if (
        request.print !== true &&
        launcher === 'managed' &&
        (await reusableRuntime(core.paths.dataDir, facts.packageName, version)) === null
      ) {
        effects.push(
          `installs ${facts.packageName}@${version} from npm into ${managedRuntimeDir(core.paths.dataDir, facts.packageName, version)}`,
        );
      }
      return {
        before: config,
        after: config,
        effects,
        summary:
          effects.length > 0
            ? `Register the ${label} MCP server with ${request.client}`
            : `Print the ${label} MCP server's entry for ${request.client}`,
      };
    },
    apply: async () => {
      const result = await mcpInstall(context, await productNow(), installOptions(request));
      return {
        ...result,
        restart: result.applied
          ? `Restart ${request.client} to load "${result.name}": no MCP client loads a new server into a session that is already running.`
          : null,
      };
    },
  };
}

// ── Prune ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerPruneRequest {
  channel: Channel;
  dryRun?: boolean | undefined;
  includePrinted?: boolean | undefined;
  /** For a test: the command lines of the running processes, or null when they cannot be listed. */
  processes?: (() => Promise<readonly string[] | null>) | undefined;
}

/**
 * Removing a channel's unused managed runtimes, as a change.
 *
 * A dry run is free: it removes nothing. Otherwise the plan is that same dry run, and each runtime it would remove is
 * one effect — the removal cannot be taken back — so the approval is bound to exactly that list; and the removal is
 * then restricted to it (`only`), so a runtime that became unused after the list was shown stays.
 *
 * `own` is the calling channel's product, from its own `mcp prune`, so the runtime kept as "this release" is the
 * release of the command that was run; checked to be that channel's, as for an install.
 */
export function serverPruneChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerPruneRequest,
  own?: Pick<McpProduct, 'packageName' | 'version'>,
): GatedChange<PruneResult> {
  if (!isChannel(request.channel)) {
    throw new CommsError('USAGE', `"${String(request.channel)}" is not a channel`, {
      hint: `One of: ${CHANNELS.join(', ')}.`,
    });
  }
  const context: InstallContext = { env, core };
  const { packageName, version } = ownProduct(request.channel, own) ?? {
    packageName: CHANNEL_SERVERS[request.channel].packageName,
    version: VERSION,
  };
  const product = { packageName, version };
  const label = CHANNEL_LABELS[request.channel];
  const base = {
    includePrinted: request.includePrinted === true,
    ...(request.processes ? { processes: request.processes } : {}),
  };
  let approved: string[] = [];
  return {
    plan: async (config) => {
      if (request.dryRun) {
        return { before: config, after: config, summary: `Show which ${label} runtimes are unused` };
      }
      const preview = await pruneManagedRuntimes(context, product, { ...base, dryRun: true });
      approved = preview.removed.map((item) => item.path);
      return {
        before: config,
        after: config,
        effects: preview.removed.map((item) => `deletes the unused ${label} runtime ${item.version} at ${item.path}`),
        summary: `Remove ${approved.length} unused ${label} runtime${approved.length === 1 ? '' : 's'}`,
      };
    },
    apply: () =>
      pruneManagedRuntimes(context, product, {
        ...base,
        dryRun: request.dryRun === true,
        ...(request.dryRun ? {} : { only: approved }),
      }),
  };
}

// ── What is available ───────────────────────────────────────────────────────────────────────────────────────────

export interface ChannelRegistration {
  client: string;
  name: string;
  scope: 'user' | 'project';
  /** The config file it is in. */
  path: string;
  launcher: Launcher | 'other';
  /** The version the entry pins, or null for one that pins none (`local`, or written by hand). */
  version: string | null;
  /** What the entry narrows the server to: its pin and `--read-only`. */
  narrowing: string[];
  /** A file the entry starts that is no longer there — a runtime deleted by hand, a Node a version manager removed. */
  missing: string | null;
}

export interface ChannelAvailability {
  channel: Channel;
  label: string;
  package: string;
  binary: string;
  /** The name a registration gets unless another is chosen. */
  serverName: string;
  /** The version `comms_server_install` registers: this core's own, since the packages are released together. */
  installs: string;
  /** Whether it is on this machine at all: a managed runtime, the command on PATH, or — for core — this process. */
  installed: boolean;
  /** Managed runtimes on disk, as `mcp install` leaves them. */
  runtimes: { version: string; path: string }[];
  /** The command on PATH, and the version of the package it belongs to when that can be read. */
  onPath: { path: string; version: string | null } | null;
  /** Every client entry that starts this channel's server. */
  registered: ChannelRegistration[];
}

export interface ChannelsReport {
  /** The version of the core answering. */
  core: string;
  channels: ChannelAvailability[];
  /** Client configs that are there and could not be read: what they register is not known. */
  unreadable: UnreadableConfig[];
}

/** The version of the package a command on PATH belongs to, read from its manifest; null when it cannot be read. */
async function versionBehind(binPath: string, packageName: string): Promise<string | null> {
  let dir: string;
  try {
    dir = dirname(await realpath(binPath));
  } catch {
    return null;
  }
  for (let depth = 0; depth < 6; depth += 1) {
    try {
      const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as {
        name?: unknown;
        version?: unknown;
      };
      if (manifest.name === packageName) return typeof manifest.version === 'string' ? manifest.version : null;
    } catch {
      // keep walking up
    }
    dir = dirname(dir);
  }
  return null;
}

function launcherOf(server: RegisteredServer, facts: (typeof CHANNEL_SERVERS)[Channel]): Launcher | 'other' {
  const parts = [server.command, ...server.args];
  if (parts.some((part) => managedRuntimeVersion(part, facts.packageName) !== null)) return 'managed';
  if (server.args.some((arg) => arg.startsWith(`${facts.npxPackage}@`))) return 'npx';
  if (parts.some((part) => /[/\\]packages[/\\][^/\\]+[/\\](?:src[/\\]cli\.ts|dist[/\\]cli\.mjs)$/.test(part)))
    return 'local';
  return 'other';
}

/**
 * Which channel packages exist, which are on this machine and at which version, and which clients start them.
 *
 * Read-only: it lists a directory, looks on PATH and reads client configs, and runs nothing. Nothing an entry holds in
 * its `env` is returned — a hand-written entry can carry a token there.
 */
export async function channelsAvailable(core: Core, env: NodeJS.ProcessEnv): Promise<ChannelsReport> {
  const scan = await scanRegisteredServers(env);
  const channels: ChannelAvailability[] = [];
  for (const channel of CHANNELS) {
    const facts = CHANNEL_SERVERS[channel];
    const runtimes = await listManagedRuntimes(core.paths.dataDir, facts.packageName);
    const bin = await whichExecutable(facts.binary, env);
    const onPath = bin ? { path: bin, version: await versionBehind(bin, facts.packageName) } : null;
    const registered: ChannelRegistration[] = [];
    for (const server of scan.servers.filter((entry) => isProductServer(entry, facts))) {
      const narrowing = facts.serverArgs({ client: 'json', ...facts.narrowingOf(server.args) });
      registered.push({
        client: server.client,
        name: server.name,
        scope: server.scope ?? 'user',
        path: server.path,
        launcher: launcherOf(server, facts),
        version: server.args.map((arg) => pinnedVersion(arg, facts)).find((found) => found !== null) ?? null,
        narrowing,
        missing: await missingEntryFile(server),
      });
    }
    channels.push({
      channel,
      label: CHANNEL_LABELS[channel],
      package: facts.packageName,
      binary: facts.binary,
      serverName: facts.defaultServerName,
      installs: VERSION,
      installed: channel === 'core' || runtimes.length > 0 || onPath !== null,
      runtimes,
      onPath,
      registered,
    });
  }
  return { core: VERSION, channels, unreadable: scan.unreadable };
}
