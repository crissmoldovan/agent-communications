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
  /**
   * Where replies would go, when that is not the From address.
   *
   * Bound by the digest and previously invisible: a draft carrying `Reply-To: someone@else.test` previewed exactly
   * like one without, so a person could approve a message every answer to which goes somewhere they were never
   * told about.
   */
  replyTo?: string[] | undefined;
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
  context?:
    | {
        inbox?: string | undefined;
        draftId?: string | undefined;
        approvalId?: string | undefined;
        note?: string | undefined;
      }
    | undefined;
  /**
   * What is known about each recipient, keyed by the address as it appears in the list — "EXTERNAL · FIRST-TIME",
   * "14 earlier messages". The reader is deciding who this goes to, and an address alone rarely says enough.
   */
  recipientNotes?: Record<string, string> | undefined;
  /** Where the conversation stands: "reply-all to Sam, 17 Sep 16:02 (6 messages)". */
  thread?: string | undefined;
  /** Every link in the message, with its full query string: a shortener or a tracker is only visible in full. */
  links?: string[] | undefined;
  /** The last line: what has to happen before this can be sent, in the reader's own terms. */
  policy?: string | undefined;
  /** Facts worth seeing before approving: a first-time recipient, an external domain, a link. */
  warnings?: string[] | undefined;
}

// One past the longest label there is (`Reply-To:`, `Notifies:`), because `padEnd` at exactly that width adds
// nothing and the value runs straight into the colon. That read as `Reply-To:accounts@evil.test` on the one line
// an approver most needs to be able to skim.
const LABEL_WIDTH = 10;

function line(label: string, value: string): string {
  return `${label.padEnd(LABEL_WIDTH)}${value}`;
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
    context.approvalId ? 'SEND PREVIEW' : 'MESSAGE PREVIEW',
    context.inbox ? `inbox ${context.inbox}` : '',
    context.approvalId ? `approval ${context.approvalId}` : '',
    context.draftId ? `draft ${context.draftId}` : '',
    context.note ?? '',
  ]
    .filter(Boolean)
    .join(' · ');
  lines.push(heading);

  const list = (addresses: string[]) =>
    addresses.length > 0 ? addresses.map((a) => truncateDisplay(a, 120)).join(', ') : 'none';
  const notes = preview.recipientNotes ?? {};
  // One recipient per line when anything is known about them: "EXTERNAL · FIRST-TIME" beside a name the reader half
  // recognises is the whole point of the preview, and it is lost in a comma-separated run.
  const addressLines = (label: string, addresses: string[]): void => {
    if (addresses.length === 0) {
      if (label === 'To:') lines.push(line(label, 'none'));
      return;
    }
    if (!addresses.some((address) => notes[address])) {
      lines.push(line(label, list(addresses)));
      return;
    }
    addresses.forEach((address, index) => {
      const note = notes[address];
      lines.push(line(index === 0 ? label : '', `${truncateDisplay(address, 90)}${note ? `   ${note}` : ''}`));
    });
  };
  lines.push(line('From:', truncateDisplay(preview.recipients.from, 120)));
  if ((preview.recipients.replyTo ?? []).length > 0) {
    lines.push(line('Reply-To:', `${list(preview.recipients.replyTo ?? [])}   REPLIES GO HERE, NOT TO FROM`));
  }
  addressLines('To:', preview.recipients.to);
  if (preview.recipients.cc.length > 0) addressLines('Cc:', preview.recipients.cc);
  if (preview.recipients.bcc.length > 0) addressLines('Bcc:', preview.recipients.bcc);
  lines.push(line('Subject:', truncateDisplay(preview.subject, 200)));
  if (preview.thread) lines.push(line('Thread:', truncateDisplay(preview.thread, 120)));

  for (const attachment of preview.attachments ?? []) {
    lines.push(
      line(
        'Attach:',
        `${truncateDisplay(attachment.filename, 80)} · ${Math.round(attachment.size / 1024)} KB · ${attachment.mimeType}`,
      ),
    );
  }

  for (const url of preview.links ?? []) lines.push(line('Link:', truncateDisplay(url, 160)));

  const words = preview.body.trim() ? preview.body.trim().split(/\s+/).length : 0;
  lines.push('', `Body (${words} word${words === 1 ? '' : 's'}, ${preview.body.length} characters):`);
  lines.push(renderFencedBody(preview.body));

  for (const warning of preview.warnings ?? []) lines.push(`! ${escapeForDisplay(warning)}`);

  // Again, after the body: a long message scrolls the lines above out of view, and these are what is being approved.
  lines.push(
    '',
    `── To ${list(preview.recipients.to)} · Cc ${list(preview.recipients.cc)} · Bcc ${list(preview.recipients.bcc)}`,
  );
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}

