import { type CliHandoffs, CommsError } from '@agentcomms/core';
import { type gmail_v1, gmail as gmailApi } from '@googleapis/gmail';
import { type people_v1, people as peopleApi } from '@googleapis/people';
import { OAuth2Client } from 'google-auth-library';
import type { GoogleEndpoints } from '../auth/endpoints.ts';
import type { TokenSource } from '../auth/session.ts';
import {
  type AttachmentAbout,
  DOWNLOAD_IDLE_MS,
  DOWNLOAD_PACE,
  type DownloadLimits,
  downloadAttachment,
} from './download.ts';
import { describeGoogleError, mapGoogleError } from './errors.ts';
import { createLimiter, type RetryMode, withRetry } from './retry.ts';

/**
 * Everything this package may ask Google to do. Operations depend on this interface, never on `@googleapis/*`, so
 * they can be tested against a fake and so the surface stays small enough to see at a glance.
 *
 * **There is still no send method here.** Sending goes through `withSendPermit`, which opens the door for exactly one
 * call and closes it again; every request this transport makes is checked against that permit, so a send reaching
 * Google without one is a runtime error rather than a review oversight.
 */
export interface GmailTransport {
  readonly alias: string;
  readonly inboxId: string;
  getProfile(): Promise<GmailProfile>;
  /**
   * One unfiltered page of the mailbox history. The event source owns filtering because Gmail accepts only one
   * singular label id, while several active rules may name different label sets.
   */
  listHistory(options: HistoryListOptions): Promise<GmailHistoryPage>;
  listLabels(): Promise<GmailLabel[]>;
  listSendAs(): Promise<SendAsAddress[]>;
  /** One message with its full part tree. `format=metadata` has no parts, so reading always uses `full`. */
  getMessage(messageId: string): Promise<RawMessage>;
  /** A whole thread in one call: cheaper than a get per message from three messages up. */
  getThread(threadId: string): Promise<RawThread>;
  /** One page of ids matching a query. Ids only: metadata is fetched for the rows actually shown. */
  listMessages(options: ListOptions): Promise<ListPage>;
  listThreads(options: ListOptions): Promise<ListPage>;
  /**
   * Headers, labels and the part tree without body bytes. `format=metadata` returns no parts at all, so a row that
   * reports attachments has to ask for `full` and drop the bodies with a partial response instead.
   */
  getMessageMetadata(messageId: string): Promise<RawMessage>;
  /**
   * The bytes of one attachment. The id is resolved fresh from the message: Gmail's can change between fetches.
   *
   * Bounded in time, by a limit on silence and one on the whole answer for the size given (`download.ts`), and
   * stopped by the caller's signal. What else the caller knows — the part, its size — makes both the error and the
   * limit more exact; without them the attachment is named by its message, and allowed what the largest could need.
   */
  getAttachment(messageId: string, attachmentId: string, about?: AttachmentAbout): Promise<Buffer>;
  /** People the user has saved, and people they have corresponded with. Needs the contacts permission. */
  searchContacts(query: string): Promise<ContactMatch[]>;
  /** The message exactly as it arrived, for an `.eml` export. */
  getRawMessage(messageId: string): Promise<Buffer>;
  /** Saves a draft. Creating one is not sending one, and no method here sends. */
  createDraft(raw: Buffer, threadId?: string | undefined): Promise<DraftHandle>;
  updateDraft(draftId: string, raw: Buffer, threadId?: string | undefined): Promise<DraftHandle>;
  getDraft(draftId: string): Promise<{ id: string; message?: RawMessage | undefined }>;
  listDrafts(limit: number): Promise<Array<{ id: string; message?: RawMessage | undefined }>>;
  deleteDraft(draftId: string): Promise<void>;
  /**
   * Sends a draft that already exists. **The only method here that makes mail leave**, and the only one that may.
   *
   * Two things guard it, because one of them is only a convention. The convention: a test asserts this method is
   * called from exactly one file, `operations/send.ts`, after an approval. The mechanism: the real transport opens a
   * one-shot permit for this draft id and the auth client refuses any request to a path ending in `/send` without
   * one — so a second send in the same call, a send of another draft, or a `messages.send` added anywhere in this
   * package fails at the request rather than at review time.
   *
   * Never retried, at any layer: a retried send may deliver the same mail twice, and nothing here can tell.
   *
   * `id` is absent when Gmail accepted the send without naming the message (`providerId`): never an empty string,
   * which every later reader would take for an id (design 2026-10-05 §D8).
   */
  sendDraft(draftId: string): Promise<{ id: string | undefined; threadId: string | undefined }>;
  /** Adds and removes labels on many messages at once. Changing a label is not sending anything. */
  modifyMessages(
    messageIds: readonly string[],
    addLabelIds: readonly string[],
    removeLabelIds: readonly string[],
  ): Promise<void>;
  trashMessage(messageId: string): Promise<void>;
  untrashMessage(messageId: string): Promise<void>;
  createLabel(name: string): Promise<{ id: string; name: string }>;
}

