import type net from 'node:net';
import type tls from 'node:tls';
import {
  ANALYSE_CALL_DEADLINE_MS,
  ANALYSE_MAX_REQUEST_BYTES,
  ANALYSE_MAX_RESPONSE_BYTES,
  type AnalyseCallRefusal,
  type AnalyseRoute,
  type AnalyseWireRequest,
  readAnalyseResponse,
  refusalForStatus,
} from '../domain/analyse-model.ts';
import { AddressPolicyError } from '../network/address-policy.ts';
import {
  connectPinnedTcp,
  connectPinnedTls,
  type PinnedConnection,
  type PinnedTcpOptions,
  type PinnedTlsOptions,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
} from '../network/pinned-connection.ts';
import type { AddressResolver } from '../network/resolver.ts';

/**
 * Analyse's one network path to its model (0.33.0 design §3.3), on the judges' pattern: the request's exact bytes are
 * built and bounded before any DNS lookup; the provider's fixed hostname resolves through the pinned, global-only path
 * that admits Analyse's two endpoints and nothing else; TCP and TLS go to the vetted address with the certificate
 * checked for that hostname; the response is read under a byte ceiling and one deadline for the whole call; nothing
 * follows a redirect, and there is no other socket, agent or proxy. A refusal is a closed word, never provider text.
 */

export type AnalyseCallResult =
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'refused'; readonly code: AnalyseCallRefusal };

export interface AnalyseTransportClock {
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface AnalyseTransportOptions {
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  readonly clock?: AnalyseTransportClock | undefined;
  readonly deadlineMs?: number | undefined;
}

class DeadlineExceeded extends Error {}
class ResponseTooLarge extends Error {}

const systemClock: AnalyseTransportClock = {
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

/** The request's exact bytes, from the fixed endpoint alone, so they are bounded before anything is resolved. */
export function analyseRequestBytes(route: AnalyseRoute, request: AnalyseWireRequest): Buffer {
  const url = new URL(route.endpoint);
  const connection: PinnedConnection = {
    url,
    hostname: url.hostname,
    address: url.hostname,
    port: 443,
    useTls: true,
    hostHeader: url.hostname,
    tls: { rejectUnauthorized: true, servername: url.hostname, certificateHost: url.hostname },
  };
  return requestBytesForPinnedConnection(connection, 'POST', request.body, request.headers);
}

interface HttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bodyStart: number;
}

function readHead(bytes: Buffer): HttpHead | null | 'incomplete' {
  const boundary = bytes.indexOf('\r\n\r\n');
  if (boundary === -1) return 'incomplete';
  const lines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?$/u.exec(lines[0] ?? '');
  if (status?.[1] === undefined) return null;
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon < 1) return null;
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    // A repeated framing header could be read two ways; it is refused rather than guessed.
    if ((name === 'content-length' || name === 'transfer-encoding') && headers.has(name)) return null;
    headers.set(name, value);
  }
  return { status: Number(status[1]), headers, bodyStart: boundary + 4 };
}

/** A chunked body, decoded; `incomplete` until its last chunk, and null when it is not one. */
function dechunk(bytes: Buffer): Buffer | null | 'incomplete' {
  const parts: Buffer[] = [];
  let at = 0;
  for (;;) {
    const lineEnd = bytes.indexOf('\r\n', at);
    if (lineEnd === -1) return 'incomplete';
    const size = /^([0-9A-Fa-f]{1,8})(?:;[^\r\n]*)?$/u.exec(bytes.subarray(at, lineEnd).toString('latin1'));
    if (size?.[1] === undefined) return null;
    const length = Number.parseInt(size[1], 16);
    at = lineEnd + 2;
    if (length === 0) return Buffer.concat(parts);
    if (bytes.byteLength < at + length + 2) return 'incomplete';
    parts.push(bytes.subarray(at, at + length));
    if (bytes.subarray(at + length, at + length + 2).toString('latin1') !== '\r\n') return null;
    at += length + 2;
  }
}

/**
 * One HTTP/1.1 response read strictly: its status and its body, framed by a Content-Length, by chunks, or by the
 * connection's close. `incomplete` while more bytes are needed; null when the bytes are not one well-framed response.
 */
export function readHttpResponse(
  bytes: Buffer,
  closed: boolean,
): { readonly status: number; readonly body: Buffer } | null | 'incomplete' {
  const head = readHead(bytes);
  if (head === null) return null;
  if (head === 'incomplete') return closed ? null : 'incomplete';
  const rest = bytes.subarray(head.bodyStart);
  const encoding = head.headers.get('transfer-encoding');
  const length = head.headers.get('content-length');
  if (encoding !== undefined && length !== undefined) return null;
  if (encoding !== undefined) {
    if (encoding.toLowerCase() !== 'chunked') return null;
    const body = dechunk(rest);
    if (body === 'incomplete') return closed ? null : 'incomplete';
    return body === null ? null : { status: head.status, body };
  }
  if (length !== undefined) {
    if (!/^[0-9]{1,9}$/u.test(length)) return null;
    const expected = Number(length);
    if (rest.byteLength < expected) return closed ? null : 'incomplete';
    return { status: head.status, body: rest.subarray(0, expected) };
  }
  return closed ? { status: head.status, body: rest } : 'incomplete';
}

