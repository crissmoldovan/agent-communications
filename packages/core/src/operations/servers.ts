import { access, constants, readFile, realpath, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeRequest, ChangeSurface } from '../changes.ts';
import type { NarrowingOption } from '../channel-manifest.ts';
import {
  CHANNEL_SERVERS,
  CHANNELS,
  type Channel,
  isChannel,
  isServer,
  requireChannelManifest,
  SERVERS,
  type ServerId,
  serverFacts,
  serverKind,
  serverLabel,
} from '../channel-servers.ts';
import { accountNoun, hasNarrowing, listed, narrowingOwner, pinOption } from '../channel-words.ts';
import { locateCliCommand } from '../cli-command.ts';
import type { Config } from '../config.ts';
import { registeredOrConnected } from '../connection-registrations.ts';
import { CONNECTION_KEY_ENV, partFacts, readConnections, withConnection } from '../connections.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import { writeFileAtomic } from '../fs.ts';
import { handoffSentence, requireHandoffs } from '../handoffs.ts';
import { launcherCli, launcherName, launcherPaths, readPointer } from '../launcher.ts';
import {
  type ManagedShimWriteResult,
  managedShimPath,
  managedShimsSupported,
  managedShimUnsupportedNotice,
  writeManagedShim,
} from '../managed-shims.ts';
import type { UnreadableConfig } from '../mcp-clients.ts';
import {
  checkServerName,
  connectionOfEntry,
  entryDestination,
  type InstallContext,
  type InstallOptions,
  type InstallResult,
  installFailure,
  installManagedRuntime,
  installRemedyOf,
  isProductServer,
  type Launcher,
  listManagedRuntimes,
  localCliEntry,
  type McpProduct,
  managedRuntimeDir,
  mcpInstall,
  mcpUninstall,
  missingEntryFile,
  type PlannedInstall,
  type PruneResult,
  plannedInstall,
  preflightInstall,
  pruneManagedRuntimes,
  reusableRuntime,
  runningCommandLines,
  type SupportedClient,
  type UninstallResult,
  whichExecutable,
} from '../mcp-install.ts';
import { resolveName } from '../names.ts';
import { isBehind } from '../npm.ts';
import { homeDirectory, type PathOverrides } from '../paths.ts';
import { launcherOf, registrationPathPins, registrationVersion } from '../registrations.ts';
import { refuseWhileUpdating, withPersonUpdateLock } from '../update-lock.ts';
// Types only: sigstore-js stays out of everything core's index reaches. Core's CLI and server hand in the verifier.
import type { VerifiedProvenance } from '../update-provenance.ts';
import {
  BUILT_BY,
  type ReleaseRegistry,
  type ReleaseSources,
  type ReleaseVerifier,
  runtimeIntegrityProblem,
  verifyReleaseSet,
} from '../update-release.ts';
import { VERSION } from '../version.ts';

/**
 * Registering, pruning and listing every declared channel or service MCP server, from the core.
 *
 * `agentcomms mcp install` registers core or a declared service; `comms_server_install` registers any declared
 * server; and channel CLIs register their own. They are the one change here, over
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
 * released together, at one version, so the core asked to install Gmail or events installs its own release.
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
async function localModuleUrl(server: ServerId): Promise<string> {
  const coreRoot = await corePackageRoot();
  const unscopedName = serverFacts(server).packageName.split('/').at(-1) ?? server;
  const root = server === 'core' ? coreRoot : join(dirname(coreRoot), unscopedName);
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
    `\`--launcher local\` registers a checkout's own code, and there is no ${serverFacts(server).packageName} beside this one`,
    { hint: `Looked in ${root}. Use the managed launcher, or run the install from that checkout.` },
  );
}

/**
 * The CLI a part of an MCP connection runs from a checkout (`launcher: local`): this core's sibling package's own
 * `src/cli.ts` when this core runs from source, its `dist/cli.mjs` otherwise — the file `--launcher local` registers.
 */
export async function localPartCli(server: ServerId): Promise<string> {
  return localCliEntry(await localModuleUrl(server));
}

/**
 * The product the shared installer registers, for one channel: at this core's version unless another is named.
 *
 * The version is what reaches the launcher. The managed launcher installs exactly `<package>@<version>` into
 * `runtime/<version>-<name>` and the npx launcher pins `<npx package>@<version>`, both from the product; so naming a
 * newer release here is all it takes to register one this core is older than — which is what `agentcomms update` does.
 * `comms_server_install` and every `mcp install` name none, and register their own release as they always have.
 */
export async function serverProduct(
  server: ServerId,
  launcher: Launcher | undefined,
  version: string = VERSION,
): Promise<McpProduct> {
  return {
    ...serverFacts(server),
    version,
    // Only the `local` launcher reads `moduleUrl`, and only it needs a checkout beside this one; the others must not
    // be refused for the lack of one.
    moduleUrl: launcher === 'local' ? await localModuleUrl(server) : '',
  };
}

/** Backward-compatible name for callers that install a channel server. */
export async function channelProduct(
  channel: Channel,
  launcher: Launcher | undefined,
  version: string = VERSION,
): Promise<McpProduct> {
  return serverProduct(channel, launcher, version);
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
function ownProduct<P extends Pick<McpProduct, 'packageName'>>(server: ServerId, own: P | undefined): P | undefined {
  if (own !== undefined && own.packageName !== serverFacts(server).packageName) {
    throw new CommsError(
      'UNEXPECTED',
      `${own.packageName} is not the ${serverLabel(server)} server's package, so it cannot register that server`,
    );
  }
  return own;
}

// ── Install ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerInstallRequest {
  /** The declared server id. Kept as `channel` for CLI–MCP compatibility with earlier releases. */
  channel: ServerId;
  client: SupportedClient;
  name?: string | undefined;
  /**
   * The pin, for any channel: serve one account, by its name `organisation/<channel>` (design 2026-09-26). Every
   * channel after Gmail and Slack is pinned this way; for those two it is the same as `inbox` and `workspace`, which
   * stay, so their entries, tools and skills work as they did.
   */
  account?: string | undefined;
  /** Gmail's pin: serve one mailbox. The same as `account` for Gmail. */
  inbox?: string | undefined;
  /** Slack's pin: serve one workspace. The same as `account` for Slack. */
  workspace?: string | undefined;
  /** Gmail only: leave out every tool that changes a mailbox. */
  readOnly?: boolean | undefined;
  launcher?: Launcher | undefined;
  force?: boolean | undefined;
  /** Only print the entry: nothing is written, and nothing is asked. */
  print?: boolean | undefined;
  noVerify?: boolean | undefined;
  /**
   * An MCP connection's entry (single-server design D17, D18), for `connection add`: core's server started as the
   * gateway for this connection — `mcp --connection <id>` — with its key in the entry's environment, at Claude Code's
   * user or local scope. Never from a tool's arguments: only the connection operations set it.
   */
  connection?: ConnectionEntryRequest | undefined;
}

/** What registering an MCP connection's entry needs: which connection, its key, and where its entry goes. */
export interface ConnectionEntryRequest {
  readonly id: string;
  readonly name: string;
  readonly key: string;
  readonly scope?: 'user' | 'local' | undefined;
  readonly folder?: string | undefined;
  /** A migration: the entry takes the place of core's own under the name, put back if it does not land (§9.1). */
  readonly replaceCore?: boolean | undefined;
}

export type ServerInstallResult = InstallResult & {
  /** What the person has to do before the server's tools appear, or null when nothing was registered. */
  restart: string | null;
  /**
   * The provenance of the runtime this install fetched from npm, or found there for a release it verified: verified,
   * or — a channel's own command installing the release it is running, which it cannot check — not, with `note`
   * saying so and naming core's command that checks it (also among `warnings`). Absent when it fetched nothing.
   */
  provenance?: { package: string; version: string; verified: boolean; note?: string | undefined } | undefined;
};

