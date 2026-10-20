import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { assertLoopbackSeal } from '../../../test/helpers/loopback-seal-preload.mjs';
import {
  canonicalLayaTemplate,
  LAYA_CHOICE2_TEMPLATE_ID,
  LAYA_NOUL_TEMPLATE_ID,
  LAYA_TEMPLATE_IDS,
  layaLayout,
  layaTemplateDigest,
} from '../src/runtime/laya/templates.ts';
import { LAYA_SANDBOX_PROFILE, LAYA_WORKER_ENV } from '../src/runtime/laya/worker-boundary-probe.ts';
import { encodeWorkerFrame, WorkerFrameParser } from '../src/runtime/laya/worker-protocol.ts';
import {
  evaluateLayaRequest,
  LAYA_HEAD_MAX_TOKENS,
  LAYA_MAX_SEQUENCE_TOKENS,
  LAYA_OPTION_MAX_TOKENS,
  LAYA_QUESTION_NAME,
  type LayaRuntimeBinding,
  type LayaWorkerRequest,
  layaLoadOptions,
  layaLoadPayload,
  layaSequenceTokens,
  loadVerifiedLayaRuntime,
} from '../src/runtime/laya/worker-runtime.ts';
import { ANSWERING_LAYA, syntheticRuntimeTree } from './support/laya-synthetic-runtime.ts';
import { WINDOWS_SKIP } from './support/short-temp.ts';

assertLoopbackSeal();

const workerRuntimeSource = new URL('../src/runtime/laya/worker-runtime.ts', import.meta.url);
const shippedManifest = new URL('../laya-manifest.json', import.meta.url);

/** One token per whitespace-separated word: a synthetic tokenizer whose counts a test can predict exactly. */
function words(text: string): number {
  return text.split(/\s+/u).filter((word) => word.length > 0).length;
}

interface Asked {
  readonly state: string;
  readonly questions: Readonly<Record<string, unknown>>;
}

/** A stand-in runtime: it answers whatever a test hands it and records exactly what it was asked. */
function standinRuntime(
  answer: (asked: Asked) => unknown,
  count: (text: string) => number = words,
): LayaRuntimeBinding & { readonly asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    countTokens: count,
    async systemOne(state, questions) {
      const entry = { state, questions };
      asked.push(entry);
      return answer(entry);
    },
    async close() {},
  };
}

function noulAnswer(value: unknown, inputTokens: number, outputTokens = 0, extra: Record<string, unknown> = {}) {
  return {
    answers: { [LAYA_QUESTION_NAME]: { type: 'noul', noul: value, confidence: 0.4, ...extra } },
    model: 'synthetic-runtime',
    usage: { input_tokens: inputTokens, output_tokens: outputTokens },
  };
}

function request(state: string, instructions = 'Does this synthetic message ask for a reply?'): LayaWorkerRequest {
  return { templateId: LAYA_NOUL_TEMPLATE_ID, instructions, state };
}

/** The exact sequence the runtime builds: [CLS] head [SEP], then [MASK] + option for each, [SEP] state [SEP]. */
function expectedTokens(input: LayaWorkerRequest): number {
  const layout = layaLayout(input.templateId, input);
  return (
    words(layout.head) + layout.options.reduce((sum, option) => sum + 1 + words(option), 0) + words(layout.state) + 4
  );
}

test('E2 Laya worker runtime vectors: one noul question, its value unchanged and the uncut token count', async () => {
  const input = request('{"version":1,"inputs":[{"pointer":"/subject","value":"synthetic subject words"}]}');
  const tokens = expectedTokens(input);
  const runtime = standinRuntime(() => noulAnswer(0.734_56, tokens));
  assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'answer', value: 0.734_56, inputTokens: tokens });
  assert.equal(runtime.asked.length, 1);
  assert.equal(runtime.asked[0]?.state, input.state, 'the enveloped input reaches the runtime as it was given');
  assert.deepEqual(
    { ...runtime.asked[0]?.questions },
    {
      [LAYA_QUESTION_NAME]: { type: 'noul', instructions: input.instructions },
    },
  );
  for (const value of [0, 1]) {
    const exact = standinRuntime(() => noulAnswer(value, tokens));
    assert.deepEqual(await evaluateLayaRequest(exact, input), { kind: 'answer', value, inputTokens: tokens });
  }
});

