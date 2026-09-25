import { CommsError, canonicalAddress, decodeHeaderWords, neutralise, parseAddressList } from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { headerValue } from '../domain/mime.ts';
import { type NumberOption, numberOption } from './numbers.ts';
import { resolveInboxes } from './search.ts';
import { allOf, oneOf } from './words.ts';

/**
 * Finding someone's address.
 *
 * Three sources, and the ranking says which is which: people the user saved, people they have corresponded with
 * (Google's "other contacts"), and addresses seen in the headers of their own mail. **Nothing here is evidence that
 * an address is the right one** — a lookalike domain matches a name search as readily as the real thing — so every
 * row carries where it came from and how often it was seen, and the choice stays with the person.
 */

export type ContactSource = 'contacts' | 'other-contacts' | 'history';

/** Where an address can come from: the saved address book, Google's "other contacts", and past mail's headers. */
export const CONTACT_SOURCES: readonly ContactSource[] = ['contacts', 'other-contacts', 'history'];

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
  /**
   * Which sources to use, as given: each is checked by `searchContacts` against {@link CONTACT_SOURCES}. All three
   * when left out.
   */
  sources?: readonly string[] | undefined;
  /** How many rows, as given; checked by `searchContacts` against {@link CONTACTS_LIMIT}. Twenty when left out. */
  limit?: unknown;
}

