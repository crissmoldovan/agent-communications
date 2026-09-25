import { closedPermit, type WritePermit } from '../api/guard.ts';
import type { SlackContext } from '../context.ts';
import type { PostDeps, PrepareDeps } from './send.ts';
import { openWorkspace, type SessionDeps } from './session.ts';
import { requireWorkspace } from './workspaces.ts';

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
  const { alias: name, account } = requireWorkspace(config, alias);
  const { call, teamId } = await openWorkspace(context, name, deps);
  return {
    call,
    accountId: account.id,
    workspaceId: teamId,
    workspaceName: name,
    postingAs: account.userId,
    policy: account.sendPolicy ?? config.defaults.sendPolicy,
    approvals: context.core.approvals,
    audit: context.core.audit,
    surface: context.surface,
    permit: closedPermit(),
  };
}