test('E2 Laya worker runtime: an input the 512-token context would cut is refused, never truncated', async () => {
  const base = request('x');
  const room = LAYA_MAX_SEQUENCE_TOKENS - expectedTokens(base) + 1;
  const fits = request(Array.from({ length: room }, () => 'w').join(' '));
  assert.equal(expectedTokens(fits), LAYA_MAX_SEQUENCE_TOKENS);
  assert.equal(layaSequenceTokens({ countTokens: words }, fits), LAYA_MAX_SEQUENCE_TOKENS);
  const answered = standinRuntime(() => noulAnswer(0.5, LAYA_MAX_SEQUENCE_TOKENS));
  assert.deepEqual(await evaluateLayaRequest(answered, fits), {
    kind: 'answer',
    value: 0.5,
    inputTokens: LAYA_MAX_SEQUENCE_TOKENS,
  });

  const over = request(`${fits.state} w`);
  assert.equal(expectedTokens(over), LAYA_MAX_SEQUENCE_TOKENS + 1);
  const refused = standinRuntime(() => noulAnswer(0.5, LAYA_MAX_SEQUENCE_TOKENS));
  assert.deepEqual(await evaluateLayaRequest(refused, over), { kind: 'refused', code: 'token-limit' });
  assert.equal(refused.asked.length, 0, 'the runtime is never asked to cut an over-long input');
});

test('E2 Laya worker runtime: an option over 48 tokens is refused, never cut', async () => {
  const input = request('short state');
  const layout = layaLayout(LAYA_NOUL_TEMPLATE_ID, input);
  const first = layout.options[0] ?? '';
  const at = (limit: number) => (text: string) => (text === first ? limit : words(text));
  assert.notEqual(layaSequenceTokens({ countTokens: at(LAYA_OPTION_MAX_TOKENS) }, input), null);
  const runtime = standinRuntime(() => noulAnswer(0.5, 1), at(LAYA_OPTION_MAX_TOKENS + 1));
  assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'refused', code: 'token-limit' });
  assert.equal(runtime.asked.length, 0);
});

test('E2 Laya worker runtime: a head over its 192-token budget is refused, never cut', async () => {
  const input = request('short state');
  const layout = layaLayout(LAYA_NOUL_TEMPLATE_ID, input);
  // The head is [CLS], its text and [SEP], then one [MASK] and the text of each option.
  const optionTokens = layout.options.reduce((sum, option) => sum + words(option), 0);
  const fitting = LAYA_HEAD_MAX_TOKENS - 2 - layout.options.length - optionTokens;
  const head = (tokens: number) => (text: string) => (text === layout.head ? tokens : words(text));
  assert.notEqual(layaSequenceTokens({ countTokens: head(fitting) }, input), null);
  const runtime = standinRuntime(() => noulAnswer(0.5, 1), head(fitting + 1));
  assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'refused', code: 'token-limit' });
  assert.equal(runtime.asked.length, 0);
});

test('E2 Laya worker runtime: a non-finite, out-of-range or non-numeric value is malformed, never clamped', async () => {
  const input = request('synthetic state');
  const tokens = expectedTokens(input);
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, 1.01, '0.5', null]) {
    const runtime = standinRuntime(() => noulAnswer(value, tokens));
    assert.deepEqual(
      await evaluateLayaRequest(runtime, input),
      { kind: 'refused', code: 'malformed' },
      `the value ${String(value)} is refused`,
    );
  }
});

test('E2 Laya worker runtime: the runtime must report the uncut count and no output tokens', async () => {
  const input = request('synthetic state');
  const tokens = expectedTokens(input);
  for (const [inputTokens, outputTokens] of [
    [tokens - 1, 0],
    [tokens + 1, 0],
    [tokens, 1],
  ] as const) {
    const runtime = standinRuntime(() => noulAnswer(0.5, inputTokens, outputTokens));
    assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'refused', code: 'malformed' });
  }
});

