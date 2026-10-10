import type net from 'node:net';
import type tls from 'node:tls';
import { APPROVED_TYPESAFE_MODELS } from '../domain/judges.ts';
import { validateLocalEndpoint } from '../network/local-endpoint.ts';
import {
  addressSetDigest,
  connectPinnedTcp,
  connectPinnedTls,
  type PinnedConnection,
  type PinnedTcpOptions,
  type PinnedTlsOptions,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
} from '../network/pinned-connection.ts';
import type { AddressResolver } from '../network/resolver.ts';
import {
  buildJudgeWireRequest,
  JUDGE_MAX_REQUEST_BYTES,
  JUDGE_MAX_RESPONSE_BYTES,
  type JudgeTransportRefusalCode,
  type JudgeTransportResult,
  parseJudgeResponse,
} from './judge-adapters.ts';

export type { JudgeTransportResult } from './judge-adapters.ts';
export { buildJudgeWireRequest, parseJudgeResponse } from './judge-adapters.ts';

const TYPESAFE_ENDPOINT = 'https://api.typesafe.ai/v1/systemone';
const OLLAMA_SYSTEM_ONE_PATH = '/v1/systemone';
const JUDGE_ATTEMPT_DEADLINE_MS = 20_000;

export type JudgeTransportPhase = 'dns' | 'tcp' | 'tls' | 'write';

type LocalJudgeBase = {
  readonly judgeId: string;
  readonly version: number;
  readonly kind: 'local-endpoint';
  readonly provider: string;
  readonly model: string;
  readonly endpoint: string;
  readonly approvedAddressSet: readonly string[];
  readonly promptTemplate: string;
};

export type TransportJudge =
  | {
      readonly judgeId: string;
      readonly version: number;
      readonly kind: 'typesafe';
      readonly provider: 'typesafe';
      readonly model: string;
      readonly endpoint: typeof TYPESAFE_ENDPOINT;
      readonly promptTemplate: string;
      readonly protocol: 'noul';
    }
  | (LocalJudgeBase & { readonly protocol: 'noul' })
  | (LocalJudgeBase & { readonly protocol: 'json-score'; readonly scorePointer: string });

export interface JudgeTransportCall {
  readonly judge: TransportJudge;
  readonly state: string;
  readonly questionName: string;
  readonly instructions: string;
  readonly maxInputTokens: number;
  readonly maxOutputTokens: number;
  /** B3 supplies this at the hosted boundary only; it is never persisted or returned. */
  readonly hostedApiKey?: string | undefined;
}

export interface JudgeTransportHooks {
  readonly beforeGate?: ((phase: JudgeTransportPhase) => Promise<void>) | undefined;
  /**
   * Synchronous and physically adjacent to the DNS/TCP/TLS/write action. It returns nothing: a gate that returns a value,
   * a promise above all, has not finished deciding and refuses the phase.
   */
  readonly finalGate: (phase: JudgeTransportPhase) => undefined;
}

export interface JudgeTransportClock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface JudgeTransportOptions {
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  readonly clock?: JudgeTransportClock | undefined;
}

class DeadlineExceeded extends Error {}
class ResponseTooLarge extends Error {}
class FenceRefused extends Error {}

const systemClock: JudgeTransportClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function assertBeforeDeadline(deadline: number, clock: JudgeTransportClock): void {
  if (clock.now() >= deadline) throw new DeadlineExceeded();
}

function refused(code: JudgeTransportRefusalCode): JudgeTransportResult {
  return { kind: 'refused', code };
}

function positiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function adapterFor(call: JudgeTransportCall): 'typesafe' | 'ollama' | null {
  if (call.judge.kind === 'typesafe') {
    if (
      call.judge.endpoint !== TYPESAFE_ENDPOINT ||
      call.judge.protocol !== 'noul' ||
      !(APPROVED_TYPESAFE_MODELS as readonly string[]).includes(call.judge.model)
    )
      return null;
    return 'typesafe';
  }
  if (call.judge.protocol !== 'noul' || call.judge.provider !== 'ollama') return null;
  let endpoint: ReturnType<typeof validateLocalEndpoint>;
  try {
    endpoint = validateLocalEndpoint(call.judge.endpoint, call.judge.approvedAddressSet);
  } catch {
    return null;
  }
  return endpoint.url.pathname === OLLAMA_SYSTEM_ONE_PATH && endpoint.url.search === '' ? 'ollama' : null;
}

