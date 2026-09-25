import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  type AttachPolicy,
  CommsError,
  checkAttachable,
  decodeHeaderWords,
  defaultAttachDeny,
  expandHome,
  formerNamesOf,
  homeDirectory,
  neutralise,
  parseAddressList,
  readComposeProfile,
  recipientDomains,
  renderMessagePreview,
} from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { buildBody } from '../domain/body.ts';
import {
  type ComposeAttachment,
  composeMessage,
  formatAddress,
  planReply,
  type QuotedOriginal,
  WARN_ATTACHMENT_BYTES,
} from '../domain/compose.ts';
import { headerValue, readParts } from '../domain/mime.ts';
import type { GmailTransport, RawMessage } from '../gmail-api/transport.ts';
import { ownAddresses } from './analyse.ts';
import { type NumberOption, numberOption } from './numbers.ts';
import { oneOf } from './words.ts';

/**
 * Drafts: writing a message, and leaving it where a person can see it.
 *
 * Nothing here sends. A draft is the unit of work an agent produces, and the result carries the preview the user is
 * meant to read — so "show it in full before asking" is what the tool returns, rather than something a skill has to
 * remember to do.
 */

export interface DraftResult {
  inbox: string;
  draftId: string;
  messageId: string;
  threadId: string | undefined;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  /** The message as the user should see it before approving anything. */
  preview: string;
  attachments: Array<{ filename: string; size: number; mimeType: string; source: string }>;
  bytes: number;
  warnings: string[];
  /** What this mailbox's writing profile says, for whoever revises the draft. */
  profile?: string | undefined;
}

export interface UpdateDraftInput extends Omit<DraftInput, 'text'> {
  /** What the message should say. Omit it to keep the body the draft already has. */
  text?: string | undefined;
}

export interface DraftInput {
  to?: string[] | undefined;
  cc?: string[] | undefined;
  bcc?: string[] | undefined;
  subject?: string | undefined;
  /** The body as written. Plain text: the HTML part is generated, so an agent cannot inject markup. */
  text: string;
  /** Local files to attach; each must pass the attachment jail. */
  attach?: string[] | undefined;
  /** Use the mailbox's Gmail signature. */
  signature?: boolean | undefined;
  /** Include the writing profile in the result, for an agent about to revise. */
  includeProfile?: boolean | undefined;
}

async function attachmentsFor(
  context: GmailContext,
  paths: readonly string[],
): Promise<{
  attachments: ComposeAttachment[];
  described: DraftResult['attachments'];
  warnings: string[];
}> {
  if (paths.length === 0) return { attachments: [], described: [], warnings: [] };
  const config = await context.config();
  const home = homeDirectory(context.env);
  const policy: AttachPolicy = {
    roots: config.defaults.attachRoots.map((root) => expandHome(root, home)),
    deny: [...defaultAttachDeny(context.core.paths.configDir, context.env), ...config.defaults.attachDeny],
    // The home the rest of this process uses. Without it the jail falls back to the account's real home, and the
    // rule that never attaches from a dot-folder would be checked against the wrong one.
    home,
  };

  const attachments: ComposeAttachment[] = [];
  const described: DraftResult['attachments'] = [];
  const warnings: string[] = [];
  let total = 0;

  for (const given of paths) {
    const path = resolve(expandHome(given, home));
    // The jail decides: under an allowed root, and not inside anything on the deny list (credentials, dot-files,
    // the config directory itself). The name that goes on the wire is the file's own, never something an agent typed.
    const allowed = await checkAttachable(path, policy);
    const info = await stat(allowed);
    if (!info.isFile()) {
      throw new CommsError('BAD_DATA', `${allowed} is not a file`, { hint: 'Attach files, not directories.' });
    }
    const content = await readFile(allowed);
    total += content.byteLength;
    attachments.push({ filename: basename(allowed), content });
    described.push({
      filename: basename(allowed),
      size: content.byteLength,
      mimeType: 'application/octet-stream',
      source: allowed,
    });
  }

  if (total > WARN_ATTACHMENT_BYTES) {
    warnings.push(
      `${Math.round(total / 1_048_576)} MB of attachments: Gmail's limit is 25 MB and some recipients will not receive it. A link may be better.`,
    );
  }
  return { attachments, described, warnings };
}

