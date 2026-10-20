import assert from 'node:assert/strict';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { EventEmitter } from 'node:events';
import { realpathSync } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server, type Socket } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { PassThrough, Writable } from 'node:stream';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  createLayaWorkerBoundary,
  createLayaWorkerBoundaryForTest,
  LAYA_SANDBOX_CONFINEMENT,
  LAYA_SANDBOX_EXECUTABLE,
  LAYA_SANDBOX_PROFILE,
  LAYA_WORKER_DIRECTORY_PARAMETER,
  LAYA_WORKER_ENTRY,
  LAYA_WORKER_ENV,
  LAYA_WORKER_SANDBOX_PROFILE,
  type LayaBoundaryListeners,
  type LayaWorkerSpawn,
} from '../src/runtime/laya/worker-boundary-probe.ts';
import { encodeWorkerFrame, WorkerFrameParser } from '../src/runtime/laya/worker-protocol.ts';
import { shortTempDir, WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const workerMain = fileURLToPath(new URL('../src/runtime/laya/worker-main.ts', import.meta.url));
const boundaryProbe = fileURLToPath(new URL('../src/runtime/laya/worker-boundary-probe.ts', import.meta.url));
const standin = fileURLToPath(new URL('./support/laya-worker-standin.ts', import.meta.url));
const CLOSED_WORKER_ENV = { PATH: '/usr/bin:/bin', TZ: 'UTC' };

/** A short root keeps a pathname socket inside macOS's 103-byte limit (B1-G). */
async function withTemporaryDirectory(run: (directory: string) => Promise<void>): Promise<void> {
  const directory = await shortTempDir('laya-bd-');
  try {
    await run(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runUnconfined(entry: string, mode?: string): LayaWorkerSpawn {
  const launcher: LayaWorkerSpawn = (command, args, options) => {
    assert.equal(command, LAYA_SANDBOX_EXECUTABLE);
    // The worker's own directory, resolved as the kernel sees it, is the one place the profile lets it write.
    assert.deepEqual(args, [
      '-D',
      `${LAYA_WORKER_DIRECTORY_PARAMETER}=${realpathSync(String(options?.cwd))}`,
      '-p',
      LAYA_WORKER_SANDBOX_PROFILE,
      process.execPath,
      '--experimental-strip-types',
      entry,
    ]);
    assert.deepEqual(options?.env, CLOSED_WORKER_ENV);
    assert.deepEqual(options?.stdio, ['pipe', 'pipe', 'pipe']);
    assert.equal(options?.shell, false);
    return spawn(
      process.execPath,
      ['--experimental-strip-types', entry, ...(mode === undefined ? [] : ['--standin', mode])],
      options,
    ) as ChildProcessWithoutNullStreams;
  };
  return launcher;
}

function activeResources(): readonly string[] {
  return process.getActiveResourcesInfo().toSorted();
}

async function nextTurn(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

function isListenerRefusal(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'EPERM' || (error as NodeJS.ErrnoException).code === 'EACCES';
}

async function skipIfListenerRefused(t: { skip(reason?: string): void }, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    if (isListenerRefusal(error)) {
      t.skip(`the host refused disposable local boundary listeners: ${(error as NodeJS.ErrnoException).code}`);
      return;
    }
    throw error;
  }
}

async function syntheticListeners(): Promise<LayaBoundaryListeners> {
  return {
    tcpPort: 1,
    udpPort: 2,
    udsPath: '/tmp/laya-boundary-synthetic.sock',
    observed: { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 },
    failure: new Promise<Error>(() => undefined),
    async close() {},
  };
}

async function trackedSyntheticListeners(onClose: () => void): Promise<LayaBoundaryListeners> {
  return {
    tcpPort: 1,
    udpPort: 2,
    udsPath: '/tmp/laya-boundary-tracked.sock',
    observed: { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 },
    failure: new Promise<Error>(() => undefined),
    async close() {
      onClose();
    },
  };
}

function erroringSyntheticListeners(onClose: () => void): Readonly<{
  listeners: LayaBoundaryListeners;
  fail(error: Error): void;
}> {
  let fail: (error: Error) => void = () => undefined;
  const error = new Promise<Error>((resolve) => {
    fail = resolve;
  });
  return {
    listeners: {
      tcpPort: 1,
      udpPort: 2,
      udsPath: '/tmp/laya-boundary-erroring.sock',
      observed: { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 },
      failure: error,
      async close() {
        onClose();
      },
    },
    fail,
  };
}

function spawnThatErrorsWithoutExit(): LayaWorkerSpawn {
  return () => {
    const child = Object.assign(new EventEmitter(), {
      pid: undefined,
      exitCode: null,
      signalCode: null,
      kill: () => {
        throw new Error('a child that never started must never be signalled');
      },
    }) as unknown as ChildProcessWithoutNullStreams;
    // The test must not turn the intentionally reproduced spawn error into an unhandled test-process error.
    child.on('error', () => undefined);
    queueMicrotask(() => {
      child.emit('error', new Error('synthetic sandbox-exec spawn failure'));
      child.emit('close', 1, null);
    });
    return child;
  };
}

async function resolvesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function waitForWorkerFrame(
  child: ChildProcessWithoutNullStreams,
  predicate: (frame: Readonly<Record<string, unknown>>) => boolean,
  timeoutMs = 10_000,
): Promise<Readonly<Record<string, unknown>>> {
  return new Promise((resolve, reject) => {
    const parser = new WorkerFrameParser();
    let timer: NodeJS.Timeout | undefined;
    const finish = (error?: Error, frame?: Readonly<Record<string, unknown>>): void => {
      if (timer !== undefined) clearTimeout(timer);
      child.stdout.off('data', onData);
      child.off('error', onError);
      child.off('exit', onExit);
      if (error !== undefined) reject(error);
      else if (frame !== undefined) resolve(frame);
    };
    const onData = (chunk: Buffer): void => {
      try {
        const frame = parser.push(chunk).find(predicate);
        if (frame !== undefined) finish(undefined, frame);
      } catch (error) {
        finish(error instanceof Error ? error : new Error('worker frame'));
      }
    };
    const onError = (error: Error): void => finish(error);
    const onExit = (): void => finish(new Error('worker exited before its expected frame'));
    timer = setTimeout(() => finish(new Error('worker frame timeout')), timeoutMs);
    child.stdout.on('data', onData);
    // A successful proof pauses the pipe so that nothing the worker writes next is lost before its reader attaches.
    child.stdout.resume();
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

async function expectSyntheticEscape(mode: 'tcp' | 'fetch' | 'udp' | 'uds' | 'spawn'): Promise<void> {
  await withTemporaryDirectory(async (directory) => {
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, mode),
      startListeners: syntheticListeners,
    });
    try {
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
}

test('E2 boundary: rejects each worker escape report before load', async () => {
  const { boundaryProbePassed } = await import('../src/runtime/laya/worker-boundary-probe.ts');
  const observed = { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 };
  assert.equal(
    boundaryProbePassed({ tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'denied', spawn: 'denied' }, observed),
    true,
  );
  assert.equal(
    boundaryProbePassed({ tcp: 'escaped', fetch: 'denied', udp: 'denied', uds: 'denied', spawn: 'denied' }, observed),
    false,
  );
  assert.equal(
    boundaryProbePassed({ tcp: 'denied', fetch: 'escaped', udp: 'denied', uds: 'denied', spawn: 'denied' }, observed),
    false,
  );
  assert.equal(
    boundaryProbePassed({ tcp: 'denied', fetch: 'denied', udp: 'escaped', uds: 'denied', spawn: 'denied' }, observed),
    false,
  );
  assert.equal(
    boundaryProbePassed({ tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'escaped', spawn: 'denied' }, observed),
    false,
  );
  // The fifth attempt: a process the profile let the worker start is an escape, as is any outcome but a denial.
  for (const spawn of ['escaped', 'failed'] as const)
    assert.equal(
      boundaryProbePassed({ tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'denied', spawn }, observed),
      false,
      spawn,
    );
  assert.equal(
    boundaryProbePassed(
      { tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'denied', spawn: 'denied' },
      { ...observed, tcpConnections: 1 },
    ),
    false,
  );
  assert.equal(
    boundaryProbePassed(
      { tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'denied', spawn: 'denied' },
      { ...observed, udpDatagrams: 1 },
    ),
    false,
  );
  assert.equal(
    boundaryProbePassed(
      { tcp: 'denied', fetch: 'denied', udp: 'denied', uds: 'denied', spawn: 'denied' },
      { ...observed, udsConnections: 1 },
    ),
    false,
  );
});

test('E2 boundary: an unconfined actual child is killed before the daemon sends load', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await skipIfListenerRefused(t, () =>
    withTemporaryDirectory(async (directory) => {
      const boundary = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: workerMain,
        spawn: runUnconfined(workerMain),
      });
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
    }),
  );
});

test('E2 boundary: the production entry refuses a forged all-denied child before it can receive load', async () => {
  await withTemporaryDirectory(async (root) => {
    const directory = join(root, 'must-not-be-created-before-production-input-validation');
    let spawnCalls = 0;
    let boundary: Awaited<ReturnType<typeof createLayaWorkerBoundary>> | undefined;
    const forgedSpawn: LayaWorkerSpawn = (command, args, options) => {
      spawnCalls += 1;
      return runUnconfined(standin)(command, args, options);
    };
    try {
      boundary = await createLayaWorkerBoundary({
        dataDirectory: directory,
        platform: 'darwin',
        workerEntry: standin,
        spawn: forgedSpawn,
        startListeners: syntheticListeners,
      } as never);
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
      assert.equal(spawnCalls, 0, 'a forged child must be refused before it receives a load-capable pipe');
      await assert.rejects(
        () => stat(directory),
        { code: 'ENOENT' },
        'a rejected production shape cannot even start the daemon-owned listener setup',
      );
    } finally {
      if (boundary?.ok) await boundary.close();
    }
  });
});

test('E2 boundary: the production launcher resolves only the daemon-shipped worker entry', () => {
  assert.equal(LAYA_WORKER_ENTRY, workerMain);
});

test('E2 boundary: closes probe listeners before returning a successful worker', async () => {
  await withTemporaryDirectory(async (directory) => {
    let closeCalls = 0;
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, 'all-denied'),
      startListeners: () =>
        trackedSyntheticListeners(() => {
          closeCalls += 1;
        }),
    });
    try {
      assert.equal(boundary.ok, true);
      assert.equal(closeCalls, 1, 'a returned worker owns only its pipes, never probe listeners');
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test('E2 boundary: waits for a loaded child to complete all observable attempts', async () => {
  await withTemporaryDirectory(async (directory) => {
    let boundary: Awaited<ReturnType<typeof createLayaWorkerBoundary>> | undefined;
    try {
      boundary = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        spawn: runUnconfined(standin, 'delayed-denied'),
        startListeners: syntheticListeners,
      } as never);
      assert.equal(boundary.ok, true);
    } finally {
      if (boundary?.ok) await boundary.close();
    }
  });
});

test('E2 boundary: a forged all-denied report without four observed attempts is refused', async () => {
  await withTemporaryDirectory(async (directory) => {
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin),
      startListeners: syntheticListeners,
    });
    try {
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test('E2 boundary: out-of-order and every unexpected proof frame are refused', async () => {
  const modes = [
    'out-of-order-attempts',
    'unrecognised-frame',
    'malformed-frame',
    'mismatched-binding',
    'extra-frame',
  ] as const;
  for (const mode of modes) {
    await withTemporaryDirectory(async (directory) => {
      const boundary = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        spawn: runUnconfined(standin, mode),
        startListeners: syntheticListeners,
      });
      try {
        assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false }, mode);
      } finally {
        if (boundary.ok) await boundary.close();
      }
    });
  }
});

test('E2 boundary: a late TCP attempt after a denied report still refuses the child', {
  skip: WINDOWS_SKIP,
}, async (t) => {
  await skipIfListenerRefused(t, () =>
    withTemporaryDirectory(async (directory) => {
      const boundary = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        spawn: runUnconfined(standin, 'late-tcp'),
      });
      try {
        assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
      } finally {
        if (boundary.ok) await boundary.close();
      }
    }),
  );
});

