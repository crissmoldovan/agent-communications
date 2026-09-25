import {
  type ApprovalRecord,
  type CanonicalChannelMessage,
  type ChannelPreview,
  type ClaimOptions,
  CommsError,
  canonicalJson,
  type Expectation,
  messageDigest,
  type SendPolicy,
  sha256Hex,
  stricterPolicy,
} from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { spendOn, type WritePermit } from '../api/guard.ts';
import { type ComposedPayload, payloadOf } from '../compose/blocks.ts';
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

/**
 * The flag on a post's approval whose reach could not be counted when it was prepared.
 *
 * Read back as well as shown. The digest binds a reach nobody measured as exactly that, and the approval screen reads
 * this to say so when it voids one — rather than quoting the `0` that stood in for the count as though it were one.
 */
export const REACH_UNKNOWN = 'reach-unknown';

/** Anything about this post a person should look at twice. Flags, never refusals. */
function risksOf(
  payload: { text: string },
  notifies: { channel: boolean; here: boolean; estimated: number; unknown?: string | undefined },
): string[] {
  const flags: string[] = [];
  if (notifies.channel) flags.push('notifies-channel');
  if (notifies.here) flags.push('notifies-here');
  if (notifies.unknown !== undefined) flags.push(REACH_UNKNOWN);
  if (notifies.estimated >= 50) flags.push('large-audience');
  const { references } = decodeSlackText(payload.text);
  if (references.some((reference) => reference.kind === 'link')) flags.push('contains-link');
  return flags;
}

/** A post as it would go now: what a person is shown, and the digest that binds exactly that. */
export interface PostView {
  readonly preview: ChannelPreview;
  readonly digest: string;
  /** Why the room could not be read, when it could not — so its reach is a gap, not a number. */
  readonly roomUnread: string | undefined;
  /** What posts: the one payload the preview was rendered from and the digest was taken over. */
  readonly payload: ComposedPayload;
}

/**
 * What a draft posts: its text, composed again — and only if that is exactly what the draft file holds.
 *
 * The preview is read from `text`. The post sends `blocks` as well, and a client renders the blocks and notifies from
 * them, so a draft whose blocks say something its text does not would be shown as one message and posted as another —
 * approved on the strength of words nobody would see, reaching people the preview never counted. The composer cannot
 * write one; a file edited by hand can, and anything with a shell can edit it. So the payload is made again from
 * `text` by the composer that made it, and a draft that is not byte for byte that payload — blocks, flags, or a field
 * nothing here writes — is refused before anyone is shown anything. Checked here because preparing, the approval
 * screen and posting all come through `viewPost`: no surface can show or send a draft this has not passed.
 */
export function postedPayload(draft: SlackDraft): ComposedPayload {
  const stored = draft.payload;
  const posted = payloadOf(stored.text, stored.channel, stored.thread_ts);
  if (canonicalJson(stored) !== canonicalJson(posted)) {
    throw new CommsError(
      'BAD_DATA',
      `nothing was sent: draft "${draft.draftId}" is not what its text composes to, so its preview would not be what posts`,
      {
        hint: `It was changed outside agent-slack. Delete it with \`agent-slack draft delete ${draft.draftId} --workspace <name>\` and compose it again.`,
        details: { draftId: draft.draftId, reason: 'not-composed' },
      },
    );
  }
  return posted;
}

/**
 * Reads the room once and builds both halves from that one reading.
 *
 * One function for the three places that need them — preparing, the approval screen, and posting. They were two
 * copies, and the approval screen, which had neither, rendered a room of four hundred as a count it could not read:
 * the person typing the code was never shown the reach their approval bound. Built in one place, what is shown and
 * what is bound cannot drift apart between the three.
 */
