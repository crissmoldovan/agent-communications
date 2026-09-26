import type { GatedChange } from '../change-flow.ts';
import { CHANNEL_LABELS, CHANNEL_SERVERS, CHANNELS, type Channel } from '../channel-servers.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError, toCommsError } from '../errors.ts';
import { type RegisteredServer, scanRegisteredServers, type UnreadableConfig } from '../mcp-clients.ts';
import {
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
  pinnedVersion,
  preflightInstall,
  reusableRuntime,
  type SupportedClient,
} from '../mcp-install.ts';
import { resolveName } from '../names.ts';
import { compareVersions, isBehind, isVersion, npmGlobalPackages, npmInstallGlobal, npmLatestVersion } from '../npm.ts';
import { VERSION } from '../version.ts';
import { channelProduct, launcherOf } from './servers.ts';

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

/** The packages this suite publishes, whose latest releases an update reads. */
const PUBLISHED = Object.freeze({
  core: CHANNEL_SERVERS.core.packageName,
  gmail: CHANNEL_SERVERS.gmail.packageName,
  gmailMcp: CHANNEL_SERVERS.gmail.npxPackage,
  slack: CHANNEL_SERVERS.slack.packageName,
});
const PUBLISHED_NAMES: readonly string[] = Object.freeze([...new Set(Object.values(PUBLISHED))].sort());

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
}

export interface UpdateRequest {
  /** Do not start each server registered again to check that it answers. */
  noVerify?: boolean | undefined;
}

/** One client's registration of one channel's server. */
export interface RegistrationItem {
  kind: 'registration';
  channel: Channel;
  /** The package the entry starts: the channel's, or for Gmail started through npx, `@agentcomms/gmail-mcp`. */
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
  channel: Channel;
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
      channel: Channel;
      package: string;
      version: string;
      path: string;
      outcome: 'installed' | 'failed';
      detail?: string | undefined;
    }
  | {
      kind: 'registration';
      channel: Channel;
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
  /** Behind, and updatable as far as the files show. */
  candidates: Found[];
  /** Behind, and not updatable from here. */
  manual: RegistrationItem[];
  globals: GlobalItem[];
}

function narrowingArgs(channel: Channel, narrowing: Narrowing): string[] {
  return CHANNEL_SERVERS[channel].serverArgs({ client: 'json', ...narrowing });
}

