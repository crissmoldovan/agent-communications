import { type CliHandoffs, CommsError, canonicalJson, sha256Hex, truncateDisplay } from '@agentcomms/core';
import { callSlack, type SlackCall } from '../api/call.ts';
import { decodeSlackText } from '../text/decode.ts';
import { requireConversation } from './destination.ts';
import type { NameBook } from './people.ts';

/**
 * The one message an edit or a deletion is about, read from Slack (design 2026-10-06 §E2, §E3).
 *
 * The caller names a message by its channel and its ts, and that is all the caller is trusted for: what a preview shows
 * of it, whose it is, and what the approval binds are what Slack returned for that pair a moment ago — never what a
 * caller said was there.
 */

type Raw = Record<string, unknown>;

/** Where a message is: the conversation, and the ts Slack gave it. */
export interface MessageAt {
  readonly channel: string;
  readonly ts: string;
}

/** A message as Slack has it now: the fields an edit or a deletion shows, checks and binds. */
export interface TargetMessage extends MessageAt {
  /** Who wrote it, by id — checked against the account before anything is shown. Absent when Slack named nobody. */
  readonly userId: string | undefined;
  /** Its words in Slack's wire form — escaped, mentions as spans. Bound as they are; shown decoded. */
  readonly text: string;
  /** The thread it is a reply in, when it is one. A thread's parent is not a reply, and has no value here. */
  readonly threadTs: string | undefined;
  /** How many replies it has, when it is a thread's parent: none otherwise. */
  readonly replyCount: number;
  /** Its files, by id and the name Slack shows. Not part of an edit; not deleted with a deletion. */
  readonly files: readonly { readonly id: string; readonly name: string }[];
  /** When it was last edited, as Slack says: bound, so a change to it in Slack between preview and claim voids. */
  readonly editedTs: string | undefined;
}

/*
 * A Slack message ts: seconds, a point, then the sequence within that second — `1700000000.000100`. Checked before Slack
 * is asked anything, so a mistyped one is refused in words that say so, and so a deletion's record — which carries the
 * ts in its draft id — holds nothing but digits and one point.
 */
const MESSAGE_TS = /^\d{1,12}\.\d{1,8}$/;
/* A conversation id: a channel's C…, a private channel's G…, a DM's D…. A user id is refused before this, in its own words. */
const CONVERSATION_ID = /^[CGD][A-Z0-9]{1,39}$/;

/**
 * Refuses a channel or a ts that cannot name a message, before Slack is asked about it.
 *
 * A user id first, in the words a post's refusal uses (#43): a DM is a conversation with an id of its own.
 */
export function requireMessageAt(where: MessageAt, alias: string, handoffs: CliHandoffs): void {
  requireConversation(where.channel, alias, handoffs);
  if (!CONVERSATION_ID.test(where.channel)) {
    throw new CommsError('USAGE', `"${truncateDisplay(where.channel, 60)}" is not a conversation id`, {
      hint: 'Pass the id of the channel the message is in: a channel’s C… or G…, or a DM’s D….',
      details: { channel: where.channel, reason: 'not-a-conversation' },
    });
  }
  requireMessageTs(where.ts);
}

/** Refuses a ts that cannot be a message's — alone, for a caller whose channel comes from a draft read later. */
export function requireMessageTs(ts: string): void {
  if (MESSAGE_TS.test(ts)) return;
  throw new CommsError('USAGE', `"${truncateDisplay(ts, 60)}" is not a message timestamp`, {
    hint: 'Pass the message’s ts exactly as a read returned it, such as 1700000000.000100.',
    details: { ts, reason: 'not-a-ts' },
  });
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null) as Raw[]) : [];
}

/** The message whose own ts is `ts`, among those Slack returned — by identity, never by position. */
function withTs(messages: unknown, ts: string): Raw | undefined {
  return list(messages).find((message) => message.ts === ts);
}

function targetOf(where: MessageAt, raw: Raw): TargetMessage {
  const threadTs = str(raw.thread_ts);
  const edited = (raw.edited as Raw | undefined) ?? {};
  return {
    channel: where.channel,
    ts: where.ts,
    userId: str(raw.user),
    text: typeof raw.text === 'string' ? raw.text : '',
    // A parent carries its own ts as `thread_ts`: it is the thread, not a reply in one.
    threadTs: threadTs !== undefined && threadTs !== where.ts ? threadTs : undefined,
    replyCount: typeof raw.reply_count === 'number' && raw.reply_count > 0 ? raw.reply_count : 0,
    files: list(raw.files).flatMap((file) => {
      const id = str(file.id);
      return id === undefined ? [] : [{ id, name: str(file.name) ?? str(file.title) ?? id }];
    }),
    editedTs: str(edited.ts),
  };
}

