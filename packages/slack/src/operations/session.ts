import { CommsError } from '@agentcomms/core';
import type { SlackCall } from '../api/call.ts';
import type { FetchLike } from '../api/guard.ts';
import { accessTokenFor, type PersistPolicy, type RefreshDeps, renewRejectedToken } from '../auth/refresh.ts';
import type { SlackContext } from '../context.ts';
import { bundleFrom, requireWorkspace } from './workspaces.ts';

/**
 * A workspace, ready to be read.
 *
 * Every read command does the same four things — resolve the name, find the account, get a token that has not
 * expired, and build the call — and doing them in each command is how one of them ends up not refreshing. So they
 * happen here, once.
 *
 * The refresh is the part worth stating. Slack's token rotation makes a refresh token single-use, so a refresh
 * that is attempted twice loses the credential; `accessTokenFor` holds a per-account lock across the exchange and
 * records what it attempted, and this passes it the pieces it needs rather than re-implementing any of that.
 */

export interface SessionDeps {
  /** Injected in tests. The real `fetch` otherwise, always through the guard by the time it is used. */
  fetch?: FetchLike | undefined;
  /** Where Slack is. Tests point this at a local server rather than turning the origin check off. */
  baseUrl?: string | undefined;
  /** How patiently a renewed credential's write is retried. Tests shorten the minute it takes in production. */
  persist?: PersistPolicy | undefined;
}

export interface WorkspaceSession {
  /** The name this account is known by, for the envelope and for anything the reader prints. */
  readonly name: string;
  readonly accountId: string;
  /** Slack's id for this workspace, so a message from another one is reported as external. */
  readonly teamId: string;
  readonly call: SlackCall;
}

/**
 * Exchanges a rotated refresh token for a new bundle.
 *
 * `oauth.v2.access` with `grant_type=refresh_token` and no client secret — the same PKCE-shaped exchange the
 * sign-in uses, and for the same reason: this package never stores a client secret, so there is none to send.
 * Slack's PKCE guide: "Refreshes for those tokens do not require a client_secret", and "No PKCE parameters
 * (code_verifier, code_challenge) are used during refresh".
 *
 * The response is parsed here rather than through `readExchange`, which is the sign-in's parser and rightly
 * insists on the identity a sign-in establishes — the workspace id, the user id, the granted scopes. A refresh
 * re-establishes none of that; it renews a credential for an account that was identified once already. Sending
 * it through the sign-in's parser would refuse a perfectly good renewal for missing a `team` Slack had no reason
 * to send.
 *
 * Getting this wrong is expensive in a way most parse errors are not: the refresh token is single-use, so by the
 * time this runs Slack has already retired the old one, and a throw here leaves the account with a credential
 * nobody can renew. An earlier version handed Slack's snake_case straight to `bundleFrom`, whose input is
 * camelCase — `expiresInSeconds` arrived `undefined`, the expiry became an invalid date, and the renewal threw
 * *after* the token was spent. So once Slack has said `ok:true` with both tokens, this does not refuse the reply.
 */
