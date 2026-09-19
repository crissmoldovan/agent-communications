import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CommsError,
  createUniqueFile,
  decodeHeaderWords,
  ensurePrivateDir,
  expandHome,
  homeDirectory,
  neutralise,
  parseAddressList,
  resolveInsideRoot,
  safeFilename,
  slug,
} from '@cloudpixel/comms-core';
import type { GmailContext } from '../context.ts';
import { headerValue, readParts } from '../domain/mime.ts';
import { compileQuery } from '../domain/query.ts';
import { attachmentRisks } from './read.ts';
import { resolveInboxes } from './search.ts';

/**
 * Finding and downloading attachments.
 *
 * Nothing here is ever opened or executed, and nothing is written outside the downloads root. Files arrive from
 * strangers: a name can contain path separators, a right-to-left override that makes `exe` look like `pdf`, or the
 * name of a file already there. So every component of the path is rebuilt from a safe form, the write is `O_EXCL`
 * and refuses to follow a link, and the real path is checked against the root again after resolution.
 */

export interface AttachmentRow {
  inbox: string;
  messageId: string;
  threadId: string;
  partId: string;
  attachmentId: string | undefined;
  filename: string;
  mimeType: string;
  size: number;
  date: string | null;
  from: string | null;
  subject: string;
  riskFlags: string[];
}

export interface FindAttachmentsOptions {
  inboxes?: string[] | 'all' | undefined;
  /** Extra Gmail syntax, combined with the filters below. */
  query?: string | undefined;
  from?: string | undefined;
  filename?: string | undefined;
  after?: string | undefined;
  before?: string | undefined;
  minBytes?: number | undefined;
  maxBytes?: number | undefined;
  mimeType?: string | undefined;
  limit?: number | undefined;
}

export interface FindAttachmentsResult {
  query: string;
  rows: AttachmentRow[];
  /** Attachments held in Drive rather than in the message: there is no Drive permission, so they cannot be fetched. */
  driveLinks: number;
  errors: Array<{ inbox: string; code: string; message: string }>;
  complete: boolean;
}

/** Builds the Gmail query for the filters, so a caller does not have to know the syntax. */
export function attachmentQuery(options: FindAttachmentsOptions): string {
  const parts = ['has:attachment'];
  if (options.from) parts.push(`from:${options.from}`);
  if (options.filename) parts.push(`filename:${options.filename}`);
  if (options.after) parts.push(`after:${options.after}`);
  if (options.before) parts.push(`before:${options.before}`);
  if (options.minBytes) parts.push(`larger:${options.minBytes}`);
  if (options.maxBytes) parts.push(`smaller:${options.maxBytes}`);
  if (options.query) parts.push(options.query);
  return parts.join(' ');
}