/** The signature Gmail holds for the sending address, used byte-for-byte or not at all. */
async function signatureFor(
  context: GmailContext,
  alias: string,
  from: string,
): Promise<{ text: string; html: string } | undefined> {
  const transport = await context.transport(alias);
  const addresses = await transport.listSendAs();
  const match =
    addresses.find((entry) => entry.sendAsEmail.toLowerCase() === from.toLowerCase()) ??
    addresses.find((entry) => entry.isDefault);
  if (!match?.signature) return undefined;
  // The text part of a signature is the HTML with its tags removed; Gmail's own is HTML.
  const text = match.signature
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .trim();
  return { text, html: match.signature };
}

async function profileFor(context: GmailContext, alias: string): Promise<string> {
  const config = await context.config();
  const profile = await readComposeProfile(join(context.core.paths.configDir, 'compose'), {
    platform: 'gmail',
    inbox: alias,
    // So rules written before a rename keep applying to the mailbox they were written for.
    formerInboxes: formerNamesOf(config, 'inbox', alias),
  });
  return profile.text;
}

function warningsFor(input: { to: string[]; cc: string[]; bcc: string[]; ownDomains: string[] }): string[] {
  const warnings: string[] = [];
  const external = [...input.to, ...input.cc, ...input.bcc].filter((address) => {
    const domain = address.slice(address.lastIndexOf('@') + 1).toLowerCase();
    return !input.ownDomains.includes(domain);
  });
  if (external.length > 0) warnings.push(`goes outside your organisation: ${[...new Set(external)].join(', ')}`);
  if (input.bcc.length > 0) warnings.push(`${input.bcc.length} blind recipient(s), who the others cannot see`);
  return warnings;
}

