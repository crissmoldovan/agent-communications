import {
  type ApprovalObject,
  type ApprovalRecord,
  type AttachPolicy,
  type ChannelPreview,
  CommsError,
  canonicalJson,
  type Expectation,
  escapeForDisplay,
  fenceOrStop,
  type Handoff,
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
import { callSlack, certainlyRefused, type SlackCall, type SlackResponse } from '../api/call.ts';
import { spendOn } from '../api/guard.ts';
import { slackFileUpload } from '../api/upload.ts';
import { type ComposedPayload, payloadOf } from '../compose/blocks.ts';
import type { SlackDraft } from '../compose/drafts.ts';
import { checkRecordedFile, rereadFile, type SlackDraftFile } from '../compose/files.ts';
import { FILE_POST_UNFURLS, urlsInWords } from '../compose/preview.ts';
import { messageAt, requireOwnMessage, shownText, type TargetMessage, targetDigest } from './message.ts';
import type { Channel, NameBook } from './people.ts';
import {
  ACCEPTED_WITHOUT_ID,
  type AuditSink,
  approvalNow,
  attachPolicyFor,
  CONTAINS_FILES,
  claimOrHandOver,
  discarded,
  fenceFirstStep,
  filesAsRecorded,
  LINK_MAY_UNFURL,
  messageOf,
  NO_ID,
  noteOf,
  type PostDeps,
  type PostedFile,
  type PrepareDeps,
  perhapsDiscarded,
  providerId,
  refileCommand,
  refusalWithBookkeeping,
  requireFileSending,
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
  record: {
    operation: string;
    outcome: 'ok' | 'refused' | 'failed' | 'started';
    ids: Record<string, string | string[]>;
  } & {
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

/** The flag on an edit that takes files off the message: they stay in Slack, shared nowhere. */
export const REMOVES_FILES = 'removes-files';

/**
 * Exactly what `chat.update` is sent (§E5): the words, under the parse rule a post goes out under — and `file_ids`
 * when the edit changes the files, added at the edit itself, once the new files are up (§5).
 *
 * No `blocks`: with them Slack does not mark the message "(edited)", and the composer's `section` is refused against the
 * `rich_text` a message typed in Slack carries. No `link_names`, whose default is none. And `parse: none` said, because
 * an update's default is `client` — a different rule from the one the post, and its preview, were written for. `text`
 * is always sent: observed 2026-10-06, `file_ids` without it leaves the message with no words at all.
 */
export interface EditRequest {
  readonly channel: string;
  readonly ts: string;
  readonly text: string;
  readonly parse: 'none';
}

/**
 * What an edit does to the files on the message, or `null` when it leaves them alone.
 *
 * Observed 2026-10-06 (design §5): `chat.update`'s `file_ids` replaces the message's files with exactly the ids sent,
 * in that order; one left out is taken off the message and stays in Slack, shared nowhere; and an edit that sends no
 * `file_ids` keeps them. So an edit that changes the files sends every id the message should end with — the files it
 * keeps, in the order the message has them, then the ones it adds, in the order the draft names them.
 */
export interface EditFiles {
  readonly keep: readonly { readonly id: string; readonly name: string }[];
  readonly remove: readonly { readonly id: string; readonly name: string }[];
  readonly add: readonly SlackDraftFile[];
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
  readonly files: EditFiles | null;
  /** The draft has no words: the message keeps its own, sent back exactly as Slack holds them. */
  readonly keepsWords: boolean;
}

/**
 * The message an edit replaces, the reach it was prepared with and the files it takes off, as its expectation states
 * them. The files are here because nothing else in the record could hold them: an edit's draft is its new words and
 * new files, and which of the message's files go is part of the act, not of the words.
 */
function editExpectation(
  where: { channel: string; ts: string },
  notifies: { estimated: number },
  removeFiles: readonly string[],
): Expectation {
  const removes = removeFiles.length > 0 ? `, removes ${removeFiles.join(' ')}` : '';
  return {
    to: [where.channel],
    cc: [],
    bcc: [],
    subject: `edits ${where.ts}, reaches ${notifies.estimated}${removes}`,
  };
}

/** Refuses a draft written as a reply in a thread (§E4): an edit leaves a message where it is. */
function requireEditable(draft: SlackDraft): void {
  if (draft.payload.thread_ts === undefined) return;
  throw new CommsError(
    'USAGE',
    `draft "${draft.draftId}" is written as a reply in a thread, and an edit cannot move a message`,
    {
      hint: 'An edit leaves the message where it is. Compose the new words without a thread, then prepare the edit.',
      details: { draftId: draft.draftId, reason: 'edit-in-thread' },
    },
  );
}

/**
 * What the edit does to the message's files — refusing an id to take off that is not one of them, before anything is
 * shown. `null` when the edit adds none and takes none off, and so leaves them alone.
 */
function filesOfEdit(message: TargetMessage, draft: SlackDraft, removeFiles: readonly string[]): EditFiles | null {
  for (const id of removeFiles) {
    if (message.files.some((file) => file.id === id)) continue;
    throw new CommsError('USAGE', `"${truncateDisplay(id, 40)}" is not a file of the message at ${message.ts}`, {
      hint: 'Read the message again, and pass the ids of its own files to take off.',
      details: { file: id, ts: message.ts, reason: 'not-a-file-of-the-message' },
    });
  }
  const add = draft.files ?? [];
  if (add.length === 0 && removeFiles.length === 0) return null;
  return {
    keep: message.files.filter((file) => !removeFiles.includes(file.id)),
    remove: message.files.filter((file) => removeFiles.includes(file.id)),
    add,
  };
}

/** What a person should notice about an edit before saying yes: flags, never refusals. */
function editWarnings(
  message: TargetMessage,
  notifies: PreviewNotifies,
  urls: readonly string[],
  files: EditFiles | null,
  keepsWords: boolean,
): string[] {
  const warnings: string[] = [];
  if (!keepsWords) {
    warnings.push(
      'Everyone who can read the channel sees the new words in place of the old: nobody who read the old words is told what changed.',
    );
  }
  if (notifies.channel || notifies.here || notifies.users.length > 0) {
    warnings.push(
      'Whether Slack notifies anyone mentioned only in an edit is not documented: the reach above counts them as if it does.',
    );
  }
  if (urls.length > 0) {
    warnings.push(
      keepsWords
        ? 'Slack may fetch a link in the message’s words and show its preview to everyone in the channel when it is edited: an edit offers no way to turn that off.'
        : 'Slack may fetch a link in the new words and show its preview to everyone in the channel: an edit offers no way to turn that off.',
    );
  }
  if (files === null && message.files.length > 0) {
    warnings.push(
      `This changes only the words: ${namesOf(message.files)} ${message.files.length === 1 ? 'is' : 'are'} not part of the edit.`,
    );
  }
  if (files !== null && files.remove.length > 0) {
    const one = files.remove.length === 1;
    warnings.push(
      `${namesOf(files.remove)} ${one ? 'is' : 'are'} taken off the message, not deleted: Slack keeps ${one ? 'it' : 'them'}, shared nowhere. Delete ${one ? 'it' : 'them'} in Slack if ${one ? 'it' : 'they'} should go.`,
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
 *
 * A draft with no words keeps the message's: they are sent back exactly as Slack holds them — escaped, mentions as
 * spans — so a mention in them stays one, which words typed again from a read could not promise. They are previewed and
 * counted from that text, as a post of it would be.
 */
export async function viewEdit(
  deps: Pick<PrepareDeps, 'call' | 'workspaceId' | 'workspaceName' | 'postingAs' | 'handoffs'>,
  draft: SlackDraft,
  ts: string,
  removeFiles: readonly string[],
  book: NameBook,
): Promise<EditView> {
  requireEditable(draft);
  const message = await messageAt(deps.call, { channel: draft.payload.channel, ts });
  requireOwnMessage(message, deps.postingAs, 'edit');
  const files = filesOfEdit(message, draft, removeFiles);
  const keepsWords = draft.payload.text === '';
  if (keepsWords && files === null) {
    throw new CommsError('USAGE', 'nothing to change: the edit has no new words, and adds or takes off no files', {
      hint: 'Give the new words, files to add, file ids to take off, or any of them together.',
      details: { draftId: draft.draftId, reason: 'nothing-to-change' },
    });
  }
  // The post the edit's words and new files would be, checked, read and counted as a post of them is (§E6).
  const words = keepsWords ? { ...draft, payload: payloadOf(message.text, draft.payload.channel, undefined) } : draft;
  const view = await viewPost(deps, words, book);
  const request: EditRequest = { channel: view.payload.channel, ts, text: view.payload.text, parse: 'none' };
  // Every address in the words, bare or not: an edit cannot turn unfurling off, so any of them may unfurl.
  const urls = urlsInWords(request.text);
  const thread = threadShown(message);
  const preview: ChannelPreview = {
    ...view.preview,
    ...(thread === undefined ? {} : { thread }),
    replaces: {
      ts,
      body: shownText(message, book),
      ...(keepsWords ? { wordsUnchanged: true } : {}),
      ...(files === null
        ? {}
        : { files: { keeps: files.keep.map((file) => file.name), removes: files.remove.map((file) => file.name) } }),
    },
    links: urls,
    context: { ...view.preview.context, note: 'nothing has been changed' },
    warnings: [
      // The post's warning about links in a file post is not this edit's: its words go out through `chat.update`.
      ...(view.preview.warnings ?? []).filter((warning) => warning !== FILE_POST_UNFURLS),
      ...editWarnings(message, view.preview.notifies, urls, files, keepsWords),
    ],
  };
  const digest = sha256Hex(
    canonicalJson({
      kind: 'edit',
      // The post's digest binds the workspace, the account, the room, the words, their reach and every new file's bytes.
      post: view.digest,
      // The words and the parse rule that go to `chat.update`, so a change to any of them is a different edit.
      request,
      // Which of the message's files stay and which go, by id.
      files:
        files === null
          ? null
          : { keep: files.keep.map((file) => file.id), remove: files.remove.map((file) => file.id) },
      message: targetDigest(message, 'edit'),
    }),
  );
  return { preview, digest, request, roomUnread: view.roomUnread, payload: view.payload, message, files, keepsWords };
}

export interface PreparedEdit {
  readonly approvalId: string;
  readonly draftId: string;
  /** The message it edits. */
  readonly channel: string;
  readonly ts: string;
  /** The words it has now and the words it will have, its files, the reach, and what to notice. */
  readonly preview: ChannelPreview;
  readonly expect: Expectation;
  readonly policy: SendPolicy;
  readonly requiredPolicy: SendPolicy;
  readonly riskFlags: readonly string[];
  readonly expiresAt: string;
  /** Where its approval stands (design 2026-10-05 §D8): pending, and whether a yes in the chat makes it. */
  readonly approval: ApprovalObject;
}

/** Whether an edit touches files at all, so needs the workspace able to send them (`requireFileSending`). */
function changesFiles(draft: SlackDraft, removeFiles: readonly string[]): boolean {
  return (draft.files ?? []).length > 0 || removeFiles.length > 0;
}

/**
 * Prepares one edit, and shows what it will be. Nothing is changed here: the permit stays closed, and Slack is only
 * read — the message, and the room. An edit that adds files reads each one again first, as a post with files does, so
 * nobody is shown a file that is no longer the one the draft recorded.
 */
export async function prepareMessageEdit(
  deps: PrepareDeps,
  draft: SlackDraft,
  ts: string,
  removeFiles: readonly string[],
  book: NameBook,
): Promise<PreparedEdit> {
  refuseNever(deps.policy, 'edit');
  requireChatWrite(deps, 'edit');
  if (changesFiles(draft, removeFiles)) requireFileSending(deps);
  await filesAsRecorded(deps, draft);
  const { preview, digest, payload, message, files } = await viewEdit(deps, draft, ts, removeFiles, book);
  const where = { channel: message.channel, ts };
  const riskFlags = [
    EDITS_MESSAGE,
    ...(files !== null && files.add.length > 0 ? [CONTAINS_FILES] : []),
    ...(files !== null && files.remove.length > 0 ? [REMOVES_FILES] : []),
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
    expect: editExpectation(where, preview.notifies, files?.remove.map((file) => file.id) ?? []),
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
 * The message an approval says it edits, and the files it takes off — or `undefined` when it is not an edit's.
 *
 * Read from the record's flag and expectation, and only believed once the edit it names reproduces the record's digest:
 * the approval screen and the edit itself both read the message again and compare.
 */
export function editOfApproval(
  record: ApprovalRecord,
): { channel: string; ts: string; removeFiles: readonly string[] } | undefined {
  if (!record.riskFlags.includes(EDITS_MESSAGE)) return undefined;
  const what = /^edits (\S+), reaches \d+(?:, removes (F[A-Z0-9]+(?: F[A-Z0-9]+)*))?$/.exec(record.expect.subject);
  const [channel] = record.expect.to;
  if (!what?.[1] || record.expect.to.length !== 1 || channel === undefined) {
    throw new CommsError('BAD_DATA', 'this approval does not describe the edit it is bound to', {
      hint: 'Nothing was approved. Prepare the edit again, for a new approval.',
      details: { approvalId: record.approvalId },
    });
  }
  return { channel, ts: what[1], removeFiles: what[2] === undefined ? [] : what[2].split(' ') };
}

export interface EditedMessage {
  readonly approvalId: string;
  /** The message that was edited: the one the approval names. */
  readonly channel: string;
  readonly ts: string;
  /**
   * The message's files after an edit that changed them, as Slack's answer lists them, by id and name — the ones it
   * kept and the ones it added. Absent when the edit left the files alone.
   */
  readonly files?: readonly { readonly id: string; readonly name: string }[] | undefined;
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
 * refused before the claim — the channel and ts restated against the approval, the workspace's grant, every new file
 * read again, the message and the room read again and the digest recomputed; a cancellation honoured up to the request
 * that edits and never after it; a fence before every step; and only what is known recorded of its outcome.
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
  const adding = draft.files ?? [];
  if (changesFiles(draft, bound.removeFiles)) requireFileSending(deps);
  const policy = adding.length > 0 ? attachPolicyFor(deps) : undefined;
  // The request sent below is this one: the one previewed, and the one the digest is taken over.
  const view = await viewEdit(deps, draft, target.ts, bound.removeFiles, book);
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
      expect: editExpectation(where, view.preview.notifies, bound.removeFiles),
    },
    waitingHint('edit', deps.surface, approvalId, deps.handoffs),
    () => cancelled('edit', notUsed('edit')),
  );
  return withSendingLease(deps.approvals, approvalId, claim.claimToken, async () => {
    if (deps.signal?.aborted) {
      throw await recordNotChanged(deps, approvalId, claim, 'edit', ids, cancelled('edit', spentByCancel('edit')));
    }
    let added: PostedFile[] = [];
    if (policy !== undefined && view.files !== null) {
      // The new files go up first, shared nowhere; each step after its own fence, the first one included.
      added = await uploadForEdit(deps, approvalId, claim, draft, view.files.add, policy, ids);
      const verdict = await fenceOrStop(deps.approvals, approvalId, claim.claimToken, {
        stepsStarted: added.length * 2 + 1,
      });
      if (!verdict.proceed) {
        throw await recordNotChanged(
          deps,
          approvalId,
          claim,
          'edit',
          withFiles(ids, added),
          editLeaseRanOut(namedOnly(added), true),
        );
      }
    } else {
      // The fence (design 2026-10-05 §D1): the edit starts only while this claim still holds the send.
      await fenceFirstStep(deps, approvalId, claim, WORDS.edit.operation, ids);
    }
    const fileIds =
      view.files === null ? undefined : [...view.files.keep.map((file) => file.id), ...added.map((file) => file.id)];
    const auditIds = withFiles(ids, added);
    let response: SlackResponse;
    try {
      // Without the signal, deliberately: this is the request that edits, and it is never abandoned once it is out.
      response = await spendOn(deps.permit, approvalId, 'chat.update', () =>
        callSlack({ ...deps.call, permit: deps.permit }, 'chat.update', {
          ...view.request,
          ...(fileIds === undefined ? {} : { file_ids: JSON.stringify(fileIds) }),
        }),
      );
    } catch (error) {
      if (certainlyRefused(error, 'chat.update')) {
        throw await recordNotChanged(deps, approvalId, claim, 'edit', auditIds, withLeftovers(error, added, false));
      }
      throw await recordMaybeChanged(deps, approvalId, claim.claimed, 'edit', auditIds, error, leftovers(added, true));
    }
    const after = fileIds === undefined ? undefined : filesAfter(response, added, view.files);
    const mismatch =
      after !== undefined && fileIds !== undefined && after.map((file) => file.id).join(' ') !== fileIds.join(' ')
        ? `Slack lists the message's files as ${after.map((file) => file.name).join(', ') || 'none'}, not the ones this edit sent`
        : undefined;
    const { note, approval } = await recordChanged(
      deps,
      approvalId,
      claim,
      'edit',
      auditIds,
      providerId(response.ts),
      mismatch,
    );
    return {
      approvalId,
      ...where,
      ...(after === undefined ? {} : { files: after }),
      ...(note === undefined ? {} : { note }),
      approval,
    };
  });
}

/** An edit's audit ids, with the files it put up: by id and name, never by what is in them. */
function withFiles(ids: Record<string, string>, added: readonly PostedFile[]): Record<string, string | string[]> {
  if (added.length === 0) return ids;
  return { ...ids, files: added.map((file) => file.id), fileNames: added.map((file) => file.name) };
}

/** Files as every failure names them: by id and name, never by size or hash. */
function namedOnly(files: readonly { id: string; name: string }[]): { id: string; name: string }[] {
  return files.map(({ id, name }) => ({ id, name }));
}

/** The message's files after the edit, as Slack's answer lists them — or, when it lists none, what was sent. */
function filesAfter(
  response: SlackResponse,
  added: readonly PostedFile[],
  files: EditFiles | null,
): { id: string; name: string }[] {
  const listed = (response.message as { files?: unknown } | undefined)?.files;
  if (Array.isArray(listed)) {
    return listed.flatMap((file) => {
      const id = providerId((file as { id?: unknown } | null)?.id);
      const name = (file as { name?: unknown } | null)?.name;
      return id === undefined ? [] : [{ id, name: typeof name === 'string' && name !== '' ? name : id }];
    });
  }
  return [...(files?.keep ?? []), ...added.map((file) => ({ id: file.id, name: file.name }))];
}

/**
 * What became of files an edit put up and never attached — said beside a failure, or an outcome nobody knows. Uploaded
 * and finished but never attached, Slack keeps them, private to this account (observed 2026-10-06): unlike a post's
 * file that never reached the call finishing it, which Slack discards.
 */
function leftovers(added: readonly { name: string }[], maybe: boolean): string {
  if (added.length === 0) return '';
  const one = added.length === 1;
  const names = added.map((file) => truncateDisplay(file.name, 60)).join(', ');
  const said = `${names} ${one ? 'was' : 'were'} uploaded for this edit and never attached: Slack keeps ${one ? 'it' : 'them'}, private to this account. Delete ${one ? 'it' : 'them'} in Slack if ${one ? 'it is' : 'they are'} not wanted.`;
  return maybe ? `If the edit did not happen, ${said.charAt(0).toLowerCase()}${said.slice(1)}` : said;
}

/** Slack's refusal of the edit, with what became of the files already up added to its hint. */
function withLeftovers(error: unknown, added: readonly { id: string; name: string }[], maybe: boolean): unknown {
  const said = leftovers(added, maybe);
  if (said === '' || !(error instanceof CommsError)) return error;
  return new CommsError(error.code, error.message, {
    hint: [error.hint, said].filter((part) => part !== undefined && part !== '').join(' '),
    ...(error.details === undefined ? {} : { details: { ...error.details, uploaded: namedOnly(added) } }),
    cause: error,
  });
}

/** What an edit's refusal says when its lease ran out between its steps. */
export const EDIT_LEASE_RAN_OUT = 'nothing was changed: the sending lease ran out before the message was edited';

/**
 * An edit whose lease ran out after it had started: another call found it `unknown`, so no further step started and
 * the message is as it was. What went up is named — discarded by Slack, or, once finished, kept privately.
 */
function editLeaseRanOut(uploaded: readonly { id: string; name: string }[], finished: boolean): CommsError {
  return new CommsError('APPROVAL_VOID', EDIT_LEASE_RAN_OUT, {
    hint: [
      finished ? leftovers(uploaded, false) : discarded(uploaded),
      'No step started once its lease had run out, and the message was not changed. Prepare the edit again and show the new preview to the user.',
    ]
      .filter(Boolean)
      .join(' '),
    details: { reason: 'lease-lost', stage: finished ? 'edit' : 'upload', uploaded: [...uploaded] },
  });
}

/** The refusal for a new file that is not the one approved: nothing more is sent, and the approval is spent. */
function editFileNotApproved(
  file: SlackDraftFile,
  why: string,
  uploaded: readonly { id: string; name: string }[],
  command: Handoff,
): CommsError {
  return new CommsError(
    'APPROVAL_VOID',
    `nothing was changed: ${file.name} is not the file that was approved — ${why}`,
    {
      hint: [
        discarded(uploaded),
        handoffSentence(
          command,
          (refile) =>
            `Put the files on the draft again with ${refile} or slack_draft_update, prepare the edit again, and approve the new preview.`,
          {
            instead:
              'Put the files on the draft again with slack_draft_update, prepare the edit again, and approve the new preview.',
          },
        ),
      ]
        .filter(Boolean)
        .join(' '),
      details: { file: file.name, path: file.path, reason: 'file-changed', uploaded: [...uploaded], command },
    },
  );
}

/**
 * Puts an edit's new files up, once the approval has been claimed — shared nowhere, ready for `chat.update` to attach.
 *
 * `postFiles`'s steps, inside one permit for `files.completeUploadExternal`, and for the same reasons: every file is read
 * again and matched to what was approved before any leaves the machine; then file by file, an upload URL, the file read
 * and hashed once more, those bytes sent; then one call finishing them all. That last call names no channel, so it
 * shares nothing — only the edit attaches them. Each step starts after its own fence, the first one included.
 *
 * Every failure here leaves the message as it was, so each is recorded as a failed edit, saying which files went up and
 * what Slack does with them: a file never finished is discarded; one that may have been finished is kept, privately.
 */
async function uploadForEdit(
  deps: PostDeps,
  approvalId: string,
  claim: { claimToken: string; claimed: ApprovalObject },
  draft: SlackDraft,
  files: readonly SlackDraftFile[],
  policy: AttachPolicy,
  ids: Record<string, string>,
): Promise<PostedFile[]> {
  const uploaded: { id: string; name: string }[] = [];
  let inFlight: { id: string; name: string } | undefined;
  const added: PostedFile[] = [];
  const call: SlackCall = { ...deps.call, permit: deps.permit };
  // The uploads, and only the uploads, carry the signal — as in `postFiles`, for the same reason.
  const transfer: SlackCall = deps.signal === undefined ? call : { ...call, signal: deps.signal };
  const refile = refileCommand(deps.workspaceName, draft.draftId, deps.handoffs);
  let stage = 'check' as 'check' | 'upload' | 'complete';
  let stepsStarted = 0;
  let stoppedFirst: CommsError | undefined;
  const fence = async (): Promise<void> => {
    if (stepsStarted === 0) {
      try {
        await fenceFirstStep(deps, approvalId, claim, WORDS.edit.operation, ids);
      } catch (error) {
        stoppedFirst = error as CommsError;
        throw error;
      }
    } else {
      const verdict = await fenceOrStop(deps.approvals, approvalId, claim.claimToken, { stepsStarted });
      if (!verdict.proceed) throw editLeaseRanOut(uploaded, false);
    }
  };
  try {
    await spendOn(deps.permit, approvalId, 'files.completeUploadExternal', async () => {
      for (const file of files) {
        const check = await checkRecordedFile(file, policy);
        if (!check.ok) throw editFileNotApproved(file, check.why, uploaded, refile);
      }
      stage = 'upload';
      for (const file of files) {
        await fence();
        stepsStarted += 1;
        const place = await callSlack(call, 'files.getUploadURLExternal', { filename: file.name, length: file.size });
        const url = providerId(place.upload_url);
        const fileId = providerId(place.file_id);
        if (url === undefined || fileId === undefined) {
          throw new CommsError('PROVIDER_UNAVAILABLE', 'Slack’s answer held no upload URL or file id for the file', {
            hint: 'Try again shortly.',
          });
        }
        const read = await rereadFile(file, policy);
        if (!read.ok) throw editFileNotApproved(file, read.why, uploaded, refile);
        await fence();
        stepsStarted += 1;
        inFlight = { id: fileId, name: file.name };
        try {
          await slackFileUpload(transfer, { url, bytes: read.bytes });
        } catch (error) {
          if (deps.signal?.aborted) throw cancelled('edit', spentByCancel('edit'));
          throw error;
        }
        inFlight = undefined;
        uploaded.push({ id: fileId, name: file.name });
        added.push({ id: fileId, name: file.name, size: file.size, sha256: file.sha256 });
      }
      // Every file is up and none is finished: the last moment a cancellation keeps any of them from being kept.
      if (deps.signal?.aborted) throw cancelled('edit', spentByCancel('edit'));
      await fence();
      stepsStarted += 1;
      stage = 'complete';
      // No channel: this finishes the uploads and shares them nowhere. Only the edit attaches them (§5).
      await callSlack(call, 'files.completeUploadExternal', {
        files: JSON.stringify(added.map((file) => ({ id: file.id, title: file.name }))),
      });
    });
  } catch (error) {
    // Stopped before the first step: recorded and audited already, and nothing had been asked of Slack.
    if (error === stoppedFirst) throw error;
    const possibly = inFlight === undefined ? [] : [inFlight];
    const auditIds = {
      ...ids,
      ...(uploaded.length > 0
        ? { files: uploaded.map((file) => file.id), fileNames: uploaded.map((file) => file.name) }
        : {}),
    };
    throw await recordNotChanged(
      deps,
      approvalId,
      claim,
      'edit',
      auditIds,
      uploadFailure(error, stage, uploaded, possibly),
    );
  }
  return added;
}

/**
 * An edit's failure while its files went up, in words that say the message was not changed, and what became of each
 * file: one never finished is discarded; at the call finishing them, a refusal finished nothing, and anything else may
 * have finished them — kept privately, then. A refusal of a changed file, a lease that ran out and a cancellation are
 * already worded for themselves.
 */
function uploadFailure(
  error: unknown,
  stage: 'check' | 'upload' | 'complete',
  uploaded: readonly { id: string; name: string }[],
  possibly: readonly { id: string; name: string }[],
): unknown {
  if (!(error instanceof CommsError) || error.code === 'APPROVAL_VOID') return error;
  const finishedMaybe = stage === 'complete' && !certainlyRefused(error, 'files.completeUploadExternal');
  const which = {
    stage,
    uploaded: [...uploaded],
    ...(possibly.length > 0 ? { possiblyUploaded: [...possibly] } : {}),
  };
  const said = [
    finishedMaybe
      ? leftovers(uploaded, true).replace(/^If the edit did not happen, /, 'If Slack finished them, ')
      : discarded(uploaded),
    perhapsDiscarded(possibly),
    error.hint,
  ]
    .filter(Boolean)
    .join(' ');
  if (error.details?.reason === 'cancelled') {
    return new CommsError(error.code, error.message, { hint: said, details: { ...error.details, ...which } });
  }
  return new CommsError(error.code, `nothing was changed: ${error.message}`, {
    hint: said,
    details: { ...error.details, ...which },
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
  ids: Record<string, string | string[]>,
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
  ids: Record<string, string | string[]>,
  error: unknown,
  also = '',
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
    hint: `${look}${also === '' ? '' : ` ${also}`}${unaudited}`,
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
  ids: Record<string, string | string[]>,
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
