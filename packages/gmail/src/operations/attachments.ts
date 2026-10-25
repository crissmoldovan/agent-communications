import { createHash } from 'node:crypto';
import { type FileHandle, rm } from 'node:fs/promises';
import { basename } from 'node:path';
import {
  type ActivityDetail,
  type ActivityItem,
  askWhereToSave,
  CommsError,
  checkDownloadAnswer,
  createSavedFile,
  type DestinationQuestion,
  type DownloadAnswer,
  type DownloadRequest,
  decodeHeaderWords,
  downloadRecordPath,
  effectiveChangePolicy,
  ensurePrivateDir,
  expandHome,
  fileWarnings,
  homeDirectory,
  type InternetMark,
  type InternetMarkKind,
  isPlainFileName,
  markFromInternet,
  newBoundary,
  parseAddressList,
  type RenameReason,
  type SaveChoice,
  savedName,
  saveFailure,
  saveFolders,
  settleDestination,
  slug,
  type WarnedFile,
  writeFileAtomic,
} from '@agentcomms/core';
import { itemOf, plain, recorded } from '../activity.ts';
import type { GmailContext } from '../context.ts';
import { type DecodedPart, headerValue, readParts } from '../domain/mime.ts';
import { compileQuery } from '../domain/query.ts';
import {
  addressField,
  type FieldEnvelope,
  filenameField,
  mimeTypeField,
  wrapField,
} from '../domain/untrusted-fields.ts';
import { type NumberOption, numberOption } from './numbers.ts';
import { attachmentRisks } from './read.ts';
import { resolveInboxes } from './search.ts';

/**
 * Finding and downloading attachments.
 *
 * Nothing here is ever opened or executed, and nothing is saved until the person has said where. Files arrive from
 * strangers: a name can contain path separators, a right-to-left override that makes `exe` look like `pdf`, a leading
 * dot that makes it a project's configuration, the name of a file already there — or a sentence. So a download asks
 * first (core's `save-destination.ts`), and saves only into the folder the person chose, under the name the sender
 * gave the file made safe by `savedName` — with `.download` after it unless its extension is one that is only ever
 * opened — and marks it as downloaded from the internet; the write is `O_EXCL` and refuses to follow a link. What the
 * sender called the file comes back beside the path, wrapped as untrusted content, and so do the subject and the type
 * they declared — and the saved name and path too, unless the name is plainly a file name.
 */

export interface AttachmentRow {
  inbox: string;
  messageId: string;
  threadId: string;
  partId: string;
  attachmentId: string | undefined;
  /** Wrapped: the sender named it. `(unnamed)` when they did not. */
  filename: string;
  /** A bare MIME type, or wrapped when it is anything more. */
  mimeType: string;
  size: number;
  date: string | null;
  /** A bare address, or wrapped when it is anything more. */
  from: string | null;
  /** Wrapped: the sender wrote it. */
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
  /** At least this many bytes, as given; checked by `findAttachments` against {@link MIN_BYTES}. */
  minBytes?: unknown;
  /** At most this many bytes, as given; checked against {@link MAX_BYTES}. */
  maxBytes?: unknown;
  mimeType?: string | undefined;
  /** How many rows, as given; checked against {@link FIND_LIMIT}. Twenty-five when left out. */
  limit?: unknown;
}

/** The filters as `attachmentQuery` writes them: sizes that have been checked. */
export type AttachmentFilters = Omit<FindAttachmentsOptions, 'minBytes' | 'maxBytes' | 'limit'> & {
  minBytes?: number | undefined;
  maxBytes?: number | undefined;
};

// 0 bytes at least is no lower bound, as it always was; at most 0 bytes was ignored, so it is refused instead.
export const MIN_BYTES: NumberOption = { flag: '--min-bytes', arg: 'minBytes', min: 0 };
export const MAX_BYTES: NumberOption = { flag: '--max-bytes', arg: 'maxBytes', min: 1 };
export const FIND_LIMIT: NumberOption = { flag: '--limit', arg: 'limit', min: 1, max: 100 };

export interface FindAttachmentsResult {
  query: string;
  rows: AttachmentRow[];
  /** Attachments held in Drive rather than in the message: there is no Drive permission, so they cannot be fetched. */
  driveLinks: number;
  errors: Array<{ inbox: string; code: string; message: string }>;
  complete: boolean;
}