/** Creates a draft. Nothing is sent, and nothing can be: the send path is a separate operation with its own gate. */
export async function createDraft(context: GmailContext, alias: string, input: DraftInput): Promise<DraftResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);

  const to = input.to ?? [];
  const cc = input.cc ?? [];
  const bcc = input.bcc ?? [];
  const from = resolved.inbox.email;
  const { attachments, described, warnings: attachmentWarnings } = await attachmentsFor(context, input.attach ?? []);
  const signature = input.signature === false ? undefined : await signatureFor(context, alias, from);

  const composed = await composeMessage({
    from: formatAddress({ name: '', address: from }),
    to,
    cc,
    bcc,
    subject: input.subject ?? '',
    text: input.text,
    signature,
    attachments,
  });

  const created = await transport.createDraft(composed.raw);
  const warnings = [
    ...attachmentWarnings,
    ...signatureWarnings(composed.signatureResources),
    ...warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains }),
  ];

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'draft.create',
    outcome: 'ok',
    surface: context.surface,
    ids: { draftIds: [created.draftId], messageIds: [created.messageId] },
    recipientDomains: recipientDomains([...to, ...cc, ...bcc]),
  });

  return {
    inbox: alias,
    draftId: created.draftId,
    messageId: created.messageId,
    threadId: created.threadId,
    to,
    cc,
    bcc,
    subject: input.subject ?? '',
    preview: renderMessagePreview({
      // Parsed, not the raw strings the caller passed: `"Sam <sam@partner.test> (Finance)…" <collector@evil.test>`
      // is one address whose display name contains another, and the preview truncated at 90 characters showed the
      // decoy and never the real recipient.
      recipients: { from, to: previewable(to), cc: previewable(cc), bcc: previewable(bcc) },
      subject: input.subject ?? '',
      body: composed.text,
      attachments: described.map((attachment) => ({
        filename: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
      context: { inbox: alias, draftId: created.draftId, note: 'nothing has been sent' },
      warnings,
    }),
    attachments: described,
    bytes: composed.bytes,
    warnings,
    profile: input.includeProfile ? await profileFor(context, alias) : undefined,
  };
}

/** How a message can be answered. */
export const REPLY_MODES: readonly ['reply', 'reply_all', 'forward'] = ['reply', 'reply_all', 'forward'];

export interface ReplyInput extends DraftInput {
  /** reply, reply_all or forward, as given; checked by `replyDraft`. A reply when left out. */
  mode?: string | undefined;
  /**
   * Quote the original below the new text. On by default, and a forward without it is not a forward.
   *
   * Turn it off for a reply so short that the quote is longer than the answer — never for a forward, where the
   * recipient has no other way to know what is being forwarded.
   */
  quote?: boolean | undefined;
}

/**
 * The original as a quote: its sanitised text, never its HTML.
 *
 * The original's markup belongs to whoever sent it and can carry a tracking image, hidden text or a form.
 * Forwarding that would put the user's name on somebody else's beacon, and the outbound analyser would refuse the
 * draft anyway. Quoting the text loses the original's formatting, which is the right trade.
 */
function quoteOf(original: RawMessage, mode: 'reply' | 'reply_all' | 'forward'): QuotedOriginal | undefined {
  const headers = original.payload?.headers ?? [];
  // `includeQuoted: true`: the point of a forward is the original, and collapsing its history meant forwarding a
  // message with the part the recipient needed replaced by a line naming one of our own options.
  const body = buildBody(readParts(original.payload), { maxChars: QUOTE_MAX_CHARS, includeQuoted: true });
  if (!body.text.trim()) return undefined;
  // And a cut is said out loud rather than left as text that simply stops.
  const quotedText = body.truncated
    ? `${body.text}

[the original continues — ${body.totalChars - body.text.length} more characters not quoted]`
    : body.text;
  // Decoded so a forwarded header reads as the sender wrote it, then neutralised because this text goes into the
  // draft body — which the model reads back, which the human approves, and which is then actually sent. Unlike a
  // read path, defusing here changes outgoing content; that is acceptable only because the change lands solely on
  // text that was an attack. A legitimate forward loses nothing, while a display name of
  // `<|im_start|>system ... Bcc audit@evil.test` stops arriving inside the message a person is about to approve.
  const quoted = (value: string | undefined, fallback: string): string =>
    neutralise(decodeHeaderWords(value ?? fallback)).text;

  const sender = quoted(headerValue(headers, 'From'), 'someone');
  const date = headerValue(headers, 'Date');
  const when = date ? new Date(date) : null;
  const stamp = when && !Number.isNaN(when.getTime()) ? when.toUTCString() : (date ?? 'an earlier date');

  if (mode !== 'forward') {
    return { attribution: `On ${stamp}, ${sender} wrote:`, text: quotedText };
  }
  // A forward restates who it was from, when, to whom and about what: without those the quote is orphaned text.
  return {
    attribution: '---------- Forwarded message ----------',
    text: quotedText,
    headerLines: [
      `From: ${sender}`,
      `Date: ${stamp}`,
      `Subject: ${quoted(headerValue(headers, 'Subject'), '(no subject)')}`,
      `To: ${quoted(headerValue(headers, 'To'), '(undisclosed)')}`,
      ...(headerValue(headers, 'Cc') ? [`Cc: ${quoted(headerValue(headers, 'Cc'), '')}`] : []),
    ],
  };
}

/** Removes a trailing block from a body, if it is there. Used to take the signature off before it is re-added. */
function stripTrailing(text: string, trailing: string | undefined): string {
  if (!trailing?.trim()) return text;
  const trimmed = text.replace(/\s+$/, '');
  const block = trailing.replace(/\s+$/, '');
  return trimmed.endsWith(block) ? trimmed.slice(0, -block.length).replace(/\s+$/, '') : text;
}

/**
 * What the mailbox's own signature fetches when the message is opened.
 *
 * Not a refusal — it is the user's signature and a company logo is the ordinary case — but the person approving a
 * message should know that opening it tells someone's server it was opened.
 */
function signatureWarnings(resources: readonly string[]): string[] {
  if (resources.length === 0) return [];
  return [
    `your signature loads ${resources.length} image(s) from the internet when the message is opened: ` +
      resources.slice(0, 3).join(', '),
  ];
}

/** Addresses as they will actually be used, so a display name cannot stand in for the recipient in a preview. */
function previewable(entries: readonly string[]): string[] {
  return entries.flatMap((entry) => {
    const parsed = parseAddressList(entry);
    return parsed.length > 0 ? parsed.map((address) => formatAddress(address)) : [entry];
  });
}

/** How much of an original is quoted. Long enough for context, short enough not to dominate the message. */
const QUOTE_MAX_CHARS = 4000;

/** The attachments already on a draft, fetched by their bytes so an update can put them back. */
async function carriedAttachments(
  transport: GmailTransport,
  messageId: string,
  parts: ReturnType<typeof readParts>,
): Promise<{ attachments: ComposeAttachment[]; described: DraftResult['attachments']; warnings: string[] }> {
  const attachments: ComposeAttachment[] = [];
  const described: DraftResult['attachments'] = [];
  const warnings: string[] = [];
  for (const part of parts.attachments) {
    if (!part.attachmentId || !messageId) continue;
    try {
      const content = await transport.getAttachment(messageId, part.attachmentId);
      const filename = part.filename ?? 'attachment';
      attachments.push({ filename, content, contentType: part.mimeType });
      described.push({ filename, size: content.length, mimeType: part.mimeType, source: 'kept from the draft' });
    } catch {
      // Better to say a file was lost than to save a draft that quietly no longer has it.
      warnings.push(`could not keep the attachment "${part.filename ?? 'attachment'}"; it is no longer on the draft`);
    }
  }
  return { attachments, described, warnings };
}

/** Replies to a message, or forwards it. The recipients are computed, then shown, never assumed. */
export async function replyDraft(
  context: GmailContext,
  alias: string,
  messageId: string,
  input: ReplyInput,
): Promise<DraftResult> {
  // Checked before anything is read, so a word that is not a mode is refused the same way from either surface.
  const mode = oneOf(input.mode, REPLY_MODES, 'a reply mode') ?? 'reply';
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);

  const original = await transport.getMessage(messageId);
  const headers = original.payload?.headers ?? [];

  const plan = planReply(
    {
      from: parseAddressList(headerValue(headers, 'From'))[0] ?? null,
      replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
      to: parseAddressList(headerValue(headers, 'To')),
      cc: parseAddressList(headerValue(headers, 'Cc')),
      // Decoded, not neutralised: this becomes the outgoing subject, so defusing it would alter what is sent.
      // Decoding is still required — the `Re:`/`Fwd:` stripper below cannot see a prefix inside an
      // encoded-word, so a reply to `=?UTF-8?Q?...?=` would have gone out as `Re: =?UTF-8?Q?...?=`, which the
      // recipient's client then shows as the encoded blob rather than the thread it belongs to.
      subject: decodeHeaderWords(headerValue(headers, 'Subject') ?? ''),
      messageIdHeader: headerValue(headers, 'Message-ID'),
      references: (headerValue(headers, 'References') ?? '').split(/\s+/).filter(Boolean),
      threadId: original.threadId ?? '',
    },
    { mode, ownAddresses: await ownAddresses(context, alias), to: input.to },
  );

  const to = input.to ?? plan.to;
  const cc = input.cc ?? plan.cc;
  const bcc = input.bcc ?? [];
  if (to.length === 0 && cc.length === 0 && bcc.length === 0) {
    throw new CommsError('REPLY_INVALID', 'there is nobody to reply to', {
      hint: mode === 'forward' ? 'A forward needs recipients: pass `to`.' : 'Pass `to` explicitly.',
    });
  }

  const from = resolved.inbox.email;
  const { attachments, described, warnings: attachmentWarnings } = await attachmentsFor(context, input.attach ?? []);
  const signature = input.signature === false ? undefined : await signatureFor(context, alias, from);
  const subject = input.subject ?? plan.subject;
  const quoted = input.quote === false ? undefined : quoteOf(original, mode);

  const composed = await composeMessage({
    from: formatAddress({ name: '', address: from }),
    to,
    cc,
    bcc,
    subject,
    text: input.text,
    signature,
    attachments,
    quoted,
    inReplyTo: plan.inReplyTo,
    references: plan.references,
  });

  const created = await transport.createDraft(composed.raw, plan.threadId);
  const senderWarnings: string[] = [];
  const replyTo = parseAddressList(headerValue(headers, 'Reply-To'));
  // **Every** Reply-To address, not just the first. `planReply` makes the whole list the recipients, so an original
  // carrying `Reply-To: sam@partner.test, collector@evil.test` addresses the draft to both — and comparing only the
  // first entry found it equal to `From` and said nothing at all. The added address is the one worth naming.
  const fromAddress = parseAddressList(headerValue(headers, 'From'))[0]?.address;
  if (replyTo.length > 0 && replyTo.some((entry) => entry.address !== fromAddress)) {
    senderWarnings.push(
      `the sender asked for replies to go to ${replyTo.map((entry) => entry.address).join(', ')}, not to the address it came from`,
    );
  }
  const warnings = [
    ...attachmentWarnings,
    ...senderWarnings,
    ...signatureWarnings(composed.signatureResources),
    ...warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains }),
  ];

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: `draft.${mode}`,
    outcome: 'ok',
    surface: context.surface,
    ids: { draftIds: [created.draftId], messageIds: [messageId] },
    recipientDomains: recipientDomains([...to, ...cc, ...bcc]),
  });

  return {
    inbox: alias,
    draftId: created.draftId,
    messageId: created.messageId,
    threadId: created.threadId,
    to,
    cc,
    bcc,
    subject,
    preview: renderMessagePreview({
      // Parsed, not the raw strings the caller passed: `"Sam <sam@partner.test> (Finance)…" <collector@evil.test>`
      // is one address whose display name contains another, and the preview truncated at 90 characters showed the
      // decoy and never the real recipient.
      recipients: { from, to: previewable(to), cc: previewable(cc), bcc: previewable(bcc) },
      subject,
      body: composed.text,
      attachments: described.map((attachment) => ({
        filename: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
      context: { inbox: alias, draftId: created.draftId, note: 'nothing has been sent' },
      warnings,
    }),
    attachments: described,
    bytes: composed.bytes,
    warnings,
    profile: input.includeProfile ? await profileFor(context, alias) : undefined,
  };
}

export interface DraftSummary {
  draftId: string;
  messageId: string;
  threadId: string | undefined;
  to: string[];
  subject: string;
  updatedAt: string | null;
}

export const DRAFT_LIST_LIMIT: NumberOption = { flag: '--limit', arg: 'limit', min: 1 };

/** The drafts in a mailbox. `limit` is as given, and checked before the mailbox is read; twenty when left out. */
export async function listDrafts(context: GmailContext, alias: string, given?: unknown): Promise<DraftSummary[]> {
  const limit = numberOption(context, given, DRAFT_LIST_LIMIT) ?? 20;
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);
  const drafts = await transport.listDrafts(limit);

  const summaries: DraftSummary[] = [];
  for (const draft of drafts) {
    const message = draft.message;
    const headers = message?.payload?.headers ?? [];
    summaries.push({
      draftId: draft.id,
      messageId: message?.id ?? '',
      threadId: message?.threadId ?? undefined,
      to: parseAddressList(headerValue(headers, 'To')).map((entry) => entry.address),
      // Decoded, not neutralised: this becomes the outgoing subject, so defusing it would alter what is sent.
      // Decoding is still required — the `Re:`/`Fwd:` stripper below cannot see a prefix inside an
      // encoded-word, so a reply to `=?UTF-8?Q?...?=` would have gone out as `Re: =?UTF-8?Q?...?=`, which the
      // recipient's client then shows as the encoded blob rather than the thread it belongs to.
      subject: decodeHeaderWords(headerValue(headers, 'Subject') ?? ''),
      updatedAt: message?.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    });
  }
  return summaries;
}

export async function deleteDraft(context: GmailContext, alias: string, draftId: string): Promise<{ draftId: string }> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  await refuseWhileSending(context, resolved.inbox.id, draftId);
  const transport = await context.transport(alias);
  await transport.deleteDraft(draftId);
  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'draft.delete',
    outcome: 'ok',
    surface: context.surface,
    ids: { draftIds: [draftId] },
  });
  return { draftId };
}

