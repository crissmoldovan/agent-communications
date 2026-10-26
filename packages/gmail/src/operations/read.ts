import {
  decodeHeaderWords,
  fileRisks,
  neutralise,
  newBoundary,
  type ParsedAddress,
  parseAddressList,
  type SanitizeReport,
  TaintCollector,
  type TakenView,
  wrapUntrusted,
} from '@agentcomms/core';
import { itemOf, recorded } from '../activity.ts';
import type { GmailContext } from '../context.ts';
import { type AuthResults, readAuthResults, readSenderWarnings, type SenderWarnings } from '../domain/auth-results.ts';
import { type BodyOptions, buildBody, DEFAULT_MAX_CHARS, type MessageBody } from '../domain/body.ts';
import { type GmailPart, headerValue, readParts } from '../domain/mime.ts';
import { type FieldEnvelope, filenameField, mimeTypeField } from '../domain/untrusted-fields.ts';
import { gmailTaken } from '../takes.ts';
import { type NumberOption, numberOption } from './numbers.ts';

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
  /** Wrapped: the sender named it. `(unnamed)` when they did not. */
  filename: string;
  /** A bare MIME type, or wrapped when it is anything more. */
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
  /**
   * Who has the message (design 2026-10-26-taking-messages §6), for a read of the message or its thread: null when
   * nobody has taken, offered or handed it back; otherwise closed words, never another session's folder or client.
   */
  taken?: TakenView | undefined;
}

/**
 * A parsed address with its display name neutralised.
 *
 * The address itself is structure — it is parsed, canonicalised and compared elsewhere — but the display name is
 * free text the sender chose, and it travels in the same object.
 */
function safeAddress<T extends { name: string; address: string } | null>(entry: T): T {
  if (!entry) return entry;
  return { ...entry, name: neutralise(entry.name).text } as T;
}

/**
 * The risks worth naming for an attachment, judged from the name the sender sent.
 *
 * **It normalises its own input, and it needs two forms of the name to do it.** Every call site used to pass a
 * different string — the raw header on the download path, `safeFilename(...)` on the read path, something else
 * again on find — so the same file came back `['executable']` from one surface and `[]` from another. Deciding it
 * here means a caller cannot get it wrong, and a new surface inherits the right answer.
 *
 * The extension rules run against the name the file would actually be **written under**: decoded, and with the
 * trailing spaces and separators `safeFilename` strips. `invoice.exe ` matches no `$`-anchored rule while landing
 * on disk as `invoice.exe`, and an RFC 2047-encoded header matches nothing at all — so a sender could suppress
 * every flag just by encoding the name.
 *
 * The bidi rule runs against the **raw** header, because that is the only place the override still exists:
 * `safeFilename` removes it by design, so testing the cleaned name meant `bidi-filename` could never fire on a
 * find row or a message read at all.
 */