export interface ServerInstallDeps {
  /** The platform whose install behavior is planned; this process's unless a test supplies another. */
  platform?: NodeJS.Platform | undefined;
  /**
   * Every package's full document on the registry, read for the tarball integrity of the runtime a first install
   * fetches. Handed in, as the verifier is: core's CLI and server hand in the registry npm reads (`npmRegistry`), and
   * nothing here reaches the network on its own — WhatsApp's bundle, which carries this module, reaches none. Without
   * one, an install that would fetch a runtime is refused.
   */
  registry?: ReleaseRegistry | null | undefined;
  /**
   * Verifies the release a first install fetches from npm, with the pins and the refusal of the update by hand
   * (`verifyReleaseSet`; security review of 0.20.0). Core's CLI and server hand in theirs (`stateReleaseVerifier`), a
   * test its own. Without one — a channel's own process, which carries no Sigstore — an install that would fetch a
   * runtime is refused, naming core's command, and nothing skips it — but for the one release the command is running
   * itself (`running`), which npx already fetched and which is running: that is installed as before, said in the
   * preview and the result not to be verified, and recorded so in its receipt (owner's decision, 2026-10-17).
   */
  verifyRelease?: ReleaseVerifier | undefined;
  /**
   * The release this process is running, when it is a channel's own command: the only one it may install without
   * verifying, and only with no verifier. Left out, the channel's own product (`own`) is it: the version it is.
   */
  running?: { packageName: string; version: string } | undefined;
}

/**
 * What a first install verifies with, from an update's own sources: the same registry and verifier, and the registry
 * npm reads (`npmRegistry`, which the caller hands in) where the update names none. An update handed a stand-in
 * `latest` and no registry — a test's — reads no real registry, and neither does the install then.
 */
export function installVerification(
  update: {
    registry?: ReleaseRegistry | undefined;
    verifyRelease?: ReleaseVerifier | undefined;
    latestVersion?: unknown;
  },
  npm: ReleaseRegistry,
): Pick<ServerInstallDeps, 'registry' | 'verifyRelease'> {
  return {
    registry: update.registry ?? (update.latestVersion === undefined ? npm : null),
    ...(update.verifyRelease !== undefined ? { verifyRelease: update.verifyRelease } : {}),
  };
}

/**
 * Refuses what the channel's own `mcp install` has no flag for, rather than ignoring it.
 *
 * `agent-slack mcp install --inbox work` is an unknown option, and a tool that quietly dropped `inbox` for Slack would
 * register a server reaching every workspace for a caller who believed they had pinned it.
 */
