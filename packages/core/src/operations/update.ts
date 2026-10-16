import { corruptStubOf, type StoredApproval, stateOf } from '../approval-stored.ts';
import type { ApprovalState } from '../approvals.ts';
import type { GatedChange } from '../change-flow.ts';
import {
  CHANNELS,
  isChannel,
  requireChannelManifest,
  SERVERS,
  type ServerId,
  serverFacts,
  serverLabel,
} from '../channel-servers.ts';
import { accountNoun, pinOption } from '../channel-words.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import { type CliHandoffs, type Handoff, handoffChoices, handoffSentence, requireHandoffs } from '../handoffs.ts';
import { APPROVAL_ID_PATTERN } from '../ids.ts';
import { type ManagedShimWriteResult, managedShimPath, managedShimsSupported } from '../managed-shims.ts';
import { type RegisteredServer, scanRegisteredServers, type UnreadableConfig } from '../mcp-clients.ts';
import {
  clientCliSearch,
  entryDestination,
  type InstallContext,
  type InstallOptions,
  type InstallResult,
  installManagedRuntime,
  installTarget,
  isProductServer,
  type Launcher,
  listManagedRuntimes,
  type McpProduct,
  managedRuntimeDir,
  mcpInstall,
  type Narrowing,
  type PlannedInstall,
  plannedInstall,
  preflightInstall,
  reusableRuntime,
  type SupportedClient,
} from '../mcp-install.ts';
import { resolveName } from '../names.ts';
import {
  compareVersions,
  isBehind,
  isPrerelease,
  isVersion,
  npmGlobalPackages,
  npmInstallGlobal,
  npmLatestVersion,
  npmReleaseDeclaration,
  type ReleaseDeclaration,
} from '../npm.ts';
import { launcherOf, registrationVersion } from '../registrations.ts';
import { changeUpdateCheck, type ReleaseFacts, type UpdateCurrent, updateCheckSwitchedOff } from '../update-state.ts';
import { VERSION } from '../version.ts';
import { serverProduct, withManagedShim } from './servers.ts';

/**
 * Bringing a machine to the latest release, from a terminal (`agentcomms update`) or a chat (`comms_update`).
 *
 * A registration pins an exact version, so a new release reaches a client only when it is registered again — which
 * until now only a channel's own `mcp install --force`, run from that release, could do: the core server registers
 * servers at its own version. This reads the npm registry for the latest release, finds everything on this machine
 * that is behind it — every client's registration of each channel, the managed runtimes those need, and the global
 * packages that are installed — and makes one change of it, approved like every other: each registration registered
 * again at the latest version with exactly the name, client, scope, launcher and pins it has, each runtime that needs
 * installing, and each global package updated.
 *
 * The check reads and asks nobody. The update is a change whose effects are every step, one sentence each, so the
 * approval is bound to exactly that list — the versions in it included: a release published between the question and
 * the yes is a different change, and the claim is refused. Nothing behind, nothing is prepared.
 */

/**
 * The packages this suite publishes, whose latest releases an update reads: every declared server owner's, from the
 * channel and service declarations, and every package a server is run through by `npx` when that is another one —
 * Gmail's `gmail-mcp`.
 */
const OWNER_PACKAGES: readonly string[] = Object.freeze(SERVERS.map((server) => serverFacts(server).packageName));
const SERVER_PACKAGES: readonly string[] = Object.freeze(
  SERVERS.map((server) => serverFacts(server).npxPackage).filter((name) => !OWNER_PACKAGES.includes(name)),
);
const PUBLISHED_NAMES: readonly string[] = Object.freeze([...new Set([...OWNER_PACKAGES, ...SERVER_PACKAGES])].sort());

/**
 * What an update does outside this process, each replaceable: a test hands in stand-ins, and nothing it runs reads
 * the real registry, lists the machine's global packages, or installs anything.
 */
export interface UpdateDeps {
  /** The version the registry's `latest` dist-tag names. Defaults to npm's registry, with a timeout. */
  latestVersion?: ((packageName: string) => Promise<string>) | undefined;
  /** This suite's packages installed globally, by name. Defaults to `npm ls --global --depth=0 --json`. */
  globalPackages?: (() => Promise<Record<string, string>>) | undefined;
  /** `npm install --global <spec>`. */
  installGlobal?: ((spec: string) => Promise<void>) | undefined;
  /** Installs a managed runtime of exactly this version, as the managed launcher would. */
  installRuntime?: ((packageName: string, version: string) => Promise<void>) | undefined;
  /**
   * What a release's core manifest declares — a security fix, a decision it needs (design 2026-10-16, U7). Defaults to
   * the registry's own document of that release, but only beside the registry's own `latest`: a test that hands in a
   * `latestVersion` hands in this too, or the facts are not read. Null: never read them.
   */
  releaseFacts?: ((packageName: string, version: string) => Promise<ReleaseDeclaration>) | null | undefined;
  /** The clock a check or an update is recorded by in the daily check's file. */
  now?: (() => Date) | undefined;
  /** The shell the commands it prints are quoted for: this machine's, unless a test asks for another by name. */
  platform?: NodeJS.Platform | undefined;
}

export interface UpdateRequest {
  /** Do not start each server registered again to check that it answers. */
  noVerify?: boolean | undefined;
}

/** One client's registration of one declared server. */
export interface RegistrationItem {
  kind: 'registration';
  channel: ServerId;
  /** The package the entry starts: the owner's, or for Gmail started through npx, `@agentcomms/gmail-mcp`. */
  package: string;
  client: string;
  name: string;
  scope: 'user' | 'project';
  /** The config file it is in. */
  path: string;
  launcher: Launcher | 'other';
  /** The version the entry pins; null for one that pins none. */
  version: string | null;
  latest: string;
  /** Its pin and `--read-only`, as `mcp install` writes them. An update keeps exactly these. */
  narrowing: string[];
  /** On an entry that is behind: whether the update can register it again from here. */
  updatable?: boolean | undefined;
  /** Why not, and what a person can do instead; or, for one that pins nothing, why it is not compared. */
  reason?: string | undefined;
}

