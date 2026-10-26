/**
 * The spike's router (single-server design D1–D5, §4–§5): toward the client it is one low-level SDK `Server`, served
 * by `serveStdio` so it speaks whichever era the client opens with; toward each part it is a raw JSON-RPC link over
 * the SDK's `StdioClientTransport` (framing and process only, no `Client`), so that no SDK default answers, retries,
 * refuses or reshapes anything a part sends.
 *
 * Not product code: no restart backoff, no status file, no instructions budget, no key check.
 */
import { clientStdio, PASSTHROUGH, server as sdk, serverStdio, z } from './sdk.mjs';

const { Server, ProtocolErrorCode } = sdk;
const { StdioClientTransport } = clientStdio;

/** The reserved per-request envelope keys of 2026-07-28 (`RESERVED_ENVELOPE_META_KEYS` in the SDK). */
const ENVELOPE_KEYS = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/logLevel',
];
const STDERR_LINE_LIMIT = 4096;
const TERMINAL_TASK_STATES = new Set(['completed', 'failed', 'cancelled']);
/** Stripped from every part's environment (§4): the key, and the launcher name that would claim `core`. */
const STRIPPED_ENV = ['AGENT_COMMS_CONNECTION_KEY', 'AGENT_COMMS_LAUNCHER'];
/** The client requests the router forwards with the client's own params. */
const FORWARDED = new Set(['tools/call', 'tasks/get', 'tasks/cancel']);

const isRequest = (m) => m !== null && typeof m === 'object' && 'method' in m && 'id' in m;
const isNotification = (m) => m !== null && typeof m === 'object' && 'method' in m && !('id' in m);
const isResponse = (m) => m !== null && typeof m === 'object' && 'id' in m && ('result' in m || 'error' in m);

function envelopeOf(message) {
  const meta = message?.params?._meta;
  if (meta === null || typeof meta !== 'object') return undefined;
  const envelope = {};
  for (const key of ENVELOPE_KEYS) if (Object.hasOwn(meta, key)) envelope[key] = meta[key];
  return Object.keys(envelope).length === 0 ? undefined : envelope;
}