function checkRequest(request: ServerInstallRequest): void {
  if (!isServer(request.channel)) {
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
  const label = serverLabel(request.channel);
  /*
   * A channel's own names for its pin and its switches, refused on a server that has none — by whose option each is,
   * from the manifests, in the words the refusal always had.
   */
  const refuse = (option: NarrowingOption) => {
    const owner = narrowingOwner(option);
    throw new CommsError(
      'USAGE',
      owner === undefined
        ? `\`${option}\` is not an option of the ${label} server`
        : `\`${option}\` is an option of the ${owner.label} server; the ${label} server has no such option`,
    );
  };
  if (request.inbox !== undefined && !hasNarrowing(request.channel, 'inbox')) refuse('inbox');
  if (request.readOnly && !hasNarrowing(request.channel, 'readOnly')) refuse('readOnly');
  if (request.workspace !== undefined && !hasNarrowing(request.channel, 'workspace')) refuse('workspace');
  if (request.account !== undefined) {
    // The generic pin is every channel's that has a pin at all: the core reaches no account, so it has none.
    const own = pinOption(request.channel);
    if (own === undefined) {
      throw new CommsError('USAGE', `\`account\` is not an option of the ${label} server: it reaches no account`);
    }
    // Given twice, it has to say one thing: a server is pinned to one account.
    const alias = own === 'account' ? undefined : request[own];
    if (alias !== undefined && alias !== request.account) {
      throw new CommsError(
        'USAGE',
        `\`account\` and \`${own}\` both pin the ${label} server, to different accounts: give one`,
      );
    }
  }
}

/** The account a request pins its server to — by the generic `account`, or the channel's own name for its pin. */
function pinOf(request: ServerInstallRequest): string | undefined {
  const own = pinOption(request.channel);
  if (own === undefined || own === 'readOnly') return undefined;
  return request[own] ?? request.account;
}

/**
 * The pin, resolved before anything is written, as each channel's own installer does.
 *
 * A server pinned to a mailbox or workspace that does not exist — or to one renamed since — starts, fails, and says so
 * only in a client's log. A former name is refused with the name it has now. An account of another platform is
 * refused too: a Slack server pinned to a mailbox's name starts and serves nothing.
 */
function checkPin(config: Config, request: ServerInstallRequest): void {
  const pin = pinOf(request);
  if (pin === undefined) return;
  const accounts = requireChannelManifest(request.channel).accounts;
  if (accounts?.map === 'inboxes') {
    resolveName(config, 'inbox', pin);
    return;
  }
  const { account } = resolveName(config, 'account', pin);
  if (account.platform !== request.channel) {
    throw new CommsError('USAGE', `"${pin}" is not a ${serverLabel(request.channel)} ${accountNoun(request.channel)}`);
  }
}

function installOptions(request: ServerInstallRequest): InstallOptions {
  // The pin under the channel's own name for it, whichever name it was given by: `--inbox` is what Gmail's server
  // reads, `--workspace` Slack's, `--account` every channel's after them.
  const own = pinOption(request.channel);
  const pin = pinOf(request);
  return {
    client: request.client,
    name: request.name,
    inbox: own === 'inbox' ? pin : request.inbox,
    workspace: own === 'workspace' ? pin : request.workspace,
    ...(own === 'account' && pin !== undefined ? { account: pin } : {}),
    readOnly: request.readOnly,
    launcher: request.launcher,
    noVerify: request.noVerify,
    apply: request.print !== true,
    force: request.force,
    ...(request.connection === undefined
      ? {}
      : {
          entryEnv: { [CONNECTION_KEY_ENV]: request.connection.key },
          connection: request.connection.id,
          scope: request.connection.scope ?? 'user',
          ...(request.connection.replaceCore === true ? { replaceCore: true } : {}),
          ...(request.connection.folder === undefined ? {} : { folder: request.connection.folder }),
        }),
  };
}

/**
 * The install receipt a fetched runtime keeps in its folder: which release, whether its provenance was verified, and
 * by whom it was installed — core, which verifies, or a channel's own command, which cannot (owner's decision,
 * 2026-10-17). Doctor and a person can read it; nothing else depends on it.
 */
export const INSTALL_RECEIPT = '.agentcomms-install.json';

/** A sentence's first letter in capitals: core's command, said after a full stop. */
const capitalised = (text: string): string => `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** What an install's plan found, for its apply to hold the install to: see `serverInstallChange`. */
interface Planned {
  product: McpProduct;
  install: PlannedInstall;
  /** The release a first install fetches, verified before the preview; undefined when it fetches none. */
  verified: VerifiedProvenance | undefined;
  /** A channel's own command fetching the release it is running, which it cannot verify (`running`). */
  unverifiedOwn: boolean;
}

/**
 * Registering one declared server with one client, as a change.
 *
 * The effects are what a person is agreeing to, one sentence each, and everything that decides what the server may
 * reach is in them — which server, which client, under which name, pinned to what, replacing what, started how. The
 * approval is bound to those sentences, so a second call that differs in any of them is a different change and is
 * refused. What `installTarget` says will only be printed has no effect and asks nobody; a managed runtime not yet on
 * this machine is fetched from npm, which is said too.
 *
 * `own` is the calling channel's product, from its own `mcp install`: see `ownProduct`. The sentences depend on the
 * request and the machine, not on which surface prepared them, so an approval prepared by one is claimed by the
 * other. The sentences that name code name it as this environment resolves it: the client's config file and the node
 * or npx the entry starts (#46), and for `--launcher local` the checkout's file. A claim from an environment that
 * resolves another — `CLAUDE_CONFIG_DIR` set to another account's, a PATH that finds another node, a core running
 * from another build of the checkout — is another registration, refused as one.
 */
export function serverInstallChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerInstallRequest,
  own?: McpProduct,
  deps: ServerInstallDeps = {},
): GatedChange<ServerInstallResult> {
  checkRequest(request);
  ownProduct(request.channel, own);
  const context: InstallContext = { env, core, ...(deps.platform === undefined ? {} : { platform: deps.platform }) };
  const facts = serverFacts(request.channel);
  const label = serverLabel(request.channel);
  const noun = accountNoun(request.channel);
  const pinName = pinOption(request.channel);
  const switchable = hasNarrowing(request.channel, 'readOnly');
  const name = request.name ?? facts.defaultServerName;
  const launcher = request.launcher ?? 'managed';
  const productNow = async (): Promise<McpProduct> => {
    const product = own ?? (await serverProduct(request.channel, request.launcher));
    const connection = request.connection;
    if (connection === undefined) return product;
    // Core's server as one connection's gateway: `mcp --connection <id>` (D2).
    return { ...product, serverArgs: (options) => ['--connection', connection.id, ...product.serverArgs(options)] };
  };
  /*
   * What the plan found, for the apply to hold the install to. The install looks at the machine again when it runs,
   * and what it finds then has to be what the plan found — whether it writes or prints, where, what it replaces, and
   * what the server is pinned to — or the person agreed to one thing and got another. See `PlannedInstall`.
   */
  let planned: Planned | undefined;
  /*
   * Where a first install reads the release's document and verifies it (security review of 0.20.0): the registry and
   * the verifier the caller handed in — core's CLI and server, npm's and theirs; a test, its stand-ins.
   */
  const sources = (): ReleaseSources => ({
    registry: deps.registry ?? null,
    verify: deps.verifyRelease ?? null,
    why:
      deps.verifyRelease === undefined
        ? "nothing here can verify provenance: run the install from core's own command or server"
        : 'this install was handed a verifier and no registry',
  });
  /**
   * Core's own command for this same install, located — the one that verifies — said by `say`; `instead` where no
   * command can be named.
   */
  const coreWords = (): string[] => {
    const words = ['mcp', 'install', '--server', request.channel, '--client', request.client];
    if (request.name !== undefined) words.push('--name', request.name);
    const pin = pinOf(request);
    const option = pinOption(request.channel);
    if (pin !== undefined && option !== undefined && option !== 'readOnly') words.push(`--${option}`, pin);
    if (request.readOnly) words.push('--read-only');
    if (request.force) words.push('--force');
    return words;
  };
  const inCore = (say: (command: string) => string, instead: string): string => {
    try {
      return handoffSentence(requireHandoffs(core, deps.platform).core(coreWords()), say, { instead });
    } catch {
      // A core opened with no caller has no command to name: the words alone, never a bare guess.
      return instead;
    }
  };
  /** Where a process that cannot verify — a channel's own, with no Sigstore — sends the person: core, which can. */
  const verifyInCore = (): string =>
    inCore(
      (command) =>
        `Core verifies a release's provenance before it installs it: run ${command} in your own terminal, or call comms_server_install from a chat. Nothing was prepared to approve.`,
      "Core verifies a release's provenance before it installs it: run core's `mcp install --server` in your own terminal, or call comms_server_install from a chat. Nothing was prepared to approve.",
    );
  /** Where the release a channel's own command installs unverified is checked: core's command, located. */
  const checkedInCore = (): string =>
    inCore(
      (command) => `core's ${command} checks it before it installs it`,
      "core's `mcp install --server` checks it before it installs it",
    );
  /** The receipt a runtime this install fetched keeps beside it (`INSTALL_RECEIPT`). */
  const writeReceipt = (runtime: string, packageName: string, version: string, verified: boolean, by: string) =>
    writeFileAtomic(
      join(runtime, INSTALL_RECEIPT),
      `${JSON.stringify({ package: packageName, version, verified, by, at: new Date().toISOString() }, null, 2)}\n`,
    );
  /*
   * The runtime a managed registration starts, held to what the plan verified, before the launcher is pointed or
   * anything is registered. A runtime to fetch is fetched here, with npm running no package's script, and must then
   * hold the very tarball that verified, every package of ours in it verifying too (`runtimeIntegrityProblem`): one
   * that does not is removed, and nothing is registered on it. One the plan found on disk is used as it was found, and
   * one gone since is not fetched unverified.
   */
  const verifiedRuntime = async (done: Planned): Promise<ServerInstallResult['provenance']> => {
    const { dataDir } = core.paths;
    const { packageName, version } = done.product;
    const runtime = managedRuntimeDir(dataDir, packageName, version);
    const there = await reusableRuntime(dataDir, packageName, version);
    if (done.verified === undefined) {
      if (there !== null) return undefined;
      /*
       * A channel's own command installing the release it is running (owner's decision, 2026-10-17): the same package
       * at the same version npx fetched to run it, which this process cannot verify. Installed as before, and said
       * and recorded not to be verified; core's command checks it.
       */
      if (done.unverifiedOwn) {
        await installManagedRuntime(context, done.product, version).catch(async (error) => {
          throw await remedyLocated(error, core);
        });
        await writeReceipt(runtime, packageName, version, false, `${label}’s own command`);
        const note = `${packageName}@${version} was installed without its provenance verified: this command cannot check provenance, so it installed the release it is running itself. ${capitalised(checkedInCore())}.`;
        return { package: packageName, version, verified: false, note };
      }
      throw new CommsError(
        'CONFIG',
        `this registration changed between being planned and being applied: ${runtime} was on this machine when it was planned, and is not now, so it would be fetched from npm without being verified. So nothing was installed or registered`,
        {
          hint: 'Run the same install again: it is planned afresh from what is there now, verifies the release it would fetch, and asks again.',
        },
      );
    }
    if (there === null) {
      await installManagedRuntime(context, done.product, version).catch(async (error) => {
        throw await remedyLocated(error, core);
      });
    }
    const { sha512 } = done.verified;
    const problem = await runtimeIntegrityProblem(runtime, packageName, sha512, {
      verify: sources().verify,
      known: new Map([[`${packageName}@${version}`, sha512]]),
    });
    if (problem === null) {
      // Fetched now, or found on disk and shown to be the verified tarball: its receipt says so from now on.
      await writeReceipt(runtime, packageName, version, true, 'core');
      return { package: packageName, version, verified: true };
    }
    if (there === null) await rm(runtime, { recursive: true, force: true }).catch(() => undefined);
    const general =
      "An install registers only a runtime whose packages of this suite were all built by this repository's release workflow, as their Sigstore provenance shows. If it happens again, do not install it some other way; report it as SECURITY.md says.";
    throw new CommsError(
      'BAD_DATA',
      `nothing was registered: ${problem}${there === null ? ', so it was removed' : ''}. The launcher was not pointed at it`,
      {
        // A runtime found on disk is left for whatever starts it now: say how to put a verified one in its place.
        hint:
          there === null
            ? general
            : `To fetch a verified one, remove ${runtime} — whatever starts it stops until it is installed again — and run this install again: it fetches ${packageName}@${version} from npm and verifies it before anything is registered. ${general}`,
        details: { package: packageName, version },
      },
    );
  };
  return {
    plan: async (config) => {
      checkPin(config, request);
      const product = await productNow();
      const { version } = product;
      // Refuses here what the install would refuse, before anybody is asked; and says what a replacement keeps.
      const preflight = await preflightInstall(context, product, installOptions(request)).catch(async (error) => {
        throw await remedyLocated(error, core);
      });
      const { target, previous, effective, kept, command } = preflight;
      /*
       * A first install fetches the release from npm: verified first, before the preview is made — and again when the
       * approval is claimed, since the claim plans again — against the pins the update holds a release to. One that
       * does not verify refuses the install, and nothing is prepared to approve.
       */
      const managedApply = request.print !== true && launcher === 'managed';
      const fetches =
        managedApply && (await reusableRuntime(core.paths.dataDir, product.packageName, version)) === null;
      /*
       * A runtime already on disk is held to the verified release too, wherever there is a verifier — core's install
       * (re-review of 0.20.0, severity 4): one a channel's own command installed unverified, or one made some other
       * way, is registered on only once it is shown to be the tarball that verified, as the update holds one.
       */
      const checksDisk = managedApply && !fetches && deps.verifyRelease !== undefined;
      const from = sources();
      // The release a channel's own command is running, which npx already fetched: the one it may install unverified.
      const running =
        deps.running ?? (own === undefined ? undefined : { packageName: own.packageName, version: own.version });
      const unverifiedOwn =
        fetches &&
        deps.verifyRelease === undefined &&
        running !== undefined &&
        running.packageName === product.packageName &&
        running.version === version;
      const verified =
        (fetches && !unverifiedOwn) || checksDisk
          ? (
              await verifyReleaseSet(
                from,
                new Map([[product.packageName, version]]),
                'install',
                from.registry === null || from.verify === null ? verifyInCore() : undefined,
              )
            ).get(product.packageName)
          : undefined;
      /*
       * An npx entry's client fetches its package from npm when it starts it: registering the entry is installing that
       * release (design 2026-10-22 P5). So wherever there is a verifier — core's install — the release is verified as a
       * managed runtime is, before the preview and again at the claim, and one that does not verify is refused in the
       * same words. No sentence is added: a channel's own command, which cannot verify, prepares the same change, and
       * core holds it to this when it is claimed. An entry only printed registers nothing, and is not asked about.
       */
      if (request.print !== true && launcher === 'npx' && target.writes && deps.verifyRelease !== undefined) {
        await verifyReleaseSet(from, new Map([[facts.npxPackage, version]]), 'install');
      }
      planned = { product, install: plannedInstall(preflight), verified, unverifiedOwn };
      const effects: string[] = [];
      if (target.writes) {
        // The pin and the switch the server is started with, in the channel's words: "pinned to the mailbox …".
        const pinned = pinName === undefined || pinName === 'readOnly' ? undefined : effective[pinName];
        const pins = [
          pinned !== undefined ? `pinned to the ${noun} ${pinned}` : '',
          effective.readOnly ? 'read-only' : '',
        ].filter(Boolean);
        // What the entry being replaced served, in the channel's words (#47): the account its pin named, or every one.
        const served =
          pinName === undefined || pinName === 'readOnly'
            ? []
            : [...new Set(previous.map((server) => facts.narrowingOf(server.args)[pinName] ?? null))];
        const what = served.map((pin) => (pin === null ? `every ${noun}` : `the ${noun} ${pin}`)).join(' and ');
        const replacing =
          previous.length > 0
            ? `, replacing its own earlier entry of that name${what ? `, which served ${what}${kept.length > 0 ? ',' : ''}` : ''}${kept.length > 0 ? ` and keeping ${kept.join(' ')} from it` : ''}`
            : '';
        effects.push(
          request.connection === undefined
            ? `registers the ${label} MCP server with ${request.client} as "${name}"${pins.length > 0 ? `, ${pins.join(', ')}` : ''}${replacing}`
            : `registers the connection "${request.connection.name}" with ${request.client} as "${name}"${request.connection.scope === 'local' ? `, for the project ${request.connection.folder ?? ''} only` : ''}: one entry that starts Agent Comms with its parts, its key in the entry's environment${previous.length > 0 ? ', replacing its own earlier entry' : ''}`,
        );
        /*
         * What it may reach, said when it is everything rather than left to be inferred from a pin not mentioned.
         * A preview that names only the narrowing a server has reads the same to a person skimming it whether that
         * narrowing is there or not; the widest registration is the one that most needs to say so. A server that
         * reaches no account — the core's — has nothing to say here.
         */
        const everyAccount = pinName !== undefined && pinned === undefined;
        const everyTool = switchable && effective.readOnly !== true;
        if (everyAccount) {
          effects.push(`not pinned: it reaches every ${noun} on this machine${everyTool ? ', with every tool' : ''}`);
        } else if (everyTool) {
          effects.push(`not read-only: it has every tool for ${pinned}, including those that change it`);
        }
        // Where the entry goes and what it starts, as this environment resolves them (#46): bound with the rest, so a
        // claim from an environment that resolves another file or another command is another change.
        effects.push(entryDestination(request.client, target, command, env));
        if (launcher === 'npx') {
          effects.push(`${request.client} will fetch ${facts.npxPackage}@${version} from npm each time it starts it`);
        } else if (launcher === 'local') {
          effects.push(`${request.client} will start it from ${await localCliEntry(product.moduleUrl)}`);
        }
      }
      // A server the client reaches through a connection already would be there twice (§9.2): said, never refused.
      if (target.writes && request.connection === undefined) {
        for (const read of readConnections(config).connections) {
          if (!read.readable || read.record.revokedAt !== null || read.record.app !== request.client) continue;
          if (!read.record.parts.some((part) => part.server === request.channel)) continue;
          effects.push(
            `${request.client} reaches the ${label} server through the connection "${read.record.name}" already: registered on its own too, the agent sees the same tools twice`,
          );
        }
      }
      if (fetches) {
        effects.push(
          `installs ${facts.packageName}@${version} from npm into ${managedRuntimeDir(core.paths.dataDir, facts.packageName, version)}`,
        );
      }
      if (request.print !== true && launcher === 'managed') {
        effects.push(launcherSwitchEffect(core.paths.dataDir, facts.packageName, label, version));
      }
      if (request.print !== true && launcher === 'managed' && managedShimsSupported(context)) {
        const path = managedShimPath({ env, dataDir: core.paths.dataDir, platform: context.platform }, facts.binary);
        effects.push(`writes or repoints the owned CLI shim at ${path}; a foreign file there is left unchanged`);
      }
      /*
       * What it verified for a release it fetches, as the update's preview says it: last, one sentence — or that it
       * cannot, and where it would be. A runtime already on disk is verified and checked all the same (`checksDisk`),
       * but adds no sentence: a channel's own `mcp install` and `comms_server_install` are one change, an approval one
       * prepares claimed by the other (capabilities.json), so where both register on what is already here they say
       * the same words; core refuses at the claim what it cannot verify.
       */
      if (verified !== undefined && fetches) {
        effects.push(`${verified.package}@${verified.version} was verified before this preview: built by ${BUILT_BY}`);
      } else if (unverifiedOwn) {
        // Core's command by its words: located, with its four folders, it is longer than a preview's line shows. The
        // result names it located.
        effects.push(
          `${product.packageName}@${version} will not be verified: this command cannot check provenance, so it installs the release it is running itself; core's \`${coreWords().join(' ')}\` checks it before it installs it`,
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
      if (planned === undefined)
        throw new CommsError('UNEXPECTED', 'the registration was applied before it was planned');
      const provenance = request.print !== true && launcher === 'managed' ? await verifiedRuntime(planned) : undefined;
      const installed = await mcpInstall(context, planned.product, installOptions(request), planned.install).catch(
        async (error) => {
          throw await remedyLocated(error, core);
        },
      );
      const result = request.print === true ? installed : await withManagedShim(context, planned.product, installed);
      return {
        ...result,
        // Not verified is said where every surface prints an install's words, and recorded in the result as well.
        ...(provenance?.note === undefined ? {} : { warnings: [...result.warnings, provenance.note] }),
        ...(provenance === undefined ? {} : { provenance }),
        restart: result.applied
          ? `Restart ${request.client} to load "${result.name}": no MCP client loads a new server into a session that is already running.`
          : null,
      };
    },
  };
}

// ── Several servers at once ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Several declared servers for one client, as one change (design 2026-10-26-desktop-0340, B3): `mcp install --server
 * core,gmail,events`, and `comms_server_install` with `servers`. Every option is the single install's, but those that
 * name one server's entry (`ONE_SERVER_OPTIONS`).
 */
export interface ServerInstallsRequest extends Omit<ServerInstallRequest, 'channel'> {
  /** The declared servers, in the order they are registered: two or more, each once. */
  servers: readonly ServerId[];
}

/** One server's registration among several: the single install's result, and which server it is. */
export type ServerInstalled = ServerInstallResult & { server: ServerId };

export interface ServerInstallsResult {
  client: SupportedClient;
  /** Every server asked for, in the order they were registered. */
  servers: ServerId[];
  /** Each one's result, in that order. */
  results: ServerInstalled[];
  /** What the person has to do before their tools appear, or null when nothing was registered. */
  restart: string | null;
}

/**
 * The options that name one server's entry — what it is called, the account it is pinned to, its read-only switch —
 * which one list of several cannot give each server its own of. Refused there, rather than given to whichever server
 * happens to have it: register that server on its own to name or pin it.
 */
const ONE_SERVER_OPTIONS = ['name', 'account', 'inbox', 'workspace', 'readOnly'] as const;

/** The sentence a list's preview ends with: the order, and what a failure part-way leaves. Bound with the rest. */
const IN_ORDER =
  'registers them one after another, in the order above, and stops at the first that fails: those after it are not registered, and this approval is not used again';

/** Refuses a list that is not two or more declared servers, each once, before anything is planned. */
function checkServers(servers: readonly unknown[]): ServerId[] {
  if (!Array.isArray(servers) || servers.length < 2) {
    throw new CommsError('USAGE', 'name two or more servers to register several at once', {
      hint: 'One server is registered on its own, named as the server.',
    });
  }
  const seen = new Set<string>();
  for (const server of servers) {
    if (typeof server !== 'string' || server.trim() === '') {
      throw new CommsError('USAGE', 'a name in the list of servers is empty', {
        hint: `Name each server once, separated by commas: one of ${SERVERS.join(', ')}.`,
      });
    }
    if (!isServer(server)) {
      throw new CommsError('USAGE', `"${server}" is not a server this can register`, {
        hint: `One of: ${SERVERS.join(', ')}.`,
      });
    }
    if (seen.has(server)) {
      throw new CommsError('USAGE', `"${server}" is named twice: each server is registered once`);
    }
    seen.add(server);
  }
  return [...seen];
}

/**
 * Registering several declared servers with one client, as one change: one plan, one preview naming every server,
 * one approval, and then each server registered in turn (design 2026-10-26-desktop-0340, B3).
 *
 * It is each server's own registration (`serverInstallChange`), planned together. Every server is planned from the
 * machine as it is now before anything is written, so one that refuses — someone else's entry under its name, a
 * release that does not verify — refuses the whole list, and nothing is prepared to approve. The preview is every
 * server's sentences in order, each under its server's name — what it registers, what it reaches, where it is written
 * and what it starts — and one more, bound with them, that says the order and what a failure leaves. The approval is
 * bound to all of it, so it is claimed only for exactly this list, in this order; claiming it spends it. Then each is
 * applied in order, and the first that fails — it throws, registers nothing although it was asked to, or registers an
 * entry that does not start — stops the rest: the error says which were registered and which were not, and carries
 * each finished one's result. The approval was spent on that attempt and is not used again.
 *
 * Someone else's entry is never replaced, a replaced entry's pins are kept and `force` replaces only a server's own
 * earlier entry, as for one: each server's own planning decides it.
 */
export function serverInstallsChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerInstallsRequest,
  deps: ServerInstallDeps = {},
): GatedChange<ServerInstallsResult> {
  const servers = checkServers(request.servers);
  const given = ONE_SERVER_OPTIONS.filter((option) =>
    option === 'readOnly' ? request.readOnly === true : request[option] !== undefined,
  );
  if (given.length > 0) {
    const named = listed(
      given.map((option) => `\`${option}\``),
      'and',
    );
    throw new CommsError(
      'USAGE',
      `${named} ${given.length === 1 ? 'names' : 'name'} one server's entry, and this registers several`,
      { hint: 'Register that server on its own to name or pin it, before or after the rest. Nothing was prepared.' },
    );
  }
  const { client } = request;
  const parts = servers.map((server) => ({
    server,
    change: serverInstallChange(
      core,
      env,
      {
        channel: server,
        client,
        launcher: request.launcher,
        force: request.force,
        print: request.print,
        noVerify: request.noVerify,
      },
      undefined,
      deps,
    ),
    planned: undefined as ChangeRequest | undefined,
  }));
  const labels = listed(servers.map(serverLabel), 'and');
  /** Why the list stopped at `server`, said with what was registered before it and what was not. */
  const stopped = (
    index: number,
    error: unknown,
    done: readonly ServerInstalled[],
    registered: boolean,
  ): CommsError => {
    const server = servers[index] as ServerId;
    const cause = toCommsError(error);
    const installed = done.map((result) => result.server);
    const notInstalled = servers.slice(index);
    const said = (ids: readonly ServerId[]) => (ids.length === 0 ? 'none' : listed(ids.map(serverLabel), 'and'));
    const failed = registered
      ? `the ${serverLabel(server)} server was registered and did not start`
      : `the ${serverLabel(server)} server was not registered`;
    return new CommsError(
      cause.code,
      `stopped at the ${serverLabel(server)} server: ${cause.message}. Registered with ${client}: ${said(installed)}; not registered: ${said(notInstalled.slice(registered ? 1 : 0))}`,
      {
        hint: `${cause.hint === undefined ? '' : `${cause.hint} `}So ${failed}, and nothing after it was tried. The approval was spent on this attempt and is not used again: once what stopped it is fixed, ask again for ${said(notInstalled)}.`,
        details: {
          client,
          servers,
          installed,
          notInstalled: notInstalled.slice(registered ? 1 : 0),
          failed: { server, registered, code: cause.code, message: cause.message, details: cause.details ?? null },
          results: done,
        },
        cause: error,
      },
    );
  };
  return {
    plan: async (config) => {
      const effects: string[] = [];
      for (const part of parts) {
        part.planned = await part.change.plan(config);
        for (const effect of part.planned.effects ?? []) effects.push(`${serverLabel(part.server)}: ${effect}`);
      }
      if (effects.length > 0) effects.push(IN_ORDER);
      return {
        before: config,
        after: config,
        effects,
        summary:
          effects.length > 0
            ? `Register the ${labels} MCP servers with ${client}`
            : `Print the ${labels} MCP servers' entries for ${client}`,
      };
    },
    apply: async (consent) => {
      const results: ServerInstalled[] = [];
      for (const [index, part] of parts.entries()) {
        if (part.planned === undefined) {
          throw new CommsError('UNEXPECTED', 'the registrations were applied before they were planned');
        }
        let result: ServerInstallResult;
        try {
          result = await part.change.apply(consent, part.planned);
        } catch (error) {
          throw stopped(index, error, results, false);
        }
        // Registered nothing although asked to, or registered an entry that did not start: a failure, as for one.
        const failure = installFailure(result);
        if (failure !== null) throw stopped(index, failure, results, result.applied);
        results.push({ server: part.server, ...result });
      }
      const loaded = results.filter((result) => result.applied).map((result) => `"${result.name}"`);
      return {
        client,
        servers,
        results,
        restart:
          loaded.length > 0
            ? `Restart ${client} to load ${listed(loaded, 'and')}: no MCP client loads a new server into a session that is already running.`
            : null,
      };
    },
  };
}