/** The managed runtime of one package at the latest release: behind when a registration the update moves needs it. */
export interface RuntimeItem {
  kind: 'runtime';
  channel: ServerId;
  package: string;
  /** The newest runtime of this package on disk, or null when there is none. */
  version: string | null;
  latest: string;
  /** Where the latest release's runtime is, or will be installed. */
  path: string;
}

/** A package of this suite installed globally with npm. */
export interface GlobalItem {
  kind: 'global';
  package: string;
  version: string;
  latest: string;
}

export type UpdateItem = RegistrationItem | RuntimeItem | GlobalItem;

export interface UpdateReport {
  /** The version of the core answering. */
  core: string;
  /** The latest release of each package, as the registry names it. */
  latest: Record<string, string>;
  behind: UpdateItem[];
  upToDate: UpdateItem[];
  /** Registrations that pin no version — a checkout's own code, or an entry written by hand — so are not compared. */
  unpinned: RegistrationItem[];
  /** Client configs, and the global package list, that could not be read: what they hold is not known. */
  unreadable: UnreadableConfig[];
}

export type UpdateStep =
  | {
      kind: 'runtime';
      channel: ServerId;
      package: string;
      version: string;
      path: string;
      outcome: 'installed' | 'failed';
      detail?: string | undefined;
    }
  | {
      kind: 'registration';
      channel: ServerId;
      client: string;
      name: string;
      scope: 'user';
      path: string;
      launcher: Launcher;
      from: string;
      to: string;
      narrowing: string[];
      outcome: 'registered' | 'failed' | 'skipped';
      /** Whether the new entry was started and answered, as `mcp install` checks it. */
      verification?: InstallResult['verification'] | undefined;
      detail?: string | undefined;
      /** Where the entry it replaced was saved. */
      backupPath?: string | undefined;
      warnings?: string[] | undefined;
      shim?: ManagedShimWriteResult | undefined;
    }
  | {
      kind: 'global';
      package: string;
      from: string;
      to: string;
      outcome: 'updated' | 'failed';
      detail?: string | undefined;
    };

export interface UpdateResult {
  /**
   * `up-to-date`: nothing was behind. `updated`: every step worked. `failed`: at least one did not — each step says
   * which. `manual`: something is behind that only a person can bring up to date; `manual` says what and how.
   */
  status: 'up-to-date' | 'updated' | 'failed' | 'manual';
  latest: Record<string, string>;
  /** What was done, in the order it was done, each with how it went. */
  steps: UpdateStep[];
  /** Behind, and left for a person, each with why. */
  manual: RegistrationItem[];
  /** No step failed. */
  ok: boolean;
  /** What the person does next: restart the clients, then prune the old runtimes. Null when nothing was registered. */
  next: string | null;
}

// ── Reading what is there ──────────────────────────────────────────────────────────────────────────────────────

interface Found {
  server: RegisteredServer;
  item: RegistrationItem;
}

interface Inspection {
  report: UpdateReport;
  /** The commands this update hands a person: core's, and each channel's found among the registrations it read. */
  handoffs: CliHandoffs;
  /** Behind, and updatable as far as the files show. */
  candidates: Found[];
  /** Behind, and not updatable from here. */
  manual: RegistrationItem[];
  globals: GlobalItem[];
}

function narrowingArgs(server: ServerId, narrowing: Narrowing): string[] {
  return serverFacts(server).serverArgs({ client: 'json', ...narrowing });
}

/** Every registration of every declared server, as the core's `channels` finds them — nothing an `env` holds. */
function registrations(servers: readonly RegisteredServer[]): { channel: ServerId; server: RegisteredServer }[] {
  return SERVERS.flatMap((channel) =>
    servers.filter((server) => isProductServer(server, serverFacts(channel))).map((server) => ({ channel, server })),
  );
}

/** The latest release of each package, all asked at once; the first that cannot be read stops everything. */
async function latestReleases(
  names: readonly string[],
  latestVersion: (packageName: string) => Promise<string>,
): Promise<Record<string, string>> {
  const answers = await Promise.all(
    names.map(async (name) => {
      try {
        const version = await latestVersion(name);
        if (!isVersion(version)) {
          return {
            name,
            problem: `the npm registry names ${JSON.stringify(String(version)).slice(0, 60)} as the latest release of ${name}, which is not a version`,
          };
        }
        return { name, version };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return { name, problem: `could not read the latest release of ${name} from the npm registry: ${reason}` };
      }
    }),
  );
  const problems = answers.filter((answer) => answer.problem !== undefined);
  const [first] = problems;
  if (first?.problem) {
    throw new CommsError(
      'PROVIDER_UNAVAILABLE',
      `${first.problem}${problems.length > 1 ? ` (and ${problems.length - 1} more)` : ''}`,
      {
        hint: 'Nothing was checked or changed. Try again once the registry can be reached; `npm view <package> version` shows what npm itself reads.',
      },
    );
  }
  return Object.fromEntries(answers.map((answer) => [answer.name, answer.version ?? '']));
}

/**
 * How to register an entry again by hand: its channel's own `mcp install`, with every flag that decides its reach —
 * located as that channel's command among this machine's registrations, or why it is not locatable here (CUE-403).
 *
 * The entry's name and pins are read from the client's file, which may hold anything, so on Windows the command may
 * have no line to paste: the reasons below give it with `handoffSentence`, which shows it as words then.
 */
