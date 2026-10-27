import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import { canonicalSseSubscriber, type SseSubscriberDocument } from '../domain/sse-subscriber.ts';
import { installErrorSink } from '../network/error-sink.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventSecretOwner, EventSecretStore } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import type { SseFrameVisibilityGate } from './phase-d-whatsapp-seam.ts';
import { StreamReplay } from './stream-replay.ts';
import {
  type SubscriberBearerGeneration,
  type SubscriberStreamAdmission,
  SubscriberStreams,
} from './subscriber-streams.ts';
import {
  acceptWebSocket,
  isWebSocketHandshake,
  LIVE_STREAM_BUFFER_MAX,
  offeredProtocols,
  refuseWebSocket,
  WEBSOCKET_CLOSE,
  type WebSocketPush,
  type WebSocketTiming,
} from './websocket.ts';

/**
 * A listener's own bounds (security review of 0.36.0, M1), set explicitly rather than left to Node's defaults:
 * - a request whose headers have not all arrived after 10 seconds, or that is not whole after 15, is cut. These cover
 *   receiving the request only: an admitted stream's response is not bounded by them;
 * - those deadlines are checked every 5 seconds;
 * - at most 64 connections at once;
 * - when the listener closes, every connection still open after 250 ms is destroyed, so no client — one that sent half
 *   a request, one that stopped reading, an upgraded socket that never answers the close — holds the close, nor the
 *   owner's tick that waits for it.
 */
const HEADERS_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const CONNECTIONS_CHECKING_INTERVAL_MS = 5_000;
const MAX_CONNECTIONS = 64;
const CLOSE_GRACE_MS = 250;

export interface SseServerOptions {
  readonly store: EventDatabase;
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  /** Test seam; production callers use eventSecrets so every bearer reference is resolved by the real ledger. */
  readonly readBearerGenerations?: ((owner: EventSecretOwner) => Promise<readonly SseBearerMaterial[]>) | undefined;
  readonly eventSecrets?: Pick<EventSecretStore, 'readLiveGenerations'> | undefined;
  readonly now?: (() => number) | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly visibilityGate?: SseFrameVisibilityGate | undefined;
  readonly hasConcreteWhatsAppVisibilityFence?: boolean | undefined;
  /** Test seam: an already-bound loopback server, so its ephemeral port is never released and reacquired. */
  readonly listener?: Server | undefined;
  /** Test seam: a WebSocket's ping interval and pong deadline (production: 30 and 60 seconds). */
  readonly websocket?: WebSocketTiming | undefined;
  /** Test seam: the request deadlines of a listener this server binds itself (production: 10 s, 15 s, checked every 5 s). */
  readonly httpTimeouts?:
    | {
        readonly headersTimeoutMs?: number | undefined;
        readonly requestTimeoutMs?: number | undefined;
        readonly connectionsCheckingIntervalMs?: number | undefined;
      }
    | undefined;
}

export interface SseBearerMaterial {
  readonly generation: number;
  readonly lifecycle: 'current' | 'overlap';
  readonly material: string;
  readonly expiresAt?: number | null | undefined;
}

export interface SseServer {
  readonly authority: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>;
  /** The listener's actual bound address, for health checks and tests: it must equal the persisted authority. */
  boundAddress(): AddressInfo | string | null;
  close(): Promise<void>;
  rotate(input: Readonly<{ subscriberId: string; subscriberVersion: number; generation: number }>): void;
  writeLive(
    input: Readonly<{
      streamLogId: string;
      frame: string;
    }>,
  ): Promise<number>;
  /**
   * One raised event's frame, from this subscriber's event log (0.36.0, W31), to every open stream that is still
   * current: the same bearer, subscriber and generation checks as `writeLive`, and W35's fence before and after the
   * record is opened. Returns how many streams it reached.
   */
  writeEvent(input: Readonly<{ eventStreamLogId: string }>): Promise<number>;
  /** One workflow SSE target's frame, from this subscriber's `stream_log`, to every open stream that is still current. */
  writeRule(input: Readonly<{ streamLogId: string }>): Promise<number>;
  preflightCount(): number;
}

