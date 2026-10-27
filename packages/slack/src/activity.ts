import { basename } from 'node:path';
import {
  type ActivityAccount,
  type ActivityDetail,
  type ActivityItem,
  type ActivityKind,
  type ActivitySender,
  type ApprovalRecord,
  type PreparedStanding,
  resolveName,
  withActivity,
} from '@agentcomms/core';
import type { SlackDraftFile } from './compose/files.ts';
import type { SlackContext } from './context.ts';
import type { AckResult } from './operations/ack.ts';
import type { DeletedMessage, EditedMessage, PreparedDeletion, PreparedEdit } from './operations/amend.ts';
import type { DeletedDraft, DraftView } from './operations/drafts.ts';
import type { FileDownloadQuestion, FileDownloadResult } from './operations/files.ts';
import type { AgentIconResult } from './operations/icon.ts';
import type {
  ChannelsResult,
  FilesResult,
  HistoryResult,
  PeopleResult,
  ReadRow,
  SearchResult,
  ThreadResult,
} from './operations/read.ts';
import type { PostedFiles, PostedMessage, PreparedPost, ReactionOptions, ReactionResult } from './operations/send.ts';
import { captureSlack } from './search-capture.ts';

/**
 * What this package writes in core's activity log (design 2026-10-25-activity, §4.2 and §8 Task 2b): one line for each
 * call that reads or writes a workspace's data, tied to the session that made it.
 *
 * - **Reads:** each message by its ts, the conversation it is in by name (its id when Slack gave no name), the poster by
 *   the name Slack shows, the counts, and a search's query — the agent's words, not a sender's.
 * - **Writes:** what the audit records — the message, the draft, the approval — and the conversation's name where the
 *   result has it: a preview names the room, a post's answer only its id. A file by its name and size, never its bytes.
 * - **Kinds** (the lead's rule for 0.29.0, as Gmail and Resend have them): `write` only for an act that reaches Slack —
 *   a post, a reaction claimed with its approval, an edit, a deletion, an acknowledgement. `approval` for preparing or
 *   cancelling one that a person approves first: a draft written, changed or thrown away (nothing reaches Slack — it
 *   is the first half of a post's preparation), a post, edit, deletion or reaction prepared, a standing approval
 *   prepared, and a download's question of where to save. `read` for the rest, the files saved included.
 * - **Never** a message's words, a preview's body, a file's bytes, a token or a secret. Each describer below copies ids,
 *   names and sizes out of a result field by field, and core copies them again into the line (`activityLineOf`), so a
 *   whole result handed over by mistake still writes none of its text.
 *
 * Where it is recorded: the operations that are given this package's context record themselves, so the command and the
 * tool that share one record alike. The six reads given a `SlackCall` — channels, read, thread, search, files, people —
 * and the three steps each surface takes itself — a download, the agent emoji, deleting a draft — are recorded where
 * each surface calls them, opening the workspace included, so a sign-in that has lapsed is a `failed` line too.
 */

const CHANNEL = 'slack';

/**
 * The workspace a call names, as the log records it: its immutable id and the name it has now. Undefined when the name
 * names no Slack workspace — the call is then refused before any account is touched, and records nothing.
 */
