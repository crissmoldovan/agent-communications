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

export interface PreparePinnedConnectionOptions extends AddressPolicyOptions {
  readonly url: URL | string;
  readonly resolver?: AddressResolver;
  readonly approvedAddressSetDigest?: string;
}

export interface PinnedTcpOptions {
  readonly host: string;
  readonly port: number;
}

export interface PinnedTlsOptions {
  readonly socket: net.Socket;
  readonly rejectUnauthorized: true;
  readonly servername?: string;
  readonly certificateHost: string;
}

export interface OpenPinnedConnectionOptions {
  readonly tcpConnect?: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly tlsConnect?: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
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

/** Resolves all answers, validates them all, and selects a literal only after the complete set passes. */
export async function preparePinnedConnection(options: PreparePinnedConnectionOptions): Promise<PinnedConnection> {
  const url = typeof options.url === 'string' ? new URL(options.url) : new URL(options.url.href);
  assertPinnedUrl(url);
  if (
    options.approvedAddressSetDigest !== undefined &&
    options.approvedAddressSetDigest !== addressSetDigest(options.approvedAddressSet)
  )
    throw new AddressPolicyError('approvedAddressSet fingerprint does not match before resolution');
  assertApprovedAddressSet(options.approvedAddressSet);

  const hostname = hostWithoutBrackets(url.hostname);
  const literal = isLiteral(hostname);
  if (url.protocol === 'http:' && (!literal || (hostname !== '127.0.0.1' && hostname !== '::1')))
    throw new AddressPolicyError('HTTP requires literal 127.0.0.1 or ::1');
  if (url.protocol === 'http:' && !isSoleApprovedLiteral(options.approvedAddressSet, hostname))
    throw new AddressPolicyError('HTTP requires its one exact approved literal loopback address');

  const answers = await resolveHost(hostname, options.resolver ?? systemAddressResolver);
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

/** Opens the selected literal TCP peer. Callers place their final authority fence immediately before this call. */
export function connectPinnedTcp(options: PinnedTcpOptions): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: options.host, port: options.port });
    socket.once('error', reject);
    socket.once('connect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
  });
}

/** Starts TLS only over the already-pinned TCP socket. Callers fence immediately before this ClientHello. */
export function connectPinnedTls(options: PinnedTlsOptions): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({
      socket: options.socket,
      rejectUnauthorized: options.rejectUnauthorized,
      ...(options.servername === undefined ? {} : { servername: options.servername }),
      checkServerIdentity: (_name, certificate) => tls.checkServerIdentity(options.certificateHost, certificate),
    });
    socket.once('error', reject);
    socket.once('secureConnect', () => {
      socket.off('error', reject);
      resolve(socket);
    });
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
