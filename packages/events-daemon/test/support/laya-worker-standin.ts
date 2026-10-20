import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { WorkerFrameParser, writeWorkerFrame } from '../../src/runtime/laya/worker-protocol.ts';

/**
 * How long after its all-denied report a `late-*` stand-in makes its escape: well inside the daemon's 150 ms window,
 * so a loaded runner cannot push it past the window, and after the report, so a window of 0 ms would miss it.
 */
const LATE_AFTER_REPORT_MS = 30;

const standinArgument = process.argv.indexOf('--standin');
const mode = standinArgument === -1 ? 'forged' : process.argv[standinArgument + 1];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * E2 Task 8: after a proof, `--serve <behaviour>` makes this a frame-compatible stand-in for the worker's load and
 * request protocol. It never imports a runtime or model: it answers with the synthetic value it was given.
 */
const serve = argument('--serve');
const valueJson = argument('--value-json') ?? '0.75';
const inputTokens = Number(argument('--tokens') ?? '37');
const delayMs = Number(argument('--delay') ?? '0');

function bindingOf(frame: Readonly<Record<string, unknown>>) {
  return {
    nonce: frame.nonce,
    pid: frame.pid,
    profile: frame.profile,
    entry: frame.entry,
    pipeGeneration: frame.pipeGeneration,
  };
}

/** Writes one frame from raw JSON text, so a reply can carry a value JSON can parse but not produce (`1e309`). */
function writeRaw(json: string): void {
  const payload = Buffer.from(json, 'utf8');
  const frame = Buffer.alloc(4 + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, 4);
  process.stdout.write(frame);
}

let served = 0;
function answerRequest(frame: Readonly<Record<string, unknown>>): void {
  served += 1;
  const binding = serve === 'wrong-binding' ? { ...bindingOf(frame), nonce: 'another-child' } : bindingOf(frame);
  const requestId = serve === 'wrong-request-id' ? 'another-request' : frame.requestId;
  const head = JSON.stringify({ type: 'answer', ...binding, requestId, inputTokens }).slice(0, -1);
  const reply = (): void => {
    if (serve === 'token-limit' || serve === 'malformed-refusal' || serve === 'template-blocked') {
      const code = serve === 'malformed-refusal' ? 'malformed' : serve;
      void writeWorkerFrame(process.stdout, { type: 'refused', ...binding, requestId: frame.requestId, code });
      return;
    }
    if (serve === 'extra-field') {
      writeRaw(`${head},"value":${valueJson},"reason":"provider says match"}`);
      return;
    }
    writeRaw(`${head},"value":${valueJson}}`);
    if (serve === 'extra-frame') void writeWorkerFrame(process.stdout, { type: 'answer', ...binding, requestId });
  };
  if (serve === 'hang' || (serve === 'hang-second' && served === 2)) return;
  if (serve === 'crash' || (serve === 'crash-first' && served === 1)) process.exit(3);
  if (serve === 'late' || serve === 'slow') setTimeout(reply, delayMs);
  else reply();
}

