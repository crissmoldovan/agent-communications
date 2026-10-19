import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type {
  LayaJudgeAvailability,
  LayaJudgeUnavailable,
  LayaModelFailureCode,
  LayaUnavailableCode,
} from './contracts.ts';
import type { LayaWorkerSelection, LayaWorkerStopper } from './manager.ts';
import { isLayaTemplateId, LAYA_MAX_SEQUENCE_TOKENS, type LayaTemplateId } from './templates.ts';
import { createLayaWorkerBoundary, type LayaBoundaryResult, type LayaWorkerBinding } from './worker-boundary-probe.ts';
import {
  createWorkerRequestId,
  encodeWorkerFrame,
  WORKER_FRAME_MAX_BYTES,
  type WorkerFrame,
  WorkerFrameParser,
} from './worker-protocol.ts';

/** D11: a call not answered within 30 seconds is a timeout, and the daemon kills the worker. */
export const LAYA_REQUEST_DEADLINE_MS = 30_000;
/** D11: the worker exits after ten idle minutes. */
export const LAYA_IDLE_EXIT_MS = 600_000;
/** Loading about 1.7 GB of weights is bounded too: a load not answered in two minutes kills the child. */
export const LAYA_LOAD_DEADLINE_MS = 120_000;
/**
 * Each worker's owner-only working and proof directory is a fresh `mkdtemp` beneath `/tmp`, which is sticky and owned
 * by root as B1-G's socket-directory check accepts. Task 7's probe binds `<directory>/laya-boundary-XXXXXX/
 * boundary.sock`, 35 bytes beyond it, so this 27-byte directory keeps the socket at 62 bytes, inside macOS's 103 for
 * any home: core's data directory fits only while the home is at most 22 bytes.
 */
export const LAYA_WORKER_DIRECTORY_PARENT = '/tmp';
const LAYA_WORKER_DIRECTORY_PREFIX = 'agentcomms-laya-';
/** A request frame's own fields — its type, the child's binding and a request id — beside the reserved payload. */
const LAYA_REQUEST_FRAME_OVERHEAD_BYTES = 4_096;

/** The Laya judge document as E hands it over: the manifest entry (its model) and the template it approved. */
export interface LayaExecutionJudge {
  readonly model: string;
  readonly promptTemplate: string;
}

/** The exact request one worker frame carries, and the payload bytes E reserves against as their estimate. */
export interface LayaPreparedRequest {
  readonly templateId: LayaTemplateId;
  readonly instructions: string;
  readonly state: string;
  readonly body: Buffer;
}

/**
 * Closed, content-free reasons a Laya call produced no answer. `preIo` is true when no request frame reached the
 * worker, so E's gate left the reservation released; otherwise E settles it as post-I/O work, and D5 records no-match.
 */
export type LayaExecutionRefusalCode =
  | LayaUnavailableCode
  | LayaModelFailureCode
  | 'laya-adapter-blocked'
  | 'laya-request-too-large'
  | 'laya-not-ready'
  | 'laya-authority-changed'
  | 'laya-purged'
  | 'laya-stopped'
  | 'laya-timeout'
  | 'laya-crashed'
  | 'laya-malformed'
  | 'laya-token-limit'
  | 'laya-template-blocked';

export type LayaExecutionResult =
  | { readonly kind: 'answer'; readonly value: number; readonly inputTokens: number }
  | { readonly kind: 'refused'; readonly code: LayaExecutionRefusalCode; readonly preIo: boolean };

export interface LayaExecutionHooks {
  /** E's reservation id: the only identity a request has, here and for E's purge listener. */
  readonly reservationId: string;
  /**
   * E's synchronous reserved → in-flight transition. It runs immediately before the request frame is written, with no
   * await between the two; a refusal leaves the reservation released and no byte on the pipe.
   */
  readonly finalGate: () => void;
}

