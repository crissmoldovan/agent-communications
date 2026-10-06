import {
  type ApprovalObject,
  type ApprovalRecord,
  type ChannelPreview,
  CommsError,
  canonicalJson,
  type Expectation,
  escapeForDisplay,
  handoffSentence,
  type PreviewNotifies,
  renderFencedBody,
  type SendPolicy,
  sha256Hex,
  stricterPolicy,
  truncateDisplay,
  withApproval,
  withSendingLease,
} from '@agentcomms/core';
import { callSlack, certainlyRefused, type SlackResponse } from '../api/call.ts';
import { spendOn } from '../api/guard.ts';
import type { ComposedPayload } from '../compose/blocks.ts';
import type { SlackDraft } from '../compose/drafts.ts';
import { urlsInWords } from '../compose/preview.ts';
import { messageAt, requireOwnMessage, shownText, type TargetMessage, targetDigest } from './message.ts';
import type { Channel, NameBook } from './people.ts';
import {
  ACCEPTED_WITHOUT_ID,
  type AuditSink,
  approvalNow,
  claimOrHandOver,
  fenceFirstStep,
  LINK_MAY_UNFURL,
  messageOf,
  NO_ID,
  noteOf,
  type PostDeps,
  type PrepareDeps,
  providerId,
  refusalWithBookkeeping,
  risksOf,
  roomOf,
  settledWith,
  viewPost,
  waitingHint,
} from './send.ts';

/**
 * Editing and deleting a message this account posted (design 2026-10-06).
 *
 * The post's gate, for two more acts: an approval bound to exactly this act on exactly this message as it is now,
 * claimed once, under a lease, after a fence, through a permit open for one request. What is new is only what the acts
 * need — the message is read and shown, and refused unless it is this account's (§E2, §E3) — and the records each
 * outcome leaves, which follow the post's rules (§E8). Nothing here posts, and nothing reaches `chat.update` or
 * `chat.delete` except through `spendOn` below.
 */

/** The flag every edit's approval carries: what the approval screen and the audit tell an edit by (§E9). */
export const EDITS_MESSAGE = 'edits-message';
/** The flag every deletion's approval carries. */
export const DELETES_MESSAGE = 'deletes-message';
/** A deletion of a thread's parent: its replies stay, and the person was told how many there were. */
export const HAS_REPLIES = 'has-replies';
/** A deletion of a message with files: the files stay, and the person was told which. */
export const HAS_FILES = 'has-files';

type Act = 'edit' | 'delete';

/** How each act is spoken of: what it is called, what it leaves done, and what audits it. */
const WORDS: Readonly<Record<Act, { gerund: string; done: string; noun: string; operation: string }>> = {
  edit: { gerund: 'editing', done: 'changed', noun: 'edit', operation: 'slack.edit' },
  delete: { gerund: 'deleting', done: 'deleted', noun: 'deletion', operation: 'slack.delete' },
};

/** Before the claim, a cancellation spends nothing. */
function notUsed(act: Act): string {
  return `The approval was not used: it can still make this ${WORDS[act].noun} until it expires.`;
}

/** After the claim, a cancellation spends the approval: a claim is single use, and cannot be put back. */
function spentByCancel(act: Act): string {
  return `The approval was used up by the attempt. If it should still be made, prepare the ${WORDS[act].noun} again and approve the new preview.`;
}

/** A call cancelled before Slack had it: nothing was changed. The words every cancellation here is reported in. */
function cancelled(act: Act, hint: string): CommsError {
  return new CommsError('USAGE', `cancelled: nothing was ${WORDS[act].done}`, {
    hint,
    details: { reason: 'cancelled' },
  });
}

/** What an accepted act says when its call was cancelled after the request had gone out: that it was made. */
function tooLate(act: Act): string {
  return act === 'edit'
    ? 'the call was cancelled too late to stop it: Slack accepted the edit, and it cannot be taken back'
    : 'the call was cancelled too late to stop it: Slack accepted the deletion, and it cannot be undone';
}

/** The policy line of a preview, in the act's words. */
function describeActPolicy(policy: SendPolicy, act: Act): string {
  const what = `the message is ${WORDS[act].done}`;
  switch (policy) {
    case 'never':
      return `nothing can be ${WORDS[act].done} from this workspace`;
    case 'confirm':
      return `this needs a person to approve it at a terminal before ${what}`;
    default:
      return `say yes and ${what}`;
  }
}

/** `never` refuses both acts, as it refuses a post: the policy is about what this workspace does in Slack. */
function refuseNever(policy: SendPolicy, act: Act): void {
  if (policy !== 'never') return;
  throw new CommsError(
    'POLICY_NEVER',
    'posting, editing and deleting are turned off for this workspace (policy: never)',
    {
      hint:
        act === 'edit'
          ? 'Change the words in Slack yourself, or change the policy at a terminal.'
          : 'Delete it in Slack yourself, or change the policy at a terminal.',
    },
  );
}

