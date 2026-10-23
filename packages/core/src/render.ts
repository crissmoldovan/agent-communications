import { serverLabel } from './channel-servers.ts';
import { isDangerous } from './chars.ts';
import { paint } from './cli-runtime.ts';
import { type CliHandoffs, handoffSentence } from './handoffs.ts';
import type { InstallResult, PruneResult } from './mcp-install.ts';
import type { DoctorReport } from './operations/maintenance.ts';
import type { PruneAllResult } from './operations/servers.ts';
import type { UpdateItem, UpdateReport, UpdateResult } from './operations/update.ts';
import type { UpdateStatus } from './operations/update-status.ts';

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
  /**
   * The SHA-256 of the bytes that will leave, when the approval is bound to it. A channel preview sets it for every
   * file: the hash is what makes "these files" one set of bytes rather than whatever carries these names at send time.
   */
  sha256?: string | undefined;
  /** Where the file is read from on this machine, when it is a local file, so the person can see which one it is. */
  path?: string | undefined;
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
 * The `A · B · C` line at the top, with every part flattened and escaped.
 *
 * Escaped even where the field looks safe. An inbox alias is `[a-z0-9-]` and cannot carry a newline; a workspace
 * name is whatever the workspace is called, and a heading assembled from raw parts put an attacker one newline away
 * from writing a line of the preview's own. Which fields are constrained is not a property this function can see,
 * and the next one added will not announce that it is the unconstrained one.
 */
