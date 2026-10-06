import { setTimeout as sleep } from 'node:timers/promises';
import {
  type ApprovalExpectation,
  type ApprovalObject,
  type ApprovalOutcome,
  type ApprovalRecord,
  type AttachPolicy,
  approveAndWaitSentence,
  type CanonicalChannelMessage,
  type ChannelPreview,
  type ClaimOptions,
  type CliHandoffs,
  CommsError,
  type CreateApprovalInput,
  canonicalJson,
  type Expectation,
  fenceOrStop,
  type Handoff,
  handoffSentence,
  handoffSentenceToFill,
  LEASE_LOST_BEFORE_SEND,
  messageDigest,
  type OutcomeAction,
  type SendClaim,
  type SendOutcome,
  type SendPolicy,
  type StoredApproval,
  sha256Hex,
  stricterPolicy,
  truncateDisplay,
  withApproval,
  withSendingLease,
} from '@agentcomms/core';
import { callSlack, certainlyRefused, type PostingMethod, type SlackCall, type SlackResponse } from '../api/call.ts';
import { spendOn, type WritePermit } from '../api/guard.ts';
import { slackFileUpload } from '../api/upload.ts';
import { type ComposedPayload, payloadOf } from '../compose/blocks.ts';
import type { SlackDraft } from '../compose/drafts.ts';
import { checkRecordedFile, rereadFile, type SlackDraftFile } from '../compose/files.ts';
import { mentionedUserIds, previewOf, urlsInWords } from '../compose/preview.ts';
import { decodeSlackText } from '../text/decode.ts';
import { requireConversation } from './destination.ts';
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
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat posts it. */
  readonly approval: ApprovalObject;
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
  /**
   * The commands a refusal or a wait names — Slack's own `approve`, `draft update`, `workspace mode` — located from this
   * installation and quoted for the shell the output is for (`SlackContext.handoffs`). Never in the digest.
   */
  readonly handoffs: CliHandoffs;
  /** The user id this posts as. In the digest: two accounts in one workspace are two different people speaking. */
  readonly postingAs: string;
  readonly policy: SendPolicy;
  /**
   * The account's send epoch as the configuration holds it now (`sendEpochOf`), stored on every approval this prepares
   * and bound: a `never` set after the prepare leaves it behind for good.
   */
  readonly sendEpoch: number;
  /**
   * What the workspace was connected as, and what Slack granted it — for a post with files, which needs both `send` and
   * `files:write`. Read from the configuration by `gateDepsFor`; a post of text alone does not look at them.
   */
  readonly mode?: string | undefined;
  readonly grantedScopes?: readonly string[] | undefined;
  /** Which local files may be sent: the attachment jail's folders, as `attachPolicyOf` reads them. */
  readonly attachPolicy?: AttachPolicy | undefined;
  readonly approvals: {
    create(input: CreateApprovalInput): Promise<ApprovalRecord>;
    /** D8's object for a record this call just wrote or finished: what its result reports. */
    approvalOf(record: ApprovalRecord): Promise<ApprovalObject>;
  };
}

