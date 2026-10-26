import {
  CommsError,
  type Config,
  gateTake,
  handoffSentence,
  type TakeCaller,
  type TakeGatePass,
  type TakeStore,
  takeRequiredIn,
  takerIdentity,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import type { SlackContext } from '../context.ts';
import type { AppPostRecord } from './app-posts.ts';
import { channelOf } from './people.ts';

/**
 * Taking messages, at Slack's gate (design 2026-10-26-taking-messages §6): which message an act answers, and the check
 * core makes of it — at prepare, before any preview or approval, and again at the claim (`claimOrHandOver`).
 *
 * - **A reaction and an acknowledgement** answer the message they are on.
 * - **A post in a thread** answers the newest message from someone else in that thread — standing-approvals S4's
 *   target, read as `ack` reads a thread, at most ten pages.
 * - **A top-level post in a DM or a group DM** answers the newest message from someone else there.
 * - **Anything else** answers nobody's message and is not gated: a channel's top-level post, an edit or a deletion of
 *   this account's own post, a local draft.
 *
 * "Someone else" is anyone but this account's user and the posts its app made (its app-posts record).
 *
 * A gate built without `take` — a unit test of the gate's own mechanics — asks nothing, as one built without the label
 * acts as before the label: `gateDepsFor`, which every surface uses, always sets it.
 */

type Raw = Record<string, unknown>;

/** What the gate needs to ask about a take: who is acting, the store, and how this surface takes a message. */
export interface SlackTakeGate {
  /** The session acting — worked out by the server or the command itself, never from an argument — or the person. */
  readonly caller: () => Promise<TakeCaller>;
  readonly store: TakeStore;
  /** How a refusal tells this surface to take the message: the tool over MCP, the located command at a terminal. */
  readonly takeWith: (channel: string, ts: string) => string;
}

/** The message an act answers: a conversation and a ts. */
export interface TakeTarget {
  readonly channel: string;
  readonly ts: string;
}

/** What a gate needs of the deps it is built with. */
export interface TakeGateDeps {
  readonly take?: SlackTakeGate | undefined;
  readonly accountId: string;
  readonly workspaceName: string;
  readonly currentConfig: () => Promise<Config>;
}

/** How this surface takes a message, said in a refusal's hint (§6). */
export function takeWithOf(context: SlackContext): (channel: string, ts: string) => string {
  return (channel, ts) =>
    context.surface === 'mcp'
      ? 'slack_take (step "take")'
      : handoffSentence(context.handoffs.own(['take', channel, ts]), (command) => command, {
          instead: 'the take command',
        });
}

/** The gate's take deps for a context: the caller worked out once, on first use. */
export function slackTakeGateFor(context: SlackContext): SlackTakeGate {
  let caller: Promise<TakeCaller> | undefined;
  return {
    caller: () => {
      caller ??= takerIdentity(context.core, context.surface, context.clientInfo?.(), { env: context.env });
      return caller;
    },
    store: context.core.takes,
    takeWith: takeWithOf(context),
  };
}

/**
 * §6: the take of `target` for `act`, as core's gate decides it on the configuration as it is now. Null when there is
 * no target — the act answers nobody's message — or no take deps. `approvalId` pins the take while that approval waits.
 */
export async function requireSlackTake(
  deps: TakeGateDeps,
  target: TakeTarget | null,
  act: string,
  approvalId?: string | undefined,
): Promise<TakeGatePass | null> {
  if (deps.take === undefined || target === null) return null;
  const id = `${target.channel}/${target.ts}`;
  return gateTake(deps.take.store, await deps.currentConfig(), {
    ref: { channel: 'slack', accountId: deps.accountId, id },
    caller: await deps.take.caller(),
    act: { account: deps.workspaceName, shown: id, act, takeWith: deps.take.takeWith(target.channel, target.ts) },
    ...(approvalId === undefined ? {} : { approvalId }),
  });
}

/** At most this many pages of a thread are read for its newest message, as `ack` reads one. */
const THREAD_PAGES = 10;
const PAGE_SIZE = 200;
/** How many of a DM's latest messages are read for its newest from someone else. */
const DM_LATEST = 100;
/** A message Slack made about the conversation, not one anybody wrote to it. */
const NOT_SAID = new Set([
  'channel_join',
  'channel_leave',
  'channel_topic',
  'channel_purpose',
  'channel_name',
  'channel_archive',
  'channel_unarchive',
  'group_join',
  'group_leave',
  'group_topic',
  'group_purpose',
  'group_name',
  'group_archive',
  'group_unarchive',
  'pinned_item',
  'unpinned_item',
  'reminder_add',
]);

const list = (value: unknown): Raw[] =>
  Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null && !Array.isArray(v)) as Raw[]) : [];
const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

