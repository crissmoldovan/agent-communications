import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Slack's Web API and its files host on a loopback port. Never the real ones.
 *
 * A real HTTP server rather than a function standing in for `fetch`, because what these tests have to show is about
 * the request as it leaves: which token rode on it, in which header, and that nothing else did. The guard is not
 * relaxed to reach it — `fetch` below is the *inner* fetch, which only ever sees a URL the guard has already
 * approved, as `https://slack.com/api/…` or `https://files.slack.com/files-pri/…`, and rewrites the origin to this
 * server after that approval. Any other URL reaching it means the guard let it through, and it throws rather than
 * sending — so a token cannot reach a third host through this fake, and a test that tried would fail.
 *
 * One server for both hosts, told apart by a prefix the rewrite adds: `/api/…` is the Web API, `/files/…` the files
 * host. Anything else that arrives — a redirect somebody followed, say — is recorded as `other`, so a test can say
 * nothing did.
 *
 * The files host takes uploads as well as downloads: `acceptUploads` scripts the three Web API methods a file post
 * makes — `files.getUploadURLExternal`, `files.completeUploadExternal` and `files.info` — and the upload URLs it hands
 * out are paths on the files host, whose bytes are kept exactly as they arrived.
 */

export const API = 'https://slack.com/api/';
export const FILES = 'https://files.slack.com/files-pri/';
/** Where the upload URLs `acceptUploads` hands out point: the files host, under `/upload/`, as Slack's do. */
export const UPLOADS = 'https://files.slack.com/upload/';

export interface SlackRequest {
  /** Which host it reached: the Web API, the files host, or neither — which is always a failure. */
  readonly host: 'api' | 'files' | 'other';
  /** The Slack method, from the last path segment: `apps.manifest.validate`. Empty for anything but the Web API. */
  readonly method: string;
  /** The HTTP verb. */
  readonly verb: string;
  /** The path as the real host would have seen it, without this server's prefix and without the query. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly params: URLSearchParams;
  /** The body exactly as it arrived, byte for byte: what an upload sent. */
  readonly body: Buffer;
  /** The path and query exactly as received. */
  readonly url: string;
  /** Everything that arrived — request line, every header, the body — for "it appeared nowhere else" assertions. */
  readonly raw: string;
}

/**
 * What a scripted method returns to have the Web API take the request — it is recorded, and whatever the script did
 * before returning has happened — and then destroy the socket instead of answering: Slack acting on a post, and the
 * answer lost on the way back. The case that says nothing about whether a write happened.
 */
export const DROP: unique symbol = Symbol('drop the connection instead of answering');

/** A Web API answer with a chosen HTTP status and an ordinary JSON body. */
export interface HttpReply {
  readonly status: number;
  readonly body: unknown;
  /** Sent with it: `Retry-After` on a 429, as Slack sends it. */
  readonly headers?: Record<string, string>;
}

export type Reply =
  | ((request: SlackRequest) => unknown | HttpReply | typeof DROP)
  | ((request: SlackRequest) => Promise<unknown | HttpReply | typeof DROP>);

/** One cursor-addressed page from Slack's two event read methods. */
export interface SlackEventPageFixture {
  readonly messages?: readonly Record<string, unknown>[] | undefined;
  readonly nextCursor?: string | null | undefined;
  readonly retainedHistoryBoundary?: boolean | undefined;
  /** A loopback 429 with Slack's documented retry hint. */
  readonly retryAfterSeconds?: number | undefined;
  /** Holds this page after the request journal records it. */
  readonly delayed?: Promise<void> | undefined;
}

/** Cursor-addressed event fixtures; reply keys are `${parentTs}\u0000${cursor ?? ''}`. */
export interface SlackEventPages {
  readonly history: Readonly<Record<string, SlackEventPageFixture>>;
  readonly replies: Readonly<Record<string, SlackEventPageFixture>>;
}