/** The channel, and how many people are in it — or why that could not be established. */
export async function roomOf(
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
 * Refuses a post to a room this account has not joined — issue #43.
 *
 * A post to a room this account has not joined puts the person into a conversation they are not part of, under their
 * name — an agent that picked the wrong room — and Slack cannot be relied on to refuse it first. So a room that was
 * read, and does not say it counts this account as a member, is refused.
 *
 * A direct message and a group DM are exempt by what they are, never by `is_member`: Slack leaves that field out of a
 * DM's answer, and `channelOf` reads a missing field as false, so checking the field alone would refuse every DM. A
 * room that could not be read is not refused here — nothing is known about it — and its preview says membership was
 * not checked (see `previewOf`).
 *
 * `SCOPE_MISSING`, the code Slack's own `not_in_channel` maps to in `callSlack`: the same fact, found before Slack is
 * asked to post rather than after.
 */
function requireMember(channel: Channel, channelId: string): void {
  if (channel.isIm || channel.isMpim || channel.isMember) return;
  const name = channel.name?.text;
  const named = name ? `#${truncateDisplay(name, 80)} (${channelId})` : channelId;
  throw new CommsError('SCOPE_MISSING', `nothing was sent: this account is not a member of ${named}`, {
    hint: 'Join the channel in Slack yourself, then prepare the post again: nothing here joins a channel for you.',
    details: { channel: channelId, reason: 'not-a-member' },
  });
}

/**
 * The flag on a post's approval whose reach could not be counted when it was prepared.
 *
 * Read back as well as shown. The digest binds a reach nobody measured as exactly that, and the approval screen reads
 * this to say so when it voids one — rather than quoting the `0` that stood in for the count as though it were one.
 */
export const REACH_UNKNOWN = 'reach-unknown';

/** The flag on a post's approval that carries files: what the approval screen and the audit can tell a file post by. */
export const CONTAINS_FILES = 'contains-files';

/**
 * The flag on a post with files whose words hold a link, which Slack may unfurl for the whole room — issue #44. Its
 * preview warns about it; see `unfurlWarnings`.
 */
export const LINK_MAY_UNFURL = 'link-may-unfurl';

/** Anything about this post a person should look at twice. Flags, never refusals. */
export function risksOf(
  payload: { text: string },
  notifies: { channel: boolean; here: boolean; estimated: number; unknown?: string | undefined },
  files: number,
): string[] {
  const flags: string[] = [];
  if (files > 0) flags.push(CONTAINS_FILES);
  if (notifies.channel) flags.push('notifies-channel');
  if (notifies.here) flags.push('notifies-here');
  if (notifies.unknown !== undefined) flags.push(REACH_UNKNOWN);
  if (notifies.estimated >= 50) flags.push('large-audience');
  const { references } = decodeSlackText(payload.text);
  if (references.some((reference) => reference.kind === 'link')) flags.push('contains-link');
  // Only with files: a message posts with unfurling off, and its flags are what they always were.
  if (files > 0 && urlsInWords(payload.text).length > 0) flags.push(LINK_MAY_UNFURL);
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
 *
 * The thread is checked for being a string first, because it is the one field composed again *from* the file rather
 * than against it: a `thread_ts` the file holds as a number went back into the payload as that number, compared equal
 * to itself, and passed — to fail inside the digest as UNEXPECTED, where the gate's refusal belonged, and as `null` to
 * prepare as a message outside any thread. The composer writes a string or nothing; anything else was written by hand.
 * (`text` and `channel` are checked to be strings when the file is read — see `isDraftShaped`.)
 */
export function postedPayload(draft: SlackDraft, handoffs: CliHandoffs): ComposedPayload {
  const stored = draft.payload;
  const threadTs: unknown = stored.thread_ts;
  if (threadTs !== undefined && typeof threadTs !== 'string') throw notComposed(draft, handoffs);
  const posted = payloadOf(stored.text, stored.channel, threadTs);
  if (canonicalJson(stored) !== canonicalJson(posted)) throw notComposed(draft, handoffs);
  return posted;
}

/** The gate's refusal of a draft that is not what its text composes to — one wording, whichever part of it differs. */
function notComposed(draft: SlackDraft, handoffs: CliHandoffs): CommsError {
  return new CommsError(
    'BAD_DATA',
    `nothing was sent: draft "${draft.draftId}" is not what its text composes to, so its preview would not be what posts`,
    { hint: changedOutsideHint(draft.draftId, handoffs), details: { draftId: draft.draftId, reason: 'not-composed' } },
  );
}

/**
 * What to do about a draft file changed outside agent-slack: there is no mending one, only composing it again.
 *
 * One sentence for every place that finds one — the gate, and `draft show` and `slack_draft_get`, which show a draft as
 * the gate would post it — so the advice cannot differ between showing a draft and trying to post it.
 */
export function changedOutsideHint(draftId: string, handoffs: CliHandoffs): string {
  const remove = handoffSentenceToFill(
    handoffs.own(['draft', 'delete', draftId, '--workspace']),
    ['<name>'],
    (command) => `Delete it with ${command} and compose it again.`,
    { instead: 'Delete it with slack_draft_delete from a chat and compose it again.' },
  );
  return `It was changed outside agent-communications. ${remove}`;
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
  deps: Pick<PrepareDeps, 'call' | 'workspaceId' | 'workspaceName' | 'postingAs' | 'handoffs'>,
  draft: SlackDraft,
  book: NameBook,
): Promise<PostView> {
  // Before Slack is asked anything: a draft that is not what its text composes to is shown to nobody.
  const payload = postedPayload(draft, deps.handoffs);
  // A draft stored before 0.12.0, or written by hand, may name a user: refused here too, before Slack is asked.
  requireConversation(payload.channel, deps.workspaceName, deps.handoffs);
  const { channel, members, why } = await roomOf(deps.call, payload.channel);
  // Here, so preparing, the approval screen and posting all refuse it — and posting before the approval is claimed.
  if (channel) requireMember(channel, payload.channel);
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
    membershipUnchecked: why,
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
    /*
     * Each file as it will leave — the name Slack shows, its type, its size and its hash — so a file whose bytes change
     * is a different post, and its approval is void. Empty for a post of text alone, which is the digest it always was.
     */
    attachments: (draft.files ?? []).map((file) => ({
      filename: file.name,
      mimeType: file.mimeType,
      size: file.size,
      sha256: file.sha256,
    })),
  };
  return { preview, digest: messageDigest(canonical), roomUnread: why, payload };
}

/**
 * Refuses a post with files from a workspace that cannot send one: connected to read, or not granted `files:write`.
 *
 * Checked at prepare, so nobody is shown a preview they could never post, and again at send, because the grant can
 * narrow in between. Slack would refuse it anyway — a `read` token holds no posting scope — but only after the bytes had
 * gone to it, and in words that do not say what to do. A post of text alone never comes here.
 */
export function requireFileSending(
  deps: Pick<PrepareDeps, 'mode' | 'grantedScopes' | 'workspaceName' | 'handoffs'>,
): void {
  const alias = deps.workspaceName;
  const { handoffs } = deps;
  if (deps.mode !== 'send') {
    throw new CommsError('SCOPE_MISSING', `"${alias}" is connected to read, and cannot send files`, {
      hint: `Nothing was sent. Moving it to send takes a person: ${handoffSentence(
        handoffs.own(['workspace', 'mode', alias]),
        (command) => `${command} shows the steps, as slack_mode does from a chat.`,
        { instead: 'slack_mode shows the steps, from a chat.' },
      )}`,
      details: { mode: deps.mode ?? null },
    });
  }
  if (!(deps.grantedScopes ?? []).includes('files:write')) {
    const reauth = handoffs.own(['workspace', 'reauth', alias, '--mode', 'send']);
    const manifest = handoffSentence(
      handoffs.own(['manifest', '--mode', 'send']),
      (command) => `If the app itself does not offer files:write, update it with ${command} first.`,
      {
        instead: 'If the app itself does not offer files:write, update it first: slack_manifest prints what it needs.',
      },
    );
    throw new CommsError('SCOPE_MISSING', `"${alias}" was not granted files:write, which sending a file needs`, {
      hint: `Nothing was sent. ${handoffSentence(reauth, (command) => `Sign in again to grant it: ${command}.`, {
        instead: 'Sign in again to grant it, with slack_workspace_reauth from a chat.',
      })} ${manifest}`,
      details: { scope: 'files:write', command: reauth },
    });
  }
}

/** The jail's folders, which every file post needs — and which only a caller that built its deps by hand could lack. */
export function attachPolicyFor(deps: Pick<PrepareDeps, 'attachPolicy'>): AttachPolicy {
  if (deps.attachPolicy === undefined) {
    throw new CommsError('SEND_REFUSED', 'a post with files was prepared without the folders files may come from', {
      hint: 'This is a bug — please report it.',
    });
  }
  return deps.attachPolicy;
}

/**
 * The command that puts a draft's files on it again, as it is run: the draft's id and the workspace's own name, and
 * only the paths left to fill in. `draft update` takes nothing without `--workspace`, and a refusal whose one step
 * leaves it out offers a command that fails.
 */
export function refileCommand(workspace: string, draftId: string, handoffs: CliHandoffs): Handoff {
  return handoffs.own(['draft', 'update', draftId, '--workspace', workspace, '--file', '<path…>']);
}

/**
 * Reads every file of a draft again, and refuses the post if any is no longer the file the draft recorded.
 *
 * Before anyone is shown anything: the preview lists each file's hash, and a person must never be asked to approve
 * bytes other than the ones listed. The draft's record is what the digest binds, so a file that changed since is
 * refused here rather than shown as its old self.
 */
export async function filesAsRecorded(
  deps: Pick<PrepareDeps, 'attachPolicy' | 'workspaceName' | 'handoffs'>,
  draft: SlackDraft,
): Promise<void> {
  const files = draft.files ?? [];
  if (files.length === 0) return;
  const policy = attachPolicyFor(deps);
  for (const file of files) {
    const check = await checkRecordedFile(file, policy);
    if (!check.ok) {
      throw new CommsError(
        'BAD_DATA',
        `nothing was prepared: ${file.name} is not the file the draft recorded — ${check.why}`,
        {
          hint: handoffSentence(
            refileCommand(deps.workspaceName, draft.draftId, deps.handoffs),
            (command) =>
              `Put the files on the draft again with ${command} (every one: --file replaces the list) or slack_draft_update, then prepare it again.`,
            { instead: 'Put the files on the draft again with slack_draft_update, then prepare it again.' },
          ),
          details: {
            draftId: draft.draftId,
            file: file.name,
            path: file.path,
            reason: 'file-changed',
            command: refileCommand(deps.workspaceName, draft.draftId, deps.handoffs),
          },
        },
      );
    }
  }
}

/**
 * Prepares one post, and shows what it will be.
 *
 * Nothing is posted here and nothing can be: the permit stays closed, and the only Slack call made is a read of
 * the channel so the reach can be counted. A post with files is checked first — the workspace can send them, and each
 * is still the file the draft recorded — so a refusal asks Slack nothing.
 */
export async function preparePost(deps: PrepareDeps, draft: SlackDraft, book: NameBook): Promise<PreparedPost> {
  if (deps.policy === 'never') {
    throw new CommsError('POLICY_NEVER', 'posting is turned off for this workspace (policy: never)', {
      hint: 'The preview below is pasteable — send it yourself in Slack, or change the policy at a terminal.',
    });
  }
  const files = draft.files ?? [];
  if (files.length > 0) {
    requireFileSending(deps);
    await filesAsRecorded(deps, draft);
  }
  const { preview, digest, payload } = await viewPost(deps, draft, book);

  const riskFlags = risksOf(payload, preview.notifies, files.length);
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
    channel: 'slack',
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: draft.draftId,
    draftMessageId: draft.revision,
    contentDigest: digest,
    sendEpoch: deps.sendEpoch,
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
    approval: await deps.approvals.approvalOf(record),
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
        contentDigest: string;
        inboxId: string;
        inboxSub?: string | undefined;
        expect: Expectation;
      },
      options?: ClaimOptions,
    ): Promise<SendClaim>;
    complete(approvalId: string, claimToken: string, outcome: SendOutcome): Promise<ApprovalRecord>;
    heartbeat(approvalId: string, claimToken: string): Promise<'renewed' | 'lost'>;
    /** The look before each provider step: `go` while this claim still holds the send, `stop` once it reads unknown. */
    fence(approvalId: string, claimToken: string): Promise<'go' | 'stop'>;
    /** A locked look at one approval, classified for what the caller is about to do (design 2026-10-05 §D2). */
    inspect(
      approvalId: string,
      expect?: ApprovalExpectation,
      options?: { action?: OutcomeAction | undefined },
    ): Promise<{ stored: StoredApproval; outcome: ApprovalOutcome }>;
  };
  /**
   * The call's cancellation: the MCP request's signal, which the SDK aborts when the client cancels the call. The
   * command line passes none — Ctrl-C ends the process. Honoured until the request that posts goes out, and never
   * after it: see {@link postPrepared}.
   */
  readonly signal?: AbortSignal | undefined;
}

