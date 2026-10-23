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
  LAUNCHER_ENV,
  type LauncherPointer,
  launcherName,
  launcherRuntimeVersion,
  readPointer,
  restorePointer,
} from './launcher.ts';
import { withFileLock } from './lock.ts';
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
import { readVerifiedDeclaration } from './release-declarations.ts';
import { firstSeenTimes } from './release-first-seen.ts';
import { type TarballFetch, tarballLocation } from './release-tarball.ts';
import { childEnvironment } from './system-programs.ts';
import { backgroundJobAtRun, recordUpdateJobRun, type UpdateJobDeps, updateJobContext } from './update-job.ts';
import { withUpdateLock } from './update-lock.ts';
import {
  type BundleVerifier,
  type ProvenanceDeps,
  type ProvenanceVerdict,
  type SigstoreModules,
  sigstoreBundleVerifier,
  type VerifiedProvenance,
  verifyProvenance,
} from './update-provenance.ts';
import {
  decisionNeeded,
  majorOf,
  npmRegistry,
  oldestVersion,
  type RegistryAnswer,
  type ReleaseRegistry,
  type ReleaseVerifier,
  releaseIntegrity,
  runtimeIntegrityProblem,
} from './update-release.ts';
import {
  type BackgroundNotice,
  changeUpdateCheck,
  configuredUpdates,
  pauseEnd,
  readUpdateCheck,
  type UpdateCheckRecord,
  updateCheckSwitchedOff,
} from './update-state.ts';
import { BACKGROUND_WORDS, DECLARATION_UNREAD, type FailedWhat } from './update-words.ts';
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
 * 2. **The registry.** `latest` of the core, its release verified first (`update-provenance.ts`), and what it declares
 *    read from its verified tarball (`release-declarations.ts`; design 2026-10-22 P1) — never from the registry's copy
 *    of its manifest, and of no other release (§8.1). Never automatic: a major version, a release that needs a
 *    decision — the latest declares `agentcommsRelease.needsDecision`, or carries a `needsDecisionSince` after the
 *    oldest release a launcher here starts — a downgrade — each a notice. Held: a release that was rolled back, until a
 *    newer one exists (`update-held.json`); one signed under 72 hours ago, or 24 for a security fix. A pause holds
 *    everything but a security fix. A latest whose declaration cannot be read — its tarball cannot be had — holds the
 *    run back, `unavailable`: the next run tries again, and a job that is never past it is reported as not running.
 *    Which versions the registry lists decides nothing, and costs nothing: none of them is verified or read.
 * 3. **Provenance** of every package to install, before its hold is decided. Any refusal stops the whole run: nothing
 *    is installed. The hold counts from the time Rekor signed for each package's release, the latest of them
 *    (`VerifiedProvenance.signedAt`; design 2026-10-22 P4), or, for a release whose provenance carries none, from when
 *    this machine first saw it (`release-first-seen.ts`). The registry's `time` counts for nothing.
 * 4. **Install** each into a runtime of its own, as `comms_update` does; then check each: the installed package is the
 *    tarball whose provenance was verified, its CLI's `--version` is the release, and its server answers MCP
 *    `initialize` started with no account to reach.
 * 5. **Switch** every pointer only once every package has verified and checked. One switch that fails puts back those
 *    already switched: a release is switched whole or not at all (plan, Review focus 3).
 * 6. **Audit** every run, and prune what is older than the previous release with the prune's own in-use checks.
 * 7. **The notice** for the next session, in the update state file.
 *
 * The clock is the earlier of this machine's and the registry's (its `Date`), so a clock that jumps ahead skips no
 * hold and ends no pause early; one that goes back only holds longer (plan, Review focus 2). A first sight is recorded
 * at this machine's own clock, never the run's, which a registry's `Date` could set back.
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

export type { Packument, RegistryAnswer, ReleaseRegistry } from './update-release.ts';
export { npmRegistry } from './update-release.ts';

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
  /** sigstore-js's modules, when no `provenance.verifyBundle` is handed in: for a test, its TUF reader stood in. */
  loadSigstore?: (() => Promise<SigstoreModules>) | undefined;
  /** How a pointer is switched and put back: for a test, one that cannot be put back. */
  launchers?:
    | { exchange?: typeof exchangePointer | undefined; restore?: typeof restorePointer | undefined }
    | undefined;
  /** How a release's tarball is fetched, to read what it declares. Defaults to `fetch`. */
  tarballs?: TarballFetch | undefined;
}

