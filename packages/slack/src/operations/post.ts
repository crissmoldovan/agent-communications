import { CommsError, ensureSendEpochConfig, type LegacyDrainReport } from '@agentcomms/core';
import { openDraftStore } from '../compose/drafts.ts';
import { checkFileCount, recordFiles } from '../compose/files.ts';
import type { SlackContext } from '../context.ts';
import {
  type DeletedMessage,
  deletePrepared,
  type EditedMessage,
  editPrepared,
  type PreparedDeletion,
  type PreparedEdit,
  prepareDeletion,
  prepareMessageEdit,
} from './amend.ts';
import { requireConversation } from './destination.ts';
import { attachPolicyOf, type DraftInput, draftPayload, ownDraft } from './drafts.ts';
import { gateDepsFor } from './gate.ts';
import { requireMessageAt, requireMessageTs } from './message.ts';
import { NameBook } from './people.ts';
import {
  type PostedFiles,
  type PostedMessage,
  type PreparedPost,
  postPrepared,
  preparePost,
  prepareReaction,
  type ReactionOptions,
  type ReactionResult,
  reactPrepared,
} from './send.ts';
import type { SessionDeps } from './session.ts';

/**
 * Posting a prepared draft, reacting, and editing or deleting a message this account posted, as both surfaces do them.
 *
 * `agent-slack post send` and `slack_post_send`, `agent-slack react` and `slack_react` with `slack_react_send`,
 * `edit prepare`/`edit send` and `delete prepare`/`delete send` with their tools (design 2026-10-06): one function
 * each, so a refusal one surface makes the other makes too. Until the owner's rule of 2026-09-25 only the
 * CLI could post, and its commands held these steps inline; a second copy for the tools would have been a second
 * place for a check to go missing — which is what happened to the audit sink the one time the MCP server assembled
 * the gate for itself (see `gateDepsFor`).
 *
 * Nothing here decides whether a person has approved. That is the approval store's, under the workspace's policy as
 * it is when the claim is made: under `chat` the person's yes in the conversation is the approval and the claim goes
 * through; under `confirm` the claim waits for `agent-slack approve` at a terminal, which no tool runs; under `never`
 * it refuses. So posting from a chat is exactly as gated as posting from a shell.
 */

/**
 * What to prepare: a draft already written, or a message to write as one first.
 *
 * Exactly one. `draftId` is `agent-slack post prepare --draft`: a draft `draft create` wrote, or one whose approval
 * expired and is being shown again. The message is `draft create` and `post prepare` in one call, which is how a tool
 * does it — with its text, its files, or both. Given both a draft and a message, which one was meant is a guess, so it
 * is refused rather than made.
 */
export interface PrepareRequest {
  readonly draftId?: string | undefined;
  readonly channel?: string | undefined;
  readonly text?: string | undefined;
  readonly threadTs?: string | undefined;
  readonly mentionUsers?: readonly string[] | undefined;
  readonly broadcast?: unknown;
  /** Local files to post, by path, for a new message: see `DraftInput.files`. */
  readonly files?: readonly string[] | undefined;
}

function draftToWrite(request: PrepareRequest): DraftInput | undefined {
  const composing = [
    request.channel,
    request.text,
    request.threadTs,
    request.mentionUsers,
    request.broadcast,
    request.files,
  ].some((given) => given !== undefined);
  if (request.draftId !== undefined) {
    if (composing) {
      throw new CommsError('USAGE', 'prepare a draft already written, or a new message — not both', {
        hint: 'Pass `draftId` alone, or `channel` with `text`, `files` or both (and `threadTs`, `mentionUsers` or `broadcast`) without it.',
      });
    }
    return undefined;
  }
  if (request.channel === undefined || (request.text === undefined && (request.files ?? []).length === 0)) {
    throw new CommsError(
      'USAGE',
      'nothing to prepare: name a draft, or give the channel and the text or files of a new one',
      { hint: 'Pass `draftId` for a draft already written, or `channel` with `text`, `files` or both to write one.' },
    );
  }
  return {
    channel: request.channel,
    text: request.text,
    threadTs: request.threadTs,
    mentionUsers: request.mentionUsers,
    broadcast: request.broadcast,
    files: request.files,
  };
}

