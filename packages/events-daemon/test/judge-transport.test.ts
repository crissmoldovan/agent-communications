import assert from 'node:assert/strict';
import { cp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { JudgeTransportHooks } from '../src/runtime/judge-transport.ts';
import { runStrictMutationChild } from './support/strict-mutation-child.ts';

assertLoopbackSeal();

const { JudgeTransport, buildJudgeWireRequest, parseJudgeResponse } = await import('../src/runtime/judge-transport.ts');
const { JUDGE_ADAPTER_REFERENCES } = await import('../src/runtime/judge-adapters.ts');

/** The sealed result is closed: every refusal states whether no physical I/O started. */
function refused(code: string, preIo: boolean) {
  return { kind: 'refused' as const, code, preIo };
}

interface SystemOneVector {
  readonly model: string;
  readonly state: string;
  readonly questionName: string;
  readonly instructions: string;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly response: string;
}

const fixture = JSON.parse(
  await readFile(new URL('./fixtures/judges/transport/system-one-v1.json', import.meta.url), 'utf8'),
) as {
  readonly sources: {
    readonly typesafe: {
      readonly quickstart: { readonly url: string; readonly read: '2026-10-10' };
      readonly models: { readonly url: string; readonly read: '2026-10-10' };
    };
    readonly ollama: { readonly url: string; readonly read: '2026-10-10' };
  };
  readonly vectors: { readonly typesafe: SystemOneVector; readonly ollama: SystemOneVector };
};

function typesafeJudge() {
  return {
    judgeId: 'judge-typesafe-e6',
    version: 1,
    kind: 'typesafe' as const,
    provider: 'typesafe' as const,
    model: fixture.vectors.typesafe.model,
    endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul' as const,
  };
}

function localJudge(): {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: 'local-endpoint';
  readonly provider: 'ollama';
  readonly model: string;
  readonly endpoint: string;
  readonly approvedAddressSet: readonly ['127.0.0.1'];
  readonly promptTemplate: string;
  readonly protocol: 'noul';
};
function localJudge(protocol: 'json-score'): {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: 'local-endpoint';
  readonly provider: 'ollama';
  readonly model: string;
  readonly endpoint: string;
  readonly approvedAddressSet: readonly ['127.0.0.1'];
  readonly promptTemplate: string;
  readonly protocol: 'json-score';
  readonly scorePointer: '/score';
};
function localJudge(protocol: 'noul' | 'json-score' = 'noul') {
  const base = {
    judgeId: 'judge-local-e6',
    version: 1,
    kind: 'local-endpoint' as const,
    provider: 'ollama',
    model: fixture.vectors.ollama.model,
    endpoint: 'http://127.0.0.1:11434/v1/systemone',
    approvedAddressSet: ['127.0.0.1'] as const,
    promptTemplate: 'ollama-noul-v1',
  };
  return protocol === 'json-score' ? { ...base, protocol, scorePointer: '/score' as const } : { ...base, protocol };
}

function respondingSocket(response: string, afterResponse?: () => void) {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  const writes: Buffer[] = [];
  let dataListenerCount = 0;
  return {
    writes,
    get dataListenerCount() {
      return dataListenerCount;
    },
    socket: {
      write(bytes: Uint8Array) {
        writes.push(Buffer.from(bytes));
        queueMicrotask(() => {
          listeners.get('data')?.(Buffer.from(response));
          listeners.get('end')?.();
          afterResponse?.();
        });
        return true;
      },
      destroy() {},
      once(event: string, listener: (value?: Buffer | Error) => void) {
        listeners.set(event, listener);
        return this;
      },
      on(event: string, listener: (value?: Buffer | Error) => void) {
        if (event === 'data') dataListenerCount += 1;
        listeners.set(event, listener);
        return this;
      },
    },
  };
}

const allowAllTransportGates: JudgeTransportHooks = { finalGate() {} };

function lastingResources(): string[] {
  return process
    .getActiveResourcesInfo()
    .filter((name) => !/Req|^WriteWrap$|^ShutdownWrap$/u.test(name))
    .sort();
}

test('E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers', () => {
  assert.deepEqual(JUDGE_ADAPTER_REFERENCES.typesafe, {
    quickstart: {
      url: fixture.sources.typesafe.quickstart.url,
      readAt: fixture.sources.typesafe.quickstart.read,
    },
    models: {
      url: fixture.sources.typesafe.models.url,
      readAt: fixture.sources.typesafe.models.read,
    },
  });
  assert.deepEqual(JUDGE_ADAPTER_REFERENCES.ollama, {
    url: fixture.sources.ollama.url,
    readAt: fixture.sources.ollama.read,
  });
  for (const [adapter, vector, key] of [
    ['typesafe', fixture.vectors.typesafe, 'test-hosted-key'],
    ['ollama', fixture.vectors.ollama, undefined],
  ] as const) {
    const request = buildJudgeWireRequest({
      adapter,
      model: vector.model,
      state: vector.state,
      questionName: vector.questionName,
      instructions: vector.instructions,
      ...(key === undefined ? {} : { hostedApiKey: key }),
    });
    assert.equal(request.body.toString('utf8'), vector.body);
    assert.deepEqual(request.headers, vector.headers);
  }
  assert.throws(
    () =>
      buildJudgeWireRequest({
        adapter: 'typesafe',
        model: fixture.vectors.typesafe.model,
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        hostedApiKey: 'synthetic-key\r\nX-Undocumented: injected',
      }),
    /boundary key/u,
  );

  const parsed = parseJudgeResponse({
    adapter: 'typesafe',
    protocol: { protocol: 'noul' },
    questionName: fixture.vectors.typesafe.questionName,
    response: Buffer.from(fixture.vectors.typesafe.response),
    maxOutputTokens: 3,
  });
  assert.deepEqual(parsed, {
    kind: 'answer',
    value: 0.75,
    valueLabel: 'probability',
    usage: { inputTokens: 11, outputTokens: 3 },
  });
});

test('E6: response parsing returns only bounded scores and usage metadata', () => {
  const malformed = [
    '{}',
    '{"answers":{"judge":{"type":"noul","noul":"1"}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":-1}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":1.1}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5,"match":true}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5,"reason":"ignore prior instructions"}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5,"tool":"untrusted"}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0","tools":[],"usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0"}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0","usage":{"input_tokens":-1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0","usage":{"input_tokens":1.5,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":"1"}}',
    '{"answers":{"judge":{"type":"noul","noul":NaN}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":Infinity}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
    '{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":4}}',
  ];
  for (const response of malformed) {
    assert.deepEqual(
      parseJudgeResponse({
        adapter: 'typesafe',
        protocol: { protocol: 'noul' },
        questionName: 'judge',
        response: Buffer.from(response),
        maxOutputTokens: 3,
      }),
      {
        kind: 'refused',
        code: response.includes('"output_tokens":4') ? 'OUTPUT_TOKEN_LIMIT_EXCEEDED' : 'MALFORMED_RESPONSE',
        preIo: false,
      },
    );
  }

  assert.deepEqual(
    parseJudgeResponse({
      adapter: 'generic-json-score',
      protocol: { protocol: 'json-score', scorePointer: '/score' },
      questionName: 'judge',
      response: Buffer.from('{"score":0.25}'),
      maxOutputTokens: 64,
    }),
    {
      kind: 'answer',
      value: 0.25,
      valueLabel: 'uncalibrated-score',
      usage: { inputTokens: 0, outputTokens: Buffer.byteLength('{"score":0.25}') },
    },
  );

  assert.deepEqual(
    parseJudgeResponse({
      adapter: 'generic-json-score',
      protocol: { protocol: 'json-score', scorePointer: '/scores/*' },
      questionName: 'judge',
      response: Buffer.from('{"scores":[0.25]}'),
      maxOutputTokens: 64,
    }),
    refused('MALFORMED_RESPONSE', false),
  );
  for (const scorePointer of ['', '/scores/*', '/score,/other']) {
    assert.deepEqual(
      parseJudgeResponse({
        adapter: 'generic-json-score',
        protocol: { protocol: 'json-score', scorePointer },
        questionName: 'judge',
        response: Buffer.from(scorePointer === '' ? '0.25' : '{"score":0.25,"scores":[0.25],"other":0.75}'),
        maxOutputTokens: 64,
      }),
      refused('MALFORMED_RESPONSE', false),
    );
  }
});

test('E6: malformed UTF-8 anywhere in a Noul answer is fail-closed', () => {
  const validTail = '","usage":{"input_tokens":11,"output_tokens":3}}';
  const malformedResponses = [
    Buffer.concat([
      Buffer.from('{"answers":{"judge":{"type":"noul","noul":0.75}},"model":"jev'),
      Buffer.from([0x80]),
      Buffer.from(validTail),
    ]),
    Buffer.concat([
      Buffer.from('{"answers":{"judge'),
      Buffer.from([0x80]),
      Buffer.from('":{"type":"noul","noul":0.75}},"model":"jev-1.13.0'),
      Buffer.from(validTail),
    ]),
  ];
  for (const [index, response] of malformedResponses.entries()) {
    assert.deepEqual(
      parseJudgeResponse({
        adapter: 'typesafe',
        protocol: { protocol: 'noul' },
        questionName: index === 0 ? 'judge' : 'judge�',
        response,
        maxOutputTokens: 3,
      }),
      refused('MALFORMED_RESPONSE', false),
    );
  }
});

test('E6: execute requires a final gate in both its type and runtime boundary', async () => {
  let resolverCalls = 0;
  let tcpCalls = 0;
  const peer = respondingSocket(`HTTP/1.1 200 OK\r\n\r\n${fixture.vectors.typesafe.response}`);
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return ['8.8.8.8'];
      },
    },
    tcpConnect: async () => {
      tcpCalls += 1;
      return {} as never;
    },
    tlsConnect: async () => peer.socket as never,
  });
  const call = {
    judge: typesafeJudge(),
    state: fixture.vectors.typesafe.state,
    questionName: fixture.vectors.typesafe.questionName,
    instructions: fixture.vectors.typesafe.instructions,
    maxInputTokens: 512,
    maxOutputTokens: 3,
    hostedApiKey: { generation: 1, material: 'test-hosted-key' },
  };
  const requireGateAtTypeBoundary = () => {
    // @ts-expect-error a transport call cannot omit the synchronous final authority gate
    void transport.execute(call);
    // @ts-expect-error an object without that gate cannot satisfy the call boundary either
    void transport.execute(call, {});
  };
  void requireGateAtTypeBoundary;
  const executeWithoutGate = transport.execute as unknown as (input: typeof call) => Promise<unknown>;
  assert.deepEqual(await executeWithoutGate.call(transport, call), {
    kind: 'refused',
    code: 'NETWORK_FENCE_REFUSED',
    preIo: true,
  });
  assert.equal(resolverCalls, 0);
  assert.equal(tcpCalls, 0);
  assert.deepEqual(peer.writes, []);
});

