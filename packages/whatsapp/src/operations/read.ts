import { CommsError, wholeNumber } from '@agentcomms/core';
import { recordWhatsApp } from '../activity.ts';
import { chatRefOf, noSuchChat } from '../chat-ref.ts';
import type { WhatsAppContext } from '../context.ts';
import { WhatsAppIndex } from '../index-db.ts';
import { type ChatView, type MessageView, Presenter } from '../present.ts';
import type { ChatKind } from '../source/types.ts';
import { Visibility } from '../visibility.ts';

/**
 * Reading: chats, one chat, search. Each opens only the local index — never WhatsApp's own files — so none of them
 * can wait on a macOS dialog, and each works on what the last `sync` saw.
 */

export const CHAT_KINDS: readonly ChatKind[] = Object.freeze([
  'direct',
  'hidden-number',
  'group',
  'status',
  'broadcast',
  'channel',
  'unknown',
]);

/**
 * What `chats` lists and `search` searches when no kind is asked for: every kind but status updates, which are posts
 * to everyone rather than a conversation — and, in a real store, one session per contact, enough to bury the chats.
 * They are there for the asking (`--kind status`), and a status chat named by its id is read like any other.
 */
export const DEFAULT_KINDS: readonly ChatKind[] = Object.freeze(CHAT_KINDS.filter((kind) => kind !== 'status'));

/** The one kind asked for, checked; or, when none was, the default kinds. */
function kindsOf(kind: string | undefined): readonly ChatKind[] {
  if (kind === undefined) return DEFAULT_KINDS;
  if (!(CHAT_KINDS as readonly string[]).includes(kind)) {
    throw new CommsError('USAGE', `"${kind}" is not a kind of chat`, { hint: `One of ${CHAT_KINDS.join(', ')}.` });
  }
  return [kind as ChatKind];
}

/** The account's index, seen through its allow and deny lists. Every read here opens it this way. */
async function openIndex(context: WhatsAppContext, accountName: string | undefined) {
  const { name, account, lists } = await context.account(accountName);
  const index = await WhatsAppIndex.open(context.accountDir(account), name, new Visibility(lists), context.handoffs);
  return { name, index };
}

export interface ChatsResult {
  account: string;
  indexedAt: string;
  chats: ChatView[];
  /** False when more chats exist beyond `limit`. */
  complete: boolean;
}

export async function listChats(
  context: WhatsAppContext,
  request: { account?: string | undefined; limit?: unknown; kind?: string | undefined },
): Promise<ChatsResult> {
  // How many chats, never which (S4): see `recordWhatsApp`.
  return recordWhatsApp(
    context,
    request.account,
    'whatsapp.chats',
    'read',
    () => chatsOf(context, request),
    (result) => ({ chats: result.chats.length }),
  );
}

async function chatsOf(
  context: WhatsAppContext,
  request: { account?: string | undefined; limit?: unknown; kind?: string | undefined },
): Promise<ChatsResult> {
  const limit = wholeNumber(request.limit ?? 50, { name: 'limit', min: 1, max: 500 }) as number;
  const kinds = kindsOf(request.kind);
  const { name, index } = await openIndex(context, request.account);
  try {
    const rows = index.chats({ limit: limit + 1, kinds });
    const present = new Presenter(name);
    return {
      account: name,
      indexedAt: index.stats().indexedAt,
      chats: rows.slice(0, limit).map((chat) => present.chat(chat)),
      complete: rows.length <= limit,
    };
  } finally {
    index.close();
  }
}

export interface ReadResult {
  account: string;
  indexedAt: string;
  chat: ChatView;
  /** Newest first. */
  messages: MessageView[];
  complete: boolean;
  /** Pass as `before` to read the next, older page. */
  next?: string | undefined;
}

export async function readChat(
  context: WhatsAppContext,
  request: { account?: string | undefined; chat: string; limit?: unknown; before?: string | undefined },
): Promise<ReadResult> {
  // One chat and how many of its messages, never which chat (S4).
  return recordWhatsApp(
    context,
    request.account,
    'whatsapp.read',
    'read',
    () => chatOf(context, request),
    (result) => ({ chats: 1, messages: result.messages.length }),
  );
}