function installHandoff(item: RegistrationItem, handoffs: CliHandoffs): Handoff {
  const facts = serverFacts(item.channel);
  const words = ['mcp', 'install', '--client', item.client];
  if (item.name !== facts.defaultServerName) words.push('--name', item.name);
  words.push(...item.narrowing, '--force');
  return isChannel(item.channel)
    ? handoffs.of(item.channel, words)
    : handoffs.core(['mcp', 'install', '--server', item.channel, ...words.slice(2)]);
}

/**
 * Why a registration that is behind cannot be registered again from here, or undefined when it can.
 *
 * `mcp install` writes one entry at user scope into the client's own configuration, through the client's CLI where it
 * has one, with a launcher it knows — so an entry it did not write, one for a single project, and one for a client
 * whose CLI is not here are each left for a person, with what to run. So is one pinned to an account that has since
 * been renamed or removed: registering it again would register a server that is refused when it starts.
 */
async function whyNotUpdatable(
  context: InstallContext,
  config: Config | null,
  item: RegistrationItem,
  narrowing: Narrowing,
  handoffs: CliHandoffs,
): Promise<string | undefined> {
  if (item.launcher !== 'managed' && item.launcher !== 'npx') {
    return `it was not written by \`mcp install\`, so how it starts cannot be carried over; ${handoffSentence(installHandoff(item, handoffs), (command) => `register it again with ${command}`)}`;
  }
  if (item.scope !== 'user') {
    return `it is registered for one project (in ${item.path}), and \`mcp install\` registers at user scope only; register it again from that project with ${item.client}'s own command`;
  }
  // Every client the scan reads is one `mcp install` registers with: it reads the files of exactly those.
  const target = await installTarget(context, { client: item.client as SupportedClient, apply: true });
  if (!target.writes) {
    return target.cliName
      ? `\`${target.cliName}\` is not ${clientCliSearch(context.env)}, so the entry cannot be replaced from here; ${handoffSentence(installHandoff(item, handoffs), (command) => `run ${command} where it is`)}`
      : `this environment names no ${item.client} configuration to write to`;
  }
  const own = pinOption(item.channel);
  const pin = own === undefined || own === 'readOnly' ? undefined : narrowing[own];
  if (pin !== undefined) {
    if (config === null) return 'the configuration could not be read, so the account it is pinned to cannot be checked';
    try {
      // In the map the channel's accounts live in: Gmail's mailboxes, or everyone else's accounts.
      if (requireChannelManifest(item.channel).accounts?.map === 'inboxes') resolveName(config, 'inbox', pin);
      else resolveName(config, 'account', pin);
    } catch (error) {
      const refused = toCommsError(error);
      return `it is pinned to an account this machine does not have by that name — ${refused.message}; register it again with the account's name as it is now`;
    }
  }
  return undefined;
}

/** The newest version among runtimes on disk, or null. */
function newest(versions: readonly string[]): string | null {
  return versions.reduce<string | null>(
    (best, version) => (best === null || (compareVersions(version, best) ?? 0) > 0 ? version : best),
    null,
  );
}

/**
 * The runtimes the registrations in `managed` need, per package: to install when the latest release's runtime is not
 * on disk. Only what a registration being moved will start — an old runtime nothing registers is for `prune`.
 */
async function runtimesNeeded(
  dataDir: string,
  latest: Record<string, string>,
  managed: readonly RegistrationItem[],
): Promise<RuntimeItem[]> {
  const needed: RuntimeItem[] = [];
  for (const channel of SERVERS) {
    const packageName = serverFacts(channel).packageName;
    const version = latest[packageName];
    if (version === undefined) continue;
    if (!managed.some((item) => item.channel === channel && item.launcher === 'managed')) continue;
    if ((await reusableRuntime(dataDir, packageName, version)) !== null) continue;
    const onDisk = (await listManagedRuntimes(dataDir, packageName)).map((runtime) => runtime.version);
    needed.push({
      kind: 'runtime',
      channel,
      package: packageName,
      version: newest(onDisk),
      latest: version,
      path: managedRuntimeDir(dataDir, packageName, version),
    });
  }
  return needed;
}

