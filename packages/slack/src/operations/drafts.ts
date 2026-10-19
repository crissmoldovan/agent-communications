import {
  type AttachPolicy,
  type CliHandoffs,
  CommsError,
  defaultAttachDeny,
  type EvidenceScope,
  expandHome,
  handoffSentenceToFill,
  homeDirectory,
  type UnsentRow,
  type UnsentStatus,
  unsentReport,
} from '@agentcomms/core';
import {
  type Broadcast,
  type ComposedPayload,
  compose,
  composedFrom,
  escapeForSlack,
  type Mention,
} from '../compose/blocks.ts';
import { type DraftStore, isUnreadableDraft, openDraftStore, type SlackDraft } from '../compose/drafts.ts';
import { checkFileCount, recordFiles, type SlackDraftFile } from '../compose/files.ts';
import type { SlackContext } from '../context.ts';
import { decodeSlackText } from '../text/decode.ts';
import { requireConversation } from './destination.ts';
import { requireMessageTs } from './message.ts';
import { changedOutsideHint, postedPayload } from './send.ts';
import { requireWorkspace } from './workspaces.ts';

/** A message to write as a draft: what `draft create` takes, and `slack_post_prepare` when it is given no draft. */
export interface DraftInput {
  readonly channel: string;
  /**
   * What it says. Needed for a post of text alone; with files it may be left out, and when given it is posted as the
   * files' message, so the two arrive as one post.
   */
  readonly text?: string | undefined;
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
  /**
   * Local files to post, by path, in the order they should appear. Each is checked, measured, hashed and typed when the
   * draft is written — see `recordFiles` — and at most ten go on one draft.
   */
  readonly files?: readonly string[] | undefined;
}

/**
 * The payload a draft input composes to, or the refusal — the same for every surface, before anything is written.
 *
 * Every mention is written by `renderMention`, which checks it. Nothing else can put a span in the text: the author's
 * words are escaped, so a `<!here>` typed into them is shown as those characters and notifies nobody.
 */
export function draftPayload(input: DraftInput): ComposedPayload {
  // A thread no message ts names is refused: Slack would post the reply as a new message instead (spec 2, finding 9).
  if (input.threadTs !== undefined) requireMessageTs(input.threadTs);
  const mentions: Mention[] = [
    ...(input.mentionUsers ?? []).map((id) => ({ kind: 'user' as const, id })),
    ...(input.broadcast === undefined ? [] : [{ kind: 'broadcast' as const, who: input.broadcast as Broadcast }]),
  ];
  return compose({ channel: input.channel, text: input.text ?? '', threadTs: input.threadTs, mentions });
}

/**
 * Which local files may go on a draft: exactly the folders Gmail attaches from, read from the same configuration.
 *
 * The same home the rest of this process uses, and not the account's real one — without it the jail would judge the
 * rule that never sends from a hidden folder against the wrong home.
 */
export async function attachPolicyOf(context: SlackContext): Promise<AttachPolicy> {
  const config = await context.config();
  const home = homeDirectory(context.env);
  return {
    roots: config.defaults.attachRoots.map((root) => expandHome(root, home)),
    deny: [...defaultAttachDeny(context.core.paths.configDir, context.env), ...config.defaults.attachDeny],
    home,
    // The jail's refusal names core's `attach roots add`, located from this installation.
    handoffs: context.handoffs,
  };
}

/** The refusal for a draft that would post nothing: no words and no files. */
function nothingToPost(): CommsError {
  return new CommsError('USAGE', 'a draft needs something to post: text, files or both', {
    hint: 'Give the text, or one or more files, or both.',
  });
}

/**
 * Writes a draft for this workspace: `agent-slack draft create`. Nothing reaches Slack.
 *
 * The message is composed first, so a mention that is refused is refused before any file is read; then the files are
 * checked and recorded, and the draft is written only once every one of them has been.
 */
export async function createDraft(context: SlackContext, alias: string, input: DraftInput): Promise<SlackDraft> {
  const { account } = requireWorkspace(await context.config(), alias, context.handoffs);
  requireConversation(input.channel, alias, context.handoffs);
  const paths = input.files ?? [];
  if (input.text === undefined && paths.length === 0) throw nothingToPost();
  const payload = draftPayload(input);
  checkFileCount(paths.length);
  const files = paths.length === 0 ? [] : await recordFiles(paths, await attachPolicyOf(context));
  return openDraftStore(context.core.paths.stateDir, context.now, context.handoffs).create(
    account.id,
    payload,
    input.text ?? '',
    files,
  );
}

/**
 * What an update changes. Each field left out keeps what the draft has; each given replaces it.
 *
 * `files` replaces the list of files — an empty list takes them all off — and `addFiles` adds to the end of it. Both
 * together replace the list and then add, in that order.
 */