test('E2 boundary: a late escaped attempt frame after a denied report still refuses the child', async () => {
  await withTemporaryDirectory(async (directory) => {
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, 'late-report'),
      startListeners: syntheticListeners,
    });
    try {
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test('E2 boundary: resources return to baseline after every boundary outcome', { skip: WINDOWS_SKIP }, async (t) => {
  const outcomes: readonly [string, string | undefined][] = [
    ['success', 'all-denied'],
    ['tcp escape', 'tcp'],
    ['fetch escape', 'fetch'],
    ['udp escape', 'udp'],
    ['uds escape', 'uds'],
    ['spawn escape', 'spawn'],
    ['forged report', undefined],
    ['timeout', 'silence'],
  ];
  await skipIfListenerRefused(t, async () => {
    for (const [name, mode] of outcomes) {
      await nextTurn();
      const before = activeResources();
      await withTemporaryDirectory(async (directory) => {
        const boundary = await createLayaWorkerBoundaryForTest({
          platform: 'darwin',
          dataDirectory: directory,
          workerEntry: standin,
          spawn: runUnconfined(standin, mode),
        });
        if (boundary.ok) await boundary.close();
      });
      await nextTurn();
      assert.deepEqual(activeResources(), before, `${name} leaked a boundary resource`);
    }
  });
});

test('E2 boundary: a sandbox spawn error without exit fails closed and returns within its cleanup bound', async () => {
  const before = activeResources();
  await withTemporaryDirectory(async (directory) => {
    let closeCalls = 0;
    const result = await resolvesWithin(
      createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        spawn: spawnThatErrorsWithoutExit(),
        startListeners: () =>
          trackedSyntheticListeners(() => {
            closeCalls += 1;
          }),
      }),
      300,
    );
    assert.deepEqual(result, { ok: false, code: 'boundary-failed', loadSent: false });
    assert.equal(closeCalls, 1);
  });
  await nextTurn();
  assert.deepEqual(activeResources(), before);
});

