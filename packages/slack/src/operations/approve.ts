import {
  type ApprovalRecord,
  approvalNotFound,
  CommsError,
  ensureSendEpochConfig,
  ownerOf,
  renderChannelPreview,
  truncateDisplay,
} from '@agentcomms/core';
import { openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import {
  type DeletionView,
  deletionOfApproval,
  type EditView,
  editOfApproval,
  renderDeletionPreview,
  viewDeletion,
  viewEdit,
} from './amend.ts';
import { gateDepsFor } from './gate.ts';
import { NameBook } from './people.ts';
import { type PostView, REACH_UNKNOWN, type ReactionOptions, reactionOfApproval, viewPost } from './send.ts';
import type { SessionDeps } from './session.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Approving a post, a reaction, an edit or a deletion at a terminal.
 *
 * Separate from posting, and that separation is the point: an agent that could approve and post in one step could
 * post anything it liked. This command approves and does not post; the posting is a second act, which the
 * approval then permits exactly once.
 *
 * The challenge is read off the screen and typed back, so what is approved is what was *displayed* — not what a
 * caller claimed was displayed.
 */

/**
 * What this command approves: a Slack send — a post, a reaction, an edit or a deletion — and nothing of another
 * channel's (§D2).
 */
const SLACK_SEND = { kind: 'send', channel: 'slack' } as const;

export interface ApprovalPrompt {
  readonly approvalId: string;
  /** What the approval permits, so the command can say what it did and did not do. */
  readonly kind: 'post' | 'reaction' | 'edit' | 'delete';
  /** The preview as a person should read it, rendered from what the approval is bound to. */
  readonly preview: string;
  /** The code to type back. Never stored; only its hash is. */
  readonly challenge: string;
}

/**
 * The approval, classified under its lock for the approval a person is about to give (design 2026-10-05 §D2), and the
 * workspace it belongs to by its current name.
 *
 * A Slack post's or reaction's, or the one NOT_FOUND — an id of another channel or another kind is not found, as one
 * nobody prepared is not. Then anything that cannot be approved is refused for what it is, with where it stands, before
 * the room or the draft is read: corrupt, an earlier release's, expired, used, revoked — now, because its workspace was
 * removed or posting was turned off — or under way.
 */
async function approvalAndWorkspace(context: SlackContext, approvalId: string) {
  const { outcome } = await context.core.approvals.inspect(approvalId, SLACK_SEND, { action: 'approve' });
  if (outcome.error) throw outcome.error;
  const record = outcome.record;
  if (record === null) throw new CommsError('UNEXPECTED', 'a send approval read as no record');
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
  const drafts = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
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
  if (!edited && view.roomUnread && (notifiesRoom || view.digest !== record.contentDigest)) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'the channel could not be read, so who this reaches cannot be shown', {
      hint: 'Nothing was approved. Try again in a moment.',
      details: { approvalId, reason: view.roomUnread },
    });
  }
  /*
   * A room read without its count is the same gap. Slack answers some conversations with no `num_members` — a direct
   * message, for one — and keying the refusal only on a failed read let that `@channel` through with its reach shown
   * as "not known". Never approved without a count, whichever way the count went missing.
   */
  const uncounted = notifiesRoom ? view.preview.notifies.unknown : undefined;
  if (!edited && uncounted !== undefined) {
    throw new CommsError(
      'PROVIDER_UNAVAILABLE',
      'the channel’s members could not be counted, so who this reaches cannot be shown',
      {
        hint: 'Nothing was approved. Remove the @channel or @here, or post it from Slack itself.',
        details: { approvalId, reason: uncounted },
      },
    );
  }
  if (edited || view.digest !== record.contentDigest) {
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
    const voided = await context.core.approvals.revoke(approvalId, reason, {
      disposition: 'integrity',
      expect: { kind: 'send' },
    });
    throw new CommsError('APPROVAL_VOID', `nothing was approved: ${reason}`, {
      hint: 'Prepare the post again, and approve the preview that prints.',
      details: {
        approvalId,
        approval: voided.form === 'v2' ? await context.core.approvals.approvalOf(voided.record) : null,
      },
    });
  }
  return { draft, view };
}