test('E2 Laya worker runtime: an answer outside the closed noul shape, or a runtime that throws, is malformed', async () => {
  const input = request('synthetic state');
  const tokens = expectedTokens(input);
  const shapes: unknown[] = [
    null,
    { answers: {}, usage: { input_tokens: tokens, output_tokens: 0 } },
    {
      answers: { [LAYA_QUESTION_NAME]: { type: 'noul', noul: 0.5 }, other: { type: 'noul', noul: 0.9 } },
      usage: { input_tokens: tokens, output_tokens: 0 },
    },
    {
      answers: { [LAYA_QUESTION_NAME]: { type: 'choice', noul: 0.5 } },
      usage: { input_tokens: tokens, output_tokens: 0 },
    },
    { answers: { [LAYA_QUESTION_NAME]: { type: 'noul', noul: 0.5 } } },
  ];
  for (const shape of shapes) {
    assert.deepEqual(
      await evaluateLayaRequest(
        standinRuntime(() => shape),
        input,
      ),
      {
        kind: 'refused',
        code: 'malformed',
      },
    );
  }
  const throwing = standinRuntime(() => {
    throw new Error('synthetic runtime failure');
  });
  assert.deepEqual(await evaluateLayaRequest(throwing, input), { kind: 'refused', code: 'malformed' });
  const badCount = standinRuntime(
    () => noulAnswer(0.5, tokens),
    () => -1,
  );
  assert.deepEqual(await evaluateLayaRequest(badCount, input), { kind: 'refused', code: 'malformed' });
  assert.equal(badCount.asked.length, 0);
});

test('E2 Laya worker runtime: an answer that names a decision or reason is still only its probability', async () => {
  const input = request('synthetic state');
  const tokens = expectedTokens(input);
  const runtime = standinRuntime(() => noulAnswer(0.25, tokens, 0, { match: true, reason: 'the provider says match' }));
  assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'answer', value: 0.25, inputTokens: tokens });
});

test('E2 Laya worker runtime: every literal [MASK] is counted as the space the runtime replaces it with', async () => {
  const masked = request('alpha[MASK]beta', 'Is[MASK]this urgent?');
  const layout = layaLayout(LAYA_NOUL_TEMPLATE_ID, masked);
  assert.equal(layout.state, 'alpha beta');
  assert.equal(layout.head, 'noul question: Is this urgent?');
  assert.equal(layaSequenceTokens({ countTokens: words }, masked), expectedTokens(masked));
  const tokens = expectedTokens(masked);
  // The head's five words, [MASK] + 7 and [MASK] + 5 for the two options, the two state words, and four markers.
  assert.equal(tokens, 5 + (1 + 7) + (1 + 5) + 2 + 4);
  const runtime = standinRuntime(() => noulAnswer(0.5, tokens));
  assert.deepEqual(await evaluateLayaRequest(runtime, masked), { kind: 'answer', value: 0.5, inputTokens: tokens });
  assert.equal(runtime.asked[0]?.state, masked.state, 'the runtime itself is given the request unchanged');
});

test('E2 Laya worker runtime: laya-choice2-v1 is counted but refused until its runtime wire is recorded', async () => {
  const input: LayaWorkerRequest = { templateId: LAYA_CHOICE2_TEMPLATE_ID, instructions: 'Is it urgent?', state: 's' };
  assert.deepEqual(layaLayout(LAYA_CHOICE2_TEMPLATE_ID, input).options, [
    ' a: yes, the statement holds',
    ' b: no, the statement does not hold',
  ]);
  const runtime = standinRuntime(() => noulAnswer(0.5, 1));
  assert.deepEqual(await evaluateLayaRequest(runtime, input), { kind: 'refused', code: 'template-blocked' });
  assert.equal(runtime.asked.length, 0, 'no choice question is ever built from an unrecorded wire');
});

