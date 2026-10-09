import type { PathOverrides } from '@agentcomms/core';
import { CommsError, neutralise, newBoundary, stripInvisible } from '@agentcomms/core';
import { keyPermissionOf, type NamedAccount } from '../accounts.ts';
import { type ResendTransport, resendRequest } from '../api/client.ts';
import { addressesOf, attachmentRisks, readBody } from '../compose/inbound.ts';
import { ResendContext } from '../context.ts';
import { resendId } from './read.ts';

const BODY_LIMIT = 20_000;
const STATUS = new Set([
  'scheduled',
  'sent',
  'delivered',
  'delivery_delayed',
  'bounced',
  'complained',
  'opened',
  'clicked',
  'failed',
  'suppressed',
  'canceled',
  'queued',
]);

type Raw = Record<string, unknown>;
type Page<T> = Readonly<{ data?: readonly T[]; has_more?: boolean }>;

export interface ResendEventReceivedListItem {
  readonly id: string;
}

export interface ResendEventAddress {
  readonly address: string;
  readonly name: string | null;
}

export interface ResendEventReceivedAttachment {
  readonly id: string;
  readonly filename: string;
  readonly riskFlags: readonly string[];
  readonly contentType: string | null;
  readonly size: number | null;
  readonly inline: boolean;
}

export interface ResendEventAuthentication {
  readonly spf: string | null;
  readonly dkim: string | null;
  readonly dmarc: string | null;
  readonly evaluatedBy: 'resend' | null;
}

export interface ResendEventReceivedCandidate {
  readonly emailId: string;
  readonly receivedAt: string;
  readonly subject: string;
  readonly body?: string | undefined;
  readonly bodyTruncated?: boolean | undefined;
  readonly attachments: readonly ResendEventReceivedAttachment[];
  readonly attachmentCount: number;
  readonly from: ResendEventAddress | null;
  readonly replyTo: readonly ResendEventAddress[];
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly receivedFor: readonly string[];
  readonly messageId: string | null;
  readonly authentication: ResendEventAuthentication;
}

export interface ResendEventSentItem {
  readonly id: string;
  readonly lastEvent: string;
  readonly from: ResendEventAddress | null;
  readonly to: readonly string[];
  readonly cc: readonly string[];
  readonly bcc: readonly string[];
  readonly subject: string;
  readonly createdAt: string | null;
  readonly scheduledAt: string | null;
  readonly messageId: string | null;
}

export interface ResendEventReader {
  listReceived(
    after?: string,
  ): Promise<Readonly<{ emails: readonly ResendEventReceivedListItem[]; next: string | null }>>;
  getReceived(
    id: string,
  ): Promise<Readonly<{ kind: 'candidate'; candidate: ResendEventReceivedCandidate }> | Readonly<{ kind: 'vanished' }>>;
  listSent(after?: string): Promise<Readonly<{ emails: readonly ResendEventSentItem[]; next: string | null }>>;
}

/**
 * Converts the already-capped body produced by the Resend reader into the
 * event representation.  `bodyTruncated` is that reader's fact: this layer
 * must not recompute it from Unicode code points.
 */
export function normaliseResendEventBody(
  value: string,
  bodyTruncated: boolean,
): Readonly<{ body: string; bodyTruncated: boolean }> {
  let body = value;
  if (bodyTruncated && body.charCodeAt(body.length - 1) >= 0xd800 && body.charCodeAt(body.length - 1) <= 0xdbff)
    body = body.slice(0, -1);
  for (let index = 0; index < body.length; index += 1) {
    const code = body.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = body.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff))
        throw new CommsError('BAD_DATA', 'Resend body is not a Unicode scalar sequence');
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new CommsError('BAD_DATA', 'Resend body is not a Unicode scalar sequence');
    }
  }
  if ([...body].length > BODY_LIMIT)
    throw new CommsError('BAD_DATA', 'Resend body exceeds the Unicode code-point limit');
  return { body, bodyTruncated };
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function cleanText(value: unknown): string {
  return neutralise(stripInvisible(typeof value === 'string' ? value : '').text).text;
}

function cleanAddress(entry: { readonly address: string; readonly name: string }): ResendEventAddress {
  return { address: cleanText(entry.address), name: entry.name === '' ? null : cleanText(entry.name) };
}

function unwrapReadBody(value: string): string {
  const firstNewline = value.indexOf('\n');
  const finalNewline = value.lastIndexOf('\n<');
  if (firstNewline < 0 || finalNewline <= firstNewline)
    throw new CommsError('BAD_DATA', 'Resend read body did not have its expected untrusted-content envelope');
  return value.slice(firstNewline + 1, finalNewline);
}

function cleanBody(entry: Raw, emailId: string): Readonly<{ body: string; bodyTruncated: boolean }> {
  // The existing read path owns HTML/plain-text sanitisation and the provider-visible truncation fact.  Event
  // normalisation removes this transient response envelope; a target-specific envelope is added only at disclosure.
  const read = readBody(text(entry.html), text(entry.text), {
    account: 'resend-event-reader',
    id: emailId,
    boundary: newBoundary(),
  });
  return normaliseResendEventBody(unwrapReadBody(read.body), read.truncated);
}