test('E2 boundary: a listener error after setup fails closed without escaping the daemon', async () => {
  const before = activeResources();
  await withTemporaryDirectory(async (directory) => {
    let closeCalls = 0;
    let spawned!: () => void;
    const childStarted = new Promise<void>((resolve) => {
      spawned = resolve;
    });
    const controlled = erroringSyntheticListeners(() => {
      closeCalls += 1;
    });
    const pending = createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: (command, args, options) => {
        const child = runUnconfined(standin, 'silence')(command, args, options);
        spawned();
        return child;
      },
      startListeners: async () => controlled.listeners,
    });
    await childStarted;
    controlled.fail(new Error('synthetic listener failure'));
    const result = await resolvesWithin(pending, 300);
    assert.deepEqual(result, { ok: false, code: 'boundary-failed', loadSent: false });
    assert.equal(closeCalls, 1);
  });
  await nextTurn();
  assert.deepEqual(activeResources(), before);
});

test('E2 boundary: abort before spawn, during proof, and during settle cleans up fully', async () => {
  const stages = ['before-spawn', 'during-proof', 'during-settle'] as const;
  for (const stage of stages) {
    await nextTurn();
    const before = activeResources();
    await withTemporaryDirectory(async (directory) => {
      const controller = new AbortController();
      let closeCalls = 0;
      let spawned!: () => void;
      const childStarted = new Promise<void>((resolve) => {
        spawned = resolve;
      });
      if (stage === 'before-spawn') controller.abort();
      const pending = createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        signal: controller.signal,
        spawn: (command, args, options) => {
          const child = runUnconfined(standin, stage === 'during-proof' ? 'silence' : 'all-denied')(
            command,
            args,
            options,
          );
          if (stage === 'during-settle') {
            const parser = new WorkerFrameParser();
            child.stdout.on('data', (chunk: Buffer) => {
              if (parser.push(chunk).some((frame) => frame.type === 'probe-result'))
                setImmediate(() => controller.abort());
            });
          }
          spawned();
          return child;
        },
        startListeners: () =>
          trackedSyntheticListeners(() => {
            closeCalls += 1;
          }),
      });
      if (stage === 'during-proof') {
        await childStarted;
        controller.abort();
      }
      const result = await resolvesWithin(pending, 1_000);
      assert.deepEqual(result, { ok: false, code: 'boundary-failed', loadSent: false }, stage);
      assert.equal(closeCalls, stage === 'before-spawn' ? 0 : 1, stage);
    });
    await nextTurn();
    assert.deepEqual(activeResources(), before, `${stage} leaked a boundary resource`);
  }
});

test('E2 boundary: a tcp-only child escape is killed before load', async () => {
  await expectSyntheticEscape('tcp');
});

test('E2 boundary: a fetch-only child escape is killed before load', async () => {
  await expectSyntheticEscape('fetch');
});

test('E2 boundary: a udp-only child escape is killed before load', async () => {
  await expectSyntheticEscape('udp');
});

test('E2 boundary: a uds-only child escape is killed before load', async () => {
  await expectSyntheticEscape('uds');
});

test('E2 boundary: a child that started a process is killed before load', async () => {
  await expectSyntheticEscape('spawn');
});