test('E2 Laya worker runtime: the manifest offers only templates the worker implements, each with a stable digest', async () => {
  const manifest = JSON.parse(await readFile(shippedManifest, 'utf8')) as { promptTemplates: string[] };
  assert.deepEqual([...LAYA_TEMPLATE_IDS], [LAYA_CHOICE2_TEMPLATE_ID, LAYA_NOUL_TEMPLATE_ID]);
  // E2 Task 10: this release offers `laya-noul-v1` alone; the choice template stays in the worker, refused, until its
  // own task lifts that refusal.
  assert.deepEqual(manifest.promptTemplates, [LAYA_NOUL_TEMPLATE_ID]);
  assert.ok(manifest.promptTemplates.every((id) => (LAYA_TEMPLATE_IDS as readonly string[]).includes(id)));
  assert.deepEqual(layaLayout(LAYA_NOUL_TEMPLATE_ID, { instructions: 'q', state: 's' }).options, [
    ' false: no, the statement does not hold',
    ' true: yes, the statement holds',
  ]);
  assert.equal(
    canonicalLayaTemplate(LAYA_NOUL_TEMPLATE_ID),
    '{"id":"laya-noul-v1","type":"noul","options":[{"label":"false","text":"no, the statement does not hold"},{"label":"true","text":"yes, the statement holds"}],"affirmative":"true"}',
  );
  assert.equal(layaTemplateDigest(LAYA_NOUL_TEMPLATE_ID), TEMPLATE_DIGESTS[LAYA_NOUL_TEMPLATE_ID]);
  assert.equal(layaTemplateDigest(LAYA_CHOICE2_TEMPLATE_ID), TEMPLATE_DIGESTS[LAYA_CHOICE2_TEMPLATE_ID]);
});

const TEMPLATE_DIGESTS: Readonly<Record<string, string>> = {
  [LAYA_NOUL_TEMPLATE_ID]: 'fc39610ab838a51b9f740928a280cb7b6a12c85d11f98a4436a3862ec52978fc',
  [LAYA_CHOICE2_TEMPLATE_ID]: '36b7c018309b476ceb3afc3381dd5514381b36076ec1f656260015ed42c9d01d',
};

// The trees are absolute on the worker's own host: `/a/runtime` on POSIX, `<drive>:\a\runtime` on Windows, where
// `/a/runtime` is not normalised (E2 CI round 1: this data test must pass on Windows too, and named POSIX paths there).
test('E2 Laya worker runtime: a load names two absolute, normalised trees and nothing else', () => {
  const runtimeRoot = resolve('/a', 'runtime');
  const modelDir = resolve('/a', 'model');
  assert.deepEqual(layaLoadPayload({ runtimeRoot, modelDir }), { runtimeRoot, modelDir });
  for (const payload of [
    null,
    { runtimeRoot },
    { runtimeRoot: 'relative', modelDir },
    { runtimeRoot: `${resolve('/a')}${sep}..${sep}runtime`, modelDir },
    { runtimeRoot, modelDir, repo: 'receptron/laya-onnx' },
    { kind: 'test-only-no-runtime' },
  ])
    assert.equal(layaLoadPayload(payload), null);
});

function resetSyntheticRecords(): void {
  const records = globalThis as unknown as Record<string, unknown>;
  records.__layaSyntheticLoads = [];
  records.__layaSyntheticAsks = [];
  records.__layaSyntheticTokenizers = [];
  records.__layaSyntheticClosed = 0;
}

