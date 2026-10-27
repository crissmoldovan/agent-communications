import {
  captureForSearch,
  lookupName,
  readSearchSettings,
  type SearchCapture,
  searchKeeps,
  UNTRUSTED_TAG,
} from '@agentcomms/core';
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
 *
 * **Never the person's own** (S2; the review of 2026-10-27): a message from the mailbox's own address, from any of its
 * send-as addresses, or one it sent or holds as a draft (`SENT`, `DRAFT`) is not an ask. Core knows the mailbox's own
 * address; the send-as addresses are Gmail's, so they are read here — one settings call, only while Search keeps the
 * mailbox and something read is someone's, remembered by this process for 15 minutes (a minute after a failure), and
 * waited for at most 2 seconds. It fetches no message. Should it fail, the labels still keep out what the mailbox sent.
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

/** The labels a message the person sent or is writing carries: theirs, never an ask. */
const OWN_LABELS: ReadonlySet<string> = new Set(['SENT', 'DRAFT']);

function ownMessage(labels: readonly string[] | undefined): boolean {
  return (labels ?? []).some((label) => OWN_LABELS.has(label));
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
      return ownMessage(message.labels) ? [] : [{ alias: message.inbox, capture: messageCapture(message) }];
    }
    case 'gmail.thread.read': {
      const thread = result as ReadThreadResult;
      return thread.messages
        .filter((message) => !ownMessage(message.labels))
        .map((message) => ({ alias: thread.inbox, capture: messageCapture(message) }));
    }
    case 'gmail.search': {
      const found = result as SearchResult;
      return found.rows
        .filter((row) => !ownMessage(row.labels))
        .map((row) => ({
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

/** How long this process remembers a mailbox's send-as addresses; after a failure; and how long a capture waits. */
const SEND_AS_KEPT_MS = 15 * 60_000;
const SEND_AS_RETRY_MS = 60_000;
const SEND_AS_WAIT_MS = 2_000;

const sendAsHeld = new WeakMap<GmailContext, Map<string, { until: number; addresses: Promise<string[]> }>>();

async function listedSendAs(context: GmailContext, alias: string): Promise<string[]> {
  const transport = await context.transport(alias);
  return (await transport.listSendAs()).map((each) => each.sendAsEmail).filter((address) => address !== '');
}

/** The mailbox's send-as addresses, as Gmail lists them — remembered a while; none when they cannot be read in time. */
async function sendAsAddresses(context: GmailContext, alias: string): Promise<string[]> {
  const now = Date.now();
  let held = sendAsHeld.get(context);
  if (held === undefined) {
    held = new Map();
    sendAsHeld.set(context, held);
  }
  let entry = held.get(alias);
  if (entry === undefined || entry.until <= now) {
    const made = { until: now + SEND_AS_KEPT_MS } as { until: number; addresses: Promise<string[]> };
    made.addresses = listedSendAs(context, alias).catch(() => {
      made.until = Date.now() + SEND_AS_RETRY_MS;
      return [];
    });
    entry = made;
    held.set(alias, made);
  }
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      entry.addresses,
      new Promise<string[]>((resolve) => {
        timer = setTimeout(() => resolve([]), SEND_AS_WAIT_MS);
        timer.unref();
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** Hands what `operation` had in hand to core's capture, mailbox by mailbox. Never throws. */
export async function captureGmail(context: GmailContext, operation: string, result: unknown): Promise<void> {
  try {
    const captured = gmailCaptures(operation, result);
    if (captured.length === 0) return;
    const config = await context.config();
    const settings = readSearchSettings(config);
    const byAlias = new Map<string, SearchCapture[]>();
    for (const { alias, capture } of captured) {
      const list = byAlias.get(alias) ?? [];
      list.push(capture);
      byAlias.set(alias, list);
    }
    for (const [alias, captures] of byAlias) {
      const inbox = lookupName(config, 'inbox', alias);
      if (inbox === undefined) continue;
      // The send-as addresses are asked for only where something would be kept as someone's ask.
      const asks = searchKeeps(settings, inbox.id) && captures.some((capture) => capture.direction === 'in');
      const own = asks ? await sendAsAddresses(context, alias) : [];
      await captureForSearch(context.core, { id: inbox.id }, captures, { own });
    }
  } catch {
    // Search never fails a read: core says a failure once, and this one is only a missing configuration.
  }
}
