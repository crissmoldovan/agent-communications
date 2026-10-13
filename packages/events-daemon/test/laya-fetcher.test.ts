import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import { resolverFor, scriptedLayaOrigin, stalledLayaOrigin } from './support/laya-origin.ts';

assertLoopbackSeal();

const { LayaArtifactFetcher, LayaFetchError, assertLayaRequestHeaders } = await import(
  '../src/runtime/laya/fetcher.ts'
);

const revision = 'a'.repeat(40);
const runtimeBytes = Buffer.from('tiny synthetic runtime archive');

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sri(bytes: Uint8Array): string {
  return `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
}

function manifestFile(path = 'laya.onnx', bytes = Buffer.from('tiny synthetic model')) {
  return { path, size: bytes.byteLength, sha256: sha256(bytes) };
}

function sourceUrl(path: string): string {
  return `https:${'//'}huggingface.co/receptron/laya-onnx/resolve/${revision}/${path}`;
}

function httpsUrl(host: string, path: string): string {
  return `https:${'//'}${host}${path}`;
}

type FetchOrigin = Pick<ReturnType<typeof scriptedLayaOrigin>, 'tcpConnect' | 'tlsConnect'>;

function fetcher(
  origin: FetchOrigin,
  options: {
    readonly answers?: readonly string[];
    readonly idleTimeoutMs?: number;
    readonly totalTimeoutMs?: number;
  } = {},
) {
  return new LayaArtifactFetcher({
    manifest: { source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision }, files: [] },
    runtimePackages: [
      {
        name: '@tiny/runtime',
        version: '1.0.0',
        url: httpsUrl('registry.npmjs.org', '/@tiny/runtime/-/runtime-1.0.0.tgz'),
        integrity: sri(runtimeBytes),
      },
    ],
    resolver: resolverFor(...(options.answers ?? ['8.8.8.8'])),
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
    idleTimeoutMs: options.idleTimeoutMs,
    totalTimeoutMs: options.totalTimeoutMs,
  });
}

function signal(): AbortSignal {
  return new AbortController().signal;
}

async function settlesWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`fetch did not settle within ${milliseconds}ms`)), milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

test('E2 fetcher: accepts only the reviewed registry tarball URL and matching SRI', async () => {
  const origin = scriptedLayaOrigin([
    { status: 200, headers: { 'Content-Length': String(runtimeBytes.length) }, body: runtimeBytes },
  ]);
  const received = await fetcher(origin).fetchRuntimeArchive(
    { name: '@tiny/runtime', version: '1.0.0' },
    { signal: signal() },
  );
  assert.deepEqual(received, runtimeBytes);
  assert.equal(origin.journal.length, 1);
  assert.match(
    origin.journal[0]?.request ?? '',
    /^GET \/@tiny\/runtime\/-\/runtime-1\.0\.0\.tgz HTTP\/1\.1\r\nHost: registry\.npmjs\.org\r\nConnection: close\r\nUser-Agent: agentcomms-events\/[\d.]+\r\n\r\n$/u,
  );
});

test('E2 fetcher: refuses a runtime redirect before another request', async () => {
  const origin = scriptedLayaOrigin([
    { status: 302, headers: { Location: httpsUrl('registry.npmjs.org', '/@tiny/runtime/-/runtime-1.0.0.tgz') } },
    { status: 200, headers: { 'Content-Length': String(runtimeBytes.length) }, body: runtimeBytes },
  ]);
  await assert.rejects(
    () => fetcher(origin).fetchRuntimeArchive({ name: '@tiny/runtime', version: '1.0.0' }, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'REDIRECT',
  );
  assert.equal(origin.journal.length, 1, 'the literal registry request must not follow a redirect');
});

test('E2 fetcher: refuses a non-registry runtime URL before a request', async () => {
  const origin = scriptedLayaOrigin([]);
  const unsafe = new LayaArtifactFetcher({
    manifest: { source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision }, files: [] },
    runtimePackages: [
      { name: '@tiny/runtime', version: '1.0.0', url: sourceUrl('runtime.tgz'), integrity: sri(runtimeBytes) },
    ],
    resolver: resolverFor('8.8.8.8'),
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
  });
  await assert.rejects(
    () => unsafe.fetchRuntimeArchive({ name: '@tiny/runtime', version: '1.0.0' }, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'RUNTIME_ORIGIN',
  );
  assert.equal(origin.journal.length, 0);
});

test('E2 fetcher: rejects altered runtime bytes against the exact SRI', async () => {
  const origin = scriptedLayaOrigin([
    { status: 200, headers: { 'Content-Length': '7' }, body: Buffer.from('altered') },
  ]);
  await assert.rejects(
    () => fetcher(origin).fetchRuntimeArchive({ name: '@tiny/runtime', version: '1.0.0' }, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'RUNTIME_INTEGRITY',
  );
});

test('E2 fetcher: aborts a sealed peer that sends no bytes at idle deadline', async () => {
  const origin = stalledLayaOrigin();
  const controller = new AbortController();
  const instance = fetcher(origin, { idleTimeoutMs: 15, totalTimeoutMs: 80 });
  try {
    await assert.rejects(
      () =>
        settlesWithin(
          instance.fetchModelFile(manifestFile('laya.onnx', Buffer.alloc(128)), undefined, {
            signal: controller.signal,
          }),
          160,
        ),
      (error: unknown) => error instanceof LayaFetchError && error.code === 'IDLE_TIMEOUT',
    );
    assert.equal(origin.journal.length, 1);
    assert.equal(origin.destroyed(), true, 'the idle deadline must destroy the sealed peer');
  } finally {
    origin.forceDestroy();
  }
});

test('E2 fetcher: aborts a responding peer at total deadline', async () => {
  const origin = stalledLayaOrigin({ heartbeatMs: 3 });
  const instance = fetcher(origin, { idleTimeoutMs: 30, totalTimeoutMs: 45 });
  try {
    await assert.rejects(
      () =>
        settlesWithin(
          instance.fetchModelFile(manifestFile('laya.onnx', Buffer.alloc(256)), undefined, { signal: signal() }),
          160,
        ),
      (error: unknown) => error instanceof LayaFetchError && error.code === 'TOTAL_TIMEOUT',
    );
    assert.equal(origin.journal.length, 1);
    assert.equal(origin.destroyed(), true, 'the total deadline must destroy the sealed peer');
  } finally {
    origin.forceDestroy();
  }
});

test('E2 fetcher: abort signal destroys a stalled sealed peer with a typed result', async () => {
  const origin = stalledLayaOrigin();
  const controller = new AbortController();
  const instance = fetcher(origin, { idleTimeoutMs: 80, totalTimeoutMs: 160 });
  const request = instance.fetchModelFile(manifestFile('laya.onnx', Buffer.alloc(128)), undefined, {
    signal: controller.signal,
  });
  try {
    while (origin.journal.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    controller.abort();
    await assert.rejects(
      () => settlesWithin(request, 80),
      (error: unknown) => error instanceof LayaFetchError && error.code === 'ABORTED',
    );
    assert.equal(origin.destroyed(), true, 'cancellation must destroy the peer immediately');
  } finally {
    origin.forceDestroy();
  }
});

test('E2 fetcher: total deadline reaches the TCP connector before it opens', async () => {
  let sawConnectDeadline = false;
  const origin: FetchOrigin = {
    tcpConnect: async (options) =>
      new Promise<import('node:net').Socket>((_resolve, reject) => {
        const signal = (
          options as import('../src/network/pinned-connection.ts').PinnedTcpOptions & {
            readonly signal?: AbortSignal;
          }
        ).signal;
        signal?.addEventListener(
          'abort',
          () => {
            sawConnectDeadline = true;
            reject(signal.reason instanceof Error ? signal.reason : new Error('TCP connect aborted'));
          },
          { once: true },
        );
      }),
    tlsConnect: async () => {
      throw new Error('TLS must not start before the TCP connector opens');
    },
  };
  await assert.rejects(
    () =>
      settlesWithin(
        fetcher(origin, { totalTimeoutMs: 20 }).fetchModelFile(
          manifestFile('laya.onnx', Buffer.alloc(128)),
          undefined,
          {
            signal: signal(),
          },
        ),
        80,
      ),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'TOTAL_TIMEOUT',
  );
  assert.equal(sawConnectDeadline, true, 'the TCP connector must receive the request-wide deadline signal');
});

test('E2 fetcher: refuses an optional request header before network I/O', () => {
  assert.throws(
    () => assertLayaRequestHeaders({ Cookie: 'synthetic' }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'REQUEST_HEADER',
  );
});

test('E2 fetcher: refuses a short manifest revision before a request', async () => {
  const origin = scriptedLayaOrigin([]);
  const instance = new LayaArtifactFetcher({
    manifest: {
      source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision: revision.slice(1) },
      files: [],
    },
    runtimePackages: [],
    resolver: resolverFor('8.8.8.8'),
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
  });
  await assert.rejects(
    () => instance.fetchModelFile(manifestFile(), undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'HTTP_RESPONSE',
  );
  assert.equal(origin.journal.length, 0);
});

test('E2 fetcher: accepts an unpinned CDN redirect only after the manifest byte hash verifies', async () => {
  const bytes = Buffer.from('verified CDN model bytes');
  const file = manifestFile('laya.onnx', bytes);
  const origin = scriptedLayaOrigin([
    { status: 302, headers: { Location: `https:${'//'}cdn.example.test/signed/synthetic` } },
    { status: 200, headers: { 'Content-Length': String(bytes.length), Etag: 'not-a-content-hash' }, body: bytes },
  ]);
  const received = await fetcher(origin).fetchModelFile(file, undefined, { signal: signal() });
  assert.deepEqual(received.bytes, bytes);
  assert.equal(received.url, `https:${'//'}cdn.example.test/signed/synthetic`);
  assert.equal(origin.journal.length, 2);
});

test('E2 fetcher: refuses a private redirect target before connecting', async () => {
  const file = manifestFile();
  const origin = scriptedLayaOrigin([{ status: 302, headers: { Location: `https:${'//'}private.example.test/file` } }]);
  const instance = new LayaArtifactFetcher({
    manifest: { source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision }, files: [] },
    runtimePackages: [],
    resolver: { lookup: async (host: string) => (host === 'private.example.test' ? ['10.0.0.1'] : ['8.8.8.8']) },
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
  });
  await assert.rejects(
    () => instance.fetchModelFile(file, undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'ADDRESS',
  );
  assert.equal(origin.journal.length, 1);
});

test('E2 fetcher: rejects DNS drift before the pinned connection opens', async () => {
  const origin = scriptedLayaOrigin([]);
  let calls = 0;
  const instance = new LayaArtifactFetcher({
    manifest: { source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision }, files: [] },
    runtimePackages: [],
    resolver: { lookup: async () => (calls++ === 0 ? ['8.8.8.8'] : ['9.9.9.9']) },
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
  });
  await assert.rejects(
    () => instance.fetchModelFile(manifestFile(), undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'ADDRESS',
  );
  assert.equal(origin.journal.length, 0);
});

test('E2 fetcher: refuses the sixth redirect hop', async () => {
  const file = manifestFile();
  const origin = scriptedLayaOrigin(
    Array.from({ length: 6 }, (_, index) => ({
      status: 302,
      headers: { Location: `https:${'//'}cdn.example.test/${index}` },
    })),
  );
  await assert.rejects(
    () => fetcher(origin).fetchModelFile(file, undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'REDIRECT_LIMIT',
  );
  assert.equal(origin.journal.length, 6);
});

test('E2 fetcher: refuses a bounded response header overflow', async () => {
  const file = manifestFile();
  const origin = scriptedLayaOrigin([
    { status: 200, headers: { 'X-Synthetic': 'x'.repeat(512) }, body: Buffer.alloc(0) },
  ]);
  const instance = new LayaArtifactFetcher({
    manifest: { source: { host: 'huggingface.co', repo: 'receptron/laya-onnx', revision }, files: [] },
    runtimePackages: [],
    resolver: resolverFor('8.8.8.8'),
    tcpConnect: origin.tcpConnect,
    tlsConnect: origin.tlsConnect,
    maxResponseHeaderBytes: 128,
  });
  await assert.rejects(
    () => instance.fetchModelFile(file, undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'RESPONSE_HEADERS',
  );
});

test('E2 fetcher: abandons bytes above the reviewed model size', async () => {
  const file = manifestFile('laya.onnx', Buffer.from('tiny'));
  const origin = scriptedLayaOrigin([{ status: 200, headers: { 'Content-Length': '5' }, body: Buffer.from('overs') }]);
  await assert.rejects(
    () => fetcher(origin).fetchModelFile(file, undefined, { signal: signal() }),
    (error: unknown) => error instanceof LayaFetchError && error.code === 'RESPONSE_BODY',
  );
});