function receivedCandidate(entry: Raw): ResendEventReceivedCandidate {
  const emailId = resendId(entry.id, 'received email id');
  const receivedAt = text(entry.created_at);
  if (receivedAt === null) throw new CommsError('BAD_DATA', 'Resend received detail has no received time');
  const from = addressesOf(entry.from)[0];
  const attachments = (Array.isArray(entry.attachments) ? entry.attachments : []).map((value) => {
    const attachment = value as Raw;
    const rawFilename = typeof attachment.filename === 'string' ? attachment.filename : '';
    const filename = cleanText(rawFilename);
    return {
      id: cleanText(attachment.id),
      filename,
      contentType: text(attachment.content_type) === null ? null : cleanText(attachment.content_type),
      size: typeof attachment.size === 'number' && Number.isSafeInteger(attachment.size) ? attachment.size : null,
      inline: attachment.content_disposition === 'inline',
      riskFlags: [...new Set(attachmentRisks(rawFilename))].sort(),
    };
  });
  const auth = (entry.authentication ?? null) as Raw | null;
  const body = cleanBody(entry, emailId);
  return {
    emailId,
    receivedAt,
    subject: cleanText(entry.subject),
    body: body.body,
    bodyTruncated: body.bodyTruncated,
    attachments,
    attachmentCount: attachments.length,
    from: from === undefined ? null : cleanAddress(from),
    replyTo: addressesOf(entry.reply_to).map(cleanAddress),
    to: addressesOf(entry.to).map((entry) => cleanText(entry.address)),
    cc: addressesOf(entry.cc).map((entry) => cleanText(entry.address)),
    receivedFor: addressesOf(entry.received_for).map((entry) => cleanText(entry.address)),
    messageId: text(entry.message_id) === null ? null : cleanText(entry.message_id),
    authentication: auth
      ? {
          spf: text(auth.spf),
          dkim: text(auth.dkim),
          dmarc: text(auth.dmarc),
          evaluatedBy: 'resend',
        }
      : { spf: null, dkim: null, dmarc: null, evaluatedBy: null },
  };
}

function sentItem(entry: Raw): ResendEventSentItem {
  const id = resendId(entry.id, 'sent email id');
  const lastEvent = text(entry.last_event);
  if (lastEvent === null || !STATUS.has(lastEvent))
    throw new CommsError('BAD_DATA', 'Resend sent detail has an unsupported status');
  const from = addressesOf(entry.from)[0];
  return {
    id,
    lastEvent,
    from: from === undefined ? null : cleanAddress(from),
    to: addressesOf(entry.to).map((address) => cleanText(address.address)),
    cc: addressesOf(entry.cc).map((address) => cleanText(address.address)),
    bcc: addressesOf(entry.bcc).map((address) => cleanText(address.address)),
    subject: cleanText(entry.subject),
    createdAt: text(entry.created_at),
    scheduledAt: text(entry.scheduled_at),
    messageId: text(entry.message_id) === null ? null : cleanText(entry.message_id),
  };
}

async function readable<T>(
  context: ResendContext,
  name: string,
  work: (transport: ResendTransport) => Promise<T>,
): Promise<T> {
  const named: NamedAccount = await context.accounts.require(name);
  if (keyPermissionOf(named.account) !== 'full_access')
    throw new CommsError('SOURCE_UNAVAILABLE', 'Resend event polling requires a full-access key');
  return work(await context.transport(named));
}

/** A structural read adapter: no permit, no sender, and each request is labelled background-event. */
export function createResendEventReader(context: ResendContext, account: string): ResendEventReader {
  return {
    async listReceived(after?: string) {
      return readable(context, account, async (transport) => {
        const page = await resendRequest<Page<Raw>>(transport, 'GET', '/emails/receiving', {
          query: { limit: 100, after },
          throttlePriority: 'background-event',
        });
        const emails = (page.data ?? []).map((entry) => ({ id: resendId(entry.id, 'received email id') }));
        return { emails, next: page.has_more === true ? (emails.at(-1)?.id ?? null) : null };
      });
    },
    async getReceived(id: string) {
      const emailId = resendId(id, 'received email id');
      try {
        return await readable(context, account, async (transport) => {
          const detail = await resendRequest<Raw>(transport, 'GET', `/emails/receiving/${emailId}`, {
            throttlePriority: 'background-event',
          });
          return { kind: 'candidate' as const, candidate: receivedCandidate(detail) };
        });
      } catch (error) {
        if (error instanceof CommsError && error.code === 'NOT_FOUND') return { kind: 'vanished' as const };
        throw error;
      }
    },
    async listSent(after?: string) {
      return readable(context, account, async (transport) => {
        const page = await resendRequest<Page<Raw>>(transport, 'GET', '/emails', {
          query: { limit: 100, after },
          throttlePriority: 'background-event',
        });
        const emails = (page.data ?? []).map(sentItem);
        return { emails, next: page.has_more === true ? (emails.at(-1)?.id ?? null) : null };
      });
    },
  };
}

/** Opens Resend's guarded, read-only context for the held event owner. */
export function createResendEventReaderForPaths(
  input: Readonly<{
    account: string;
    pathOverrides: PathOverrides;
  }>,
): ResendEventReader {
  return createResendEventReader(new ResendContext({ pathOverrides: input.pathOverrides }), input.account);
}