export const CONTACTS_LIMIT: NumberOption = { flag: '--limit', arg: 'limit', min: 1, max: 50 };

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
  /*
   * Checked before anything is read, so a word that is not a source is refused the same way from either surface. It
   * was used as a filter instead: a misspelt source was never looked in and never mentioned, so `['history',
   * 'adress-book']` searched past mail alone, and `['address-book']` searched nothing and answered "complete" with no
   * contacts — which a person reads as nobody by that name.
   */
  const sources = new Set<ContactSource>(allOf(options.sources, CONTACT_SOURCES, 'a source') ?? CONTACT_SOURCES);
  const limit = numberOption(context, options.limit, CONTACTS_LIMIT) ?? 20;
  const aliases = await resolveInboxes(context, options.inboxes);
  const errors: ContactsResult['errors'] = [];
  const found = new Map<string, Contact>();

  const add = (
    alias: string,
    entry: { name: string; email: string; source: ContactSource; at?: string | null },
  ): void => {
    // Canonical on the way in, so the same address from two sources is one row. The People API rows were only
    // lower-cased while the history rows went through `canonicalAddress`, which converts an internationalised
    // domain to punycode — so `josé@compañía.es` arrived twice, as two people, and neither row knew about the
    // other's evidence.
    const email = canonicalAddress(entry.email);
    // A display name is sender-controlled and, through RFC 2047, can hold arbitrary bytes — and neither source here
    // is one the user curated: Google auto-populates "other contacts" from the display names of whoever has mailed
    // them, and the history source reads them straight out of message headers. A contact row leaves this function as
    // a bare string in a structured result, outside any envelope, so it is neutralised here at the one place both
    // sources funnel through rather than at each call site, where the next source added would miss it.
    const name = neutralise(entry.name).text;
    const key = `${alias}:${email}`;
    const existing = found.get(key);
    if (existing) {
      if (!existing.sources.includes(entry.source)) existing.sources.push(entry.source);
      if (entry.source === 'history') existing.messages += 1;
      if (entry.at && (!existing.lastSeen || entry.at > existing.lastSeen)) existing.lastSeen = entry.at;
      if (!existing.name && name) existing.name = name;
      return;
    }
    found.set(key, {
      name,
      // Recorded canonically too, so what a caller sees is what a later lookup will match.
      email,
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
        } else {
          // Two of the three sources were not looked in, and saying nothing made the result read as a search of all
          // three that found nothing there — which is how a person concludes an address does not exist when it is
          // in their address book.
          errors.push({
            inbox: alias,
            code: 'SCOPE_MISSING',
            message: `${alias} was not granted access to contacts, so only past mail was searched`,
          });
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

/** Who a follow-up waits on: them, or me. */
export const FOLLOW_UP_DIRECTIONS: readonly ['them', 'me'] = ['them', 'me'];

export interface FollowUpOptions {
  inboxes?: string[] | 'all' | undefined;
  /** `them` = we wrote and nobody replied; `me` = they wrote and we have not. As given; checked by `followUps`. */
  direction?: string | undefined;
  /**
   * Only threads whose last real message is at least this old, in either direction.
   *
   * Defaults to 3 days for `them` and 0 for `me`: nagging somebody the day after you wrote is rude, and hiding
   * this morning's unanswered mail is unhelpful.
   */
  olderThanDays?: unknown;
  /** How far back to look. Default 30 days, and never less than `olderThanDays + 1`. */
  lookbackDays?: unknown;
  /**
   * How many rows to return in total.
   *
   * One budget across every mailbox, spent in the order they resolve — so a small limit over several mailboxes can
   * return nothing from the last of them. Raise it, or name one inbox, when the answer has to be complete.
   */
  limit?: unknown;
}

/*
 * The follow-up numbers, as given and checked by `followUps`: whole days, and rows up to fifty. A lookback shorter
 * than the quiet threshold is still raised to one day past it, as it always was — that is not a number out of range.
 */
export const OLDER_THAN_DAYS: NumberOption = { flag: '--older-than', arg: 'olderThanDays', min: 0 };
export const LOOKBACK_DAYS: NumberOption = { flag: '--lookback', arg: 'lookbackDays', min: 1 };
export const FOLLOW_UP_LIMIT: NumberOption = { flag: '--limit', arg: 'limit', min: 1, max: 50 };

/**
 * Threads that are waiting on somebody. Computed from Gmail's own view of what was sent and received, not from a
 * model's reading of the text — a follow-up list that invents obligations is worse than none.
 */
export async function followUps(context: GmailContext, options: FollowUpOptions = {}): Promise<FollowUpsResult> {
  // Checked before anything is read, so a word that is not a direction is refused the same way from either surface.
  const direction = oneOf(options.direction, FOLLOW_UP_DIRECTIONS, 'a direction') ?? 'them';
  // And the numbers, which used to be clamped into range whatever arrived.
  const olderThanDays = numberOption(context, options.olderThanDays, OLDER_THAN_DAYS);
  const lookbackDays = numberOption(context, options.lookbackDays, LOOKBACK_DAYS);
  const limit = numberOption(context, options.limit, FOLLOW_UP_LIMIT) ?? 20;
  const aliases = await resolveInboxes(context, options.inboxes);
  // The default differs by direction, because the question does. "Who has not replied to me" should not nag
  // somebody after a day; "what have I not answered" should show this morning's mail, which is precisely the mail
  // most likely to be forgotten. An explicit threshold applies to both.
  const olderThan = olderThanDays ?? (direction === 'me' ? 0 : 3);
  const lookback = Math.max(olderThan + 1, lookbackDays ?? 30);

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
        // A draft at the end of a thread means a half-written answer. Skipping the thread hid exactly the ones the
        // user most needs to see under "awaiting me", so the message before the draft decides instead.
        const lastSent = labels.includes('DRAFT')
          ? messages.filter((m) => !(m.labelIds ?? []).includes('DRAFT')).at(-1)
          : last;
        if (!lastSent) continue;
        const weSentLast = (lastSent.labelIds ?? []).includes('SENT');
        // The last word decides who is waiting: if we spoke last, they owe a reply, and the other way round.
        if (direction === 'them' ? !weSentLast : weSentLast) continue;

        const headers = lastSent.payload?.headers ?? [];
        const at = lastSent.internalDate ? new Date(Number(lastSent.internalDate)) : null;
        const ageDays = at ? Math.floor((context.now().getTime() - at.getTime()) / 86_400_000) : 0;
        // The quiet threshold applies in both directions. It only filtered `them`, so asking for "anything I have
        // not answered in a fortnight" quietly returned everything from today as well.
        if (ageDays < olderThan) continue;

        const counterpart = weSentLast
          ? (parseAddressList(headerValue(headers, 'To'))[0]?.address ?? 'unknown')
          : (parseAddressList(headerValue(headers, 'From'))[0]?.address ?? 'unknown');

        rows.push({
          inbox: alias,
          threadId: thread.id ?? entry.id,
          messageId: lastSent.id ?? '',
          // Sender-controlled and outside any envelope. `followUps` is a tool an agent calls on its own
          // initiative when triaging, so leaving a message unanswered is enough to put a payload in front of
          // the model — the user never has to open it.
          subject: neutralise(decodeHeaderWords(headerValue(headers, 'Subject') ?? '').slice(0, 120)).text,
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
