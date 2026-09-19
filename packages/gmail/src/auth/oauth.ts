import { createHash, randomBytes } from 'node:crypto';
import { CommsError } from '@agentcomms/core';
import type { GoogleEndpoints } from './endpoints.ts';
import { parseGrantedScopes } from './scopes.ts';

/** A Desktop ("installed") OAuth client, as downloaded from the Google Cloud console. */
export interface InstalledClient {
  clientId: string;
  clientSecret: string;
  projectId?: string | undefined;
}

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** PKCE with S256 (Google defaults to `plain` if the method is omitted, so it never is). */
export function newPkce(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function newState(): string {
  return randomBytes(24).toString('base64url');
}

export interface AuthUrlOptions {
  client: InstalledClient;
  endpoints: GoogleEndpoints;
  redirectUri: string;
  scopes: readonly string[];
  state: string;
  codeChallenge: string;
  loginHint?: string | undefined;
  /**
   * Opt-in `hd`. Not derived from the address: `hd` accepts only Workspace accounts, so deriving it from a custom
   * domain would lock out a personal Google account that simply uses that address. `login_hint` already pre-selects.
   */
  hostedDomain?: string | undefined;
}

/** The consent URL. `select_account` forces the account chooser, so the wrong signed-in account is not picked silently. */
export function buildAuthUrl(options: AuthUrlOptions): string {
  const url = new URL(options.endpoints.authUrl);
  const params: Record<string, string> = {
    client_id: options.client.clientId,
    redirect_uri: options.redirectUri,
    response_type: 'code',
    scope: options.scopes.join(' '),
    state: options.state,
    code_challenge: options.codeChallenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent select_account',
  };
  if (options.loginHint) params.login_hint = options.loginHint;
  if (options.hostedDomain) params.hd = options.hostedDomain;
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return url.toString();
}

export interface TokenResponse {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  grantedScopes: string[];
  /** Claims of the ID token (received directly from Google's token endpoint over TLS, so not signature-checked). */
  idClaims: { sub?: string; email?: string; email_verified?: boolean; hd?: string };
  refreshTokenExpiresAt?: number | undefined;
}

function decodeIdToken(idToken: string | undefined): TokenResponse['idClaims'] {
  if (!idToken) return {};
  const payload = idToken.split('.')[1];
  if (!payload) return {};
  try {
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as TokenResponse['idClaims'];
  } catch {
    return {};
  }
}

/** Maps an OAuth error to a CommsError with the fix the setup guide gives for it. */
export function oauthError(error: string, description?: string): CommsError {
  const detail = description ? ` (${description})` : '';
  switch (error) {
    case 'access_denied':
      return new CommsError('AUTH_REQUIRED', `access was not granted${detail}`, {
        hint: 'If the screen said "Access blocked", publish the app (Google Auth Platform → Audience → Publish app) and try again.',
      });
    case 'admin_policy_enforced':
      return new CommsError('AUTH_REQUIRED', `a Google Workspace administrator blocks this app${detail}`, {
        hint: 'An admin can trust the client ID under Security → API controls → Manage third-party app access.',
      });
    case 'org_internal':
      return new CommsError('AUTH_REQUIRED', `the OAuth client is limited to its own organisation${detail}`, {
        hint: 'Set the audience to External in Google Auth Platform → Audience.',
      });
    case 'redirect_uri_mismatch':
      return new CommsError('CONFIG', `the OAuth client is not a Desktop app${detail}`, {
        hint: 'Create a client of type "Desktop app" and add it with `agent-gmail client add`.',
      });
    case 'invalid_client':
    case 'deleted_client':
    case 'unauthorized_client':
      return new CommsError('CONFIG', `Google does not accept this OAuth client (${error})${detail}`, {
        hint: 'The client may have been deleted or its secret rotated: create a new Desktop client, add it, and re-authorise.',
      });
    case 'invalid_grant':
      return new CommsError('AUTH_REQUIRED', `Google refused the grant${detail}`, {
        hint: 'Sign in again. If this happens about 7 days after the last sign-in, the app is still in Testing: publish it.',
      });
    default:
      return new CommsError('AUTH_REQUIRED', `authorisation failed: ${error}${detail}`);
  }
}

async function postForm(url: string, body: Record<string, string>): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body),
    });
  } catch (error) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'could not reach Google', { cause: error });
  }
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw oauthError(String(json.error ?? `http_${response.status}`), json.error_description as string | undefined);
  }
  return json;
}