export interface PostedMessage {
  readonly approvalId: string;
  readonly channel: string;
  /**
   * The message Slack posted. Absent — never `''` — when Slack accepted the post without saying which message it is:
   * `note` then says {@link NO_ID}, and the approval stays `sending`, to read `unknown` (design 2026-10-05 §D8).
   */
  readonly ts?: string | undefined;
  /**
   * What else is true of this post, when anything is: that Slack gave it no ts ({@link NO_ID}), that the call was
   * cancelled too late to stop it ({@link POSTED_ANYWAY}), or that a record of it could not be written afterwards
   * (`recordPosted`). Absent otherwise.
   */
  readonly note?: string | undefined;
  /**
   * Where the approval stands now that Slack has the post (design 2026-10-05 §D8): `used` — or still `sending` when
   * that could not be recorded, which later reads as `unknown`. Never a `used` invented.
   */
  readonly approval: ApprovalObject;
}

/** One file of a post, as Slack now has it: its id there, and what was sent. */
export interface PostedFile {
  readonly id: string;
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
}

/**
 * A post with files, once posted.
 *
 * `ts` is the message the files were posted in, when Slack had attached them to one by the time it was asked — and
 * `null` otherwise, with `note` saying so. Never a guess: `files.completeUploadExternal` returns no message at all, and
 * a ts made up to fill the gap would send whoever replies to it to the wrong message. The file ids are always here.
 * `note` also carries what a post of words alone says in its own (see {@link PostedMessage}).
 */
export interface PostedFiles {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string | null;
  readonly files: readonly PostedFile[];
  readonly note?: string | undefined;
  /** Where the approval stands now that the files are shared, as for a message ({@link PostedMessage}). */
  readonly approval: ApprovalObject;
}

/**
 * The command a person runs to approve at their own terminal, located: the same whichever surface asked. With no
 * command here, the sentence saying why — never a bare `approve` nobody's PATH has.
 */
