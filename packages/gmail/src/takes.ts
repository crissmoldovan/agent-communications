import {
  gateTake,
  handoffSentence,
  TAKE_ID_PATTERN,
  type TakeCaller,
  type TakeGatePass,
  type TakenView,
  takenViews,
  takeRequiredIn,
  takerIdentity,
} from '@agentcomms/core';
import type { GmailContext, ResolvedInbox } from './context.ts';
import type { GmailTransport } from './gmail-api/transport.ts';

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

/** Labels that make a message in a thread none this mailbox received: its own, or mail it set aside as Spam or Trash. */
const NOT_RECEIVED: ReadonlySet<string> = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH']);

/**
 * The message a reply to one of this mailbox's own messages answers, by the thread it goes into (security review of
 * 0.35.0): a follow-up to its own sent mail goes to the same people in the same thread, so the thread's take still
 * applies. It is refused while another session has any message in that thread this mailbox received — taking that
 * thread's latest message cannot get round another's take of an earlier one — and it answers the newest of them, as a
 * Slack post in a thread answers its newest message from someone else. Undefined when the thread holds none: a
 * follow-up to its own mail alone answers nobody's.
 *
 * Gmail is asked only where a take could matter — the mailbox requires one, or holds any — so a mailbox that never uses
 * taking reads nothing more than before.
 */
export async function threadAnswered(
  context: GmailContext,
  transport: GmailTransport,
  resolved: ResolvedInbox,
  threadId: string | null | undefined,
): Promise<string | undefined> {
  if (typeof threadId !== 'string' || threadId === '') return undefined;
  const matters =
    takeRequiredIn(await context.config(), resolved.inbox.id) ||
    (await context.core.takes.recordsIn(resolved.inbox.id));
  if (!matters) return undefined;
  const thread = await transport.getThread(threadId);
  const received = (thread.messages ?? []).flatMap((message, index) =>
    typeof message.id === 'string' &&
    TAKE_ID_PATTERN.test(message.id) &&
    !(message.labelIds ?? []).some((label) => NOT_RECEIVED.has(label))
      ? [{ id: message.id, at: Number(message.internalDate ?? Number.NaN), index }]
      : [],
  );
  await refuseGmailHeldElsewhere(
    context,
    resolved,
    received.map((message) => message.id),
  );
  // Newest by Gmail's internal date; one without a date counts as oldest, and a tie goes to the later in the thread.
  const time = (at: number) => (Number.isFinite(at) ? at : Number.NEGATIVE_INFINITY);
  return [...received].sort((a, b) => time(a.at) - time(b.at) || a.index - b.index).at(-1)?.id;
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