async function inspect(core: Core, env: NodeJS.ProcessEnv, deps: UpdateDeps): Promise<Inspection> {
  const context: InstallContext = { env, core, platform: deps.platform };
  const scan = await scanRegisteredServers(env);
  const handoffs = requireHandoffs(core, deps.platform).withRegistrations(scan.servers);
  const unreadable: UnreadableConfig[] = [...scan.unreadable];
  const found = registrations(scan.servers).map(({ channel, server }) => {
    const facts = serverFacts(channel);
    const narrowing = facts.narrowingOf(server.args);
    return {
      channel,
      server,
      narrowing,
      version: registrationVersion(server, facts),
      // Gmail's npx launcher starts its thin `-mcp` package, released beside it: that package's release is the one it
      // pins, and the one it is compared with.
      package: server.args.some((arg) => arg.startsWith(`${facts.npxPackage}@`)) ? facts.npxPackage : facts.packageName,
    };
  });

  let installed: Record<string, string> = {};
  try {
    const listed = await (deps.globalPackages ?? (() => npmGlobalPackages(env, PUBLISHED_NAMES)))();
    installed = Object.fromEntries(
      Object.entries(listed).filter(([name, version]) => PUBLISHED_NAMES.includes(name) && isVersion(version)),
    );
  } catch (error) {
    unreadable.push({
      client: 'npm',
      path: 'the global packages (npm ls --global)',
      reason: error instanceof Error ? error.message : String(error),
    });
  }

  /*
   * Only what this machine uses is asked about: core itself, every package a registration here starts, and every one
   * installed globally. A channel nobody here uses may not be on the registry at all — a release that adds a channel
   * can reach npm before that channel's first publish — and asking about it would stop the update for everyone who
   * does not use it.
   */
  const wanted = new Set<string>([serverFacts('core').packageName]);
  for (const entry of found) {
    wanted.add(serverFacts(entry.channel).packageName);
    wanted.add(entry.package);
  }
  for (const name of Object.keys(installed)) wanted.add(name);
  const latest = await latestReleases(
    [...wanted].sort(),
    deps.latestVersion ?? ((name) => npmLatestVersion(name, { env })),
  );

  let config: Config | null = null;
  try {
    config = await core.config.load();
  } catch {
    // Only a pinned entry needs it, and says so when it cannot be read.
  }

  const behind: UpdateItem[] = [];
  const upToDate: UpdateItem[] = [];
  const unpinned: RegistrationItem[] = [];
  const candidates: Found[] = [];
  const manual: RegistrationItem[] = [];
  for (const entry of found) {
    const item: RegistrationItem = {
      kind: 'registration',
      channel: entry.channel,
      package: entry.package,
      client: entry.server.client,
      name: entry.server.name,
      scope: entry.server.scope ?? 'user',
      path: entry.server.path,
      launcher: launcherOf(entry.server, serverFacts(entry.channel)),
      version: entry.version,
      latest: latest[entry.package] ?? '',
      narrowing: narrowingArgs(entry.channel, entry.narrowing),
    };
    if (item.version === null) {
      unpinned.push({
        ...item,
        reason:
          item.launcher === 'local'
            ? "it starts a checkout's own code, which pins no release"
            : 'it pins no release, so there is nothing to compare: it was not written by `mcp install`',
      });
      continue;
    }
    if (!isBehind(item.version, item.latest)) {
      upToDate.push(item);
      continue;
    }
    const reason = await whyNotUpdatable(context, config, item, entry.narrowing, handoffs);
    const listed: RegistrationItem = { ...item, updatable: reason === undefined, ...(reason ? { reason } : {}) };
    behind.push(listed);
    if (reason === undefined) candidates.push({ server: entry.server, item: listed });
    else manual.push(listed);
  }

  // The runtimes: behind when a registration being moved needs the latest one; up to date when it is on disk.
  const needed = await runtimesNeeded(
    core.paths.dataDir,
    latest,
    candidates.map((candidate) => candidate.item),
  );
  behind.push(...needed);
  for (const channel of SERVERS) {
    const packageName = serverFacts(channel).packageName;
    const version = latest[packageName];
    if (version === undefined || (await reusableRuntime(core.paths.dataDir, packageName, version)) === null) continue;
    upToDate.push({
      kind: 'runtime',
      channel,
      package: packageName,
      version,
      latest: version,
      path: managedRuntimeDir(core.paths.dataDir, packageName, version),
    });
  }

  const globals: GlobalItem[] = [];
  for (const name of PUBLISHED_NAMES) {
    const version = installed[name];
    const newestRelease = latest[name];
    if (version === undefined || newestRelease === undefined) continue;
    const item: GlobalItem = { kind: 'global', package: name, version, latest: newestRelease };
    if (isBehind(version, newestRelease)) {
      behind.push(item);
      globals.push(item);
    } else upToDate.push(item);
  }

  return {
    report: { core: VERSION, latest, behind, upToDate, unpinned, unreadable },
    handoffs,
    candidates,
    manual,
    globals,
  };
}

/**
 * What is behind the latest release on this machine, and what is not. Reads the registry and this machine, and asks
 * nobody. `agentcomms update --check` and `comms_update` with `check` — and the daily update check, which asks it the
 * same question once a day.
 *
 * It changes nothing but the daily check's own file, where what it found is recorded: a check a person asked for is
 * the day's check too, and gives up any claim a check running in the background holds, so that one's older finding
 * is not written over this. `claim` is that background check's own: what it finds is recorded only while the file
 * still holds it.
 */
export async function updateCheck(
  core: Core,
  env: NodeJS.ProcessEnv,
  deps: UpdateDeps = {},
  claim?: string,
): Promise<UpdateReport> {
  const { report } = await inspect(core, env, deps);
  await recordFound(core, env, report, deps, null, claim, await releaseOf(report, env, deps));
  return report;
}

/**
 * What the latest release's core manifest declares, for the daily check's file — or null, where it is not to be read
 * or could not be: never a reason for the check to fail. Read only for a release newer than nothing — a counted one.
 */
async function releaseOf(report: UpdateReport, env: NodeJS.ProcessEnv, deps: UpdateDeps): Promise<ReleaseFacts | null> {
  const latest = report.latest[CORE_PACKAGE];
  if (latest === undefined || !isVersion(latest) || isPrerelease(latest)) return null;
  const read =
    deps.releaseFacts !== undefined
      ? deps.releaseFacts
      : deps.latestVersion === undefined
        ? (name: string, version: string) => npmReleaseDeclaration(name, version, { env })
        : null;
  if (read === null) return null;
  try {
    return { version: latest, ...(await read(CORE_PACKAGE, latest)) };
  } catch {
    return null;
  }
}

const CORE_PACKAGE = serverFacts('core').packageName;

/**
 * One registration: its channel, its client, its scope, the file it is in and its name. Two copies of it in one file —
 * `servers` and an old `mcpServers` — are one registration, and an update registers them again as one.
 *
 * The scope and the file are part of it because a name is not unique to a client. A `gmail` a project pins to an old
 * release sits beside the user's `gmail` the update moves, in the project's `.mcp.json` — or, for a local-scope entry,
 * in the very `~/.claude.json` the user's is in, told apart only by its scope. The update leaves such an entry for a
 * person, and in that project the client starts it rather than the user's. Keyed by name alone it counted as moved,
 * and every call there was told to restart the client — which starts the same old code.
 */
const registrationKey = (entry: {
  channel: ServerId;
  client: string;
  scope: 'user' | 'project';
  path: string;
  name: string;
}): string => [entry.channel, entry.client, entry.scope, entry.path, entry.name].join('\u0000');