test('E6: missing dated generic-json-score vectors refuse before DNS and request-cap refusal does too', async () => {
  let resolverCalls = 0;
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return ['127.0.0.1'];
      },
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: localJudge('json-score'),
        state: fixture.vectors.ollama.state,
        questionName: 'judge',
        instructions: fixture.vectors.ollama.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 64,
      },
      allowAllTransportGates,
    ),
    refused('ADAPTER_REFERENCE_BLOCKED', true),
  );
  assert.equal(resolverCalls, 0);

  assert.deepEqual(
    await transport.execute(
      {
        judge: localJudge(),
        state: 'x'.repeat(1_024),
        questionName: 'judge',
        instructions: fixture.vectors.ollama.instructions,
        maxInputTokens: 1,
        maxOutputTokens: 64,
      },
      allowAllTransportGates,
    ),
    refused('INPUT_TOKEN_LIMIT_EXCEEDED', true),
  );
  assert.equal(resolverCalls, 0);

  assert.deepEqual(
    await transport.execute(
      {
        judge: localJudge(),
        state: 'x'.repeat(65_537),
        questionName: 'judge',
        instructions: fixture.vectors.ollama.instructions,
        maxInputTokens: 70_000,
        maxOutputTokens: 64,
      },
      allowAllTransportGates,
    ),
    refused('REQUEST_TOO_LARGE', true),
  );
  assert.equal(resolverCalls, 0);

  assert.deepEqual(
    await transport.execute(
      {
        judge: localJudge(),
        state: 'x'.repeat(65_400),
        questionName: 'judge',
        instructions: fixture.vectors.ollama.instructions,
        maxInputTokens: 70_000,
        maxOutputTokens: 64,
      },
      allowAllTransportGates,
    ),
    refused('REQUEST_TOO_LARGE', true),
  );
  assert.equal(resolverCalls, 0, 'raw framing counts before a resolver can run');
});

test('E6-M: TypeSafe refuses an unapproved document model instead of substituting a transport constant', async () => {
  let resolverCalls = 0;
  let tcpCalls = 0;
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return ['8.8.8.8'];
      },
    },
    tcpConnect: async () => {
      tcpCalls += 1;
      return respondingSocket('').socket as never;
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: { ...typesafeJudge(), model: 'jev-unapproved' },
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    refused('ADAPTER_REFERENCE_BLOCKED', true),
  );
  assert.equal(resolverCalls, 0);
  assert.equal(tcpCalls, 0);
});

