import {
  gateTake,
  handoffSentence,
  TAKE_ID_PATTERN,
  type TakeCaller,
  type TakeGatePass,
  type TakenView,
  takenViews,
  takerIdentity,
} from '@agentcomms/core';
import type { GmailContext, ResolvedInbox } from './context.ts';

/*
 * Taking messages, Gmail's helpers (design 2026-10-26-taking-messages §5, §6): who is acting, how this surface takes a
 * message, the gate every act that answers a message passes, the refusal of housekeeping on a message someone else
 * has, and a read's `taken`. Helpers, not operations: they live outside `operations/`, so the parity drive traces each
 * act to its own operation alone.
 */

const CALLERS = new WeakMap<GmailContext, Promise<TakeCaller>>();

/**
 * The session acting — the server's agent window, or the window a command runs in — worked out from the process and
 * `CLAUDE_CODE_SESSION_ID`, never from an argument; `null` for the person at their own terminal (T2). Once per context.
 */
export function takeCallerOf(context: GmailContext): Promise<TakeCaller> {
  let caller = CALLERS.get(context);
  if (caller === undefined) {
    caller = takerIdentity(context.core, context.surface, context.clientInfo?.(), { env: context.env });
    CALLERS.set(context, caller);
  }
  return caller;
}

/** How a refusal tells this surface to take a message (§6): the tool over MCP, the located command at a terminal. */
export function takeWithOf(context: GmailContext, alias: string, messageId: string): string {
  return context.surface === 'mcp'
    ? 'gmail_take (step "take")'
    : handoffSentence(context.handoffs.own(['take', messageId, '--inbox', alias]), (command) => command, {
        instead: 'the take command',
      });
}

/**
 * §6: the take an act answering `messageId` needs, as core's gate decides it on the configuration as it is now — the
 * person passes, the holder passes and renews its lease (pinned under `approvalId` while that approval waits), anyone
 * else is refused. `act` is the act's capability id.
 */
export async function requireGmailTake(
  context: GmailContext,
  resolved: ResolvedInbox,
  messageId: string,
  act: string,
  approvalId?: string | undefined,
): Promise<TakeGatePass> {
  return gateTake(context.core.takes, await context.config(), {
    ref: { channel: 'gmail', accountId: resolved.inbox.id, id: messageId },
    caller: await takeCallerOf(context),
    act: { account: resolved.alias, shown: messageId, act, takeWith: takeWithOf(context, resolved.alias, messageId) },
    ...(approvalId === undefined ? {} : { approvalId }),
  });
}

/**
 * The pin a prepared send puts on its take (T3), once its approval exists: best-effort, since the claim asks the gate
 * again whatever this finds.
 */
export async function pinGmailTake(
  context: GmailContext,
  resolved: ResolvedInbox,
  messageId: string,
  act: string,
  approvalId: string,
): Promise<void> {
  try {
    await requireGmailTake(context, resolved, messageId, act, approvalId);
  } catch {
    // Released between the gate and the approval: the claim refuses it.
  }
}

/**
 * T6: organising and binning need no take, but are refused on a message someone else has — another session's take or
 * offer, a message another marked done, or one the person keeps. The person is never refused.
 */
export async function refuseGmailHeldElsewhere(
  context: GmailContext,
  resolved: ResolvedInbox,
  messageIds: readonly string[],
): Promise<void> {
  const refs = messageIds
    .filter((id) => TAKE_ID_PATTERN.test(id))
    .map((id) => ({ channel: 'gmail' as const, accountId: resolved.inbox.id, id }));
  if (refs.length === 0) return;
  await context.core.takes.refuseHeldElsewhere(refs, await takeCallerOf(context));
}

/** Who has each of these messages (T7), in closed words: one file look each, and never a reason to fail a read. */
export async function gmailTaken(
  context: GmailContext,
  inboxId: string,
  messageIds: readonly string[],
): Promise<Map<string, TakenView>> {
  const refs = messageIds
    .filter((id) => TAKE_ID_PATTERN.test(id))
    .map((id) => ({ channel: 'gmail' as const, accountId: inboxId, id }));
  if (refs.length === 0) return new Map();
  try {
    return await takenViews(context.core.takes, refs, await takeCallerOf(context));
  } catch {
    return new Map();
  }
}
