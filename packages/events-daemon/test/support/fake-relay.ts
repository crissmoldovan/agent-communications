import { randomUUID } from 'node:crypto';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';

/**
 * A loopback stand-in for a claude-stream relay (0.33.0 design §3.5), serving the shapes of its API contract
 * (`agent-stream/docs/agent-relay/api-contract.md`, read 2026-10-26) and nothing else: `GET /v1/relay`,
 * `GET /v1/workspace`, the session list and snapshot, `POST /v1/sessions`, `POST /v1/sessions/:id/runs` with
 * `startId` idempotency and its 409, and the `GET /v1/events?follow=1` SSE stream with `Last-Event-ID` resume. No real
 * claude-stream is ever started or contacted; tests drive what its sessions do through this object.
 */

export const FAKE_RELAY_TOKEN = 'fake-relay-control-token-0123456789abcdef';

export interface FakeSession {
  id: string;
  provider: string;
  cwd: string;
  title: string;
  createdAt: string;
  nativeSessionId?: string;
  activeRunId?: string;
  requestedMode?: string;
  attached?: 'observer';
  capabilities: Record<string, boolean>;
}

export interface FakeRun {
  id: string;
  sessionId: string;
  status: string;
  createdAt: string;
  endedAt?: string;
  startId?: string;
  prompt: string;
  requestedMode?: string;
  sender?: unknown;
}

export interface FakeRelayRecord {
  readonly method: string;
  readonly path: string;
  readonly authorised: boolean;
  readonly body: unknown;
  readonly lastEventId: string | undefined;
  readonly origin: string | undefined;
}

interface Journal {
  readonly id: string;
  readonly cursor: number;
  readonly sessionId: string;
  readonly runId?: string;
  readonly type: string;
}

export interface FakeRelayOptions {
  readonly protocol?: number;
  readonly capabilities?: readonly string[];
  /** Answer `GET /v1/relay` with 404, as a relay older than 2026-10-18 does. */
  readonly noRelayInfo?: boolean;
  readonly allowedRoots?: readonly string[] | null;
}

const uuid = () => randomUUID();

export class FakeRelay {
  readonly sessions: FakeSession[] = [];
  readonly runs: FakeRun[] = [];
  readonly requests: FakeRelayRecord[] = [];
  readonly #journal: Journal[] = [];
  readonly #streams = new Set<ServerResponse>();
  readonly #options: FakeRelayOptions;
  #server: Server | undefined;
  #port = 0;
  /** When set, the stream resends the record at the resumed cursor, as the relay's at-least-once delivery may. */
  resendBoundary = true;

  constructor(options: FakeRelayOptions = {}) {
    this.#options = options;
  }

  get port(): number {
    return this.#port;
  }

  get url(): string {
    return `http://127.0.0.1:${this.#port}`;
  }