/** Revokes an approval whose act is no longer the one it was prepared for, and returns the refusal to throw. */
async function voidIntegrity(
  context: SlackContext,
  approvalId: string,
  reason: string,
  act: 'edit' | 'deletion',
): Promise<CommsError> {
  const voided = await context.core.approvals.revoke(approvalId, reason, {
    disposition: 'integrity',
    expect: { kind: 'send' },
  });
  return new CommsError('APPROVAL_VOID', `nothing was approved: ${reason}`, {
    hint: `Prepare the ${act} again, and approve the preview that prints.`,
    details: {
      approvalId,
      approval: voided.form === 'v2' ? await context.core.approvals.approvalOf(voided.record) : null,
    },
  });
}

/**
 * The deletion as it would be made now, and only if that is still what the approval binds — `currentPost` for a
 * deletion. The message is read again; one edited in Slack since the preview, or whose thread gained a reply, is not
 * what the person was shown, so its approval is void rather than offered to them.
 */
async function currentDeletion(
  context: SlackContext,
  record: ApprovalRecord,
  workspace: string,
  where: { channel: string; ts: string },
  deps: SessionDeps,
): Promise<DeletionView> {
  const gate = await gateDepsFor(context, workspace, deps);
  const view = await viewDeletion(gate, where, new NameBook());
  if (view.digest !== record.contentDigest) {
    throw await voidIntegrity(
      context,
      record.approvalId,
      'the message, or its thread, is not what the preview showed',
      'deletion',
    );
  }
  return view;
}

/** What the reach of an edit was when it was prepared, read from its expectation — `edits 1.2, reaches 412`. */
function preparedEditReach(record: ApprovalRecord): string | undefined {
  return /, reaches (\d+)$/.exec(record.expect.subject)?.[1];
}

/**
 * The edit as it would be made now, and only if that is still what the approval binds — `currentPost` for an edit.
 *
 * Its draft, the message and the room are all read again. A room that could not be read approves no edit that
 * notifies it, for the reason a post's does not; anything that changed voids the approval.
 */
async function currentEdit(
  context: SlackContext,
  record: ApprovalRecord,
  workspace: string,
  ts: string,
  deps: SessionDeps,
): Promise<{ draft: SlackDraft; view: EditView }> {
  const drafts = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const draft = await drafts.get(record.draftId);
  const gate = await gateDepsFor(context, workspace, deps);
  const view = await viewEdit(gate, draft, ts, new NameBook());
  const edited = draft.revision !== record.draftMessageId;
  const notifiesRoom = view.preview.notifies.channel || view.preview.notifies.here;
  if (!edited && view.roomUnread && (notifiesRoom || view.digest !== record.contentDigest)) {
    throw new CommsError('PROVIDER_UNAVAILABLE', 'the channel could not be read, so who this reaches cannot be shown', {
      hint: 'Nothing was approved. Try again in a moment.',
      details: { approvalId: record.approvalId, reason: view.roomUnread },
    });
  }
  if (edited || view.digest !== record.contentDigest) {
    const prepared = preparedEditReach(record);
    const reach = view.preview.notifies.estimated;
    const reason = edited
      ? 'the draft was edited after the preview'
      : record.riskFlags.includes(REACH_UNKNOWN)
        ? 'the room could not be read when this was prepared; prepare it again to see who it reaches'
        : prepared !== undefined && prepared !== String(reach)
          ? `the channel now reaches ${reach}, not the ${prepared} it was prepared for`
          : 'the message, the channel, or the account it posts as is not what the preview showed';
    throw await voidIntegrity(context, record.approvalId, reason, 'edit');
  }
  return { draft, view };
}

/**
 * Shows what is being approved, and issues the code that binds this screen to this approval.
 *
 * `deps` reaches Slack for a post, to read the room — see `currentPost` — and for an edit or a deletion, to read the
 * message as well. A reaction asks Slack nothing.
 */