async function accountOf(context: SlackContext, alias: string): Promise<ActivityAccount | undefined> {
  try {
    const { alias: name, account } = resolveName(await context.config(), 'account', alias);
    return account.platform === CHANNEL ? { id: account.id, alias: name } : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Runs `fn` — one capability's call on the workspace `alias` — and records its line: `operation` is the capability id
 * in `capabilities.json`. What `fn` returns or throws is exactly what this returns or throws; recording never changes
 * it (core's `withActivity`). A workspace the configuration does not know is not recorded: `fn` refuses it.
 */
export async function recordSlack<T>(
  context: SlackContext,
  alias: string,
  operation: string,
  kind: ActivityKind,
  fn: () => Promise<T>,
  describe: (result: T) => ActivityDetail,
): Promise<T> {
  const account = await accountOf(context, alias);
  if (account === undefined) return fn();
  const result = await withActivity(
    { core: context.core, channel: CHANNEL, surface: context.surface, account, clientInfo: context.clientInfo },
    operation,
    kind,
    fn,
    describe,
  );
  // What the call had in hand, for Search on this machine, where the person switched it on: never thrown, never
  // changing the result (design 2026-10-26-local-search §5).
  await captureSlack(context, account, operation, result, () => {
    try {
      return describe(result) ?? {};
    } catch {
      return {};
    }
  });
  return result;
}

// ── Reads ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Who posted a message, by the name Slack shows for them — or the app's — and their id when there is no name. */
function posterOf(row: ReadRow): ActivitySender | undefined {
  const name =
    row.author?.displayName?.text ??
    row.author?.realName?.text ??
    row.message.attribution.appName?.text ??
    row.message.userId ??
    row.message.botId;
  return name === undefined || name === '' ? undefined : { name };
}

/** One message read: its ts, who posted it and where — never what it says. */
function messageItem(row: ReadRow, conversation: string | undefined): ActivityItem {
  const from = posterOf(row);
  return {
    id: row.message.ts,
    ...(from === undefined ? {} : { from }),
    ...(conversation === undefined || conversation === '' ? {} : { conversation }),
  };
}

export function describeChannels(result: ChannelsResult): ActivityDetail {
  return {
    count: result.channels.length,
    items: result.channels.map((channel) => ({
      id: channel.id,
      ...(channel.name === undefined ? {} : { conversation: channel.name.text }),
    })),
  };
}

/**
 * A channel's history: the conversation by the name `conversations.info` gave, or the id that was asked for — and, on
 * the line, by its id (0.32.0 §3.6), which is what an event names a message by: `<channelId>/<ts>`.
 */
export function describeHistory(channelId: string): (result: HistoryResult) => ActivityDetail {
  return (result) => {
    const conversation = result.channel?.name?.text ?? channelId;
    return {
      count: result.rows.length,
      items: result.rows.map((row) => messageItem(row, conversation)),
      channelId: result.channel?.id ?? channelId,
    };
  };
}

/** A thread: parent first, then the replies, each in the conversation by its id — a thread's read names no room. */
export function describeThread(result: ThreadResult): ActivityDetail {
  const rows = [...(result.parent === undefined ? [] : [result.parent]), ...result.replies];
  return { count: rows.length, items: rows.map((row) => messageItem(row, result.channelId)) };
}

export function describeSearch(result: SearchResult): ActivityDetail {
  return {
    query: result.query,
    count: result.hits.length,
    items: result.hits.map((hit) => messageItem(hit, hit.channelName ?? hit.channelId)),
  };
}

/** The people listed, by their ids: a list of members is not anybody's message, so no name is kept. */
export function describePeople(result: PeopleResult): ActivityDetail {
  return { count: result.people.length, items: result.people.map((person) => ({ id: person.id })) };
}

export function describeFiles(result: FilesResult): ActivityDetail {
  return {
    count: result.files.length,
    items: result.files.map((file) => ({
      id: file.id,
      ...(file.name === undefined ? {} : { name: file.name }),
      ...(file.size === undefined ? {} : { size: file.size }),
    })),
  };
}

/**
 * A field a result hands back inside the untrusted-content envelope, as the text inside it: the log keeps what was
 * received and is shown inside the envelope wherever it is read, so it is not wrapped twice. Anything else as it is.
 */
export function bareOf(text: string): string {
  const inside = /^<untrusted-content\b[^>]*>\n([\s\S]*)\n<\/untrusted-content boundary="[^"]*">$/.exec(text);
  return inside?.[1] ?? text;
}

/**
 * A download: the question lists the files it would save, by id, name and size, with its choice id; the answer lists
 * the files it saved, by the name each was saved under. Never their bytes.
 */
export function describeDownload(result: FileDownloadQuestion | FileDownloadResult): ActivityDetail {
  if (result.destinationRequired) {
    return {
      approvalId: result.choiceId,
      count: result.files.length,
      items: result.files.map((file) => ({
        id: file.fileId,
        name: bareOf(file.name),
        ...(file.size === null ? {} : { size: file.size }),
        ...(file.channel === null ? {} : { conversation: file.channel }),
      })),
    };
  }
  return {
    count: result.files.length,
    items: result.files.map((file) => ({
      id: file.fileId,
      name: bareOf(file.savedAs),
      size: file.size,
      ...(file.channel === null ? {} : { conversation: file.channel }),
    })),
  };
}

/** The agent emoji made from the person's own photo: the file written, by its name and size. */
export function describeIcon(result: AgentIconResult): ActivityDetail {
  const name = basename(result.path);
  return { items: [{ id: name, name, size: result.bytes }] };
}

// ── Drafts ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** A file a draft or a post carries: its SHA-256, which names those bytes exactly, its name and its size. */
function fileItem(file: { readonly sha256?: string | undefined; readonly name: string; readonly size: number }) {
  return { id: file.sha256 ?? file.name, name: file.name, size: file.size };
}

/** A draft written or changed: its id and the conversation it is for, and the files it carries. Never its words. */
export function describeDraft(draft: {
  readonly draftId: string;
  readonly payload: { readonly channel: string };
  readonly files?: readonly SlackDraftFile[] | undefined;
}): ActivityDetail {
  return {
    items: [{ id: draft.draftId, conversation: draft.payload.channel }, ...(draft.files ?? []).map(fileItem)],
  };
}

export function describeDraftView(view: DraftView): ActivityDetail {
  return { items: [{ id: view.draftId, conversation: view.channel }, ...(view.files ?? []).map(fileItem)] };
}

export function describeDrafts(views: readonly DraftView[]): ActivityDetail {
  return { count: views.length, items: views.map((view) => ({ id: view.draftId, conversation: view.channel })) };
}

export function describeDeletedDraft(deleted: DeletedDraft): ActivityDetail {
  return { items: [{ id: deleted.draftId }] };
}

// ── Posts, reactions, edits and deletions ────────────────────────────────────────────────────────────────────────

/** The files a preview lists, by their SHA-256, name and size. */
function previewFiles(
  attachments: readonly { filename: string; size: number; sha256?: string | undefined }[] | undefined,
): ActivityItem[] {
  return (attachments ?? []).map((file) => fileItem({ sha256: file.sha256, name: file.filename, size: file.size }));
}

/** A post prepared: the draft, the room by the name the preview shows, the files, and the approval it waits on. */
export function describePrepared(prepared: PreparedPost): ActivityDetail {
  return {
    approvalId: prepared.approvalId,
    items: [
      { id: prepared.draftId, conversation: prepared.preview.channel },
      ...previewFiles(prepared.preview.attachments),
    ],
  };
}

/**
 * A post made: the message Slack made — the draft, when Slack named none — where, and the files now in Slack; and
 * (0.32.0 §3.6) the conversation by its id, and the thread it went into — the parent's ts, or null for a new message —
 * so a reply is tied to the message it answers.
 */
export function describePosted(
  draftId: string,
  thread: string | null,
): (posted: PostedMessage | PostedFiles) => ActivityDetail {
  return (posted) => {
    const files = 'files' in posted ? posted.files : [];
    return {
      approvalId: posted.approvalId,
      items: [
        { id: posted.ts ?? draftId, conversation: posted.channel },
        ...files.map((file) => ({ id: file.id, name: file.name, size: file.size })),
      ],
      channelId: posted.channel,
      thread,
    };
  };
}

/** A reaction: the message it is on, and the approval it was made under. */
export function describeReaction(wanted: ReactionOptions): (result: ReactionResult) => ActivityDetail {
  return (result) => ({ approvalId: result.approvalId, items: [{ id: wanted.ts, conversation: wanted.channel }] });
}

export function describeEditPrepared(prepared: PreparedEdit): ActivityDetail {
  return {
    approvalId: prepared.approvalId,
    items: [{ id: prepared.ts, conversation: prepared.preview.channel }, ...previewFiles(prepared.preview.attachments)],
  };
}

export function describeEdited(edited: EditedMessage): ActivityDetail {
  return {
    approvalId: edited.approvalId,
    items: [
      { id: edited.ts, conversation: edited.channel },
      ...(edited.files ?? []).map((file) => ({ id: file.id, name: file.name })),
    ],
  };
}

export function describeDeletionPrepared(prepared: PreparedDeletion): ActivityDetail {
  return { approvalId: prepared.approvalId, items: [{ id: prepared.ts, conversation: prepared.preview.channel }] };
}

export function describeDeleted(deleted: DeletedMessage): ActivityDetail {
  return { approvalId: deleted.approvalId, items: [{ id: deleted.ts, conversation: deleted.channel }] };
}

/**
 * An acknowledgement under a standing approval: the message acknowledged, the reply posted when there was one, and
 * (0.32.0) what it did — `reply` or `reaction` — so a message an agent answered reads apart from one it marked seen.
 */
export function describeAck(result: AckResult): ActivityDetail {
  const reply = result.posted?.ts;
  return {
    approvalId: result.approvalId,
    act: result.act,
    items: [
      { id: result.ts, conversation: result.channel },
      ...(reply === undefined ? [] : [{ id: reply, conversation: result.channel }]),
    ],
  };
}

/**
 * A standing approval prepared, or narrowed at once: its approval, and the places it names by id — none for
 * `threads-i-am-in`, which is no place.
 */
export function describeStanding(
  places: 'threads-i-am-in' | readonly string[],
): (
  outcome: { status: 'narrowed'; record: ApprovalRecord } | { status: 'approval-required'; prepared: PreparedStanding },
) => ActivityDetail {
  return (outcome) => ({
    approvalId: outcome.status === 'narrowed' ? outcome.record.approvalId : outcome.prepared.approvalId,
    ...(places === 'threads-i-am-in' ? {} : { items: places.map((id) => ({ id })) }),
  });
}