test('E2 worker CPU load: Laya.load gets only the verified model directory and the CPU provider', async () => {
  const tree = await syntheticRuntimeTree();
  try {
    resetSyntheticRecords();
    const runtime = await loadVerifiedLayaRuntime(tree.payload);
    const records = globalThis as unknown as {
      __layaSyntheticLoads: unknown[];
      __layaSyntheticTokenizers: unknown[];
      __layaSyntheticClosed: number;
    };
    assert.deepEqual(records.__layaSyntheticLoads, [{ modelDir: tree.payload.modelDir, executionProviders: ['cpu'] }]);
    assert.deepEqual(layaLoadOptions('/m'), { modelDir: '/m', executionProviders: ['cpu'] });
    assert.deepEqual(records.__layaSyntheticTokenizers, [
      { json: { synthetic: 'tokenizer' }, config: { synthetic: 'config' } },
    ]);
    assert.equal(runtime.countTokens('two words'), 2);
    await runtime.close();
    assert.equal(records.__layaSyntheticClosed, 1);
  } finally {
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('E2 worker CPU load: a model whose context limits are not the reviewed ones is refused before any runtime', async () => {
  for (const config of [
    { max_len: 1024, head_max_len: 192 },
    { max_len: 512, head_max_len: 256 },
    { fixture: 'three' },
  ]) {
    const tree = await syntheticRuntimeTree({ config });
    try {
      resetSyntheticRecords();
      await assert.rejects(loadVerifiedLayaRuntime(tree.payload), /reviewed context limits/u);
      assert.deepEqual((globalThis as unknown as { __layaSyntheticLoads: unknown[] }).__layaSyntheticLoads, []);
    } finally {
      await rm(tree.root, { recursive: true, force: true });
    }
  }
});

test('E2 worker CPU load: a package entry that leaves its verified tree is refused, never followed', async () => {
  for (const manifest of [
    { name: '@huggingface/tokenizers', main: '../../../escape.mjs' },
    { name: '@huggingface/tokenizers', exports: { '.': { import: '/escape.mjs' } } },
    { name: '@huggingface/tokenizers', exports: './dist/../../../../escape.mjs' },
  ]) {
    const tree = await syntheticRuntimeTree({ tokenizersManifest: manifest });
    try {
      resetSyntheticRecords();
      await assert.rejects(loadVerifiedLayaRuntime(tree.payload), /no module entry/u);
      assert.deepEqual((globalThis as unknown as { __layaSyntheticLoads: unknown[] }).__layaSyntheticLoads, []);
    } finally {
      await rm(tree.root, { recursive: true, force: true });
    }
  }
});

test('E2 worker CPU load: the package downloader is unreachable from the adapter', async () => {
  const source = await readFile(workerRuntimeSource, 'utf8');
  const executable = source.replace(/\/\*[\s\S]*?\*\/|^\s*\/\/[^\r\n]*$/gmu, '');
  assert.doesNotMatch(executable, /download/iu, 'the adapter names no download module or function');
  for (const option of ['repo', 'revision', 'token', 'cacheDir', 'onProgress', 'sessionOptions'])
    assert.doesNotMatch(executable, new RegExp(`\\b${option}\\s*:`, 'u'), `the adapter passes no ${option}`);
  assert.equal((executable.match(/\bimport\s*\(/gu) ?? []).length, 1, 'one computed import, of the verified tree');
});

test("E2 Laya worker runtime: phase E's computed-import rule exempts only the verified runtime import", async () => {
  // @ts-expect-error The verifier is a repository executable with no declaration file.
  const { verifyPhaseEJudgeSource } = await import('../../../scripts/verify-events-phase-e-tests.mjs');
  const file = 'packages/events-daemon/src/runtime/laya/worker-runtime.ts';
  const source = await readFile(workerRuntimeSource, 'utf8');
  assert.deepEqual(verifyPhaseEJudgeSource({ file, source }), []);
  const call = ['await import(pathToFileURL(', 'verifiedEntry).href)'].join('');
  assert.ok(source.includes(call), 'the adapter makes exactly the exempted call');
  const refused = (problems: readonly string[]): boolean =>
    problems.some((problem) => problem.endsWith('judge paths must not use computed module specifiers'));
  assert.equal(refused(verifyPhaseEJudgeSource({ file, source: `${source}\nconst again = ${call};\n` })), true);
  assert.equal(
    refused(
      verifyPhaseEJudgeSource({
        file: 'packages/events-daemon/src/runtime/laya/worker-main.ts',
        source: `const loaded = ${call};\n`,
      }),
    ),
    true,
    'the same call in any other file is still refused',
  );
  assert.equal(
    refused(verifyPhaseEJudgeSource({ file, source: `${source}\nconst other = await import(entry);\n` })),
    true,
  );
  assert.equal(refused(verifyPhaseEJudgeSource({ file, source: `${source}\nconst other = require(entry);\n` })), true);
});

const workerMain = fileURLToPath(new URL('../src/runtime/laya/worker-main.ts', import.meta.url));

/** The shipped worker entry, run unconfined: its post-probe protocol is the subject here, not the boundary. */
function workerProcess(cwd: string): {
  readonly child: ChildProcessWithoutNullStreams;
  next(type: string): Promise<Readonly<Record<string, unknown>>>;
  send(frame: Readonly<Record<string, unknown>>): void;
  exited(): Promise<number | null | 'still running'>;
} {
  const child = spawn(process.execPath, ['--experimental-strip-types', workerMain], {
    cwd,
    env: LAYA_WORKER_ENV,
    stdio: ['pipe', 'pipe', 'pipe'],
  }) as ChildProcessWithoutNullStreams;
  child.stderr.on('data', () => undefined);
  const parser = new WorkerFrameParser();
  const frames: Readonly<Record<string, unknown>>[] = [];
  const waiting: (() => void)[] = [];
  child.stdout.on('data', (chunk: Buffer) => {
    frames.push(...parser.push(chunk));
    for (const wake of waiting.splice(0)) wake();
  });
  const exit = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return {
    child,
    async next(type) {
      const deadline = Date.now() + 10_000;
      for (;;) {
        const index = frames.findIndex((frame) => frame.type === type);
        if (index !== -1) return frames.splice(index, 1)[0] as Readonly<Record<string, unknown>>;
        if (Date.now() > deadline) throw new Error(`no ${type} frame`);
        await new Promise<void>((resolve) => {
          waiting.push(resolve);
          setTimeout(resolve, 50);
        });
      }
    },
    send(frame) {
      child.stdin.write(encodeWorkerFrame(frame));
    },
    // Bounded: a worker that accepts a frame it must refuse stays alive, and that must fail the test, not hang it.
    exited: () =>
      Promise.race([
        exit,
        new Promise<'still running'>((resolve) => setTimeout(() => resolve('still running'), 5_000).unref()),
      ]),
  };
}

test('E2 Laya worker runtime: the real worker entry loads only the verified trees and answers each bound request', {
  skip: WINDOWS_SKIP,
}, async () => {
  const tree = await syntheticRuntimeTree({ layaModule: ANSWERING_LAYA });
  const worker = workerProcess(tree.root);
  try {
    const pid = worker.child.pid as number;
    const binding = { nonce: 'n-t8', pid, profile: LAYA_SANDBOX_PROFILE, entry: workerMain, pipeGeneration: 'g-t8' };
    // Closed loopback ports: unconfined, the attempts fail rather than being denied, which the daemon would refuse.
    worker.send({ type: 'probe', ...binding, tcpPort: 9, udpPort: 9, udsPath: join(tree.root, 'absent.sock') });
    assert.equal((await worker.next('probe-result')).nonce, 'n-t8');
    worker.send({ type: 'load', ...binding, payload: tree.payload });
    assert.deepEqual(await worker.next('loaded'), { type: 'loaded', ...binding });
    const input = request('three state words');
    await writeFile(
      join(tree.payload.runtimeRoot, 'node_modules', '@receptron', 'laya', 'dist', 'answer.json'),
      JSON.stringify({ noul: 0.375, inputTokens: expectedTokens(input) }),
    );
    worker.send({ type: 'request', ...binding, requestId: 'req-1', ...input });
    assert.deepEqual(await worker.next('answer'), {
      type: 'answer',
      ...binding,
      requestId: 'req-1',
      value: 0.375,
      inputTokens: expectedTokens(input),
    });
    worker.send({ type: 'request', ...binding, requestId: 'req-2', ...request('w '.repeat(600)) });
    assert.deepEqual(await worker.next('refused'), {
      type: 'refused',
      ...binding,
      requestId: 'req-2',
      code: 'token-limit',
    });
    // A request for another child, or carrying a field the protocol does not have, ends the worker.
    worker.send({ type: 'request', ...binding, nonce: 'another-child', requestId: 'req-3', ...input });
    assert.equal(await worker.exited(), 70);
  } finally {
    worker.child.kill('SIGKILL');
    await rm(tree.root, { recursive: true, force: true });
  }
});

test('E2 Laya worker runtime: the real worker entry refuses a request frame with any field beyond its own', {
  skip: WINDOWS_SKIP,
}, async () => {
  const tree = await syntheticRuntimeTree({ layaModule: ANSWERING_LAYA });
  const worker = workerProcess(tree.root);
  try {
    const pid = worker.child.pid as number;
    const binding = { nonce: 'n-t8', pid, profile: LAYA_SANDBOX_PROFILE, entry: workerMain, pipeGeneration: 'g-t8' };
    worker.send({ type: 'probe', ...binding, tcpPort: 9, udpPort: 9, udsPath: join(tree.root, 'absent.sock') });
    await worker.next('probe-result');
    worker.send({ type: 'load', ...binding, payload: tree.payload });
    await worker.next('loaded');
    worker.send({ type: 'request', ...binding, requestId: 'req-1', accountId: 'ibx_SYNTHETIC', ...request('state') });
    assert.equal(await worker.exited(), 70);
  } finally {
    worker.child.kill('SIGKILL');
    await rm(tree.root, { recursive: true, force: true });
  }
});
