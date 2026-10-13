import { createHash, timingSafeEqual } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { AddressPolicyError, assertAddressAllowed } from '../../network/address-policy.ts';
import {
  addressSetDigest,
  connectPinnedTcp,
  connectPinnedTls,
  getRequestBytesForPinnedConnection,
  type PinnedConnection,
  PinnedResponseError,
  type PinnedTcpOptions,
  type PinnedTlsOptions,
  preparePinnedConnection,
  streamPinnedResponseTo,
} from '../../network/pinned-connection.ts';
import { type AddressResolver, resolveHost } from '../../network/resolver.ts';
import type { CanonicalLayaManifest, LayaManifestFile } from './contracts.ts';

const MAX_REDIRECTS = 5;
const MAX_RESPONSE_HEADER_BYTES = 16 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 30 * 60_000;
const USER_AGENT = 'agentcomms-events/0.15.2';
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type LayaFetchErrorCode =
  | 'ABORTED'
  | 'ADDRESS'
  | 'CONTENT_RANGE'
  | 'HTTP_RESPONSE'
  | 'REDIRECT'
  | 'REDIRECT_LIMIT'
  | 'REQUEST_HEADER'
  | 'RESPONSE_BODY'
  | 'RESPONSE_HEADERS'
  | 'IDLE_TIMEOUT'
  | 'RUNTIME_INTEGRITY'
  | 'RUNTIME_ORIGIN'
  | 'TOTAL_TIMEOUT';

export class LayaFetchError extends Error {
  readonly code: LayaFetchErrorCode;

  constructor(code: LayaFetchErrorCode) {
    super(`Laya artifact fetch refused: ${code}`);
    this.name = 'LayaFetchError';
    this.code = code;
  }
}

export interface LayaRuntimePackageSource {
  readonly name: string;
  readonly version: string;
  readonly url: string;
  readonly integrity: string;
}

export interface LayaFetchResult {
  readonly bytes: Buffer;
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

export interface LayaFetchStreamResult {
  readonly url: string;
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bytesReceived: number;
  readonly sha256: string;
}

export interface LayaArtifactFetcherOptions {
  readonly manifest: Pick<CanonicalLayaManifest, 'source' | 'files'> & { readonly manifestId?: string };
  readonly runtimePackages: readonly LayaRuntimePackageSource[];
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  readonly maxResponseHeaderBytes?: number | undefined;
  readonly idleTimeoutMs?: number | undefined;
  readonly totalTimeoutMs?: number | undefined;
}

/** Every artifact request belongs to a lifecycle-owned cancellation scope. */
export interface LayaFetchOptions {
  readonly signal: AbortSignal;
}

interface ParsedResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly body: Buffer;
}

interface StreamedResponse {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
  readonly bytesReceived: number;
  readonly sha256: string;
  readonly url: string;
}

function exactLowercaseHex(value: string, length: number): boolean {
  return new RegExp(`^[a-f0-9]{${length}}$`).test(value);
}

function responseHeaderLimit(value: number | undefined): number {
  const limit = value ?? MAX_RESPONSE_HEADER_BYTES;
  if (!Number.isSafeInteger(limit) || limit < 1) throw new LayaFetchError('RESPONSE_HEADERS');
  return limit;
}

function fetchDeadline(value: number | undefined, fallback: number): number {
  const deadline = value ?? fallback;
  if (!Number.isSafeInteger(deadline) || deadline < 1) throw new LayaFetchError('HTTP_RESPONSE');
  return deadline;
}

function parseResponse(bytes: Buffer, headerLimit: number): ParsedResponse {
  const boundary = bytes.indexOf('\r\n\r\n', 0, 'latin1');
  if (boundary < 0 || boundary + 4 > headerLimit) throw new LayaFetchError('RESPONSE_HEADERS');
  const lines = bytes.subarray(0, boundary).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] ([0-9]{3}) [^\r\n]*$/u.exec(lines[0] ?? '');
  if (status?.[1] === undefined) throw new LayaFetchError('HTTP_RESPONSE');
  const headers = new Map<string, string>();
  for (const line of lines.slice(1)) {
    const separator = line.indexOf(':');
    if (separator < 1) throw new LayaFetchError('RESPONSE_HEADERS');
    const name = line.slice(0, separator).toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (headers.has(name) || /[\r\n]/u.test(value)) throw new LayaFetchError('RESPONSE_HEADERS');
    headers.set(name, value);
  }
  return { status: Number(status[1]), headers, body: bytes.subarray(boundary + 4) };
}