export async function findAttachments(
  context: GmailContext,
  options: FindAttachmentsOptions = {},
): Promise<FindAttachmentsResult> {
  const config = await context.config();
  const aliases = await resolveInboxes(context, options.inboxes);
  const query = compileQuery(attachmentQuery(options), { timezone: config.defaults.timezone }).compiled;
  const limit = Math.min(Math.max(1, options.limit ?? 25), 100);

  const rows: AttachmentRow[] = [];
  const errors: FindAttachmentsResult['errors'] = [];
  let driveLinks = 0;

  for (const alias of aliases) {
    try {
      const resolved = await context.inbox(alias);
      await context.requireCapability(resolved, 'read');
      const transport = await context.transport(alias);
      const page = await transport.listMessages({ query, maxResults: limit });
      for (const entry of page.ids) {
        if (rows.length >= limit) break;
        const message = await transport.getMessageMetadata(entry.id);
        const headers = message.payload?.headers ?? [];
        const parts = readParts(message.payload);
        const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
        const from = parseAddressList(headerValue(headers, 'From'))[0]?.address ?? null;
        const subject = headerValue(headers, 'Subject') ?? '';
        for (const part of parts.attachments) {
          if (part.disposition === 'inline' && !part.filename) continue;
          const filename = part.filename ?? '(unnamed)';
          if (options.mimeType && !part.mimeType.includes(options.mimeType.toLowerCase())) continue;
          if (options.minBytes && part.size < options.minBytes) continue;
          if (options.maxBytes && part.size > options.maxBytes) continue;
          if (!part.attachmentId) {
            // A Drive link is a link in the body, not bytes in the message.
            driveLinks += 1;
            continue;
          }
          rows.push({
            inbox: alias,
            messageId: message.id ?? entry.id,
            threadId: message.threadId ?? entry.threadId ?? '',
            partId: part.partId,
            attachmentId: part.attachmentId,
            // Sender-controlled, and neutralised for the same reason `read.ts` neutralises them: a row leaves this
            // function as a bare string in a structured result, outside any envelope, and an attachment name or a
            // subject can hold arbitrary bytes. This path is reached by an agent triaging mail on its own
            // initiative, so the sender does not need the user to open anything.
            filename: neutralise(decodeHeaderWords(filename)).text,
            mimeType: part.mimeType,
            size: part.size,
            date,
            from,
            subject: neutralise(decodeHeaderWords(subject).slice(0, 120)).text,
            // Flagged on the name the file would actually be written under, not the one the sender sent:
            // `invoice.exe ` is stripped to `invoice.exe` on the way to disk, and the `$`-anchored extension checks
            // do not match the trailing space, so the executable was written and the flag was not raised.
            riskFlags: attachmentRisks(safeFilename(filename), part.mimeType),
          });
        }
      }
    } catch (error) {
      const failure = error as CommsError;
      errors.push({ inbox: alias, code: failure.code ?? 'UNEXPECTED', message: failure.message });
    }
  }

  rows.sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''));
  return { query, rows: rows.slice(0, limit), driveLinks, errors, complete: errors.length === 0 };
}

export interface DownloadedFile {
  path: string;
  filename: string;
  size: number;
  sha256: string;
  mimeType: string;
  messageId: string;
  /** True when an identical file (same hash) had already been written in this batch. */
  duplicate: boolean;
  riskFlags: string[];
}

export interface DownloadResult {
  directory: string;
  files: DownloadedFile[];
  skipped: Array<{ messageId: string; partId: string; reason: string }>;
  manifestPath: string;
  totalBytes: number;
}

export interface DownloadOptions {
  /** A subdirectory of the downloads root. Never an absolute path from an agent. */
  out?: string | undefined;
  maxFiles?: number | undefined;
  maxBytes?: number | undefined;
}

export const DEFAULT_MAX_FILES = 50;
export const DEFAULT_MAX_BYTES: number = 500 * 1024 * 1024;

/** The downloads root: `~/Downloads/agent-communications` unless the config says otherwise. */
export async function downloadsRoot(context: GmailContext): Promise<string> {
  const config = await context.config();
  const configured = config.defaults.downloadsDir;
  const root = configured ? expandHome(configured, homeDirectory(context.env)) : context.core.paths.downloadsDir;
  await ensurePrivateDir(root);
  return root;
}

/**
 * Downloads specific attachments. The attachment id is resolved fresh from the message each time: Gmail's ids are
 * reported to change between fetches, and a stale one fails in a way that looks like the file is gone.
 */