function refreshExchange(context: SlackContext, clientId: string) {
  return async (refreshToken: string) => {
    const raw = (await context.exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    })) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s reply to the token renewal was not an object', {
        details: { stage: 'unreadable' },
      });
    }
    if (raw.ok !== true) {
      // Classified by the caller, which is the only place that knows what each refusal did to the token.
      const error = typeof raw.error === 'string' ? raw.error : 'unknown';
      throw new CommsError('AUTH_REQUIRED', `Slack refused the token renewal: ${error}`, {
        details: { stage: 'refused', slackError: error },
      });
    }
    /*
     * Wherever the token actually is.
     *
     * This read `authed_user` whenever it was present, on the belief that a user-token renewal "comes back under
     * `authed_user`, as the sign-in's does". Nothing supports that. Slack's docs never show a full refresh reply for
     * a user token, and all three of its SDKs — python's `TokenRotator`, `@slack/oauth`'s `InstallProvider`, java's
     * `TokenRotator` — read a refreshed user token from the **top level**; the Node SDK's type for the reply has
     * no `authed_user` at all. So a reply with the tokens at the top and an `authed_user: {id}` beside them would
     * have been refused after Slack had spent the old token. Now the object holding `access_token` is the one
     * read, and the sign-in's nested shape still works.
     */
    const nested =
      raw.authed_user && typeof raw.authed_user === 'object' ? (raw.authed_user as Record<string, unknown>) : {};
    const holders = [raw, nested].filter((candidate) => typeof candidate.access_token === 'string');
    // A user token wherever one is: an app with bot scopes gets a bot token at the top and the user's beside it.
    const source =
      holders.find((candidate) => candidate.token_type === undefined || candidate.token_type === 'user') ??
      holders[0] ??
      {};
    // A renewal answered only with a bot token is not this account's credential, whatever else it carries.
    if (source.token_type !== undefined && source.token_type !== 'user') {
      throw new CommsError('AUTH_REQUIRED', 'Slack’s token renewal returned no user token', {
        details: { stage: 'parse' },
      });
    }
    const accessToken = typeof source.access_token === 'string' ? source.access_token : undefined;
    const newRefresh = typeof source.refresh_token === 'string' ? source.refresh_token : undefined;
    if (!accessToken || !newRefresh) {
      throw new CommsError('AUTH_REQUIRED', 'Slack’s token renewal did not include a usable credential', {
        details: { stage: 'parse' },
      });
    }
    /*
     * Twelve hours when Slack does not say — on this path only.
     *
     * `bundleFrom` records the opposite rule for sign-in, "Slack's own number, never a default", and that stays: a
     * sign-in that cannot say how long its token lasts can simply be refused and tried again. Here it cannot. Slack
     * has said `ok:true`, the old refresh token is already spent, and refusing the reply for a missing number would
     * throw away the only credential the workspace has. Slack's rotation guide says `expires_in` "will always" be
     * 43200, so that is the number used — and an early renewal is the worst a wrong guess can cause.
     */
    const expiresIn =
      typeof source.expires_in === 'number' && Number.isFinite(source.expires_in) && source.expires_in > 0
        ? source.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS;
    const bundle = bundleFrom(
      { accessToken, refreshToken: newRefresh, expiresInSeconds: expiresIn } as Parameters<typeof bundleFrom>[0],
      context.now(),
    );
    const { v: _v, state: _state, attempt: _attempt, ...rest } = bundle;
    return rest;
  };
}

/** Slack's rotation guide: `expires_in` "will always" be 43200 seconds, twelve hours. */
const DEFAULT_EXPIRES_IN_SECONDS = 43_200;

/** Resolves a workspace by name and returns a call that carries a live token for it. */
export async function openWorkspace(
  context: SlackContext,
  alias: string,
  deps: SessionDeps = {},
): Promise<WorkspaceSession> {
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias);
  if (!account.oauthClientId) {
    throw new CommsError('CONFIG', `"${name}" has no Slack client id recorded`, {
      hint: `Re-authorise it with \`agent-slack workspace reauth ${name}\` so the id is stored.`,
    });
  }
  const secrets = await context.secrets();
  const refresh: RefreshDeps = {
    secrets,
    openSecrets: () => context.secrets(),
    configDir: context.core.paths.configDir,
    stateDir: context.core.paths.stateDir,
    now: context.now,
    exchange: refreshExchange(context, account.oauthClientId),
    alias: name,
    ...(deps.persist ? { persist: deps.persist } : {}),
  };
  const { token } = await accessTokenFor(refresh, account.id, account.secretRef);
  return {
    name,
    accountId: account.id,
    teamId: account.workspace,
    call: {
      token,
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      // A token Slack rejects gets one forced renewal under the refresh locks; see `renewRejectedToken`.
      renew: (rejected) => renewRejectedToken(refresh, account.id, account.secretRef, rejected),
    },
  };
}