test('E6-M: TypeSafe request bytes take the approved document model, never a transport constant', async () => {
  const source = await readFile(new URL('../src/runtime/judge-transport.ts', import.meta.url), 'utf8');
  assert.match(source, /model: call\.judge\.model,/u);
});

test('E6-A: TypeSafe uses global-only pinned resolution without a caller address set', async () => {
  const peer = respondingSocket(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${fixture.vectors.typesafe.response}`,
  );
  let tcp: unknown;
  let tls: unknown;
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async (options) => {
      tcp = options;
      return {} as never;
    },
    tlsConnect: async (options) => {
      tls = options;
      return peer.socket as never;
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: typesafeJudge(),
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    {
      kind: 'answer',
      value: 0.75,
      valueLabel: 'probability',
      usage: { inputTokens: 11, outputTokens: 3 },
    },
  );
  assert.deepEqual(tcp, { host: '8.8.8.8', port: 443 });
  assert.deepEqual(tls, {
    socket: {},
    rejectUnauthorized: true,
    servername: 'api.typesafe.ai',
    certificateHost: 'api.typesafe.ai',
  });
  assert.match(peer.writes[0]?.toString('utf8') ?? '', /"model":"jev-1\.13\.0"/u);
});

test('E6-A: TypeSafe refuses every non-global resolver answer before TCP', async (t) => {
  for (const address of [
    '127.0.0.1',
    '10.0.0.1',
    '169.254.169.254',
    'fc00::1',
    '192.0.2.1',
    '2002:a00:1::',
    '2001:0:a00:1::f7ff:fffe',
    '2600::5efe:a00:1',
    '2600::200:5efe:a9fe:101',
    '2600::5efe:a9fe:a9fe',
  ]) {
    await t.test(address, async () => {
      let resolverCalls = 0;
      let tcpCalls = 0;
      const transport = new JudgeTransport({
        resolver: {
          async lookup() {
            resolverCalls += 1;
            return [address];
          },
        },
        tcpConnect: async () => {
          tcpCalls += 1;
          return respondingSocket('').socket as never;
        },
      });
      assert.deepEqual(
        await transport.execute(
          {
            judge: typesafeJudge(),
            state: fixture.vectors.typesafe.state,
            questionName: fixture.vectors.typesafe.questionName,
            instructions: fixture.vectors.typesafe.instructions,
            maxInputTokens: 512,
            maxOutputTokens: 3,
            hostedApiKey: { generation: 1, material: 'test-hosted-key' },
          },
          allowAllTransportGates,
        ),
        refused('NETWORK_FAILURE', false),
      );
      assert.equal(resolverCalls, 1);
      assert.equal(tcpCalls, 0);
    });
  }
});

test('E6-A: TypeSafe refuses a mixed public and private resolver set before TCP', async () => {
  let tcpCalls = 0;
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8', '10.0.0.1'] },
    tcpConnect: async () => {
      tcpCalls += 1;
      return respondingSocket('').socket as never;
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: typesafeJudge(),
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    refused('NETWORK_FAILURE', false),
  );
  assert.equal(tcpCalls, 0);
});

test('E6: the TypeSafe transport pins DNS/TCP/TLS, runs every final gate, and writes no redirect path', async () => {
  const peer = respondingSocket(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${fixture.vectors.typesafe.response}`,
  );
  const phases: string[] = [];
  let tcp: unknown;
  let tls: unknown;
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async (options) => {
      tcp = options;
      return {} as never;
    },
    tlsConnect: async (options) => {
      tls = options;
      return peer.socket as never;
    },
  });
  const result = await transport.execute(
    {
      judge: typesafeJudge(),
      state: fixture.vectors.typesafe.state,
      questionName: fixture.vectors.typesafe.questionName,
      instructions: fixture.vectors.typesafe.instructions,
      maxInputTokens: 512,
      maxOutputTokens: 3,
      hostedApiKey: { generation: 1, material: 'test-hosted-key' },
    },
    {
      finalGate: (phase) => {
        phases.push(phase);
      },
    },
  );
  assert.deepEqual(result, {
    kind: 'answer',
    value: 0.75,
    valueLabel: 'probability',
    usage: { inputTokens: 11, outputTokens: 3 },
  });
  assert.deepEqual(phases, ['dns', 'tcp', 'tls', 'write']);
  assert.deepEqual(tcp, { host: '8.8.8.8', port: 443 });
  assert.deepEqual(tls, {
    socket: {},
    rejectUnauthorized: true,
    servername: 'api.typesafe.ai',
    certificateHost: 'api.typesafe.ai',
  });
  assert.match(peer.writes[0]?.toString('utf8') ?? '', /^POST \/v1\/systemone HTTP\/1\.1\r\n/u);
  assert.doesNotMatch(peer.writes[0]?.toString('utf8') ?? '', /\r\nLocation:/u);
});

test('E6: a 3xx is refused after exactly one raw request and never followed', async () => {
  const peer = respondingSocket(
    `HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1/undocumented\r\n\r\n${fixture.vectors.typesafe.response}`,
  );
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async () => ({}) as never,
    tlsConnect: async () => peer.socket as never,
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: typesafeJudge(),
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    refused('NETWORK_FAILURE', false),
  );
  assert.equal(peer.writes.length, 1);
});

test('E6: streaming response cap destroys the socket before parsing oversized peer bytes', async () => {
  const peer = respondingSocket(`HTTP/1.1 200 OK\r\n\r\n${'x'.repeat(65_537)}`);
  let destroyed = false;
  peer.socket.destroy = () => {
    destroyed = true;
  };
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async () => ({}) as never,
    tlsConnect: async () => peer.socket as never,
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: typesafeJudge(),
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    refused('RESPONSE_TOO_LARGE', false),
  );
  assert.equal(destroyed, true);
});

