import { constants } from 'node:fs';
import { lstat, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { inspect } from 'node:util';
import { CommsError, homeForDiscovery } from '@agentcomms/core';
import {
  addressSetDigest,
  connectPinnedTcp,
  PinnedResponseError,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
  streamPinnedResponseTo,
} from '../network/pinned-connection.ts';
import { type ListenerAttestor, listenerOwners, listenersAreYours } from './relay-listener.ts';

/**
 * Agent Comms as one more client of the claude-stream relay the person already runs (0.33.0 design §3.5, §6). It speaks
 * the relay's documented HTTP API — `/v1`, events at `schemaVersion: 1` — on loopback only, with the relay's control
 * token read from its home as the same user. Nothing here starts, embeds or configures a relay. Like every network path
 * of the event service it uses no fetch: HTTP/1.1 over the pinned path, to 127.0.0.1 alone.
 *
 * The token goes only into the `Authorization` header of a request this module makes: never into argv, a URL, a log
 * line, a result or an error. A token file others can read is refused, as the relay itself refuses one, and the token
 * is sent only once the system says the port is held by this user's own process (`relay-listener.ts`).
 */

/** The relay protocol this client relies on (`GET /v1/relay`'s `protocol`). */
export const RELAY_PROTOCOL = 1;
/** What this client relies on beyond the protocol: cursors that name their journal, and `sender` on a prompt. */
export const RELAY_REQUIRED_CAPABILITIES: readonly ['journal-id', 'sender'] = Object.freeze([
  'journal-id',
  'sender',
] as const);
/** The relay's default port (`http://127.0.0.1:4318`), when no record or setting names another. */
export const RELAY_DEFAULT_PORT = 4318;
/** claude-stream's own default home, `$AGENT_RELAY_HOME` in its quick start, under the person's home folder. */
export const RELAY_DEFAULT_HOME_PARTS: readonly string[] = Object.freeze(['.local', 'state', 'agent-relay']);
/** The Claude Stream Pilot app's relay home on macOS, under the person's home folder. */
export const RELAY_PILOT_HOME_PARTS: readonly string[] = Object.freeze([
  'Library',
  'Application Support',
  'com.cueplusplus.claude-stream.pilot',
  'relay-home',
]);
/** The record the Pilot app keeps of its relay's port, beside the relay's home (claude-stream `owned.rs`). */
export const RELAY_PORT_RECORD = 'owned-relay.json';
/** The run statuses that end a turn (claude-stream `RunStatus`): the session may take the next prompt then. */
export const RELAY_RUN_END_TYPES: readonly ['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'] =
  Object.freeze(['run.completed', 'run.failed', 'run.cancelled', 'run.interrupted'] as const);

const SESSION_ID = /^sess_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const RUN_ID = /^run_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const EVENT_ID = /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const START_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const TOKEN = /^[\x21-\x7e]{16,512}$/u;
const MAX_TOKEN_FILE_BYTES = 4_096;
const MAX_RECORD_BYTES = 4_096;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_SSE_LINE = 512 * 1024;
/** One event-stream record's data, at most: a run-end record is well under a kilobyte; a larger one is dropped. */
const MAX_SSE_FRAME = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
/** The relay answers on loopback only (claude-stream refuses a non-loopback bind): 127.0.0.1, the one approved address. */
const LOOPBACK = '127.0.0.1';

/** Why the relay could not be used, as a closed reason the person can act on. */
export type RelayRefusal =
  | 'RELAY_NOT_FOUND'
  | 'RELAY_TOKEN_UNSAFE'
  | 'RELAY_NOT_YOURS'
  | 'RELAY_NOT_LOOPBACK'
  | 'RELAY_UNREACHABLE'
  | 'RELAY_PROTOCOL'
  | 'RELAY_REFUSED'
  | 'RELAY_FAILED'
  | 'RELAY_BAD_RESPONSE';

/** A refusal with its reason; its message names what to do, and never holds the token. */
export class RelayError extends CommsError {
  readonly reason: RelayRefusal;
  readonly status: number | null;
  readonly relayCode: string | null;

  constructor(
    reason: RelayRefusal,
    message: string,
    extra: { readonly status?: number | undefined; readonly relayCode?: string | undefined } = {},
  ) {
    super(reason === 'RELAY_REFUSED' || reason === 'RELAY_PROTOCOL' ? 'CONFIG' : 'TRANSIENT', message, {
      details: {
        reason,
        ...(extra.status === undefined ? {} : { status: extra.status }),
        ...(extra.relayCode === undefined ? {} : { relayCode: extra.relayCode }),
      },
    });
    this.reason = reason;
    this.status = extra.status ?? null;
    this.relayCode = extra.relayCode ?? null;
  }
}

/**
 * The control token, held so that no way of printing it shows it: `String()`, `JSON.stringify`, `util.inspect` and a
 * template literal all read `[relay token]`. Only `authorization()` reads it, for the one header that needs it.
 */
export class RelayToken {
  readonly #value: string;

  constructor(value: string) {
    this.#value = value;
  }

  authorization(): string {
    return `Bearer ${this.#value}`;
  }

  toString(): string {
    return '[relay token]';
  }

  toJSON(): string {
    return '[relay token]';
  }
}

// `util.inspect` (and so console.log) prints it as its name too.
Object.defineProperty(RelayToken.prototype, inspect.custom, { value: () => '[relay token]' });

/** Where the relay is: its home (where its tokens are), the loopback address it answers on, and which default it was. */
export interface RelayLocation {
  readonly home: string;
  readonly url: string;
  readonly source: 'setting' | 'default' | 'pilot';
}

/** The person's settings for agent sessions (`integration set agent-sessions`). */
export interface RelaySettings {
  readonly relayHome: string | null;
  readonly relayPort: number | null;
}

/** The homes to try, in order: the person's own, else claude-stream's default, then the Pilot app's. */
export function relayHomeCandidates(
  settings: RelaySettings,
  homeDirectory: string,
): readonly { readonly home: string; readonly source: RelayLocation['source'] }[] {
  if (settings.relayHome !== null) return [{ home: settings.relayHome, source: 'setting' }];
  // The defaults are under the home: never the account's real one under test.
  homeForDiscovery(homeDirectory, 'the claude-stream relay');
  return [
    { home: join(homeDirectory, ...RELAY_DEFAULT_HOME_PARTS), source: 'default' },
    { home: join(homeDirectory, ...RELAY_PILOT_HOME_PARTS), source: 'pilot' },
  ];
}

/** Reads a small file whole, refusing one larger than `limit`. Undefined when it is missing. */
async function readSmall(path: string, limit: number): Promise<Buffer | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, 'r');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  try {
    const buffer = Buffer.alloc(limit + 1);
    const { bytesRead } = await handle.read(buffer, 0, limit + 1, 0);
    if (bytesRead > limit) return Buffer.alloc(0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/** The port the Pilot app recorded beside the home, when its record is there and is one; else undefined. */
export async function recordedRelayPort(home: string): Promise<number | undefined> {
  let bytes: Buffer | undefined;
  try {
    bytes = await readSmall(join(dirname(home), RELAY_PORT_RECORD), MAX_RECORD_BYTES);
  } catch {
    return undefined;
  }
  if (bytes === undefined || bytes.length === 0) return undefined;
  try {
    const port = (JSON.parse(bytes.toString('utf8')) as { port?: unknown }).port;
    return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Finds the relay: the first candidate home that holds a control token, and its port — the person's setting, else the
 * Pilot app's record beside the home, else 4318. The address is always 127.0.0.1: nothing here names another host.
 */
export async function locateRelay(settings: RelaySettings, homeDirectory: string): Promise<RelayLocation> {
  for (const candidate of relayHomeCandidates(settings, homeDirectory)) {
    try {
      await lstat(join(candidate.home, 'control.token'));
    } catch {
      continue;
    }
    const port = settings.relayPort ?? (await recordedRelayPort(candidate.home)) ?? RELAY_DEFAULT_PORT;
    return { home: candidate.home, url: `http://127.0.0.1:${port}`, source: candidate.source };
  }
  throw new RelayError(
    'RELAY_NOT_FOUND',
    settings.relayHome === null
      ? "no claude-stream relay was found: neither its default home nor the Pilot app's holds a control token"
      : 'no claude-stream relay was found: the relay home you set holds no control token',
    {},
  );
}

/**
 * Reads the relay's `control.token` as the same user. Refused unless it is a regular file — not a link — that this
 * user owns and nobody else can read or write: the relay writes it at 0600 and refuses such a file itself. The file is
 * opened without following a link and without waiting on a FIFO, and what is checked is the opened file itself, so
 * nothing swapped in after a check is read (security review of 0.33.0, finding 8).
 */
export async function readRelayToken(home: string, platform: NodeJS.Platform = process.platform): Promise<RelayToken> {
  const path = join(home, 'control.token');
  try {
    if ((await lstat(path)).isSymbolicLink())
      throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token is not a regular file (a link is refused)");
  } catch (error) {
    if (error instanceof RelayError) throw error;
    throw new RelayError('RELAY_NOT_FOUND', "the relay's home holds no control token");
  }
  const flags =
    platform === 'win32' ? constants.O_RDONLY : constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(path, flags);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new RelayError('RELAY_NOT_FOUND', "the relay's home holds no control token");
    // ELOOP: a link swapped in after the look.
    throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token could not be opened as a regular file");
  }
  try {
    const info = await handle.stat();
    if (!info.isFile())
      throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token is not a regular file (a link is refused)");
    if (platform !== 'win32') {
      const uid = process.getuid?.();
      if (uid !== undefined && info.uid !== uid)
        throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token belongs to another user");
      if ((info.mode & 0o077) !== 0)
        throw new RelayError(
          'RELAY_TOKEN_UNSAFE',
          `others can read or write the relay's control token (mode ${(info.mode & 0o777).toString(8)}); the relay writes it at 600: chmod 600 it, or restart the relay`,
        );
    }
    if (info.size > MAX_TOKEN_FILE_BYTES)
      throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token is not one");
    const buffer = Buffer.alloc(MAX_TOKEN_FILE_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, MAX_TOKEN_FILE_BYTES + 1, 0);
    const value = bytesRead > MAX_TOKEN_FILE_BYTES ? '' : buffer.subarray(0, bytesRead).toString('utf8').trim();
    buffer.fill(0);
    if (!TOKEN.test(value)) throw new RelayError('RELAY_TOKEN_UNSAFE', "the relay's control token is not one");
    return new RelayToken(value);
  } finally {
    await handle.close();
  }
}

/** The loopback base URL a client may use: `http://127.0.0.1:<port>` or `http://[::1]:<port>`, and nothing else. */
export function assertLoopbackRelayUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayError('RELAY_NOT_LOOPBACK', 'the relay address is not a URL');
  }
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]';
  if (
    url.protocol !== 'http:' ||
    !loopback ||
    url.port === '' ||
    url.username !== '' ||
    url.password !== '' ||
    (url.pathname !== '/' && url.pathname !== '') ||
    url.search !== '' ||
    url.hash !== ''
  )
    throw new RelayError(
      'RELAY_NOT_LOOPBACK',
      'Agent Comms reaches a claude-stream relay only on this machine, at http://127.0.0.1:<port>',
    );
  return url;
}

