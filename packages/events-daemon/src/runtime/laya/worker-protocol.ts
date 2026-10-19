import { randomUUID } from 'node:crypto';

/** A worker pipe never carries a request directly: only bounded JSON objects are valid frames. */
export type WorkerFrame = Readonly<Record<string, unknown>>;

export const WORKER_FRAME_MAX_BYTES: number = 64 * 1024;
const FRAME_PREFIX_BYTES = 4;

export class LayaWorkerProtocolError extends Error {
  readonly code: 'FRAME_SIZE' | 'FRAME_JSON' | 'FRAME_SHAPE' | 'FRAME_TRUNCATED';

  constructor(code: LayaWorkerProtocolError['code']) {
    super(code);
    this.name = 'LayaWorkerProtocolError';
    this.code = code;
  }
}

function frameObject(value: unknown): WorkerFrame {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new LayaWorkerProtocolError('FRAME_SHAPE');
  return value as WorkerFrame;
}

function jsonFrame(value: unknown): Buffer {
  let encoded: string;
  try {
    encoded = JSON.stringify(frameObject(value));
  } catch {
    throw new LayaWorkerProtocolError('FRAME_JSON');
  }
  if (encoded === undefined) throw new LayaWorkerProtocolError('FRAME_JSON');
  const payload = Buffer.from(encoded, 'utf8');
  if (payload.length === 0 || payload.length > WORKER_FRAME_MAX_BYTES) throw new LayaWorkerProtocolError('FRAME_SIZE');
  return payload;
}

/** Encodes one exact big-endian length-prefixed JSON object. */
export function encodeWorkerFrame(value: WorkerFrame): Buffer {
  const payload = jsonFrame(value);
  const frame = Buffer.allocUnsafe(FRAME_PREFIX_BYTES + payload.length);
  frame.writeUInt32BE(payload.length, 0);
  payload.copy(frame, FRAME_PREFIX_BYTES);
  return frame;
}

/** Incrementally parses pipes without allocating for an attacker-controlled advertised frame size. */
export class WorkerFrameParser {
  #buffer = Buffer.alloc(0);

  push(chunk: Uint8Array): readonly WorkerFrame[] {
    if (chunk.length === 0) return [];
    this.#buffer = Buffer.concat([this.#buffer, Buffer.from(chunk)]);
    const frames: WorkerFrame[] = [];
    while (this.#buffer.length >= FRAME_PREFIX_BYTES) {
      const length = this.#buffer.readUInt32BE(0);
      if (length === 0 || length > WORKER_FRAME_MAX_BYTES) throw new LayaWorkerProtocolError('FRAME_SIZE');
      const end = FRAME_PREFIX_BYTES + length;
      if (this.#buffer.length < end) break;
      const payload = this.#buffer.subarray(FRAME_PREFIX_BYTES, end);
      this.#buffer = this.#buffer.subarray(end);
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
      } catch {
        throw new LayaWorkerProtocolError('FRAME_JSON');
      }
      frames.push(frameObject(parsed));
    }
    return frames;
  }

  finish(): void {
    if (this.#buffer.length !== 0) throw new LayaWorkerProtocolError('FRAME_TRUNCATED');
  }
}

export function createWorkerRequestId(): string {
  return randomUUID();
}

export function createWorkerProbeId(): string {
  return randomUUID();
}

/** Writes one complete bounded frame and honours pipe backpressure. */
export async function writeWorkerFrame(destination: import('node:stream').Writable, frame: WorkerFrame): Promise<void> {
  if (destination.write(encodeWorkerFrame(frame))) return;
  await new Promise<void>((resolve, reject) => {
    const drained = (): void => {
      destination.off('error', failed);
      resolve();
    };
    const failed = (error: Error): void => {
      destination.off('drain', drained);
      reject(error);
    };
    destination.once('drain', drained);
    destination.once('error', failed);
  });
}