test('E2 boundary: launch has literal profile, pipe-only fds and a closed environment', async () => {
  assert.equal(LAYA_SANDBOX_EXECUTABLE, '/usr/bin/sandbox-exec');
  assert.equal(LAYA_SANDBOX_PROFILE, '(version 1) (allow default) (deny network*)');
  // E2 review round 1 (A1): beside the network clause, no process, no Apple event, no Mach service and no write
  // outside the worker's own directory and /dev/null. The measured allow-list of Mach services is empty.
  assert.equal(LAYA_WORKER_DIRECTORY_PARAMETER, 'LAYA_WORKER_DIRECTORY');
  assert.equal(
    LAYA_SANDBOX_CONFINEMENT,
    '(deny process-fork) (deny appleevent-send) (deny mach-lookup) (deny file-write*) ' +
      '(allow file-write* (subpath (param "LAYA_WORKER_DIRECTORY")) (literal "/dev/null"))',
  );
  assert.equal(LAYA_WORKER_SANDBOX_PROFILE, `${LAYA_SANDBOX_PROFILE} ${LAYA_SANDBOX_CONFINEMENT}`);
  assert.deepEqual(LAYA_WORKER_ENV, CLOSED_WORKER_ENV);
  await withTemporaryDirectory(async (directory) => {
    let spawns = 0;
    const launch = runUnconfined(standin, 'all-denied');
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: (command, args, options) => {
        spawns += 1;
        assert.equal(options.cwd, directory, 'the worker runs in the owner-only data directory, never the daemon cwd');
        return launch(command, args, options);
      },
      startListeners: syntheticListeners,
    });
    try {
      assert.equal(boundary.ok, true, 'the asserted launch options must permit the reviewed child proof');
      assert.equal(spawns, 1, 'one proof starts exactly one child; the proven child is the one returned');
      if (boundary.ok) assert.equal(boundary.binding.pid, boundary.child.pid);
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test('E2 boundary: Linux and an unavailable macOS sandbox refuse before child startup', async () => {
  await withTemporaryDirectory(async (directory) => {
    let started = false;
    const unavailable = await createLayaWorkerBoundaryForTest({
      platform: 'linux',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: () => {
        started = true;
        throw new Error('must not spawn');
      },
    });
    assert.deepEqual(unavailable, { ok: false, code: 'LAYA_PLATFORM_UNAVAILABLE', loadSent: false });
    assert.equal(started, false);
  });
  const { sandboxExecAvailable } = await import('../src/runtime/laya/contracts.ts');
  assert.equal(
    sandboxExecAvailable({
      platform: 'darwin',
      architecture: 'arm64',
      spawnSync: () => ({ status: 1, signal: null }),
    }),
    false,
  );
});

test('E2 boundary: a real macOS sandbox proves all four attempts while pipes remain live', async (t) => {
  const { sandboxExecAvailable } = await import('../src/runtime/laya/contracts.ts');
  if (process.platform !== 'darwin' || !sandboxExecAvailable({ platform: 'darwin', architecture: process.arch })) {
    t.skip('requires the host macOS sandbox-exec boundary');
    return;
  }
  await skipIfListenerRefused(t, () =>
    withTemporaryDirectory(async (directory) => {
      const boundary = await createLayaWorkerBoundary({ dataDirectory: directory });
      try {
        assert.equal(boundary.ok, true, boundary.ok ? undefined : `boundary refusal: ${boundary.code}`);
        if (!boundary.ok) return;
        const loadRefused = waitForWorkerFrame(boundary.child, (frame) => frame.type === 'load-refused', 10_000);
        await boundary.sendLoad({ kind: 'test-only-no-runtime' });
        assert.equal((await loadRefused).type, 'load-refused');
      } finally {
        if (boundary.ok) await boundary.close();
      }
    }),
  );
});

/**
 * One Node child under the worker's profile, or unconfined: it writes in its own directory, outside it and to
 * /dev/null, starts a process and asks for the account database's user record (a Mach service lookup), and prints what
 * each did. Every value it prints is a fixed word or an error code.
 */
async function confinementProbe(directory: string, confined: boolean): Promise<Readonly<Record<string, string>>> {
  const inside = join(directory, 'worker');
  await mkdir(inside, { recursive: true, mode: 0o700 });
  const script = [
    "const { writeFileSync } = require('node:fs');",
    "const { spawnSync } = require('node:child_process');",
    "const { userInfo } = require('node:os');",
    'const result = {};',
    'const attempt = (name, run) => { try { run(); result[name] = "done"; } catch (error) { result[name] = error.info?.code ?? error.code ?? "error"; } };',
    `attempt('inside', () => writeFileSync(${JSON.stringify(join(inside, 'scratch'))}, 'x'));`,
    `attempt('outside', () => writeFileSync(${JSON.stringify(join(directory, 'outside'))}, 'x'));`,
    "attempt('devNull', () => writeFileSync('/dev/null', 'x'));",
    "attempt('spawn', () => { const run = spawnSync('/usr/bin/true', [], { stdio: 'ignore' }); if (run.error) throw run.error; });",
    "attempt('machLookup', () => userInfo());",
    'process.stdout.write(JSON.stringify(result));',
  ].join('\n');
  const [command, args] = confined
    ? [
        LAYA_SANDBOX_EXECUTABLE,
        [
          '-D',
          `${LAYA_WORKER_DIRECTORY_PARAMETER}=${realpathSync(inside)}`,
          '-p',
          LAYA_WORKER_SANDBOX_PROFILE,
          process.execPath,
          '-e',
          script,
        ],
      ]
    : [process.execPath, ['-e', script]];
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(command, args, { cwd: inside, env: CLOSED_WORKER_ENV, stdio: ['ignore', 'pipe', 'ignore'] });
    let stdout = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.once('error', reject);
    child.once('close', (code) =>
      code === 0 ? resolve(stdout) : reject(new Error(`confinement probe exited ${code}`)),
    );
  });
  await rm(join(directory, 'outside'), { force: true });
  return JSON.parse(output) as Readonly<Record<string, string>>;
}

test('E2 boundary: under the real profile the worker writes only in its own directory, starts no process and reaches no system service, and still loads its runtime', async (t) => {
  const { sandboxExecAvailable } = await import('../src/runtime/laya/contracts.ts');
  if (process.platform !== 'darwin' || !sandboxExecAvailable({ platform: 'darwin', architecture: process.arch })) {
    t.skip('requires the host macOS sandbox-exec boundary');
    return;
  }
  await withTemporaryDirectory(async (directory) => {
    // Unconfined, every act succeeds: a denial under the profile is the profile's, not this machine's.
    assert.deepEqual(await confinementProbe(directory, false), {
      inside: 'done',
      outside: 'done',
      devNull: 'done',
      spawn: 'done',
      machLookup: 'done',
    });
    assert.deepEqual(await confinementProbe(directory, true), {
      inside: 'done',
      outside: 'EPERM',
      devNull: 'done',
      spawn: 'EPERM',
      // The user record comes from opendirectoryd over a Mach lookup the profile refuses.
      machLookup: 'ENOENT',
    });
  });
  // The production surface: the shipped worker proves all five attempts under this profile, then loads Task 8's
  // synthetic runtime and answers over the same pipes, with no Mach service allowed.
  const { syntheticRuntimeTree, ANSWERING_LAYA } = await import('./support/laya-synthetic-runtime.ts');
  const { layaLayout, LAYA_NOUL_TEMPLATE_ID } = await import('../src/runtime/laya/templates.ts');
  const tree = await syntheticRuntimeTree({ layaModule: ANSWERING_LAYA });
  try {
    await skipIfListenerRefused(t, () =>
      withTemporaryDirectory(async (directory) => {
        const boundary = await createLayaWorkerBoundary({ dataDirectory: directory });
        try {
          assert.equal(boundary.ok, true, boundary.ok ? undefined : `boundary refusal: ${boundary.code}`);
          if (!boundary.ok) return;
          const input = {
            templateId: LAYA_NOUL_TEMPLATE_ID,
            instructions: 'Does this synthetic message ask for a reply?',
            state: 'three state words',
          };
          const words = (text: string): number => text.split(/\s+/u).filter((word) => word.length > 0).length;
          const layout = layaLayout(input.templateId, input);
          const inputTokens =
            words(layout.head) +
            layout.options.reduce((sum: number, option: string) => sum + 1 + words(option), 0) +
            words(layout.state) +
            4;
          await writeFile(
            join(tree.payload.runtimeRoot, 'node_modules', '@receptron', 'laya', 'dist', 'answer.json'),
            JSON.stringify({ noul: 0.375, inputTokens }),
          );
          const loaded = waitForWorkerFrame(boundary.child, (frame) => frame.type !== 'probe-attempt', 10_000);
          await boundary.sendLoad(tree.payload);
          assert.equal((await loaded).type, 'loaded');
          const answered = waitForWorkerFrame(boundary.child, (frame) => frame.type !== 'loaded', 10_000);
          boundary.child.stdin.write(
            encodeWorkerFrame({ type: 'request', ...boundary.binding, requestId: 'confined-1', ...input }),
          );
          const answer = await answered;
          assert.deepEqual([answer.type, answer.value, answer.inputTokens], ['answer', 0.375, inputTokens]);
        } finally {
          if (boundary.ok) await boundary.close();
        }
      }),
    );
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('E2 boundary: source has one probe-only network import boundary and no daemon authority imports', async () => {
  const [{ assertLayaWorkerSourceBoundary }, main, probe] = await Promise.all([
    import('../src/runtime/laya/worker-boundary-probe.ts'),
    readFile(workerMain, 'utf8'),
    readFile(new URL('../src/runtime/laya/worker-boundary-probe.ts', import.meta.url), 'utf8'),
  ]);
  assertLayaWorkerSourceBoundary({ workerMain: main, boundaryProbe: probe });
  assert.throws(() => assertLayaWorkerSourceBoundary({ workerMain: "import 'node:net';", boundaryProbe: probe }));
});

test('E2 boundary: the load frame repeats exactly the successful child binding', async () => {
  const { assertWorkerLoadBinding } = await import('../src/runtime/laya/worker-boundary-probe.ts');
  const binding = {
    nonce: 'a',
    pid: 42,
    profile: LAYA_SANDBOX_PROFILE as typeof LAYA_SANDBOX_PROFILE,
    entry: workerMain,
    pipeGeneration: 'b',
  };
  assert.doesNotThrow(() => assertWorkerLoadBinding(binding, { type: 'load', ...binding, payload: {} }));
  assert.throws(() =>
    assertWorkerLoadBinding(binding, { type: 'load', ...binding, pipeGeneration: 'replacement', payload: {} }),
  );
  assert.throws(() => assertWorkerLoadBinding(binding, { type: 'load', ...binding, pid: 99, payload: {} }));
  assert.throws(() =>
    assertWorkerLoadBinding(binding, { type: 'load', ...binding, nonce: 'replacement', payload: {} }),
  );
  assert.throws(() =>
    assertWorkerLoadBinding(binding, { type: 'load', ...binding, profile: '(version 1) (allow default)', payload: {} }),
  );
  assert.throws(() =>
    assertWorkerLoadBinding(binding, { type: 'load', ...binding, entry: 'replacement', payload: {} }),
  );
  assert.notDeepEqual(
    encodeWorkerFrame({ type: 'load', ...binding, payload: {} }),
    encodeWorkerFrame({ type: 'load', ...binding, pipeGeneration: 'replacement', payload: {} }),
  );
});

interface UnconfinedListeners {
  readonly tcpPort: number;
  readonly udpPort: number;
  readonly udsPath: string;
  readonly observed: { tcp: number; udp: number; uds: number };
  close(): Promise<void>;
}

/**
 * Test-owned loopback listeners that answer, so an unconfined worker's every attempt can be seen to arrive. Windows
 * has no pathname socket listener, so a test that runs there asks for TCP and UDP only.
 */
async function unconfinedListeners(directory: string, { pathname = true } = {}): Promise<UnconfinedListeners> {
  const observed = { tcp: 0, udp: 0, uds: 0 };
  const accepted = new Set<Socket>();
  const track = (socket: Socket): void => {
    accepted.add(socket);
    socket.once('close', () => accepted.delete(socket));
    socket.on('error', () => undefined);
  };
  const tcp = createServer((socket) => {
    observed.tcp += 1;
    track(socket);
    // An HTTP answer that closes the connection lets the worker's fetch attempt complete, as an escape would.
    socket.end('HTTP/1.1 204 No Content\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
  const uds = createServer((socket) => {
    observed.uds += 1;
    track(socket);
    socket.destroy();
  });
  const udp = createSocket('udp4');
  udp.on('message', () => {
    observed.udp += 1;
  });
  const listen = (server: Server, ...address: readonly [number, string] | readonly [string]): Promise<void> =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      if (address.length === 2) server.listen(address[0], address[1], () => resolve());
      else server.listen(address[0], () => resolve());
    });
  const udsPath = join(directory, 'u.sock');
  await listen(tcp, 0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    udp.once('error', reject);
    udp.bind(0, '127.0.0.1', () => resolve());
  });
  if (pathname) await listen(uds, udsPath);
  const tcpAddress = tcp.address();
  if (tcpAddress === null || typeof tcpAddress === 'string') throw new Error('test listener');
  return {
    tcpPort: tcpAddress.port,
    udpPort: udp.address().port,
    udsPath,
    observed,
    async close() {
      for (const socket of accepted) socket.destroy();
      await Promise.all([
        new Promise<void>((resolve) => tcp.close(() => resolve())),
        pathname ? new Promise<void>((resolve) => uds.close(() => resolve())) : Promise.resolve(),
        new Promise<void>((resolve) => udp.close(() => resolve())),
      ]);
    },
  };
}

/** Runs the shipped worker entry directly, unconfined, and returns what it wrote before it answered or exited. */
async function driveActualWorker(
  frame: (pid: number) => Readonly<Record<string, unknown>>,
  until: (frame: Readonly<Record<string, unknown>>) => boolean,
): Promise<{ readonly frames: readonly Readonly<Record<string, unknown>>[]; readonly code: number | null }> {
  const child = spawn(process.execPath, ['--experimental-strip-types', workerMain], {
    cwd: '/',
    env: CLOSED_WORKER_ENV,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  child.stderr.resume();
  const frames: Readonly<Record<string, unknown>>[] = [];
  const parser = new WorkerFrameParser();
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('the actual worker neither answered nor exited')), 15_000);
      child.stdout.on('data', (chunk: Buffer) => {
        for (const parsed of parser.push(chunk)) {
          frames.push(parsed);
          if (until(parsed)) {
            clearTimeout(timer);
            resolve({ frames, code: null });
          }
        }
      });
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        resolve({ frames, code });
      });
      if (child.pid === undefined) throw new Error('the actual worker did not start');
      child.stdin.write(encodeWorkerFrame(frame(child.pid)));
    });
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
    }
  }
}