export interface DraftHandle {
  draftId: string;
  /** Gmail gives the draft's message a new id on every save, which is how an edit is detected later. */
  messageId: string;
  threadId: string | undefined;
}

export interface ContactMatch {
  name: string;
  email: string;
  /** Where the match came from, which is also how much it is worth trusting. */
  source: 'contacts' | 'other-contacts';
}

export interface ListOptions {
  query: string;
  pageToken?: string | undefined;
  maxResults?: number | undefined;
  includeSpamTrash?: boolean | undefined;
}

export interface ListPage {
  /** Message or thread ids, newest first, as Gmail returns them. */
  ids: Array<{ id: string; threadId?: string | undefined }>;
  nextPageToken: string | undefined;
  /** Gmail's own estimate. It is a lower bound on a capped page, and is reported as one. */
  resultSizeEstimate: number | undefined;
}

export interface RawThread {
  id?: string | null;
  historyId?: string | null;
  messages?: RawMessage[] | null;
}

/** The parts of Gmail's message resource this package reads. */
export interface RawMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: gmail_v1.Schema$MessagePart | null;
}

export interface GmailProfile {
  emailAddress: string;
  messagesTotal: number;
  threadsTotal: number;
  historyId: string;
}

/** The only cursor inputs Gmail's history endpoint needs for a B1 mailbox scan. */
export interface HistoryListOptions {
  readonly historyId: string;
  readonly pageToken?: string | undefined;
}

/** The message reference Gmail includes in a history-specific change. It deliberately has no body fields. */
export interface GmailHistoryMessage {
  readonly id: string;
  readonly threadId?: string | undefined;
}

export interface GmailHistoryLabelChange {
  readonly message: GmailHistoryMessage;
  readonly labelIds: readonly string[];
}

/** A history record reduced to the specific change arrays; the generic `messages` array is intentionally excluded. */
export interface GmailHistoryRecord {
  readonly id: string;
  readonly messagesAdded: readonly { readonly message: GmailHistoryMessage }[];
  readonly labelsAdded: readonly GmailHistoryLabelChange[];
  readonly labelsRemoved: readonly GmailHistoryLabelChange[];
}

/** One page and Gmail's cursor after that page. The final page's `historyId` becomes the durable cursor. */
export interface GmailHistoryPage {
  readonly history: readonly GmailHistoryRecord[];
  readonly historyId: string;
  readonly nextPageToken: string | undefined;
}

export interface GmailLabel {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal?: number | undefined;
  messagesUnread?: number | undefined;
}

export interface SendAsAddress {
  sendAsEmail: string;
  displayName: string;
  isDefault: boolean;
  isPrimary: boolean;
  treatAsAlias: boolean;
  verificationStatus?: string | undefined;
  signature?: string | undefined;
}

