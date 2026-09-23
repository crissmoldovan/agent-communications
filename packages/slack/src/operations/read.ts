import { newBoundary, wrapUntrusted } from '@agentcomms/core';
import { callSlack, paginate, type SlackCall } from '../api/call.ts';
import { senderField } from '../text/field.ts';
import { type ReadMessage, readMessage } from '../text/message.ts';
import { type Channel, channelOf, NameBook, type Person, personOf } from './people.ts';

/**
 * Reading a workspace: what channels there are, what was said, and what a thread contains.
 *
 * Two rules run through all of it. Every read is **bounded and says so** — a short list is either the whole
 * answer or a truncated one, and a caller is never left to infer which, because "nothing came back" and "nothing
 * came back from the part I looked at" are different sentences and only one of them is usually true. And every
 * message is resolved through one {@link NameBook} per read, so the ids in the text and the authors beside it
 * agree with each other and each name is fetched once.
 */

type Raw = Record<string, unknown>;

function list(value: unknown): Raw[] {
  return Array.isArray(value) ? (value.filter((v) => typeof v === 'object' && v !== null) as Raw[]) : [];
}

export interface ChannelsResult {
  readonly channels: readonly Channel[];
  /** False when a page remained: the list is the top of the answer, not the whole of it. */
  readonly complete: boolean;
  readonly cursor?: string | undefined;
}

export interface ChannelsOptions {
  /** Which kinds to include. Defaults to everything this token can see. */
  types?: readonly ('public_channel' | 'private_channel' | 'mpim' | 'im')[] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  /** Include channels this account is not in. Off by default: the useful list is the one you are part of. */
  all?: boolean | undefined;
}