  async start(): Promise<this> {
    this.#server = createServer((request, response) => {
      void this.#handle(request, response);
    });
    await new Promise<void>((resolve) => this.#server?.listen(0, '127.0.0.1', resolve));
    this.#port = (this.#server.address() as AddressInfo).port;
    return this;
  }

  async stop(): Promise<void> {
    for (const stream of this.#streams) stream.destroy();
    this.#streams.clear();
    await new Promise<void>((resolve) => this.#server?.close(() => resolve()));
  }

  /** Writes a relay home the way claude-stream does: `control.token` at 0600, and the Pilot app's port record. */
  async writeHome(root: string, mode = 0o600, record = true): Promise<string> {
    const home = join(root, 'relay-home');
    await mkdir(home, { recursive: true, mode: 0o700 });
    const token = join(home, 'control.token');
    await writeFile(token, `${FAKE_RELAY_TOKEN}\n`, { mode });
    await chmod(token, mode);
    if (record) await writeFile(join(root, 'owned-relay.json'), JSON.stringify({ port: this.#port }));
    return home;
  }

  /** A session the person or another client started, as the relay lists it. */
  addSession(input: Partial<FakeSession> & { readonly cwd: string }): FakeSession {
    const session: FakeSession = {
      id: `sess_${uuid()}`,
      provider: 'claude',
      title: 'existing',
      createdAt: new Date().toISOString(),
      capabilities: { streamingText: true },
      ...input,
    };
    this.sessions.push(session);
    this.#publish({ sessionId: session.id, type: 'session.created' });
    return session;
  }

  /** A run someone else started in `sessionId`: the session is busy until `endRun`. */
  startRunElsewhere(sessionId: string): FakeRun {
    const run = this.#newRun(sessionId, 'from elsewhere', undefined);
    return run;
  }

  /** Ends the session's live run with a terminal status, publishing its `run.*` record. */
  endRun(sessionId: string, status: 'completed' | 'failed' | 'cancelled' | 'interrupted' = 'completed'): void {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    const run = this.runs.find((candidate) => candidate.id === session?.activeRunId);
    if (session === undefined || run === undefined) throw new Error('no live run to end');
    run.status = status;
    run.endedAt = new Date().toISOString();
    delete session.activeRunId;
    this.#publish({ sessionId, runId: run.id, type: `run.${status}` });
  }

  /** Drops every open follow stream, as a relay restart or a network blip does; followers resume. */
  disconnectStreams(): void {
    for (const stream of this.#streams) stream.destroy();
    this.#streams.clear();
  }

  get streamCount(): number {
    return this.#streams.size;
  }

  #newRun(sessionId: string, prompt: string, body: Record<string, unknown> | undefined): FakeRun {
    const session = this.sessions.find((candidate) => candidate.id === sessionId);
    if (session === undefined) throw new Error('no such session');
    const run: FakeRun = {
      id: `run_${uuid()}`,
      sessionId,
      status: 'running',
      createdAt: new Date().toISOString(),
      prompt,
      ...(typeof body?.startId === 'string' ? { startId: body.startId } : {}),
      ...(typeof body?.requestedMode === 'string' ? { requestedMode: body.requestedMode } : {}),
      ...(body?.sender === undefined ? {} : { sender: body.sender }),
    };
    this.runs.push(run);
    session.activeRunId = run.id;
    this.#publish({ sessionId, runId: run.id, type: 'run.started' });
    return run;
  }

  #publish(event: Omit<Journal, 'id' | 'cursor'>): void {
    const record: Journal = { id: `evt_${uuid()}`, cursor: this.#journal.length + 1, ...event };
    this.#journal.push(record);
    for (const stream of this.#streams) this.#write(stream, record);
  }

  #write(stream: ServerResponse, record: Journal): void {
    const types = (stream as ServerResponse & { types?: readonly string[] }).types ?? [];
    if (types.length > 0 && !types.includes(record.type)) return;
    stream.write(
      `id: ${record.cursor}\nevent: relay\ndata: ${JSON.stringify({ schemaVersion: 1, provider: 'claude', observedAt: new Date().toISOString(), payload: {}, ...record })}\n\n`,
    );
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    let body: unknown = null;
    try {
      body = text.length === 0 ? null : JSON.parse(text);
    } catch {
      body = text;
    }
    const authorised = request.headers.authorization === `Bearer ${FAKE_RELAY_TOKEN}`;
    this.requests.push({
      method: request.method ?? 'GET',
      path: url.pathname + url.search,
      authorised,
      body,
      lastEventId: request.headers['last-event-id'] as string | undefined,
      origin: request.headers.origin,
    });
    const send = (status: number, value: unknown) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(value));
    };
    const refuse = (status: number, code: string, message: string) =>
      send(status, { error: { code, message: `${code}: ${message}` } });
    if (url.pathname === '/health') return send(200, { ok: true, service: 'agent-relay' });
    if (!authorised) return refuse(401, 'unauthorized', 'a bearer token is required');
    const method = request.method ?? 'GET';
    if (method === 'GET' && url.pathname === '/v1/relay') {
      if (this.#options.noRelayInfo) return refuse(404, 'not_found', 'no such route');
      return send(200, {
        relay: {
          journalId: 'jrn_00000000-0000-4000-8000-000000000001',
          version: '0.2.20',
          protocol: this.#options.protocol ?? 1,
          capabilities: this.#options.capabilities ?? ['journal-id', 'sender', 'answered-by', 'command-ids'],
        },
      });
    }
    if (method === 'GET' && url.pathname === '/v1/workspace') {
      const roots = this.#options.allowedRoots;
      return send(200, {
        defaultCwd: null,
        cwdLocation: 'relay-host',
        ...(roots === undefined || roots === null ? {} : { allowedRoots: roots }),
      });
    }
    if (method === 'GET' && url.pathname === '/v1/sessions') return send(200, { sessions: this.sessions });
    const sessionMatch = /^\/v1\/sessions\/(sess_[0-9a-f-]{36})(\/runs)?$/u.exec(url.pathname);
    if (method === 'GET' && sessionMatch !== null && sessionMatch[2] === undefined) {
      const session = this.sessions.find((candidate) => candidate.id === sessionMatch[1]);
      if (session === undefined) return refuse(404, 'not_found', 'no such session');
      return send(200, {
        session,
        runs: this.runs.filter((run) => run.sessionId === session.id),
        pendingApprovals: [],
        pendingRequests: [],
        cursor: this.#journal.length,
      });
    }
    if (method === 'POST' && url.pathname === '/v1/sessions') {
      const input = body as Record<string, unknown>;
      const roots = this.#options.allowedRoots ?? null;
      if (
        typeof input?.cwd !== 'string' ||
        (roots !== null && !roots.some((root) => input.cwd === root || String(input.cwd).startsWith(`${root}/`)))
      )
        return refuse(400, 'bad_request', 'cwd is outside the allowed roots');
      const session: FakeSession = {
        id: `sess_${uuid()}`,
        provider: String(input.provider),
        cwd: input.cwd,
        title: typeof input.title === 'string' ? input.title : 'new',
        createdAt: new Date().toISOString(),
        capabilities: { streamingText: true },
        ...(typeof input.requestedMode === 'string' ? { requestedMode: input.requestedMode } : {}),
      };
      this.sessions.push(session);
      this.#publish({ sessionId: session.id, type: 'session.created' });
      return send(201, { session });
    }
    if (method === 'POST' && sessionMatch?.[2] === '/runs') {
      const session = this.sessions.find((candidate) => candidate.id === sessionMatch[1]);
      if (session === undefined) return refuse(404, 'not_found', 'no such session');
      const input = body as Record<string, unknown>;
      if (typeof input?.prompt !== 'string') return refuse(400, 'bad_request', 'a prompt is required');
      if (input.prompt.length > 100_000) return refuse(413, 'payload_too_large', 'the prompt is too long');
      const repeated = this.runs.find((run) => run.sessionId === session.id && run.startId === input.startId);
      if (typeof input.startId === 'string' && repeated !== undefined)
        return send(200, { run: repeated, repeated: true });
      if (session.attached === 'observer') return refuse(409, 'conflict', 'a watched session takes no prompt');
      if (session.activeRunId !== undefined)
        return refuse(409, 'conflict', `session ${session.id} already has active run ${session.activeRunId}`);
      return send(202, { run: this.#newRun(session.id, input.prompt, input) });
    }
    if (method === 'GET' && url.pathname === '/v1/events' && url.searchParams.get('follow') === '1') {
      const after = Number(url.searchParams.get('after') ?? '0');
      const last = Number(request.headers['last-event-id'] ?? '0');
      const from = Math.max(after, Number.isFinite(last) ? last : 0);
      const types = (url.searchParams.get('types') ?? '').split(',').filter((type) => type.length > 0);
      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'x-relay-journal': 'jrn_00000000-0000-4000-8000-000000000001',
      });
      Object.assign(response, { types });
      response.write(`: subscribed after=${from}\n\n`);
      // At least once: on a resume the record at the cursor may come again, and the client drops the repeat.
      const start = this.resendBoundary && request.headers['last-event-id'] !== undefined ? from - 1 : from;
      for (const record of this.#journal.slice(Math.max(0, start))) this.#write(response, record);
      response.write(': keepalive\n\n');
      this.#streams.add(response);
      response.on('close', () => this.#streams.delete(response));
      return;
    }
    return refuse(404, 'not_found', 'no such route');
  }
}