export interface BackgroundRequest {
  /** Say what it would do, and why, with the provenance it verified; change nothing. */
  dryRun?: boolean | undefined;
}

/**
 * - `off`: this process's environment turned updates off (`CI`, the switch). `not-auto`: the level or the organisation
 *   does not install in the background. `busy`: another run holds the lock. `no-launchers`: nothing here starts a
 *   stable launcher. `unavailable`: the registry could not be read, or what a release this run takes the machine past
 *   declares could not be read from its verified release.
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

/**
 * The outcomes that show the job works, and so are recorded as its `lastRun` (re-review of 0.20.0, severity 6): it
 * reached the registry and decided — nothing to do, installed, held for its hours or a pause, left for the person, or
 * refused as unverified, which its notice says. Not recorded:
 * - `unavailable`: the registry could not be read, or a release's declaration could not be read from its verified
 *   release (a mirror that blocks tarballs; plan, Review Focus 1). A job that can never get past it keeps nothing up to
 *   date, so after 48 hours of it the notices and the security line come back, and doctor says the job has not run;
 * - `busy`: another run, or a person's update, held the machine's lock. One day so is nothing; a lock held for good —
 *   a run that hung — would otherwise hide a job that does nothing, so it surfaces after 48 hours too;
 * - `failed`, and `off` or `not-auto`, where the run did none of the job's work.
 */
export const JOB_WORKS: ReadonlySet<BackgroundOutcome> = new Set<BackgroundOutcome>([
  'no-launchers',
  'up-to-date',
  'paused',
  'held',
  'skipped',
  'refused',
  'installed',
]);

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
  /** The release considered, when there was one: when its hold counts from, what it declares, and when it may install. */
  release?:
    | {
        version: string;
        /** When the hold counts from: the latest Rekor time of the set, or this machine's first sight. */
        publishedAt: string | null;
        /** Where `publishedAt` comes from: the time Rekor signed, or this machine's first sight of a release with none. */
        heldFrom: 'signed' | 'first-seen' | null;
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

/** The holds (U5 step 2): hours after Rekor signed for a release, or this machine first saw it (design 2026-10-22 P4). */
export const HOLD_HOURS = 72;
export const SECURITY_HOLD_HOURS = 24;
const HOUR_MS = 60 * 60 * 1000;

/** `<state>/update-held.json`: the releases a person rolled back from, which no background run installs again. */
export const UPDATE_HELD_FILE = 'update-held.json';

const CORE: ServerId = 'core';

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
  /**
   * Where sigstore-js keeps Sigstore's trust root, read through TUF: `<state>/sigstore` for a run, and for a dry run a
   * temporary folder of its own, removed when it ends — a dry run changes nothing.
   */
  cachePath: string;
}

