import { mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { CommsError, createUniqueFile, relativeSubpath, resolveInsideRoot, safeFilename, slug } from '@agentcomms/core';
import { recorded } from '../activity.ts';
import type { GmailContext } from '../context.ts';
import { dayOf, downloadsRoot } from './attachments.ts';
import { type ReadMessageResult, type ReadThreadResult, readMessage, readThread } from './read.ts';
import { oneOf } from './words.ts';

/**
 * Writing a message or a thread to a file.
 *
 * The point is to keep a long conversation out of the model's context: an agent asked to "look through this thread"
 * can export it and read the file in pieces, rather than pulling twenty thousand characters of somebody else's
 * writing through the conversation. Files land under the downloads root, like attachments, and by the same rules —
 * named from the day and the id, `<date>_message-<id>.md` or `<date>_thread-<id>.json`, never from the subject: a slug
 * of a sentence is still the sentence, and the path comes back as a plain field.
 */

export type ExportFormat = 'md' | 'eml' | 'json';

/** The formats a message or thread can be written in, in the order they are offered. */
export const EXPORT_FORMATS: readonly ExportFormat[] = ['md', 'json', 'eml'];

export interface ExportResult {
  path: string;
  format: ExportFormat;
  bytes: number;
  /** What was exported: one message, or a whole thread. */
  kind: 'message' | 'thread';
  messageCount: number;
}

export interface ExportOptions {
  /** md, json or eml, as given; checked by `exportMail`. Markdown when left out. */
  format?: string | undefined;
  /** Export the whole thread the message belongs to. */
  thread?: boolean | undefined;
  /** A folder inside the downloads root. */
  out?: string | undefined;
  includeQuoted?: boolean | undefined;
}

function markdownForMessage(message: ReadMessageResult): string {
  const lines = [
    `## ${message.subject || '(no subject)'}`,
    '',
    `- **From:** ${message.from?.address ?? 'unknown'}${message.from?.name ? ` (${message.from.name})` : ''}`,
    `- **To:** ${message.to.map((entry) => entry.address).join(', ') || '—'}`,
  ];
  if (message.cc.length > 0) lines.push(`- **Cc:** ${message.cc.map((entry) => entry.address).join(', ')}`);
  lines.push(`- **Date:** ${message.date ?? 'unknown'}`, `- **Message:** ${message.messageId}`);
  if (message.auth.evaluatedBy) {
    lines.push(
      `- **Authentication:** spf ${message.auth.spf ?? '—'}, dkim ${message.auth.dkim ?? '—'}, dmarc ${message.auth.dmarc ?? '—'}`,
    );
  }
  if (message.sanitisation.hiddenElements > 0 || message.sanitisation.plainHtmlMismatch) {
    lines.push(
      `- **Hidden content removed:** ${message.sanitisation.hiddenElements} element(s)` +
        (message.sanitisation.plainHtmlMismatch
          ? `, and ${message.sanitisation.plainHtmlMismatch.extraChars} characters present only in the plain-text part`
          : ''),
    );
  }
  if (message.attachments.length > 0) {
    lines.push('', '### Attachments', '');
    for (const attachment of message.attachments) {
      // The name and the type on lines of their own: each is wrapped when it is the sender's words, as it is in the
      // read, and an envelope is several lines.
      lines.push(
        `- part ${attachment.partId} — ${Math.round(attachment.size / 1024)} KB` +
          (attachment.riskFlags.length ? ` (${attachment.riskFlags.join(', ')})` : ''),
        `  type ${attachment.mimeType}`,
        attachment.filename,
      );
    }
  }
  // The body keeps its envelope: a file is read back by the same models, and it is still somebody else's writing.
  lines.push('', message.body.enveloped, '');
  return lines.join('\n');
}

/**
 * Writes a message or a thread to a file, recorded in the activity log as the file — its name, which is this package's
 * own (the day and the id), and its size — under the id exported, with how many messages it holds. The read it makes
 * is part of this line, not one of its own.
 */
export async function exportMail(
  context: GmailContext,
  alias: string,
  id: string,
  options: ExportOptions = {},
): Promise<ExportResult> {
  return recorded(
    context,
    'gmail.export',
    'read',
    alias,
    () => exportTo(context, alias, id, options),
    (result) => ({
      items: [{ id, name: basename(result.path), size: result.bytes }],
      counts: { messages: result.messageCount },
    }),
  );
}

async function exportTo(
  context: GmailContext,
  alias: string,
  id: string,
  options: ExportOptions,
): Promise<ExportResult> {
  // Checked before anything is read: a word that is not a format used to be written out as Markdown under its name.
  const format = oneOf(options.format, EXPORT_FORMATS, 'an export format') ?? 'md';
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');

  const root = await downloadsRoot(context);
  const directory = await resolveInsideRoot(root, join(alias, relativeSubpath(options.out) || 'exports'));
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let content: Buffer;
  let name: string;
  let kind: ExportResult['kind'] = options.thread ? 'thread' : 'message';
  let messageCount = 1;

  if (format === 'eml') {
    if (options.thread) {
      throw new CommsError('USAGE', 'a thread cannot be exported as one .eml file', {
        hint: 'Export the thread as md or json, or export each message as eml by its own id.',
      });
    }
    const transport = await context.transport(alias);
    content = await transport.getRawMessage(id);
    name = `${slug(id, 30, 'message')}.eml`;
    kind = 'message';
  } else if (options.thread) {
    const thread: ReadThreadResult = await readThread(context, alias, id, {
      includeQuoted: options.includeQuoted,
      maxChars: 100_000,
      maxThreadChars: 1_000_000,
    });
    messageCount = thread.messages.length;
    const body =
      format === 'json'
        ? JSON.stringify(thread, null, 2)
        : [
            `# ${thread.subject || '(no subject)'}`,
            '',
            `${thread.messageCount} messages · ${thread.participants.join(', ')} · exported from ${alias}`,
            '',
            ...thread.messages.map(markdownForMessage),
          ].join('\n');
    content = Buffer.from(body, 'utf8');
    // The day it began, oldest first as a thread is read.
    const began = thread.messages[0]?.date;
    name = `${dayOf(began ? Date.parse(began) : null)}_thread-${slug(thread.threadId, 64, 'thread')}.${format}`;
  } else {
    const message: ReadMessageResult = await readMessage(context, alias, id, {
      includeQuoted: options.includeQuoted,
      maxChars: 100_000,
    });
    const body = format === 'json' ? JSON.stringify(message, null, 2) : markdownForMessage(message);
    content = Buffer.from(body, 'utf8');
    name = `${dayOf(message.date ? Date.parse(message.date) : null)}_message-${slug(message.messageId, 64, 'message')}.${format}`;
  }

  const { path, handle } = await createUniqueFile(directory, safeFilename(name));
  try {
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }

  await context.core.audit.append({
    inboxId: resolved.inbox.id,
    alias,
    operation: 'export',
    outcome: 'ok',
    surface: context.surface,
    ids: { [kind === 'thread' ? 'threadIds' : 'messageIds']: [id] },
    reason: `${format}, ${content.byteLength} bytes`,
  });

  return { path, format, bytes: content.byteLength, kind, messageCount };
}
