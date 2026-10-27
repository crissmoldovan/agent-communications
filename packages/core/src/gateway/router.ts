import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { type JSONRPCMessage, ProtocolErrorCode, Server, type Transport } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { CONNECTION_ID_ENV, CONNECTION_KEY_ENV, GATEWAY_PID_ENV } from '../connections.ts';
import { LAUNCHER_ENV } from '../launcher.ts';

/**
 * The gateway's router (single-server design D1–D5, D13, §4–§5, and the spike's findings): one MCP server per
 * connection, in front of each part's own server, each part its own process.
 *
 * Toward the client it is one low-level SDK `Server`, served by `serveStdio`, so it speaks whichever era the client
 * opens with. Toward each part it is a raw JSON-RPC link over the SDK's `StdioClientTransport` — framing and the
 * process only, never the SDK `Client`, which refuses a task answer (spike §3) — so no SDK default answers, retries,
 * refuses or reshapes anything a part sends. Tools pass through verbatim (D4); each part owns its prefix, and a tool it
 * lists outside it, or a second tool of one name, is dropped and logged (D5); a call is routed by its name's prefix,
 * never by who listed it, and never retried (D13). What a part asks of the client — a 2025 form, or a 2026-07-28
 * `input_required` result and its retry — goes to the client unchanged, and its answer back to that part; the router
 * answers none itself, but for a client that has gone away or a relay that timed out (`forwardedRequestTimeoutMs`).
 *
 * A part that crashes fails its calls in flight at once, saying so, and is started again after 1 s, 5 s and 30 s; after
 * three crashes in five minutes it stays stopped until the connection changes or the app restarts. Its tools stay
 * listed while it starts again, so a call is answered with why rather than "no such tool", and go, with
 * `tools/list_changed`, once it is given up. A part that hangs holds up nothing else: the router sets no timeout of its
 * own on a call, and the client's cancellation reaches that part under the part's own request id.
 *
 * It imports no channel code and sends nothing of its own: every message it writes to a part or to the client is one
 * the other side sent, or a refusal that says why.
 */

/** One part, as the gateway starts it: a declared server, its own program with its own words, and its own environment. */
export interface PartSpec {
  /** The declared server: `core`, `gmail`, `events`. */
  readonly server: string;
  /** How a person knows it: `Gmail`. */
  readonly label: string;
  /** The prefix every tool it owns starts with, without the underscore (D5). */
  readonly prefix: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The environment to start it in: the gateway's own, by default. The key and the launcher's name are taken out. */
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly cwd?: string | undefined;
  /**
   * Why it is not started at all — the account it is kept to is gone, say. It is listed as stopped, and a call to one of
   * its tools is told this rather than "no such tool".
   */
  readonly unavailable?: string | undefined;
}

/** Where one part stands, as the status file and `connection show` say it (§4, "Status"). */
export type PartState = 'starting' | 'running' | 'restarting' | 'stopped';

export interface PartStatus {
  readonly server: string;
  readonly label: string;
  readonly state: PartState;
  readonly pid: number | null;
  readonly version: string | null;
  readonly since: string;
  /** Why it stopped, in a person's words; null while it serves. */
  readonly why: string | null;
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
}

/** What the instructions are made from (D14): the parts, each with its state and the brief it gave. */
export interface InstructionsInput {
  readonly parts: readonly { readonly label: string; readonly state: PartState; readonly brief: string | undefined }[];
}

export interface RouterOptions {
  readonly parts: readonly PartSpec[];
  /** The connection this gateway serves: its id goes to each part (D11), never its key. */
  readonly connectionId?: string | undefined;
  /** What the gateway calls itself to the client. */
  readonly serverInfo: { readonly name: string; readonly version: string };
  /**
   * Every extension the connection's parts declare, advertised whether or not the part was ready in time (the spike's
   * change 5): capabilities are fixed when the handshake is answered, and a slow Events would otherwise leave the
   * tasks extension out.
   */
  readonly extensions?: Readonly<Record<string, unknown>> | undefined;
  /** The instructions, composed to fit (D14). */
  readonly instructions: (input: InstructionsInput) => string;
  /** How long the handshake waits for the parts in all: 8 s (§4). */
  readonly startWindowMs?: number | undefined;
  /** How long a part has to finish its own handshake: 20 s (§4). */
  readonly joinWindowMs?: number | undefined;
  /** The timeout on a part's request relayed to the client — a 2025 form a person may take minutes over: 10 min. */
  readonly forwardedRequestTimeoutMs?: number | undefined;
  /** The waits before each start again after a crash: 1 s, 5 s, 30 s (§4). */
  readonly restartDelaysMs?: readonly number[] | undefined;
  /** The crashes in `crashWindowMs` after which a part is given up: three in five minutes (§4). */
  readonly maxCrashes?: number | undefined;
  readonly crashWindowMs?: number | undefined;
  /** Each line for the client's MCP log — the gateway's stderr. Never a result, the status file or the audit. */
  readonly log?: ((line: string) => void) | undefined;
  /** Told whenever a part's state moves, for the status file. */
  readonly onStatus?: ((parts: readonly PartStatus[]) => void) | undefined;
  /**
   * Asked before each request the client makes is served (D15): null to serve it, or the reason to refuse it — the
   * connection was cut off, removed or its key replaced. The router then stops every part and serves nothing.
   */
  readonly beforeRequest?: (() => Promise<string | null>) | undefined;
  /** Told of each `tools/call` the client makes, for "last used". */
  readonly onCall?: (() => void) | undefined;
}