/** What E's coordinator and judge test call: the one Laya executor of their database's owner. */
export interface LayaJudgeExecutor {
  availability(): LayaJudgeAvailability | LayaJudgeUnavailable;
  prepare(
    input: Readonly<{ judge: LayaExecutionJudge; state: string; instructions: string }>,
  ):
    | { readonly ok: true; readonly request: LayaPreparedRequest }
    | { readonly ok: false; readonly code: LayaExecutionRefusalCode };
  execute(request: LayaPreparedRequest, hooks: LayaExecutionHooks): Promise<LayaExecutionResult>;
}

/** The artifact manager's narrow surface: no database, account, event, target or secret reaches the supervisor. */
export interface LayaWorkerArtifacts {
  availability(): LayaJudgeAvailability | LayaJudgeUnavailable;
  workerSelection(): LayaWorkerSelection | null;
  verifyForWorkerStart(): Promise<
    | { readonly ok: true; readonly runtimeRoot: string; readonly modelRoot: string }
    | { readonly ok: false; readonly failureCode: LayaModelFailureCode | null }
  >;
  recordWorkerFailure(started: LayaWorkerSelection, failureCode: 'boundary-failed' | 'runtime-failed'): void;
  trackWork(reservationId: string): { readonly signal: AbortSignal; release(): void };
  attachWorker(worker: LayaWorkerStopper): () => void;
}

/** Production proves and launches only the shipped worker entry, through Task 7; a test hands its stand-in here. */
export type LayaWorkerStart = (options: {
  readonly dataDirectory: string;
  readonly signal: AbortSignal;
}) => Promise<LayaBoundaryResult>;

export interface LayaWorkerSupervisorOptions {
  readonly artifacts: LayaWorkerArtifacts;
  /** Test seam only: the owner passes none. */
  readonly startWorker?: LayaWorkerStart | undefined;
  /** Test seams only: production uses D11's 30 seconds, ten idle minutes and the bounded load. */
  readonly requestDeadlineMs?: number | undefined;
  readonly idleExitMs?: number | undefined;
  readonly loadDeadlineMs?: number | undefined;
}

interface Pending {
  frame(frame: WorkerFrame): void;
  gone(code: LayaExecutionRefusalCode): void;
}

interface RunningWorker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly binding: LayaWorkerBinding;
  readonly selection: LayaWorkerSelection;
  readonly directory: string;
  readonly close: () => Promise<void>;
  /** The one frame the protocol expects now; none means any frame kills the child. */
  pending: Pending | undefined;
  idle: NodeJS.Timeout | undefined;
  closing: Promise<void> | undefined;
}

type Expected<T> = { readonly value: T } | { readonly gone: LayaExecutionRefusalCode };

const BINDING_FIELDS = ['nonce', 'pid', 'profile', 'entry', 'pipeGeneration'] as const;

function sameSelection(current: LayaWorkerSelection | null, started: LayaWorkerSelection): boolean {
  return (
    current !== null &&
    current.epoch === started.epoch &&
    current.version === started.version &&
    current.digest === started.digest &&
    current.manifestId === started.manifestId
  );
}

function exactFrame(frame: WorkerFrame, keys: readonly string[]): boolean {
  const found = Object.keys(frame).sort();
  const expected = [...keys].sort();
  return found.length === expected.length && found.every((key, index) => key === expected[index]);
}

function bound(frame: WorkerFrame, binding: LayaWorkerBinding): boolean {
  return BINDING_FIELDS.every((field) => frame[field] === binding[field]);
}

/** The worker's reply, in its closed shapes only: a finite value in [0, 1], never clamped, and its token count. */
function replyFrame(frame: WorkerFrame, binding: LayaWorkerBinding, requestId: string): LayaExecutionResult | null {
  if (!bound(frame, binding) || frame.requestId !== requestId) return null;
  if (frame.type === 'answer') {
    if (!exactFrame(frame, ['type', ...BINDING_FIELDS, 'requestId', 'value', 'inputTokens'])) return null;
    const { value, inputTokens } = frame;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) return null;
    if (!Number.isSafeInteger(inputTokens) || (inputTokens as number) < 1) return null;
    if ((inputTokens as number) > LAYA_MAX_SEQUENCE_TOKENS) return null;
    return { kind: 'answer', value, inputTokens: inputTokens as number };
  }
  if (frame.type !== 'refused' || !exactFrame(frame, ['type', ...BINDING_FIELDS, 'requestId', 'code'])) return null;
  if (frame.code === 'token-limit') return { kind: 'refused', code: 'laya-token-limit', preIo: false };
  if (frame.code === 'malformed') return { kind: 'refused', code: 'laya-malformed', preIo: false };
  if (frame.code === 'template-blocked') return { kind: 'refused', code: 'laya-template-blocked', preIo: false };
  return null;
}