export function approveCommand(approvalId: string, handoffs: CliHandoffs): Handoff {
  return handoffs.own(['approve', approvalId]);
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
export function waitingHint(
  kind: 'post' | 'reaction' | 'edit' | 'delete',
  surface: 'cli' | 'mcp' | undefined,
  approvalId: string,
  handoffs: CliHandoffs,
): string {
  const show =
    kind === 'reaction' ? 'Tell the user which emoji and which message, then' : 'Show the user the preview, then';
  // An edit and a deletion are sent as a post is: the same call, made again (design 2026-10-06 §E9).
  const sendTool = { post: 'slack_post_send', edit: 'slack_edit_send', delete: 'slack_delete_send' } as const;
  const sendCommand = { post: 'post send', edit: 'edit send', delete: 'delete send' } as const;
  const again =
    surface === 'mcp'
      ? kind === 'reaction'
        ? `call \`slack_react_send\` with approvalId ${approvalId} and the same channel, ts and emoji`
        : `call \`${sendTool[kind]}\` again with the same arguments`
      : kind === 'reaction'
        ? `run the same react command again with \`--approval ${approvalId}\` added`
        : `run the same ${sendCommand[kind]} command again`;
  // Terminal-only under `confirm`: with no command here, the sentence saying why, and no other way to approve it. With
  // one, the wait that learns when they have used it, as this surface takes it (design 2026-10-05 §D7).
  const ask = approveAndWaitSentence(handoffs, surface ?? 'cli', approvalId, (command, wait) =>
    wait === undefined
      ? `${show} ask them to run ${command} in their own terminal. When they have, ${again}.`
      : `${show} ask them to run ${command} in their own terminal; learn when they have with ${wait}, then ${again}.`,
  );
  return `${ask} You cannot approve this yourself.`;
}

/**
 * A post whose call was cancelled before Slack had it: nothing was posted.
 *
 * `USAGE` and `cancelled:`, the words every cancellation in this repository is reported in, with `details.reason` saying
 * so for a caller that branches on it. The hint says what became of the approval, which depends on when it came.
 */
function cancelledPost(hint: string): CommsError {
  return new CommsError('USAGE', 'cancelled: nothing was posted', { hint, details: { reason: 'cancelled' } });
}

/** Whether a failure is {@link cancelledPost}'s, so a file post's report keeps its words. */
function isCancelledPost(error: unknown): boolean {
  return error instanceof CommsError && error.details?.reason === 'cancelled';
}

/** What a refusal said of its approval (decision 8), to carry on to the refusal that replaces it. */
function approvalOfError(error: unknown): ApprovalObject | null {
  return error instanceof CommsError ? ((error.details?.approval as ApprovalObject | null | undefined) ?? null) : null;
}

/**
 * Where a claimed post's approval stands now, read under its lock — or, when that read fails, what `fallback` said: a
 * report never turns into a failure of the post it reports on.
 */
export async function approvalNow(
  deps: PostDeps,
  approvalId: string,
  fallback: ApprovalObject,
): Promise<ApprovalObject> {
  try {
    return (await deps.approvals.inspect(approvalId, { kind: 'send', owner: deps.accountId })).outcome.approval;
  } catch {
    return fallback;
  }
}

/** `error`, saying where its approval stands now that it is settled — whatever it said of it before. */
export function settledWith(error: unknown, approval: ApprovalObject): unknown {
  if (!(error instanceof CommsError)) return error;
  return new CommsError(error.code, error.message, {
    ...(error.hint === undefined ? {} : { hint: error.hint }),
    details: { ...error.details, approval },
    ...(error.cause === undefined ? {} : { cause: error.cause }),
  });
}

/** Before the claim has changed the record, a cancellation spends nothing. */
const NOT_USED = 'The approval was not used: it can still post this draft until it expires.';

/** After the claim, a cancellation spends the approval: a claim is single use, and cannot be put back. */
const SPENT_BY_CANCEL =
  'The approval was used up by the attempt. If it should still be posted, prepare the draft again and approve the new preview.';

/**
 * What a post says when its call was cancelled after the request that posts it had gone out: that it is posted.
 *
 * In the result and in the audit record, because the result alone may reach nobody — the SDK sends a cancelled call no
 * answer — and the audit log is where the person can still find out that what they tried to stop happened.
 */
const POSTED_ANYWAY =
  'the call was cancelled too late to stop it: Slack accepted the post, and a post cannot be taken back';

/**
 * What a result says of a post or reaction Slack accepted without an id to record it by (design 2026-10-05 §D8):
 * exactly this, never an id made up and never `used`. The approval stays `sending`, and reads `unknown` once its lease
 * runs out.
 */
export const NO_ID = 'sent; the provider returned no id';

/** What its audit record says in place of the id it omits. */
export const ACCEPTED_WITHOUT_ID =
  'accepted without an id: the approval is not marked used, and reads unknown once its lease runs out';

/** A provider id, or absence: `undefined`, `null`, `''` and anything not a string are no id at all — never `''`. */
export function providerId(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Claims an approval, and when it is waiting for a person, says so with the command they run as data.
 *
 * The hint is prose for whoever reads it. An agent relaying the step to a person should not have to dig a command out
 * of a sentence, so the wait carries it in `details.command` too — from both surfaces, because both come through here.
 *
 * The call's signal goes to the store, which asks it under the record's lock just before the claim changes anything. A
 * look here, before the call, would miss a cancellation that came while the claim waited for the lock — another
 * process's claim or completion holding it — and that claim then went through and spent the approval, which the post
 * then had to record as failed. The store's cancellation goes out in a post's words, with the same hint as one
 * caught before the claim, because it is the same outcome: nothing was posted, and the approval is unused.
 *
 * Everything else the claim throws goes out exactly as the store threw it.
 *
 * `unclaimed` is what a cancellation before the claim says, in the words of the act: a post's, unless an edit or a
 * deletion gives its own (design 2026-10-06), so nobody is told "nothing was posted" about a message they asked to
 * delete.
 */
export async function claimOrHandOver(
  deps: PostDeps,
  approvalId: string,
  live: Parameters<PostDeps['approvals']['claimForSend']>[1],
  pendingHint: string,
  unclaimed: () => CommsError = () => cancelledPost(NOT_USED),
): Promise<{ claimToken: string; claimed: ApprovalObject }> {
  try {
    const { claimToken, approval } = await deps.approvals.claimForSend(approvalId, live, {
      pendingHint,
      signal: deps.signal,
      platform: deps.handoffs.platform,
    });
    return { claimToken, claimed: approval };
  } catch (error) {
    if (isCancelledPost(error)) throw withApproval(unclaimed(), approvalOfError(error));
    if (!(error instanceof CommsError) || error.code !== 'APPROVAL_PENDING') throw error;
    // Another call's send under way is not waiting for a person: no approve command for it.
    if (error.details?.state === 'sending') throw error;
    throw new CommsError(error.code, error.message, {
      ...(error.hint === undefined ? {} : { hint: error.hint }),
      details: { ...error.details, command: approveCommand(approvalId, deps.handoffs) },
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
 *
 * A cancelled call (`deps.signal`, CUE-305) is honoured up to the request that posts, in three stretches. Before the
 * claim has changed the approval — while it waits for the store's lock, too — it posts nothing and spends nothing: the
 * approval is as it was, as though the call had never been made. After the claim and before Slack has the post it posts
 * nothing, and the approval is recorded as failed, saying it was cancelled — the outcome of any attempt that posted
 * nothing, since a claim cannot be put back. Once the request that posts has gone out it is never abandoned: Slack may
 * already have acted on it, and abandoning it would record as failed a post that is in the channel. So it is waited
 * for, the approval is recorded as used, and the result and the audit record say the call was cancelled too late.
 *
 * Claimed, every request to Slack starts only after a fence: the claim's lease is renewed while Slack's work is
 * outstanding, and once another caller has found it run out and recorded `unknown`, no further request starts (design
 * 2026-10-05 §D1).
 *
 * Once that request has gone out, what is recorded is only what is known. A refusal posted nothing, and is a failed
 * post. An answer lost on the way back may be a post, and is recorded as neither (`recordMaybePosted`). And a post
 * Slack accepted is a post, whatever the writes after it do (`recordPosted`): the dispatch and the bookkeeping are kept
 * apart, so a record that fails to be written can never turn into a failure of the post it records. A post accepted
 * with no ts is a post too, said to be one with no id ({@link NO_ID}), and never recorded `used`.
 */
export async function postPrepared(
  deps: PostDeps,
  draft: SlackDraft,
  approvalId: string,
  expectChannel: string,
  book: NameBook,
): Promise<PostedMessage | PostedFiles> {
  /*
   * The approval first, before Slack is asked anything — this workspace's post, classified under its lock as the claim
   * would classify it (design 2026-10-05 §D2). Another workspace's, another kind's or one nobody prepared is the one
   * NOT_FOUND; a used, expired or revoked one — now, because posting was turned off since — or one being posted by
   * another call is refused for what it is, with where it stands. Until the claim, a refusal says where it stands too.
   */
  const { outcome } = await deps.approvals.inspect(
    approvalId,
    { kind: 'send', owner: deps.accountId },
    { action: 'claim' },
  );
  if (outcome.error) throw outcome.error;
  try {
    return await postClassified(deps, draft, approvalId, expectChannel, book);
  } catch (error) {
    throw withApproval(error, outcome.approval);
  }
}

/** {@link postPrepared}, once its approval is classified: everything from the draft's checks to its outcome. */
async function postClassified(
  deps: PostDeps,
  draft: SlackDraft,
  approvalId: string,
  expectChannel: string,
  book: NameBook,
): Promise<PostedMessage | PostedFiles> {
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
  /*
   * A post with files, asked again whether this workspace may send one: the grant can narrow between prepare and send.
   * Before the claim, so a refusal here spends nothing, and the approval is there to use once the grant is mended.
   */
  const files = draft.files ?? [];
  const policy = files.length > 0 ? attachPolicyFor(deps) : undefined;
  if (files.length > 0) requireFileSending(deps);
  // The payload sent below is this one: checked against the file, previewed, and the one the digest is taken over.
  const { preview, digest, payload } = await viewPost(deps, draft, book);

  // Cancelled while the room was looked up: the claim is next, and is not made. The store asks again as it claims.
  if (deps.signal?.aborted) throw cancelledPost(NOT_USED);
  const { claimToken, claimed } = await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: draft.revision,
      contentDigest: digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      // Built from the live values, the same way `preparePost` built the stored one — one source, so they agree.
      expect: expectationFor(payload, preview.notifies),
    },
    waitingHint('post', deps.surface, approvalId, deps.handoffs),
  );
  // Claimed: from here until its outcome is recorded, the claim's lease is renewed while Slack's work is outstanding.
  return withSendingLease(deps.approvals, approvalId, claimToken, async () => {
    if (policy !== undefined) {
      return postFiles(deps, approvalId, { claimToken, claimed }, draft.draftId, payload, files, policy);
    }

    const where = { channel: payload.channel };
    // Claimed, and nothing sent yet: the approval is spent on a post that did not happen, and recorded as failed.
    if (deps.signal?.aborted)
      throw await recordNotPosted(deps, approvalId, { claimToken, claimed }, where, cancelledPost(SPENT_BY_CANCEL));
    // The fence (design 2026-10-05 §D1): the post starts only while this claim still holds the send.
    await fenceFirstStep(deps, approvalId, { claimToken, claimed }, 'slack.post', where);
    let response: SlackResponse;
    try {
      // Without the signal, deliberately: this is the request that posts, and it is never abandoned once it is out.
      response = await spendOn(deps.permit, approvalId, 'chat.postMessage', () =>
        callSlack({ ...deps.call, permit: deps.permit }, 'chat.postMessage', {
          channel: payload.channel,
          text: payload.text,
          blocks: JSON.stringify(payload.blocks),
          thread_ts: payload.thread_ts,
          unfurl_links: payload.unfurl_links,
          unfurl_media: payload.unfurl_media,
        }),
      );
    } catch (error) {
      if (certainlyRefused(error, 'chat.postMessage'))
        throw await recordNotPosted(deps, approvalId, { claimToken, claimed }, where, error);
      throw await recordMaybePosted(deps, approvalId, claimed, where, error, 'it was posted');
    }

    // Posted. Nothing from here records the approval as failed, or throws: see `recordPosted`.
    const ts = providerId(response.ts);
    const { late, unrecorded, approval } = await recordPosted(deps, approvalId, { claimToken, claimed }, ts, {
      channel: payload.channel,
      ...(ts === undefined ? {} : { ts }),
    });
    const note = noteOf([ts === undefined ? NO_ID : undefined, late, ...unrecorded]);
    return {
      approvalId,
      channel: payload.channel,
      ...(ts === undefined ? {} : { ts }),
      ...(note === undefined ? {} : { note }),
      approval,
    };
  });
}

/** A failure's message, whatever was thrown. */
export function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** What a result's note says: each thing worth saying, in order, or nothing at all. */
export function noteOf(said: readonly (string | undefined)[]): string | undefined {
  return said.filter((one) => one !== undefined).join('; ') || undefined;
}

/**
 * The fence before a flow's first provider step — a post, a reaction, or a file post's first upload URL (design
 * 2026-10-05 §D1). While this claim still holds the send, it goes on. Once another caller has found the lease run out
 * and recorded `unknown`, nothing has been asked of Slack: `fenceOrStop` records the approval `failed`
 * (`lease-lost-before-send`), and this audits it and throws the refusal saying nothing was sent, with where the
 * approval stands.
 */
export async function fenceFirstStep(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  operation: string,
  ids: Record<string, string | string[]>,
): Promise<void> {
  const verdict = await fenceOrStop(deps.approvals, approvalId, claim.claimToken, { stepsStarted: 0 });
  if (verdict.proceed) return;
  throw await recordLeaseLost(deps, approvalId, claim.claimed, operation, ids, verdict.error);
}

/** Audits a send whose lease ran out before its first step — `fenceOrStop` recorded it — and returns what to throw. */
async function recordLeaseLost(
  deps: PostDeps,
  approvalId: string,
  claimed: ApprovalObject,
  operation: string,
  ids: Record<string, string | string[]>,
  error: CommsError | null,
): Promise<CommsError> {
  const refusal =
    error ??
    new CommsError('APPROVAL_VOID', 'nothing was sent: the sending lease ran out before anything was sent', {
      details: { approvalId, reason: LEASE_LOST_BEFORE_SEND },
    });
  let unaudited: string | undefined;
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation,
      outcome: 'failed',
      ids,
      approvalId,
      reason: LEASE_LOST_BEFORE_SEND,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (failure) {
    unaudited = `The audit log could not record this (${messageOf(failure)}).`;
  }
  const said = unaudited === undefined ? refusal : refusalWithBookkeeping(refusal, [unaudited]);
  return settledWith(said, await approvalNow(deps, approvalId, claimed)) as CommsError;
}

/**
 * Records a post that did not happen — a refusal, or a cancellation before the request that posts — and returns the
 * failure, for the caller to throw.
 *
 * Recorded before it is rethrown: an approval left in `sending` is one whose outcome nobody knows, and this one's is
 * known. Only for what certainly posted nothing (`certainlyRefused`); see `recordMaybePosted` for the rest.
 */
async function recordNotPosted(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  ids: Record<string, string | string[]>,
  error: unknown,
  outcome: 'failed' | 'refused' = 'failed',
): Promise<unknown> {
  const reason = messageOf(error);
  const failed = await deps.approvals.complete(approvalId, claim.claimToken, { error: reason });
  await deps.audit?.append({
    inboxId: deps.accountId,
    alias: deps.workspaceName,
    operation: 'slack.post',
    outcome,
    ids,
    approvalId,
    reason,
    ...(deps.surface ? { surface: deps.surface } : {}),
  });
  return settledWith(error, await deps.approvals.approvalOf(failed));
}

/**
 * Records a request that posts which went out and came back as neither a success nor a refusal, and returns what to
 * throw: that whether it posted is not known.
 *
 * A connection that dropped, a 5xx, an answer that could not be read, Slack's own "some of it may have succeeded" —
 * after any of them the post may be in the channel. Recording it as failed would say something nobody knows, in the one
 * direction that invites the post again. So the approval's outcome is not recorded at all: it stays in `sending`, which
 * the store reads as `unknown` once the attempt is plainly over (`SENDING_LEASE_MS`) — the state it has for exactly
 * this, and the one a send whose process died mid-request is left in. It is not used again either way.
 *
 * The audit record says so in its reason, as Resend's does for the same case; and the error says it in its message and
 * its own code, `SEND_OUTCOME_UNKNOWN` (design 2026-10-05 §D2) — never retryable, as the provider's own `TRANSIENT`
 * was, since a retry of a post that happened is a second post — keeping the details of what went wrong. Should the
 * audit record fail to be written, the error says that too rather than being replaced by it: what happened to the post
 * is the one thing the caller has to hear.
 */
async function recordMaybePosted(
  deps: PostDeps,
  approvalId: string,
  claimed: ApprovalObject,
  ids: Record<string, string | string[]>,
  error: unknown,
  what: string,
  details: Record<string, unknown> = {},
): Promise<CommsError> {
  const said = messageOf(error);
  let unaudited = '';
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: 'slack.post',
      outcome: 'failed',
      ids,
      approvalId,
      reason: `outcome unknown: ${said}`,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (failure) {
    unaudited = ` The audit log could not record this either (${messageOf(failure)}).`;
  }
  return new CommsError('SEND_OUTCOME_UNKNOWN', `whether ${what} is not known: ${said}`, {
    cause: error,
    hint: `Look in the channel before anything else: Slack may have posted it. Prepare the draft again only if it is not there — this approval is not used again.${unaudited}`,
    details: {
      ...(error instanceof CommsError ? error.details : {}),
      ...details,
      approvalId,
      outcome: 'unknown',
      // Still `sending`: nothing is recorded of a post whose outcome is not known.
      approval: await approvalNow(deps, approvalId, claimed),
    },
  });
}

/**
 * Records a post Slack accepted, and returns what else its result should say.
 *
 * Nothing here records the approval as failed, and nothing here throws: the post is in the channel, and a record — or an
 * error — saying otherwise is wrong in the one direction that gets a post made twice. It was all one `try` with the
 * request, so a completion that timed out on the store's lock, or an audit record that could not be written, fell into
 * the failure path, which recorded the approval as failed and threw. Now each write may fail on its own, and a failure
 * is said beside the post it is about: in the result's note, and — for the approval — in the audit record. An approval
 * that could not be marked used stays in `sending`, read as `unknown` later: true of the record, if not of the post, and
 * the audit record says which post it was all the same.
 *
 * Whether the call was cancelled too late ({@link POSTED_ANYWAY}) is decided here too, after the approval is written and
 * immediately before the audit record — not as the answer arrives. The completion can wait, on the store's lock, and a
 * cancellation during that wait was decided too early to count: the result and the audit record left it out, although
 * the audit record is the one place a person can still learn that what they tried to stop was posted. `aborted` never
 * goes back once set, so this one look sees a cancellation that came at any moment from the request going out until
 * now: it latches every abort over the stretch without a listener to add and take away.
 */
async function recordPosted(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  sentMessageId: string | undefined,
  ids: Record<string, string | string[]>,
): Promise<{ late: string | undefined; unrecorded: string[]; approval: ApprovalObject }> {
  const unrecorded: string[] = [];
  // `used` only once it is written; until then — and for good, if it cannot be — the record as it stands.
  let approval: ApprovalObject | null = null;
  // No id, no completion: `used` is never written without one, and the record stays `sending` (design §D8).
  if (sentMessageId !== undefined) {
    try {
      approval = await deps.approvals.approvalOf(
        await deps.approvals.complete(approvalId, claim.claimToken, { sentMessageId }),
      );
    } catch (error) {
      unrecorded.push(`the approval could not be marked used (${messageOf(error)}), so it will read as unknown`);
    }
  }
  const late = deps.signal?.aborted ? POSTED_ANYWAY : undefined;
  const reason = noteOf([sentMessageId === undefined ? ACCEPTED_WITHOUT_ID : undefined, late, ...unrecorded]);
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: 'slack.post',
      outcome: 'ok',
      ids,
      approvalId,
      ...(reason === undefined ? {} : { reason }),
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (error) {
    unrecorded.push(`the audit log could not record it (${messageOf(error)})`);
  }
  return { late, unrecorded, approval: approval ?? (await approvalNow(deps, approvalId, claim.claimed)) };
}

/** The call that makes uploaded files visible, and so the one a file post's permit is opened for. */
const PUBLISH_FILES = 'files.completeUploadExternal';

/**
 * How long to wait, before each look, for Slack to attach the posted files to a message: four looks over three seconds.
 *
 * Bounded because the post has already happened and the person is waiting on an answer that is only a courtesy. Slack
 * attaches the message a moment after the call that shares the files returns, and until it has there is no ts to give.
 */
const SHARE_WAITS_MS: readonly number[] = [0, 250, 750, 2000];

/** Who uploaded what, in words: for a failure after some files had gone up and before any was shared. */
export function discarded(uploaded: readonly { name: string }[]): string {
  if (uploaded.length === 0) return '';
  const names = uploaded.map((file) => truncateDisplay(file.name, 60));
  return uploaded.length === 1
    ? `${names[0]} was uploaded and never shared; Slack discards it.`
    : `${names.join(', ')} were uploaded and never shared; Slack discards them.`;
}

/**
 * A file whose bytes went out and whose answer did not come back as success, in words: a 500 after the body was read,
 * or a connection dropped. Whether Slack kept them is not known, so it is said to be possible, never either way.
 */
export function perhapsDiscarded(possible: readonly { name: string }[]): string {
  if (possible.length === 0) return '';
  const names = possible.map((file) => truncateDisplay(file.name, 60)).join(', ');
  return `${names} may have been uploaded before the failure; nothing shared it, so if Slack has it, Slack discards it.`;
}

/**
 * A file post whose lease ran out after it had started: another call found it `unknown`, so no further step started —
 * and the files, never shared, are in no channel. Nothing was posted; what went up is named, as any failure before the
 * share names it. Never mid-upload: the fence is asked between steps, so no file is in flight when it stops.
 */
function leaseRanOut(uploaded: readonly { id: string; name: string }[]): CommsError {
  return new CommsError('APPROVAL_VOID', 'nothing was posted: the sending lease ran out before the files were shared', {
    hint: [
      discarded(uploaded),
      'No step started once its lease had run out, and nothing was shared. Prepare the draft again and show the new preview to the user.',
    ]
      .filter(Boolean)
      .join(' '),
    details: { reason: 'lease-lost', stage: 'upload', uploaded: [...uploaded] },
  });
}

/** The refusal for a file that is not the one approved: nothing more is sent, and the approval is spent. */
function notApproved(
  file: SlackDraftFile,
  why: string,
  uploaded: readonly { id: string; name: string }[],
  command: Handoff,
): CommsError {
  return new CommsError(
    'APPROVAL_VOID',
    `${uploaded.length === 0 ? 'nothing was sent' : 'nothing was posted'}: ${file.name} is not the file that was approved — ${why}`,
    {
      hint: [
        discarded(uploaded),
        handoffSentence(
          command,
          (refile) =>
            `Put the files on the draft again with ${refile} or slack_draft_update, prepare it, and approve the new preview.`,
          {
            instead:
              'Put the files on the draft again with slack_draft_update, prepare it, and approve the new preview.',
          },
        ),
      ]
        .filter(Boolean)
        .join(' '),
      details: { file: file.name, path: file.path, reason: 'file-changed', uploaded: [...uploaded], command },
    },
  );
}

/** The ts of the message a posted file is in, in this channel, from `files.info`'s shares — or undefined. */
function shareTs(file: unknown, channel: string): string | undefined {
  const shares = (file as { shares?: Record<string, unknown> } | null | undefined)?.shares;
  for (const kind of ['public', 'private']) {
    const entries = (shares?.[kind] as Record<string, unknown> | undefined)?.[channel];
    if (!Array.isArray(entries)) continue;
    for (const entry of entries) {
      const ts = (entry as { ts?: unknown } | null)?.ts;
      if (typeof ts === 'string' && /^\d+\.\d+$/.test(ts)) return ts;
    }
  }
  return undefined;
}

/**
 * The message a file post landed in, if Slack will say: a few looks at the first file's shares, and then an honest gap.
 *
 * A read, after the post, with no permit: nothing here can post again. A failure to ask is reported as the gap it is,
 * not as a failed post — the files are posted either way.
 */
async function messageTsOf(
  call: SlackCall,
  fileId: string,
  channel: string,
): Promise<{ ts: string | null; note?: string }> {
  let why = 'Slack had not attached the files to a message yet';
  for (const wait of SHARE_WAITS_MS) {
    if (wait > 0) await sleep(wait);
    try {
      const ts = shareTs((await callSlack(call, 'files.info', { file: fileId })).file, channel);
      if (ts !== undefined) return { ts };
    } catch (error) {
      why = `Slack could not be asked which message holds them (${(error as Error).message})`;
    }
  }
  return { ts: null, note: `${why}, so the message's ts is not known; the files are posted, and their ids are below` };
}

/**
 * Posts the files of one prepared post, once — after the approval has been claimed.
 *
 * Inside one permit, for the one call that shares the files, and in this order:
 *
 * 1. Every file is read again and matched to what was approved — not a link, a regular file, its own real path, still
 *    admitted by the jail, the approved size and hash — all of them before anything is uploaded. One that is not voids
 *    the approval, and nothing at all has left the machine.
 * 2. Then file by file: Slack is asked where to put it, the file is read and hashed again, and the bytes just hashed go
 *    to that URL. Never bytes kept from an earlier reading: what is hashed is what is sent.
 * 3. Then one call names the channel, the thread and the words, and makes every file visible as one post.
 *
 * Each of those requests — every upload URL, every upload, the share — starts only after a fence says this claim still
 * holds the send (design 2026-10-05 §D1), and one lease, renewed while they run, covers them all.
 *
 * A failure before the last step posts nothing, and says which files had been uploaded — Slack discards a file that
 * is never shared. So does a refusal at it, and a lease that ran out between steps; an answer lost at it may be a post,
 * and is `SEND_OUTCOME_UNKNOWN` (`recordMaybePosted`). Afterwards, a few looks at `files.info` for the message's ts.
 *
 * A cancelled call stops an upload on its way and is asked once more before the last step: either way nothing is
 * shared, and the approval is recorded as failed. The last step itself is the request that posts, and is never
 * abandoned — see {@link postPrepared}.
 */
async function postFiles(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  draftId: string,
  payload: ComposedPayload,
  files: readonly SlackDraftFile[],
  policy: AttachPolicy,
): Promise<PostedFiles> {
  const uploaded: { id: string; name: string }[] = [];
  /*
   * The file whose bytes are on their way, from the moment the POST starts until its answer says they arrived. If the
   * upload fails in between, they may have reached Slack or may not — so the failure names it as possibly uploaded.
   */
  let inFlight: { id: string; name: string } | undefined;
  const posted: PostedFile[] = [];
  const call: SlackCall = { ...deps.call, permit: deps.permit };
  /*
   * The uploads, and only the uploads, carry the signal. On `call` it would reach `callSlack` too, which uses a call's
   * signal in place of its thirty-second limit — and one of those calls is the one that shares the files.
   */
  const transfer: SlackCall = deps.signal === undefined ? call : { ...call, signal: deps.signal };
  const refile = refileCommand(deps.workspaceName, draftId, deps.handoffs);
  // Widened, not narrowed to its first value: it moves on inside the permit's callback, which no narrowing follows.
  let stage = 'check' as 'check' | 'upload' | 'complete';
  /*
   * The fence before each step (design 2026-10-05 §D1): an upload URL, each upload, the share. One lease covers them
   * all — renewed while they run, however long an upload takes — and a step starts only while this claim still holds
   * it. Stopped before the first, nothing was asked of Slack, and that is recorded here (`stoppedFirst`), not again
   * below; stopped after, the failure below says what had gone up. Each step counts as started once its fence said go.
   */
  let stepsStarted = 0;
  let stoppedFirst: CommsError | undefined;
  const fence = async (): Promise<void> => {
    if (stepsStarted === 0) {
      try {
        await fenceFirstStep(deps, approvalId, claim, 'slack.post', { channel: payload.channel });
      } catch (error) {
        stoppedFirst = error as CommsError;
        throw error;
      }
    } else {
      const verdict = await fenceOrStop(deps.approvals, approvalId, claim.claimToken, { stepsStarted });
      if (!verdict.proceed) throw leaseRanOut(uploaded);
    }
  };
  try {
    await spendOn(deps.permit, approvalId, PUBLISH_FILES, async () => {
      for (const file of files) {
        const check = await checkRecordedFile(file, policy);
        if (!check.ok) throw notApproved(file, check.why, uploaded, refile);
      }
      stage = 'upload';
      for (const file of files) {
        await fence();
        stepsStarted += 1;
        const place = await callSlack(call, 'files.getUploadURLExternal', { filename: file.name, length: file.size });
        // An empty URL or id is none: a file Slack named `''` could be shared, and recorded, by nothing.
        const url = providerId(place.upload_url);
        const fileId = providerId(place.file_id);
        if (url === undefined || fileId === undefined) {
          throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s answer held no upload URL or file id for the file', {
            hint: 'Try again shortly.',
          });
        }
        const read = await rereadFile(file, policy);
        if (!read.ok) throw notApproved(file, read.why, uploaded, refile);
        await fence();
        stepsStarted += 1;
        inFlight = { id: fileId, name: file.name };
        try {
          await slackFileUpload(transfer, { url, bytes: read.bytes });
        } catch (error) {
          // A cancelled upload fails as a lost connection does; it is reported as what it was. `inFlight` is kept, so
          // the record says this file's bytes may have reached Slack — they had begun to go.
          if (deps.signal?.aborted) throw cancelledPost(SPENT_BY_CANCEL);
          throw error;
        }
        inFlight = undefined;
        uploaded.push({ id: fileId, name: file.name });
        posted.push({ id: fileId, name: file.name, size: file.size, sha256: file.sha256 });
      }
      // Every file is up and none is shared: the last moment a cancellation keeps the post from happening.
      if (deps.signal?.aborted) throw cancelledPost(SPENT_BY_CANCEL);
      // Before the stage moves on: a lease run out here shared nothing, and is no post that may have happened.
      await fence();
      stepsStarted += 1;
      stage = 'complete';
      await callSlack(call, PUBLISH_FILES, {
        files: JSON.stringify(posted.map((file) => ({ id: file.id, title: file.name }))),
        channel_id: payload.channel,
        // The words, when there are any, as the files' own message: one post, not a message and then some files.
        initial_comment: payload.text === '' ? undefined : payload.text,
        thread_ts: payload.thread_ts,
      });
    });
  } catch (error) {
    // Stopped before the first step: recorded and audited already, and nothing had been asked of Slack.
    if (error === stoppedFirst) throw error;
    const possiblyUploaded = inFlight === undefined ? [] : [inFlight];
    // Which files went up, and which may have: by id and name, never by what is in them.
    const ids = {
      channel: payload.channel,
      ...(uploaded.length > 0
        ? { files: uploaded.map((file) => file.id), fileNames: uploaded.map((file) => file.name) }
        : {}),
      ...(possiblyUploaded.length > 0
        ? {
            possiblyUploaded: possiblyUploaded.map((file) => file.id),
            possiblyUploadedNames: possiblyUploaded.map((file) => file.name),
          }
        : {}),
    };
    // The call that shares the files went out and came back as neither a success nor a refusal: they may be posted.
    if (stage === 'complete' && !certainlyRefused(error, PUBLISH_FILES)) {
      throw await recordMaybePosted(deps, approvalId, claim.claimed, ids, error, 'the files were posted', {
        stage,
        uploaded: [...uploaded],
      });
    }
    const reported = reportFailure(error, stage, uploaded, possiblyUploaded);
    throw await recordNotPosted(deps, approvalId, claim, ids, reported, stage === 'check' ? 'refused' : 'failed');
  }

  // Posted. Nothing from here records the approval as failed, or throws: see `recordPosted`.
  const first = posted[0]?.id;
  // Read back only by an id Slack gave: every posted file has one (above), and there is always a first.
  const { ts, note: unshared } =
    first === undefined
      ? { ts: null, note: 'Slack did not say which message holds them' }
      : await messageTsOf(deps.call, first, payload.channel);
  // The looks above are not cut short by a cancellation: the post has happened, and its ts is part of the record.
  const { late, unrecorded, approval } = await recordPosted(
    deps,
    approvalId,
    claim,
    ts ?? providerId(posted.map((file) => file.id).join(',')),
    // What was posted, by what it is: ids, names, sizes and hashes. Never a byte of it.
    {
      channel: payload.channel,
      ...(ts === null ? {} : { ts }),
      files: posted.map((file) => file.id),
      fileNames: posted.map((file) => file.name),
      fileSizes: posted.map((file) => String(file.size)),
      fileSha256: posted.map((file) => file.sha256),
    },
  );
  const note = noteOf([unshared, late, ...unrecorded]);
  return {
    approvalId,
    channel: payload.channel,
    ts,
    files: posted,
    ...(note === undefined ? {} : { note }),
    approval,
  };
}

/**
 * A file post's failure, in words that say what did and did not happen.
 *
 * A refusal of a changed file, and a lease that ran out between steps, are already worded for themselves. Anything else
 * before the files were shared posts nothing, and names the files that had gone up, and the one that may have — its
 * bytes sent, its answer failed. So does a refusal at the call that shares them (design 2026-10-05 §D2): Slack refused
 * it before acting, so nothing was posted; one that may have posted never comes here (`recordMaybePosted`). A
 * cancellation keeps its own words, which already say nothing was posted.
 */
function reportFailure(
  error: unknown,
  stage: 'check' | 'upload' | 'complete',
  uploaded: readonly { id: string; name: string }[],
  possiblyUploaded: readonly { id: string; name: string }[],
): unknown {
  if (!(error instanceof CommsError) || error.code === 'APPROVAL_VOID') return error;
  const which = {
    uploaded: [...uploaded],
    ...(possiblyUploaded.length > 0 ? { possiblyUploaded: [...possiblyUploaded] } : {}),
  };
  if (isCancelledPost(error)) {
    return new CommsError(error.code, error.message, {
      hint: [discarded(uploaded), perhapsDiscarded(possiblyUploaded), error.hint].filter(Boolean).join(' '),
      details: { ...error.details, stage, ...which },
    });
  }
  // At the share too: Slack refused it before acting (anything else is `recordMaybePosted`'s), so nothing is posted.
  return new CommsError(error.code, `nothing was posted: ${error.message}`, {
    hint: [discarded(uploaded), perhapsDiscarded(possiblyUploaded), error.hint].filter(Boolean).join(' '),
    details: { ...error.details, stage, ...which },
  });
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
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat makes it. */
  readonly approval: ApprovalObject;
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

export interface ReactionResult {
  readonly approvalId: string;
  readonly note?: string | undefined;
  /** Where the approval stands now (design 2026-10-05 §D8): `used`, or still `sending` when that was not recorded. */
  readonly approval: ApprovalObject;
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
  if (!what || reactionDigest({ workspaceId, postingAs: record.inboxSub ?? '' }, options) !== record.contentDigest) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the reaction it is bound to', {
      hint: 'Nothing was approved. Ask for the reaction again, for a new approval.',
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
    channel: 'slack',
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: reactionDraftId(options),
    // No draft to edit, so the reaction's own digest stands in: the same value means the same act.
    draftMessageId: digest,
    contentDigest: digest,
    sendEpoch: deps.sendEpoch,
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
    approval: await deps.approvals.approvalOf(record),
  };
}

function reactionOperation(options: ReactionOptions): 'slack.reaction.add' | 'slack.reaction.remove' {
  return options.remove ? 'slack.reaction.remove' : 'slack.reaction.add';
}

/** What a reaction is audited by: the message, and the emoji. An empty value is none, and is left out — never `''`. */
function reactionIds(options: ReactionOptions): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of [
    ['channel', options.channel],
    ['ts', options.ts],
    ['emoji', options.name],
  ] as const) {
    if (value !== '') ids[key] = value;
  }
  return ids;
}