export async function downloadAttachments(
  context: GmailContext,
  alias: string,
  targets: Array<{ messageId: string; partId?: string | undefined; filename?: string | undefined }>,
  options: DownloadOptions = {},
): Promise<DownloadResult> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);

  const root = await downloadsRoot(context);
  // Over MCP `out` is a relative subpath and nothing else; the jail check below is what enforces that.
  const directory = await resolveInsideRoot(root, join(alias, options.out ?? ''));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  const maxFiles = Math.min(options.maxFiles ?? DEFAULT_MAX_FILES, 200);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const files: DownloadedFile[] = [];
  const skipped: DownloadResult['skipped'] = [];
  const seenHashes = new Map<string, string>();
  let totalBytes = 0;

  for (const target of targets) {
    const message = await transport.getMessage(target.messageId);
    const parts = readParts(message.payload);
    const headers = message.payload?.headers ?? [];
    // Which attachments this target names. `partId` picks exactly one; a `filename` picks the one with that name;
    // naming neither means every attachment on the message. That last case used to fall through to
    // `find(c => c.filename === target.filename)` with `filename` undefined — which matches an unnamed inline part,
    // a signature image say, and otherwise nothing at all. So the MCP tool, whose `partId` is optional and
    // documented as *narrowing* to one attachment, downloaded the one thing nobody asked for, or reported "no such
    // attachment" for a message plainly carrying one.
    const chosen = target.partId
      ? parts.attachments.filter((candidate) => candidate.partId === target.partId)
      : target.filename !== undefined
        ? parts.attachments.filter((candidate) => candidate.filename === target.filename)
        : parts.attachments;

    if (chosen.length === 0) {
      skipped.push({ messageId: target.messageId, partId: target.partId ?? '', reason: 'no such attachment' });
      continue;
    }

    for (const part of chosen) {
      if (files.length >= maxFiles) {
        skipped.push({
          messageId: target.messageId,
          partId: part.partId,
          reason: `more than ${maxFiles} files`,
        });
        continue;
      }

      if (!part?.attachmentId) {
        skipped.push({
          messageId: target.messageId,
          partId: target.partId ?? '',
          reason: part ? 'this part holds no downloadable bytes (a Drive link, perhaps)' : 'no such attachment',
        });
        continue;
      }
      if (totalBytes + part.size > maxBytes) {
        skipped.push({
          messageId: target.messageId,
          partId: part.partId,
          reason: `more than ${maxBytes} bytes in one batch`,
        });
        continue;
      }

      const bytes = await transport.getAttachment(target.messageId, part.attachmentId);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const existing = seenHashes.get(sha256);
      if (existing) {
        files.push({
          path: existing,
          filename: safeFilename(part.filename ?? 'attachment'),
          size: bytes.byteLength,
          sha256,
          mimeType: part.mimeType,
          messageId: target.messageId,
          duplicate: true,
          riskFlags: attachmentRisks(part.filename ?? '', part.mimeType),
        });
        continue;
      }

      // One folder per message, named from facts about it — never from anything the sender controls directly.
      const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString().slice(0, 10) : 'undated';
      const sender = slug(parseAddressList(headerValue(headers, 'From'))[0]?.address ?? 'unknown', 30, 'unknown');
      const subject = slug(headerValue(headers, 'Subject') ?? '', 40, 'no-subject');
      const folder = await resolveInsideRoot(root, join(alias, options.out ?? '', `${date}_${sender}_${subject}`));
      await mkdir(folder, { recursive: true, mode: 0o700 });

      const { path, handle } = await createUniqueFile(folder, safeFilename(part.filename ?? 'attachment'));
      try {
        await handle.writeFile(bytes);
      } finally {
        await handle.close();
      }
      seenHashes.set(sha256, path);
      totalBytes += bytes.byteLength;
      files.push({
        path,
        filename: safeFilename(part.filename ?? 'attachment'),
        size: bytes.byteLength,
        sha256,
        mimeType: part.mimeType,
        messageId: target.messageId,
        duplicate: false,
        riskFlags: attachmentRisks(part.filename ?? '', part.mimeType),
      });
    }
  }

  const manifestPath = join(directory, 'manifest.json');
  await writeFile(
    manifestPath,
    `${JSON.stringify({ at: context.now().toISOString(), inbox: alias, files, skipped, totalBytes }, null, 2)}\n`,
    { mode: 0o600 },
  );

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'attachments.download',
    outcome: 'ok',
    surface: context.surface,
    ids: { messageIds: targets.map((target) => target.messageId) },
    reason: `${files.length} file(s), ${totalBytes} bytes`,
  });

  return { directory, files, skipped, manifestPath, totalBytes };
}