/** The reserved per-request envelope keys of 2026-07-28 (`RESERVED_ENVELOPE_META_KEYS` in the SDK). */
const ENVELOPE_KEYS = [
  'io.modelcontextprotocol/protocolVersion',
  'io.modelcontextprotocol/clientInfo',
  'io.modelcontextprotocol/clientCapabilities',
  'io.modelcontextprotocol/logLevel',
] as const;
const STDERR_LINE_LIMIT = 4096;
const TERMINAL_TASK_STATES: ReadonlySet<unknown> = new Set(['completed', 'failed', 'cancelled']);
/**
 * Taken out of every part's environment (§4): the connection's key, which no part may hold, and the launcher's name,
 * which would claim `core` for a part's update gate and background job. Each part's own launcher sets its own.
 */
export const STRIPPED_PART_ENV: readonly string[] = Object.freeze([CONNECTION_KEY_ENV, LAUNCHER_ENV]);
/** The client requests the router forwards with the client's own raw params: the SDK strips the envelope from them. */
const FORWARDED = new Set(['tools/call', 'tasks/get', 'tasks/cancel']);
/** A Standard Schema that takes anything unchanged: what a relayed answer is checked against. */
const PASSTHROUGH = {
  '~standard': {
    version: 1 as const,
    vendor: 'agentcomms-gateway',
    validate: (value: unknown) => ({ value: value as Record<string, unknown> }),
  },
};

type Message = Record<string, unknown> & { id?: string | number; method?: string; params?: Record<string, unknown> };
type Answer = { result: Record<string, unknown> } | { error: WireError } | { cancelled: true };
interface WireError {
  code: number;
  message: string;
  data?: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isRequest = (m: Message) => typeof m.method === 'string' && 'id' in m;
const isNotification = (m: Message) => typeof m.method === 'string' && !('id' in m);
const isResponse = (m: Message) => 'id' in m && ('result' in m || 'error' in m);

function envelopeOf(message: Message): Record<string, unknown> | undefined {
  const meta = message.params?._meta;
  if (!isRecord(meta)) return undefined;
  const envelope: Record<string, unknown> = {};
  for (const key of ENVELOPE_KEYS) if (Object.hasOwn(meta, key)) envelope[key] = meta[key];
  return Object.keys(envelope).length === 0 ? undefined : envelope;
}

/** An error the SDK encodes as it is — `code`, an unprefixed `message`, `data` — as a part's own errors arrive. */
function wireError({ code, message, data }: WireError): Error {
  return Object.assign(new Error(message), { code, ...(data === undefined ? {} : { data }) });
}

/** A transport that shows the router every inbound message before `serveStdio` sees it (spike change 2). */
function peeking(inner: Transport, onInbound: (message: Message) => void): Transport {
  const wire: Transport = {
    start: () => inner.start(),
    send: (message, options) => inner.send(message, options),
    close: () => inner.close(),
    setProtocolVersion: (version) => inner.setProtocolVersion?.(version),
    get sessionId() {
      return inner.sessionId;
    },
  };
  inner.onmessage = (message, extra) => {
    onInbound(message as unknown as Message);
    wire.onmessage?.(message, extra);
  };
  inner.onclose = () => wire.onclose?.();
  inner.onerror = (error) => wire.onerror?.(error);
  return wire;
}

/** The environment a part starts in: the gateway's, without the key or the launcher's name, with the connection's id. */
export function partEnvironment(
  base: NodeJS.ProcessEnv,
  connectionId: string | undefined,
  gatewayPid: number = process.pid,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && !STRIPPED_PART_ENV.includes(key)) env[key] = value;
  }
  env[GATEWAY_PID_ENV] = String(gatewayPid);
  if (connectionId !== undefined) env[CONNECTION_ID_ENV] = connectionId;
  else delete env[CONNECTION_ID_ENV];
  return env;
}

class Part {
  readonly spec: PartSpec;
  readonly router: Router;
  state: PartState | 'new' = 'new';
  /** Why it stopped, for a call to it and for the status file. */
  why: string | null = null;
  /** True once this instance has been given up for good: no further start. */
  givenUp = false;
  pending: Map<number, (answer: Answer) => void> = new Map();
  nextId = 0;
  tools: Record<string, unknown>[] = [];
  capabilities: Record<string, unknown> = {};
  instructions: string | undefined;
  version: string | null = null;
  pid: number | null = null;
  since: string = new Date().toISOString();
  exit: { code: number | null; signal: string | null } | null = null;
  transport: StdioClientTransport | undefined;
  spawned: Promise<void> | undefined;
  /** Settles once its handshake is over, either way: a call to a part still starting waits for it. */
  joining: Promise<void> | undefined;

