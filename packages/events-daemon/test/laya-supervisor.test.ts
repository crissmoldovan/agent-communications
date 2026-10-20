import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { LayaWorkerSelection } from '../src/runtime/laya/manager.ts';
import { LAYA_CHOICE2_TEMPLATE_ID, LAYA_NOUL_TEMPLATE_ID } from '../src/runtime/laya/templates.ts';
import {
  createLayaWorkerBoundaryForTest,
  LAYA_WORKER_ENV,
  type LayaBoundaryResult,
} from '../src/runtime/laya/worker-boundary-probe.ts';
import { WorkerFrameParser } from '../src/runtime/laya/worker-protocol.ts';
import {
  LAYA_IDLE_EXIT_MS,
  LAYA_LOAD_DEADLINE_MS,
  LAYA_REQUEST_DEADLINE_MS,
  LAYA_WORKER_DIRECTORY_PARENT,
  type LayaExecutionResult,
  type LayaPreparedRequest,
  type LayaWorkerArtifacts,
  LayaWorkerSupervisor,
  type LayaWorkerSupervisorOptions,
} from '../src/runtime/laya/worker-supervisor.ts';
import { ANSWERING_LAYA, syntheticRuntimeTree } from './support/laya-synthetic-runtime.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const standin = fileURLToPath(new URL('./support/laya-worker-standin.ts', import.meta.url));
const supervisorSource = new URL('../src/runtime/laya/worker-supervisor.ts', import.meta.url);
const MANIFEST_ID = 'laya-en-onnx-tiny-v1';
/** A synthetic enveloped judge input: what E's coordinator hands over, never an event, account or target. */
const STATE = '{"version":1,"inputs":[{"pointer":"/subject","value":"synthetic subject"}]}';
const QUESTION = 'Does this synthetic message ask for a reply?';

interface Started {
  readonly pid: number;
  readonly dataDirectory: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Every frame the daemon wrote to this child after its proof, in order. */
  readonly written: Readonly<Record<string, unknown>>[];
}

interface Rig {
  readonly supervisor: LayaWorkerSupervisor;
  readonly artifacts: LayaWorkerArtifacts & {
    selection: LayaWorkerSelection | null;
    available: boolean;
    verified: boolean;
    roots: { readonly runtimeRoot: string; readonly modelRoot: string };
    readonly failures: string[];
    readonly verifications: number[];
    purge(reservationId: string): void;
  };
  readonly started: Started[];
  /** Every proof attempt, including a refused one. */
  readonly attempts: { readonly dataDirectory: string }[];
  readonly gates: string[];
  execute(reservationId?: string, request?: Partial<LayaPreparedRequest>): Promise<LayaExecutionResult>;
  close(): Promise<void>;
}

function selectionFor(epoch = 1): LayaWorkerSelection {
  return {
    epoch,
    version: 1,
    digest: 'a'.repeat(64),
    manifestId: MANIFEST_ID,
    promptTemplates: [LAYA_CHOICE2_TEMPLATE_ID, LAYA_NOUL_TEMPLATE_ID],
  };
}