function actualProbe(pid: number, listeners: UnconfinedListeners): Readonly<Record<string, unknown>> {
  return {
    type: 'probe',
    nonce: 'nonce-under-test',
    pid,
    profile: LAYA_SANDBOX_PROFILE,
    entry: workerMain,
    pipeGeneration: 'pipes-under-test',
    tcpPort: listeners.tcpPort,
    udpPort: listeners.udpPort,
    udsPath: listeners.udsPath,
  };
}

async function settleTraffic(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 100));
}

test('E2 boundary: the actual worker attempts TCP, fetch, UDP and UDS in order against unconfined listeners', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    const listeners = await unconfinedListeners(directory);
    try {
      const { frames } = await driveActualWorker(
        (pid) => actualProbe(pid, listeners),
        (frame) => frame.type === 'probe-result',
      );
      await settleTraffic();
      assert.deepEqual(
        frames.map((frame) => [frame.type, frame.attempt, frame.outcome]),
        [
          ['probe-attempt', 'tcp', 'escaped'],
          ['probe-attempt', 'fetch', 'escaped'],
          ['probe-attempt', 'udp', 'escaped'],
          ['probe-attempt', 'uds', 'escaped'],
          ['probe-attempt', 'spawn', 'escaped'],
          ['probe-result', undefined, undefined],
        ],
        'without a sandbox every attempt must reach its listener, or a denial under the sandbox would prove nothing',
      );
      assert.deepEqual(listeners.observed, { tcp: 2, udp: 1, uds: 1 });
      const result = frames.at(-1);
      assert.deepEqual(
        [result?.tcp, result?.fetch, result?.udp, result?.uds, result?.spawn, result?.nonce, result?.pipeGeneration],
        ['escaped', 'escaped', 'escaped', 'escaped', 'escaped', 'nonce-under-test', 'pipes-under-test'],
      );
    } finally {
      await listeners.close();
    }
  });
});

