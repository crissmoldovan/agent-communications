import { createHash } from 'node:crypto';
import net from 'node:net';
import tls from 'node:tls';
import {
  AddressPolicyError,
  type AddressPolicyOptions,
  assertAddressAllowed,
  assertApprovedAddressSet,
  parseIpLiteral,
} from './address-policy.ts';
import { installErrorSink } from './error-sink.ts';
import { type AddressResolver, resolveHost, systemAddressResolver } from './resolver.ts';

export interface PinnedConnection {
  readonly url: URL;
  readonly hostname: string;
  readonly address: string;
  readonly port: number;
  readonly useTls: boolean;
  readonly hostHeader: string;
  readonly tls: { readonly rejectUnauthorized: true; readonly servername?: string; readonly certificateHost: string };
}

const TYPESAFE_GLOBAL_ONLY_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';

export type PreparePinnedConnectionOptions = AddressPolicyOptions & {
  readonly url: URL | string;
  readonly resolver?: AddressResolver;
  readonly approvedAddressSetDigest?: string;
  /** Optional cancellation preserves B2's existing behavior for callers that omit it. */
  readonly signal?: AbortSignal;
};

export interface PinnedTcpOptions {
  readonly host: string;
  readonly port: number;
  /** Optional cancellation preserves B2's existing behavior for callers that omit it. */
  readonly signal?: AbortSignal;
}

export interface PinnedTlsOptions {
  readonly socket: net.Socket;
  readonly rejectUnauthorized: true;
  readonly servername?: string;
  readonly certificateHost: string;
  /** Optional cancellation preserves B2's existing behavior for callers that omit it. */
  readonly signal?: AbortSignal;
}

export interface OpenPinnedConnectionOptions {
  readonly tcpConnect?: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly tlsConnect?: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
}

export class PinnedResponseError extends Error {
  readonly code:
    | 'NETWORK_ABORTED'
    | 'NETWORK_IDLE_TIMEOUT'
    | 'NETWORK_RESPONSE_TOO_LARGE'
    | 'NETWORK_RESPONSE_INCOMPLETE'
    | 'NETWORK_TIMEOUT_INVALID'
    | 'NETWORK_TOTAL_TIMEOUT';

  constructor(code: PinnedResponseError['code']) {
    super(`pinned network response refused: ${code}`);
    this.name = 'PinnedResponseError';
    this.code = code;
  }
}

export interface PinnedResponseStreamOptions {
  readonly maxBytes: number;
  readonly onChunk: (chunk: Buffer) => void | Promise<void>;
  /** Optional values preserve the pre-existing B2 stream behavior for callers that omit them. */
  readonly signal?: AbortSignal | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
}

function hostWithoutBrackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isLiteral(hostname: string): boolean {
  try {
    parseIpLiteral(hostname);
    return true;
  } catch (error) {
    if (error instanceof AddressPolicyError) return false;
    throw error;
  }
}

function canonicalEntries(entries: readonly string[]): readonly string[] {
  return [...entries];
}

function isSoleApprovedLiteral(entries: readonly string[], address: string): boolean {
  if (entries.length !== 1) return false;
  const [entry] = entries;
  if (entry === undefined || entry.includes('/')) return false;
  return parseIpLiteral(entry).address === address;
}

/** Digest the exact, already-sorted address set before any DNS operation can begin. */
export function addressSetDigest(entries: readonly string[]): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalEntries(entries)))
    .digest('hex');
}

function assertPinnedUrl(url: URL): void {
  if (url.protocol !== 'http:' && url.protocol !== 'https:')
    throw new AddressPolicyError(`unsupported network scheme ${url.protocol}`);
  if (url.username !== '' || url.password !== '') throw new AddressPolicyError('network URL userinfo is refused');
  if (url.hash !== '') throw new AddressPolicyError('network URL fragments are refused');
}

function abortReason(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new PinnedResponseError('NETWORK_ABORTED');
}

