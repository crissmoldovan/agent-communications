import { type ActivityAccount, type ActivityKind, CommsError, isCommsError, withActivity } from '@agentcomms/core';
import type { WhatsAppContext } from './context.ts';

/**
 * What this package writes in core's activity log (design 2026-10-25-activity, S4, and §8 Task 2b): one line for each
 * call that reads an account's chats or drafts to one — **counts and nothing else**.
 *
 * - **A line holds** the operation, the account, `counts` (`chats`, `messages`), the outcome and the session.
 * - **Its kind:** `read` for a sync and every read of the index; `approval` for a draft, which reaches nothing — it is a
 *   link the person checks and sends themselves (the lead's rule for 0.29.0: `write` is only an act that reaches the
 *   service, and this package has none).
 * - **It never holds** a chat's id, a name, a number, a message or a preview — nor a search's words, which may be a
 *   name or a number — and no item at all. So a chat the person denies later leaves nothing behind in the log, as it
 *   leaves nothing in the index (`visibility.ts`), and core never needs WhatsApp's lists to keep the log clean.
 * - **Nor does its reason.** A refusal here names the chat it refused (`no chat 15555550101@s.whatsapp.net in …`), so a
 *   failed or refused line keeps the error's code and none of its words. The call still throws the error it threw.
 */

const CHANNEL = 'whatsapp';

/** What a failed or refused line says in place of the error's own words, which may name a chat or a number. */
export const WITHHELD = 'details withheld: a WhatsApp line names no chat, person or number';

/** The counts a line may hold: how many chats and messages, never which. */
export interface WhatsAppCounts {
  readonly chats?: number | undefined;
  readonly messages?: number | undefined;
}

/**
 * The account a call acts on: the one it names, or the pinned server's. With `anyAccount` — a draft, which applies
 * every account's lists when it names none — the only account there is, or every one of several: one line, their names
 * joined by commas and no id, as a call over several accounts is recorded (the lead's rule for 0.29.0). Undefined when
 * the call names an account this machine does not have, or none where one is needed: it is then refused before any
 * account is read, and records nothing.
 */
async function accountOf(
  context: WhatsAppContext,
  named: string | undefined,
  anyAccount: boolean,
): Promise<ActivityAccount | undefined> {
  try {
    if (named !== undefined || context.pinned !== undefined) {
      const { name, account } = await context.account(named);
      return { id: account.id, alias: name };
    }
    if (!anyAccount) return undefined;
    const names = await context.accountNames();
    if (names.length === 0) return undefined;
    if (names.length > 1) return { id: '', alias: names.join(',') };
    const { name, account } = await context.account(names[0]);
    return { id: account.id, alias: name };
  } catch {
    return undefined;
  }
}

/** The counts of a result, as whole numbers, and only the two a WhatsApp line may hold. */
function countsOf(counts: WhatsAppCounts): Record<string, number> {
  return Object.fromEntries(
    Object.entries({ chats: counts.chats, messages: counts.messages }).filter(
      (entry): entry is [string, number] => typeof entry[1] === 'number',
    ),
  );
}

/**
 * Runs `fn` — one capability's call on the account `named` — and records its line: `operation` is the capability id
 * in `capabilities.json`, and `counts` how many chats and messages it touched. What `fn` returns or throws is exactly
 * what this returns or throws: the error that is recorded is a copy with the same code and none of the words, and the
 * one `fn` threw is the one thrown on.
 */
export async function recordWhatsApp<T>(
  context: WhatsAppContext,
  named: string | undefined,
  operation: string,
  kind: ActivityKind,
  fn: () => Promise<T>,
  counts: (result: T) => WhatsAppCounts,
  options: { anyAccount?: boolean } = {},
): Promise<T> {
  const account = await accountOf(context, named, options.anyAccount === true);
  if (account === undefined) return fn();
  let thrown: { error: unknown } | undefined;
  try {
    return await withActivity(
      { core: context.core, channel: CHANNEL, surface: context.surface, account, clientInfo: context.clientInfo },
      operation,
      kind,
      async () => {
        try {
          return await fn();
        } catch (error) {
          thrown = { error };
          // Core records what this says: the code — whether it was refused or failed — and none of the error's words.
          throw new CommsError(isCommsError(error) ? error.code : 'UNEXPECTED', WITHHELD);
        }
      },
      (result) => ({ counts: countsOf(counts(result)) }),
    );
  } catch (error) {
    throw thrown === undefined ? error : thrown.error;
  }
}