test('E6: no response byte can be read before the synchronous write gate', async () => {
  const peer = respondingSocket(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${fixture.vectors.typesafe.response}`,
  );
  let dataListenersAtWriteGate = -1;
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async () => ({}) as never,
    tlsConnect: async () => peer.socket as never,
  });
  const result = await transport.execute(
    {
      judge: typesafeJudge(),
      state: fixture.vectors.typesafe.state,
      questionName: fixture.vectors.typesafe.questionName,
      instructions: fixture.vectors.typesafe.instructions,
      maxInputTokens: 512,
      maxOutputTokens: 3,
      hostedApiKey: { generation: 1, material: 'test-hosted-key' },
    },
    {
      finalGate: (phase) => {
        if (phase === 'write') dataListenersAtWriteGate = peer.dataListenerCount;
      },
    },
  );
  assert.deepEqual(result, {
    kind: 'answer',
    value: 0.75,
    valueLabel: 'probability',
    usage: { inputTokens: 11, outputTokens: 3 },
  });
  assert.equal(dataListenersAtWriteGate, 0);
});

test('E6: bounded parsers reject oversized and concatenated JSON, and the transport has no HTTP-client path', async () => {
  assert.deepEqual(
    parseJudgeResponse({
      adapter: 'typesafe',
      protocol: { protocol: 'noul' },
      questionName: 'judge',
      response: Buffer.alloc(65_537, 32),
      maxOutputTokens: 64,
    }),
    refused('RESPONSE_TOO_LARGE', false),
  );
  assert.deepEqual(
    parseJudgeResponse({
      adapter: 'typesafe',
      protocol: { protocol: 'noul' },
      questionName: 'judge',
      response: Buffer.from(`${fixture.vectors.typesafe.response}${fixture.vectors.typesafe.response}`),
      maxOutputTokens: 64,
    }),
    refused('MALFORMED_RESPONSE', false),
  );
  const source = await readFile(new URL('../src/runtime/judge-transport.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bfetch\s*\(|node:(?:http|https)|\b(?:http|https)\.request|\bproxy\b/iu);
});

test('E6: a phase that exceeds the fixed all-phase deadline produces no request bytes', async () => {
  const peer = respondingSocket(`HTTP/1.1 200 OK\r\n\r\n${fixture.vectors.typesafe.response}`);
  let scheduledMilliseconds: number | undefined;
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async () => new Promise(() => undefined) as never,
    tlsConnect: async () => peer.socket as never,
    clock: {
      now: () => 0,
      setTimeout: (callback, milliseconds) => {
        scheduledMilliseconds = milliseconds;
        queueMicrotask(callback);
        return 1;
      },
      clearTimeout() {},
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: typesafeJudge(),
        state: fixture.vectors.typesafe.state,
        questionName: fixture.vectors.typesafe.questionName,
        instructions: fixture.vectors.typesafe.instructions,
        maxInputTokens: 512,
        maxOutputTokens: 3,
        hostedApiKey: { generation: 1, material: 'test-hosted-key' },
      },
      allowAllTransportGates,
    ),
    refused('NETWORK_DEADLINE_EXCEEDED', false),
  );
  assert.deepEqual(peer.writes, []);
  assert.equal(scheduledMilliseconds, 20_000);
});

function countingTransport(clock: { now: () => number }) {
  const counts = { resolver: 0, tcp: 0, tls: 0 };
  const peer = respondingSocket(`HTTP/1.1 200 OK\r\n\r\n${fixture.vectors.typesafe.response}`);
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        counts.resolver += 1;
        return ['8.8.8.8'];
      },
    },
    tcpConnect: async () => {
      counts.tcp += 1;
      return { destroy() {} } as never;
    },
    tlsConnect: async () => {
      counts.tls += 1;
      return peer.socket as never;
    },
    clock: {
      now: clock.now,
      setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
      clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
    },
  });
  const call = {
    judge: typesafeJudge(),
    state: fixture.vectors.typesafe.state,
    questionName: fixture.vectors.typesafe.questionName,
    instructions: fixture.vectors.typesafe.instructions,
    maxInputTokens: 512,
    maxOutputTokens: 3,
    hostedApiKey: { generation: 1, material: 'test-hosted-key' },
  };
  return { counts, peer, transport, call };
}

test('E6: a final gate that has not finished deciding refuses its phase before any network action', async () => {
  for (const blocked of ['dns', 'tcp', 'tls', 'write'] as const) {
    const { counts, peer, transport, call } = countingTransport({ now: () => 0 });
    let settled = false;
    const result = await transport.execute(call, {
      // An asynchronous authority check, smuggled past the type: its promise must not count as a decision.
      finalGate: ((phase: string) =>
        phase === blocked
          ? new Promise<void>((resolve) =>
              setTimeout(() => {
                settled = true;
                resolve();
              }, 5),
            )
          : undefined) as unknown as JudgeTransportHooks['finalGate'],
    });
    assert.deepEqual(result, refused('NETWORK_FENCE_REFUSED', blocked === 'dns'), `${blocked} is refused`);
    assert.equal(settled, false, 'the transport did not wait for the pending gate and act on it');
    assert.equal(counts.resolver, blocked === 'dns' ? 0 : 1);
    assert.equal(counts.tcp, blocked === 'dns' || blocked === 'tcp' ? 0 : 1);
    assert.equal(counts.tls, blocked === 'dns' || blocked === 'tcp' || blocked === 'tls' ? 0 : 1);
    assert.deepEqual(peer.writes, []);
  }
});

test('E6: a final gate that reaches the all-phase deadline lets no later phase or byte through', async () => {
  for (const blocked of ['dns', 'tcp', 'tls', 'write'] as const) {
    let now = 0;
    const { counts, peer, transport, call } = countingTransport({ now: () => now });
    const result = await transport.execute(call, {
      finalGate: (phase, assertBeforeTransition) => {
        if (phase === blocked) now = 20_000;
        assertBeforeTransition?.();
      },
    });
    assert.deepEqual(result, refused('NETWORK_DEADLINE_EXCEEDED', blocked === 'dns'), `${blocked} times out`);
    assert.equal(counts.resolver, blocked === 'dns' ? 0 : 1, `${blocked}: no DNS starts after the final deadline`);
    assert.equal(
      counts.tcp,
      blocked === 'dns' || blocked === 'tcp' ? 0 : 1,
      `${blocked}: no TCP starts after the final deadline`,
    );
    assert.equal(
      counts.tls,
      blocked === 'dns' || blocked === 'tcp' || blocked === 'tls' ? 0 : 1,
      `${blocked}: no TLS starts after the final deadline`,
    );
    assert.deepEqual(peer.writes, [], `${blocked}: no request byte is written after the final deadline`);
  }
});

test('E6: a gate whose commit runs past the all-phase deadline starts no network action after it', async () => {
  for (const blocked of ['dns', 'tcp', 'tls', 'write'] as const) {
    let now = 0;
    const { counts, peer, transport, call } = countingTransport({ now: () => now });
    const result = await transport.execute(call, {
      finalGate: (phase, assertBeforeTransition) => {
        assertBeforeTransition?.();
        // Its own check passed; the transition it commits then takes the clock past the deadline.
        if (phase === blocked) now = 20_000;
      },
    });
    // A hosted judge's DNS gate has committed the attempt in flight by then, so the refusal is post-I/O and settles.
    assert.deepEqual(result, refused('NETWORK_DEADLINE_EXCEEDED', false), `${blocked}: refused after its gate`);
    assert.equal(counts.resolver, blocked === 'dns' ? 0 : 1, `${blocked}: no DNS starts after the deadline`);
    assert.equal(
      counts.tcp,
      blocked === 'dns' || blocked === 'tcp' ? 0 : 1,
      `${blocked}: no TCP starts after the deadline`,
    );
    assert.equal(
      counts.tls,
      blocked === 'dns' || blocked === 'tcp' || blocked === 'tls' ? 0 : 1,
      `${blocked}: no TLS starts after the deadline`,
    );
    assert.deepEqual(peer.writes, [], `${blocked}: no request byte is written after the deadline`);
  }
});

test('E6: an awaited gate that crosses the all-phase deadline stops that phase and every later phase', async () => {
  for (const blocked of ['dns', 'tcp', 'tls', 'write'] as const) {
    {
      let now = 0;
      let resolverCalls = 0;
      let tcpCalls = 0;
      let tlsCalls = 0;
      const finalGatePhases: string[] = [];
      const peer = respondingSocket(`HTTP/1.1 200 OK\r\n\r\n${fixture.vectors.typesafe.response}`);
      const transport = new JudgeTransport({
        resolver: {
          async lookup() {
            resolverCalls += 1;
            return ['8.8.8.8'];
          },
        },
        tcpConnect: async () => {
          tcpCalls += 1;
          return { destroy() {} } as never;
        },
        tlsConnect: async () => {
          tlsCalls += 1;
          return peer.socket as never;
        },
        clock: {
          now: () => now,
          setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
          clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
        },
      });
      assert.deepEqual(
        await transport.execute(
          {
            judge: typesafeJudge(),
            state: fixture.vectors.typesafe.state,
            questionName: fixture.vectors.typesafe.questionName,
            instructions: fixture.vectors.typesafe.instructions,
            maxInputTokens: 512,
            maxOutputTokens: 3,
            hostedApiKey: { generation: 1, material: 'test-hosted-key' },
          },
          {
            beforeGate: async (phase) => {
              if (phase === blocked) now = 20_000;
            },
            finalGate(phase) {
              finalGatePhases.push(phase);
            },
          },
        ),
        refused('NETWORK_DEADLINE_EXCEEDED', blocked === 'dns'),
        `${blocked}: an awaited gate that expires refuses with the all-phase deadline code`,
      );
      assert.deepEqual(
        finalGatePhases,
        (['dns', 'tcp', 'tls', 'write'] as const).slice(0, ['dns', 'tcp', 'tls', 'write'].indexOf(blocked)),
        `${blocked}: an expired awaited phase never reaches the durable final gate`,
      );
      assert.equal(resolverCalls, blocked === 'dns' ? 0 : 1, `${blocked}: no DNS starts after the awaited deadline`);
      assert.equal(
        tcpCalls,
        blocked === 'dns' || blocked === 'tcp' ? 0 : 1,
        `${blocked}: no TCP starts after the awaited deadline`,
      );
      assert.equal(
        tlsCalls,
        blocked === 'dns' || blocked === 'tcp' || blocked === 'tls' ? 0 : 1,
        `${blocked}: no TLS starts after the awaited deadline`,
      );
      assert.deepEqual(peer.writes, [], `${blocked}: no request byte is written after the awaited deadline`);
    }
  }
});

test('E6: a deadline reached while receiving a response is not accepted as an answer', async () => {
  let now = 0;
  const peer = respondingSocket(
    `HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n${fixture.vectors.typesafe.response}`,
    () => {
      now = 20_000;
    },
  );
  const transport = new JudgeTransport({
    resolver: { lookup: async () => ['8.8.8.8'] },
    tcpConnect: async () => ({}) as never,
    tlsConnect: async () => peer.socket as never,
    clock: {
      now: () => now,
      setTimeout: () => 1,
      clearTimeout() {},
    },
  });
  const result = await transport.execute(
    {
      judge: typesafeJudge(),
      state: fixture.vectors.typesafe.state,
      questionName: fixture.vectors.typesafe.questionName,
      instructions: fixture.vectors.typesafe.instructions,
      maxInputTokens: 512,
      maxOutputTokens: 3,
      hostedApiKey: { generation: 1, material: 'test-hosted-key' },
    },
    { finalGate() {} },
  );
  assert.deepEqual(result, refused('NETWORK_DEADLINE_EXCEEDED', false));
  assert.equal(peer.writes.length, 1);
});

test('E6: sockets resolving exactly at the TCP or TLS deadline are destroyed once and leave no handle or byte', async () => {
  const resourcesBefore = lastingResources();
  for (const phase of ['tcp', 'tls'] as const) {
    let now = 0;
    let tcpDestroyed = 0;
    let tlsDestroyed = 0;
    let tlsCalls = 0;
    let writes = 0;
    const tcpSocket = {
      destroy() {
        tcpDestroyed += 1;
      },
    };
    const tlsSocket = {
      destroy() {
        tlsDestroyed += 1;
      },
      write() {
        writes += 1;
        return true;
      },
    };
    const transport = new JudgeTransport({
      resolver: { lookup: async () => ['8.8.8.8'] },
      tcpConnect: async () => {
        await Promise.resolve();
        if (phase === 'tcp') now = 20_000;
        return tcpSocket as never;
      },
      tlsConnect: async () => {
        tlsCalls += 1;
        await Promise.resolve();
        now = 20_000;
        return tlsSocket as never;
      },
      clock: {
        now: () => now,
        setTimeout: () => Symbol('deadline-timer'),
        clearTimeout() {},
      },
    });
    assert.deepEqual(
      await transport.execute(
        {
          judge: typesafeJudge(),
          state: fixture.vectors.typesafe.state,
          questionName: fixture.vectors.typesafe.questionName,
          instructions: fixture.vectors.typesafe.instructions,
          maxInputTokens: 512,
          maxOutputTokens: 3,
          hostedApiKey: { generation: 1, material: 'test-hosted-key' },
        },
        allowAllTransportGates,
      ),
      refused('NETWORK_DEADLINE_EXCEEDED', false),
      `${phase}: an exact-deadline socket is refused`,
    );
    assert.equal(tcpDestroyed, 1, `${phase}: the connected TCP socket is destroyed exactly once`);
    assert.equal(tlsDestroyed, phase === 'tls' ? 1 : 0, `${phase}: only a resolved TLS socket is destroyed`);
    assert.equal(tlsCalls, phase === 'tls' ? 1 : 0, `${phase}: no TLS phase starts after a timed-out TCP connect`);
    assert.equal(writes, 0, `${phase}: no request byte follows the deadline`);
  }
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    lastingResources(),
    resourcesBefore,
    'the exact-deadline connect and TLS paths leave no lasting process resource',
  );
});

interface TransportMutation {
  readonly id: string;
  readonly file: string;
  readonly before: string;
  readonly after: string;
  readonly testFile: string;
  readonly testName: string;
  readonly killingAssertion?: string | undefined;
}

const packageRoot = join(import.meta.dirname, '..');
const repositoryRoot = join(packageRoot, '..', '..');
const mutantsRoot = join(packageRoot, '.mutants');

const transportMutations: readonly TransportMutation[] = [
  {
    id: 'e6-reference-date',
    file: 'runtime/judge-adapters.ts',
    before: `    models: {
      url: 'https://docs.typesafe.ai/models',
      readAt: '2026-10-10',
    },`,
    after: `    models: {
      url: 'https://docs.typesafe.ai/models',
      readAt: '2099-01-01',
    },`,
    testFile: 'judge-transport.test.ts',
    testName: 'E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers',
  },
  {
    id: 'e6-header-allowlist',
    file: 'runtime/judge-adapters.ts',
    before: `headers: { Authorization: \`Bearer \${input.hostedApiKey}\`, 'Content-Type': 'application/json' },`,
    after: `headers: { Authorization: \`Bearer \${input.hostedApiKey}\`, 'Content-Type': 'application/json', 'X-Extra': 'blocked' },`,
    testFile: 'judge-transport.test.ts',
    testName: 'E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers',
  },
  {
    id: 'e6-single-line-hosted-key',
    file: 'runtime/judge-adapters.ts',
    before:
      "if (/[\\r\\n]/u.test(input.hostedApiKey)) throw new TypeError('the hosted adapter needs a single-line boundary key');",
    after: "if (false) throw new TypeError('the hosted adapter needs a single-line boundary key');",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers',
  },
  {
    id: 'e6-request-cap',
    file: 'runtime/judge-transport.ts',
    before: 'return request.byteLength <= JUDGE_MAX_REQUEST_BYTES;',
    after: 'return true;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: missing dated generic-json-score vectors refuse before DNS and request-cap refusal does too',
  },
  {
    id: 'e6-response-cap',
    file: 'runtime/judge-adapters.ts',
    before: "if (input.response.byteLength > JUDGE_MAX_RESPONSE_BYTES) return refusal('RESPONSE_TOO_LARGE');",
    after: "if (false) return refusal('RESPONSE_TOO_LARGE');",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: bounded parsers reject oversized and concatenated JSON, and the transport has no HTTP-client path',
  },
  {
    id: 'e6-streaming-response-cap',
    file: 'runtime/judge-transport.ts',
    before: 'if (total > JUDGE_MAX_RESPONSE_BYTES) {',
    after: 'if (false) {',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: streaming response cap destroys the socket before parsing oversized peer bytes',
  },
  {
    id: 'e6-output-token-limit',
    file: 'runtime/judge-adapters.ts',
    before: "if (parsed.usage.output_tokens > input.maxOutputTokens) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');",
    after: "if (false) return refusal('OUTPUT_TOKEN_LIMIT_EXCEEDED');",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: response parsing returns only bounded scores and usage metadata',
  },
  {
    id: 'e6-provider-match',
    file: 'runtime/judge-adapters.ts',
    before:
      "if (!exactObject(answer, ['type', 'noul']) || answer.type !== 'noul') return refusal('MALFORMED_RESPONSE');",
    after: "if (answer.type !== 'noul') return refusal('MALFORMED_RESPONSE');",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: response parsing returns only bounded scores and usage metadata',
  },
  {
    id: 'e6-score-clamp',
    file: 'runtime/judge-adapters.ts',
    before: `if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul) || answer.noul < 0 || answer.noul > 1)
    return refusal('MALFORMED_RESPONSE');`,
    after: `if (typeof answer.noul !== 'number' || !Number.isFinite(answer.noul)) return refusal('MALFORMED_RESPONSE');`,
    testFile: 'judge-transport.test.ts',
    testName: 'E6: response parsing returns only bounded scores and usage metadata',
  },
  {
    id: 'e6-closed-score-pointer',
    file: 'runtime/judge-adapters.ts',
    before:
      "if (!pointer.ok || pointer.value.length === 0 || pointer.value.includes('*')) return refusal('MALFORMED_RESPONSE');",
    after: "if (!pointer.ok) return refusal('MALFORMED_RESPONSE');",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: response parsing returns only bounded scores and usage metadata',
  },
  {
    id: 'e6-dns-final-gate',
    file: 'runtime/judge-transport.ts',
    before: "this.#finalGate(hooks, 'dns', deadline);",
    after: 'void hooks;',
    testFile: 'judge-network-fences.test.ts',
    testName: 'E6: every hosted final gate refuses before its next physical network action',
  },
  {
    id: 'e6-tcp-final-gate',
    file: 'runtime/judge-transport.ts',
    before: "this.#finalGate(hooks, 'tcp', deadline);",
    after: 'void hooks;',
    testFile: 'judge-network-fences.test.ts',
    testName: 'E6: every hosted final gate refuses before its next physical network action',
  },
  {
    id: 'e6-tls-final-gate',
    file: 'runtime/judge-transport.ts',
    before: "this.#finalGate(hooks, 'tls', deadline);",
    after: 'void hooks;',
    testFile: 'judge-network-fences.test.ts',
    testName: 'E6: every hosted final gate refuses before its next physical network action',
  },
  {
    id: 'e6-write-final-gate',
    file: 'runtime/judge-transport.ts',
    before: "this.#finalGate(hooks, 'write', deadline);",
    after: 'void hooks;',
    testFile: 'judge-network-fences.test.ts',
    testName: 'E6: every hosted final gate refuses before its next physical network action',
  },
  {
    id: 'e6-write-gate-adjacency',
    file: 'runtime/judge-transport.ts',
    before: `      await this.#beforeGate(hooks, 'write');
      this.#finalGate(hooks, 'write', deadline);
      assertBeforeDeadline(deadline, this.#clock);
      socket.write(request);
      const response = boundedResponse(socket);`,
    after: `      const response = boundedResponse(socket);
      await this.#beforeGate(hooks, 'write');
      this.#finalGate(hooks, 'write', deadline);
      assertBeforeDeadline(deadline, this.#clock);
      socket.write(request);`,
    testFile: 'judge-transport.test.ts',
    testName: 'E6: no response byte can be read before the synchronous write gate',
  },
  {
    id: 'e6-no-http-client',
    file: 'runtime/judge-transport.ts',
    before: "import type tls from 'node:tls';",
    after: "import type tls from 'node:tls';\nimport * as blockedHttpClient from 'node:http';\nvoid blockedHttpClient;",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: bounded parsers reject oversized and concatenated JSON, and the transport has no HTTP-client path',
  },
  {
    id: 'e6-no-proxy-path',
    file: 'runtime/judge-transport.ts',
    before: "import type tls from 'node:tls';",
    after: "import type tls from 'node:tls';\nconst proxy = 'http://127.0.0.1:1';\nvoid proxy;",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: bounded parsers reject oversized and concatenated JSON, and the transport has no HTTP-client path',
  },
  {
    id: 'e6-no-redirect',
    file: 'runtime/judge-transport.ts',
    before: 'if (!Number.isInteger(code) || code < 200 || code > 299) return null;',
    after: 'if (!Number.isInteger(code)) return null;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: a 3xx is refused after exactly one raw request and never followed',
  },
  {
    id: 'e6-literal-loopback-only',
    file: 'network/local-endpoint.ts',
    before: 'address = parseIpLiteral(hostname).address;',
    after: "address = hostname === 'localhost' ? '127.0.0.1' : parseIpLiteral(hostname).address;",
    testFile: 'judge-network-fences.test.ts',
    testName: 'E6: hostname loopback is refused before DNS or TCP, never resolved as a local endpoint',
  },
  {
    id: 'e6-attempt-deadline',
    file: 'runtime/judge-transport.ts',
    before: 'const JUDGE_ATTEMPT_DEADLINE_MS = 20_000;',
    after: 'const JUDGE_ATTEMPT_DEADLINE_MS = 20_001;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: a phase that exceeds the fixed all-phase deadline produces no request bytes',
  },
  {
    id: 'e6-post-gate-deadline',
    file: 'runtime/judge-transport.ts',
    before: `    assertBeforeDeadline(deadline, this.#clock);
    let decision: unknown;`,
    after: '    let decision: unknown;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: an awaited gate that crosses the all-phase deadline stops that phase and every later phase',
  },
  {
    id: 'e6-final-gate-deadline',
    file: 'runtime/judge-transport.ts',
    before: '      decision = hooks.finalGate(phase, () => assertBeforeDeadline(deadline, this.#clock));',
    after: '      decision = hooks.finalGate(phase);',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: a final gate that reaches the all-phase deadline lets no later phase or byte through',
  },
  {
    id: 'e6-synchronous-final-gate',
    file: 'runtime/judge-transport.ts',
    before: `    if (decision !== undefined) {
      if (typeof (decision as { then?: unknown } | null)?.then === 'function')
        Promise.resolve(decision).catch(() => undefined);
      throw new FenceRefused();
    }`,
    after: '    void decision;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: a final gate that has not finished deciding refuses its phase before any network action',
  },
  {
    id: 'e6-response-deadline',
    file: 'runtime/judge-transport.ts',
    before: '      assertBeforeDeadline(deadline, clock);',
    after: '      void deadline;',
    testFile: 'judge-transport.test.ts',
    testName: 'E6: a deadline reached while receiving a response is not accepted as an answer',
  },
  {
    id: 'e6-fatal-utf8',
    file: 'runtime/judge-adapters.ts',
    before: "JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(input.response))",
    after: "JSON.parse(Buffer.from(input.response).toString('utf8'))",
    testFile: 'judge-transport.test.ts',
    testName: 'E6: malformed UTF-8 anywhere in a Noul answer is fail-closed',
  },
  {
    id: 'e6-a-accept-non-global',
    file: 'network/address-policy.ts',
    before: `if (!globallyReachable(address))
      throw new AddressPolicyError(\`non-global address \${address.address} is refused by global-only policy\`);`,
    after: `if (false)
      throw new AddressPolicyError(\`non-global address \${address.address} is refused by global-only policy\`);`,
    testFile: 'network/address-policy.test.ts',
    testName: 'E6-A: global-only policy accepts only globally reachable literals and every embedded transition address',
  },
  {
    id: 'e6-a-skip-embedded-addresses',
    file: 'network/address-policy.ts',
    before: 'for (const child of nested) assertOne(child, approved, options, seen);',
    after: 'void nested;',
    testFile: 'network/address-policy.test.ts',
    testName: 'E6-A: global-only policy accepts only globally reachable literals and every embedded transition address',
  },
  {
    id: 'e6-a-allow-global-only-non-typesafe',
    file: 'network/pinned-connection.ts',
    before: `if (url.href !== TYPESAFE_GLOBAL_ONLY_ENDPOINT)
      throw new AddressPolicyError('global-only address mode is reserved for the fixed TypeSafe endpoint');`,
    after: `if (false)
      throw new AddressPolicyError('global-only address mode is reserved for the fixed TypeSafe endpoint');`,
    testFile: 'network/pinned-connection.test.ts',
    testName: 'E6-A: global-only mode is reserved for the exact fixed TypeSafe endpoint',
  },
  {
    id: 'e6-m-accept-alias',
    file: 'domain/judges.ts',
    before: `if (!(APPROVED_TYPESAFE_MODELS as readonly string[]).includes(judge.model as string))
      return fail('a typesafe judge names one concrete model listed in the provider record');`,
    after: `if (false)
      return fail('a typesafe judge names one concrete model listed in the provider record');`,
    testFile: 'judge-documents.test.ts',
    testName: 'E6-M: TypeSafe documents name only concrete provider-record models, never aliases',
  },
  {
    id: 'e6-m-substitute-constant-model',
    file: 'runtime/judge-transport.ts',
    before: 'model: call.judge.model,',
    after: "model: 'jev-1.13.0',",
    testFile: 'judge-transport.test.ts',
    testName: 'E6-M: TypeSafe request bytes take the approved document model, never a transport constant',
  },
  {
    id: 'e-review-isatap-embedded-address',
    file: 'network/address-policy.ts',
    before:
      'if (isatapInterface === 0x00005efen || isatapInterface === 0x02005efen) embedded.push(ipv4From(address.value));',
    after: 'if (false) embedded.push(ipv4From(address.value));',
    testFile: 'network/address-policy.test.ts',
    testName: 'NET-B2: validates the outer and every embedded transition address',
    killingAssertion:
      '2600::5efe:a00:1: an approved ISATAP outer address cannot hide an unapproved embedded IPv4 address',
  },
  {
    id: 'e-review-exact-deadline-socket-disposal',
    file: 'runtime/judge-transport.ts',
    before: `    } catch (error) {
      try {
        disposeLate?.(result);
      } catch {
        // Cleanup failure cannot turn an elapsed attempt into a usable socket or hide the deadline refusal.
      }
      throw error;
    }`,
    after: `    } catch (error) {
      throw error;
    }`,
    testFile: 'judge-transport.test.ts',
    testName: 'E6: sockets resolving exactly at the TCP or TLS deadline are destroyed once and leave no handle or byte',
    killingAssertion: 'the connected TCP socket is destroyed exactly once',
  },
];

const JUDGE_TRANSPORT_MUTATIONS = transportMutations.map((mutation) => ({
  ...mutation,
  killingAssertion: mutation.killingAssertion ?? 'ERR_ASSERTION',
}));

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

function exactTestName(name: string): string {
  return `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`;
}

async function rewriteCopiedCrossPackageImports(root: string): Promise<void> {
  const copiedTests = join(root, 'test');
  const originalTests = join(packageRoot, 'test');
  const rewrite = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const copied = join(directory, entry.name);
      if (entry.isDirectory()) {
        await rewrite(copied);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.ts')) continue;
      const original = join(originalTests, relative(copiedTests, copied));
      const source = await readFile(copied, 'utf8');
      const rewritten = source.replace(
        /(\b(?:from|import)\s*(?:\()?\s*)(['"])([^'"]+)\2/gu,
        (match, prefix: string, quote: string, specifier: string) => {
          if (!specifier.startsWith('.')) return match;
          const target = resolve(dirname(original), specifier);
          if (!relative(packageRoot, target).startsWith('..')) return match;
          return `${prefix}${quote}${pathToFileURL(target).href}${quote}`;
        },
      );
      if (rewritten !== source) await writeFile(copied, rewritten, 'utf8');
    }
  };
  await rewrite(copiedTests);
}

function assertExactlyOneNamedMutationFailure(
  mutation: TransportMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.notEqual(
    result.code,
    0,
    `${mutation.id}: ${mutation.testName} unexpectedly accepted its mutant\n${result.output}`,
  );
  const summary = (name: 'tests' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: child emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: the child ran more than its one named test\n${result.output}`);
  assert.equal(summary('fail'), 1, `${mutation.id}: the named test did not fail\n${result.output}`);
  const subtests = [...result.output.matchAll(/^# Subtest: (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(subtests, [mutation.testName], `${mutation.id}: a different test ran\n${result.output}`);
  const failures = [...result.output.matchAll(/^not ok \d+ - (.+)$/gmu)].map((match) => match[1]);
  assert.deepEqual(failures, [mutation.testName], `${mutation.id}: its named test did not fail\n${result.output}`);
  assert.equal(
    result.output.includes(mutation.killingAssertion ?? ''),
    true,
    `${mutation.id}: its named guard assertion did not kill the mutant\n${result.output}`,
  );
}

function assertExactlyOneNamedMutationPass(
  mutation: TransportMutation,
  result: { readonly code: number | null; readonly output: string },
): void {
  assert.equal(result.code, 0, `${mutation.id}: unmutated named test did not pass\n${result.output}`);
  const summary = (name: 'tests' | 'pass' | 'fail'): number => {
    const values = [...result.output.matchAll(new RegExp(`^# ${name} (\\d+)$`, 'gmu'))];
    assert.equal(values.length, 1, `${mutation.id}: baseline emitted no unique TAP ${name} summary\n${result.output}`);
    return Number(values[0]?.[1]);
  };
  assert.equal(summary('tests'), 1, `${mutation.id}: baseline ran more than one named test\n${result.output}`);
  assert.equal(summary('pass'), 1, `${mutation.id}: baseline did not pass exactly once\n${result.output}`);
  assert.equal(summary('fail'), 0, `${mutation.id}: baseline reported a failure\n${result.output}`);
}

async function expectTransportMutationToFail(mutation: TransportMutation): Promise<number> {
  const root = join(mutantsRoot, mutation.id);
  await rm(root, { recursive: true, force: true });
  try {
    await cp(join(packageRoot, 'src'), join(root, 'src'), { recursive: true });
    await cp(join(packageRoot, 'test'), join(root, 'test'), { recursive: true });
    await rewriteCopiedCrossPackageImports(root);
    const target = join(root, 'src', mutation.file);
    const original = await readFile(target, 'utf8');
    assert.equal(occurrences(original, mutation.before), 1, `${mutation.id} must replace one production guard`);
    const changedLine = original.slice(0, original.indexOf(mutation.before)).split('\n').length;
    const { NODE_TEST_CONTEXT: _parentContext, ...environment } = process.env;
    const args = [
      '--import',
      pathToFileURL(join(repositoryRoot, 'test/helpers/loopback-seal-preload.mjs')).href,
      '--experimental-strip-types',
      '--disable-warning=ExperimentalWarning',
      '--test',
      '--test-reporter=tap',
      '--test-name-pattern',
      exactTestName(mutation.testName),
      join(root, 'test', mutation.testFile),
    ];
    const baseline = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 30_000,
    });
    assertExactlyOneNamedMutationPass(mutation, baseline);
    await writeFile(target, original.replace(mutation.before, mutation.after), 'utf8');
    const result = await runStrictMutationChild({
      command: process.execPath,
      args,
      cwd: root,
      env: environment,
      timeoutMs: 30_000,
    });
    assertExactlyOneNamedMutationFailure(mutation, result);
    return changedLine;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test('E6: the mutation runner rejects copied-tree import crashes and mutants whose named test passes', async () => {
  await assert.rejects(
    expectTransportMutationToFail({
      id: 'e6-self-import-crash',
      file: 'runtime/judge-transport.ts',
      before: "import type tls from 'node:tls';",
      after: "import './missing-e6-self-test.ts';\nimport type tls from 'node:tls';",
      testFile: 'judge-transport.test.ts',
      testName: 'E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers',
    }),
    /a different test ran/u,
  );
  await assert.rejects(
    expectTransportMutationToFail({
      id: 'e6-self-passing-mutant',
      file: 'runtime/judge-transport.ts',
      before: "const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';",
      after: "const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';",
      testFile: 'judge-transport.test.ts',
      testName: 'E6: dated TypeSafe and Ollama vectors allow only documented request fields and headers',
    }),
    /unexpectedly accepted its mutant/u,
  );
});

test('E6: every sealed transport guard has one destructive mutation and its named production-path oracle', async (context) => {
  const verdicts: { id: string; killed: boolean }[] = [];
  for (const mutation of JUDGE_TRANSPORT_MUTATIONS) {
    const changedLine = await expectTransportMutationToFail(mutation);
    verdicts.push({ id: mutation.id, killed: true });
    context.diagnostic(`${mutation.id}: src/${mutation.file}:${changedLine} -> ${mutation.testName}`);
  }
  assert.deepEqual(
    verdicts.map((verdict) => verdict.id),
    JUDGE_TRANSPORT_MUTATIONS.map((mutation) => mutation.id),
  );
  assert.ok(verdicts.every((verdict) => verdict.killed));
});
