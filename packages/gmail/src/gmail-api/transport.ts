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
