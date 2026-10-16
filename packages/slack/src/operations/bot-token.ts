import { CommsError, findById, handoffSentence, organisationAgentApp, toCommsError } from '@agentcomms/core';
import { callSlack } from '../api/call.ts';
import { closedPermit, guardSlackRequests } from '../api/guard.ts';
import { SLACK_ORIGIN } from '../api/methods.ts';
import { displaySlackFailureText } from '../auth/authorize.ts';
import { BUNDLE_VERSION, serialiseBundle } from '../auth/bundle.ts';
import type { SlackContext } from '../context.ts';
import { BOT_SCOPES } from '../manifest.ts';
import { openWorkspace, type SessionDeps } from './session.ts';
import { botSecretRefFor, requireWorkspace, type SlackAccount } from './workspaces.ts';

/**
 * The send app's bot token, pasted once from the app's own page (design 2026-10-15 S1, revised).
 *
 * The PKCE sign-in cannot ask Slack for bot scopes — "desktop redirects are not allowed to request bot scopes" — so a
 * workspace gets its app's bot token one of two other ways: the client-secret sign-in, or this. A person copies the
 * "Bot User OAuth Token" from the app's OAuth & Permissions page, after "Install to Workspace" has created the bot, and
 * types it at a hidden prompt; the command is a terminal's only, and refuses an agent (`workspace bot` in the CLI).
 *
 * Nothing is kept until Slack has said what the token is: a bot token, for this workspace's team, with exactly the four
 * posting scopes the send manifest declares. And not one that rotates: a token copied from the page of an app whose
 * tokens rotate stops working within twelve hours, and nothing here could renew it.
 *
 * And, for a workspace connected through an organisation's profile that names its agent app (CUE-493), that app's: the
 * organisation's bot-only app, whose one token its administrator shares and each member pastes here. `bots.info`, asked
 * with the member's own token, says which app the pasted token's bot belongs to, and another app's is refused by name.
 * A profile that names none is checked as before.
 */

export interface StoredBotToken {
  readonly alias: string;
  readonly accountId: string;
  readonly workspaceId: string;
  /** The bot user the app posts as, from `auth.test`. */
  readonly botUserId: string;
}

/** An access token that does not rotate has no expiry; the bundle says so with a date nothing reaches. */
const NEVER = '9999-12-31T23:59:59.999Z';

/** "…sign in with the app's client secret: <reauth>", located, or the words for it. */
function secretSignIn(alias: string, context: SlackContext): string {
  return handoffSentence(
    context.handoffs.own(['workspace', 'reauth', alias, '--mode', 'send', '--with-client-secret']),
    (command) => `sign in with the app's client secret instead: ${command}`,
    { instead: "sign in with the app's client secret instead, at a terminal" },
  );
}

/** Refuses what cannot be this app's bot token by its shape, before it is sent anywhere. */
function checkShape(token: string, alias: string, context: SlackContext): void {
  if (token === '') throw new CommsError('USAGE', 'nothing was typed, so nothing was kept');
  if (token.startsWith('xoxe.')) {
    throw new CommsError('AUTH_REQUIRED', 'that token rotates, so it would stop working within twelve hours', {
      hint: `Nothing was kept. A token copied from the page of an app whose tokens rotate cannot be renewed from here. Turn token rotation off for the app, if it was never on — Slack does not let it be turned off once on — or ${secretSignIn(alias, context)}.`,
      details: { reason: 'rotating-token' },
    });
  }
  if (token.startsWith('xoxp-')) {
    throw new CommsError('AUTH_REQUIRED', 'that is a user token, not the app’s bot token', {
      hint: 'Nothing was kept. Copy the "Bot User OAuth Token" (it starts xoxb-) from the app’s OAuth & Permissions page, not the "User OAuth Token".',
      details: { reason: 'user-token' },
    });
  }
  if (!token.startsWith('xoxb-')) {
    throw new CommsError('AUTH_REQUIRED', 'that is not a Slack bot token', {
      hint: 'Nothing was kept. Copy the "Bot User OAuth Token" (it starts xoxb-) from the app’s OAuth & Permissions page.',
      details: { reason: 'not-a-bot-token' },
    });
  }
}

