import { CommsError, renderChannelPreview } from '@agentcomms/core';
import { openDraftStore } from '../compose/drafts.ts';
import { previewOf } from '../compose/preview.ts';
import type { SlackContext } from '../context.ts';
import { NameBook } from './people.ts';
import { requireWorkspace } from './workspaces.ts';

/**
 * Approving a post at a terminal.
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
  /** The preview as a person should read it, rendered from the draft the approval is bound to. */
  readonly preview: string;
  /** The code to type back. Never stored; only its hash is. */
  readonly challenge: string;
}

/** Shows what is being approved, and issues the code that binds this screen to this approval. */
export async function beginApproval(context: SlackContext, approvalId: string): Promise<ApprovalPrompt> {
  const record = await context.core.approvals.get(approvalId);
  if (!record) {
    throw new CommsError('NOT_FOUND', `no approval ${approvalId}`, {
      hint: 'Prepare the post again; an approval expires ten minutes after it is made.',
    });
  }
  const config = await context.config();
  const entry = Object.entries(config.accounts).find(([, account]) => account.id === record.inboxId);
  if (!entry) {
    throw new CommsError('NOT_FOUND', 'the workspace this approval belongs to is no longer connected');
  }
  const [name] = entry;

  /*
   * Rendered from the draft, not from anything the preparing process said.
   *
   * The approval binds a digest; this is the human-readable form of the same thing. Reading it from the draft as
   * it is *now* means a draft edited since the preparation shows its edited self here — and the digest check at
   * post time then refuses it, rather than a person approving one thing and another going out.
   */
  const drafts = openDraftStore(context.core.paths.stateDir, context.now);
  const draft = await drafts.get(record.draftId);
  const preview = previewOf({
    draft,
    workspace: name,
    postingAs: record.inboxSub ?? 'this account',
    channel: undefined,
    book: new NameBook(),
    approvalId,
    note: 'nothing has been posted — approving does not post it',
  });

  const challenge = await context.core.approvals.issueChallenge(approvalId);
  return { approvalId, preview: renderChannelPreview(preview), challenge };
}

/** Records the approval, if the code typed back is the one shown. */
export async function finishApproval(context: SlackContext, approvalId: string, answer: string): Promise<void> {
  const record = await context.core.approvals.get(approvalId);
  if (!record) throw new CommsError('NOT_FOUND', `no approval ${approvalId}`);
  const drafts = openDraftStore(context.core.paths.stateDir, context.now);
  const draft = await drafts.get(record.draftId);
  await context.core.approvals.approve(
    approvalId,
    'terminal',
    { draftMessageId: draft.revision, digest: record.digest },
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
