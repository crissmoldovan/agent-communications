import { CommsError, escapeForDisplay, isCommsError, isDangerous } from '@agentcomms/core';
import { recordWhatsApp } from '../activity.ts';
import { chatRefOf, noSuchChat } from '../chat-ref.ts';
import type { ResolvedAccount, WhatsAppContext } from '../context.ts';
import { WhatsAppIndex } from '../index-db.ts';
import type { ChatKind } from '../source/types.ts';
import { Visibility } from '../visibility.ts';

/**
 * A draft: the text, and a link that opens WhatsApp with it filled in. **The person presses send.**
 *
 * This is the whole of sending in this package, and it sends nothing. There is no WhatsApp client here to send with —
 * no session, no socket, no network module — so "may draft, may not send" is not a policy this code enforces; it is
 * the only thing the code can do. The link is WhatsApp's own click-to-chat: `https://wa.me/<number>?text=…` in a
 * browser, `whatsapp://send?phone=<number>&text=…` straight into the app. Either one fills the message box and stops.
 *
 * The recipient is a phone number or any chat id `chats` prints. A group has no number, so no link can open it with
 * text filled in; the draft then comes back as text to paste. So does a chat with someone who hides their number
 * (`@lid`), a broadcast list and a channel. A status update is refused: it is a post, not a chat anyone writes to.
 */

/** Long enough for any real message; short enough that the link stays a link. */
export const DRAFT_LIMIT = 4_096;

export interface DraftResult {
  to: { chat: string | null; phone: string | null; kind: ChatKind | 'phone' };
  text: string;
  /** Null when no link can target the chat: paste `text` into WhatsApp instead. */
  links: { app: string; web: string } | null;
  pasteInstead: boolean;
  reason?: string | undefined;
  /** Always false. Nothing in this package can send. */
  sent: false;
  note: string;
}

const NOTE = 'Nothing was sent. Open the link: WhatsApp shows the message with the text filled in, and you press send.';

function recipientOf(to: string): DraftResult['to'] {
  const chat = chatRefOf(to);
  if (chat.kind === 'status') {
    // `<number>@status` is that person's own posts: their chat is the one to write to.
    const author = /^(\d{7,15})@status$/i.exec(chat.id)?.[1];
    throw new CommsError('USAGE', 'a status update is not a chat anyone writes to, so there is nothing to draft to', {
      hint: author
        ? `To write to the person who posted it, draft to their number: +${author}.`
        : 'Draft to the person’s own chat instead.',
    });
  }
  return { chat: chat.id, phone: chat.phone, kind: chat.byPhone ? 'phone' : chat.kind };
}

/** Why no link can open this chat with the text filled in — said in the result, so the person knows to paste. */
function pasteReason(kind: DraftResult['to']['kind']): string {
  switch (kind) {
    case 'group':
      return 'A group has no number, so no link can open it with the text filled in. Copy the text into the group.';
    case 'broadcast':
      return 'A broadcast list has no number, so no link can open it with the text filled in. Copy the text into the list.';
    case 'channel':
      return 'A channel has no number, so no link can open it with the text filled in. Copy the text into the channel.';
    case 'hidden-number':
      return 'This person hides their number, so this chat has no phone number a link can use. Copy the text into the chat.';
    default:
      return 'This chat has no phone number a link can use. Copy the text into the chat.';
  }
}

export function composeDraft(request: { to: string; text: string }): DraftResult {
  const text = request.text.replace(/\r\n/g, '\n');
  if (text.trim() === '') throw new CommsError('USAGE', 'the draft is empty');
  if ([...text].length > DRAFT_LIMIT) {
    throw new CommsError('USAGE', `the draft is longer than ${DRAFT_LIMIT} characters`, {
      hint: 'Shorten it, or paste it into WhatsApp directly.',
    });
  }
  /*
   * What the person reads in WhatsApp's message box must be what goes out. A bidi override, a zero-width character
   * or a Unicode tag character can make those differ — tag characters are invisible and can carry a whole hidden
   * sentence to whatever reads the message on the other side. So a draft with any of them is refused, and the
   * refusal shows where they are.
   */
  const hidden = [...text].filter((char) => isDangerous(char.codePointAt(0) ?? 0));
  if (hidden.length > 0) {
    throw new CommsError('BAD_DATA', `the draft contains ${hidden.length} hidden or control character(s)`, {
      hint: `Remove them; here they are made visible: ${escapeForDisplay(text).slice(0, 300)}`,
      details: { reason: 'HIDDEN_CHARACTERS', count: hidden.length },
    });
  }
  const to = recipientOf(request.to);
  if (to.phone === null) {
    return {
      to,
      text,
      links: null,
      pasteInstead: true,
      reason: pasteReason(to.kind),
      sent: false,
      note: 'Nothing was sent. Paste the text into the chat in WhatsApp and press send yourself.',
    };
  }
  const encoded = encodeURIComponent(text);
  return {
    to,
    text,
    links: {
      app: `whatsapp://send?phone=${to.phone}&text=${encoded}`,
      web: `https://wa.me/${to.phone}?text=${encoded}`,
    },
    pasteInstead: false,
    sent: false,
    note: NOTE,
  };
}

