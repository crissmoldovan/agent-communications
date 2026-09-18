import {
  newBoundary,
  type ParsedAddress,
  parseAddressList,
  type SanitizeReport,
  TaintCollector,
  wrapUntrusted,
} from '@cloudpixel/comms-core';
import { type AuthResults, readAuthResults, readSenderWarnings, type SenderWarnings } from '../domain/auth-results.ts';
import { type BodyOptions, buildBody, DEFAULT_MAX_CHARS, type MessageBody } from '../domain/body.ts';
import { type GmailPart, headerValue, readParts } from '../domain/mime.ts';
import type { GmailContext } from '../context.ts';

/**
 * Reading mail — the operation with the largest blast radius in this package, because everything it returns was
 * written by someone else. Three rules hold here and are visible in the code below:
 *
 *  1. every sender-controlled string leaves inside the untrusted envelope, never as bare text;
 *  2. the body is what a person would see, with anything hidden removed and counted;
 *  3. every address seen while reading is recorded as tainted before the result is returned, so a later send can
 *     tell "this address came out of an email" from "the user typed it".
 */

export interface MessageAttachment {
  partId: string;
  attachmentId: string | undefined;
  filename: string;
  mimeType: string;
  size: number;
  inline: boolean;
  riskFlags: string[];
}

export interface ReadMessageResult {
  inbox: string;
  messageId: string;
  threadId: string;
  date: string | null;
  /** Header addresses, parsed. Display names are sender-controlled and are wrapped when rendered. */
  from: ParsedAddress | null;
  replyTo: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  labels: string[];
  unread: boolean;
  auth: AuthResults;
  sender: SenderWarnings;
  attachments: MessageAttachment[];
  sanitisation: SanitizeReport & { plainHtmlMismatch: MessageBody['mismatch']; charsetOverridden: boolean };
  body: {
    /** The body inside the untrusted envelope, ready to be shown to a model. */
    enveloped: string;
    source: MessageBody['source'];
    truncated: boolean;
    nextOffset: number | undefined;
    totalChars: number;
    quotedLinesOmitted: number;
  };
  webLink: string;
}

/** File kinds worth naming before anyone opens one. Nothing here is ever opened or executed by this package. */
const RISK_RULES: Array<{ flag: string; extensions?: RegExp; mimeTypes?: RegExp }> = [
  { flag: 'executable', extensions: /\.(exe|msi|bat|cmd|com|scr|pif|app|dmg|pkg|deb|rpm|apk)$/i },
  { flag: 'script', extensions: /\.(js|mjs|vbs|ps1|sh|bash|zsh|py|rb|jar|jse|wsf|hta)$/i },
  { flag: 'macro-enabled', extensions: /\.(docm|xlsm|pptm|dotm|xltm|xlam)$/i },
  { flag: 'markup', extensions: /\.(html?|svg|xhtml|mht|mhtml)$/i, mimeTypes: /^(text\/html|image\/svg\+xml)$/i },
  { flag: 'archive', extensions: /\.(zip|rar|7z|tar|gz|bz2|xz|iso|cab)$/i },
  { flag: 'disk-image', extensions: /\.(iso|img|vhd|vmdk)$/i },
];

export function attachmentRisks(filename: string, mimeType: string): string[] {
  const flags: string[] = [];
  for (const rule of RISK_RULES) {
    if (rule.extensions?.test(filename) || rule.mimeTypes?.test(mimeType)) flags.push(rule.flag);
  }
  // `invoice.pdf.exe` shows as `invoice.pdf` in clients that hide extensions.
  if (/\.[a-z0-9]{2,5}\.[a-z0-9]{2,5}$/i.test(filename)) flags.push('double-extension');
  if (/[‪-‮⁦-⁩]/.test(filename)) flags.push('bidi-filename');
  return [...new Set(flags)];
}

export interface GmailMessage {
  id?: string | null;
  threadId?: string | null;
  labelIds?: string[] | null;
  snippet?: string | null;
  internalDate?: string | null;
  payload?: GmailPart | null;
}

export interface ReadOptions extends BodyOptions {
  /** The boundary to use for the untrusted envelope; one per response. */
  boundary?: string | undefined;
}

/**
 * Turns one Gmail message into a result. Pure apart from the taint collector it fills, so a thread read can reuse it
 * for every message and record everything once.
 */