const parser = new WorkerFrameParser();
process.stdin.on('data', (chunk: Buffer) => {
  for (const frame of parser.push(chunk)) {
    if (frame.type === 'request' && serve !== undefined) {
      answerRequest(frame);
      continue;
    }
    // A frame-compatible stand-in answers a load on its original pipes, so a test can prove those pipes stayed live.
    if (frame.type === 'load') {
      if (serve === undefined) {
        void writeWorkerFrame(process.stdout, { type: 'load-ack', nonce: frame.nonce });
        continue;
      }
      if (serve === 'hang-load') continue;
      if (serve === 'refuse-load') {
        void writeWorkerFrame(process.stdout, { type: 'load-refused', ...bindingOf(frame), code: 'runtime-failed' });
        continue;
      }
      void writeWorkerFrame(process.stdout, { type: 'loaded', ...bindingOf(frame) });
      if (serve === 'late-probe-attempt')
        setTimeout(
          () =>
            void writeWorkerFrame(process.stdout, {
              type: 'probe-attempt',
              ...bindingOf(frame),
              attempt: 'tcp',
              outcome: 'escaped',
            }),
          Math.max(delayMs, 1),
        );
      continue;
    }
    if (frame.type !== 'probe') continue;
    if (mode === 'silence') continue;
    // Untrusted runtime chatter on stderr: the daemon must neither keep it nor stall on it.
    if (mode === 'stderr-flood') process.stderr.write(`${'laya-stderr-secret '.repeat(64)}\n`.repeat(1024));
    // A child that reaches the daemon's real listeners and still claims every attempt was denied.
    const sneak = async (): Promise<void> => {
      if (mode === 'tcp-sneak' || mode === 'uds-sneak') {
        await new Promise<void>((resolve) => {
          const socket =
            mode === 'tcp-sneak' ? connect(Number(frame.tcpPort), '127.0.0.1') : connect(String(frame.udsPath));
          socket.once('connect', () => {
            socket.destroy();
            resolve();
          });
          socket.once('error', () => resolve());
        });
      }
      if (mode === 'udp-sneak') {
        await new Promise<void>((resolve) => {
          const socket = createSocket('udp4');
          socket.once('error', () => resolve());
          socket.send(Buffer.from([0]), Number(frame.udpPort), '127.0.0.1', () => {
            socket.close();
            resolve();
          });
        });
      }
    };
    const report = async () => {
      await sneak();
      const binding = {
        nonce: frame.nonce,
        pid: process.pid,
        profile: frame.profile,
        entry: frame.entry,
        pipeGeneration: frame.pipeGeneration,
      };
      if (mode === 'malformed-frame') {
        const payload = Buffer.from('{', 'utf8');
        const malformed = Buffer.alloc(4 + payload.length);
        malformed.writeUInt32BE(payload.length, 0);
        payload.copy(malformed, 4);
        process.stdout.write(malformed);
        return;
      }
      if (mode === 'unrecognised-frame')
        await writeWorkerFrame(process.stdout, { type: 'probe-unrecognised', ...binding });
      if (mode === 'mismatched-binding') {
        await writeWorkerFrame(process.stdout, {
          type: 'probe-result',
          ...binding,
          nonce: 'mismatched-binding',
          tcp: 'denied',
          fetch: 'denied',
          udp: 'denied',
          uds: 'denied',
          spawn: 'denied',
        });
      }
      const attempts =
        mode === 'out-of-order-attempts'
          ? (['fetch', 'tcp', 'udp', 'uds', 'spawn'] as const)
          : (['tcp', 'fetch', 'udp', 'uds', 'spawn'] as const);
      if (mode !== undefined && mode !== 'forged') {
        for (const attempt of attempts) {
          await writeWorkerFrame(process.stdout, {
            type: 'probe-attempt',
            ...binding,
            attempt,
            outcome: mode === attempt ? 'escaped' : 'denied',
          });
        }
      }
      await writeWorkerFrame(process.stdout, {
        type: 'probe-result',
        ...binding,
        tcp: mode === 'tcp' ? 'escaped' : 'denied',
        fetch: mode === 'fetch' ? 'escaped' : 'denied',
        udp: mode === 'udp' ? 'escaped' : 'denied',
        uds: mode === 'uds' ? 'escaped' : 'denied',
        spawn: mode === 'spawn' ? 'escaped' : 'denied',
      });
      if (mode === 'extra-frame') await writeWorkerFrame(process.stdout, { type: 'probe-extra', ...binding });
      if (mode === 'late-tcp') {
        setTimeout(() => {
          const socket = connect(Number(frame.tcpPort), '127.0.0.1');
          socket.on('error', () => undefined);
          socket.on('connect', () => socket.destroy());
        }, LATE_AFTER_REPORT_MS);
      }
      if (mode === 'late-report') {
        setTimeout(() => {
          void writeWorkerFrame(process.stdout, {
            type: 'probe-attempt',
            ...binding,
            attempt: 'tcp',
            outcome: 'escaped',
          });
        }, LATE_AFTER_REPORT_MS);
      }
    };
    if (mode === 'delayed-denied') setTimeout(() => void report(), 1000);
    else void report();
  }
});