export async function beginApproval(
  context: SlackContext,
  approvalId: string,
  deps: SessionDeps = {},
): Promise<ApprovalPrompt> {
  const { record, name, account } = await approvalAndWorkspace(context, approvalId);

  const reaction = reactionOfApproval(record, account.workspace);
  if (reaction) {
    const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform);
    return { approvalId, kind: 'reaction', preview: renderReaction(name, record, reaction), challenge };
  }

  // A deletion and an edit read the message again, as a post reads the room: shown only if it is what is bound.
  const deletion = deletionOfApproval(record);
  if (deletion) {
    const view = await currentDeletion(context, record, name, deletion, deps);
    const preview = renderDeletionPreview({
      ...view.preview,
      context: { ...view.preview.context, approvalId, note: 'nothing has been deleted — approving does not delete it' },
    });
    const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform);
    return { approvalId, kind: 'delete', preview, challenge };
  }
  const edit = editOfApproval(record);
  if (edit) {
    const { view } = await currentEdit(context, record, name, edit.ts, deps);
    const preview = renderChannelPreview({
      ...view.preview,
      context: { ...view.preview.context, approvalId, note: 'nothing has been changed — approving does not change it' },
    });
    const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform);
    return { approvalId, kind: 'edit', preview, challenge };
  }

  // Shown only if it is what the approval binds.
  const { view } = await currentPost(context, record, name, deps);
  const preview = renderChannelPreview({
    ...view.preview,
    context: { ...view.preview.context, approvalId, note: 'nothing has been posted — approving does not post it' },
  });

  const challenge = await context.core.approvals.issueChallenge(approvalId, 'send', context.platform);
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
  // First, as every approval does: version 3, and an earlier release's records retired.
  await ensureSendEpochConfig(context.core, { now: context.now });
  const { record, name, account } = await approvalAndWorkspace(context, approvalId);
  /*
   * A reaction binds the record's own digest, checked again here as `beginApproval` checked it: there is no draft
   * to read, and reading its draft id as one is what made every reaction unapprovable.
   */
  if (reactionOfApproval(record, account.workspace)) {
    await context.core.approvals.approve(
      approvalId,
      'terminal',
      { draftMessageId: record.draftMessageId, contentDigest: record.contentDigest },
      answer,
      'send',
      context.platform,
    );
    return;
  }
  const deletion = deletionOfApproval(record);
  if (deletion) {
    const view = await currentDeletion(context, record, name, deletion, deps);
    await context.core.approvals.approve(
      approvalId,
      'terminal',
      { draftMessageId: view.digest, contentDigest: view.digest },
      answer,
      'send',
      context.platform,
    );
    return;
  }
  const edit = editOfApproval(record);
  const { draft, view } =
    edit === undefined
      ? await currentPost(context, record, name, deps)
      : await currentEdit(context, record, name, edit.ts, deps);
  await context.core.approvals.approve(
    approvalId,
    'terminal',
    { draftMessageId: draft.revision, contentDigest: view.digest },
    answer,
    'send',
    context.platform,
  );
}

export async function revokeApproval(context: SlackContext, approvalId: string): Promise<void> {
  await context.core.approvals.revoke(approvalId, 'cancelled at the terminal', { disposition: 'person' });
}

/** The workspace an approval belongs to, by its current name. */
export async function workspaceForApproval(context: SlackContext, approvalId: string): Promise<string> {
  // Whose it is, looked at under its lock as a Slack post's or reaction's, from a record that can be trusted to say — a
  // version-2 record, or the stored owner of one an earlier release prepared. One that cannot is the one NOT_FOUND,
  // as an id nobody prepared, of another kind or of another channel is.
  // As the approval about to be given: a revocation the classification derives — its workspace removed, posting
  // turned off since — is written now, by this first step of it.
  const { stored, outcome } = await context.core.approvals.inspect(approvalId, SLACK_SEND, { action: 'approve' });
  const owner = ownerOf(stored);
  if (owner === null) throw approvalNotFound(approvalId, 'send');
  const config = await context.config();
  const entry = Object.entries(config.accounts).find(([, account]) => account.id === owner);
  // Its workspace removed: the classification already says what that makes of it.
  if (!entry) {
    throw outcome.error ?? new CommsError('NOT_FOUND', 'the workspace this approval belongs to is no longer connected');
  }
  requireWorkspace(config, entry[0], context.handoffs);
  return entry[0];
}