function responseBody(bytes: Buffer): Buffer | null {
  const boundary = bytes.indexOf('\r\n\r\n');
  if (boundary === -1) return null;
  const head = bytes.subarray(0, boundary).toString('latin1');
  const status = /^HTTP\/1\.[01] ([0-9]{3}) [^\r\n]*\r\n/u.exec(head);
  if (status?.[1] === undefined) return null;
  const code = Number(status[1]);
  if (!Number.isInteger(code) || code < 200 || code > 299) return null;
  return bytes.subarray(boundary + 4);
}

/** Builds the exact B2 request bytes before DNS so the byte and token ceilings cannot open a socket. */
function requestBytesForEndpoint(url: URL, body: Uint8Array, headers: Readonly<Record<string, string>>): Buffer {
  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  const useTls = url.protocol === 'https:';
  const port = url.port === '' ? (useTls ? 443 : 80) : Number(url.port);
  const defaultPort = useTls ? 443 : 80;
  const host = hostname.includes(':') ? `[${hostname}]` : hostname;
  const connection: PinnedConnection = {
    url,
    hostname,
    address: hostname,
    port,
    useTls,
    hostHeader: port === defaultPort ? host : `${host}:${port}`,
    tls: { rejectUnauthorized: true, certificateHost: hostname },
  };
  return requestBytesForPinnedConnection(connection, 'POST', body, headers);
}

function boundedResponse(socket: net.Socket | tls.TLSSocket): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const body = responseBody(Buffer.concat(chunks));
      if (body === null) reject(new Error('the judge peer did not return one 2xx HTTP response'));
      else resolve(body);
    };
    socket.once('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
    socket.on('data', (chunk: Buffer) => {
      if (settled) return;
      total += chunk.byteLength;
      if (total > JUDGE_MAX_RESPONSE_BYTES) {
        settled = true;
        socket.destroy();
        reject(new ResponseTooLarge());
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    socket.once('end', finish);
  });
}

async function beforeDeadline<T>(
  work: Promise<T>,
  deadline: number,
  clock: JudgeTransportClock,
  disposeLate?: (value: T) => void,
): Promise<T> {
  assertBeforeDeadline(deadline, clock);
  const remaining = deadline - clock.now();
  let timedOut = false;
  let handle: unknown;
  try {
    const result = await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        handle = clock.setTimeout(() => {
          timedOut = true;
          reject(new DeadlineExceeded());
        }, remaining);
      }),
    ]);
    assertBeforeDeadline(deadline, clock);
    return result;
  } finally {
    if (handle !== undefined) clock.clearTimeout(handle);
    if (timedOut)
      work.then(
        (late) => disposeLate?.(late),
        () => undefined,
      );
  }
}

/**
 * Data-only transport foundation. It has no owner, operation or registration path; Task 7 supplies authority and
 * settlement. The only network route is B2's resolver → pinned TCP → pinned TLS → synchronous raw write sequence.
 */
export class JudgeTransport {
  readonly #resolver: AddressResolver | undefined;
  readonly #tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly #tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly #clock: JudgeTransportClock;

  constructor(options: JudgeTransportOptions = {}) {
    this.#resolver = options.resolver;
    this.#tcpConnect = options.tcpConnect ?? connectPinnedTcp;
    this.#tlsConnect = options.tlsConnect ?? connectPinnedTls;
    this.#clock = options.clock ?? systemClock;
  }

