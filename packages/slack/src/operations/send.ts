import {
  type ApprovalRecord,
  type CanonicalChannelMessage,
  type ChannelPreview,
  CommsError,
  type Expectation,
  messageDigest,
  type SendPolicy,
  sha256Hex,
  stricterPolicy,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { spendOn, type WritePermit } from '../api/guard.ts';
import type { SlackDraft } from '../compose/drafts.ts';
import { mentionedUserIds, previewOf } from '../compose/preview.ts';
import { decodeSlackText } from '../text/decode.ts';
import { type Channel, channelOf, type NameBook } from './people.ts';

/**
 * The gate between a draft and a channel.
 *
 * The same shape as Gmail's, because it is the same problem and the Gmail one has been audited: prepare produces
 * an approval bound to exactly these bytes, the person is shown what will be posted, and posting claims the
 * approval once and spends a permit that is open for one request.
 *
 * Two things differ, and both come from Slack rather than from taste.
 *
 * **The gate has four doors, not one.** Gmail could guard sending by looking for a URL ending in `/send`. Slack
 * has four separate ways to put something in front of people, only one of which needs `chat:write` — a file share
 * carries an `initial_comment`, which is a message; a reaction notifies somebody and is attributed to them. All of
 * them are behind the permit, which is why the allowlist classifies methods rather than matching a path.
 *
 * **The reach is inside the digest.** A mail preview lists its recipients; a channel preview has to count them.
 * If the room grew between the preview and the post, the message now reaches people nobody agreed to reach, and
 * the approval is void rather than merely stale.
 */

/** What a caller restates at post time, so it cannot post something other than what it showed. */
export function expectationFor(payload: { channel: string }, notifies: { estimated: number }): Expectation {
  /*
   * Slack's shape, in the fields the approval store already has.
   *
   * `to` is where it goes and `subject` carries the reach, because those are the two facts a caller could get
   * wrong in a way that matters: the wrong room, or a far bigger room than the one it showed. Mapped rather than
   * invented so this uses the same single-claim, same-digest machinery the Gmail gate does, which has been
   * audited; a parallel implementation for chat would be a second place for the same bug to live.
   */
  return { to: [payload.channel], cc: [], bcc: [], subject: `reaches ${notifies.estimated}` };
}

export interface PreparedPost {
  readonly approvalId: string;
  readonly draftId: string;
  readonly preview: ChannelPreview;
  readonly expect: Expectation;
  readonly policy: SendPolicy;
  readonly requiredPolicy: SendPolicy;
  readonly riskFlags: readonly string[];
  readonly expiresAt: string;
}

/**
 * Where the gate writes what it did.
 *
 * Gmail records every operation; the first version of this file recorded none, so `agentcomms audit tail` showed
 * nothing at all for a Slack workspace and there was no answer to "what did it post, and when". Optional only so
 * a unit test can leave it out; every real caller passes one.
 */
export interface AuditSink {
  append(record: {
    inboxId: string;
    alias?: string;
    operation: string;
    outcome: 'ok' | 'refused' | 'failed' | 'started';
    ids?: Record<string, string | string[]>;
    approvalId?: string;
    reason?: string;
    surface?: 'cli' | 'mcp';
  }): Promise<unknown>;
}

export interface PrepareDeps {
  readonly call: SlackCall;
  readonly audit?: AuditSink | undefined;
  readonly surface?: 'cli' | 'mcp' | undefined;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly workspaceName: string;
  /** The user id this posts as. In the digest: two accounts in one workspace are two different people speaking. */
  readonly postingAs: string;
  readonly policy: SendPolicy;
  readonly approvals: {
    create(input: {
      inboxId: string;
      inboxSub?: string | undefined;
      draftId: string;
      draftMessageId: string;
      digest: string;
      policy: SendPolicy;
      requiredPolicy: SendPolicy;
      riskFlags: string[];
      expect: Expectation;
    }): Promise<ApprovalRecord>;
  };
}

/** The channel, and how many people are in it — or why that could not be established. */
async function roomOf(
  call: SlackCall,
  channelId: string,
): Promise<{ channel: Channel | undefined; members: number | undefined; why: string | undefined }> {
  try {
    const response = await callSlack(call, 'conversations.info', { channel: channelId, include_num_members: true });
    const channel = channelOf((response.channel as Record<string, unknown> | undefined) ?? {});
    return { channel, members: channel.memberCount, why: undefined };
  } catch (error) {
    /*
     * Never guessed.
     *
     * A count this could not read is reported as unreadable, not as zero and not as a small number. The whole
     * value of the figure is that somebody is about to agree to it, and a number nobody measured is worse than an
     * honest gap — it reads exactly like one that was measured.
     */
    return { channel: undefined, members: undefined, why: (error as Error).message };
  }
}

/** Anything about this post a person should look at twice. Flags, never refusals. */
function risksOf(
  payload: { text: string },
  notifies: { channel: boolean; here: boolean; estimated: number },
): string[] {
  const flags: string[] = [];
  if (notifies.channel) flags.push('notifies-channel');
  if (notifies.here) flags.push('notifies-here');
  if (notifies.estimated >= 50) flags.push('large-audience');
  const { references } = decodeSlackText(payload.text);
  if (references.some((reference) => reference.kind === 'link')) flags.push('contains-link');
  return flags;
}

/**
 * Prepares one post, and shows what it will be.
 *
 * Nothing is posted here and nothing can be: the permit stays closed, and the only Slack call made is a read of
 * the channel so the reach can be counted.
 */
export async function preparePost(deps: PrepareDeps, draft: SlackDraft, book: NameBook): Promise<PreparedPost> {
  if (deps.policy === 'never') {
    throw new CommsError('POLICY_NEVER', 'posting is turned off for this workspace (policy: never)', {
      hint: 'The preview below is pasteable — send it yourself in Slack, or change the policy at a terminal.',
    });
  }
  const payload = draft.payload;
  const { channel, members, why } = await roomOf(deps.call, payload.channel);
  if (channel) book.addChannel(channel);

  const preview = previewOf({
    draft,
    workspace: deps.workspaceName,
    postingAs: deps.postingAs,
    channel,
    book,
    memberCount: members,
    countUnknown: why,
  });

  const canonical: CanonicalChannelMessage = {
    kind: 'channel',
    workspace: deps.workspaceId,
    postingAs: deps.postingAs,
    channel: payload.channel,
    ...(channel?.name?.text ? { channelName: channel.name.text } : {}),
    ...(payload.thread_ts ? { threadTs: payload.thread_ts } : {}),
    visibleText: preview.body,
    // The exact bytes, so a change to the blocks that the visible text does not show still counts as a change.
    payloadSha256: sha256Hex(JSON.stringify(payload)),
    notifies: {
      here: preview.notifies.here,
      channel: preview.notifies.channel,
      // Ids, not the names the preview shows — see `mentionedUserIds`.
      users: mentionedUserIds(payload.text),
      estimated: preview.notifies.estimated,
    },
    attachments: [],
  };

  const riskFlags = risksOf(payload, preview.notifies);
  /*
   * A broadcast raises the ceremony by itself.
   *
   * Under `chat` policy an ordinary message is agreed to in the conversation. `@channel` to four hundred people
   * is not an ordinary message, and the person who would be interrupted is not in the conversation to object.
   */
  const requiredPolicy: SendPolicy = preview.notifies.channel || preview.notifies.estimated >= 50 ? 'confirm' : 'chat';

  const record = await deps.approvals.create({
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: draft.draftId,
    draftMessageId: draft.revision,
    digest: messageDigest(canonical),
    policy: deps.policy,
    requiredPolicy,
    riskFlags,
    expect: expectationFor(payload, preview.notifies),
  });

  await deps.audit?.append({
    inboxId: deps.accountId,
    alias: deps.workspaceName,
    operation: 'slack.post.prepare',
    outcome: 'started',
    ids: { channel: payload.channel, draftId: draft.draftId },
    approvalId: record.approvalId,
    ...(deps.surface ? { surface: deps.surface } : {}),
  });

  return {
    approvalId: record.approvalId,
    draftId: draft.draftId,
    preview: {
      ...preview,
      context: { ...preview.context, approvalId: record.approvalId },
      policy: describePolicy(stricterPolicy(deps.policy, requiredPolicy)),
    },
    expect: record.expect,
    policy: deps.policy,
    requiredPolicy,
    riskFlags,
    expiresAt: record.expiresAt,
  };
}

function describePolicy(policy: SendPolicy): string {
  switch (policy) {
    case 'never':
      return 'nothing can be posted from this workspace';
    case 'confirm':
      return 'this needs a person to approve it at a terminal before it posts';
    default:
      return 'say yes and it posts';
  }
}

export interface PostDeps extends PrepareDeps {
  readonly permit: WritePermit;
  readonly approvals: PrepareDeps['approvals'] & {
    claimForSend(
      approvalId: string,
      live: {
        draftMessageId: string;
        digest: string;
        inboxId: string;
        inboxSub?: string | undefined;
        policy: SendPolicy;
        expect: Expectation;
      },
    ): Promise<ApprovalRecord>;
    complete(approvalId: string, outcome: { sentMessageId: string } | { error: string }): Promise<ApprovalRecord>;
  };
}

export interface PostedMessage {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
}

/**
 * Posts one prepared message, once.
 *
 * Everything that could refuse it has refused before Slack is reached: the approval is claimed under a lock with
 * an `O_EXCL` marker that makes the claim single-use across processes, the digest is recomputed from the draft as
 * it is *now*, and the permit is opened around exactly one request and closed in a `finally` — so a write that
 * throws halfway leaves no door open behind it.
 */
export async function postPrepared(
  deps: PostDeps,
  draft: SlackDraft,
  approvalId: string,
  expect: Expectation,
  book: NameBook,
): Promise<PostedMessage> {
  const payload = draft.payload;
  const { channel, members, why } = await roomOf(deps.call, payload.channel);
  if (channel) book.addChannel(channel);
  const preview = previewOf({
    draft,
    workspace: deps.workspaceName,
    postingAs: deps.postingAs,
    channel,
    book,
    memberCount: members,
    countUnknown: why,
  });

  const canonical: CanonicalChannelMessage = {
    kind: 'channel',
    workspace: deps.workspaceId,
    postingAs: deps.postingAs,
    channel: payload.channel,
    ...(channel?.name?.text ? { channelName: channel.name.text } : {}),
    ...(payload.thread_ts ? { threadTs: payload.thread_ts } : {}),
    visibleText: preview.body,
    payloadSha256: sha256Hex(JSON.stringify(payload)),
    notifies: {
      here: preview.notifies.here,
      channel: preview.notifies.channel,
      users: mentionedUserIds(payload.text),
      estimated: preview.notifies.estimated,
    },
    attachments: [],
  };

  await deps.approvals.claimForSend(approvalId, {
    draftMessageId: draft.revision,
    digest: messageDigest(canonical),
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    policy: deps.policy,
    expect,
  });

  try {
    const response = await spendOn(deps.permit, approvalId, 'chat.postMessage', () =>
      callSlack({ ...deps.call, permit: deps.permit }, 'chat.postMessage', {
        channel: payload.channel,
        text: payload.text,
        blocks: JSON.stringify(payload.blocks),
        thread_ts: payload.thread_ts,
        unfurl_links: false,
        unfurl_media: false,
      }),
    );
    const ts = typeof response.ts === 'string' ? response.ts : '';
    await deps.approvals.complete(approvalId, { sentMessageId: ts });
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: 'slack.post',
      outcome: 'ok',
      ids: { channel: payload.channel, ts },
      approvalId,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
    return { approvalId, channel: payload.channel, ts };
  } catch (error) {
    // Recorded before it is rethrown: an approval left in `sending` is one whose outcome nobody knows.
    await deps.approvals.complete(approvalId, { error: (error as Error).message });
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: 'slack.post',
      outcome: 'failed',
      ids: { channel: payload.channel },
      approvalId,
      reason: (error as Error).message,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
    throw error;
  }
}

/**
 * A reaction, at lower ceremony — D6.
 *
 * Adding one notifies a person and is attributed to them, so it is a post and goes through the same approval
 * machinery as a message: an approval bound to this emoji, on this message, claimed once. What is *lower* about
 * the ceremony is the preview, not the gate — a reaction is one line rather than a rendered message, and putting
 * it through the full preview-and-approve flow would train people to approve without reading, which costs more
 * safety than it buys.
 *
 * An earlier version took an `approvalId` and never created or claimed one, so any string opened the door. The
 * distinction D6 draws between `chat` and `confirm` was not implemented either: both simply went.
 */
export interface PreparedReaction {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
  readonly name: string;
  readonly remove: boolean;
  readonly requiredPolicy: SendPolicy;
  readonly expect: Expectation;
}

/** What a reaction's approval is bound to: this emoji, on this message, in this workspace, as this account. */
function reactionDigest(deps: { workspaceId: string; postingAs: string }, options: ReactionOptions): string {
  return sha256Hex(
    JSON.stringify({
      kind: 'reaction',
      workspace: deps.workspaceId,
      postingAs: deps.postingAs,
      channel: options.channel,
      ts: options.ts,
      name: options.name,
      remove: options.remove === true,
    }),
  );
}

export interface ReactionOptions {
  readonly channel: string;
  readonly ts: string;
  readonly name: string;
  readonly remove?: boolean | undefined;
}

function reactionExpectation(options: ReactionOptions): Expectation {
  return { to: [options.channel], cc: [], bcc: [], subject: `:${options.name}: on ${options.ts}` };
}

export async function prepareReaction(deps: PrepareDeps, options: ReactionOptions): Promise<PreparedReaction> {
  if (deps.policy === 'never') {
    throw new CommsError('POLICY_NEVER', 'posting is turned off for this workspace (policy: never)');
  }
  const digest = reactionDigest(deps, options);
  const record = await deps.approvals.create({
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: `reaction:${options.channel}:${options.ts}`,
    // No draft to edit, so the reaction's own digest stands in: the same value means the same act.
    draftMessageId: digest,
    digest,
    policy: deps.policy,
    /*
     * A reaction never raises its own ceremony.
     *
     * A message can, because a broadcast reaches a room. A reaction reaches the one person who wrote the
     * message, so the workspace's own policy decides: `chat` is a yes in the conversation, `confirm` is the same
     * typed approval a message needs.
     */
    requiredPolicy: 'chat',
    riskFlags: options.remove ? ['removes-reaction'] : [],
    expect: reactionExpectation(options),
  });
  return {
    approvalId: record.approvalId,
    channel: options.channel,
    ts: options.ts,
    name: options.name,
    remove: options.remove === true,
    requiredPolicy: 'chat',
    expect: record.expect,
  };
}

/** Applies one prepared reaction, once, through the permit. */
export async function reactPrepared(
  deps: PostDeps,
  approvalId: string,
  options: ReactionOptions,
): Promise<{ approvalId: string }> {
  const digest = reactionDigest(deps, options);
  await deps.approvals.claimForSend(approvalId, {
    draftMessageId: digest,
    digest,
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    policy: deps.policy,
    expect: reactionExpectation(options),
  });
  const method = options.remove ? 'reactions.remove' : 'reactions.add';
  try {
    await spendOn(deps.permit, approvalId, method, () =>
      callSlack({ ...deps.call, permit: deps.permit }, method, {
        channel: options.channel,
        timestamp: options.ts,
        name: options.name,
      }),
    );
    await deps.approvals.complete(approvalId, { sentMessageId: options.ts });
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: options.remove ? 'slack.reaction.remove' : 'slack.reaction.add',
      outcome: 'ok',
      ids: { channel: options.channel, ts: options.ts, emoji: options.name },
      approvalId,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
    return { approvalId };
  } catch (error) {
    await deps.approvals.complete(approvalId, { error: (error as Error).message });
    throw error;
  }
}