/**
 * Refuses an edit or a deletion from a workspace that cannot make one: connected to read, or not granted `chat:write`.
 *
 * The shape of `requireFileSending`, for the same reason: at prepare, so nobody is shown a preview of an act that could
 * never be made, and again at send before the claim, because a grant can narrow in between. Slack would refuse it
 * anyway — a `read` token holds no posting scope — but in words that do not say what to do.
 */
export function requireChatWrite(
  deps: Pick<PrepareDeps, 'mode' | 'grantedScopes' | 'workspaceName' | 'handoffs'>,
  act: Act,
): void {
  const alias = deps.workspaceName;
  const { handoffs } = deps;
  const verb = act === 'edit' ? 'edit' : 'delete';
  if (deps.mode !== 'send') {
    throw new CommsError('SCOPE_MISSING', `"${alias}" is connected to read, and cannot ${verb} a message`, {
      hint: `Nothing was ${WORDS[act].done}. Moving it to send takes a person: ${handoffSentence(
        handoffs.own(['workspace', 'mode', alias]),
        (command) => `${command} shows the steps, as slack_mode does from a chat.`,
        { instead: 'slack_mode shows the steps, from a chat.' },
      )}`,
      details: { mode: deps.mode ?? null },
    });
  }
  if (!(deps.grantedScopes ?? []).includes('chat:write')) {
    const reauth = handoffs.own(['workspace', 'reauth', alias, '--mode', 'send']);
    throw new CommsError(
      'SCOPE_MISSING',
      `"${alias}" was not granted chat:write, which ${WORDS[act].gerund} a message needs`,
      {
        hint: `Nothing was ${WORDS[act].done}. ${handoffSentence(
          reauth,
          (command) => `Sign in again to grant it: ${command}.`,
          {
            instead: 'Sign in again to grant it, with slack_workspace_reauth from a chat.',
          },
        )}`,
        details: { scope: 'chat:write', command: reauth },
      },
    );
  }
}

/** How a conversation is named to a person: `#name`, the other person for a DM, or the id when it could not be read. */
function channelShown(channel: Channel | undefined, id: string, book: NameBook): string {
  if (channel?.isIm) return book.person(channel.withUserId ?? '')?.displayName?.text ?? 'a direct message';
  return `#${channel?.name?.text ?? id}`;
}

/** Where a reply sits, as the preview says it. A message in the channel itself says nothing. */
function threadShown(message: TargetMessage): string | undefined {
  return message.threadTs === undefined ? undefined : `a reply in the thread at ${message.threadTs}`;
}

/** Names, joined for a sentence: `a.pdf`, `a.pdf and b.png`, `a.pdf, b.png and c.txt`. */
function namesOf(files: TargetMessage['files']): string {
  const names = files.map((file) => truncateDisplay(file.name, 80));
  return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
}

/** What an act is audited by: the message, and an edit's draft. An empty value is none, and is left out — never `''`. */
function idsOf(message: { channel: string; ts: string }, draftId?: string): Record<string, string> {
  const ids: Record<string, string> = {};
  for (const [key, value] of [
    ['channel', message.channel],
    ['ts', message.ts],
    ['draftId', draftId ?? ''],
  ] as const) {
    if (value !== '') ids[key] = value;
  }
  return ids;
}

/** One audit record of this act, from a dependency set that may not have a sink. */
function auditOf(
  deps: Pick<PrepareDeps, 'accountId' | 'workspaceName' | 'surface'> & { audit?: AuditSink | undefined },
  record: { operation: string; outcome: 'ok' | 'refused' | 'failed' | 'started'; ids: Record<string, string> } & {
    approvalId: string;
    reason?: string | undefined;
  },
): Promise<unknown> | undefined {
  return deps.audit?.append({
    inboxId: deps.accountId,
    alias: deps.workspaceName,
    operation: record.operation,
    outcome: record.outcome,
    ids: record.ids,
    approvalId: record.approvalId,
    ...(record.reason === undefined ? {} : { reason: record.reason }),
    ...(deps.surface ? { surface: deps.surface } : {}),
  });
}

// ── Edits ─────────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Exactly what `chat.update` is sent (§E5): the words alone, under the parse rule a post goes out under.
 *
 * No `blocks`: with them Slack does not mark the message "(edited)", and the composer's `section` is refused against the
 * `rich_text` a message typed in Slack carries. No `link_names`, whose default is none. And `parse: none` said, because
 * an update's default is `client` — a different rule from the one the post, and its preview, were written for.
 */
export interface EditRequest {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly parse: 'none';
}

/** An edit as it would be made now: what a person is shown, and the digest that binds exactly that. */
export interface EditView {
  readonly preview: ChannelPreview;
  readonly digest: string;
  readonly request: EditRequest;
  /** Why the room could not be read, when it could not — so its reach is a gap, not a number. */
  readonly roomUnread: string | undefined;
  readonly payload: ComposedPayload;
  readonly message: TargetMessage;
}

/** The message an edit replaces and the reach it was prepared with, as its expectation states them. */
function editExpectation(where: { channel: string; ts: string }, notifies: { estimated: number }): Expectation {
  return { to: [where.channel], cc: [], bcc: [], subject: `edits ${where.ts}, reaches ${notifies.estimated}` };
}

