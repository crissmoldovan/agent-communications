import { type ActivityDetail, captureForSearch, type SearchCapture, UNTRUSTED_TAG } from '@agentcomms/core';
import type { SlackContext } from './context.ts';
import type { HistoryResult, ReadRow, SearchResult, ThreadResult } from './operations/read.ts';

/**
 * Slack's half of Search on this machine (design 2026-10-26-local-search, S2, S3, §5): what a call already had in hand,
 * handed to core's capture after it succeeded — never fetched for Search, and kept only where the person switched
 * Search on for the workspace. Core seals it, appends it to this process's own inbox file, and never throws.
 *
 * - `slack.read`, `slack.thread`, `slack.search`: each person's message — its decoded text, as the read returned it
 *   inside its envelope, its poster's user id and team, and the two flags Slack's reads carry, `mismatch` and
 *   `unrenderable`, which a hit shows. An app's post is not a person's ask, and is left out.
 * - `slack.post.send`: the words that went, as `out`, in their thread — after Slack accepted the post, from the draft
 *   the post was made from, never from the post itself.
 *
 * A standing acknowledgement's short reply keeps nothing in this phase.
 */

const ENVELOPE = new RegExp(
  `^<${UNTRUSTED_TAG} boundary="([A-Za-z0-9_-]+)"[^>\\n]*>\\n([\\s\\S]*)\\n</${UNTRUSTED_TAG} boundary="\\1">$`,
);
const CONVERSATION = /^[CDG][A-Z0-9]{1,40}$/;
const TS = /^\d{1,12}\.\d{1,8}$/;

function inner(field: string | null | undefined): string {
  if (typeof field !== 'string') return '';
  return ENVELOPE.exec(field)?.[2] ?? field;
}

function rowCapture(row: ReadRow, channel: string | undefined): SearchCapture[] {
  const message = row.message;
  if (channel === undefined || !CONVERSATION.test(channel) || !TS.test(message.ts)) return [];
  // An app's post — this suite's own app among them — is not a person asking.
  if (message.attribution.app || message.botId !== undefined) return [];
  const name = row.author?.displayName?.text ?? row.author?.realName?.text;
  return [
    {
      channel: 'slack',
      direction: 'in',
      sourceId: `${channel}/${message.ts}`,
      threadId: `${channel}/${message.threadTs ?? message.ts}`,
      from: {
        userId: message.userId,
        teamId: message.attribution.teamId ?? row.author?.teamId,
        ...(name === undefined ? {} : { name }),
      },
      text: inner(message.enveloped),
      at: Math.floor(Number(message.ts) * 1000),
      partial: message.truncated,
      mismatch: message.mismatch,
      unrenderable: message.unrenderable,
    },
  ];
}

/** A post as `postDraftOf` makes it, with the words the draft held. */
interface MadePostForSearch {
  readonly posted?: { readonly channel?: string; readonly ts?: string | undefined } | undefined;
  readonly thread?: string | null | undefined;
  readonly said?: string | undefined;
}

/** What `operation`'s result had in hand; nothing for an operation that keeps nothing. */
export function slackCaptures(operation: string, result: unknown, detail: ActivityDetail): SearchCapture[] {
  switch (operation) {
    case 'slack.read': {
      const history = result as HistoryResult;
      const channel = history.channel?.id ?? detail.channelId;
      return history.rows.flatMap((row) => rowCapture(row, channel));
    }
    case 'slack.thread': {
      const thread = result as ThreadResult;
      return [...(thread.parent === undefined ? [] : [thread.parent]), ...thread.replies].flatMap((row) =>
        rowCapture(row, thread.channelId),
      );
    }
    case 'slack.search': {
      const found = result as SearchResult;
      return found.hits.flatMap((hit) => rowCapture(hit, hit.channelId));
    }
    case 'slack.post.send': {
      const made = result as MadePostForSearch;
      const channel = made.posted?.channel;
      const ts = made.posted?.ts;
      if (channel === undefined || ts === undefined || typeof made.said !== 'string') return [];
      if (!CONVERSATION.test(channel) || !TS.test(ts)) return [];
      const thread = typeof made.thread === 'string' && TS.test(made.thread) ? made.thread : undefined;
      return [
        {
          channel: 'slack',
          direction: 'out',
          sourceId: `${channel}/${ts}`,
          threadId: `${channel}/${thread ?? ts}`,
          ...(thread === undefined ? {} : { replyTo: `${channel}/${thread}` }),
          text: made.said,
          at: Math.floor(Number(ts) * 1000),
          partial: false,
        },
      ];
    }
    default:
      return [];
  }
}

/** Hands what `operation` had in hand to core's capture. Never throws. */
export async function captureSlack(
  context: SlackContext,
  account: { readonly id: string },
  operation: string,
  result: unknown,
  detail: () => ActivityDetail,
): Promise<void> {
  try {
    const captures = slackCaptures(operation, result, detail());
    if (captures.length === 0) return;
    await captureForSearch(context.core, account, captures);
  } catch {
    // Search never fails a read: core says its own failures once.
  }
}
