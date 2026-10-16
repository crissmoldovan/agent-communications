import { effectiveAccountSendPolicy, securityNotice, sendEpochOf } from '@agentcomms/core';
import type { SlackCall } from '../api/call.ts';
import { closedPermit, type WritePermit } from '../api/guard.ts';
import type { SlackContext } from '../context.ts';
import { VERSION } from '../version.ts';
import { appPostRecordFor } from './app-posts.ts';
import { appTokenRevokedOf, forgetAppToken } from './app-token.ts';
import { attachPolicyOf } from './drafts.ts';
import { labelSettingsOf, noAppReason, revokedAppReason } from './label.ts';
import type { PostDeps, PrepareDeps } from './send.ts';
import { openApp, openWorkspace, type SessionDeps } from './session.ts';
import { botUserIdOf, requireWorkspace } from './workspaces.ts';

/**
 * Everything the gate needs, assembled once — for the CLI and the MCP server alike.
 *
 * The audit sink and the surface go in here rather than at each call site: an operation that records what it did
 * in three places out of four is an operation whose log cannot be trusted, and the missing one is always the
 * interesting one. That is not hypothetical. This used to live in the CLI, and the MCP server built its own copy
 * without the audit sink, so every `slack_post_prepare` an agent made left no record while the same prepare from a
 * terminal did — `agentcomms audit tail` answered "what did the agent ask to post" with nothing at all.
 *
 * The surface is read from the context rather than passed, because the context is what each surface builds for
 * itself and cannot get wrong without every other operation noticing.
 */
export interface GateDeps extends PostDeps {
  readonly audit: NonNullable<PrepareDeps['audit']>;
  readonly surface: 'cli' | 'mcp';
  readonly permit: WritePermit;
}

export async function gateDepsFor(context: SlackContext, alias: string, deps: SessionDeps = {}): Promise<GateDeps> {
  const config = await context.config();
  const { alias: name, account } = requireWorkspace(config, alias, context.handoffs);
  const { call, teamId } = await openWorkspace(context, name, deps);
  const mode = account.mode ?? account.tier;
  const botUserId = mode === 'send' ? botUserIdOf(account) : undefined;
  // Opened at most once, and only when an act routes to the app (design 2026-10-15 S2).
  let app: Promise<SlackCall> | undefined;
  return {
    call,
    accountId: account.id,
    workspaceId: teamId,
    workspaceName: name,
    handoffs: context.handoffs,
    postingAs: account.userId,
    policy: effectiveAccountSendPolicy(config, name),
    sendEpoch: sendEpochOf(config, account.id),
    // What a post with files is checked against, at prepare and again at send: the mode, the grant, and the folders.
    mode: account.mode ?? account.tier,
    grantedScopes: account.grantedScopes,
    attachPolicy: await attachPolicyOf(context),
    approvals: context.core.approvals,
    audit: context.core.audit,
    surface: context.surface,
    permit: closedPermit(),
    sendPacing: context.sendPacing,
    // This account's own record of its app's posts (design 2026-10-15 S5).
    appPosts: appPostRecordFor(context.core.paths.stateDir, account.id),
    // A security fix this machine does not install on its own, asked about once in a preview (design 2026-10-16, U7).
    securityNotice: (act) => securityNotice({ core: context.core, env: context.env, running: VERSION, act }),
    // Who each act appears to come from (design 2026-10-15): the person's settings, and this account's app if it has one.
    label: {
      account: name,
      accountId: account.id,
      settings: labelSettingsOf(config),
      ...(botUserId === undefined
        ? {
            // A token Slack refused and nothing replaced since says so (CUE-493); otherwise, why there is none.
            noApp: mode === 'send' && appTokenRevokedOf(account) !== undefined ? revokedAppReason() : noAppReason(mode),
          }
        : {
            app: {
              userId: botUserId,
              call: () => {
                app ??= openApp(context, name, account, deps);
                return app;
              },
              // Only the token the refused call carried: the call this gate opened, and nothing stored since.
              forget: async (slackError: string) => {
                const refused = await app?.catch(() => undefined);
                if (refused === undefined) return 'kept' as const;
                return forgetAppToken(context, account.id, slackError, refused.token);
              },
              ...(account.organisation === undefined ? {} : { organisation: account.organisation }),
            },
          }),
    },
  };
}
