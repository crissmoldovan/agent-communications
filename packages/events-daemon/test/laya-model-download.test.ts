import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  resolverFor,
  scriptedLayaOrigin,
  splitBodyLayaOrigin,
  stalledLayaOrigin,
  tlsHandshakeStallLayaOrigin,
} from './support/laya-origin.ts';

assertLoopbackSeal();

const { LayaArtifactFetcher } = await import('../src/runtime/laya/fetcher.ts');
const { LayaModelDownloadError, LayaModelDownloader } = await import('../src/runtime/laya/model-downloader.ts');

const revision = 'b'.repeat(40);
const modelId = 'tiny-model-v1';
const fixtureRoot = join(import.meta.dirname, 'fixtures', 'laya', 'model-tiny-v1');
// E2 review round 1 (B6): a phase's deadline stays far above the few milliseconds its abort takes, and the settle guard
// far above the deadline, so a loaded runner cannot turn an abort into a deadline or a slow settle into a failure; the
// guard only stops a hang. Every wait for a test's own signal is bounded too, and each test has a timeout.
const PHASE_TOTAL_TIMEOUT_MS = 1_000;
const PHASE_SETTLE_GUARD_MS = 5_000;
const TEST_TIMEOUT = { timeout: 60_000 } as const;

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function file(path: string, body: string) {
  const bytes = Buffer.from(body);
  return { path, size: bytes.length, sha256: sha256(bytes), bytes };
}

async function testFiles() {
  const paths = [
    'laya.onnx',
    'laya.onnx.data',
    'laya_config.json',
    'tokenizer/tokenizer.json',
    'tokenizer/tokenizer_config.json',
  ];
  return Promise.all(paths.map(async (path) => file(path, await readFile(join(fixtureRoot, path), 'utf8'))));
}

