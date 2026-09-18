import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A local stand-in for Google: the OAuth consent and token endpoints, revocation, and the Gmail and People calls this
 * package makes. Tests point `AGENT_COMMS_GOOGLE_ROOT_URL` at it, so the real bundled `@googleapis/*` and
 * `google-auth-library` code paths run — token refresh included — with no test-only branch in the shipped code.
 *
 * It is deliberately strict where Google is strict: PKCE is verified, an authorisation code is single-use, a wrong
 * client secret is rejected, and refresh tokens can be made to fail with `invalid_grant`.
 */

export interface FakeAccount {
  sub: string;
  email: string;
  /** Scopes this account grants back. Defaults to whatever was asked for — set it to model a user unticking a box. */
  grantScopes?: string[];
  profile?: { messagesTotal?: number; threadsTotal?: number; historyId?: string };
  labels?: Array<{
    id: string;
    name: string;
    type?: 'system' | 'user';
    messagesTotal?: number;
    messagesUnread?: number;
  }>;
  sendAs?: Array<{
    sendAsEmail: string;
    displayName?: string;
    isDefault?: boolean;
    isPrimary?: boolean;
    treatAsAlias?: boolean;
    signature?: string;
    verificationStatus?: string;
  }>;
  /** Messages this account holds, keyed by id, in the shape `users.messages.get(format=full)` returns. */
  messages?: Record<string, FakeMessage>;
}

export interface FakeMessage {
  id?: string;
  threadId?: string;
  labelIds?: string[];
  snippet?: string;
  internalDate?: string;
  payload?: unknown;
}

export interface FakeGoogleOptions {
  clientId?: string;
  clientSecret?: string;
  accounts?: FakeAccount[];
  /** Which account a consent request signs in as; defaults to the first (or the one matching `login_hint`). */
  now?: () => number;
}

interface PendingCode {
  code: string;
  sub: string;
  scopes: string[];
  codeChallenge: string | null;
  redirectUri: string;
  used: boolean;
}

interface GrantedToken {
  refreshToken: string;
  sub: string;
  scopes: string[];
  revoked: boolean;
}

export interface FakeGoogle {
  readonly url: string;
  readonly server: Server;
  /** Every request the server saw: method, path and parsed body or query. */
  readonly requests: Array<{ method: string; path: string; params: Record<string, string> }>;
  accounts: Map<string, FakeAccount>;
  tokens: Map<string, GrantedToken>;
  /** Makes the next N calls to a path fail with this status (and optional Google error `reason`). */
  failNext(path: string, times: number, status: number, reason?: string, retryAfter?: string): void;
  /** Turns a stored refresh token into one Google refuses, as revocation or a Testing-app expiry would. */
  revoke(refreshToken: string): void;
  /** Completes a consent the way a browser would, returning the redirect URL with `code` and `state`. */
  consent(authUrl: string, options?: { sub?: string | undefined; deny?: string | undefined }): string;
  close(): Promise<void>;
}

/**
 * The little of Gmail's query language the fake understands: `from:`, `subject:`, `has:attachment`, `is:unread`,
 * `after:`/`before:` as epoch seconds, and bare words against the snippet. Enough to prove the compiled query is
 * what reaches the API, which is what the tests are about.
 */