/**
 * Replaces the content of a draft that already exists.
 *
 * Gmail gives the draft's message a new id on every save, which is how an edit is noticed later: an approval is
 * bound to the message id it was given, so editing a draft after it has been approved invalidates that approval
 * rather than quietly changing what gets sent.
 */
/**
 * Refuses to change a draft that a send is standing on.
 *
 * Between the final check and `drafts.send` there is a window in which an edit would mean the mail that goes is not
 * the mail that was approved. Our own tools close it here — including two tool calls from the same agent in
 * parallel. What remains is an edit made in Gmail web at that exact moment, and that is documented, not claimed.
 */
async function refuseWhileSending(context: GmailContext, inboxId: string, draftId: string): Promise<void> {
  const sending = await context.core.approvals.list({ inboxId, states: ['sending'] });
  if (sending.some((record) => record.draftId === draftId)) {
    throw new CommsError('APPROVAL_PENDING', 'this draft is being sent right now, so it cannot be changed', {
      hint: 'Wait for the send to finish, then look at the message in Sent.',
      details: { draftId },
    });
  }
}

export async function updateDraft(
  context: GmailContext,
  alias: string,
  draftId: string,
  input: UpdateDraftInput,
): Promise<DraftResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  await refuseWhileSending(context, resolved.inbox.id, draftId);
  const transport = await context.transport(alias);

  const existing = await transport.getDraft(draftId);
  const headers = existing.message?.payload?.headers ?? [];
  // Anything the caller does not restate keeps what the draft already had — and that has to include the body and
  // the attachments, not only the headers. An update that silently emptied a draft of its files was a quiet way to
  // lose work: the caller asked to change one thing and got a different message back.
  const to = input.to ?? parseAddressList(headerValue(headers, 'To')).map((entry) => entry.address);
  const cc = input.cc ?? parseAddressList(headerValue(headers, 'Cc')).map((entry) => entry.address);
  const bcc = input.bcc ?? parseAddressList(headerValue(headers, 'Bcc')).map((entry) => entry.address);
  const subject = input.subject ?? headerValue(headers, 'Subject') ?? '';
  const from = resolved.inbox.email;

  const existingParts = readParts(existing.message?.payload);
  // The body kept from the draft already ends with the signature, because the draft was composed with it. Passing
  // it back through `composeMessage` with a signature would append a second copy, and the next update a third.
  const existingText = existingParts.plain[0]?.text ?? '';
  const keptSignature = await signatureFor(context, alias, resolved.inbox.email);
  const text = input.text ?? stripTrailing(existingText, keptSignature?.text);
  if (!input.text && !text.trim()) {
    throw new CommsError('USAGE', 'this draft has no body, and none was given', {
      hint: 'Pass `text` with what the message should say.',
    });
  }

  // Attachments are carried over by their bytes, because a draft rebuilt from scratch has no other way to keep
  // them. Passing `attach` replaces the set; passing nothing keeps it.
  const carried = input.attach
    ? { attachments: [], described: [], warnings: [] }
    : await carriedAttachments(transport, existing.message?.id ?? '', existingParts);
  const {
    attachments: added,
    described: describedAdded,
    warnings: attachmentWarnings,
  } = await attachmentsFor(context, input.attach ?? []);
  const attachments = [...carried.attachments, ...added];
  const described = [...carried.described, ...describedAdded];
  const signature = input.signature === false ? undefined : keptSignature;
  const inReplyTo = headerValue(headers, 'In-Reply-To');
  const references = (headerValue(headers, 'References') ?? '').split(/\s+/).filter(Boolean);

  const composed = await composeMessage({
    from: formatAddress({ name: '', address: from }),
    to,
    cc,
    bcc,
    subject,
    text,
    signature,
    attachments,
    inReplyTo,
    references,
  });

  const saved = await transport.updateDraft(draftId, composed.raw, existing.message?.threadId ?? undefined);
  const warnings = [
    ...attachmentWarnings,
    ...signatureWarnings(composed.signatureResources),
    ...warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains }),
  ];

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'draft.update',
    outcome: 'ok',
    surface: context.surface,
    ids: { draftIds: [draftId], messageIds: [saved.messageId] },
    recipientDomains: recipientDomains([...to, ...cc, ...bcc]),
  });

  return {
    inbox: alias,
    draftId: saved.draftId,
    messageId: saved.messageId,
    threadId: saved.threadId,
    to,
    cc,
    bcc,
    subject,
    preview: renderMessagePreview({
      // Parsed, not the raw strings the caller passed: `"Sam <sam@partner.test> (Finance)…" <collector@evil.test>`
      // is one address whose display name contains another, and the preview truncated at 90 characters showed the
      // decoy and never the real recipient.
      recipients: { from, to: previewable(to), cc: previewable(cc), bcc: previewable(bcc) },
      subject,
      body: composed.text,
      attachments: described.map((attachment) => ({
        filename: attachment.filename,
        size: attachment.size,
        mimeType: attachment.mimeType,
      })),
      context: { inbox: alias, draftId: saved.draftId, note: 'nothing has been sent' },
      warnings,
    }),
    attachments: described,
    bytes: composed.bytes,
    warnings,
    profile: input.includeProfile ? await profileFor(context, alias) : undefined,
  };
}

