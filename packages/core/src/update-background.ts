import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { AuditRecord } from './audit.ts';
import { SERVERS, type ServerId, serverFacts, serverLabel } from './channel-servers.ts';
import type { Config, UpdateLevel } from './config.ts';
import type { Core } from './core.ts';
import { toCommsError } from './errors.ts';
import { writeFileAtomic } from './fs.ts';
import {
  exchangePointer,
  type LauncherPointer,
  launcherName,
  launcherRuntimeVersion,
  readPointer,
  restorePointer,
} from './launcher.ts';
import { withFileLock } from './lock.ts';
import { displayUrl } from './mcp-clients.ts';
import {
  type InstallContext,
  installManagedRuntime,
  listManagedRuntimes,
  type McpProduct,
  managedRuntimeDir,
  managedRuntimeEntry,
  pruneManagedRuntimes,
  reusableRuntime,
  runningCommandLines,
  verifyEntry,
} from './mcp-install.ts';
import { REGISTRY_TIMEOUT_MS, registryUrl } from './npm.ts';
import { childEnvironment } from './system-programs.ts';
import { backgroundJobAtRun, recordUpdateJobRun, type UpdateJobDeps, updateJobContext } from './update-job.ts';
import { withUpdateLock } from './update-lock.ts';
import {
  type ProvenanceDeps,
  type ProvenanceVerdict,
  sigstoreBundleVerifier,
  type VerifiedProvenance,
  verifyProvenance,
} from './update-provenance.ts';
import {
  type BackgroundNotice,
  changeUpdateCheck,
  configuredUpdates,
  pauseEnd,
  readUpdateCheck,
  type UpdateCheckRecord,
  updateCheckSwitchedOff,
} from './update-state.ts';
import { VERSION } from './version.ts';
import { compareVersions, isPrerelease, isVersion } from './versions.ts';

/**
 * One background run (design 2026-10-16 U5; plan Track D): what the per-user job (Track C) starts once a day, as
 * `update --background`, with no terminal and no agent. It never sends, posts or approves anything, and it changes only
 * what U5 lists — a new runtime per package, each stable launcher's pointer, the runtimes older than the previous
 * release, one audit line, and the notice the next session shows.
 *
 * 1. **Settings.** Track A's, through `updateSettingsReader`: unless the level in force is `auto` and no organisation
 *    turns background updates off, Track C's `backgroundJobAtRun` is called — it removes the job an organisation
 *    turned off — and the run stops.
 * 2. **The registry.** `latest` of the core. Never automatic: a major version, a release whose core manifest declares
 *    `agentcommsRelease.needsDecision`, a downgrade — each a notice. Held: a release that was rolled back, until a
 *    newer one exists (`update-held.json`); one published under 72 hours ago, or 24 for `agentcommsRelease.security`.
 *    A pause holds everything but a security fix.
 * 3. **Provenance** of every package to install (`update-provenance.ts`). Any refusal stops the whole run: nothing is
 *    installed.
 * 4. **Install** each into a runtime of its own, as `comms_update` does; then check each: the installed package is the
 *    tarball whose provenance was verified, its CLI's `--version` is the release, and its server answers MCP
 *    `initialize` started with no account to reach.
 * 5. **Switch** every pointer only once every package has verified and checked. One switch that fails puts back those
 *    already switched: a release is switched whole or not at all (plan, Review focus 3).
 * 6. **Audit** every run, and prune what is older than the previous release with the prune's own in-use checks.
 * 7. **The notice** for the next session, in the update state file.
 *
 * The clock is the earlier of this machine's and the registry's (its `Date`), so a clock that jumps ahead skips no
 * hold and ends no pause early; one that goes back only holds longer (plan, Review focus 2).
 */

/** What a run reads of the person's and the organisation's settings: Track A's, through `updateSettingsReader`. */
export interface UpdateSettingsReader {
  level(): UpdateLevel;
  /**
   * The end of a pause (U3), when one holds at `at` — the run's clock, the earlier of this machine's and the
   * registry's, so a clock that jumps ahead ends no pause early.
   */
  pausedUntil(at?: Date): Date | undefined;
  /** Whether an organisation profile allows background updates (U8): false for `updates.background: false`. */
  background(): boolean;
}

/**
 * Track A's settings, as a run reads them (design 2026-10-16, U2, U3, U8): the level in force — the one set, capped by
 * the organisations' caps (`configuredUpdates`) — the pause the person asked for, read as the notice reads it
 * (`pauseEnd`, never longer than 14 days from when it was asked), and whether any organisation turns background updates
 * off. The environment's switches are the run's own first step, before any of this.
 */