/** The verifier a run checks bundles with: the one handed in, or sigstore-js's, its trust root kept in `cachePath`. */
function bundleVerifier(run: Run): BundleVerifier {
  return (
    run.deps.provenance?.verifyBundle ??
    sigstoreBundleVerifier({ cachePath: run.cachePath, load: run.deps.loadSigstore })
  );
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
    return stop('failed', toCommsError(error).message, undefined, {
      text: BACKGROUND_WORDS.stopped(null),
      outcome: 'failed',
    });
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
  // A release is named by its plain MAJOR.MINOR.PATCH — what npm publishes — or it is not one this runs: a
  // prerelease is never installed, and build metadata is not part of a published version. Neither is repeated.
  const latest = coreAnswer.packument['dist-tags']?.latest;
  if (!isVersion(latest) || latest.includes('+')) {
    return stop('unavailable', 'the registry names no latest release of the core', facts);
  }
  if (isPrerelease(latest))
    return stop('up-to-date', "the registry's latest is a prerelease, which is never installed", facts);
  facts.latest = latest;

  const behind = launched.filter((entry) => entry.version !== latest);
  const ahead = launched.filter((entry) => entry.version !== null && (compareVersions(entry.version, latest) ?? 0) > 0);
  if (behind.length === 0) return stop('up-to-date', `every stable launcher here starts ${latest}, the latest`, facts);

  const servedAt = [coreAnswer.servedAt];
  const clock = () => new Date(Math.min(run.now.getTime(), ...servedAt.flatMap((at) => (at ? [at.getTime()] : []))));
  const paused = settings.pausedUntil(clock());
  const pausedNow = paused !== undefined && clock() < paused;
  const pausedStop = () =>
    stop('paused', `background updates are paused until ${paused?.toISOString()}; ${latest} waits until then`, facts);

  // Core's release, verified before anything said of it is acted on — a security fix, a needed decision, a major, a
  // downgrade — or made a notice: one that does not verify is only refused. A pause is decided after it too, as only
  // what the verified release declares can pass one.
  const verifier = bundleVerifier(run);
  const verify = (packageName: string, version: string, integrity: string): Promise<ProvenanceVerdict> =>
    verifyProvenance({ packageName, version, integrity }, { fetch: deps.provenance?.fetch, verifyBundle: verifier });
  const coreIntegrity = releaseIntegrity(coreAnswer.packument, latest);
  if (coreIntegrity === null) return stop('held', `${corePackage}@${latest} is not on the registry yet`, facts);
  const coreVerdict = await verify(corePackage, latest, coreIntegrity);
  if (!coreVerdict.ok) {
    return stop('refused', `the provenance of ${corePackage}@${latest} did not verify: ${coreVerdict.field}`, facts, {
      text: BACKGROUND_WORDS.unverified(latest, coreVerdict.field),
      outcome: 'refused',
    });
  }

  // What a verified release declares is read from its own tarball — the bytes whose sha512 is the digest its provenance
  // signed — never from the registry's copy of its manifest, nor checked against the integrity the registry gives
  // (design 2026-10-22 P1). Kept per integrity, and never written by a dry run.
  const declared = await readVerifiedDeclaration(
    coreVerdict.provenance,
    tarballLocation(coreAnswer.packument, latest),
    {
      stateDir: core.paths.stateDir,
      ...(deps.tarballs !== undefined ? { fetch: deps.tarballs } : {}),
      writeCache: !run.dryRun,
    },
  );
  // No notice: a run that cannot read it is not a decision about the release. The next run tries again, and a job that
  // never gets past it is not recorded as working (`JOB_WORKS`), so its notices come back (plan, Review Focus 1).
  if (!declared.known) {
    if (pausedNow) return pausedStop();
    return stop('unavailable', `${corePackage}@${latest}: ${DECLARATION_UNREAD}; the next run tries again`, facts);
  }
  const flags = { security: declared.security };
  if (pausedNow && !flags.security) return pausedStop();

  if ((compareVersions(latest, current) ?? 0) < 0 || ahead.length > 0) {
    return stop('skipped', `${latest} is older than what runs here: a downgrade is never automatic`, facts, {
      text: BACKGROUND_WORDS.downgrade(latest),
      outcome: 'skipped',
    });
  }
  // The oldest release a launcher here starts is what this run takes the machine from: a major crossed by any launcher
  // here, or a decision the latest declares or carries forward after it (design 2026-10-22 §8.1), waits for the person.
  // Only the latest's verified declaration says so: which releases the registry lists between decides nothing, so a
  // release left out of its document, or one added that does not verify, changes nothing and is never asked about.
  const from = oldestVersion(behind.map((entry) => entry.version ?? current)) ?? current;
  if (majorOf(latest) !== majorOf(from)) {
    return stop('skipped', `${latest} is a major release after ${from}: it waits for the person`, facts, {
      text: BACKGROUND_WORDS.major(latest),
      outcome: 'skipped',
    });
  }
  // What the decision is, the manifest's own words, is never said: the person reads it in the release notes.
  const deciding = decisionNeeded(declared, from);
  if (deciding !== null) {
    return stop('skipped', `${latest} needs a decision from the person (${deciding} says so)`, facts, {
      text: BACKGROUND_WORDS.decision(latest),
      outcome: 'skipped',
    });
  }

  const held = await readHeldReleases(core.paths.stateDir);
  if (held === null) {
    const text = BACKGROUND_WORDS.heldUnreadable;
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

  // Every package's document: its release, and its tarball's integrity.
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

  const packages: BackgroundPackage[] = behind.map((entry) => ({
    channel: entry.channel,
    package: entry.packageName,
    from: entry.version,
    to: latest,
    runtime: managedRuntimeDir(core.paths.dataDir, entry.packageName, latest),
  }));
  // Every package verified before its hold is decided, and before any is installed: one refusal installs nothing at
  // all, and the hold counts from the times their verified provenance carries. Core's was, above.
  for (const item of packages) {
    if (item.package === corePackage) {
      item.provenance = coreVerdict.provenance;
      continue;
    }
    const integrity = String(answers.get(item.package)?.packument.versions?.[latest]?.dist?.integrity);
    const verdict = await verify(item.package, latest, integrity);
    if (!verdict.ok) {
      item.detail = `provenance refused (${verdict.field}): ${verdict.reason}`;
      const text = BACKGROUND_WORDS.unverified(latest, verdict.field);
      return stop(
        'refused',
        `the provenance of ${item.package}@${latest} did not verify: ${verdict.field}`,
        { ...facts, packages },
        {
          text,
          outcome: 'refused',
        },
      );
    }
    item.provenance = verdict.provenance;
  }

  // The hold (design 2026-10-22 P4): from the time Rekor signed for each package's release, or — for one whose
  // provenance carries none — from when this machine first saw it, recorded at this machine's own clock, never the
  // run's, which the registry's `Date` could set back (plan, gap 7). The set's counts from the last of them. The
  // registry's `time` is never read: a registry could make a release look older than it is.
  const set = new Map<string, VerifiedProvenance>([[corePackage, coreVerdict.provenance]]);
  for (const item of packages) if (item.provenance !== undefined) set.set(item.package, item.provenance);
  const unsigned = [...set.values()].filter((provenance) => provenance.signedAt === null);
  const seen =
    unsigned.length === 0
      ? new Map<string, Date>()
      : await firstSeenTimes(
          core.paths.stateDir,
          unsigned.map((provenance) => ({
            package: provenance.package,
            version: provenance.version,
            integrity: `sha512-${Buffer.from(provenance.sha512, 'hex').toString('base64')}`,
          })),
          run.now,
          { record: !run.dryRun },
        );
  const times = [...set.values()].map((provenance) =>
    provenance.signedAt !== null
      ? { at: Date.parse(provenance.signedAt), from: 'signed' as const }
      : {
          at: seen.get(`${provenance.package}@${provenance.version}`)?.getTime() ?? Number.NaN,
          from: 'first-seen' as const,
        },
  );
  const holdHours = flags.security ? SECURITY_HOLD_HOURS : HOLD_HOURS;
  const known = times.every((time) => Number.isFinite(time.at));
  const last = known ? Math.max(...times.map((time) => time.at)) : null;
  // Where the time the hold counts from came from; a first sight, when one ties a signed time.
  const heldFrom =
    last === null
      ? null
      : times.some((time) => time.at === last && time.from === 'first-seen')
        ? 'first-seen'
        : 'signed';
  const release = {
    version: latest,
    publishedAt: last === null ? null : new Date(last).toISOString(),
    heldFrom,
    security: flags.security,
    needsDecision: null,
    holdHours,
    installableAt: last === null ? null : new Date(last + holdHours * HOUR_MS).toISOString(),
  } satisfies NonNullable<BackgroundRunResult['release']>;
  if (last === null) {
    return stop('held', `no time ${latest} was signed or first seen here can be read, so no hold can be counted`, {
      ...facts,
      release,
    });
  }
  // A time ahead of the clock is a release whose age is not known yet: held, as a young one is.
  const age = clock().getTime() - last;
  if (age < holdHours * HOUR_MS) {
    const ago = age < 0 ? 'after the time this machine reads now' : `${Math.floor(age / HOUR_MS)} hours ago`;
    const since =
      heldFrom === 'first-seen'
        ? `was first seen here ${ago}, as its provenance carries no time Rekor signed`
        : `came out ${ago}, by the time Rekor signed for it`;
    return stop(
      'held',
      `${latest} ${since}; ${flags.security ? 'a security fix' : 'a release'} installs ${holdHours} hours after that, at ${release.installableAt}`,
      { ...facts, release },
    );
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
  // The detail is the run's, for its result and the audit log; the notice says what went wrong in fixed words.
  const failed = (item: BackgroundPackage, detail: string, what: FailedWhat): Settled => {
    item.detail = detail;
    return {
      ...partial,
      outcome: 'failed',
      reason: `${item.package}@${latest} (${serverLabel(item.channel)}): ${detail}`,
      notice: BACKGROUND_WORDS.failed(latest, what),
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
          'inUse',
        );
      }
    }
    try {
      await install(item.package, latest);
      item.installed = true;
    } catch (error) {
      item.installed = false;
      return failed(item, `it could not be installed: ${toCommsError(error).message}`, 'install');
    }
  }
  // What npm installed is what was verified: each package's own tarball, and every package of this suite it depends on.
  const known = new Map(
    packages.flatMap((item) =>
      item.provenance ? [[`${item.package}@${item.provenance.version}`, item.provenance.sha512] as const] : [],
    ),
  );
  const verifier = bundleVerifier(run);
  const verify: ReleaseVerifier = (release) =>
    verifyProvenance(release, { fetch: deps.provenance?.fetch, verifyBundle: verifier });
  for (const item of packages) {
    const attested = item.provenance?.sha512;
    const problem =
      attested === undefined
        ? 'its provenance was not verified'
        : await runtimeIntegrityProblem(item.runtime, item.package, attested, { verify, known });
    if (problem !== null) {
      item.checked = false;
      return failed(item, problem, 'tarball');
    }
    const checked = await selfCheck({
      channel: item.channel,
      packageName: item.package,
      version: latest,
      runtime: item.runtime,
    });
    item.checked = checked.ok;
    item.detail = checked.detail;
    if (!checked.ok) return failed(item, `its self-check failed: ${checked.detail}`, 'selfCheck');
  }

  // Every package verified and checked: now the pointers, all of them or none.
  const exchange = deps.launchers?.exchange ?? exchangePointer;
  const restore = deps.launchers?.restore ?? restorePointer;
  const done: { item: BackgroundPackage; name: string; before: LauncherPointer | undefined; runtime: string }[] = [];
  for (const item of packages) {
    const name = launcherName(item.package);
    try {
      const before = await exchange(dataDir, name, item.runtime);
      done.push({ item, name, before, runtime: item.runtime });
      item.switched = true;
    } catch (error) {
      item.switched = false;
      // Each one switched is put back — and one that cannot be is said to be still switched, as it is.
      const left: string[] = [];
      for (const back of done.reverse()) {
        const put = await restore(dataDir, back.name, back.before, back.runtime).catch(() => false);
        back.item.switched = !put;
        if (!put) left.push(back.name);
      }
      const why = toCommsError(error).message;
      if (left.length === 0) {
        return failed(item, `its launcher could not be switched (${why}), so every launcher was put back`, 'switch');
      }
      const result = failed(
        item,
        `its launcher could not be switched (${why}), and ${left.length === 1 ? 'this launcher' : 'these launchers'} could not be put back: ${left.join(', ')} — ${left.length === 1 ? 'it starts' : 'they start'} ${latest} from ${left.length === 1 ? 'its' : 'their'} next start`,
        'switch',
      );
      return { ...result, notice: BACKGROUND_WORDS.partlySwitched(latest) };
    }
  }
  const pruned = await prune(run, latest);
  const text = BACKGROUND_WORDS.installed(latest);
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
  const dryRun = request.dryRun === true;
  const run: Run = {
    core,
    env,
    deps,
    dryRun,
    now: (deps.now ?? (() => new Date()))(),
    cachePath: dryRun ? await mkdtemp(join(tmpdir(), 'comms-sigstore-')) : join(core.paths.stateDir, 'sigstore'),
  };
  const finish = (partial: Settled): BackgroundRunResult => {
    const { noticeOutcome: _left, ...rest } = partial;
    return { ...rest, dryRun: run.dryRun, pruned: partial.pruned ?? [], jobRemoved: partial.jobRemoved ?? false };
  };
  if (run.dryRun) {
    try {
      const decided = await decide(run);
      if (!('go' in decided)) return finish(decided);
      const { latest } = decided.partial;
      return finish({
        ...decided.partial,
        outcome: 'would-install',
        reason: `${latest} would be installed: every package's provenance verified, and it is past its hold`,
        notice: BACKGROUND_WORDS.installed(latest ?? ''),
      });
    } finally {
      await rm(run.cachePath, { recursive: true, force: true }).catch(() => undefined);
    }
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
        : stop('failed', refused.message, undefined, { text: BACKGROUND_WORDS.stopped(null), outcome: 'failed' });
  }
  const result = finish(partial);
  // A run of the job's that did the job's work says it ran, one that found nothing to do included: a job that never
  // runs, or never gets that far, silences no notice (U4, U7; `JOB_WORKS`). The job starts the stable core launcher,
  // which says so to what it starts (`LAUNCHER_ENV`); `update --background` a person runs from their own command is
  // not the job running, and records nothing (re-review of 0.20.0, severity 2).
  const byJob = env[LAUNCHER_ENV]?.trim() === 'core';
  if (byJob && JOB_WORKS.has(result.outcome)) {
    await recordUpdateJobRun(core.paths.stateDir, run.now).catch(() => undefined);
  }
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
