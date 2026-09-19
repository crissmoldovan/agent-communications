import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The redirect target for the consent flow: `127.0.0.1` on a random port, never `localhost` (which can resolve to a
 * name another process owns, and which Google's native-app guidance advises against).
 */
export interface LoopbackListener {
  port: number;
  redirectUri: string;
  /** Resolves with the first callback that carries the expected `state`. */
  result: Promise<LoopbackResult>;
  close(): Promise<void>;
}

export type LoopbackResult = { code: string } | { error: string; description?: string | undefined } | { timeout: true };

const PAGE_OK = `<!doctype html><meta charset="utf-8"><title>Signed in</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:30rem">
<h1>Signed in</h1><p>You can close this tab and go back to your terminal.</p>`;

const PAGE_ERROR = `<!doctype html><meta charset="utf-8"><title>Not signed in</title>
<body style="font-family:system-ui;margin:3rem auto;max-width:30rem">
<h1>Not signed in</h1><p>Go back to your terminal: it will say what happened.</p>`;

export interface LoopbackOptions {
  /** The `state` that must come back; anything else is ignored rather than ending the flow. */
  state: string;
  /** A fixed port, when a flow was started with one. Defaults to a free port chosen by the OS. */
  port?: number | undefined;
  timeoutMs?: number | undefined;
}

/**
 * Serves exactly one OAuth redirect. A request without the expected `state` — a stray browser tab, a probe from
 * another process on this machine — is answered and ignored, so it cannot cancel the sign-in the user is doing.
 */
export async function startLoopback(options: LoopbackOptions): Promise<LoopbackListener> {
  let settle: (result: LoopbackResult) => void = () => undefined;
  const result = new Promise<LoopbackResult>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    if (state !== options.state || (!code && !error)) {
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE_ERROR);
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(code ? PAGE_OK : PAGE_ERROR);
    settle(
      code
        ? { code }
        : { error: error ?? 'unknown_error', description: url.searchParams.get('error_description') ?? undefined },
    );
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  const timeoutMs = options.timeoutMs ?? 10 * 60_000;
  const timer = setTimeout(() => settle({ timeout: true }), timeoutMs);
  timer.unref?.();
  void result.finally(() => clearTimeout(timer));

  return {
    port,
    redirectUri: `http://127.0.0.1:${port}/`,
    result,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