/** Keeps Slack's refusal as the error, adding only what failed while this tried to record it. */
export function refusalWithBookkeeping(error: CommsError, unrecorded: readonly string[]): CommsError {
  if (unrecorded.length === 0) return error;
  const said = unrecorded.join('; ');
  const sentence = `${said.slice(0, 1).toUpperCase()}${said.slice(1)}.`;
  return new CommsError(error.code, error.message, {
    hint: [error.hint, sentence].filter((part) => part !== undefined).join(' '),
    ...(error.details === undefined ? {} : { details: error.details }),
    cause: error,
  });
}

/** Records a reaction Slack certainly refused, without letting either record replace Slack's refusal. */
async function recordReactionRefused(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  options: ReactionOptions,
  error: CommsError,
): Promise<CommsError> {
  const unrecorded: string[] = [];
  const reason = messageOf(error);
  let settled = claim.claimed;
  try {
    settled = await deps.approvals.approvalOf(
      await deps.approvals.complete(approvalId, claim.claimToken, { error: reason }),
    );
  } catch (failure) {
    unrecorded.push(`the approval could not be marked failed (${messageOf(failure)})`);
  }
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: reactionOperation(options),
      outcome: 'failed',
      ids: reactionIds(options),
      approvalId,
      reason: [reason, ...unrecorded].join('; '),
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (failure) {
    unrecorded.push(`the audit log could not record the refusal (${messageOf(failure)})`);
  }
  return settledWith(refusalWithBookkeeping(error, unrecorded), settled) as CommsError;
}