/** Resolves all answers, validates them all, and selects a literal only after the complete set passes. */
export async function preparePinnedConnection(options: PreparePinnedConnectionOptions): Promise<PinnedConnection> {
  const url = typeof options.url === 'string' ? new URL(options.url) : new URL(options.url.href);
  assertPinnedUrl(url);
  const globalOnly = options.addressMode === 'global-only';
  if (globalOnly) {
    if (url.href !== TYPESAFE_GLOBAL_ONLY_ENDPOINT)
      throw new AddressPolicyError('global-only address mode is reserved for the fixed TypeSafe endpoint');
    if (options.approvedAddressSetDigest !== undefined)
      throw new AddressPolicyError('global-only address mode does not accept an approvedAddressSet fingerprint');
  } else {
    if (
      options.approvedAddressSetDigest !== undefined &&
      options.approvedAddressSetDigest !== addressSetDigest(options.approvedAddressSet)
    )
      throw new AddressPolicyError('approvedAddressSet fingerprint does not match before resolution');
    assertApprovedAddressSet(options.approvedAddressSet);
  }

  const hostname = hostWithoutBrackets(url.hostname);
  const literal = isLiteral(hostname);
  if (url.protocol === 'http:' && (!literal || (hostname !== '127.0.0.1' && hostname !== '::1')))
    throw new AddressPolicyError('HTTP requires literal 127.0.0.1 or ::1');
  if (url.protocol === 'http:' && !globalOnly && !isSoleApprovedLiteral(options.approvedAddressSet, hostname))
    throw new AddressPolicyError('HTTP requires its one exact approved literal loopback address');

  const answers = await resolveHost(hostname, options.resolver ?? systemAddressResolver, { signal: options.signal });
  const vetted = answers.map((answer) => assertAddressAllowed(answer, options));
  const addresses = vetted.map((answer) => answer.address).sort((left, right) => left.localeCompare(right));
  if (addresses.length === 0) throw new AddressPolicyError('resolver returned no vetted addresses');
  const [address] = addresses;
  if (address === undefined) throw new AddressPolicyError('resolver returned no selected address');
  if (url.protocol === 'http:' && (addresses.length !== 1 || address !== hostname))
    throw new AddressPolicyError('HTTP requires its one approved literal loopback answer');

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new AddressPolicyError(`invalid network port ${url.port}`);
  const defaultPort = url.protocol === 'https:' ? 443 : 80;
  const hostForHeader = hostname.includes(':') ? `[${hostname}]` : hostname;
  return {
    url,
    hostname,
    address,
    port,
    useTls: url.protocol === 'https:',
    hostHeader: port === defaultPort ? hostForHeader : `${hostForHeader}:${port}`,
    tls: literal
      ? { rejectUnauthorized: true, certificateHost: hostname }
      : { rejectUnauthorized: true, servername: hostname, certificateHost: hostname },
  };
}

/** Generates raw request bytes. This transport owns no redirect, agent, proxy, or fetch path. */
export function requestBytesForPinnedConnection(
  connection: PinnedConnection,
  method: 'GET' | 'POST',
  body: Uint8Array = Buffer.alloc(0),
  headers: Readonly<Record<string, string>> = {},
): Buffer {
  const pathname = `${connection.url.pathname}${connection.url.search}` || '/';
  const supplied = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return Buffer.concat([
    Buffer.from(
      `${method} ${pathname} HTTP/1.1\r\nHost: ${connection.hostHeader}\r\nContent-Length: ${body.byteLength}\r\nConnection: close\r\n${supplied.join('\r\n')}\r\n\r\n`,
    ),
    Buffer.from(body),
  ]);
}

/**
 * Generates a no-body raw GET for a fixed-purpose caller.  The caller's header
 * policy is deliberately outside B2; B2 only guarantees that these exact raw
 * bytes go over a previously pinned connection.
 */
export function getRequestBytesForPinnedConnection(
  connection: PinnedConnection,
  headers: Readonly<Record<string, string>>,
): Buffer {
  const pathname = `${connection.url.pathname}${connection.url.search}` || '/';
  const supplied = Object.entries(headers).map(([name, value]) => `${name}: ${value}`);
  return Buffer.from(
    `GET ${pathname} HTTP/1.1\r\nHost: ${connection.hostHeader}\r\nConnection: close\r\n${supplied.join('\r\n')}\r\n\r\n`,
    'latin1',
  );
}

/**
 * Writes one already-bounded raw request and collects a close-delimited raw
 * response under a caller-supplied byte ceiling.  It opens no connection and
 * performs no HTTP parsing, redirecting, proxying, or retrying.
 */
export function streamPinnedResponse(
  socket: net.Socket | tls.TLSSocket,
  request: Uint8Array,
  maxBytes: number,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  return streamPinnedResponseTo(socket, request, {
    maxBytes,
    onChunk: (chunk) => {
      chunks.push(Buffer.from(chunk));
    },
  }).then(() => Buffer.concat(chunks));
}

