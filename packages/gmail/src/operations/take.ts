import {
  CommsError,
  checkedTakenIds,
  checkedTakeStep,
  rfc822IdOf,
  TAKE_ID_PATTERN,
  type TakeMessage,
  type TakeMessageRef,
  type TakenView,
  type TakeStepRequest,
  type TakeStepResult,
  takeStep,
} from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { headerValue } from '../domain/mime.ts';
import { gmailTaken, takeCallerOf, takeWithOf } from '../takes.ts';

/**
 * Taking messages in Gmail (design 2026-10-26-taking-messages §5, T2, T5, T7): `agent-gmail take` and `gmail_take`,
 * `agent-gmail taken` and `gmail_taken`, one operation each way.
 *
 * - **Take** reads the message from the mailbox first: it must be there, and someone else's — not one this mailbox
 *   sent, and not a draft (T5) — so an id for a message that has not arrived cannot be squatted. What is recorded is ids
 *   only: Gmail's message id, its thread id, and its Message-ID header, so a reply's In-Reply-To finds its take.
 * - **Hand back** and **done** read nothing from Gmail: they need the record a take made, and only the holder may.
 * - **Taken** says who has each message in closed words, one file look each; with no messages, this session's own.
 *
 * Who is acting is worked out by the server or the command itself (`takerIdentity`), never from an argument. A take,
 * a hand-back and a done write no activity line (T10): the record's history is the story. Gmail has no 👀 (§7): a take
 * says nothing to the sender.
 */

export interface GmailTakeResult extends TakeStepResult {
  readonly inbox: string;
}

export interface GmailTakenResult {
  readonly inbox: string;
  /** Each message asked about — or, with none asked, each this session holds or is offered — and who has it. */
  readonly messages: { readonly id: string; readonly taken: TakenView }[];
}

/** Labels a message this mailbox did not receive carries: one it sent, and a draft — which an agent can write. */
const NOT_RECEIVED = new Set(['SENT', 'DRAFT']);

function messageIdChecked(messageId: string): string {
  if (typeof messageId !== 'string' || !TAKE_ID_PATTERN.test(messageId)) {
    throw new CommsError('USAGE', `"${String(messageId).slice(0, 60)}" is not a Gmail message id`, {
      hint: 'Name the message by the id a search or a read gives it.',
    });
  }
  return messageId;
}

/**
 * Takes, hands back or finishes one message: `step` is `take` (or a renewal of this session's own), `hand-back` with a
 * closed reason and a note for the person, or `done`.
 */
export async function takeMessage(
  context: GmailContext,
  alias: string,
  messageId: string,
  request: TakeStepRequest,
): Promise<GmailTakeResult> {
  const checked = checkedTakeStep(request);
  const id = messageIdChecked(messageId);
  const resolved = await context.inbox(alias);
  const ref: TakeMessageRef = { channel: 'gmail', accountId: resolved.inbox.id, id };
  const result = await takeStep(context.core.takes, {
    caller: await takeCallerOf(context),
    request: checked,
    ref,
    act: { account: alias, shown: id, act: 'gmail.take', takeWith: takeWithOf(context, alias, id) },
    handoffs: context.handoffs,
    verify: async (): Promise<TakeMessage> => {
      // T5: the message, as the mailbox holds it now — there, and received.
      await context.requireCapability(resolved, 'read');
      const transport = await context.transport(alias);
      let message: Awaited<ReturnType<typeof transport.getMessageMetadata>>;
      try {
        message = await transport.getMessageMetadata(id);
      } catch (error) {
        if (error instanceof CommsError && error.code === 'NOT_FOUND') {
          throw new CommsError('NOT_FOUND', `there is no message ${id} in ${alias}`, {
            hint: 'Take a message by the id a search or a read gives it: one that has arrived.',
          });
        }
        throw error;
      }
      if ((message.labelIds ?? []).some((label) => NOT_RECEIVED.has(label))) {
        throw new CommsError(
          'USAGE',
          `${alias} sent ${id}, or it is a draft: a session takes a message someone else sent`,
          {
            hint: 'Taking says which session answers a message that arrived. Your own messages need no take.',
            details: { reason: 'own-message' },
          },
        );
      }
      const rfc822Id = rfc822IdOf(headerValue(message.payload?.headers ?? [], 'Message-ID'));
      return {
        ...ref,
        thread: message.threadId && TAKE_ID_PATTERN.test(message.threadId) ? message.threadId : null,
        ...(rfc822Id === undefined ? {} : { rfc822Id }),
      };
    },
  });
  return { inbox: alias, ...result };
}

/**
 * Who has these messages (T7), at most fifty; with none, the messages this session holds or is offered in the mailbox.
 * Reads only this machine's records.
 */
export async function takenMessages(
  context: GmailContext,
  alias: string,
  messageIds?: readonly string[] | undefined,
): Promise<GmailTakenResult> {
  const ids = checkedTakenIds(messageIds);
  for (const id of ids ?? []) messageIdChecked(id);
  const resolved = await context.inbox(alias);
  const caller = await takeCallerOf(context);
  if (ids === undefined) {
    // The person at their own terminal holds nothing: a take is a session's.
    if (caller === null) return { inbox: alias, messages: [] };
    const mine = await context.core.takes.mine('gmail', resolved.inbox.id, caller);
    return { inbox: alias, messages: mine.map((held) => ({ id: held.id, taken: held.view })) };
  }
  const views = await gmailTaken(context, resolved.inbox.id, ids);
  return { inbox: alias, messages: ids.map((id) => ({ id, taken: views.get(id) ?? null })) };
}
