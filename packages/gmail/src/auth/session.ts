import { type ClientConfig, CommsError, type Core, type InboxConfig, type SecretStore } from '@cloudpixel/comms-core';
import type { GoogleEndpoints } from './endpoints.ts';
import { oauthError } from './oauth.ts';
import { parseGrantedScopes } from './scopes.ts';

export function clientSecretRef(name: string): string {
  return `client:${name}:secret`;
}

export function refreshTokenRef(inboxId: string): string {
  return `gmail:refresh:${inboxId}`;
}

export interface AccessToken {
  token: string;
  expiresAt: number;
  scopes: string[];
}

/** A token endpoint failure carries `error` in its JSON body; the HTTP status alone does not say what to do. */
interface TokenErrorBody {
  error?: string;
  error_description?: string;
}

export interface TokenSourceOptions {
  core: Core;
  endpoints: GoogleEndpoints;
  inbox: InboxConfig;
  client: ClientConfig;
  alias: string;
  now?: () => number;
  fetchImpl?: typeof fetch;
}

/**
 * Turns the stored refresh token into short-lived access tokens, and keeps the one failure that matters legible:
 * `invalid_grant` means the grant is gone (revoked, expired after 7 days of an unpublished app, or 6 months unused),
 * which no retry fixes — but it also happens when another process has just replaced the token, so the stored value is
 * re-read once before giving up.
 */
export class TokenSource {
  readonly alias: string;
  readonly inbox: InboxConfig;
  readonly #core: Core;
  readonly #client: ClientConfig;
  readonly #endpoints: GoogleEndpoints;
  readonly #now: () => number;
  readonly #fetch: typeof fetch;
  #cached: AccessToken | null = null;
  #inFlight: Promise<AccessToken> | null = null;

  constructor(options: TokenSourceOptions) {
    this.alias = options.alias;
    this.inbox = options.inbox;
    this.#core = options.core;
    this.#client = options.client;
    this.#endpoints = options.endpoints;
    this.#now = options.now ?? (() => Date.now());
    this.#fetch = options.fetchImpl ?? fetch;
  }

  /** A valid access token, refreshed when the cached one is within a minute of expiry. */
  async accessToken(): Promise<AccessToken> {
    if (this.#cached && this.#cached.expiresAt - this.#now() > 60_000) return this.#cached;
    // One refresh at a time per inbox: several tool calls starting together must not each spend a token request.
    this.#inFlight ??= this.#refresh().finally(() => {
      this.#inFlight = null;
    });
    return this.#inFlight;
  }

  /** Drops the cached access token, so the next call refreshes. */
  invalidate(): void {
    this.#cached = null;
  }

  async #secrets(): Promise<SecretStore> {
    return this.#core.secrets();
  }

  async #storedSecret(ref: string, what: string): Promise<string> {
    const store = await this.#secrets();
    const value = await store.get(ref);
    if (value) return value;
    throw new CommsError('AUTH_REQUIRED', `the ${what} for ${this.alias} is not in the secret store`, {
      hint:
        what === 'client secret'
          ? 'Add the client again: `agent-gmail client add <client_secret.json>`.'
          : `Sign in again: \`agent-gmail inbox reauth ${this.alias}\`.`,
    });
  }

  async #refresh(): Promise<AccessToken> {
    const clientSecret = await this.#storedSecret(clientSecretRef(this.inbox.client), 'client secret');
    const tokenRef = refreshTokenRef(this.inbox.id);
    let refreshToken = await this.#storedSecret(tokenRef, 'refresh token');
    try {
      return await this.#exchange(refreshToken, clientSecret);
    } catch (error) {
      if (!(error instanceof CommsError) || error.code !== 'AUTH_REQUIRED') throw error;
      // Another process may have re-authorised this inbox since the value was cached.
      const store = await this.#secrets();
      store.invalidate(tokenRef);
      const current = await store.get(tokenRef);
      if (!current || current === refreshToken) {
        await this.#core.states.update(this.inbox.id, {
          lastError: { code: error.code, message: error.message, at: new Date(this.#now()).toISOString() },
        });
        throw error;
      }
      refreshToken = current;
      return this.#exchange(refreshToken, clientSecret);
    }
  }

  async #exchange(refreshToken: string, clientSecret: string): Promise<AccessToken> {
    let response: Response;
    try {
      response = await this.#fetch(this.#endpoints.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: refreshToken,
          client_id: this.#client.clientId,
          client_secret: clientSecret,
        }),
      });
    } catch (error) {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'could not reach Google to refresh the access token', {
        cause: error,
      });
    }
    const body = (await response.json().catch(() => ({}))) as TokenErrorBody & {
      access_token?: string;
      expires_in?: number;
      scope?: string;
    };
    if (!response.ok || !body.access_token) {
      const error = oauthError(body.error ?? `http_${response.status}`, body.error_description);
      throw body.error === 'invalid_grant' ? this.#explainInvalidGrant(error) : error;
    }
    const scopes = parseGrantedScopes(body.scope);
    const token: AccessToken = {
      token: body.access_token,
      expiresAt: this.#now() + (body.expires_in ?? 3600) * 1000,
      // A refresh response often omits `scope`; the grant's scopes are then what was recorded at consent.
      scopes: scopes.length > 0 ? scopes : [...this.inbox.grantedScopes],
    };
    this.#cached = token;
    await this.#core.states.update(this.inbox.id, { lastRefreshOkAt: new Date(this.#now()).toISOString() });
    return token;
  }

  #explainInvalidGrant(error: CommsError): CommsError {
    const created = Date.parse(this.inbox.createdAt);
    const days = Number.isFinite(created) ? (this.#now() - created) / 86_400_000 : Number.NaN;
    const hint =
      days >= 6 && days <= 9
        ? `This is about a week after consent, which is how long a Testing app's tokens last: publish the app (Google Auth Platform → Audience → Publish app), then \`agent-gmail inbox reauth ${this.alias}\`.`
        : `The grant is gone — revoked, or unused for six months. Sign in again: \`agent-gmail inbox reauth ${this.alias}\`.`;
    return new CommsError('AUTH_REQUIRED', `Google will not refresh the token for ${this.alias}`, {
      hint,
      cause: error,
    });
  }
}
