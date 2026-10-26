import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  canonicalJudge,
  JEV_PROVIDER_ROUTES,
  OPENROUTER_SYSTEM_ONE_ENDPOINT,
  TYPESAFE_SYSTEM_ONE_ENDPOINT,
} from '../src/domain/judges.ts';
import { preparePinnedConnection } from '../src/network/pinned-connection.ts';
import { JudgeTransport, prepareJudgeTransportRequest } from '../src/runtime/judge-transport.ts';

assertLoopbackSeal();

/** Jev through OpenRouter (owner decision 2026-10-26): the provider sets the endpoint and the one approved model. */
function openRouterJev(overrides: Record<string, unknown> = {}) {
  return {
    judgeId: 'jev',
    version: 2,
    kind: 'typesafe',
    provider: 'openrouter',
    model: 'typesafe/jev-1.14',
    endpoint: 'https://openrouter.ai/api/v1/systemone',
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul',
    ...overrides,
  };
}

function nativeJev() {
  return {
    judgeId: 'jev',
    version: 1,
    kind: 'typesafe',
    provider: 'typesafe',
    model: 'jev-1.13.0',
    endpoint: 'https://api.typesafe.ai/v1/systemone',
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul',
  };
}

test('Jev provider: OpenRouter fixes its endpoint and concrete model; TypeSafe’s own document is unchanged', () => {
  assert.deepEqual(canonicalJudge(openRouterJev()), openRouterJev());
  assert.deepEqual(canonicalJudge(nativeJev()), nativeJev(), 'a native Jev document keeps its exact canonical form');
  assert.deepEqual(JEV_PROVIDER_ROUTES.openrouter, {
    endpoint: OPENROUTER_SYSTEM_ONE_ENDPOINT,
    model: 'typesafe/jev-1.14',
    name: 'OpenRouter',
  });
  assert.deepEqual(JEV_PROVIDER_ROUTES.typesafe, {
    endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT,
    model: 'jev-1.13.0',
    name: 'TypeSafe',
  });
  for (const [what, overrides] of [
    ['a moving alias', { model: '~typesafe/jev-latest' }],
    ['an older model OpenRouter lists', { model: 'typesafe/jev-1.13' }],
    ["TypeSafe's native model id", { model: 'jev-1.13.0' }],
    ['another endpoint', { endpoint: 'https://openrouter.ai/api/v1/chat/completions' }],
    ["TypeSafe's endpoint", { endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT }],
    ['another protocol', { protocol: 'json-score' }],
    ['an unknown provider', { provider: 'someone-else' }],
  ] as const)
    assert.throws(() => canonicalJudge(openRouterJev(overrides)), /judge/u, `refuses ${what}`);
  assert.throws(
    () => canonicalJudge({ ...nativeJev(), endpoint: OPENROUTER_SYSTEM_ONE_ENDPOINT }),
    /fixed System One endpoint/u,
    'a native Jev document cannot borrow the OpenRouter endpoint',
  );
});

test('Jev provider: the hosted network check admits exactly OpenRouter’s System One URL, and still refuses any other', async () => {
  let lookups = 0;
  const resolver = {
    async lookup(hostname: string) {
      lookups += 1;
      assert.equal(hostname, 'openrouter.ai');
      return ['8.8.8.8'];
    },
  };
  const connection = await preparePinnedConnection({
    url: OPENROUTER_SYSTEM_ONE_ENDPOINT,
    addressMode: 'global-only',
    resolver,
  });
  assert.equal(connection.hostname, 'openrouter.ai');
  assert.equal(connection.useTls, true);
  assert.equal(connection.tls.certificateHost, 'openrouter.ai');
  assert.equal(lookups, 1);
  for (const url of [
    'https://openrouter.ai/api/v1/chat/completions',
    'https://openrouter.ai:8443/api/v1/systemone',
    'https://evil.openrouter.ai/api/v1/systemone',
    'https://openrouter.ai.example/api/v1/systemone',
    'http://openrouter.ai/api/v1/systemone',
    'https://receiver.example.test/hook',
  ])
    await assert.rejects(
      () => preparePinnedConnection({ url, addressMode: 'global-only', resolver }),
      /global-only/u,
      url,
    );
  assert.equal(lookups, 1, 'a refused hosted URL is refused before DNS');
});

