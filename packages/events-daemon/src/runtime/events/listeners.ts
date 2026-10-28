import type { ApprovalStore, ConfigStore } from '@agentcomms/core';
import { canonicalSubscriber } from '../../domain/activation-documents.ts';
import type { EventDatabase } from '../../store/database.ts';
import type { EventSecretStore } from '../../store/event-secrets.ts';
import type { EventRecordCipher } from '../../store/records.ts';
import type { SseFrameVisibilityGate } from '../phase-d-whatsapp-seam.ts';
import { type SseServer, type SseServerOptions, startSseServer } from '../sse-server.ts';
import type { WebSocketTiming } from '../websocket.ts';

/**
 * The owner's live listeners (workflows design W31): one loopback listener for each subscriber version something may
 * deliver to — one an active workflow's SSE target binds, or one whose subscription is active — started when that
 * begins and closed when it ends. Each is today's `startSseServer`, unchanged in its checks, serving SSE (and from D4
 * WebSocket) on the subscriber's exact authority. A port another program holds is reported, not retried in a loop:
 * `subscribers list` shows `PORT_IN_USE`, and the next reconcile tries again.
 */

export interface SubscriberListenersOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly eventSecrets: Pick<EventSecretStore, 'readLiveGenerations'>;
  /** The owner's stream registry: a token rotation or a removal closes each listener's old streams through it. */
  readonly registry: {
    register(
      input: Pick<SseServer, 'rotate'> & { readonly subscriberId: string; readonly subscriberVersion: number },
    ): () => void;
  };
  readonly now?: (() => number) | undefined;
  readonly visibilityGate?: SseFrameVisibilityGate | undefined;
  readonly hasConcreteWhatsAppVisibilityFence?: boolean | undefined;
  /** Test seam: a WebSocket's ping interval and pong deadline. Production: 30 and 60 seconds. */
  readonly websocket?: WebSocketTiming | undefined;
  /** Test seam: the listener factory. Production uses `startSseServer`. */
  readonly startServer?: ((options: SseServerOptions) => Promise<SseServer>) | undefined;
  /** Test seam: the longest one listener's close is waited for. Production: 3 seconds. */
  readonly closeBoundMs?: number | undefined;
}

/** Where one subscriber version is listening, or why it is not. */
export interface ListenerStatus {
  readonly listening: { readonly host: string; readonly port: number } | null;
  readonly listenError: 'PORT_IN_USE' | null;
}

interface Running {
  readonly server: SseServer;
  readonly unregister: () => void;
}

interface Wanted {
  readonly subscriberId: string;
  readonly version: number;
}

function key(subscriberId: string, version: number): string {
  return `${subscriberId}\u0000${version}`;
}

/**
 * The longest the owner waits for one listener to close (security review of 0.36.0, M1). The listener destroys what
 * its clients leave open well within it; this bounds the reconcile and the stop, which run inside the owner's tick,
 * even if a close never settles.
 */
const LISTENER_CLOSE_BOUND_MS = 3_000;

async function closeWithin(server: SseServer, boundMs: number): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    server.close().catch(() => undefined),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, boundMs);
      timer.unref();
    }),
  ]);
  clearTimeout(timer);
}

export class SubscriberListeners {
  readonly #options: SubscriberListenersOptions;
  readonly #running = new Map<string, Running>();
  readonly #errors = new Map<string, 'PORT_IN_USE'>();
  #turn: Promise<void> = Promise.resolve();
  #closed = false;

  constructor(options: SubscriberListenersOptions) {
    this.#options = options;
  }

  async start(): Promise<void> {
    await this.reconcile();
  }

  /** Starts each wanted listener that is not running, and closes each running one that is no longer wanted. */
  async reconcile(): Promise<void> {
    const turn = this.#turn.then(() => this.#reconcile());
    this.#turn = turn.catch(() => undefined);
    return turn;
  }

