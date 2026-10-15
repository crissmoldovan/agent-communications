import { type AccountConfig, CommsError, findById, handoffSentence } from '@agentcomms/core';
import type { SlackCall } from '../api/call.ts';
import type { FetchLike } from '../api/guard.ts';
import { accessTokenFor, type PersistPolicy, type RefreshDeps, renewRejectedToken } from '../auth/refresh.ts';
import type { SlackContext } from '../context.ts';
import { botSecretRefFor, bundleFrom, clientSecretRefOf, requireWorkspace } from './workspaces.ts';

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
function refreshExchange(context: SlackContext, clientId: string, clientSecretRef?: string | undefined) {
  return async (refreshToken: string) => {
    const secret = await renewalSecret(context, clientSecretRef);
    const raw = (await context.exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      ...(secret === undefined ? {} : { client_secret: secret }),
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
      { refreshExpires: secret === undefined },
    );
    const { v: _v, state: _state, attempt: _attempt, ...rest } = bundle;
    return rest;
  };
}

/**
 * The app's client secret, for a renewal of a token a client-secret sign-in issued (design 2026-10-15 S1, revised):
 * Slack's rotation guide sends `client_secret` with every refresh of a confidential client's token. Read just before
 * the request, from the secret store; one that is gone stops the renewal before anything is sent (`stage: guard`), so
 * the single-use refresh token is not spent on a request Slack would refuse.
 */
async function renewalSecret(context: SlackContext, ref: string | undefined): Promise<string | undefined> {
  if (ref === undefined) return undefined;
  const secret = await (await context.secrets()).get(ref);
  if (secret === null || secret === '') {
    throw new CommsError(
      'AUTH_REQUIRED',
      "the app's client secret is not stored on this machine, so the token cannot be renewed",
      {
        hint: 'Sign the workspace in again with --with-client-secret, and type the secret when asked.',
        details: { stage: 'guard' },
      },
    );
  }
  return secret;
}

/** Slack's rotation guide: `expires_in` "will always" be 43200 seconds, twelve hours. */
const DEFAULT_EXPIRES_IN_SECONDS = 43_200;

/**
 * Renews the send app's bot token (design 2026-10-15 S1): the same exchange as the user token's, and the same rule once
 * Slack has said `ok:true` — but the token read is the bot's, at the top of the reply, and a reply that holds only a
 * user token is not this credential. The manifest turns rotation on for the whole app, so the bot token rotates too.
 */
function botRefreshExchange(context: SlackContext, clientId: string, clientSecretRef?: string | undefined) {
  return async (refreshToken: string) => {
    const secret = await renewalSecret(context, clientSecretRef);
    const raw = (await context.exchange({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      ...(secret === undefined ? {} : { client_secret: secret }),
    })) as Record<string, unknown> | null;
    if (raw === null || typeof raw !== 'object') {
      throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s reply to the app token renewal was not an object', {
        details: { stage: 'unreadable' },
      });
    }
    if (raw.ok !== true) {
      const error = typeof raw.error === 'string' ? raw.error : 'unknown';
      throw new CommsError('AUTH_REQUIRED', `Slack refused the app token renewal: ${error}`, {
        details: { stage: 'refused', slackError: error },
      });
    }
    const accessToken = typeof raw.access_token === 'string' ? raw.access_token : undefined;
    const newRefresh = typeof raw.refresh_token === 'string' ? raw.refresh_token : undefined;
    if (raw.token_type !== 'bot' || !accessToken || !newRefresh) {
      throw new CommsError('AUTH_REQUIRED', 'Slack’s app token renewal returned no bot token', {
        details: { stage: 'parse' },
      });
    }
    const expiresIn =
      typeof raw.expires_in === 'number' && Number.isFinite(raw.expires_in) && raw.expires_in > 0
        ? raw.expires_in
        : DEFAULT_EXPIRES_IN_SECONDS;
    const bundle = bundleFrom(
      { accessToken, refreshToken: newRefresh, expiresInSeconds: expiresIn } as Parameters<typeof bundleFrom>[0],
      context.now(),
      { refreshExpires: secret === undefined },
    );
    const { v: _v, state: _state, attempt: _attempt, ...rest } = bundle;
    return rest;
  };
}