export function updateSettingsReader(config: Config, record: UpdateCheckRecord, now: Date): UpdateSettingsReader {
  const updates = configuredUpdates(config);
  return {
    level: () => updates.level,
    pausedUntil: (at = now) => pauseEnd(record, at) ?? undefined,
    background: () => updates.backgroundOff === undefined,
  };
}

/** What the run reads of a package's document on the registry: its tags, its versions' manifests, when each came out. */
export interface Packument {
  'dist-tags'?: Record<string, unknown> | undefined;
  versions?: Record<string, { agentcommsRelease?: unknown; dist?: { integrity?: unknown } } | undefined> | undefined;
  time?: Record<string, unknown> | undefined;
}

/** A package's document, and when the registry served it (its `Date`), when it said. */
export interface RegistryAnswer {
  packument: Packument;
  servedAt?: Date | undefined;
}

export type ReleaseRegistry = (packageName: string) => Promise<RegistryAnswer>;

/** One package's check after installing: what was run, and how it went. */
export type SelfCheck = (subject: {
  channel: ServerId;
  packageName: string;
  version: string;
  runtime: string;
}) => Promise<{ ok: boolean; detail: string }>;

export interface BackgroundDeps {
  settings?: UpdateSettingsReader | undefined;
  registry?: ReleaseRegistry | undefined;
  provenance?: ProvenanceDeps | undefined;
  /** Installs `packageName@version` into its runtime, as `comms_update` does; answers where. */
  install?: ((packageName: string, version: string) => Promise<string>) | undefined;
  selfCheck?: SelfCheck | undefined;
  /** Every running process's command line, or null when they cannot be listed: what prune and install keep for. */
  processes?: (() => Promise<readonly string[] | null>) | undefined;
  now?: (() => Date) | undefined;
  /** For Track C's `backgroundJobAtRun`: its runner, so a test never removes a real job. */
  job?: UpdateJobDeps | undefined;
  platform?: NodeJS.Platform | undefined;
}

export interface BackgroundRequest {
  /** Say what it would do, and why, with the provenance it verified; change nothing. */
  dryRun?: boolean | undefined;
}

/**
 * - `off`: this process's environment turned updates off (`CI`, the switch). `not-auto`: the level or the organisation
 *   does not install in the background. `busy`: another run holds the lock. `no-launchers`: nothing here starts a
 *   stable launcher. `unavailable`: the registry could not be read.
 * - `up-to-date`, `paused`, `held`: nothing to do yet. `skipped`: a release that waits for the person. `refused`: its
 *   provenance did not verify. `failed`: installing, checking or switching did not work, and nothing was switched.
 * - `installed`: switched. `would-install`: a dry run that found everything verified.
 */
export type BackgroundOutcome =
  | 'off'
  | 'not-auto'
  | 'busy'
  | 'no-launchers'
  | 'unavailable'
  | 'up-to-date'
  | 'paused'
  | 'held'
  | 'skipped'
  | 'refused'
  | 'failed'
  | 'installed'
  | 'would-install';

/** One package of the release, and what the run did with it. */
export interface BackgroundPackage {
  channel: ServerId;
  package: string;
  /** The release its stable launcher starts now, or null when its folder names none. */
  from: string | null;
  to: string;
  /** Where the release's runtime is, or would be. */
  runtime: string;
  provenance?: VerifiedProvenance | undefined;
  installed?: boolean | undefined;
  checked?: boolean | undefined;
  switched?: boolean | undefined;
  detail?: string | undefined;
}

export interface BackgroundRunResult {
  outcome: BackgroundOutcome;
  dryRun: boolean;
  /** The release this machine runs — what core's stable launcher starts — and the latest the registry names. */
  current: string | null;
  latest: string | null;
  /** Why the run did what it did, in a sentence. */
  reason: string;
  /** The release considered, when there was one: when it came out, what it declares, and when it may install. */
  release?:
    | {
        version: string;
        publishedAt: string | null;
        security: boolean;
        needsDecision: string | null;
        holdHours: number;
        installableAt: string | null;
      }
    | undefined;
  packages: BackgroundPackage[];
  /** Runtimes removed after the switch: older than the previous release, and in use by nothing. */
  pruned: { path: string; version: string }[];
  /** What the next session is told — on a dry run, what it would be told — or null for nothing. */
  notice: string | null;
  /** Whether the job was removed, because an organisation turned background updates off. */
  jobRemoved: boolean;
}

/** The holds (U5 step 2): hours after publish. */
export const HOLD_HOURS = 72;
export const SECURITY_HOLD_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** `<state>/update-held.json`: the releases a person rolled back from, which no background run installs again. */
export const UPDATE_HELD_FILE = 'update-held.json';

