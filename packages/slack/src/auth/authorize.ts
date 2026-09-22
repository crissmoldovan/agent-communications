import { CommsError } from '@agentcomms/core';
import { SLACK_ORIGIN } from '../api/methods.ts';
import type { InstallMode } from '../manifest.ts';
import { scopesForMode } from '../manifest.ts';
import { newPkcePair, newState, type PkcePair } from './pkce.ts';

/**
 * Building the authorisation request, and reading what comes back.
 *
 * Separate from the listener and the exchange on purpose: this part is pure, so the URL a person is sent to and
 * the validation of what returns can both be tested without a socket or a fake Slack.
 */

/**
 * `localhost`, not `127.0.0.1`.
 *
 * The Gmail side deliberately uses the literal address, because `localhost` resolves to whatever a name service
 * says and that is one more thing between the browser and this process. Slack makes the opposite choice for us:
 * its PKCE guide promises desktop handling for one spelling — "Redirects to `localhost` (e.g.
 * `http://localhost:8080/auth`) are treated as desktop redirects" — and says nothing about the literal address.
 *
 * So the two packages differ, and the reason is written down rather than left to look like an inconsistency.
 * Confirming that `127.0.0.1` is *not* accepted is on the list of things to check against a real workspace.
 */
export const REDIRECT_HOST = 'localhost';

export function redirectUrlFor(port: number): string {
  return `http://${REDIRECT_HOST}:${port}/slack/callback`;
}

export interface AuthorizeRequest {
  readonly url: string;
  readonly state: string;
  readonly pkce: PkcePair;
  readonly redirectUrl: string;
  readonly scopes: readonly string[];
}

/**
 * The URL the person opens.
 *
 * Only `user_scope` is set, never `scope`. Two independent reasons, either sufficient: a user token is the only
 * one that reaches the person's DMs and unjoined public channels (research §1.3), and Slack states "desktop
 * redirects are not allowed to request bot scopes" — and this is a desktop redirect.
 */
export function buildAuthorizeUrl(options: {
  clientId: string;
  mode: InstallMode;
  port: number;
  pkce?: PkcePair;
  state?: string;
}): AuthorizeRequest {
  const pkce = options.pkce ?? newPkcePair();
  const state = options.state ?? newState();
  const redirectUrl = redirectUrlFor(options.port);
  const scopes = scopesForMode(options.mode);

  const url = new URL('/oauth/v2/authorize', SLACK_ORIGIN);
  url.searchParams.set('client_id', options.clientId);
  url.searchParams.set('user_scope', scopes.join(','));
  url.searchParams.set('redirect_uri', redirectUrl);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', pkce.challenge);
  url.searchParams.set('code_challenge_method', pkce.method);

  return { url: url.href, state, pkce, redirectUrl, scopes };
}

/**
 * What Slack put on the redirect, or why it is not usable.
 *
 * Slack reports a refusal by redirecting with `error` rather than by not redirecting, so "the person said no" and
 * "something went wrong" arrive the same way and both have to be read off the query.
 */
export type CallbackOutcome =
  | { readonly kind: 'code'; readonly code: string }
  | { readonly kind: 'denied'; readonly error: string; readonly description?: string | undefined }
  | { readonly kind: 'ignored'; readonly why: string };

/**
 * Reads one redirect.
 *
 * A request whose `state` does not match is **ignored**, not failed: a stray browser tab or another process
 * probing the port must not be able to cancel a sign-in the person is in the middle of. That distinction is why
 * this returns a third outcome rather than throwing.
 */
export function readCallback(
  url: URL,
  expectedState: string,
  matches: (a: string | null, b: string) => boolean,
): CallbackOutcome {
  const state = url.searchParams.get('state');
  if (!matches(state, expectedState)) return { kind: 'ignored', why: 'the state did not match' };

  const error = url.searchParams.get('error');
  if (error) {
    return {
      kind: 'denied',
      error,
      ...(url.searchParams.get('error_description')
        ? { description: url.searchParams.get('error_description') as string }
        : {}),
    };
  }

  const code = url.searchParams.get('code');
  if (!code) return { kind: 'ignored', why: 'there was neither a code nor an error' };
  return { kind: 'code', code };
}

