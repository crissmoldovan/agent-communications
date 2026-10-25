import { AsyncLocalStorage } from 'node:async_hooks';
import {
  type ActivityAccount,
  type ActivityDetail,
  type ActivityItem,
  type ActivityKind,
  type ActivitySender,
  parseAddressList,
  UNTRUSTED_TAG,
  withActivity,
} from '@agentcomms/core';
import type { ResendContext } from './context.ts';

/**
 * Resend's half of the activity log (design 2026-10-25-activity §4.2, §8 Task 2a): every operation a capability row
 * names that reads or writes a Resend account records one line, through core's `withActivity`, from inside the
 * operation — so the command and the tool that run it record the same line.
 *
 * - **One line per call.** An operation another recorded operation calls on its way records nothing of its own; the
 *   outer call is known by the async context it runs in, so two calls at once in one server are two lines.
 * - **What it touched, never what it said.** Ids, counts, subjects, senders' names and addresses, file names and
 *   sizes, a send's recipients and its approval — never a body, a preview or bytes. A field a result carries inside the
 *   untrusted-content envelope is taken out of it for the line (`plain`); the log wraps it again wherever it is shown.
 * - **Never in the way.** Working out the account never throws, and `withActivity` never changes what the call returns
 *   or throws.
 */

/** Set for the length of a recorded call: an operation it calls on its way records nothing of its own. */
const recording = new AsyncLocalStorage<true>();

/** The account a line is recorded against, as known before the call: its id and its name, or the name alone. */
async function accountOf(context: ResendContext, name: string): Promise<ActivityAccount> {
  try {
    return { id: (await context.accounts.find(name))?.account.id ?? '', alias: name };
  } catch {
    return { id: '', alias: name };
  }
}

/**
 * Runs one Resend operation and records its line: `operation` is the capability id (`resend.emails.list`), `kind`
 * what it did, `account` the account's name as the call gives it. Inside another recorded call it only runs `fn`.
 */
export async function recorded<T>(
  context: ResendContext,
  operation: string,
  kind: ActivityKind,
  account: string,
  fn: () => Promise<T>,
  describe: (result: T) => ActivityDetail,
): Promise<T> {
  if (recording.getStore() === true) return fn();
  const named = await accountOf(context, account);
  return recording.run(true, () =>
    withActivity(
      {
        core: context.core,
        channel: 'resend',
        surface: context.surface,
        account: named,
        clientInfo: () => context.clientInfo?.(),
      },
      operation,
      kind,
      fn,
      describe,
    ),
  );
}

/** What a read answers when its key cannot read: a refusal that comes back as a result, recorded as one. */
export function unavailable(result: { readonly reason: string }): ActivityDetail {
  return { outcome: 'refused', reason: result.reason };
}

const ENVELOPE = new RegExp(
  `^<${UNTRUSTED_TAG} boundary="([A-Za-z0-9_-]+)"[^>\\n]*>\\n([\\s\\S]*)\\n</${UNTRUSTED_TAG} boundary="\\1">$`,
);

/**
 * A field as its sender wrote it: the text inside its untrusted-content envelope when it is wrapped, the field itself
 * when it is bare (a plain address), and undefined for nothing at all.
 */
export function plain(field: string | null | undefined): string | undefined {
  if (typeof field !== 'string' || field === '') return undefined;
  return ENVELOPE.exec(field)?.[2] ?? field;
}

/** A sender from a `Name <address>` field, bare or wrapped: the name only when there is one. */
export function senderOfField(field: string | null | undefined): ActivitySender | undefined {
  const text = plain(field);
  if (text === undefined) return undefined;
  const parsed = parseAddressList(text)[0];
  if (parsed === undefined) return { address: text };
  return { ...(parsed.name ? { name: parsed.name } : {}), address: parsed.address };
}

/** A sender from its two fields, each bare or wrapped. Undefined when there is neither. */
export function senderOf(
  from: { readonly name?: string | null | undefined; readonly address?: string | null | undefined } | null | undefined,
): ActivitySender | undefined {
  const name = plain(from?.name ?? undefined);
  const address = plain(from?.address ?? undefined);
  if (name === undefined && address === undefined) return undefined;
  return { ...(name === undefined ? {} : { name }), ...(address === undefined ? {} : { address }) };
}

/** One email touched: its id, and its subject and sender when it has them. */
export function itemOf(
  id: string,
  subject?: string | null | undefined,
  from?: ActivitySender | undefined,
): ActivityItem {
  const text = plain(subject ?? undefined);
  return { id, ...(text === undefined ? {} : { subject: text }), ...(from === undefined ? {} : { from }) };
}