/** The manager's narrow surface, with every fact a test needs to move: availability, selection, verification, purge. */
function fakeArtifacts(): Rig['artifacts'] {
  const tracked = new Map<string, AbortController>();
  const artifacts: Rig['artifacts'] = {
    selection: selectionFor(),
    available: true,
    verified: true,
    roots: { runtimeRoot: '/tmp/laya-synthetic-runtime', modelRoot: '/tmp/laya-synthetic-model' },
    failures: [],
    verifications: [],
    availability: () =>
      artifacts.available ? { available: true } : { available: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
    workerSelection: () => artifacts.selection,
    async verifyForWorkerStart() {
      artifacts.verifications.push(Date.now());
      return artifacts.verified ? { ok: true, ...artifacts.roots } : { ok: false, failureCode: 'integrity' };
    },
    recordWorkerFailure: (_selection, failureCode) => {
      artifacts.failures.push(failureCode);
    },
    trackWork(reservationId) {
      const controller = new AbortController();
      tracked.set(reservationId, controller);
      return { signal: controller.signal, release: () => tracked.delete(reservationId) };
    },
    attachWorker: () => () => undefined,
    purge(reservationId) {
      tracked.get(reservationId)?.abort();
    },
  };
  return artifacts;
}

function frameRecorder(child: ChildProcessWithoutNullStreams, written: Readonly<Record<string, unknown>>[]): void {
  const parser = new WorkerFrameParser();
  const write = child.stdin.write.bind(child.stdin) as (chunk: unknown, ...rest: unknown[]) => boolean;
  child.stdin.write = ((chunk: unknown, ...rest: unknown[]) => {
    if (Buffer.isBuffer(chunk)) written.push(...parser.push(chunk));
    return write(chunk, ...rest);
  }) as typeof child.stdin.write;
}

/**
 * Task 7's real proof over a frame-compatible stand-in run unconfined: the stand-in reports every attempt denied, so
 * the proof's own listeners and binding checks run, and then it serves the post-load protocol as told.
 */
function rig(
  serve: string,
  options: Partial<LayaWorkerSupervisorOptions> & {
    readonly extra?: readonly string[];
    readonly probe?: string;
    readonly onStart?: (dataDirectory: string) => void;
    /** The behaviour of the n-th child started (from 1); `serve` otherwise. */
    readonly serveFor?: (start: number) => string;
  } = {},
): Rig {
  const artifacts = fakeArtifacts();
  const started: Started[] = [];
  const attempts: { dataDirectory: string }[] = [];
  const gates: string[] = [];
  const supervisor = new LayaWorkerSupervisor({
    artifacts,
    requestDeadlineMs: options.requestDeadlineMs ?? 5_000,
    idleExitMs: options.idleExitMs ?? 60_000,
    loadDeadlineMs: options.loadDeadlineMs ?? 5_000,
    startWorker: async ({ dataDirectory, signal }) => {
      attempts.push({ dataDirectory });
      options.onStart?.(dataDirectory);
      const result: LayaBoundaryResult = await createLayaWorkerBoundaryForTest({
        platform: 'darwin',
        dataDirectory,
        workerEntry: standin,
        signal,
        spawn: (_command, _args, spawnOptions) =>
          spawn(
            process.execPath,
            [
              '--experimental-strip-types',
              standin,
              '--standin',
              options.probe ?? 'all-denied',
              '--serve',
              options.serveFor?.(attempts.length) ?? serve,
              ...(options.extra ?? []),
            ],
            spawnOptions,
          ) as ChildProcessWithoutNullStreams,
      });
      if (result.ok) {
        const written: Readonly<Record<string, unknown>>[] = [];
        frameRecorder(result.child, written);
        started.push({ pid: result.binding.pid, dataDirectory, child: result.child, written });
      }
      return result;
    },
  });
  let sequence = 0;
  return {
    supervisor,
    artifacts,
    started,
    attempts,
    gates,
    execute(reservationId = `reservation-${++sequence}`, request = {}) {
      const prepared = supervisor.prepare({
        judge: { model: MANIFEST_ID, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
        state: STATE,
        instructions: QUESTION,
      });
      assert.equal(prepared.ok, true, 'a prepared synthetic request');
      if (!prepared.ok) throw new Error('unprepared');
      return supervisor.execute(
        { ...prepared.request, ...request },
        {
          reservationId,
          finalGate: () => {
            gates.push(reservationId);
          },
        },
      );
    },
    close: () => supervisor.close(),
  };
}

function exited(child: ChildProcessWithoutNullStreams): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function waitUntil(condition: () => boolean, ms: number, what: string): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

async function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out waiting for ${what}`)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function absent(path: string): Promise<boolean> {
  return stat(path).then(
    () => false,
    () => true,
  );
}

test('E2 Laya supervisor: one framed request, after the proof, bound to the proven child and carrying no event, account or target', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('answer', { extra: ['--value-json', '0.6125', '--tokens', '41'] });
  try {
    assert.deepEqual(await laya.execute('reservation-a'), { kind: 'answer', value: 0.6125, inputTokens: 41 });
    assert.equal(laya.started.length, 1);
    const [load, request, ...rest] = laya.started[0]?.written ?? [];
    assert.deepEqual(rest, [], 'one load and one request: nothing else reaches the worker');
    assert.equal(load?.type, 'load');
    assert.deepEqual(load?.payload, {
      runtimeRoot: '/tmp/laya-synthetic-runtime',
      modelDir: '/tmp/laya-synthetic-model',
    });
    assert.deepEqual(Object.keys(request ?? {}).toSorted(), [
      'entry',
      'instructions',
      'nonce',
      'pid',
      'pipeGeneration',
      'profile',
      'requestId',
      'state',
      'templateId',
      'type',
    ]);
    assert.equal(request?.type, 'request');
    assert.equal(request?.pid, laya.started[0]?.pid, 'the request goes to the very child that passed its proof');
    for (const field of ['nonce', 'profile', 'entry', 'pipeGeneration'] as const)
      assert.equal(request?.[field], load?.[field], `the request repeats the proven ${field}`);
    assert.equal(request?.templateId, LAYA_NOUL_TEMPLATE_ID);
    assert.equal(request?.state, STATE);
    assert.equal(request?.instructions, QUESTION);
    assert.match(String(request?.requestId), /^[0-9a-f-]{36}$/u, 'a random request id, not the reservation id');
    assert.doesNotMatch(JSON.stringify(request), /reservation-a|eventId|accountId|target|ruleId/u);
    assert.deepEqual(laya.gates, ['reservation-a'], "E's gate ran once, for this request");
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: E gates the reservation immediately before the one write, and a refused gate writes nothing', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('answer');
  try {
    const order: string[] = [];
    const prepared = laya.supervisor.prepare({
      judge: { model: MANIFEST_ID, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
      state: STATE,
      instructions: QUESTION,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const first = await laya.supervisor.execute(prepared.request, {
      reservationId: 'gated',
      finalGate: () => {
        order.push(`gate:${laya.started[0]?.written.length}`);
      },
    });
    assert.equal(first.kind, 'answer');
    assert.deepEqual(order, ['gate:1'], 'only the load had been written when the gate ran');
    const refused = await laya.supervisor.execute(prepared.request, {
      reservationId: 'refused-gate',
      finalGate: () => {
        throw new Error('JUDGE_AUTHORITY_CHANGED');
      },
    });
    assert.deepEqual(refused, { kind: 'refused', code: 'laya-authority-changed', preIo: true });
    assert.equal(laya.started[0]?.written.length, 2, 'a refused gate wrote no request frame');
    assert.equal(exited(laya.started[0]?.child as ChildProcessWithoutNullStreams), false, 'and kept the idle worker');
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor timeout/crash/idle: a hung request is killed at its deadline and the next starts a fresh child', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('hang-second', { requestDeadlineMs: 400 });
  try {
    assert.equal((await laya.execute()).kind, 'answer');
    const startedAt = Date.now();
    assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'laya-timeout', preIo: false });
    assert.ok(Date.now() - startedAt < 4_000, 'the deadline, not the stand-in, ended the request');
    const hung = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    await waitUntil(() => exited(hung), 2_000, 'the hung worker to be killed');
    assert.equal(hung.signalCode, 'SIGKILL');
    assert.equal(await absent(laya.started[0]?.dataDirectory ?? ''), true, 'its owner-only directory is removed');
    assert.equal((await laya.execute()).kind, 'answer');
    assert.equal(laya.started.length, 2, 'a later call starts a fresh worker');
    assert.notEqual(laya.started[1]?.pid, laya.started[0]?.pid);
    assert.equal(laya.artifacts.verifications.length, 2, 'and verifies both trees again before it');
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor timeout/crash/idle: a crash is no-match and the next request restarts the worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('answer', { requestDeadlineMs: 20_000, serveFor: (start) => (start === 1 ? 'crash' : 'answer') });
  try {
    const startedAt = Date.now();
    assert.deepEqual(await within(laya.execute(), 10_000, 'the crash'), {
      kind: 'refused',
      code: 'laya-crashed',
      preIo: false,
    });
    assert.ok(Date.now() - startedAt < 10_000, 'the exit, not the deadline, settled it');
    const answer = await laya.execute();
    assert.equal(answer.kind, 'answer');
    assert.equal(laya.started.length, 2);
    assert.notEqual(laya.started[1]?.pid, laya.started[0]?.pid);
  } finally {
    await laya.close();
  }
});

test('E2 late worker result is discarded', { skip: WINDOWS_SKIP }, async () => {
  // The late reply comes long after the 2-second wait below, so only the deadline's own kill can end the worker in it.
  const laya = rig('late', { requestDeadlineMs: 300, extra: ['--delay', '5000'] });
  try {
    assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'laya-timeout', preIo: false });
    const late = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    await waitUntil(() => exited(late), 2_000, 'the late worker to be killed');
    // The answer the killed worker would have sent after its deadline never reaches a caller.
    await new Promise<void>((resolve) => setTimeout(resolve, 900));
    assert.equal(laya.started.length, 1, 'nothing restarted on its own');
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor timeout/crash/idle: an idle worker exits after its idle window', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('answer', { idleExitMs: 300 });
  try {
    assert.equal((await laya.execute()).kind, 'answer');
    const idle = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    assert.equal(exited(idle), false);
    await waitUntil(() => exited(idle), 5_000, 'the idle worker to exit');
    assert.equal((await laya.execute()).kind, 'answer');
    assert.equal(laya.started.length, 2, 'the next call starts a fresh worker');
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: the production deadlines are D11’s 30 seconds and ten idle minutes', async () => {
  assert.equal(LAYA_REQUEST_DEADLINE_MS, 30_000);
  assert.equal(LAYA_IDLE_EXIT_MS, 600_000);
  assert.equal(LAYA_LOAD_DEADLINE_MS, 120_000);
});

test('E2 Laya supervisor: a second request is written only after the first has settled', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('slow', { extra: ['--delay', '300'] });
  try {
    const first = laya.execute('first');
    const second = laya.execute('second');
    const results = await Promise.all([first, second]);
    assert.deepEqual(
      results.map((result) => result.kind),
      ['answer', 'answer'],
    );
    assert.equal(laya.started.length, 1, 'one worker answered both');
    assert.deepEqual(laya.gates, ['first', 'second']);
    // The stand-in answers each request after 300 ms; were both written at once, its answers would overlap.
    const requests = laya.started[0]?.written.filter((frame) => frame.type === 'request') ?? [];
    assert.equal(requests.length, 2);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: requests are serialised — the second waits in the queue while the first is in flight', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('slow', { extra: ['--delay', '400'] });
  try {
    const first = laya.execute('first');
    await waitUntil(() => laya.gates.length === 1, 10_000, 'the first request to pass its gate');
    const second = laya.execute('second');
    await new Promise<void>((resolve) => setTimeout(resolve, 200));
    assert.deepEqual(laya.gates, ['first'], 'the second request is not gated while the first is in flight');
    assert.equal(laya.started[0]?.written.filter((frame) => frame.type === 'request').length, 1);
    await first;
    await second;
    assert.deepEqual(laya.gates, ['first', 'second']);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: any unexpected frame kills the worker, a late probe-attempt included', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('late-probe-attempt', { extra: ['--delay', '150'] });
  try {
    assert.equal((await laya.execute()).kind, 'answer');
    const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    await waitUntil(() => exited(worker), 5_000, 'the worker that sent a late probe-attempt to be killed');
    assert.equal(worker.signalCode, 'SIGKILL');
    assert.equal((await laya.execute()).kind, 'answer');
    assert.equal(laya.started.length, 2);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: an answer outside its closed shape is malformed and kills the worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  const cases: readonly [string, readonly string[]][] = [
    ['answer', ['--value-json', '1.5']],
    ['answer', ['--value-json', '-0.25']],
    ['answer', ['--value-json', '1e309']],
    ['answer', ['--value-json', '"0.5"']],
    ['answer', ['--value-json', 'null']],
    ['answer', ['--tokens', '513']],
    ['answer', ['--tokens', '0']],
    ['extra-field', []],
    ['wrong-request-id', []],
    ['wrong-binding', []],
  ];
  for (const [serve, extra] of cases) {
    const laya = rig(serve, { extra });
    try {
      assert.deepEqual(
        await laya.execute(),
        { kind: 'refused', code: 'laya-malformed', preIo: false },
        `${serve} ${extra.join(' ')}`,
      );
      const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
      await waitUntil(() => exited(worker), 2_000, `the ${serve} worker to be killed`);
    } finally {
      await laya.close();
    }
  }
});

test('E2 Laya supervisor: a worker’s own refusal is no-match and keeps the worker', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [serve, code] of [
    ['token-limit', 'laya-token-limit'],
    ['malformed-refusal', 'laya-malformed'],
    ['template-blocked', 'laya-template-blocked'],
  ] as const) {
    const laya = rig(serve);
    try {
      assert.deepEqual(await laya.execute(), { kind: 'refused', code, preIo: false });
      assert.equal(exited(laya.started[0]?.child as ChildProcessWithoutNullStreams), false);
    } finally {
      await laya.close();
    }
  }
});

test('E2 Laya supervisor: a failed proof sends no load and records boundary-failed', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const probe of ['tcp', 'fetch', 'udp', 'uds']) {
    const laya = rig('answer', { probe });
    try {
      assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'boundary-failed', preIo: true });
      assert.equal(laya.started.length, 0, 'no proven child, so nothing was loaded');
      assert.deepEqual(laya.artifacts.failures, ['boundary-failed']);
      assert.deepEqual(laya.gates, [], 'nothing reached E’s gate');
      assert.equal(await absent(laya.attempts[0]?.dataDirectory ?? ''), true);
    } finally {
      await laya.close();
    }
  }
});

test('E2 Laya supervisor: a runtime that refuses to load records runtime-failed and is killed', {
  skip: WINDOWS_SKIP,
}, async () => {
  for (const [serve, options] of [
    ['refuse-load', {}],
    ['hang-load', { loadDeadlineMs: 400 }],
  ] as const) {
    const laya = rig(serve, options);
    try {
      assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'runtime-failed', preIo: true });
      assert.deepEqual(laya.artifacts.failures, ['runtime-failed']);
      const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
      await waitUntil(() => exited(worker), 2_000, `the ${serve} worker to be killed`);
      assert.deepEqual(laya.gates, []);
    } finally {
      await laya.close();
    }
  }
});

test('E2 Laya supervisor: an unready model, a failed verification or unavailable Laya starts no child', {
  skip: WINDOWS_SKIP,
}, async () => {
  const unready = rig('answer');
  try {
    unready.artifacts.verified = false;
    assert.deepEqual(await unready.execute(), { kind: 'refused', code: 'integrity', preIo: true });
    const prepared = unready.supervisor.prepare({
      judge: { model: MANIFEST_ID, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
      state: STATE,
      instructions: QUESTION,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    unready.artifacts.selection = null;
    assert.deepEqual(
      await unready.supervisor.execute(prepared.request, { reservationId: 'r', finalGate: () => undefined }),
      {
        kind: 'refused',
        code: 'laya-not-ready',
        preIo: true,
      },
    );
    assert.equal(unready.attempts.length, 0, 'no child was ever started');
  } finally {
    await unready.close();
  }
  const blocked = rig('answer');
  try {
    blocked.artifacts.available = false;
    assert.deepEqual(
      blocked.supervisor.prepare({
        judge: { model: MANIFEST_ID, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
        state: STATE,
        instructions: QUESTION,
      }),
      { ok: false, code: 'E2_EXTERNAL_REFERENCE_BLOCKED' },
    );
    assert.deepEqual(
      await blocked.supervisor.execute(
        { templateId: LAYA_NOUL_TEMPLATE_ID, instructions: QUESTION, state: STATE, body: Buffer.from('x') },
        { reservationId: 'blocked', finalGate: () => undefined },
      ),
      { kind: 'refused', code: 'E2_EXTERNAL_REFERENCE_BLOCKED', preIo: true },
    );
    assert.equal(blocked.attempts.length, 0, 'the placeholder lock spawns nothing');
  } finally {
    await blocked.close();
  }
});

test('E2 Laya supervisor: a selection changed after its trees were verified sends no load', {
  skip: WINDOWS_SKIP,
}, async () => {
  let laya: Rig | undefined;
  laya = rig('answer', {
    onStart: () => {
      // A disable and re-enable, or an update, lands while the child proves its boundary.
      if (laya !== undefined) laya.artifacts.selection = selectionFor(2);
    },
  });
  try {
    assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'laya-authority-changed', preIo: true });
    const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    assert.deepEqual(laya.started[0]?.written, [], 'the proven child never received a load frame');
    await waitUntil(() => exited(worker), 2_000, 'the unloaded child to be killed');
    assert.deepEqual(laya.gates, []);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: a selection changed while the worker was idle refuses before any request is written', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('answer');
  try {
    assert.equal((await laya.execute()).kind, 'answer');
    laya.artifacts.selection = selectionFor(2);
    assert.deepEqual(await laya.execute(), { kind: 'refused', code: 'laya-authority-changed', preIo: true });
    assert.equal(laya.started[0]?.written.filter((frame) => frame.type === 'request').length, 1);
    assert.equal(laya.gates.length, 1);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: a purge of the in-flight reservation kills its worker at once', {
  skip: WINDOWS_SKIP,
}, async () => {
  const laya = rig('hang', { requestDeadlineMs: 20_000 });
  try {
    const pending = laya.execute('purged-work');
    await waitUntil(() => laya.gates.length === 1, 10_000, 'the request to be in flight');
    laya.artifacts.purge('purged-work');
    assert.deepEqual(await within(pending, 5_000, 'the purge'), {
      kind: 'refused',
      code: 'laya-purged',
      preIo: false,
    });
    const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    await waitUntil(() => exited(worker), 2_000, 'the purged worker to be killed');
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: stop kills the worker and fails what waited on it', { skip: WINDOWS_SKIP }, async () => {
  const laya = rig('hang', { requestDeadlineMs: 20_000 });
  try {
    const pending = laya.execute('stopped-work');
    await waitUntil(() => laya.gates.length === 1, 10_000, 'the request to be in flight');
    await laya.supervisor.stop();
    assert.deepEqual(await within(pending, 5_000, 'the stop'), { kind: 'refused', code: 'laya-stopped', preIo: false });
    const worker = laya.started[0]?.child as ChildProcessWithoutNullStreams;
    assert.equal(exited(worker), true);
  } finally {
    await laya.close();
  }
});

test('E2 Laya supervisor: each worker directory keeps the probe’s socket within macOS’s 103 bytes for any home', {
  skip: WINDOWS_SKIP,
}, async () => {
  let directory: string | undefined;
  const laya = rig('answer', {
    onStart: (dataDirectory) => {
      directory = dataDirectory;
    },
  });
  try {
    assert.equal((await laya.execute()).kind, 'answer');
    assert.equal(LAYA_WORKER_DIRECTORY_PARENT, '/tmp');
    assert.match(directory ?? '', /^\/tmp\/agentcomms-laya-[A-Za-z0-9]{6}$/u);
    const socket = `${directory}/laya-boundary-XXXXXX/boundary.sock`;
    assert.ok(Buffer.byteLength(socket) <= 103, `${socket} fits`);
    assert.equal(((await stat(directory ?? '')).mode & 0o777).toString(8), '700', 'owner-only');
  } finally {
    await laya.close();
  }
  assert.equal(await absent(directory ?? ''), true, 'the directory leaves with its worker');
});

test('E2 Laya supervisor has no daemon authority', async () => {
  const source = await readFile(supervisorSource, 'utf8');
  // Every specifier: `from`, a dynamic `import(` and a bare side-effect `import '…'` alike.
  const imports = [...source.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\1/gu)].map(
    (match) => match[2] ?? '',
  );
  for (const specifier of imports)
    assert.ok(
      /^node:(?:child_process|fs\/promises|path|sqlite)$/u.test(specifier) || /^\.\/[a-z-]+\.ts$/u.test(specifier),
      `the supervisor imports only Laya-local modules and process/file built-ins: ${specifier}`,
    );
  assert.doesNotMatch(source, /\bprepare\s*\(\s*['"`]\s*(?:SELECT|UPDATE|INSERT|DELETE)/iu, 'it runs no SQL');
  const executable = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\r\n]*$/gmu, '');
  assert.doesNotMatch(executable, /\b(?:secret|keychain|accountId|eventId|targetId|ruleId)\b/iu);
  // Production proves and launches only the shipped entry, with only a directory and a signal.
  assert.match(source, /options\.startWorker \?\? \(\(start\) => createLayaWorkerBoundary\(start\)\)/u);
  assert.deepEqual(LAYA_WORKER_ENV, { PATH: '/usr/bin:/bin', TZ: 'UTC' });
});