/**
 * The message at `where`, as Slack has it now — or `NOT_FOUND`.
 *
 * `conversations.history` first, bounded to that one ts: a message in the channel itself, a thread's parent, or a reply
 * also sent to the channel. A reply that lives only in its thread is not there, so `conversations.replies` is asked
 * next, given the reply's own ts — which Slack accepts as "a message in the thread" — and the reply is picked out by
 * its ts, never assumed to be the first or the last of what came back. One neither finds is not there for this
 * account, and that is all that is said: never a guess at which message was meant.
 */
export async function messageAt(call: SlackCall, where: MessageAt): Promise<TargetMessage> {
  const window = { channel: where.channel, oldest: where.ts, latest: where.ts, inclusive: true };
  const history = await callSlack(call, 'conversations.history', { ...window, limit: 1 });
  let found = withTs(history.messages, where.ts);
  if (found === undefined) {
    try {
      const replies = await callSlack(call, 'conversations.replies', { ...window, ts: where.ts });
      found = withTs(replies.messages, where.ts);
    } catch (error) {
      /*
       * No thread at that ts is no message at it: said once, below, in one set of words. Only Slack's own
       * `thread_not_found` — not every NOT_FOUND, which `callSlack` also gives a channel not found or archived since.
       * Swallowed, those read as "no message", and a deletion's last look took a reply still there for one already
       * deleted (review of #52).
       */
      if (!(error instanceof CommsError) || error.details?.slackError !== 'thread_not_found') throw error;
    }
  }
  if (found === undefined) {
    throw new CommsError('NOT_FOUND', `no message at ${where.ts} in ${where.channel} that this account can read`, {
      hint: 'Read the channel or the thread again and pass the ts it shows for the message.',
      details: { channel: where.channel, ts: where.ts, reason: 'no-message' },
    });
  }
  return targetOf(where, found);
}

/**
 * Refuses a message this account did not write (design 2026-10-06 §E2), before anything about it is shown.
 *
 * For an edit this is Slack's own rule, found sooner. For a deletion it is stricter than Slack: a workspace admin can
 * delete anybody's messages, and an agent acting for one never does — anyone else's words stay as they wrote them.
 */
export function requireOwnMessage(message: TargetMessage, postingAs: string, act: 'edit' | 'delete'): void {
  if (message.userId !== undefined && message.userId === postingAs) return;
  const done = act === 'edit' ? 'changed' : 'deleted';
  throw new CommsError(
    'SCOPE_MISSING',
    `nothing was ${done}: the message at ${message.ts} was not written by this account`,
    {
      hint:
        act === 'edit'
          ? 'Only a message this account posted can be edited.'
          : 'Only a message this account posted is deleted from here; anyone else’s stays as they wrote it.',
      details: { channel: message.channel, ts: message.ts, reason: 'not-own-message' },
    },
  );
}

/**
 * What an approval binds of the message it acts on: its author, its words, its thread, when it was last edited and
 * its files — and, for a deletion, how many replies it has, which is what the person was told would be left behind.
 *
 * An edit does not bind the replies: a thread that gained a reply is the same message to change.
 */
export function targetDigest(message: TargetMessage, act: 'edit' | 'delete'): string {
  return sha256Hex(
    canonicalJson({
      channel: message.channel,
      ts: message.ts,
      user: message.userId ?? null,
      text: message.text,
      threadTs: message.threadTs ?? null,
      editedTs: message.editedTs ?? null,
      files: message.files.map((file) => file.id),
      ...(act === 'delete' ? { replyCount: message.replyCount } : {}),
    }),
  );
}

/**
 * The message's words as the channel reads them: decoded, and not neutralised — they are this account's own, as an
 * outgoing post's are (D4). The renderer escapes them for the terminal.
 */
export function shownText(message: TargetMessage, book: NameBook): string {
  return decodeSlackText(message.text, book.names()).text;
}