/** What became of the approvals an earlier release prepared, when the call retired them (`ensureSendEpochConfig`). */
export interface LegacyDrainNote {
  readonly legacyDrain?: LegacyDrainReport | undefined;
}

/** `result`, and the drain's report beside it when there is one. */
function noting<T extends object>(result: T, legacyDrain: LegacyDrainReport | undefined): T & LegacyDrainNote {
  return legacyDrain === undefined ? result : { ...result, legacyDrain };
}

/**
 * Prepares a post and returns the preview a person must approve: `agent-slack post prepare` and `slack_post_prepare`.
 *
 * One function, so the same draft gives the same preview from either surface and a draft written at a terminal — or
 * one whose approval ran out — can be prepared from a chat. The request is checked and a new message composed before
 * Slack is asked anything, so a bad mention is refused without opening the workspace — and so is a file that may not
 * be sent, since each one is checked and recorded here, on this machine; the draft is written only once the workspace
 * has opened, so a sign-in that has lapsed leaves no draft behind it.
 */
export async function prepareDraftPost(
  context: SlackContext,
  alias: string,
  request: PrepareRequest,
  slack: SessionDeps = {},
): Promise<PreparedPost & LegacyDrainNote> {
  const writing = draftToWrite(request);
  if (writing !== undefined) requireConversation(writing.channel, alias, context.handoffs);
  const composed = writing === undefined ? undefined : { payload: draftPayload(writing), source: writing.text ?? '' };
  const paths = writing?.files ?? [];
  checkFileCount(paths.length);
  const files = paths.length === 0 ? [] : await recordFiles(paths, await attachPolicyOf(context));
  // Before the epoch is read for the approval: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const draft =
    composed === undefined
      ? // Another workspace's draft is absent here: drafts share one directory, and the id alone proves nothing.
        await ownDraft(store, gate.accountId, request.draftId as string)
      : await store.create(gate.accountId, composed.payload, composed.source, files);
  return noting(await preparePost(gate, draft, new NameBook()), legacyDrain);
}

export interface SendPostInput {
  readonly draftId: string;
  readonly approvalId: string;
  /** The channel the caller believes this goes to, restated from the preview and checked against the draft. */
  readonly expectChannel: string;
  /**
   * The call's cancellation: `slack_post_send` passes the MCP request's signal, and `post send` none — Ctrl-C ends
   * the process. See `PostDeps.signal` for how far it reaches.
   */
  readonly signal?: AbortSignal | undefined;
}

/**
 * Posts one prepared draft of this workspace, once, if its approval allows it now.
 *
 * A post of text alone comes back as the message it made. A post with files comes back with their ids in Slack, and
 * the message's ts when Slack had attached them to one — `null`, and a note saying so, when it had not.
 */
export async function sendPost(
  context: SlackContext,
  alias: string,
  input: SendPostInput,
  slack: SessionDeps = {},
): Promise<(PostedMessage | PostedFiles) & LegacyDrainNote> {
  // First, as every claim does: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  // Another workspace's draft is absent here: drafts share one directory, and the id alone proves nothing.
  const draft = await ownDraft(store, gate.accountId, input.draftId);
  return noting(
    await postPrepared({ ...gate, signal: input.signal }, draft, input.approvalId, input.expectChannel, new NameBook()),
    legacyDrain,
  );
}

/**
 * Adds or removes one reaction.
 *
 * One step under `chat`, two under `confirm` — the shape a post has. Without an approval id this makes an approval
 * and tries it at once: under `chat` that is the yes the conversation already gave, and under `confirm` the claim
 * waits, naming the approval a person has to give. With one, it claims that approval and makes none — so a retry
 * after a person approved does not mint a new approval that nobody has seen.
 */
export async function react(
  context: SlackContext,
  alias: string,
  wanted: ReactionOptions,
  approvalId: string | undefined,
  slack: SessionDeps = {},
): Promise<ReactionResult & LegacyDrainNote> {
  // First — it prepares, or claims, or both: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  const claiming = approvalId ?? (await prepareReaction(gate, wanted)).approvalId;
  return noting(await reactPrepared(gate, claiming, wanted), legacyDrain);
}

