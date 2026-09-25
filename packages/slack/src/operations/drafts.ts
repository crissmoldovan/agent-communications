import { CommsError } from '@agentcomms/core';
import { type DraftStore, isUnreadableDraft, type SlackDraft } from '../compose/drafts.ts';

/**
 * A draft, if it belongs to the workspace being asked about.
 *
 * Drafts are stored by id in one directory shared by every workspace, so without this a caller naming workspace
 * A could read, prepare, post or delete workspace B's draft. Slack would probably refuse the channel id, which is
 * luck rather than a check — and on the two workspaces of one organisation that share channel ids, it would not.
 *
 * Shared by both surfaces for the same reason the gate's dependencies are: the MCP draft tools arrived after the
 * CLI's, and a second copy of this check is a second place to forget it. A draft of another workspace is reported
 * as absent rather than as forbidden, so a caller cannot use the difference to learn which ids exist elsewhere.
 */
export async function ownDraft(store: DraftStore, accountId: string, draftId: string): Promise<SlackDraft> {
  let found: SlackDraft;
  try {
    found = await store.get(draftId);
  } catch (error) {
    // A damaged draft of another workspace is absent here too; "could not be read" would say that it exists.
    if (isUnreadableDraft(error)) {
      const owner = await store.ownerOf(draftId);
      if (owner !== undefined && owner !== accountId) throw notHere(draftId);
    }
    throw error;
  }
  if (found.accountId !== accountId) throw notHere(draftId);
  return found;
}

function notHere(draftId: string): CommsError {
  return new CommsError('NOT_FOUND', `no draft "${draftId}" in this workspace`, {
    hint: 'List this workspace’s drafts with `agent-slack draft list --workspace <name>`.',
  });
}

export interface DeletedDraft {
  readonly draftId: string;
  readonly deleted: true;
  /** Set when the file could not be read as a draft: what it said was never shown, and is gone now. */
  readonly unreadable?: true;
  /**
   * For an unreadable draft, whether it still named this workspace. `false` means it named none, so nothing tied it
   * to any workspace and it was removed on its id alone.
   */
  readonly workspaceConfirmed?: boolean;
}

/**
 * Throws a draft away — including one too damaged to read, which is the draft most in need of it.
 *
 * Shared by `draft delete` and `slack_draft_delete`, for the reason `ownDraft` is. Both used to read the draft to
 * check whose it was, so one that would not parse refused the delete with advice to delete it, and `draft list`
 * skipped it: invisible, and there for good.
 *
 * Still scoped where that can be established. A damaged file that names another workspace is reported as absent,
 * exactly as a readable one would be. One that names nobody is removed, and the result says so, because no
 * workspace can be shown to own it and leaving it helps none of them.
 */
export async function deleteOwnDraft(store: DraftStore, accountId: string, draftId: string): Promise<DeletedDraft> {
  try {
    await ownDraft(store, accountId, draftId);
  } catch (error) {
    if (!isUnreadableDraft(error)) throw error;
    const owner = await store.ownerOf(draftId);
    if (owner !== undefined && owner !== accountId) throw notHere(draftId);
    await store.remove(draftId);
    return { draftId, deleted: true, unreadable: true, workspaceConfirmed: owner !== undefined };
  }
  await store.remove(draftId);
  return { draftId, deleted: true };
}
