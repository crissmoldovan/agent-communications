import { analyseOutboundHtml, CommsError, type ParsedAddress } from '@cloudpixel/comms-core';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';

/**
 * Building the message that will be sent.
 *
 * **An agent supplies text, never HTML.** The HTML part is generated here from that text, so there is no path by
 * which an agent can put a remote image, a script, a form or invisible text into something the user's name goes on.
 * The generated HTML is checked with the same analyser that inspects incoming mail, and a message that fails the
 * check is refused rather than quietly cleaned — if this code ever generates something that looks like a beacon,
 * that is a bug to see, not to paper over.
 */

export interface ComposeAttachment {
  filename: string;
  content: Buffer;
  contentType?: string | undefined;
}

export interface ComposeInput {
  from: string;
  to: string[];
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject: string;
  /** The body as the author wrote it: plain text, or Markdown-ish text. Never HTML. */
  text: string;
  /** Appended to both parts, exactly as Gmail stores it for the sending address. */
  signature?: { text: string; html: string } | undefined;
  attachments?: ComposeAttachment[] | undefined;
  inReplyTo?: string | undefined;
  references?: string[] | undefined;
  headers?: Record<string, string> | undefined;
}

export interface ComposedMessage {
  raw: Buffer;
  /** The text part, as it will be sent. */
  text: string;
  /** The generated HTML part. */
  html: string;
  bytes: number;
}

/** Gmail's own limit on the whole message, after base64 inflates the attachments by about a third. */
export const MAX_MESSAGE_BYTES = 36_700_160;
/** Gmail's user-facing attachment limit; above this a recipient may simply not receive it. */
export const WARN_ATTACHMENT_BYTES: number = 25 * 1024 * 1024;

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}

