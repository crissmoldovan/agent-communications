import { randomBytes } from 'node:crypto';
import {
  type ActivityAccount,
  type ActivityKind,
  type ActivitySession,
  CommsError,
  isCommsError,
  lookupName,
  withActivity,
} from '@agentcomms/core';
import { PLATFORM } from './config.ts';
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
 * - **Its session is this process's own, ungrouped.** Grouping a process with its agent window (S2) reads the parent's
 *   start with `ps`, and this package starts no process but the link opener (`no-network.test.ts`): so each server and
 *   each command is a session of its own, marked ungrouped, with its folder and — over MCP — what the client said.
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
 *
 * Read from the configuration alone — never through `context.account`, which reads the person's lists too: the
 * operation looks its account up itself, once, as it always has.
 */
async function accountOf(
  context: WhatsAppContext,
  named: string | undefined,
  anyAccount: boolean,
): Promise<ActivityAccount | undefined> {
  try {
    let names: string[];
    if (context.pinned !== undefined) {
      // The pinned account under the name it has now; a call naming another is refused, and records nothing.
      names = await context.accountNames();
      if (named !== undefined && !names.includes(named)) return undefined;
    } else if (named !== undefined) names = [named];
    else if (anyAccount) names = await context.accountNames();
    else return undefined;
    const config = await context.config();
    const accounts = names.map((name) => ({ name, account: lookupName(config, 'account', name) }));
    if (accounts.length === 0 || accounts.some(({ account }) => account?.platform !== PLATFORM)) return undefined;
    const [only] = accounts;
    if (accounts.length === 1 && only?.account !== undefined) return { id: only.account.id, alias: only.name };
    return { id: '', alias: names.join(',') };
  } catch {
    return undefined;
  }
}

/** This process's own session key and id: made once, so every line of this process is one session. */
const OWN = { key: randomBytes(8).toString('hex'), process: randomBytes(6).toString('hex') };

/** The session a line of this process is recorded under: its own, ungrouped, with no process started to learn more. */
function ownSession(context: WhatsAppContext): ActivitySession {
  let folder: string | null;
  try {
    folder = process.cwd();
  } catch {
    folder = null;
  }
  const client = context.clientInfo?.();
  return {
    key: OWN.key,
    process: OWN.process,
    pid: process.pid,
    ...(client?.name ? { client: { name: client.name, ...(client.version ? { version: client.version } : {}) } } : {}),
    folder,
    grouped: false,
    surface: context.surface,
  };
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
      { core: context.core, channel: CHANNEL, surface: context.surface, account, session: ownSession(context) },
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