/**
 * What a managed install or update does to the product's stable launcher, as the preview says it (design 2026-10-16,
 * U6): it points it at the release's runtime, and every registration of the product that starts it — in any client —
 * runs that release from its next start.
 */
export function launcherSwitchEffect(dataDir: string, packageName: string, label: string, version: string): string {
  const { launcher } = launcherPaths(dataDir, launcherName(packageName));
  return `points the stable launcher ${launcher} at ${managedRuntimeDir(dataDir, packageName, version)}: every ${label} registration on this machine that starts it runs ${version} from its next start`;
}

/**
 * A managed install's CLI shim (CUE-406), once the registration's outcome is known: the command the locator finds in
 * the runtime the entry starts, written where nothing is or over this installation's own unchanged shim, and never
 * over anything else. A shim that cannot be written leaves the registration as it went, and says how to repair both.
 * The installer may not import the locator, so the operation writes it — for `mcp install` and `update` alike.
 */
export async function withManagedShim(
  context: InstallContext,
  product: McpProduct,
  installed: InstallResult,
): Promise<InstallResult> {
  if (installed.launcher !== 'managed') return installed;
  const shimContext = { env: context.env, dataDir: context.core.paths.dataDir, platform: context.platform };
  if (!managedShimsSupported(shimContext)) {
    return { ...installed, shimNotice: managedShimUnsupportedNotice(shimContext) };
  }
  const warnings = [...installed.warnings];
  let shim: ManagedShimWriteResult | undefined;
  let shimFailure: string | undefined;
  try {
    /*
     * The shim starts the stable launcher, as the registration does (design 2026-10-16, U6), so an update that
     * switches the launcher's pointer moves the command a person types too, and rewrites nothing. The CLI the launcher
     * starts is still located first, from the runtime its pointer names: a runtime this Node cannot run, or whose
     * package does not declare its command, gets no shim.
     */
    const name = launcherName(product.packageName);
    const { launcher } = launcherPaths(context.core.paths.dataDir, name);
    const pointer = await readPointer(context.core.paths.dataDir, name);
    if (pointer === undefined) {
      throw new CommsError('CONFIG', `the stable launcher ${launcher} has no pointer, so it starts nothing yet`);
    }
    const cliEntry = launcherCli(pointer.current, name);
    const located = locateCliCommand({
      caller: { url: pathToFileURL(cliEntry).href, packageName: product.packageName },
      target: {
        packageName: product.packageName,
        manifest: { label: product.defaultServerName, binary: product.binary },
      },
      words: [],
      uses: [],
      paths: { ...context.core.paths, downloadsDir: context.core.paths.dataDir },
      platform: context.platform,
      // This Node as PATH finds it, as the registration beside the shim names it: a link stays the link (CUE-492).
      env: context.env,
    });
    if (!located.ok) {
      throw new CommsError('CONFIG', `the managed CLI command could not be located: ${located.message}`);
    }
    shim = await (context.writeShim ?? writeManagedShim)(shimContext, {
      binary: product.binary,
      command: [launcher],
      entry: launcher,
    });
  } catch (error) {
    shimFailure = error instanceof Error ? error.message : String(error);
    const path = join(homeDirectory(context.env), '.local', 'bin', product.binary);
    warnings.push(
      `The MCP registration ${installed.applied ? 'succeeded' : 'was not changed'}, but the CLI shim at ${path} could not be written (${shimFailure}). Fix that shim directory, then run this managed install again with \`--force\`; the owned registration is replaced without widening it and the shim is repaired.`,
    );
  }
  if (shim?.status === 'foreign') {
    warnings.push(
      `${shim.path} already exists but was not written by this installation, so it was left unchanged; move it aside and run this managed install again with \`--force\` to create the CLI shim at that path.`,
    );
  }
  return {
    ...installed,
    warnings,
    ...(shim === undefined ? {} : { shim }),
    ...(shimFailure === undefined ? {} : { shimFailure }),
  };
}