/**
 * What the exchange must return before anything is written down.
 *
 * Slack's user-token response nests the token under `authed_user`, and an app that requests only user scopes
 * gets an empty bot half — so a response carrying a bot token is a sign the manifest asked for something it
 * should not have, and is refused rather than quietly ignored.
 */
export interface ExchangedToken {
  readonly accessToken: string;
  readonly refreshToken?: string | undefined;
  readonly expiresInSeconds?: number | undefined;
  readonly scopes: readonly string[];
  readonly userId: string;
  readonly workspaceId: string;
  readonly workspaceName?: string | undefined;
  readonly appId?: string | undefined;
  readonly tokenType?: string | undefined;
}

/** Slack's `oauth.v2.access` shape, as far as this needs it. */
interface OAuthResponse {
  ok?: boolean;
  error?: string;
  app_id?: string;
  team?: { id?: string; name?: string };
  access_token?: string;
  token_type?: string;
  authed_user?: {
    id?: string;
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    token_type?: string;
  };
}

/**
 * Turns Slack's reply into something worth storing, or refuses it.
 *
 * Every refusal here happens **before** anything reaches the config or the secret store. `--mode read` is only
 * trustworthy if the token physically cannot post, and the only moment to establish that is now: afterwards the
 * label is a claim about a token nobody re-examined.
 */
export function readExchange(body: unknown): ExchangedToken {
  const response = body as OAuthResponse;
  if (response?.ok !== true) {
    throw new CommsError('AUTH_REQUIRED', `Slack refused the sign-in: ${response?.error ?? 'no reason given'}`, {
      hint: 'Start again with `agent-slack workspace add`.',
    });
  }

  const user = response.authed_user;
  if (!user?.access_token || !user.id) {
    throw new CommsError('AUTH_REQUIRED', 'Slack returned no user token', {
      hint: 'The app must request user scopes, not bot scopes. Re-create it from the manifest this prints.',
    });
  }

  /*
   * A bot token in the reply means the app asked for bot scopes.
   *
   * It is not merely surplus: a bot token for this workspace would sit in the same app, outside everything this
   * package guards, and the whole read-mode guarantee is that no token exists which can post. Refused rather
   * than dropped, because dropping it would leave that token in existence and unmentioned.
   */
  if (response.access_token) {
    throw new CommsError('AUTH_REQUIRED', 'Slack also issued a bot token, which this app must not request', {
      hint: 'Re-create the app from the manifest this prints; it requests user scopes only.',
    });
  }

  const tokenType = user.token_type;
  if (tokenType && tokenType !== 'user') {
    throw new CommsError('AUTH_REQUIRED', `Slack issued a ${tokenType} token, not a user token`, {
      hint: 'Re-create the app from the manifest this prints.',
    });
  }

  if (!response.team?.id) {
    throw new CommsError('AUTH_REQUIRED', 'Slack did not say which workspace this token is for', {
      hint: 'Start again with `agent-slack workspace add`.',
    });
  }

  return {
    accessToken: user.access_token,
    ...(user.refresh_token ? { refreshToken: user.refresh_token } : {}),
    ...(typeof user.expires_in === 'number' ? { expiresInSeconds: user.expires_in } : {}),
    scopes: (user.scope ?? '').split(',').filter(Boolean).sort(),
    userId: user.id,
    workspaceId: response.team.id,
    ...(response.team.name ? { workspaceName: response.team.name } : {}),
    ...(response.app_id ? { appId: response.app_id } : {}),
    ...(tokenType ? { tokenType } : {}),
  };
}

/**
 * Whether the scopes Slack granted are exactly the ones the mode asks for.
 *
 * Exact, in both directions. Missing scopes mean the install is broken; **extra** ones mean the label is a lie —
 * a token copied from an app that once had `chat:write` would otherwise be stored as `read` and reported as
 * unable to post, which is the one thing D1 promises.
 */
export function scopeMismatch(mode: InstallMode, granted: readonly string[]): { missing: string[]; extra: string[] } {
  const wanted = new Set(scopesForMode(mode));
  const has = new Set(granted);
  return {
    missing: [...wanted].filter((scope) => !has.has(scope)).sort(),
    extra: [...has].filter((scope) => !wanted.has(scope)).sort(),
  };
}