/**
 * The draft as both surfaces offer it: `draft` and `whatsapp_draft` call this.
 *
 * **A draft cannot be used to ask which chats are hidden.** Everything that does not depend on the person's lists —
 * the text, and whether the recipient is something a message can be written to at all — is checked first. Then, while
 * the lists hide anything, a draft goes only to a chat an agent could read: one in the index and visible, answered
 * word for word as `read` answers a chat that does not exist when it is not. Otherwise "not found" for a hidden number
 * and a link for any other would say which numbers the person hid. While the lists hide nothing there is nothing to
 * give away, and any number is drafted to, in the index or not.
 *
 * Which lists: the named account's — a pinned server's is named whether the call names it or not — or, with none
 * named, every account's, since the draft could be meant for any. And on a server that is not pinned, **every
 * account's deny list, always**: a draft is a link to a number, not to an account, so a number the person denied on
 * one account is not drafted to by naming another. A pinned server serves its account alone and consults no other.
 */
export async function draftMessage(
  context: WhatsAppContext,
  request: { account?: string | undefined; to: string; text: string },
): Promise<DraftResult> {
  /*
   * One message drafted to one chat — never which, nor what it says (S4). Kind `approval`: nothing reaches WhatsApp, and
   * the person sends it. A draft naming no account is checked against every account's lists, so it is recorded under
   * the only account there is, or under all of several.
   */
  return recordWhatsApp(
    context,
    request.account,
    'whatsapp.draft',
    'approval',
    () => draftOf(context, request),
    () => ({ chats: 1, messages: 1 }),
    { anyAccount: true },
  );
}

async function draftOf(
  context: WhatsAppContext,
  request: { account?: string | undefined; to: string; text: string },
): Promise<DraftResult> {
  const draft = composeDraft({ to: request.to, text: request.text });
  const chat = chatRefOf(request.to);
  const named = request.account !== undefined || context.pinned !== undefined;
  // Every account — or, on a pinned server, its one: `accountNames` says nothing of any other there.
  const everyAccount = await Promise.all((await context.accountNames()).map((name) => context.account(name)));
  const scope = named ? [await context.account(request.account)] : everyAccount;
  // No account, no lists and no index: nothing can be hidden.
  if (scope.length === 0) return draft;
  const hidesAnything =
    scope.some(({ lists }) => lists.allow.length > 0 || lists.deny.length > 0) ||
    everyAccount.some(({ lists }) => lists.deny.length > 0);
  if (!hidesAnything) return draft;

  // One answer for hidden and for absent, naming the same account whichever it is.
  const absent = noSuchChat(chat.id, (scope[0] as ResolvedAccount).name);
  const deniedAnywhere = everyAccount.some(
    ({ lists }) => !new Visibility({ allow: [], deny: lists.deny }).seesChat(chat.id),
  );
  if (deniedAnywhere) throw absent;
  if (scope.some(({ lists }) => !new Visibility(lists).seesChat(chat.id))) throw absent;
  for (const { name, account, lists } of scope) {
    let index: WhatsAppIndex;
    try {
      index = await WhatsAppIndex.open(context.accountDir(account), name, new Visibility(lists), context.handoffs);
    } catch (error) {
      // An account never synced holds no chat; named alone, it says so, which gives away nothing about the lists.
      if (scope.length > 1 && isCommsError(error) && error.details?.reason === 'NOT_SYNCED') continue;
      throw error;
    }
    try {
      if (index.chat(chat.id)) return draft;
    } finally {
      index.close();
    }
  }
  throw absent;
}