/**
 * Records a reaction request whose answer does not say whether Slack acted, and returns what to throw: as a post's
 * (`recordMaybePosted`), `SEND_OUTCOME_UNKNOWN`, with the approval left `sending`.
 */
async function recordReactionUnknown(
  deps: PostDeps,
  approvalId: string,
  claimed: ApprovalObject,
  options: ReactionOptions,
  error: unknown,
): Promise<CommsError> {
  const said = messageOf(error);
  let unaudited = '';
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: reactionOperation(options),
      outcome: 'failed',
      ids: reactionIds(options),
      approvalId,
      reason: `outcome unknown: ${said}`,
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (failure) {
    unaudited = ` The audit log could not record this either (${messageOf(failure)}).`;
  }
  const act = options.remove ? 'removed' : 'added';
  return new CommsError('SEND_OUTCOME_UNKNOWN', `whether the reaction was ${act} is not known: ${said}`, {
    cause: error,
    hint: `Look at the message before anything else: Slack may have ${act} the reaction. Try again only if its state is not what the person asked for — this approval is not used again.${unaudited}`,
    details: {
      ...(error instanceof CommsError ? error.details : {}),
      approvalId,
      outcome: 'unknown',
      // Still `sending`: nothing is recorded of a reaction whose outcome is not known.
      approval: await approvalNow(deps, approvalId, claimed),
    },
  });
}