function heading(parts: readonly (string | undefined)[]): string {
  return parts
    .filter((part): part is string => Boolean(part))
    .map((part) => truncateDisplay(part, 120))
    .join(' · ');
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
  lines.push(
    heading([
      context.approvalId ? 'SEND PREVIEW' : 'MESSAGE PREVIEW',
      context.inbox ? `inbox ${context.inbox}` : '',
      context.approvalId ? `approval ${context.approvalId}` : '',
      context.draftId ? `draft ${context.draftId}` : '',
      context.note,
    ]),
  );

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
  /**
   * A security fix is out and this machine does not install it on its own (design 2026-10-16, U7): the line the
   * preview opens with, asked once. Display only — never in what the approval binds.
   */
  security?: string | undefined;
  workspace: string;
  /**
   * Who this will be posted as, as a person should read it: `Acme Bot (U024BE7LH)`.
   *
   * The channel counterpart of the `From:` line, and shown for the same reason — it is recipient-visible, and an
   * approver who is not told which of their connected accounts is speaking has not been shown the message.
   */
  postingAs: string;
  /** `#engineering`, or a person's name for a direct message. */
  channel: string;
  /** Set when this is a reply inside a thread: "in reply to Sam, 17 Sep 16:02 (6 replies)". */
  thread?: string | undefined;
  /** The text as the client will render it, not the payload that produces it. */
  body: string;
  /**
   * Set when this replaces a message already in the channel rather than posting a new one — an edit (Slack design
   * 2026-10-06). `body` is then what the message will say, and this is what it says now, rendered the same way: a person
   * approving an edit is agreeing to the change from one to the other, and cannot judge it from the new words alone.
   *
   * `wordsUnchanged` is an edit that keeps the message's words and changes only its files: one body is shown, said to
   * be unchanged. `files` is set when an edit changes the files: the ones the message keeps and the ones taken off, by
   * the names Slack shows; the files it adds are the preview's `attachments`, as a post's are.
   */
  replaces?:
    | {
        ts: string;
        body: string;
        wordsUnchanged?: boolean | undefined;
        files?: { keeps: readonly string[]; removes: readonly string[] } | undefined;
      }
    | undefined;
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
/**
 * How many names are listed before the rest become a number, and how wide each may be.
 *
 * Both exist so the string this returns has a ceiling. The reach clause is last, and a caller that truncated the
 * result would cut the count off the end — losing the one part of the line that cannot be inferred from the rest.
 */
const MAX_NAMED = 4;
const NAME_WIDTH = 24;

export function describeNotifies(notifies: PreviewNotifies): string {
  const parts: string[] = [];
  if (notifies.channel) parts.push('@channel');
  if (notifies.here) parts.push('@here');

  // Display names are chosen by the accounts that bear them, so they are attacker-controlled text. They are escaped
  // here rather than at the call sites: this string is rendered in two places and one of them wrote it straight into
  // the preview, where a name carrying a newline forged a `Policy:` line in the preview's own voice. A guarantee
  // that depends on every caller remembering is not a guarantee — so the chokepoint holds it.
  const named = notifies.users.map((user) => truncateDisplay(user, NAME_WIDTH));
  if (named.length > 0) {
    const shown = named.slice(0, MAX_NAMED);
    const rest = named.length - shown.length;
    parts.push(rest > 0 ? `${shown.join(', ')} and ${rest} more` : shown.join(', '));
  }

  if (parts.length === 0) return 'nobody is notified';
  const reach = notifies.unknown
    ? `how many that reaches is not known — ${truncateDisplay(notifies.unknown, 60)}`
    : `about ${notifies.estimated} ${notifies.estimated === 1 ? 'person' : 'people'}`;
  return `${parts.join(' · ')} — ${reach}`;
}

/**
 * A byte count as a person reads it.
 *
 * Here, beside the rest of what formats a value for a person, since the channel preview wants it as well as the
 * download question — and `save-destination.ts` already imports from here.
 */
export function sizeOf(bytes: number): string {
  if (bytes < 1024) return `${bytes} ${bytes === 1 ? 'byte' : 'bytes'}`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * A file's size as a person checks it against a file they know: `sizeOf`'s figure, with the exact count beside it
 * above a kilobyte — `47 bytes`, `10.0 MB (10,485,761 bytes)`. Grouped the same way on every machine, whatever its
 * locale.
 */
export function describeSize(bytes: number): string {
  return bytes < 1024 ? sizeOf(bytes) : `${sizeOf(bytes)} (${bytes.toLocaleString('en-US')} bytes)`;
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
  if (preview.security) lines.push(escapeForDisplay(preview.security));
  const context = preview.context ?? {};
  const { replaces } = preview;
  lines.push(
    heading([
      replaces ? 'EDIT PREVIEW' : context.approvalId ? 'POST PREVIEW' : 'MESSAGE PREVIEW',
      `workspace ${context.workspace ?? preview.workspace}`,
      context.approvalId ? `approval ${context.approvalId}` : '',
      context.draftId ? `draft ${context.draftId}` : '',
      context.note,
    ]),
  );

  lines.push(line('From:', truncateDisplay(preview.postingAs, 120)));
  lines.push(line('Channel:', truncateDisplay(preview.channel, 120)));
  if (preview.thread) lines.push(line('Thread:', truncateDisplay(preview.thread, 120)));
  if (replaces) lines.push(line('Edits:', `the message at ${truncateDisplay(replaces.ts, 40)}`));
  // What an edit does to the files already on the message, before the files it adds (`Attach:`, below).
  const names = (list: readonly string[]) => list.map((name) => truncateDisplay(name, 60)).join(', ');
  if (replaces?.files && replaces.files.keeps.length > 0) lines.push(line('Keeps:', names(replaces.files.keeps)));
  if (replaces?.files && replaces.files.removes.length > 0) lines.push(line('Removes:', names(replaces.files.removes)));
  lines.push(line('Notifies:', describeNotifies(preview.notifies)));

  /*
   * Each file on three lines: what Slack will show — name, size, type — then the hash the approval is bound to, then
   * where it is read from. The size is exact, because a person matching this to a file they know is matching bytes,
   * and every part is escaped: the name is a file's, and a draft file can be edited by anything with a shell.
   */
  for (const attachment of preview.attachments ?? []) {
    lines.push(
      line(
        'Attach:',
        `${truncateDisplay(attachment.filename, 80)} · ${describeSize(attachment.size)} · ${truncateDisplay(attachment.mimeType, 80)}`,
      ),
    );
    if (attachment.sha256 !== undefined) lines.push(line('', `sha256 ${truncateDisplay(attachment.sha256, 80)}`));
    if (attachment.path !== undefined) lines.push(line('', `from ${truncateDisplay(attachment.path, 200)}`));
  }
  for (const url of preview.links ?? []) lines.push(line('Link:', truncateDisplay(url, 160)));

  // An edit shows both, the words it has now first, each counted and fenced the same way, so neither reads as the other.
  const counted = (label: string, body: string) => {
    const words = body.trim() ? body.trim().split(/\s+/).length : 0;
    lines.push('', `${label} (${words} word${words === 1 ? '' : 's'}, ${body.length} characters):`);
    lines.push(renderFencedBody(body));
  };
  if (replaces?.wordsUnchanged) counted('Words, unchanged', replaces.body);
  else if (replaces) {
    counted('Now', replaces.body);
    counted('After the edit', preview.body);
  } else counted('Body', preview.body);

  for (const warning of preview.warnings ?? []) lines.push(`! ${escapeForDisplay(warning)}`);

  lines.push('', `── ${truncateDisplay(preview.channel, 60)} · ${describeNotifies(preview.notifies)}`);
  if (preview.policy) lines.push(escapeForDisplay(preview.policy));
  return lines.join('\n');
}

/**
 * What an MCP install did, or would do.
 *
 * Here rather than in either package: the result shape is `@agentcomms/core`'s, so a second renderer would be a
 * second place for the same words to drift. Gmail re-exports it under its old name so nothing that imported it
 * has to change.
 */
export function renderInstall(result: InstallResult, color: boolean): string {
  const lines: string[] = [];
  if (result.applied) {
    lines.push(
      paint(
        color,
        'green',
        `Registered "${result.name}" with ${result.client}${result.method === 'file' ? ` in ${result.configPath}` : ''}.`,
      ),
      'Restart the client to pick it up.',
    );
  } else {
    if (result.notApplied) lines.push(paint(color, 'red', `Not registered: ${result.notApplied}.`));
    lines.push(
      paint(color, 'bold', `Add this to ${result.configPath ?? `the MCP configuration of ${result.client}`}:`),
      result.snippet.trimEnd(),
    );
  }
  if (result.backupPath) lines.push(`The entry it replaced was saved to ${result.backupPath}.`);
  if (result.shim && result.shim.status !== 'foreign') {
    lines.push(`CLI shim ${result.shim.status}: ${result.shim.path}.`);
  }
  if (result.shimFailure) lines.push(paint(color, 'yellow', `CLI shim failed: ${result.shimFailure}.`));
  if (result.shimNotice) lines.push(paint(color, 'yellow', result.shimNotice));
  if (result.shim?.pathNotice) lines.push(result.shim.pathNotice);
  // A check that ran and failed is not one that was skipped: "Not checked" for both read as "probably fine".
  if (result.verification === 'passed') lines.push(paint(color, 'green', `Checked: ${result.verifyDetail}`));
  else if (result.verification === 'failed') {
    lines.push(paint(color, 'red', `Failed to start: ${result.verifyDetail ?? 'no reason given'}`));
    if (result.backupPath) lines.push(`The entry it replaced is still in ${result.backupPath}, to put back by hand.`);
  } else lines.push(paint(color, 'yellow', `Not checked: ${result.verifyDetail ?? 'skipped'}`));
  for (const warning of result.warnings) lines.push('', paint(color, 'red', warning));
  return lines.join('\n');
}

/**
 * What `agentcomms doctor` prints: one line a check — `ok`, `warn` or `FAIL` — and the fix under any that has one.
 *
 * Here rather than inside the command, so a test can read the lines a person reads: the command itself probes the
 * login keychain, which no test may touch.
 */
export function renderDoctor(report: DoctorReport): string {
  return report.checks
    .map(
      (c) =>
        `${c.ok ? (c.warn ? 'warn' : 'ok  ') : 'FAIL'} ${c.name.padEnd(16)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}`,
    )
    .join('\n');
}

/**
 * What `mcp prune` removed and kept, and why each one it kept is still needed. A prune of every managed server lists
 * each server that had a runtime under its own name, in the registry's order.
 */
export function renderPrune(result: PruneResult | PruneAllResult, color: boolean): string {
  if ('servers' in result) {
    const groups = result.servers
      .map((part) => ({ label: part.label, lines: pruneLines(part, color) }))
      .filter((group) => group.lines.length > 0)
      .map((group) => [`${group.label}:`, ...group.lines.map((line) => `  ${line}`)].join('\n'));
    if (groups.length === 0) return `No managed runtimes to remove in ${result.runtimeDir}.`;
    // Last, so a server left unchecked among others that went ahead is not lost in the list above.
    const unchecked = (result.refusedServers ?? []).map(({ label, refused }) => `${label} (${refused})`);
    if (unchecked.length > 0) {
      const its = unchecked.length === 1 ? 'its' : 'their';
      groups.push(
        paint(color, 'yellow', `Not checked, so none of ${its} runtimes was removed: ${unchecked.join('; ')}.`),
      );
    }
    return groups.join('\n');
  }
  const lines = pruneLines(result, color);
  if (lines.length === 0) lines.push(`No managed runtimes to remove in ${result.runtimeDir}.`);
  return lines.join('\n');
}

/** One server's prune, a line a runtime or shim; none when it had nothing to look at. */
function pruneLines(result: PruneResult, color: boolean): string[] {
  const lines: string[] = [];
  if (result.refused) lines.push(paint(color, 'yellow', `Nothing removed: ${result.refused}.`));
  const verb = result.dryRun ? 'Would remove' : 'Removed';
  for (const item of result.removed) lines.push(paint(color, 'green', `${verb} ${item.version}: ${item.path}`));
  for (const path of result.shims.removed) lines.push(paint(color, 'green', `${verb} CLI shim: ${path}`));
  for (const path of result.shims.kept) lines.push(`Kept foreign CLI shim: ${path}`);
  for (const item of result.kept) lines.push(`Kept ${item.version} (${item.reason}): ${item.path}`);
  return lines;
}

// ── An update, as `agentcomms update` prints it — here so a channel's command can print one too ──────────────────

/** One item of an update check, as a line. */
function describeItem(item: UpdateItem): string {
  if (item.kind === 'global') {
    const again = item.reinstall ? ', to install again: an earlier update removed what did not match its release' : '';
    return `global ${item.package} ${item.version}${item.version === item.latest ? '' : ` → ${item.latest}`}${again}`;
  }
  if (item.kind === 'runtime') {
    return item.version === item.latest
      ? `${item.package} runtime ${item.latest} in ${item.path}`
      : `${item.package} runtime ${item.version ?? '(none yet)'} → ${item.latest}, to install into ${item.path}`;
  }
  const where = item.scope === 'project' ? `for a project, in ${item.path}` : `in ${item.path}`;
  const pins = item.narrowing.length > 0 ? `, ${item.narrowing.join(' ')}` : '';
  const version =
    item.version === null
      ? 'pins no release'
      : `${item.version}${item.version === item.latest ? '' : ` → ${item.latest}`}`;
  const launcher = item.launches === undefined ? item.launcher : `${item.launcher}, stable launcher`;
  return `${serverLabel(item.channel)} with ${item.client} as "${item.name}" ${where} (${launcher}, ${version}${pins})`;
}

export function renderUpdateCheck(report: UpdateReport, handoffs: CliHandoffs): string {
  const latest = Object.entries(report.latest)
    .map(([name, version]) => `${name} ${version}`)
    .join(', ');
  const lines = [`Latest: ${latest}. This core is ${report.core}.`];
  const section = (title: string, items: readonly UpdateItem[]) => {
    if (items.length === 0) return;
    lines.push('', `${title}:`);
    for (const item of items) {
      lines.push(`  ${describeItem(item)}`);
      if (item.kind === 'registration' && item.reason) lines.push(`    ${item.reason}`);
    }
  };
  section('Behind', report.behind);
  section('Up to date', report.upToDate);
  section('Pinned to no release', report.unpinned);
  // At the latest release, still naming a versioned runtime: the next update moves each to the stable launcher, once.
  section('To move to the stable launcher', report.moves ?? []);
  for (const file of report.unreadable) lines.push('', `Could not read ${file.path}: ${file.reason}.`);
  const updatable = report.behind.some((item) => item.kind !== 'registration' || item.updatable === true);
  const moves = (report.moves ?? []).length > 0;
  lines.push(
    '',
    report.behind.length === 0
      ? moves
        ? handoffSentence(
            handoffs.core(['update']),
            (command) =>
              `Everything here is at the latest release. Run ${command} once to move the registrations above to the stable launcher: after that, an update edits no client configuration.`,
          )
        : 'Everything here is at the latest release.'
      : updatable
        ? handoffSentence(
            handoffs.core(['update']),
            (command) => `Run ${command} to bring what is behind to the latest release.`,
          )
        : 'Nothing behind can be updated from here; each says why above.',
  );
  return lines.join('\n');
}

/**
 * What `update --status` prints: a `key value` line per field, as `paths` prints its folders, the job's under `job.`.
 * Nothing known is `none`. Each value is shown on one line, its control and invisible characters made visible: a
 * check's error is the registry's text, and an organisation's name the configuration's.
 */
export function renderUpdateStatus(status: UpdateStatus): string {
  const shown = (value: string | boolean | null): string => {
    if (value === null) return 'none';
    if (typeof value === 'boolean') return value ? 'yes' : 'no';
    return escapeForDisplay(value).replace(/[\n\t]+/g, ' ');
  };
  const rows: [string, string | boolean | null][] = [
    ['level', status.level],
    ['set', status.set],
    ['by', status.by],
    ['cap', status.cap === null ? null : `${status.cap.level} (${status.cap.organisation})`],
    ['pausedUntil', status.pausedUntil],
    ['lastChecked', status.lastChecked],
    ['latest', status.latest],
    ['running', status.running],
    ['security', status.security],
    ['lastError', status.lastError],
    ['job.state', status.job.state],
    ['job.where', status.job.where],
    ['job.installedAt', status.job.installedAt],
    ['job.lastRun', status.job.lastRun],
    ['job.working', status.job.working],
    ...(status.job.reason === undefined ? [] : ([['job.reason', status.job.reason]] as [string, string][])),
  ];
  return rows.map(([key, value]) => `${key.padEnd(15)} ${shown(value)}`).join('\n');
}

export function renderUpdate(result: UpdateResult, color: boolean): string {
  const lines: string[] = [];
  for (const step of result.steps) {
    if (step.kind === 'runtime') {
      lines.push(
        step.outcome === 'installed'
          ? paint(color, 'green', `Installed ${step.package}@${step.version} into ${step.path}.`)
          : paint(
              color,
              'red',
              `Could not install ${step.package}@${step.version}: ${step.detail ?? 'no reason given'}`,
            ),
      );
    } else if (step.kind === 'registration') {
      const what = `"${step.name}" with ${step.client} at ${step.to}`;
      if (step.outcome === 'registered') {
        lines.push(paint(color, 'green', `Registered ${what}, in place of ${step.from}.`));
        if (step.verification === 'passed') lines.push(`  Checked: ${step.detail}`);
        else if (step.verification === 'failed') lines.push(paint(color, 'red', `  Failed to start: ${step.detail}`));
        else lines.push(paint(color, 'yellow', `  Not checked: ${step.detail ?? 'skipped'}`));
        if (step.shim && step.shim.status !== 'foreign')
          lines.push(`  CLI shim ${step.shim.status}: ${step.shim.path}.`);
        if (step.shim?.pathNotice) lines.push(`  ${step.shim.pathNotice}`);
        for (const warning of step.warnings ?? []) lines.push(`  ${warning}`);
      } else {
        lines.push(
          paint(
            color,
            'red',
            `${step.outcome === 'skipped' ? 'Skipped' : 'Could not register'} ${what}: ${step.detail}`,
          ),
        );
      }
    } else if (step.kind === 'pointer') {
      const starters = step.registrations.map((registration) => `"${registration.name}" with ${registration.client}`);
      if (step.outcome === 'switched') {
        lines.push(
          paint(
            color,
            'green',
            `Switched the stable launcher ${step.launcher} from ${step.from ?? 'no release'} to ${step.to}: no client configuration was changed.`,
          ),
        );
        if (step.verification === 'passed') lines.push(`  Checked: ${step.detail}`);
        else lines.push(paint(color, 'yellow', `  Not checked: ${step.detail ?? 'skipped'}`));
        lines.push(`  ${starters.join(', ')} ${starters.length === 1 ? 'runs' : 'run'} ${step.to} once restarted.`);
      } else {
        lines.push(
          paint(
            color,
            'red',
            `${step.outcome === 'skipped' ? 'Skipped' : 'Could not switch'} the stable launcher ${step.launcher} to ${step.to}: ${step.detail ?? 'no reason given'}`,
          ),
        );
      }
    } else {
      lines.push(
        step.outcome === 'updated'
          ? paint(color, 'green', `Updated the global ${step.package} from ${step.from} to ${step.to}.`)
          : paint(color, 'red', `Could not update the global ${step.package}: ${step.detail ?? 'no reason given'}`),
      );
    }
  }
  if (result.status === 'up-to-date') lines.push('Everything here is at the latest release. Nothing was changed.');
  if (result.status === 'manual') lines.push('Nothing was changed: what is behind is left for you.');
  for (const item of result.manual) {
    lines.push(paint(color, 'yellow', `Left for you: ${describeItem(item)}`), `  ${item.reason ?? ''}`);
  }
  if (result.next) lines.push('', result.next);
  // On its own line, last, as a sentence: the update was installed, and only the daily check's file lags behind it.
  if (result.recordNote) lines.push(`${result.recordNote.charAt(0).toUpperCase()}${result.recordNote.slice(1)}.`);
  return lines.join('\n');
}
