import { createHash } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { installErrorSink } from '../network/error-sink.ts';

/**
 * A push-only RFC 6455 server endpoint, with no library (workflows design W31): the event service has no runtime
 * dependency outside the workspace. The listener has already checked the request's Host, path, query, cookie, Origin
 * and bearer; this does the handshake and the framing:
 * - each message out is one unmasked, unfragmented text frame;
 * - a client may send only ping, pong and close, each at most 125 bytes and masked. A data frame closes with 1008, a
 *   frame over 125 bytes with 1009, and anything malformed — unmasked, fragmented, reserved bits — with 1002;
 * - the server pings every 30 seconds and closes with 4408 when no pong comes within 60;
 * - no extension is ever negotiated, so no `permessage-deflate`.
 */

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const OPCODE_TEXT = 0x1;
const OPCODE_CLOSE = 0x8;
const OPCODE_PING = 0x9;
const OPCODE_PONG = 0xa;
const CONTROL_MAX = 125;

/** The only subprotocol the listener ever answers with: never a bearer, never a cursor. */
export const WEBSOCKET_PROTOCOL = 'agentcomms.events.v1';

/** The close codes this endpoint uses (W31): normal, policy, protocol, too big, the token's end, a lost pong. */
export const WEBSOCKET_CLOSE: Readonly<{
  normal: 1000;
  protocol: 1002;
  policy: 1008;
  tooBig: 1009;
  unauthorised: 4401;
  noPong: 4408;
}> = Object.freeze({ normal: 1000, protocol: 1002, policy: 1008, tooBig: 1009, unauthorised: 4401, noPong: 4408 });

export interface WebSocketPush {
  /** One text message: the bytes as they are. Nothing is sent once the socket is closing. */
  send(text: string): void;
  /** Sends a close frame with this code and ends the connection. */
  close(code: number): void;
  onClose(listener: (code: number) => void): void;
  readonly closed: boolean;
}

export interface WebSocketTiming {
  readonly pingMs?: number | undefined;
  readonly pongTimeoutMs?: number | undefined;
}

/** `Sec-WebSocket-Accept`: base64 of SHA-1 of the client's key and RFC 6455's GUID. */
export function websocketAccept(key: string): string {
  return createHash('sha1').update(`${key}${GUID}`).digest('base64');
}

/** The subprotocols a client offered, in order. */
export function offeredProtocols(request: IncomingMessage): readonly string[] {
  const header = request.headers['sec-websocket-protocol'];
  const value = Array.isArray(header) ? header.join(',') : (header ?? '');
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function frame(opcode: number, payload: Buffer): Buffer {
  const length = payload.byteLength;
  const head =
    length < 126
      ? Buffer.from([0x80 | opcode, length])
      : length < 65_536
        ? Buffer.from([0x80 | opcode, 126, length >> 8, length & 0xff])
        : (() => {
            const header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(length), 2);
            return header;
          })();
  return Buffer.concat([head, payload]);
}

function closePayload(code: number): Buffer {
  const payload = Buffer.alloc(2);
  payload.writeUInt16BE(code, 0);
  return payload;
}

/** Whether a request is a WebSocket handshake this endpoint can answer: version 13, a 16-byte key, an Upgrade. */
export function isWebSocketHandshake(request: IncomingMessage): boolean {
  const upgrade = request.headers.upgrade;
  const connection = request.headers.connection ?? '';
  const key = request.headers['sec-websocket-key'];
  return (
    request.method === 'GET' &&
    typeof upgrade === 'string' &&
    upgrade.toLowerCase() === 'websocket' &&
    connection
      .toLowerCase()
      .split(',')
      .some((entry) => entry.trim() === 'upgrade') &&
    request.headers['sec-websocket-version'] === '13' &&
    typeof key === 'string' &&
    Buffer.from(key, 'base64').byteLength === 16
  );
}

/** Refuses a handshake before it is accepted, with a bare HTTP status, and ends the socket. */
export function refuseWebSocket(socket: Duplex, status: 400 | 403 | 404): void {
  const reason = status === 400 ? 'Bad Request' : status === 403 ? 'Forbidden' : 'Not Found';
  // An upgraded socket is no longer read by the HTTP server: once the answer is flushed it is destroyed, so a peer
  // that keeps it open cannot hold the listener's close.
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    () => socket.destroy(),
  );
}

/**
 * Completes the handshake for a request the listener has already authorised, answering the subprotocol
 * `agentcomms.events.v1` when the client offered it, and returns the push endpoint; null, with the socket ended, for
 * a request that is not a valid version-13 handshake.
 */