function matchesQuery(
  message: { internalDate?: string; snippet?: string; labelIds?: string[]; payload?: unknown },
  query: string,
): boolean {
  if (!query.trim()) return true;
  const headers =
    ((message.payload as { headers?: Array<{ name?: string; value?: string }> } | undefined)?.headers ?? []).map(
      (header) => `${(header.name ?? '').toLowerCase()}:${header.value ?? ''}`,
    ) ?? [];
  const headerValue = (name: string): string =>
    headers.find((header) => header.startsWith(`${name}:`))?.slice(name.length + 1) ?? '';

  for (const token of query.split(/\s+/).filter(Boolean)) {
    const colon = token.indexOf(':');
    const operator = colon > 0 ? token.slice(0, colon).toLowerCase() : '';
    const value = colon > 0 ? token.slice(colon + 1).replace(/^"|"$/g, '') : token;
    switch (operator) {
      case 'from':
        if (!headerValue('from').toLowerCase().includes(value.toLowerCase())) return false;
        break;
      case 'subject':
        if (!headerValue('subject').toLowerCase().includes(value.toLowerCase())) return false;
        break;
      case 'after':
        if (Number(message.internalDate ?? 0) < Number(value) * 1000) return false;
        break;
      case 'before':
        if (Number(message.internalDate ?? 0) >= Number(value) * 1000) return false;
        break;
      case 'is':
        if (value === 'unread' && !(message.labelIds ?? []).includes('UNREAD')) return false;
        break;
      case 'has':
        if (value === 'attachment' && !JSON.stringify(message.payload ?? {}).includes('attachmentId')) return false;
        break;
      default:
        if (!`${message.snippet ?? ''} ${headerValue('subject')}`.toLowerCase().includes(value.toLowerCase())) {
          return false;
        }
    }
  }
  return true;
}

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    request.on('data', (chunk) => {
      data += chunk;
    });
    request.on('end', () => resolve(data));
    request.on('error', reject);
  });
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  response.end(text);
}