/** Exchanges an authorisation code (with its PKCE verifier) for tokens. */
export async function exchangeCode(options: {
  client: InstalledClient;
  endpoints: GoogleEndpoints;
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const json = await postForm(options.endpoints.tokenUrl, {
    grant_type: 'authorization_code',
    code: options.code,
    code_verifier: options.codeVerifier,
    redirect_uri: options.redirectUri,
    client_id: options.client.clientId,
    // Desktop clients are documented as unable to keep a secret, but Google still expects it; always send it.
    client_secret: options.client.clientSecret,
  });
  const refreshToken = json.refresh_token;
  if (typeof refreshToken !== 'string' || !refreshToken) {
    throw new CommsError('AUTH_REQUIRED', 'Google returned no refresh token', {
      hint: 'Remove the app at https://myaccount.google.com/connections and sign in again.',
    });
  }
  const now = Date.now();
  return {
    accessToken: String(json.access_token ?? ''),
    refreshToken,
    expiresAt: now + Number(json.expires_in ?? 3600) * 1000,
    grantedScopes: parseGrantedScopes(json.scope as string | undefined),
    idClaims: decodeIdToken(json.id_token as string | undefined),
    refreshTokenExpiresAt:
      json.refresh_token_expires_in === undefined ? undefined : now + Number(json.refresh_token_expires_in) * 1000,
  };
}

/** Revokes a token (and, for an access token, its refresh token). Best effort: Google may take a while to apply it. */
export async function revokeToken(endpoints: GoogleEndpoints, token: string): Promise<void> {
  await postForm(endpoints.revokeUrl, { token });
}

export type ClientProbe =
  | { ok: true }
  /** The credentials are definitely wrong: refuse to store them. */
  | { ok: false; fatal: true; error: CommsError }
  /** The check could not be made (no network); storing is still fine. */
  | { ok: false; fatal: false; reason: string };

/**
 * Checks credentials with Google before they are stored, by redeeming a code that cannot work. A live client answers
 * `invalid_grant` ("the code is bad"); a deleted client or a wrong secret answers `invalid_client`. Worth the one
 * request: the alternative is a confusing failure much later, after the user has deleted the downloaded JSON.
 */
export async function probeClientCredentials(
  endpoints: GoogleEndpoints,
  client: InstalledClient,
): Promise<ClientProbe> {
  try {
    await postForm(endpoints.tokenUrl, {
      grant_type: 'authorization_code',
      code: 'agent-communications-probe',
      redirect_uri: 'http://127.0.0.1:1/',
      client_id: client.clientId,
      client_secret: client.clientSecret,
    });
    // A probe code cannot be redeemed; if it somehow was, nothing is wrong with the client either.
    return { ok: true };
  } catch (error) {
    if (!(error instanceof CommsError)) return { ok: false, fatal: false, reason: 'the check could not be made' };
    if (error.code === 'PROVIDER_UNAVAILABLE') {
      return { ok: false, fatal: false, reason: 'Google could not be reached, so the client was not checked' };
    }
    // `invalid_grant` is the expected answer from a working client: the code was never real.
    if (error.code === 'AUTH_REQUIRED') return { ok: true };
    return { ok: false, fatal: true, error };
  }
}

/** Reads and validates a client JSON file's content: only Desktop (`installed`) clients are accepted. */
export function parseClientJson(text: string): InstalledClient {
  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new CommsError('BAD_DATA', 'the client file is not valid JSON');
  }
  if (json.web && !json.installed) {
    throw new CommsError('BAD_DATA', 'this is a "Web application" client; a "Desktop app" client is needed', {
      hint: 'In Google Auth Platform → Clients, create a client of type "Desktop app" and download its JSON.',
    });
  }
  const installed = json.installed as Record<string, unknown> | undefined;
  const clientId = installed?.client_id;
  const clientSecret = installed?.client_secret;
  if (typeof clientId !== 'string' || !clientId.endsWith('.apps.googleusercontent.com')) {
    throw new CommsError('BAD_DATA', 'the client file has no Desktop client id');
  }
  if (typeof clientSecret !== 'string' || !clientSecret) {
    throw new CommsError('BAD_DATA', 'the client file has no client secret', {
      hint: 'Google shows the secret only when a client is created: download the JSON from the creation dialog, or add a new secret to the client.',
    });
  }
  return {
    clientId,
    clientSecret,
    projectId: typeof installed?.project_id === 'string' ? installed.project_id : undefined,
  };
}
