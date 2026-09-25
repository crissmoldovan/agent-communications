import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Slack's Web API on a loopback port, for the calls that change an app.
 *
 * A real HTTP server rather than a function standing in for `fetch`, because what these tests have to show is about
 * the request as it leaves: which token rode on it, in which header, and that nothing else did. The guard is not
 * relaxed to reach it — `fetch` below is the *inner* fetch, which only ever sees a URL the guard has already
 * approved as `https://slack.com/api/…`, and rewrites the origin to this server after that approval.
 */

export interface SlackRequest {
  /** The Slack method, from the last path segment: `apps.manifest.validate`. */
  readonly method: string;
  readonly authorization: string | undefined;
  readonly contentType: string | undefined;
  readonly params: URLSearchParams;
  /** The path and query exactly as received. */
  readonly url: string;
  /** Everything that arrived — request line, every header, the body — for "it appeared nowhere else" assertions. */
  readonly raw: string;
}

export type Reply = (request: SlackRequest) => unknown;

export interface FakeSlack {
  readonly requests: SlackRequest[];
  /** Replies by method. A method with no reply answers `unknown_method`, as Slack does. */
  script: Record<string, Reply>;
  /** The inner fetch to hand the CLI. */
  readonly fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
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

export async function startFakeSlack(script: Record<string, Reply> = {}): Promise<FakeSlack> {
  const requests: SlackRequest[] = [];
  const fake: FakeSlack = {
    requests,
    script,
    fetch: async () => {
      throw new Error('not started');
    },
    close: async () => undefined,
  };

  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const body = await read(request);
      const url = request.url ?? '';
      const method = url.split('?')[0]?.split('/api/')[1] ?? '';
      const headers: string[] = [];
      for (let i = 0; i < request.rawHeaders.length; i += 2) {
        headers.push(`${request.rawHeaders[i]}: ${request.rawHeaders[i + 1]}`);
      }
      const recorded: SlackRequest = {
        method,
        authorization: request.headers.authorization,
        contentType: request.headers['content-type'],
        params: new URLSearchParams(body),
        url,
        raw: `${request.method} ${url}\n${headers.join('\n')}\n\n${body}`,
      };
      requests.push(recorded);
      const reply = fake.script[method];
      const answer = reply ? reply(recorded) : { ok: false, error: 'unknown_method' };
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(answer));
    })();
  });
  await new Promise<void>((settle) => server.listen(0, '127.0.0.1', () => settle()));
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;

  return Object.assign(fake, {
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // Only ever a URL the guard has approved. Anything else here means the guard let it through, which is a failure.
      if (!url.startsWith('https://slack.com/api/')) throw new Error(`the guard let ${url} through`);
      return fetch(url.replace('https://slack.com', origin), init);
    },
    close: () =>
      new Promise<void>((settle) => {
        server.closeAllConnections();
        server.close(() => settle());
      }),
  });
}
