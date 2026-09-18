import {
  analyseOutboundHtml,
  type CanonicalMessage,
  CommsError,
  collapseWhitespace,
  messageDigest,
  normaliseAddress,
  parseAddressList,
  sha256Hex,
} from '@cloudpixel/comms-core';
import type { RawMessage, SendAsAddress } from '../gmail-api/transport.ts';
import { type GmailHeader, headerValue, headerValues, readParts } from './mime.ts';

/**
 * What `send prepare` needs to know about a draft before anyone is asked to approve it.
 *
 * Two jobs, and they are different. One is the **digest**: a canonical form of everything a recipient would see or
 * receive, so an approval can be bound to this exact content and any later edit voids it. The other is
 * **sendability**: our own drafts carry no HTML the author did not write, but a draft written in Gmail, or by another
 * tool, can carry anything — a beacon, hidden text, a form. An agent may only send what it could have written itself,
 * so anything else is refused here and the person is told to send it from Gmail.
 */

export interface OutboundAttachment {
  filename: string;
  mimeType: string;
  size: number;
  sha256: string;
}

export interface DraftAnalysis {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  threadId: string | undefined;
  inReplyTo: string | undefined;
  references: string[];
  /** The body as the author wrote it — the text part, which is what the preview shows. */
  text: string;
  /** What a recipient would see, from the HTML part when there is one; what the digest is computed over. */
  visibleText: string;
  attachments: OutboundAttachment[];
  /** Every link in the message, full query strings kept. */
  links: string[];
  /** Remote resources inside the verified signature block, which are the user's own and are shown, not refused. */
  signatureResources: string[];
  canonical: CanonicalMessage;
  digest: string;
}

/** Why a draft cannot be sent by an agent. Each one names what to do instead. */
export interface Unsendable {
  reason: string;
  detail: string;
}

