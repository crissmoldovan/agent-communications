import { randomBytes } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import {
  analyseOutboundHtml,
  type CliHandoffs,
  CommsError,
  canonicalAddress,
  canonicalJson,
  checkAttachable,
  collapseWhitespace,
  defaultAttachDeny,
  domainOf,
  homeDirectory,
  isControl,
  isInvisible,
  safeFilename,
  sha256Hex,
} from '@agentcomms/core';

/**
 * One outbound email, exactly as it will be sent — validated, and bound to a digest.
 *
 * The send gate's whole promise rests on this: **what the person approves is what Resend receives.** So the message is
 * built once, at prepare, from what the agent asked for; everything a recipient could see is in the digest; and the
 * request execute sends is built from this stored form, never from anything passed at execute time.
 *
 * Two things are deliberately not in the digest, because they are derived from the approval after it exists: the
 * `Idempotency-Key` header and the `agentcomms_approval` tag. Both are the approval id, and the guard refuses a send
 * that does not carry it in both places.
 */

/**
 * Above this many unique recipients a send needs a person at a terminal, whatever the account's send policy says —
 * the mail counterpart of Slack's @channel. Not a setting: the contract allows no new safety settings.
 */
export const REACH_CONFIRM_THRESHOLD = 10;
/** Resend accepts at most 50 addresses in `to`; one email to more than 50 people is not a one-off email. */
export const MAX_RECIPIENTS = 50;
/** Resend's limit is 40 MB of attachments per email after Base64 encoding. */
export const MAX_ATTACHMENT_BASE64_BYTES: number = 40 * 1024 * 1024;
/** Emails can be scheduled up to 30 days ahead. */
export const MAX_SCHEDULE_MS: number = 30 * 24 * 60 * 60 * 1000;

export interface SendInput {
  from: string;
  to: readonly string[];
  cc?: readonly string[] | undefined;
  bcc?: readonly string[] | undefined;
  subject: string;
  text?: string | undefined;
  html?: string | undefined;
  /** Local paths, each checked against the attachment jail. */
  attachments?: readonly string[] | undefined;
  replyTo?: readonly string[] | undefined;
  /** The Message-ID of the email this replies to, as `<…@…>`. */
  inReplyTo?: string | undefined;
  references?: readonly string[] | undefined;
  /** ISO 8601 with a time zone, in the future, at most 30 days ahead. */
  scheduledAt?: string | undefined;
}