/**
 * Refuses a draft that cannot be an edit (§E4): one written as a reply in a thread — an edit leaves a message where it
 * is — or one with files, which replacing is not offered yet (§5).
 */
function requireEditable(draft: SlackDraft): void {
  if (draft.payload.thread_ts !== undefined) {
    throw new CommsError(
      'USAGE',
      `draft "${draft.draftId}" is written as a reply in a thread, and an edit cannot move a message`,
      {
        hint: 'An edit leaves the message where it is. Compose the new words without a thread, then prepare the edit.',
        details: { draftId: draft.draftId, reason: 'edit-in-thread' },
      },
    );
  }
  if ((draft.files ?? []).length > 0) {
    throw new CommsError('USAGE', `draft "${draft.draftId}" has files, and an edit changes only a message’s words`, {
      hint: 'Replacing a message’s files is not offered yet. Compose the new words without files, then prepare the edit.',
      details: { draftId: draft.draftId, reason: 'edit-with-files' },
    });
  }
}

/** What a person should notice about an edit before saying yes: flags, never refusals. */
function editWarnings(message: TargetMessage, notifies: PreviewNotifies, urls: readonly string[]): string[] {
  const warnings = [
    'Everyone who can read the channel sees the new words in place of the old: nobody who read the old words is told what changed.',
  ];
  if (notifies.channel || notifies.here || notifies.users.length > 0) {
    warnings.push(
      'Whether Slack notifies anyone mentioned only in an edit is not documented: the reach above counts them as if it does.',
    );
  }
  if (urls.length > 0) {
    warnings.push(
      'Slack may fetch a link in the new words and show its preview to everyone in the channel: an edit offers no way to turn that off.',
    );
  }
  if (message.files.length > 0) {
    warnings.push(
      `This changes only the words: ${namesOf(message.files)} ${message.files.length === 1 ? 'is' : 'are'} not part of the edit.`,
    );
  }
  return warnings;
}

/**
 * Reads the message and the room, and builds the edit's preview and digest from that one reading.
 *
 * One function for the three places that need them — preparing, the approval screen and editing — as `viewPost` is
 * for a post, so what is shown and what is bound cannot drift apart between them. The message first: one that is not
 * this account's is refused before the room is read or anything is shown.
 */
export async function viewEdit(
  deps: Pick<PrepareDeps, 'call' | 'workspaceId' | 'workspaceName' | 'postingAs' | 'handoffs'>,
  draft: SlackDraft,
  ts: string,
  book: NameBook,
): Promise<EditView> {
  requireEditable(draft);
  const message = await messageAt(deps.call, { channel: draft.payload.channel, ts });
  requireOwnMessage(message, deps.postingAs, 'edit');
  // The post the new words would be, checked, read and counted exactly as a post of them is (§E6).
  const view = await viewPost(deps, draft, book);
  const request: EditRequest = { channel: view.payload.channel, ts, text: view.payload.text, parse: 'none' };
  // Every address in the new words, bare or not: an edit cannot turn unfurling off, so any of them may unfurl.
  const urls = urlsInWords(request.text);
  const thread = threadShown(message);
  const preview: ChannelPreview = {
    ...view.preview,
    ...(thread === undefined ? {} : { thread }),
    replaces: { ts, body: shownText(message, book) },
    links: urls,
    context: { ...view.preview.context, note: 'nothing has been changed' },
    warnings: [...(view.preview.warnings ?? []), ...editWarnings(message, view.preview.notifies, urls)],
  };
  const digest = sha256Hex(
    canonicalJson({
      kind: 'edit',
      // The post's digest binds the workspace, the account, the room, the words and their reach.
      post: view.digest,
      // The bytes that go to `chat.update`, so a change to any of them is a different edit.
      request,
      message: targetDigest(message, 'edit'),
    }),
  );
  return { preview, digest, request, roomUnread: view.roomUnread, payload: view.payload, message };
}

export interface PreparedEdit {
  readonly approvalId: string;
  readonly draftId: string;
  /** The message it edits. */
  readonly channel: string;
  readonly ts: string;
  /** The words it has now and the words it will have, the reach, and what to notice. */
  readonly preview: ChannelPreview;
  readonly expect: Expectation;
  readonly policy: SendPolicy;
  readonly requiredPolicy: SendPolicy;
  readonly riskFlags: readonly string[];
  readonly expiresAt: string;
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat makes it. */
  readonly approval: ApprovalObject;
}

/**
 * Prepares one edit, and shows what it will be. Nothing is changed here: the permit stays closed, and Slack is only
 * read — the message, and the room.
 */