/**
 * What a check or an update found, written to the daily update check's file (design 2026-09-28 §1): when the registry
 * was asked, the latest release it named, whether anything here is still behind it, and — channel by channel — where
 * this machine is known to run it.
 *
 * So an update applied here is known at once, not a day later: a server started before it, every registration of
 * which the update moved, stops saying "update" and says "restart" instead. `after` is the update's result, when this
 * records one. Best effort, and skipped wherever the check is switched off: what was asked for is the report or the
 * update, and it is returned whether or not this lands.
 *
 * Whatever this writes is the newest word on the machine, so it gives up any claim a background check holds. `claim`,
 * when this is that background check's own finding, is the claim it was made under: the finding is dropped when the
 * file no longer holds it, because something newer — a check a person asked for, an update — was written meanwhile.
 * The machine it describes was read before that, and put back it would say "update" where "restart" is right.
 */
async function recordFound(
  core: Core,
  env: NodeJS.ProcessEnv,
  report: UpdateReport,
  deps: Pick<UpdateDeps, 'now'>,
  after: UpdateResult | null = null,
  claim?: string,
  release?: ReleaseFacts | null,
): Promise<void> {
  const latest = report.latest[CORE_PACKAGE];
  if (updateCheckSwitchedOff(env) !== null || latest === undefined || !isVersion(latest)) return;
  const at = (deps.now ?? (() => new Date()))().toISOString();
  const { behind, current } = updateCheckFindings(report, latest, after);
  // What the release declares, when this read it; what an earlier read found of another release counts for nothing.
  const facts = (record: { release: ReleaseFacts | null }) =>
    release !== undefined ? release : record.release?.version === latest ? record.release : null;
  await changeUpdateCheck(core.paths.stateDir, (record) =>
    claim !== undefined && record.checking !== claim
      ? null
      : {
          record: {
            ...record,
            lastChecked: at,
            latest,
            behind,
            current,
            lastError: null,
            checking: null,
            release: facts(record),
          },
        },
  ).catch(() => undefined);
}

/**
 * What a report says of `latest`, for the daily check's file: as the machine was, or — with `after` — as the update
 * left it.
 *
 * `behind` is the machine as a whole: true while anything is behind, or the update left something behind; null when
 * some of it could not be known — a configuration or the global packages unread, a registration that pins nothing to
 * compare; false only when all of it was seen and none of it is behind.
 *
 * `current` is each channel's own, and only what was seen, because it is what lets a server say "restart" instead of
 * "update" — advice that stops every call until it is taken, and that only works when restarting starts `latest`.
 * `registered`: there is a registration of the channel's server, every one pins `latest` (or was just registered
 * again at it), none pins nothing, and every client's configuration was read — one that was not may hold another.
 * `global`: the channel's own package is installed globally at `latest`, or was just now. A server nothing here
 * registers — a plugin's, an extension's, one started from a checkout — is in neither, and stays `update`.
 */
export function updateCheckFindings(
  report: UpdateReport,
  latest: string,
  after: UpdateResult | null = null,
): { behind: boolean | null; current: UpdateCurrent } {
  const moved = new Set<string>();
  const installed = new Set<string>();
  for (const step of after?.steps ?? []) {
    if (step.kind === 'registration' && step.outcome === 'registered' && step.verification !== 'failed') {
      moved.add(registrationKey(step));
    }
    if (step.kind === 'global' && step.outcome === 'updated') installed.add(step.package);
  }
  const atLatest = (version: string | null) => version !== null && isVersion(version) && !isBehind(version, latest);
  const items = [...report.behind, ...report.upToDate];
  const registrations = items.filter((item): item is RegistrationItem => item.kind === 'registration');
  const clientsUnread = report.unreadable.some((file) => file.client !== 'npm');
  const registered = clientsUnread
    ? []
    : CHANNELS.filter((channel) => {
        const own = registrations.filter((item) => item.channel === channel);
        return (
          own.length > 0 &&
          !report.unpinned.some((item) => item.channel === channel) &&
          own.every((item) => atLatest(moved.has(registrationKey(item)) ? item.latest : item.version))
        );
      });
  const globals = items.filter((item): item is GlobalItem => item.kind === 'global');
  const global = CHANNELS.filter((channel) => {
    const name = serverFacts(channel).packageName;
    return globals.some((item) => item.package === name && atLatest(installed.has(name) ? item.latest : item.version));
  });
  // What an update did not settle is still behind: a step that failed, or something left for a person.
  const stillBehind =
    after === null ? report.behind.length > 0 : !(after.ok && after.manual.length === 0 && after.status !== 'manual');
  const unknown = report.unreadable.length > 0 || report.unpinned.length > 0;
  return { behind: stillBehind ? true : unknown ? null : false, current: { registered, global } };
}

// ── The change ─────────────────────────────────────────────────────────────────────────────────────────────────

interface RegistrationStep {
  item: RegistrationItem & { version: string; launcher: Launcher };
  product: McpProduct;
  options: InstallOptions;
  /** What the plan's preflight found the install would do — the config file and the command among it — held to. */
  install: PlannedInstall;
  /** Where the entry goes and what it starts, as the preview says it: see `entryDestination`. */
  destination: string;
  /** The managed package CLI shim this registration writes or repoints. */
  shim?: string | undefined;
}

interface Planned {
  /** The report the plan was made from: what the daily check's file records, as the update leaves it. */
  report: UpdateReport;
  handoffs: CliHandoffs;
  latest: Record<string, string>;
  runtimes: RuntimeItem[];
  registrations: RegistrationStep[];
  globals: GlobalItem[];
  manual: RegistrationItem[];
  nothingBehind: boolean;
}