export async function viewPost(
  deps: Pick<PrepareDeps, 'call' | 'workspaceId' | 'workspaceName' | 'postingAs'>,
  draft: SlackDraft,
  book: NameBook,
): Promise<PostView> {
  // Before Slack is asked anything: a draft that is not what its text composes to is shown to nobody.
  const payload = postedPayload(draft);
  const { channel, members, why } = await roomOf(deps.call, payload.channel);
  if (channel) book.addChannel(channel);

  const preview = previewOf({
    // Rendered from the payload that posts, not from the file it was checked against.
    draft: { ...draft, payload },
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
    // The exact bytes `postPrepared` sends, so a change to any field of them counts as a change.
    payloadSha256: sha256Hex(JSON.stringify(payload)),
    notifies: {
      here: preview.notifies.here,
      channel: preview.notifies.channel,
      // Ids, not the names the preview shows — see `mentionedUserIds`.
      users: mentionedUserIds(payload.text),
      estimated: preview.notifies.estimated,
      // A reach nobody could count is bound as that, not as the `0` that stands in for it — see `roomOf`.
      unmeasured: preview.notifies.unknown !== undefined,
    },
    attachments: [],
  };
  return { preview, digest: messageDigest(canonical), roomUnread: why, payload };
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
  const { preview, digest, payload } = await viewPost(deps, draft, book);

  const riskFlags = risksOf(payload, preview.notifies);
  /*
   * A broadcast raises the ceremony by itself.
   *
   * Under `chat` policy an ordinary message is agreed to in the conversation. `@channel` to four hundred people
   * is not an ordinary message, and the person who would be interrupted is not in the conversation to object.
   * `@here` is a broadcast too: it reaches whoever is online, which nothing here can count, and leaving it out let one
   * to a small room go on a yes in the chat.
   *
   * So does a reach nobody could count. A user group, or any mention the preview cannot put a number on, used to go on
   * a yes in the chat with its reach shown as zero; a person approving it at a terminal is told it is not known.
   */
  const broadcast = preview.notifies.channel || preview.notifies.here;
  const requiredPolicy: SendPolicy =
    broadcast || preview.notifies.estimated >= 50 || preview.notifies.unknown !== undefined ? 'confirm' : 'chat';

  const record = await deps.approvals.create({
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: draft.draftId,
    draftMessageId: draft.revision,
    digest,
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
      options?: ClaimOptions,
    ): Promise<ApprovalRecord>;
    complete(approvalId: string, outcome: { sentMessageId: string } | { error: string }): Promise<ApprovalRecord>;
  };
}

export interface PostedMessage {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
}

/** The command a person runs to approve at their own terminal. The same whichever surface asked. */
export function approveCommand(approvalId: string): string {
  return `agent-slack approve ${approvalId}`;
}

/**
 * What the caller is told while an approval waits for a person, in the words of the surface it is using.
 *
 * The person's step is the same from either surface: `agent-slack approve` is a terminal command, and under
 * `confirm` that is the point of it. The agent's next step is not. A CLI caller runs its command again, and an MCP
 * caller calls its tool — telling an agent in a chat to run `agent-slack post send` would send it looking for a shell
 * it may not have, to take a step its own tool takes. No input is echoed: the emoji and the channel are the caller's
 * own, and this may be printed at a terminal.
 */
function waitingHint(kind: 'post' | 'reaction', surface: 'cli' | 'mcp' | undefined, approvalId: string): string {
  const show =
    kind === 'post' ? 'Show the user the preview, then' : 'Tell the user which emoji and which message, then';
  const again =
    surface === 'mcp'
      ? kind === 'post'
        ? 'call `slack_post_send` again with the same arguments'
        : `call \`slack_react_send\` with approvalId ${approvalId} and the same channel, ts and emoji`
      : kind === 'post'
        ? 'run the same `agent-slack post send` again'
        : `run the same \`agent-slack react\` command again with \`--approval ${approvalId}\` added`;
  return `${show} ask them to run \`${approveCommand(approvalId)}\` in their own terminal. When they have, ${again}. You cannot approve this yourself.`;
}

/**
 * Claims an approval, and when it is waiting for a person, says so with the command they run as data.
 *
 * The hint is prose for whoever reads it. An agent relaying the step to a person should not have to dig a command out
 * of a sentence, so the wait carries it in `details.command` too — from both surfaces, because both come through here.
 * Everything else the claim throws goes out exactly as the store threw it.
 */
async function claimOrHandOver(
  deps: PostDeps,
  approvalId: string,
  live: Parameters<PostDeps['approvals']['claimForSend']>[1],
  pendingHint: string,
): Promise<void> {
  try {
    await deps.approvals.claimForSend(approvalId, live, { pendingHint });
  } catch (error) {
    if (!(error instanceof CommsError) || error.code !== 'APPROVAL_PENDING') throw error;
    throw new CommsError(error.code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      details: { ...error.details, command: approveCommand(approvalId) },
    });
  }
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
  expectChannel: string,
  book: NameBook,
): Promise<PostedMessage> {
  /*
   * The caller restates the destination; this builds the rest.
   *
   * It used to take the whole `Expectation`, which meant the CLI had to reconstruct a value `preparePost` had
   * composed — and it reconstructed it wrongly, with an empty subject against the stored `reaches N`. The command
   * therefore refused every post it was given, and no test saw it because the tests called this function directly
   * with the value `preparePost` had returned. A caller can honestly say which channel it believes it is posting
   * to; it cannot honestly restate a reach it did not measure, so it no longer pretends to.
   */
  if (expectChannel !== draft.payload.channel) {
    throw new CommsError(
      'APPROVAL_VOID',
      `nothing was sent: this draft posts to ${draft.payload.channel}, not ${expectChannel}`,
      {
        hint: 'Check the channel in the preview, then pass that one.',
      },
    );
  }
  // The payload sent below is this one: checked against the file, previewed, and the one the digest is taken over.
  const { preview, digest, payload } = await viewPost(deps, draft, book);

  await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: draft.revision,
      digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      policy: deps.policy,
      // Built from the live values, the same way `preparePost` built the stored one — one source, so they agree.
      expect: expectationFor(payload, preview.notifies),
    },
    waitingHint('post', deps.surface, approvalId),
  );

  try {
    const response = await spendOn(deps.permit, approvalId, 'chat.postMessage', () =>
      callSlack({ ...deps.call, permit: deps.permit }, 'chat.postMessage', {
        channel: payload.channel,
        text: payload.text,
        blocks: JSON.stringify(payload.blocks),
        thread_ts: payload.thread_ts,
        unfurl_links: payload.unfurl_links,
        unfurl_media: payload.unfurl_media,
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

/** Where a reaction's approval says what it is for, in place of the draft a post has. */
function reactionDraftId(options: ReactionOptions): string {
  return `reaction:${options.channel}:${options.ts}`;
}

/**
 * The reaction an approval was prepared for, read back from the record — or `undefined` when it is a post's.
 *
 * A reaction has no draft file: what it is lives in the record itself, spread over fields the approval store
 * already has — the message in the draft id, the emoji in the expectation, a removal in the risk flags. Approving
 * one used to read `draftId` as a draft, which it is not, so every reaction under `confirm` was refused at the
 * approval screen and could never be made.
 *
 * What comes back is only believed once it reproduces the record's own digest. That is what makes the one line a
 * person reads the act the approval permits, rather than a reading of some fields that happen to sit near it.
 */
export function reactionOfApproval(record: ApprovalRecord, workspaceId: string): ReactionOptions | undefined {
  const where = /^reaction:([^:]+):(.+)$/.exec(record.draftId);
  if (!where) return undefined;
  const what = /^:(.+): on (.+)$/.exec(record.expect.subject);
  const options: ReactionOptions = {
    channel: where[1] ?? '',
    ts: where[2] ?? '',
    name: what?.[1] ?? '',
    remove: record.riskFlags.includes('removes-reaction'),
  };
  if (!what || reactionDigest({ workspaceId, postingAs: record.inboxSub ?? '' }, options) !== record.digest) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the reaction it is bound to', {
      hint: 'Nothing was approved. Run the `agent-slack react` command again for a new approval.',
      details: { approvalId: record.approvalId },
    });
  }
  return options;
}

export async function prepareReaction(deps: PrepareDeps, options: ReactionOptions): Promise<PreparedReaction> {
  if (deps.policy === 'never') {
    throw new CommsError('POLICY_NEVER', 'posting is turned off for this workspace (policy: never)');
  }
  const digest = reactionDigest(deps, options);
  const record = await deps.approvals.create({
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: reactionDraftId(options),
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
  await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: digest,
      digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      policy: deps.policy,
      expect: reactionExpectation(options),
    },
    waitingHint('reaction', deps.surface, approvalId),
  );
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