/** Records a reaction whose requested state is known to hold, without letting bookkeeping rewrite that success. */
async function recordReactionChanged(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  options: ReactionOptions,
  known?: string | undefined,
): Promise<ReactionResult> {
  const unrecorded: string[] = [];
  let approval: ApprovalObject | null = null;
  // What a reaction is recorded by is the message it is on. With none, it is never `used` by an empty id (§D8).
  const sentMessageId = providerId(options.ts);
  if (sentMessageId !== undefined) {
    try {
      approval = await deps.approvals.approvalOf(
        await deps.approvals.complete(approvalId, claim.claimToken, { sentMessageId }),
      );
    } catch (error) {
      unrecorded.push(`the approval could not be marked used (${messageOf(error)}), so it will read as unknown`);
    }
  }
  const unidentified = sentMessageId === undefined;
  const reason = noteOf([unidentified ? ACCEPTED_WITHOUT_ID : undefined, known, ...unrecorded]);
  try {
    await deps.audit?.append({
      inboxId: deps.accountId,
      alias: deps.workspaceName,
      operation: reactionOperation(options),
      outcome: 'ok',
      ids: reactionIds(options),
      approvalId,
      ...(reason === undefined ? {} : { reason }),
      ...(deps.surface ? { surface: deps.surface } : {}),
    });
  } catch (error) {
    unrecorded.push(`the audit log could not record it (${messageOf(error)})`);
  }
  const note = noteOf([unidentified ? NO_ID : undefined, known, ...unrecorded]);
  return {
    approvalId,
    ...(note === undefined ? {} : { note }),
    approval: approval ?? (await approvalNow(deps, approvalId, claim.claimed)),
  };
}