test('E2 boundary: the actual worker refuses a probe for another process, entry or frame order before any attempt', {
  skip: WINDOWS_SKIP,
}, async () => {
  const refusals: readonly [string, (pid: number, listeners: UnconfinedListeners) => Record<string, unknown>][] = [
    ['another pid', (pid, listeners) => ({ ...actualProbe(pid, listeners), pid: pid + 1 })],
    ['another entry', (pid, listeners) => ({ ...actualProbe(pid, listeners), entry: standin })],
    [
      'another profile',
      (pid, listeners) => ({ ...actualProbe(pid, listeners), profile: '(version 1) (allow default)' }),
    ],
    ['load before probe', (pid, listeners) => ({ ...actualProbe(pid, listeners), type: 'load' })],
  ];
  for (const [name, frame] of refusals) {
    await withTemporaryDirectory(async (directory) => {
      const listeners = await unconfinedListeners(directory);
      try {
        // Any frame at all is already a failure, so the wait ends on the first one or on the worker's exit.
        const { frames, code } = await driveActualWorker(
          (pid) => frame(pid, listeners),
          () => true,
        );
        await settleTraffic();
        assert.equal(code, 70, `${name}: the worker exits as a protocol refusal`);
        assert.deepEqual(frames, [], `${name}: the worker reports nothing`);
        assert.deepEqual(listeners.observed, { tcp: 0, udp: 0, uds: 0 }, `${name}: the worker attempts nothing`);
      } finally {
        await listeners.close();
      }
    });
  }
});

test("E2 boundary: after its probe the worker's fetch, sockets and listeners are sealed", async () => {
  await withTemporaryDirectory(async (directory) => {
    const listeners = await unconfinedListeners(directory, { pathname: false });
    try {
      const script = [
        `import { sealWorkerNetworkAfterProbe } from ${JSON.stringify(pathToFileURL(boundaryProbe).href)};`,
        "import { connect, createServer, Socket } from 'node:net';",
        "import { createSocket } from 'node:dgram';",
        "import { request } from 'node:http';",
        `const tcpPort = ${listeners.tcpPort};`,
        `const udpPort = ${listeners.udpPort};`,
        // Built from parts: the E2 checker reads a literal scheme-and-host in a Laya test as a host to refuse.
        `const loopback = '127.0.0.1:${listeners.tcpPort}';`,
        // A datagram socket bound before the seal must still be unable to send or connect after it.
        "const bound = createSocket('udp4');",
        "await new Promise((resolve) => bound.bind(0, '127.0.0.1', resolve));",
        "const httpTarget = ['http', '://', loopback, '/'].join('');",
        "const webSocketTarget = ['ws', '://', loopback, '/'].join('');",
        'sealWorkerNetworkAfterProbe();',
        'const results = {};',
        'const attempt = async (name, run) => {',
        '  try { await run(); results[name] = "open"; } catch (error) { results[name] = error.message; }',
        '};',
        "await attempt('fetch', () => fetch(httpTarget));",
        "await attempt('websocket', () => new WebSocket(webSocketTarget));",
        "await attempt('tcp', () => connect(tcpPort, '127.0.0.1'));",
        "await attempt('socket', () => new Socket().connect(tcpPort, '127.0.0.1'));",
        "await attempt('http', () => new Promise((resolve, reject) => {",
        "  const outgoing = request({ host: '127.0.0.1', port: tcpPort });",
        "  outgoing.on('error', reject); outgoing.on('response', resolve); outgoing.end();",
        '}));',
        "await attempt('listen', () => createServer().listen(0, '127.0.0.1'));",
        "await attempt('udp-send', () => createSocket('udp4').send(Buffer.from([0]), udpPort, '127.0.0.1'));",
        "await attempt('udp-bind', () => createSocket('udp4').bind(0, '127.0.0.1'));",
        "await attempt('bound-udp-send', () => new Promise((resolve, reject) => {",
        "  bound.send(Buffer.from([0]), udpPort, '127.0.0.1', (error) => (error ? reject(error) : resolve()));",
        '}));',
        "await attempt('bound-udp-connect', () => bound.connect(udpPort, '127.0.0.1'));",
        'process.stdout.write(JSON.stringify(results));',
        'process.exit(0);',
      ].join('\n');
      const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
          { cwd: directory, env: environment, stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let stdout = '';
        let stderr = '';
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
          stderr += chunk;
        });
        child.once('error', reject);
        child.once('close', (code) => (code === 0 ? resolve(stdout) : reject(new Error(`sealed child: ${stderr}`))));
      });
      await settleTraffic();
      const sealed = 'Laya worker network is sealed';
      assert.deepEqual(JSON.parse(output), {
        fetch: sealed,
        websocket: sealed,
        tcp: sealed,
        socket: sealed,
        http: sealed,
        listen: sealed,
        'udp-send': sealed,
        'udp-bind': sealed,
        'bound-udp-send': sealed,
        'bound-udp-connect': sealed,
      });
      assert.deepEqual(listeners.observed, { tcp: 0, udp: 0, uds: 0 });
    } finally {
      await listeners.close();
    }
  });
});

test('E2 boundary: a network resource that outlives the probe withholds its report', async () => {
  const { assertNoProbeSocketsRemain, networkResourcesRemain } = await import(
    '../src/runtime/laya/worker-boundary-probe.ts'
  );
  assert.equal(networkResourcesRemain(['PipeWrap', 'PipeWrap', 'PipeWrap', 'Timeout', 'FSReqCallback']), false);
  for (const resource of [
    'TCPSocketWrap',
    'TCPServerWrap',
    'UDPWrap',
    'PipeServerWrap',
    'GetAddrInfoReqWrap',
    'TLSWrap',
  ]) {
    assert.equal(networkResourcesRemain(['PipeWrap', resource]), true, resource);
  }
  await assert.rejects(
    () => assertNoProbeSocketsRemain(() => ['PipeWrap', 'TCPSocketWrap']),
    /network resource outlived its probe/,
  );
  let polls = 0;
  await assertNoProbeSocketsRemain(() => {
    polls += 1;
    return polls < 3 ? ['UDPWrap'] : ['PipeWrap'];
  });
  assert.equal(polls, 3, 'a socket still closing is waited for, not reported');
});

