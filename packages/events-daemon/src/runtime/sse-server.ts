import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import { canonicalSseSubscriber, type SseSubscriberDocument } from '../domain/sse-subscriber.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventSecretOwner, EventSecretStore } from '../store/event-secrets.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import type { SseFrameVisibilityGate } from './phase-d-whatsapp-seam.ts';
import { StreamReplay } from './stream-replay.ts';
import { type SubscriberBearerGeneration, SubscriberStreams } from './subscriber-streams.ts';

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
}

export interface SseBearerMaterial {
  readonly generation: number;
  readonly lifecycle: 'current' | 'overlap';
  readonly material: string;
  readonly expiresAt?: number | null | undefined;
}

export interface SseServer {
  readonly authority: Readonly<{ host: '127.0.0.1' | '::1'; port: number }>;
  close(): Promise<void>;
  rotate(input: Readonly<{ subscriberId: string; subscriberVersion: number; generation: number }>): void;
  writeLive(
    input: Readonly<{
      streamLogId: string;
      frame: string;
    }>,
  ): Promise<number>;
  preflightCount(): number;
}

interface PersistedSubscriber {
  readonly document: SseSubscriberDocument;
  readonly owner: EventSecretOwner;
}

interface LiveConnection {
  readonly generation: number;
  readonly response: ServerResponse;
  readonly close: () => void;
}

function expectedHost(authority: SseSubscriberDocument['authority']): string {
  return authority.host === '::1' ? `[::1]:${authority.port}` : `${authority.host}:${authority.port}`;
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
  readonly #connections = new Set<LiveConnection>();
  #preflightCount = 0;

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
    this.#server = createServer((request, response) => void this.#handle(request, response));
  }

  static async start(options: SseServerOptions): Promise<LoopbackSseServer> {
    const subscriber = readSubscriber(options);
    const result = new LoopbackSseServer(options, subscriber);
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

  async close(): Promise<void> {
    for (const connection of this.#connections) connection.close();
    await new Promise<void>((resolve, reject) =>
      this.#server.close((error) => (error === undefined ? resolve() : reject(error))),
    );
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
        })
      ) {
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
          }),
        writeFrame: (frame) => {
          connection.response.write(frame);
        },
      });
      if (wrote) written += 1;
    }
    return written;
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

    let generation: number | null;
    try {
      const generations = await this.#bearerGenerations();
      if (!this.#subscriberIsCurrent()) return endForbidden(response);
      generation = this.#streams.authenticate({
        bearer: token,
        generations: asBearerGenerations(generations),
      });
    } catch {
      return endForbidden(response);
    }
    if (generation === null) return endForbidden(response);

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      this.#connections.delete(connection);
      this.#streams.unregister({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
      });
      response.end();
    };
    const connection: LiveConnection = { generation, response, close };
    if (
      !this.#streams.register({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
        close,
      }) ||
      !this.#subscriberIsCurrent() ||
      !this.#streams.isCurrent({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
      })
    ) {
      return endForbidden(response);
    }
    this.#connections.add(connection);
    response.once('close', close);
    // This is the header gate: no await occurs between the current-generation check and writeHead.
    if (
      !this.#subscriberIsCurrent() ||
      !this.#streams.isCurrent({
        subscriberId: subscriber.subscriberId,
        subscriberVersion: subscriber.version,
        generation,
      })
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
          })
        ) {
          response.write(frame);
        }
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