/** Reads one response under the byte ceiling, until it is complete or the peer closes; the socket is the caller's. */
function readBounded(
  socket: net.Socket | tls.TLSSocket,
  signal: AbortSignal,
): Promise<{ readonly status: number; readonly body: Buffer } | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const settle = (work: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      work();
    };
    const onAbort = () => settle(() => reject(new DeadlineExceeded()));
    const check = (closed: boolean) => {
      const read = readHttpResponse(Buffer.concat(chunks), closed);
      if (read === 'incomplete') return;
      settle(() => resolve(read));
    };
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener('abort', onAbort, { once: true });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > ANALYSE_MAX_RESPONSE_BYTES) {
        settle(() => reject(new ResponseTooLarge()));
        return;
      }
      chunks.push(Buffer.from(chunk));
      check(false);
    });
    socket.once('end', () => check(true));
    socket.once('close', () => check(true));
    socket.once('error', (error: Error) => settle(() => reject(error)));
  });
}

function refused(code: AnalyseCallRefusal): AnalyseCallResult {
  return { kind: 'refused', code };
}

export class AnalyseTransport {
  readonly #resolver: AddressResolver | undefined;
  readonly #tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly #tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly #clock: AnalyseTransportClock;
  readonly #deadlineMs: number;

  constructor(options: AnalyseTransportOptions = {}) {
    this.#resolver = options.resolver;
    this.#tcpConnect = options.tcpConnect ?? connectPinnedTcp;
    this.#tlsConnect = options.tlsConnect ?? connectPinnedTls;
    this.#clock = options.clock ?? systemClock;
    this.#deadlineMs = options.deadlineMs ?? ANALYSE_CALL_DEADLINE_MS;
  }

  /** One call: the prepared request to the route's fixed endpoint, and the model's text or a closed refusal. */
  async call(route: AnalyseRoute, request: AnalyseWireRequest, signal?: AbortSignal): Promise<AnalyseCallResult> {
    const bytes = analyseRequestBytes(route, request);
    if (bytes.byteLength > ANALYSE_MAX_REQUEST_BYTES) return refused('REQUEST_TOO_LARGE');
    const deadline = new AbortController();
    const timer = this.#clock.setTimeout(() => deadline.abort(new DeadlineExceeded()), this.#deadlineMs);
    // The person who asked going away (the control request's own signal) ends the call as its deadline does.
    const onGone = () => deadline.abort(new DeadlineExceeded());
    if (signal?.aborted === true) onGone();
    else signal?.addEventListener('abort', onGone, { once: true });
    let socket: net.Socket | tls.TLSSocket | undefined;
    try {
      const connection = await preparePinnedConnection({
        url: route.endpoint,
        addressMode: 'global-only',
        hostedPurpose: 'analyse',
        signal: deadline.signal,
        ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
      });
      if (deadline.signal.aborted) throw new DeadlineExceeded();
      const tcp = await this.#tcpConnect({ host: connection.address, port: connection.port, signal: deadline.signal });
      socket = tcp;
      if (deadline.signal.aborted) throw new DeadlineExceeded();
      socket = await this.#tlsConnect({ socket: tcp, ...connection.tls, signal: deadline.signal });
      if (deadline.signal.aborted) throw new DeadlineExceeded();
      const response = readBounded(socket, deadline.signal);
      socket.write(bytes);
      const read = await response;
      if (read === null) return refused('RESPONSE_MALFORMED');
      if (read.status < 200 || read.status > 299) return refused(refusalForStatus(read.status));
      const answer = readAnalyseResponse(route.provider, read.body);
      return 'refused' in answer ? refused(answer.refused) : { kind: 'answer', text: answer.text };
    } catch (error) {
      if (error instanceof DeadlineExceeded || deadline.signal.aborted) return refused('NETWORK_DEADLINE_EXCEEDED');
      if (error instanceof ResponseTooLarge) return refused('RESPONSE_TOO_LARGE');
      if (error instanceof AddressPolicyError) return refused('NETWORK_FENCE_REFUSED');
      return refused('NETWORK_FAILURE');
    } finally {
      this.#clock.clearTimeout(timer);
      signal?.removeEventListener('abort', onGone);
      socket?.destroy();
    }
  }
}