  constructor(spec: PartSpec, router: Router) {
    this.spec = spec;
    this.router = router;
  }

  get server(): string {
    return this.spec.server;
  }

  get label(): string {
    return this.spec.label;
  }

  move(state: PartState, why: string | null = null): void {
    this.state = state;
    this.why = why;
    this.since = new Date().toISOString();
    this.router.statusChanged();
  }

  spawn(): Promise<void> {
    const env = partEnvironment(this.spec.env ?? process.env, this.router.connectionId);
    const transport = new StdioClientTransport({
      command: this.spec.command,
      args: [...this.spec.args],
      env,
      stderr: 'pipe',
      ...(this.spec.cwd === undefined ? {} : { cwd: this.spec.cwd }),
    });
    this.transport = transport;
    let partial = '';
    // Each line it writes goes to the client's log, cut at 4 KB, and nowhere else: a log line can carry sender text.
    transport.stderr?.on('data', (chunk: Buffer) => {
      partial += chunk.toString('utf8');
      const lines = partial.split('\n');
      partial = lines.pop() ?? '';
      for (const line of lines) this.router.log(`[gateway:${this.server}] ${line.slice(0, STDERR_LINE_LIMIT)}`);
    });
    transport.onmessage = (message) => this.onmessage(message as unknown as Message);
    transport.onclose = () => this.onclose();
    transport.onerror = (error) => this.router.log(`[gateway:${this.server}] transport: ${error.message}`);
    this.move('starting');
    this.spawned = transport.start().then(
      () => {
        this.pid = transport.pid;
        this.router.statusChanged();
      },
      (error: unknown) => {
        this.router.log(`[gateway:${this.server}] did not start: ${(error as Error).message}`);
        this.onclose();
        throw error;
      },
    );
    this.spawned.catch(() => undefined);
    return this.spawned;
  }

  stoppedError(): WireError {
    return { code: ProtocolErrorCode.InternalError, message: this.router.stoppedMessage(this) };
  }

  /** One request to the part, under the router's own id. Never retried, and never timed out by the router. */
  request(
    method: string,
    params: Record<string, unknown> | undefined,
    options: { signal?: AbortSignal | undefined; cancelMeta?: Record<string, unknown> | undefined } = {},
  ): Promise<Answer> {
    if (this.state !== 'running' && this.state !== 'starting') return Promise.resolve({ error: this.stoppedError() });
    this.nextId += 1;
    const id = this.nextId;
    const message = { jsonrpc: '2.0' as const, id, method, ...(params === undefined ? {} : { params }) };
    const { signal, cancelMeta } = options;
    return new Promise<Answer>((resolve) => {
      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        // Down to the one part concerned (§5.4), under the part's own request id, never the client's.
        this.notify('notifications/cancelled', {
          requestId: id,
          reason: String((signal?.reason as Error | undefined)?.message ?? signal?.reason ?? 'cancelled by the client'),
          ...(cancelMeta === undefined ? {} : { _meta: cancelMeta }),
        });
        resolve({ cancelled: true });
      };
      this.pending.set(id, (answer) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(answer);
      });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener('abort', onAbort, { once: true });
      this.transport?.send(message as unknown as JSONRPCMessage).catch((error: unknown) => {
        this.pending.delete(id);
        resolve({
          error: { code: ProtocolErrorCode.InternalError, message: `${this.label}: ${(error as Error).message}` },
        });
      });
    });
  }

  notify(method: string, params?: Record<string, unknown>): void {
    if (this.transport === undefined || this.state === 'stopped') return;
    const message = { jsonrpc: '2.0' as const, method, ...(params === undefined ? {} : { params }) };
    this.transport.send(message as unknown as JSONRPCMessage).catch(() => undefined);
  }

  reply(id: string | number, answer: { result: unknown } | { error: WireError }): void {
    if (this.transport === undefined || this.state === 'stopped') return;
    this.transport.send({ jsonrpc: '2.0', id, ...answer } as unknown as JSONRPCMessage).catch(() => undefined);
  }

  private onmessage(message: Message): void {
    if (isResponse(message)) {
      const settle = this.pending.get(message.id as number);
      if (settle === undefined) return;
      this.pending.delete(message.id as number);
      settle(
        message.error === undefined
          ? { result: (message.result ?? {}) as Record<string, unknown> }
          : { error: message.error as WireError },
      );
      return;
    }
    if (isRequest(message)) {
      void this.router.relayPartRequest(this, message);
      return;
    }
    if (isNotification(message)) this.router.relayPartNotification(this, message);
  }

  private onclose(): void {
    if (this.state === 'stopped') return;
    const child = (this.transport as unknown as { _process?: { exitCode: number | null; signalCode: string | null } })
      ?._process;
    this.exit = child === undefined ? this.exit : { code: child.exitCode ?? null, signal: child.signalCode ?? null };
    // What happens next is decided first, so the calls it fails say it: starting again, or given up.
    if (this.stopping) this.move('stopped', this.why);
    else this.router.partCrashed(this);
    for (const settle of this.pending.values()) settle({ error: this.stoppedError() });
    this.pending.clear();
  }

  stopping = false;

  async close(why: string | null = null): Promise<void> {
    if (this.state === 'stopped') return;
    this.stopping = true;
    this.why = why;
    // Calls still waiting are answered now, saying why, rather than left to the client's own timeout.
    for (const settle of this.pending.values()) settle({ error: this.stoppedError() });
    this.pending.clear();
    await this.transport?.close();
    // The process may have ended on its own while it was being closed: then it has moved already.
    if ((this.state as PartState | 'new') !== 'stopped') this.move('stopped', why);
  }
}