/** A relay session, the fields this client reads (claude-stream `RelaySession`). */
export interface RelaySessionV1 {
  readonly id: string;
  readonly provider: string;
  readonly cwd: string;
  readonly createdAt: string;
  readonly nativeSessionId?: string | undefined;
  readonly activeRunId?: string | undefined;
  readonly requestedMode?: string | undefined;
  readonly attached?: 'observer' | undefined;
  /** Who runs it (claude-stream 0b): absent, or `active`, is this relay; `fenced` or `moved` takes no prompt here. */
  readonly executor?: { readonly state: string } | undefined;
}

/**
 * Whether a session can take a prompt from this client: one the relay runs here — not one it only watches
 * (`attached: observer`, which answers a prompt with 409), and not one fenced or moved to another executor.
 */
export function isPromptableSession(session: RelaySessionV1): boolean {
  return session.attached !== 'observer' && (session.executor === undefined || session.executor.state === 'active');
}

export interface RelayRunV1 {
  readonly id: string;
  readonly sessionId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly endedAt?: string | undefined;
  readonly startId?: string | undefined;
}

export interface RelaySnapshotV1 {
  readonly session: RelaySessionV1;
  readonly runs: readonly RelayRunV1[];
  readonly cursor: number;
}

export interface RelayInfoV1 {
  readonly journalId: string;
  readonly version: string;
  readonly protocol: number;
  readonly capabilities: readonly string[];
}