/** How the files host answers one file. */
export interface FileReply {
  /** 200 unless said otherwise. */
  status?: number;
  /** Sent as given, after the defaults: a `content-length` here overrides the true one. */
  headers?: Record<string, string>;
  /** Sent in one piece, with its length declared. */
  body?: Uint8Array | string;
  /** Sent one after another with no length declared, so only a running count can tell how much is coming. */
  chunks?: readonly Uint8Array[];
  /**
   * Sent slowly: the headers at once, then one chunk every `everyMs`, then the end. No length is declared unless
   * `headers` declares one. A slow host that never stops — the case a limit on a whole download exists for.
   */
  pace?: { readonly chunks: readonly Uint8Array[]; readonly everyMs: number };
  /** With `pace`, how many of its chunks are sent before the host goes silent, holding the connection open. */
  stallAfter?: number;
  /**
   * Send the headers and one byte, then nothing more: the case a timeout exists for. For an upload, take the bytes
   * and never answer at all — no status, no headers.
   */
  stall?: boolean;
  /** Destroy the socket instead of answering. */
  drop?: boolean;
}

export type FileAnswer = (request: SlackRequest) => FileReply;

/** How the files host answers an upload: at once, or — a promise — once the test lets it, after its bytes arrived. */
export type UploadAnswer = (request: SlackRequest) => FileReply | Promise<FileReply>;

/** One upload URL `files.getUploadURLExternal` handed out, and what it was asked for. */
export interface IssuedUpload {
  readonly fileId: string;
  readonly url: string;
  readonly filename: string;
  readonly length: number;
}

/** One `files.completeUploadExternal`, as Slack was asked it. */
export interface CompletedUpload {
  readonly channelId: string | null;
  readonly initialComment: string | null;
  readonly threadTs: string | null;
  readonly files: readonly { id: string; title?: string }[];
}

/** What the scripted file post has seen, for a test to hold the request against. */
export interface FakeUploads {
  readonly issued: IssuedUpload[];
  /** The bytes each upload URL received, by the file id it was issued for. */
  readonly received: Record<string, Buffer>;
  readonly completed: CompletedUpload[];
}

export interface UploadOptions {
  /**
   * The message ts `files.info` reports in the file's shares for the channel. `null` reports no shares at all — Slack
   * has not attached the file to a message yet — which is what a post returns `ts: null` for.
   */
  ts?: string | null;
  /** Whether the channel is private, so the share is under `shares.private` rather than `shares.public`. */
  private?: boolean;
  /** A Slack error for `files.completeUploadExternal` to answer with, in place of success. */
  completeError?: string;
  /** A Slack error for `files.getUploadURLExternal` to answer with, in place of an upload URL. */
  urlError?: string;
  /**
   * Runs as `files.getUploadURLExternal` is asked for a file, before it answers: after a send's first pass over every
   * file, and before that file's own read and upload — the gap a test changes a file in.
   */
  onUploadUrl?: (filename: string) => void;
}

export interface FakeSlack {
  readonly requests: SlackRequest[];
  /** Replies by method. A method with no reply answers `unknown_method`, as Slack does. */
  script: Record<string, Reply>;
  /** Answers by `<TEAM>-<FILEID>`, the pair the files path names. A file with no answer is a 404. */
  files: Record<string, FileAnswer>;
  /**
   * How the files host answers an upload. `200 OK` unless replaced. A promise holds the answer back — the bytes have
   * arrived and been recorded — until it settles: an upload as long as a test needs it to be.
   */
  uploadAnswer: UploadAnswer;
  /** Installs the narrow, read-only history/replies routes used by local event tests. */
  eventPages(pages: SlackEventPages): void;
  /**
   * Scripts the three Web API methods a file post makes, and returns what they see as they are called.
   *
   * Replaces any `files.info` already scripted: a test that posts files is not also downloading them.
   */
  acceptUploads(options?: UploadOptions): FakeUploads;
  /** This server's own origin, for a reply that must point somewhere the guard never approved — a redirect. */
  readonly local: string;
  /** The inner fetch to hand the CLI. */
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  close(): Promise<void>;
}

function read(request: IncomingMessage): Promise<Buffer> {
  return new Promise((settle, fail) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on('end', () => settle(Buffer.concat(chunks)));
    request.on('error', fail);
  });
}

function sendReply(reply: FileReply, response: ServerResponse): void {
  if (reply.drop) {
    response.socket?.destroy();
    return;
  }
  // The bytes were read before this was asked; the answer never comes, and the connection is held until the fake closes.
  if (reply.stall) return;
  const status = reply.status ?? 200;
  const headers = { 'content-type': 'application/octet-stream', ...reply.headers };
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : Buffer.from(reply.body ?? new Uint8Array());
  response.writeHead(status, { 'content-length': String(body.byteLength), ...headers });
  response.end(body);
}

