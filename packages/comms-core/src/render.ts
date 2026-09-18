import { isDangerous } from './chars.ts';

/**
 * One renderer for every surface a send preview is shown on — the chat, an elicitation form, a terminal. Text the
 * draft's author controls (body, subject, display names, file names, link text) must not be able to change how the
 * rest of the preview reads: an ESC/CSI sequence in a body can move a terminal cursor and overwrite the To line the
 * human is about to approve; a bidi override can reverse an address; a zero-width character can hide a difference.
 */

function visible(codePoint: number): string {
  return `<U+${codePoint.toString(16).toUpperCase().padStart(4, '0')}>`;
}

/** Makes every control and invisible character visible as `<U+XXXX>`. Newlines and tabs are kept; CRLF becomes LF. */
export function escapeForDisplay(text: string): string {
  let out = '';
  const normalised = text.replace(/\r\n/g, '\n');
  for (const char of normalised) {
    const codePoint = char.codePointAt(0) ?? 0;
    out += isDangerous(codePoint) ? visible(codePoint) : char;
  }
  return out;
}

/** Escapes, flattens to one line, and cuts to `width` characters — for names and file names in fixed columns. */
export function truncateDisplay(text: string, width: number): string {
  const flat = escapeForDisplay(text).replace(/[\n\t]+/g, ' ');
  const chars = [...flat];
  return chars.length <= width ? flat : `${chars.slice(0, Math.max(0, width - 1)).join('')}…`;
}

/** A Markdown code fence longer than any backtick run inside `body`, so the body cannot close it. */
export function fenceFor(body: string): string {
  const longest = Math.max(0, ...[...body.matchAll(/`+/g)].map((match) => match[0].length));
  return '`'.repeat(Math.max(3, longest + 1));
}

/** The body as it goes into a chat preview: escaped and fenced. */
export function renderFencedBody(body: string, info = 'text'): string {
  const safe = escapeForDisplay(body);
  const fence = fenceFor(safe);
  return `${fence}${info}\n${safe}\n${fence}`;
}

export interface PreviewRecipients {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface PreviewAttachment {
  filename: string;
  size: number;
  mimeType: string;
}

export interface MessagePreview {
  recipients: PreviewRecipients;
  subject: string;
  body: string;
  attachments?: PreviewAttachment[] | undefined;
  /** Shown above the preview: the mailbox, the draft, whether anything has been sent. */
  context?: { inbox?: string | undefined; draftId?: string | undefined; note?: string | undefined } | undefined;
  /** Facts worth seeing before approving: a first-time recipient, an external domain, a link. */
  warnings?: string[] | undefined;
}

function line(label: string, value: string): string {
  return `${label.padEnd(9)}${value}`;
}

/**
 * The preview of a message about to be written or sent, rendered the same way everywhere: chat, terminal, an
 * approval form.
 *
 * Three things it does deliberately. The body is **fenced with a fence longer than any backtick run inside it**, so
 * a message containing ``` cannot break out and impersonate the lines around it. Every control and invisible
 * character is shown as `<U+XXXX>`, so an ESC sequence cannot repaint a terminal and a bidi override cannot reverse
 * an address. And the recipients are **repeated after the body**, because a long message pushes the To line off the
 * screen, and the recipients are the one thing the reader is actually approving.
 */
export function renderMessagePreview(preview: MessagePreview): string {
  const lines: string[] = [];
  const context = preview.context ?? {};
  const heading = [
    'MESSAGE PREVIEW',
    context.inbox ? `inbox ${context.inbox}` : '',
    context.draftId ? `draft ${context.draftId}` : '',
    context.note ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(heading);

  const list = (addresses: string[]) =>
    addresses.length > 0 ? addresses.map((a) => truncateDisplay(a, 120)).join(', ') : 'none';
  lines.push(line('From:', truncateDisplay(preview.recipients.from, 120)));
  lines.push(line('To:', list(preview.recipients.to)));
  if (preview.recipients.cc.length > 0) lines.push(line('Cc:', list(preview.recipients.cc)));
  if (preview.recipients.bcc.length > 0) lines.push(line('Bcc:', list(preview.recipients.bcc)));
  lines.push(line('Subject:', truncateDisplay(preview.subject, 200)));

  for (const attachment of preview.attachments ?? []) {
    lines.push(
      line(
        'Attach:',
        `${truncateDisplay(attachment.filename, 80)} · ${Math.round(attachment.size / 1024)} KB · ${attachment.mimeType}`,
      ),
    );
  }

  const words = preview.body.trim() ? preview.body.trim().split(/\s+/).length : 0;
  lines.push('', `Body (${words} word${words === 1 ? '' : 's'}, ${preview.body.length} characters):`);
  lines.push(renderFencedBody(preview.body));

  for (const warning of preview.warnings ?? []) lines.push(`! ${escapeForDisplay(warning)}`);

  // Again, after the body: a long message scrolls the lines above out of view, and these are what is being approved.
  lines.push(
    '',
    `── To ${list(preview.recipients.to)} · Cc ${list(preview.recipients.cc)} · Bcc ${list(preview.recipients.bcc)}`,
  );
  return lines.join('\n');
}