function contentLength(response: Pick<ParsedResponse, 'headers'>): number | null {
  const value = response.headers.get('content-length');
  if (value === undefined) return null;
  if (!/^(?:0|[1-9]\d*)$/u.test(value)) throw new LayaFetchError('RESPONSE_HEADERS');
  const length = Number(value);
  if (!Number.isSafeInteger(length)) throw new LayaFetchError('RESPONSE_HEADERS');
  return length;
}

function exactSriSha512(value: string): Buffer {
  const matched = /^sha512-([A-Za-z0-9+/]{86}==)$/.exec(value);
  if (matched?.[1] === undefined) throw new LayaFetchError('RUNTIME_INTEGRITY');
  const decoded = Buffer.from(matched[1], 'base64');
  if (decoded.length !== 64 || decoded.toString('base64') !== matched[1]) throw new LayaFetchError('RUNTIME_INTEGRITY');
  return decoded;
}

function isExactRegistryTarballUrl(source: LayaRuntimePackageSource): boolean {
  if (!/^(?:@[-a-z0-9]+\/)?[-a-z0-9]+$/iu.test(source.name)) return false;
  if (!/^[0-9A-Za-z][0-9A-Za-z.+-]*$/u.test(source.version)) return false;
  const basename = source.name.slice(source.name.lastIndexOf('/') + 1);
  return source.url === `https://registry.npmjs.org/${source.name}/-/${basename}-${source.version}.tgz`;
}

function throwIfAborted(signal: AbortSignal): void {
  if (!signal.aborted) return;
  if (signal.reason instanceof LayaFetchError) throw signal.reason;
  throw new LayaFetchError('ABORTED');
}

/** One request-wide lifetime: total time starts before the first DNS query and never resets on redirects. */
class FetchDeadline {
  readonly #controller = new AbortController();
  readonly #expiresAt: number;
  readonly #onCallerAbort: () => void;
  readonly #timer: NodeJS.Timeout;
  readonly signal = this.#controller.signal;

