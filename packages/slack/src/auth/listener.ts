import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readCallback } from './authorize.ts';
import { sameState } from './pkce.ts';

/**
 * The one redirect, received locally.
 *
 * Slack sends the browser back to `http://localhost:<port>/slack/callback`, which is allowed because the app
 * opted into PKCE — see `authorize.ts` for why that spelling and not `127.0.0.1`.
 *
 * The page this serves is the last thing a person sees, and the Gmail side learned what it must not say: it
 * cannot claim the workspace is connected, because at this moment the code has not been exchanged and nothing
 * is stored. It says what it actually knows.
 */

export interface Loopback {
  readonly port: number;
  readonly redirectUrl: string;
  /** Resolves with the code once a redirect carrying the expected `state` arrives. */
  readonly result: Promise<LoopbackResult>;
  close(): Promise<void>;
}

export type LoopbackResult =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'denied'; readonly error: string; readonly description?: string | undefined }
  | { readonly kind: 'timeout' };

const STYLE = `<style>
:root{color-scheme:light dark;--fg:#111;--dim:#666;--line:#e3e3e3;--bg:#fff;--accent:#1a7f5a}
@media (prefers-color-scheme:dark){:root{--fg:#ededed;--dim:#9a9a9a;--line:#2a2a2a;--bg:#141414;--accent:#4ade80}}
body{font-family:ui-sans-serif,system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--fg);
margin:0;min-height:100vh;display:grid;place-items:center;padding:2rem;line-height:1.5}
main{max-width:30rem;width:100%}
.brand{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--dim);margin:0 0 1.5rem}
h1{font-size:1.5rem;margin:0 0 .25rem;letter-spacing:-.01em}
h1 .tick{color:var(--accent)}
.lede{color:var(--dim);margin:0 0 1.75rem}
dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.25rem;margin:0 0 1.75rem;padding:1rem 0;
border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:.95rem}
dt{color:var(--dim)}
dd{margin:0;word-break:break-all}
.note{font-size:.9rem;color:var(--dim);margin:0}
</style>`;

/** Caller-supplied values are escaped: a workspace alias comes from a flag and this renders it into HTML. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

export interface PageAbout {
  readonly alias: string;
  readonly mode: string;
  readonly reauth: boolean;
}

/**
 * The page after a successful redirect.
 *
 * It does **not** say the workspace is connected. At this moment Slack has returned a code and nothing has been
 * exchanged, so which account was granted is not yet known — and on a reauth it is exactly the thing being
 * checked. Saying it here would be a guess printed as a fact, which is the mistake the Gmail page made.
 */
function pageOk(about: PageAbout | undefined): string {
  const rows = about
    ? `<dl><dt>${about.reauth ? 'Re-authorising' : 'Connecting'}</dt><dd>${escapeHtml(about.alias)}</dd>` +
      `<dt>Access</dt><dd>${escapeHtml(about.mode)}</dd></dl>`
    : '';
  return `<!doctype html><meta charset="utf-8"><title>Signed in — agent-slack</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${STYLE}
<body><main><p class="brand">agent-slack</p>
<h1><span class="tick">&check;</span> Slack returned the grant</h1>
<p class="lede">Nothing is stored yet.</p>${rows}
<p class="note">The workspace and the account are checked against what was asked for before anything is saved, and
a different one is refused. Close this tab — the terminal or the agent that started this will finish it and name
the workspace.</p></main>`;
}

function pageError(): string {
  return `<!doctype html><meta charset="utf-8"><title>Not signed in — agent-slack</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${STYLE}
<body><main><p class="brand">agent-slack</p>
<h1>Not signed in</h1>
<p class="lede">The sign-in did not complete.</p>
<p class="note">Nothing was changed. Go back to your terminal or your agent: it will say what happened and how to
start again.</p></main>`;
}

export interface LoopbackOptions {
  readonly state: string;
  /** A fixed port, when a flow already chose one. Otherwise the OS picks. */
  readonly port?: number | undefined;
  readonly timeoutMs?: number | undefined;
  /** What the page may say. Absent keeps the plain wording. */
  readonly about?: PageAbout | undefined;
}

export async function startLoopback(options: LoopbackOptions): Promise<Loopback> {
  let settle: (result: LoopbackResult) => void = () => undefined;
  const result = new Promise<LoopbackResult>((resolve) => {
    settle = resolve;
  });

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://localhost');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'GET') {
      // Slack's redirect is a GET. Anything else is not the browser coming back, whatever it carries.
      response.writeHead(405).end();
      return;
    }

    const outcome = readCallback(url, options.state, sameState);
    if (outcome.kind === 'ignored') {
      /*
       * A stray tab, or another process finding an open port. It is answered and ignored rather than allowed to
       * end the sign-in somebody is halfway through — and it is told nothing about the flow, because it has not
       * demonstrated that it knows anything.
       */
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(pageError());
      return;
    }

    const body = outcome.kind === 'code' ? pageOk(options.about) : pageError();
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }).end(body);
    settle(outcome);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // `localhost` rather than `127.0.0.1`, matching the redirect Slack was given — see `authorize.ts`.
    server.listen(options.port ?? 0, 'localhost', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;

  const timer = setTimeout(() => settle({ kind: 'timeout' }), options.timeoutMs ?? 10 * 60_000);
  timer.unref?.();
  void result.finally(() => clearTimeout(timer));

  return {
    port,
    redirectUrl: `http://localhost:${port}/slack/callback`,
    result,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