export interface DraftChange {
  readonly channel?: string | undefined;
  readonly text?: string | undefined;
  readonly threadTs?: string | undefined;
  readonly mentionUsers?: readonly string[] | undefined;
  readonly broadcast?: unknown;
  readonly files?: readonly string[] | undefined;
  readonly addFiles?: readonly string[] | undefined;
}

/**
 * The mentions a draft's text starts with, read back as what `draftPayload` wrote them from: user ids and a broadcast.
 *
 * A draft keeps its mentions only as the spans written in front of the author's words, so keeping them across an edit
 * of the words means reading them back. What `draftPayload` writes is user mentions and one broadcast; anything else
 * standing there was not written by it, and the draft is refused as the gate refuses a draft changed by hand.
 */
function mentionsOf(
  draft: SlackDraft,
  text: string,
  handoffs: CliHandoffs,
): { users: string[]; broadcast: string | undefined } {
  const body = escapeForSlack(draft.source);
  const changed = (): CommsError =>
    new CommsError('BAD_DATA', `draft "${draft.draftId}" is not what its source composes to, so it cannot be edited`, {
      hint: changedOutsideHint(draft.draftId, handoffs),
      details: { draftId: draft.draftId, reason: 'source-differs' },
    });
  if (!composedFrom(draft.source, text)) throw changed();
  if (text === body) return { users: [], broadcast: undefined };
  const users: string[] = [];
  let broadcast: string | undefined;
  for (const span of text.slice(0, text.length - body.length - 1).split(' ')) {
    const user = /^<@([^<>]+)>$/.exec(span);
    const room = /^<!([^<>]+)>$/.exec(span);
    if (user?.[1] !== undefined) users.push(user[1]);
    else if (room?.[1] !== undefined && broadcast === undefined) broadcast = room[1];
    else throw changed();
  }
  return { users, broadcast };
}

/**
 * Changes a draft of this workspace: `agent-slack draft update` and `slack_draft_update`. Nothing reaches Slack.
 *
 * Every update is a new revision, whatever it changed — even nothing — and an approval is bound to the revision it was
 * prepared for, so an update voids any approval the draft had: what was approved is no longer what would post. The new
 * version is composed and every added file recorded before anything is saved, so a refused update leaves the draft
 * exactly as it was. Files kept from before keep what was recorded about them; if one has changed on disk since, the
 * gate says so when the draft is prepared.
 */
export async function updateDraft(
  context: SlackContext,
  alias: string,
  draftId: string,
  change: DraftChange,
): Promise<SlackDraft> {
  const { account } = requireWorkspace(await context.config(), alias, context.handoffs);
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const draft = await ownDraft(store, account.id, draftId);
  // As the gate would post it, or its refusal: a draft changed outside agent-slack is composed again, not edited.
  const posted = postedPayload(draft, context.handoffs);
  const kept = mentionsOf(draft, posted.text, context.handoffs);
  const next: DraftInput = {
    channel: change.channel ?? posted.channel,
    text: change.text ?? draft.source,
    threadTs: change.threadTs ?? posted.thread_ts,
    mentionUsers: change.mentionUsers ?? kept.users,
    broadcast: change.broadcast ?? kept.broadcast,
  };
  requireConversation(next.channel, alias, context.handoffs);
  const payload = draftPayload(next);

  const staying = change.files === undefined ? (draft.files ?? []) : [];
  const adding = [...(change.files ?? []), ...(change.addFiles ?? [])];
  checkFileCount(staying.length + adding.length);
  const files = [
    ...staying,
    ...(adding.length === 0 ? [] : await recordFiles(adding, await attachPolicyOf(context), staying.length)),
  ];
  if (payload.text.trim() === '' && files.length === 0) throw nothingToPost();
  return store.update(draft.draftId, payload, next.text ?? '', files);
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
      if (owner !== undefined && owner !== accountId) throw notHere(draftId, store.handoffs);
    }
    throw error;
  }
  if (found.accountId !== accountId) throw notHere(draftId, store.handoffs);
  return found;
}