/**
 * A refusal of `mcp install` with its remedy — another install of the same product — said with the command located:
 * the printing package's own, core's, or another product's found among this machine's registrations (CUE-403). The
 * installer says only the words; it may not import the locator.
 */
async function remedyLocated(error: unknown, core: Core): Promise<unknown> {
  const remedy = installRemedyOf(error);
  if (remedy === undefined || !(error instanceof CommsError)) return error;
  const server = SERVERS.find((each) => serverFacts(each).binary === remedy.binary);
  if (server === undefined) return error;
  const maker = await requireHandoffs(core).registered();
  // A channel's own `mcp install` registers an entry of its own only with `--standalone` (D17); core's always does.
  const words =
    server === 'core' || !isChannel(server)
      ? remedy.words
      : [...remedy.words.slice(0, 4), '--standalone', ...remedy.words.slice(4)];
  const handoff = isChannel(server)
    ? maker.of(server, words)
    : maker.core(['mcp', 'install', '--server', server, ...remedy.words.slice(2)]);
  return new CommsError(error.code, error.message, {
    hint: handoffSentence(handoff, remedy.say),
    ...(error.details === undefined ? {} : { details: error.details }),
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

// ── Prune ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerPruneRequest {
  /**
   * The declared server id, kept as `channel` for CLI–MCP compatibility with earlier releases. Left out, every managed
   * server the channel registry declares (`SERVERS`): `agentcomms mcp prune`, and `comms_server_prune` with no channel.
   */
  channel?: ServerId | undefined;
  dryRun?: boolean | undefined;
  includePrinted?: boolean | undefined;
  /** For a test: the command lines of the running processes, or null when they cannot be listed. */
  processes?: (() => Promise<readonly string[] | null>) | undefined;
}

/** One declared server's part of a prune that names no server: its own prune, and whose it is. */
export interface ServerPruned extends PruneResult {
  server: ServerId;
  /** The server as a person knows it: "agentcomms (core)", "Gmail". */
  label: string;
}

/**
 * A prune of every managed server: each server's own prune, in the registry's order, and all of it together — every
 * runtime removed and kept, each saying whose it is, and every shim — so it reads as one server's prune does.
 * `refused` is set only when every server with a runtime to look at was stopped: then nothing at all was removed.
 * `refusedServers` names each server that was stopped whenever any was, so one left unchecked beside others that went
 * ahead is not missed.
 */
export interface PruneAllResult extends PruneResult {
  removed: { path: string; version: string; server: ServerId }[];
  kept: { path: string; version: string; reason: string; server: ServerId }[];
  servers: ServerPruned[];
  /** Each server whose prune was stopped, and why: none of its runtimes was looked at, so all of them stay. */
  refusedServers?: { server: ServerId; label: string; refused: string }[] | undefined;
}

/**
 * Removing a declared server's unused managed runtimes, as a change.
 *
 * A dry run is free: it removes nothing. Otherwise the plan is that same dry run, and each runtime it would remove is
 * one effect — the removal cannot be taken back — so the approval is bound to exactly that list; and the removal is
 * then restricted to it (`only`), so a runtime that became unused after the list was shown stays.
 *
 * A removal never runs beside an update (`update-lock.ts`): a background run installs a release and checks it before
 * any pointer names it, and a prune beside it would find that runtime unused. So it is refused at once while an update
 * holds the lock — before an approval is prepared — and the removal itself holds the lock, refused in turn when an
 * update has started since. A refusal stops nothing else.
 *
 * `own` is the calling channel's product, from its own `mcp prune`, so the runtime kept as "this release" is the
 * release of the command that was run; checked to be that channel's, as for an install.
 */
export function serverPruneChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerPruneRequest,
  own?: Pick<McpProduct, 'packageName' | 'version'>,
): GatedChange<PruneResult | PruneAllResult> {
  if (request.channel === undefined && own === undefined) return everyServerPruneChange(core, env, request);
  if (request.channel === undefined || !isServer(request.channel)) {
    throw new CommsError('USAGE', `"${String(request.channel)}" is not a channel`, {
      hint: `One of: ${CHANNELS.join(', ')}.`,
    });
  }
  const context: InstallContext = { env, core };
  const { packageName, version } = ownProduct(request.channel, own) ?? {
    packageName: serverFacts(request.channel).packageName,
    version: VERSION,
  };
  const product = { packageName, version };
  const label = serverLabel(request.channel);
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
      // Never beside an update: refused here, before an approval is prepared or claimed, and held below.
      await refuseWhileUpdating(core.paths.stateDir, 'prune');
      const preview = await pruneManagedRuntimes(context, product, { ...base, dryRun: true });
      approved = preview.removed.map((item) => item.path);
      return {
        before: config,
        after: config,
        effects: pruneEffects(label, preview),
        summary: `Remove ${approved.length} unused ${label} runtime${approved.length === 1 ? '' : 's'}`,
      };
    },
    apply: () =>
      request.dryRun
        ? pruneManagedRuntimes(context, product, { ...base, dryRun: true })
        : withPersonUpdateLock(
            core.paths.stateDir,
            () => pruneManagedRuntimes(context, product, { ...base, dryRun: false, only: approved }),
            'prune',
          ),
  };
}