/** Reads a draft back, with the preview: what the user would approve if asked now. */
export async function getDraft(context: GmailContext, alias: string, draftId: string): Promise<DraftResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);
  const draft = await transport.getDraft(draftId);
  const message = draft.message;
  const headers = message?.payload?.headers ?? [];
  const parts = readParts(message?.payload);
  const to = parseAddressList(headerValue(headers, 'To')).map((entry) => entry.address);
  const cc = parseAddressList(headerValue(headers, 'Cc')).map((entry) => entry.address);
  const bcc = parseAddressList(headerValue(headers, 'Bcc')).map((entry) => entry.address);
  const subject = headerValue(headers, 'Subject') ?? '';
  const body = parts.plain.map((part) => part.text ?? '').join('\n');
  const attachments = parts.attachments.map((part) => ({
    filename: part.filename ?? '(unnamed)',
    size: part.size,
    mimeType: part.mimeType,
    source: 'in the draft',
  }));
  const warnings = warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains });

  return {
    inbox: alias,
    draftId,
    messageId: message?.id ?? '',
    threadId: message?.threadId ?? undefined,
    to,
    cc,
    bcc,
    subject,
    preview: renderMessagePreview({
      recipients: { from: resolved.inbox.email, to, cc, bcc },
      subject,
      body,
      attachments,
      context: { inbox: alias, draftId, note: 'nothing has been sent' },
      warnings,
    }),
    attachments,
    bytes: 0,
    warnings,
  };
}
