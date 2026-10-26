import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ActivityAccount,
  type ActivityDetail,
  type ActivityItem,
  type ActivityKind,
  type ActivitySender,
  lookupName,
  UNTRUSTED_TAG,
  withActivity,
} from '@agentcomms/core';
import type { GmailContext } from './context.ts';
import { captureGmail } from './search-capture.ts';

/**
 * Gmail's half of the activity log (design 2026-10-25-activity §4.2, §8 Task 2a): every operation a capability row
 * names that reads or writes a mailbox records one line, through core's `withActivity`, from inside the operation —
 * so the command and the tool that run it record the same line, and no surface can forget to.
 *
 * - **One line per call.** An operation another recorded operation calls on its way — an export reading the message it
 *   writes out, a timeline reading its thread — records nothing of its own: the line of the call that was made says
 *   what it touched. The outer call is known by the async context it runs in, so two calls running at once in one
 *   server are two lines.
 * - **What it touched, never what it said.** `describe` picks ids, counts, subjects, senders' names and addresses, file
 *   names and sizes, the query an agent wrote and a send's recipients, and nothing else; core copies only a line's own
 *   fields whatever it is handed. A subject or a name a result carries inside the untrusted-content envelope is taken
 *   out of it for the line (`plain`): the log keeps what the sender wrote, and wraps it again wherever it is shown.
 * - **Never in the way.** Working out the account never throws, and core's `withActivity` never changes what the call
 *   returns or throws.
 */

/** Set for the length of a recorded call: an operation it calls on its way records nothing of its own. */
const recording = new AsyncLocalStorage<true>();

/** Which mailboxes a call names: one alias, a list of them, or every one (`all`, or left out). */
export type MailboxesAsked = string | readonly string[] | 'all' | undefined;

/**
 * The account a line is recorded against, as known before the call runs: the mailbox's id and its name. A call over
 * several mailboxes names them all, by name, with no single id; a name that is not a mailbox's is kept as asked, with
 * no id. Never throws: a configuration that cannot be read leaves the name alone.
 */
async function accountOf(context: GmailContext, asked: MailboxesAsked): Promise<ActivityAccount> {
  const named = typeof asked === 'string' && asked !== 'all' ? [asked] : Array.isArray(asked) ? [...asked] : null;
  try {
    const config = await context.config();
    const aliases = named ?? Object.keys(config.inboxes).sort();
    const only = aliases.length === 1 ? aliases[0] : undefined;
    if (only !== undefined) return { id: lookupName(config, 'inbox', only)?.id ?? '', alias: only };
    return { id: '', alias: aliases.join(',') };
  } catch {
    return { id: '', alias: named?.join(',') ?? '' };
  }
}

/**
 * Runs one Gmail operation and records its line: `operation` is the capability id (`gmail.search`), `kind` what it
 * did, `mailboxes` the mailbox or mailboxes it was asked about, and `query` a search's words when it has them. Inside
 * another recorded call it only runs `fn`.
 */
export async function recorded<T>(
  context: GmailContext,
  operation: string,
  kind: ActivityKind,
  mailboxes: MailboxesAsked,
  fn: () => Promise<T>,
  describe: (result: T) => ActivityDetail,
  query?: string | undefined,
): Promise<T> {
  if (recording.getStore() === true) return fn();
  const account = await accountOf(context, mailboxes);
  const result = await recording.run(true, () =>
    withActivity(
      {
        core: context.core,
        channel: 'gmail',
        surface: context.surface,
        account,
        clientInfo: () => context.clientInfo?.(),
        ...(query === undefined ? {} : { query }),
      },
      operation,
      kind,
      fn,
      describe,
    ),
  );
  // What the call had in hand, for Search on this machine, where the person switched it on: never thrown, never
  // changing the result (design 2026-10-26-local-search §5).
  await captureGmail(context, operation, result);
  return result;
}

const ENVELOPE = new RegExp(
  `^<${UNTRUSTED_TAG} boundary="([A-Za-z0-9_-]+)"[^>\\n]*>\\n([\\s\\S]*)\\n</${UNTRUSTED_TAG} boundary="\\1">$`,
);

/**
 * A field as its sender wrote it: the text inside its untrusted-content envelope when it is wrapped, the field itself
 * when it is bare (a plain address, a plain file name), and undefined for nothing at all. Already neutralised either
 * way: an envelope's text is, and a bare field is only ever a plain token.
 */
export function plain(field: string | null | undefined): string | undefined {
  if (typeof field !== 'string' || field === '') return undefined;
  return ENVELOPE.exec(field)?.[2] ?? field;
}

/** A sender as a line keeps one: the name only when there is one. Undefined when there is neither. */
export function senderOf(
  from: { readonly name?: string | null | undefined; readonly address?: string | null | undefined } | null | undefined,
): ActivitySender | undefined {
  const name = plain(from?.name ?? undefined);
  const address = plain(from?.address ?? undefined);
  if (name === undefined && address === undefined) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(address === undefined ? {} : { address }) };
}

/** One thing touched: its id, and its subject and sender when it has them. */
export function itemOf(
  id: string,
  subject?: string | null | undefined,
  from?: Parameters<typeof senderOf>[0],
): ActivityItem {
  const text = plain(subject ?? undefined);
  const sender = senderOf(from);
  return { id, ...(text === undefined ? {} : { subject: text }), ...(sender === undefined ? {} : { from: sender }) };
}