  async execute(call: JudgeTransportCall, hooks: JudgeTransportHooks): Promise<JudgeTransportResult> {
    if (hooks === undefined || typeof hooks.finalGate !== 'function') return refused('NETWORK_FENCE_REFUSED');
    const adapter = adapterFor(call);
    if (adapter === null) return refused('ADAPTER_REFERENCE_BLOCKED');
    if (!positiveInteger(call.maxInputTokens) || !positiveInteger(call.maxOutputTokens))
      return refused('MALFORMED_RESPONSE');

    let wire: ReturnType<typeof buildJudgeWireRequest>;
    try {
      wire = buildJudgeWireRequest({
        adapter,
        model: call.judge.model,
        state: call.state,
        questionName: call.questionName,
        instructions: call.instructions,
        ...(call.hostedApiKey === undefined ? {} : { hostedApiKey: call.hostedApiKey }),
      });
    } catch {
      return refused('ADAPTER_REFERENCE_BLOCKED');
    }
    let endpoint: URL;
    try {
      if (call.judge.kind === 'typesafe') {
        endpoint = new URL(TYPESAFE_ENDPOINT);
      } else {
        endpoint = validateLocalEndpoint(call.judge.endpoint, call.judge.approvedAddressSet).url;
      }
    } catch {
      return refused('ADAPTER_REFERENCE_BLOCKED');
    }
    const request = requestBytesForEndpoint(endpoint, wire.body, wire.headers);
    if (request.byteLength > call.maxInputTokens) return refused('INPUT_TOKEN_LIMIT_EXCEEDED');
    if (request.byteLength > JUDGE_MAX_REQUEST_BYTES) return refused('REQUEST_TOO_LARGE');

    const deadline = this.#clock.now() + JUDGE_ATTEMPT_DEADLINE_MS;
    let socket: net.Socket | tls.TLSSocket | undefined;
    try {
      await this.#beforeGate(hooks, 'dns');
      this.#finalGate(hooks, 'dns');
      assertBeforeDeadline(deadline, this.#clock);
      const connection = await beforeDeadline(
        preparePinnedConnection(
          call.judge.kind === 'typesafe'
            ? {
                url: endpoint,
                addressMode: 'global-only',
                ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
              }
            : {
                url: endpoint,
                approvedAddressSet: call.judge.approvedAddressSet,
                approvedAddressSetDigest: addressSetDigest(call.judge.approvedAddressSet),
                ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
              },
        ),
        deadline,
        this.#clock,
      );
      assertBeforeDeadline(deadline, this.#clock);

      await this.#beforeGate(hooks, 'tcp');
      this.#finalGate(hooks, 'tcp');
      assertBeforeDeadline(deadline, this.#clock);
      const tcp = await beforeDeadline(
        this.#tcpConnect({ host: connection.address, port: connection.port }),
        deadline,
        this.#clock,
        (late) => late.destroy(),
      );
      assertBeforeDeadline(deadline, this.#clock);
      socket = tcp;
      if (connection.useTls) {
        await this.#beforeGate(hooks, 'tls');
        this.#finalGate(hooks, 'tls');
        assertBeforeDeadline(deadline, this.#clock);
        socket = await beforeDeadline(
          this.#tlsConnect({ socket: tcp, ...connection.tls }),
          deadline,
          this.#clock,
          (late) => late.destroy(),
        );
        assertBeforeDeadline(deadline, this.#clock);
      }

      await this.#beforeGate(hooks, 'write');
      this.#finalGate(hooks, 'write');
      assertBeforeDeadline(deadline, this.#clock);
      socket.write(request);
      const response = boundedResponse(socket);
      const body = await beforeDeadline(response, deadline, this.#clock);
      return parseJudgeResponse({
        adapter,
        protocol:
          call.judge.protocol === 'json-score'
            ? { protocol: 'json-score', scorePointer: call.judge.scorePointer }
            : { protocol: 'noul' },
        questionName: call.questionName,
        response: body,
        maxOutputTokens: call.maxOutputTokens,
      });
    } catch (error) {
      if (error instanceof DeadlineExceeded) return refused('NETWORK_DEADLINE_EXCEEDED');
      if (error instanceof ResponseTooLarge) return refused('RESPONSE_TOO_LARGE');
      if (error instanceof FenceRefused) return refused('NETWORK_FENCE_REFUSED');
      return refused('NETWORK_FAILURE');
    } finally {
      socket?.destroy();
    }
  }

  async #beforeGate(hooks: JudgeTransportHooks, phase: JudgeTransportPhase): Promise<void> {
    try {
      if (hooks.beforeGate !== undefined) await hooks.beforeGate(phase);
    } catch {
      throw new FenceRefused();
    }
  }

  /**
   * At every call site only the synchronous deadline check stands between this gate and the physical B2 network action;
   * no await may be inserted between them.
   */
  #finalGate(hooks: JudgeTransportHooks, phase: JudgeTransportPhase): void {
    let decision: unknown;
    try {
      decision = hooks.finalGate(phase);
    } catch {
      throw new FenceRefused();
    }
    if (decision !== undefined) {
      if (typeof (decision as { then?: unknown } | null)?.then === 'function')
        Promise.resolve(decision).catch(() => undefined);
      throw new FenceRefused();
    }
  }
}