export async function prepareMessageEdit(
  deps: PrepareDeps,
  draft: SlackDraft,
  ts: string,
  book: NameBook,
): Promise<PreparedEdit> {
  refuseNever(deps.policy, 'edit');
  requireChatWrite(deps, 'edit');
  const { preview, digest, payload, message } = await viewEdit(deps, draft, ts, book);
  const where = { channel: message.channel, ts };
  const riskFlags = [
    EDITS_MESSAGE,
    ...risksOf(payload, preview.notifies, 0).filter((flag) => flag !== 'contains-link'),
    ...((preview.links ?? []).length > 0 ? ['contains-link', LINK_MAY_UNFURL] : []),
  ];
  // What raises a post raises its edit (§E6): a broadcast, a large room, or a reach nobody could count.
  const broadcast = preview.notifies.channel || preview.notifies.here;
  const requiredPolicy: SendPolicy =
    broadcast || preview.notifies.estimated >= 50 || preview.notifies.unknown !== undefined ? 'confirm' : 'chat';

  const record = await deps.approvals.create({
    channel: 'slack',
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: draft.draftId,
    draftMessageId: draft.revision,
    contentDigest: digest,
    sendEpoch: deps.sendEpoch,
    policy: deps.policy,
    requiredPolicy,
    riskFlags,
    expect: editExpectation(where, preview.notifies),
  });
  await auditOf(deps, {
    operation: 'slack.edit.prepare',
    outcome: 'started',
    ids: idsOf(where, draft.draftId),
    approvalId: record.approvalId,
  });
  return {
    approvalId: record.approvalId,
    draftId: draft.draftId,
    channel: where.channel,
    ts,
    preview: {
      ...preview,
      context: { ...preview.context, approvalId: record.approvalId },
      policy: describeActPolicy(stricterPolicy(deps.policy, requiredPolicy), 'edit'),
    },
    expect: record.expect,
    policy: deps.policy,
    requiredPolicy,
    riskFlags,
    expiresAt: record.expiresAt,
    approval: await deps.approvals.approvalOf(record),
  };
}

/**
 * The message an approval says it edits — or `undefined` when it is not an edit's.
 *
 * Read from the record's flag and expectation, and only believed once the edit it names reproduces the record's digest:
 * the approval screen and the edit itself both read the message again and compare.
 */
export function editOfApproval(record: ApprovalRecord): { channel: string; ts: string } | undefined {
  if (!record.riskFlags.includes(EDITS_MESSAGE)) return undefined;
  const what = /^edits (\S+), reaches \d+$/.exec(record.expect.subject);
  const [channel] = record.expect.to;
  if (!what?.[1] || record.expect.to.length !== 1 || channel === undefined) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the edit it is bound to', {
      hint: 'Nothing was approved. Prepare the edit again, for a new approval.',
      details: { approvalId: record.approvalId },
    });
  }
  return { channel, ts: what[1] };
}

export interface EditedMessage {
  readonly approvalId: string;
  /** The message that was edited: the one the approval names. */
  readonly channel: string;
  readonly ts: string;
  /** What else is true of this edit, when anything is — as a post's note says it. */
  readonly note?: string | undefined;
  /** Where the approval stands now: `used`, or still `sending` when that could not be recorded. */
  readonly approval: ApprovalObject;
}

/** Refuses an approval that is not for this act on this message, before anything is claimed or spent. */
function notThisAct(act: Act, approvalId: string, reason: string, hint: string): CommsError {
  return new CommsError('APPROVAL_VOID', `nothing was ${WORDS[act].done}: ${reason}`, {
    hint,
    details: { approvalId, reason: 'not-this-act' },
  });
}

/**
 * Edits one message, once, as a prepared edit's approval allows.
 *
 * `postPrepared`'s shape, step for step: the approval classified under its lock; everything that could refuse it
 * refused before the claim — the channel and ts restated against the approval, the workspace's grant, the message and
 * the room read again and the digest recomputed; a cancellation honoured up to the request that edits and never after
 * it; a fence before that request; and only what is known recorded of its outcome.
 */
export async function editPrepared(
  deps: PostDeps,
  draft: SlackDraft,
  approvalId: string,
  target: { expectChannel: string; ts: string },
  book: NameBook,
): Promise<EditedMessage> {
  const { outcome } = await deps.approvals.inspect(
    approvalId,
    { kind: 'send', owner: deps.accountId },
    { action: 'claim' },
  );
  if (outcome.error) throw outcome.error;
  try {
    return await editClassified(deps, draft, approvalId, outcome.record, target, book);
  } catch (error) {
    throw withApproval(error, outcome.approval);
  }
}