export interface TransportOptions {
  tokens: TokenSource;
  endpoints: GoogleEndpoints;
  /** The commands an error's fix names (`GmailContext.handoffs`); without them the fix is said in words. */
  handoffs?: CliHandoffs | undefined;
  /** Concurrency cap per inbox: Gmail's per-user quota, not the network, is the limit worth respecting. */
  concurrency?: number;
  retry?: { attempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };
  /** How long an attachment download may go silent, and how slowly it may arrive. Tests set it; production does not. */
  download?: Partial<DownloadLimits> | undefined;
}

/**
 * A provider's id as this package keeps it: a non-empty string, or absent (design 2026-10-05 §D8). `undefined`, `null`,
 * `""` and blank are all absence — never an empty string a completion, an audit line or a read-back would take for an
 * id.
 */
export function providerId(value: string | null | undefined): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}

/** Builds the list parameters, omitting the page token entirely when there is none. */
function listParameters(options: ListOptions): {
  userId: string;
  q: string;
  maxResults: number;
  includeSpamTrash: boolean;
  pageToken?: string;
} {
  const parameters = {
    userId: 'me',
    q: options.query,
    maxResults: options.maxResults ?? 25,
    includeSpamTrash: options.includeSpamTrash ?? false,
  };
  return options.pageToken === undefined ? parameters : { ...parameters, pageToken: options.pageToken };
}

/** The live transport: `@googleapis/gmail` and `@googleapis/people`, with our own auth, retries and error mapping. */
/**
 * The URL path of every Gmail endpoint that makes mail leave: `drafts/{id}/send`, `messages/send`. Matching the path
 * rather than the method name means a future call, a hand-built request, or a redirect to one is caught too.
 */
const SEND_PATH = /\/send$/;

/**
 * Refuses any request to a send endpoint unless a permit for that draft is open.
 *
 * This wraps the auth client's own `request`, which is where every Gmail call in this package ends up —
 * `@googleapis/gmail` issues its requests through it. So this is the narrowest place where every send can be seen,
 * and the only one that cannot be bypassed by adding another method somewhere else in the package.
 */
