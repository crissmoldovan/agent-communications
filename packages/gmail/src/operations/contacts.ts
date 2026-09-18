import { CommsError, parseAddressList } from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';
import { headerValue } from '../domain/mime.ts';
import { resolveInboxes } from './search.ts';

/**
 * Finding someone's address.
 *
 * Three sources, and the ranking says which is which: people the user saved, people they have corresponded with
 * (Google's "other contacts"), and addresses seen in the headers of their own mail. **Nothing here is evidence that
 * an address is the right one** — a lookalike domain matches a name search as readily as the real thing — so every
 * row carries where it came from and how often it was seen, and the choice stays with the person.
 */

export type ContactSource = 'contacts' | 'other-contacts' | 'history';

export interface Contact {
  name: string;
  email: string;
  inbox: string;
  sources: ContactSource[];
  /** How many messages in this mailbox involved the address; 0 when it came only from the contact list. */
  messages: number;
  lastSeen: string | null;
}

export interface ContactsResult {
  query: string;
  contacts: Contact[];
  errors: Array<{ inbox: string; code: string; message: string }>;
  complete: boolean;
}

export interface ContactsOptions {
  inboxes?: string[] | 'all' | undefined;
  /** Which sources to use; all three by default. */
  sources?: ContactSource[] | undefined;
  limit?: number | undefined;
}

const RANK: Record<ContactSource, number> = { contacts: 0, history: 1, 'other-contacts': 2 };

export async function searchContacts(
  context: GmailContext,
  query: string,
  options: ContactsOptions = {},
): Promise<ContactsResult> {
  if (!query.trim()) {
    throw new CommsError('USAGE', 'searching contacts needs something to search for', {
      hint: 'Pass a name, part of an address, or a domain.',
    });
  }
  const aliases = await resolveInboxes(context, options.inboxes);
  const sources = new Set<ContactSource>(options.sources ?? ['contacts', 'other-contacts', 'history']);
  const limit = Math.min(Math.max(1, options.limit ?? 20), 50);
  const errors: ContactsResult['errors'] = [];
  const found = new Map<string, Contact>();

  const add = (
    alias: string,
    entry: { name: string; email: string; source: ContactSource; at?: string | null },
  ): void => {
    const key = `${alias}:${entry.email.toLowerCase()}`;
    const existing = found.get(key);
    if (existing) {
      if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
      if (entry.source === 'history') existing.messages += 1;
      if (entry.at && (!existing.lastSeen || entry.at > existing.lastSeen)) existing.lastSeen = entry.at;
      if (!existing.name && entry.name) existing.name = entry.name;
      return;
    }
    found.set(key, {
      name: entry.name,
      email: entry.email.toLowerCase(),
      inbox: alias,
      sources: [entry.source],
      messages: entry.source === 'history' ? 1 : 0,
      lastSeen: entry.at ?? null,
    });
  };

  for (const alias of aliases) {
    try {
      const resolved = await context.inbox(alias);
      await context.requireCapability(resolved, 'read');
      const transport = await context.transport(alias);

      if (sources.has('contacts') || sources.has('other-contacts')) {
        if (resolved.inbox.contacts) {
          try {
            for (const match of await transport.searchContacts(query)) {
              if (!sources.has(match.source)) continue;
              add(alias, { name: match.name, email: match.email, source: match.source });
            }
          } catch (error) {
            // Contacts is a separate permission and a separate API; without it, history still answers.
            const failure = error as CommsError;
            errors.push({ inbox: alias, code: failure.code ?? 'UNEXPECTED', message: failure.message });
          }
        }
      }

      if (sources.has('history')) {
        // Gmail matches the query against addresses and display names in the headers it indexed.
        const page = await transport.listMessages({ query: `from:${query} OR to:${query}`, maxResults: 25 });
        for (const entry of page.ids.slice(0, 25)) {
          const message = await transport.getMessageMetadata(entry.id);
          const headers = message.payload?.headers ?? [];
          const at = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
          for (const header of ['From', 'To', 'Cc']) {
            for (const address of parseAddressList(headerValue(headers, header))) {
              if (address.address === resolved.inbox.email.toLowerCase()) continue;
              const needle = query.toLowerCase();
              if (!address.address.includes(needle) && !address.name.toLowerCase().includes(needle)) continue;
              add(alias, { name: address.name, email: address.address, source: 'history', at });
            }
          }
        }
      }
    } catch (error) {
      const failure = error as CommsError;
      errors.push({ inbox: alias, code: failure.code ?? 'UNEXPECTED', message: failure.message });
    }
  }

  const contacts = [...found.values()]
    .sort((a, b) => {
      const source = Math.min(...a.sources.map((s) => RANK[s])) - Math.min(...b.sources.map((s) => RANK[s]));
      if (source !== 0) return source;
      if (b.messages !== a.messages) return b.messages - a.messages;
      return (b.lastSeen ?? '').localeCompare(a.lastSeen ?? '');
    })
    .slice(0, limit);

  return { query, contacts, errors, complete: errors.length === 0 };
}