/** Scripts a file post on `fake`: see {@link FakeSlack.acceptUploads}. */
function acceptUploads(fake: FakeSlack, options: UploadOptions = {}): FakeUploads {
  const seen: FakeUploads = { issued: [], received: {}, completed: [] };
  let next = 0;
  fake.script['files.getUploadURLExternal'] = (request) => {
    options.onUploadUrl?.(request.params.get('filename') ?? '');
    if (options.urlError) return { ok: false, error: options.urlError };
    next += 1;
    const fileId = `F0UP${String(next).padStart(4, '0')}`;
    // Opaque, as Slack's are, and different for every file.
    const url = `${UPLOADS}v1/CwAB${fileId}x${String(next * 7919)}`;
    seen.issued.push({
      fileId,
      url,
      filename: request.params.get('filename') ?? '',
      length: Number(request.params.get('length')),
    });
    return { ok: true, upload_url: url, file_id: fileId };
  };
  fake.script['files.completeUploadExternal'] = (request) => {
    const files = JSON.parse(request.params.get('files') ?? '[]') as { id: string; title?: string }[];
    seen.completed.push({
      channelId: request.params.get('channel_id'),
      initialComment: request.params.get('initial_comment'),
      threadTs: request.params.get('thread_ts'),
      files,
    });
    if (options.completeError) return { ok: false, error: options.completeError };
    // Slack's answer: the files, and no message ts anywhere in it.
    return { ok: true, files: files.map((file) => ({ id: file.id, title: file.title ?? '' })) };
  };
  fake.script['files.info'] = (request) => {
    const id = request.params.get('file') ?? '';
    const done = seen.completed.find((completed) => completed.files.some((file) => file.id === id));
    const ts = options.ts === undefined ? '1700000000.000200' : options.ts;
    const channel = done?.channelId ?? '';
    const share = { ts: ts ?? '', ...(done?.threadTs ? { thread_ts: done.threadTs } : {}) };
    return {
      ok: true,
      file: {
        id,
        name: seen.issued.find((issued) => issued.fileId === id)?.filename ?? '',
        shares:
          ts === null || done === undefined ? {} : { [options.private ? 'private' : 'public']: { [channel]: [share] } },
      },
    };
  };
  // Kept apart from `uploadAnswer`, so a test that changes how the host answers still sees what it was sent.
  receivers.set(fake, (request) => {
    const issued = seen.issued.find((upload) => upload.url === `https://files.slack.com${request.path}`);
    if (issued) seen.received[issued.fileId] = request.body;
  });
  return seen;
}

/** What each fake does with an upload's bytes before it answers: `acceptUploads` keeps them. */
const receivers = new WeakMap<FakeSlack, (request: SlackRequest) => void>();

function answerFile(fake: FakeSlack, recorded: SlackRequest, response: ServerResponse): void {
  if (recorded.path.startsWith('/upload/')) {
    receivers.get(fake)?.(recorded);
    const reply = fake.uploadAnswer(recorded);
    if (reply instanceof Promise) void reply.then((held) => sendReply(held, response));
    else sendReply(reply, response);
    return;
  }
  const pair = recorded.path.split('/')[2] ?? '';
  const answer = fake.files[pair];
  const reply: FileReply = answer ? answer(recorded) : { status: 404, body: 'file_not_found' };
  if (reply.drop) {
    response.socket?.destroy();
    return;
  }
  const status = reply.status ?? 200;
  const headers = { 'content-type': 'application/octet-stream', ...reply.headers };
  if (reply.stall) {
    response.writeHead(status, headers);
    response.write(Buffer.from([0]));
    return;
  }
  if (reply.chunks) {
    response.writeHead(status, headers);
    for (const chunk of reply.chunks) response.write(chunk);
    response.end();
    return;
  }
  if (reply.pace) {
    sendPaced(reply.pace, reply.stallAfter, status, headers, response);
    return;
  }
  const body = typeof reply.body === 'string' ? Buffer.from(reply.body) : Buffer.from(reply.body ?? new Uint8Array());
  response.writeHead(status, { 'content-length': String(body.byteLength), ...headers });
  response.end(body);
}

