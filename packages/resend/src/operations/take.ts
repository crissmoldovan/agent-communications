import {
  CommsError,
  type Config,
  checkedTakenIds,
  checkedTakeStep,
  gateTake,
  handoffSentence,
  isUnmatched,
  rfc822IdOf,
  type TakeAct,
  type TakeCaller,
  type TakeGatePass,
  type TakeMessage,
  type TakeMessageRef,
  type TakenView,
  type TakeStepRequest,
  type TakeStepResult,
  takenViews,
  takeRequired,
  takeRequiredIn,
  takeStep,
  unmatchedTakeRequired,
} from '@agentcomms/core';
import { keyPermissionOf, type NamedAccount } from '../accounts.ts';
import { resendRequest } from '../api/client.ts';
import type { ResendContext } from '../context.ts';
import { resendId } from './read.ts';

/**
 * Taking messages, for Resend (design 2026-10-26-taking-messages §5, §6, T5): a session takes a received email before
 * it replies to it, hands one back that is not its own ("not mine", with a closed reason), marks one done, and asks
 * who has an email — the tool `resend_take` and the command `agent-resend take`, `resend_taken` and `taken`, one
 * operation each way.
 *
 * - **Who:** the session is worked out by the server or the command itself (`context.taker`), never passed in. The
 *   person at their own terminal takes nothing: they keep an email with core's `takes keep`.
 * - **What a take reads (T5):** the email itself, through Resend's received-mail read — so an id for mail that has not
 *   arrived, or one this account sent, cannot be taken — and its Message-ID, kept as `rfc822Id` so a reply's
 *   In-Reply-To finds its take. Nothing the sender wrote is kept. A hand-back and a done read nothing: only a take
 *   made the record they need.
 * - **What a reply needs (§6):** with an In-Reply-To, a send answers the received email with that Message-ID. It is
 *   asked at prepare, before any preview or approval, and again before the claim in `executeSend`. See `replyTake`.
 * - **Nothing recorded in activity (T10):** the record's history is the story.
 */

/** A take step's result: the account, and what core's `takeStep` says — content-free (§5). */
export type TakeResult = { readonly account: string } & TakeStepResult;

/** Who has each of these received emails, in closed words (T7). */
export interface TakenResult {
  readonly account: string;
  readonly messages: { readonly id: string; readonly taken: TakenView }[];
}

/** How this surface takes an email, for a refusal's hint: the tool over MCP, the located command at a terminal. */
function takeWith(context: ResendContext, account: string, emailId: string | null): string {
  if (context.surface === 'mcp') return 'resend_take (step "take")';
  if (emailId === null) return 'the take command';
  return handoffSentence(context.handoffs.own(['take', emailId, '--account', account]), (command) => command, {
    instead: 'the take command',
  });
}

function refOf(named: NamedAccount, id: string): TakeMessageRef {
  return { channel: 'resend', accountId: named.account.id, id };
}

/**
 * T5: the received email a take is of — there, received by this account, its Message-ID kept — or a refusal: an id
 * Resend has no received email for (one this account sent included) is NOT_FOUND; a sending-only key can read nothing,
 * so it has no email to take.
 */
async function receivedForTake(context: ResendContext, named: NamedAccount, id: string): Promise<TakeMessage> {
  const notReceived = () =>
    new CommsError('NOT_FOUND', `${named.name} received no email ${id}`, {
      hint: 'A session takes an email this account received: the received list names them. Mail it sent is not one.',
    });
  if (keyPermissionOf(named.account) === 'sending_access') {
    throw new CommsError(
      'SCOPE_MISSING',
      `${named.name}'s key can only send email: Resend refuses every read with it, so it has no received email to take`,
      { hint: 'Reading — and taking — needs a full-access key under another account name.' },
    );
  }
  const transport = await context.transport(named);
  let entry: Record<string, unknown>;
  try {
    entry = await resendRequest<Record<string, unknown>>(transport, 'GET', `/emails/receiving/${id}`);
  } catch (error) {
    if (error instanceof CommsError && error.code === 'NOT_FOUND') throw notReceived();
    throw error;
  }
  if (String(entry.id ?? '').toLowerCase() !== id) throw notReceived();
  const rfc822Id = rfc822IdOf(entry.message_id);
  return { ...refOf(named, id), thread: null, ...(rfc822Id === undefined ? {} : { rfc822Id }) };
}

/**
 * Takes a received email, hands it back with a closed reason, or marks it done (§5): `request.step` is `take`, the
 * default, `hand-back` or `done`. Refused with `TAKEN_ELSEWHERE` while someone else has it; a hand-back or a done by a
 * session that has not taken it is refused too.
 */
