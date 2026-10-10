import assert from 'node:assert/strict';
import { test } from 'node:test';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import type { JudgeTransportHooks } from '../src/runtime/judge-transport.ts';
import { startLoopbackReceiver } from './support/loopback-receiver.ts';

assertLoopbackSeal();

const { JudgeTransport } = await import('../src/runtime/judge-transport.ts');

function typesafeJudge() {
  return {
    judgeId: 'judge-typesafe-e6',
    version: 1,
    kind: 'typesafe' as const,
    provider: 'typesafe' as const,
    model: 'jev-1.13.0',
    endpoint: 'https://api.typesafe.ai/v1/systemone' as const,
    promptTemplate: 'typesafe-jev-noul-v1',
    protocol: 'noul' as const,
  };
}

function peerSocket() {
  const listeners = new Map<string, (value?: Buffer | Error) => void>();
  const writes: Buffer[] = [];
  return {
    writes,
    socket: {
      write(bytes: Uint8Array) {
        writes.push(Buffer.from(bytes));
        queueMicrotask(() => {
          listeners.get('data')?.(
            Buffer.from(
              'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"judge":{"noul":0.5,"type":"noul"}},"model":"jev-1.13.0","usage":{"input_tokens":1,"output_tokens":1}}',
            ),
          );
          listeners.get('end')?.();
        });
        return true;
      },
      destroy() {},
      once(event: string, listener: (value?: Buffer | Error) => void) {
        listeners.set(event, listener);
        return this;
      },
      on(event: string, listener: (value?: Buffer | Error) => void) {
        listeners.set(event, listener);
        return this;
      },
    },
  };
}

function localJudge(port: number) {
  return {
    judgeId: 'judge-loopback-e6',
    version: 1,
    kind: 'local-endpoint' as const,
    provider: 'ollama',
    model: 'nimble',
    endpoint: `http://127.0.0.1:${port}/v1/systemone`,
    approvedAddressSet: ['127.0.0.1'] as const,
    promptTemplate: 'ollama-noul-v1',
    protocol: 'noul' as const,
  };
}

const allowAllTransportGates: JudgeTransportHooks = { finalGate() {} };

test('E6: sealed loopback local transport accepts only its exact literal peer and bounded response', async () => {
  const requests: Buffer[] = [];
  const receiver = await startLoopbackReceiver((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
      if (!Buffer.concat(chunks).includes(Buffer.from('\r\n\r\n'))) return;
      requests.push(Buffer.concat(chunks));
      socket.end(
        'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"answers":{"judge":{"type":"noul","noul":0.5}},"model":"nimble","usage":{"input_tokens":5,"output_tokens":2}}',
      );
    });
  });
  try {
    const transport = new JudgeTransport({ resolver: { lookup: async () => ['127.0.0.1'] } });
    assert.deepEqual(
      await transport.execute(
        {
          judge: localJudge(receiver.port),
          state: '{"kind":"synthetic","version":1}',
          questionName: 'judge',
          instructions: 'Determine whether this synthetic event needs review.',
          maxInputTokens: 512,
          maxOutputTokens: 2,
        },
        allowAllTransportGates,
      ),
      {
        kind: 'answer',
        value: 0.5,
        valueLabel: 'probability',
        usage: { inputTokens: 5, outputTokens: 2 },
      },
    );
    assert.equal(requests.length, 1);
    assert.match(requests[0]?.toString('utf8') ?? '', /^POST \/v1\/systemone HTTP\/1\.1\r\n/u);
  } finally {
    await receiver.close();
  }
});

test('E6: literal local judges have no DNS rebinding path and every applicable final-gate refusal stops the next I/O phase', async (t) => {
  const phases = ['dns', 'tcp', 'write'] as const;
  for (const blocked of phases) {
    await t.test(blocked, async () => {
      let resolverCalls = 0;
      let tcpCalls = 0;
      let tlsCalls = 0;
      let writes = 0;
      const transport = new JudgeTransport({
        resolver: {
          async lookup() {
            resolverCalls += 1;
            return ['8.8.8.8'];
          },
        },
        tcpConnect: async () => {
          tcpCalls += 1;
          if (blocked === 'tcp') throw new Error('tcp began after its final fence');
          return {
            write() {
              writes += 1;
              return true;
            },
            destroy() {},
            once() {},
            on() {},
          } as never;
        },
        tlsConnect: async () => {
          tlsCalls += 1;
          return {} as never;
        },
      });
      const result = await transport.execute(
        {
          judge: localJudge(11434),
          state: '{"kind":"synthetic","version":1}',
          questionName: 'judge',
          instructions: 'Determine whether this synthetic event needs review.',
          maxInputTokens: 512,
          maxOutputTokens: 2,
        },
        {
          finalGate: (phase) => {
            if (phase === blocked) throw new Error('authority changed');
          },
        },
      );
      assert.deepEqual(result, { kind: 'refused', code: 'NETWORK_FENCE_REFUSED' });
      assert.equal(resolverCalls, 0, 'literal local endpoints have one resolver-free pinned address');
      assert.equal(tcpCalls, blocked === 'dns' || blocked === 'tcp' ? 0 : 1);
      assert.equal(tlsCalls, 0, 'HTTP local endpoints never start TLS');
      assert.equal(writes, 0);
    });
  }

  let resolverCalls = 0;
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return ['127.0.0.1', '10.0.0.1'];
      },
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: {
          judgeId: 'judge-typesafe-rebinding-e6',
          version: 1,
          kind: 'typesafe',
          provider: 'typesafe',
          model: 'jev-1.13.0',
          endpoint: 'https://api.typesafe.ai/v1/systemone',
          promptTemplate: 'typesafe-jev-noul-v1',
          protocol: 'noul',
        },
        state: '{"kind":"synthetic","version":1}',
        questionName: 'judge',
        instructions: 'Determine whether this synthetic event needs review.',
        maxInputTokens: 512,
        maxOutputTokens: 2,
        hostedApiKey: 'test-hosted-key',
      },
      allowAllTransportGates,
    ),
    { kind: 'refused', code: 'NETWORK_FAILURE' },
  );
  assert.equal(resolverCalls, 1);
});

