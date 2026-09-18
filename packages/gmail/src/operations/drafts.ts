import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import {
  type AttachPolicy,
  CommsError,
  checkAttachable,
  defaultAttachDeny,
  expandHome,
  parseAddressList,
  readComposeProfile,
  recipientDomains,
  renderMessagePreview,
} from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';
import {
  type ComposeAttachment,
  composeMessage,
  formatAddress,
  planReply,
  WARN_ATTACHMENT_BYTES,
} from '../domain/compose.ts';
import { headerValue, readParts } from '../domain/mime.ts';
import { ownAddresses } from './analyse.ts';

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
  const home = context.env.HOME ?? '';
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
  const profile = await readComposeProfile(join(context.core.paths.configDir, 'compose'), {
    platform: 'gmail',
    inbox: alias,
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
  const warnings = [...attachmentWarnings, ...warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains })];

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
      recipients: { from, to, cc, bcc },
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

export interface ReplyInput extends DraftInput {
  mode?: 'reply' | 'reply_all' | 'forward' | undefined;
}

/** Replies to a message, or forwards it. The recipients are computed, then shown, never assumed. */
export async function replyDraft(
  context: GmailContext,
  alias: string,
  messageId: string,
  input: ReplyInput,
): Promise<DraftResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);

  const original = await transport.getMessage(messageId);
  const headers = original.payload?.headers ?? [];
  const mode = input.mode ?? 'reply';

  const plan = planReply(
    {
      from: parseAddressList(headerValue(headers, 'From'))[0] ?? null,
      replyTo: parseAddressList(headerValue(headers, 'Reply-To')),
      to: parseAddressList(headerValue(headers, 'To')),
      cc: parseAddressList(headerValue(headers, 'Cc')),
      subject: headerValue(headers, 'Subject') ?? '',
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

  const composed = await composeMessage({
    from: formatAddress({ name: '', address: from }),
    to,
    cc,
    bcc,
    subject,
    text: input.text,
    signature,
    attachments,
    inReplyTo: plan.inReplyTo,
    references: plan.references,
  });

  const created = await transport.createDraft(composed.raw, plan.threadId);
  const senderWarnings: string[] = [];
  const replyTo = parseAddressList(headerValue(headers, 'Reply-To'));
  if (replyTo.length > 0 && replyTo[0]?.address !== parseAddressList(headerValue(headers, 'From'))[0]?.address) {
    senderWarnings.push(
      `the sender asked for replies to go to ${replyTo.map((entry) => entry.address).join(', ')}, not to the address it came from`,
    );
  }
  const warnings = [
    ...attachmentWarnings,
    ...senderWarnings,
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
      recipients: { from, to, cc, bcc },
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

export async function listDrafts(context: GmailContext, alias: string, limit = 20): Promise<DraftSummary[]> {
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
      subject: headerValue(headers, 'Subject') ?? '',
      updatedAt: message?.internalDate ? new Date(Number(message.internalDate)).toISOString() : null,
    });
  }
  return summaries;
}

export async function deleteDraft(context: GmailContext, alias: string, draftId: string): Promise<{ draftId: string }> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
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
export async function updateDraft(
  context: GmailContext,
  alias: string,
  draftId: string,
  input: DraftInput,
): Promise<DraftResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'draft');
  const transport = await context.transport(alias);

  const existing = await transport.getDraft(draftId);
  const headers = existing.message?.payload?.headers ?? [];
  // Anything the caller does not restate keeps what the draft already had.
  const to = input.to ?? parseAddressList(headerValue(headers, 'To')).map((entry) => entry.address);
  const cc = input.cc ?? parseAddressList(headerValue(headers, 'Cc')).map((entry) => entry.address);
  const bcc = input.bcc ?? parseAddressList(headerValue(headers, 'Bcc')).map((entry) => entry.address);
  const subject = input.subject ?? headerValue(headers, 'Subject') ?? '';
  const from = resolved.inbox.email;

  const { attachments, described, warnings: attachmentWarnings } = await attachmentsFor(context, input.attach ?? []);
  const signature = input.signature === false ? undefined : await signatureFor(context, alias, from);
  const inReplyTo = headerValue(headers, 'In-Reply-To');
  const references = (headerValue(headers, 'References') ?? '').split(/\s+/).filter(Boolean);

  const composed = await composeMessage({
    from: formatAddress({ name: '', address: from }),
    to,
    cc,
    bcc,
    subject,
    text: input.text,
    signature,
    attachments,
    inReplyTo,
    references,
  });

  const saved = await transport.updateDraft(draftId, composed.raw, existing.message?.threadId ?? undefined);
  const warnings = [...attachmentWarnings, ...warningsFor({ to, cc, bcc, ownDomains: resolved.inbox.internalDomains })];

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
      recipients: { from, to, cc, bcc },
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