/** One journal record from the follow stream, the fields this client reads. */
export interface RelayEventV1 {
  readonly id: string;
  readonly cursor: number;
  readonly sessionId: string;
  readonly runId?: string | undefined;
  readonly type: string;
}

export type RelayStartResult =
  | { readonly kind: 'started'; readonly run: RelayRunV1; readonly repeated: boolean }
  | { readonly kind: 'busy' };

/** Who a prompt came from, as the relay records it beside the prompt (`sender`, never trusted for access). */
export const AGENT_COMMS_SENDER: { readonly kind: 'local'; readonly id: string; readonly name: string } = Object.freeze(
  {
    kind: 'local',
    id: 'agent-comms',
    name: 'Agent Comms',
  },
);

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function session(value: unknown): RelaySessionV1 {
  if (!isRecord(value) || typeof value.id !== 'string' || !SESSION_ID.test(value.id))
    throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered with a session this client cannot read');
  if (typeof value.provider !== 'string' || typeof value.cwd !== 'string' || typeof value.createdAt !== 'string')
    throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered with a session this client cannot read');
  const activeRunId = optionalText(value.activeRunId);
  if (activeRunId !== undefined && !RUN_ID.test(activeRunId))
    throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered with a session this client cannot read');
  return {
    id: value.id,
    provider: value.provider,
    cwd: value.cwd,
    createdAt: value.createdAt,
    ...(optionalText(value.nativeSessionId) === undefined ? {} : { nativeSessionId: value.nativeSessionId as string }),
    ...(activeRunId === undefined ? {} : { activeRunId }),
    ...(optionalText(value.requestedMode) === undefined ? {} : { requestedMode: value.requestedMode as string }),
    ...(value.attached === 'observer' ? { attached: 'observer' as const } : {}),
    ...(isRecord(value.executor) && typeof value.executor.state === 'string'
      ? { executor: { state: value.executor.state } }
      : {}),
  };
}