export interface FollowUp {
  inbox: string;
  threadId: string;
  messageId: string;
  subject: string;
  with: string;
  lastAt: string | null;
  ageDays: number;
  direction: 'awaiting-them' | 'awaiting-me';
}

export interface FollowUpsResult {
  rows: FollowUp[];
  query: string;
  errors: Array<{ inbox: string; code: string; message: string }>;
  complete: boolean;
}

export interface FollowUpOptions {
  inboxes?: string[] | 'all' | undefined;
  /** `them` = we wrote and nobody replied; `me` = they wrote and we have not. */
  direction?: 'them' | 'me' | undefined;
  /** Only threads older than this many days. */
  olderThanDays?: number | undefined;
  /** How far back to look. */
  lookbackDays?: number | undefined;
  limit?: number | undefined;
}

/**
 * Threads that are waiting on somebody. Computed from Gmail's own view of what was sent and received, not from a
 * model's reading of the text — a follow-up list that invents obligations is worse than none.
 */
export async function followUps(context: GmailContext, options: FollowUpOptions = {}): Promise<FollowUpsResult> {
  const aliases = await resolveInboxes(context, options.inboxes);
  const direction = options.direction ?? 'them';
  const olderThan = Math.max(0, options.olderThanDays ?? 3);
  const lookback = Math.max(olderThan + 1, options.lookbackDays ?? 30);
  const limit = Math.min(Math.max(1, options.limit ?? 20), 50);

  // Awaiting them: we wrote it, and it has not been touched since. Awaiting me: it arrived and is still in the inbox.
  const query =
    direction === 'them'
      ? `in:sent older_than:${olderThan}d newer_than:${lookback}d`
      : `in:inbox newer_than:${lookback}d -category:promotions -category:social -category:updates -category:forums`;

  const rows: FollowUp[] = [];
  const errors: FollowUpsResult['errors'] = [];

  for (const alias of aliases) {
    try {
      const resolved = await context.inbox(alias);
      await context.requireCapability(resolved, 'read');
      const transport = await context.transport(alias);
      const page = await transport.listThreads({ query, maxResults: limit });

      for (const entry of page.ids) {
        if (rows.length >= limit) break;
        const thread = await transport.getThread(entry.id);
        const messages = [...(thread.messages ?? [])].sort(
          (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
        );
        const last = messages.at(-1);
        if (!last) continue;
        const labels = last.labelIds ?? [];
        if (labels.includes('DRAFT')) continue;
        const weSentLast = labels.includes('SENT');
        // The last word decides who is waiting: if we spoke last, they owe a reply, and the other way round.
        if (direction === 'them' ? !weSentLast : weSentLast) continue;

        const headers = last.payload?.headers ?? [];
        const at = last.internalDate ? new Date(Number(last.internalDate)) : null;
        const ageDays = at ? Math.floor((context.now().getTime() - at.getTime()) / 86_400_000) : 0;
        if (direction === 'them' && ageDays < olderThan) continue;

        const counterpart = weSentLast
          ? (parseAddressList(headerValue(headers, 'To'))[0]?.address ?? 'unknown')
          : (parseAddressList(headerValue(headers, 'From'))[0]?.address ?? 'unknown');

        rows.push({
          inbox: alias,
          threadId: thread.id ?? entry.id,
          messageId: last.id ?? '',
          subject: (headerValue(headers, 'Subject') ?? '').slice(0, 120),
          with: counterpart,
          lastAt: at?.toISOString() ?? null,
          ageDays,
          direction: direction === 'them' ? 'awaiting-them' : 'awaiting-me',
        });
      }
    } catch (error) {
      const failure = error as CommsError;
      errors.push({ inbox: alias, code: failure.code ?? 'UNEXPECTED', message: failure.message });
    }
  }

  rows.sort((a, b) => b.ageDays - a.ageDays);
  return { rows: rows.slice(0, limit), query, errors, complete: errors.length === 0 };
}
