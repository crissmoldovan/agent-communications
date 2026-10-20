import { lstat, mkdir, readdir, rename, rm, statfs } from 'node:fs/promises';
import type net from 'node:net';
import { join } from 'node:path';
import type tls from 'node:tls';
import { type AuditLog, CommsError, canonicalJson } from '@agentcomms/core';
import { type LayaEnablementInputs, layaJudgeKindDefinitionFor } from '../../domain/judges.ts';
import { JUDGE_KIND_LAYA } from '../../domain/lifecycle.ts';
import { ImmutableVersions } from '../../domain/versions.ts';
import type { PinnedTcpOptions, PinnedTlsOptions } from '../../network/pinned-connection.ts';
import type { AddressResolver } from '../../network/resolver.ts';
import type { EventDatabase } from '../../store/database.ts';
import { LayaModelRepository } from '../../store/records.ts';
import type { JudgeWorkPurgeListener } from '../judge-purge.ts';
import { layaModelArtifactPaths } from './artifact-paths.ts';
import type {
  CanonicalLayaEnablement,
  LayaArtifactDoctor,
  LayaJudgeKindDefinition,
  LayaManifestFile,
  LayaModelFailureCode,
  LayaModelState,
  LayaModelStatus,
  LayaUnavailableCode,
} from './contracts.ts';
import { LayaArtifactFetcher, type LayaFetchOptions, type LayaFetchStreamResult } from './fetcher.ts';
import { type LayaArtifactFence, LayaModelDownloader } from './model-downloader.ts';
import { installRuntime, type RuntimeInstallFile } from './runtime-installer.ts';
import type { RuntimeTreeFile } from './tar.ts';
import { verifyRuntimeTree } from './tree-verifier.ts';

const OWNER_ONLY_DIRECTORY_MODE = 0o700;

/**
 * The points a test may pause at, each inside the artifact lock (or, for `install-start`, at a job's first locked
 * section; for `worker-start-verify`, after a worker start's walk of both trees; for `tree-sweep`, after each tree a
 * sweep deleted) and before the recheck that guards the effect named. Production composes no failpoint.
 */
export type LayaArtifactEdge =
  | 'install-start'
  | 'runtime-promotion'
  | 'model-promotion'
  | 'model-ready'
  | 'repair-delete'
  | 'remove-model'
  | 'update-disable'
  | 'worker-start-verify'
  | 'tree-sweep';

export type LayaArtifactFailpoint = (edge: LayaArtifactEdge) => void | Promise<void>;

/** The closed audit reasons of D11's start-up update tightening. */
export type LayaUpdateReason = 'model-changed' | 'runtime-changed';

/** The sealed network a test hands the production fetcher; production passes none and dials only global addresses. */
export interface LayaArtifactNetwork {
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
}

/**
 * A content-free refusal a person or app can act on: its stable `details.reason` is `LAYA_ENABLED` (remove while the
 * kind is enabled) or `LAYA_NOT_READY` (a worker start before the kind is enabled); it names no path or content.
 */
function layaRefusal(reason: 'LAYA_ENABLED' | 'LAYA_NOT_READY', message: string): CommsError {
  return new CommsError(reason === 'LAYA_ENABLED' ? 'USAGE' : 'CONFIG', message, { details: { reason } });
}

/** A job or repair whose selection, pointer or epoch moved on: it stops without writing anything. */
class ArtifactWorkStale extends Error {
  constructor() {
    super('the Laya artifact work no longer owns the active selection');
    this.name = 'ArtifactWorkStale';
  }
}

/** A closed failure the job records for `doctor`, the app and `judge model status`. */
class ArtifactFailure extends Error {
  readonly failureCode: LayaModelFailureCode;

  constructor(failureCode: LayaModelFailureCode) {
    super(`Laya artifact work failed: ${failureCode}`);
    this.name = 'ArtifactFailure';
    this.failureCode = failureCode;
  }
}

/** One FIFO lock: every artifact promotion, deletion, disable, removal and update tightening runs inside it. */
class ArtifactMutex {
  #tail: Promise<void> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(work, work);
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/**
 * The enabled selection one Laya worker is started for. Task 8's supervisor captures it before it verifies the trees
 * and requires it unchanged — same pointer version and digest, same manager epoch — after every await before it sends
 * a load or a request.
 */
export interface LayaWorkerSelection {
  readonly epoch: number;
  readonly version: number;
  readonly digest: string;
  readonly manifestId: string;
  readonly promptTemplates: readonly string[];
}

/** The one worker supervisor this manager stops whenever it fences Laya's work: a kind disable, an update, a stop. */
export interface LayaWorkerStopper {
  stop(): Promise<void>;
}

interface ActiveEnablement {
  readonly version: number;
  readonly digest: string;
  readonly document: unknown;
}

interface ArtifactJob {
  readonly epoch: number;
  readonly version: number;
  readonly digest: string;
  readonly selection: CanonicalLayaEnablement;
  readonly controller: AbortController;
  phase: 'installing' | 'downloading' | 'verifying';
  runtimeBytes: number;
  readonly modelProgress: Map<string, number>;
  settled: Promise<void>;
}

interface TrackedWork {
  readonly reservationId: string;
  readonly controller: AbortController;
}

/** The selected platform's runtime files as the installer and verifier read them: rooted at `node_modules/`. */
function runtimeFiles(selection: CanonicalLayaEnablement): readonly RuntimeInstallFile[] {
  return selection.runtimeLock.platform.files.map((file) => ({
    packageName: file.package,
    path: `node_modules/${file.package}/${file.path}`,
    size: file.size,
    sha256: file.sha256,
    executable: file.executable,
  }));
}

function modelFiles(selection: CanonicalLayaEnablement): readonly RuntimeTreeFile[] {
  return selection.manifest.files.map((file) => ({ ...file, executable: false }));
}

function bytesOf(files: readonly { readonly size: number }[]): number {
  return files.reduce((sum, file) => sum + file.size, 0);
}

function totalBytes(selection: CanonicalLayaEnablement): number {
  return bytesOf(selection.manifest.files) + bytesOf(selection.runtimeLock.platform.files);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * D11's update rule over the complete approved entries: the enabled document must equal this release's document
 * byte for byte — its embedded manifest, its complete package list with every exact URL, version and SRI, and the
 * selected platform's complete file list, not merely a digest. A manifest difference is `model-changed`; any other
 * difference, a downgrade among them, is `runtime-changed`.
 */
export function layaUpdateReason(stored: unknown, release: CanonicalLayaEnablement): LayaUpdateReason | null {
  if (canonicalJson(stored) === canonicalJson(release)) return null;
  return canonicalJson(record(stored)?.manifest ?? null) !== canonicalJson(release.manifest)
    ? 'model-changed'
    : 'runtime-changed';
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function ownerOnlyDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE });
}

