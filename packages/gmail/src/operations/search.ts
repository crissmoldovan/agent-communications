import { createHash } from 'node:crypto';
import {
  CommsError,
  neutralise,
  newBoundary,
  parseAddressList,
  TaintCollector,
  wrapUntrusted,
} from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';
import { headerValue, readParts } from '../domain/mime.ts';
import { compileQuery } from '../domain/query.ts';
import type { GmailTransport, RawMessage } from '../gmail-api/transport.ts';
import { taintExclusions } from './read.ts';

/**
 * Searching across mailboxes.
 *
 * Two things here are less obvious than they look. **Gmail's result count is an estimate**, wrong in both
 * directions, and agents read "about 20 results" as the whole answer and stop looking — so the count of rows
 * returned, Gmail's estimate and an explicit `hasMore` are three separate fields, and only the last is a statement
 * about whether anything was left behind. And **a cursor is bound to the query and the mailboxes it came from**:
 * replaying page two of one search against a different query would silently interleave two result sets.
 */

export type SearchKind = 'threads' | 'messages';

export interface SearchRow {
  inbox: string;
  threadId: string;
  messageId: string;
  date: string | null;
  from: { name: string; address: string } | null;
  toCount: number;
  /** Sender-controlled, and enveloped: a subject can carry an instruction as easily as a body can. */
  subject: string;
  snippet: string;
  labels: string[];
  attachmentCount: number;
  unread: boolean;
  webLink: string;
}

export interface SearchError {
  inbox: string;
  code: string;
  message: string;
  hint?: string | undefined;
}

export interface SearchResult {
  /** The query as sent to Gmail, with what was rewritten and why. */
  query: {
    given: string;
    compiled: string;
    rewrites: Array<{ operator: string; from: string; to: string }>;
    timezone: string;
  };
  kind: SearchKind;
  inboxes: string[];
  rows: SearchRow[];
  /** Untrusted-content envelope wrapping every subject and snippet in `rows`, for a model to read. */
  enveloped: string;
  hasMore: boolean;
  nextCursor: string | undefined;
  /** How many rows this page actually holds. */
  returned: number;
  /**
   * Gmail's own `resultSizeEstimate`, summed across mailboxes. It is an estimate in both directions and is never a
   * count — `hasMore` is the only reliable statement about whether anything was left behind.
   */
  estimatedTotal: number;
  /** Mailboxes that failed; the rest of the search still returned. */
  errors: SearchError[];
  /** False when any mailbox failed, so a caller never reads a partial answer as a complete one. */
  complete: boolean;
}

export interface SearchOptions {
  query: string;
  /** Aliases, or `all`. */
  inboxes?: string[] | 'all' | undefined;
  kind?: SearchKind | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  includeSpamTrash?: boolean | undefined;
}

export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 50;

interface CursorState {
  v: 1;
  /** Hash of the compiled query, so a cursor cannot be replayed against another search. */
  q: string;
  kind: SearchKind;
  inboxes: string[];
  per: Record<string, { pageToken?: string | undefined; consumed: string[]; exhausted: boolean }>;
}

function encodeCursor(state: CursorState): string {
  return Buffer.from(JSON.stringify(state), 'utf8').toString('base64url');
}

function decodeCursor(cursor: string): CursorState {
  let parsed: CursorState;
  try {
    parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as CursorState;
  } catch {
    throw new CommsError('CURSOR_MISMATCH', 'that cursor is not one of ours', {
      hint: 'Run the search again without a cursor.',
    });
  }
  if (parsed?.v !== 1 || typeof parsed.q !== 'string' || !parsed.per) {
    throw new CommsError('CURSOR_MISMATCH', 'that cursor is from an older version', {
      hint: 'Run the search again without a cursor.',
    });
  }
  return parsed;
}

function queryHash(compiled: string): string {
  return createHash('sha256').update(compiled).digest('hex').slice(0, 16);
}

/**
 * One mailbox's side of the merge: pages of ids, and metadata fetched only when the merge actually looks at a row.
 * A search over six mailboxes that returns twenty rows fetches about twenty-six messages, not six pages of fifty.
 */
class InboxStream {
  readonly alias: string;
  readonly #transport: GmailTransport;
  readonly #kind: SearchKind;
  readonly #query: string;
  readonly #includeSpamTrash: boolean;
  #pageToken: string | undefined;
  #pending: Array<{ id: string; threadId?: string | undefined }> = [];
  /** Gmail said there is no page after the one we hold. */
  #noMorePages = false;
  #exhausted = false;
  #head: { id: string; message: RawMessage; date: number } | null = null;
  consumed: string[] = [];
  resultSizeEstimate = 0;

