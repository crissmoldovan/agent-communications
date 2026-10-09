import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Resend's API and attachment CDN on a loopback port. Never the real one.
 *
 * A real HTTP server rather than a function standing in for `fetch`, because what these tests have to show is about
 * the request as it leaves: which key rode on it, in which header, which idempotency key, and that nothing else did.
 * The guard is not relaxed to reach it — `fetch` below is the *inner* fetch, which only ever sees a URL the guard has
 * already approved, and rewrites the origin to this server after that approval. A URL that is not Resend's reaching
 * it is a failure of the guard, and throws.
 */

export const API = 'https://api.resend.com';
export const CDN = 'https://inbound-cdn.resend.com';

export interface SeenRequest {
  readonly origin: 'api' | 'cdn';
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
  /** Request line, every header and the body, for "it appeared nowhere else" assertions. */
  readonly raw: string;
}

export interface Reply {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
  /** Destroy the socket instead of answering: the outcome the client cannot know. */
  drop?: boolean;
}

export interface FakeDomain {
  id: string;
  name: string;
  status: string;
  sending?: string;
  receiving?: string;
}

export interface FakeKey {
  permission: 'full_access' | 'sending_access';
  domain?: string | undefined;
}

export interface FakeSent {
  id: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  reply_to: string[];
  subject: string;
  text: string | null;
  html: string | null;
  last_event: string;
  scheduled_at: string | null;
  created_at: string;
  message_id: string;
  tags: { name: string; value: string }[];
  headers: Record<string, string>;
  attachments: { filename: string; content_type?: string; content: string }[];
}

export interface FakeReceived {
  id: string;
  from: string;
  to: string[];
  cc?: string[];
  reply_to?: string[];
  subject: string;
  html?: string | null;
  text?: string | null;
  message_id?: string;
  created_at?: string;
  received_for?: string[];
  authentication?: { spf: string; dkim: string; dmarc: string } | null;
  attachments?: { id: string; filename: string; content_type: string; bytes: Uint8Array; inline?: boolean }[];
}

export interface FakeResend {
  readonly requests: SeenRequest[];
  /** Deterministic provider clock for received/sent fixtures; it never affects the host clock. */
  readonly now: () => number;
  setNow(value: number): void;
  readonly keys: Map<string, FakeKey>;
  domains: FakeDomain[];
  readonly sent: FakeSent[];
  received: FakeReceived[];
  suppressions: { id: string; email: string; origin: string; source_id: string | null; created_at: string }[];
  /** Answers a request before the fake does, when it returns a reply. */
  intercept: ((request: SeenRequest) => Reply | undefined) | null;
  /** Called once a send has been created, to answer something other than success for it. */
  afterSend: ((email: FakeSent) => Reply | undefined) | null;
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Only the requests that reached Resend's send route. */
  sends(): SeenRequest[];
  close(): Promise<void>;
}

function read(request: IncomingMessage): Promise<string> {
  return new Promise((settle, fail) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk: string) => {
      body += chunk;
    });
    request.on('end', () => settle(body));
    request.on('error', fail);
  });
}

const RATE = { 'ratelimit-limit': '10', 'ratelimit-remaining': '9', 'ratelimit-reset': '1' };

function error(status: number, name: string, message: string): Reply {
  return { status, body: { statusCode: status, name, message } };
}

function list<T>(items: T[], query: URLSearchParams, idOf: (item: T) => string): { has_more: boolean; data: T[] } {
  const limit = Number(query.get('limit') ?? '20');
  const after = query.get('after');
  const start = after ? items.findIndex((item) => idOf(item) === after) + 1 : 0;
  const page = items.slice(start, start + limit);
  return { has_more: start + limit < items.length, data: page };
}

