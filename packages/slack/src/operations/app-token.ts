import { type CliHandoffs, CommsError, findById, handoffSentence, toCommsError } from '@agentcomms/core';
import type { SlackContext } from '../context.ts';
import type { LabelDeps } from './label.ts';
import { botSecretRefFor, type SlackAccount } from './workspaces.ts';

/**
 * A stored bot token Slack no longer accepts (CUE-493, decided 2026-10-16).
 *
 * An organisation's agent app has one token, shared by its members; when someone leaves, its admin revokes it and
 * shares a new one, and every member's copy stops working at once. Nothing on this machine can tell until Slack says
 * so, on the next act made with it. Then:
 *
 * - **that act is refused**, as any refusal is: the person approved the app's identity, and the other identity is a
 *   different message that needs its own preview and its own yes;
 * - **the token is forgotten**, as narrowing or removal forgets it — deleted from the secret store, never revoked, and
 *   the account no longer names the bot user — so the next prepare takes the labelled fallback (S2);
 * - **why is recorded** on the account, `appTokenRevoked`, so `doctor` can say when, and what brings it back.
 *
 * Only for the three answers that say the token itself is dead. Any other refusal — not in the channel, a scope, a
 * channel gone — is about the act, and keeps the token.
 */

/** Slack's answers that mean the bot token itself no longer works, whatever the act. */
export const DEAD_APP_TOKEN: ReadonlySet<string> = new Set(['token_revoked', 'invalid_auth', 'account_inactive']);

/** What the account records of a bot token Slack refused: when, and Slack's own word for it. */
export interface AppTokenRevoked {
  readonly at: string;
  readonly slackError: string;
}

/** The record of a revoked bot token on an account, checked rather than cast: it is read back from the configuration. */
export function appTokenRevokedOf(account: unknown): AppTokenRevoked | undefined {
  const value = (account as { appTokenRevoked?: unknown } | undefined)?.appTokenRevoked as
    | { at?: unknown; slackError?: unknown }
    | undefined;
  if (value === undefined || typeof value.at !== 'string' || !Number.isFinite(Date.parse(value.at))) return undefined;
  return { at: value.at, slackError: typeof value.slackError === 'string' ? value.slackError : 'unknown' };
}

/**
 * Forgets an account's bot token after Slack refused it: the secret first, as removal deletes it, then the account —
 * the bot user it named taken off, and why recorded. A token kept with no bot user named is one nothing posts with.
 */
export async function forgetAppToken(context: SlackContext, accountId: string, slackError: string): Promise<void> {
  const secrets = await context.secrets();
  await secrets.delete(botSecretRefFor(accountId));
  secrets.invalidate(botSecretRefFor(accountId));
  const at = context.now().toISOString();
  await context.core.config.update((current) => {
    const held = findById(current, 'account', accountId);
    if (!held) return current;
    const { botUserId: _gone, ...rest } = held.account as SlackAccount;
    const next = { ...rest, appTokenRevoked: { at, slackError } };
    return { ...current, accounts: { ...current.accounts, [held.alias]: next } };
  });
}

/** Which act a refusal ended: what it says was not done, and what to do next. */
export type AppAct = 'post' | 'reaction' | 'edit' | 'delete';

/**
 * The refusal an act made with the app's bot token ends with, when Slack refused the token itself: the token forgotten
 * first, and the words for it — what happened, that nothing went out, and what to do now, with the paste command
 * located. Any other error is returned as it came, and the token kept.
 */
export async function appTokenRefusal(
  deps: { readonly label?: LabelDeps | undefined; readonly handoffs: CliHandoffs; readonly workspaceName: string },
  act: AppAct,
  error: unknown,
): Promise<unknown> {
  if (!(error instanceof CommsError)) return error;
  const slackError = error.details?.slackError;
  if (typeof slackError !== 'string' || !DEAD_APP_TOKEN.has(slackError)) return error;
  const app = deps.label?.app;
  let kept = '';
  try {
    await app?.forget?.(slackError);
  } catch (failure) {
    kept = ` It could not be removed from this machine (${toCommsError(failure).message}), so the next prepare may route to the app again.`;
  }
  const who =
    app?.organisation !== undefined
      ? ` (${app.organisation}'s admin may have regenerated it)`
      : ' (it may have been regenerated, or the app reinstalled)';
  const paste = deps.handoffs.own(['workspace', 'bot', deps.workspaceName]);
  const hint = {
    post: handoffSentence(
      paste,
      (command) =>
        `Prepare it again to post as you, labelled, or paste the new token with ${command} in your own terminal first, to post as the app.`,
      { instead: 'Prepare it again to post as you, labelled, or paste the new token with `workspace bot` first.' },
    ),
    reaction: handoffSentence(
      paste,
      (command) =>
        `Prepare it again to react as you, or paste the new token with ${command} in your own terminal first, to react as the app.`,
      { instead: 'Prepare it again to react as you, or paste the new token with `workspace bot` first.' },
    ),
    edit: handoffSentence(
      paste,
      (command) =>
        `Only the app can edit or delete its own message: paste the new token with ${command} in your own terminal, then prepare it again.`,
      {
        instead:
          'Only the app can edit or delete its own message: paste the new token with `workspace bot`, then prepare it again.',
      },
    ),
  };
  return new CommsError(
    error.code,
    `the agent app's token was revoked${who}, so nothing was ${act === 'post' ? 'posted' : 'changed'}: Slack said ${slackError}`,
    {
      hint: `${act === 'delete' ? hint.edit : hint[act]}${kept}`,
      details: { ...error.details, reason: 'app-token-revoked' },
      ...(error.cause === undefined ? {} : { cause: error.cause }),
    },
  );
}