async function editClassified(
  deps: PostDeps,
  draft: SlackDraft,
  approvalId: string,
  record: ApprovalRecord | null,
  target: { expectChannel: string; ts: string },
  book: NameBook,
): Promise<EditedMessage> {
  if (target.expectChannel !== draft.payload.channel) {
    throw notThisAct(
      'edit',
      approvalId,
      `this draft is for ${draft.payload.channel}, not ${target.expectChannel}`,
      'Check the channel in the preview, then pass that one.',
    );
  }
  const bound = record === null ? undefined : editOfApproval(record);
  if (bound === undefined) {
    throw notThisAct(
      'edit',
      approvalId,
      'this approval is not for an edit',
      'Prepare the edit with slack_edit_prepare or `edit prepare`, and use the approval it returns.',
    );
  }
  if (bound.ts !== target.ts || bound.channel !== draft.payload.channel) {
    throw notThisAct(
      'edit',
      approvalId,
      `this approval edits the message at ${bound.ts} in ${bound.channel}, not ${target.ts} in ${draft.payload.channel}`,
      'Pass the channel and ts the preview showed.',
    );
  }
  // The grant can narrow between prepare and edit. Before the claim, so a refusal spends nothing.
  requireChatWrite(deps, 'edit');
  // The request sent below is this one: the one previewed, and the one the digest is taken over.
  const view = await viewEdit(deps, draft, target.ts, book);
  const where = { channel: view.request.channel, ts: target.ts };
  const ids = idsOf(where, draft.draftId);

  // Cancelled while Slack was read: the claim is next, and is not made. The store asks again as it claims.
  if (deps.signal?.aborted) throw cancelled('edit', notUsed('edit'));
  const claim = await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: draft.revision,
      contentDigest: view.digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      expect: editExpectation(where, view.preview.notifies),
    },
    waitingHint('edit', deps.surface, approvalId, deps.handoffs),
    () => cancelled('edit', notUsed('edit')),
  );
  return withSendingLease(deps.approvals, approvalId, claim.claimToken, async () => {
    if (deps.signal?.aborted) {
      throw await recordNotChanged(deps, approvalId, claim, 'edit', ids, cancelled('edit', spentByCancel('edit')));
    }
    // The fence (design 2026-10-05 §D1): the edit starts only while this claim still holds the send.
    await fenceFirstStep(deps, approvalId, claim, WORDS.edit.operation, ids);
    let response: SlackResponse;
    try {
      // Without the signal, deliberately: this is the request that edits, and it is never abandoned once it is out.
      response = await spendOn(deps.permit, approvalId, 'chat.update', () =>
        callSlack({ ...deps.call, permit: deps.permit }, 'chat.update', { ...view.request }),
      );
    } catch (error) {
      if (certainlyRefused(error, 'chat.update')) {
        throw await recordNotChanged(deps, approvalId, claim, 'edit', ids, error);
      }
      throw await recordMaybeChanged(deps, approvalId, claim.claimed, 'edit', ids, error);
    }
    const { note, approval } = await recordChanged(deps, approvalId, claim, 'edit', ids, providerId(response.ts));
    return { approvalId, ...where, ...(note === undefined ? {} : { note }), approval };
  });
}

// ── Deletions ─────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * What a person is shown before a message is deleted (§E7): the message as it is now — its words, where it is, its
 * files and how many replies it has — and what deleting it leaves behind.
 *
 * No reach: a deletion notifies nobody. Its words are this account's own (§E3), decoded as the channel reads them;
 * `renderDeletionPreview` escapes every part for the terminal.
 */
export interface DeletionPreview {
  readonly workspace: string;
  readonly postingAs: string;
  /** `#name`, the other person for a DM, or the id when the conversation could not be read. */
  readonly channel: string;
  readonly ts: string;
  readonly thread?: string | undefined;
  readonly body: string;
  /** Replies it has, when it is a thread's parent. They are not deleted with it. */
  readonly replies: number;
  /** Its files, by the name Slack shows. They are not deleted with it. */
  readonly files: readonly string[];
  readonly warnings: readonly string[];
  readonly context: { readonly workspace: string; readonly approvalId?: string | undefined; readonly note: string };
  readonly policy?: string | undefined;
}

/** A deletion as it would be made now: what a person is shown, and the digest that binds exactly that. */
export interface DeletionView {
  readonly preview: DeletionPreview;
  readonly digest: string;
  readonly message: TargetMessage;
}

/** Where a deletion's approval says what it is for, in place of the draft an edit has: the message itself. */
function deletionDraftId(where: { channel: string; ts: string }): string {
  return `delete:${where.channel}:${where.ts}`;
}

function deletionExpectation(where: { channel: string; ts: string }): Expectation {
  return { to: [where.channel], cc: [], bcc: [], subject: `deletes ${where.ts}` };
}

/** What a person should notice before a message is deleted. */
function deletionWarnings(message: TargetMessage): string[] {
  const warnings = ['A deletion cannot be undone: the words are gone from Slack for everyone, this account included.'];
  if (message.replyCount > 0) {
    warnings.push(
      `It has ${message.replyCount} ${message.replyCount === 1 ? 'reply' : 'replies'}. Only this message is deleted: the thread’s replies are not.`,
    );
  }
  if (message.files.length > 0) {
    warnings.push(
      `Only the message is deleted, not ${namesOf(message.files)}: if ${message.files.length === 1 ? 'it' : 'they'} should go too, delete ${message.files.length === 1 ? 'it' : 'them'} in Slack.`,
    );
  }
  return warnings;
}

/**
 * Reads the message and its conversation, and builds the deletion's preview and digest from that one reading — for
 * preparing, the approval screen and deleting alike, as `viewEdit` is for an edit.
 *
 * The conversation is read only for its name: a deletion reaches nobody, so there is no reach to count and no
 * membership to require. One that cannot be read is named by its id.
 */
