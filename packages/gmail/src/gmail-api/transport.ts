import { type gmail_v1, gmail as gmailApi } from '@googleapis/gmail';
import { type people_v1, people as peopleApi } from '@googleapis/people';
import { OAuth2Client } from 'google-auth-library';
import type { GoogleEndpoints } from '../auth/endpoints.ts';
import type { TokenSource } from '../auth/session.ts';
import { describeGoogleError, mapGoogleError } from './errors.ts';
import { createLimiter, type RetryMode, withRetry } from './retry.ts';

/**
 * Everything this package may ask Google to do. Operations depend on this interface, never on `@googleapis/*`, so
 * they can be tested against a fake and so the surface stays small enough to see at a glance.
 *
 * **There is no send method here.** The send gate adds one in its own phase, reachable only from `send.execute`.
 */
export interface GmailTransport {
  readonly alias: string;
  readonly inboxId: string;
  getProfile(): Promise<GmailProfile>;
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
  /** The bytes of one attachment. The id is resolved fresh from the message: Gmail's can change between fetches. */
  getAttachment(messageId: string, attachmentId: string): Promise<Buffer>;
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
  /** Concurrency cap per inbox: Gmail's per-user quota, not the network, is the limit worth respecting. */
  concurrency?: number;
  retry?: { attempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number };
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
export class GoogleGmailTransport implements GmailTransport {
  readonly alias: string;
  readonly inboxId: string;
  readonly #tokens: TokenSource;
  readonly #endpoints: GoogleEndpoints;
  readonly #limit: <T>(task: () => Promise<T>) => Promise<T>;
  readonly #retry: TransportOptions['retry'];
  #gmail: gmail_v1.Gmail | null = null;
  #people: people_v1.People | null = null;
  #oauth: OAuth2Client | null = null;

  constructor(options: TransportOptions) {
    this.#tokens = options.tokens;
    this.alias = options.tokens.alias;
    this.inboxId = options.tokens.inbox.id;
    this.#endpoints = options.endpoints;
    this.#limit = createLimiter(options.concurrency ?? 5);
    this.#retry = options.retry;
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
        throw mapGoogleError(error, { alias: this.alias, operation, api: options.api ?? 'gmail' });
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

  async getAttachment(messageId: string, attachmentId: string): Promise<Buffer> {
    const { data } = await this.call('download an attachment', () =>
      this.gmail().users.messages.attachments.get({ userId: 'me', messageId, id: attachmentId }),
    );
    return Buffer.from(data.data ?? '', 'base64url');
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
    const { data } = await this.call('save a draft', () =>
      this.gmail().users.drafts.create({
        userId: 'me',
        requestBody: { message: { raw: raw.toString('base64url'), ...(threadId ? { threadId } : {}) } },
      }),
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