test('E2 Laya supervisor: under this Mac’s own sandbox the shipped worker proves, loads a verified runtime and answers', async (t) => {
  const { sandboxExecAvailable } = await import('../src/runtime/laya/contracts.ts');
  if (process.platform !== 'darwin' || !sandboxExecAvailable({ platform: 'darwin', architecture: process.arch })) {
    t.skip('requires the host macOS sandbox-exec boundary');
    return;
  }
  const { layaSequenceTokens } = await import('../src/runtime/laya/worker-runtime.ts');
  const tree = await syntheticRuntimeTree({ layaModule: ANSWERING_LAYA });
  const artifacts = fakeArtifacts();
  artifacts.roots = { runtimeRoot: tree.payload.runtimeRoot, modelRoot: tree.payload.modelDir };
  // The production launcher: `/usr/bin/sandbox-exec`, the literal profile and the shipped worker entry.
  const supervisor = new LayaWorkerSupervisor({ artifacts });
  try {
    const prepared = supervisor.prepare({
      judge: { model: MANIFEST_ID, promptTemplate: LAYA_NOUL_TEMPLATE_ID },
      state: STATE,
      instructions: QUESTION,
    });
    assert.equal(prepared.ok, true);
    if (!prepared.ok) return;
    const words = (text: string): number => text.split(/\s+/u).filter(Boolean).length;
    const tokens = layaSequenceTokens({ countTokens: words }, prepared.request);
    assert.ok(tokens !== null);
    await writeFile(
      join(tree.payload.runtimeRoot, 'node_modules', '@receptron', 'laya', 'dist', 'answer.json'),
      JSON.stringify({ noul: 0.375, inputTokens: tokens }),
    );
    const gates: string[] = [];
    assert.deepEqual(
      await supervisor.execute(prepared.request, {
        reservationId: 'sandboxed',
        finalGate: () => void gates.push('in-flight'),
      }),
      { kind: 'answer', value: 0.375, inputTokens: tokens },
    );
    assert.deepEqual(gates, ['in-flight']);
    assert.deepEqual(artifacts.failures, []);
  } finally {
    await supervisor.close();
    await rm(tree.root, { recursive: true, force: true });
  }
});