function downloader(
  root: string,
  origin: Pick<ReturnType<typeof scriptedLayaOrigin>, 'tcpConnect' | 'tlsConnect'>,
  files: Awaited<ReturnType<typeof testFiles>>,
  fence = {
    async assertCurrent(_stage: string) {},
    async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
      return work();
    },
  },
  fetchOptions: {
    readonly resolver?: { lookup(hostname: string): Promise<readonly string[]> };
    readonly idleTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
  } = {},
) {
  const manifest = {
    manifestId: modelId,
    source: { host: 'huggingface.co' as const, repo: 'receptron/laya-onnx', revision },
    files: files.map(({ bytes: _bytes, ...expected }) => expected),
  };
  const fetcher = new LayaArtifactFetcher({
    manifest,
    runtimePackages: [],
    resolver: fetchOptions.resolver ?? resolverFor('8.8.8.8'),
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
    idleTimeoutMs: fetchOptions.idleTimeoutMs,
    totalTimeoutMs: fetchOptions.totalTimeoutMs,
  });
  return new LayaModelDownloader({ dataDirectory: root, manifest, fetcher, fence });
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`download did not settle within ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function downloadOptions(overrides: Partial<{ readonly freeBytes: () => Promise<number> }> = {}): {
  readonly signal: AbortSignal;
  readonly freeBytes?: () => Promise<number>;
} {
  return { signal: new AbortController().signal, ...overrides };
}

async function temporary(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'events-e2-laya-download-'));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function activeResources(): readonly string[] {
  return process.getActiveResourcesInfo().toSorted();
}

async function settledResources(): Promise<readonly string[]> {
  let previous = activeResources();
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const current = activeResources();
    if (JSON.stringify(current) === JSON.stringify(previous)) return current;
    previous = current;
  }
  return previous;
}

async function settlesAfter(controller: AbortController, milliseconds: number): Promise<void> {
  setTimeout(() => controller.abort(), milliseconds);
  await new Promise((resolve) => setTimeout(resolve, milliseconds + 2));
}

async function waitUntil(check: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + PHASE_SETTLE_GUARD_MS;
  while (Date.now() < deadline) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function assertNoLeakedResources(before: readonly string[], signal: AbortSignal): Promise<void> {
  const events = (await import('node:events')) as unknown as {
    getEventListeners(target: EventTarget, type: string): readonly unknown[];
  };
  assert.equal(events.getEventListeners(signal, 'abort').length, 0, 'the phase must remove its abort listener');
  assert.deepEqual(await settledResources(), before, 'the phase must leave no socket, timeout, or listener resource');
}

test(
  'E2 laya model download: an unresolved resolver aborts or times out and removes the partial tree',
  TEST_TIMEOUT,
  async (t) => {
    for (const mode of ['abort', 'deadline'] as const) {
      await t.test(mode, async () => {
        await temporary(async (root) => {
          const files = [file('laya.onnx', 'abcdef')];
          const partial = join(root, 'models', `${modelId}.partial`);
          const controller = new AbortController();
          let resolverCalls = 0;
          const before = await settledResources();
          const instance = downloader(root, scriptedLayaOrigin([]), files, undefined, {
            resolver: {
              lookup: async () => {
                resolverCalls += 1;
                return new Promise<readonly string[]>(() => undefined);
              },
            },
            totalTimeoutMs: PHASE_TOTAL_TIMEOUT_MS,
          });
          const pending = instance.download({ signal: controller.signal });
          void pending.catch(() => undefined);
          await waitUntil(() => resolverCalls === 1, 'the injected resolver to begin');
          if (mode === 'abort') await settlesAfter(controller, 5);
          await assert.rejects(
            () => settlesWithin(pending, PHASE_SETTLE_GUARD_MS),
            (error: unknown) =>
              error instanceof LayaModelDownloadError && error.code === (mode === 'abort' ? 'CANCELLED' : 'DEADLINE'),
          );
          await assert.rejects(() => lstat(partial), { code: 'ENOENT' });
          await assertNoLeakedResources(before, controller.signal);
        });
      });
    }
  },
);

test(
  'E2 laya model download: a TLS handshake stall observes abort and deadline then removes the partial tree',
  TEST_TIMEOUT,
  async (t) => {
    for (const mode of ['abort', 'deadline'] as const) {
      await t.test(mode, async () => {
        await temporary(async (root) => {
          const files = [file('laya.onnx', 'abcdef')];
          const partial = join(root, 'models', `${modelId}.partial`);
          const origin = tlsHandshakeStallLayaOrigin();
          const controller = new AbortController();
          const before = await settledResources();
          const pending = downloader(root, origin, files, undefined, {
            totalTimeoutMs: PHASE_TOTAL_TIMEOUT_MS,
          }).download({
            signal: controller.signal,
          });
          void pending.catch(() => undefined);
          await waitUntil(() => origin.tlsStarted(), 'the sealed peer to begin TLS');
          if (mode === 'abort') await settlesAfter(controller, 5);
          await assert.rejects(
            () => settlesWithin(pending, PHASE_SETTLE_GUARD_MS),
            (error: unknown) =>
              error instanceof LayaModelDownloadError && error.code === (mode === 'abort' ? 'CANCELLED' : 'DEADLINE'),
          );
          assert.equal(
            origin.tlsSignalObserved(),
            true,
            'the TLS primitive must receive the fetch abort/deadline signal',
          );
          assert.equal(origin.destroyed(), true, 'a TLS abort/deadline must destroy the accepted TCP socket');
          await assert.rejects(() => lstat(partial), { code: 'ENOENT' });
          await assertNoLeakedResources(before, controller.signal);
        });
      });
    }
  },
);

// E2 CI round 1: the owner's stop and every disable fence the manager's job (its fence turns stale) and abort its
// signal at once. A fence check that found the signal already aborted answered the abort and left the stale fence's
// own rejection unhandled: on a loaded runner (the check after a file's hash) the daemon would end on it.
test(
  'E2 laya model download: a fence that goes stale as the download is cancelled is answered, never left to reject unhandled',
  TEST_TIMEOUT,
  async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      await temporary(async (root) => {
        const controller = new AbortController();
        const never = async () => {
          throw new Error('a cancelled download connects nowhere');
        };
        const fence = {
          // As the manager's stop does: the job's signal aborts and its fence is stale in the same moment.
          async assertCurrent(_stage: string) {
            controller.abort();
            throw new Error('the fence is stale');
          },
          async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
            return work();
          },
        };
        const download = downloader(root, { tcpConnect: never, tlsConnect: never } as never, await testFiles(), fence);
        await assert.rejects(download.download({ signal: controller.signal }), { code: 'CANCELLED' });
        // An unhandled rejection is reported after the microtasks of the turn it was made in.
        for (let turn = 0; turn < 3; turn += 1) await new Promise<void>((resolve) => setImmediate(resolve));
      });
      assert.deepEqual(unhandled, [], 'a stale fence is answered even when the signal decided first');
    } finally {
      process.off('unhandledRejection', record);
    }
  },
);

test('E2 laya model download: forwards abort into the TLS handshake primitive', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const origin = tlsHandshakeStallLayaOrigin();
    const controller = new AbortController();
    const pending = downloader(root, origin, files, undefined, { totalTimeoutMs: PHASE_TOTAL_TIMEOUT_MS }).download({
      signal: controller.signal,
    });
    void pending.catch(() => undefined);
    await waitUntil(() => origin.tlsStarted(), 'the sealed peer to begin TLS');
    controller.abort();
    await assert.rejects(
      () => settlesWithin(pending, PHASE_SETTLE_GUARD_MS),
      (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'CANCELLED',
    );
    assert.equal(origin.tlsSignalObserved(), true, 'the TLS primitive must receive the fetch abort/deadline signal');
  });
});

test(
  'E2 laya model download: a peer with no response header aborts or times out and removes the partial tree',
  TEST_TIMEOUT,
  async (t) => {
    for (const mode of ['abort', 'deadline'] as const) {
      await t.test(mode, async () => {
        await temporary(async (root) => {
          const files = [file('laya.onnx', 'abcdef')];
          const partial = join(root, 'models', `${modelId}.partial`);
          const origin = stalledLayaOrigin();
          const controller = new AbortController();
          const before = await settledResources();
          const pending = downloader(root, origin, files, undefined, {
            idleTimeoutMs: PHASE_SETTLE_GUARD_MS,
            totalTimeoutMs: PHASE_TOTAL_TIMEOUT_MS,
          }).download({ signal: controller.signal });
          void pending.catch(() => undefined);
          await waitUntil(() => origin.journal.length === 1, 'the sealed peer to receive the request');
          if (mode === 'abort') await settlesAfter(controller, 5);
          await assert.rejects(
            () => settlesWithin(pending, PHASE_SETTLE_GUARD_MS),
            (error: unknown) =>
              error instanceof LayaModelDownloadError && error.code === (mode === 'abort' ? 'CANCELLED' : 'DEADLINE'),
          );
          assert.equal(origin.destroyed(), true, 'the response-phase abort/deadline must destroy the sealed peer');
          await assert.rejects(() => lstat(partial), { code: 'ENOENT' });
          await assertNoLeakedResources(before, controller.signal);
        });
      });
    }
  },
);

async function assertBlockedSinkWaitsForCleanup(mode: 'abort' | 'deadline'): Promise<void> {
  await temporary(async (root) => {
    const contents = Buffer.from('abcdef');
    const files = [file('laya.onnx', contents.toString('utf8'))];
    const partial = join(root, 'models', `${modelId}.partial`);
    const partialFile = join(partial, 'laya.onnx');
    await mkdir(partial, { recursive: true });
    await writeFile(partialFile, contents.subarray(0, 3));
    const retainedPartial = await open(partialFile, 'r');
    const controller = new AbortController();
    const totalTimeoutMs = PHASE_TOTAL_TIMEOUT_MS;
    let retryChecks = 0;
    let releaseBlockedSink!: () => void;
    let blockedSignal: AbortSignal | undefined;
    const sinkBlocked = new Promise<void>((resolve) => {
      releaseBlockedSink = resolve;
    });
    let sinkEntered!: () => void;
    const sinkEnteredPromise = new Promise<void>((resolve) => {
      sinkEntered = resolve;
    });
    const fence = {
      async assertCurrent(stage: string, signal?: AbortSignal) {
        if (stage !== 'retry') return;
        retryChecks += 1;
        if (retryChecks !== 5) return;
        blockedSignal = signal;
        sinkEntered();
        await sinkBlocked;
      },
      async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
        return work();
      },
    };
    const firstOrigin = splitBodyLayaOrigin(
      {
        status: 206,
        headers: { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' },
        body: contents.subarray(3),
      },
      1,
    );
    const first = downloader(root, firstOrigin, files, fence, { totalTimeoutMs }).download({
      signal: controller.signal,
    });
    void first.catch(() => undefined);

    try {
      await settlesWithin(sinkEnteredPromise, PHASE_SETTLE_GUARD_MS);
      if (mode === 'abort') controller.abort();
      else await new Promise((resolve) => setTimeout(resolve, totalTimeoutMs + 20));

      assert.equal(blockedSignal?.aborted, true, 'the lifecycle fence must observe the fetch abort/deadline signal');
      await assert.rejects(
        () => settlesWithin(first, PHASE_SETTLE_GUARD_MS),
        (error: unknown) =>
          error instanceof LayaModelDownloadError && error.code === (mode === 'abort' ? 'CANCELLED' : 'DEADLINE'),
      );
      assert.equal(
        await settlesWithin(retainedPartial.readFile({ encoding: 'utf8' }), PHASE_SETTLE_GUARD_MS),
        'abcd',
        'the aborted sink must not append after its lifecycle wait returns',
      );
      await assert.rejects(() => lstat(partial), { code: 'ENOENT' });

      const reenabledOrigin = scriptedLayaOrigin([
        { status: 200, headers: { 'Content-Length': String(contents.length) }, body: contents },
      ]);
      const reenabled = await settlesWithin(
        downloader(root, reenabledOrigin, files).download(downloadOptions()),
        PHASE_SETTLE_GUARD_MS,
      );
      assert.equal(reenabled.bytesVerified, contents.length, 'the re-enabled download verifies its only attempt');
      assert.equal(reenabledOrigin.journal.length, 1, 'the re-enabled download needs no retry after the stale sink');
      assert.equal(
        sha256(await readFile(join(reenabled.root, 'laya.onnx'))),
        files[0]?.sha256,
        'the re-enabled model has the manifest SHA-256 on its first attempt',
      );
    } finally {
      releaseBlockedSink();
      await settlesWithin(Promise.allSettled([first]), PHASE_SETTLE_GUARD_MS);
      await settlesWithin(retainedPartial.close(), PHASE_SETTLE_GUARD_MS);
    }
  });
}

test('E2 laya model download: waits for a blocked abort sink before cleanup and re-enable', TEST_TIMEOUT, async () => {
  await assertBlockedSinkWaitsForCleanup('abort');
});

test(
  'E2 laya model download: waits for a blocked deadline sink before cleanup and re-enable',
  TEST_TIMEOUT,
  async () => {
    await assertBlockedSinkWaitsForCleanup('deadline');
  },
);

test('E2 laya model download: rechecks an abort after its lifecycle fence awaits', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const contents = Buffer.from('abcdef');
    const files = [file('laya.onnx', contents.toString('utf8'))];
    const partial = join(root, 'models', `${modelId}.partial`);
    const partialFile = join(partial, 'laya.onnx');
    await mkdir(partial, { recursive: true });
    await writeFile(partialFile, contents.subarray(0, 3));
    const retainedPartial = await open(partialFile, 'r');
    const controller = new AbortController();
    let retryChecks = 0;
    let releaseFence!: () => void;
    let fenceSignal: AbortSignal | undefined;
    const fenceBlocked = new Promise<void>((resolve) => {
      releaseFence = resolve;
    });
    let sinkEntered!: () => void;
    const sinkEnteredPromise = new Promise<void>((resolve) => {
      sinkEntered = resolve;
    });
    const fence = {
      assertCurrent(stage: string, signal?: AbortSignal): Promise<void> {
        if (stage !== 'retry') return Promise.resolve();
        retryChecks += 1;
        if (retryChecks !== 4) return Promise.resolve();
        fenceSignal = signal;
        sinkEntered();
        return {
          // biome-ignore lint/suspicious/noThenProperty: a hand-made thenable runs the awaiting continuation before the abort, the interleaving under test
          then(
            onFulfilled?: ((value: undefined) => unknown) | null,
            onRejected?: ((reason: unknown) => unknown) | null,
          ) {
            return fenceBlocked.then(() => {
              const result = onFulfilled?.(undefined);
              controller.abort();
              return result;
            }, onRejected ?? undefined);
          },
        } as unknown as Promise<void>;
      },
      async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
        return work();
      },
    };
    const firstOrigin = scriptedLayaOrigin([
      {
        status: 206,
        headers: { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' },
        body: contents.subarray(3),
      },
    ]);
    const first = downloader(root, firstOrigin, files, fence).download({ signal: controller.signal });
    void first.catch(() => undefined);

    try {
      await settlesWithin(sinkEnteredPromise, PHASE_SETTLE_GUARD_MS);
      releaseFence();
      await assert.rejects(
        () => settlesWithin(first, PHASE_SETTLE_GUARD_MS),
        (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'CANCELLED',
      );
      assert.equal(fenceSignal?.aborted, true, 'the sink fence receives the fetch abort signal');
      assert.equal(
        await settlesWithin(retainedPartial.readFile({ encoding: 'utf8' }), PHASE_SETTLE_GUARD_MS),
        'abc',
        'the sink must recheck abort after its lifecycle fence before appending bytes',
      );
      await assert.rejects(() => lstat(partial), { code: 'ENOENT' });

      const reenabledOrigin = scriptedLayaOrigin([
        { status: 200, headers: { 'Content-Length': String(contents.length) }, body: contents },
      ]);
      const reenabled = await settlesWithin(
        downloader(root, reenabledOrigin, files).download(downloadOptions()),
        PHASE_SETTLE_GUARD_MS,
      );
      assert.equal(reenabledOrigin.journal.length, 1, 'the re-enabled download verifies on its first attempt');
      assert.equal(sha256(await readFile(join(reenabled.root, 'laya.onnx'))), files[0]?.sha256);
    } finally {
      releaseFence();
      await settlesWithin(Promise.allSettled([first]), PHASE_SETTLE_GUARD_MS);
      await settlesWithin(retainedPartial.close(), PHASE_SETTLE_GUARD_MS);
    }
  });
});

test('E2 laya model download: promotes only after five tiny files verify', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = await testFiles();
    const origin = scriptedLayaOrigin(
      files.map(({ bytes }) => ({ status: 200, headers: { 'Content-Length': String(bytes.length) }, body: bytes })),
    );
    const result = await downloader(root, origin, files).download(downloadOptions());
    assert.deepEqual(JSON.parse(await readFile(join(result.root, 'tokenizer/tokenizer_config.json'), 'utf8')), {
      fixture: 'five',
    });
    await assert.rejects(() => lstat(join(root, 'models', `${modelId}.partial`)), { code: 'ENOENT' });
    assert.equal(origin.journal.length, 5);
  });
});

test('E2 laya model download: resumes only a rehashed exact Content-Range', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const partial = join(root, 'models', `${modelId}.partial`);
    await mkdir(partial, { recursive: true });
    await writeFile(join(partial, 'laya.onnx'), 'abc');
    const origin = scriptedLayaOrigin([
      { status: 206, headers: { 'Content-Range': 'bytes 3-5/6', 'Content-Length': '3' }, body: Buffer.from('def') },
    ]);
    await downloader(root, origin, files).download(downloadOptions());
    assert.match(origin.journal[0]?.request ?? '', /Range: bytes=3-\r\n/u);
    assert.equal(await readFile(join(root, 'models', modelId, 'laya.onnx'), 'utf8'), 'abcdef');
  });
});

// E2 review round 1 (A7/B8): the model's data file is 1.69 GB, so a whole-file read would hold all of it in memory.
// Node's readFile refuses a file of 2 GiB or more, so a held partial of exactly 2 GiB (sparse: no disk is used) can be
// rehashed and resumed, and the finished file verified, only by a hash that streams.
test('E2 laya model download: rehashes a held partial and verifies the finished file as a stream, never as one read', {
  skip: process.platform === 'win32' && 'a sparse 2 GiB fixture needs a POSIX filesystem',
  timeout: 180_000,
}, async () => {
  await temporary(async (root) => {
    const held = 2 ** 31;
    const tail = Buffer.from('tail');
    const size = held + tail.length;
    const expected = createHash('sha256');
    const zeros = Buffer.alloc(2 ** 24);
    for (let written = 0; written < held; written += zeros.length) expected.update(zeros);
    expected.update(tail);
    const files = [{ path: 'laya.onnx.data', size, sha256: expected.digest('hex'), bytes: Buffer.alloc(0) }];
    const partial = join(root, 'models', `${modelId}.partial`);
    await mkdir(partial, { recursive: true });
    const handle = await open(join(partial, 'laya.onnx.data'), 'w');
    await handle.truncate(held);
    await handle.close();
    const origin = scriptedLayaOrigin([
      {
        status: 206,
        headers: { 'Content-Range': `bytes ${held}-${size - 1}/${size}`, 'Content-Length': String(tail.length) },
        body: tail,
      },
    ]);
    const result = await downloader(root, origin, files).download(
      downloadOptions({ freeBytes: async () => Number.MAX_SAFE_INTEGER }),
    );
    assert.equal(origin.journal.length, 1, 'one request: the held bytes were rehashed, not fetched again');
    assert.match(origin.journal[0]?.request ?? '', new RegExp(`Range: bytes=${held}-\\r\\n`, 'u'));
    assert.equal(result.bytesVerified, size, 'the finished file verified at its manifest size and SHA-256');
    assert.equal((await lstat(join(result.root, 'laya.onnx.data'))).size, size);
  });
});

test('E2 laya model download: resets a partial on 200, mismatched Content-Range, or 416', TEST_TIMEOUT, async (t) => {
  for (const reply of [
    { status: 200, headers: { 'Content-Length': '6' }, body: Buffer.from('abcdef') },
    { status: 206, headers: { 'Content-Range': 'bytes 2-5/6', 'Content-Length': '3' }, body: Buffer.from('def') },
    { status: 416, headers: { 'Content-Range': 'bytes */6' } },
  ]) {
    await t.test(String(reply.status), async () => {
      await temporary(async (root) => {
        const files = [file('laya.onnx', 'abcdef')];
        const partial = join(root, 'models', `${modelId}.partial`);
        await mkdir(partial, { recursive: true });
        await writeFile(join(partial, 'laya.onnx'), 'abc');
        const origin = scriptedLayaOrigin([
          reply,
          { status: 200, headers: { 'Content-Length': '6' }, body: Buffer.from('abcdef') },
        ]);
        await downloader(root, origin, files).download(downloadOptions());
        assert.doesNotMatch(origin.journal[1]?.request ?? '', /\r\nRange:/u);
      });
    });
  }
});

test('E2 laya model download: refuses insufficient free space before a request', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const origin = scriptedLayaOrigin([]);
    const instance = downloader(root, origin, await testFiles());
    await assert.rejects(
      () => instance.download(downloadOptions({ freeBytes: async () => 0 })),
      (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'DISK_SPACE',
    );
    assert.equal(origin.journal.length, 0);
  });
});

test('E2 laya model download: cleans partial data when disable aborts it', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const partial = join(root, 'models', `${modelId}.partial`);
    await mkdir(partial, { recursive: true });
    await writeFile(join(partial, 'laya.onnx'), 'abc');
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => downloader(root, scriptedLayaOrigin([]), files).download({ signal: controller.signal }));
    await assert.rejects(() => lstat(partial), { code: 'ENOENT' });
  });
});

test('E2 laya model download: cancels a stalled sealed peer and removes its partial tree', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const partial = join(root, 'models', `${modelId}.partial`);
    const origin = stalledLayaOrigin();
    const controller = new AbortController();
    const pending = downloader(root, origin, files).download({ signal: controller.signal });
    try {
      for (let attempts = 0; origin.journal.length === 0 && attempts < 80; attempts += 1)
        await new Promise((resolve) => setTimeout(resolve, 1));
      assert.equal(origin.journal.length, 1, 'the sealed peer accepted the model request');
      controller.abort();
      await assert.rejects(
        () => settlesWithin(pending, 80),
        (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'CANCELLED',
      );
      assert.equal(origin.destroyed(), true, 'cancellation must destroy the sealed peer');
      await assert.rejects(() => lstat(partial), { code: 'ENOENT' });
    } finally {
      origin.forceDestroy();
      await Promise.allSettled([pending]);
    }
  });
});

test('E2 laya model download: fails and removes a bad partial after five bad byte attempts', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const origin = scriptedLayaOrigin(
      Array.from({ length: 5 }, () => ({
        status: 200,
        headers: { 'Content-Length': '6' },
        body: Buffer.from('broken'),
      })),
    );
    await assert.rejects(
      () => downloader(root, origin, files).download(downloadOptions()),
      (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'DOWNLOAD_FAILED',
    );
    assert.equal(origin.journal.length, 5);
    await assert.rejects(() => lstat(join(root, 'models', `${modelId}.partial`)), { code: 'ENOENT' });
  });
});

test('E2 laya model download: rechecks its final lifecycle fence before promotion', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    let checks = 0;
    const fence = {
      async assertCurrent(stage: string) {
        checks += 1;
        if (stage === 'promotion') throw new Error('the claimed enablement was revoked');
      },
      async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
        return work();
      },
    };
    const origin = scriptedLayaOrigin([
      { status: 200, headers: { 'Content-Length': '6' }, body: Buffer.from('abcdef') },
    ]);
    await assert.rejects(() => downloader(root, origin, files, fence).download(downloadOptions()), /revoked/);
    assert.ok(checks > 0);
    await assert.rejects(() => lstat(join(root, 'models', modelId)), { code: 'ENOENT' });
  });
});

test('E2 laya model download: requires the lifecycle fence before any artifact action', TEST_TIMEOUT, async () => {
  await temporary(async (root) => {
    const files = [file('laya.onnx', 'abcdef')];
    const origin = scriptedLayaOrigin([]);
    const manifest = {
      manifestId: modelId,
      files: files.map(({ bytes: _bytes, ...expected }) => expected),
    };
    const fetcher = new LayaArtifactFetcher({
      manifest: { ...manifest, source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision } },
      runtimePackages: [],
      resolver: resolverFor('8.8.8.8'),
      tcpConnect: origin.tcpConnect,
      tlsConnect: origin.tlsConnect,
    });
    assert.throws(
      () => new LayaModelDownloader({ dataDirectory: root, manifest, fetcher } as never),
      (error: unknown) => error instanceof LayaModelDownloadError && error.code === 'LIFECYCLE_FENCE',
    );
    await assert.rejects(() => lstat(join(root, 'models')), { code: 'ENOENT' });
    assert.equal(origin.journal.length, 0);
  });
});

test(
  'E2 laya model download: disable landing after its check cannot leave a promoted model',
  TEST_TIMEOUT,
  async () => {
    await temporary(async (root) => {
      const files = [file('laya.onnx', 'abcdef')];
      const origin = scriptedLayaOrigin([
        { status: 200, headers: { 'Content-Length': '6' }, body: Buffer.from('abcdef') },
      ]);
      let enabled = true;
      let locked = false;
      let promotionChecked!: () => void;
      let releasePromotion!: () => void;
      let unlocked!: () => void;
      let disableBlocked!: () => void;
      let disableFinished!: () => void;
      const checked = new Promise<void>((resolve) => {
        promotionChecked = resolve;
      });
      const continuePromotion = new Promise<void>((resolve) => {
        releasePromotion = resolve;
      });
      const released = new Promise<void>((resolve) => {
        unlocked = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        disableBlocked = resolve;
      });
      const disabled = new Promise<void>((resolve) => {
        disableFinished = resolve;
      });
      const fence = {
        async assertCurrent(stage: string) {
          if (!enabled) throw new Error('the claimed enablement was revoked');
          if (stage === 'promotion') {
            promotionChecked();
            await continuePromotion;
          }
        },
        async withArtifactLock<T>(work: () => Promise<T>): Promise<T> {
          locked = true;
          try {
            return await work();
          } finally {
            locked = false;
            unlocked();
          }
        },
        async disable(): Promise<void> {
          if (locked) {
            disableBlocked();
            await released;
          }
          enabled = false;
          await rm(join(root, 'models', modelId), { recursive: true, force: true });
          disableFinished();
        },
      };
      const install = downloader(root, origin, files, fence).download(downloadOptions());
      await checked;
      const disable = fence.disable();
      try {
        const state = await Promise.race([
          blocked.then(() => 'blocked' as const),
          disabled.then(() => 'removed' as const),
        ]);
        assert.equal(state, 'blocked', 'disable must wait for the promotion critical section');
        releasePromotion();
        await install;
        await disable;
        await assert.rejects(() => lstat(join(root, 'models', modelId)), { code: 'ENOENT' });
      } finally {
        releasePromotion();
        await Promise.allSettled([install, disable]);
      }
    });
  },
);