export interface OutboundAttachment {
  /** Where the bytes are read from, again, at execute. Not in the digest: the bytes' hash is. */
  path: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface OutboundMessage {
  /** `Name <address>` or a bare address, as it will appear. */
  from: string;
  fromAddress: string;
  fromDomain: string;
  to: string[];
  cc: string[];
  bcc: string[];
  replyTo: string[];
  subject: string;
  /** The text part exactly as sent. */
  text: string;
  /** The HTML part exactly as sent, or null. */
  html: string | null;
  attachments: OutboundAttachment[];
  inReplyTo: string | null;
  references: string[];
  scheduledAt: string | null;
}

export interface BuiltMessage {
  message: OutboundMessage;
  /** Every link in the message, with its full query string. */
  links: string[];
  /** Things a person should see before approving that are not refusals. */
  warnings: string[];
}

const ADDRESS = /^[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MESSAGE_ID = /^<[^<>\s@]+@[^<>\s@]+>$/;
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;

function bad(message: string, hint?: string): CommsError {
  return new CommsError('BAD_DATA', message, hint === undefined ? {} : { hint });
}

/** A bare address, checked and canonicalised. Display names are only accepted on From. */
function address(value: string, field: string): string {
  const trimmed = value.trim();
  if (!ADDRESS.test(trimmed)) {
    throw bad(`${field} contains a value that is not a bare email address`, 'Give bare addresses.');
  }
  return canonicalAddress(trimmed);
}

function list(values: readonly string[] | undefined, field: string): string[] {
  const out: string[] = [];
  for (const value of values ?? []) {
    const canonical = address(value, field);
    if (!out.includes(canonical)) out.push(canonical);
  }
  return out;
}

/** A header-bound text: no control character at all, no invisible one, not empty when required. */
function headerText(value: string, field: string, max: number): string {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (isControl(code) || code === 0x0a || code === 0x09 || isInvisible(code)) {
      throw bad(`${field} contains a control or invisible character (U+${code.toString(16).toUpperCase()})`);
    }
  }
  const trimmed = value.trim();
  if ([...trimmed].length > max) throw bad(`${field} is longer than ${max} characters`);
  return trimmed;
}

function parseFrom(raw: string): { from: string; fromAddress: string; fromDomain: string } {
  const value = raw.trim();
  const angled = /^(.*)<([^<>]+)>$/.exec(value);
  const bare = angled ? (angled[2] ?? '') : value;
  const fromAddress = address(bare, 'from');
  const fromDomain = domainOf(fromAddress) ?? '';
  if (!angled) return { from: fromAddress, fromAddress, fromDomain };
  const name = headerText((angled[1] ?? '').trim().replace(/^"(.*)"$/, '$1'), 'the From name', 100);
  if (/[<>"@,;]/.test(name)) throw bad('the From name may not contain < > " @ , or ;');
  return { from: name ? `${name} <${fromAddress}>` : fromAddress, fromAddress, fromDomain };
}

/** A body: controls other than newline and tab are refused, invisible characters are counted for a warning. */
function bodyText(value: string): { text: string; invisible: number } {
  const text = value.replace(/\r\n/g, '\n');
  let invisible = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    if (isControl(code)) throw bad(`the text contains a control character (U+${code.toString(16).toUpperCase()})`);
    if (isInvisible(code)) invisible += 1;
  }
  return { text, invisible };
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.ics': 'text/calendar',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

export interface AttachPolicyInput {
  configDir: string;
  env: NodeJS.ProcessEnv;
  roots: readonly string[];
  deny: readonly string[];
  /** The context's handoffs, for the command the jail's refusal names: core's `attach roots add`, located from here. */
  handoffs: CliHandoffs;
}

/** Reads an attachment through core's attachment jail, and says exactly what it is. */
export async function readAttachment(
  path: string,
  policy: AttachPolicyInput,
): Promise<{ attachment: OutboundAttachment; bytes: Uint8Array }> {
  const home = homeDirectory(policy.env);
  const real = await checkAttachable(path, {
    roots: [...policy.roots],
    deny: [...defaultAttachDeny(policy.configDir, policy.env), ...policy.deny],
    home,
    handoffs: policy.handoffs,
  });
  const info = await stat(real);
  if (info.size > MAX_ATTACHMENT_BASE64_BYTES) throw bad(`${basename(real)} is larger than Resend accepts`);
  const bytes = new Uint8Array(await readFile(real));
  const filename = safeFilename(basename(real));
  return {
    attachment: {
      path: real,
      filename,
      contentType: CONTENT_TYPES[extname(filename).toLowerCase()] ?? 'application/octet-stream',
      size: bytes.byteLength,
      sha256: sha256Hex(bytes),
    },
    bytes,
  };
}

function linksInText(text: string): string[] {
  return [...new Set(text.match(/\bhttps?:\/\/[^\s<>"')\]]+/gi) ?? [])];
}

/** Builds and checks the outbound message. Refuses anything an agent could not show a person in full. */
export async function buildMessage(
  input: SendInput,
  options: { now: Date; attach: AttachPolicyInput },
): Promise<BuiltMessage> {
  const warnings: string[] = [];
  const { from, fromAddress, fromDomain } = parseFrom(input.from);
  const to = list(input.to, 'to');
  const cc = list(input.cc, 'cc');
  const bcc = list(input.bcc, 'bcc');
  const replyTo = list(input.replyTo, 'reply-to');
  if (to.length === 0) throw bad('an email needs at least one address in `to`');
  const reach = uniqueRecipients({ to, cc, bcc });
  if (reach.length > MAX_RECIPIENTS) {
    throw bad(`this email reaches ${reach.length} people; one email may reach at most ${MAX_RECIPIENTS}`);
  }
  const listed = to.length + cc.length + bcc.length;
  if (listed > reach.length)
    warnings.push(`${listed - reach.length} address(es) appear in more than one of To, Cc and Bcc`);

  const subject = headerText(input.subject, 'the subject', 998);
  if (subject === '') throw bad('an email needs a subject');

  if ((input.text === undefined || input.text === '') && (input.html === undefined || input.html === '')) {
    throw bad('an email needs a text or an HTML body');
  }
  let text = '';
  let invisible = 0;
  if (input.text !== undefined && input.text !== '') ({ text, invisible } = bodyText(input.text));
  let html: string | null = null;
  const links: string[] = [];
  if (input.html !== undefined && input.html !== '') {
    const report = analyseOutboundHtml(input.html);
    const problems: string[] = [];
    if (report.remoteResources.length > 0) {
      problems.push(`it loads ${report.remoteResources.length} thing(s) from the internet when opened`);
    }
    const images = imagesIn(input.html, report.urls);
    if (images > 0) problems.push(`it shows ${images} image(s) or embedded object(s) the preview cannot`);
    if (report.hidden.length > 0) problems.push(`${report.hidden.length} part(s) a reader would not see`);
    if (report.forms + report.formFields > 0) problems.push('it has form elements');
    if (report.scripts > 0) problems.push('it has scripts');
    // Markup that makes the recipient read other text, or the same text in another order, than the text compared:
    // a stylesheet's `content`, `<bdo>`, a bidi override and the rest, as core's analyser names them.
    const alterations = [...new Set(report.alterations.map((entry) => entry.reason))];
    for (const reason of alterations.slice(0, 3)) problems.push(`it has ${reason}`);
    if (alterations.length > 3) problems.push(`and ${alterations.length - 3} more thing(s) that change what it shows`);
    if (text !== '' && collapseWhitespace(report.comparableText) !== collapseWhitespace(text)) {
      problems.push('what it shows is not the text part');
    }
    if (problems.length > 0) {
      throw new CommsError('UNSENDABLE_HTML', `this HTML cannot be sent by an agent: ${problems.join('; ')}`, {
        hint: 'Send plain text, or simple HTML whose visible text is exactly the text part, in the same order: no images, styles beyond simple formatting, hidden parts, forms or scripts.',
      });
    }
    html = input.html;
    if (text === '') ({ text, invisible } = bodyText(report.comparableText));
    for (const url of report.urls) if (!links.includes(url.url)) links.push(url.url);
    warnings.push(
      `HTML part: ${html.length} characters, sha256 ${sha256Hex(html).slice(0, 12)}…; it shows exactly the text above`,
    );
  }
  for (const url of linksInText(text)) if (!links.includes(url)) links.push(url);
  if (invisible > 0) warnings.push(`the text contains ${invisible} invisible character(s), shown as <U+…>`);

  const attachments: OutboundAttachment[] = [];
  let base64 = 0;
  for (const path of input.attachments ?? []) {
    const { attachment } = await readAttachment(path, options.attach);
    base64 += Math.ceil(attachment.size / 3) * 4;
    attachments.push(attachment);
  }
  if (base64 > MAX_ATTACHMENT_BASE64_BYTES) throw bad('the attachments are larger than Resend accepts (40 MB encoded)');

  let inReplyTo: string | null = null;
  if (input.inReplyTo !== undefined && input.inReplyTo !== '') {
    inReplyTo = input.inReplyTo.trim();
    if (!MESSAGE_ID.test(inReplyTo)) throw bad('In-Reply-To must be a Message-ID, like <id@example.com>');
  }
  const references = (input.references ?? []).map((value) => value.trim()).filter(Boolean);
  for (const reference of references) {
    if (!MESSAGE_ID.test(reference)) throw bad(`References: "${reference.slice(0, 80)}" is not a Message-ID`);
  }
  if (inReplyTo !== null && !references.includes(inReplyTo)) references.push(inReplyTo);

  let scheduledAt: string | null = null;
  if (input.scheduledAt !== undefined && input.scheduledAt !== '') {
    const raw = input.scheduledAt.trim();
    const at = ISO_WITH_ZONE.test(raw) ? new Date(raw) : null;
    if (!at || Number.isNaN(at.getTime())) {
      throw bad(
        'scheduledAt must be an ISO 8601 time with a zone, like 2026-10-01T09:00:00Z',
        'Natural language is not accepted: the preview has to show one exact time.',
      );
    }
    const ahead = at.getTime() - options.now.getTime();
    if (ahead < 60_000) throw bad('scheduledAt must be at least a minute in the future');
    if (ahead > MAX_SCHEDULE_MS) throw bad('Resend schedules at most 30 days ahead');
    scheduledAt = at.toISOString();
  }

  return {
    message: {
      from,
      fromAddress,
      fromDomain,
      to,
      cc,
      bcc,
      replyTo,
      subject,
      text,
      html,
      attachments,
      inReplyTo,
      references,
      scheduledAt,
    },
    links,
    warnings,
  };
}

/** Everyone the email reaches, once each — BCC included. */
export function uniqueRecipients(message: Pick<OutboundMessage, 'to' | 'cc' | 'bcc'>): string[] {
  return [...new Set([...message.to, ...message.cc, ...message.bcc])];
}

/**
 * Elements that show a recipient something that is not text: images, SVG, media, frames, embedded objects — and
 * `link`, which pulls a stylesheet in. Matched on the source rather than on what a parser makes of it, so a spelling
 * the analyser does not know (`xlink:href`, say) is refused all the same; a false match only refuses HTML, and plain
 * text is always there.
 */
const IMAGE_ELEMENT = /<(?:img|image|picture|svg|video|audio|object|embed|iframe|frame|canvas|link)\b/gi;
/** Where a URL is shown or loaded on open, whatever its scheme — `data:` and `cid:` as much as `https:`. */
const SHOWN_ON_OPEN = /\[(?:src|srcset|background|poster|data|style)\]$|^style block$/;

/**
 * How many images, or other things a preview cannot show, the HTML carries. The analyser counts only what a mail
 * client fetches from the internet; an image inlined as `data:` or attached as `cid:` fetches nothing and still puts
 * pixels in front of the recipient — a bank detail, say — that the approver never saw. So none are sent, as the
 * refusal's hint has always said.
 */
function imagesIn(html: string, urls: readonly { where: string; url: string }[]): number {
  const elements = html.match(IMAGE_ELEMENT)?.length ?? 0;
  return elements + urls.filter((entry) => SHOWN_ON_OPEN.test(entry.where)).length;
}

/** The digest an approval is bound to: everything a recipient can see or that decides who receives it. */
export function digestOf(message: OutboundMessage): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      from: message.from,
      to: message.to,
      cc: message.cc,
      bcc: message.bcc,
      replyTo: message.replyTo,
      subject: message.subject,
      text: message.text,
      html: message.html === null ? null : sha256Hex(message.html),
      attachments: message.attachments.map(({ filename, contentType, size, sha256 }) => ({
        filename,
        contentType,
        size,
        sha256,
      })),
      inReplyTo: message.inReplyTo,
      references: message.references,
      scheduledAt: message.scheduledAt,
    }),
  );
}

/** A fresh id for a prepared message's file: `rp_` + 26 characters. */
export function newPreparedId(): string {
  const alphabet = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const bytes = randomBytes(26);
  let out = 'rp_';
  for (const byte of bytes) out += alphabet[byte & 31];
  return out;
}

export const PREPARED_ID_PATTERN: RegExp = /^rp_[0-9A-HJKMNP-TV-Z]{26}$/;