test('Jev provider: an OpenRouter judge sends the same System One request to OpenRouter, with its key as a Bearer token', async () => {
  const call = {
    judge: openRouterJev() as Parameters<typeof prepareJudgeTransportRequest>[0]['judge'],
    state: '{"kind":"synthetic","version":1}',
    questionName: 'judge',
    instructions: 'Determine whether this synthetic event needs review.',
    maxInputTokens: 4096,
    maxOutputTokens: 8,
    hostedApiKey: { generation: 1, material: 'fake-key' },
  };
  const prepared = prepareJudgeTransportRequest(call);
  assert.ok(!('kind' in prepared), 'an OpenRouter judge is prepared');
  assert.equal(prepared.adapter, 'typesafe', 'OpenRouter serves Jev through the hosted System One adapter');
  assert.equal(prepared.endpoint.href, OPENROUTER_SYSTEM_ONE_ENDPOINT);
  const request = prepared.request.toString('utf8');
  assert.match(request, /^POST \/api\/v1\/systemone HTTP\/1\.1\r\n/u);
  assert.match(request, /\r\nHost: openrouter\.ai\r\n/u);
  assert.match(request, /\r\nAuthorization: Bearer fake-key\r\n/u);
  assert.equal(
    JSON.parse(prepared.body.toString('utf8')).model,
    'typesafe/jev-1.14',
    'the body names the approved OpenRouter model',
  );

  // The whole transport reaches only the pinned OpenRouter address, verifies its certificate as openrouter.ai and
  // reads Jev's answer as it does TypeSafe's own.
  const writes: Buffer[] = [];
  const tlsOptions: unknown[] = [];
  const response =
    '{"answers":{"judge":{"noul":0.75,"type":"noul"}},"model":"typesafe/jev-1.14","usage":{"input_tokens":11,"output_tokens":3}}';
  const listeners = new Map<string, (value?: Buffer) => void>();
  const socket = {
    write(bytes: Uint8Array) {
      writes.push(Buffer.from(bytes));
      queueMicrotask(() => {
        listeners.get('data')?.(Buffer.from(`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${response}`));
        listeners.get('end')?.();
      });
      return true;
    },
    destroy() {},
    once(event: string, listener: (value?: Buffer) => void) {
      listeners.set(event, listener);
      return this;
    },
    on(event: string, listener: (value?: Buffer) => void) {
      listeners.set(event, listener);
      return this;
    },
  };
  const tcpHosts: string[] = [];
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async (options) => {
      tcpHosts.push(`${options.host}:${options.port}`);
      return {} as never;
    },
    tlsConnect: async (options) => {
      tlsOptions.push({ certificateHost: options.certificateHost, servername: options.servername });
      return socket as never;
    },
  });
  const result = await transport.execute(call, { finalGate() {} });
  assert.deepEqual(result, {
    kind: 'answer',
    value: 0.75,
    valueLabel: 'probability',
    usage: { inputTokens: 11, outputTokens: 3 },
  });
  assert.deepEqual(tcpHosts, ['8.8.8.8:443']);
  assert.deepEqual(tlsOptions, [{ certificateHost: 'openrouter.ai', servername: 'openrouter.ai' }]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0]?.toString('utf8'), request);

  // A document that drifts from the route is blocked before any byte is prepared.
  for (const judge of [
    { ...openRouterJev(), endpoint: TYPESAFE_SYSTEM_ONE_ENDPOINT },
    { ...openRouterJev(), model: '~typesafe/jev-latest' },
  ])
    assert.deepEqual(prepareJudgeTransportRequest({ ...call, judge: judge as never }), {
      kind: 'refused',
      code: 'ADAPTER_REFERENCE_BLOCKED',
      preIo: true,
    });
});
