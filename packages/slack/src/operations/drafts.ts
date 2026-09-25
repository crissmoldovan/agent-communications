import { CommsError } from '@agentcomms/core';
import { type Broadcast, type ComposedPayload, compose, type Mention } from '../compose/blocks.ts';
import { type DraftStore, isUnreadableDraft, openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import { requireWorkspace } from './workspaces.ts';

/** A message to write as a draft: what `draft create` takes, and `slack_post_prepare` when it is given no draft. */
export interface DraftInput {
  readonly channel: string;
  readonly text: string;
  readonly threadTs?: string | undefined;
  /** People to mention, by user id. Each is checked to be one: see `renderMention`. */
  readonly mentionUsers?: readonly string[] | undefined;
  /**
   * `here`, `channel` or `everyone`, and nothing else.
   *
   * `unknown` rather than `Broadcast`, because this is where it is checked: the CLI's `--broadcast` took any word until
   * it had choices, and `--broadcast subteam^S0123` wrote a user-group mention that the preview counted as nobody. Each
   * surface's own parser refuses what it can; this refuses it for all of them.
   */
  readonly broadcast?: unknown;
}

/**
 * The payload a draft input composes to, or the refusal — the same for every surface, before anything is written.
 *
 * Every mention is written by `renderMention`, which checks it. Nothing else can put a span in the text: the author's
 * words are escaped, so a `<!here>` typed into them is shown as those characters and notifies nobody.
 */
export function draftPayload(input: DraftInput): ComposedPayload {
  const mentions: Mention[] = [
    ...(input.mentionUsers ?? []).map((id) => ({ kind: 'user' as const, id })),
    ...(input.broadcast === undefined ? [] : [{ kind: 'broadcast' as const, who: input.broadcast as Broadcast }]),
  ];
  return compose({ channel: input.channel, text: input.text, threadTs: input.threadTs, mentions });
}

/** Writes a draft for this workspace: `agent-slack draft create`. Nothing reaches Slack. */
export async function createDraft(context: SlackContext, alias: string, input: DraftInput): Promise<SlackDraft> {
  const { account } = requireWorkspace(await context.config(), alias);
  const payload = draftPayload(input);
  return openDraftStore(context.core.paths.stateDir, context.now).create(account.id, payload, input.text);
}

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