/**
 * What to prepare an edit from: the message it changes, its new words and files — a draft already written, or words
 * and files to write as one first — and the message's files to take off (design 2026-10-06 §E4, §5).
 *
 * Exactly one source, as for a post. `draftId` is `agent-slack edit prepare --draft`: a draft `draft create` wrote, or
 * one whose edit's approval expired. Otherwise `channel` — the message's — with `text`, `files` or both is
 * `draft create` and `edit prepare` in one call, which is how a tool does it. No thread: an edit leaves a message where
 * it is. `removeFiles` names files the message has now, by id, and goes with either source: which of its files go is
 * part of the edit, not of its words.
 *
 * Words left out keep the message's own, exactly as Slack holds them — so an edit that only swaps a file never retypes
 * the words, which would turn a mention into plain text.
 */
export interface EditPrepareRequest {
  /** The message to edit. */
  readonly ts: string;
  readonly draftId?: string | undefined;
  readonly channel?: string | undefined;
  /** The new words. Left out, the message keeps its own. */
  readonly text?: string | undefined;
  readonly mentionUsers?: readonly string[] | undefined;
  readonly broadcast?: unknown;
  /** Local files to add, by path: see `DraftInput.files`. They follow the files the message keeps. */
  readonly files?: readonly string[] | undefined;
  /** The ids of the message's own files to take off it. */
  readonly removeFiles?: readonly string[] | undefined;
}

/* A Slack file id: F, then capitals and digits. Checked before Slack is asked, and before it goes into the record. */
const FILE_ID = /^F[A-Z0-9]{1,39}$/;

/** The ids of the files to take off, checked and each once, in the order given. */
function filesToRemove(request: EditPrepareRequest): string[] {
  const ids = [...new Set(request.removeFiles ?? [])];
  for (const id of ids) {
    if (FILE_ID.test(id)) continue;
    throw new CommsError('USAGE', `"${id.slice(0, 40)}" is not a Slack file id`, {
      hint: 'A file id is F and then capitals and digits, such as F0C739JK4LE: read the message to see its files.',
      details: { file: id, reason: 'not-a-file-id' },
    });
  }
  return ids;
}

function editWordsToWrite(request: EditPrepareRequest): DraftInput | undefined {
  const composing = [request.channel, request.text, request.mentionUsers, request.broadcast, request.files].some(
    (given) => given !== undefined,
  );
  if (request.draftId !== undefined) {
    if (composing) {
      throw new CommsError('USAGE', 'prepare an edit from a draft already written, or from new words — not both', {
        hint: 'Pass `draftId` alone (with `removeFiles` if any go), or `channel` with `text`, `files` or both without it.',
      });
    }
    return undefined;
  }
  if (request.channel === undefined) {
    throw new CommsError('USAGE', 'nothing to prepare: name a draft, or give the channel of the message', {
      hint: 'Pass `draftId` for a draft already written, or `channel` with `text`, `files` or `removeFiles`.',
    });
  }
  const words = request.text ?? '';
  if (words === '' && (request.mentionUsers !== undefined || request.broadcast !== undefined)) {
    throw new CommsError('USAGE', 'a mention is part of the words: give the new words with it', {
      hint: 'Leave the words out, and the mentions with them, to keep the message’s own.',
    });
  }
  if (words === '' && (request.files ?? []).length === 0 && (request.removeFiles ?? []).length === 0) {
    throw new CommsError('USAGE', 'nothing to change: give the new words, files to add or file ids to take off', {
      hint: 'Pass `text`, `files`, `removeFiles`, or any of them together.',
      details: { reason: 'nothing-to-change' },
    });
  }
  return {
    channel: request.channel,
    text: request.text,
    mentionUsers: request.mentionUsers,
    broadcast: request.broadcast,
    files: request.files,
  };
}

/**
 * Prepares an edit and returns the preview a person must approve: `agent-slack edit prepare` and `slack_edit_prepare`.
 *
 * As `prepareDraftPost` does for a post: the request is checked, new words composed and every file to add checked and
 * recorded before Slack is asked anything, and a draft is written only once the workspace has opened. Nothing is
 * changed in Slack: the message and its room are read, and refused unless the message is this account's.
 */
