import { type ApprovalRecord, CommsError, renderChannelPreview, truncateDisplay } from '@agentcomms/core';
import { openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import { gateDepsFor } from './gate.ts';
import { NameBook } from './people.ts';
import { type PostView, REACH_UNKNOWN, type ReactionOptions, reactionOfApproval, viewPost } from './send.ts';
import type { SessionDeps } from './session.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Approving a post or a reaction at a terminal.
 *
 * Separate from posting, and that separation is the point: an agent that could approve and post in one step could
 * post anything it liked. This command approves and does not post; the posting is a second act, which the
 * approval then permits exactly once.
 *
 * The challenge is read off the screen and typed back, so what is approved is what was *displayed* — not what a
 * caller claimed was displayed.
 */

export interface ApprovalPrompt {
  readonly approvalId: string;
  /** What the approval permits, so the command can say what it did and did not do. */
  readonly kind: 'post' | 'reaction';
  /** The preview as a person should read it, rendered from what the approval is bound to. */
  readonly preview: string;
  /** The code to type back. Never stored; only its hash is. */
  readonly challenge: string;
}

/** The approval, and the workspace it belongs to by its current name. */
async function approvalAndWorkspace(context: SlackContext, approvalId: string) {
  const record = await context.core.approvals.get(approvalId);
  if (!record) {
    throw new CommsError('NOT_FOUND', `no approval ${approvalId}`, {
      hint: 'Prepare it again; an approval expires ten minutes after it is made.',
    });
  }
  const config = await context.config();
  const entry = Object.entries(config.accounts).find(([, account]) => account.id === record.inboxId);
  if (!entry) {
    throw new CommsError('NOT_FOUND', 'the workspace this approval belongs to is no longer connected');
  }
  const [name, account] = entry;
  return { record, name, account };
}

/**
 * A reaction is one line, and this is it: which emoji, on which message, in which channel, as whom.
 *
 * Every part is escaped and cut to one line. The emoji name and the channel are whatever the agent passed, and this
 * is printed at the terminal of the person about to type a code — the one place a control sequence would do most
 * harm.
 */
function renderReaction(workspace: string, record: ApprovalRecord, reaction: ReactionOptions): string {
  const act = reaction.remove
    ? `Remove :${truncateDisplay(reaction.name, 60)}: from`
    : `Add :${truncateDisplay(reaction.name, 60)}: to`;
  return [
    [
      'REACTION PREVIEW',
      `workspace ${truncateDisplay(workspace, 120)}`,
      `approval ${record.approvalId}`,
      'nothing has been added — approving does not add it',
    ].join(' · '),
    `${act} the message at ${truncateDisplay(reaction.ts, 40)} in ${truncateDisplay(reaction.channel, 40)}, as ${truncateDisplay(record.inboxSub ?? 'this account', 60)}.`,
  ].join('\n');
}

/** What the reach of a post was when it was prepared, read from its expectation — `reaches 412`. */
function preparedReach(record: ApprovalRecord): string | undefined {
  return /^reaches (\d+)$/.exec(record.expect.subject)?.[1];
}

/**
 * The post as it would go now, and only if that is still what the approval binds.
 *
 * Read by both halves of approving — the screen, and the typed code that follows it — so neither can approve
 * something the other would have refused. `finishApproval` used to take the screen's word for the room, so a room
 * that could not be read by the time the code was typed was approved all the same.
 *
 * The draft alone is not enough. A post's approval binds who it reaches, and the screen used to render without the
 * room, so `@channel` to four hundred people read as a count that could not be read: the person typing the code was
 * never shown the number they were agreeing to. So the room is read again, the digest recomputed as the post will
 * recompute it, and a post that does not match the approval is never approved — an edited draft or a room that grew
 * would be refused at post time anyway, and a person should not be asked to agree to it first.
 */
async function currentPost(
  context: SlackContext,
  record: ApprovalRecord,
  workspace: string,
  deps: SessionDeps,
): Promise<{ draft: SlackDraft; view: PostView }> {
  const approvalId = record.approvalId;
  const drafts = openDraftStore(context.core.paths.stateDir, context.now);
  const draft = await drafts.get(record.draftId);
  const gate = await gateDepsFor(context, workspace, deps);
  const view = await viewPost(gate, draft, new NameBook());
  const edited = draft.revision !== record.draftMessageId;
  /*
   * A room that could not be read approves nothing, and the approval stays as it was, to be tried again.
   *
   * For a post that notifies the room this comes before any digest is compared. One prepared while the room could
   * not be read binds that same gap, so the digests agreed, the comparison below saw nothing wrong, and an `@channel`
   * nobody had counted was approved. It is never approved without a count. Any other post is refused here only when
   * the digests disagree: nothing is known to have changed, the room simply could not be read.
   */
  const notifiesRoom = view.preview.notifies.channel || view.preview.notifies.here;
  if (!edited && view.roomUnread && (notifiesRoom || view.digest !== record.digest)) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'the channel could not be read, so who this reaches cannot be shown', {
      hint: 'Nothing was approved. Try again in a moment.',
      details: { approvalId, reason: view.roomUnread },
    });
  }
  if (edited || view.digest !== record.digest) {
    const prepared = preparedReach(record);
    const reach = view.preview.notifies.estimated;
    /*
     * A reach that was not known at the preview is said to be that. Its expectation holds the `0` that stood in for
     * the count, and quoting it — "not the 0 it was prepared for" — told the person a number nobody had measured.
     */
    const reason = edited
      ? 'the draft was edited after the preview'
      : record.riskFlags.includes(REACH_UNKNOWN)
        ? 'the room could not be read when this was prepared; prepare it again to see who it reaches'
        : prepared !== undefined && prepared !== String(reach)
          ? `the channel now reaches ${reach}, not the ${prepared} it was prepared for`
          : 'the channel, or the account it posts as, is not what the preview showed';
    await context.core.approvals.revoke(approvalId, reason);
    throw new CommsError('APPROVAL_VOID', `nothing was approved: ${reason}`, {
      hint: 'Prepare the post again, and approve the preview that prints.',
      details: { approvalId },
    });
  }
  return { draft, view };
}

