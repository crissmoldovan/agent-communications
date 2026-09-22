import { timingSafeEqual } from 'node:crypto';
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

/**
 * What the page can say about the sign-in it is the end of.
 *
 * All of it is known before the browser is opened, which is the point: this page is served the moment Google
 * redirects, *before* the authorization code has been exchanged for anything. So the account that was actually
 * granted is not known here and cannot be shown. What can be shown is what was asked for.
 */
export interface LoopbackAbout {
  /** The name the mailbox is being connected under. */
  alias: string;
  mode: 'add' | 'reauth';
  /** read, draft or organize — how much access the consent screen asked for. */
  tier?: string | undefined;
  /** The address the flow requires it to turn out to be, when one was named. */
  expectEmail?: string | undefined;
}

/** Values here come from a CLI argument or an MCP call, so they are escaped rather than trusted. */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char] ?? char,
  );
}

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
dl{display:grid;grid-template-columns:auto 1fr;gap:.4rem 1.25rem;margin:0 0 1.75rem;
padding:1rem 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line);font-size:.95rem}
dt{color:var(--dim)}
dd{margin:0;font-variant-numeric:tabular-nums;word-break:break-all}
.note{font-size:.9rem;color:var(--dim);margin:0}
</style>`;

const BRAND = '<p class="brand">agent-gmail</p>';

function pageOk(about: LoopbackAbout | undefined): string {
  const rows: string[] = [];
  if (about) {
    const what = about.mode === 'reauth' ? 'Re-authorising' : 'Connecting';
    rows.push(`<dt>${what}</dt><dd>${escapeHtml(about.alias)}</dd>`);
    // "Asked for", never "Signed in as": the consent screen lets a person choose any account, and which one they
    // chose is not known until the code is exchanged. Naming it here as though it were settled would be a guess
    // printed as a fact — and the mismatch it would hide is the one thing `--email` exists to catch.
    if (about.expectEmail) rows.push(`<dt>Asked for</dt><dd>${escapeHtml(about.expectEmail)}</dd>`);
    if (about.tier) rows.push(`<dt>Access</dt><dd>${escapeHtml(about.tier)}</dd>`);
  }
  const detail = rows.length > 0 ? `<dl>${rows.join('')}</dl>` : '';
  const check = about?.expectEmail
    ? `The address is checked against <strong>${escapeHtml(about.expectEmail)}</strong> before anything is stored, and a different account is refused.`
    : 'The account is checked before anything is stored.';
  return `<!doctype html><meta charset="utf-8"><title>Signed in — agent-gmail</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${STYLE}
<body><main>${BRAND}
<h1><span class="tick">&check;</span> Google returned the grant</h1>
<p class="lede">Nothing is stored yet.</p>
${detail}
<p class="note">${check} Close this tab — the terminal or the agent that started this will finish it and name the account.</p>
</main>`;
}

function pageError(about: LoopbackAbout | undefined): string {
  const who = about ? ` for <strong>${escapeHtml(about.alias)}</strong>` : '';
  return `<!doctype html><meta charset="utf-8"><title>Not signed in — agent-gmail</title>
<meta name="viewport" content="width=device-width,initial-scale=1">${STYLE}
<body><main>${BRAND}
<h1>Not signed in</h1>
<p class="lede">The sign-in${who} did not complete.</p>
<p class="note">Nothing was changed. Go back to your terminal or your agent: it will say what happened and how to start again.</p>
</main>`;
}

export interface LoopbackOptions {
  /** The `state` that must come back; anything else is ignored rather than ending the flow. */
  state: string;
  /** A fixed port, when a flow was started with one. Defaults to a free port chosen by the OS. */
  port?: number | undefined;
  timeoutMs?: number | undefined;
  /** What to tell the person on the page. Absent keeps the plain wording, for a caller that knows nothing. */
  about?: LoopbackAbout | undefined;
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

  /** Constant-time comparison of two values that may be absent. */
  const sameSecret = (given: string | null, expected: string): boolean => {
    if (given === null) return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const server: Server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/favicon.ico') {
      response.writeHead(404).end();
      return;
    }
    // Google's redirect is a GET. Anything else is not the browser coming back, whatever it carries.
    if (request.method !== 'GET') {
      response.writeHead(405).end();
      return;
    }
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');
    const error = url.searchParams.get('error');
    // Compared in constant time, like every other secret comparison here. The state is 192 bits and the attacker
    // would be on this machine already, so this is tidiness rather than a fix — but a plain `!==` on a secret is
    // the kind of thing that is right until the secret gets shorter.
    if (!sameSecret(state, options.state) || (!code && !error)) {
      /*
       * Nothing about the flow here, deliberately.
       *
       * A request that does not carry the state is not the browser coming back from Google — it is a stray tab,
       * or another process on this machine finding an open port. It has not demonstrated that it knows anything,
       * so it is not told which mailbox is being connected or which address was asked for.
       */
      response.writeHead(400, { 'content-type': 'text/html; charset=utf-8' }).end(pageError(undefined));
      return;
    }
    response
      .writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      .end(code ? pageOk(options.about) : pageError(options.about));
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