/** Slack's ts order: the seconds, then the sequence within them. */
export function compareTs(a: string, b: string): number {
  const [aSeconds = '0', aSequence = '0'] = a.split('.');
  const [bSeconds = '0', bSequence = '0'] = b.split('.');
  const seconds = Number(aSeconds) - Number(bSeconds);
  return seconds !== 0 ? seconds : Number(aSequence.padEnd(6, '0')) - Number(bSequence.padEnd(6, '0'));
}

/** Nothing a gate could read is not an answer: refused, with nothing sent, so it can be tried again. */
function unread(channel: string, cause: unknown): CommsError {
  return new CommsError(
    'TRANSIENT',
    `nothing was sent: Slack could not be asked which message in ${channel} this answers, which decides whose take it needs`,
    {
      hint: 'Try again in a moment: nothing was sent, and no approval was spent.',
      details: { channel, reason: 'take-target-unread' },
      ...(cause === undefined ? {} : { cause }),
    },
  );
}

/** A thread's messages, parent first: `none` when Slack has no such thread there. Refused when it cannot be read whole. */
async function threadMessages(call: SlackCall, channel: string, ts: string): Promise<Raw[] | 'none'> {
  const messages: Raw[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < THREAD_PAGES; page += 1) {
    let response: Raw;
    try {
      response = (await callSlack(call, 'conversations.replies', {
        channel,
        ts,
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      })) as Raw;
    } catch (error) {
      if (page === 0 && error instanceof CommsError && error.details?.slackError === 'thread_not_found') return 'none';
      throw unread(channel, error);
    }
    messages.push(...list(response.messages));
    const next = (response.response_metadata as { next_cursor?: unknown } | undefined)?.next_cursor;
    if (typeof next !== 'string' || next === '') {
      if (response.has_more === true) throw unread(channel, undefined);
      return messages;
    }
    cursor = next;
  }
  throw unread(channel, undefined);
}

/** The newest message in `messages` someone else wrote — not this account's user, and not a post its app made. */
async function newestFromSomeoneElse(
  deps: { readonly postingAs: string; readonly appPosts?: AppPostRecord | undefined },
  channel: string,
  messages: readonly Raw[],
): Promise<TakeTarget | null> {
  const sorted = messages
    .flatMap((message) => {
      const ts = str(message.ts);
      return ts === undefined ? [] : [{ ts, message }];
    })
    .sort((a, b) => compareTs(b.ts, a.ts));
  for (const { ts, message } of sorted) {
    const subtype = str(message.subtype);
    if (subtype !== undefined && NOT_SAID.has(subtype)) continue;
    if (message.user === deps.postingAs) continue;
    if (deps.appPosts !== undefined && (await deps.appPosts.holds({ channel, ts }))) continue;
    return { channel, ts };
  }
  return null;
}

/** Whether a conversation is a DM or a group DM, as Slack says: a `D…` is one; a `G…` is read; anything else is not. */
async function isDirect(call: SlackCall, channel: string): Promise<boolean> {
  if (channel.startsWith('D')) return true;
  if (!channel.startsWith('G')) return false;
  let response: Raw;
  try {
    response = (await callSlack(call, 'conversations.info', { channel })) as Raw;
  } catch (error) {
    throw unread(channel, error);
  }
  const room = channelOf((response.channel as Raw | undefined) ?? {});
  return room.isMpim === true || room.isIm === true;
}

/**
 * The message a post answers (§6): in a thread, the newest message from someone else in it; at the top of a DM or a
 * group DM, the newest from someone else there; anything else, none. A thread Slack does not have is a top-level post
 * there, as Slack would make it.
 *
 * When nothing could stand in the act's way — no take is required in the account, and none is recorded in it — Slack is
 * asked nothing: an account that never uses taking reads nothing more than it did.
 */
export async function postTakeTarget(
  deps: TakeGateDeps & {
    readonly call: SlackCall;
    readonly postingAs: string;
    readonly appPosts?: AppPostRecord | undefined;
  },
  post: { readonly channel: string; readonly threadTs?: string | undefined },
): Promise<TakeTarget | null> {
  if (deps.take === undefined) return null;
  if (!(await takesCanMatter(deps))) return null;
  if (post.threadTs !== undefined) {
    const thread = await threadMessages(deps.call, post.channel, post.threadTs);
    if (thread !== 'none') return newestFromSomeoneElse(deps, post.channel, thread);
  }
  if (!(await isDirect(deps.call, post.channel))) return null;
  let response: Raw;
  try {
    response = (await callSlack(deps.call, 'conversations.history', {
      channel: post.channel,
      limit: DM_LATEST,
    })) as Raw;
  } catch (error) {
    throw unread(post.channel, error);
  }
  return newestFromSomeoneElse(deps, post.channel, list(response.messages));
}

/** Whether a take could stop an act in this account: one is required, or any is recorded. */
async function takesCanMatter(deps: TakeGateDeps): Promise<boolean> {
  if (deps.take === undefined) return false;
  if (takeRequiredIn(await deps.currentConfig(), deps.accountId)) return true;
  return (await deps.take.store.list({ accountId: deps.accountId })).length > 0;
}