/** Who a channel message will notify, resolved to real people rather than left as syntax. */
export interface PreviewNotifies {
  /** `@here` — members currently online. */
  here: boolean;
  /** `@channel` — every member, online or not. */
  channel: boolean;
  /** Individually mentioned people, already resolved to display names. */
  users: string[];
  /**
   * How many people the above actually reaches.
   *
   * The number is the point. "@channel" is four characters whether the room holds three people or four hundred, and
   * a person approving the four-hundred case is agreeing to something quite different. A mail preview lists its
   * recipients and the reader counts them; a channel preview has to do the counting.
   */
  estimated: number;
  /** Set when the count could not be resolved — an unreadable member list, a rate limit. Never guessed at. */
  unknown?: string | undefined;
}

export interface ChannelPreview {
  workspace: string;
  /** `#engineering`, or a person's name for a direct message. */
  channel: string;
  /** Set when this is a reply inside a thread: "in reply to Sam, 17 Sep 16:02 (6 replies)". */
  thread?: string | undefined;
  /** The text as the client will render it, not the payload that produces it. */
  body: string;
  notifies: PreviewNotifies;
  attachments?: PreviewAttachment[] | undefined;
  context?:
    | {
        workspace?: string | undefined;
        draftId?: string | undefined;
        approvalId?: string | undefined;
        note?: string | undefined;
      }
    | undefined;
  /** Every link, with its query string: a shortener or a tracker is only visible in full. */
  links?: string[] | undefined;
  /** The last line: what has to happen before this can be posted. */
  policy?: string | undefined;
  warnings?: string[] | undefined;
}

/** How a notification set reads to a person: "@channel — about 412 people", "2 people". */
export function describeNotifies(notifies: PreviewNotifies): string {
  const parts: string[] = [];
  if (notifies.channel) parts.push('@channel');
  if (notifies.here) parts.push('@here');
  if (notifies.users.length > 0) parts.push(notifies.users.join(', '));
  if (parts.length === 0) return 'nobody is notified';
  const reach = notifies.unknown
    ? `how many that reaches is not known — ${notifies.unknown}`
    : `about ${notifies.estimated} ${notifies.estimated === 1 ? 'person' : 'people'}`;
  return `${parts.join(' · ')} — ${reach}`;
}

/**
 * The channel equivalent of `renderMessagePreview`, and deliberately the same shape: a person approving a post
 * should not have to learn a second layout.
 *
 * The difference is what sits where the recipients do. Mail names the people it goes to; a channel message names
 * one room, and the question a person actually needs answered is how far it carries. So the notification line takes
 * the position the recipient list occupies for mail — including the repeat below the body, for the same reason a
 * long message scrolls the header out of view.
 */
export function renderChannelPreview(preview: ChannelPreview): string {
  const lines: string[] = [];
  const context = preview.context ?? {};
  lines.push(
    [
      context.approvalId ? 'POST PREVIEW' : 'MESSAGE PREVIEW',
      `workspace ${context.workspace ?? preview.workspace}`,
      context.approvalId ? `approval ${context.approvalId}` : '',
      context.draftId ? `draft ${context.draftId}` : '',
      context.note ?? '',
    ]
      .filter(Boolean)
      .join(' · '),
  );

  lines.push(line('Channel:', truncateDisplay(preview.channel, 120)));
  if (preview.thread) lines.push(line('Thread:', truncateDisplay(preview.thread, 120)));
  lines.push(line('Notifies:', truncateDisplay(describeNotifies(preview.notifies), 160)));

  for (const attachment of preview.attachments ?? []) {
    lines.push(
      line(
        'Attach:',
        `${truncateDisplay(attachment.filename, 80)} · ${Math.round(attachment.size / 1024)} KB · ${attachment.mimeType}`,
      ),
    );
  }
  for (const url of preview.links ?? []) lines.push(line('Link:', truncateDisplay(url, 160)));

  const words = preview.body.trim() ? preview.body.trim().split(/\s+/).length : 0;
  lines.push('', `Body (${words} word${words === 1 ? '' : 's'}, ${preview.body.length} characters):`);
  lines.push(renderFencedBody(preview.body));

  for (const warning of preview.warnings ?? []) lines.push(`! ${escapeForDisplay(warning)}`);

  lines.push('', `── ${truncateDisplay(preview.channel, 60)} · ${describeNotifies(preview.notifies)}`);
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}