/**
 * What a registration may reach, as the preview of `mcp install` says it, in the channel's words: "pinned to the
 * mailbox …", "not pinned: it reaches every workspace on this machine". Empty for the core, which reaches no account.
 */
function reachOf(channel: ServerId, narrowing: Narrowing): string {
  const own = pinOption(channel);
  if (own === undefined || own === 'readOnly') return '';
  const noun = accountNoun(channel);
  const pin = narrowing[own];
  return [
    pin !== undefined ? `pinned to the ${noun} ${pin}` : `not pinned: it reaches every ${noun} on this machine`,
    narrowing.readOnly ? 'read-only' : '',
  ]
    .filter(Boolean)
    .join(', ');
}

/**
 * A registration as the sentences a person reads: one for the entry, and — for the npx launcher — one for what the
 * client will fetch, as `mcp install` says it. Short enough not to be cut: a preview shows each sentence to 300
 * characters, and the part cut off was the part about npm.
 */
function registrationEffects(step: RegistrationStep): string[] {
  const { item } = step;
  const reach = reachOf(item.channel, serverFacts(item.channel).narrowingOf(item.narrowing));
  const entry = `registers the ${serverLabel(item.channel)} MCP server with ${item.client} as "${item.name}" again (${item.scope} scope, ${item.launcher} launcher), at ${item.latest} in place of ${item.version}${reach ? ` — ${reach}, as now` : ''}`;
  // Where it goes and what it starts, as `mcp install` says it (#46): in the digest, so a claim from an environment
  // that resolves another config file or another command is another update.
  const effects = [entry, step.destination];
  if (step.shim)
    effects.push(`writes or repoints the owned CLI shim at ${step.shim}; a foreign file there is left unchanged`);
  if (item.launcher === 'npx') {
    effects.push(
      `${item.client} will fetch ${item.package}@${item.latest} from npm each time it starts "${item.name}"`,
    );
  }
  return effects;
}

/** Every step as the sentences a person reads, in the order the steps are taken. */
function effectsOf(planned: Planned): string[] {
  return [
    // The wording `mcp install` uses for the same act, so the two previews read alike.
    ...planned.runtimes.map((runtime) => `installs ${runtime.package}@${runtime.latest} from npm into ${runtime.path}`),
    ...planned.registrations.flatMap(registrationEffects),
    ...planned.globals.map(
      (global) =>
        `updates the global ${global.package} from ${global.version} to ${global.latest}: \`npm install -g ${global.package}@${global.latest}\``,
    ),
  ];
}