/** Every registration of every channel's server, as the core's `channels` finds them — nothing an `env` holds. */
function registrations(servers: readonly RegisteredServer[]): { channel: Channel; server: RegisteredServer }[] {
  return CHANNELS.flatMap((channel) =>
    servers
      .filter((server) => isProductServer(server, CHANNEL_SERVERS[channel]))
      .map((server) => ({ channel, server })),
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

/** How to register an entry again by hand: its channel's own `mcp install`, with every flag that decides its reach. */
function installCommand(item: RegistrationItem): string {
  const facts = CHANNEL_SERVERS[item.channel];
  const words = [facts.binary, 'mcp', 'install', '--client', item.client];
  if (item.name !== facts.defaultServerName) words.push('--name', item.name);
  words.push(...item.narrowing, '--force');
  return words.join(' ');
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
): Promise<string | undefined> {
  if (item.launcher !== 'managed' && item.launcher !== 'npx') {
    return `it was not written by \`mcp install\`, so how it starts cannot be carried over; register it again with \`${installCommand(item)}\``;
  }
  if (item.scope !== 'user') {
    return `it is registered for one project (in ${item.path}), and \`mcp install\` registers at user scope only; register it again from that project with ${item.client}'s own command`;
  }
  // Every client the scan reads is one `mcp install` registers with: it reads the files of exactly those.
  const target = await installTarget(context, { client: item.client as SupportedClient, apply: true });
  if (!target.writes) {
    return target.cliName
      ? `\`${target.cliName}\` is not on PATH, so the entry cannot be replaced from here; run \`${installCommand(item)}\` where it is`
      : `this environment names no ${item.client} configuration to write to`;
  }
  if (narrowing.inbox !== undefined || narrowing.workspace !== undefined) {
    if (config === null) return 'the configuration could not be read, so the account it is pinned to cannot be checked';
    try {
      if (narrowing.inbox !== undefined) resolveName(config, 'inbox', narrowing.inbox);
      if (narrowing.workspace !== undefined) resolveName(config, 'account', narrowing.workspace);
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
  for (const channel of CHANNELS) {
    const packageName = CHANNEL_SERVERS[channel].packageName;
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
  const context: InstallContext = { env, core };
  const scan = await scanRegisteredServers(env);
  const unreadable: UnreadableConfig[] = [...scan.unreadable];
  const found = registrations(scan.servers).map(({ channel, server }) => {
    const facts = CHANNEL_SERVERS[channel];
    const narrowing = facts.narrowingOf(server.args);
    return {
      channel,
      server,
      narrowing,
      version: server.args.map((arg) => pinnedVersion(arg, facts)).find((pinned) => pinned !== null) ?? null,
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

  // Gmail's npx package only when something starts it or it is installed: the other three always.
  const wanted = new Set([PUBLISHED.core, PUBLISHED.gmail, PUBLISHED.slack]);
  if (found.some((entry) => entry.package === PUBLISHED.gmailMcp) || PUBLISHED.gmailMcp in installed) {
    wanted.add(PUBLISHED.gmailMcp);
  }
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
      launcher: launcherOf(entry.server, CHANNEL_SERVERS[entry.channel]),
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
    const reason = await whyNotUpdatable(context, config, item, entry.narrowing);
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
  for (const channel of CHANNELS) {
    const packageName = CHANNEL_SERVERS[channel].packageName;
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
    candidates,
    manual,
    globals,
  };
}

/**
 * What is behind the latest release on this machine, and what is not. Reads the registry and this machine; writes
 * nothing and asks nobody. `agentcomms update --check` and `comms_update` with `check`.
 */
export async function updateCheck(core: Core, env: NodeJS.ProcessEnv, deps: UpdateDeps = {}): Promise<UpdateReport> {
  return (await inspect(core, env, deps)).report;
}

// ── The change ─────────────────────────────────────────────────────────────────────────────────────────────────

interface RegistrationStep {
  item: RegistrationItem & { version: string; launcher: Launcher };
  product: McpProduct;
  options: InstallOptions;
}

interface Planned {
  latest: Record<string, string>;
  runtimes: RuntimeItem[];
  registrations: RegistrationStep[];
  globals: GlobalItem[];
  manual: RegistrationItem[];
  nothingBehind: boolean;
}

/** What a registration may reach, as the preview of `mcp install` says it. Empty for the core, which reaches no account. */
function reachOf(channel: Channel, narrowing: Narrowing): string {
  if (channel === 'gmail') {
    return [
      narrowing.inbox !== undefined
        ? `pinned to the mailbox ${narrowing.inbox}`
        : 'not pinned: it reaches every mailbox on this machine',
      narrowing.readOnly ? 'read-only' : '',
    ]
      .filter(Boolean)
      .join(', ');
  }
  if (channel === 'slack') {
    return narrowing.workspace !== undefined
      ? `pinned to the workspace ${narrowing.workspace}`
      : 'not pinned: it reaches every workspace on this machine';
  }
  return '';
}

/**
 * A registration as the sentences a person reads: one for the entry, and — for the npx launcher — one for what the
 * client will fetch, as `mcp install` says it. Short enough not to be cut: a preview shows each sentence to 300
 * characters, and the part cut off was the part about npm.
 */
function registrationEffects(step: RegistrationStep): string[] {
  const { item } = step;
  const reach = reachOf(item.channel, CHANNEL_SERVERS[item.channel].narrowingOf(item.narrowing));
  const entry = `registers the ${CHANNEL_LABELS[item.channel]} MCP server with ${item.client} as "${item.name}" again (${item.scope} scope, ${item.launcher} launcher), at ${item.latest} in place of ${item.version}${reach ? ` — ${reach}, as now` : ''}`;
  return item.launcher === 'npx'
    ? [entry, `${item.client} will fetch ${item.package}@${item.latest} from npm each time it starts "${item.name}"`]
    : [entry];
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
    const product = await channelProduct(item.channel, launcher, item.latest);
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
        `registering it again would not keep exactly ${item.narrowing.length > 0 ? item.narrowing.join(' ') : 'no pin'}: ${item.client} itself has the entry as ${keeps.length > 0 ? keeps.join(' ') : 'not pinned'}. Register it again yourself with the pins it should have: \`${installCommand(item)}\``,
      );
      continue;
    }
    steps.push({ item: item as RegistrationStep['item'], product, options });
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
  const context: InstallContext = { env, core };
  let planned: Planned | null = null;
  return {
    plan: async (config) => {
      const inspection = await inspect(core, env, deps);
      const { steps, manual } = await planRegistrations(context, inspection.candidates, request);
      const runtimes = await runtimesNeeded(
        core.paths.dataDir,
        inspection.report.latest,
        steps.map((step) => step.item),
      );
      planned = {
        latest: inspection.report.latest,
        runtimes,
        registrations: steps,
        globals: inspection.globals,
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
      return applyUpdate(context, planned, deps);
    },
  };
}

/** The product a runtime of `packageName` is installed as: the channel whose package it is. */
function runtimeProduct(packageName: string, version: string): Promise<McpProduct> {
  const channel = CHANNELS.find((each) => CHANNEL_SERVERS[each].packageName === packageName);
  if (channel === undefined) throw new CommsError('UNEXPECTED', `${packageName} is not a channel's package`);
  return channelProduct(channel, 'managed', version);
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

  for (const { item, product, options } of planned.registrations) {
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
      const pins = CHANNEL_SERVERS[item.channel].narrowingOf(item.narrowing);
      const result = await mcpInstall(context, product, { ...options, ...pins });
      if (!result.applied) {
        steps.push({ ...base, outcome: 'failed', detail: result.notApplied ?? 'nothing was registered' });
        continue;
      }
      steps.push({
        ...base,
        outcome: 'registered',
        verification: result.verification,
        ...(result.verifyDetail !== undefined ? { detail: result.verifyDetail } : {}),
        ...(result.backupPath !== undefined ? { backupPath: result.backupPath } : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
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
      ? `Restart ${clients.length === 1 ? clients[0] : `${clients.slice(0, -1).join(', ')} and ${clients.at(-1)}`} to load the new servers: no MCP client loads a new server into a session that is already running. Then, from the restarted server, prune the runtimes the old versions leave behind: comms_server_prune for each channel — at a terminal, \`agentcomms mcp prune\`, \`agent-gmail mcp prune\` and \`agent-slack mcp prune\`.`
      : null;
  return { status, latest: planned.latest, steps, manual: planned.manual, ok, next };
}