/**
 * Shows what is being approved, and issues the code that binds this screen to this approval.
 *
 * `deps` reaches Slack for a post, to read the room: see `currentPost`. A reaction asks Slack nothing.
 */
export async function beginApproval(
  context: SlackContext,
  approvalId: string,
  deps: SessionDeps = {},
): Promise<ApprovalPrompt> {
  const { record, name, account } = await approvalAndWorkspace(context, approvalId);

  const reaction = reactionOfApproval(record, account.workspace);
  if (reaction) {
    const challenge = await context.core.approvals.issueChallenge(approvalId);
    return { approvalId, kind: 'reaction', preview: renderReaction(name, record, reaction), challenge };
  }

  // Shown only if it is what the approval binds.
  const { view } = await currentPost(context, record, name, deps);
  const preview = renderChannelPreview({
    ...view.preview,
    context: { ...view.preview.context, approvalId, note: 'nothing has been posted — approving does not post it' },
  });

  const challenge = await context.core.approvals.issueChallenge(approvalId);
  return { approvalId, kind: 'post', preview, challenge };
}

/**
 * Records the approval, if the code typed back is the one shown.
 *
 * A post's room is read again first, with the same checks the screen made: see `currentPost`.
 */
export async function finishApproval(
  context: SlackContext,
  approvalId: string,
  answer: string,
  deps: SessionDeps = {},
): Promise<void> {
  const { record, name, account } = await approvalAndWorkspace(context, approvalId);
  /*
   * A reaction binds the record's own digest, checked again here as `beginApproval` checked it: there is no draft
   * to read, and reading its draft id as one is what made every reaction unapprovable.
   */
  if (reactionOfApproval(record, account.workspace)) {
    await context.core.approvals.approve(
      approvalId,
      'terminal',
      { draftMessageId: record.draftMessageId, digest: record.digest },
      answer,
    );
    return;
  }
  const { draft, view } = await currentPost(context, record, name, deps);
  await context.core.approvals.approve(
    approvalId,
    'terminal',
    { draftMessageId: draft.revision, digest: view.digest },
    answer,
  );
}

export async function revokeApproval(context: SlackContext, approvalId: string): Promise<void> {
  await context.core.approvals.revoke(approvalId, 'cancelled at the terminal');
}

/** The workspace an approval belongs to, by its current name. */
export async function workspaceForApproval(context: SlackContext, approvalId: string): Promise<string> {
  const record = await context.core.approvals.get(approvalId);
  if (!record) throw new CommsError('NOT_FOUND', `no approval ${approvalId}`);
  const config = await context.config();
  const entry = Object.entries(config.accounts).find(([, account]) => account.id === record.inboxId);
  if (!entry) throw new CommsError('NOT_FOUND', 'the workspace this approval belongs to is no longer connected');
  requireWorkspace(config, entry[0]);
  return entry[0];
}