export async function prepareEdit(
  context: SlackContext,
  alias: string,
  request: EditPrepareRequest,
  slack: SessionDeps = {},
): Promise<PreparedEdit & LegacyDrainNote> {
  const writing = editWordsToWrite(request);
  const removeFiles = filesToRemove(request);
  if (writing !== undefined) requireMessageAt({ channel: writing.channel, ts: request.ts }, alias, context.handoffs);
  else requireMessageTs(request.ts);
  const composed = writing === undefined ? undefined : { payload: draftPayload(writing), source: writing.text ?? '' };
  const paths = writing?.files ?? [];
  checkFileCount(paths.length);
  const files = paths.length === 0 ? [] : await recordFiles(paths, await attachPolicyOf(context));
  // Before the epoch is read for the approval: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const draft =
    composed === undefined
      ? // Another workspace's draft is absent here: drafts share one directory, and the id alone proves nothing.
        await ownDraft(store, gate.accountId, request.draftId as string)
      : await store.create(gate.accountId, composed.payload, composed.source, files);
  requireMessageAt({ channel: draft.payload.channel, ts: request.ts }, alias, context.handoffs);
  return noting(await prepareMessageEdit(gate, draft, request.ts, removeFiles, new NameBook()), legacyDrain);
}

export interface SendEditInput {
  readonly draftId: string;
  readonly approvalId: string;
  /** The channel the caller believes the message is in, restated from the preview and checked against the draft. */
  readonly expectChannel: string;
  /** The message the caller believes this edits, restated from the preview and checked against the approval. */
  readonly ts: string;
  /** The call's cancellation, as for a post: see `PostDeps.signal`. */
  readonly signal?: AbortSignal | undefined;
}

/** Edits one message of this workspace, once, if its approval allows it now: `edit send` and `slack_edit_send`. */
export async function sendEdit(
  context: SlackContext,
  alias: string,
  input: SendEditInput,
  slack: SessionDeps = {},
): Promise<EditedMessage & LegacyDrainNote> {
  requireMessageTs(input.ts);
  // First, as every claim does: version 3, and an earlier release's records retired.
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now, context.handoffs);
  const draft = await ownDraft(store, gate.accountId, input.draftId);
  const edited = await editPrepared(
    { ...gate, signal: input.signal },
    draft,
    input.approvalId,
    { expectChannel: input.expectChannel, ts: input.ts },
    new NameBook(),
  );
  return noting(edited, legacyDrain);
}

/**
 * Prepares a deletion and returns the preview a person must approve: `agent-slack delete prepare` and
 * `slack_delete_prepare`. Nothing is deleted: the message is read, and refused unless it is this account's.
 */
export async function prepareDelete(
  context: SlackContext,
  alias: string,
  where: { readonly channel: string; readonly ts: string },
  slack: SessionDeps = {},
): Promise<PreparedDeletion & LegacyDrainNote> {
  requireMessageAt(where, alias, context.handoffs);
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  return noting(await prepareDeletion(gate, { channel: where.channel, ts: where.ts }, new NameBook()), legacyDrain);
}

export interface SendDeleteInput {
  /** The message, restated from the preview and checked against the approval. */
  readonly channel: string;
  readonly ts: string;
  readonly approvalId: string;
  readonly signal?: AbortSignal | undefined;
}

/** Deletes one message of this workspace, once, if its approval allows it now: `delete send` and `slack_delete_send`. */
export async function sendDelete(
  context: SlackContext,
  alias: string,
  input: SendDeleteInput,
  slack: SessionDeps = {},
): Promise<DeletedMessage & LegacyDrainNote> {
  const where = { channel: input.channel, ts: input.ts };
  requireMessageAt(where, alias, context.handoffs);
  const { legacyDrain } = await ensureSendEpochConfig(context.core, { now: context.now });
  const gate = await gateDepsFor(context, alias, slack);
  return noting(
    await deletePrepared({ ...gate, signal: input.signal }, input.approvalId, where, new NameBook()),
    legacyDrain,
  );
}
