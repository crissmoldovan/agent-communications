import type net from 'node:net';
import type tls from 'node:tls';
import { LINEAR_GRAPHQL_ENDPOINT } from '../domain/linear-target.ts';
import {
  connectPinnedTcp,
  connectPinnedTls,
  type PinnedTcpOptions,
  type PinnedTlsOptions,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
} from '../network/pinned-connection.ts';
import type { AddressResolver } from '../network/resolver.ts';

/*
 * Linear's GraphQL API (0.33.0 design §3.4), reached only through the pinned connection: global-only resolution of
 * exactly `https://api.linear.app/graphql`, a pinned TCP peer, TLS verified as api.linear.app, and one raw request
 * written after its gate. There is no redirect, proxy, agent or fetch path. A personal API key travels as Linear asks,
 * `Authorization: <key>` (linear.app/developers/graphql, read 2026-10-26), and is never logged or returned.
 *
 * Outcomes are content-free: a request's answer is its data, or a closed kind with Linear's error code — never Linear's
 * message, which can repeat what was sent. Linear answers a rate limit with HTTP 400 and the GraphQL error code
 * `RATELIMITED` (linear.app/developers/rate-limiting, read 2026-10-26); a 429 is read the same way.
 */

const ATTEMPT_DEADLINE_MS = 20_000;
/** The most of an answer read; Linear's answers to these queries are a few kilobytes. */
const MAX_RESPONSE_BYTES = 1_048_576;
const MAX_REQUEST_BYTES = 262_144;

export type LinearPhase = 'dns' | 'tcp' | 'tls' | 'write';

/** What one GraphQL request came to. Only `data` holds anything Linear said, and only on success. */
export type LinearOutcome =
  | { readonly kind: 'data'; readonly status: number; readonly data: Readonly<Record<string, unknown>> }
  | { readonly kind: 'rate-limited'; readonly status: number }
  | { readonly kind: 'server'; readonly status: number }
  /** Linear refused the request: a 4xx, or a GraphQL error. `code` is Linear's, or `HTTP_<status>`. */
  | { readonly kind: 'refused'; readonly status: number; readonly code: string }
  /** No usable answer: DNS, a connection, TLS, the deadline, or an answer that is not one. */
  | { readonly kind: 'network'; readonly preIo: boolean };

export interface LinearGates {
  /** Awaited before each phase's synchronous gate; a throw refuses the phase. */
  readonly beforeGate?: ((phase: LinearPhase) => Promise<void>) | undefined;
  /** Synchronous and physically adjacent to the phase's action; a throw refuses it. */
  readonly finalGate?: ((phase: LinearPhase) => void) | undefined;
}

export interface LinearClientOptions {
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  readonly deadlineMs?: number | undefined;
}

/** A gate's refusal: the phase never ran. */
export class LinearGateRefused extends Error {
  readonly phase: LinearPhase;
  override readonly cause: unknown;

  constructor(phase: LinearPhase, cause: unknown) {
    super(`the Linear request was refused before its ${phase}`);
    this.name = 'LinearGateRefused';
    this.phase = phase;
    this.cause = cause;
  }
}

/** A personal API key is one header value: printable ASCII, no space, at most 4 KiB. */
export function isLinearKeyShape(value: string): boolean {
  return /^[\x21-\x7e]{1,4096}$/u.test(value);
}

/** Linear's own error code, kept only when it is one: capital letters, digits and `_`. */
function errorCode(body: unknown): string | null {
  if (typeof body !== 'object' || body === null) return null;
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  for (const entry of errors) {
    const code = (entry as { extensions?: { code?: unknown } } | null)?.extensions?.code;
    if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/u.test(code)) return code;
  }
  return 'GRAPHQL_ERROR';
}

/** Reads one HTTP/1.1 answer: its status, and its body by Content-Length, chunked transfer, or to the close. */
export function parseHttpResponse(bytes: Buffer): { readonly status: number; readonly body: Buffer } | null {
  const boundary = bytes.indexOf('\r\n\r\n');
  if (boundary === -1) return null;
  const head = bytes.subarray(0, boundary).toString('latin1');
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: [^\r\n]*)?\r\n/u.exec(`${head}\r\n`);
  if (status?.[1] === undefined) return null;
  const headers = new Map<string, string>();
  for (const line of head.split('\r\n').slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  let body = bytes.subarray(boundary + 4);
  if ((headers.get('transfer-encoding') ?? '').toLowerCase() === 'chunked') {
    const chunks: Buffer[] = [];
    let at = 0;
    for (;;) {
      const end = body.indexOf('\r\n', at);
      if (end === -1) return null;
      const size = Number.parseInt(body.subarray(at, end).toString('latin1').split(';')[0] ?? '', 16);
      if (!Number.isSafeInteger(size) || size < 0) return null;
      if (size === 0) break;
      const start = end + 2;
      if (start + size + 2 > body.length) return null;
      chunks.push(body.subarray(start, start + size));
      at = start + size + 2;
    }
    body = Buffer.concat(chunks);
  } else if (headers.has('content-length')) {
    const length = Number(headers.get('content-length'));
    if (!Number.isSafeInteger(length) || length < 0 || length > body.length) return null;
    body = body.subarray(0, length);
  }
  return { status: Number(status[1]), body };
}