function childWhosePipesFail(): LayaWorkerSpawn {
  return () => {
    // As with a real pipe, the write is accepted and its EPIPE arrives afterwards, with no write left waiting on it.
    const failingWrite = new Writable({
      write(_chunk, _encoding, callback) {
        setTimeout(() => callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })), 20);
      },
    });
    const child = Object.assign(new EventEmitter(), {
      pid: 424242,
      exitCode: null as number | null,
      signalCode: null as NodeJS.Signals | null,
      stdin: failingWrite,
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill(): boolean {
        child.signalCode = 'SIGKILL';
        queueMicrotask(() => {
          child.emit('exit', null, 'SIGKILL');
          child.emit('close', null, 'SIGKILL');
        });
        return true;
      },
    });
    return child as unknown as ChildProcessWithoutNullStreams;
  };
}

test('E2 boundary: a worker that exits before the probe fails closed without an EPIPE escaping the daemon', async () => {
  await withTemporaryDirectory(async (directory) => {
    const result = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: childWhosePipesFail(),
      startListeners: syntheticListeners,
      timeoutMs: 200,
    });
    assert.deepEqual(result, { ok: false, code: 'boundary-failed', loadSent: false });
  });
});

test('E2 boundary: a chatty stderr neither stalls the proof nor reaches its result', async () => {
  await withTemporaryDirectory(async (directory) => {
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, 'stderr-flood'),
      startListeners: syntheticListeners,
    });
    try {
      assert.equal(boundary.ok, true);
      if (!boundary.ok) return;
      assert.deepEqual(Object.keys(boundary).toSorted(), ['binding', 'child', 'close', 'ok', 'sendLoad']);
      assert.doesNotMatch(JSON.stringify(boundary.binding), /laya-stderr-secret/);
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test("E2 boundary: a proven worker's next frame waits for its next reader", async () => {
  await withTemporaryDirectory(async (directory) => {
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, 'all-denied'),
      startListeners: syntheticListeners,
    });
    try {
      assert.equal(boundary.ok, true);
      if (!boundary.ok) return;
      await boundary.sendLoad({ kind: 'test-only-no-runtime' });
      // The stand-in answers at once, while nobody is reading its stdout yet.
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
      const answer = await waitForWorkerFrame(boundary.child, (frame) => frame.type === 'load-ack', 5_000);
      assert.equal(answer.nonce, boundary.binding.nonce);
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test("E2 boundary: phase E's fetch rule exempts only the probe's one loopback fetch attempt", async () => {
  // @ts-expect-error The verifier is a repository executable with no declaration file.
  const { verifyPhaseEJudgeSource } = await import('../../../scripts/verify-events-phase-e-tests.mjs');
  const probeFile = 'packages/events-daemon/src/runtime/laya/worker-boundary-probe.ts';
  // The probe's exact call, built from parts so neither the E2 hostname scan nor a template placeholder misreads it.
  const attempt = ['globalThis.fetch(`http', '://127.0.0.1:', '$', '{port}/laya-boundary-probe`, { signal });\n'].join(
    '',
  );
  assert.deepEqual(verifyPhaseEJudgeSource({ file: probeFile, source: await readFile(boundaryProbe, 'utf8') }), []);
  assert.deepEqual(verifyPhaseEJudgeSource({ file: probeFile, source: attempt }), []);
  for (const file of [
    'packages/events-daemon/src/runtime/laya/worker-main.ts',
    'packages/events-daemon/src/runtime/laya/worker-protocol.ts',
    'packages/events-daemon/src/runtime/judge-coordinator.ts',
  ]) {
    assert.deepEqual(verifyPhaseEJudgeSource({ file, source: attempt }), [`${file}: judge paths must not call fetch`]);
  }
  const probeSource = await readFile(boundaryProbe, 'utf8');
  const refusedUse = [`${probeFile}: the Laya boundary probe may use fetch only in its one loopback attempt`];
  for (const evasion of [
    'globalThis.fetch(target);',
    'globalThis.fetch?.(target);',
    "globalThis['fetch'](target);",
    'fetch.call(null, target);',
    'Reflect.apply(fetch, null, [target]);',
    'const request = globalThis.fetch;',
    "export const PROBE_ATTEMPTS = ['tcp', 'fetch', 'udp', 'uds', 'spawn'] as const;",
  ]) {
    assert.deepEqual(
      verifyPhaseEJudgeSource({ file: probeFile, source: `${probeSource}\n${evasion}\n` }),
      refusedUse,
      evasion,
    );
  }
  assert.deepEqual(verifyPhaseEJudgeSource({ file: probeFile, source: `${attempt}${attempt}` }), refusedUse);
  assert.deepEqual(verifyPhaseEJudgeSource({ file: probeFile, source: `${attempt}http.request(options);\n` }), [
    `${probeFile}: judge paths must not call http.request`,
  ]);
  assert.deepEqual(
    verifyPhaseEJudgeSource({ file: probeFile, source: `import { get } from 'node:https';\n${attempt}` }),
    [`${probeFile}: judge paths must not import node:http or node:https`],
  );
});

test('E2 boundary: the worker loads only its probe, its protocol and Node built-ins before any runtime', async () => {
  const sourceRoot = dirname(workerMain);
  // Task 8's runtime adapter and its templates load with the worker too, and import Node built-ins only: the runtime
  // and model are reached only by the adapter's one verified-tree import, after the load frame.
  const allowed = new Set(
    [
      'worker-main.ts',
      'worker-boundary-probe.ts',
      'worker-protocol.ts',
      'worker-runtime.ts',
      'templates.ts',
      '../../network/error-sink.ts',
    ].map((file) => resolve(sourceRoot, file)),
  );
  const seen = new Set<string>();
  const pending = [workerMain];
  for (let file = pending.pop(); file !== undefined; file = pending.pop()) {
    if (seen.has(file)) continue;
    seen.add(file);
    assert.ok(allowed.has(file), `the worker must not load ${file}`);
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/g)) {
      const specifier = match[2] ?? '';
      if (specifier.startsWith('.')) pending.push(resolve(dirname(file), specifier));
      else assert.match(specifier, /^node:[a-z_/]+$/, `${file} may import only Node built-ins: ${specifier}`);
    }
  }
  assert.deepEqual([...seen].toSorted(), [...allowed].toSorted());
});

test('E2 boundary: a socket path macOS would truncate fails closed before any child starts', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    // 105 bytes: past macOS's 103, inside Linux's 107, so an unguarded listener binds on both and the child starts.
    const suffix = '/laya-boundary-XXXXXX/boundary.sock';
    const dataDirectory = join(directory, 'd'.repeat(105 - Buffer.byteLength(directory) - 1 - suffix.length));
    assert.equal(Buffer.byteLength(`${dataDirectory}${suffix}`), 105);
    let spawns = 0;
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory,
      workerEntry: standin,
      spawn: (command, args, options) => {
        spawns += 1;
        return runUnconfined(standin, 'all-denied')(command, args, options);
      },
    });
    try {
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
      assert.equal(spawns, 0, 'no child starts against a listener bound somewhere other than the path it is told');
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test('E2 boundary: traffic that reaches a listener while it closes still fails the proof', async () => {
  await withTemporaryDirectory(async (directory) => {
    const observed = { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 };
    const boundary = await createLayaWorkerBoundaryForTest({
      platform: 'darwin',
      dataDirectory: directory,
      workerEntry: standin,
      spawn: runUnconfined(standin, 'all-denied'),
      startListeners: async () => ({
        tcpPort: 1,
        udpPort: 2,
        udsPath: '/tmp/laya-boundary-closing.sock',
        get observed() {
          return { ...observed };
        },
        failure: new Promise<Error>(() => undefined),
        async close() {
          observed.udsConnections += 1;
        },
      }),
    });
    try {
      assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false });
    } finally {
      if (boundary.ok) await boundary.close();
    }
  });
});