/** An error the SDK encodes as-is: `code`, an unprefixed `message`, and `data` (a `ProtocolError` would prefix it). */
function wireError({ code, message, data }) {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** A transport that shows the router every inbound message before `serveStdio` does (§4: the factory needs it). */
function peeking(inner, onInbound) {
  const wire = {
    onmessage: undefined,
    onclose: undefined,
    onerror: undefined,
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    get sessionId() {
      return inner.sessionId;
    },
  };
  inner.onmessage = (message, extra) => {
    onInbound(message);
    wire.onmessage?.(message, extra);
  };
  inner.onclose = () => wire.onclose?.();
  inner.onerror = (error) => wire.onerror?.(error);
  return wire;
}

class Part {
  constructor(spec, router) {
    this.spec = spec;
    this.id = spec.id;
    this.prefix = spec.prefix ?? spec.id;
    this.router = router;
    this.state = 'new';
    this.pending = new Map();
    this.nextId = 0;
    this.tools = [];
    this.capabilities = {};
    this.instructions = undefined;
    this.serverInfo = undefined;
    this.ready = undefined;
  }

  get label() {
    return this.spec.label ?? this.id;
  }

  spawn() {
    const base = this.spec.env ?? process.env;
    const env = {};
    for (const [key, value] of Object.entries(base)) if (!STRIPPED_ENV.includes(key)) env[key] = value;
    env.AGENTCOMMS_GATEWAY_PID = String(process.pid);
    if (this.router.connectionId !== undefined) env.AGENTCOMMS_CONNECTION = this.router.connectionId;
    this.transport = new StdioClientTransport({
      command: this.spec.command,
      args: this.spec.args ?? [],
      env,
      stderr: 'pipe',
      ...(this.spec.cwd === undefined ? {} : { cwd: this.spec.cwd }),
    });
    let partial = '';
    this.transport.stderr?.on('data', (chunk) => {
      partial += chunk.toString('utf8');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) this.router.log(`[agentcomms:${this.id}] ${line.slice(0, STDERR_LINE_LIMIT)}`);
    });
    this.transport.onmessage = (message) => this.#onmessage(message);
    this.transport.onclose = () => this.#onclose();
    this.transport.onerror = (error) => this.router.log(`[agentcomms:${this.id}] transport: ${error.message}`);
    this.state = 'starting';
    this.spawned = this.transport.start().then(
      () => {
        this.pid = this.transport.pid;
      },
      (error) => {
        this.router.log(`[agentcomms:${this.id}] did not start: ${error.message}`);
        this.#onclose();
        throw error;
      },
    );
    this.spawned.catch(() => undefined);
    return this.spawned;
  }

  stoppedError() {
    return {
      code: ProtocolErrorCode.InternalError,
      message: `${this.label} stopped in this connection; Agent Comms is not retrying this call`,
    };
  }

  /** One request to the part, under the router's own id. Resolves with `{result}`, `{error}` or `{cancelled}`. */
  request(method, params, { signal, cancelMeta } = {}) {
    if (this.state === 'stopped' || this.state === 'stopping') return Promise.resolve({ error: this.stoppedError() });
    this.nextId += 1;
    const id = this.nextId;
    const message = { jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) };
    return new Promise((resolve) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        // Down to the one part concerned (§5.4): the part's own request id, never the client's.
        this.notify('notifications/cancelled', {
          requestId: id,
          reason: String(signal?.reason?.message ?? signal?.reason ?? 'cancelled by the client'),
          ...(cancelMeta === undefined ? {} : { _meta: cancelMeta }),
        });
        resolve({ cancelled: true });
      };
      this.pending.set(id, (answer) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      });
      if (signal?.aborted) return onAbort();
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport.send(message).catch((error) => {
        this.pending.delete(id);
        resolve({ error: { code: ProtocolErrorCode.InternalError, message: `${this.label}: ${error.message}` } });
      });
    });
  }

  notify(method, params) {
    if (this.state === 'stopped' || this.transport === undefined) return;
    this.transport.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) }).catch(() => undefined);
  }

  reply(id, answer) {
    if (this.state === 'stopped') return;
    this.transport.send({ jsonrpc: '2.0', id, ...answer }).catch(() => undefined);
  }

  #onmessage(message) {
    if (isResponse(message)) {
      const settle = this.pending.get(message.id);
      if (settle === undefined) return;
      this.pending.delete(message.id);
      settle(message.error === undefined ? { result: message.result } : { error: message.error });
      return;
    }
    if (isRequest(message)) {
      void this.router.relayPartRequest(this, message);
      return;
    }
    if (isNotification(message)) this.router.relayPartNotification(this, message);
  }

  #onclose() {
    if (this.state === 'stopped') return;
    const expected = this.state === 'stopping';
    this.state = 'stopped';
    for (const settle of this.pending.values()) settle({ error: this.stoppedError() });
    this.pending.clear();
    if (!expected) this.router.partStopped(this);
  }

  async close() {
    if (this.state === 'stopped') return;
    this.state = 'stopping';
    for (const settle of this.pending.values()) settle({ error: this.stoppedError() });
    this.pending.clear();
    await this.transport?.close();
    this.state = 'stopped';
  }
}

export class Router {
  /**
   * @param {object} options
   * @param {Array<{id: string, prefix?: string, label?: string, command: string, args?: string[], env?: object}>} options.parts
   * @param {number} [options.startWindowMs] how long the handshake waits for parts (§4: 8 s)
   * @param {number} [options.joinWindowMs] how long a part has to finish its own handshake (§4: 20 s)
   * @param {number} [options.forwardedRequestTimeoutMs] the timeout on a part's request relayed to the client
   */
  constructor(options) {
    this.options = options;
    this.startWindowMs = options.startWindowMs ?? 8_000;
    this.joinWindowMs = options.joinWindowMs ?? 20_000;
    this.forwardedRequestTimeoutMs = options.forwardedRequestTimeoutMs ?? 10 * 60_000;
    this.connectionId = options.connectionId;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.parts = new Map();
    this.rawInbound = new Map();
    this.taskOwners = new Map();
    this.partRequests = new Map();
    this.server = undefined;
    this.era = undefined;
    /** What the client said it is: its `initialize` (2025) and its first envelope (2026-07-28), seen on the wire. */
    this.initialize = undefined;
    this.firstEnvelope = undefined;
    this.clientInitialized = false;
    /** For the spike's tests: every request a part made of the client, and what the router did with it. */
    this.relayed = [];
    this.dropped = [];
  }