function run(value: unknown): RelayRunV1 {
  if (!isRecord(value) || typeof value.id !== 'string' || !RUN_ID.test(value.id))
    throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered with a run this client cannot read');
  if (typeof value.sessionId !== 'string' || typeof value.status !== 'string' || typeof value.createdAt !== 'string')
    throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered with a run this client cannot read');
  return {
    id: value.id,
    sessionId: value.sessionId,
    status: value.status,
    createdAt: value.createdAt,
    ...(optionalText(value.endedAt) === undefined ? {} : { endedAt: value.endedAt as string }),
    ...(optionalText(value.startId) === undefined ? {} : { startId: value.startId as string }),
  };
}

export interface RelayClientOptions {
  readonly url: string;
  readonly token: RelayToken;
  readonly timeoutMs?: number | undefined;
  /** Who listens on the relay's port; the system's answer by default (`relay-listener.ts`). A seam for tests. */
  readonly attestListener?: ListenerAttestor | undefined;
}

/** What a follow is told: each new record once, and the stream's own gap and close notices. */
export interface RelayFollowHandlers {
  readonly onEvent: (event: RelayEventV1) => void;
  readonly onOpen?: ((journalId: string | null) => void) | undefined;
  readonly onGap?: (() => void) | undefined;
}

/**
 * A client of one relay. `ready()` must pass before anything else is asked: it checks the protocol and the capabilities
 * this client relies on, and refuses with a clear reason otherwise.
 */
export class RelayClient {
  readonly #url: URL;
  readonly #token: RelayToken;
  readonly #timeoutMs: number;
  readonly #attest: ListenerAttestor;

  constructor(options: RelayClientOptions) {
    this.#url = assertLoopbackRelayUrl(options.url);
    this.#token = options.token;
    this.#timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.#attest = options.attestListener ?? ((port) => listenerOwners(port));
  }

  /** `GET /v1/relay`: the relay's protocol and capabilities, refused unless they are the ones this client relies on. */
  async ready(): Promise<RelayInfoV1> {
    const body = await this.#json('GET', '/v1/relay');
    const relay = isRecord(body.value) ? body.value.relay : undefined;
    if (!isRecord(relay) || typeof relay.protocol !== 'number' || !Array.isArray(relay.capabilities))
      throw new RelayError(
        'RELAY_PROTOCOL',
        'the relay does not say which protocol it speaks (GET /v1/relay); this claude-stream is older than Agent Comms needs',
      );
    if (relay.protocol !== RELAY_PROTOCOL)
      throw new RelayError(
        'RELAY_PROTOCOL',
        `the relay speaks protocol ${relay.protocol}, and Agent Comms speaks protocol ${RELAY_PROTOCOL}`,
      );
    const capabilities = relay.capabilities.filter((entry): entry is string => typeof entry === 'string');
    const missing = RELAY_REQUIRED_CAPABILITIES.filter((needed) => !capabilities.includes(needed));
    if (missing.length > 0)
      throw new RelayError(
        'RELAY_PROTOCOL',
        `the relay does not offer ${missing.join(' and ')}, which Agent Comms relies on; update claude-stream`,
      );
    return {
      journalId: typeof relay.journalId === 'string' ? relay.journalId : '',
      version: typeof relay.version === 'string' ? relay.version : 'unknown',
      protocol: relay.protocol,
      capabilities,
    };
  }

