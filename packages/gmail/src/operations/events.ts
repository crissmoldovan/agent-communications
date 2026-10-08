import { decodeHeaderWords, neutralise, parseAddressList } from '@agentcomms/core';
import { GmailContext, type GmailContextOptions } from '../context.ts';
import { readAuthResults, readSenderWarnings } from '../domain/auth-results.ts';
import { buildBody } from '../domain/body.ts';
import { headerValue, readParts } from '../domain/mime.ts';
import type { AttachmentAbout } from '../gmail-api/download.ts';
import type { GmailHistoryPage, GmailProfile, RawMessage } from '../gmail-api/transport.ts';
import { attachmentRisks } from './read.ts';

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

export interface GmailEventAttachmentMetadata {
  readonly name: string;
  readonly type: string;
  readonly size: number;
  readonly inline: boolean;
  readonly riskFlags: readonly string[];
}

/** D3: an absent or empty display name is `null`, never synthesized. */
export interface GmailEventAddress {
  readonly address: string;
  readonly name: string | null;
}

/** Sender-controlled values that the daemon may retain only in sanitised typed form. */
export interface GmailEventMessageMetadata {
  readonly messageId: string;
  readonly threadId: string;
  readonly labels: readonly string[];
  readonly snippet: string;
  readonly date: string;
  readonly unread: boolean;
  readonly from: GmailEventAddress | null;
  readonly replyTo: readonly GmailEventAddress[];
  readonly to: readonly GmailEventAddress[];
  readonly cc: readonly GmailEventAddress[];
  readonly subject: string;
  readonly authentication: ReturnType<typeof readAuthResults>;
  readonly warnings: ReturnType<typeof readSenderWarnings>;
  readonly hasAttachments: boolean;
  readonly attachments: readonly GmailEventAttachmentMetadata[];
  readonly body?: string | undefined;
}

function sortUtf8(values: readonly string[]): readonly string[] {
  const encoder = new TextEncoder();
  return [...new Set(values)].sort((left, right) => {
    const leftBytes = encoder.encode(left);
    const rightBytes = encoder.encode(right);
    for (let index = 0; index < Math.min(leftBytes.length, rightBytes.length); index += 1) {
      const difference = (leftBytes[index] ?? 0) - (rightBytes[index] ?? 0);
      if (difference !== 0) return difference;
    }
    return leftBytes.length - rightBytes.length;
  });
}

function safeText(value: string): string {
  return neutralise(decodeHeaderWords(value)).text;
}

function safeAddresses(value: string | undefined): readonly GmailEventAddress[] {
  // A name that is absent, empty, or empty once sanitised is null: D3 never synthesizes one.
  return parseAddressList(value).map((entry) => ({ address: entry.address, name: safeText(entry.name) || null }));
}

/**
 * Converts a metadata or full message through the Gmail package's established parsers and sanitiser before the daemon
 * encrypts it. Metadata replies have no body bytes, so this cannot accidentally make a lazy body read eager.
 */
export function normaliseGmailEventMetadata(
  message: RawMessage,
  options: { readonly includeBody?: boolean } = {},
): GmailEventMessageMetadata {
  if (!message.id || !message.threadId) throw new Error('a Gmail event message requires an id and thread id');
  const milliseconds = Number(message.internalDate);
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0)
    throw new Error('a Gmail event message requires an unsigned internal date');
  const headers = message.payload?.headers ?? [];
  const fromHeader = headerValue(headers, 'From');
  const replyToHeader = headerValue(headers, 'Reply-To');
  const parts = readParts(message.payload);
  const attachments = parts.attachments.map((part) => ({
    name: safeText(part.filename ?? ''),
    type: safeText(part.mimeType),
    size: part.size,
    inline: part.disposition === 'inline',
    riskFlags: sortUtf8(attachmentRisks(part.filename ?? '', part.mimeType)),
  }));
  const from = safeAddresses(fromHeader)[0] ?? null;
  const warnings = readSenderWarnings(fromHeader, replyToHeader);
  const metadata: GmailEventMessageMetadata = {
    messageId: message.id,
    threadId: message.threadId,
    labels: sortUtf8(message.labelIds ?? []),
    snippet: safeText(message.snippet ?? ''),
    date: new Date(milliseconds).toISOString(),
    unread: (message.labelIds ?? []).includes('UNREAD'),
    from,
    replyTo: safeAddresses(replyToHeader),
    to: safeAddresses(headerValue(headers, 'To')),
    cc: safeAddresses(headerValue(headers, 'Cc')),
    subject: safeText(headerValue(headers, 'Subject') ?? ''),
    authentication: readAuthResults(headers, fromHeader),
    warnings: {
      ...warnings,
      replyToDomains: [...sortUtf8(warnings.replyToDomains)],
    },
    hasAttachments: attachments.length > 0,
    attachments,
  };
  if (!options.includeBody) return metadata;
  return { ...metadata, body: buildBody(parts).text };
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