export async function startFakeResend(): Promise<FakeResend> {
  const requests: SeenRequest[] = [];
  const idempotency = new Map<string, { hash: string; reply: Reply }>();
  let now = Date.now();
  const fake: FakeResend = {
    requests,
    now: () => now,
    setNow: (value) => {
      now = value;
    },
    keys: new Map(),
    domains: [],
    sent: [],
    received: [],
    suppressions: [],
    intercept: null,
    afterSend: null,
    fetch: async () => {
      throw new Error('not started');
    },
    sends: () =>
      requests.filter((request) => request.origin === 'api' && request.method === 'POST' && request.path === '/emails'),
    close: async () => undefined,
  };

  const answer = (seen: SeenRequest): Reply => {
    if (seen.origin === 'cdn') {
      const [, emailId, , attachmentId] = seen.path.split('/');
      const email = fake.received.find((candidate) => candidate.id === emailId);
      const attachment = email?.attachments?.find((candidate) => candidate.id === attachmentId);
      if (!attachment || seen.query.get('signature') !== 'sig-test') return { status: 404, body: 'not found' };
      return { status: 200, body: attachment.bytes, headers: { 'content-type': attachment.content_type } };
    }
    const auth = String(seen.headers.authorization ?? '');
    const key = auth.startsWith('Bearer ') ? fake.keys.get(auth.slice(7)) : undefined;
    if (!auth) return error(401, 'missing_api_key', 'Missing API key in the authorization header');
    if (!key) return error(401, 'validation_error', `API key is invalid: ${auth.slice(7)}`);
    const isSend = seen.method === 'POST' && seen.path === '/emails';
    if (key.permission === 'sending_access' && !isSend) {
      return error(401, 'restricted_api_key', 'This API key is restricted to only send emails');
    }
    const segments = seen.path.split('/').filter(Boolean);

    if (seen.method === 'GET' && seen.path === '/domains') {
      return {
        status: 200,
        body: {
          object: 'list',
          has_more: false,
          data: fake.domains.map((domain) => ({
            id: domain.id,
            name: domain.name,
            status: domain.status,
            created_at: '2026-09-01 10:00:00+00',
            region: 'eu-west-1',
            capabilities: { sending: domain.sending ?? 'enabled', receiving: domain.receiving ?? 'disabled' },
          })),
        },
      };
    }
    if (seen.method === 'GET' && segments[0] === 'domains' && segments.length === 2) {
      const domain = fake.domains.find((candidate) => candidate.id === segments[1]);
      if (!domain) return error(404, 'not_found', 'Domain not found');
      return {
        status: 200,
        body: {
          object: 'domain',
          id: domain.id,
          name: domain.name,
          status: domain.status,
          region: 'eu-west-1',
          capabilities: { sending: domain.sending ?? 'enabled', receiving: domain.receiving ?? 'disabled' },
          records: [
            {
              record: 'SPF',
              name: 'send',
              type: 'TXT',
              ttl: 'Auto',
              status: domain.status,
              value: '"v=spf1 include:amazonses.com ~all"',
            },
            {
              record: 'DKIM',
              name: 'resend._domainkey',
              type: 'TXT',
              ttl: 'Auto',
              status: domain.status,
              value: 'p=FAKEKEY',
            },
          ],
        },
      };
    }
    if (isSend) {
      const body = JSON.parse(seen.body) as Record<string, unknown>;
      const from = String(body.from ?? '');
      const domainName =
        from
          .replace(/^.*<|>.*$/g, '')
          .split('@')[1]
          ?.toLowerCase() ?? '';
      const domain = fake.domains.find((candidate) => candidate.name === domainName);
      if (domain?.status !== 'verified') {
        return error(
          403,
          'validation_error',
          `The ${domainName} domain is not verified. Please, add and verify your domain.`,
        );
      }
      if (key.domain && key.domain !== domainName)
        return error(403, 'validation_error', 'This key cannot send from that domain');
      const idem = typeof seen.headers['idempotency-key'] === 'string' ? seen.headers['idempotency-key'] : undefined;
      const hash = createHash('sha256').update(seen.body).digest('hex');
      if (idem) {
        const known = idempotency.get(idem);
        if (known && known.hash !== hash) return error(409, 'invalid_idempotent_request', 'Body differs');
        if (known) return known.reply;
      }
      const email: FakeSent = {
        id: randomUUID(),
        from,
        to: (body.to as string[]) ?? [],
        cc: (body.cc as string[]) ?? [],
        bcc: (body.bcc as string[]) ?? [],
        reply_to: (body.reply_to as string[]) ?? [],
        subject: String(body.subject ?? ''),
        text: typeof body.text === 'string' ? body.text : null,
        html: typeof body.html === 'string' ? body.html : null,
        last_event: body.scheduled_at ? 'scheduled' : 'delivered',
        scheduled_at: typeof body.scheduled_at === 'string' ? body.scheduled_at : null,
        created_at: new Date(now).toISOString(),
        message_id: `<${randomUUID()}@example.test>`,
        tags: (body.tags as { name: string; value: string }[]) ?? [],
        headers: (body.headers as Record<string, string>) ?? {},
        attachments: (body.attachments as FakeSent['attachments']) ?? [],
      };
      fake.sent.unshift(email);
      const reply = fake.afterSend?.(email) ?? { status: 200, body: { id: email.id } };
      if (idem) idempotency.set(idem, { hash, reply });
      return reply;
    }
    if (seen.method === 'GET' && seen.path === '/emails') {
      const page = list(fake.sent, seen.query, (email) => email.id);
      return {
        status: 200,
        body: {
          object: 'list',
          has_more: page.has_more,
          data: page.data.map(({ html: _h, text: _t, tags: _tags, headers: _hd, attachments: _a, ...rest }) => rest),
        },
      };
    }
    if (seen.method === 'GET' && seen.path === '/emails/metrics') {
      return {
        status: 200,
        body: {
          object: 'metrics',
          start_date: seen.query.get('start_date') ?? '2026-09-20T00:00:00.000Z',
          end_date: seen.query.get('end_date') ?? '2026-09-26T00:00:00.000Z',
          totals: {
            sent: fake.sent.length,
            delivered: fake.sent.filter((email) => email.last_event === 'delivered').length,
            bounce_rate: 0,
          },
        },
      };
    }
    if (seen.method === 'GET' && seen.path === '/emails/receiving') {
      const page = list(fake.received, seen.query, (email) => email.id);
      return {
        status: 200,
        body: {
          object: 'list',
          has_more: page.has_more,
          data: page.data.map((email) => ({
            id: email.id,
            from: email.from,
            to: email.to,
            cc: email.cc ?? [],
            reply_to: email.reply_to ?? [],
            subject: email.subject,
            created_at: email.created_at ?? '2026-09-25T10:00:00.000Z',
            message_id: email.message_id ?? '<m1@example.test>',
            attachments: (email.attachments ?? []).map((attachment) => ({
              id: attachment.id,
              filename: attachment.filename,
              content_type: attachment.content_type,
              size: attachment.bytes.byteLength,
            })),
          })),
        },
      };
    }
    if (seen.method === 'GET' && segments[0] === 'emails' && segments[1] === 'receiving') {
      const email = fake.received.find((candidate) => candidate.id === segments[2]);
      if (!email) return error(404, 'not_found', 'Email not found');
      if (segments.length === 5 && segments[3] === 'attachments') {
        const attachment = email.attachments?.find((candidate) => candidate.id === segments[4]);
        if (!attachment) return error(404, 'not_found', 'Attachment not found');
        return {
          status: 200,
          body: {
            object: 'attachment',
            id: attachment.id,
            filename: attachment.filename,
            size: attachment.bytes.byteLength,
            content_type: attachment.content_type,
            download_url: `${CDN}/${email.id}/attachments/${attachment.id}?signature=sig-test`,
            expires_at: '2026-10-17T14:29:41.521Z',
          },
        };
      }
      return {
        status: 200,
        body: {
          object: 'email',
          id: email.id,
          from: email.from,
          to: email.to,
          cc: email.cc ?? [],
          reply_to: email.reply_to ?? [],
          received_for: email.received_for ?? [],
          subject: email.subject,
          html: email.html ?? null,
          text: email.text ?? null,
          created_at: email.created_at ?? '2026-09-25T10:00:00.000Z',
          message_id: email.message_id ?? '<m1@example.test>',
          authentication:
            email.authentication === undefined ? { spf: 'pass', dkim: 'pass', dmarc: 'pass' } : email.authentication,
          raw: {
            download_url: 'https://example.resend.test/raw/secret-signed-link',
            expires_at: '2026-10-01T00:00:00Z',
          },
          attachments: (email.attachments ?? []).map((attachment) => ({
            id: attachment.id,
            filename: attachment.filename,
            content_type: attachment.content_type,
            content_disposition: attachment.inline ? 'inline' : null,
            size: attachment.bytes.byteLength,
          })),
        },
      };
    }
    if (seen.method === 'GET' && segments[0] === 'emails' && segments.length === 2) {
      const email = fake.sent.find((candidate) => candidate.id === segments[1]);
      if (!email) return error(404, 'not_found', 'Email not found');
      const { attachments: _a, headers: _h, ...rest } = email;
      return { status: 200, body: { object: 'email', ...rest } };
    }
    if (seen.method === 'POST' && segments[0] === 'emails' && segments[2] === 'cancel') {
      const email = fake.sent.find((candidate) => candidate.id === segments[1]);
      if (!email) return error(404, 'not_found', 'Email not found');
      if (email.last_event !== 'scheduled') return error(422, 'validation_error', 'Email is not scheduled');
      email.last_event = 'canceled';
      return { status: 200, body: { object: 'email', id: email.id } };
    }
    if (seen.method === 'GET' && seen.path === '/suppressions') {
      const origin = seen.query.get('origin');
      const all = origin ? fake.suppressions.filter((entry) => entry.origin === origin) : fake.suppressions;
      const page = list(all, seen.query, (entry) => entry.id);
      return { status: 200, body: { object: 'list', ...page } };
    }
    return error(404, 'not_found', 'The requested endpoint does not exist.');
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = await read(request);
      const url = new URL(request.url ?? '/', 'http://fake');
      const origin = url.pathname.startsWith('/cdn/') ? 'cdn' : 'api';
      const path = url.pathname.replace(/^\/(api|cdn)/, '') || '/';
      const headers: string[] = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      }
      const seen: SeenRequest = {
        origin,
        method: request.method ?? 'GET',
        path,
        query: url.searchParams,
        headers: request.headers,
        body,
        raw: `${request.method} ${request.url}\n${headers.join('\n')}\n\n${body}`,
      };
      requests.push(seen);
      const reply = fake.intercept?.(seen) ?? answer(seen);
      if (reply.drop) {
        request.socket.destroy();
        return;
      }
      const isBytes = reply.body instanceof Uint8Array;
      response.writeHead(reply.status, {
        'content-type': isBytes ? 'application/octet-stream' : 'application/json',
        ...(origin === 'api' ? RATE : {}),
        ...reply.headers,
      });
      response.end(
        isBytes ? Buffer.from(reply.body as Uint8Array) : reply.body === undefined ? '' : JSON.stringify(reply.body),
      );
    })();
  });
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as AddressInfo;
  const local = `http://127.0.0.1:${port}`;

  return Object.assign(fake, {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Only ever a URL the guard has approved. Anything else here means the guard let it through.
      if (url.startsWith(`${API}/`)) return fetch(url.replace(API, `${local}/api`), init);
      if (url.startsWith(`${CDN}/`)) return fetch(url.replace(CDN, `${local}/cdn`), init);
      throw new Error(`the guard let ${url} through`);
    },
    close: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  });
}
