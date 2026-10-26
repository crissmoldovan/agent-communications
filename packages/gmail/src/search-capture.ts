import { captureForSearch, lookupName, type SearchCapture, UNTRUSTED_TAG } from '@agentcomms/core';
import type { GmailContext } from './context.ts';
import type { FollowUpsResult } from './operations/contacts.ts';
import type { ReadMessageResult, ReadThreadResult } from './operations/read.ts';
import type { SearchResult } from './operations/search.ts';

/**
 * Gmail's half of Search on this machine (design 2026-10-26-local-search, S2, S3, §5): what a call already had in hand,
 * handed to core's capture after it succeeded — never fetched for Search, and kept only where the person switched
 * Search on for the mailbox. Core seals it, appends it to this process's own inbox file, and never throws.
 *
 * - `gmail.message.read`, `gmail.thread.read`: each message's sanitised visible text — quoted history already collapsed
 *   by the read — its subject and sender; `partial` when the read was cut short (`--max-chars`, or a later page).
 * - `gmail.search`: each row's subject, snippet and sender, `partial`.
 * - `gmail.followups`: a thread waiting on the person, by its subject and sender, `partial`.
 * - `gmail.send.execute`: the text that went, as `out`, with its thread and, where the send's binding proved it, the
 *   message it answers — taken after Gmail accepted it, from the draft the send read, never from the send itself.
 *
 * A thread's timeline reads each body at one character and carries no text: it keeps nothing.
 */

const ENVELOPE = new RegExp(
  `^<${UNTRUSTED_TAG} boundary="([A-Za-z0-9_-]+)"[^>\\n]*>\\n([\\s\\S]*)\\n</${UNTRUSTED_TAG} boundary="\\1">$`,
);

/** A field as its sender wrote it: the text inside its envelope when it is wrapped, the field itself when bare. */
function inner(field: string | null | undefined): string {
  if (typeof field !== 'string') return '';
  return ENVELOPE.exec(field)?.[2] ?? field;
}

function timeOf(date: string | null | undefined): number {
  const at = typeof date === 'string' ? Date.parse(date) : Number.NaN;
  return Number.isFinite(at) ? at : Date.now();
}

/** One message read: its body without the `Subject:` line the envelope begins with. */
function messageCapture(message: ReadMessageResult): SearchCapture {
  const enveloped = inner(message.body.enveloped);
  const window = enveloped.replace(/^Subject: [^\n]*\n\n/u, '');
  return {
    channel: 'gmail',
    direction: 'in',
    sourceId: message.messageId,
    threadId: message.threadId,
    from: { address: message.from?.address, name: message.from?.name },
    subject: message.subject,
    text: window,
    at: timeOf(message.date),
    partial: message.body.truncated || window.length < message.body.totalChars,
  };
}

/** What a sent message said, registered by the send itself after Gmail accepted it, for its capture to find. */
export interface SentForSearch {
  readonly text: string;
  readonly subject: string;
  readonly threadId: string | undefined;
  readonly replyTo: string | undefined;
}

/** Each send's words, by the result it returned: nothing is added to the result, and nothing else can read it. */
export const SENT_FOR_SEARCH: WeakMap<object, SentForSearch> = new WeakMap();

/** What `operation`'s result had in hand, by mailbox name; nothing for an operation that keeps nothing. */
export function gmailCaptures(operation: string, result: unknown): { alias: string; capture: SearchCapture }[] {
  switch (operation) {
    case 'gmail.message.read': {
      const message = result as ReadMessageResult;
      return [{ alias: message.inbox, capture: messageCapture(message) }];
    }
    case 'gmail.thread.read': {
      const thread = result as ReadThreadResult;
      return thread.messages.map((message) => ({ alias: thread.inbox, capture: messageCapture(message) }));
    }
    case 'gmail.search': {
      const found = result as SearchResult;
      return found.rows.map((row) => ({
        alias: row.inbox,
        capture: {
          channel: 'gmail',
          direction: 'in',
          sourceId: row.messageId,
          threadId: row.threadId,
          from: { address: row.from?.address, name: row.from?.name },
          subject: inner(row.subject),
          text: inner(row.snippet),
          at: timeOf(row.date),
          partial: true,
        },
      }));
    }
    case 'gmail.followups': {
      const found = result as FollowUpsResult;
      return found.rows
        .filter((row) => row.direction === 'awaiting-me')
        .map((row) => ({
          alias: row.inbox,
          capture: {
            channel: 'gmail',
            direction: 'in',
            sourceId: row.messageId,
            threadId: row.threadId,
            from: { address: row.with },
            subject: inner(row.subject),
            text: '',
            at: timeOf(row.lastAt),
            partial: true,
          },
        }));
    }
    case 'gmail.send.execute': {
      const sent = result as { inbox?: string; sentMessageId?: string | undefined };
      const words = typeof result === 'object' && result !== null ? SENT_FOR_SEARCH.get(result) : undefined;
      if (words === undefined || sent.sentMessageId === undefined || typeof sent.inbox !== 'string') return [];
      return [
        {
          alias: sent.inbox,
          capture: {
            channel: 'gmail',
            direction: 'out',
            sourceId: sent.sentMessageId,
            threadId: words.threadId,
            replyTo: words.replyTo,
            subject: words.subject,
            text: words.text,
            at: Date.now(),
            partial: false,
          },
        },
      ];
    }
    default:
      return [];
  }
}

/** Hands what `operation` had in hand to core's capture, mailbox by mailbox. Never throws. */
export async function captureGmail(context: GmailContext, operation: string, result: unknown): Promise<void> {
  try {
    const captured = gmailCaptures(operation, result);
    if (captured.length === 0) return;
    const config = await context.config();
    const byAlias = new Map<string, SearchCapture[]>();
    for (const { alias, capture } of captured) {
      const list = byAlias.get(alias) ?? [];
      list.push(capture);
      byAlias.set(alias, list);
    }
    for (const [alias, captures] of byAlias) {
      const inbox = lookupName(config, 'inbox', alias);
      if (inbox === undefined) continue;
      await captureForSearch(context.core, { id: inbox.id }, captures);
    }
  } catch {
    // Search never fails a read: core says a failure once, and this one is only a missing configuration.
  }
}