const CORE: ServerId = 'core';
const RESTART =
  'restart each MCP client that starts these servers (in Claude Code, /mcp and then Reconnect) to use it: a server already running keeps the code it started with';

// ── The releases a person rolled back from ───────────────────────────────────────────────────────────────────────

export function updateHeldPath(stateDir: string): string {
  return join(stateDir, UPDATE_HELD_FILE);
}

/** The releases held, each with when it was rolled back from; null when the file is there and cannot be read. */
export async function readHeldReleases(stateDir: string): Promise<Map<string, string> | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(updateHeldPath(stateDir), 'utf8'));
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? new Map() : null;
  }
  const held = (parsed as { held?: unknown } | null)?.held;
  if (!Array.isArray(held)) return null;
  const releases = new Map<string, string>();
  for (const entry of held) {
    const { version, at } = (entry ?? {}) as Record<string, unknown>;
    if (!isVersion(version) || typeof at !== 'string') return null;
    releases.set(version, at);
  }
  return releases;
}

/**
 * Records a rollback for the background run (U6 with U5): every release it went back from is held, and the release it
 * went to is not — a second rollback, which goes forward again, is the person choosing that release. Clears the next
 * session's "installed; restart" for a release now held: restarting would not start it.
 */
export async function holdRolledBack(
  stateDir: string,
  rolled: { from: readonly string[]; to: readonly string[] },
  now: Date = new Date(),
): Promise<string[]> {
  return withFileLock(
    join(stateDir, '.update-held.lock'),
    async () => {
      const held = (await readHeldReleases(stateDir)) ?? new Map<string, string>();
      for (const version of rolled.to) held.delete(version);
      for (const version of rolled.from) if (isVersion(version)) held.set(version, now.toISOString());
      const list = [...held].map(([version, at]) => ({ version, at }));
      await writeFileAtomic(updateHeldPath(stateDir), `${JSON.stringify({ held: list }, null, 2)}\n`);
      await changeUpdateCheck(stateDir, (record) =>
        record.backgroundNotice?.outcome === 'installed' &&
        record.backgroundNotice.version !== null &&
        held.has(record.backgroundNotice.version)
          ? { record: { ...record, backgroundNotice: null } }
          : null,
      );
      return [...held.keys()];
    },
    { timeoutMs: 5_000 },
  );
}

// ── The registry ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * The registry npm itself reads, asked for a package's full document — the one that says when each version came out.
 * A mirror's address with a user and password in it means basic authentication, as `npmLatestVersion` sends it. It
 * fails rather than guesses, naming the registry by its host only.
 */
export function npmRegistry(env: NodeJS.ProcessEnv): ReleaseRegistry {
  return async (packageName) => {
    const base = registryUrl(env);
    const where = displayUrl(base) ?? 'the npm registry';
    const url = new URL(packageName.replace('/', '%2f'), base);
    const headers: Record<string, string> = { accept: 'application/json' };
    if (url.username || url.password) {
      const user = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
      headers.authorization = `Basic ${Buffer.from(user).toString('base64')}`;
      url.username = '';
      url.password = '';
    }
    let response: Response;
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS) });
    } catch {
      throw new Error(`${where} could not be reached`);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`${where} answered ${response.status} for ${packageName}`);
    }
    let packument: Packument;
    try {
      packument = (await response.json()) as Packument;
    } catch {
      throw new Error(`${where} answered something that is not JSON for ${packageName}`);
    }
    const date = Date.parse(response.headers.get('date') ?? '');
    return { packument, ...(Number.isFinite(date) ? { servedAt: new Date(date) } : {}) };
  };
}

/** What a release's core manifest declares (U5): a security fix, and a decision it needs from the person. */
function releaseFlags(manifest: { agentcommsRelease?: unknown } | undefined): {
  security: boolean;
  needsDecision: string | null;
} {
  const declared = manifest?.agentcommsRelease;
  if (declared === undefined || declared === null) return { security: false, needsDecision: null };
  // A declaration this release cannot read waits for the person: it may be the decision it cannot see.
  if (typeof declared !== 'object' || Array.isArray(declared)) {
    return { security: false, needsDecision: 'its release declaration cannot be read' };
  }
  const { security, needsDecision } = declared as Record<string, unknown>;
  const decision =
    needsDecision === undefined || needsDecision === null || needsDecision === false
      ? null
      : typeof needsDecision === 'string' && needsDecision.trim()
        ? needsDecision.trim().slice(0, 200)
        : 'its release says it needs one';
  return { security: security === true, needsDecision: decision };
}

function majorOf(version: string): string {
  return version.split('.')[0] ?? version;
}

// ── One run ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** A package this machine starts through a stable launcher, and the release its pointer names. */
interface Launched {
  channel: ServerId;
  packageName: string;
  name: string;
  pointer: LauncherPointer;
  version: string | null;
}