/** The headers now, then a chunk every `everyMs` — or silence, with the connection open, after `stallAfter` of them. */
function sendPaced(
  pace: NonNullable<FileReply['pace']>,
  stallAfter: number | undefined,
  status: number,
  headers: Record<string, string>,
  response: ServerResponse,
): void {
  response.writeHead(status, headers);
  response.flushHeaders();
  let sent = 0;
  const next = (): void => {
    // A client that gave up, or a fake that closed: nothing more to send.
    if (response.destroyed || response.writableEnded) return;
    if (stallAfter !== undefined && sent >= stallAfter) return;
    const chunk = pace.chunks[sent];
    if (chunk === undefined) {
      response.end();
      return;
    }
    response.write(chunk);
    sent += 1;
    setTimeout(next, pace.everyMs);
  };
  setTimeout(next, pace.everyMs);
}

function eventPageAnswer(page: SlackEventPageFixture): Reply {
  return async () => {
    await page.delayed;
    if (page.retryAfterSeconds !== undefined)
      return {
        status: 429,
        headers: { 'retry-after': String(page.retryAfterSeconds) },
        body: { ok: false, error: 'ratelimited' },
      };
    return {
      ok: true,
      messages: page.messages ?? [],
      ...(page.retainedHistoryBoundary === true ? { is_limited: true } : {}),
      response_metadata:
        page.nextCursor === null || page.nextCursor === undefined ? {} : { next_cursor: page.nextCursor },
    };
  };
}

function installEventPages(fake: FakeSlack, pages: SlackEventPages): void {
  fake.script['conversations.history'] = (request) => {
    const cursor = request.params.get('cursor') ?? '';
    const page = pages.history[cursor];
    return page === undefined ? { ok: false, error: 'invalid_cursor' } : eventPageAnswer(page)(request);
  };
  fake.script['conversations.replies'] = (request) => {
    const parent = request.params.get('ts') ?? '';
    const cursor = request.params.get('cursor') ?? '';
    const page = pages.replies[`${parent}\u0000${cursor}`];
    return page === undefined ? { ok: false, error: 'invalid_cursor' } : eventPageAnswer(page)(request);
  };
}

export async function startFakeSlack(script: Record<string, Reply> = {}): Promise<FakeSlack> {
  const requests: SlackRequest[] = [];
  const fake: FakeSlack = {
    requests,
    script,
    files: {},
    uploadAnswer: () => ({ status: 200, body: 'OK' }),
    eventPages: (pages) => installEventPages(fake, pages),
    acceptUploads: (options) => acceptUploads(fake, options),
    local: '',
    fetch: async () => {
      throw new Error('not started');
    },
    close: async () => undefined,
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const bytes = await read(request);
      const body = bytes.toString('utf8');
      const url = request.url ?? '';
      const pathname = url.split('?')[0] ?? '';
      const host = pathname.startsWith('/api/') ? 'api' : pathname.startsWith('/files/') ? 'files' : 'other';
      const method = host === 'api' ? (pathname.split('/api/')[1] ?? '') : '';
      const headers: string[] = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      }
      const recorded: SlackRequest = {
        host,
        method,
        verb: request.method ?? '',
        path: host === 'files' ? pathname.slice('/files'.length) : pathname,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        params: new URLSearchParams(body),
        body: bytes,
        url,
        raw: `${request.method} ${url}\n${headers.join('\n')}\n\n${body}`,
      };
      requests.push(recorded);
      if (host === 'files') {
        answerFile(fake, recorded, response);
        return;
      }
      if (host === 'other') {
        // Answered as if it were the file, so a redirect that was followed looks like a success to the client — and
        // only this record says otherwise.
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end('followed');
        return;
      }
      const reply = fake.script[method];
      const answer = reply ? await reply(recorded) : { ok: false, error: 'unknown_method' };
      if (answer === DROP) {
        response.socket?.destroy();
        return;
      }
      const selected =
        typeof answer === 'object' && answer !== null && 'status' in answer && 'body' in answer
          ? (answer as HttpReply)
          : { status: 200, body: answer };
      response.writeHead(selected.status, {
        'content-type': 'application/json',
        ...('headers' in selected ? selected.headers : {}),
      });
      response.end(JSON.stringify(selected.body));
    })();
  });
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return Object.assign(fake, {
    local: origin,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Only ever a URL the guard has approved. Anything else here means the guard let it through, which is a failure.
      if (url.startsWith(API)) return fetch(url.replace('https://slack.com', origin), init);
      if (url.startsWith(FILES) || url.startsWith(UPLOADS)) {
        return fetch(url.replace('https://files.slack.com', `${origin}/files`), init);
      }
      throw new Error(`the guard let ${url} through`);
    },
    close: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  });
}