/** The router: see the module's comment. */
export class Router {
  readonly options: RouterOptions;
  readonly connectionId: string | undefined;
  readonly log: (line: string) => void;
  readonly parts: Map<string, Part> = new Map();
  readonly startWindowMs: number;
  readonly joinWindowMs: number;
  readonly forwardedRequestTimeoutMs: number;
  readonly restartDelaysMs: readonly number[];
  readonly maxCrashes: number;
  readonly crashWindowMs: number;
  /** For the tests: every tool dropped, and why (D5). */
  readonly dropped: { server: string; tool: unknown; why: string }[] = [];
  /** For the tests: every request a part made of the client, and who answered it. */
  readonly relayed: { server: string; method: string; answeredBy: 'client' | 'router' | undefined }[] = [];
  private server: Server | undefined;
  private era: 'legacy' | 'modern' | undefined;
  private initialize: Message | undefined;
  private firstEnvelope: Record<string, unknown> | undefined;
  private envelope: Record<string, unknown> | undefined;
  private initParams: Record<string, unknown> | undefined;
  private clientInitialized = false;
  private readonly rawInbound = new Map<string | number, Message>();
  private readonly taskOwners = new Map<string, string>();
  private readonly partRequests = new Map<string, AbortController>();
  private readonly crashes = new Map<string, number[]>();
  private readonly restartTimers = new Set<NodeJS.Timeout>();
  private handle: { close(): Promise<void> } | undefined;
  private refusal: string | null = null;
  /** The refusal's stopping of every part, in flight or done: whoever meets the refusal waits for it (D15). */
  private refusing: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(options: RouterOptions) {
    this.options = options;
    this.connectionId = options.connectionId;
    this.log = options.log ?? ((line) => process.stderr.write(`${line}\n`));
    this.startWindowMs = options.startWindowMs ?? 8_000;
    this.joinWindowMs = options.joinWindowMs ?? 20_000;
    this.forwardedRequestTimeoutMs = options.forwardedRequestTimeoutMs ?? 10 * 60_000;
    this.restartDelaysMs = options.restartDelaysMs ?? [1_000, 5_000, 30_000];
    this.maxCrashes = options.maxCrashes ?? 3;
    this.crashWindowMs = options.crashWindowMs ?? 5 * 60_000;
  }

  /** The client, as it named itself: in its `initialize` (2025) or its first envelope (2026-07-28). Null until it has. */
  client(): { name: string; version?: string } | null {
    const said = this.initialize?.params?.clientInfo ?? this.firstEnvelope?.['io.modelcontextprotocol/clientInfo'];
    if (!isRecord(said) || typeof said.name !== 'string' || said.name === '') return null;
    return {
      name: said.name.slice(0, 100),
      ...(typeof said.version === 'string' ? { version: said.version.slice(0, 64) } : {}),
    };
  }

  /** Every part's state now, in the parts' order. */
  status(): PartStatus[] {
    return [...this.parts.values()].map((part) => ({
      server: part.server,
      label: part.label,
      state: part.state === 'new' ? 'starting' : part.state,
      pid: part.pid,
      version: part.version,
      since: part.since,
      why: part.why,
      exit: part.exit,
    }));
  }

  statusChanged(): void {
    try {
      this.options.onStatus?.(this.status());
    } catch {
      // The status file is a courtesy to readers: it never stops a part.
    }
  }

  /** Starts every part at once — before the client speaks, so their start overlaps its wait (§4) — and serves. */
  async serve(transport: Transport): Promise<{ close(): Promise<void> }> {
    for (const spec of this.options.parts) this.start(spec);
    const wire = peeking(transport, (message) => {
      if (isRequest(message) && FORWARDED.has(message.method as string)) {
        this.rawInbound.set(message.id as string | number, message);
      }
      if (isRequest(message) && message.method === 'initialize') this.initialize = message;
      this.firstEnvelope ??= envelopeOf(message);
    });
    const { serveStdio } = await import('@modelcontextprotocol/server/stdio');
    this.handle = serveStdio((ctx) => this.factory(ctx), {
      transport: wire,
      onerror: (error) => this.log(`[gateway] ${error.message}`),
    });
    return { close: () => this.close() };
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    await this.handle?.close();
    await Promise.all([...this.parts.values()].map((part) => part.close('Agent Comms stopped')));
  }