/**
 * A call carrying the send app's bot token, renewed first when it is due (design 2026-10-15 S1, S4). Under the same
 * credentials lock as every refresh, with a lock and an in-flight slot of its own, so it never waits on the user
 * token's. Only an act the gate routed to the app opens it, and only to post through the gate.
 */
export async function openApp(
  context: SlackContext,
  name: string,
  account: AccountConfig,
  deps: SessionDeps = {},
): Promise<SlackCall> {
  if (!account.oauthClientId) {
    throw new CommsError('CONFIG', `"${name}" has no Slack client id recorded, so its app's token cannot be renewed`);
  }
  const secrets = await context.secrets();
  const persist = deps.persist ?? context.persist;
  const ref = botSecretRefFor(account.id);
  const refresh: RefreshDeps = {
    secrets,
    openSecrets: () => context.secrets(),
    configDir: context.core.paths.configDir,
    stateDir: context.core.paths.stateDir,
    now: context.now,
    exchange: botRefreshExchange(context, account.oauthClientId, clientSecretRefOf(account)),
    alias: name,
    handoffs: context.handoffs,
    ...(persist ? { persist } : {}),
  };
  // Its own lock and its own kept result: the user token's are keyed by the account's id, and this is not that token.
  const { token } = await accessTokenFor(refresh, `${account.id}-app`, ref);
  return { token, fetch: deps.fetch, baseUrl: deps.baseUrl };
}

/** Resolves a workspace by name and returns a call that carries a live token for it. */
export async function openWorkspace(
  context: SlackContext,
  alias: string,
  deps: SessionDeps = {},
): Promise<WorkspaceSession> {
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias, context.handoffs);
  if (!account.oauthClientId) {
    throw new CommsError('CONFIG', `"${name}" has no Slack client id recorded`, {
      hint: handoffSentence(
        context.handoffs.own(['workspace', 'reauth', name]),
        (command) => `Re-authorise it with ${command} so the id is stored.`,
        { instead: 'Re-authorise it with slack_workspace_reauth from a chat so the id is stored.' },
      ),
    });
  }
  const secrets = await context.secrets();
  const persist = deps.persist ?? context.persist;
  const liveAccount = async () => {
    const live = findById(await context.config(), 'account', account.id);
    if (!live) throw new CommsError('CONFIG', 'the Slack account is no longer connected');
    return live;
  };
  const refresh: RefreshDeps = {
    secrets,
    openSecrets: async () => {
      // Called under the credentials lock, before refresh writes a marker or spends a token. A hand-off that
      // won that lock first has retired this ref; the caller below follows the replacement instead.
      const current = await context.config();
      if (current.pendingRevocations?.some((entry) => entry.ref === account.secretRef)) {
        throw new CommsError('TRANSIENT', 'the Slack credential was replaced before it could be refreshed');
      }
      return context.secrets();
    },
    configDir: context.core.paths.configDir,
    stateDir: context.core.paths.stateDir,
    now: context.now,
    exchange: refreshExchange(context, account.oauthClientId, clientSecretRefOf(account)),
    alias: name,
    handoffs: context.handoffs,
    ...(persist ? { persist } : {}),
  };
  let token: string;
  try {
    ({ token } = await accessTokenFor(refresh, account.id, account.secretRef));
  } catch (error) {
    const live = await liveAccount();
    if (live.account.secretRef !== account.secretRef) return openWorkspace(context, live.alias, deps);
    throw error;
  }
  const live = await liveAccount();
  if (live.account.secretRef !== account.secretRef) return openWorkspace(context, live.alias, deps);
  return {
    name,
    accountId: account.id,
    teamId: account.workspace,
    call: {
      token,
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      // A token Slack rejects gets one forced renewal under the refresh locks; see `renewRejectedToken`.
      renew: async (rejected) => {
        // A profile hand-off keeps the account id but puts the old ref in the cleanup ledger. An already-open
        // session must follow the live account rather than rotate a token that is being revoked.
        const live = await liveAccount();
        if (live.account.secretRef !== account.secretRef) {
          const current = await openWorkspace(context, live.alias, deps);
          return current.call.token === rejected ? null : current.call.token;
        }
        try {
          return await renewRejectedToken(refresh, account.id, account.secretRef, rejected);
        } catch (error) {
          const changed = await liveAccount();
          if (changed.account.secretRef === account.secretRef) throw error;
          const current = await openWorkspace(context, changed.alias, deps);
          return current.call.token === rejected ? null : current.call.token;
        }
      },
    },
  };
}