  constructor(options: {
    alias: string;
    transport: GmailTransport;
    kind: SearchKind;
    query: string;
    includeSpamTrash: boolean;
    state?: { pageToken?: string | undefined; consumed: string[]; exhausted: boolean } | undefined;
  }) {
    this.alias = options.alias;
    this.#transport = options.transport;
    this.#kind = options.kind;
    this.#query = options.query;
    this.#includeSpamTrash = options.includeSpamTrash;
    this.#pageToken = options.state?.pageToken;
    this.consumed = options.state?.consumed ?? [];
    this.#exhausted = options.state?.exhausted ?? false;
    this.#noMorePages = this.#exhausted;
  }

  get exhausted(): boolean {
    return this.#exhausted && this.#pending.length === 0 && this.#head === null;
  }

  async #fill(): Promise<void> {
    if (this.#pending.length > 0 || this.#exhausted) return;
    if (this.#noMorePages) {
      this.#exhausted = true;
      return;
    }
    // A resumed search whose first page carried no page token starts that page again and skips what it already
    // emitted: one page of ids costs 5 quota units, and the alternative is losing the rest of the results.
    const page =
      this.#kind === 'threads'
        ? await this.#transport.listThreads({
            query: this.#query,
            pageToken: this.#pageToken,
            includeSpamTrash: this.#includeSpamTrash,
          })
        : await this.#transport.listMessages({
            query: this.#query,
            pageToken: this.#pageToken,
            includeSpamTrash: this.#includeSpamTrash,
          });
    this.resultSizeEstimate = Math.max(this.resultSizeEstimate, page.resultSizeEstimate ?? 0);
    this.#pageToken = page.nextPageToken;
    if (page.nextPageToken === undefined) this.#noMorePages = true;
    // Ids already emitted on an earlier page of this search are skipped rather than shown twice.
    this.#pending = page.ids.filter((entry) => !this.consumed.includes(entry.id));
    if (this.#pending.length === 0 && this.#noMorePages) this.#exhausted = true;
  }

  /** The newest row this mailbox has not yet emitted, with its metadata fetched. */
  async peek(): Promise<{ id: string; message: RawMessage; date: number } | null> {
    if (this.#head) return this.#head;
    await this.#fill();
    const next = this.#pending.shift();
    if (!next) return null;
    // For a thread the row describes its newest message, which is the last one Gmail returns.
    const message = await this.#transport.getMessageMetadata(
      this.#kind === 'threads' ? await this.#newestOfThread(next.id) : next.id,
    );
    this.#head = { id: next.id, message, date: Number(message.internalDate ?? 0) };
    return this.#head;
  }

  async #newestOfThread(threadId: string): Promise<string> {
    const thread = await this.#transport.getThread(threadId);
    const messages = [...(thread.messages ?? [])].sort(
      (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
    );
    return messages.at(-1)?.id ?? threadId;
  }

  take(): { id: string; message: RawMessage } | null {
    const head = this.#head;
    if (!head) return null;
    this.#head = null;
    this.consumed.push(head.id);
    return head;
  }

  state(): { pageToken?: string | undefined; consumed: string[]; exhausted: boolean } {
    return {
      pageToken: this.#pageToken,
      // Only what this page needs to skip; the list cannot grow without bound.
      consumed: this.consumed.slice(-200),
      exhausted: this.#noMorePages && this.#head === null && this.#pending.length === 0,
    };
  }
}

function rowFrom(alias: string, message: RawMessage, threadId: string): SearchRow {
  const headers = message.payload?.headers ?? [];
  const parts = readParts(message.payload);
  const from = parseAddressList(headerValue(headers, 'From'))[0] ?? null;
  const labels = message.labelIds ?? [];
  return {
    inbox: alias,
    threadId,
    messageId: message.id ?? '',
    date: message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    // Sender-controlled, and therefore neutralised: a search row leaves this function as a bare string in a
    // structured result, beside the enveloped body rather than inside it. A display name can carry anything at
    // all — RFC 2047 encoding puts arbitrary bytes, newlines included, into a field that looks like a name.
    from: from ? { ...from, name: neutralise(from.name).text } : null,
    toCount: parseAddressList(headerValue(headers, 'To')).length + parseAddressList(headerValue(headers, 'Cc')).length,
    subject: neutralise((headerValue(headers, 'Subject') ?? '').slice(0, 120)).text,
    snippet: neutralise(message.snippet ?? '').text,
    labels,
    attachmentCount: parts.attachments.filter((part) => part.disposition !== 'inline').length,
    unread: labels.includes('UNREAD'),
    webLink: message.id ? `https://mail.google.com/mail/u/0/#all/${message.id}` : '',
  };
}

/** Resolves the mailbox list: named aliases, or every connected mailbox. */
export async function resolveInboxes(
  context: GmailContext,
  requested: string[] | 'all' | undefined,
): Promise<string[]> {
  const config = await context.config();
  const known = Object.keys(config.inboxes);
  if (requested === undefined || requested === 'all') {
    if (known.length === 0) {
      throw new CommsError('NOT_FOUND', 'no mailbox is connected yet', {
        hint: 'Connect one with `agent-gmail inbox add <name> --start`.',
      });
    }
    // Sorted, so a cursor made today still matches the same set tomorrow whatever order the config file grew in.
    return [...known].sort();
  }
  const unknown = requested.filter((alias) => !known.includes(alias));
  if (unknown.length > 0) {
    throw new CommsError('NOT_FOUND', `no inbox called "${unknown.join('", "')}"`, {
      hint: known.length ? `Known inboxes: ${known.join(', ')}.` : 'No inboxes yet.',
    });
  }
  return requested;
}