export function buildMessageResult(
  message: GmailMessage,
  options: {
    inbox: string;
    boundary: string;
    collector: TaintCollector;
    body?: BodyOptions;
  },
): ReadMessageResult {
  const headers = message.payload?.headers ?? [];
  const parts = readParts(message.payload);
  const body = buildBody(parts, options.body ?? {});

  const from = parseAddressList(headerValue(headers, 'From'))[0] ?? null;
  const replyTo = parseAddressList(headerValue(headers, 'Reply-To'));
  const to = parseAddressList(headerValue(headers, 'To'));
  const cc = parseAddressList(headerValue(headers, 'Cc'));
  const subject = headerValue(headers, 'Subject') ?? '';

  // Everything the sender chose: the addresses in the headers, and every address inside the body text.
  options.collector.observeHeaders([from?.address, ...replyTo.map((a) => a.address), ...to.map((a) => a.address), ...cc.map((a) => a.address)].filter((address): address is string => Boolean(address)));

  const enveloped = wrapUntrusted(
    `Subject: ${subject}\n\n${body.text}`,
    { field: 'body', inbox: options.inbox, id: message.id ?? undefined },
    options.boundary,
    options.collector,
  );

  const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
  const labels = message.labelIds ?? [];

  return {
    inbox: options.inbox,
    messageId: message.id ?? '',
    threadId: message.threadId ?? '',
    date,
    from,
    replyTo,
    to,
    cc,
    // Kept for structure; a renderer shows it through the envelope, never as a bare string.
    subject,
    labels,
    unread: labels.includes('UNREAD'),
    auth: readAuthResults(headers, headerValue(headers, 'From')),
    sender: readSenderWarnings(headerValue(headers, 'From'), headerValue(headers, 'Reply-To')),
    attachments: parts.attachments.map((part) => ({
      partId: part.partId,
      attachmentId: part.attachmentId,
      filename: part.filename ?? '(unnamed)',
      mimeType: part.mimeType,
      size: part.size,
      inline: part.disposition === 'inline',
      riskFlags: attachmentRisks(part.filename ?? '', part.mimeType),
    })),
    sanitisation: {
      ...body.report,
      plainHtmlMismatch: body.mismatch,
      charsetOverridden: parts.parts.some((part) => part.charsetOverridden),
    },
    body: {
      enveloped,
      source: body.source,
      truncated: body.truncated,
      nextOffset: body.nextOffset,
      totalChars: body.totalChars,
      quotedLinesOmitted: body.quoted.linesOmitted,
    },
    webLink: message.id ? `https://mail.google.com/mail/u/0/#all/${message.id}` : '',
  };
}

/** The addresses that are not worth recording as tainted: the inbox's own, and its internal domains. */
export async function taintExclusions(
  context: GmailContext,
  alias: string,
): Promise<{ ownAddresses: string[]; internalDomains: string[] }> {
  const { inbox } = await context.inbox(alias);
  return { ownAddresses: [inbox.email], internalDomains: inbox.internalDomains };
}

export interface ReadThreadResult {
  inbox: string;
  threadId: string;
  subject: string;
  messageCount: number;
  participants: string[];
  /** Chronological, oldest first: a thread is read as a conversation, not as a stack. */
  messages: ReadMessageResult[];
  /** True when the per-thread cap cut the last messages short. */
  truncated: boolean;
  totalChars: number;
}

/** Total characters of body across a thread before it is cut: a whole thread should not fill a context window. */
export const DEFAULT_THREAD_CHARS = 20_000;

/**
 * Reads a whole thread in one call. Later messages quote earlier ones, so each body is collapsed as usual, and the
 * budget is spent oldest-first — a reader who runs out of room has still seen how the conversation started.
 */
export async function readThread(
  context: GmailContext,
  alias: string,
  threadId: string,
  options: ReadOptions & { maxThreadChars?: number | undefined } = {},
): Promise<ReadThreadResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const thread = await transport.getThread(threadId);

  const boundary = options.boundary ?? newBoundary();
  const collector = new TaintCollector(resolved.inbox.id, threadId);
  const ordered = [...(thread.messages ?? [])].sort(
    (a, b) => Number(a.internalDate ?? 0) - Number(b.internalDate ?? 0),
  );

  const budget = options.maxThreadChars ?? DEFAULT_THREAD_CHARS;
  const messages: ReadMessageResult[] = [];
  let spent = 0;
  let truncated = false;
  for (const message of ordered) {
    const remaining = budget - spent;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const result = buildMessageResult(message, {
      inbox: alias,
      boundary,
      collector,
      body: { ...options, maxChars: Math.min(options.maxChars ?? DEFAULT_MAX_CHARS, remaining) },
    });
    spent += result.body.totalChars;
    if (result.body.truncated) truncated = true;
    messages.push(result);
  }

  await collector.flush(context.core.taint, await taintExclusions(context, alias));
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });

  const participants = [
    ...new Set(
      messages.flatMap((message) =>
        [message.from?.address, ...message.to.map((a) => a.address), ...message.cc.map((a) => a.address)].filter(
          (address): address is string => Boolean(address),
        ),
      ),
    ),
  ];

  return {
    inbox: alias,
    threadId: thread.id ?? threadId,
    subject: messages[0]?.subject ?? '',
    messageCount: ordered.length,
    participants,
    messages,
    truncated,
    totalChars: spent,
  };
}

/** Reads one message. The result is returned only after the taint it observed has been recorded. */
export async function readMessage(
  context: GmailContext,
  alias: string,
  messageId: string,
  options: ReadOptions = {},
): Promise<ReadMessageResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const message = await transport.getMessage(messageId);

  const collector = new TaintCollector(resolved.inbox.id, messageId);
  const result = buildMessageResult(message, {
    inbox: alias,
    boundary: options.boundary ?? newBoundary(),
    collector,
    body: options,
  });
  await collector.flush(context.core.taint, await taintExclusions(context, alias));
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });
  return result;
}
