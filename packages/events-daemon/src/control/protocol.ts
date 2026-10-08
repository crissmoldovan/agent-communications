import type { ErrorCode } from '@agentcomms/core';

export const CONTROL_PROTOCOL_VERSIONS: readonly number[] = [1];
export const MAX_CONTROL_FRAME_BYTES: number = 64 * 1024;

export type ControlErrorCode =
  | 'AUTH_REQUIRED'
  | 'DUPLICATE_REQUEST_ID'
  | 'FRAME_TOO_LARGE'
  | 'MALFORMED_FRAME'
  | 'PROTOCOL_UNSUPPORTED';

export interface ControlError {
  /** A protocol code above, or the stable `ErrorCode` an operation failed with. */
  readonly code: ControlErrorCode | ErrorCode;
  readonly message: string;
  readonly hint?: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;
}

export interface ControlSuccess<T = unknown> {
  readonly ok: true;
  readonly requestId?: string;
  readonly data?: T;
  readonly version?: number;
  readonly session?: string;
}

export interface ControlFailure {
  readonly ok: false;
  readonly requestId?: string;
  readonly error: ControlError;
}

export type ControlReply<T = unknown> = ControlSuccess<T> | ControlFailure;

export interface ControlHello {
  readonly hello: {
    readonly supportedVersions: readonly number[];
    readonly token: string;
    readonly client: { readonly name: string };
  };
}

export interface ControlRequest {
  readonly version: number;
  readonly requestId: string;
  readonly session: string;
  readonly operation: string;
  readonly args: Record<string, unknown>;
}

export interface VersionNegotiated {
  readonly ok: true;
  readonly version: number;
}

export interface VersionUnsupported {
  readonly ok: false;
  readonly code: 'PROTOCOL_UNSUPPORTED';
}

export function controlFailure(code: ControlErrorCode, message: string, hint?: string): ControlFailure {
  return { ok: false, error: { code, message, ...(hint === undefined ? {} : { hint }), retryable: false } };
}

export function negotiateVersion(
  clientVersions: readonly number[],
  serverVersions: readonly number[] = CONTROL_PROTOCOL_VERSIONS,
): VersionNegotiated | VersionUnsupported {
  const shared = clientVersions.filter((version) => Number.isSafeInteger(version) && serverVersions.includes(version));
  if (shared.length === 0) return { ok: false, code: 'PROTOCOL_UNSUPPORTED' };
  return { ok: true, version: Math.max(...shared) };
}

function malformed(): Error {
  return new Error('malformed local control frame');
}

export function encodeControlFrame(value: unknown): Uint8Array {
  const payload = new TextEncoder().encode(JSON.stringify(value));
  if (payload.byteLength > MAX_CONTROL_FRAME_BYTES) throw new Error('local control frame is too large');
  const frame = new Uint8Array(4 + payload.byteLength);
  new DataView(frame.buffer).setUint32(0, payload.byteLength, false);
  frame.set(payload, 4);
  return frame;
}

/** Decodes exactly one complete length-prefixed control frame. */
export function decodeControlFrame(frame: Uint8Array): unknown {
  if (frame.byteLength < 4) throw malformed();
  const length = new DataView(frame.buffer, frame.byteOffset, frame.byteLength).getUint32(0, false);
  if (length > MAX_CONTROL_FRAME_BYTES) throw new Error('local control frame is too large');
  if (frame.byteLength !== length + 4) throw malformed();
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(frame.subarray(4)));
  } catch {
    throw malformed();
  }
}

/** Incrementally separates complete frames without buffering an unbounded peer payload. */
export class ControlFrameReader {
  #buffer: Uint8Array<ArrayBufferLike> = new Uint8Array();

  push(chunk: Uint8Array): unknown[] {
    let buffered = this.#buffer;
    let offset = 0;
    const values: unknown[] = [];
    while (offset < chunk.byteLength || buffered.byteLength >= 4) {
      if (buffered.byteLength < 4) {
        const remainingHeader = 4 - buffered.byteLength;
        const take = Math.min(remainingHeader, chunk.byteLength - offset);
        buffered = append(buffered, chunk.subarray(offset, offset + take));
        offset += take;
        if (buffered.byteLength < 4) break;
      }
      const length = new DataView(buffered.buffer, buffered.byteOffset, buffered.byteLength).getUint32(0, false);
      if (length > MAX_CONTROL_FRAME_BYTES) throw new Error('local control frame is too large');
      const frameLength = length + 4;
      if (buffered.byteLength < frameLength) {
        const take = Math.min(frameLength - buffered.byteLength, chunk.byteLength - offset);
        buffered = append(buffered, chunk.subarray(offset, offset + take));
        offset += take;
        if (buffered.byteLength < frameLength) break;
      }
      values.push(decodeControlFrame(buffered.subarray(0, frameLength)));
      buffered = buffered.subarray(frameLength);
    }
    this.#buffer = buffered.slice();
    return values;
  }
}

function append(first: Uint8Array<ArrayBufferLike>, second: Uint8Array<ArrayBufferLike>): Uint8Array<ArrayBufferLike> {
  const joined = new Uint8Array(first.byteLength + second.byteLength);
  joined.set(first);
  joined.set(second, first.byteLength);
  return joined;
}

export function isControlHello(value: unknown): value is ControlHello {
  if (!isRecord(value) || !isRecord(value.hello)) return false;
  const { supportedVersions, token, client } = value.hello;
  return (
    Array.isArray(supportedVersions) &&
    supportedVersions.length > 0 &&
    supportedVersions.length <= 8 &&
    supportedVersions.every((version) => Number.isSafeInteger(version)) &&
    typeof token === 'string' &&
    token.length === 64 &&
    isRecord(client) &&
    typeof client.name === 'string' &&
    client.name.length > 0 &&
    client.name.length <= 128
  );
}

export function isControlRequest(value: unknown): value is ControlRequest {
  if (!isRecord(value)) return false;
  return (
    Number.isSafeInteger(value.version) &&
    typeof value.requestId === 'string' &&
    value.requestId.length > 0 &&
    value.requestId.length <= 128 &&
    typeof value.session === 'string' &&
    value.session.length > 0 &&
    value.session.length <= 256 &&
    typeof value.operation === 'string' &&
    value.operation.length > 0 &&
    value.operation.length <= 128 &&
    isRecord(value.args)
  );
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