export async function takeMessage(
  context: ResendContext,
  name: string,
  emailId: unknown,
  request: TakeStepRequest,
): Promise<TakeResult> {
  const checked = checkedTakeStep(request);
  const id = resendId(emailId, 'received email id');
  const named = await context.accounts.require(name);
  const act: TakeAct = {
    account: named.name,
    shown: id,
    act: `resend.take${checked.step === 'take' ? '' : `.${checked.step}`}`,
    takeWith: takeWith(context, named.name, id),
  };
  const result = await takeStep(context.core.takes, {
    caller: await context.taker(),
    request: checked,
    ref: refOf(named, id),
    act,
    handoffs: context.handoffs,
    verify: () => receivedForTake(context, named, id),
  });
  return { account: named.name, ...result };
}

/**
 * Who has these received emails (T7): `you`, `another session` or `the person`, never another session's folder, client
 * or key. With none named, the emails in this account this session holds or is offered. Reads only this machine.
 */
export async function takenMessages(
  context: ResendContext,
  name: string,
  emails?: readonly unknown[] | undefined,
): Promise<TakenResult> {
  const asked = checkedTakenIds(emails);
  const ids = asked?.map((id) => resendId(id, 'received email id'));
  const named = await context.accounts.require(name);
  const caller = await context.taker();
  if (ids === undefined) {
    // The person holds no take of their own here: what they keep is in core's `takes list`.
    if (caller === null) return { account: named.name, messages: [] };
    const mine = await context.core.takes.mine('resend', named.account.id, caller);
    return { account: named.name, messages: mine.map(({ id, view }) => ({ id, taken: view })) };
  }
  const views = await takenViews(
    context.core.takes,
    ids.map((id) => refOf(named, id)),
    caller,
  );
  return { account: named.name, messages: ids.map((id) => ({ id, taken: views.get(id) ?? null })) };
}

/**
 * §6, for a send that answers a received email — one with an In-Reply-To — at prepare and again before the claim: the
 * take of the received email with that Message-ID, found by the `rfc822Id` its take recorded.
 *
 * - **A take recorded for it:** core's gate — the holder passes, renewing its lease (and, given `approvalId`, pinning
 *   the take while that approval waits); anyone else is refused `TAKEN_ELSEWHERE`, whether or not a take is required;
 *   with a take required, a session that has not taken it is refused `TAKE_REQUIRED`.
 * - **Several received emails with that Message-ID** — a Message-ID is the sender's word, and a forged copy can carry
 *   another's — each recorded one is asked by its own id, and the reply passes only where it may act on every one
 *   (security review of 0.35.0): the session holding one copy cannot answer another session's.
 * - **No take recorded for that Message-ID:** with a take required, `TAKE_REQUIRED`, naming the Message-ID. Resend
 *   cannot be asked which received email has a given Message-ID — its received list has no search — so an In-Reply-To
 *   nobody took cannot be told apart from one naming mail this account sent. Failing closed means a follow-up to the
 *   account's own email, In-Reply-To set, waits for the person, or goes without it. Without a take required, it passes:
 *   nobody else has it.
 * - **The person** is never held to taking. An agent's shell that is no session is held to every gate, and — where a
 *   take is required and none is recorded — told why it cannot take one (security review of 0.35.0, M4).
 *
 * Null when the send answers nothing, or passed without a take; the gate's pass otherwise, its line for the preview.
 */
export async function replyTake(
  context: ResendContext,
  config: Config,
  named: NamedAccount,
  inReplyTo: string | null | undefined,
  act: string,
  options: { readonly caller?: TakeCaller | undefined; readonly approvalId?: string | undefined } = {},
): Promise<TakeGatePass | null> {
  if (inReplyTo === null || inReplyTo === undefined || inReplyTo.trim() === '') return null;
  const caller = options.caller === undefined ? await context.taker() : options.caller;
  if (caller === null) return null;
  const rfc822Id = rfc822IdOf(inReplyTo);
  const found =
    rfc822Id === undefined ? [] : await context.core.takes.findAllByRfc822('resend', named.account.id, rfc822Id);
  if (found.length === 0) {
    if (!takeRequiredIn(config, named.account.id)) return null;
    const shown = rfc822Id === undefined ? 'the message it answers' : `<${rfc822Id}>`;
    const taking: TakeAct = { account: named.name, shown, act, takeWith: takeWith(context, named.name, null) };
    if (isUnmatched(caller)) throw unmatchedTakeRequired(taking, caller);
    const refused = takeRequired(taking);
    throw new CommsError(refused.code, refused.message, {
      hint: `${refused.hint} No received email with that Message-ID has been taken: take the one it answers first. If it answers none this account received — a follow-up to its own email — leave In-Reply-To out, or ask the person to send it.`,
      details: { ...refused.details, ...(rfc822Id === undefined ? {} : { inReplyTo: rfc822Id }) },
    });
  }
  let pass: TakeGatePass | null = null;
  for (const ref of found) {
    const gated = await gateTake(context.core.takes, config, {
      ref,
      caller,
      act: { account: named.name, shown: ref.id, act, takeWith: takeWith(context, named.name, ref.id) },
      ...(options.approvalId === undefined ? {} : { approvalId: options.approvalId }),
    });
    if (pass === null || (!pass.held && gated.held)) pass = gated;
  }
  return pass;
}