function counted(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The registrations the update moves: every candidate the install itself would go ahead with, as it would.
 *
 * Each is planned by `preflightInstall` — what `mcp install --force` runs before it writes anything — with the entry's
 * own name, client and launcher, and no pin: the pins are the install's own keep-the-pin rule's to carry over from the
 * entry it replaces, as they are for `mcp install --force`. What that rule arrives at has to be exactly what the entry
 * has. When it is not — the client itself reports the entry otherwise than its file does, say — registering again
 * would change what the server may reach, so the entry is left for a person rather than widened or narrowed.
 */
async function planRegistrations(
  context: InstallContext,
  candidates: readonly Found[],
  request: UpdateRequest,
  handoffs: CliHandoffs,
): Promise<{ steps: RegistrationStep[]; manual: RegistrationItem[] }> {
  const steps: RegistrationStep[] = [];
  const manual: RegistrationItem[] = [];
  const leave = (item: RegistrationItem, reason: string) => manual.push({ ...item, updatable: false, reason });
  const seen = new Set<string>();
  for (const { item } of candidates) {
    // One entry per name in a client: two copies of it — `servers` and an old `mcpServers` — are replaced as one.
    const key = `${item.client}\u0000${item.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const launcher = item.launcher as Launcher;
    const product = await serverProduct(item.channel, launcher, item.latest);
    const options: InstallOptions = {
      client: item.client as SupportedClient,
      name: item.name,
      launcher,
      force: true,
      noVerify: request.noVerify,
      apply: true,
    };
    let preflight: Awaited<ReturnType<typeof preflightInstall>>;
    try {
      preflight = await preflightInstall(context, product, options);
    } catch (error) {
      leave(item, toCommsError(error).message);
      continue;
    }
    const keeps = narrowingArgs(item.channel, preflight.effective);
    if (JSON.stringify(keeps) !== JSON.stringify(item.narrowing)) {
      leave(
        item,
        `registering it again would not keep exactly ${item.narrowing.length > 0 ? item.narrowing.join(' ') : 'no pin'}: ${item.client} itself has the entry as ${keeps.length > 0 ? keeps.join(' ') : 'not pinned'}. ${handoffSentence(installHandoff(item, handoffs), (command) => `Register it again yourself with the pins it should have: ${command}`)}`,
      );
      continue;
    }
    steps.push({
      item: item as RegistrationStep['item'],
      product,
      options,
      install: plannedInstall(preflight),
      destination: entryDestination(item.client, preflight.target, preflight.command, context.env),
      ...(launcher === 'managed' && managedShimsSupported(context)
        ? {
            shim: managedShimPath(
              { env: context.env, dataDir: context.core.paths.dataDir, platform: context.platform },
              product.binary,
            ),
          }
        : {}),
    });
  }
  return { steps, manual };
}

/**
 * The update, as a change: one approval for every step, applied in order on the second call.
 *
 * `plan` reads everything again on both calls — the registry, the clients, the runtimes, the global packages — so the
 * steps claimed are the steps as they would be taken at that moment, and a claim for any other list is refused.
 */
export function updateChange(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: UpdateRequest = {},
  deps: UpdateDeps = {},
): GatedChange<UpdateResult> {
  const context: InstallContext = { env, core, platform: deps.platform };
  let planned: Planned | null = null;
  return {
    plan: async (config) => {
      const inspection = await inspect(core, env, deps);
      const { steps, manual } = await planRegistrations(context, inspection.candidates, request, inspection.handoffs);
      const runtimes = await runtimesNeeded(
        core.paths.dataDir,
        inspection.report.latest,
        steps.map((step) => step.item),
      );
      planned = {
        report: inspection.report,
        latest: inspection.report.latest,
        runtimes,
        registrations: steps,
        globals: inspection.globals,
        handoffs: inspection.handoffs,
        manual: [...inspection.manual, ...manual],
        nothingBehind: inspection.report.behind.length === 0,
      };
      const parts = [
        steps.length > 0 ? counted(steps.length, 'registration', 'registrations') : '',
        runtimes.length > 0 ? counted(runtimes.length, 'runtime', 'runtimes') : '',
        inspection.globals.length > 0 ? counted(inspection.globals.length, 'global package', 'global packages') : '',
      ].filter(Boolean);
      return {
        before: config,
        after: config,
        effects: effectsOf(planned),
        summary:
          parts.length > 0
            ? `Update agent-communications to the latest release: ${parts.join(', ')}`
            : 'Check agent-communications against the latest release',
      };
    },
    apply: async () => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the update was applied before it was planned');
      const result = await applyUpdate(context, planned, deps);
      // What it moved to the latest release — and only what worked — is what lets a server or a command started
      // before this say "restart" rather than "update" from now on.
      await recordFound(core, env, planned.report, deps, result);
      return result;
    },
    refuseApproval: (approvalId) => {
      if (planned === null) throw new CommsError('UNEXPECTED', 'the update was refused before it was planned');
      return nothingToApply(core, approvalId, planned);
    },
  };
}

/**
 * The refusal for an approval handed to an update with no step left in it (CUE-303).
 *
 * An update needs an approval only for its steps, so one with none takes no approval, and the general refusal said to
 * call again without it, as "it applies at once". An approval is prepared for an update while something is behind,
 * and it is usually claimed minutes later; meanwhile another session, or the person at a terminal, may have applied
 * the update. Then nothing is behind, calling again applies nothing, and "applies at once" read as an update about to
 * happen. So this says what is so: there is nothing to apply — nothing behind at all, or nothing that can be updated
 * from here — and the approval was not used, with what had become of it.
 *
 * The store is asked as it is. Its `get` answers null for an approval it does not have, and throws for anything else:
 * an id that is not one, a record it cannot read or parse. Every one of those was caught and said as "not used" with
 * nothing more, so a corrupt approval file or a permissions problem read as an approval that was simply not there.
 * Now a record that cannot be read goes up as itself, as it would from any other call that reads an approval, and an
 * id that is not one is said to be that.
 */
async function nothingToApply(core: Core, approvalId: string, planned: Planned): Promise<CommsError> {
  // A check: comms_update with `check`, or this installation's own `update --check` at a terminal.
  const check = (say: (command: string) => string) =>
    handoffSentence(planned.handoffs.core(['update', '--check']), say);
  // Refused before the store is asked, in a change's words: the store's own refusal of it begins "nothing was sent".
  if (!APPROVAL_ID_PATTERN.test(approvalId)) {
    return new CommsError('USAGE', `nothing was changed: "${approvalId}" is not an approval id`, {
      hint: check(
        (command) =>
          `An approval id is the \`approvalId\` a call that needs approval returns, and nothing here needs one: a check — comms_update with \`check\`, or ${command} at a terminal — shows what is behind.`,
      ),
      details: { approvalId },
    });
  }
  const stored = await core.approvals.get(approvalId);
  // One that cannot be read safely is said to be that — never "not used", as though anything were known of it.
  const unused =
    stored !== null && corruptStubOf(stored) !== null
      ? `and the approval ${approvalId} was refused: ${whatBecameOf(stored)}`
      : `so there is nothing to apply; the approval ${approvalId} was not used (${whatBecameOf(stored)})`;
  const details = { approvalId, ...(stored ? { state: stateOf(stored) } : {}) };
  if (planned.nothingBehind) {
    return new CommsError('USAGE', `nothing was changed: nothing is behind the latest release, ${unused}`, {
      hint: check(
        (command) =>
          `Nothing needs doing: a check — comms_update with \`check\`, or ${command} at a terminal — shows everything here up to date. A release published later is another update, with a preview and an approval of its own.`,
      ),
      details,
    });
  }
  return new CommsError('USAGE', `nothing was changed: what is behind cannot be updated from here, ${unused}`, {
    hint: check(
      (command) =>
        `Each is left for a person: a check — comms_update with \`check\`, or ${command} at a terminal — lists them, with why and what to run. The same call without the approval reports them too, and changes nothing.`,
    ),
    details,
  });
}

/**
 * What had become of an approval, for `nothingToApply`: none at all, or each state an approval can be in, by name.
 *
 * A record, so that a state added to the store is a type error here rather than a refusal that says nothing. The
 * send states are here too: any approval's id can be handed to an update, a send's among them, and this reads the
 * record before anything looks at its kind.
 */
function whatBecameOf(stored: StoredApproval | null): string {
  if (stored === null) return 'there is no approval by that id';
  // Read safely or not at all: a record that cannot be is said to be that, by its fixed reason alone.
  const stub = corruptStubOf(stored);
  if (stub !== null) return `it could not be read safely (${stub.reason})`;
  if (stored.form === 'legacy') {
    return `it was prepared by an earlier release, and is ${stored.view.state}; this release does not use it`;
  }
  if (stored.form !== 'v2') return 'it could not be read safely';
  const record = stored.record;
  const states: Record<ApprovalState, string> = {
    pending: `it was still waiting to be approved, and lapses at ${record.expiresAt}`,
    approved: `it had been approved, and lapses unspent at ${record.expiresAt}`,
    sending: 'it is an approval to send, and that send is under way',
    used: 'it had been spent already',
    failed: 'it had been spent on a send that failed',
    unknown: 'it had been spent on a send whose outcome was never recorded',
    expired: `it had expired at ${record.expiresAt}`,
    revoked: 'it had been revoked',
  };
  // A record written by a later version, or by hand, can hold a state this one has never heard of: named as it is.
  return states[record.state] ?? `it is ${JSON.stringify(record.state)}, a state this version does not know`;
}