  status(subscriberId: string, version: number): ListenerStatus {
    const running = this.#running.get(key(subscriberId, version));
    if (running !== undefined) {
      const authority = running.server.authority;
      return { listening: { host: authority.host, port: authority.port }, listenError: null };
    }
    return { listening: null, listenError: this.#errors.get(key(subscriberId, version)) ?? null };
  }

  /**
   * Writes one event frame the dispatcher has just put in this subscriber's event log to its open streams. Returns how
   * many it reached; none, when nothing is listening — the log is its replay.
   */
  async push(subscriberId: string, version: number, frame: { readonly eventStreamLogId: string }): Promise<number> {
    const running = this.#running.get(key(subscriberId, version));
    if (running === undefined) return 0;
    return running.server.writeEvent({ eventStreamLogId: frame.eventStreamLogId });
  }

  /** A workflow SSE target's frame, just put in `stream_log`, to the subscriber's open streams. */
  async pushRule(subscriberId: string, version: number, frame: { readonly streamLogId: string }): Promise<number> {
    const running = this.#running.get(key(subscriberId, version));
    if (running === undefined) return 0;
    return running.server.writeRule({ streamLogId: frame.streamLogId });
  }

  async close(): Promise<void> {
    this.#closed = true;
    await this.#turn;
    for (const [name, running] of [...this.#running]) {
      this.#running.delete(name);
      running.unregister();
      await closeWithin(running.server, this.#options.closeBoundMs ?? LISTENER_CLOSE_BOUND_MS);
    }
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    const wanted = new Map(this.#wanted().map((entry) => [key(entry.subscriberId, entry.version), entry]));
    for (const [name, running] of [...this.#running]) {
      if (wanted.has(name)) continue;
      this.#running.delete(name);
      running.unregister();
      // Bounded: the tick that reconciles holds the writer lease, and no client may hold it (M1).
      await closeWithin(running.server, this.#options.closeBoundMs ?? LISTENER_CLOSE_BOUND_MS);
    }
    for (const name of [...this.#errors.keys()]) if (!wanted.has(name)) this.#errors.delete(name);
    for (const [name, entry] of wanted) {
      if (this.#running.has(name) || this.#closed) continue;
      try {
        const server = await (this.#options.startServer ?? startSseServer)({
          store: this.#options.store,
          subscriberId: entry.subscriberId,
          subscriberVersion: entry.version,
          cipher: this.#options.cipher,
          approvals: this.#options.approvals,
          config: this.#options.config,
          eventSecrets: this.#options.eventSecrets,
          now: this.#options.now,
          visibilityGate: this.#options.visibilityGate,
          hasConcreteWhatsAppVisibilityFence: this.#options.hasConcreteWhatsAppVisibilityFence,
          websocket: this.#options.websocket,
        });
        const unregister = this.#options.registry.register({
          rotate: (input) => server.rotate(input),
          subscriberId: entry.subscriberId,
          subscriberVersion: entry.version,
        });
        this.#running.set(name, { server, unregister });
        this.#errors.delete(name);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'EADDRINUSE' || code === 'EACCES') this.#errors.set(name, 'PORT_IN_USE');
      }
    }
  }

  /**
   * The live SSE subscriber versions something may deliver to (W31): one an active workflow's SSE target binds, and one
   * whose subscription is active. A revoked version, or one whose stored document no longer reads, has none.
   */
  #wanted(): readonly Wanted[] {
    const database = this.#options.store.database;
    const found = new Map<string, Wanted>();
    const live = (subscriberId: string, version: number): boolean => {
      const row = database
        .prepare(
          'SELECT document FROM subscriber_versions WHERE subscriber_id = ? AND version = ? AND revoked_at IS NULL',
        )
        .get(subscriberId, version) as { document: string } | undefined;
      if (row === undefined) return false;
      try {
        return canonicalSubscriber(JSON.parse(row.document)).kind === 'sse';
      } catch {
        return false;
      }
    };
    const subscribed = database
      .prepare("SELECT subscriber_id, version FROM subscriber_versions WHERE state = 'active' AND revoked_at IS NULL")
      .all() as Array<{ subscriber_id: string; version: number }>;
    for (const row of subscribed)
      if (live(row.subscriber_id, row.version))
        found.set(key(row.subscriber_id, row.version), { subscriberId: row.subscriber_id, version: row.version });
    const rules = database.prepare("SELECT document FROM rule_versions WHERE state = 'active'").all() as Array<{
      document: string;
    }>;
    for (const rule of rules) {
      let targets: unknown;
      try {
        targets = (JSON.parse(rule.document) as { targets?: unknown }).targets;
      } catch {
        continue;
      }
      if (!Array.isArray(targets)) continue;
      for (const target of targets) {
        const bound = target as { kind?: unknown; subscriberId?: unknown; subscriberVersion?: unknown };
        if (
          bound.kind !== 'sse' ||
          typeof bound.subscriberId !== 'string' ||
          typeof bound.subscriberVersion !== 'number'
        )
          continue;
        if (live(bound.subscriberId, bound.subscriberVersion))
          found.set(key(bound.subscriberId, bound.subscriberVersion), {
            subscriberId: bound.subscriberId,
            version: bound.subscriberVersion,
          });
      }
    }
    return [...found.values()];
  }
}