async function launchedPackages(dataDir: string): Promise<Launched[]> {
  const found: Launched[] = [];
  for (const channel of SERVERS) {
    const { packageName } = serverFacts(channel);
    const name = launcherName(packageName);
    // A pointer that cannot be read is refused by `readPointer`, and the run with it: what it names may be in use.
    const pointer = await readPointer(dataDir, name);
    if (pointer === undefined) continue;
    found.push({ channel, packageName, name, pointer, version: launcherRuntimeVersion(pointer.current, name) });
  }
  return found;
}

function product(channel: ServerId, version: string): McpProduct {
  return { ...serverFacts(channel), version, moduleUrl: '' };
}

/** The integrity npm recorded for the package it installed into a runtime, from the runtime's own lockfile. */
async function installedIntegrity(runtime: string, packageName: string): Promise<string | null> {
  try {
    const lock = JSON.parse(await readFile(join(runtime, 'package-lock.json'), 'utf8')) as {
      packages?: Record<string, { integrity?: unknown } | undefined>;
    };
    const integrity = lock.packages?.[`node_modules/${packageName}`]?.integrity;
    return typeof integrity === 'string' ? integrity : null;
  } catch {
    return null;
  }
}

/** A command run to its end, its stdout read, given up on after `timeoutMs`. */
function capture(command: string, args: string[], env: NodeJS.ProcessEnv, timeoutMs: number): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    execFile(command, args, { env, timeout: timeoutMs, encoding: 'utf8', windowsHide: true }, (error, stdout) => {
      if (error) reject(new Error(error.message.slice(0, 300)));
      else resolvePromise(stdout);
    });
  });
}

/**
 * The offline self-check (U5 step 4): the runtime's CLI says it is `version`, and its server answers MCP `initialize`
 * and lists its tools — started, both times, with every folder in an empty temporary directory and the update check
 * off, so it reaches no account, no secret and no registry.
 */