/** The product a runtime of `packageName` is installed as: the declared server whose package it is. */
function runtimeProduct(packageName: string, version: string): Promise<McpProduct> {
  const channel = SERVERS.find((each) => serverFacts(each).packageName === packageName);
  if (channel === undefined) throw new CommsError('UNEXPECTED', `${packageName} is not a declared server package`);
  return serverProduct(channel, 'managed', version);
}

/**
 * Every declared server's `mcp prune`, as a person runs it at a terminal: each channel command is located among this
 * machine's registrations, and each service uses core — never a bare name (CUE-403).
 */
function pruneCommands(handoffs: CliHandoffs): string {
  return handoffChoices(
    SERVERS.map((channel) =>
      isChannel(channel)
        ? handoffs.of(channel, ['mcp', 'prune'])
        : handoffs.core(['mcp', 'prune', '--server', channel]),
    ),
    'none of their commands is locatable here:',
    { conjunction: 'and' },
  );
}

function message(error: unknown): string {
  return error instanceof CommsError ? error.message : error instanceof Error ? error.message : String(error);
}

async function applyUpdate(context: InstallContext, planned: Planned, deps: UpdateDeps): Promise<UpdateResult> {
  const installRuntime =
    deps.installRuntime ??
    (async (packageName: string, version: string) => {
      await installManagedRuntime(context, await runtimeProduct(packageName, version), version);
    });
  const installGlobal = deps.installGlobal ?? ((spec: string) => npmInstallGlobal(context.env, spec));
  const steps: UpdateStep[] = [];

  // The runtimes first: a registration whose runtime could not be installed is not attempted, and stays as it was.
  const missing = new Set<string>();
  for (const runtime of planned.runtimes) {
    const base = {
      kind: 'runtime' as const,
      channel: runtime.channel,
      package: runtime.package,
      version: runtime.latest,
      path: runtime.path,
    };
    try {
      await installRuntime(runtime.package, runtime.latest);
      steps.push({ ...base, outcome: 'installed' });
    } catch (error) {
      missing.add(runtime.package);
      steps.push({ ...base, outcome: 'failed', detail: message(error) });
    }
  }

  for (const { item, product, options, install } of planned.registrations) {
    const base = {
      kind: 'registration' as const,
      channel: item.channel,
      client: item.client,
      name: item.name,
      scope: 'user' as const,
      path: item.path,
      launcher: item.launcher,
      from: item.version,
      to: item.latest,
      narrowing: item.narrowing,
    };
    if (item.launcher === 'managed' && missing.has(product.packageName)) {
      steps.push({
        ...base,
        outcome: 'skipped',
        detail: `its runtime ${product.packageName}@${item.latest} could not be installed, so the entry was left as it was`,
      });
      continue;
    }
    try {
      // The pins the plan checked the install's own keep-the-pin rule arrives at, given outright: the entry is written
      // with exactly those whatever it finds to replace now, and says nothing of keeping what it was told.
      const pins = serverFacts(item.channel).narrowingOf(item.narrowing);
      // Held to what the plan found — the file, the client CLI, the entry replaced and the command it starts — so
      // nothing is looked for again and registered in its place.
      const installed = await mcpInstall(context, product, { ...options, ...pins }, install);
      if (!installed.applied) {
        steps.push({ ...base, outcome: 'failed', detail: installed.notApplied ?? 'nothing was registered' });
        continue;
      }
      // The entry moved, so its owned CLI shim moves with it, as `mcp install` moves it.
      const result = await withManagedShim(context, product, installed);
      steps.push({
        ...base,
        outcome: 'registered',
        verification: result.verification,
        ...(result.verifyDetail !== undefined ? { detail: result.verifyDetail } : {}),
        ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.shim !== undefined ? { shim: result.shim } : {}),
      });
    } catch (error) {
      steps.push({ ...base, outcome: 'failed', detail: message(error) });
    }
  }

  // Last: a global package may be the very command running this, and npm replaces it underneath.
  for (const global of planned.globals) {
    const base = { kind: 'global' as const, package: global.package, from: global.version, to: global.latest };
    try {
      await installGlobal(`${global.package}@${global.latest}`);
      steps.push({ ...base, outcome: 'updated' });
    } catch (error) {
      steps.push({ ...base, outcome: 'failed', detail: message(error) });
    }
  }

  const worked = (step: UpdateStep) =>
    step.kind === 'registration'
      ? step.outcome === 'registered' && step.verification !== 'failed'
      : step.outcome !== 'failed';
  const ok = steps.every(worked);
  const status: UpdateResult['status'] =
    steps.length === 0 ? (planned.nothingBehind ? 'up-to-date' : 'manual') : ok ? 'updated' : 'failed';
  const clients = [
    ...new Set(
      steps.flatMap((step) => (step.kind === 'registration' && step.outcome === 'registered' ? [step.client] : [])),
    ),
  ];
  const next =
    clients.length > 0
      ? `Restart ${clients.length === 1 ? clients[0] : `${clients.slice(0, -1).join(', ')} and ${clients.at(-1)}`} to load the new servers: no MCP client loads a new server into a session that is already running. Then, from the restarted server, prune the runtimes the old versions leave behind: comms_server_prune for each channel — at a terminal, ${pruneCommands(planned.handoffs)}.`
      : null;
  return { status, latest: planned.latest, steps, manual: planned.manual, ok, next };
}
