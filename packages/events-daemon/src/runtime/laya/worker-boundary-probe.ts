import { type ChildProcessWithoutNullStreams, type SpawnOptionsWithoutStdio, spawn } from 'node:child_process';
import { createSocket, Socket as DatagramSocket } from 'node:dgram';
import { chmod, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { connect, createServer, Server, Socket } from 'node:net';
import { join, sep } from 'node:path';
import { installErrorSink } from '../../network/error-sink.ts';
import {
  createWorkerProbeId,
  createWorkerRequestId,
  type WorkerFrame,
  WorkerFrameParser,
  writeWorkerFrame,
} from './worker-protocol.ts';

export const LAYA_SANDBOX_EXECUTABLE = '/usr/bin/sandbox-exec';
export const LAYA_SANDBOX_PROFILE = '(version 1) (allow default) (deny network*)';
const BOUNDARY_PROBE_TIMEOUT_MS = 5_000;
const BOUNDARY_SETTLE_MS = 150;
const PROBE_SOCKET_RELEASE_MS = 1_000;
const UNSPAWNED_RELEASE_MS = 1_000;
const DENIED_CODES = new Set(['EPERM', 'EACCES']);
/** macOS keeps 104 bytes for a socket path, its terminating NUL included (B1-G's control socket has the same bound). */
const UNIX_SOCKET_PATH_LIMIT_BYTES = 103;
const PROBE_NETWORK_IMPORTS = new Set(['node:net', 'node:dgram']);

/** The daemon resolves its reviewed worker from its own shipped package, never from a caller-supplied path. */
export const LAYA_WORKER_ENTRY: string = join(
  import.meta.dirname,
  import.meta.dirname.endsWith(`${sep}dist`) ? 'laya-worker.mjs' : 'worker-main.ts',
);

/** The child receives no inherited credential, proxy, Node option or descriptor beyond these three pipes. */
export const LAYA_WORKER_ENV: Readonly<Record<string, string>> = Object.freeze({ PATH: '/usr/bin:/bin', TZ: 'UTC' });

export interface LayaWorkerBinding {
  readonly nonce: string;
  readonly pid: number;
  readonly profile: typeof LAYA_SANDBOX_PROFILE;
  readonly entry: string;
  readonly pipeGeneration: string;
}

export type LayaBoundaryResult =
  | Readonly<{
      ok: false;
      code: 'LAYA_PLATFORM_UNAVAILABLE' | 'LAYA_SANDBOX_UNAVAILABLE' | 'boundary-failed';
      loadSent: false;
    }>
  | Readonly<{
      ok: true;
      child: ChildProcessWithoutNullStreams;
      binding: LayaWorkerBinding;
      sendLoad(payload: WorkerFrame): Promise<void>;
      close(): Promise<void>;
    }>;

export type LayaWorkerSpawn = (
  command: string,
  args: readonly string[],
  options: SpawnOptionsWithoutStdio & { readonly stdio: readonly ['pipe', 'pipe', 'pipe']; readonly shell: false },
) => ChildProcessWithoutNullStreams;

export interface LayaWorkerBoundaryOptions {
  readonly dataDirectory: string;
  /** Stops an in-progress proof without ever returning a load-capable worker. */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Test-only injection point.  It is not part of the daemon operation surface: production invokes only
 * createLayaWorkerBoundary(), which has no child-entry, launch, listener or deadline input.
 */
export interface LayaWorkerBoundaryTestOptions {
  readonly dataDirectory: string;
  readonly workerEntry: string;
  readonly platform?: NodeJS.Platform | undefined;
  /** A test stand-in still has to satisfy every production proof predicate. */
  readonly spawn?: LayaWorkerSpawn | undefined;
  readonly startListeners?: ((dataDirectory: string) => Promise<LayaBoundaryListeners>) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** The worker's four attempts, in the order it makes and reports them. */
export const PROBE_ATTEMPTS = ['tcp', 'fetch', 'udp', 'uds'] as const;
/** `denied` only when the operating system refused (EPERM or EACCES); any other error is `failed`, never a denial. */
export type LayaBoundaryProbeOutcome = 'denied' | 'escaped' | 'failed';
export type LayaBoundaryProbeAttempt = (typeof PROBE_ATTEMPTS)[number];
export type LayaBoundaryProbeReport = Readonly<Record<LayaBoundaryProbeAttempt, LayaBoundaryProbeOutcome>>;

type ProbeResult = LayaWorkerBinding &
  LayaBoundaryProbeReport & {
    readonly type: 'probe-result';
  };

export interface LayaBoundaryListeners {
  readonly tcpPort: number;
  readonly udpPort: number;
  readonly udsPath: string;
  readonly observed: Readonly<{ tcpConnections: number; udpDatagrams: number; udsConnections: number }>;
  /** Resolves on any listener or accepted-socket error; the proof then fails closed. */
  readonly failure: Promise<Error>;
  close(): Promise<void>;
}

function listen(server: Server, address: string | number, host?: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    if (host === undefined) server.listen(address);
    else if (typeof address === 'number') server.listen({ port: address, host });
    else reject(new Error('boundary listener address'));
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => {
      if (error === undefined || (error as NodeJS.ErrnoException).code === 'ERR_SERVER_NOT_RUNNING') resolve();
      else reject(error);
    }),
  );
}

function closeUdp(socket: DatagramSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

function bindUdp(socket: DatagramSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind({ address: '127.0.0.1', port: 0 }, () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

async function startBoundaryListeners(dataDirectory: string): Promise<LayaBoundaryListeners> {
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  await chmod(dataDirectory, 0o700);
  const udsDirectory = await mkdtemp(join(dataDirectory, 'laya-boundary-'));
  await chmod(udsDirectory, 0o700);
  const udsPath = join(udsDirectory, 'boundary.sock');
  // Past macOS's limit the socket would be bound, silently truncated, at another path than the probe names.
  if (Buffer.byteLength(udsPath) > UNIX_SOCKET_PATH_LIMIT_BYTES) {
    await rm(udsDirectory, { recursive: true, force: true });
    throw new Error('the Laya boundary socket path is too long');
  }
  let tcpConnections = 0;
  let udpDatagrams = 0;
  let udsConnections = 0;
  const tcpSockets = new Set<Socket>();
  const udsSockets = new Set<Socket>();
  let reportFailure: (error: Error) => void = () => undefined;
  const failure = new Promise<Error>((resolve) => {
    reportFailure = resolve;
  });
  const guardError = <T extends Server | DatagramSocket | Socket>(resource: T): T => {
    installErrorSink(resource);
    resource.on('error', reportFailure);
    return resource;
  };
  const track = (sockets: Set<Socket>, socket: Socket): void => {
    guardError(socket);
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    socket.destroy();
  };
  const tcp = guardError(
    createServer((socket) => {
      tcpConnections += 1;
      track(tcpSockets, socket);
    }),
  );
  const udp = guardError(createSocket('udp4'));
  udp.on('message', () => {
    udpDatagrams += 1;
  });
  const uds = guardError(
    createServer((socket) => {
      udsConnections += 1;
      track(udsSockets, socket);
    }),
  );
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      for (const socket of [...tcpSockets, ...udsSockets]) socket.destroy();
      await Promise.allSettled([closeServer(tcp), closeServer(uds), closeUdp(udp)]);
      // sandbox-exec denial and a killed child can race Unix socket cleanup; force both identities away.
      await rm(udsPath, { force: true });
      await rm(udsDirectory, { recursive: true, force: true });
    })();
    return closing;
  };
  try {
    await listen(tcp, 0, '127.0.0.1');
    await bindUdp(udp);
    await listen(uds, udsPath);
    const tcpAddress = tcp.address();
    const udpAddress = udp.address();
    if (tcpAddress === null || typeof tcpAddress === 'string' || typeof udpAddress === 'string')
      throw new Error('boundary listener');
    return {
      tcpPort: tcpAddress.port,
      udpPort: udpAddress.port,
      udsPath,
      get observed() {
        return { tcpConnections, udpDatagrams, udsConnections };
      },
      failure,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

function workerArguments(entry: string): readonly string[] {
  return entry.endsWith('.ts')
    ? ['-p', LAYA_SANDBOX_PROFILE, process.execPath, '--experimental-strip-types', entry]
    : ['-p', LAYA_SANDBOX_PROFILE, process.execPath, entry];
}

/** The working directory is the owner-only (0700) data directory the proof's listeners were made in. */
function workerSpawnOptions(workingDirectory: string): SpawnOptionsWithoutStdio & {
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly shell: false;
} {
  return { cwd: workingDirectory, env: LAYA_WORKER_ENV, shell: false, stdio: ['pipe', 'pipe', 'pipe'] };
}

function bindingFrom(value: WorkerFrame): LayaWorkerBinding | null {
  if (
    typeof value.nonce !== 'string' ||
    typeof value.pid !== 'number' ||
    !Number.isSafeInteger(value.pid) ||
    typeof value.profile !== 'string' ||
    typeof value.entry !== 'string' ||
    typeof value.pipeGeneration !== 'string'
  ) {
    return null;
  }
  return {
    nonce: value.nonce,
    pid: value.pid,
    profile: value.profile as typeof LAYA_SANDBOX_PROFILE,
    entry: value.entry,
    pipeGeneration: value.pipeGeneration,
  };
}

function sameBinding(expected: LayaWorkerBinding, candidate: LayaWorkerBinding): boolean {
  return (
    expected.nonce === candidate.nonce &&
    expected.pid === candidate.pid &&
    expected.profile === candidate.profile &&
    expected.entry === candidate.entry &&
    expected.pipeGeneration === candidate.pipeGeneration
  );
}

function isProbeOutcome(value: unknown): value is LayaBoundaryProbeOutcome {
  return value === 'denied' || value === 'escaped' || value === 'failed';
}

function isProbeAttempt(value: unknown): value is LayaBoundaryProbeAttempt {
  return (PROBE_ATTEMPTS as readonly unknown[]).includes(value);
}

function probeReport(frame: WorkerFrame): LayaBoundaryProbeReport | null {
  const report: Partial<Record<LayaBoundaryProbeAttempt, LayaBoundaryProbeOutcome>> = {};
  for (const attempt of PROBE_ATTEMPTS) {
    const outcome = frame[attempt];
    if (!isProbeOutcome(outcome)) return null;
    report[attempt] = outcome;
  }
  return report as LayaBoundaryProbeReport;
}

function probeResult(frame: WorkerFrame, binding: LayaWorkerBinding): ProbeResult | null {
  if (frame.type !== 'probe-result') return null;
  const candidate = bindingFrom(frame);
  if (candidate === null || !sameBinding(binding, candidate)) return null;
  const report = probeReport(frame);
  return report === null ? null : { type: 'probe-result', ...candidate, ...report };
}

function probeAttempt(
  frame: WorkerFrame,
  binding: LayaWorkerBinding,
): Readonly<{ attempt: LayaBoundaryProbeAttempt; outcome: LayaBoundaryProbeOutcome }> | null {
  if (frame.type !== 'probe-attempt') return null;
  const candidate = bindingFrom(frame);
  if (candidate === null || !sameBinding(binding, candidate)) return null;
  if (!isProbeAttempt(frame.attempt) || !isProbeOutcome(frame.outcome)) return null;
  return { attempt: frame.attempt, outcome: frame.outcome };
}

/**
 * Child stderr can carry untrusted runtime or model text, so the daemon retains none of it. It keeps reading and
 * discarding: a paused pipe would fill and stall a child that writes to stderr, which would look like a hung worker.
 */
function discardStderr(child: ChildProcessWithoutNullStreams): void {
  child.stderr.on('data', () => undefined);
}

/** A worker that exits early turns the daemon's next write into EPIPE; that must fail the proof, never the daemon. */
function sinkWorkerPipes(child: ChildProcessWithoutNullStreams): void {
  installErrorSink(child);
  installErrorSink(child.stdin);
  installErrorSink(child.stdout);
  installErrorSink(child.stderr);
}

function waitForProbe(
  child: ChildProcessWithoutNullStreams,
  binding: LayaWorkerBinding,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<ProbeResult | null> {
  return new Promise((resolve) => {
    const parser = new WorkerFrameParser();
    const attempts = new Set<LayaBoundaryProbeAttempt>();
    const expectedAttempts: readonly LayaBoundaryProbeAttempt[] = PROBE_ATTEMPTS;
    let done = false;
    let reported: ProbeResult | undefined;
    let settled: NodeJS.Timeout | undefined;
    const finish = (result: ProbeResult | null): void => {
      if (done) return;
      done = true;
      clearTimeout(timeout);
      if (settled !== undefined) clearTimeout(settled);
      child.stdout.off('data', onData);
      // Removing the listener does not pause a flowing stream: hold every later frame for the worker's next reader.
      child.stdout.pause();
      child.off('error', onEnd);
      child.off('exit', onEnd);
      child.off('close', onEnd);
      signal?.removeEventListener('abort', onAbort);
      resolve(result);
    };
    const onData = (chunk: Buffer): void => {
      try {
        for (const frame of parser.push(chunk)) {
          // The proof pipe is closed to every frame shape except one exact, ordered probe transcript.
          if (reported !== undefined) {
            finish(null);
            return;
          }
          if (frame.type === 'probe-attempt') {
            const attempt = probeAttempt(frame, binding);
            if (
              attempt === null ||
              attempt.outcome !== 'denied' ||
              attempt.attempt !== expectedAttempts[attempts.size] ||
              attempts.has(attempt.attempt)
            ) {
              finish(null);
              return;
            }
            attempts.add(attempt.attempt);
            continue;
          }
          const result = probeResult(frame, binding);
          if (result === null || attempts.size !== expectedAttempts.length) {
            finish(null);
            return;
          }
          // Keep the same pipe and the daemon-owned listeners live briefly after the final report. A delayed
          // connection or any additional frame is evidence of an escape, never a success.
          reported = result;
          settled = setTimeout(() => finish(reported ?? null), BOUNDARY_SETTLE_MS);
        }
      } catch {
        finish(null);
      }
    };
    const onEnd = (): void => finish(null);
    const onAbort = (): void => finish(null);
    const timeout = setTimeout(() => finish(null), timeoutMs);
    child.stdout.on('data', onData);
    child.once('error', onEnd);
    child.once('exit', onEnd);
    child.once('close', onEnd);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams, boundMs?: number): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = boundMs === undefined ? undefined : setTimeout(() => settled(), boundMs);
    const settled = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.off('exit', settled);
      child.off('close', settled);
      child.off('error', settled);
      resolve();
    };
    child.once('exit', settled);
    child.once('close', settled);
    child.once('error', settled);
  });
}

async function killWorker(child: ChildProcessWithoutNullStreams): Promise<void> {
  // A child whose spawn failed has no PID, and libuv would signal PID 0: the daemon's own process group.
  if (child.pid === undefined) {
    await waitForExit(child, UNSPAWNED_RELEASE_MS);
    return;
  }
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  await waitForExit(child);
}

/** A child report alone is never sufficient: the daemon's own listeners must observe no connection or datagram. */
export function boundaryProbePassed(
  result: LayaBoundaryProbeReport,
  observed: LayaBoundaryListeners['observed'],
): boolean {
  return (
    result.tcp === 'denied' &&
    result.fetch === 'denied' &&
    result.udp === 'denied' &&
    result.uds === 'denied' &&
    observed.tcpConnections === 0 &&
    observed.udpDatagrams === 0 &&
    observed.udsConnections === 0
  );
}

function isAbortSignal(value: unknown): value is AbortSignal {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as AbortSignal).aborted === 'boolean' &&
    typeof (value as AbortSignal).addEventListener === 'function' &&
    typeof (value as AbortSignal).removeEventListener === 'function'
  );
}

function productionBoundaryOptions(input: unknown): LayaWorkerBoundaryOptions | null {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return null;
  const candidate = input as Record<string, unknown>;
  const keys = Object.keys(candidate).toSorted();
  if (
    keys.length < 1 ||
    keys.length > 2 ||
    keys[0] !== 'dataDirectory' ||
    (keys[1] !== undefined && keys[1] !== 'signal')
  )
    return null;
  if (typeof candidate.dataDirectory !== 'string' || candidate.dataDirectory.length === 0) return null;
  if (candidate.signal !== undefined && !isAbortSignal(candidate.signal)) return null;
  return { dataDirectory: candidate.dataDirectory, signal: candidate.signal as AbortSignal | undefined };
}

async function disposeFailedBoundary(
  child: ChildProcessWithoutNullStreams | undefined,
  listeners: LayaBoundaryListeners | undefined,
): Promise<void> {
  await Promise.allSettled([
    ...(child === undefined ? [] : [killWorker(child)]),
    ...(listeners === undefined ? [] : [listeners.close()]),
  ]);
}

/** Starts one child, proves its own OS boundary before load, and never falls back to an unconfined process. */
async function createLayaWorkerBoundaryInternal(options: LayaWorkerBoundaryTestOptions): Promise<LayaBoundaryResult> {
  const platform = options.platform ?? process.platform;
  if (platform !== 'darwin') return { ok: false, code: 'LAYA_PLATFORM_UNAVAILABLE', loadSent: false };
  if (options.signal?.aborted) return { ok: false, code: 'boundary-failed', loadSent: false };
  let listeners: LayaBoundaryListeners | undefined;
  let child: ChildProcessWithoutNullStreams | undefined;
  try {
    listeners = await (options.startListeners ?? startBoundaryListeners)(options.dataDirectory);
    if (options.signal?.aborted) {
      await disposeFailedBoundary(undefined, listeners);
      listeners = undefined;
      return { ok: false, code: 'boundary-failed', loadSent: false };
    }
    const start = options.spawn ?? ((command, args, spawnOptions) => spawn(command, args, spawnOptions));
    child = start(
      LAYA_SANDBOX_EXECUTABLE,
      workerArguments(options.workerEntry),
      workerSpawnOptions(options.dataDirectory),
    );
    const started = child;
    installErrorSink(started);
    if (started.pid === undefined) {
      await disposeFailedBoundary(started, listeners);
      listeners = undefined;
      return { ok: false, code: 'boundary-failed', loadSent: false };
    }
    sinkWorkerPipes(started);
    discardStderr(started);
    if (options.signal?.aborted) {
      await disposeFailedBoundary(started, listeners);
      listeners = undefined;
      return { ok: false, code: 'boundary-failed', loadSent: false };
    }
    const binding: LayaWorkerBinding = {
      nonce: createWorkerProbeId(),
      pid: started.pid,
      profile: LAYA_SANDBOX_PROFILE,
      entry: options.workerEntry,
      pipeGeneration: createWorkerRequestId(),
    };
    await writeWorkerFrame(started.stdin, {
      type: 'probe',
      ...binding,
      tcpPort: listeners.tcpPort,
      udpPort: listeners.udpPort,
      udsPath: listeners.udsPath,
    });
    const result = await Promise.race([
      waitForProbe(started, binding, options.timeoutMs ?? BOUNDARY_PROBE_TIMEOUT_MS, options.signal),
      listeners.failure.then(() => null),
    ]);
    // The listeners are proof-only: they close before the verdict, whatever it is, and the verdict counts everything
    // they saw until they had closed, so traffic that arrives while they close still fails the proof.
    const proof = listeners;
    listeners = undefined;
    await proof.close();
    if (result === null || !boundaryProbePassed(result, proof.observed)) {
      await disposeFailedBoundary(started, undefined);
      return { ok: false, code: 'boundary-failed', loadSent: false };
    }
    return {
      ok: true,
      child: started,
      binding,
      async sendLoad(payload: WorkerFrame): Promise<void> {
        assertWorkerLoadBinding(binding, { type: 'load', ...binding, payload });
        await writeWorkerFrame(started.stdin, { type: 'load', ...binding, payload });
      },
      async close(): Promise<void> {
        await killWorker(started);
      },
    };
  } catch {
    await disposeFailedBoundary(child, listeners);
    listeners = undefined;
    return { ok: false, code: 'boundary-failed', loadSent: false };
  } finally {
    if (listeners !== undefined) await disposeFailedBoundary(undefined, listeners);
  }
}

/** Production surface: only the daemon's shipped worker entry can reach the sandbox launcher. */
export async function createLayaWorkerBoundary(options: LayaWorkerBoundaryOptions): Promise<LayaBoundaryResult> {
  const accepted = productionBoundaryOptions(options);
  if (accepted === null) return { ok: false, code: 'boundary-failed', loadSent: false };
  return createLayaWorkerBoundaryInternal({ ...accepted, workerEntry: LAYA_WORKER_ENTRY });
}

/** Test-only seam. Production modules do not import it and cannot pass a substituted child to the production surface. */
export async function createLayaWorkerBoundaryForTest(
  options: LayaWorkerBoundaryTestOptions,
): Promise<LayaBoundaryResult> {
  return createLayaWorkerBoundaryInternal(options);
}

/** The worker's second frame may only use the exact child that completed the probe. */
export function assertWorkerLoadBinding(binding: LayaWorkerBinding, frame: WorkerFrame): void {
  const candidate = bindingFrom(frame);
  if (frame.type !== 'load' || candidate === null || !sameBinding(binding, candidate))
    throw new Error('worker load binding');
}

/** Testable source-boundary scanner: network built-ins belong only in this probe module, never in the worker main. */
export function assertLayaWorkerSourceBoundary(input: Readonly<{ workerMain: string; boundaryProbe: string }>): void {
  const imports = (source: string): readonly string[] =>
    [...source.matchAll(/(?:from\s*|import\s*\(|import\s+)(['"])([^'"]+)\1/g)].map((match) => match[2] ?? '');
  const network = (specifier: string): boolean =>
    ['node:net', 'node:dgram', 'node:http', 'node:https', 'node:tls', 'node:dns'].includes(specifier);
  const mainImports = imports(input.workerMain);
  if (mainImports.some(network)) throw new Error('worker main imports network');
  const probeImports = imports(input.boundaryProbe).filter(network);
  if (probeImports.some((specifier) => !PROBE_NETWORK_IMPORTS.has(specifier))) {
    throw new Error('worker boundary probe imports an unapproved network builtin');
  }
  if ([...PROBE_NETWORK_IMPORTS].some((specifier) => !probeImports.includes(specifier))) {
    throw new Error('worker boundary probe lost a required network probe');
  }
  if (/['"][^'"]*(?:database|control|secrets|provider)[^'"]*['"]/.test(input.workerMain)) {
    throw new Error('worker main imports daemon authority');
  }
}

/** True only for the operating system's refusal, found on the error, its cause or an aggregate's members. */
export function deniedBySystem(error: unknown, depth = 0): boolean {
  if (depth > 4 || error === null || typeof error !== 'object') return false;
  const { code, cause, errors } = error as { code?: unknown; cause?: unknown; errors?: unknown };
  if (typeof code === 'string' && DENIED_CODES.has(code)) return true;
  if (deniedBySystem(cause, depth + 1)) return true;
  return Array.isArray(errors) && errors.some((member) => deniedBySystem(member, depth + 1));
}

function settled(run: () => Promise<void>): Promise<LayaBoundaryProbeOutcome> {
  return new Promise<void>((resolve) => resolve(run())).then(
    () => 'escaped',
    (error: unknown) => (deniedBySystem(error) ? 'denied' : 'failed'),
  );
}

/** Runs one attempt with a bound; on expiry its own socket is released before the attempt fails. */
function bounded(
  run: (resolve: () => void, reject: (error: Error) => void) => (() => Promise<void>) | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let done = false;
    let release: (() => Promise<void>) | undefined;
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      void (release?.() ?? Promise.resolve()).finally(() => reject(new Error('boundary probe timeout')));
    }, BOUNDARY_PROBE_TIMEOUT_MS);
    release = run(
      () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      },
      (error) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

function closedSocket(socket: Socket): Promise<void> {
  if (socket.closed) return Promise.resolve();
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.destroy();
  });
}

function closedDatagram(socket: DatagramSocket): Promise<void> {
  return new Promise((resolve) => {
    try {
      socket.close(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** The attempt settles only after its socket has closed, so no probe handle outlives the report. */
function connectProbe(options: { readonly port: number } | { readonly path: string }): Promise<void> {
  return bounded((resolve, reject) => {
    const socket = 'path' in options ? connect(options.path) : connect(options.port, '127.0.0.1');
    socket.on('error', () => undefined);
    const release = (): Promise<void> => closedSocket(socket);
    socket.once('connect', () => void release().then(resolve));
    socket.once('error', (error) => void release().then(() => reject(error)));
    return release;
  });
}

function fetchProbe(port: number): Promise<void> {
  return bounded((resolve, reject) => {
    const controller = new AbortController();
    globalThis.fetch(`http://127.0.0.1:${port}/laya-boundary-probe`, { signal: controller.signal }).then(
      async (response) => {
        await response.body?.cancel().catch(() => undefined);
        resolve();
      },
      (error: unknown) => reject(error instanceof Error ? error : new Error('probe request')),
    );
    return async () => controller.abort();
  });
}

function udpProbe(port: number): Promise<void> {
  return bounded((resolve, reject) => {
    const socket = createSocket('udp4');
    socket.on('error', () => undefined);
    const release = (): Promise<void> => closedDatagram(socket);
    socket.once('error', (error) => void release().then(() => reject(error)));
    socket.send(Buffer.from([0]), port, '127.0.0.1', (error) => {
      void release().then(() => (error ? reject(error) : resolve()));
    });
    return release;
  });
}

/** This is the worker's first built-in-only act, before any runtime/model import. */
export async function runWorkerBoundaryProbe(
  input: Readonly<{ tcpPort: number; udpPort: number; udsPath: string }>,
  observeAttempt?: (attempt: LayaBoundaryProbeAttempt, outcome: LayaBoundaryProbeOutcome) => Promise<void>,
): Promise<LayaBoundaryProbeReport> {
  const attempts: readonly [LayaBoundaryProbeAttempt, () => Promise<void>][] = [
    ['tcp', () => connectProbe({ port: input.tcpPort })],
    ['fetch', () => fetchProbe(input.tcpPort)],
    ['udp', () => udpProbe(input.udpPort)],
    ['uds', () => connectProbe({ path: input.udsPath })],
  ];
  const outcomes: Partial<Record<LayaBoundaryProbeAttempt, LayaBoundaryProbeOutcome>> = {};
  for (const [attempt, run] of attempts) {
    const outcome = await settled(run);
    outcomes[attempt] = outcome;
    await observeAttempt?.(attempt, outcome);
  }
  if (PROBE_ATTEMPTS.some((attempt) => outcomes[attempt] === undefined)) throw new Error('boundary probe');
  return outcomes as LayaBoundaryProbeReport;
}

function sealedNetwork(): never {
  throw new Error('Laya worker network is sealed');
}

function seal(target: object, name: string, value: unknown): void {
  Object.defineProperty(target, name, { configurable: false, enumerable: false, writable: false, value });
}

/**
 * Defence in depth after the operating-system proof, never a substitute for it: `fetch` and `WebSocket`, every TCP or
 * pathname-socket connection and listener (which `http`, `https` and `tls` build on) and every datagram bind, connect
 * or send throw for the rest of the worker's life.
 */
export function sealWorkerNetworkAfterProbe(): void {
  seal(globalThis, 'fetch', async (): Promise<never> => sealedNetwork());
  if ('WebSocket' in globalThis) {
    seal(
      globalThis,
      'WebSocket',
      class SealedWebSocket {
        constructor() {
          sealedNetwork();
        }
      },
    );
  }
  seal(Socket.prototype, 'connect', sealedNetwork);
  seal(Server.prototype, 'listen', sealedNetwork);
  seal(DatagramSocket.prototype, 'bind', sealedNetwork);
  seal(DatagramSocket.prototype, 'connect', sealedNetwork);
  seal(DatagramSocket.prototype, 'send', sealedNetwork);
}

/** Node's names for an open TCP or UDP socket, a listener or a resolver request; stdio pipes are not among them. */
const NETWORK_RESOURCE = /^(?:TCP|UDP|PipeServer|GetAddrInfo|GetNameInfo|Query|TLS)/;

export function networkResourcesRemain(resources: readonly string[]): boolean {
  return resources.some((resource) => NETWORK_RESOURCE.test(resource));
}

/** The worker reports its proof only once no socket, listener or lookup it may have opened is still alive. */
export async function assertNoProbeSocketsRemain(
  resources: () => readonly string[] = () => process.getActiveResourcesInfo(),
): Promise<void> {
  const deadline = Date.now() + PROBE_SOCKET_RELEASE_MS;
  while (networkResourcesRemain(resources())) {
    if (Date.now() >= deadline) throw new Error('a Laya worker network resource outlived its probe');
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}
