import { CommsError } from '@agentcomms/core';
import type { SlackCall } from '../api/call.ts';
import type { FetchLike } from '../api/guard.ts';
import { accessTokenFor } from '../auth/refresh.ts';
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
 *
 * The response is parsed here rather than through `readExchange`, which is the sign-in's parser and rightly
 * insists on the identity a sign-in establishes — the workspace id, the user id, the granted scopes. A refresh
 * re-establishes none of that; it renews a credential for an account that was identified once already. Sending
 * it through the sign-in's parser would refuse a perfectly good renewal for missing a `team` Slack had no reason
 * to send.
 *
 * What it does insist on is the three fields a bundle cannot be built without. Getting that wrong is expensive in
 * a way most parse errors are not: the refresh token is single-use, so by the time this runs Slack has already
 * retired the old one, and a throw here leaves the account with a credential nobody can renew. An earlier version
 * of this function handed Slack's snake_case straight to `bundleFrom`, whose input is camelCase — `expiresInSeconds`
 * arrived `undefined`, the expiry became an invalid date, and the renewal threw *after* the token was spent.
 */
function refreshExchange(context: SlackContext, clientId: string) {
  return async (refreshToken: string) => {
    const raw = (await context.exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
    })) as { ok?: boolean; error?: string; authed_user?: Record<string, unknown> };
    if (raw.ok !== true) {
      throw new CommsError('AUTH_REQUIRED', `Slack refused the token renewal: ${raw.error ?? 'unknown'}`, {
        hint: 'Re-authorise this workspace with `agent-slack workspace reauth <name>`.',
      });
    }
    // A user-token renewal comes back under `authed_user`, as the sign-in's does; some shapes put it at the top.
    const user = (raw.authed_user ?? raw) as Record<string, unknown>;
    const accessToken = typeof user.access_token === 'string' ? user.access_token : undefined;
    const newRefresh = typeof user.refresh_token === 'string' ? user.refresh_token : undefined;
    const expiresIn = typeof user.expires_in === 'number' ? user.expires_in : undefined;
    if (!accessToken || !newRefresh || expiresIn === undefined || expiresIn <= 0) {
      throw new CommsError('AUTH_REQUIRED', 'Slack’s token renewal did not include a usable credential', {
        hint: 'Re-authorise this workspace with `agent-slack workspace reauth <name>`.',
      });
    }
    const bundle = bundleFrom(
      { accessToken, refreshToken: newRefresh, expiresInSeconds: expiresIn } as Parameters<typeof bundleFrom>[0],
      context.now(),
    );
    const { v: _v, state: _state, attempt: _attempt, ...rest } = bundle;
    return rest;
  };
}

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
      hint: 'Re-authorise it with `agent-slack workspace reauth <name>` so the id is stored.',
    });
  }
  const secrets = await context.secrets();
  const { token } = await accessTokenFor(
    {
      secrets,
      openSecrets: () => context.secrets(),
      configDir: context.core.paths.configDir,
      stateDir: context.core.paths.stateDir,
      now: context.now,
      exchange: refreshExchange(context, account.oauthClientId),
    },
    account.id,
    account.secretRef,
  );
  return {
    name,
    accountId: account.id,
    teamId: account.workspace,
    call: { token, fetch: deps.fetch, baseUrl: deps.baseUrl },
  };
}