interface AuthTest {
  readonly ok?: boolean;
  readonly error?: string;
  readonly team_id?: string;
  readonly user_id?: string;
  readonly bot_id?: string;
}

/**
 * What Slack says the token is, through the guard every Slack request goes through: `auth.test`, a read with no
 * permit, carrying the pasted token and nothing else. The scopes come from Slack's `x-oauth-scopes` header.
 */
async function askSlack(token: string, deps: SessionDeps): Promise<{ body: AuthTest; scopes: string[] | undefined }> {
  const send = guardSlackRequests(deps.fetch ?? (fetch as NonNullable<SessionDeps['fetch']>), closedPermit());
  let response: Response;
  try {
    response = await send(new URL('/api/auth.test', deps.baseUrl ?? SLACK_ORIGIN), {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded;charset=utf-8' },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack could not be asked what the token is, so nothing was kept', {
      hint: 'Try again in a moment.',
      details: { cause: (error as Error).message },
    });
  }
  const header = response.headers.get('x-oauth-scopes');
  const scopes = header
    ?.split(',')
    .map((scope) => scope.trim())
    .filter(Boolean)
    .sort();
  let body: AuthTest;
  try {
    body = (await response.json()) as AuthTest;
  } catch {
    throw new CommsError(
      'PROVIDER_UNAVAILABLE',
      'Slack’s answer about the token was not readable, so nothing was kept',
      {
        hint: 'Try again in a moment.',
      },
    );
  }
  return { body, scopes };
}

interface BotsInfo {
  readonly bot?: { readonly app_id?: unknown; readonly name?: unknown };
}

/**
 * Refuses a bot token that is not the organisation's agent app's: `bots.info` about the bot `auth.test` named, asked
 * with the member's own user token (`users:read`), never with the pasted one, and its `app_id` compared exactly. An
 * answer that names no app — or none could be had — keeps nothing: the check is the reason to ask.
 */
async function requireAgentApp(
  context: SlackContext,
  alias: string,
  organisation: string,
  botId: string,
  expected: string,
  deps: SessionDeps,
): Promise<void> {
  const ask = 'Ask your organisation’s admin for the agent app’s "Bot User OAuth Token", and paste that one.';
  let answer: BotsInfo;
  try {
    const session = await openWorkspace(context, alias, deps);
    answer = (await callSlack(session.call, 'bots.info', { bot: botId })) as BotsInfo;
  } catch (error) {
    const failure = toCommsError(error);
    throw new CommsError(
      'PROVIDER_UNAVAILABLE',
      'Slack could not say which app that token belongs to, so nothing was kept',
      {
        hint: `${organisation}'s profile names its agent app, so the token is kept only once Slack says it is that app's. ${displaySlackFailureText(failure.message)}. Try again in a moment.`,
        details: { reason: 'app-unknown' },
      },
    );
  }
  const appId = typeof answer.bot?.app_id === 'string' ? answer.bot.app_id : '';
  if (appId === '') {
    throw new CommsError(
      'PROVIDER_UNAVAILABLE',
      'Slack did not say which app that token belongs to, so nothing was kept',
      {
        hint: `${organisation}'s profile names its agent app, so the token is kept only once Slack says it is that app's. Try again in a moment.`,
        details: { reason: 'app-unknown' },
      },
    );
  }
  if (appId === expected) return;
  const shownId = displaySlackFailureText(appId);
  const shownName = displaySlackFailureText(answer.bot?.name);
  throw new CommsError(
    'CONFIG',
    `that token is the app ${shownId}${shownName ? ` ("${shownName}")` : ''}'s, not ${organisation}'s agent app, ${displaySlackFailureText(expected)}`,
    {
      hint: `Nothing was kept. ${ask}`,
      details: { reason: 'another-app', appId: shownId, expected: displaySlackFailureText(expected) },
    },
  );
}

/**
 * Checks a pasted bot token with Slack and keeps it for the workspace, under `slack/bot-token/<accountId>`, with
 * `auth.test`'s `user_id` as the account's `botUserId`. Never prints it, and never keeps one Slack has not vouched for.
 */
export async function storeBotToken(
  context: SlackContext,
  alias: string,
  pasted: string,
  deps: SessionDeps = {},
): Promise<StoredBotToken> {
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias, context.handoffs);
  if ((account.mode ?? account.tier) !== 'send') {
    throw new CommsError('SCOPE_MISSING', `"${name}" is connected to read, and keeps no token that can post`, {
      hint: 'Nothing was kept. A read workspace holds no token that can post, by design: move it to send first.',
      details: { mode: account.mode ?? account.tier },
    });
  }
  const token = pasted.trim();
  checkShape(token, name, context);

  const { body, scopes } = await askSlack(token, deps);
  if (body.ok !== true) {
    throw new CommsError(
      'AUTH_REQUIRED',
      `Slack refused the token: ${displaySlackFailureText(body.error) || 'no reason given'}`,
      { hint: 'Nothing was kept. Copy the "Bot User OAuth Token" again from the app’s OAuth & Permissions page.' },
    );
  }
  if (body.bot_id === undefined || body.bot_id === '') {
    throw new CommsError('AUTH_REQUIRED', 'Slack says that token is not a bot token', {
      hint: 'Nothing was kept. Copy the "Bot User OAuth Token" from the app’s OAuth & Permissions page.',
      details: { reason: 'not-a-bot-token' },
    });
  }
  if (body.team_id !== account.workspace) {
    throw new CommsError(
      'CONFIG',
      `that token is for another workspace (${displaySlackFailureText(body.team_id) || 'none named'}), not ${account.workspace}`,
      {
        hint: `Nothing was kept. Copy the bot token of the app "${name}" signs in through, installed in its own team.`,
        details: { reason: 'another-team' },
      },
    );
  }
  const botUserId = body.user_id;
  if (typeof botUserId !== 'string' || !/^[UW][A-Z0-9]{2,39}$/.test(botUserId)) {
    throw new CommsError('AUTH_REQUIRED', 'Slack did not say which bot user the token posts as', {
      hint: 'Nothing was kept. Try again in a moment.',
    });
  }
  // Whose app, when the organisation says whose it should be: before the scopes, as the more basic of the two.
  if (account.organisation !== undefined) {
    const named = organisationAgentApp(config, account.organisation, account.workspace);
    if (named !== undefined) await requireAgentApp(context, name, account.organisation, body.bot_id, named.appId, deps);
  }
  const wanted = [...BOT_SCOPES].sort();
  if (scopes === undefined || scopes.join(',') !== wanted.join(',')) {
    const held = scopes?.map((scope) => displaySlackFailureText(scope)).join(', ') || 'no scope Slack named';
    throw new CommsError('AUTH_REQUIRED', `that bot token holds ${held}, not exactly ${wanted.join(', ')}`, {
      hint: 'Nothing was kept. Update the app from the send manifest, so its bot asks for exactly these four, install it to the workspace again, and copy the new token.',
      details: { reason: 'bot-scopes', held: scopes ?? null },
    });
  }

  const ref = botSecretRefFor(account.id);
  const secrets = await context.secrets();
  const now = context.now().toISOString();
  await secrets.set(
    ref,
    serialiseBundle({ v: BUNDLE_VERSION, state: 'ready', accessToken: token, accessExpiresAt: NEVER, issuedAt: now }),
  );
  try {
    await context.core.config.update((current) => {
      // The account the token was checked for, by id, wherever it is now — and still able to post.
      const held = findById(current, 'account', account.id);
      if (
        !held ||
        (held.account.mode ?? held.account.tier) !== 'send' ||
        held.account.workspace !== account.workspace
      ) {
        throw new CommsError('CONFIG', `"${name}" changed while its bot token was being kept, so nothing was kept`, {
          hint: 'Look at the workspace, and paste the token again if it should still have one.',
        });
      }
      // A token pasted again replaces one Slack refused: the record of that refusal goes with it (CUE-493).
      const { appTokenRevoked: _replaced, ...kept } = held.account as SlackAccount & { appTokenRevoked?: unknown };
      const next: SlackAccount = { ...kept, botUserId };
      return { ...current, accounts: { ...current.accounts, [held.alias]: next } };
    });
  } catch (error) {
    // Not named by the account, so not kept: a token nothing names is a token nothing deletes.
    await secrets.delete(ref).catch(() => undefined);
    throw error;
  }
  return { alias: name, accountId: account.id, workspaceId: account.workspace, botUserId };
}