export async function viewDeletion(
  deps: Pick<PrepareDeps, 'call' | 'workspaceId' | 'workspaceName' | 'postingAs'>,
  where: { channel: string; ts: string },
  book: NameBook,
): Promise<DeletionView> {
  const message = await messageAt(deps.call, where);
  requireOwnMessage(message, deps.postingAs, 'delete');
  const { channel } = await roomOf(deps.call, where.channel);
  if (channel) book.addChannel(channel);
  const thread = threadShown(message);
  const preview: DeletionPreview = {
    workspace: deps.workspaceName,
    postingAs: deps.postingAs,
    channel: channelShown(channel, where.channel, book),
    ts: where.ts,
    ...(thread === undefined ? {} : { thread }),
    body: shownText(message, book),
    replies: message.replyCount,
    files: message.files.map((file) => file.name),
    warnings: deletionWarnings(message),
    context: { workspace: deps.workspaceName, note: 'nothing has been deleted' },
  };
  const digest = sha256Hex(
    canonicalJson({
      kind: 'delete',
      workspace: deps.workspaceId,
      postingAs: deps.postingAs,
      channel: where.channel,
      ts: where.ts,
      message: targetDigest(message, 'delete'),
    }),
  );
  return { preview, digest, message };
}

/**
 * A deletion's preview as a person reads it: at the terminal, where `approve` shows it, and from `delete prepare`.
 *
 * Laid out as a post's is, so nobody approving one has to learn a second layout: the heading, then where — whose
 * message, which conversation, which message — then what stays behind, then the words, fenced, then what to notice.
 * Every part is escaped and cut to its line: the words and the file names are this account's, but this is printed at
 * the terminal of the person about to type a code, the one place a control sequence would do most harm.
 */
export function renderDeletionPreview(preview: DeletionPreview): string {
  const line = (label: string, value: string) => `${label.padEnd(10)}${value}`;
  const lines = [
    [
      'DELETE PREVIEW',
      `workspace ${preview.context.workspace}`,
      ...(preview.context.approvalId ? [`approval ${preview.context.approvalId}`] : []),
      preview.context.note,
    ]
      .map((part) => truncateDisplay(part, 120))
      .join(' · '),
    line('From:', truncateDisplay(preview.postingAs, 120)),
    line('Channel:', truncateDisplay(preview.channel, 120)),
  ];
  if (preview.thread) lines.push(line('Thread:', truncateDisplay(preview.thread, 120)));
  lines.push(line('Deletes:', `the message at ${truncateDisplay(preview.ts, 40)}`));
  if (preview.replies > 0) {
    lines.push(line('Replies:', `${preview.replies}, not deleted with it`));
  }
  for (const file of preview.files) lines.push(line('File:', `${truncateDisplay(file, 80)}, not deleted with it`));
  const words = preview.body.trim() ? preview.body.trim().split(/\s+/).length : 0;
  lines.push('', `Body (${words} word${words === 1 ? '' : 's'}, ${preview.body.length} characters):`);
  lines.push(renderFencedBody(preview.body));
  for (const warning of preview.warnings) lines.push(`! ${escapeForDisplay(warning)}`);
  // Again, after the words: a long message scrolls the lines above out of view, and this is what is being approved.
  lines.push(
    '',
    `── deletes the message at ${truncateDisplay(preview.ts, 40)} in ${truncateDisplay(preview.channel, 60)}`,
  );
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}

export interface PreparedDeletion {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
  readonly preview: DeletionPreview;
  readonly expect: Expectation;
  readonly policy: SendPolicy;
  readonly requiredPolicy: SendPolicy;
  readonly riskFlags: readonly string[];
  readonly expiresAt: string;
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat makes it. */
  readonly approval: ApprovalObject;
}

/**
 * Prepares one deletion, and shows what would be deleted. Nothing is deleted here: Slack is only read.
 *
 * At the workspace's policy, raised by nothing (§E7): a deletion notifies nobody, and the account's own words are
 * what it removes.
 */
export async function prepareDeletion(
  deps: PrepareDeps,
  where: { channel: string; ts: string },
  book: NameBook,
): Promise<PreparedDeletion> {
  refuseNever(deps.policy, 'delete');
  requireChatWrite(deps, 'delete');
  const { preview, digest, message } = await viewDeletion(deps, where, book);
  const riskFlags = [
    DELETES_MESSAGE,
    ...(message.replyCount > 0 ? [HAS_REPLIES] : []),
    ...(message.files.length > 0 ? [HAS_FILES] : []),
  ];
  const record = await deps.approvals.create({
    channel: 'slack',
    inboxId: deps.accountId,
    inboxSub: deps.postingAs,
    draftId: deletionDraftId(where),
    // No draft, so the deletion's own digest stands in, as a reaction's does: the same value means the same act.
    draftMessageId: digest,
    contentDigest: digest,
    sendEpoch: deps.sendEpoch,
    policy: deps.policy,
    requiredPolicy: 'chat',
    riskFlags,
    expect: deletionExpectation(where),
  });
  await auditOf(deps, {
    operation: 'slack.delete.prepare',
    outcome: 'started',
    ids: idsOf(where),
    approvalId: record.approvalId,
  });
  return {
    approvalId: record.approvalId,
    channel: where.channel,
    ts: where.ts,
    preview: {
      ...preview,
      context: { ...preview.context, approvalId: record.approvalId },
      policy: describeActPolicy(deps.policy, 'delete'),
    },
    expect: record.expect,
    policy: deps.policy,
    requiredPolicy: 'chat',
    riskFlags,
    expiresAt: record.expiresAt,
    approval: await deps.approvals.approvalOf(record),
  };
}