/** What a removal of runtimes does, in the preview's words: each runtime, then each owned CLI shim. */
function pruneEffects(label: string, preview: PruneResult): string[] {
  return [
    ...preview.removed.map((item) => `deletes the unused ${label} runtime ${item.version} at ${item.path}`),
    ...preview.shims.removed.map((path) => `deletes the owned ${label} CLI shim at ${path}`),
  ];
}

/**
 * Every managed server's unused runtimes, as one change (0.21): what an update leaves behind is every server's, and
 * `--server` for each was a step a person had to know to take. The servers are the channel registry's (`SERVERS`),
 * channels and declared services alike, never a list written here; each is pruned exactly as `--server` prunes it —
 * this release's runtime, one any client config or printed entry names, one a running process uses, and the runtime
 * its stable launcher starts and the one it keeps for a rollback all stay, each said why.
 *
 * A dry run is free. Otherwise the plan is every server's dry run, shown grouped by server, and the approval is bound to
 * exactly that list; the removal is then restricted to it, so nothing that became unused after it was shown goes. A
 * server whose prune was stopped — a pointer or a config that cannot be read — is named in the preview, beside what the
 * others remove, and in the result's `refusedServers`. The running processes are listed again for each server, just
 * before it is decided, as the prune of one server lists them: a listing taken at the start of the pass would not see
 * a process started from a runtime while the servers before it were pruned. And, as for one server, a removal never
 * runs beside an update.
 */
function everyServerPruneChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerPruneRequest,
): GatedChange<PruneAllResult> {
  const context: InstallContext = { env, core };
  const servers = SERVERS.map((server) => ({
    server,
    label: serverLabel(server),
    product: { packageName: serverFacts(server).packageName, version: VERSION },
  }));
  const pruneEach = async (options: { dryRun: boolean; only?: readonly string[] }): Promise<ServerPruned[]> => {
    const parts: ServerPruned[] = [];
    for (const { server, label, product } of servers) {
      // Each server's prune lists the running processes itself, just before it decides (`pruneManagedRuntimes`).
      const result = await pruneManagedRuntimes(context, product, {
        includePrinted: request.includePrinted === true,
        processes: request.processes ?? runningCommandLines,
        ...options,
      });
      parts.push({ server, label, ...result });
    }
    return parts;
  };
  /** Each server whose prune was stopped, and why. */
  const refusedOf = (parts: readonly ServerPruned[]) =>
    parts.flatMap(({ server, label, refused }) => (refused === undefined ? [] : [{ server, label, refused }]));
  let approved: string[] = [];
  return {
    plan: async (config) => {
      if (request.dryRun) {
        return { before: config, after: config, summary: 'Show which runtimes of every managed server are unused' };
      }
      // Never beside an update: refused here, before an approval is prepared or claimed, and held below.
      await refuseWhileUpdating(core.paths.stateDir, 'prune');
      const previews = await pruneEach({ dryRun: true });
      approved = previews.flatMap((part) => part.removed.map((item) => item.path));
      const counts = previews
        .filter((part) => part.removed.length > 0)
        .map((part) => `${part.removed.length} ${part.label}`);
      const removals = previews.flatMap((part) => pruneEffects(part.label, part));
      // Beside what it removes, each server it could not check, so the one left alone is read with the rest. Alone,
      // they remove nothing, and there is nothing to approve: the result says them.
      const unchecked = refusedOf(previews).map(
        ({ label, refused }) => `does not check the ${label} runtimes, and removes none of them: ${refused}`,
      );
      return {
        before: config,
        after: config,
        effects: removals.length > 0 ? [...removals, ...unchecked] : [],
        summary: `Remove ${approved.length} unused runtime${approved.length === 1 ? '' : 's'}${counts.length > 0 ? `: ${counts.join(', ')}` : ''}`,
      };
    },
    apply: async () => {
      const dryRun = request.dryRun === true;
      const parts = dryRun
        ? await pruneEach({ dryRun })
        : await withPersonUpdateLock(core.paths.stateDir, () => pruneEach({ dryRun, only: approved }), 'prune');
      const looked = parts.filter((part) => part.removed.length + part.kept.length > 0);
      const refused = looked.length > 0 && looked.every((part) => part.refused !== undefined);
      const refusedServers = refusedOf(parts);
      return {
        runtimeDir: join(core.paths.dataDir, 'runtime'),
        dryRun,
        removed: parts.flatMap((part) => part.removed.map((item) => ({ ...item, server: part.server }))),
        kept: parts.flatMap((part) => part.kept.map((item) => ({ ...item, server: part.server }))),
        shims: {
          removed: parts.flatMap((part) => part.shims.removed),
          kept: parts.flatMap((part) => part.shims.kept),
        },
        ...(refused ? { refused: [...new Set(looked.map((part) => part.refused))].join('; ') } : {}),
        servers: parts,
        ...(refusedServers.length > 0 ? { refusedServers } : {}),
      };
    },
  };
}

// ── Uninstall ───────────────────────────────────────────────────────────────────────────────────────────────

export interface ServerUninstallRequest {
  /** The declared server id, named `channel` as `comms_server_install` names it: `gmail`, `slack`, `core`, `events`. */
  channel: ServerId;
  /** The client to take it out of. Not `json`: a printed entry is registered nowhere this can see. */
  client: SupportedClient;
}

export interface ServerUninstallResult extends UninstallResult {
  server: ServerId;
  /** The server as a person knows it: "agentcomms (core)", "Gmail". */
  label: string;
  /** What to tell the person: the client keeps the server it started until it restarts. */
  restart: string;
  /**
   * The MCP connections for this client the server was taken out of, as a part (single-server design §9.2): so "every
   * entry of that server in that client goes" stays true when the client reaches it through a connection.
   */
  connections: { id: string; name: string }[];
}