export function acceptWebSocket(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  timing: WebSocketTiming = {},
): WebSocketPush | null {
  if (!isWebSocketHandshake(request)) {
    refuseWebSocket(socket, 400);
    return null;
  }
  installErrorSink(socket as never);
  const key = request.headers['sec-websocket-key'] as string;
  const protocol = offeredProtocols(request).includes(WEBSOCKET_PROTOCOL) ? WEBSOCKET_PROTOCOL : undefined;
  socket.write(
    [
      'HTTP/1.1 101 Switching Protocols',
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      ...(protocol === undefined ? [] : [`Sec-WebSocket-Protocol: ${protocol}`]),
      '',
      '',
    ].join('\r\n'),
  );
  return new PushSocket(socket, head, timing);
}

class PushSocket implements WebSocketPush {
  readonly #socket: Duplex;
  readonly #listeners: Array<(code: number) => void> = [];
  readonly #pingTimer: NodeJS.Timeout;
  readonly #pongTimeoutMs: number;
  #buffer: Buffer = Buffer.alloc(0);
  #lastPong: number = Date.now();
  #closed = false;
  #code = 1006;

  constructor(socket: Duplex, head: Buffer, timing: WebSocketTiming) {
    this.#socket = socket;
    this.#pongTimeoutMs = timing.pongTimeoutMs ?? 60_000;
    socket.on('data', (chunk: Buffer) => this.#receive(chunk));
    socket.once('close', () => this.#finish(this.#code));
    // The HTTP server's sockets are half-open: a peer that goes away leaves ours open until it is destroyed here.
    socket.once('end', () => {
      this.#finish(this.#code);
      socket.destroy();
    });
    this.#pingTimer = setInterval(() => {
      if (Date.now() - this.#lastPong > this.#pongTimeoutMs) {
        this.close(WEBSOCKET_CLOSE.noPong);
        return;
      }
      this.#write(frame(OPCODE_PING, Buffer.alloc(0)));
    }, timing.pingMs ?? 30_000);
    this.#pingTimer.unref();
    if (head.byteLength > 0) this.#receive(head);
  }

  get closed(): boolean {
    return this.#closed;
  }

  send(text: string): void {
    if (this.#closed) return;
    this.#write(frame(OPCODE_TEXT, Buffer.from(text, 'utf8')));
  }

  close(code: number): void {
    if (this.#closed) return;
    this.#code = code;
    this.#write(frame(OPCODE_CLOSE, closePayload(code)));
    this.#finish(code);
    this.#socket.end();
    // A peer that never answers the close does not keep the socket, nor the listener's own close waiting for it.
    setTimeout(() => this.#socket.destroy(), 250);
  }

  onClose(listener: (code: number) => void): void {
    if (this.#closed) listener(this.#code);
    else this.#listeners.push(listener);
  }

  #write(bytes: Buffer): void {
    if (!this.#socket.writable) return;
    this.#socket.write(bytes);
  }

  #finish(code: number): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#code = code;
    clearInterval(this.#pingTimer);
    for (const listener of this.#listeners.splice(0)) listener(code);
  }

  #receive(chunk: Buffer): void {
    if (this.#closed) return;
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    while (!this.#closed && this.#buffer.byteLength >= 2) {
      const first = this.#buffer[0] as number;
      const second = this.#buffer[1] as number;
      const fin = (first & 0x80) !== 0;
      const reserved = first & 0x70;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      const length7 = second & 0x7f;
      // Anything longer than a control frame's 125 bytes is too big for this endpoint, whatever it carries.
      if (length7 > CONTROL_MAX) {
        this.close(WEBSOCKET_CLOSE.tooBig);
        return;
      }
      if (reserved !== 0 || !masked) {
        this.close(WEBSOCKET_CLOSE.protocol);
        return;
      }
      if (opcode !== OPCODE_PING && opcode !== OPCODE_PONG && opcode !== OPCODE_CLOSE) {
        // A data frame — text, binary, or a continuation — is not one this push-only endpoint accepts.
        this.close(WEBSOCKET_CLOSE.policy);
        return;
      }
      if (!fin) {
        this.close(WEBSOCKET_CLOSE.protocol);
        return;
      }
      const total = 2 + 4 + length7;
      if (this.#buffer.byteLength < total) return;
      const mask = this.#buffer.subarray(2, 6);
      const payload = Buffer.from(this.#buffer.subarray(6, total));
      for (let index = 0; index < payload.byteLength; index += 1)
        payload[index] = (payload[index] as number) ^ (mask[index % 4] as number);
      this.#buffer = this.#buffer.subarray(total);
      if (opcode === OPCODE_PING) this.#write(frame(OPCODE_PONG, payload));
      else if (opcode === OPCODE_PONG) this.#lastPong = Date.now();
      else {
        // The client's close: answered with its own code (or normal), and the connection ends.
        const code = payload.byteLength >= 2 ? payload.readUInt16BE(0) : WEBSOCKET_CLOSE.normal;
        this.close(code);
        return;
      }
    }
  }
}
