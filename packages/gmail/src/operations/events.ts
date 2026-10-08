import { GmailContext, type GmailContextOptions } from '../context.ts';
import type { AttachmentAbout } from '../gmail-api/download.ts';
import type { GmailHistoryPage, GmailProfile, RawMessage } from '../gmail-api/transport.ts';

/**
 * The narrow Gmail boundary consumed by the local events service. It exposes one mailbox cursor, a baseline-only
 * profile read, and distinct metadata versus lazy materialisation paths without importing an SDK into the daemon.
 */
export interface GmailEventSource {
  readonly alias: string;
  readonly inboxId: string;
  /** D12's baseline-only operation: no history scan, normalisation, projection or delivery happens here. */
  getProfile(): Promise<GmailProfile>;
  /** One unfiltered mailbox-history page from a previously stored cursor. */
  listHistory(options: {
    readonly historyId: string;
    readonly pageToken?: string | undefined;
  }): Promise<GmailHistoryPage>;
  /** Headers, labels, dates and attachment metadata only; the provider response contains no body bytes. */
  getMessageMetadata(messageId: string): Promise<RawMessage>;
  /** The existing full-message path, called only when a source projection requires lazy materialisation. */
  getMessage(messageId: string): Promise<RawMessage>;
  /** The existing bounded attachment-download path, also only for lazy materialisation. */
  getAttachment(messageId: string, attachmentId: string, about?: AttachmentAbout): Promise<Buffer>;
}

/** The configured mailbox and the ordinary Gmail context inputs used to open its provider boundary. */
export interface CreateGmailEventSourceOptions extends GmailContextOptions {
  readonly alias: string;
  /** Tests and an embedding host may pass the already-open Gmail context; production normally constructs one here. */
  readonly context?: GmailContext | undefined;
}

/**
 * Opens one structural event-source adapter through Gmail's ordinary context. The context validates the configured
 * mailbox and owns the provider transport, token cache, request guard and fake injection point; the daemon sees none
 * of the Google client implementation.
 */
export async function createGmailEventSource(options: CreateGmailEventSourceOptions): Promise<GmailEventSource> {
  const context = options.context ?? new GmailContext(options);
  const { alias } = options;
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  return {
    alias: resolved.alias,
    inboxId: resolved.inbox.id,
    getProfile: () => transport.getProfile(),
    listHistory: (options) => transport.listHistory(options),
    getMessageMetadata: (messageId) => transport.getMessageMetadata(messageId),
    getMessage: (messageId) => transport.getMessage(messageId),
    getAttachment: (messageId, attachmentId, about) => transport.getAttachment(messageId, attachmentId, about),
  };
}