export function offlineSelfCheck(env: NodeJS.ProcessEnv, dataDir: string, platform?: NodeJS.Platform): SelfCheck {
  return async ({ channel, packageName, version }) => {
    const cli = managedRuntimeEntry(dataDir, packageName, version);
    const scratch = await mkdtemp(join(tmpdir(), 'comms-self-check-'));
    try {
      const pins = ['config', 'state', 'data', 'secrets'].flatMap((folder) => [
        `--${folder}-dir`,
        join(scratch, folder),
      ]);
      const own = childEnvironment(env, platform);
      const isolated: Record<string, string> = {
        ...Object.fromEntries(Object.entries(own).filter((entry): entry is [string, string] => entry[1] !== undefined)),
        HOME: scratch,
        USERPROFILE: scratch,
        AGENT_COMMS_UPDATE_CHECK: 'off',
        NO_COLOR: '1',
      };
      const said = (await capture(process.execPath, [cli, '--version'], isolated, 30_000)).trim();
      if (said !== version)
        return { ok: false, detail: `its CLI says it is ${JSON.stringify(said.slice(0, 40))}, not ${version}` };
      const answered = await verifyEntry(
        { command: process.execPath, args: [cli, ...pins, 'mcp'], env: isolated },
        product(channel, version),
      );
      return answered.ok
        ? { ok: true, detail: `its CLI says ${version}, and ${answered.detail}` }
        : { ok: false, detail: `its server did not answer: ${answered.detail}` };
    } catch (error) {
      return { ok: false, detail: toCommsError(error).message };
    } finally {
      await rm(scratch, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

interface Run {
  core: Core;
  env: NodeJS.ProcessEnv;
  deps: BackgroundDeps;
  dryRun: boolean;
  now: Date;
}

type Settled = Omit<BackgroundRunResult, 'dryRun' | 'pruned' | 'jobRemoved'> & {
  pruned?: BackgroundRunResult['pruned'];
  jobRemoved?: boolean;
  /** The notice's outcome, for the state file, when the run leaves one. */
  noticeOutcome?: BackgroundNotice['outcome'];
};

function stop(
  outcome: BackgroundOutcome,
  reason: string,
  facts: Pick<BackgroundRunResult, 'current' | 'latest'> &
    Partial<Pick<BackgroundRunResult, 'release' | 'packages'>> = {
    current: null,
    latest: null,
  },
  notice?: { text: string; outcome: BackgroundNotice['outcome'] },
): Settled {
  return {
    outcome,
    reason,
    current: facts.current,
    latest: facts.latest,
    ...(facts.release ? { release: facts.release } : {}),
    packages: facts.packages ?? [],
    notice: notice?.text ?? null,
    ...(notice ? { noticeOutcome: notice.outcome } : {}),
  };
}

/** Everything a run decides before it changes anything: the dry run is this, and nothing after. */
async function decide(run: Run): Promise<Settled | { go: true; partial: Settled; packages: BackgroundPackage[] }> {
  const { core, env, deps } = run;
  const switched = updateCheckSwitchedOff(env);
  if (switched !== null) {
    return stop(
      'off',
      `${switched === 'CI' ? 'CI' : switched} turns updates off for this process, so nothing was asked`,
    );
  }

  let settings = deps.settings;
  if (settings === undefined) {
    let config: Config;
    try {
      config = await core.config.load();
    } catch {
      return stop(
        'not-auto',
        'config.json could not be read, so what it says of updates is not known; nothing was installed',
      );
    }
    settings = updateSettingsReader(config, await readUpdateCheck(core.paths.stateDir), run.now);
  }
  const level = settings.level();
  const background = settings.background();
  if (level !== 'auto' || !background) {
    const why =
      level !== 'auto'
        ? `the update level is ${level}, which installs nothing in the background`
        : 'an organisation profile here turns background updates off';
    if (run.dryRun) {
      return stop('not-auto', `${why}${background ? '' : '; a run would remove the background job'}`);
    }
    const job = await backgroundJobAtRun(updateJobContext(core, env, { platform: deps.platform, deps: deps.job }), {
      background,
    });
    return {
      ...stop('not-auto', `${why}${job.removed ? ', so the background job was removed' : ''}`),
      jobRemoved: job.removed,
      ...(job.notice !== null ? { notice: job.notice, noticeOutcome: 'job-removed' as const } : {}),
    };
  }

  let launched: Launched[];
  try {
    launched = await launchedPackages(core.paths.dataDir);
  } catch (error) {
    const text = `No update was installed in the background: ${toCommsError(error).message}`;
    return stop('failed', toCommsError(error).message, undefined, { text, outcome: 'failed' });
  }
  if (launched.length === 0) {
    return stop('no-launchers', 'nothing here starts a stable launcher, so there is nothing a background run switches');
  }
  const current = launched.find((entry) => entry.channel === CORE)?.version ?? VERSION;
  const facts = { current, latest: null as string | null };

  const registry = deps.registry ?? npmRegistry(env);
  const corePackage = serverFacts(CORE).packageName;
  let coreAnswer: RegistryAnswer;
  try {
    coreAnswer = await registry(corePackage);
  } catch (error) {
    return stop('unavailable', `the registry could not be read: ${toCommsError(error).message}`, facts);
  }
  const latest = coreAnswer.packument['dist-tags']?.latest;
  if (!isVersion(latest)) return stop('unavailable', 'the registry names no latest release of the core', facts);
  facts.latest = latest;
  if (isPrerelease(latest)) return stop('up-to-date', `the registry's latest, ${latest}, is a prerelease`, facts);

  const behind = launched.filter((entry) => entry.version !== latest);
  const ahead = launched.filter((entry) => entry.version !== null && (compareVersions(entry.version, latest) ?? 0) > 0);
  if (behind.length === 0) return stop('up-to-date', `every stable launcher here starts ${latest}, the latest`, facts);

  const flags = releaseFlags(coreAnswer.packument.versions?.[latest]);
  const servedAt = [coreAnswer.servedAt];
  const clock = () => new Date(Math.min(run.now.getTime(), ...servedAt.flatMap((at) => (at ? [at.getTime()] : []))));
  const paused = settings.pausedUntil(clock());
  if (paused !== undefined && clock() < paused && !flags.security) {
    return stop(
      'paused',
      `background updates are paused until ${paused.toISOString()}; ${latest} waits until then`,
      facts,
    );
  }

  if ((compareVersions(latest, current) ?? 0) < 0 || ahead.length > 0) {
    const text = `The registry names ${latest} as the latest release, older than ${current} here: nothing was changed in the background.`;
    return stop('skipped', `${latest} is older than what runs here: a downgrade is never automatic`, facts, {
      text,
      outcome: 'skipped',
    });
  }
  if (majorOf(latest) !== majorOf(current)) {
    const text = `${latest} is a new major release: it is never installed in the background. Update when it suits you — comms_update shows each step first.`;
    return stop('skipped', `${latest} is a major release after ${current}: it waits for the person`, facts, {
      text,
      outcome: 'skipped',
    });
  }
  if (flags.needsDecision !== null) {
    const text = `${latest} needs a decision from you (${flags.needsDecision}), so it was not installed in the background. comms_update shows what it changes.`;
    return stop('skipped', `${latest} needs a decision: ${flags.needsDecision}`, facts, { text, outcome: 'skipped' });
  }

  const held = await readHeldReleases(core.paths.stateDir);
  if (held === null) {
    const text = `No update is installed in the background while ${core.paths.stateDir}/${UPDATE_HELD_FILE} cannot be read: it says which releases were rolled back. Delete it to hold none.`;
    return stop(
      'held',
      `${UPDATE_HELD_FILE} cannot be read, so it is not known whether ${latest} was rolled back`,
      facts,
      {
        text,
        outcome: 'failed',
      },
    );
  }
  const rolled = held.get(latest);
  if (rolled !== undefined) {
    return stop(
      'held',
      `${latest} was rolled back on ${rolled.slice(0, 10)}: it is held until a newer release is out`,
      facts,
    );
  }

  // Every package's document: its release, its tarball's integrity, and when it came out — the hold counts from the
  // last of them, so a package published after the core is held for as long.
  const answers = new Map<string, RegistryAnswer>([[corePackage, coreAnswer]]);
  for (const entry of behind) {
    if (answers.has(entry.packageName)) continue;
    try {
      const answer = await registry(entry.packageName);
      answers.set(entry.packageName, answer);
      servedAt.push(answer.servedAt);
    } catch (error) {
      return stop('unavailable', `the registry could not be read: ${toCommsError(error).message}`, facts);
    }
  }
  const missing = behind.filter((entry) => {
    const integrity = answers.get(entry.packageName)?.packument.versions?.[latest]?.dist?.integrity;
    return typeof integrity !== 'string';
  });
  if (missing.length > 0) {
    return stop(
      'held',
      `${missing.map((entry) => `${entry.packageName}@${latest}`).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not on the registry yet`,
      facts,
    );
  }
  const published = [corePackage, ...behind.map((entry) => entry.packageName)].map((name) =>
    Date.parse(String(answers.get(name)?.packument.time?.[latest])),
  );
  const holdHours = flags.security ? SECURITY_HOLD_HOURS : HOLD_HOURS;
  const last = published.every(Number.isFinite) ? Math.max(...published) : null;
  const release = {
    version: latest,
    publishedAt: last === null ? null : new Date(last).toISOString(),
    security: flags.security,
    needsDecision: null,
    holdHours,
    installableAt: last === null ? null : new Date(last + holdHours * HOUR_MS).toISOString(),
  };
  if (last === null) {
    return stop('held', `the registry gives no time ${latest} was published, so no hold can be counted`, {
      ...facts,
      release,
    });
  }
  // A publish time ahead of the clock is a release whose age is not known yet: held, as a young one is.
  const age = clock().getTime() - last;
  if (age < holdHours * HOUR_MS) {
    return stop(
      'held',
      `${latest} came out ${age < 0 ? 'after the time this machine reads now' : `${Math.floor(age / HOUR_MS)} hours ago`}; ${flags.security ? 'a security fix' : 'a release'} installs ${holdHours} hours after it came out, at ${release.installableAt}`,
      { ...facts, release },
    );
  }

  const packages: BackgroundPackage[] = behind.map((entry) => ({
    channel: entry.channel,
    package: entry.packageName,
    from: entry.version,
    to: latest,
    runtime: managedRuntimeDir(core.paths.dataDir, entry.packageName, latest),
  }));
  // Every package verified before any is installed: one refusal installs nothing at all.
  const verifier =
    deps.provenance?.verifyBundle ?? sigstoreBundleVerifier({ cachePath: join(core.paths.stateDir, 'sigstore') });
  for (const item of packages) {
    const integrity = String(answers.get(item.package)?.packument.versions?.[latest]?.dist?.integrity);
    const verdict: ProvenanceVerdict = await verifyProvenance(
      { packageName: item.package, version: latest, integrity },
      { fetch: deps.provenance?.fetch, verifyBundle: verifier },
    );
    if (!verdict.ok) {
      item.detail = `provenance refused (${verdict.field}): ${verdict.reason}`;
      const text = `${latest} was not installed: the provenance of ${item.package}@${latest} did not verify (${verdict.field}: ${verdict.reason}). Nothing was changed.`;
      return stop(
        'refused',
        `the provenance of ${item.package}@${latest} did not verify: ${verdict.field}`,
        { ...facts, release, packages },
        {
          text,
          outcome: 'refused',
        },
      );
    }
    item.provenance = verdict.provenance;
  }
  return { go: true, partial: { ...stop('would-install', '', { ...facts, release, packages }) }, packages };
}

/** Whether a running process names `path`, as prune reads one: null when the processes cannot be listed. */
async function inUse(path: string, deps: BackgroundDeps): Promise<boolean | null> {
  const lines = await (deps.processes ?? runningCommandLines)();
  if (lines === null) return null;
  const full = resolve(path);
  return lines.some((line) => line.includes(full));
}

/** Install, check and switch: every package, or no pointer at all. */
async function apply(run: Run, partial: Settled, packages: BackgroundPackage[]): Promise<Settled> {
  const { core, env, deps } = run;
  const { dataDir } = core.paths;
  const context: InstallContext = { env, core, platform: deps.platform };
  const latest = partial.latest as string;
  const install =
    deps.install ??
    ((packageName: string, version: string) => {
      const channel = SERVERS.find((each) => serverFacts(each).packageName === packageName) ?? CORE;
      return installManagedRuntime(context, product(channel, version), version);
    });
  const selfCheck = deps.selfCheck ?? offlineSelfCheck(env, dataDir, deps.platform);
  const failed = (item: BackgroundPackage, detail: string): Settled => {
    item.detail = detail;
    const text = `${latest} was not installed in the background: ${serverLabel(item.channel)}, ${detail}. Nothing was switched; the next run tries again.`;
    return {
      ...partial,
      outcome: 'failed',
      reason: `${item.package}@${latest}: ${detail}`,
      notice: text,
      noticeOutcome: 'failed',
    };
  };

  for (const item of packages) {
    // A half-made runtime of this release in the way is written over by the installer; never one a process uses.
    if (existsSync(item.runtime) && (await reusableRuntime(dataDir, item.package, latest)) === null) {
      const used = await inUse(item.runtime, deps);
      if (used !== false) {
        return failed(
          item,
          `${item.runtime} is there unfinished and ${used === null ? 'the running processes cannot be listed' : 'a running process uses it'}, so it was not installed over`,
        );
      }
    }
    try {
      await install(item.package, latest);
      item.installed = true;
    } catch (error) {
      item.installed = false;
      return failed(item, `it could not be installed: ${toCommsError(error).message}`);
    }
  }
  for (const item of packages) {
    const integrity = await installedIntegrity(item.runtime, item.package);
    const attested = item.provenance?.sha512;
    const hex = integrity?.startsWith('sha512-') ? Buffer.from(integrity.slice(7), 'base64').toString('hex') : null;
    if (attested === undefined || hex !== attested) {
      item.checked = false;
      return failed(
        item,
        `what was installed is not the tarball whose provenance was verified (${integrity === null ? 'no integrity recorded' : 'another integrity'})`,
      );
    }
    const checked = await selfCheck({
      channel: item.channel,
      packageName: item.package,
      version: latest,
      runtime: item.runtime,
    });
    item.checked = checked.ok;
    item.detail = checked.detail;
    if (!checked.ok) return failed(item, `its self-check failed: ${checked.detail}`);
  }

  // Every package verified and checked: now the pointers, all of them or none.
  const done: { name: string; before: LauncherPointer | undefined; runtime: string }[] = [];
  for (const item of packages) {
    const name = launcherName(item.package);
    try {
      const before = await exchangePointer(dataDir, name, item.runtime);
      done.push({ name, before, runtime: item.runtime });
      item.switched = true;
    } catch (error) {
      for (const back of done.reverse()) {
        await restorePointer(dataDir, back.name, back.before, back.runtime).catch(() => false);
      }
      for (const each of packages) each.switched = false;
      return failed(
        item,
        `its launcher could not be switched (${toCommsError(error).message}), so every launcher was put back`,
      );
    }
  }
  const pruned = await prune(run, latest);
  const text = `${latest} is installed; ${RESTART}.`;
  return {
    ...partial,
    outcome: 'installed',
    reason: `${latest} verified, installed, checked and switched to`,
    pruned,
    notice: text,
    noticeOutcome: 'installed',
  };
}

/**
 * Runtimes older than each launcher's previous one — never the one it starts, never the one it falls back to — removed
 * through the prune's own checks: one a client names, one handed out to paste, or one a running process uses is kept,
 * and nothing is removed when the processes cannot be listed.
 */
async function prune(run: Run, latest: string): Promise<BackgroundRunResult['pruned']> {
  const { core, env, deps } = run;
  const context: InstallContext = { env, core, platform: deps.platform };
  const removed: BackgroundRunResult['pruned'] = [];
  for (const channel of SERVERS) {
    const { packageName } = serverFacts(channel);
    const name = launcherName(packageName);
    const pointer = await readPointer(core.paths.dataDir, name).catch(() => undefined);
    const previous = pointer?.previous === undefined ? null : launcherRuntimeVersion(pointer.previous, name);
    if (previous === null) continue;
    const older = (await listManagedRuntimes(core.paths.dataDir, packageName))
      .filter((runtime) => compareVersions(runtime.version, previous) === -1)
      .map((runtime) => runtime.path);
    if (older.length === 0) continue;
    try {
      const result = await pruneManagedRuntimes(
        context,
        { packageName, version: launcherRuntimeVersion(pointer?.current ?? '', name) ?? latest },
        { only: older, ...(deps.processes ? { processes: deps.processes } : {}) },
      );
      removed.push(...result.removed);
    } catch {
      // A prune that could not finish removes nothing more; the next run tries again.
    }
  }
  return removed;
}

const AUDIT_OUTCOME: Record<BackgroundOutcome, AuditRecord['outcome']> = {
  off: 'ok',
  'not-auto': 'ok',
  busy: 'refused',
  'no-launchers': 'ok',
  unavailable: 'failed',
  'up-to-date': 'ok',
  paused: 'ok',
  held: 'ok',
  skipped: 'refused',
  refused: 'refused',
  failed: 'failed',
  installed: 'ok',
  'would-install': 'ok',
};

/** The next session's notice, as the run leaves it in the update state file. */
async function leaveNotice(run: Run, result: Settled): Promise<void> {
  const at = run.now.toISOString();
  await changeUpdateCheck(run.core.paths.stateDir, (record) => {
    if (result.noticeOutcome !== undefined && result.notice !== null) {
      return {
        record: {
          ...record,
          backgroundNotice: { at, outcome: result.noticeOutcome, version: result.latest, text: result.notice },
        },
      };
    }
    // At the latest release: an "installed; restart" for it still holds — a session may not have restarted — and
    // anything about another release is over.
    const left = record.backgroundNotice;
    if (result.outcome === 'up-to-date' && left !== null && left !== undefined) {
      const still = left.outcome === 'installed' && left.version === result.latest;
      return still ? null : { record: { ...record, backgroundNotice: null } };
    }
    return null;
  }).catch(() => undefined);
}

/**
 * One background run, from settings to notice. `dryRun` reads the registry and the attestations, verifies the
 * provenance, and says what it would do and why — and changes nothing: no job, no install, no pointer, no prune, no
 * audit line, no notice.
 */
export async function runBackgroundUpdate(
  core: Core,
  env: NodeJS.ProcessEnv,
  request: BackgroundRequest = {},
  deps: BackgroundDeps = {},
): Promise<BackgroundRunResult> {
  const run: Run = { core, env, deps, dryRun: request.dryRun === true, now: (deps.now ?? (() => new Date()))() };
  const finish = (partial: Settled): BackgroundRunResult => {
    const { noticeOutcome: _left, ...rest } = partial;
    return { ...rest, dryRun: run.dryRun, pruned: partial.pruned ?? [], jobRemoved: partial.jobRemoved ?? false };
  };
  if (run.dryRun) {
    const decided = await decide(run);
    if (!('go' in decided)) return finish(decided);
    const { latest } = decided.partial;
    return finish({
      ...decided.partial,
      outcome: 'would-install',
      reason: `${latest} would be installed: every package's provenance verified, and it is past its hold`,
      notice: `${latest} is installed; ${RESTART}.`,
    });
  }
  let partial: Settled;
  try {
    // The machine's one update lock, which a person's update and rollback take too: the two never overlap. An install
    // can take minutes, so it is renewed while it runs.
    partial = await withUpdateLock(core.paths.stateDir, async () => {
      const decided = await decide(run);
      const result = 'go' in decided ? await apply(run, decided.partial, decided.packages) : decided;
      if (result.outcome === 'up-to-date') result.pruned = await prune(run, result.latest ?? '');
      await leaveNotice(run, result);
      return result;
    });
  } catch (error) {
    const refused = toCommsError(error);
    partial =
      refused.code === 'LOCK_TIMEOUT'
        ? stop('busy', 'another background run, or a person’s update, is under way')
        : stop('failed', refused.message, undefined, {
            text: `No update was installed in the background: ${refused.message}`,
            outcome: 'failed',
          });
  }
  const result = finish(partial);
  // Every run says it ran, one that found nothing to do included: a job that never runs silences no notice (U4, U7).
  await recordUpdateJobRun(core.paths.stateDir, run.now).catch(() => undefined);
  await core.audit
    .append({
      inboxId: '',
      operation: 'update.background',
      outcome: AUDIT_OUTCOME[result.outcome],
      surface: 'daemon',
      origin: 'daemon',
      reason: `${result.outcome}: ${result.reason}`.slice(0, 500),
      ids: {
        ...(result.current ? { from: result.current } : {}),
        ...(result.latest ? { latest: result.latest } : {}),
        ...(result.packages.length > 0 ? { packages: result.packages.map((item) => item.package) } : {}),
        ...(result.pruned.length > 0 ? { pruned: result.pruned.map((item) => item.path) } : {}),
      },
    })
    .catch(() => undefined);
  return result;
}
