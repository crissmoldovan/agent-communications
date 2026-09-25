import { CommsError } from '@agentcomms/core';
import { type Broadcast, type ComposedPayload, compose, composedFrom, type Mention } from '../compose/blocks.ts';
import { type DraftStore, isUnreadableDraft, openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import { decodeSlackText } from '../text/decode.ts';
import { changedOutsideHint, postedPayload } from './send.ts';
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

/**
 * Why a draft is not as agent-slack wrote it: the code and the words the gate uses, and which of two things it is.
 *
 * - `not-composed` — its blocks, or another part of its payload, are not what its text composes to. The gate refuses
 *   to prepare, approve or post it, and showing it is refused in the same words; a list names it with them.
 * - `source-differs` — what it posts is whole, but the words it keeps as typed are not the ones it posts. The gate
 *   would post its `text`, so that is what it is shown as, and the words it keeps are not shown at all.
 */
export interface DraftProblem {
  readonly code: 'BAD_DATA';
  readonly reason: 'not-composed' | 'source-differs';
  readonly message: string;
  readonly hint: string;
}

/**
 * A draft as it would post: what `draft show`, `draft list`, `slack_draft_get` and `slack_draft_list` give.
 *
 * They gave the draft file, and a person reading one was shown its `source` — the words the author typed, which
 * nothing posts. The gate composes the payload again from the draft's `text` and posts that, so a file edited so the
 * two disagreed was shown as one message and prepared, approved and posted as another. This is built from the
 * payload the gate would send, by the gate's own `postedPayload`, so what a draft is shown as and what it posts are
 * one reading of one file, refused for the same reason in the same words.
 */
export interface DraftView {
  readonly draftId: string;
  /** Where it would post. */
  readonly channel: string;
  readonly threadTs?: string | undefined;
  /**
   * What it would post, as the channel will read it: the payload's text with Slack's escaping undone and each mention
   * as its id — `@U024BE7LH`, which the preview puts a name to. Absent from a list's row for a draft the gate refuses.
   */
  readonly text?: string | undefined;
  /** The words as the author typed them, which an edit starts from: only when they are the words it posts. */
  readonly source?: string | undefined;
  /** Set when the file was changed outside agent-slack — see {@link DraftProblem}. */
  readonly problem?: DraftProblem | undefined;
  /** What would be sent, byte for byte: the payload the gate composes again and posts. Absent when it refuses. */
  readonly payload?: ComposedPayload | undefined;
  readonly revision: string;
  readonly accountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** The part of a view every draft has, whether or not it would post. */
function heading(draft: SlackDraft): Pick<DraftView, 'draftId' | 'channel' | 'threadTs'> {
  // Only a string: a file the gate refuses may hold anything here, and this is shown beside the refusal.
  const threadTs: unknown = draft.payload.thread_ts;
  return {
    draftId: draft.draftId,
    channel: draft.payload.channel,
    ...(typeof threadTs === 'string' ? { threadTs } : {}),
  };
}

function kept(draft: SlackDraft): Pick<DraftView, 'revision' | 'accountId' | 'createdAt' | 'updatedAt'> {
  return {
    revision: draft.revision,
    accountId: draft.accountId,
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
  };
}

/**
 * One draft as it would post — or the gate's refusal, thrown as the gate throws it.
 *
 * The payload is `postedPayload`'s, which is what `viewPost` checks before anyone is shown anything and what
 * `postPrepared` sends, so a draft is refused here exactly when preparing or posting it would be, and is shown as
 * exactly what they would send.
 */
export function viewDraft(draft: SlackDraft): DraftView {
  const payload = postedPayload(draft);
  const written = composedFrom(draft.source, payload.text);
  return {
    ...heading(draft),
    text: decodeSlackText(payload.text).text,
    ...(written
      ? { source: draft.source }
      : {
          problem: {
            code: 'BAD_DATA',
            reason: 'source-differs',
            message: `draft "${draft.draftId}" is not what its source composes to, so the words it keeps as typed are not what it posts`,
            hint: changedOutsideHint(draft.draftId),
          },
        }),
    payload,
    ...kept(draft),
  };
}

/** One draft of this workspace, as it would post: `agent-slack draft show` and `slack_draft_get`. */
export async function showDraft(context: SlackContext, alias: string, draftId: string): Promise<DraftView> {
  const { account } = requireWorkspace(await context.config(), alias);
  // Whose it is before what it says: another workspace's draft is absent here, refused or not.
  const draft = await ownDraft(openDraftStore(context.core.paths.stateDir, context.now), account.id, draftId);
  return viewDraft(draft);
}

/**
 * This workspace's drafts, newest first, each as it would post: `agent-slack draft list` and `slack_draft_list`.
 *
 * A draft the gate refuses is listed, not dropped and not shown: its row carries the gate's refusal and neither the
 * text nor the payload it holds, since neither is what would post. Dropping it would hide the one draft somebody
 * needs to delete; failing the list for it would hide all the others.
 */
export async function listDrafts(context: SlackContext, alias: string): Promise<DraftView[]> {
  const { account } = requireWorkspace(await context.config(), alias);
  const drafts = await openDraftStore(context.core.paths.stateDir, context.now).list(account.id);
  return drafts.map((draft) => {
    try {
      return viewDraft(draft);
    } catch (error) {
      if (!(error instanceof CommsError) || error.details?.reason !== 'not-composed') throw error;
      return {
        ...heading(draft),
        problem: { code: 'BAD_DATA', reason: 'not-composed', message: error.message, hint: error.hint ?? '' },
        ...kept(draft),
      };
    }
  });
}