function guardSendRequests(client: OAuth2Client, permit: { draftId: string | null }): void {
  const inner = client.request.bind(client) as (options: unknown, callback?: unknown) => unknown;
  const guarded = (options: { url?: string | undefined; data?: unknown }, callback?: unknown): unknown => {
    const url = String(options?.url ?? '');
    let path = url;
    try {
      path = new URL(url).pathname;
    } catch {
      // A relative or malformed URL: check the whole string rather than assuming it is harmless — but drop the
      // query first, or `/drafts/send?alt=json` does not end in `/send` and the guard waves it through.
      path = url.split(/[?#]/)[0] ?? url;
    }
    // A batch endpoint carries other requests inside its body, which this cannot see. Nothing here batches, and
    // the guarantee is that a send cannot reach Google any other way — so a batch is refused outright rather than
    // trusted to contain nothing.
    if (/\/batch(\/|$)/.test(path)) {
      throw new CommsError('SEND_REFUSED', 'this package does not batch requests, and a batch could hide a send', {
        hint: 'This is a bug — please report it.',
      });
    }
    if (SEND_PATH.test(path.replace(/\/$/, ''))) {
      if (!permit.draftId) {
        throw new CommsError('SEND_REFUSED', 'a send was attempted without an approval', {
          hint: 'Mail leaves only through `send execute`, after an approval. This is a bug — please report it.',
        });
      }
      // `drafts/send` names the draft in the body, `messages/{id}/send` in the path; check wherever it is.
      const body = typeof options.data === 'string' ? options.data : JSON.stringify(options.data ?? {});
      if (!path.includes(permit.draftId) && !body.includes(permit.draftId)) {
        throw new CommsError('SEND_REFUSED', 'a send was attempted for a different draft than the approved one', {
          hint: 'The approval names one draft. Prepare the send again for the draft you mean.',
        });
      }
      // One permit, one request: a second send inside the same permit finds the door shut.
      permit.draftId = null;
    }
    return inner(options, callback);
  };
  client.request = guarded as OAuth2Client['request'];
}

export class GoogleGmailTransport implements GmailTransport {
  readonly alias: string;
  readonly inboxId: string;
  readonly #tokens: TokenSource;
  readonly #endpoints: GoogleEndpoints;
  readonly #limit: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #retry: TransportOptions['retry'];
  readonly #download: DownloadLimits;
  readonly #handoffs: CliHandoffs | undefined;
  #gmail: gmail_v1.Gmail | null = null;
  #people: people_v1.People | null = null;
  #oauth: OAuth2Client | null = null;
  /** Open only inside `withSendPermit`, and only for the draft named there. */
  readonly #sendPermit: { draftId: string | null } = { draftId: null };

  constructor(options: TransportOptions) {
    this.#tokens = options.tokens;
    this.alias = options.tokens.alias;
    this.inboxId = options.tokens.inbox.id;
    this.#endpoints = options.endpoints;
    this.#handoffs = options.handoffs;
    this.#limit = createLimiter(options.concurrency ?? 5);
    this.#retry = options.retry;
    this.#download = {
      idleMs: options.download?.idleMs ?? DOWNLOAD_IDLE_MS,
      pace: options.download?.pace ?? DOWNLOAD_PACE,
    };
  }

  /**
   * One OAuth2Client per transport, fed by our `TokenSource` through `refreshHandler`, so the library never holds the
   * refresh token. `forceRefreshOnFailure` is deliberately left off: it makes the library refresh and silently repeat
   * the request on any 401 *or 403* — which would hide a disabled API or a missing scope behind a wasted token
   * refresh, and would repeat requests outside the retry policy. Stale access tokens are handled in `call()` instead.
   */
  #auth(): OAuth2Client {
    if (this.#oauth) return this.#oauth;
    const client = new OAuth2Client();
    guardSendRequests(client, this.#sendPermit);
    client.refreshHandler = async () => {
      const token = await this.#tokens.accessToken();
      return { access_token: token.token, expiry_date: token.expiresAt, scope: token.scopes.join(' ') };
    };
    this.#oauth = client;
    return client;
  }

  /** Drops the access token held here and inside the library, so the next call fetches a fresh one. */
  #forgetAccessToken(): void {
    this.#tokens.invalidate();
    this.#oauth?.setCredentials({});
  }

  gmail(): gmail_v1.Gmail {
    this.#gmail ??= gmailApi({ version: 'v1', auth: this.#auth(), rootUrl: this.#endpoints.gmailRoot, retry: false });
    return this.#gmail;
  }

  people(): people_v1.People {
    this.#people ??= peopleApi({
      version: 'v1',
      auth: this.#auth(),
      rootUrl: this.#endpoints.peopleRoot,
      retry: false,
    });
    return this.#people;
  }

  /** Runs one Google call under the inbox's concurrency cap and retry policy, mapping any failure to a CommsError. */
  async call<T>(
    operation: string,
    fn: () => Promise<T>,
    options: { mode?: RetryMode; api?: 'gmail' | 'people' } = {},
  ): Promise<T> {
    const mode = options.mode ?? 'safe';
    return this.#limit(async () => {
      try {
        try {
          return await withRetry(fn, { mode, ...this.#retry });
        } catch (error) {
          // A token revoked or expired mid-run reads as 401. Fetch a fresh one and try once more — except for a send,
          // which must never be repeated: the first attempt may already have delivered the mail.
          if (mode === 'never' || describeGoogleError(error).status !== 401) throw error;
          this.#forgetAccessToken();
          return await withRetry(fn, { mode, ...this.#retry });
        }
      } catch (error) {
        throw mapGoogleError(error, {
          alias: this.alias,
          operation,
          api: options.api ?? 'gmail',
          handoffs: this.#handoffs,
        });
      }
    });
  }

  async getProfile(): Promise<GmailProfile> {
    const { data } = await this.call('read the profile', () => this.gmail().users.getProfile({ userId: 'me' }));
    return {
      emailAddress: data.emailAddress ?? '',
      messagesTotal: data.messagesTotal ?? 0,
      threadsTotal: data.threadsTotal ?? 0,
      historyId: data.historyId ?? '',
    };
  }

  async listHistory(options: HistoryListOptions): Promise<GmailHistoryPage> {
    const { data } = await this.call('read mailbox history', () =>
      this.gmail().users.history.list({
        userId: 'me',
        startHistoryId: options.historyId,
        ...(options.pageToken === undefined ? {} : { pageToken: options.pageToken }),
      }),
    );
    // A cursor or message id Gmail did not send is never invented: an empty cursor committed later would break every
    // scan after it, and an empty message id would name no message. Such a page is refused as bad provider data.
    const malformed = (what: string) =>
      new CommsError('BAD_DATA', `Gmail returned a mailbox history page without ${what}`, {
        hint: 'Try again later; if it keeps happening, the mailbox history cannot be read safely.',
      });
    if (!data.historyId) throw malformed('its history id');
    const present = (value: string | null | undefined, what: string): string => {
      if (!value) throw malformed(what);
      return value;
    };
    const message = (value: gmail_v1.Schema$Message | null | undefined): GmailHistoryMessage => ({
      id: present(value?.id, 'a message id'),
      ...(value?.threadId ? { threadId: value.threadId } : {}),
    });
    return {
      history: (data.history ?? []).map((record) => ({
        id: present(record.id, 'a history record id'),
        messagesAdded: (record.messagesAdded ?? []).map((change) => ({ message: message(change.message) })),
        labelsAdded: (record.labelsAdded ?? []).map((change) => ({
          message: message(change.message),
          labelIds: [...(change.labelIds ?? [])],
        })),
        labelsRemoved: (record.labelsRemoved ?? []).map((change) => ({
          message: message(change.message),
          labelIds: [...(change.labelIds ?? [])],
        })),
      })),
      historyId: data.historyId,
      nextPageToken: data.nextPageToken ?? undefined,
    };
  }

  async listLabels(): Promise<GmailLabel[]> {
    const { data } = await this.call('list labels', () => this.gmail().users.labels.list({ userId: 'me' }));
    return (data.labels ?? []).map((label) => ({
      id: label.id ?? '',
      name: label.name ?? '',
      type: label.type === 'system' ? 'system' : 'user',
      messagesTotal: label.messagesTotal ?? undefined,
      messagesUnread: label.messagesUnread ?? undefined,
    }));
  }

  async getMessage(messageId: string): Promise<RawMessage> {
    const { data } = await this.call('read a message', () =>
      this.gmail().users.messages.get({ userId: 'me', id: messageId, format: 'full' }),
    );
    return data;
  }

  async getThread(threadId: string): Promise<RawThread> {
    const { data } = await this.call('read a thread', () =>
      this.gmail().users.threads.get({ userId: 'me', id: threadId, format: 'full' }),
    );
    return data;
  }

  async listMessages(options: ListOptions): Promise<ListPage> {
    const { data } = await this.call('search messages', () =>
      this.gmail().users.messages.list(listParameters(options)),
    );
    return {
      ids: (data.messages ?? []).map((message) => ({
        id: message.id ?? '',
        threadId: message.threadId ?? undefined,
      })),
      nextPageToken: data.nextPageToken ?? undefined,
      resultSizeEstimate: data.resultSizeEstimate ?? undefined,
    };
  }

  async listThreads(options: ListOptions): Promise<ListPage> {
    const { data } = await this.call('search threads', () => this.gmail().users.threads.list(listParameters(options)));
    return {
      ids: (data.threads ?? []).map((thread) => ({ id: thread.id ?? '', threadId: thread.id ?? undefined })),
      nextPageToken: data.nextPageToken ?? undefined,
      resultSizeEstimate: data.resultSizeEstimate ?? undefined,
    };
  }

  async getMessageMetadata(messageId: string): Promise<RawMessage> {
    const { data } = await this.call('read message metadata', () =>
      this.gmail().users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full',
        // Everything a search row needs, and none of the body bytes.
        fields:
          'id,threadId,labelIds,snippet,internalDate,payload(partId,mimeType,filename,headers,body/size,body/attachmentId,parts(partId,mimeType,filename,headers,body/size,body/attachmentId,parts(partId,mimeType,filename,headers,body/size,body/attachmentId)))',
      }),
    );
    return data;
  }

  async getAttachment(messageId: string, attachmentId: string, about: AttachmentAbout = {}): Promise<Buffer> {
    return this.call('download an attachment', async () => {
      /*
       * The access token first, before either limit starts. They measure Gmail, and a token being refreshed — from
       * the secret store, through a keychain prompt a person is still answering — is not Gmail going silent. With a
       * fresh one held here, the library's own refresh hands it straight back.
       */
      await this.#tokens.accessToken();
      return downloadAttachment(
        (signal) =>
          this.gmail().users.messages.attachments.get(
            { userId: 'me', messageId, id: attachmentId },
            /*
             * The answer as a stream, so that `downloadAttachment` can hear each piece arrive, and every status as an
             * answer rather than an error, so that a refusal's body is read under the same limits as the file's. Each
             * attempt the retry policy makes gets limits of its own; a limit reached is not one it repeats.
             */
            { responseType: 'stream', signal, validateStatus: () => true },
          ),
        { ...about, messageId },
        this.#download,
      );
    });
  }

  /**
   * The People API needs a warm-up call before it returns anything for a query, which is why the first search of a
   * session can come back empty. Both collections are asked; the caller merges them with what it saw in headers.
   */
  async searchContacts(query: string): Promise<ContactMatch[]> {
    const fields = 'names,emailAddresses';
    const [saved, others] = await Promise.all([
      this.call(
        'search contacts',
        () => this.people().people.searchContacts({ query, readMask: fields, pageSize: 20 }),
        { api: 'people' },
      ),
      this.call(
        'search other contacts',
        () => this.people().otherContacts.search({ query, readMask: fields, pageSize: 20 }),
        { api: 'people' },
      ),
    ]);

    const matches: ContactMatch[] = [];
    const collect = (results: unknown, source: ContactMatch['source']): void => {
      for (const entry of (results as { results?: Array<{ person?: unknown }> } | undefined)?.results ?? []) {
        const person = entry.person as
          | { names?: Array<{ displayName?: string | null }>; emailAddresses?: Array<{ value?: string | null }> }
          | undefined;
        const name = person?.names?.[0]?.displayName ?? '';
        for (const address of person?.emailAddresses ?? []) {
          if (address.value) matches.push({ name, email: address.value.toLowerCase(), source });
        }
      }
    };
    collect(saved.data, 'contacts');
    collect(others.data, 'other-contacts');
    return matches;
  }

  async getRawMessage(messageId: string): Promise<Buffer> {
    const { data } = await this.call('export a message', () =>
      this.gmail().users.messages.get({ userId: 'me', id: messageId, format: 'raw' }),
    );
    return Buffer.from(data.raw ?? '', 'base64url');
  }

  async createDraft(raw: Buffer, threadId?: string | undefined): Promise<DraftHandle> {
    const { data } = await this.call(
      'save a draft',
      () =>
        this.gmail().users.drafts.create({
          userId: 'me',
          requestBody: { message: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) } },
        }),
      // A connection dropped *after* Gmail accepted the POST looks exactly like one dropped before it, so a retry
      // on no-status leaves two drafts from one call. Rate-limit retries are still fine: those carry a status and
      // mean the request was refused rather than acted on.
      { mode: 'rate-limit-only' },
    );
    return {
      draftId: data.id ?? '',
      messageId: data.message?.id ?? '',
      threadId: data.message?.threadId ?? undefined,
    };
  }

  async updateDraft(draftId: string, raw: Buffer, threadId?: string | undefined): Promise<DraftHandle> {
    const { data } = await this.call('update a draft', () =>
      this.gmail().users.drafts.update({
        userId: 'me',
        id: draftId,
        requestBody: { message: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) } },
      }),
    );
    return {
      draftId: data.id ?? draftId,
      messageId: data.message?.id ?? '',
      threadId: data.message?.threadId ?? undefined,
    };
  }

  async getDraft(draftId: string): Promise<{ id: string; message?: RawMessage | undefined }> {
    const { data } = await this.call('read a draft', () =>
      this.gmail().users.drafts.get({ userId: 'me', id: draftId, format: 'full' }),
    );
    return { id: data.id ?? draftId, message: data.message ?? undefined };
  }

  async listDrafts(limit: number): Promise<Array<{ id: string; message?: RawMessage | undefined }>> {
    const { data } = await this.call('list drafts', () =>
      this.gmail().users.drafts.list({ userId: 'me', maxResults: limit }),
    );
    const drafts = data.drafts ?? [];
    // The list gives ids only; each draft's headers come from its own read.
    return Promise.all(
      drafts.map(async (draft) => (draft.id ? this.getDraft(draft.id) : { id: '', message: undefined })),
    );
  }

  async deleteDraft(draftId: string): Promise<void> {
    await this.call('delete a draft', () => this.gmail().users.drafts.delete({ userId: 'me', id: draftId }), {
      mode: 'rate-limit-only',
    });
  }

  async sendDraft(draftId: string): Promise<{ id: string | undefined; threadId: string | undefined }> {
    this.#auth();
    if (this.#sendPermit.draftId) {
      throw new CommsError('SEND_REFUSED', 'a send is already in progress on this transport');
    }
    this.#sendPermit.draftId = draftId;
    try {
      const { data } = await this.call(
        'send the draft',
        () => this.gmail().users.drafts.send({ userId: 'me', requestBody: { id: draftId } }),
        // `never`: not one retry, at any layer. The first attempt may already have delivered the mail.
        { mode: 'never' },
      );
      // Accepted without an id is reported as exactly that, never as the empty string (§D8).
      return { id: providerId(data.id), threadId: data.threadId ?? undefined };
    } finally {
      this.#sendPermit.draftId = null;
    }
  }

  async modifyMessages(
    messageIds: readonly string[],
    addLabelIds: readonly string[],
    removeLabelIds: readonly string[],
  ): Promise<void> {
    // Gmail's batch endpoint takes up to a thousand ids per call and costs far less than one call each.
    for (let index = 0; index < messageIds.length; index += 1000) {
      const chunk = messageIds.slice(index, index + 1000);
      await this.call('change labels', () =>
        this.gmail().users.messages.batchModify({
          userId: 'me',
          requestBody: { ids: [...chunk], addLabelIds: [...addLabelIds], removeLabelIds: [...removeLabelIds] },
        }),
      );
    }
  }

  async trashMessage(messageId: string): Promise<void> {
    await this.call('move a message to the bin', () =>
      this.gmail().users.messages.trash({ userId: 'me', id: messageId }),
    );
  }

  async untrashMessage(messageId: string): Promise<void> {
    await this.call('take a message out of the bin', () =>
      this.gmail().users.messages.untrash({ userId: 'me', id: messageId }),
    );
  }

  async createLabel(name: string): Promise<{ id: string; name: string }> {
    const { data } = await this.call(
      'create a label',
      () =>
        this.gmail().users.labels.create({
          userId: 'me',
          requestBody: { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' },
        }),
      { mode: 'rate-limit-only' },
    );
    return { id: data.id ?? '', name: data.name ?? name };
  }

  async listSendAs(): Promise<SendAsAddress[]> {
    const { data } = await this.call('list the send-as addresses', () =>
      this.gmail().users.settings.sendAs.list({ userId: 'me' }),
    );
    return (data.sendAs ?? []).map((entry) => ({
      sendAsEmail: entry.sendAsEmail ?? '',
      displayName: entry.displayName ?? '',
      isDefault: entry.isDefault ?? false,
      isPrimary: entry.isPrimary ?? false,
      treatAsAlias: entry.treatAsAlias ?? false,
      verificationStatus: entry.verificationStatus ?? undefined,
      signature: entry.signature ?? undefined,
    }));
  }
}