async function availableBytes(path: string): Promise<number> {
  const stats = await statfs(path);
  return Number(stats.bavail) * Number(stats.bsize);
}

/** The production fetcher, counting each streamed model byte for status only after the downloader's sink took it. */
class ProgressReportingArtifactFetcher extends LayaArtifactFetcher {
  readonly #progress: Map<string, number>;

  constructor(options: ConstructorParameters<typeof LayaArtifactFetcher>[0], progress: Map<string, number>) {
    super(options);
    this.#progress = progress;
  }

  override async fetchModelFileTo(
    file: LayaManifestFile,
    resumeFrom: number | undefined,
    onChunk: (chunk: Buffer, signal: AbortSignal) => void | Promise<void>,
    options: LayaFetchOptions,
  ): Promise<LayaFetchStreamResult> {
    let received = resumeFrom ?? 0;
    this.#progress.set(file.path, received);
    return super.fetchModelFileTo(
      file,
      resumeFrom,
      async (chunk, signal) => {
        await onChunk(chunk, signal);
        received += chunk.length;
        this.#progress.set(file.path, received);
      },
      options,
    );
  }
}

export interface LayaArtifactManagerOptions {
  readonly store: EventDatabase;
  /** `<dataDir>/events/laya`: the only directory this manager creates, writes or deletes beneath. */
  readonly artifactRoot: string;
  /** Exactly the inputs E's activation path uses: shipped bytes in production, strict fixture bytes in tests. */
  readonly inputs?: LayaEnablementInputs | undefined;
  readonly network?: LayaArtifactNetwork | undefined;
  readonly freeBytes?: (() => Promise<number>) | undefined;
  readonly audit?: Pick<AuditLog, 'append'> | undefined;
  readonly now?: (() => number) | undefined;
  readonly failpoint?: LayaArtifactFailpoint | undefined;
}

/** How long a failed availability probe stands before the next request that needs it probes again. */
const AVAILABILITY_RETRY_MS = 60_000;

/**
 * The one serial owner of Laya's installation-wide artifacts. E stays the sole authority: the active Laya
 * judge-kind pointer starts every job, every post-await step rechecks that exact pointer, its embedded document and
 * this manager's epoch, and E's disable, purge and update tightenings stop the work they orphan. Only content-free
 * D8 model state is persisted; trees live under `runtime/<lockDigest>` and `models/<manifestId>` and nowhere else.
 */
export class LayaArtifactManager implements JudgeWorkPurgeListener {
  readonly kind: typeof JUDGE_KIND_LAYA = JUDGE_KIND_LAYA;
  readonly #store: EventDatabase;
  readonly #root: string;
  readonly #inputs: LayaEnablementInputs;
  #reviewed: LayaJudgeKindDefinition | undefined;
  readonly #network: LayaArtifactNetwork;
  readonly #freeBytes: (() => Promise<number>) | undefined;
  readonly #audit: Pick<AuditLog, 'append'> | undefined;
  readonly #now: () => number;
  readonly #failpoint: LayaArtifactFailpoint | undefined;
  readonly #models: LayaModelRepository;
  readonly #mutex = new ArtifactMutex();
  readonly #tracked = new Map<string, TrackedWork>();
  #availability: ReturnType<LayaJudgeKindDefinition['availability']> | undefined;
  #availabilityProbedAt = 0;
  /** Bumped by every disable, removal, update tightening and stop: a job captures it and stops once it moves. */
  #epoch = 0;
  #job: ArtifactJob | undefined;
  #stopped = false;
  #worker: LayaWorkerStopper | undefined;

  constructor(options: LayaArtifactManagerOptions) {
    this.#store = options.store;
    this.#root = options.artifactRoot;
    this.#inputs = options.inputs ?? {};
    this.#network = options.network ?? {};
    this.#freeBytes = options.freeBytes;
    this.#audit = options.audit;
    this.#now = options.now ?? Date.now;
    this.#failpoint = options.failpoint;
    this.#models = new LayaModelRepository(options.store.database);
  }

