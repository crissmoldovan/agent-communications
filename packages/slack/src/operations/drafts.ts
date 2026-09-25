import { CommsError } from '@agentcomms/core';
import type { DraftStore, SlackDraft } from '../compose/drafts.ts';

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
  const found = await store.get(draftId);
  if (found.accountId !== accountId) {
    throw new CommsError('NOT_FOUND', `no draft "${draftId}" in this workspace`, {
      hint: 'List this workspace’s drafts with `agent-slack draft list --workspace <name>`.',
    });
  }
  return found;
}