export async function search(context: GmailContext, options: SearchOptions): Promise<SearchResult> {
  const config = await context.config();
  const kind = options.kind ?? 'threads';
  const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT);
  const aliases = await resolveInboxes(context, options.inboxes);
  const compiled = compileQuery(options.query, { timezone: config.defaults.timezone });
  const hash = queryHash(`${compiled.compiled}|${kind}`);

  let cursorState: CursorState | undefined;
  if (options.cursor) {
    cursorState = decodeCursor(options.cursor);
    if (cursorState.q !== hash) {
      throw new CommsError('CURSOR_MISMATCH', 'that cursor belongs to a different search', {
        hint: 'Cursors carry their query and mailboxes. Run this search from the start, or repeat the original query.',
      });
    }
    if (cursorState.inboxes.join(',') !== aliases.join(',')) {
      throw new CommsError('CURSOR_MISMATCH', 'that cursor was made for a different set of mailboxes', {
        hint: `It was for: ${cursorState.inboxes.join(', ')}.`,
      });
    }
  }

  const streams: InboxStream[] = [];
  const errors: SearchError[] = [];
  for (const alias of aliases) {
    try {
      const resolved = await context.inbox(alias);
      await context.requireCapability(resolved, 'read');
      streams.push(
        new InboxStream({
          alias,
          transport: await context.transport(alias),
          kind,
          query: compiled.compiled,
          includeSpamTrash: options.includeSpamTrash ?? false,
          state: cursorState?.per[alias],
        }),
      );
    } catch (error) {
      const failure = error as CommsError;
      errors.push({ inbox: alias, code: failure.code ?? 'UNEXPECTED', message: failure.message, hint: failure.hint });
    }
  }

  const rows: SearchRow[] = [];
  const boundary = newBoundary();
  const collectors = new Map<string, TaintCollector>();

  // Merge by date: take whichever mailbox's next row is newest, so one page reads as one conversation list.
  while (rows.length < limit) {
    const heads: Array<{ stream: InboxStream; head: { id: string; message: RawMessage; date: number } }> = [];
    for (const stream of streams) {
      try {
        const head = await stream.peek();
        if (head) heads.push({ stream, head });
      } catch (error) {
        const failure = error as CommsError;
        if (!errors.some((entry) => entry.inbox === stream.alias)) {
          errors.push({
            inbox: stream.alias,
            code: failure.code ?? 'UNEXPECTED',
            message: failure.message,
            hint: failure.hint,
          });
        }
      }
    }
    if (heads.length === 0) break;
    heads.sort((a, b) => b.head.date - a.head.date);
    const chosen = heads[0];
    if (!chosen) break;
    const taken = chosen.stream.take();
    if (!taken) break;

    const row = rowFrom(chosen.stream.alias, taken.message, taken.message.threadId ?? taken.id);
    rows.push(row);

    const resolved = await context.inbox(chosen.stream.alias);
    let collector = collectors.get(chosen.stream.alias);
    if (!collector) {
      collector = new TaintCollector(resolved.inbox.id);
      collectors.set(chosen.stream.alias, collector);
    }
    collector.observeText(`${row.subject}\n${row.snippet}`);
    if (row.from) collector.observeHeaders([row.from.address]);
  }

  for (const [alias, collector] of collectors) {
    await collector.flush(context.core.taint, await taintExclusions(context, alias));
  }

  const per: CursorState['per'] = {};
  for (const stream of streams) per[stream.alias] = stream.state();
  const hasMore = streams.some((stream) => !stream.exhausted);

  const enveloped = wrapUntrusted(
    rows
      .map(
        (row, index) =>
          `[${index + 1}] ${row.inbox} · ${row.date ?? 'unknown date'} · from ${row.from?.address ?? 'unknown'}\n` +
          `Subject: ${row.subject}\n${row.snippet}`,
      )
      .join('\n\n'),
    { field: 'search-results' },
    boundary,
  );

  return {
    query: {
      given: options.query,
      compiled: compiled.compiled,
      rewrites: compiled.rewrites,
      timezone: compiled.timezone,
    },
    kind,
    inboxes: aliases,
    rows,
    enveloped,
    hasMore,
    nextCursor: hasMore ? encodeCursor({ v: 1, q: hash, kind, inboxes: aliases, per }) : undefined,
    returned: rows.length,
    estimatedTotal: streams.reduce((total, stream) => total + stream.resultSizeEstimate, 0),
    errors,
    complete: errors.length === 0,
  };
}