/**
 * Taking one declared server out of one MCP client, as a change (design 2026-10-26-owner-feedback-0320 §3.3, §4):
 * `agentcomms mcp uninstall --client <c> --server <s>` and comms_server_uninstall. Prune is not this: it removes
 * runtimes nothing names, and leaves every client's registrations as they are.
 *
 * A tightening — an agent and its client can do less after it — so it applies at once and asks nobody, from either
 * surface: the plan changes no setting and does nothing that cannot be taken back (the entries are saved first, and
 * registering again puts them back). The audit log records it. What it does is `mcpUninstall`'s.
 */
export function serverUninstallChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: ServerUninstallRequest,
  surface: ChangeSurface,
  deps: { platform?: NodeJS.Platform | undefined } = {},
): GatedChange<ServerUninstallResult> {
  const channel = (request as { channel?: unknown } | undefined)?.channel;
  const client = (request as { client?: unknown } | undefined)?.client;
  if (typeof channel !== 'string' || !isServer(channel)) {
    throw new CommsError('USAGE', `"${String(channel).slice(0, 40)}" is not a server this can take out`, {
      hint: `One of: ${SERVERS.join(', ')}.`,
    });
  }
  if (typeof client !== 'string' || !(CLIENTS as readonly string[]).includes(client) || client === 'json') {
    throw new CommsError('USAGE', `"${String(client).slice(0, 40)}" is not a client a server can be taken out of`, {
      hint: `One of: ${CLIENTS.filter((each) => each !== 'json').join(', ')}.`,
    });
  }
  const label = serverLabel(channel);
  const context: InstallContext = { env, core, ...(deps.platform === undefined ? {} : { platform: deps.platform }) };
  return {
    plan: (config) => ({ before: config, after: config, summary: `Take the ${label} server out of ${client}` }),
    apply: async () => {
      const result = await mcpUninstall(context, serverFacts(channel), client as SupportedClient);
      // Out of every connection for this client too, as a part: a tightening, applied at once beside the rest.
      const connections: { id: string; name: string }[] = [];
      await core.config.update((config) => {
        let held: unknown = config.connections;
        for (const read of readConnections(config).connections) {
          if (!read.readable || read.record.app !== client) continue;
          if (!read.record.parts.some((part) => part.server === channel)) continue;
          connections.push({ id: read.record.id, name: read.record.name });
          held = withConnection(
            { connections: held },
            { put: { ...read.record, parts: read.record.parts.filter((part) => part.server !== channel) } },
          );
        }
        return connections.length === 0 ? config : ({ ...config, connections: held } as Config);
      });
      await core.audit.append({
        inboxId: '',
        operation: 'mcp.uninstall',
        outcome: 'ok',
        surface,
        reason: `${channel} from ${client}: removed ${result.removed.length}, kept ${result.kept.length}, out of ${connections.length} connection(s)`,
      });
      return {
        server: channel,
        label,
        ...result,
        connections,
        restart:
          result.removed.length > 0 || connections.length > 0
            ? `${client} keeps the ${label} server it started until it is restarted: restart it for this to take effect`
            : `nothing of the ${label} server was taken out of ${client}`,
      };
    },
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
  /** The four suite roots explicitly pinned in the registration. Downloads are never a server-registration pin. */
  pathPins: Omit<PathOverrides, 'downloadsDir'>;
  /** A file the entry starts that is no longer there — a runtime deleted by hand, a Node a version manager removed. */
  missing: string | null;
  /**
   * The entry pins a release older than the core answering: drift an agent can see without asking the registry. Not
   * whether a newer release exists — `comms_update` with `check` asks npm that — and false for an entry that pins none.
   */
  behindCore: boolean;
  /**
   * The MCP connection this registration is (single-server design §9.2): the connection's gateway entry, or one of its
   * parts, which the gateway starts and no app's config holds. Null for a server's own entry.
   */
  connection: string | null;
}

export interface ChannelAvailability {
  /** Stable server id. Kept as `channel` in this compatibility-shaped report. */
  channel: ServerId;
  kind: 'channel' | 'service';
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
  /** Every client entry that starts this channel's server, and every connection whose gateway starts it. */
  registered: ChannelRegistration[];
  /** The MCP connections that reach this server (§9.2): each by id, name and app. */
  viaConnections: { id: string; name: string; app: string }[];
  /**
   * What it takes as a part of an MCP connection (§11, D20) — the account it can be kept to, by its option and what one
   * is called, and whether it can be started read-only — so the app keeps no table of its own; null for a server no
   * connection can have.
   */
  part: {
    account: { option: 'inbox' | 'workspace' | 'account'; noun: string } | null;
    readOnly: boolean;
  } | null;
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

/** A server's choices as a connection's part, from core's snapshot of the declarations (`partFacts`). */
function partChoice(server: string): ChannelAvailability['part'] {
  const facts = partFacts(server);
  if (facts === undefined) return null;
  return {
    account: facts.pin === undefined ? null : { option: facts.pin, noun: facts.noun ?? 'account' },
    readOnly: facts.readOnlySwitch,
  };
}

/**
 * Which channel packages exist, which are on this machine and at which version, and which clients start them.
 *
 * Read-only: it lists a directory, looks on PATH and reads client configs, and runs nothing. Nothing an entry holds in
 * its `env` is returned — a hand-written entry can carry a token there.
 */
export async function channelsAvailable(core: Core, env: NodeJS.ProcessEnv): Promise<ChannelsReport> {
  // Every entry in the apps' configs, and every part a connection's gateway starts (D19).
  const scan = await registeredOrConnected(core, env);
  const channels: ChannelAvailability[] = [];
  for (const channel of SERVERS) {
    const facts = serverFacts(channel);
    const runtimes = await listManagedRuntimes(core.paths.dataDir, facts.packageName);
    const bin = await whichExecutable(facts.binary, env);
    const onPath = bin ? { path: bin, version: await versionBehind(bin, facts.packageName) } : null;
    const registered: ChannelRegistration[] = [];
    const viaConnections: ChannelAvailability['viaConnections'] = [];
    for (const server of scan.servers.filter((entry) => isProductServer(entry, facts))) {
      // A connection's gateway entry starts core's launcher, but it is the connection's, not core's own registration.
      const gateway = server.connection === undefined ? connectionOfEntry(server.args) : null;
      if (channel === 'core' && gateway !== null) continue;
      if (server.connection !== undefined) {
        viaConnections.push({ id: server.connection.id, name: server.connection.name, app: server.client });
      }
      const narrowing = facts.serverArgs({ client: 'json', ...facts.narrowingOf(server.args) });
      const version = registrationVersion(server, facts);
      registered.push({
        client: server.client,
        name: server.name,
        scope: server.scope ?? 'user',
        path: server.path,
        launcher: launcherOf(server, facts),
        version,
        narrowing,
        pathPins: registrationPathPins(server.args),
        missing: await missingEntryFile(server),
        behindCore: version !== null && isBehind(version, VERSION),
        connection: server.connection?.id ?? null,
      });
    }
    channels.push({
      channel,
      kind: serverKind(channel),
      label: serverLabel(channel),
      package: facts.packageName,
      binary: facts.binary,
      serverName: facts.defaultServerName,
      installs: VERSION,
      installed: channel === 'core' || runtimes.length > 0 || onPath !== null,
      runtimes,
      onPath,
      registered,
      viaConnections,
      part: partChoice(channel),
    });
  }
  return { core: VERSION, channels, unreadable: scan.unreadable };
}
