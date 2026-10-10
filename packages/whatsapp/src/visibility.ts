import { type ChatKind, chatKindOf } from './source/types.ts';

/**
 * Which chats an agent may see in an account: the person's allow and deny lists.
 *
 * - **deny**: chats an agent must never see. A denied chat is not listed, searched, read, counted or drafted to, and
 *   asking for it by id gets the answer a chat that does not exist gets.
 * - **allow**: when it has anything on it, the only chats an agent may see.
 * - Denied wins over allowed. With neither list, every chat is visible — status updates are still left out of
 *   listings and searches unless asked for, which is a default, not a list.
 *
 * An entry is a chat id, or a phone number kept as its `…@s.whatsapp.net` id. A number names a person rather than one
 * chat: their one-to-one chat and their own status posts (`<number>@status`) — and, in a status feed, where each post
 * is its author's, the posts they wrote.
 *
 * **A status post needs an author the lists can be checked against.** Its author is the person WhatsApp recorded as
 * sending it, or — in a contact's own `<number>@status` session — that contact; one the person posted is theirs. A post
 * with no author (no `ZFROMJID`, no group-member row, or an id that names no person) could be anyone's, including
 * someone denied, so it is shown only while the lists hide nobody, and otherwise hidden and counted
 * (`unattributed`). Failing closed costs posts nobody can be named for; failing open showed a denied person's.
 *
 * **A group is a chat**, allowed or denied whole: denying someone does not remove what they wrote in a group the agent
 * may see, whether WhatsApp recorded them as its author or not — so an unknown author in a group hides nothing either.
 * A status post is its author's alone, and a feed only files them together. A group message is part of a conversation
 * the others answer and quote, so hiding one person's lines would leave the rest describing them. It could not be
 * done reliably either: a member can appear under a hidden-number id (`…@lid`) that their number does not match, and
 * an allowed group would lose every member not on the allow list. Denying the group is what hides it.
 *
 * Every read applies this — `WhatsAppIndex` cannot be opened without one — and so does `sync`, which leaves what it
 * hides out of the index, so a hidden chat's messages are not kept in a second copy on disk either.
 */

export interface ChatLists {
  readonly allow: readonly string[];
  readonly deny: readonly string[];
}

/** One entry per person or chat: a phone number and the ids that carry it compare equal. */
export function listKey(jid: string): string {
  const id = jid.trim().toLowerCase();
  const person = /^(\d{7,15})@(?:s\.whatsapp\.net|status)$/.exec(id);
  return person ? `+${person[1]}` : id;
}

/**
 * The one visibility unit a raw row belongs to.  The daemon persists this key, but only this channel defines the
 * vocabulary: an ordinary chat is its list key; a status post is the pair of its status chat and its author (or no
 * author), because the lists can hide either one — denying the status feed hides every author in it.
 */
export function visibilityUnitKey(chatId: string, chatKind: ChatKind | string, senderJid: string | null): string {
  if (chatKind !== 'status') return listKey(chatId);
  const author = statusAuthor(chatId, senderJid);
  return JSON.stringify([STATUS_UNIT, listKey(chatId), author === null ? null : listKey(author)]);
}

const STATUS_UNIT = 'status-unit';

function statusUnit(unitKey: string): { readonly chat: string; readonly author: string | null } | undefined {
  if (!unitKey.startsWith(`["${STATUS_UNIT}",`)) return undefined;
  try {
    const parsed: unknown = JSON.parse(unitKey);
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      parsed[0] === STATUS_UNIT &&
      typeof parsed[1] === 'string' &&
      (parsed[2] === null || typeof parsed[2] === 'string')
    )
      return { chat: parsed[1], author: parsed[2] };
  } catch {}
  return undefined;
}

export class Visibility {
  readonly #allow: ReadonlySet<string>;
  readonly #deny: ReadonlySet<string>;

  constructor(lists: ChatLists | undefined) {
    this.#allow = new Set((lists?.allow ?? []).map(listKey));
    this.#deny = new Set((lists?.deny ?? []).map(listKey));
  }

  /** Whether an agent may see this chat at all. */
  seesChat(chatId: string): boolean {
    const key = listKey(chatId);
    if (this.#deny.has(key)) return false;
    return this.#allow.size === 0 || this.#allow.has(key);
  }

  /**
   * Whether an agent may see this message: its chat must be visible, and in a status chat, its author — the person's
   * own posts always, anyone else's only when they are known and visible, or when the lists hide nobody at all.
   */
  seesMessage(chatId: string, chatKind: ChatKind | string, senderJid: string | null, fromMe: boolean): boolean {
    if (!this.seesChat(chatId)) return false;
    if (chatKind !== 'status' || fromMe) return true;
    const author = statusAuthor(chatId, senderJid);
    return author === null ? !this.#hidesAnyone() : this.seesChat(author);
  }

  /** Whether a durable source unit remains visible under these same lists. */
  seesUnit(unitKey: string): boolean {
    const status = statusUnit(unitKey);
    if (unitKey.startsWith(`["${STATUS_UNIT}",`) && status === undefined) return false;
    if (status === undefined) return this.seesChat(unitKey);
    // The same decision `seesMessage` makes for every non-own post in the unit.
    if (!this.seesChat(status.chat)) return false;
    return status.author === null ? !this.#hidesAnyone() : this.seesChat(status.author);
  }

  /** A status post someone else wrote with no author the lists can be checked against: hidden while they hide anyone. */
  unattributed(chatId: string, chatKind: ChatKind | string, senderJid: string | null, fromMe: boolean): boolean {
    return chatKind === 'status' && !fromMe && statusAuthor(chatId, senderJid) === null;
  }

  #hidesAnyone(): boolean {
    return this.#allow.size > 0 || this.#deny.size > 0;
  }
}

/** A contact's own status session, `<number>@status`: its id names its author. */
const OWN_STATUS = /^\d{7,15}@status$/;

/**
 * Who wrote a status post, as an id the lists can be checked against — or null when nobody can be named.
 *
 * The sender WhatsApp recorded, when it is a person (a number, or a hidden number); otherwise, in a contact's own
 * session, that contact. A group's, a feed's or a broadcast's id is no author.
 */
export function statusAuthor(chatId: string, senderJid: string | null): string | null {
  const sender = senderJid?.trim().toLowerCase() ?? '';
  if (sender !== '') {
    const kind = chatKindOf(sender);
    if (kind === 'direct' || kind === 'hidden-number' || OWN_STATUS.test(sender)) return sender;
  }
  const chat = chatId.trim().toLowerCase();
  return OWN_STATUS.test(chat) ? chat : null;
}