function loadFrame(frame: WorkerFrame, binding: LayaWorkerBinding): 'loaded' | 'refused' | null {
  if (!bound(frame, binding)) return null;
  if (frame.type === 'loaded' && exactFrame(frame, ['type', ...BINDING_FIELDS])) return 'loaded';
  if (frame.type === 'load-refused' && exactFrame(frame, ['type', ...BINDING_FIELDS, 'code'])) return 'refused';
  return null;
}

function refusedBefore(code: LayaExecutionRefusalCode): { readonly refused: LayaExecutionResult } {
  return { refused: { kind: 'refused', code, preIo: true } };
}

/**
 * The one isolated Laya worker (E2-7, D11): started lazily, one request at a time, and killed on a 30-second
 * deadline, a crash, any frame outside the protocol, a purge of its in-flight reservation, a kind disable or update
 * tightening, the owner's stop, and after ten idle minutes. It holds no database, account, event, target or secret:
 * E's coordinator reserves, gates and settles, and this supervisor moves only one bounded request to the child and
 * its bounded answer back. A later call after any kill starts a fresh child, proved again from the beginning.
 */
export class LayaWorkerSupervisor implements LayaJudgeExecutor, LayaWorkerStopper {
  readonly #artifacts: LayaWorkerArtifacts;
  readonly #startWorker: LayaWorkerStart;
  readonly #requestDeadlineMs: number;
  readonly #idleExitMs: number;
  readonly #loadDeadlineMs: number;
  readonly #detach: () => void;
  #queue: Promise<void> = Promise.resolve();
  #worker: RunningWorker | undefined;
  /** Bumped by every stop: a start or request that began before it never adopts or keeps a worker. */
  #generation = 0;
  #stopping = new AbortController();

  constructor(options: LayaWorkerSupervisorOptions) {
    this.#artifacts = options.artifacts;
    this.#startWorker = options.startWorker ?? ((start) => createLayaWorkerBoundary(start));
    this.#requestDeadlineMs = options.requestDeadlineMs ?? LAYA_REQUEST_DEADLINE_MS;
    this.#idleExitMs = options.idleExitMs ?? LAYA_IDLE_EXIT_MS;
    this.#loadDeadlineMs = options.loadDeadlineMs ?? LAYA_LOAD_DEADLINE_MS;
    this.#detach = options.artifacts.attachWorker(this);
  }

  availability(): LayaJudgeAvailability | LayaJudgeUnavailable {
    return this.#artifacts.availability();
  }

  /**
   * Before E reserves anything: this release must offer Laya here, the enabled entry must be the judge's own manifest
   * and list the judge's template, and the request must fit one frame. The body is what E reserves against.
   */
  prepare(
    input: Readonly<{ judge: LayaExecutionJudge; state: string; instructions: string }>,
  ): ReturnType<LayaJudgeExecutor['prepare']> {
    const availability = this.#artifacts.availability();
    if (!availability.available) return { ok: false, code: availability.code };
    const selection = this.#artifacts.workerSelection();
    if (selection === null) return { ok: false, code: 'laya-not-ready' };
    const templateId = input.judge.promptTemplate;
    if (
      input.judge.model !== selection.manifestId ||
      !isLayaTemplateId(templateId) ||
      !selection.promptTemplates.includes(templateId) ||
      input.state.length === 0 ||
      input.instructions.length === 0
    )
      return { ok: false, code: 'laya-adapter-blocked' };
    const body = Buffer.from(JSON.stringify({ templateId, instructions: input.instructions, state: input.state }));
    if (body.length > WORKER_FRAME_MAX_BYTES - LAYA_REQUEST_FRAME_OVERHEAD_BYTES)
      return { ok: false, code: 'laya-request-too-large' };
    return { ok: true, request: { templateId, instructions: input.instructions, state: input.state, body } };
  }