const URL_PATTERN = /\bhttps?:\/\/[^\s<>()[\]{}"']+/g;

/**
 * Turns the author's text into the HTML part: paragraphs, line breaks, and links for anything that is already a
 * URL. Nothing else — no images, no styles, no tables — because everything here ends up in somebody's mailbox with
 * the user's name on it, and the simplest thing that renders correctly everywhere is a paragraph.
 */
export function textToHtml(text: string): string {
  const paragraphs = text.replace(/\r\n/g, '\n').split(/\n{2,}/);
  return paragraphs
    .map((paragraph) => {
      // Links are found in the text as written, then everything is escaped — including inside the href. Escaping
      // first and matching afterwards swallows the entities that follow a URL into the link.
      let html = '';
      let index = 0;
      for (const match of paragraph.matchAll(URL_PATTERN)) {
        const start = match.index ?? 0;
        html += escapeHtml(paragraph.slice(index, start));
        const url = escapeHtml(match[0]);
        html += `<a href="${url}">${url}</a>`;
        index = start + match[0].length;
      }
      html += escapeHtml(paragraph.slice(index));
      return `<p>${html.split('\n').join('<br>')}</p>`;
    })
    .join('\n');
}

/** Formats an address for a header, quoting a display name that needs it. */
export function formatAddress(entry: ParsedAddress | string): string {
  if (typeof entry === 'string') return entry;
  if (!entry.name) return entry.address;
  const name = /["\\,:;<>@[\]]/.test(entry.name) ? `"${entry.name.replace(/(["\\])/g, '\\$1')}"` : entry.name;
  return `${name} <${entry.address}>`;
}

/**
 * Builds the message. Returns the raw bytes for Gmail, and the two body parts for a preview and for the digest the
 * approval is bound to.
 */
export async function composeMessage(input: ComposeInput): Promise<ComposedMessage> {
  if (input.to.length === 0 && (input.cc?.length ?? 0) === 0 && (input.bcc?.length ?? 0) === 0) {
    throw new CommsError('BAD_DATA', 'a message needs at least one recipient');
  }

  const text = input.signature ? `${input.text.replace(/\s+$/, '')}\n\n${input.signature.text}` : input.text;
  // Gmail wraps a signature in its own element so its editor recognises it; the wrapper is kept byte-for-byte.
  const html = input.signature
    ? `${textToHtml(input.text)}\n<div class="gmail_signature" data-smartmail="gmail_signature">${input.signature.html}</div>`
    : textToHtml(input.text);

  const report = analyseOutboundHtml(html);
  const problems = [
    report.scripts > 0 ? 'scripts' : '',
    report.forms > 0 ? 'forms' : '',
    report.remoteResources.length > 0 ? 'remote images or other remote resources' : '',
    report.hidden.length > 0 ? 'text hidden from the reader' : '',
  ].filter(Boolean);
  if (problems.length > 0) {
    throw new CommsError('UNSENDABLE_HTML', `this message would contain ${problems.join(', ')}`, {
      hint: 'The HTML part is generated from your text, so this is a fault in this package rather than in what you wrote.',
      details: { report },
    });
  }

  const composer = new MailComposer({
    from: input.from,
    to: input.to.length > 0 ? input.to : undefined,
    cc: input.cc?.length ? input.cc : undefined,
    bcc: input.bcc?.length ? input.bcc : undefined,
    subject: input.subject,
    text,
    html,
    inReplyTo: input.inReplyTo,
    references: input.references?.length ? input.references : undefined,
    headers: input.headers,
    attachments: input.attachments?.map((attachment) => ({
      filename: attachment.filename,
      content: attachment.content,
      contentType: attachment.contentType,
    })),
    // Gmail rewraps a lone text/plain part; a multipart message keeps the author's line breaks.
    textEncoding: 'quoted-printable' as const,
  });

  const raw = await composer.compile().build();
  if (raw.byteLength > MAX_MESSAGE_BYTES) {
    throw new CommsError(
      'BAD_DATA',
      `the message is ${Math.round(raw.byteLength / 1_048_576)} MB, over Gmail's limit`,
      {
        hint: 'Send fewer or smaller attachments, or share a link instead.',
      },
    );
  }
  return { raw, text, html, bytes: raw.byteLength };
}

export interface ReplyContext {
  /** The message being replied to. */
  from: ParsedAddress | null;
  replyTo: ParsedAddress[];
  to: ParsedAddress[];
  cc: ParsedAddress[];
  subject: string;
  messageIdHeader: string | undefined;
  references: string[];
  threadId: string;
}

export interface ReplyPlan {
  to: string[];
  cc: string[];
  subject: string;
  inReplyTo: string | undefined;
  references: string[];
  threadId: string | undefined;
}

/**
 * Who a reply goes to.
 *
 * `Reply-To` wins over `From` where it is set, which is what mail clients do and how mailing lists work — and also
 * how a redirect is done, so the caller is told about it separately. Reply-all keeps everyone except this mailbox's
 * own addresses, so nobody replies to themselves; duplicates are removed; and a forward starts a new conversation
 * rather than inheriting one.
 */
export function planReply(
  context: ReplyContext,
  options: { mode: 'reply' | 'reply_all' | 'forward'; ownAddresses: readonly string[]; to?: string[] | undefined },
): ReplyPlan {
  const own = new Set(options.ownAddresses.map((address) => address.toLowerCase()));
  const sender = context.replyTo.length > 0 ? context.replyTo : context.from ? [context.from] : [];
  const subjectBase = context.subject.replace(/^((re|fwd?|aw|sv|vs|rv)\s*(\[\d+\])?\s*:\s*)+/i, '').trim();

  if (options.mode === 'forward') {
    return {
      to: options.to ?? [],
      cc: [],
      subject: `Fwd: ${subjectBase}`,
      // A forward is a new conversation: it goes to people who were never in this one.
      inReplyTo: undefined,
      references: [],
      threadId: undefined,
    };
  }

  const to = sender.map((entry) => entry.address).filter((address) => !own.has(address));
  const everyone =
    options.mode === 'reply_all'
      ? [...context.to, ...context.cc].map((entry) => entry.address).filter((address) => !own.has(address))
      : [];

  const primary = to.length > 0 ? to : sender.map((entry) => entry.address);
  const cc = [...new Set(everyone)].filter((address) => !primary.includes(address));

  return {
    to: [...new Set(primary)],
    cc,
    subject: subjectBase.toLowerCase().startsWith('re:') ? subjectBase : `Re: ${subjectBase}`,
    inReplyTo: context.messageIdHeader,
    // The chain, plus the message being answered, with the duplicate the sender may already have included removed.
    references: [
      ...new Set([...context.references, context.messageIdHeader].filter((id): id is string => Boolean(id))),
    ],
    threadId: context.threadId,
  };
}