/** Builds the Gmail query for the filters, so a caller does not have to know the syntax. */
export function attachmentQuery(options: AttachmentFilters): string {
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

/**
 * Finds attachments across mailboxes, recorded in the activity log with the query it ran and each attachment found —
 * by its message and part, its file name and size, and its message's subject and sender.
 */
export async function findAttachments(
  context: GmailContext,
  options: FindAttachmentsOptions = {},
): Promise<FindAttachmentsResult> {
  return recorded(
    context,
    'gmail.attachments.find',
    'read',
    options.inboxes,
    () => findAttachmentsIn(context, options),
    (result) => ({
      query: result.query,
      count: result.rows.length,
      items: result.rows.map((row) => attachmentItem(row)),
    }),
    options.query,
  );
}

/**
 * An attachment as a line keeps it: `<message id>/<part id>`, as the audit names a saved part; the name the sender gave
 * it and its size; and its message's subject and sender.
 */
function attachmentItem(row: {
  messageId: string;
  partId: string;
  filename: string;
  size: number;
  subject: string;
  from: string | null;
}): ActivityItem {
  const name = row.filename === '(unnamed)' ? undefined : plain(row.filename);
  return {
    ...itemOf(`${row.messageId}/${row.partId}`, row.subject, { address: row.from }),
    ...(name === undefined ? {} : { name }),
    size: row.size,
  };
}

async function findAttachmentsIn(
  context: GmailContext,
  options: FindAttachmentsOptions,
): Promise<FindAttachmentsResult> {
  // Checked before anything is read, so a number out of range is refused the same way from either surface.
  const minBytes = numberOption(context, options.minBytes, MIN_BYTES);
  const maxBytes = numberOption(context, options.maxBytes, MAX_BYTES);
  const limit = numberOption(context, options.limit, FIND_LIMIT) ?? 25;
  const config = await context.config();
  const aliases = await resolveInboxes(context, options.inboxes);
  const query = compileQuery(attachmentQuery({ ...options, minBytes, maxBytes }), {
    timezone: config.defaults.timezone,
  }).compiled;

  const rows: AttachmentRow[] = [];
  const errors: FindAttachmentsResult['errors'] = [];
  let driveLinks = 0;
  const boundary = newBoundary();

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
        // Sender-controlled, every one, and each row leaves this function as structured data outside any envelope.
        // This path is reached by an agent triaging mail on its own initiative, so the sender does not need the user
        // to open anything: the name, the type, the address and the subject are wrapped here, or kept bare only while
        // they are nothing but an address or a MIME type.
        const envelope: FieldEnvelope = { boundary, inbox: alias, id: message.id ?? entry.id };
        const address = parseAddressList(headerValue(headers, 'From'))[0]?.address;
        const from = address === undefined ? null : addressField(address, 'from-address', envelope);
        // Decoded first, then cut, then wrapped: see `read.ts` on why the encoded form hides a forged tag.
        const subject = wrapField(
          decodeHeaderWords(headerValue(headers, 'Subject') ?? '').slice(0, 120),
          'subject',
          envelope,
        );
        for (const part of parts.attachments) {
          if (part.disposition === 'inline' && !part.filename) continue;
          const filename = part.filename ?? '(unnamed)';
          if (options.mimeType && !part.mimeType.includes(options.mimeType.toLowerCase())) continue;
          if (minBytes && part.size < minBytes) continue;
          if (maxBytes && part.size > maxBytes) continue;
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
            filename: filenameField(part.filename, envelope),
            mimeType: mimeTypeField(part.mimeType, envelope),
            size: part.size,
            date,
            from,
            subject,
            // Flagged on the name the file would actually be written under, not the one the sender sent:
            // `invoice.exe ` is stripped to `invoice.exe` on the way to disk, and the `$`-anchored extension checks
            // do not match the trailing space, so the executable was written and the flag was not raised.
            riskFlags: attachmentRisks(filename, part.mimeType),
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

// ── Downloading ──────────────────────────────────────────────────────────────────────────────────────────────────

/** One attachment a download names, as the question lists it: what it is and where it came from, before any byte. */
export interface AttachmentToSave {
  messageId: string;
  /** Which attachment of the message it is: the part id Gmail gave it. */
  partId: string;
  /** Wrapped: the name the sender gave it. `(unnamed)` when they did not. */
  filename: string;
  /** What the message says it holds. The bytes saved are counted again as they arrive. */
  size: number;
  /** What the sender declared: a bare MIME type, or wrapped when it is anything more. */
  mimeType: string;
  /** A bare address, or wrapped when it is anything more. */
  from: string | null;
  /** Wrapped: the sender wrote it. */
  subject: string;
  date: string | null;
  riskFlags: string[];
}

export interface DownloadedFile {
  /** Wrapped: the name the sender gave it, as `gmail_attachments_find` shows it. `(unnamed)` when they gave none. */
  filename: string;
  /**
   * The name it was saved under: the sender's, made safe by core's `savedFileName` and never over a file already
   * there. Bare while it is plainly a file name, and wrapped otherwise — see `isPlainFileName`.
   */
  savedAs: string;
  /** Where it was saved: the folder the person chose, and `savedAs`. Wrapped whenever `savedAs` is. */
  path: string;
  /** Which attachment of the message it is: the part id Gmail gave it. */
  partId: string;
  /** The bytes written. */
  size: number;
  sha256: string;
  /** What the sender declared: a bare MIME type, or wrapped when it is anything more. */
  mimeType: string;
  messageId: string;
  /** Who sent it: a bare address, or wrapped when it is anything more. */
  from: string | null;
  /** Wrapped: the subject of the message it came with. */
  subject: string;
  date: string | null;
  /**
   * True when the same file — the same name and the same bytes — had already been written in this batch: `path` is
   * that one's. The same bytes under another name are written under that name: the person asked for each by name.
   */
  duplicate: boolean;
  riskFlags: string[];
  /**
   * The mark the saved file carries as downloaded from the internet — macOS's quarantine attribute, Windows's
   * `Zone.Identifier` — or null: on a system with no such mark, or when it could not be written, which `warnings` says.
   */
  marked: InternetMarkKind | null;
}

export interface DownloadSkip {
  messageId: string;
  partId: string;
  reason: string;
  /** `stopped` for a file the download stopped before saving; absent for one it never meant to save. */
  cause?: 'stopped' | undefined;
}

/** What a download answers once it has saved — or found nothing to save. */
export interface DownloadResult {
  /** False: this is what was saved, not a question. */
  destinationRequired: false;
  /** The folder the files were saved in, as its real path; null when there was nothing to save. */
  folder: string | null;
  /** How the folder was chosen: the answer the person gave, or null when there was nothing to save. */
  chosen: SaveChoice | null;
  files: DownloadedFile[];
  skipped: DownloadSkip[];
  /**
   * This package's own record of the download, under its state directory — never in the person's folder, where
   * nothing is written but the files. Null when there was nothing to save.
   */
  manifestPath: string | null;
  totalBytes: number;
  /**
   * What the person should know about the files saved, one line each: a file saved with `.download` after its name
   * and why, a file with a risk flag, a file that could not be marked as downloaded from the internet. Plain file names
   * are named; any other is called by its place in `files`.
   */
  warnings: string[];
}

/** What a download answers before anything is saved: the question for the person, with the files it would save. */
export interface DownloadQuestion extends DestinationQuestion {
  files: AttachmentToSave[];
  skipped: DownloadSkip[];
  /** What the files declare, together. */
  totalBytes: number;
}

export interface DownloadOptions extends DownloadAnswer {
  /** How many files at most, as given; checked by `downloadAttachments` against {@link MAX_FILES}. */
  maxFiles?: unknown;
  maxBytes?: number | undefined;
  /**
   * How a file's bytes are written into the file made for them: the handle's own `writeFile` when left out. Neither
   * surface passes it; a test does, to fail a write part-way as a full disk would, which no fake mailbox can.
   */
  write?: ((handle: FileHandle, bytes: Buffer) => Promise<void>) | undefined;
  /**
   * How a saved file is marked as downloaded from the internet: core's `markFromInternet` when left out. Neither surface
   * passes it; a test does, to fail the mark as a disk without extended attributes would.
   */
  mark?: ((path: string) => Promise<InternetMark>) | undefined;
  /**
   * Gives up on the download when it aborts: the attachment being fetched stops there, and the download ends as any
   * that stops part-way does, recording what it saved. Neither surface passes one yet — the MCP tool could pass its
   * request's, as `gmail_inbox_finish` does for a sign-in — so for now only a test does.
   */
  signal?: AbortSignal | undefined;
}

export const DEFAULT_MAX_FILES = 50;
export const MAX_FILES: NumberOption = { flag: '--max-files', arg: 'maxFiles', min: 1, max: 200 };
export const DEFAULT_MAX_BYTES: number = 500 * 1024 * 1024;

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A day, `YYYY-MM-DD`, for a folder or file name — or `undated`. Gmail's time, not the sender's; still only a date or
 * nothing, since it becomes part of a path: a number that is no time at all threw, and one past the year 9999 came
 * out as `+010000-01`.
 */
export function dayOf(at: number | null | undefined): string {
  const time = new Date(at ?? Number.NaN);
  if (Number.isNaN(time.getTime())) return 'undated';
  const day = time.toISOString().slice(0, 10);
  return DAY.test(day) ? day : 'undated';
}

/** The downloads root, where exports go: `~/Downloads/agent-communications` unless the config says otherwise. */
export async function downloadsRoot(context: GmailContext): Promise<string> {
  const config = await context.config();
  const configured = config.defaults.downloadsDir;
  const root =
    context.core.pathOverrides.downloadsDir ??
    (configured ? expandHome(configured, homeDirectory(context.env)) : context.core.paths.downloadsDir);
  await ensurePrivateDir(root);
  return root;
}

/** One attachment the request names and a download would save, with the message it is on. */
interface Planned {
  readonly messageId: string;
  readonly part: DecodedPart & { attachmentId: string };
  readonly listed: AttachmentToSave;
  /** The name it would be saved under: the sender's, made safe, with `.download` after it unless it is inert. */
  readonly name: string;
  /** The sender's name made safe, before any `.download`: what the warnings call it. */
  readonly given: string;
  /** Why `.download` is after its name, when it is. */
  readonly renamed: RenameReason | undefined;
}

/**
 * Downloads specific attachments — where the person says, and only once they have said it.
 *
 * Without an answer nothing is saved. The messages are read, and what comes back is the question: the attachments
 * the request names, by name and size, and three places to save them, the first two by their exact paths — see core's
 * `save-destination.ts`. With the person's answer and the question's `choiceId` the question is claimed, for these
 * messages and these attachments only — under this mailbox's change policy, so that under `confirm` only an answer the
 * person gave at their terminal or in a trusted form will do — and each attachment is saved in the chosen folder, never
 * one on core's deny list (`save-deny.ts`), under the name its sender gave it, made safe by `savedFileName`, created
 * exclusively and never through a link or over a file already there. Nothing else is written into that folder.
 *
 * A download that stops part-way — a part Gmail will not hand over, a file that cannot be written — records what it
 * saved, in the manifest and the audit log, removes a file it wrote only part of, and ends in an error that says what
 * was saved and what was not.
 *
 * The attachment id is resolved fresh from the message each time: Gmail's ids are reported to change between fetches,
 * and a stale one fails in a way that looks like the file is gone.
 */
export async function downloadAttachments(
  context: GmailContext,
  alias: string,
  targets: Array<{ messageId: string; partId?: string | undefined; filename?: string | undefined }>,
  options: DownloadOptions = {},
): Promise<DownloadQuestion | DownloadResult> {
  /*
   * Recorded in the activity log by each file — its name and size, and its message's subject and sender — and the
   * question's id. A question records what it would save (`toSave`); an answer, what it saved (`saved`).
   */
  return recorded(
    context,
    'gmail.attachments.download',
    'read',
    alias,
    () => downloadAttachmentsOf(context, alias, targets, options),
    (result): ActivityDetail => {
      const asked = typeof options.choiceId === 'string' ? options.choiceId : undefined;
      const choiceId = result.destinationRequired ? result.choiceId : asked;
      const files = result.destinationRequired ? result.files : result.files.filter((file) => !file.duplicate);
      return {
        items: files.map((file) => attachmentItem(file)),
        counts: result.destinationRequired
          ? { toSave: files.length, skipped: result.skipped.length }
          : { saved: files.length, skipped: result.skipped.length },
        ...(choiceId === undefined ? {} : { approvalId: choiceId }),
      };
    },
  );
}

async function downloadAttachmentsOf(
  context: GmailContext,
  alias: string,
  targets: Array<{ messageId: string; partId?: string | undefined; filename?: string | undefined }>,
  options: DownloadOptions,
): Promise<DownloadQuestion | DownloadResult> {
  // Before the mailbox is read or a folder made: no messages at all made a folder, wrote a manifest of nothing and
  // answered `files: []`, as if there had been nothing to save. The command takes one message id or more.
  if (targets.length === 0) {
    throw new CommsError('USAGE', 'name the messages whose attachments to save', {
      hint: context.surface === 'mcp' ? 'Pass one message id or more in `messageIds`.' : 'Pass one message id or more.',
    });
  }
  // Before the mailbox is read or a folder made: none at all saved nothing and said each file was one too many.
  const maxFiles = numberOption(context, options.maxFiles, MAX_FILES) ?? DEFAULT_MAX_FILES;
  // And the answer: one without the question it answers is refused before anything is read.
  const answer = checkDownloadAnswer(options, context.surface);
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;

  const planned: Planned[] = [];
  const skipped: DownloadSkip[] = [];
  const boundary = newBoundary();

  for (const target of targets) {
    const message = await transport.getMessage(target.messageId);
    const parts = readParts(message.payload);
    const messageId = message.id ?? target.messageId;
    const envelope: FieldEnvelope = { boundary, inbox: alias, id: messageId };
    const headers = message.payload?.headers ?? [];
    const address = parseAddressList(headerValue(headers, 'From'))[0]?.address;
    const from = address === undefined ? null : addressField(address, 'from-address', envelope);
    // Decoded first, then cut, then wrapped: see `read.ts` on why the encoded form hides a forged tag.
    const subject = wrapField(
      decodeHeaderWords(headerValue(headers, 'Subject') ?? '').slice(0, 120),
      'subject',
      envelope,
    );
    const date = message.internalDate ? new Date(Number(message.internalDate)).toISOString() : null;
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
      if (planned.length >= maxFiles) {
        skipped.push({ messageId: target.messageId, partId: part.partId, reason: `more than ${maxFiles} files` });
        continue;
      }
      if (!part.attachmentId) {
        skipped.push({
          messageId: target.messageId,
          partId: part.partId,
          reason: 'this part holds no downloadable bytes (a Drive link, perhaps)',
        });
        continue;
      }
      // Under the sender's name, made safe; the part's own id when nothing of the name is left.
      const saved = savedName(
        decodeHeaderWords(part.filename ?? ''),
        `${slug(target.messageId, 64, 'message')}-part-${slug(part.partId, 32, 'root')}`,
      );
      planned.push({
        messageId: target.messageId,
        part: part as DecodedPart & { attachmentId: string },
        name: saved.name,
        given: saved.given,
        renamed: saved.renamed,
        listed: {
          messageId: target.messageId,
          partId: part.partId,
          filename: filenameField(part.filename, envelope),
          size: part.size,
          mimeType: mimeTypeField(part.mimeType, envelope),
          from,
          subject,
          date,
          riskFlags: attachmentRisks(part.filename ?? '', part.mimeType),
        },
      });
    }
  }

  // The request as the question is bound to it: the messages and parts named, and the most it may save.
  const request: DownloadRequest = {
    target: { kind: 'inbox', name: alias, id: resolved.inbox.id },
    operation: 'attachments.download',
    request: {
      targets: targets.map((target) => ({
        messageId: target.messageId,
        partId: target.partId ?? null,
        filename: target.filename ?? null,
      })),
      maxFiles,
    },
    files: planned.map((entry) => `${entry.messageId}/${entry.part.partId}`),
    names: planned.map((entry) => entry.name),
  };

  const config = await context.config();
  const folders = () =>
    saveFolders({
      configured: config.defaults.downloadsDir,
      pinnedDownloads: context.core.pathOverrides.downloadsDir,
      env: context.env,
      cwd: context.cwd,
    });
  // Where a stranger's files land is a change to this machine, answered as this mailbox's other changes are approved.
  const policy = effectiveChangePolicy(config, { inbox: alias });

  if (answer.kind === 'none') {
    // Nothing to save is said as it is, with the reasons, rather than asked about.
    if (planned.length === 0) return nothingToSave(skipped);
    const question = await askWhereToSave(context.core, {
      channel: 'gmail',
      request,
      folders: folders(),
      configured: context.core.pathOverrides.downloadsDir !== undefined || Boolean(config.defaults.downloadsDir),
      count: planned.length,
      bytes: planned.reduce((sum, entry) => sum + entry.part.size, 0),
      listing: planned.map((entry) => ({
        name: entry.name,
        size: entry.part.size,
        renamed: entry.renamed,
        flags: entry.listed.riskFlags,
      })),
      policy,
      surface: context.surface,
      tool: 'gmail_attachment_download',
      env: context.env,
    });
    return {
      ...question,
      files: planned.map((entry) => entry.listed),
      skipped,
      totalBytes: planned.reduce((sum, entry) => sum + entry.part.size, 0),
    };
  }
  // A person's own `--to` with nothing to save has nothing to decide; an answer to a question is claimed whatever the
  // request holds now, so that one asked about other files is refused rather than answered with nothing.
  if (answer.kind === 'person' && planned.length === 0) return nothingToSave(skipped);

  const destination = await settleDestination(context.core, {
    answer,
    request,
    folders,
    policy,
    surface: context.surface,
    env: context.env,
    signal: options.signal,
  });
  const files: DownloadedFile[] = [];
  // The same file twice — the same name and the same bytes — is written once. The same bytes under another name are
  // written under that name as well: the person asked for each file by its name, and `report-copy.pdf` pointing at
  // `report.pdf` is a file they were told was saved and cannot find.
  const writtenAs = new Map<string, { path: string; savedAs: string; marked: InternetMarkKind | null }>();
  // What the result warns about each file written: its rename, its flags, a mark that could not be made.
  const warned: WarnedFile[] = [];
  const unmarked: string[] = [];
  let totalBytes = 0;
  // Boxed, so that even something thrown as `undefined` still counts as the download having stopped.
  let stopped: { readonly error: unknown } | undefined;
  // A file whose write failed and whose part-written copy could not be removed either: see below.
  let leftBehind: { readonly fileId: string; readonly path: string } | undefined;

  let at = 0;
  try {
    for (; at < planned.length; at += 1) {
      const { messageId, part, listed, name, given, renamed } = planned[at] as Planned;
      const fileId = `${messageId}/${part.partId}`;
      if (totalBytes + part.size > maxBytes) {
        skipped.push({ messageId, partId: part.partId, reason: `more than ${maxBytes} bytes in one batch` });
        continue;
      }
      // Named by its part, and allowed the time its size is worth: Gmail's figure, used for time alone.
      const bytes = await transport.getAttachment(messageId, part.attachmentId, {
        partId: part.partId,
        size: part.size,
        signal: options.signal,
      });
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const envelope: FieldEnvelope = { boundary, inbox: alias, id: messageId };
      const same = writtenAs.get(`${name}\u0000${sha256}`);
      if (same) {
        files.push({ ...savedFields(listed, same), size: bytes.byteLength, sha256, duplicate: true });
        continue;
      }

      // Created here, exclusively, and proved to be in the folder that was checked: an error from the file system
      // names the folder and the part, never the sender's name, which its own message would carry in the path.
      const created = await createSavedFile(destination, name, { fileId });
      let marking: InternetMark;
      try {
        /*
         * Marked as downloaded from the internet the moment it exists, before a byte of it is written: a program that
         * watches the folder and acts on a file as soon as it is there, or as soon as it is closed, finds it marked
         * already. A mark that cannot be made is said in the result, file by file; the file is still saved.
         */
        marking = await (options.mark ?? markFromInternet)(created.path);
        await (options.write ?? ((handle, data) => handle.writeFile(data)))(created.handle, bytes);
        await created.handle.close();
      } catch (error) {
        /*
         * A file cut short is worse than none. It looks like the file, under the file's own name, and neither the
         * manifest nor the audit lists it — and a download made again saves the whole one beside it as `-2`. So it is
         * removed before the failure goes on; the path was created here, exclusively, so what is removed is this
         * download's own. The removal can fail too, and then the error, the manifest and the audit record each say so.
         */
        await created.handle.close().catch(() => undefined);
        await rm(created.path, { force: true }).catch(() => {
          leftBehind = { fileId, path: savedNameFields(created.path, envelope).path };
        });
        throw saveFailure(error, { folder: destination.folder, fileId });
      }
      const shown = { ...savedNameFields(created.path, envelope), marked: marking.mark };
      writtenAs.set(`${name}\u0000${sha256}`, shown);
      totalBytes += bytes.byteLength;
      files.push({ ...savedFields(listed, shown), size: bytes.byteLength, sha256, duplicate: false });
      const position = files.length;
      const savedAs = basename(created.path);
      warned.push({ given, savedAs, renamed, flags: listed.riskFlags, position });
      if (marking.failure !== undefined) {
        unmarked.push(
          `${isPlainFileName(savedAs) ? savedAs : `file ${position}`} is not marked as downloaded from the internet: ${marking.failure}`,
        );
      }
    }
  } catch (error) {
    // A part Gmail would not hand over, or a file this machine could not write, stops the download. What was saved
    // before it is still recorded, below, before the failure is reported.
    stopped = { error };
  }

  /*
   * The files the download stopped before: the one it was on, and each it never reached. Without them a download that
   * stopped part-way left files on disk that no record named, and a caller told only that it failed would ask for
   * everything again, and save each file it already had a second time as `-2`.
   */
  const stoppedBefore: string[] = [];
  if (stopped !== undefined) {
    for (const { messageId, part } of planned.slice(at)) {
      const fileId = `${messageId}/${part.partId}`;
      stoppedBefore.push(fileId);
      skipped.push({
        messageId,
        partId: part.partId,
        cause: 'stopped',
        reason:
          leftBehind?.fileId === fileId
            ? `the download stopped while it was being written, and the part written could not be removed: ${leftBehind.path}`
            : 'the download stopped before this file was saved',
      });
    }
  }

  const now = context.now();
  const manifestPath = downloadRecordPath(context.core, now, destination.choiceId);
  const result: DownloadResult = {
    destinationRequired: false,
    folder: destination.folder,
    chosen: destination.choice,
    files,
    skipped,
    manifestPath,
    totalBytes,
    warnings: [...fileWarnings(warned, 'result'), ...unmarked],
  };

  // The manifest and the audit record, each written whatever became of the other: see Slack's `downloadFiles`.
  let manifestFailure: { readonly error: unknown } | undefined;
  try {
    // This package's own file, under its state directory: never in the folder the person chose.
    await writeFileAtomic(
      manifestPath,
      `${JSON.stringify(
        {
          at: now.toISOString(),
          inbox: alias,
          choiceId: destination.choiceId,
          answeredVia: destination.answeredVia,
          complete: stopped === undefined,
          ...result,
        },
        null,
        2,
      )}\n`,
    );
  } catch (error) {
    manifestFailure = { error };
  }
  const savedCount = files.filter((file) => !file.duplicate).length;
  let auditFailure: { readonly error: unknown } | undefined;
  try {
    await context.core.audit.append({
      inboxId: resolved.inbox.id,
      alias,
      operation: 'attachments.download',
      outcome: stopped === undefined && manifestFailure === undefined ? 'ok' : 'failed',
      surface: context.surface,
      ids: {
        messageIds: targets.map((target) => target.messageId),
        savedParts: files.filter((file) => !file.duplicate).map((file) => `${file.messageId}/${file.partId}`),
        ...(stoppedBefore.length === 0 ? {} : { stoppedBefore: [...stoppedBefore] }),
      },
      ...(destination.choiceId ? { approvalId: destination.choiceId } : {}),
      // The folder and the parts' ids, never a saved name: a name is the sender's words, and the audit log is read back.
      reason: `${savedCount} file(s), ${totalBytes} bytes, saved to ${destination.folder} (${destination.choice}, answered ${
        destination.answeredVia === 'flag' ? 'by flag' : `in ${destination.answeredVia}`
      }); ${skipped.length} skipped${stopped === undefined ? '' : '; stopped part-way'}${
        manifestFailure === undefined ? '' : '; the manifest not written'
      }${leftBehind === undefined ? '' : `; part of ${leftBehind.fileId} could not be removed from ${destination.folder}`}`,
    });
  } catch (error) {
    auditFailure = { error };
  }

  if (stopped === undefined && manifestFailure === undefined && auditFailure === undefined) return result;
  throw unfinished({
    stopped,
    manifestFailure,
    auditFailure,
    files: files.filter((file) => !file.duplicate),
    folder: destination.folder,
    manifestPath,
    stoppedBefore,
    leftBehind,
  });
}

/** A failure's message, whatever was thrown. By here a file-system error has been made one naming no sender's name. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The error a download ends with once files may be on disk: what went wrong, what was saved and where it is listed,
 * which parts it stopped before, and any part-written file it could not remove — as Slack's `unfinished` says it.
 *
 * Parts are named by their ids, `<message id>/<part id>`, and the folder by its path: a saved name is the sender's
 * words, and a hint is the tool's. A part-written file's path is carried as `savedNameFields` carries any path, inside
 * the envelope unless its name is plainly a file name. A refusal the download stopped on keeps its own code and hint;
 * anything else is `CONFIG`, as another file this machine could not write is.
 */
function unfinished(state: {
  readonly stopped: { readonly error: unknown } | undefined;
  readonly manifestFailure: { readonly error: unknown } | undefined;
  readonly auditFailure: { readonly error: unknown } | undefined;
  readonly files: readonly DownloadedFile[];
  readonly folder: string;
  readonly manifestPath: string;
  readonly stoppedBefore: readonly string[];
  readonly leftBehind: { readonly fileId: string; readonly path: string } | undefined;
}): CommsError {
  const { stopped, manifestFailure, auditFailure, files, folder, manifestPath, stoppedBefore, leftBehind } = state;
  const cause = (stopped ?? manifestFailure ?? auditFailure)?.error;
  const own = cause instanceof CommsError ? cause : undefined;
  const count = files.length;
  const them = count === 1 ? 'it' : 'them';
  const ids = files.map((file) => `${file.messageId}/${file.partId}`);

  const savedSoFar = count === 0 ? '' : `${count === 1 ? 'the file was' : 'the files were'} saved`;
  let message: string;
  if (stopped !== undefined) message = `the download stopped part-way: ${messageOf(stopped.error)}`;
  else if (manifestFailure !== undefined) {
    message = `${savedSoFar === '' ? '' : `${savedSoFar}, but `}the manifest could not be written: ${messageOf(manifestFailure.error)}`;
  } else {
    message = `${savedSoFar === '' ? '' : `${savedSoFar} and the manifest lists ${them}, but `}the audit log could not be written: ${messageOf(auditFailure?.error)}`;
  }

  const hint: string[] = [];
  if (own?.hint !== undefined) hint.push(own.hint);
  if (count === 0) hint.push('Nothing was saved.');
  else {
    const listed =
      manifestFailure === undefined
        ? `, and the manifest at ${manifestPath} lists ${them}`
        : auditFailure === undefined
          ? ', and the audit log records which'
          : `, and nothing else records ${count === 1 ? 'it' : 'which'}: ${ids.join(', ')}, in ${folder}`;
    hint.push(
      `${count === 1 ? '1 file was' : `${count} files were`} saved${stopped === undefined ? '' : ' before it stopped'}${listed}.`,
      `Downloading again saves ${count === 1 ? 'that file' : 'each of those files'} a second time, so ask only for what is missing.`,
    );
  }
  if (stoppedBefore.length > 0) {
    const which =
      stoppedBefore.length === 1
        ? 'The attachment it stopped before is'
        : `The ${stoppedBefore.length} attachments it stopped before are`;
    hint.push(
      manifestFailure === undefined
        ? `${which} in the manifest under \`skipped\`, as \`stopped\`.`
        : auditFailure === undefined
          ? `${which} in the audit log.`
          : `${which} ${stoppedBefore.join(', ')}.`,
    );
  }
  if (leftBehind !== undefined) {
    hint.push(
      `Part of ${leftBehind.fileId} was written and could not be removed: delete it — it is not the whole file. It is ${leftBehind.path}`,
    );
  }

  return new CommsError(own?.code ?? 'CONFIG', message, {
    hint: hint.join(' '),
    details: {
      ...(own?.details ?? {}),
      saved: count,
      savedFiles: files.map((file) => ({ messageId: file.messageId, partId: file.partId, path: file.path })),
      stoppedBefore: [...stoppedBefore],
      partialFile: leftBehind?.path ?? null,
      manifestPath: manifestFailure === undefined ? manifestPath : null,
      audited: auditFailure === undefined,
    },
  });
}

/** A download with nothing in it to save: said, with each reason, and nothing asked, made or written. */
function nothingToSave(skipped: DownloadSkip[]): DownloadResult {
  return {
    destinationRequired: false,
    folder: null,
    chosen: null,
    files: [],
    skipped,
    manifestPath: null,
    totalBytes: 0,
    warnings: [],
  };
}

/** A listed attachment as saved: what the question said of it, with where it went. */
function savedFields(
  listed: AttachmentToSave,
  saved: { path: string; savedAs: string; marked: InternetMarkKind | null },
): Omit<DownloadedFile, 'size' | 'sha256' | 'duplicate'> {
  return {
    filename: listed.filename,
    savedAs: saved.savedAs,
    path: saved.path,
    partId: listed.partId,
    mimeType: listed.mimeType,
    messageId: listed.messageId,
    from: listed.from,
    subject: listed.subject,
    date: listed.date,
    riskFlags: listed.riskFlags,
    marked: saved.marked,
  };
}

/**
 * The saved name and path as a result carries them: bare while the name is plainly a file name, and otherwise inside
 * the envelope — the name is the sender's, and `Ignore previous instructions.txt` is still a sentence on disk.
 */
function savedNameFields(path: string, envelope: FieldEnvelope): { path: string; savedAs: string } {
  const savedAs = basename(path);
  if (isPlainFileName(savedAs)) return { path, savedAs };
  return { path: wrapField(path, 'saved-path', envelope), savedAs: wrapField(savedAs, 'saved-as', envelope) };
}