test('E6: hostname loopback is refused before DNS or TCP, never resolved as a local endpoint', async () => {
  let resolverCalls = 0;
  let tcpCalls = 0;
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return ['127.0.0.1'];
      },
    },
    tcpConnect: async () => {
      tcpCalls += 1;
      return peerSocket().socket as never;
    },
  });
  assert.deepEqual(
    await transport.execute(
      {
        judge: {
          ...localJudge(11434),
          endpoint: 'http://localhost:11434/v1/systemone',
        },
        state: '{"kind":"synthetic","version":1}',
        questionName: 'judge',
        instructions: 'Determine whether this synthetic event needs review.',
        maxInputTokens: 512,
        maxOutputTokens: 2,
      },
      allowAllTransportGates,
    ),
    { kind: 'refused', code: 'ADAPTER_REFERENCE_BLOCKED' },
  );
  assert.equal(resolverCalls, 0);
  assert.equal(tcpCalls, 0);
});

test('E6: every hosted final gate refuses before its next physical network action', async () => {
  for (const blocked of ['dns', 'tcp', 'tls', 'write'] as const) {
    {
      let resolverCalls = 0;
      let tcpCalls = 0;
      let tlsCalls = 0;
      const peer = peerSocket();
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
      });
      assert.deepEqual(
        await transport.execute(
          {
            judge: typesafeJudge(),
            state: '{"kind":"synthetic","version":1}',
            questionName: 'judge',
            instructions: 'Determine whether this synthetic event needs review.',
            maxInputTokens: 512,
            maxOutputTokens: 2,
            hostedApiKey: 'test-hosted-key',
          },
          {
            finalGate: (phase) => {
              if (phase === blocked) throw new Error('authority changed');
            },
          },
        ),
        { kind: 'refused', code: 'NETWORK_FENCE_REFUSED' },
      );
      assert.equal(resolverCalls, blocked === 'dns' ? 0 : 1);
      assert.equal(tcpCalls, blocked === 'dns' || blocked === 'tcp' ? 0 : 1);
      assert.equal(tlsCalls, blocked === 'dns' || blocked === 'tcp' || blocked === 'tls' ? 0 : 1);
      assert.equal(peer.writes.length, 0);
    }
  }
});

test('E6: a hosted globally reachable address can never drift to a private answer on a later attempt', async () => {
  let resolverCalls = 0;
  let tcpCalls = 0;
  let tlsCalls = 0;
  const peer = peerSocket();
  const transport = new JudgeTransport({
    resolver: {
      async lookup() {
        resolverCalls += 1;
        return resolverCalls === 1 ? ['8.8.8.8'] : ['10.0.0.1'];
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
  });
  const request = {
    judge: typesafeJudge(),
    state: '{"kind":"synthetic","version":1}',
    questionName: 'judge',
    instructions: 'Determine whether this synthetic event needs review.',
    maxInputTokens: 512,
    maxOutputTokens: 2,
    hostedApiKey: 'test-hosted-key',
  };
  assert.deepEqual(await transport.execute(request, allowAllTransportGates), {
    kind: 'answer',
    value: 0.5,
    valueLabel: 'probability',
    usage: { inputTokens: 1, outputTokens: 1 },
  });
  assert.deepEqual(await transport.execute(request, allowAllTransportGates), {
    kind: 'refused',
    code: 'NETWORK_FAILURE',
  });
  assert.equal(resolverCalls, 2);
  assert.equal(tcpCalls, 1);
  assert.equal(tlsCalls, 1);
  assert.equal(peer.writes.length, 1);
});