  /** `GET /v1/workspace`: the folders a session may work in, when the relay tells a control token (`session-files`). */
  async allowedRoots(): Promise<readonly string[] | null> {
    const body = await this.#json('GET', '/v1/workspace', undefined, [200, 404, 405]);
    if (body.status !== 200 || !isRecord(body.value) || !Array.isArray(body.value.allowedRoots)) return null;
    const roots = body.value.allowedRoots.filter(
      (root): root is string => typeof root === 'string' && root.startsWith('/'),
    );
    return roots;
  }

  /** `GET /v1/sessions`. */
  async sessions(): Promise<readonly RelaySessionV1[]> {
    const body = await this.#json('GET', '/v1/sessions');
    if (!isRecord(body.value) || !Array.isArray(body.value.sessions))
      throw new RelayError(
        'RELAY_BAD_RESPONSE',
        'the relay answered its session list in a shape this client cannot read',
      );
    return body.value.sessions.map(session);
  }

  /** `GET /v1/sessions/:id`: the session, its runs and the journal cursor it reflects; null when there is none. */
  async snapshot(sessionId: string): Promise<RelaySnapshotV1 | null> {
    if (!SESSION_ID.test(sessionId)) throw new RelayError('RELAY_BAD_RESPONSE', 'a relay session id is sess_<uuid>');
    const body = await this.#json('GET', `/v1/sessions/${sessionId}`, undefined, [200, 404]);
    if (body.status === 404) return null;
    if (!isRecord(body.value) || !Array.isArray(body.value.runs) || typeof body.value.cursor !== 'number')
      throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered a session in a shape this client cannot read');
    return { session: session(body.value.session), runs: body.value.runs.map(run), cursor: body.value.cursor };
  }

  /** `POST /v1/sessions`: a new session in `cwd`, which the relay checks is inside its allowed roots. */
  async createSession(input: {
    readonly provider: string;
    readonly cwd: string;
    readonly requestedMode: string;
    readonly title: string;
  }): Promise<RelaySessionV1> {
    const body = await this.#json('POST', '/v1/sessions', input, [201]);
    if (!isRecord(body.value)) throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered a new session oddly');
    return session(body.value.session);
  }

