import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { CommsError, createUniqueFile, relativeSubpath, resolveInsideRoot, safeFilename, slug } from '@agentcomms/core';
import type { GmailContext } from '../context.ts';
import { downloadsRoot } from './attachments.ts';
import { type ReadMessageResult, type ReadThreadResult, readMessage, readThread } from './read.ts';
import { oneOf } from './words.ts';

/**
 * Writing a message or a thread to a file.
 *
 * The point is to keep a long conversation out of the model's context: an agent asked to "look through this thread"
 * can export it and read the file in pieces, rather than pulling twenty thousand characters of somebody else's
 * writing through the conversation. Files land under the downloads root, like attachments, and by the same rules.
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
      lines.push(
        `- ${attachment.filename} — ${Math.round(attachment.size / 1024)} KB, ${attachment.mimeType}` +
          (attachment.riskFlags.length ? ` (${attachment.riskFlags.join(', ')})` : ''),
      );
    }
  }
  // The body keeps its envelope: a file is read back by the same models, and it is still somebody else's writing.
  lines.push('', message.body.enveloped, '');
  return lines.join('\n');
}

export async function exportMail(
  context: GmailContext,
  alias: string,
  id: string,
  options: ExportOptions = {},
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
    name = `${slug(thread.subject || thread.threadId, 40, 'thread')}.${format}`;
  } else {
    const message: ReadMessageResult = await readMessage(context, alias, id, {
      includeQuoted: options.includeQuoted,
      maxChars: 100_000,
    });
    const body = format === 'json' ? JSON.stringify(message, null, 2) : markdownForMessage(message);
    content = Buffer.from(body, 'utf8');
    name = `${slug(message.subject || message.messageId, 40, 'message')}.${format}`;
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