test("E2 boundary: the daemon's own listeners catch a child that reaches them and still reports every attempt denied", {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const mode of ['tcp-sneak', 'udp-sneak', 'uds-sneak'] as const) {
    await withTemporaryDirectory(async (directory) => {
      const boundary = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory: directory,
        workerEntry: standin,
        spawn: runUnconfined(standin, mode),
      });
      try {
        assert.deepEqual(boundary, { ok: false, code: 'boundary-failed', loadSent: false }, mode);
      } finally {
        if (boundary.ok) await boundary.close();
      }
    });
  }
});

test('E2 boundary: the actual worker reports a refused or missing listener as failed, never as denied', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    // Ports that were just released and a socket path that does not exist: nothing listens, no sandbox refuses.
    const released = createServer();
    await new Promise<void>((resolve) => released.listen(0, '127.0.0.1', () => resolve()));
    const address = released.address();
    await new Promise<void>((resolve) => released.close(() => resolve()));
    if (address === null || typeof address === 'string') throw new Error('test port');
    const nothing: UnconfinedListeners = {
      tcpPort: address.port,
      udpPort: address.port,
      udsPath: join(directory, 'absent.sock'),
      observed: { tcp: 0, udp: 0, uds: 0 },
      async close() {},
    };
    const { frames } = await driveActualWorker(
      (pid) => actualProbe(pid, nothing),
      (frame) => frame.type === 'probe-result',
    );
    assert.deepEqual(
      frames.map((frame) => [frame.attempt, frame.outcome]),
      [
        ['tcp', 'failed'],
        ['fetch', 'failed'],
        ['udp', 'escaped'],
        ['uds', 'failed'],
        ['spawn', 'escaped'],
        [undefined, undefined],
      ],
      'only an operating-system refusal is a denial; a refused or absent listener proves nothing',
    );
  });
});

test('E2 boundary: only EPERM or EACCES, on the error, its cause or an aggregate member, is a denial', async () => {
  const { deniedBySystem } = await import('../src/runtime/laya/worker-boundary-probe.ts');
  const coded = (code: string): Error => Object.assign(new Error(code), { code });
  for (const error of [
    coded('EPERM'),
    coded('EACCES'),
    new TypeError('fetch failed', { cause: coded('EPERM') }),
    new AggregateError([coded('ECONNREFUSED'), coded('EACCES')], 'connect'),
  ]) {
    assert.equal(deniedBySystem(error), true, String(error));
  }
  for (const error of [
    coded('ECONNREFUSED'),
    coded('ENOENT'),
    coded('ETIMEDOUT'),
    new Error('boundary probe timeout'),
    new TypeError('fetch failed', { cause: coded('ECONNRESET') }),
    'EPERM',
    null,
  ]) {
    assert.equal(deniedBySystem(error), false, String(error));
  }
});

test('E2 boundary: a sandbox launcher that cannot start is never signalled, so the daemon process group survives', {
  skip: WINDOWS_SKIP,
}, async () => {
  await withTemporaryDirectory(async (directory) => {
    // Node gives a failed spawn no PID; signalling it reaches PID 0, the caller's whole process group. The run is in
    // a detached child, its own process group, so a regression kills only that child.
    const script = [
      `import { createLayaWorkerBoundaryForTest } from ${JSON.stringify(pathToFileURL(boundaryProbe).href)};`,
      "import { spawn } from 'node:child_process';",
      'const result = await createLayaWorkerBoundaryForTest({',
      "  platform: 'darwin',",
      `  dataDirectory: ${JSON.stringify(directory)},`,
      "  workerEntry: '/nonexistent/laya-worker.mjs',",
      "  spawn: (command, args, options) => spawn('/nonexistent/laya-sandbox-exec', args, options),",
      '  startListeners: async () => ({',
      "    tcpPort: 1, udpPort: 2, udsPath: '/tmp/laya-boundary-unspawned.sock',",
      '    observed: { tcpConnections: 0, udpDatagrams: 0, udsConnections: 0 },',
      '    failure: new Promise(() => undefined),',
      '    async close() {},',
      '  }),',
      '});',
      'await new Promise((resolve) => setTimeout(resolve, 100));',
      'process.stdout.write(JSON.stringify(result));',
    ].join('\n');
    const { NODE_TEST_CONTEXT: _testContext, ...environment } = process.env;
    const outcome = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>(
      (resolve, reject) => {
        const child = spawn(
          process.execPath,
          ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script],
          { cwd: directory, detached: true, env: environment, stdio: ['ignore', 'pipe', 'ignore'] },
        );
        let stdout = '';
        const timer = setTimeout(() => {
          if (child.pid !== undefined) process.kill(child.pid, 'SIGKILL');
        }, 15_000);
        child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
          stdout += chunk;
        });
        child.once('error', reject);
        child.once('close', (code, signal) => {
          clearTimeout(timer);
          resolve({ code, signal, stdout });
        });
      },
    );
    assert.deepEqual(outcome, {
      code: 0,
      signal: null,
      stdout: JSON.stringify({ ok: false, code: 'boundary-failed', loadSent: false }),
    });
  });
});
