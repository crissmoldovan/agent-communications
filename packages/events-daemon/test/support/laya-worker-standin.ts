import { createSocket } from 'node:dgram';
import { connect } from 'node:net';
import { WorkerFrameParser, writeWorkerFrame } from '../../src/runtime/laya/worker-protocol.ts';

const standinArgument = process.argv.indexOf('--standin');
const mode = standinArgument === -1 ? 'forged' : process.argv[standinArgument + 1];
const parser = new WorkerFrameParser();
process.stdin.on('data', (chunk: Buffer) => {
  for (const frame of parser.push(chunk)) {
    // A frame-compatible stand-in answers a load on its original pipes, so a test can prove those pipes stayed live.
    if (frame.type === 'load') {
      void writeWorkerFrame(process.stdout, { type: 'load-ack', nonce: frame.nonce });
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
        });
      }
      const attempts =
        mode === 'out-of-order-attempts'
          ? (['fetch', 'tcp', 'udp', 'uds'] as const)
          : (['tcp', 'fetch', 'udp', 'uds'] as const);
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
      });
      if (mode === 'extra-frame') await writeWorkerFrame(process.stdout, { type: 'probe-extra', ...binding });
      if (mode === 'late-tcp') {
        setTimeout(() => {
          const socket = connect(Number(frame.tcpPort), '127.0.0.1');
          socket.on('error', () => undefined);
          socket.on('connect', () => socket.destroy());
        }, 75);
      }
      if (mode === 'late-report') {
        setTimeout(() => {
          void writeWorkerFrame(process.stdout, {
            type: 'probe-attempt',
            ...binding,
            attempt: 'tcp',
            outcome: 'escaped',
          });
        }, 75);
      }
    };
    if (mode === 'delayed-denied') setTimeout(() => void report(), 1000);
    else void report();
  }
});