export async function listChannels(call: SlackCall, options: ChannelsOptions = {}): Promise<ChannelsResult> {
  const types = (options.types ?? ['public_channel', 'private_channel', 'mpim', 'im']).join(',');
  const page = await paginate(
    call,
    'conversations.list',
    { types, exclude_archived: true },
    (response) => list(response.channels).map(channelOf),
    { limit: options.limit ?? 100, cursor: options.cursor },
  );
  const channels = options.all ? page.items : page.items.filter((channel) => channel.isMember || channel.isIm);
  return { channels, complete: page.complete, ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/** One message with its author resolved, ready to hand to a model or print. */
export interface ReadRow {
  readonly message: ReadMessage;
  readonly author?: Person | undefined;
  /**
   * The body inside the untrusted envelope, with this read's boundary.
   *
   * Built here rather than by each caller, because the Gmail audit's worst cluster was three read paths that
   * returned sender-controlled strings *beside* a carefully enveloped body. A row that carries its own enveloped
   * form cannot be handed to a model half-wrapped.
   */
  readonly enveloped: string;
}

export interface HistoryResult {
  readonly channel: Channel | undefined;
  readonly rows: readonly ReadRow[];
  readonly complete: boolean;
  readonly cursor?: string | undefined;
  /** The window actually read, so a report can state it rather than implying the whole channel. */
  readonly window: { oldest?: string | undefined; latest?: string | undefined; limit: number };
}

export interface HistoryOptions {
  /** This workspace's own team id, so an author from another one is reported as external. */
  ourTeamId?: string | undefined;
  limit?: number | undefined;
  oldest?: string | undefined;
  latest?: string | undefined;
  cursor?: string | undefined;
  /** Resolve author names. On by default; a caller reading thousands of rows may turn it off. */
  resolveNames?: boolean | undefined;
}

async function rowsFrom(
  call: SlackCall,
  raws: Raw[],
  book: NameBook,
  options: { resolveNames: boolean; accountName: string; ourTeamId?: string | undefined },
): Promise<ReadRow[]> {
  if (options.resolveNames) {
    // Two passes: learn every id this page mentions or was written by, then render with a book that knows them.
    const userIds = new Set<string>();
    const channelIds = new Set<string>();
    for (const raw of raws) {
      const author = typeof raw.user === 'string' ? raw.user : undefined;
      if (author) userIds.add(author);
      for (const reference of readMessage(raw).references) {
        if (reference.kind === 'user') userIds.add(reference.id);
        if (reference.kind === 'channel') channelIds.add(reference.id);
      }
    }
    await book.learnPeople(call, userIds);
    await book.learnChannels(call, channelIds);
  }

  const boundary = newBoundary();
  return raws.map((raw) => {
    const message = readMessage(raw, book.names(), options.ourTeamId);
    const author = message.userId ? book.person(message.userId) : undefined;
    return {
      message,
      author,
      enveloped: wrapUntrusted(message.body, { field: 'body', inbox: options.accountName, id: message.ts }, boundary),
    };
  });
}

/**
 * A channel's recent messages, newest first, within a stated window.
 *
 * `accountName` goes on the envelope so a model reading two workspaces at once can tell which is which — the same
 * reason the Gmail envelope carries the mailbox.
 */
export async function readChannel(
  call: SlackCall,
  accountName: string,
  channelId: string,
  options: HistoryOptions = {},
): Promise<HistoryResult> {
  const limit = options.limit ?? 50;
  const book = new NameBook();
  const info = await callSlack(call, 'conversations.info', { channel: channelId }).catch(() => null);
  const channel = info ? channelOf((info.channel as Raw | undefined) ?? {}) : undefined;
  if (channel) book.addChannel(channel);

  const page = await paginate(
    call,
    'conversations.history',
    { channel: channelId, oldest: options.oldest, latest: options.latest, inclusive: true },
    (response) => list(response.messages),
    { limit, cursor: options.cursor },
  );

  const rows = await rowsFrom(call, page.items, book, {
    resolveNames: options.resolveNames ?? true,
    accountName,
    ourTeamId: options.ourTeamId,
  });
  return {
    channel,
    rows,
    complete: page.complete,
    ...(page.cursor ? { cursor: page.cursor } : {}),
    window: { oldest: options.oldest, latest: options.latest, limit },
  };
}

export interface ThreadResult {
  readonly channelId: string;
  readonly parent?: ReadRow | undefined;
  readonly replies: readonly ReadRow[];
  readonly complete: boolean;
  /** Where to resume when the bound stopped the read. Without it a long thread could not be finished. */
  readonly cursor?: string | undefined;
}

/**
 * A thread, parent first.
 *
 * Slack returns the parent as the first element of `conversations.replies`, which is easy to miss and easy to
 * double-count — a caller that treats the whole array as replies reports one more reply than there are, every time.
 */
export async function readThread(
  call: SlackCall,
  accountName: string,
  channelId: string,
  threadTs: string,
  options: {
    limit?: number | undefined;
    resolveNames?: boolean | undefined;
    cursor?: string | undefined;
    ourTeamId?: string | undefined;
  } = {},
): Promise<ThreadResult> {
  const book = new NameBook();
  const page = await paginate(
    call,
    'conversations.replies',
    { channel: channelId, ts: threadTs },
    (response) => list(response.messages),
    { limit: options.limit ?? 100, cursor: options.cursor },
  );
  const rows = await rowsFrom(call, page.items, book, {
    resolveNames: options.resolveNames ?? true,
    accountName,
    ourTeamId: options.ourTeamId,
  });
  const [parent, ...replies] = rows;
  return { channelId, parent, replies, complete: page.complete, ...(page.cursor ? { cursor: page.cursor } : {}) };
}

export interface SearchHit extends ReadRow {
  readonly channelId?: string | undefined;
  readonly channelName?: string | undefined;
  readonly permalink?: string | undefined;
}

export interface SearchResult {
  readonly query: string;
  readonly hits: readonly SearchHit[];
  readonly total?: number | undefined;
  readonly complete: boolean;
  /** The next page to ask for when more remain. Slack's search pages by number, not by cursor. */
  readonly nextPage?: number | undefined;
}

/**
 * Slack's own search, which is a user-token method with no bot equivalent.
 *
 * The query goes to Slack verbatim — it is the person's search, in Slack's syntax, and rewriting it would mean
 * reporting results for a question nobody asked. What comes *back* is sender-controlled and goes through the same
 * funnel as everything else.
 */
export async function searchMessages(
  call: SlackCall,
  accountName: string,
  query: string,
  options: { limit?: number | undefined; page?: number | undefined } = {},
): Promise<SearchResult> {
  const limit = Math.min(options.limit ?? 20, 100);
  const response = await callSlack(call, 'search.messages', {
    query,
    count: limit,
    page: options.page ?? 1,
  });
  const matches = (response.messages as Raw | undefined) ?? {};
  const raws = list(matches.matches);
  const book = new NameBook();
  const rows = await rowsFrom(call, raws, book, { resolveNames: true, accountName });

  const hits: SearchHit[] = rows.map((row, index) => {
    const raw = raws[index] ?? {};
    const channel = (raw.channel as Raw | undefined) ?? {};
    return {
      ...row,
      channelId: typeof channel.id === 'string' ? channel.id : undefined,
      channelName: senderField(typeof channel.name === 'string' ? channel.name : undefined)?.text,
      permalink: typeof raw.permalink === 'string' ? raw.permalink : undefined,
    };
  });

  const total = typeof matches.total === 'number' ? matches.total : undefined;
  const paging = (matches.paging as Raw | undefined) ?? {};
  const pages = typeof paging.pages === 'number' ? paging.pages : 1;
  const current = typeof paging.page === 'number' ? paging.page : 1;
  const complete = current >= pages;
  return { query, hits, total, complete, ...(complete ? {} : { nextPage: current + 1 }) };
}

export interface PeopleResult {
  readonly people: readonly Person[];
  readonly complete: boolean;
  readonly cursor?: string | undefined;
}

/** The workspace's members, bounded like everything else. */
export async function listPeople(
  call: SlackCall,
  options: { limit?: number | undefined; cursor?: string | undefined } = {},
): Promise<PeopleResult> {
  const page = await paginate(call, 'users.list', {}, (response) => list(response.members).map(personOf), {
    limit: options.limit ?? 200,
    cursor: options.cursor,
  });
  return { people: page.items, complete: page.complete, ...(page.cursor ? { cursor: page.cursor } : {}) };
}

/** One file shared in the workspace. Every name and title is sender-controlled, like everything else here. */
export interface SharedFile {
  readonly id: string;
  readonly name?: string | undefined;
  readonly title?: string | undefined;
  readonly mimetype?: string | undefined;
  readonly size?: number | undefined;
  readonly userId?: string | undefined;
  readonly created?: number | undefined;
  /** Slack's own flag. A file anyone with the link can open is worth seeing as such. */
  readonly publicUrlShared?: boolean | undefined;
  /**
   * Where the bytes are.
   *
   * Carried, never fetched: downloading is S4's business and needs the jail core already has. A URL here is a
   * URL Slack gave us, and it is shown so a person can decide, not followed because it was in a message.
   */
  readonly urlPrivate?: string | undefined;
}

function fileOf(raw: Raw): SharedFile {
  const str_ = (value: unknown) => (typeof value === 'string' && value !== '' ? value : undefined);
  const num_ = (value: unknown) => (typeof value === 'number' ? value : undefined);
  return {
    id: str_(raw.id) ?? '',
    name: senderField(str_(raw.name))?.text,
    title: senderField(str_(raw.title))?.text,
    mimetype: str_(raw.mimetype),
    size: num_(raw.size),
    userId: str_(raw.user),
    created: num_(raw.created),
    ...(typeof raw.public_url_shared === 'boolean' ? { publicUrlShared: raw.public_url_shared } : {}),
    urlPrivate: str_(raw.url_private),
  };
}

export interface FilesResult {
  readonly files: readonly SharedFile[];
  readonly complete: boolean;
  readonly page?: number | undefined;
}

/** The files this account can see, newest first, bounded. */
export async function listFiles(
  call: SlackCall,
  options: {
    channel?: string | undefined;
    user?: string | undefined;
    limit?: number | undefined;
    page?: number | undefined;
  } = {},
): Promise<FilesResult> {
  const limit = Math.min(options.limit ?? 50, 200);
  const response = await callSlack(call, 'files.list', {
    channel: options.channel,
    user: options.user,
    count: limit,
    page: options.page ?? 1,
  });
  const paging = (response.paging as Raw | undefined) ?? {};
  const pages = typeof paging.pages === 'number' ? paging.pages : 1;
  const current = typeof paging.page === 'number' ? paging.page : 1;
  const complete = current >= pages;
  return {
    files: list(response.files).map(fileOf),
    complete,
    ...(complete ? {} : { page: current + 1 }),
  };
}

/** Everything Slack knows about one file. */
export async function fileInfo(call: SlackCall, fileId: string): Promise<SharedFile> {
  const response = await callSlack(call, 'files.info', { file: fileId });
  return fileOf((response.file as Raw | undefined) ?? {});
}