  /**
   * `POST /v1/sessions/:id/runs`: the prompt, under `startId` — the delivery's own — so a retry makes no second run.
   * A session with a live run answers 409: `busy`, and nothing was started.
   */
  async startRun(
    sessionId: string,
    input: { readonly prompt: string; readonly requestedMode: string; readonly startId: string },
  ): Promise<RelayStartResult> {
    if (!SESSION_ID.test(sessionId)) throw new RelayError('RELAY_BAD_RESPONSE', 'a relay session id is sess_<uuid>');
    if (!START_ID.test(input.startId))
      throw new RelayError('RELAY_BAD_RESPONSE', 'a start id is a lower-case version 4 UUID');
    const body = await this.#json(
      'POST',
      `/v1/sessions/${sessionId}/runs`,
      { ...input, sender: AGENT_COMMS_SENDER },
      [200, 202, 409],
    );
    if (body.status === 409) {
      // Busy is the relay's one refusal of a live run: `conflict`, "… already has active run …". Every other 409 — a
      // watched session, a fenced or moved one, a stale generation — is a refusal, retried or failed, never waited on
      // (security review of 0.33.0, finding 3).
      const error = isRecord(body.value) && isRecord(body.value.error) ? body.value.error : {};
      const code = typeof error.code === 'string' ? error.code : undefined;
      const message = typeof error.message === 'string' ? error.message : '';
      if (code === 'conflict' && /\balready has active run\b/u.test(message)) return { kind: 'busy' };
      throw refusedBy(409, code ?? null);
    }
    if (!isRecord(body.value)) throw new RelayError('RELAY_BAD_RESPONSE', 'the relay answered a started run oddly');
    return { kind: 'started', run: run(body.value.run), repeated: body.value.repeated === true };
  }

  /**
   * Follows `GET /v1/events?follow=1` until `signal` aborts or the relay ends the stream — with the Authorization header,
   * which an EventSource cannot send — resuming with `Last-Event-ID` when `lastEventId` is given. Each record is told
   * once, by its `id`: delivery is at least once, so a repeat after a resume is dropped. Returns the last cursor read,
   * for the next resume. A keepalive comes every 15 seconds, so a stream silent for 45 is taken as dropped.
   */
  async follow(input: {
    readonly after: number;
    readonly lastEventId?: number | undefined;
    readonly types: readonly string[];
    readonly signal: AbortSignal;
    readonly seen: Set<string>;
    readonly handlers: RelayFollowHandlers;
  }): Promise<number> {
    const query = new URLSearchParams({ follow: '1', after: String(input.after), types: input.types.join(',') });
    let cursor = input.lastEventId ?? input.after;
    let frame: { event?: string; data: string[]; size: number; dropped: boolean } = {
      data: [],
      size: 0,
      dropped: false,
    };
    const dispatch = () => {
      const current = frame;
      frame = { data: [], size: 0, dropped: false };
      // A record larger than any this client reads is dropped whole, never held (security review of 0.33.0, finding 8).
      if (current.dropped || current.data.length === 0) return;
      if (current.event === 'relay-gap') {
        input.handlers.onGap?.();
        return;
      }
      if (current.event === 'relay-close') throw new StreamClosed();
      if (current.event !== undefined && current.event !== 'relay') return;
      let parsed: unknown;
      try {
        parsed = JSON.parse(current.data.join('\n'));
      } catch {
        return;
      }
      if (!isRecord(parsed) || typeof parsed.id !== 'string' || !EVENT_ID.test(parsed.id)) return;
      if (typeof parsed.cursor === 'number' && parsed.cursor > cursor) cursor = parsed.cursor;
      if (input.seen.has(parsed.id)) return;
      input.seen.add(parsed.id);
      // Bounded: the oldest ids go first, well after any resume could repeat them.
      if (input.seen.size > 4_096) input.seen.delete(input.seen.values().next().value as string);
      if (typeof parsed.sessionId !== 'string' || typeof parsed.type !== 'string') return;
      input.handlers.onEvent({
        id: parsed.id,
        cursor: typeof parsed.cursor === 'number' ? parsed.cursor : cursor,
        sessionId: parsed.sessionId,
        ...(typeof parsed.runId === 'string' ? { runId: parsed.runId } : {}),
        type: parsed.type,
      });
    };
    let buffered = '';
    const decoder = new TextDecoder();
    let skipping = false;
    const lines = (text: string) => {
      buffered += text;
      if (skipping) {
        const end = buffered.search(/\r\n|\n|\r/u);
        if (end === -1) {
          buffered = '';
          return;
        }
        buffered = buffered.slice(end + (buffered.startsWith('\r\n', end) ? 2 : 1));
        skipping = false;
      }
      let newline = buffered.search(/\r\n|\n|\r/u);
      while (newline !== -1) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + (buffered.startsWith('\r\n', newline) ? 2 : 1));
        if (line === '') dispatch();
        else if (!line.startsWith(':')) {
          const colon = line.indexOf(':');
          const field = colon === -1 ? line : line.slice(0, colon);
          const raw = colon === -1 ? '' : line.slice(colon + 1);
          const value = raw.startsWith(' ') ? raw.slice(1) : raw;
          if (field === 'data') {
            frame.size += value.length + 1;
            if (frame.size > MAX_SSE_FRAME) {
              frame.dropped = true;
              frame.data = [];
            } else if (!frame.dropped) frame.data.push(value);
          } else if (field === 'event') frame.event = value;
          else if (field === 'id') {
            const id = Number(value);
            if (Number.isSafeInteger(id) && id > cursor) cursor = id;
          }
        }
        newline = buffered.search(/\r\n|\n|\r/u);
      }
      // What is left is one unfinished line. One longer than any record is dropped, with the record it is in, as it
      // comes — never held, and never a reason to follow the stream again only to be sent it again.
      if (buffered.length > MAX_SSE_LINE) {
        buffered = '';
        skipping = true;
        frame.dropped = true;
        frame.data = [];
      }
    };
    try {
      await exchange(this.#url, {
        attest: this.#attest,
        method: 'GET',
        path: `/v1/events?${query.toString()}`,
        headers: {
          Authorization: this.#token.authorization(),
          Accept: 'text/event-stream',
          ...(input.lastEventId === undefined ? {} : { 'Last-Event-ID': String(input.lastEventId) }),
        },
        maxBytes: Number.MAX_SAFE_INTEGER,
        idleTimeoutMs: SSE_IDLE_MS,
        signal: input.signal,
        onHead: (head) => {
          if (head.status !== 200) throw refusedBy(head.status, null);
          input.handlers.onOpen?.(head.headers.get('x-relay-journal') ?? null);
        },
        onBody: (chunk) => lines(decoder.decode(chunk, { stream: true })),
      });
    } catch (error) {
      if (!(error instanceof StreamEnded)) throw error;
      // A stream the relay closed, dropped or let go silent ends here; the caller resumes from the cursor returned.
    }
    return cursor;
  }

  async #json(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    accepted: readonly number[] = [200],
  ): Promise<{ readonly status: number; readonly value: unknown }> {
    const response = await exchange(this.#url, {
      attest: this.#attest,
      method,
      path,
      headers: {
        Authorization: this.#token.authorization(),
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: Buffer.from(JSON.stringify(body)) }),
      maxBytes: MAX_RESPONSE_BYTES,
      totalTimeoutMs: this.#timeoutMs,
    });
    const text = response.body.toString('utf8');
    let value: unknown = null;
    if (text.length > 0) {
      try {
        value = JSON.parse(text);
      } catch {
        value = null;
      }
    }
    if (!accepted.includes(response.status)) {
      const code = isRecord(value) && isRecord(value.error) ? value.error.code : undefined;
      if (response.status === 404 && path === '/v1/relay')
        throw new RelayError(
          'RELAY_PROTOCOL',
          'the relay does not say which protocol it speaks (GET /v1/relay); this claude-stream is older than Agent Comms needs',
          { status: 404 },
        );
      throw refusedBy(response.status, typeof code === 'string' ? code : null);
    }
    return { status: response.status, value };
  }
}