  constructor(callerSignal: AbortSignal, totalTimeoutMs: number) {
    this.#expiresAt = Date.now() + totalTimeoutMs;
    this.#onCallerAbort = () => this.#abort(new LayaFetchError('ABORTED'));
    if (callerSignal.aborted) this.#onCallerAbort();
    else callerSignal.addEventListener('abort', this.#onCallerAbort, { once: true });
    this.#timer = setTimeout(() => this.#abort(new LayaFetchError('TOTAL_TIMEOUT')), totalTimeoutMs);
    this.#callerSignal = callerSignal;
  }

  readonly #callerSignal: AbortSignal;

  remainingMs(): number {
    throwIfAborted(this.signal);
    return Math.max(1, this.#expiresAt - Date.now());
  }

  dispose(): void {
    clearTimeout(this.#timer);
    this.#callerSignal.removeEventListener('abort', this.#onCallerAbort);
  }

  #abort(reason: LayaFetchError): void {
    if (!this.signal.aborted) this.#controller.abort(reason);
  }
}

function mapPinnedResponseError(error: unknown): never {
  if (error instanceof PinnedResponseError) {
    if (error.code === 'NETWORK_ABORTED') throw new LayaFetchError('ABORTED');
    if (error.code === 'NETWORK_IDLE_TIMEOUT') throw new LayaFetchError('IDLE_TIMEOUT');
    if (error.code === 'NETWORK_TOTAL_TIMEOUT') throw new LayaFetchError('TOTAL_TIMEOUT');
  }
  throw error;
}

function safeManifestPath(value: string): boolean {
  return (
    value.length > 0 &&
    !value.includes('\\') &&
    !value.includes('\0') &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    value.normalize('NFC') === value &&
    value.split('/').every((part) => /^[a-z0-9][a-z0-9._-]*$/iu.test(part) && part !== '.' && part !== '..')
  );
}

function modelUrl(manifest: LayaArtifactFetcherOptions['manifest'], file: LayaManifestFile): URL {
  if (manifest.source.host !== 'huggingface.co') throw new LayaFetchError('HTTP_RESPONSE');
  if (!/^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/iu.test(manifest.source.repo))
    throw new LayaFetchError('HTTP_RESPONSE');
  if (!exactLowercaseHex(manifest.source.revision, 40) || !safeManifestPath(file.path))
    throw new LayaFetchError('HTTP_RESPONSE');
  return new URL(
    `https://${manifest.source.host}/${manifest.source.repo}/resolve/${manifest.source.revision}/${file.path}`,
  );
}

/** Rejects every optional request header before any pinned DNS/TCP/TLS activity begins. */
export function assertLayaRequestHeaders(headers: Readonly<Record<string, string>>): void {
  const allowed = new Set(['range', 'user-agent']);
  const seen = new Set<string>();
  for (const [rawName, value] of Object.entries(headers)) {
    const name = rawName.toLowerCase();
    if (!allowed.has(name)) throw new LayaFetchError('REQUEST_HEADER');
    if (seen.has(name)) throw new LayaFetchError('REQUEST_HEADER');
    seen.add(name);
    if (name === 'user-agent' && value !== USER_AGENT) throw new LayaFetchError('REQUEST_HEADER');
    if (name === 'range' && !/^bytes=[1-9]\d*-$/.test(value)) throw new LayaFetchError('REQUEST_HEADER');
  }
}

function expectedContentRange(value: string | undefined, start: number, size: number, received: number): void {
  if (value === undefined) throw new LayaFetchError('CONTENT_RANGE');
  const matched = /^bytes (\d+)-(\d+)\/(\d+)$/u.exec(value);
  if (matched === null) throw new LayaFetchError('CONTENT_RANGE');
  const [, returnedStart, returnedEnd, total] = matched;
  if (
    Number(returnedStart) !== start ||
    Number(total) !== size ||
    Number(returnedEnd) !== start + received - 1 ||
    received < 1 ||
    start + received > size
  )
    throw new LayaFetchError('CONTENT_RANGE');
}

/** Fixed-purpose raw artifact reader: it owns no proxy, agent, HTTP client, or loopback exception. */
export class LayaArtifactFetcher {
  readonly manifest: LayaArtifactFetcherOptions['manifest'];
  readonly #runtimePackages: readonly LayaRuntimePackageSource[];
  readonly #resolver: AddressResolver | undefined;
  readonly #tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly #tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly #headerLimit: number;
  readonly #idleTimeoutMs: number;
  readonly #totalTimeoutMs: number;

  constructor(options: LayaArtifactFetcherOptions) {
    this.manifest = options.manifest;
    this.#runtimePackages = options.runtimePackages;
    this.#resolver = options.resolver;
    this.#tcpConnect = options.tcpConnect ?? connectPinnedTcp;
    this.#tlsConnect = options.tlsConnect ?? connectPinnedTls;
    this.#headerLimit = responseHeaderLimit(options.maxResponseHeaderBytes);
    this.#idleTimeoutMs = fetchDeadline(options.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS);
    this.#totalTimeoutMs = fetchDeadline(options.totalTimeoutMs, DEFAULT_TOTAL_TIMEOUT_MS);
  }

  async fetchRuntimeArchive(
    input: { readonly name: string; readonly version: string },
    options: LayaFetchOptions,
  ): Promise<Buffer> {
    const runtimePackage = this.#runtimePackages.find(
      (candidate) => candidate.name === input.name && candidate.version === input.version,
    );
    if (runtimePackage === undefined) throw new LayaFetchError('RUNTIME_ORIGIN');
    if (!isExactRegistryTarballUrl(runtimePackage)) throw new LayaFetchError('RUNTIME_ORIGIN');
    const expected = exactSriSha512(runtimePackage.integrity);
    const chunks: Buffer[] = [];
    const result = await this.#get(
      new URL(runtimePackage.url),
      undefined,
      512 * 1024 * 1024,
      async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      options.signal,
      false,
    );
    const bytes = Buffer.concat(chunks);
    if (result.status !== 200 || (contentLength(result) !== null && contentLength(result) !== bytes.length))
      throw new LayaFetchError('HTTP_RESPONSE');
    const actual = createHash('sha512').update(bytes).digest();
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected))
      throw new LayaFetchError('RUNTIME_INTEGRITY');
    return bytes;
  }

  async fetchModelFile(
    file: LayaManifestFile,
    resumeFrom: number | undefined,
    options: LayaFetchOptions,
  ): Promise<LayaFetchResult> {
    const chunks: Buffer[] = [];
    const result = await this.fetchModelFileTo(
      file,
      resumeFrom,
      async (chunk) => {
        chunks.push(Buffer.from(chunk));
      },
      options,
    );
    return { bytes: Buffer.concat(chunks), url: result.url, status: result.status, headers: result.headers };
  }

  async fetchModelFileTo(
    file: LayaManifestFile,
    resumeFrom: number | undefined,
    onChunk: (chunk: Buffer, signal: AbortSignal) => void | Promise<void>,
    options: LayaFetchOptions,
  ): Promise<LayaFetchStreamResult> {
    if (!Number.isSafeInteger(file.size) || file.size < 1 || !exactLowercaseHex(file.sha256, 64))
      throw new LayaFetchError('HTTP_RESPONSE');
    if (resumeFrom !== undefined && (!Number.isSafeInteger(resumeFrom) || resumeFrom < 1 || resumeFrom >= file.size))
      throw new LayaFetchError('CONTENT_RANGE');
    const result = await this.#get(modelUrl(this.manifest, file), resumeFrom, file.size, onChunk, options.signal, true);
    const declaredLength = contentLength(result);
    if (declaredLength !== null && declaredLength !== result.bytesReceived) throw new LayaFetchError('RESPONSE_BODY');
    if (resumeFrom === undefined) {
      if (result.status !== 200 || result.bytesReceived !== file.size) throw new LayaFetchError('HTTP_RESPONSE');
    } else {
      if (result.status !== 206) throw new LayaFetchError('CONTENT_RANGE');
      expectedContentRange(result.headers.get('content-range'), resumeFrom, file.size, result.bytesReceived);
    }
    return result;
  }

  async #globalApprovedAddresses(url: URL, signal: AbortSignal): Promise<readonly string[]> {
    const hostname =
      url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
    let answers: readonly string[];
    try {
      answers = await resolveHost(hostname, this.#resolver, { signal });
      const vetted = answers.map((answer) => assertAddressAllowed(answer, { addressMode: 'global-only' }));
      return [...new Set(vetted.map((answer) => answer.address))].sort((left, right) => left.localeCompare(right));
    } catch (error) {
      if (error instanceof AddressPolicyError) throw new LayaFetchError('ADDRESS');
      throw error;
    }
  }

  async #get(
    initial: URL,
    resumeFrom: number | undefined,
    maximumBytes: number,
    onBody: (chunk: Buffer, signal: AbortSignal) => void | Promise<void>,
    signal: AbortSignal,
    allowRedirects: boolean,
  ): Promise<StreamedResponse> {
    let url = new URL(initial.href);
    let redirects = 0;
    const deadline = new FetchDeadline(signal, this.#totalTimeoutMs);
    try {
      while (true) {
        throwIfAborted(deadline.signal);
        if (url.protocol !== 'https:' || url.username !== '' || url.password !== '' || url.hash !== '')
          throw new LayaFetchError('REDIRECT');
        const approvedAddressSet = await this.#waitForPhase(
          () => this.#globalApprovedAddresses(url, deadline.signal),
          deadline,
        );
        let connection: PinnedConnection;
        try {
          connection = await this.#waitForPhase(
            () =>
              preparePinnedConnection({
                url,
                approvedAddressSet,
                approvedAddressSetDigest: addressSetDigest(approvedAddressSet),
                ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
                signal: deadline.signal,
              }),
            deadline,
          );
        } catch (error) {
          if (error instanceof AddressPolicyError) throw new LayaFetchError('ADDRESS');
          throw error;
        }
        const tcp = await this.#waitForPhase(
          () => this.#tcpConnect({ host: connection.address, port: connection.port, signal: deadline.signal }),
          deadline,
          (late) => late.destroy(),
        );
        let socket: tls.TLSSocket;
        try {
          socket = await this.#waitForPhase(
            () => this.#tlsConnect({ socket: tcp, ...connection.tls, signal: deadline.signal }),
            deadline,
            (late) => late.destroy(),
          );
        } catch (error) {
          tcp.destroy();
          throw error;
        }
        const headers: Record<string, string> = { 'User-Agent': USER_AGENT };
        if (resumeFrom !== undefined) headers.Range = `bytes=${resumeFrom}-`;
        assertLayaRequestHeaders(headers);
        let header = Buffer.alloc(0);
        let response: ParsedResponse | undefined;
        let bytesReceived = 0;
        const hash = createHash('sha256');
        try {
          await streamPinnedResponseTo(socket, getRequestBytesForPinnedConnection(connection, headers), {
            maxBytes: maximumBytes + MAX_RESPONSE_HEADER_BYTES,
            signal: deadline.signal,
            idleTimeoutMs: this.#idleTimeoutMs,
            totalTimeoutMs: deadline.remainingMs(),
            onChunk: async (chunk) => {
              let body = chunk;
              if (response === undefined) {
                header = Buffer.concat([header, chunk]);
                const boundary = header.indexOf('\r\n\r\n', 0, 'latin1');
                if (boundary < 0) {
                  if (header.length > this.#headerLimit) throw new LayaFetchError('RESPONSE_HEADERS');
                  return;
                }
                response = parseResponse(header.subarray(0, boundary + 4), this.#headerLimit);
                body = header.subarray(boundary + 4);
                header = Buffer.alloc(0);
              }
              if (response === undefined || REDIRECT_STATUSES.has(response.status) || body.length === 0) return;
              bytesReceived += body.length;
              if (bytesReceived > maximumBytes) throw new LayaFetchError('RESPONSE_BODY');
              hash.update(body);
              await onBody(body, deadline.signal);
            },
          });
        } catch (error) {
          mapPinnedResponseError(error);
        }
        if (response === undefined) throw new LayaFetchError('RESPONSE_HEADERS');
        if (!REDIRECT_STATUSES.has(response.status)) {
          return { ...response, bytesReceived, sha256: hash.digest('hex'), url: url.href };
        }
        if (!allowRedirects) throw new LayaFetchError('REDIRECT');
        if (redirects >= MAX_REDIRECTS) throw new LayaFetchError('REDIRECT_LIMIT');
        const location = response.headers.get('location');
        if (location === undefined || location.length === 0) throw new LayaFetchError('REDIRECT');
        try {
          url = new URL(location, url);
        } catch {
          throw new LayaFetchError('REDIRECT');
        }
        redirects += 1;
      }
    } finally {
      deadline.dispose();
    }
  }

  #waitForPhase<T>(operation: () => Promise<T>, deadline: FetchDeadline, destroyLate?: (value: T) => void): Promise<T> {
    return new Promise((resolve, reject) => {
      let settled = false;
      const cleanup = () => deadline.signal.removeEventListener('abort', onAbort);
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onAbort = () => {
        try {
          throwIfAborted(deadline.signal);
        } catch (error) {
          fail(error instanceof Error ? error : new LayaFetchError('ABORTED'));
        }
      };
      deadline.signal.addEventListener('abort', onAbort, { once: true });
      if (deadline.signal.aborted) {
        onAbort();
        return;
      }
      Promise.resolve()
        .then(() => {
          throwIfAborted(deadline.signal);
          return operation();
        })
        .then(
          (value) => {
            if (settled || deadline.signal.aborted) {
              destroyLate?.(value);
              onAbort();
              return;
            }
            settled = true;
            cleanup();
            resolve(value);
          },
          (error: unknown) => fail(error instanceof Error ? error : new Error('pinned fetch phase failed')),
        );
    });
  }
}