  /**
   * The reviewed definition, parsed on first use: an owner whose Laya is never asked about never reads its assets,
   * so a start-up needs them only once a Laya pointer, status or operation does.
   */
  get #definition(): LayaJudgeKindDefinition {
    this.#reviewed ??= layaJudgeKindDefinitionFor(this.#inputs);
    return this.#reviewed;
  }

  /**
   * The content-free availability probe: a fact about this machine, never a document input. Only a success is kept for
   * the owner's life (E2 review round 1, B7); after a failure the next request that needs it probes again, at most once
   * a minute, so a sandbox that failed once is not taken as missing until the daemon restarts.
   */
  availability(): ReturnType<LayaJudgeKindDefinition['availability']> {
    const now = this.#now();
    if (
      this.#availability === undefined ||
      (!this.#availability.available && now - this.#availabilityProbedAt >= AVAILABILITY_RETRY_MS)
    ) {
      this.#availability = this.#definition.availability();
      this.#availabilityProbedAt = now;
    }
    return this.#availability;
  }

  /**
   * The judge-kind version a Laya enable prepares: the newest live version if it is exactly this release's reviewed
   * document, otherwise a new immutable version of it. Unavailable refuses before any version, intent or file exists.
   */
  enablementVersion(): { readonly version: number } | ReturnType<typeof unavailableResult> {
    const availability = this.availability();
    if (!availability.available) return unavailableResult(availability.code);
    return this.#store.immediate(() => {
      const latest = this.#store.database
        .prepare(
          `SELECT version, document FROM judge_kind_versions
            WHERE kind = ? AND revoked_at IS NULL ORDER BY version DESC LIMIT 1`,
        )
        .get(JUDGE_KIND_LAYA) as { version: number; document: string } | undefined;
      if (latest !== undefined) {
        const release = this.#definition.preview({ version: latest.version });
        if (canonicalJson(JSON.parse(latest.document)) === canonicalJson(release)) return { version: latest.version };
      }
      const highest = this.#store.database
        .prepare('SELECT max(version) AS version FROM judge_kind_versions WHERE kind = ?')
        .get(JUDGE_KIND_LAYA) as { version: number | null };
      const version = (highest.version ?? 0) + 1;
      new ImmutableVersions(this.#store.database, this.#inputs).createJudgeKind(
        this.#definition.prepareEnablement({ version }),
      );
      return { version };
    });
  }

  /** E's kind-list entry: the real pointer state while Laya is offered, its closed reason while it is not. */
  kindEntry():
    | { readonly kind: typeof JUDGE_KIND_LAYA; readonly state: 'disabled' | 'enabled'; readonly version: number | null }
    | { readonly kind: typeof JUDGE_KIND_LAYA; readonly state: 'unavailable'; readonly code: LayaUnavailableCode } {
    const active = this.#activeEnablement();
    if (active !== null) return { kind: JUDGE_KIND_LAYA, state: 'enabled', version: active.version };
    const availability = this.availability();
    if (!availability.available) return { kind: JUDGE_KIND_LAYA, state: 'unavailable', code: availability.code };
    return { kind: JUDGE_KIND_LAYA, state: 'disabled', version: null };
  }

  /**
   * Starts (or joins) the install for the active pointer. Before the enablement's claim there is no pointer, so this
   * does nothing: no request, row, directory or file. It never rejects; a failure becomes closed model state.
   */
  ensureInstalled(): Promise<void> {
    try {
      return this.#ensureInstalled();
    } catch {
      // A store that cannot be read here starts nothing; the next claim, start or status read sees the same store.
      return Promise.resolve();
    }
  }

  #ensureInstalled(): Promise<void> {
    if (this.#stopped) return Promise.resolve();
    const active = this.#activeEnablement();
    if (active === null) return Promise.resolve();
    const running = this.#job;
    if (running !== undefined && running.epoch === this.#epoch && running.version === active.version)
      return running.settled;
    const selection = this.#selectionFor(active);
    if (selection === null || !this.availability().available) return Promise.resolve();
    const job: ArtifactJob = {
      epoch: this.#epoch,
      version: active.version,
      digest: active.digest,
      selection,
      controller: new AbortController(),
      phase: 'installing',
      runtimeBytes: 0,
      modelProgress: new Map(),
      settled: Promise.resolve(),
    };
    const previous = running?.settled ?? Promise.resolve();
    this.#job = job;
    job.settled = previous
      .then(() => this.#install(job))
      .finally(() => {
        if (this.#job === job) this.#job = undefined;
      });
    return job.settled;
  }

  /** Start-up's resume: an approved, unfinished install continues; a ready or failed model waits for its person. */
  async resume(): Promise<void> {
    const active = this.#activeEnablement();
    if (active === null) return;
    const selection = this.#selectionFor(active);
    if (selection === null) return;
    const row = this.#models.get(selection.manifest.manifestId);
    if (row?.state === 'ready' || row?.state === 'failed') return;
    await this.ensureInstalled();
  }

  /**
   * E's immediate kind disable, wrapped: this manager's work is fenced and aborted first, E's whole disable
   * transaction runs under the artifact lock (so no promotion can land between its last recheck and its rename), and
   * then the partial and staging trees the disable orphaned are deleted. Verified trees survive.
   */
  async disableKind<T>(disable: () => T): Promise<T> {
    const job = this.#fence();
    const result = await this.#mutex.run(async () => {
      const disabled = disable();
      await this.#removeUnverified();
      return disabled;
    });
    await job?.settled.catch(() => undefined);
    // D11: a disabled kind's worker exits. In-flight work was already stopped by E's purge of its reservation.
    await this.#worker?.stop();
    return result;
  }

  /**
   * D11's start-up update rule. While Laya is enabled, its approved document is compared with this release's; any
   * difference applies E's kind-disable tightening with `model-changed` or `runtime-changed`, keeps verified trees,
   * and never re-approves. The tightening rechecks that the compared pointer is still the active one.
   */
  async reconcileRelease(disable: () => unknown): Promise<LayaUpdateReason | null> {
    const compared = this.#activeEnablement();
    if (compared === null) return null;
    let release: CanonicalLayaEnablement | null;
    try {
      release = this.#definition.preview({ version: compared.version });
    } catch {
      release = null;
    }
    const reason: LayaUpdateReason | null =
      release === null ? 'runtime-changed' : layaUpdateReason(compared.document, release);
    if (reason === null) return null;
    const job = this.#fence();
    const applied = await this.#locked('update-disable', async () => {
      const live = this.#activeEnablement();
      if (live === null || live.version !== compared.version || live.digest !== compared.digest) return false;
      disable();
      await this.#removeUnverified();
      return true;
    });
    await job?.settled.catch(() => undefined);
    if (!applied) return null;
    await this.#worker?.stop();
    await this.#audit?.append({
      inboxId: '',
      operation: 'events.disableJudgeKind',
      outcome: 'ok',
      reason,
      ids: { kind: JUDGE_KIND_LAYA, version: String(compared.version) },
      surface: 'daemon',
      origin: 'daemon',
    });
    return reason;
  }

  /**
   * `judge model remove` (D11): only while Laya is disabled, deletes every verified runtime and model tree under the
   * Laya root — an earlier release's first, then this release's own with its unverified copies. Another selection's
   * partial or staging tree is a disable's to delete, never a removal's. Each asynchronous deletion is followed by a
   * recheck that Laya is still disabled; an enablement claimed meanwhile stops the removal and owns what remains.
   */
  async remove(): Promise<LayaModelStatus> {
    // The lock is held only briefly by an enabled kind's work, so a refusal is prompt; a disable already fenced every
    // job, and a stale one's own cleanup touches only its unverified trees.
    await this.#mutex.run(async () => {
      if (this.#activeEnablement() !== null)
        throw layaRefusal('LAYA_ENABLED', 'disable the Laya judge kind before removing its model');
      if (!(await this.#removeEarlierVerifiedTrees())) return;
      const manifestId = this.#manifestId();
      // Trees exist only after a claimed job recorded model state: an installation that never had one has nothing here.
      const recorded = manifestId === null ? null : this.#models.get(manifestId);
      if (recorded === null || recorded.state === 'removed') return;
      const release = this.#releaseSelection();
      if (release !== null) {
        const runtimeRoot = this.#runtimeRoot(release);
        await rm(runtimeRoot, { recursive: true, force: true });
        await rm(`${runtimeRoot}.staging`, { recursive: true, force: true });
      }
      await this.#failpoint?.('remove-model');
      const claimedDuringRuntimeRemoval = this.#activeEnablement() !== null;
      if (claimedDuringRuntimeRemoval) return;
      if (manifestId !== null) {
        const paths = layaModelArtifactPaths(this.#root, manifestId);
        await rm(paths.complete, { recursive: true, force: true });
        await rm(paths.partial, { recursive: true, force: true });
      }
      if (this.#activeEnablement() !== null || manifestId === null) return;
      this.#store.immediate(() => this.#models.markRemovedWhileDisabled({ manifestId, now: this.#now() }));
    });
    return this.status();
  }

  /**
   * Immediately before a worker may start: both whole trees are walked and compared with the enabled lock and
   * manifest. A failing tree is recorded as `integrity`, deleted and reinstalled once from its pinned source; if the
   * fresh copy fails too, Laya stays `failed` until its person acts. Paths stay inside the daemon.
   */
  async verifyForWorkerStart(): Promise<
    | { readonly ok: true; readonly runtimeRoot: string; readonly modelRoot: string }
    | { readonly ok: false; readonly failureCode: LayaModelFailureCode | null }
  > {
    const active = this.#activeEnablement();
    if (active === null) throw layaRefusal('LAYA_NOT_READY', 'the Laya judge kind is not enabled');
    const selection = this.#selectionFor(active);
    const row = selection === null ? null : this.#models.get(selection.manifest.manifestId);
    if (selection === null || row?.state !== 'ready' || this.#job !== undefined)
      return { ok: false, failureCode: row?.failureCode ?? null };
    // The walks below are awaits. A disable and re-enable claims the same version and digest again, so only the epoch
    // shows that the selection they compared was fenced; a job begun meanwhile owns the trees after them.
    const walkedEpoch = this.#epoch;
    const runtimeRoot = this.#runtimeRoot(selection);
    const modelRoot = layaModelArtifactPaths(this.#root, selection.manifest.manifestId).complete;
    const runtimeOk = (await verifyRuntimeTree({ root: runtimeRoot, files: runtimeFiles(selection) })).ok;
    const modelOk = (await verifyRuntimeTree({ root: modelRoot, files: modelFiles(selection) })).ok;
    await this.#failpoint?.('worker-start-verify');
    if (runtimeOk && modelOk) return { ok: true, runtimeRoot, modelRoot };
    if (walkedEpoch !== this.#epoch || this.#job !== undefined) return { ok: false, failureCode: null };
    const job = this.#repairJob(active, selection);
    const settled = this.#repair(job, { runtime: !runtimeOk, model: !modelOk });
    job.settled = settled.then(
      () => undefined,
      () => undefined,
    );
    this.#job = job;
    try {
      const repaired = await settled;
      return repaired ? { ok: true, runtimeRoot, modelRoot } : { ok: false, failureCode: 'integrity' };
    } finally {
      if (this.#job === job) this.#job = undefined;
    }
  }

  /** The stable status answer: the DTO `judge model status`, `doctor` and the desktop app read. */
  status(): LayaModelStatus {
    const availability = this.availability();
    const active = this.#activeEnablement();
    if (active === null) {
      if (!availability.available) {
        const blocked = this.#definition.status();
        return {
          state: 'unavailable',
          manifestId: blocked.manifestId,
          runtimeLockDigest: blocked.runtimeLockDigest,
          bytesVerified: blocked.bytesVerified,
          totalBytes: blocked.totalBytes,
          failureCode: null,
          reason: availability.code,
          updatedAt: blocked.updatedAt,
        };
      }
      const release = this.#releaseSelection();
      if (release === null) return this.#definition.status();
      const row = this.#models.get(release.manifest.manifestId);
      return {
        state: 'idle',
        manifestId: release.manifest.manifestId,
        runtimeLockDigest: release.runtimeLock.digest,
        bytesVerified: row?.state === 'ready' ? row.bytesVerified : 0,
        totalBytes: totalBytes(release),
        failureCode: null,
        reason: null,
        updatedAt: row?.updatedAt ?? null,
      };
    }
    const enabled = this.#enabledShape(active);
    const row = enabled === null ? null : this.#models.get(enabled.manifestId);
    const answer = (
      state: LayaModelStatus['state'],
      bytesVerified: number,
      failureCode: LayaModelStatus['failureCode'],
      reason: LayaModelStatus['reason'],
    ): LayaModelStatus => ({
      state,
      manifestId: enabled?.manifestId ?? null,
      runtimeLockDigest: enabled?.runtimeLockDigest ?? null,
      bytesVerified,
      totalBytes: enabled?.totalBytes ?? 0,
      failureCode,
      reason,
      updatedAt: row?.updatedAt ?? null,
    });
    if (!availability.available) return answer('failed', row?.bytesVerified ?? 0, 'boundary-failed', availability.code);
    const job = this.#job;
    if (job !== undefined && job.version === active.version && job.epoch === this.#epoch)
      return answer(job.phase, this.#progress(job), null, null);
    if (row === null || row.state === 'removed') return answer('installing', 0, null, null);
    return answer(row.state, row.bytesVerified, row.state === 'failed' ? row.failureCode : null, null);
  }

  /** The doctor's view: the status answer plus the runtime and model states and the boundary reason, never a path. */
  async doctor(): Promise<LayaArtifactDoctor> {
    const status = this.status();
    const availability = this.availability();
    const job = this.#job;
    let runtime: LayaArtifactDoctor['runtime'] = 'absent';
    if (job !== undefined && job.phase === 'installing') runtime = 'installing';
    else if (status.runtimeLockDigest !== null && /^[a-f0-9]{64}$/.test(status.runtimeLockDigest))
      runtime = (await isDirectory(join(this.#root, 'runtime', status.runtimeLockDigest))) ? 'installed' : 'absent';
    const row = status.manifestId === null ? null : this.#models.get(status.manifestId);
    return {
      state: status.state,
      manifestId: status.manifestId,
      runtimeLockDigest: status.runtimeLockDigest,
      runtime,
      model: row?.state ?? 'absent',
      boundary: availability.available
        ? { status: 'active', reason: null }
        : { status: 'unavailable', reason: availability.code },
      failureCode: status.failureCode,
      bytesVerified: status.bytesVerified,
      totalBytes: status.totalBytes,
    };
  }

  /** Task 8's one worker supervisor; the returned function detaches exactly that supervisor. */
  attachWorker(worker: LayaWorkerStopper): () => void {
    if (this.#worker !== undefined) throw new Error('a Laya worker supervisor is already attached');
    this.#worker = worker;
    return () => {
      if (this.#worker === worker) this.#worker = undefined;
    };
  }

  /**
   * The selection a worker may start for: the active pointer, only while its document is exactly this release's
   * reviewed one, with the manager's current epoch. Null before an enablement, after a disable, an update or a stop.
   */
  workerSelection(): LayaWorkerSelection | null {
    if (this.#stopped) return null;
    const active = this.#activeEnablement();
    if (active === null) return null;
    const selection = this.#selectionFor(active);
    if (selection === null) return null;
    return {
      epoch: this.#epoch,
      version: active.version,
      digest: active.digest,
      manifestId: selection.manifest.manifestId,
      promptTemplates: selection.manifest.promptTemplates,
    };
  }

  /**
   * D11: a worker whose per-start boundary proof failed, or whose verified runtime would not load, leaves Laya
   * `failed` with that closed code until its person acts — no later request starts another child for it. The write is
   * made only while the selection that worker verified is still the current one, in the same transaction.
   */
  recordWorkerFailure(started: LayaWorkerSelection, failureCode: 'boundary-failed' | 'runtime-failed'): void {
    try {
      this.#store.immediate(() => {
        const current = this.workerSelection();
        if (
          current === null ||
          current.epoch !== started.epoch ||
          current.version !== started.version ||
          current.digest !== started.digest
        )
          return;
        const row = this.#models.get(started.manifestId);
        if (row?.state !== 'ready') return;
        this.#models.write({
          manifestId: started.manifestId,
          state: 'failed',
          bytesVerified: row.bytesVerified,
          failureCode,
          now: this.#now(),
        });
      });
    } catch {
      // A store that cannot be written records nothing; the supervisor has already killed that worker.
    }
  }

  /**
   * Task 8's supervisor registers each in-flight worker request by its E reservation. The returned signal fires when
   * an E purge terminalises exactly that reservation; nothing else is touched.
   */
  trackWork(reservationId: string): { readonly signal: AbortSignal; release(): void } {
    const controller = new AbortController();
    const work: TrackedWork = { reservationId, controller };
    this.#tracked.set(reservationId, work);
    return {
      signal: controller.signal,
      release: () => {
        if (this.#tracked.get(reservationId) === work) this.#tracked.delete(reservationId);
      },
    };
  }

  /**
   * E's purge participant calls this inside the purge transaction, after its recovery transition. Only tracked work
   * whose own reservation that transition settled or released is stopped: an account, rule, hold, visibility,
   * expiry or disable-all purge never touches an installation-wide verified tree or another scope's work.
   */
  onWorkPurged(): void {
    for (const work of [...this.#tracked.values()]) {
      const row = this.#store.database
        .prepare('SELECT state FROM judge_budget_reservations WHERE id = ?')
        .get(work.reservationId) as { state: string } | undefined;
      if (row !== undefined && (row.state === 'reserved' || row.state === 'in-flight')) continue;
      this.#tracked.delete(work.reservationId);
      work.controller.abort(new ArtifactWorkStale());
    }
  }

  /** Owner stop: no job outlives the database it writes to. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const job = this.#fence();
    for (const work of this.#tracked.values()) work.controller.abort(new ArtifactWorkStale());
    this.#tracked.clear();
    await job?.settled.catch(() => undefined);
    await this.#worker?.stop();
  }

  #fence(): ArtifactJob | undefined {
    this.#epoch += 1;
    const job = this.#job;
    job?.controller.abort(new ArtifactWorkStale());
    return job;
  }

  #locked<T>(edge: LayaArtifactEdge, work: () => Promise<T>): Promise<T> {
    return this.#mutex.run(async () => {
      await this.#failpoint?.(edge);
      return work();
    });
  }

  #activeEnablement(): ActiveEnablement | null {
    const row = this.#store.database
      .prepare(
        `SELECT active.version AS version, versions.document AS document, versions.digest AS digest
           FROM active_versions AS active
           JOIN judge_kind_versions AS versions
             ON versions.kind = active.object_id AND versions.version = active.version
          WHERE active.kind = 'judge-kind' AND active.object_id = ?`,
      )
      .get(JUDGE_KIND_LAYA) as { version: number; document: string; digest: string } | undefined;
    if (row === undefined) return null;
    let document: unknown;
    try {
      document = JSON.parse(row.document);
    } catch {
      document = null;
    }
    return { version: row.version, digest: row.digest, document };
  }

  /** The active document, only when it is exactly this release's reviewed document; an update leaves it null. */
  #selectionFor(active: ActiveEnablement): CanonicalLayaEnablement | null {
    try {
      const release = this.#definition.preview({ version: active.version });
      return layaUpdateReason(active.document, release) === null ? release : null;
    } catch {
      return null;
    }
  }

  #releaseSelection(): CanonicalLayaEnablement | null {
    try {
      return this.#definition.preview({ version: 1 });
    } catch {
      return null;
    }
  }

  #manifestId(): string | null {
    return this.#releaseSelection()?.manifest.manifestId ?? this.#definition.status().manifestId;
  }

  /** The content-free identity of an enabled document, read even when this release no longer matches it. */
  #enabledShape(
    active: ActiveEnablement,
  ): { readonly manifestId: string; readonly runtimeLockDigest: string; readonly totalBytes: number } | null {
    const selection = this.#selectionFor(active);
    if (selection !== null)
      return {
        manifestId: selection.manifest.manifestId,
        runtimeLockDigest: selection.runtimeLock.digest,
        totalBytes: totalBytes(selection),
      };
    const document = active.document as Partial<CanonicalLayaEnablement> | null;
    const manifestId = document?.manifest?.manifestId;
    const digest = document?.runtimeLock?.digest;
    if (typeof manifestId !== 'string' || typeof digest !== 'string') return null;
    const files = [...(document?.manifest?.files ?? []), ...(document?.runtimeLock?.platform?.files ?? [])];
    return { manifestId, runtimeLockDigest: digest, totalBytes: bytesOf(files) };
  }

  #runtimeRoot(selection: CanonicalLayaEnablement): string {
    const digest = selection.runtimeLock.digest;
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new ArtifactFailure('runtime-failed');
    return join(this.#root, 'runtime', digest);
  }

  #progress(job: ArtifactJob): number {
    let model = 0;
    for (const bytes of job.modelProgress.values()) model += bytes;
    return Math.min(job.runtimeBytes + model, totalBytes(job.selection));
  }

  /** The synchronous recheck every post-await step makes: same pointer version, same document, same epoch. */
  #assertCurrent(job: ArtifactJob): void {
    if (this.#stopped || job.epoch !== this.#epoch || job.controller.signal.aborted) throw new ArtifactWorkStale();
    const active = this.#activeEnablement();
    if (active === null || active.version !== job.version || active.digest !== job.digest)
      throw new ArtifactWorkStale();
  }

  #isCurrent(job: ArtifactJob): boolean {
    try {
      this.#assertCurrent(job);
      return true;
    } catch {
      return false;
    }
  }

  #write(job: ArtifactJob, state: LayaModelState, bytesVerified: number, failureCode?: LayaModelFailureCode): void {
    this.#store.immediate(() => {
      this.#assertCurrent(job);
      this.#models.write({
        manifestId: job.selection.manifest.manifestId,
        state,
        bytesVerified,
        ...(state === 'ready' ? { verifiedAt: this.#now() } : {}),
        ...(failureCode === undefined ? {} : { failureCode }),
        now: this.#now(),
      });
    });
  }

  #fenceFor(job: ArtifactJob): LayaArtifactFence {
    return {
      assertCurrent: async (stage) => {
        if (stage === 'promotion') await this.#failpoint?.('model-promotion');
        this.#assertCurrent(job);
      },
      withArtifactLock: (work) => this.#mutex.run(work),
    };
  }

  async #install(job: ArtifactJob): Promise<void> {
    try {
      await this.#locked('install-start', async () => {
        this.#write(job, 'installing', 0);
      });
      const selection = job.selection;
      const runtimeRoot = this.#runtimeRoot(selection);
      if (!(await verifyRuntimeTree({ root: runtimeRoot, files: runtimeFiles(selection) })).ok) {
        this.#assertCurrent(job);
        await this.#installRuntime(job, { replace: await isDirectory(runtimeRoot) });
      }
      this.#assertCurrent(job);
      job.runtimeBytes = bytesOf(selection.runtimeLock.platform.files);
      this.#write(job, 'downloading', job.runtimeBytes);
      job.phase = 'downloading';
      const modelRoot = layaModelArtifactPaths(this.#root, selection.manifest.manifestId).complete;
      if (!(await verifyRuntimeTree({ root: modelRoot, files: modelFiles(selection) })).ok) {
        this.#assertCurrent(job);
        await this.#downloadModel(job, { replace: await isDirectory(modelRoot) });
      }
      job.phase = 'verifying';
      const runtime = await verifyRuntimeTree({ root: runtimeRoot, files: runtimeFiles(selection) });
      const model = await verifyRuntimeTree({ root: modelRoot, files: modelFiles(selection) });
      if (!runtime.ok || !model.ok) throw new ArtifactFailure('integrity');
      await this.#locked('model-ready', async () => {
        this.#write(job, 'ready', totalBytes(selection));
        await this.#removeObsoleteTrees(job);
      });
    } catch (error) {
      this.#recordFailure(job, error);
    }
  }

  #recordFailure(job: ArtifactJob, error: unknown): void {
    if (error instanceof ArtifactWorkStale || !this.#isCurrent(job)) return;
    const failureCode =
      error instanceof ArtifactFailure
        ? error.failureCode
        : job.phase === 'installing'
          ? 'runtime-failed'
          : job.phase === 'downloading'
            ? 'download-failed'
            : 'integrity';
    try {
      this.#write(job, 'failed', this.#progress(job), failureCode);
    } catch {
      // The pointer or epoch moved between the failure and its record: the newer owner reports its own state.
    }
  }

  /**
   * Fetches every SRI-pinned archive, extracts only the selected platform's listed files into a staging tree that
   * the strict installer verifies, then promotes that tree inside the artifact lock after the exact recheck.
   */
  async #installRuntime(job: ArtifactJob, options: { readonly replace: boolean }): Promise<void> {
    const selection = job.selection;
    const runtimeRoot = this.#runtimeRoot(selection);
    const staging = `${runtimeRoot}.staging`;
    const files = runtimeFiles(selection);
    await ownerOnlyDirectory(join(this.#root, 'runtime'));
    const free = await (this.#freeBytes ?? (() => availableBytes(join(this.#root, 'runtime'))))();
    if (!Number.isSafeInteger(free) || free < Math.ceil(bytesOf(files) * 1.1))
      throw new ArtifactFailure('runtime-failed');
    const fetcher = this.#fetcher(job);
    const packages = [];
    for (const pkg of selection.runtimeLock.packages) {
      if (!files.some((file) => file.packageName === pkg.name)) continue;
      this.#assertCurrent(job);
      const bytes = await fetcher.fetchRuntimeArchive(pkg, { signal: job.controller.signal });
      packages.push({
        packageName: pkg.name,
        source: (async function* () {
          yield bytes;
        })(),
      });
    }
    this.#assertCurrent(job);
    await rm(staging, { recursive: true, force: true });
    try {
      const installed = await installRuntime({
        runtimeDirectory: staging,
        lockDigest: selection.runtimeLock.digest,
        packages,
        files,
      });
      await this.#locked('runtime-promotion', async () => {
        this.#assertCurrent(job);
        if (options.replace) await rm(runtimeRoot, { recursive: true, force: true });
        await rename(installed.root, runtimeRoot);
      });
    } finally {
      // Extraction is not abortable, so a disable can clean up before it ends; the job removes its own staging tree,
      // and the next job for this lock waits for this one to settle first.
      await rm(staging, { recursive: true, force: true });
    }
  }

  async #downloadModel(job: ArtifactJob, options: { readonly replace: boolean }): Promise<void> {
    const selection = job.selection;
    const paths = layaModelArtifactPaths(this.#root, selection.manifest.manifestId);
    if (options.replace)
      await this.#mutex.run(async () => {
        this.#assertCurrent(job);
        await rm(paths.complete, { recursive: true, force: true });
      });
    const downloader = new LayaModelDownloader({
      dataDirectory: this.#root,
      manifest: selection.manifest,
      fetcher: this.#fetcher(job),
      fence: this.#fenceFor(job),
    });
    await downloader.download({
      signal: job.controller.signal,
      ...(this.#freeBytes === undefined ? {} : { freeBytes: this.#freeBytes }),
    });
  }

  #fetcher(job: ArtifactJob): ProgressReportingArtifactFetcher {
    return new ProgressReportingArtifactFetcher(
      {
        manifest: job.selection.manifest,
        runtimePackages: job.selection.runtimeLock.packages,
        resolver: this.#network.resolver,
        tcpConnect: this.#network.tcpConnect,
        tlsConnect: this.#network.tlsConnect,
      },
      job.modelProgress,
    );
  }

  #repairJob(active: ActiveEnablement, selection: CanonicalLayaEnablement): ArtifactJob {
    return {
      epoch: this.#epoch,
      version: active.version,
      digest: active.digest,
      selection,
      controller: new AbortController(),
      phase: 'installing',
      runtimeBytes: 0,
      modelProgress: new Map(),
      settled: Promise.resolve(),
    };
  }

  /** One repair per failing tree; the fresh copy must verify or Laya records `integrity` and stays failed. */
  async #repair(job: ArtifactJob, failing: { readonly runtime: boolean; readonly model: boolean }): Promise<boolean> {
    const selection = job.selection;
    const runtimeRoot = this.#runtimeRoot(selection);
    const modelRoot = layaModelArtifactPaths(this.#root, selection.manifest.manifestId).complete;
    try {
      await this.#locked('repair-delete', async () => {
        // The walk above was an await: only the selection it compared, still enabled, may lose its failing tree.
        this.#assertCurrent(job);
        if (failing.runtime) await rm(runtimeRoot, { recursive: true, force: true });
        if (failing.model) await rm(modelRoot, { recursive: true, force: true });
        this.#write(job, 'failed', 0, 'integrity');
      });
      if (failing.runtime) await this.#installRuntime(job, { replace: false });
      job.runtimeBytes = bytesOf(selection.runtimeLock.platform.files);
      job.phase = 'downloading';
      if (failing.model) await this.#downloadModel(job, { replace: false });
      job.phase = 'verifying';
      const runtime = await verifyRuntimeTree({ root: runtimeRoot, files: runtimeFiles(selection) });
      const model = await verifyRuntimeTree({ root: modelRoot, files: modelFiles(selection) });
      if (!runtime.ok || !model.ok) throw new ArtifactFailure('integrity');
      await this.#locked('model-ready', async () => {
        this.#write(job, 'ready', totalBytes(selection));
        await this.#removeObsoleteTrees(job);
      });
      return true;
    } catch (error) {
      if (error instanceof ArtifactWorkStale || !this.#isCurrent(job)) return false;
      try {
        this.#write(job, 'failed', 0, 'integrity');
      } catch {
        // A newer pointer or epoch owns the record.
      }
      return false;
    }
  }

  /**
   * D11 and E2-5: once a selection's model is ready, a tree no enabled entry names is obsolete. Inside the
   * `model-ready` lock, every `runtime/` and `models/` entry but the selection's own two is deleted, partial and staging
   * trees included, and the sweep stops at its first recheck that finds the job fenced by a disable, update or stop.
   */
  #removeObsoleteTrees(job: ArtifactJob): Promise<boolean> {
    const named = { runtime: job.selection.runtimeLock.digest, models: job.selection.manifest.manifestId };
    return this.#sweepTrees(
      (directory, name) => name === named[directory],
      () => this.#isCurrent(job),
    );
  }

  /**
   * `judge model remove`'s sweep of every verified tree but this release's own, which the removal then deletes with
   * its unverified copies. It stops at its first recheck that finds an enablement claimed meanwhile.
   */
  #removeEarlierVerifiedTrees(): Promise<boolean> {
    const own = { runtime: this.#releaseSelection()?.runtimeLock.digest, models: this.#manifestId() };
    return this.#sweepTrees(
      (directory, name) => name.endsWith('.partial') || name.endsWith('.staging') || name === own[directory],
      () => this.#activeEnablement() === null,
    );
  }

  /**
   * Deletes, one at a time in raw-byte name order, every entry under `runtime/` and `models/` that `keep` does not
   * name, rechecking `current` after every await: a tightening or a claim that lands meanwhile stops the sweep before
   * its next deletion. A deletion that fails is left for the next sweep. Resolves whether the sweep finished. Its
   * callers hold the artifact lock.
   */
  async #sweepTrees(
    keep: (directory: 'runtime' | 'models', name: string) => boolean,
    current: () => boolean,
  ): Promise<boolean> {
    for (const directory of ['runtime', 'models'] as const) {
      let names: string[];
      try {
        names = await readdir(join(this.#root, directory));
      } catch {
        names = [];
      }
      if (!current()) return false;
      names.sort((left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)));
      for (const name of names) {
        if (keep(directory, name)) continue;
        await rm(join(this.#root, directory, name), { recursive: true, force: true }).catch(() => undefined);
        await this.#failpoint?.('tree-sweep');
        if (!current()) return false;
      }
    }
    return true;
  }

  /** Deletes every partial and staging tree beneath the artifact root, and never a verified one. */
  async #removeUnverified(): Promise<void> {
    for (const directory of ['runtime', 'models']) {
      const parent = join(this.#root, directory);
      let names: string[];
      try {
        names = await readdir(parent);
      } catch {
        continue;
      }
      for (const name of names) {
        if (name.endsWith('.partial') || name.endsWith('.staging'))
          await rm(join(parent, name), { recursive: true, force: true });
      }
    }
  }
}

function unavailableResult(code: LayaUnavailableCode): {
  readonly kind: 'unavailable';
  readonly code: LayaUnavailableCode;
  readonly phase: 'E2';
} {
  return { kind: 'unavailable', code, phase: 'E2' };
}