function base64url(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/** An unsigned JWT: this package reads the claims of an ID token it received itself over TLS, and checks no signature. */
function idToken(claims: Record<string, unknown>): string {
  return `${base64url({ alg: 'none', typ: 'JWT' })}.${base64url(claims)}.`;
}

export async function startFakeGoogle(options: FakeGoogleOptions = {}): Promise<FakeGoogle> {
  const clientId = options.clientId ?? 'test-client.apps.googleusercontent.com';
  const clientSecret = options.clientSecret ?? 'test-client-secret-not-a-real-credential';
  const now = options.now ?? (() => Date.now());
  const accounts = new Map<string, FakeAccount>(
    (options.accounts ?? [{ sub: '10000000000000000001', email: 'jo@example.test' }]).map((a) => [a.sub, a]),
  );
  const codes = new Map<string, PendingCode>();
  const tokens = new Map<string, GrantedToken>();
  const access = new Map<string, { sub: string; scopes: string[]; expiresAt: number }>();
  const failures = new Map<
    string,
    Array<{ status: number; reason?: string | undefined; retryAfter?: string | undefined }>
  >();
  const requests: FakeGoogle['requests'] = [];

  const fail = (
    path: string,
  ): { status: number; reason?: string | undefined; retryAfter?: string | undefined } | undefined =>
    failures.get(path)?.shift();

  const accountOf = (request: IncomingMessage): { sub: string; scopes: string[] } | null => {
    const header = request.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    const granted = access.get(token);
    if (!granted || granted.expiresAt < now()) return null;
    return granted;
  };

  const server = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? '/', 'http://127.0.0.1');
      const body = request.method === 'POST' ? await readBody(request) : '';
      const params: Record<string, string> = {};
      for (const [key, value] of url.searchParams) params[key] = value;
      if (body && (request.headers['content-type'] ?? '').includes('x-www-form-urlencoded')) {
        for (const [key, value] of new URLSearchParams(body)) params[key] = value;
      }
      requests.push({ method: request.method ?? 'GET', path: url.pathname, params });

      const forced = fail(url.pathname);
      if (forced) {
        if (forced.retryAfter) response.setHeader('retry-after', forced.retryAfter);
        json(response, forced.status, {
          error: {
            code: forced.status,
            message:
              forced.reason === 'accessNotConfigured'
                ? 'Gmail API has not been used in project 111 before or it is disabled. Enable it by visiting https://console.developers.google.com/apis/api/gmail.googleapis.com/overview?project=111 then retry.'
                : `forced ${forced.status}`,
            errors: forced.reason ? [{ reason: forced.reason }] : [],
            status: forced.reason,
          },
        });
        return;
      }

      // ---- OAuth ----------------------------------------------------------------
      if (url.pathname === '/token') {
        if (params.client_id !== clientId || params.client_secret !== clientSecret) {
          json(response, 401, { error: 'invalid_client', error_description: 'client not recognised' });
          return;
        }
        if (params.grant_type === 'authorization_code') {
          const pending = codes.get(params.code ?? '');
          if (!pending || pending.used) {
            json(response, 400, { error: 'invalid_grant', error_description: 'code already used' });
            return;
          }
          if (pending.codeChallenge) {
            const verifier = params.code_verifier ?? '';
            const challenge = createHash('sha256').update(verifier).digest('base64url');
            if (challenge !== pending.codeChallenge) {
              json(response, 400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
              return;
            }
          }
          if (params.redirect_uri !== pending.redirectUri) {
            json(response, 400, { error: 'redirect_uri_mismatch' });
            return;
          }
          pending.used = true;
          const account = accounts.get(pending.sub);
          const refreshToken = `rt_${randomBytes(12).toString('hex')}`;
          tokens.set(refreshToken, { refreshToken, sub: pending.sub, scopes: pending.scopes, revoked: false });
          const accessToken = `at_${randomBytes(12).toString('hex')}`;
          access.set(accessToken, { sub: pending.sub, scopes: pending.scopes, expiresAt: now() + 3600_000 });
          json(response, 200, {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: pending.scopes.join(' '),
            id_token: idToken({ sub: pending.sub, email: account?.email, email_verified: true }),
          });
          return;
        }
        if (params.grant_type === 'refresh_token') {
          const grant = tokens.get(params.refresh_token ?? '');
          if (!grant || grant.revoked) {
            json(response, 400, { error: 'invalid_grant', error_description: 'token revoked or expired' });
            return;
          }
          const accessToken = `at_${randomBytes(12).toString('hex')}`;
          access.set(accessToken, { sub: grant.sub, scopes: grant.scopes, expiresAt: now() + 3600_000 });
          json(response, 200, {
            access_token: accessToken,
            expires_in: 3600,
            token_type: 'Bearer',
            scope: grant.scopes.join(' '),
          });
          return;
        }
        json(response, 400, { error: 'unsupported_grant_type' });
        return;
      }

      if (url.pathname === '/revoke') {
        const grant = tokens.get(params.token ?? '');
        if (grant) grant.revoked = true;
        json(response, 200, {});
        return;
      }

      // ---- Gmail ----------------------------------------------------------------
      const granted = accountOf(request);
      if (!granted) {
        json(response, 401, {
          error: { code: 401, message: 'Invalid Credentials', errors: [{ reason: 'authError' }] },
        });
        return;
      }
      const account = accounts.get(granted.sub);
      const requires = (scope: string): boolean => granted.scopes.includes(scope);
      const readScopes = [
        'https://www.googleapis.com/auth/gmail.readonly',
        'https://www.googleapis.com/auth/gmail.modify',
      ];
      if (url.pathname.startsWith('/gmail/v1/') && !readScopes.some(requires)) {
        json(response, 403, {
          error: {
            code: 403,
            message: 'Request had insufficient authentication scopes.',
            status: 'PERMISSION_DENIED',
            errors: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
          },
        });
        return;
      }
      if (url.pathname === '/gmail/v1/users/me/profile') {
        json(response, 200, {
          emailAddress: account?.email,
          messagesTotal: account?.profile?.messagesTotal ?? 42,
          threadsTotal: account?.profile?.threadsTotal ?? 17,
          historyId: account?.profile?.historyId ?? '9001',
        });
        return;
      }
      if (url.pathname === '/gmail/v1/users/me/labels') {
        json(response, 200, {
          labels: account?.labels ?? [
            { id: 'INBOX', name: 'INBOX', type: 'system', messagesTotal: 12, messagesUnread: 3 },
            { id: 'Label_1', name: 'Clients', type: 'user', messagesTotal: 4, messagesUnread: 0 },
          ],
        });
        return;
      }
      // Listing: ids only, newest first, paged. `q` is recorded so a test can assert what was actually sent.
      if (url.pathname === '/gmail/v1/users/me/messages' || url.pathname === '/gmail/v1/users/me/threads') {
        const wantsThreads = url.pathname.endsWith('/threads');
        const all = Object.entries(account?.messages ?? {})
          .map(([messageId, value]) => ({ id: messageId, ...value }))
          .sort((a, b) => Number(b.internalDate ?? 0) - Number(a.internalDate ?? 0));
        const matching = all.filter((value) => matchesQuery(value, params.q ?? ''));
        const rows = wantsThreads
          ? [...new Map(matching.map((value) => [value.threadId ?? value.id, value])).values()]
          : matching;
        const pageSize = Math.max(1, Number(params.maxResults ?? 25));
        const start = Number(params.pageToken ?? '0');
        const page = rows.slice(start, start + pageSize);
        const next = start + pageSize < rows.length ? String(start + pageSize) : undefined;
        json(response, 200, {
          [wantsThreads ? 'threads' : 'messages']: page.map((value) =>
            wantsThreads ? { id: value.threadId ?? value.id } : { id: value.id, threadId: value.threadId },
          ),
          ...(next ? { nextPageToken: next } : {}),
          resultSizeEstimate: rows.length,
        });
        return;
      }

      const thread = /^\/gmail\/v1\/users\/me\/threads\/([^/]+)$/.exec(url.pathname);
      if (thread) {
        const id = decodeURIComponent(thread[1] ?? '');
        const messages = Object.entries(account?.messages ?? {})
          .map(([messageId, value]) => ({ id: messageId, ...value }))
          .filter((value) => (value.threadId ?? '') === id);
        if (messages.length === 0) {
          json(response, 404, {
            error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] },
          });
          return;
        }
        json(response, 200, { id, messages });
        return;
      }

      const message = /^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/.exec(url.pathname);
      if (message) {
        const id = decodeURIComponent(message[1] ?? '');
        const found = account?.messages?.[id];
        if (!found) {
          json(response, 404, {
            error: { code: 404, message: 'Requested entity was not found.', errors: [{ reason: 'notFound' }] },
          });
          return;
        }
        json(response, 200, { id, ...found });
        return;
      }

      if (url.pathname === '/gmail/v1/users/me/settings/sendAs') {
        json(response, 200, {
          sendAs: account?.sendAs ?? [
            {
              sendAsEmail: account?.email,
              displayName: 'Jo Example',
              isDefault: true,
              isPrimary: true,
              treatAsAlias: false,
              verificationStatus: 'accepted',
            },
          ],
        });
        return;
      }

      // ---- People ---------------------------------------------------------------
      if (url.pathname === '/v1/people:searchContacts' || url.pathname === '/v1/otherContacts:search') {
        json(response, 200, { results: [] });
        return;
      }

      json(response, 404, { error: { code: 404, message: `no fake handler for ${url.pathname}` } });
    })().catch((error) => {
      json(response, 500, { error: { code: 500, message: String(error) } });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    server,
    requests,
    accounts,
    tokens,
    failNext(path, times, status, reason, retryAfter) {
      const list = failures.get(path) ?? [];
      for (let i = 0; i < times; i++) list.push({ status, reason, retryAfter });
      failures.set(path, list);
    },
    revoke(refreshToken) {
      const grant = tokens.get(refreshToken);
      if (grant) grant.revoked = true;
    },
    consent(authUrl, consentOptions = {}) {
      const parsed = new URL(authUrl);
      const redirectUri = parsed.searchParams.get('redirect_uri') ?? '';
      const state = parsed.searchParams.get('state') ?? '';
      const redirect = new URL(redirectUri);
      if (consentOptions.deny) {
        redirect.searchParams.set('error', consentOptions.deny);
        redirect.searchParams.set('state', state);
        return redirect.toString();
      }
      const hint = parsed.searchParams.get('login_hint');
      const chosen =
        consentOptions.sub ??
        [...accounts.values()].find((a) => hint && a.email.toLowerCase() === hint.toLowerCase())?.sub ??
        [...accounts.keys()][0];
      if (chosen === undefined) throw new Error('the fake Google server has no accounts');
      const asked = (parsed.searchParams.get('scope') ?? '').split(' ').filter(Boolean);
      const code = `ac_${randomBytes(12).toString('hex')}`;
      codes.set(code, {
        code,
        sub: chosen,
        scopes: accounts.get(chosen)?.grantScopes ?? asked,
        codeChallenge: parsed.searchParams.get('code_challenge'),
        redirectUri,
        used: false,
      });
      redirect.searchParams.set('code', code);
      redirect.searchParams.set('state', state);
      return redirect.toString();
    },
    async close() {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}