  /** Spawns every part at once (§4: before the client speaks) and serves `transport` with `serveStdio`. */
  serve(transport) {
    for (const spec of this.options.parts) this.#add(spec).spawn();
    const wire = peeking(transport, (message) => {
      if (isRequest(message) && FORWARDED.has(message.method)) this.rawInbound.set(message.id, message);
      if (isRequest(message) && message.method === 'initialize') this.initialize = message;
      this.firstEnvelope ??= envelopeOf(message);
    });
    this.handle = serverStdio.serveStdio((ctx) => this.#factory(ctx), {
      transport: wire,
      onerror: (error) => this.log(`[agentcomms] ${error.message}`),
    });
    return { close: () => this.close() };
  }

  async close() {
    await this.handle?.close();
    await Promise.all([...this.parts.values()].map((part) => part.close()));
  }

  #add(spec) {
    const part = new Part(spec, this);
    this.parts.set(part.id, part);
    return part;
  }

  /** The part's view of a request the router itself makes: the client's own envelope on 2026-07-28. */
  #partParams(params = {}) {
    if (this.era !== 'modern' || this.envelope === undefined) return params;
    return { ...params, _meta: { ...(params._meta ?? {}), ...this.envelope } };
  }

  async #factory({ era }) {
    if (this.era !== undefined && this.era !== era) {
      // A discarded `server/discover` probe followed by `initialize`: the parts were opened in the other era.
      await Promise.all([...this.parts.values()].map((part) => part.close()));
      for (const spec of this.options.parts) this.#add(spec).spawn();
    }
    this.era = era;
    this.initParams = era === 'legacy' ? this.initialize?.params : undefined;
    this.envelope = era === 'modern' ? this.firstEnvelope : undefined;
    const joining = [...this.parts.values()].map((part) => this.#join(part));
    let timer;
    await Promise.race([
      Promise.allSettled(joining),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.startWindowMs);
      }),
    ]);
    clearTimeout(timer);
    const server = new Server(
      { name: 'agentcomms', version: '0.35.0-spike' },
      { capabilities: this.#capabilities(), instructions: this.#instructions() },
    );
    this.#install(server);
    this.server = server;
    return server;
  }

  /** `tools.listChanged`, plus every extension a ready part declares (§4). Fixed once the handshake is answered. */
  #capabilities() {
    const extensions = {};
    for (const part of this.parts.values())
      if (part.state === 'running') Object.assign(extensions, part.capabilities?.extensions ?? {});
    return { tools: { listChanged: true }, ...(Object.keys(extensions).length === 0 ? {} : { extensions }) };
  }

  #instructions() {
    const lines = ['Agent Comms (spike router).'];
    for (const part of this.parts.values()) {
      if (part.state === 'running') {
        if (part.instructions) lines.push(`${part.label}: ${part.instructions.slice(0, 200)}`);
      } else lines.push(`${part.label}: ${part.state === 'stopped' ? 'stopped' : 'starting'}.`);
    }
    return lines.join('\n');
  }

  /** Opens one part in the client's era with what the client said, within the join window (§4). */
  async #join(part) {
    let timer;
    const deadline = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('did not start')), this.joinWindowMs);
    });
    try {
      await Promise.race([this.#open(part), deadline]);
      part.state = 'running';
      if (this.server !== undefined) await this.#listChanged();
    } catch (error) {
      this.log(`[agentcomms:${part.id}] stopped: ${error.message}`);
      if (part.state !== 'stopped') await part.close();
    } finally {
      clearTimeout(timer);
    }
  }

  async #open(part) {
    await part.spawned;
    if (this.era === 'legacy') {
      // D7: the part's `initialize` is the client's own, byte for byte: its clientInfo, capabilities and version.
      const opened = await part.request('initialize', this.initParams);
      if (opened.error !== undefined) throw new Error(opened.error.message);
      part.capabilities = opened.result.capabilities ?? {};
      part.instructions = opened.result.instructions;
      part.serverInfo = opened.result.serverInfo;
      if (this.clientInitialized) part.notify('notifications/initialized');
    } else {
      const discovered = await part.request('server/discover', this.#partParams());
      if (discovered.error !== undefined) throw new Error(discovered.error.message);
      part.capabilities = discovered.result.capabilities ?? {};
      part.instructions = discovered.result.instructions;
      part.serverInfo = discovered.result._meta?.['io.modelcontextprotocol/serverInfo'];
    }
    await this.#list(part);
    if (this.era === 'modern' && part.capabilities?.tools?.listChanged) {
      // 2026-07-28 delivers a part's list_changed only on a subscription (serveStdio's listen router).
      void part.request('subscriptions/listen', this.#partParams({ notifications: { toolsListChanged: true } }));
    }
  }

  /** Follows a part's pages to the end and keeps only the tools under its own prefix (D5). */
  async #list(part) {
    const tools = [];
    let cursor;
    do {
      const page = await part.request('tools/list', this.#partParams(cursor === undefined ? {} : { cursor }));
      if (page.error !== undefined) throw new Error(page.error.message);
      tools.push(...(page.result.tools ?? []));
      cursor = page.result.nextCursor;
    } while (cursor !== undefined);
    part.tools = tools.filter((tool) => {
      const owned = typeof tool.name === 'string' && tool.name.startsWith(`${part.prefix}_`);
      if (!owned) {
        this.dropped.push({ part: part.id, tool: tool.name, why: 'outside its prefix' });
        this.log(`[agentcomms:${part.id}] dropped ${tool.name}: outside its prefix ${part.prefix}_`);
      }
      return owned;
    });
  }

  #merged() {
    const seen = new Set();
    const tools = [];
    for (const part of this.parts.values()) {
      if (part.state === 'stopped' && part.tools.length === 0) continue;
      for (const tool of part.tools) {
        if (seen.has(tool.name)) {
          this.dropped.push({ part: part.id, tool: tool.name, why: 'a second tool with that name' });
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** The part that owns a tool name: by prefix, never by who listed it (D5). */
  #owner(name) {
    const cut = typeof name === 'string' ? name.indexOf('_') : -1;
    if (cut <= 0) return undefined;
    const prefix = name.slice(0, cut);
    return [...this.parts.values()].find((part) => part.prefix === prefix);
  }

  /** The client's own params for this request, as it sent them: envelope, retry fields and `_meta` included. */
  #clientParams(request, ctx) {
    const raw = this.rawInbound.get(ctx.mcpReq.id);
    this.rawInbound.delete(ctx.mcpReq.id);
    return raw?.method === request.method ? raw.params : request.params;
  }

  #answer(answer) {
    if (answer.cancelled) throw wireError({ code: ProtocolErrorCode.InternalError, message: 'cancelled' });
    if (answer.error !== undefined) throw wireError(answer.error);
    return answer.result;
  }

  #install(server) {
    const cancelMeta = () => (this.era === 'modern' ? this.envelope : undefined);
    server.setRequestHandler('tools/list', () => ({ tools: this.#merged() }));
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const params = this.#clientParams(request, ctx);
      const part = this.#owner(request.params.name);
      if (part === undefined || part.state === 'new')
        throw wireError({ code: ProtocolErrorCode.InvalidParams, message: `Tool ${request.params.name} not found` });
      const answer = await part.request('tools/call', params, { signal: ctx.mcpReq.signal, cancelMeta: cancelMeta() });
      const result = this.#answer(answer);
      if (result?.resultType === 'task' && typeof result.taskId === 'string') {
        const owner = this.taskOwners.get(result.taskId);
        if (owner !== undefined && owner !== part.id) {
          void part.request('tasks/cancel', this.#partParams({ taskId: result.taskId }));
          throw wireError({
            code: ProtocolErrorCode.InternalError,
            message: `task ${result.taskId} is already another part's: refused`,
          });
        }
        this.taskOwners.set(result.taskId, part.id);
      }
      return result;
    });
    const taskParams = z.looseObject({ taskId: z.string().min(1) });
    for (const method of ['tasks/get', 'tasks/cancel']) {
      server.setRequestHandler(method, { params: taskParams }, async (params, ctx) => {
        const raw = this.rawInbound.get(ctx.mcpReq.id);
        this.rawInbound.delete(ctx.mcpReq.id);
        const part = this.parts.get(this.taskOwners.get(params.taskId));
        if (part === undefined) throw wireError({ code: ProtocolErrorCode.InvalidParams, message: 'unknown task' });
        const answer = await part.request(method, raw?.params ?? params, {
          signal: ctx.mcpReq.signal,
          cancelMeta: cancelMeta(),
        });
        const result = this.#answer(answer);
        // Forgotten only once the part says it is over, so a poll after a cancel still gets the part's own answer.
        if (method === 'tasks/get' && TERMINAL_TASK_STATES.has(result?.status)) this.taskOwners.delete(params.taskId);
        return result;
      });
    }
    server.oninitialized = () => {
      this.clientInitialized = true;
      for (const part of this.parts.values()) if (part.state === 'running') part.notify('notifications/initialized');
    };
    server.setNotificationHandler('notifications/roots/list_changed', (notification) => {
      for (const part of this.parts.values()) part.notify(notification.method, notification.params);
    });
  }

  async #listChanged() {
    try {
      await this.server?.sendToolListChanged();
    } catch (error) {
      this.log(`[agentcomms] list_changed: ${error.message}`);
    }
  }

  /** What a part asks of the client (2025 era: elicitation, sampling, roots): to the client, unchanged, and back. */
  async relayPartRequest(part, message) {
    if (message.method === 'ping') return part.reply(message.id, { result: {} });
    const record = { part: part.id, method: message.method, answeredBy: undefined };
    this.relayed.push(record);
    if (this.server === undefined || this.era !== 'legacy') {
      record.answeredBy = 'router';
      return part.reply(message.id, {
        error: { code: ProtocolErrorCode.MethodNotFound, message: `${message.method} is not served on this era` },
      });
    }
    const controller = new AbortController();
    const key = `${part.id}:${message.id}`;
    this.partRequests.set(key, controller);
    try {
      const result = await this.server.request({ method: message.method, params: message.params }, PASSTHROUGH, {
        timeout: this.forwardedRequestTimeoutMs,
        signal: controller.signal,
      });
      record.answeredBy = 'client';
      part.reply(message.id, { result });
    } catch (error) {
      // The client's own error is passed back as it came; a transport failure or timeout is the router's to say.
      record.answeredBy = Number.isInteger(error.code) ? 'client' : 'router';
      part.reply(message.id, {
        error: {
          code: Number.isInteger(error.code) ? error.code : ProtocolErrorCode.InternalError,
          message: error.message,
          ...(error.data === undefined ? {} : { data: error.data }),
        },
      });
    } finally {
      this.partRequests.delete(key);
    }
  }

  relayPartNotification(part, message) {
    switch (message.method) {
      case 'notifications/tools/list_changed':
        void this.#list(part).then(
          () => this.#listChanged(),
          (error) => this.log(`[agentcomms:${part.id}] relist: ${error.message}`),
        );
        return;
      case 'notifications/subscriptions/acknowledged':
        return;
      case 'notifications/cancelled':
        this.partRequests.get(`${part.id}:${message.params?.requestId}`)?.abort(new Error('cancelled by the part'));
        return;
      default:
        // Progress (the client's own token), logging and task status: up to the client, unchanged (§5.4).
        void this.server?.notification({ method: message.method, params: message.params }).catch((error) => {
          this.log(`[agentcomms:${part.id}] ${message.method} not relayed: ${error.message}`);
        });
    }
  }

  partStopped(part) {
    this.log(`[agentcomms:${part.id}] stopped: its process ended`);
  }

  /** Adds a part to a running connection (D15): opens it in the client's era, then `tools/list_changed`. */
  async addPart(spec) {
    const part = this.#add(spec);
    await part.spawn();
    if (this.era !== undefined) await this.#join(part);
    return part;
  }

  /** Removes a part from a running connection (D15): stops it, then `tools/list_changed`. */
  async removePart(id) {
    const part = this.parts.get(id);
    if (part === undefined) return;
    this.parts.delete(id);
    await part.close();
    await this.#listChanged();
  }
}