  private add(spec: PartSpec): Part {
    const part = new Part(spec, this);
    this.parts.set(spec.server, part);
    return part;
  }

  /** Adds a part and starts its process — or, for one that cannot be started, lists it as stopped, with why. */
  private start(spec: PartSpec): Part {
    const part = this.add(spec);
    if (spec.unavailable !== undefined) {
      part.givenUp = true;
      part.move('stopped', `${spec.label} is not started in this connection: ${spec.unavailable}`);
      return part;
    }
    part.spawn().catch(() => undefined);
    return part;
  }

  /** The part's view of a request the router itself makes: on 2026-07-28, the client's own envelope. */
  private partParams(params: Record<string, unknown> = {}): Record<string, unknown> {
    if (this.era !== 'modern' || this.envelope === undefined) return params;
    return { ...params, _meta: { ...(isRecord(params._meta) ? params._meta : {}), ...this.envelope } };
  }

  private async factory({ era }: { era: 'legacy' | 'modern' }): Promise<Server> {
    if (this.era !== undefined && this.era !== era) {
      // A discarded `server/discover` probe followed by `initialize`: the parts were opened in the other era.
      const specs = [...this.parts.values()].map((part) => part.spec);
      await Promise.all([...this.parts.values()].map((part) => part.close()));
      this.parts.clear();
      for (const spec of specs) this.start(spec);
    }
    this.era = era;
    this.initParams = era === 'legacy' ? this.initialize?.params : undefined;
    this.envelope = era === 'modern' ? this.firstEnvelope : undefined;
    const joining = [...this.parts.values()]
      .filter((part) => part.spec.unavailable === undefined)
      .map((part) => this.join(part));
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      Promise.allSettled(joining),
      new Promise((resolve) => {
        timer = setTimeout(resolve, this.startWindowMs);
      }),
    ]);
    clearTimeout(timer);
    const server = new Server(
      { name: this.options.serverInfo.name, version: this.options.serverInfo.version },
      { capabilities: this.capabilities(), instructions: this.instructionsNow() },
    );
    this.install(server);
    this.server = server;
    return server;
  }

  /** `tools.listChanged`, the extensions the connection's parts declare, and any a ready part declares besides. */
  private capabilities(): Record<string, unknown> {
    const extensions: Record<string, unknown> = { ...(this.options.extensions ?? {}) };
    let logging = false;
    for (const part of this.parts.values()) {
      if (part.state !== 'running') continue;
      const declared = part.capabilities.extensions;
      if (isRecord(declared)) Object.assign(extensions, declared);
      if (part.capabilities.logging !== undefined) logging = true;
    }
    return {
      tools: { listChanged: true },
      ...(logging ? { logging: {} } : {}),
      ...(Object.keys(extensions).length === 0 ? {} : { extensions }),
    };
  }

  private instructionsNow(): string {
    return this.options.instructions({
      parts: [...this.parts.values()].map((part) => ({
        label: part.label,
        state: part.state === 'new' ? 'starting' : part.state,
        brief: part.state === 'running' ? part.instructions : undefined,
      })),
    });
  }

  /** Opens one part in the client's era, with what the client said, within the join window (§4). */
  private join(part: Part): Promise<void> {
    part.joining = this.joined(part);
    return part.joining;
  }

  private async joined(part: Part): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('it did not start in time')), this.joinWindowMs);
    });
    try {
      await Promise.race([this.open(part), deadline]);
      if (part.state === 'starting') part.move('running');
      if (this.server !== undefined) await this.listChanged();
    } catch (error) {
      if (part.state === 'stopped' || part.state === 'restarting') return;
      this.log(`[gateway:${part.server}] stopped: ${(error as Error).message}`);
      part.givenUp = true;
      await part.close(`${part.label} did not start`);
      if (this.server !== undefined) await this.listChanged();
    } finally {
      clearTimeout(timer);
    }
  }

  private async open(part: Part): Promise<void> {
    await part.spawned;
    if (this.era === 'legacy') {
      // D7: the part's `initialize` is the client's own, byte for byte: its clientInfo, capabilities and version.
      const opened = await part.request('initialize', this.initParams);
      if (!('result' in opened)) throw new Error('error' in opened ? opened.error.message : 'cancelled');
      part.capabilities = isRecord(opened.result.capabilities) ? opened.result.capabilities : {};
      part.instructions = typeof opened.result.instructions === 'string' ? opened.result.instructions : undefined;
      const info = opened.result.serverInfo;
      part.version = isRecord(info) && typeof info.version === 'string' ? info.version : null;
      if (this.clientInitialized) part.notify('notifications/initialized');
    } else {
      const discovered = await part.request('server/discover', this.partParams());
      if (!('result' in discovered)) throw new Error('error' in discovered ? discovered.error.message : 'cancelled');
      part.capabilities = isRecord(discovered.result.capabilities) ? discovered.result.capabilities : {};
      part.instructions =
        typeof discovered.result.instructions === 'string' ? discovered.result.instructions : undefined;
      const meta = discovered.result._meta;
      const info = isRecord(meta) ? meta['io.modelcontextprotocol/serverInfo'] : undefined;
      part.version = isRecord(info) && typeof info.version === 'string' ? info.version : null;
    }
    await this.list(part);
    const tools = part.capabilities.tools;
    if (this.era === 'modern' && isRecord(tools) && tools.listChanged === true) {
      // 2026-07-28 delivers a part's list_changed only on a subscription (serveStdio's listen router).
      void part.request('subscriptions/listen', this.partParams({ notifications: { toolsListChanged: true } }));
    }
  }

  /** Follows a part's pages to the end and keeps only the tools under its own prefix (D5). */
  private async list(part: Part): Promise<void> {
    const tools: Record<string, unknown>[] = [];
    let cursor: unknown;
    do {
      const page = await part.request('tools/list', this.partParams(cursor === undefined ? {} : { cursor }));
      if (!('result' in page)) throw new Error('error' in page ? page.error.message : 'cancelled');
      const listed = page.result.tools;
      if (Array.isArray(listed)) tools.push(...listed.filter(isRecord));
      cursor = page.result.nextCursor;
    } while (typeof cursor === 'string' && cursor !== '');
    part.tools = tools.filter((tool) => {
      const owned = typeof tool.name === 'string' && tool.name.startsWith(`${part.spec.prefix}_`);
      if (!owned) {
        this.dropped.push({ server: part.server, tool: tool.name, why: 'outside its prefix' });
        this.log(`[gateway:${part.server}] dropped a tool outside its prefix ${part.spec.prefix}_`);
      }
      return owned;
    });
  }

  /** Every listed tool, in the parts' order: a part given up lists none; one starting again keeps its own (§4). */
  private merged(): Record<string, unknown>[] {
    if (this.refusal !== null) return [];
    const seen = new Set<unknown>();
    const tools: Record<string, unknown>[] = [];
    for (const part of this.parts.values()) {
      if (part.state === 'stopped' && part.givenUp) continue;
      for (const tool of part.tools) {
        if (seen.has(tool.name)) {
          this.dropped.push({ server: part.server, tool: tool.name, why: 'a second tool with that name' });
          continue;
        }
        seen.add(tool.name);
        tools.push(tool);
      }
    }
    return tools;
  }

  /** The part that owns a tool name: by its prefix, never by who listed it (D5). */
  private owner(name: unknown): Part | undefined {
    if (typeof name !== 'string') return undefined;
    const cut = name.indexOf('_');
    if (cut <= 0) return undefined;
    const prefix = name.slice(0, cut);
    return [...this.parts.values()].find((part) => part.spec.prefix === prefix);
  }

  /** The client's own params for this request, as it sent them: the envelope, its retry fields and `_meta` included. */
  private clientParams(method: string, fallback: unknown, id: string | number | undefined): Record<string, unknown> {
    const raw = id === undefined ? undefined : this.rawInbound.get(id);
    if (id !== undefined) this.rawInbound.delete(id);
    if (raw?.method === method && isRecord(raw.params)) return raw.params;
    return isRecord(fallback) ? fallback : {};
  }

  private answer(answer: Answer): Record<string, unknown> {
    if ('cancelled' in answer) throw wireError({ code: ProtocolErrorCode.InternalError, message: 'cancelled' });
    if ('error' in answer) throw wireError(answer.error);
    return answer.result;
  }

  /** D15: the connection checked before each request; a refusal stops every part, and every later call says why. */
  private async gate(): Promise<void> {
    if (this.refusal === null && this.options.beforeRequest !== undefined) {
      const why = await this.options.beforeRequest().catch(() => null);
      if (why !== null) await this.refuse(why);
    }
    if (this.refusal !== null) {
      // A refusal another look began may still be stopping the parts: the call is answered once they have stopped.
      await this.refusing.catch(() => undefined);
      throw wireError({ code: ProtocolErrorCode.InvalidRequest, message: this.refusal });
    }
  }

  /**
   * Stops every part and serves nothing from now on, saying why (D15: a connection cut off, removed or re-keyed).
   *
   * Whoever calls it again while the first is stopping the parts waits for that one: it returned at once, so a request
   * whose own look found the reason too was answered "replaced" while the parts the timer's look was stopping still ran.
   */
  refuse(why: string): Promise<void> {
    if (this.refusal !== null) return this.refusing;
    this.refusal = why;
    this.log(`[gateway] ${why}`);
    for (const timer of this.restartTimers) clearTimeout(timer);
    this.restartTimers.clear();
    this.refusing = (async () => {
      await Promise.all(
        [...this.parts.values()].map((part) => {
          part.givenUp = true;
          return part.close(why);
        }),
      );
      await this.listChanged();
    })();
    return this.refusing;
  }

  private install(server: Server): void {
    const cancelMeta = () => (this.era === 'modern' ? this.envelope : undefined);
    server.setRequestHandler('tools/list', async () => {
      await this.gate().catch(() => undefined);
      return { tools: this.merged() } as never;
    });
    server.setRequestHandler('tools/call', async (request, ctx) => {
      const id = (ctx as { mcpReq?: { id?: string | number } }).mcpReq?.id;
      const params = this.clientParams('tools/call', request.params, id);
      await this.gate();
      this.options.onCall?.();
      const name = request.params.name;
      const part = this.owner(name);
      if (part === undefined || part.state === 'new') {
        throw wireError({ code: ProtocolErrorCode.InvalidParams, message: `Tool ${String(name)} not found` });
      }
      // A part still starting — late for the handshake, or started again — is waited for, never sent a call early.
      if (part.state === 'starting') await part.joining?.catch(() => undefined);
      const signal = (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
      const answer = await part.request('tools/call', params, { signal, cancelMeta: cancelMeta() });
      const result = this.answer(answer);
      if (result.resultType === 'task' && typeof result.taskId === 'string') {
        const owner = this.taskOwners.get(result.taskId);
        if (owner !== undefined && owner !== part.server) {
          void part.request('tasks/cancel', this.partParams({ taskId: result.taskId }));
          throw wireError({
            code: ProtocolErrorCode.InternalError,
            message: `task ${result.taskId} is already another part's: refused`,
          });
        }
        this.taskOwners.set(result.taskId, part.server);
      }
      return result as never;
    });
    const taskParams = z.looseObject({ taskId: z.string().min(1) });
    for (const method of ['tasks/get', 'tasks/cancel'] as const) {
      server.setRequestHandler(method, { params: taskParams }, async (params, ctx) => {
        const id = (ctx as { mcpReq?: { id?: string | number } }).mcpReq?.id;
        const raw = this.clientParams(method, params, id);
        await this.gate();
        const owner = this.taskOwners.get(params.taskId);
        const part = owner === undefined ? undefined : this.parts.get(owner);
        if (part === undefined) throw wireError({ code: ProtocolErrorCode.InvalidParams, message: 'unknown task' });
        const signal = (ctx as { mcpReq?: { signal?: AbortSignal } }).mcpReq?.signal;
        const result = this.answer(await part.request(method, raw, { signal, cancelMeta: cancelMeta() }));
        // Forgotten only once the part says it is over, so a poll after a cancel still gets the part's own answer.
        if (method === 'tasks/get' && TERMINAL_TASK_STATES.has(result.status)) this.taskOwners.delete(params.taskId);
        return result as never;
      });
    }
    server.oninitialized = () => {
      this.clientInitialized = true;
      for (const part of this.parts.values()) if (part.state === 'running') part.notify('notifications/initialized');
    };
    server.setNotificationHandler('notifications/roots/list_changed', (notification) => {
      for (const part of this.parts.values()) {
        part.notify(notification.method, notification.params as Record<string, unknown> | undefined);
      }
    });
  }

  private async listChanged(): Promise<void> {
    try {
      await this.server?.sendToolListChanged();
    } catch (error) {
      this.log(`[gateway] list_changed: ${(error as Error).message}`);
    }
  }

  /** What a part asks of the client (2025: a form, roots, sampling): to the client, unchanged, and its answer back. */
  async relayPartRequest(part: Part, message: Message): Promise<void> {
    const id = message.id as string | number;
    if (message.method === 'ping') {
      part.reply(id, { result: {} });
      return;
    }
    const record: (typeof this.relayed)[number] = {
      server: part.server,
      method: String(message.method),
      answeredBy: undefined,
    };
    this.relayed.push(record);
    if (this.server === undefined || this.era !== 'legacy') {
      record.answeredBy = 'router';
      part.reply(id, {
        error: {
          code: ProtocolErrorCode.MethodNotFound,
          message: `${String(message.method)} is not served on this era`,
        },
      });
      return;
    }
    const controller = new AbortController();
    const key = `${part.server}:${String(id)}`;
    this.partRequests.set(key, controller);
    try {
      const result = await this.server.request(
        { method: String(message.method), ...(message.params === undefined ? {} : { params: message.params }) },
        PASSTHROUGH,
        { timeout: this.forwardedRequestTimeoutMs, signal: controller.signal },
      );
      record.answeredBy = 'client';
      part.reply(id, { result });
    } catch (error) {
      // The client's own error goes back as it came; a transport failure or a timeout is the router's to say.
      const code = (error as { code?: unknown }).code;
      record.answeredBy = Number.isInteger(code) ? 'client' : 'router';
      const data = (error as { data?: unknown }).data;
      part.reply(id, {
        error: {
          code: Number.isInteger(code) ? (code as number) : ProtocolErrorCode.InternalError,
          message: (error as Error).message,
          ...(data === undefined ? {} : { data }),
        },
      });
    } finally {
      this.partRequests.delete(key);
    }
  }

  relayPartNotification(part: Part, message: Message): void {
    switch (message.method) {
      case 'notifications/tools/list_changed':
        void this.list(part).then(
          () => this.listChanged(),
          (error: unknown) => this.log(`[gateway:${part.server}] relist: ${(error as Error).message}`),
        );
        return;
      case 'notifications/subscriptions/acknowledged':
        return;
      case 'notifications/cancelled': {
        const requestId = message.params?.requestId;
        this.partRequests.get(`${part.server}:${String(requestId)}`)?.abort(new Error('cancelled by the part'));
        return;
      }
      default:
        // Progress (the client's own token), logging and task status: up to the client, unchanged (§5.4).
        void this.server
          ?.notification({
            method: String(message.method),
            ...(message.params === undefined ? {} : { params: message.params }),
          } as never)
          .catch((error: unknown) => {
            this.log(`[gateway:${part.server}] ${String(message.method)} not relayed: ${(error as Error).message}`);
          });
    }
  }

  /** What a call to a part that is not serving is told: why, and whether Agent Comms is starting it again. */
  stoppedMessage(part: Part): string {
    if (this.refusal !== null) return this.refusal;
    if (part.spec.unavailable !== undefined && part.why !== null) return part.why;
    if (part.state === 'restarting') {
      return `${part.label} stopped in this connection; Agent Comms is starting it again, and does not repeat this call`;
    }
    if (part.givenUp && part.why?.endsWith('did not start')) {
      return `${part.label} did not start in this connection; Agent Comms starts it again when the connection changes or the app restarts`;
    }
    if (part.givenUp) {
      return `${part.label} stopped in this connection, and Agent Comms starts it again only when the connection changes or the app restarts`;
    }
    return `${part.label} stopped in this connection; Agent Comms does not repeat this call`;
  }

  /** A part's process ended on its own: its calls have failed; start it again after a wait, or give it up (§4). */
  partCrashed(part: Part): void {
    const now = Date.now();
    const recent = (this.crashes.get(part.server) ?? []).filter((at) => now - at < this.crashWindowMs);
    recent.push(now);
    this.crashes.set(part.server, recent);
    const exit = part.exit === null ? '' : ` (exit ${part.exit.code ?? part.exit.signal ?? 'unknown'})`;
    this.log(`[gateway:${part.server}] its process ended${exit}`);
    if (this.closed || this.refusal !== null || part.givenUp || this.parts.get(part.server) !== part) {
      part.move('stopped', `${part.label} stopped`);
      return;
    }
    if (recent.length >= this.maxCrashes) {
      part.givenUp = true;
      part.move('stopped', `${part.label} stopped ${recent.length} times in a few minutes, so it was given up`);
      // Its tools go only now, once it is given up.
      void this.listChanged();
      return;
    }
    const delay = this.restartDelaysMs[Math.min(recent.length - 1, this.restartDelaysMs.length - 1)] ?? 1_000;
    part.move('restarting', `${part.label} stopped; it starts again in ${Math.round(delay / 1000)} s`);
    const timer = setTimeout(() => {
      this.restartTimers.delete(timer);
      if (this.closed || this.refusal !== null || this.parts.get(part.server) !== part) return;
      const next = this.add(part.spec);
      // Its tools stay listed while it starts again, so a call is told why rather than "no such tool" (§4).
      next.tools = part.tools;
      next.spawn().catch(() => undefined);
      if (this.era !== undefined) void this.join(next);
    }, delay);
    timer.unref?.();
    this.restartTimers.add(timer);
  }

  /** Adds a part to a running connection (D15): opened in the client's era, then `tools/list_changed`. */
  async addPart(spec: PartSpec): Promise<void> {
    if (this.refusal !== null) return;
    const previous = this.parts.get(spec.server);
    if (previous !== undefined) await previous.close();
    this.crashes.delete(spec.server);
    const part = this.start(spec);
    if (spec.unavailable !== undefined) {
      await this.listChanged();
      return;
    }
    await part.spawned?.catch(() => undefined);
    if (this.era !== undefined) await this.join(part);
  }

  /** Removes a part from a running connection (D15): stopped, then `tools/list_changed`. */
  async removePart(server: string): Promise<void> {
    const part = this.parts.get(server);
    if (part === undefined) return;
    this.parts.delete(server);
    this.crashes.delete(server);
    await part.close('taken out of the connection');
    await this.listChanged();
  }

  /** The specs the router serves now, by server. */
  specs(): Map<string, PartSpec> {
    return new Map([...this.parts.values()].map((part) => [part.server, part.spec]));
  }
}