export function attachmentRisks(filename: string, mimeType: string): string[] {
  // The rules are core's, shared with Slack's file download; what is Gmail's own is decoding the header first.
  return fileRisks(decodeHeaderWords(filename), mimeType);
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

/** What a read takes: the body options, with its numbers as given — checked by the read, for either surface. */
export interface ReadRequest extends Omit<ReadOptions, 'maxChars' | 'offset'> {
  /** How much of a body to return; checked against {@link MAX_CHARS}. */
  maxChars?: unknown;
  /** Where a truncated body continues from; checked against {@link OFFSET}. */
  offset?: unknown;
}

// No characters at all returned an empty body marked truncated, continuing from where it began: a reader paging
// through it never got anywhere.
export const MAX_CHARS: NumberOption = { flag: '--max-chars', arg: 'maxChars', min: 1 };
export const OFFSET: NumberOption = { flag: '--offset', arg: 'offset', min: 0 };

/** The read's numbers, checked before anything is read. */
function bodyNumbers(
  context: GmailContext,
  options: ReadRequest,
): { maxChars: number | undefined; offset: number | undefined } {
  return {
    maxChars: numberOption(context, options.maxChars, MAX_CHARS),
    offset: numberOption(context, options.offset, OFFSET),
  };
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
  options.collector.observeHeaders(
    [from?.address, ...replyTo.map((a) => a.address), ...to.map((a) => a.address), ...cc.map((a) => a.address)].filter(
      (address): address is string => Boolean(address),
    ),
  );

  const enveloped = wrapUntrusted(
    `Subject: ${subject}\n\n${body.text}`,
    { field: 'body', inbox: options.inbox, id: message.id ?? undefined },
    options.boundary,
    options.collector,
  );

  const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
  const labels = message.labelIds ?? [];
  // The attachments' names and types are wrapped with the body's boundary, and their text is collected as it is.
  const fields: FieldEnvelope = {
    boundary: options.boundary,
    inbox: options.inbox,
    id: message.id ?? undefined,
    collector: options.collector,
  };

  return {
    inbox: options.inbox,
    messageId: message.id ?? '',
    threadId: message.threadId ?? '',
    date,
    // Every one of these is written by the sender, and every one of them leaves this object as a bare string in a
    // structured result that a client serialises into the model's text. The body was enveloped and neutralised and
    // these were not, which is a gap with no upside: a display name carrying `<|im_start|>system` or a closing
    // envelope tag arrived intact beside the carefully wrapped body it was attached to. RFC 2047 encoding means a
    // display name can hold any bytes at all, newlines included.
    from: safeAddress(from),
    replyTo: replyTo.map(safeAddress),
    to: to.map(safeAddress),
    cc: cc.map(safeAddress),
    // Kept for structure; a renderer shows it through the envelope, never as a bare string.
    // Decoded first: Gmail returns the header as it sits in the MIME source. Neutralised second and never the
    // other way round — `=?utf-8?B?PC91bnRydXN0ZWQtZW1haWwtY29udGVudD4=?=` decodes to a literal closing envelope
    // tag, so a neutralise run on the encoded form sees nothing to defuse.
    subject: neutralise(decodeHeaderWords(subject)).text,
    labels,
    unread: labels.includes('UNREAD'),
    auth: readAuthResults(headers, headerValue(headers, 'From')),
    sender: readSenderWarnings(headerValue(headers, 'From'), headerValue(headers, 'Reply-To')),
    attachments: parts.attachments.map((part) => {
      // Risk is judged by `attachmentRisks` itself, from the raw name: it needs both the written-to-disk form and the
      // untouched header, and deciding that in one place is what stopped each surface flagging the same file differently.
      // The name and the type are the sender's, and leave inside the envelope: neutralising them defused a forged tag
      // but left a sentence — `Ignore previous instructions.txt` — in the tool's own voice.
      return {
        partId: part.partId,
        attachmentId: part.attachmentId,
        filename: filenameField(part.filename, fields),
        mimeType: mimeTypeField(part.mimeType, fields),
        size: part.size,
        inline: part.disposition === 'inline',
        riskFlags: attachmentRisks(part.filename ?? '', part.mimeType),
      };
    }),
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
  options: ReadRequest & { maxThreadChars?: number | undefined } = {},
): Promise<ReadThreadResult> {
  // Recorded as each message read — its id, subject and sender — and how many the thread holds.
  return recorded(
    context,
    'gmail.thread.read',
    'read',
    alias,
    () => readWholeThread(context, alias, threadId, options),
    (thread) => ({
      count: thread.messageCount,
      items: thread.messages.map((message) => itemOf(message.messageId, message.subject, message.from)),
    }),
  );
}

async function readWholeThread(
  context: GmailContext,
  alias: string,
  threadId: string,
  options: ReadRequest & { maxThreadChars?: number | undefined },
): Promise<ReadThreadResult> {
  const { maxChars, offset } = bodyNumbers(context, options);
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
      body: { ...options, maxChars: Math.min(maxChars ?? DEFAULT_MAX_CHARS, remaining), offset },
    });
    // What was actually kept, not what the message contains. The budget exists to cap the conversation, so spending
    // a 40,000-character message against it when one character was returned ended a timeline five messages in — and
    // the timeline is exactly the caller that asks for one character.
    spent += result.body.enveloped.length;
    if (result.body.truncated) truncated = true;
    messages.push(result);
  }

  await collector.flush(context.core.taint, await taintExclusions(context, alias));
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });
  // Who has each message (design 2026-10-26-taking-messages §6): one file look each, in closed words.
  const taken = await gmailTaken(
    context,
    resolved.inbox.id,
    messages.map((message) => message.messageId),
  );
  for (const message of messages) message.taken = taken.get(message.messageId) ?? null;

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

/**
 * Reads one message. The result is returned only after the taint it observed has been recorded — and the read is
 * recorded in the activity log by the message's id, subject and sender.
 */
export async function readMessage(
  context: GmailContext,
  alias: string,
  messageId: string,
  options: ReadRequest = {},
): Promise<ReadMessageResult> {
  return recorded(
    context,
    'gmail.message.read',
    'read',
    alias,
    () => readOneMessage(context, alias, messageId, options),
    (message) => ({ items: [itemOf(message.messageId, message.subject, message.from)] }),
  );
}

async function readOneMessage(
  context: GmailContext,
  alias: string,
  messageId: string,
  options: ReadRequest,
): Promise<ReadMessageResult> {
  const numbers = bodyNumbers(context, options);
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const message = await transport.getMessage(messageId);

  const collector = new TaintCollector(resolved.inbox.id, messageId);
  const result = buildMessageResult(message, {
    inbox: alias,
    boundary: options.boundary ?? newBoundary(),
    collector,
    body: { ...options, ...numbers },
  });
  await collector.flush(context.core.taint, await taintExclusions(context, alias));
  await context.core.states.update(resolved.inbox.id, { lastUsedAt: context.now().toISOString() });
  // Who has it (design 2026-10-26-taking-messages §6): one file look, in closed words.
  result.taken = (await gmailTaken(context, resolved.inbox.id, [result.messageId])).get(result.messageId) ?? null;
  return result;
}