/**
 * The message an approval says it deletes — or `undefined` when it is not a deletion's.
 *
 * Read from the record's draft id, expectation and flag, which must all say the same; believed only once the message,
 * read again, reproduces the record's digest — which the approval screen and the deletion both check.
 */
export function deletionOfApproval(record: ApprovalRecord): { channel: string; ts: string } | undefined {
  if (!record.draftId.startsWith('delete:')) return undefined;
  const where = /^delete:([CGD][A-Z0-9]+):(\d+\.\d+)$/.exec(record.draftId);
  const channel = where?.[1];
  const ts = where?.[2];
  if (
    channel === undefined ||
    ts === undefined ||
    !record.riskFlags.includes(DELETES_MESSAGE) ||
    record.expect.subject !== `deletes ${ts}` ||
    record.expect.to.length !== 1 ||
    record.expect.to[0] !== channel
  ) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the deletion it is bound to', {
      hint: 'Nothing was approved. Prepare the deletion again, for a new approval.',
      details: { approvalId: record.approvalId },
    });
  }
  return { channel, ts };
}

export interface DeletedMessage {
  readonly approvalId: string;
  readonly channel: string;
  readonly ts: string;
  readonly note?: string | undefined;
  /** Where the approval stands now: `used`, or still `sending` when that could not be recorded. */
  readonly approval: ApprovalObject;
}

/**
 * Deletes one message, once, as a prepared deletion's approval allows — `editPrepared`'s shape, for `chat.delete`.
 *
 * One answer is not a refusal although Slack sends it as an error: `message_not_found` means the message is not there,
 * which is the state the approval asked for, and the message was read moments before under this same claim (§E8). It
 * is recorded as used, with a note saying Slack found nothing left to delete.
 */
export async function deletePrepared(
  deps: PostDeps,
  approvalId: string,
  where: { channel: string; ts: string },
  book: NameBook,
): Promise<DeletedMessage> {
  const { outcome } = await deps.approvals.inspect(
    approvalId,
    { kind: 'send', owner: deps.accountId },
    { action: 'claim' },
  );
  if (outcome.error) throw outcome.error;
  try {
    return await deleteClassified(deps, approvalId, outcome.record, where, book);
  } catch (error) {
    throw withApproval(error, outcome.approval);
  }
}

/** What a deletion's result says when Slack found nothing left to delete. */
export const ALREADY_GONE =
  'Slack found no message at that ts by the time it was asked, so there was nothing left to delete';

async function deleteClassified(
  deps: PostDeps,
  approvalId: string,
  record: ApprovalRecord | null,
  where: { channel: string; ts: string },
  book: NameBook,
): Promise<DeletedMessage> {
  const bound = record === null ? undefined : deletionOfApproval(record);
  if (bound === undefined) {
    throw notThisAct(
      'delete',
      approvalId,
      'this approval is not for a deletion',
      'Prepare the deletion with slack_delete_prepare or `delete prepare`, and use the approval it returns.',
    );
  }
  if (bound.channel !== where.channel || bound.ts !== where.ts) {
    throw notThisAct(
      'delete',
      approvalId,
      `this approval deletes the message at ${bound.ts} in ${bound.channel}, not ${where.ts} in ${where.channel}`,
      'Pass the channel and ts the preview showed.',
    );
  }
  requireChatWrite(deps, 'delete');
  const view = await viewDeletion(deps, where, book);
  const ids = idsOf(where);

  if (deps.signal?.aborted) throw cancelled('delete', notUsed('delete'));
  const claim = await claimOrHandOver(
    deps,
    approvalId,
    {
      draftMessageId: view.digest,
      contentDigest: view.digest,
      inboxId: deps.accountId,
      inboxSub: deps.postingAs,
      expect: deletionExpectation(where),
    },
    waitingHint('delete', deps.surface, approvalId, deps.handoffs),
    () => cancelled('delete', notUsed('delete')),
  );
  return withSendingLease(deps.approvals, approvalId, claim.claimToken, async () => {
    if (deps.signal?.aborted) {
      throw await recordNotChanged(
        deps,
        approvalId,
        claim,
        'delete',
        ids,
        cancelled('delete', spentByCancel('delete')),
      );
    }
    await fenceFirstStep(deps, approvalId, claim, WORDS.delete.operation, ids);
    let response: SlackResponse;
    try {
      response = await spendOn(deps.permit, approvalId, 'chat.delete', () =>
        callSlack({ ...deps.call, permit: deps.permit }, 'chat.delete', { channel: where.channel, ts: where.ts }),
      );
    } catch (error) {
      if (error instanceof CommsError && error.details?.slackError === 'message_not_found') {
        // The state asked for holds: recorded by the message the approval names, which Slack just said is gone.
        const { note, approval } = await recordChanged(deps, approvalId, claim, 'delete', ids, where.ts, ALREADY_GONE);
        return { approvalId, ...where, ...(note === undefined ? {} : { note }), approval };
      }
      if (certainlyRefused(error, 'chat.delete')) {
        throw await recordNotChanged(deps, approvalId, claim, 'delete', ids, error);
      }
      throw await recordMaybeChanged(deps, approvalId, claim.claimed, 'delete', ids, error);
    }
    const { note, approval } = await recordChanged(deps, approvalId, claim, 'delete', ids, providerId(response.ts));
    return { approvalId, ...where, ...(note === undefined ? {} : { note }), approval };
  });
}