const GMAIL_SIGNATURE = /<div[^>]*class="[^"]*gmail_signature[^"]*"[^>]*>([\s\S]*?)<\/div>/i;

/**
 * Removes a signature block from the HTML **only when it is byte-identical to the mailbox's live signature**.
 *
 * The signature is the user's own HTML and often carries a company logo from a remote URL, which the remote-resource
 * rule would otherwise refuse. Exempting it by its marker alone would let anyone smuggle a beacon inside a div with
 * the right class, so the exemption is the whole block matching what Gmail reports for this From address, fetched at
 * prepare time; anything else is analysed like the rest of the message.
 */
export function separateSignature(
  html: string,
  liveSignature: string | undefined,
): { body: string; signature: string | null } {
  if (!liveSignature?.trim()) return { body: html, signature: null };
  const match = GMAIL_SIGNATURE.exec(html);
  if (!match) return { body: html, signature: null };
  const inner = match[1] ?? '';
  if (inner.trim() !== liveSignature.trim()) return { body: html, signature: null };
  return { body: html.replace(match[0], ''), signature: inner };
}

/**
 * Every address under a header name, across **all** instances of it.
 *
 * A message may legitimately carry more than one `Cc:` line, and a reader of only the first would digest a message
 * with fewer recipients than the one that goes out — which is the difference between what was approved and what was
 * sent. Merged and de-duplicated, order preserved.
 */
export function mergedAddresses(headers: readonly GmailHeader[] | null | undefined, name: string): string[] {
  const merged = headerValues(headers, name).flatMap((value) => parseAddressList(value).map((entry) => entry.address));
  return [...new Set(merged)];
}

/**
 * Reads a draft into the form an approval is bound to, and refuses it if an agent could not have written it.
 *
 * `fetchAttachment` is called for every attachment: the digest covers the bytes, not just the name and size, so
 * replacing a file with another of the same length is a different message. Sends are rare and a prepare that reads
 * the attachments once is the cheapest honest answer.
 */
export async function analyseDraft(options: {
  message: RawMessage;
  threadId?: string | undefined;
  sendAs: readonly SendAsAddress[];
  fetchAttachment: (attachmentId: string) => Promise<Buffer>;
}): Promise<{ analysis: DraftAnalysis; refusals: Unsendable[] }> {
  const { message, sendAs } = options;
  const headers = message.payload?.headers ?? [];
  const parts = readParts(message.payload);
  const from = headerValue(headers, 'From') ?? '';
  const fromAddress = normaliseAddress(parseAddressList(from)[0]?.address ?? '');
  const liveSignature = sendAs.find((entry) => normaliseAddress(entry.sendAsEmail) === fromAddress)?.signature;

  // The first part of each kind is the message; a later one is an alternative inside a nested multipart.
  const text = parts.plain[0]?.text ?? '';
  const html = parts.html[0]?.text ?? '';
  const refusals: Unsendable[] = [];
  let visibleText = collapseWhitespace(text);
  let links: string[] = [];
  let signatureResources: string[] = [];

  if (html) {
    const { body, signature } = separateSignature(html, liveSignature);
    const report = analyseOutboundHtml(body);
    visibleText = collapseWhitespace(report.visibleText);
    links = [...new Set(report.urls.map((entry) => entry.url))];
    if (signature) {
      const inSignature = analyseOutboundHtml(signature);
      signatureResources = [...new Set(inSignature.remoteResources)];
      links = [...new Set([...links, ...inSignature.urls.map((entry) => entry.url)])];
    }

    if (report.remoteResources.length > 0) {
      refusals.push({
        reason: 'it loads something from the internet when it is opened',
        detail: report.remoteResources.slice(0, 5).join(', '),
      });
    }
    if (report.hidden.length > 0) {
      refusals.push({
        reason: 'it contains content a recipient would not see',
        detail: report.hidden
          .map((entry) => entry.reason)
          .slice(0, 5)
          .join(', '),
      });
    }
    const formElements = report.forms + report.formFields;
    if (formElements > 0) {
      refusals.push({ reason: 'it contains a form', detail: `${formElements} element(s)` });
    }
    if (report.scripts > 0) {
      refusals.push({ reason: 'it contains a script', detail: `${report.scripts} element(s)` });
    }
    // The text part is what the preview shows and the HTML is what most people read: if they say different things,
    // approving one is not approving the other.
    const plain = collapseWhitespace(text);
    if (plain && visibleText && plain !== visibleText) {
      refusals.push({
        reason: 'its plain-text and HTML parts do not say the same thing',
        detail: `text ${plain.length} characters, HTML ${visibleText.length}`,
      });
    }
  }

  const attachments: OutboundAttachment[] = [];
  for (const attachment of parts.attachments) {
    const bytes = attachment.attachmentId ? await options.fetchAttachment(attachment.attachmentId) : Buffer.alloc(0);
    attachments.push({
      filename: attachment.filename ?? '(unnamed)',
      mimeType: attachment.mimeType ?? 'application/octet-stream',
      size: bytes.length || (attachment.size ?? 0),
      sha256: sha256Hex(bytes),
    });
  }

  const canonical: CanonicalMessage = {
    from: fromAddress,
    to: mergedAddresses(headers, 'To'),
    cc: mergedAddresses(headers, 'Cc'),
    bcc: mergedAddresses(headers, 'Bcc'),
    replyTo: [...new Set([...mergedAddresses(headers, 'Reply-To'), ...mergedAddresses(headers, 'Sender')])],
    subject: headerValue(headers, 'Subject') ?? '',
    threadId: options.threadId,
    inReplyTo: headerValue(headers, 'In-Reply-To'),
    references: (headerValue(headers, 'References') ?? '').split(/\s+/).filter(Boolean),
    visibleText,
    htmlSha256: html ? sha256Hex(html) : undefined,
    textSha256: text ? sha256Hex(text) : undefined,
    attachments,
  };

  const analysis: DraftAnalysis = {
    from,
    to: canonical.to as string[],
    cc: canonical.cc as string[],
    bcc: canonical.bcc as string[],
    replyTo: canonical.replyTo as string[],
    subject: canonical.subject,
    threadId: options.threadId,
    inReplyTo: canonical.inReplyTo,
    references: canonical.references as string[],
    text,
    visibleText,
    attachments,
    links,
    signatureResources,
    canonical,
    digest: messageDigest(canonical),
  };
  return { analysis, refusals };
}

/** The one error for a draft an agent may not send, carrying every reason rather than only the first. */
export function unsendable(refusals: readonly Unsendable[]): CommsError {
  return new CommsError('UNSENDABLE_HTML', `this draft cannot be sent by an agent: ${refusals[0]?.reason}`, {
    hint: 'Review it and send it from Gmail. An agent may only send what it could have written itself.',
    details: { refusals: refusals.map((refusal) => `${refusal.reason} (${refusal.detail})`) },
  });
}