interface PersistedSubscriber {
  readonly document: SseSubscriberDocument;
  readonly owner: EventSecretOwner;
}

interface LiveConnection {
  readonly generation: number;
  /** An overlap-bearer stream's authority ends here; a current-bearer stream has none until a rotation. */
  readonly authorizedUntil: number | undefined;
  /** SSE (the response stream) or WebSocket (0.36.0, W31): the same admission, a different framing. */
  readonly transport: 'sse' | 'websocket';
  readonly write: (frame: string) => void;
  readonly close: () => void;
}

/** A rule frame's CloudEvent, for a WebSocket: the one `data:` line of its SSE frame. */
function frameData(frame: string): string {
  return (
    frame
      .split('\n')
      .find((line) => line.startsWith('data: '))
      ?.slice('data: '.length) ?? ''
  );
}

/** A value a browser offers as a subprotocol (W31): `agentcomms.bearer.<token>`, `agentcomms.after.<event id>`. */
function subprotocolValue(request: IncomingMessage, prefix: string): string | null {
  const offered = offeredProtocols(request).filter((entry) => entry.startsWith(prefix));
  if (offered.length !== 1) return null;
  const value = (offered[0] as string).slice(prefix.length);
  return value.length > 0 ? value : null;
}

function expectedHost(authority: SseSubscriberDocument['authority']): string {
  return authority.host === '::1' ? `[::1]:${authority.port}` : `${authority.host}:${authority.port}`;
}

function assertInjectedListener(listener: Server, authority: SseSubscriberDocument['authority']): void {
  if (!listener.listening) throw new Error('the injected SSE listener is not listening');
  const address = listener.address();
  if (
    address === null ||
    typeof address === 'string' ||
    address.address !== authority.host ||
    address.port !== authority.port
  ) {
    throw new Error('the injected SSE listener is not bound to the subscriber exact loopback authority');
  }
}

function pathFor(subscriberId: string): string {
  return `/v1/streams/${encodeURIComponent(subscriberId)}`;
}

function bearer(header: string | undefined): string | null {
  if (header === undefined || !header.startsWith('Bearer ')) return null;
  const value = header.slice('Bearer '.length);
  return value.length > 0 && !value.includes('\t') && !value.includes('\n') ? value : null;
}

function requestHeaders(value: string | undefined): boolean {
  if (value === undefined) return true;
  const requested = value
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return (
    requested.length > 0 &&
    requested.length === new Set(requested).size &&
    requested.every((entry) => entry === 'authorization' || entry === 'last-event-id')
  );
}

function corsHeaders(origin: string | undefined, subscriber: SseSubscriberDocument): Record<string, string> | null {
  if (origin === undefined) return {};
  if (!subscriber.origins.includes(origin)) return null;
  return { 'Access-Control-Allow-Origin': origin, Vary: 'Origin' };
}

function endForbidden(response: ServerResponse): void {
  response.writeHead(403, { 'Cache-Control': 'no-store' });
  response.end();
}

function endNotFound(response: ServerResponse): void {
  response.writeHead(404, { 'Cache-Control': 'no-store' });
  response.end();
}

function asBearerGenerations(values: readonly SseBearerMaterial[]): readonly SubscriberBearerGeneration[] {
  return values.map((value) => ({
    generation: value.generation,
    lifecycle: value.lifecycle,
    material: value.material,
    ...(value.expiresAt === null ? {} : { expiresAt: value.expiresAt }),
  }));
}

/**
 * The private loopback SSE boundary. It accepts no target or subscriber operation: callers supply one immutable
 * subscriber version and its secret-store reader, and every incoming request is checked against that persisted row.
 */