  /**
   * One request at a time: the next one's frame is not written until this one has settled. Work is tracked by its
   * E reservation from the moment it is handed over, so a purge reaches it while it waits, too.
   */
  execute(request: LayaPreparedRequest, hooks: LayaExecutionHooks): Promise<LayaExecutionResult> {
    const tracked = this.#artifacts.trackWork(hooks.reservationId);
    const run = this.#queue.then(() => this.#execute(request, hooks, tracked.signal));
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run.finally(() => tracked.release());
  }

  /** Kills the worker — a kind disable, an update tightening, the owner's stop — and fails whatever waited on it. */
  async stop(): Promise<void> {
    this.#generation += 1;
    const stopping = this.#stopping;
    this.#stopping = new AbortController();
    stopping.abort();
    const worker = this.#worker;
    this.#worker = undefined;
    if (worker !== undefined) await this.#kill(worker, 'laya-stopped');
  }

  /** The owner's final stop: also detaches from the manager. */
  async close(): Promise<void> {
    await this.stop();
    this.#detach();
  }

  async #execute(
    request: LayaPreparedRequest,
    hooks: LayaExecutionHooks,
    signal: AbortSignal,
  ): Promise<LayaExecutionResult> {
    const generation = this.#generation;
    const stopping = this.#stopping.signal;
    if (signal.aborted) return { kind: 'refused', code: 'laya-purged', preIo: true };
    const started = await this.#ensureWorker(generation, signal, stopping);
    if ('refused' in started) return started.refused;
    const worker = started.worker;
    // Every await above may have let a disable, update, stop or purge through; none of them may meet a written frame.
    if (signal.aborted) return { kind: 'refused', code: 'laya-purged', preIo: true };
    if (generation !== this.#generation || this.#worker !== worker)
      return { kind: 'refused', code: 'laya-stopped', preIo: true };
    if (!sameSelection(this.#artifacts.workerSelection(), worker.selection))
      return { kind: 'refused', code: 'laya-authority-changed', preIo: true };
    const requestId = createWorkerRequestId();
    let bytes: Buffer;
    try {
      bytes = encodeWorkerFrame({
        type: 'request',
        ...worker.binding,
        requestId,
        templateId: request.templateId,
        instructions: request.instructions,
        state: request.state,
      });
    } catch {
      return { kind: 'refused', code: 'laya-request-too-large', preIo: true };
    }
    this.#clearIdle(worker);
    const reply = this.#expect(worker, this.#requestDeadlineMs, signal, stopping, (frame) =>
      replyFrame(frame, worker.binding, requestId),
    );
    try {
      hooks.finalGate();
    } catch {
      reply.cancel();
      this.#armIdle(worker);
      return { kind: 'refused', code: 'laya-authority-changed', preIo: true };
    }
    // Nothing sits between E's in-flight transition above and this one write of the complete frame.
    worker.child.stdin.write(bytes);
    const result = await reply.settled;
    if ('gone' in result) {
      await this.#kill(worker, result.gone);
      return { kind: 'refused', code: result.gone, preIo: false };
    }
    this.#armIdle(worker);
    return result.value;
  }

  async #ensureWorker(
    generation: number,
    signal: AbortSignal,
    stopping: AbortSignal,
  ): Promise<{ readonly worker: RunningWorker } | { readonly refused: LayaExecutionResult }> {
    const running = this.#worker;
    if (running !== undefined) return { worker: running };
    const availability = this.#artifacts.availability();
    if (!availability.available) return refusedBefore(availability.code);
    const selection = this.#artifacts.workerSelection();
    if (selection === null) return refusedBefore('laya-not-ready');
    // E2-5: both whole trees are walked and compared immediately before a child exists.
    const verified = await this.#artifacts.verifyForWorkerStart();
    if (!verified.ok) return refusedBefore(verified.failureCode ?? 'laya-not-ready');
    if (generation !== this.#generation || stopping.aborted) return refusedBefore('laya-stopped');
    if (signal.aborted) return refusedBefore('laya-purged');
    if (!sameSelection(this.#artifacts.workerSelection(), selection)) return refusedBefore('laya-authority-changed');
    let directory: string;
    try {
      directory = await mkdtemp(join(LAYA_WORKER_DIRECTORY_PARENT, LAYA_WORKER_DIRECTORY_PREFIX));
    } catch {
      return refusedBefore('boundary-failed');
    }
    const proof = new AbortController();
    const abortProof = (): void => proof.abort();
    signal.addEventListener('abort', abortProof, { once: true });
    stopping.addEventListener('abort', abortProof, { once: true });
    if (signal.aborted || stopping.aborted) proof.abort();
    let boundary: LayaBoundaryResult;
    try {
      boundary = await this.#startWorker({ dataDirectory: directory, signal: proof.signal });
    } catch {
      boundary = { ok: false, code: 'boundary-failed', loadSent: false };
    } finally {
      signal.removeEventListener('abort', abortProof);
      stopping.removeEventListener('abort', abortProof);
    }
    if (!boundary.ok) {
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
      // A proof that was stopped or purged showed nothing about the boundary: only a real failure is recorded.
      if (proof.signal.aborted) return refusedBefore(signal.aborted ? 'laya-purged' : 'laya-stopped');
      if (boundary.code === 'boundary-failed') this.#artifacts.recordWorkerFailure(selection, 'boundary-failed');
      return refusedBefore(boundary.code);
    }
    const proven = boundary;
    const worker: RunningWorker = {
      child: proven.child,
      binding: proven.binding,
      selection,
      directory,
      close: () => proven.close(),
      pending: undefined,
      idle: undefined,
      closing: undefined,
    };
    this.#read(worker);
    // E2's ledger: the load frame goes only to the proven child, while the selection its trees were verified for and
    // this supervisor's generation are unchanged.
    if (generation !== this.#generation || stopping.aborted || signal.aborted) {
      await this.#kill(worker, 'laya-stopped');
      return refusedBefore(signal.aborted ? 'laya-purged' : 'laya-stopped');
    }
    if (!sameSelection(this.#artifacts.workerSelection(), selection)) {
      await this.#kill(worker, 'laya-authority-changed');
      return refusedBefore('laya-authority-changed');
    }
    const loaded = this.#expect(worker, this.#loadDeadlineMs, signal, stopping, (frame) =>
      loadFrame(frame, worker.binding),
    );
    try {
      await proven.sendLoad({ runtimeRoot: verified.runtimeRoot, modelDir: verified.modelRoot });
    } catch {
      loaded.cancel();
      await this.#kill(worker, 'laya-crashed');
      return refusedBefore('laya-crashed');
    }
    const outcome = await loaded.settled;
    if ('gone' in outcome || outcome.value !== 'loaded') {
      const gone = 'gone' in outcome ? outcome.gone : 'runtime-failed';
      await this.#kill(worker, gone);
      if (gone === 'laya-purged' || gone === 'laya-stopped') return refusedBefore(gone);
      // A verified runtime that cannot load its model in time, or at all, stays failed until its person acts.
      this.#artifacts.recordWorkerFailure(selection, 'runtime-failed');
      return refusedBefore('runtime-failed');
    }
    if (generation !== this.#generation || stopping.aborted) {
      await this.#kill(worker, 'laya-stopped');
      return refusedBefore('laya-stopped');
    }
    this.#worker = worker;
    return { worker };
  }

  /** Attaches the child's one stdout reader. A proven child's stdout is paused, and stays paused until resumed. */
  #read(worker: RunningWorker): void {
    const parser = new WorkerFrameParser();
    worker.child.stdout.on('data', (chunk: Buffer) => {
      let frames: readonly WorkerFrame[];
      try {
        frames = parser.push(chunk);
      } catch {
        void this.#kill(worker, 'laya-malformed');
        return;
      }
      for (const frame of frames) {
        const pending = worker.pending;
        // A frame the protocol does not expect now — a late probe-attempt, an answer nobody asked for — is a worker
        // the daemon no longer understands.
        if (pending === undefined) {
          void this.#kill(worker, 'laya-malformed');
          return;
        }
        pending.frame(frame);
      }
    });
    worker.child.once('exit', () => void this.#kill(worker, 'laya-crashed'));
    worker.child.stdout.resume();
    if (worker.child.exitCode !== null || worker.child.signalCode !== null) void this.#kill(worker, 'laya-crashed');
  }

  /**
   * Waits for exactly one expected frame within a deadline. Any other frame, the child's end, the deadline, a purge of
   * the waiting request or a stop settles it as gone; `cancel` withdraws it when nothing was written.
   */
  #expect<T>(
    worker: RunningWorker,
    deadlineMs: number,
    signal: AbortSignal,
    stopping: AbortSignal,
    accept: (frame: WorkerFrame) => T | null,
  ): { readonly settled: Promise<Expected<T>>; cancel(): void } {
    let resolve: (result: Expected<T>) => void = () => undefined;
    const settled = new Promise<Expected<T>>((done) => {
      resolve = done;
    });
    let done = false;
    const onPurge = (): void => finish({ gone: 'laya-purged' });
    const onStop = (): void => finish({ gone: 'laya-stopped' });
    const timer = setTimeout(() => finish({ gone: 'laya-timeout' }), deadlineMs);
    const pending: Pending = {
      frame: (frame) => {
        const value = accept(frame);
        finish(value === null ? { gone: 'laya-malformed' } : { value });
      },
      gone: (code) => finish({ gone: code }),
    };
    function withdraw(): boolean {
      if (done) return false;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onPurge);
      stopping.removeEventListener('abort', onStop);
      if (worker.pending === pending) worker.pending = undefined;
      return true;
    }
    function finish(result: Expected<T>): void {
      if (withdraw()) resolve(result);
    }
    worker.pending = pending;
    signal.addEventListener('abort', onPurge, { once: true });
    stopping.addEventListener('abort', onStop, { once: true });
    if (signal.aborted) onPurge();
    if (stopping.aborted) onStop();
    if (worker.closing !== undefined) finish({ gone: 'laya-crashed' });
    return { settled, cancel: () => void withdraw() };
  }

  #clearIdle(worker: RunningWorker): void {
    if (worker.idle !== undefined) clearTimeout(worker.idle);
    worker.idle = undefined;
  }

  #armIdle(worker: RunningWorker): void {
    this.#clearIdle(worker);
    worker.idle = setTimeout(() => {
      if (worker.pending === undefined) void this.#kill(worker, 'laya-stopped');
    }, this.#idleExitMs);
  }

  /**
   * SIGKILL, wait, and remove the worker's owner-only directory. Whatever was waiting learns why first, and the child's
   * reader is detached, so no frame is read from a killed worker.
   */
  #kill(worker: RunningWorker, reason: LayaExecutionRefusalCode): Promise<void> {
    worker.closing ??= (async () => {
      if (this.#worker === worker) this.#worker = undefined;
      this.#clearIdle(worker);
      worker.child.stdout.removeAllListeners('data');
      const pending = worker.pending;
      worker.pending = undefined;
      pending?.gone(reason);
      await worker.close().catch(() => undefined);
      await rm(worker.directory, { recursive: true, force: true }).catch(() => undefined);
    })();
    return worker.closing;
  }
}

/** One owner composes one Laya executor per database, as it does E's purge listener; a test composes its own. */
const executors = new WeakMap<DatabaseSync, LayaJudgeExecutor>();

export function registerLayaJudgeExecutor(database: DatabaseSync, executor: LayaJudgeExecutor): () => void {
  if (executors.has(database)) throw new Error('a Laya judge executor is already registered');
  executors.set(database, executor);
  return () => {
    if (executors.get(database) === executor) executors.delete(database);
  };
}

/** The executor E's coordinator and judge test reach a Laya judge through; none means Laya cannot run here. */
export function layaJudgeExecutorFor(database: DatabaseSync): LayaJudgeExecutor | undefined {
  return executors.get(database);
}