/** Applies one prepared reaction, once, through the permit. */
export async function reactPrepared(
  deps: PostDeps,
  approvalId: string,
  options: ReactionOptions,
): Promise<ReactionResult> {
  const digest = reactionDigest(deps, options);
  const claim = await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: digest,
      contentDigest: digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      expect: reactionExpectation(options),
    },
    waitingHint('reaction', deps.surface, approvalId, deps.handoffs),
  );
  // Claimed: the lease is renewed while Slack's answer is outstanding.
  return withSendingLease(deps.approvals, approvalId, claim.claimToken, async () => {
    const method: PostingMethod = options.remove ? 'reactions.remove' : 'reactions.add';
    // The fence (design 2026-10-05 §D1): the reaction starts only while this claim still holds the send.
    await fenceFirstStep(deps, approvalId, claim, reactionOperation(options), reactionIds(options));
    try {
      await spendOn(deps.permit, approvalId, method, () =>
        callSlack({ ...deps.call, permit: deps.permit }, method, {
          channel: options.channel,
          timestamp: options.ts,
          name: options.name,
        }),
      );
    } catch (error) {
      /*
       * `already_reacted` means the state this approval asked for already holds. Recording it as failed would tell a
       * caller to try the same outward act again, so it is used and audited as success, with Slack's answer in the note.
       */
      if (
        method === 'reactions.add' &&
        error instanceof CommsError &&
        error.details?.slackError === 'already_reacted'
      ) {
        return recordReactionChanged(
          deps,
          approvalId,
          claim,
          options,
          'Slack says this account had already added the reaction',
        );
      }
      /*
       * `no_reaction` means this account already has the state the removal asked for. Other people's reactions remain,
       * which the result says explicitly so success cannot be mistaken for removing the emoji from the message.
       */
      if (method === 'reactions.remove' && error instanceof CommsError && error.details?.slackError === 'no_reaction') {
        return recordReactionChanged(
          deps,
          approvalId,
          claim,
          options,
          'Slack says this account had no such reaction on the message, so there was nothing of yours to remove; reactions other people added are not affected.',
        );
      }
      if (error instanceof CommsError && certainlyRefused(error, method)) {
        throw await recordReactionRefused(deps, approvalId, claim, options, error);
      }
      throw await recordReactionUnknown(deps, approvalId, claim.claimed, options, error);
    }
    return recordReactionChanged(deps, approvalId, claim, options);
  });
}
