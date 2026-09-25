import { CommsError } from '@agentcomms/core';
import { openDraftStore } from '../compose/drafts.ts';
import type { SlackContext } from '../context.ts';
import { type DraftInput, draftPayload, ownDraft } from './drafts.ts';
import { gateDepsFor } from './gate.ts';
import { NameBook } from './people.ts';
import {
  type PostedMessage,
  type PreparedPost,
  postPrepared,
  preparePost,
  prepareReaction,
  type ReactionOptions,
  reactPrepared,
} from './send.ts';
import type { SessionDeps } from './session.ts';

/**
 * Posting a prepared draft and reacting, as both surfaces do them.
 *
 * `agent-slack post send` and `slack_post_send`, `agent-slack react` and `slack_react` with `slack_react_send`: one
 * function each, so a refusal one surface makes the other makes too. Until the owner's rule of 2026-09-25 only the
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
 * does it. Given both, which one was meant is a guess, so it is refused rather than made.
 */
export interface PrepareRequest {
  readonly draftId?: string | undefined;
  readonly channel?: string | undefined;
  readonly text?: string | undefined;
  readonly threadTs?: string | undefined;
  readonly mentionUsers?: readonly string[] | undefined;
  readonly broadcast?: unknown;
}

function draftToWrite(request: PrepareRequest): DraftInput | undefined {
  const composing = [request.channel, request.text, request.threadTs, request.mentionUsers, request.broadcast].some(
    (given) => given !== undefined,
  );
  if (request.draftId !== undefined) {
    if (composing) {
      throw new CommsError('USAGE', 'prepare a draft already written, or a new message — not both', {
        hint: 'Pass `draftId` alone, or `channel` and `text` (with `threadTs`, `mentionUsers` or `broadcast`) without it.',
      });
    }
    return undefined;
  }
  if (request.channel === undefined || request.text === undefined) {
    throw new CommsError('USAGE', 'nothing to prepare: name a draft, or give the channel and the text of a new one', {
      hint: 'Pass `draftId` for a draft already written, or `channel` and `text` to write one.',
    });
  }
  return {
    channel: request.channel,
    text: request.text,
    threadTs: request.threadTs,
    mentionUsers: request.mentionUsers,
    broadcast: request.broadcast,
  };
}

/**
 * Prepares a post and returns the preview a person must approve: `agent-slack post prepare` and `slack_post_prepare`.
 *
 * One function, so the same draft gives the same preview from either surface and a draft written at a terminal — or
 * one whose approval ran out — can be prepared from a chat. The request is checked and a new message composed before
 * Slack is asked anything, so a bad mention is refused without opening the workspace; the draft is written only once
 * the workspace has opened, so a sign-in that has lapsed leaves no draft behind it.
 */
export async function prepareDraftPost(
  context: SlackContext,
  alias: string,
  request: PrepareRequest,
  slack: SessionDeps = {},
): Promise<PreparedPost> {
  const writing = draftToWrite(request);
  const composed = writing === undefined ? undefined : { payload: draftPayload(writing), source: writing.text };
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now);
  const draft =
    composed === undefined
      ? // Another workspace's draft is absent here: drafts share one directory, and the id alone proves nothing.
        await ownDraft(store, gate.accountId, request.draftId as string)
      : await store.create(gate.accountId, composed.payload, composed.source);
  return preparePost(gate, draft, new NameBook());
}

export interface SendPostInput {
  readonly draftId: string;
  readonly approvalId: string;
  /** The channel the caller believes this goes to, restated from the preview and checked against the draft. */
  readonly expectChannel: string;
}

/** Posts one prepared draft of this workspace, once, if its approval allows it now. */
export async function sendPost(
  context: SlackContext,
  alias: string,
  input: SendPostInput,
  slack: SessionDeps = {},
): Promise<PostedMessage> {
  const gate = await gateDepsFor(context, alias, slack);
  const store = openDraftStore(context.core.paths.stateDir, context.now);
  // Another workspace's draft is absent here: drafts share one directory, and the id alone proves nothing.
  const draft = await ownDraft(store, gate.accountId, input.draftId);
  return postPrepared(gate, draft, input.approvalId, input.expectChannel, new NameBook());
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
): Promise<{ approvalId: string }> {
  const gate = await gateDepsFor(context, alias, slack);
  const claiming = approvalId ?? (await prepareReaction(gate, wanted)).approvalId;
  return reactPrepared(gate, claiming, wanted);
}