class StreamClosed extends Error {}

/** A follow stream that ended — closed, dropped or silent — rather than one that could not be opened. */
class StreamEnded extends RelayError {}

const SSE_IDLE_MS = 45_000;

interface HttpHead {
  readonly status: number;
  readonly headers: ReadonlyMap<string, string>;
}

/** The status line and headers of an HTTP/1.1 response, names lower-cased; null when they are not one. */
function parseHead(text: string): HttpHead | null {
  const [statusLine, ...lines] = text.split('\r\n');
  const status = /^HTTP\/1\.[01] ([0-9]{3})(?: |$)/u.exec(statusLine ?? '');
  if (status?.[1] === undefined) return null;
  const headers = new Map<string, string>();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) return null;
    headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  return { status: Number(status[1]), headers };
}

/** Undoes `Transfer-Encoding: chunked` as the bytes come, handing on each chunk's data. */
class ChunkedDecoder {
  #buffer = Buffer.alloc(0);
  #remaining = -1;
  #done = false;

  push(bytes: Buffer, emit: (data: Buffer) => void): void {
    this.#buffer = Buffer.concat([this.#buffer, bytes]);
    while (!this.#done) {
      if (this.#remaining < 0) {
        const end = this.#buffer.indexOf('\r\n');
        if (end === -1) {
          if (this.#buffer.length > 64) throw new RelayError('RELAY_BAD_RESPONSE', 'the relay sent a malformed chunk');
          return;
        }
        const size = Number.parseInt(this.#buffer.subarray(0, end).toString('latin1').split(';')[0] ?? '', 16);
        if (!Number.isSafeInteger(size) || size < 0)
          throw new RelayError('RELAY_BAD_RESPONSE', 'the relay sent a malformed chunk');
        this.#buffer = this.#buffer.subarray(end + 2);
        if (size === 0) {
          this.#done = true;
          return;
        }
        this.#remaining = size;
      }
      if (this.#buffer.length < this.#remaining + 2) {
        if (this.#buffer.length > 0 && this.#remaining > 0) {
          const take = Math.min(this.#buffer.length, this.#remaining);
          emit(this.#buffer.subarray(0, take));
          this.#buffer = this.#buffer.subarray(take);
          this.#remaining -= take;
          if (this.#remaining > 0) return;
          continue;
        }
        return;
      }
      if (this.#remaining > 0) emit(this.#buffer.subarray(0, this.#remaining));
      this.#buffer = this.#buffer.subarray(this.#remaining + 2);
      this.#remaining = -1;
    }
  }
}

/**
 * One HTTP/1.1 exchange with the relay over the event service's pinned path: 127.0.0.1 as the one approved literal,
 * a plain TCP connection to it, the raw request bytes, and the response read under a byte ceiling and a deadline —
 * no fetch, no redirect, no proxy. `onHead` and `onBody` stream it; without them the whole body is returned.
 */
async function exchange(
  base: URL,
  input: {
    readonly attest: ListenerAttestor;
    readonly method: 'GET' | 'POST';
    readonly path: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: Buffer | undefined;
    readonly maxBytes: number;
    readonly totalTimeoutMs?: number | undefined;
    readonly idleTimeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly onHead?: ((head: HttpHead) => void) | undefined;
    readonly onBody?: ((chunk: Buffer) => void) | undefined;
  },
): Promise<{ readonly status: number; readonly headers: ReadonlyMap<string, string>; readonly body: Buffer }> {
  let socket: Awaited<ReturnType<typeof connectPinnedTcp>>;
  let connection: Awaited<ReturnType<typeof preparePinnedConnection>>;
  try {
    connection = await preparePinnedConnection({
      url: new URL(input.path, base),
      approvedAddressSet: [LOOPBACK],
      approvedAddressSetDigest: addressSetDigest([LOOPBACK]),
    });
    socket = await connectPinnedTcp({
      host: connection.address,
      port: connection.port,
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
  } catch {
    throw new RelayError(
      'RELAY_UNREACHABLE',
      'the claude-stream relay could not be reached: is it running (or is the Pilot app open)?',
    );
  }
  // Before a byte of the request — its token — is sent: the port is held by this user's own process, or nothing is sent.
  let yours: boolean | 'unknown';
  try {
    yours = listenersAreYours(await input.attest(connection.port), process.getuid?.());
  } catch {
    yours = 'unknown';
  }
  if (yours !== true) {
    socket.destroy();
    throw new RelayError(
      'RELAY_NOT_YOURS',
      yours === 'unknown'
        ? "who holds the relay's port could not be checked, so its control token was not sent"
        : "the relay's port is not held by a relay you run, so its control token was not sent: is claude-stream running as you?",
    );
  }
  let head: HttpHead | undefined;
  let pending = Buffer.alloc(0);
  let chunked: ChunkedDecoder | undefined;
  const body: Buffer[] = [];
  const emit = (data: Buffer) => {
    if (input.onBody === undefined) body.push(Buffer.from(data));
    else input.onBody(data);
  };
  try {
    await streamPinnedResponseTo(
      socket,
      requestBytesForPinnedConnection(connection, input.method, input.body, input.headers),
      {
        maxBytes: input.maxBytes,
        ...(input.signal === undefined ? {} : { signal: input.signal }),
        ...(input.totalTimeoutMs === undefined ? {} : { totalTimeoutMs: input.totalTimeoutMs }),
        ...(input.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: input.idleTimeoutMs }),
        onChunk: (chunk) => {
          if (head === undefined) {
            pending = Buffer.concat([pending, chunk]);
            const end = pending.indexOf('\r\n\r\n');
            if (end === -1) {
              if (pending.length > 16_384) throw new RelayError('RELAY_BAD_RESPONSE', 'the relay sent an odd answer');
              return;
            }
            const parsed = parseHead(pending.subarray(0, end).toString('latin1'));
            if (parsed === null) throw new RelayError('RELAY_BAD_RESPONSE', 'the relay sent an odd answer');
            head = parsed;
            if (/\bchunked\b/iu.test(parsed.headers.get('transfer-encoding') ?? '')) chunked = new ChunkedDecoder();
            input.onHead?.(parsed);
            chunk = pending.subarray(end + 4);
            pending = Buffer.alloc(0);
          }
          if (chunk.length === 0) return;
          if (chunked === undefined) emit(chunk);
          else chunked.push(chunk, emit);
        },
      },
    );
  } catch (error) {
    socket.destroy();
    if (error instanceof RelayError) throw error;
    if (head !== undefined && input.onBody !== undefined)
      throw new StreamEnded('RELAY_UNREACHABLE', 'the relay ended the stream');
    if (error instanceof PinnedResponseError && error.code === 'NETWORK_TOTAL_TIMEOUT')
      throw new RelayError('RELAY_UNREACHABLE', 'the claude-stream relay did not answer in time');
    throw new RelayError(
      'RELAY_UNREACHABLE',
      'the claude-stream relay could not be reached: is it running (or is the Pilot app open)?',
    );
  } finally {
    socket.destroy();
  }
  // A connection closed before any answer: the request may or may not have been acted on, as with any lost answer.
  if (head === undefined)
    throw new RelayError('RELAY_UNREACHABLE', 'the relay closed the connection before it answered');
  return { status: head.status, headers: head.headers, body: Buffer.concat(body) };
}

/** A refusal by status: the relay's own error code is kept (a closed word), its message is not. */
function refusedBy(status: number, relayCode: string | null): RelayError {
  const code = relayCode !== null && /^[a-z_]{1,40}$/u.test(relayCode) ? relayCode : undefined;
  if (status === 401 || status === 403)
    return new RelayError('RELAY_REFUSED', 'the relay refused the control token', {
      status,
      ...(code === undefined ? {} : { relayCode: code }),
    });
  if (status >= 500)
    return new RelayError('RELAY_FAILED', `the relay failed (HTTP ${status})`, {
      status,
      ...(code === undefined ? {} : { relayCode: code }),
    });
  return new RelayError('RELAY_REFUSED', `the relay refused the request (HTTP ${status}${code ? `, ${code}` : ''})`, {
    status,
    ...(code === undefined ? {} : { relayCode: code }),
  });
}