function notHere(draftId: string, handoffs: CliHandoffs): CommsError {
  return new CommsError('NOT_FOUND', `no draft "${draftId}" in this workspace`, {
    hint: handoffSentenceToFill(
      handoffs.own(['draft', 'list', '--workspace']),
      ['<name>'],
      (command) => `List this workspace’s drafts with ${command}.`,
      { instead: 'List this workspace’s drafts with slack_draft_list from a chat.' },
    ),
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
    if (owner !== undefined && owner !== accountId) throw notHere(draftId, store.handoffs);
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
  /**
   * The local files it would post, as the draft recorded them: each is read again, and must still match, when it is
   * prepared and when it is sent. Absent on a post of text alone.
   */
  readonly files?: readonly SlackDraftFile[] | undefined;
  readonly revision: string;
  readonly accountId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * A list's row only: what the approval records read say of this exact revision, when a post of it was prepared in
   * the last seven days and either its last preparation expired or an approval of it was used, is under way or still
   * stands — one entry for each content digest it was prepared with (design 2026-10-05 §D9). Absent otherwise.
   */
  readonly unsent?: readonly DraftSendHistory[] | undefined;
}

/**
 * What the approval records read say of one exact revision of a draft, prepared with one content digest (design
 * 2026-10-05 §D9): keyed by workspace, draft, revision and digest — so a post of another revision, identical or not,
 * never hides it, and it never hides one.
 */
export interface DraftSendHistory {
  /**
   * Where it stands by the records read: `unsent` (in the scope's words), `approved`, `sending`, `used`, `unknown` or
   * `indeterminate`.
   */
  readonly status: UnsentStatus;
  /** The finding, in its exact words. */
  readonly said: string;
  /** What the scan behind it read: every retained record, the newest 500, or not enough to say. */
  readonly evidence: EvidenceScope;
  /** The content digest this revision was prepared with. */
  readonly contentDigest: string;
  /** The last preparation, and when it expired, if it did. */
  readonly last: UnsentRow['last'];
  /** The approval that decided a status other than `unsent` or `indeterminate`. */
  readonly decidedBy?: string | undefined;
}

/** The part of a view every draft has, whether or not it would post. */
function heading(draft: SlackDraft): Pick<DraftView, 'draftId' | 'channel' | 'threadTs'> {
  // Only a string: the gate refuses a draft holding anything else here (see `postedPayload`), and this is shown beside
  // that refusal.
  const threadTs: unknown = draft.payload.thread_ts;
  return {
    draftId: draft.draftId,
    channel: draft.payload.channel,
    ...(typeof threadTs === 'string' ? { threadTs } : {}),
  };
}

/** A draft's files, when it has any — so a view of a post of text alone is the view it always was. */
function filesOf(draft: SlackDraft): Pick<DraftView, 'files'> {
  return draft.files === undefined || draft.files.length === 0 ? {} : { files: draft.files };
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
export function viewDraft(draft: SlackDraft, handoffs: CliHandoffs): DraftView {
  const payload = postedPayload(draft, handoffs);
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
            hint: changedOutsideHint(draft.draftId, handoffs),
          },
        }),
    payload,
    ...filesOf(draft),
    ...kept(draft),
  };
}

/** One draft of this workspace, as it would post: `agent-slack draft show` and `slack_draft_get`. */
export async function showDraft(context: SlackContext, alias: string, draftId: string): Promise<DraftView> {
  const { account } = requireWorkspace(await context.config(), alias, context.handoffs);
  // Whose it is before what it says: another workspace's draft is absent here, refused or not.
  const draft = await ownDraft(
    openDraftStore(context.core.paths.stateDir, context.now, context.handoffs),
    account.id,
    draftId,
  );
  return viewDraft(draft, context.handoffs);
}

/**
 * This workspace's drafts, newest first, each as it would post: `agent-slack draft list` and `slack_draft_list`.
 *
 * A draft the gate refuses is listed, not dropped and not shown: its row carries the gate's refusal and neither the
 * text nor the payload it holds, since neither is what would post. Dropping it would hide the one draft somebody
 * needs to delete; failing the list for it would hide all the others.
 */
export async function listDrafts(context: SlackContext, alias: string): Promise<DraftView[]> {
  const { account } = requireWorkspace(await context.config(), alias, context.handoffs);
  const drafts = await openDraftStore(context.core.paths.stateDir, context.now, context.handoffs).list(account.id);
  const views = drafts.map((draft): DraftView => {
    try {
      return viewDraft(draft, context.handoffs);
    } catch (error) {
      if (!(error instanceof CommsError) || error.details?.reason !== 'not-composed') throw error;
      return {
        ...heading(draft),
        problem: { code: 'BAD_DATA', reason: 'not-composed', message: error.message, hint: error.hint ?? '' },
        ...kept(draft),
      };
    }
  });
  if (views.length === 0) return views;
  /*
   * Each draft's current revision, as the approval records read say it stands (design 2026-10-05 §D9): its own exact
   * revision only, under each digest it was prepared with, and — since a list annotates one exact revision — said
   * when a used, sending, unknown or standing approval decides it as well as when its last preparation expired.
   */
  const report = await unsentReport(context.core, {
    channel: 'slack',
    owner: account.id,
    drafts: views.map((view) => ({ draftId: view.draftId, revision: view.revision })),
    decided: true,
  });
  return views.map((view) => {
    // The report holds only each draft's current revision: what is left to sort is which draft a row is for.
    const rows = report.rows.filter((row) => row.key.draftId === view.draftId);
    return rows.length === 0 ? view : { ...view, unsent: rows.map(historyOf) };
  });
}

/** A row of the report as a list's annotation: no sender-written field, only what the records say. */
function historyOf(row: UnsentRow): DraftSendHistory {
  return {
    status: row.status,
    said: row.said,
    evidence: row.evidence,
    contentDigest: row.key.contentDigest ?? '',
    last: row.last,
    ...(row.decidedBy === undefined ? {} : { decidedBy: row.decidedBy }),
  };
}