async function chatOf(
  context: WhatsAppContext,
  request: { account?: string | undefined; chat: string; limit?: unknown; before?: string | undefined },
): Promise<ReadResult> {
  const limit = wholeNumber(request.limit ?? 50, { name: 'limit', min: 1, max: 200 }) as number;
  const chatId = chatRefOf(request.chat).id;
  const { name, index } = await openIndex(context, request.account);
  try {
    const chat = index.chat(chatId);
    if (!chat) throw noSuchChat(chatId, name);
    let before: ReturnType<WhatsAppIndex['message']> | undefined;
    if (request.before !== undefined) {
      before = index.message(request.before);
      if (!before || before.chatId !== chatId) {
        throw new CommsError('USAGE', `"${request.before}" is not a message in this chat`, {
          hint: 'Pass the `next` value an earlier read returned.',
        });
      }
    }
    const rows = index.history(chatId, { limit: limit + 1, before: before ?? undefined });
    const present = new Presenter(name);
    const page = rows.slice(0, limit);
    const complete = rows.length <= limit;
    return {
      account: name,
      indexedAt: index.stats().indexedAt,
      chat: present.chat(chat),
      messages: page.map((message) => present.message(message)),
      complete,
      ...(complete ? {} : { next: page.at(-1)?.id }),
    };
  } finally {
    index.close();
  }
}

export interface SearchHit {
  chat: { id: string; kind: ChatKind; name: ChatView['name'] };
  message: MessageView;
}

export interface SearchResult {
  account: string;
  indexedAt: string;
  /** The words searched for, as they were matched: each a word, never search syntax. */
  words: string[];
  results: SearchHit[];
  complete: boolean;
}

/** The words of a query. Anything that is not a letter or a digit only separates them, so nothing typed is syntax. */
export function wordsOf(query: string): string[] {
  return query
    .normalize('NFKC')
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => word.length > 0)
    .slice(0, 16);
}

export async function searchMessages(
  context: WhatsAppContext,
  request: {
    account?: string | undefined;
    query: string;
    chat?: string | undefined;
    sender?: string | undefined;
    kind?: string | undefined;
    limit?: unknown;
  },
): Promise<SearchResult> {
  // How many messages in how many chats — and not the words searched for, which may be a name or a number (S4).
  return recordWhatsApp(
    context,
    request.account,
    'whatsapp.search',
    'read',
    () => searchOf(context, request),
    (result) => ({ chats: new Set(result.results.map((hit) => hit.chat.id)).size, messages: result.results.length }),
  );
}

async function searchOf(
  context: WhatsAppContext,
  request: {
    account?: string | undefined;
    query: string;
    chat?: string | undefined;
    sender?: string | undefined;
    kind?: string | undefined;
    limit?: unknown;
  },
): Promise<SearchResult> {
  const limit = wholeNumber(request.limit ?? 20, { name: 'limit', min: 1, max: 100 }) as number;
  const words = wordsOf(request.query);
  if (words.length === 0) {
    throw new CommsError('USAGE', 'search for at least one word', {
      hint: 'Words match the text, a caption or file name, the sender’s name and the chat’s name.',
    });
  }
  const chatId = request.chat === undefined ? undefined : chatRefOf(request.chat).id;
  // Naming a chat is asking for it, whatever its kind; otherwise the default kinds, or the one asked for.
  const kinds = chatId !== undefined && request.kind === undefined ? undefined : kindsOf(request.kind);
  const { name, index } = await openIndex(context, request.account);
  try {
    const rows = index.search(words, {
      limit: limit + 1,
      chatId,
      sender: request.sender?.trim() || undefined,
      kinds,
    });
    const present = new Presenter(name);
    const chats = new Map<string, SearchHit['chat']>();
    const results = rows.slice(0, limit).map((message) => {
      let chat = chats.get(message.chatId);
      if (!chat) {
        const view = present.chat({
          id: message.chatId,
          kind: message.chatKind,
          name: message.chatName,
          lastMessageAt: null,
          messages: 0,
        });
        chat = { id: view.id, kind: view.kind, name: view.name };
        chats.set(message.chatId, chat);
      }
      return { chat, message: present.message(message) };
    });
    return {
      account: name,
      indexedAt: index.stats().indexedAt,
      words,
      results,
      complete: rows.length <= limit,
    };
  } finally {
    index.close();
  }
}