class LoopbackSseServer implements SseServer {
  readonly #options: SseServerOptions;
  readonly #subscriber: PersistedSubscriber;
  readonly #streams: SubscriberStreams;
  readonly #replay: StreamReplay;
  readonly #server: Server;
  readonly #ownsServer: boolean;
  readonly #connections = new Set<LiveConnection>();
  /** Every socket this listener accepted that is still open, upgraded ones included: a close destroys what is left. */
  readonly #sockets = new Set<Socket>();
  readonly #requestListener = (request: IncomingMessage, response: ServerResponse) =>
    void this.#handle(request, response);
  readonly #connectionListener = (socket: Socket) => {
    installErrorSink(socket);
    this.#sockets.add(socket);
    socket.once('close', () => this.#sockets.delete(socket));
  };
  readonly #upgradeListener = (request: IncomingMessage, socket: Duplex, head: Buffer) =>
    void this.#upgrade(request, socket, head).catch(() => socket.destroy());
  #preflightCount = 0;
  #closed = false;
  #closing: Promise<void> | undefined;

  private constructor(options: SseServerOptions, subscriber: PersistedSubscriber) {
    this.#options = options;
    this.#subscriber = subscriber;
    this.#streams = new SubscriberStreams({ now: options.now });
    this.#replay = new StreamReplay({
      store: options.store,
      cipher: options.cipher,
      approvals: options.approvals,
      config: options.config,
      now: options.now,
      fence: options.fence ?? assertDisclosable,
      visibilityGate: options.visibilityGate,
      hasConcreteWhatsAppVisibilityFence: options.hasConcreteWhatsAppVisibilityFence,
    });
    this.#ownsServer = options.listener === undefined;
    this.#server = options.listener ?? LoopbackSseServer.#createListener(options.httpTimeouts);
    this.#server.on('request', this.#requestListener);
    if (this.#ownsServer) installErrorSink(this.#server);
    this.#server.on('connection', this.#connectionListener);
    this.#server.on('upgrade', this.#upgradeListener);
  }

  /** A listener with its bounds set explicitly (M1): request deadlines and a connection cap. */
  static #createListener(timeouts: SseServerOptions['httpTimeouts']): Server {
    const server = createServer({
      headersTimeout: timeouts?.headersTimeoutMs ?? HEADERS_TIMEOUT_MS,
      requestTimeout: timeouts?.requestTimeoutMs ?? REQUEST_TIMEOUT_MS,
      connectionsCheckingInterval: timeouts?.connectionsCheckingIntervalMs ?? CONNECTIONS_CHECKING_INTERVAL_MS,
    });
    server.maxConnections = MAX_CONNECTIONS;
    return server;
  }

  static async start(options: SseServerOptions): Promise<LoopbackSseServer> {
    const subscriber = readSubscriber(options);
    if (options.listener !== undefined) assertInjectedListener(options.listener, subscriber.document.authority);
    const result = new LoopbackSseServer(options, subscriber);
    if (!result.#ownsServer) return result;
    await new Promise<void>((resolve, reject) => {
      result.#server.once('error', reject);
      result.#server.listen(subscriber.document.authority.port, subscriber.document.authority.host, () => {
        result.#server.off('error', reject);
        resolve();
      });
    });
    return result;
  }

  get authority(): Readonly<{ host: '127.0.0.1' | '::1'; port: number }> {
    return this.#subscriber.document.authority;
  }

  boundAddress(): AddressInfo | string | null {
    return this.#server.address();
  }

  /**
   * Ends every stream and stops listening, within a bound whatever the clients do (security review of 0.36.0, M1). A
   * second call returns the first's promise.
   */
  close(): Promise<void> {
    this.#closing ??= this.#close();
    return this.#closing;
  }

  async #close(): Promise<void> {
    this.#closed = true;
    for (const connection of [...this.#connections]) connection.close();
    this.#server.off('request', this.#requestListener);
    this.#server.off('connection', this.#connectionListener);
    this.#server.off('upgrade', this.#upgradeListener);
    // A request left half-sent, a reader that stopped reading, an upgraded socket whose peer never answers the close:
    // whatever is still open after the grace is destroyed, so no client can hold this close open.
    const grace = setTimeout(() => {
      for (const socket of this.#sockets) socket.destroy();
    }, CLOSE_GRACE_MS);
    grace.unref();
    if (!this.#ownsServer) return;
    try {
      await new Promise<void>((resolve, reject) => {
        this.#server.close((error) => (error === undefined ? resolve() : reject(error)));
        // `close` stops the server's own check of request deadlines, so a request still being received would never be
        // cut: every HTTP connection ends now. Upgraded sockets are not among them; the grace ends those.
        this.#server.closeAllConnections();
      });
    } finally {
      clearTimeout(grace);
    }
  }

  rotate(input: Readonly<{ subscriberId: string; subscriberVersion: number; generation: number }>): void {
    this.#streams.rotate(input);
  }

  async writeLive(
    input: Readonly<{
      streamLogId: string;
      frame: string;
    }>,
  ): Promise<number> {
    let written = 0;
    for (const connection of [...this.#connections]) {
      if (
        !this.#streams.isCurrent({
          subscriberId: this.#subscriber.document.subscriberId,
          subscriberVersion: this.#subscriber.document.version,
          generation: connection.generation,
          authorizedUntil: connection.authorizedUntil,
        }) ||
        !this.#bearerGenerationLive(connection.generation)
      ) {
        // A rotated or expired-overlap stream has lost its bearer authority: end it rather than keep it open.
        connection.close();
        continue;
      }
      const wrote = await this.#replay.writeLive({
        streamLogId: input.streamLogId,
        frame: input.frame,
        isStreamCurrent: () =>
          this.#connections.has(connection) &&
          this.#subscriberIsCurrent() &&
          this.#streams.isCurrent({
            subscriberId: this.#subscriber.document.subscriberId,
            subscriberVersion: this.#subscriber.document.version,
            generation: connection.generation,
            authorizedUntil: connection.authorizedUntil,
          }) &&
          this.#bearerGenerationLive(connection.generation),
        writeFrame: (frame) => {
          connection.write(connection.transport === 'sse' ? frame : frameData(frame));
        },
      });
      if (wrote) written += 1;
    }
    return written;
  }

  async writeRule(input: Readonly<{ streamLogId: string }>): Promise<number> {
    let written = 0;
    for (const connection of [...this.#connections]) {
      if (!this.#connectionIsCurrent(connection)) {
        connection.close();
        continue;
      }
      const wrote = await this.#replay.writeRule({
        streamLogId: input.streamLogId,
        subscriberId: this.#subscriber.document.subscriberId,
        subscriberVersion: this.#subscriber.document.version,
        transport: connection.transport,
        isStreamCurrent: () =>
          this.#connections.has(connection) && this.#subscriberIsCurrent() && this.#connectionIsCurrent(connection),
        writeFrame: (frame) => {
          connection.write(frame);
        },
      });
      if (wrote) written += 1;
    }
    return written;
  }

  async writeEvent(input: Readonly<{ eventStreamLogId: string }>): Promise<number> {
    let written = 0;
    for (const connection of [...this.#connections]) {
      if (!this.#connectionIsCurrent(connection)) {
        // A rotated or expired-overlap stream has lost its bearer authority: end it rather than keep it open.
        connection.close();
        continue;
      }
      const wrote = await this.#replay.writeEvent({
        eventStreamLogId: input.eventStreamLogId,
        subscriberId: this.#subscriber.document.subscriberId,
        subscriberVersion: this.#subscriber.document.version,
        transport: connection.transport,
        isStreamCurrent: () =>
          this.#connections.has(connection) && this.#subscriberIsCurrent() && this.#connectionIsCurrent(connection),
        writeFrame: (frame) => {
          connection.write(frame);
        },
      });
      if (wrote) written += 1;
    }
    return written;
  }

  #connectionIsCurrent(connection: LiveConnection): boolean {
    return (
      this.#streams.isCurrent({
        subscriberId: this.#subscriber.document.subscriberId,
        subscriberVersion: this.#subscriber.document.version,
        generation: connection.generation,
        authorizedUntil: connection.authorizedUntil,
      }) && this.#bearerGenerationLive(connection.generation)
    );
  }

  preflightCount(): number {
    return this.#preflightCount;
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const subscriber = this.#subscriber.document;
    const parsed = new URL(request.url ?? '/', 'http://loopback.invalid');
    if (parsed.pathname !== pathFor(subscriber.subscriberId)) return endNotFound(response);
    if (parsed.search !== '' || request.headers.host !== expectedHost(subscriber.authority))
      return endForbidden(response);
    if (request.headers.cookie !== undefined) return endForbidden(response);
    const cors = corsHeaders(request.headers.origin, subscriber);
    if (cors === null) return endForbidden(response);
    if (request.method === 'OPTIONS') {
      if (
        request.headers.origin === undefined ||
        request.headers['access-control-request-method'] !== 'GET' ||
        !requestHeaders(request.headers['access-control-request-headers'])
      ) {
        return endForbidden(response);
      }
      this.#preflightCount += 1;
      response.writeHead(204, {
        ...cors,
        'Access-Control-Allow-Methods': 'GET',
        'Access-Control-Allow-Headers': 'Authorization, Last-Event-ID',
        'Cache-Control': 'no-store',
      });
      response.end();
      return;
    }
    if (request.method !== 'GET') return endNotFound(response);
    const token = bearer(request.headers.authorization);
    if (token === null) return endForbidden(response);

    let admission: SubscriberStreamAdmission | null;
    try {
      const generations = await this.#bearerGenerations();
      // A listener that closed while the bearer was read admits nothing more.
      if (this.#closed || !this.#subscriberIsCurrent()) return endForbidden(response);
      admission = this.#streams.admit({
        bearer: token,
        generations: asBearerGenerations(generations),
      });
    } catch {
      return endForbidden(response);
    }
    if (admission === null) return endForbidden(response);
    const { generation, currentGeneration, authorizedUntil } = admission;

    let closed = false;
    let overlapEnds: NodeJS.Timeout | undefined;
    const close = () => {
      if (closed) return;
      closed = true;
      clearTimeout(overlapEnds);
      this.#connections.delete(connection);
      this.#streams.unregister({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
      });
      response.end();
    };
    // Every frame, live or replayed: a reader that leaves more than 1 MiB unread is closed, not buffered for (L8).
    const send = (frame: string) => {
      if (closed) return;
      response.write(frame);
      if (response.writableLength <= LIVE_STREAM_BUFFER_MAX) return;
      close();
      response.destroy();
    };
    const connection: LiveConnection = {
      generation,
      authorizedUntil,
      transport: 'sse',
      write: send,
      close,
    };
    if (
      !this.#streams.register({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
        currentGeneration,
        authorizedUntil,
      }) ||
      !this.#subscriberIsCurrent() ||
      !this.#streams.isCurrent({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        authorizedUntil,
      })
    ) {
      return endForbidden(response);
    }
    this.#connections.add(connection);
    response.once('close', close);
    overlapEnds = this.#endAtOverlap(authorizedUntil, close);
    // This is the header gate: no await occurs between the current-generation check and writeHead.
    if (
      !this.#subscriberIsCurrent() ||
      !this.#streams.isCurrent({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        authorizedUntil,
      }) ||
      !this.#bearerGenerationLive(generation)
    ) {
      close();
      return;
    }
    response.writeHead(200, {
      ...cors,
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive',
    });
    response.flushHeaders();
    await this.#replay.replay({
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      afterId: typeof request.headers['last-event-id'] === 'string' ? request.headers['last-event-id'] : null,
      writeFrame: (frame) => {
        if (
          !closed &&
          this.#subscriberIsCurrent() &&
          this.#streams.isCurrent({
            subscriberId: subscriber.subscriberId,
            subscriberVersion: subscriber.version,
            generation,
            authorizedUntil,
          }) &&
          this.#bearerGenerationLive(generation)
        ) {
          send(frame);
        }
      },
    });
  }

  /**
   * A stream admitted on the previous token ends when that token's overlap does, whether or not a frame comes then
   * (security review of 0.36.0, L8). A stream on the current token has no such end until a rotation closes it.
   */
  #endAtOverlap(authorizedUntil: number | undefined, close: () => void): NodeJS.Timeout | undefined {
    if (authorizedUntil === undefined) return undefined;
    const timer = setTimeout(close, Math.max(0, authorizedUntil - (this.#options.now ?? Date.now)()));
    timer.unref();
    return timer;
  }

  /**
   * WebSocket on the same listener and path (0.36.0, W31): the same Host, query, cookie and Origin refusals, the
   * same bearer admission — from `Authorization`, or offered by a browser as the subprotocol
   * `agentcomms.bearer.<token>` — and the same replay, from Last-Event-ID or `agentcomms.after.<event id>`. The answer
   * names `agentcomms.events.v1` only. A rotated or revoked bearer closes it with 4401.
   */
  async #upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    installErrorSink(socket as Socket);
    const subscriber = this.#subscriber.document;
    const parsed = new URL(request.url ?? '/', 'http://loopback.invalid');
    if (parsed.pathname !== pathFor(subscriber.subscriberId)) return refuseWebSocket(socket, 404);
    if (parsed.search !== '' || request.headers.host !== expectedHost(subscriber.authority))
      return refuseWebSocket(socket, 403);
    if (request.headers.cookie !== undefined) return refuseWebSocket(socket, 403);
    if (corsHeaders(request.headers.origin, subscriber) === null) return refuseWebSocket(socket, 403);
    if (!isWebSocketHandshake(request)) return refuseWebSocket(socket, 400);
    const header = bearer(request.headers.authorization);
    const offered = header === null ? subprotocolValue(request, 'agentcomms.bearer.') : null;
    // A bearer offered as a subprotocol is a browser's, so it is accepted only from an Origin the subscriber lists
    // (design §14); a program sends it in Authorization.
    if (offered !== null && request.headers.origin === undefined) return refuseWebSocket(socket, 403);
    const token = header ?? offered;
    if (token === null) return refuseWebSocket(socket, 403);
    let admission: SubscriberStreamAdmission | null;
    try {
      const generations = await this.#bearerGenerations();
      // A listener that closed while the bearer was read admits nothing more.
      if (this.#closed || !this.#subscriberIsCurrent()) return refuseWebSocket(socket, 403);
      admission = this.#streams.admit({ bearer: token, generations: asBearerGenerations(generations) });
    } catch {
      return refuseWebSocket(socket, 403);
    }
    if (admission === null) return refuseWebSocket(socket, 403);
    const { generation, currentGeneration, authorizedUntil } = admission;
    const current = () =>
      this.#subscriberIsCurrent() &&
      this.#streams.isCurrent({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        authorizedUntil,
      }) &&
      this.#bearerGenerationLive(generation);
    let push: WebSocketPush | null = null;
    let closed = false;
    let overlapEnds: NodeJS.Timeout | undefined;
    const forget = () => {
      clearTimeout(overlapEnds);
      this.#connections.delete(connection);
      this.#streams.unregister({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
      });
    };
    // The registry's close: a rotated or revoked bearer ends the socket with 4401, as an SSE stream is ended.
    const close = () => {
      if (closed) return;
      closed = true;
      forget();
      push?.close(WEBSOCKET_CLOSE.unauthorised);
    };
    const connection: LiveConnection = {
      generation,
      authorizedUntil,
      transport: 'websocket',
      write: (text) => push?.send(text),
      close,
    };
    if (
      !this.#streams.register({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
        currentGeneration,
        authorizedUntil,
      }) ||
      !current()
    ) {
      closed = true;
      forget();
      return refuseWebSocket(socket, 403);
    }
    // This is the handshake gate: no await occurs between the current-generation check and the 101.
    push = acceptWebSocket(request, socket, head, this.#options.websocket);
    if (push === null) {
      closed = true;
      forget();
      return;
    }
    this.#connections.add(connection);
    push.onClose(() => {
      if (closed) return;
      closed = true;
      forget();
    });
    // The previous token's overlap ends the socket with 4401, as a rotation does, though no frame comes then.
    if (!closed) overlapEnds = this.#endAtOverlap(authorizedUntil, close);
    const lastEventId = request.headers['last-event-id'];
    const afterId = typeof lastEventId === 'string' ? lastEventId : subprotocolValue(request, 'agentcomms.after.');
    await this.#replay.replay({
      subscriberId: subscriber.subscriberId,
      subscriberVersion: subscriber.version,
      afterId,
      transport: 'websocket',
      writeFrame: (text) => {
        if (!closed && current()) push?.send(text);
      },
    });
  }

  async #bearerGenerations(): Promise<readonly SseBearerMaterial[]> {
    if (this.#options.readBearerGenerations !== undefined)
      return this.#options.readBearerGenerations(this.#subscriber.owner);
    if (this.#options.eventSecrets === undefined)
      throw new Error('the SSE listener needs an event-secret bearer reader');
    return this.#options.eventSecrets.readLiveGenerations({
      owner: this.#subscriber.owner,
      purpose: 'sse-bearer',
      cipher: this.#options.cipher,
    });
  }

  #subscriberIsCurrent(): boolean {
    try {
      const current = readSubscriber(this.#options);
      return (
        current.owner.digest === this.#subscriber.owner.digest &&
        current.document.authority.host === this.#subscriber.document.authority.host &&
        current.document.authority.port === this.#subscriber.document.authority.port
      );
    } catch {
      return false;
    }
  }

  /**
   * The secret ledger, not this process's memory, says which bearer generations are live: a rotation persisted by
   * any writer ends an older stream at its next frame. Read synchronously so it can sit directly before a write.
   */
  #bearerGenerationLive(generation: number): boolean {
    const owner = this.#subscriber.owner;
    const row = this.#options.store.database
      .prepare(
        `SELECT owner_digest, lifecycle, expires_at FROM event_secret_generations
         WHERE owner_kind = 'subscriber' AND owner_id = ? AND owner_version = ? AND purpose = 'sse-bearer'
           AND generation = ?`,
      )
      .get(owner.id, owner.version, generation) as
      | { owner_digest: string; lifecycle: string; expires_at: number | null }
      | undefined;
    if (row === undefined || row.owner_digest !== owner.digest) return false;
    if (row.lifecycle === 'current') return true;
    return row.lifecycle === 'overlap' && row.expires_at !== null && row.expires_at > (this.#options.now ?? Date.now)();
  }
}

function readSubscriber(
  options: Pick<SseServerOptions, 'store' | 'subscriberId' | 'subscriberVersion'>,
): PersistedSubscriber {
  const row = options.store.database
    .prepare(
      `SELECT document, digest, revoked_at FROM subscriber_versions
       WHERE subscriber_id = ? AND version = ?`,
    )
    .get(options.subscriberId, options.subscriberVersion) as
    | { document: string; digest: string; revoked_at: number | null }
    | undefined;
  if (row === undefined || row.revoked_at !== null) throw new Error('the exact SSE subscriber version is not live');
  const document = canonicalSseSubscriber(JSON.parse(row.document));
  if (document.subscriberId !== options.subscriberId || document.version !== options.subscriberVersion)
    throw new Error('the stored SSE subscriber document does not match its immutable identity');
  return {
    document,
    owner: { kind: 'subscriber', id: document.subscriberId, version: document.version, digest: row.digest },
  };
}

export async function startSseServer(options: SseServerOptions): Promise<SseServer> {
  return LoopbackSseServer.start(options);
}