// ── What each outcome leaves behind ───────────────────────────────────────────────────────────────────────────

/**
 * Records an act that certainly did nothing — Slack's refusal from the method's allowlist, or a cancellation after the
 * claim and before the request — and returns what to throw: the refusal as Slack or the cancellation said it, with
 * anything that failed while recording it added, never put in its place.
 */
async function recordNotChanged(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  act: Act,
  ids: Record<string, string>,
  error: unknown,
): Promise<unknown> {
  const unrecorded: string[] = [];
  const reason = messageOf(error);
  let settled = claim.claimed;
  try {
    settled = await deps.approvals.approvalOf(
      await deps.approvals.complete(approvalId, claim.claimToken, { error: reason }),
    );
  } catch (failure) {
    unrecorded.push(`the approval could not be marked failed (${messageOf(failure)})`);
  }
  try {
    await auditOf(deps, {
      operation: WORDS[act].operation,
      outcome: 'failed',
      ids,
      approvalId,
      reason: [reason, ...unrecorded].join('; '),
    });
  } catch (failure) {
    unrecorded.push(`the audit log could not record the refusal (${messageOf(failure)})`);
  }
  const said = error instanceof CommsError ? refusalWithBookkeeping(error, unrecorded) : error;
  return settledWith(said, settled);
}

/**
 * Records a request whose answer does not say whether Slack acted, and returns what to throw: `SEND_OUTCOME_UNKNOWN`,
 * never retryable, with the approval left `sending` to read `unknown` — as a post's (`recordMaybePosted`). An edit or a
 * deletion recorded as failed when it was made is the record that invites it again.
 */
async function recordMaybeChanged(
  deps: PostDeps,
  approvalId: string,
  claimed: ApprovalObject,
  act: Act,
  ids: Record<string, string>,
  error: unknown,
): Promise<CommsError> {
  const said = messageOf(error);
  let unaudited = '';
  try {
    await auditOf(deps, {
      operation: WORDS[act].operation,
      outcome: 'failed',
      ids,
      approvalId,
      reason: `outcome unknown: ${said}`,
    });
  } catch (failure) {
    unaudited = ` The audit log could not record this either (${messageOf(failure)}).`;
  }
  const look =
    act === 'edit'
      ? 'Look at the message before anything else: Slack may have changed it. Prepare the edit again only if it still reads the old way — this approval is not used again.'
      : 'Look for the message before anything else: Slack may have deleted it. Prepare the deletion again only if it is still there — this approval is not used again.';
  return new CommsError('SEND_OUTCOME_UNKNOWN', `whether the message was ${WORDS[act].done} is not known: ${said}`, {
    cause: error,
    hint: `${look}${unaudited}`,
    details: {
      ...(error instanceof CommsError ? error.details : {}),
      approvalId,
      outcome: 'unknown',
      // Still `sending`: nothing is recorded of an act whose outcome is not known.
      approval: await approvalNow(deps, approvalId, claimed),
    },
  });
}

/**
 * Records an act Slack accepted — or whose asked-for state Slack says already holds — and returns what its result
 * should say. Nothing here records the approval as failed and nothing here throws: the message is changed, and a record
 * saying otherwise is wrong in the one direction that gets the act made twice. An approval is `used` only by an id; with
 * none it stays `sending`, and the note says so ({@link NO_ID}).
 */
async function recordChanged(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  act: Act,
  ids: Record<string, string>,
  sentMessageId: string | undefined,
  known?: string | undefined,
): Promise<{ note: string | undefined; approval: ApprovalObject }> {
  const unrecorded: string[] = [];
  let approval: ApprovalObject | null = null;
  if (sentMessageId !== undefined) {
    try {
      approval = await deps.approvals.approvalOf(
        await deps.approvals.complete(approvalId, claim.claimToken, { sentMessageId }),
      );
    } catch (error) {
      unrecorded.push(`the approval could not be marked used (${messageOf(error)}), so it will read as unknown`);
    }
  }
  // Decided after the approval is written, as a post's is (`recordPosted`): a cancellation during that wait counts.
  const late = deps.signal?.aborted ? tooLate(act) : undefined;
  const unidentified = sentMessageId === undefined;
  const reason = noteOf([unidentified ? ACCEPTED_WITHOUT_ID : undefined, known, late, ...unrecorded]);
  try {
    await auditOf(deps, { operation: WORDS[act].operation, outcome: 'ok', ids, approvalId, reason });
  } catch (error) {
    unrecorded.push(`the audit log could not record it (${messageOf(error)})`);
  }
  return {
    note: noteOf([unidentified ? NO_ID : undefined, known, late, ...unrecorded]),
    approval: approval ?? (await approvalNow(deps, approvalId, claim.claimed)),
  };
}