/** One answer, classified. Only a 2xx answer with data and no error gives `data`. */
export function classifyLinearResponse(status: number, body: Buffer): LinearOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
  } catch {
    parsed = undefined;
  }
  const code = errorCode(parsed);
  if (code === 'RATELIMITED' || status === 429) return { kind: 'rate-limited', status };
  if (status >= 500) return { kind: 'server', status };
  if (status < 200 || status > 299) return { kind: 'refused', status, code: code ?? `HTTP_${status}` };
  if (code !== null) return { kind: 'refused', status, code };
  const data = (parsed as { data?: unknown } | undefined)?.data;
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { kind: 'network', preIo: false };
  return { kind: 'data', status, data: data as Record<string, unknown> };
}

function readAll(socket: net.Socket | tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        settled = true;
        socket.destroy();
        reject(new Error('the Linear answer is larger than allowed'));
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks));
    });
  });
}

async function beforeDeadline<T>(work: Promise<T>, deadline: number, disposeLate?: (late: T) => void): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let expired = false;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => {
            expired = true;
            reject(new Error('the Linear request reached its deadline'));
          },
          Math.max(0, deadline - Date.now()),
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
    if (expired)
      work.then(
        (late) => disposeLate?.(late),
        () => undefined,
      );
  }
}

/** The one Linear GraphQL client: a request is a query, its variables and the person's key, and nothing else. */
export class LinearClient {
  readonly #resolver: AddressResolver | undefined;
  readonly #tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly #tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly #deadlineMs: number;

  constructor(options: LinearClientOptions = {}) {
    this.#resolver = options.resolver;
    this.#tcpConnect = options.tcpConnect ?? connectPinnedTcp;
    this.#tlsConnect = options.tlsConnect ?? connectPinnedTls;
    this.#deadlineMs = options.deadlineMs ?? ATTEMPT_DEADLINE_MS;
  }

  /**
   * Sends one GraphQL request. A gate's refusal throws `LinearGateRefused`, before that phase ran; every network
   * failure is the `network` outcome, `preIo` while nothing was written.
   */
  async request(input: {
    readonly key: string;
    readonly query: string;
    readonly variables: Readonly<Record<string, unknown>>;
    readonly gates?: LinearGates | undefined;
    /** An absolute time (ms) the request must end before; the client's own deadline when later or absent. */
    readonly deadline?: number | undefined;
  }): Promise<LinearOutcome> {
    if (!isLinearKeyShape(input.key)) return { kind: 'refused', status: 0, code: 'LINEAR_KEY_MALFORMED' };
    const body = Buffer.from(JSON.stringify({ query: input.query, variables: input.variables }), 'utf8');
    const deadline = Math.min(Date.now() + this.#deadlineMs, input.deadline ?? Number.POSITIVE_INFINITY);
    const prepare = async (phase: LinearPhase) => {
      try {
        await input.gates?.beforeGate?.(phase);
      } catch (error) {
        throw new LinearGateRefused(phase, error);
      }
    };
    // Synchronous, and called in the same statement sequence as the phase's action: no await comes between them.
    const final = (phase: LinearPhase) => {
      try {
        input.gates?.finalGate?.(phase);
      } catch (error) {
        throw new LinearGateRefused(phase, error);
      }
    };
    let socket: net.Socket | tls.TLSSocket | undefined;
    let wrote = false;
    try {
      await prepare('dns');
      final('dns');
      const connection = await beforeDeadline(
        preparePinnedConnection({
          url: LINEAR_GRAPHQL_ENDPOINT,
          addressMode: 'global-only',
          ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
        }),
        deadline,
      );
      const request = requestBytesForPinnedConnection(connection, 'POST', body, {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: input.key,
        'User-Agent': 'agent-communications-events',
      });
      if (request.byteLength > MAX_REQUEST_BYTES) return { kind: 'refused', status: 0, code: 'REQUEST_TOO_LARGE' };
      await prepare('tcp');
      final('tcp');
      const tcp = await beforeDeadline(
        this.#tcpConnect({ host: connection.address, port: connection.port }),
        deadline,
        (late) => late.destroy(),
      );
      socket = tcp;
      await prepare('tls');
      final('tls');
      socket = await beforeDeadline(this.#tlsConnect({ socket: tcp, ...connection.tls }), deadline, (late) =>
        late.destroy(),
      );
      await prepare('write');
      const answer = readAll(socket);
      // A refused write leaves the read unsettled or failed; it is never awaited then, and never unhandled.
      answer.catch(() => undefined);
      final('write');
      socket.write(request);
      wrote = true;
      const parsed = parseHttpResponse(await beforeDeadline(answer, deadline));
      if (parsed === null) return { kind: 'network', preIo: false };
      return classifyLinearResponse(parsed.status, parsed.body);
    } catch (error) {
      if (error instanceof LinearGateRefused) throw error;
      return { kind: 'network', preIo: !wrote };
    } finally {
      socket?.destroy();
    }
  }
}