/** Streams one bounded raw response without retaining its bytes in memory. */
export function streamPinnedResponseTo(
  socket: net.Socket | tls.TLSSocket,
  request: Uint8Array,
  options: PinnedResponseStreamOptions,
): Promise<void> {
  const { maxBytes, onChunk, signal } = options;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) throw new PinnedResponseError('NETWORK_RESPONSE_TOO_LARGE');
  for (const deadline of [options.idleTimeoutMs, options.totalTimeoutMs]) {
    if (deadline !== undefined && (!Number.isSafeInteger(deadline) || deadline < 1))
      throw new PinnedResponseError('NETWORK_TIMEOUT_INVALID');
  }
  return new Promise((resolve, reject) => {
    let total = 0;
    let terminal: Error | null | undefined;
    let ended = false;
    let pending = Promise.resolve();
    let idleTimer: NodeJS.Timeout | undefined;
    let totalTimer: NodeJS.Timeout | undefined;
    const onError = (error: Error) => fail(error);
    const onAbort = () => fail(signal === undefined ? new PinnedResponseError('NETWORK_ABORTED') : abortReason(signal));
    const clearTimers = () => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      if (totalTimer !== undefined) clearTimeout(totalTimer);
    };
    const resetIdleDeadline = () => {
      if (options.idleTimeoutMs === undefined) return;
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => fail(new PinnedResponseError('NETWORK_IDLE_TIMEOUT')), options.idleTimeoutMs);
    };
    const cleanup = () => {
      clearTimers();
      signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
    };
    const finish = () => {
      if (terminal !== undefined) return;
      terminal = null;
      cleanup();
      void pending.then(() => resolve());
    };
    const fail = (error: Error) => {
      if (terminal !== undefined) return;
      terminal = error;
      cleanup();
      socket.destroy();
      void pending.then(() => reject(error));
    };
    socket.once('error', onError);
    if (signal?.aborted === true) {
      fail(new PinnedResponseError('NETWORK_ABORTED'));
      return;
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    resetIdleDeadline();
    if (options.totalTimeoutMs !== undefined)
      totalTimer = setTimeout(() => fail(new PinnedResponseError('NETWORK_TOTAL_TIMEOUT')), options.totalTimeoutMs);
    socket.on('data', (chunk: Buffer) => {
      if (terminal !== undefined) return;
      resetIdleDeadline();
      total += chunk.byteLength;
      if (total > maxBytes) {
        fail(new PinnedResponseError('NETWORK_RESPONSE_TOO_LARGE'));
        return;
      }
      socket.pause();
      pending = pending
        .then(() => onChunk(Buffer.from(chunk)))
        .then(
          () => {
            if (terminal === undefined) socket.resume();
            if (ended) finish();
          },
          (error: unknown) => fail(error instanceof Error ? error : new Error('raw pinned response sink failed')),
        );
    });
    socket.once('end', () => {
      ended = true;
      void pending.then(() => finish());
    });
    socket.once('close', () => {
      if (terminal === undefined) fail(new PinnedResponseError('NETWORK_RESPONSE_INCOMPLETE'));
    });
    try {
      socket.write(request);
    } catch (error) {
      fail(error instanceof Error ? error : new Error('raw pinned request write failed'));
    }
  });
}

/** Opens the selected literal TCP peer. Callers place their final authority fence immediately before this call. */
export function connectPinnedTcp(options: PinnedTcpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      reject(abortReason(options.signal));
      return;
    }
    const socket = net.connect({ host: options.host, port: options.port });
    installErrorSink(socket);
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('connect', onConnect);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onAbort = () =>
      fail(options.signal === undefined ? new PinnedResponseError('NETWORK_ABORTED') : abortReason(options.signal));
    const onConnect = () => {
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('connect', onConnect);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Starts TLS only over the already-pinned TCP socket. Callers fence immediately before this ClientHello. */
export function connectPinnedTls(options: PinnedTlsOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted === true) {
      options.socket.destroy();
      reject(abortReason(options.signal));
      return;
    }
    const socket = tls.connect({
      socket: options.socket,
      rejectUnauthorized: options.rejectUnauthorized,
      ...(options.servername === undefined ? {} : { servername: options.servername }),
      checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(options.certificateHost, certificate),
    });
    installErrorSink(socket);
    const cleanup = () => {
      options.signal?.removeEventListener('abort', onAbort);
      socket.off('error', onError);
      socket.off('secureConnect', onSecureConnect);
    };
    const fail = (error: Error) => {
      cleanup();
      socket.destroy();
      reject(error);
    };
    const onError = (error: Error) => fail(error);
    const onAbort = () =>
      fail(options.signal === undefined ? new PinnedResponseError('NETWORK_ABORTED') : abortReason(options.signal));
    const onSecureConnect = () => {
      cleanup();
      resolve(socket);
    };
    socket.once('error', onError);
    socket.once('secureConnect', onSecureConnect);
    options.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Opens only a raw connection to the selected vetted literal; callers write their own protocol bytes. */
export async function openPinnedConnection(
  connection: PinnedConnection,
  options: OpenPinnedConnectionOptions = {},
): Promise<net.Socket | tls.TLSSocket> {
  const socket = await (options.tcpConnect ?? connectPinnedTcp)({ host: connection.address, port: connection.port });
  if (!connection.useTls) return socket;
  return (options.tlsConnect ?? connectPinnedTls)({ socket, ...connection.tls });
}
