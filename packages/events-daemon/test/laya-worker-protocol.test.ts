import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createWorkerProbeId,
  createWorkerRequestId,
  encodeWorkerFrame,
  LayaWorkerProtocolError,
  WORKER_FRAME_MAX_BYTES,
  WorkerFrameParser,
} from '../src/runtime/laya/worker-protocol.ts';

test('laya worker protocol: length-prefixed frames survive arbitrary pipe chunking', () => {
  const parser = new WorkerFrameParser();
  const first = encodeWorkerFrame({ type: 'probe', probeId: 'probe-a' });
  const second = encodeWorkerFrame({ type: 'load', requestId: 'request-a' });
  const combined = Buffer.concat([first, second]);
  const frames: unknown[] = [];
  for (let offset = 0; offset < combined.length; offset += 3)
    frames.push(...parser.push(combined.subarray(offset, offset + 3)));
  assert.deepEqual(frames, [
    { type: 'probe', probeId: 'probe-a' },
    { type: 'load', requestId: 'request-a' },
  ]);
  parser.finish();
});

test('laya worker protocol: refuses malformed, non-object, trailing and oversized frames before dispatch', () => {
  const parser = new WorkerFrameParser();
  const nonObject = Buffer.from('["not-an-object"]', 'utf8');
  const malformed = Buffer.from('{', 'utf8');
  const trailing = Buffer.from('{"type":"probe"} x', 'utf8');
  for (const payload of [nonObject, malformed, trailing]) {
    const bytes = Buffer.allocUnsafe(4 + payload.length);
    bytes.writeUInt32BE(payload.length, 0);
    payload.copy(bytes, 4);
    assert.throws(
      () => parser.push(bytes),
      (error: unknown) => error instanceof LayaWorkerProtocolError,
    );
  }
  const oversized = Buffer.alloc(4);
  oversized.writeUInt32BE(WORKER_FRAME_MAX_BYTES + 1, 0);
  assert.throws(
    () => new WorkerFrameParser().push(oversized),
    (error: unknown) => error instanceof LayaWorkerProtocolError && error.code === 'FRAME_SIZE',
  );
});

test('laya worker protocol: does not accept a truncated frame at end of pipe', () => {
  const parser = new WorkerFrameParser();
  const encoded = encodeWorkerFrame({ type: 'probe', probeId: 'probe-a' });
  parser.push(encoded.subarray(0, encoded.length - 1));
  assert.throws(
    () => parser.finish(),
    (error: unknown) => error instanceof LayaWorkerProtocolError && error.code === 'FRAME_TRUNCATED',
  );
});

test('laya worker protocol: request and probe identities are fresh opaque UUIDs', () => {
  const request = createWorkerRequestId();
  const probe = createWorkerProbeId();
  assert.match(request, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.match(probe, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.notEqual(request, probe);
});
