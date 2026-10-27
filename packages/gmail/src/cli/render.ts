import {
  type CliHandoffs,
  type ConnectionPartResult,
  type Handoff,
  handoffSentence,
  handoffSentenceToFill,
  handoffText,
  handoffTextToFill,
  type InstallResult,
  paint,
  renderConnectionPart,
  renderInstall,
  type ServerInstallResult,
  sizeOf,
} from '@agentcomms/core';
import type { RegistrationIntent } from '../auth/flows.ts';
import type { LabelSummary, SendAsSummary } from '../operations/analyse.ts';
import type { DownloadQuestion, DownloadResult, FindAttachmentsResult } from '../operations/attachments.ts';
import type { ClientAddResult, ClientView } from '../operations/clients.ts';
import type { ConsentResult } from '../operations/consent.ts';
import type { ContactsResult, FollowUpsResult } from '../operations/contacts.ts';
import type { DoctorResult } from '../operations/doctor.ts';
import type { DraftResult, DraftSummary } from '../operations/drafts.ts';
import type { ImportResult } from '../operations/import-legacy.ts';
import type { InboxView, WhoamiResult } from '../operations/inboxes.ts';
import type { ModifyResult, TrashResult } from '../operations/organise.ts';
import type { ReadMessageResult, ReadThreadResult } from '../operations/read.ts';
import type { SearchResult } from '../operations/search.ts';
import type { ApprovalList, SendPreparation, SendResult } from '../operations/send.ts';
import { FINISH_WAIT_SECONDS, type StartedSignIn } from '../operations/signin.ts';
import type { UnsentDraft, UnsentSection } from '../operations/unsent.ts';

type ApprovalView = ApprovalList['approvals'][number];

/**
 * Human renderings. `--json` prints the data itself; these exist so a person is not made to read JSON.
 *
 * A command one names is this installation's own, located from the handoffs it is given (`GmailContext.handoffs`,
 * CUE-403), quoted for the shell of the output — or, with none here, the sentence saying why.
 */

function table(rows: string[][], color: boolean): string {
  const header = rows[0];
  if (!header) return '';
  const widths = header.map((_, column) => Math.max(...rows.map((row) => (row[column] ?? '').length)));
  return rows
    .map((row, index) => {
      const line = row
        .map((cell, column) => (cell ?? '').padEnd(widths[column] ?? 0))
        .join('  ')
        .trimEnd();
      return index === 0 ? paint(color, 'dim', line) : line;
    })
    .join('\n');
}

export function renderClients(clients: ClientView[], color: boolean, handoffs: CliHandoffs): string {
  if (clients.length === 0) {
    return handoffSentenceToFill(
      handoffs.own(['client', 'add']),
      ['<client_secret.json>'],
      (command) => `No OAuth client registered yet. Add one with ${command}.`,
      { instead: 'No OAuth client registered yet.' },
    );
  }
  return table(
    [
      ['NAME', 'CLIENT ID', 'PROJECT', 'INBOXES'],
      ...clients.map((client) => [
        client.name,
        client.clientId,
        client.projectId ?? '—',
        client.inboxes.length ? client.inboxes.join(', ') : '—',
      ]),
    ],
    color,
  );
}

export function renderClientAdd(result: ClientAddResult, color: boolean, handoffs: CliHandoffs): string {
  const lines = [
    `Registered the OAuth client "${result.name}".`,
    `  client id: ${result.clientId}`,
    `  secrets:   ${result.store === 'keychain' ? 'the system keychain' : 'owner-only files in the config directory'}`,
  ];
  if (result.probeSkippedReason) lines.push(paint(color, 'yellow', `  note: ${result.probeSkippedReason}`));
  if (result.sourceRemoved) lines.push('  the downloaded file was deleted');
  lines.push(
    '',
    handoffSentenceToFill(
      handoffs.own(['inbox', 'add', '--start']),
      ['<name>'],
      (command) => `Next: connect a mailbox with ${command}.`,
    ),
  );
  return lines.join('\n');
}

export function renderSignInStarted(
  started: StartedSignIn,
  mode: 'add' | 'reauth',
  color: boolean,
  handoffs: CliHandoffs,
): string {
  const finish = handoffText(
    handoffs.own(['inbox', mode, '--finish', started.flowId, '--wait', String(FINISH_WAIT_SECONDS)]),
  );
  return [
    paint(
      color,
      'bold',
      mode === 'add' ? 'Open this link to connect the mailbox:' : 'Open this link to sign in again:',
    ),
    started.authUrl,
    '',
    'Google will warn that the app is not verified — that is expected for a client you made yourself:',
    'choose Advanced, then "Go to … (unsafe)", and leave every permission ticked.',
    '',
    `Then run: ${finish}`,
    paint(color, 'dim', `The link works for ten minutes (until ${started.expiresAt}).`),
    // The link is a one-time capability and it has just been printed — into a terminal, a transcript, a log. Whoever
    // opens it decides which Google account gets connected, and without `--email` nothing checks that afterwards.
    ...(started.expectedEmail
      ? []
      : [
          paint(
            color,
            'yellow',
            'This link connects whichever Google account opens it. Keep it to yourself, and check the address ' +
              'reported when it finishes — or pass --email <address> next time, which refuses anything else.',
          ),
        ]),
  ].join('\n');
}

/**
 * What became of the registration a finished sign-in carried from `setup --mcp-client`, reported beside the mailbox.
 *
 * Beside it, never instead of it: the mailbox is connected whatever happens here, and a registration waiting for a
 * person, or refused, is not a sign-in that failed. Nor is one that did not happen reported as one that did — each
 * outcome says which it is, and only `registered` carries an install that wrote an entry.
 */
export type FinishRegistration =
  /**
   * The client's entry of ours under the name `setup` registers already serves this mailbox (`clientServesInbox`) —
   * or, from 0.35.0, its MCP connection's Gmail part reaches it (`connectionServesInbox`), and `connection` names it.
   */
  | { client: string; status: 'already-registered'; connection?: string | undefined }
  | { client: string; status: 'registered'; install: ServerInstallResult }
  /** Gmail put into the app's MCP connection, or a connection made for it (single-server design D17). */
  | { client: string; status: 'registered'; connection: ConnectionPartResult }
  | {
      client: string;
      status: 'approval-required';
      approvalId: string;
      policy: string;
      summary: string;
      /** What the person reads before agreeing. */
      preview: string;
      expiresAt: string;
      /**
       * The command that claims the approval once the person has agreed: this installation's own `mcp install`, the same
       * change, located — or why there is none here. Written out as its text with `--json` (`PrintedCommand.toJSON`).
       */
      claim: Handoff;
      hint: string;
    }
  | {
      client: string;
      status: 'not-registered';
      reason: string;
      hint?: string | undefined;
      /** Present when the install ran and only printed the entry: what to paste instead. */
      install?: InstallResult | undefined;
    };

function renderFinishRegistration(registration: FinishRegistration, color: boolean): string {
  const { client } = registration;
  switch (registration.status) {
    case 'already-registered':
      return registration.connection === undefined
        ? `Setup asked for the Gmail server to be registered with ${client}; its entry there already serves this mailbox, so nothing was changed.`
        : `Setup asked for Gmail to be put into ${client}'s MCP connection; its connection "${registration.connection}" already reaches this mailbox, so nothing was changed.`;
    case 'registered':
      return 'connection' in registration
        ? [
            `Setup asked for Gmail to be put into ${client}'s MCP connection:`,
            renderConnectionPart(registration.connection, color),
          ].join('\n')
        : [
            `Setup asked for the Gmail server to be registered with ${client}:`,
            renderInstall(registration.install, color),
          ].join('\n');
    case 'approval-required':
      return [
        paint(
          color,
          'bold',
          `Setup also asked to register the Gmail server with ${client}. That waits for the person's approval:`,
        ),
        '',
        registration.preview,
        '',
        registration.hint,
      ].join('\n');
    case 'not-registered':
      return [
        paint(color, 'yellow', `The Gmail server was not registered with ${client}: ${registration.reason}`),
        ...(registration.hint ? [registration.hint] : []),
        ...(registration.install ? [renderInstall(registration.install, color)] : []),
      ].join('\n');
  }
}

export function renderSignedIn(
  result: ConsentResult & { registration?: FinishRegistration | undefined },
  color: boolean,
  handoffs: CliHandoffs,
): string {
  const lines = [
    paint(
      color,
      'green',
      result.reauthorised
        ? `Signed in again as ${result.inbox.email}.`
        : `Connected ${result.inbox.email} as "${result.alias}".`,
    ),
    `  access: ${result.inbox.tier}${result.inbox.contacts ? ' + contacts' : ''}`,
    `  client: ${result.client}${result.organisation ? ` (organisation ${result.organisation})` : ''}`,
  ];
  if (result.missingScopes.length > 0) {
    lines.push(
      paint(color, 'yellow', `  not granted: ${result.missingScopes.join(', ')}`),
      `  ${handoffSentence(handoffs.own(['inbox', 'reauth', result.alias]), (command) => `to grant it: ${command}`)}`,
    );
  }
  lines.push(
    '',
    handoffSentence(handoffs.own(['whoami', '--inbox', result.alias]), (command) => `Check it: ${command}`),
  );
  if (result.registration) lines.push('', renderFinishRegistration(result.registration, color));
  return lines.join('\n');
}

export function renderInboxList(inboxes: InboxView[], color: boolean, handoffs: CliHandoffs): string {
  if (inboxes.length === 0) {
    return handoffSentenceToFill(
      handoffs.own(['inbox', 'add']),
      ['<name>'],
      (command) => `No mailbox connected yet. Connect one with ${command}.`,
      { instead: 'No mailbox connected yet.' },
    );
  }
  return table(
    [
      ['NAME', 'ADDRESS', 'ACCESS', 'CLIENT', 'SENDING', 'HEALTH'],
      ...inboxes.map((inbox) => [
        inbox.alias,
        inbox.email,
        inbox.tier + (inbox.contacts ? '+contacts' : ''),
        inbox.client + (inbox.organisation ? ` (${inbox.organisation})` : ''),
        inbox.sendPolicy + (inbox.sendPolicyInherited ? ' (default)' : ''),
        inbox.health === 'ok' ? 'ok' : inbox.health === 'unknown' ? 'not used yet' : 'needs attention',
      ]),
    ],
    color,
  );
}

export function renderInboxShow(
  inbox: InboxView & { grantedScopes: string[]; internalDomains: string[] },
  color: boolean,
): string {
  const lines = [
    paint(color, 'bold', `${inbox.alias} — ${inbox.email}`),
    `  id:          ${inbox.id}`,
    `  access:      ${inbox.tier} (${inbox.capabilities.join(', ')})`,
    `  sending:     ${inbox.sendPolicy}${inbox.sendPolicyInherited ? ' (from defaults)' : ''}`,
    `  changes:     ${inbox.changePolicy}${inbox.changePolicyInherited ? ' (from defaults)' : ''}`,
    `  client:      ${inbox.client}`,
    ...(inbox.organisation ? [`  organisation: ${inbox.organisation}`] : []),
    `  account id:  ${inbox.identity === 'oidc' ? 'known' : 'not known (imported)'}`,
    `  connected:   ${inbox.createdAt}`,
    `  last refresh:${inbox.lastRefreshOkAt ? ` ${inbox.lastRefreshOkAt}` : ' never'}`,
    `  internal domains: ${inbox.internalDomains.length ? inbox.internalDomains.join(', ') : '—'}`,
  ];
  if (inbox.lastError) {
    lines.push(paint(color, 'yellow', `  last error:  ${inbox.lastError.code} — ${inbox.lastError.message}`));
  }
  return lines.join('\n');
}

export function renderWhoami(result: WhoamiResult, color: boolean): string {
  const lines = [
    paint(color, 'bold', `${result.alias} — ${result.profileEmail}`),
    `  access:   ${result.tier} (${result.capabilities.join(', ')})`,
    `  sending:  ${result.sendPolicy}`,
    `  messages: ${result.messagesTotal} in ${result.threadsTotal} threads`,
  ];
  if (!result.matches) {
    lines.push(
      paint(
        color,
        'yellow',
        `  warning: this inbox is recorded as ${result.email}, but Google says ${result.profileEmail}`,
      ),
    );
  }
  return lines.join('\n');
}

export function renderDoctor(result: DoctorResult, color: boolean): string {
  const mark: Record<string, string> = { ok: 'ok  ', warn: 'warn', fail: 'FAIL', skipped: '--  ' };
  const tint: Record<string, Parameters<typeof paint>[1]> = {
    ok: 'green',
    warn: 'yellow',
    fail: 'red',
    skipped: 'dim',
  };
  const lines = result.checks.map((check) => {
    const head = `${paint(color, tint[check.status] ?? 'dim', mark[check.status] ?? '?')}  ${check.title}: ${check.detail}`;
    const fix = check.fix
      ? `\n${check.fix
          .split('\n')
          .map((line) => `      ${paint(color, 'dim', `fix: ${line}`)}`)
          .join('\n')}`
      : '';
    return `${head}${fix}`;
  });
  lines.push('', `${result.summary.ok} ok · ${result.summary.warn} to look at · ${result.summary.fail} broken`);
  return lines.join('\n');
}

export function renderImport(result: ImportResult, color: boolean): string {
  const lines: string[] = [];
  lines.push(
    paint(
      color,
      'bold',
      result.dryRun ? 'Nothing was changed. This is what would be imported:' : 'Imported from the other Gmail server:',
    ),
  );
  if (result.imported.length === 0) lines.push('  (nothing)');
  for (const candidate of result.imported) {
    lines.push(`  ${candidate.alias}: ${candidate.email ?? 'unknown address'} — ${candidate.tier}`);
  }
  for (const candidate of result.skipped) {
    lines.push(paint(color, 'yellow', `  skipped ${candidate.alias}: ${candidate.problem ?? 'not usable'}`));
  }
  if (result.ungatedServers.length > 0) {
    lines.push(
      '',
      paint(color, 'red', 'The other Gmail server is still connected to an agent client.'),
      'Its send tools are not gated by anything here: while it is registered, an agent can send mail without',
      'the approval steps this package adds.',
    );
    for (const finding of result.ungatedServers) {
      lines.push(`  ${finding.packageName} as "${finding.name}" in ${finding.path} (${finding.client})`);
    }
  }
  if (result.nextSteps.length > 0) {
    lines.push('', paint(color, 'bold', 'Next:'));
    for (const step of result.nextSteps) lines.push(`  ${step}`);
  }
  return lines.join('\n');
}

export function renderSearch(result: SearchResult, color: boolean): string {
  const lines: string[] = [];
  if (result.query.rewrites.length > 0) {
    lines.push(paint(color, 'dim', `query: ${result.query.compiled}  (dates read in ${result.query.timezone})`));
  }
  if (result.rows.length === 0) {
    lines.push('Nothing matched.');
  } else {
    for (const [index, row] of result.rows.entries()) {
      const marks = [row.unread ? 'unread' : '', row.attachmentCount > 0 ? `${row.attachmentCount} attached` : '']
        .filter(Boolean)
        .join(' · ');
      lines.push(
        `${paint(color, 'dim', String(index + 1).padStart(2))} ${row.date?.slice(0, 16).replace('T', ' ') ?? '—'}  ${paint(color, 'bold', row.inbox)}  ${row.from?.address ?? 'unknown'}`,
        `   ${row.subject || '(no subject)'}${marks ? paint(color, 'dim', `  [${marks}]`) : ''}`,
        `   ${paint(color, 'dim', `${row.threadId}${row.messageId === row.threadId ? '' : ` · message ${row.messageId}`}`)}`,
      );
    }
  }
  lines.push('');
  lines.push(
    `${result.returned} shown${result.hasMore ? '; more available' : '; that is all of them'}${
      result.hasMore ? ` (continue with --cursor ${result.nextCursor})` : ''
    }`,
  );
  for (const error of result.errors) {
    lines.push(paint(color, 'yellow', `${error.inbox} could not be searched: ${error.message}`));
  }
  return lines.join('\n');
}

export function renderMessage(message: ReadMessageResult, color: boolean): string {
  const lines = [
    paint(color, 'bold', message.subject || '(no subject)'),
    `from: ${message.from?.address ?? 'unknown'}${message.from?.name ? ` (${message.from.name})` : ''}`,
    `to:   ${message.to.map((entry) => entry.address).join(', ') || '—'}`,
  ];
  if (message.cc.length > 0) lines.push(`cc:   ${message.cc.map((entry) => entry.address).join(', ')}`);
  lines.push(`date: ${message.date ?? 'unknown'}   ${paint(color, 'dim', `[${message.inbox}] ${message.messageId}`)}`);

  const warnings: string[] = [];
  if (message.sender.replyToDiffers) warnings.push(`replies would go to ${message.sender.replyToDomains.join(', ')}`);
  if (message.sender.displayNameContainsOtherAddress) warnings.push('the display name contains another address');
  if (message.auth.evaluatedBy === null) warnings.push('Google published no authentication result for this message');
  else if (message.auth.dmarc !== 'pass') warnings.push(`DMARC: ${message.auth.dmarc ?? 'none'}`);
  if (message.sanitisation.hiddenElements > 0) {
    warnings.push(`${message.sanitisation.hiddenElements} hidden element(s) removed`);
  }
  if (message.sanitisation.plainHtmlMismatch) {
    warnings.push(
      `the plain-text part carries ${message.sanitisation.plainHtmlMismatch.extraChars} characters the reader never sees`,
    );
  }
  for (const warning of warnings) lines.push(paint(color, 'yellow', `!     ${warning}`));

  if (message.attachments.length > 0) {
    lines.push('', paint(color, 'bold', 'Attachments'));
    // The name the sender gave is wrapped, several lines long, and so is a type that is more than a type: each is
    // printed as it came, never folded into a line of the tool's own.
    for (const attachment of message.attachments) {
      lines.push(
        `  part ${attachment.partId} · ${Math.round(attachment.size / 1024)} KB${
          attachment.riskFlags.length ? paint(color, 'yellow', `  [${attachment.riskFlags.join(', ')}]`) : ''
        }`,
        `  type ${attachment.mimeType}`,
        attachment.filename,
      );
    }
  }

  lines.push('', message.body.enveloped);
  if (message.body.truncated) {
    lines.push(paint(color, 'dim', `(truncated; continue with --offset ${message.body.nextOffset})`));
  }
  return lines.join('\n');
}

export function renderThread(thread: ReadThreadResult, color: boolean): string {
  const lines = [
    paint(color, 'bold', `${thread.subject || '(no subject)'} — ${thread.messageCount} messages`),
    paint(color, 'dim', `${thread.inbox} · ${thread.threadId} · ${thread.participants.join(', ')}`),
  ];
  for (const message of thread.messages) {
    lines.push(
      '',
      paint(color, 'dim', `── ${message.date ?? 'unknown'} · ${message.from?.address ?? 'unknown'}`),
      message.body.enveloped,
    );
  }
  if (thread.truncated)
    lines.push('', paint(color, 'dim', '(the thread was cut short; read single messages for more)'));
  return lines.join('\n');
}

export function renderLabels(labels: LabelSummary[], color: boolean): string {
  if (labels.length === 0) return 'No labels.';
  return table(
    [
      ['NAME', 'ID', 'TYPE', 'TOTAL', 'UNREAD'],
      ...labels.map((label) => [
        label.name,
        label.id,
        label.type,
        String(label.messagesTotal ?? '—'),
        String(label.messagesUnread ?? '—'),
      ]),
    ],
    color,
  );
}

export function renderSendAs(addresses: SendAsSummary[], color: boolean): string {
  if (addresses.length === 0) return 'No send-as addresses.';
  return table(
    [
      ['ADDRESS', 'NAME', 'DEFAULT', 'VERIFIED', 'SIGNATURE'],
      ...addresses.map((entry) => [
        entry.email,
        entry.displayName || '—',
        entry.isDefault ? 'yes' : '',
        entry.verificationStatus ?? '—',
        entry.hasSignature ? 'yes' : '',
      ]),
    ],
    color,
  );
}

export function renderAttachments(result: FindAttachmentsResult, color: boolean, handoffs: CliHandoffs): string {
  if (result.rows.length === 0) return 'No attachments matched.';
  // A block per attachment rather than a table: the file name, and an address or a type that is more than one, come
  // wrapped, several lines each — they cannot sit in a cell, and printed bare they would read as the tool's own words.
  const lines: string[] = [];
  for (const [index, row] of result.rows.entries()) {
    lines.push(
      `${paint(color, 'dim', String(index + 1).padStart(2))} ${row.date?.slice(0, 10) ?? '—'}  ${paint(color, 'bold', row.inbox)}  ` +
        `message ${row.messageId} · part ${row.partId} · ${Math.round(row.size / 1024)} KB${
          row.riskFlags.length ? paint(color, 'yellow', `  [${row.riskFlags.join(', ')}]`) : ''
        }`,
      `   from ${row.from ?? 'unknown'}`,
      `   type ${row.mimeType}`,
      row.filename,
    );
  }
  lines.push(
    '',
    handoffSentenceToFill(
      handoffs.own(['attachments', 'download'], { downloads: true }),
      ['<messageId>', '--inbox', '<name>', '--part', '<partId>'],
      (command) => `${result.rows.length} attachment(s). Download with ${command}.`,
      { instead: `${result.rows.length} attachment(s).` },
    ),
  );
  if (result.driveLinks > 0) {
    lines.push(
      paint(color, 'dim', `${result.driveLinks} Drive link(s) were skipped: they are links, not files in the message.`),
    );
  }
  for (const error of result.errors) lines.push(paint(color, 'yellow', `${error.inbox}: ${error.message}`));
  return lines.join('\n');
}

/**
 * The question a download asks before it saves anything: each file — its size, where it came from, and the name the
 * sender gave it, wrapped — and then the three places, the first two by their paths.
 */
export function renderDownloadQuestion(question: DownloadQuestion, color: boolean): string {
  const lines: string[] = [];
  for (const [index, file] of question.files.entries()) {
    lines.push(
      `${paint(color, 'dim', String(index + 1).padStart(2))} ${sizeOf(file.size)} · message ${file.messageId} · part ${file.partId} · from ${file.from ?? 'unknown'}${
        file.riskFlags.length ? paint(color, 'yellow', `  [${file.riskFlags.join(', ')}]`) : ''
      }`,
      file.filename,
    );
  }
  for (const skip of question.skipped) {
    lines.push(paint(color, 'yellow', `not saved ${skip.messageId}: ${skip.reason}`));
  }
  lines.push('', question.question);
  return lines.join('\n');
}

/** A field a result carries inside the untrusted-content envelope, rather than bare. */
function isWrapped(value: string): boolean {
  return value.startsWith('<untrusted-content');
}

export function renderDownloads(result: DownloadResult, color: boolean): string {
  const lines: string[] = [];
  for (const file of result.files) {
    // Where it went, and how big it is; then the name the sender gave it, wrapped. A path that ends in the sender's
    // words is wrapped too, and gets lines of its own rather than sitting inside one of the tool's.
    const wrapped = isWrapped(file.path);
    lines.push(
      `${file.duplicate ? paint(color, 'dim', 'same as') : 'saved '} ${wrapped ? `in ${result.folder}` : file.path} · ${sizeOf(file.size)} · from ${file.from ?? 'unknown'}` +
        (file.riskFlags.length ? paint(color, 'yellow', `  [${file.riskFlags.join(', ')}]`) : ''),
      ...(wrapped ? [file.path] : []),
      file.filename,
    );
  }
  for (const skip of result.skipped) lines.push(paint(color, 'yellow', `skipped ${skip.messageId}: ${skip.reason}`));
  // What the person should know before opening any of them: a rename, a flag, a mark that could not be made.
  for (const warning of result.warnings) lines.push(paint(color, 'yellow', `! ${warning}`));
  const saved = result.files.filter((file) => !file.duplicate).length;
  lines.push(
    '',
    result.folder === null
      ? 'Nothing was saved.'
      : `${saved} file(s), ${sizeOf(result.totalBytes)}, saved in ${result.folder}.`,
    paint(color, 'dim', 'Nothing was opened or run.'),
  );
  return lines.join('\n');
}

export function renderContacts(result: ContactsResult, color: boolean): string {
  if (result.contacts.length === 0) return `Nobody matched "${result.query}".`;
  const lines = [
    table(
      [
        ['ADDRESS', 'NAME', 'INBOX', 'WHERE FROM', 'MESSAGES', 'LAST SEEN'],
        ...result.contacts.map((contact) => [
          contact.email,
          contact.name || '—',
          contact.inbox,
          contact.sources.join('+'),
          contact.messages ? String(contact.messages) : '—',
          contact.lastSeen?.slice(0, 10) ?? '—',
        ]),
      ],
      color,
    ),
    '',
    paint(
      color,
      'dim',
      'Similar addresses are shown, not filtered: a lookalike domain matches a name as readily as the real one.',
    ),
  ];
  for (const error of result.errors) lines.push(paint(color, 'yellow', `${error.inbox}: ${error.message}`));
  return lines.join('\n');
}

export function renderFollowUps(result: FollowUpsResult, color: boolean): string {
  if (result.rows.length === 0) return 'Nothing is waiting.';
  const lines = [
    table(
      [
        ['DAYS', 'INBOX', 'WITH', 'SUBJECT', 'THREAD'],
        ...result.rows.map((row) => [
          String(row.ageDays),
          row.inbox,
          row.with,
          row.subject || '(no subject)',
          row.threadId,
        ]),
      ],
      color,
    ),
    '',
    result.rows[0]?.direction === 'awaiting-them'
      ? 'These are conversations where you spoke last.'
      : 'These arrived and have not been answered.',
  ];
  for (const error of result.errors) lines.push(paint(color, 'yellow', `${error.inbox}: ${error.message}`));
  return lines.join('\n');
}

export function renderDraft(result: DraftResult, color: boolean): string {
  // The preview is the point of the command, so it is printed as it is: it is what the user approves or rejects, and
  // reformatting it here would mean the thing approved is not the thing shown.
  const lines = [result.preview];
  if (result.attachments.length > 0) {
    lines.push(
      '',
      table(
        [
          ['ATTACHED', 'SIZE', 'TYPE', 'FROM'],
          ...result.attachments.map((attachment) => [
            attachment.filename,
            `${Math.max(1, Math.round(attachment.size / 1024))} KB`,
            attachment.mimeType,
            attachment.source,
          ]),
        ],
        color,
      ),
    );
  }
  for (const warning of result.warnings) lines.push(paint(color, 'yellow', `! ${warning}`));
  lines.push(
    '',
    paint(color, 'dim', `Saved as a draft in ${result.inbox} (${result.draftId}). Nothing has been sent.`),
    paint(color, 'dim', 'Open it in Gmail to send it, or ask for it to be sent and approve the send when prompted.'),
  );
  // Its last preparation expired: what the records read say of it, as `send list` says it (design 2026-10-05 §D9).
  if (result.unsent !== undefined) {
    lines.push(
      '',
      paint(color, 'dim', 'Its last preparation to send expired:'),
      ...unsentLines(result.unsent, color).slice(1),
    );
  }
  if (result.profile) lines.push('', paint(color, 'dim', '— writing profile —'), result.profile);
  return lines.join('\n');
}

export function renderDrafts(drafts: DraftSummary[], color: boolean): string {
  if (drafts.length === 0) return 'No drafts.';
  // A last column only when a draft's last preparation expired: what the records read say of it (§D9).
  const history = drafts.some((draft) => draft.unsent !== undefined);
  return table(
    [
      ['DRAFT', 'TO', 'SUBJECT', 'UPDATED', ...(history ? ['LAST PREPARATION EXPIRED'] : [])],
      ...drafts.map((draft) => [
        draft.draftId,
        draft.to.join(', ') || '—',
        draft.subject || '(no subject)',
        draft.updatedAt?.slice(0, 16).replace('T', ' ') ?? '—',
        ...(history ? [draft.unsent?.said ?? '—'] : []),
      ]),
    ],
    color,
  );
}

export function renderModify(result: ModifyResult, color: boolean, handoffs: CliHandoffs): string {
  const what = [
    result.addLabelIds.length > 0 ? `+${result.addLabelIds.join(' +')}` : '',
    result.removeLabelIds.length > 0 ? `-${result.removeLabelIds.join(' -')}` : '',
  ]
    .filter(Boolean)
    .join(' ');
  const scope = `${result.messages} message${result.messages === 1 ? '' : 's'}`;
  if (result.dryRun) {
    const lines = [`Would change ${scope} in ${result.inbox}: ${what}.`, paint(color, 'dim', 'Nothing was changed.')];
    return lines.join('\n');
  }
  const lines = [`Changed ${scope} in ${result.inbox}: ${what}.`];
  if (result.undo && result.undo.length > 0) {
    // The undo differs per message, so it is not a command line to retype — it is the `undo` array from `--json`.
    lines.push(
      paint(
        color,
        'dim',
        `${result.undo.length} message(s) can be put back exactly as they were: ${handoffSentence(
          handoffs.own(['organise-undo', '--inbox', result.inbox]),
          (command) => `re-run with --json, then pipe its \`undo\` into ${command}.`,
        )}`,
      ),
    );
  } else {
    lines.push(paint(color, 'dim', 'Nothing to put back: every message already had these labels.'));
  }
  return lines.join('\n');
}

export function renderTrash(result: TrashResult, color: boolean): string {
  const count = `${result.messages.length} message${result.messages.length === 1 ? '' : 's'}`;
  const verb = result.action === 'trash' ? 'Moved' : 'Restored';
  const where = result.action === 'trash' ? 'to the bin' : 'from the bin';
  // The preview has to name the operation it is previewing. This branch hard-coded "to the bin" while `result.action`
  // already said `untrash`, so someone recovering from a bad bulk bin — exactly the person who runs a dry run first —
  // was told their restore would bin forty more messages. The preview is the one place that claim gets checked.
  if (result.dryRun) {
    const would = result.action === 'trash' ? 'move' : 'restore';
    return `Would ${would} ${count} ${where} in ${result.inbox}.\n${paint(color, 'dim', 'Nothing was changed.')}`;
  }
  return [
    `${verb} ${count} ${where} in ${result.inbox}.`,
    paint(color, 'dim', 'Gmail keeps a binned message for thirty days; nothing is deleted outright.'),
  ].join('\n');
}

export function renderSendPreparation(result: SendPreparation, color: boolean, handoffs: CliHandoffs): string {
  // The preview verbatim, then what has to happen: reformatting the preview would mean the thing shown is not the
  // thing the digest was taken over.
  const lines = [result.preview, ''];
  if (result.riskFlags.length > 0) {
    lines.push(paint(color, 'yellow', `! raised to "confirm": ${result.riskFlags.join(', ')}`));
  }
  // Where the approval stands (design 2026-10-05 §D8): its state, and whether a yes in the chat sends it.
  const waiting = result.approval.claimable ? 'a yes in the chat sends it' : 'it waits for a person outside the chat';
  lines.push(
    paint(
      color,
      'dim',
      `Approval ${result.approvalId} is ${result.approval.state}: ${waiting}. Good until ${result.expiresAt.slice(11, 16)} UTC.`,
    ),
    result.nextStep,
    paint(color, 'dim', `Then: ${handoffText(handoffs.own(sendExecuteWords(result)))}`),
  );
  return lines.join('\n');
}

/**
 * The words, after the program, of the command that sends what was prepared: a command to show, never one run here —
 * only `send execute` sends, through `executeSend`, with the person's approval.
 */
function sendExecuteWords(result: SendPreparation): string[] {
  return ['send', 'execute', result.approvalId, '--inbox', result.inbox];
}

export function renderSent(result: SendResult, color: boolean): string {
  const lines = [
    `Sent to ${result.to.join(', ') || '(nobody in To)'}${result.cc.length > 0 ? ` · cc ${result.cc.join(', ')}` : ''}.`,
    paint(
      color,
      'dim',
      result.sentMessageId === undefined
        ? // Accepted without an id: said exactly so, and recorded as nothing more (design 2026-10-05 §D8).
          `In ${result.inbox}, approval ${result.approvalId} (${result.approval.state}): ${result.said}.`
        : `Message ${result.sentMessageId} in ${result.inbox}, approval ${result.approvalId} (${result.approval.state}).`,
    ),
  ];
  if (result.sentMessageId === undefined) {
    lines.push(paint(color, 'yellow', 'With no id there is nothing to read it back by: look for it in Sent.'));
  } else if (result.verified) {
    lines.push(
      paint(
        color,
        'dim',
        `Read back from the mailbox: ${result.verified.labelIds.join(', ') || 'no labels'}${
          result.verified.threadId ? ` · conversation ${result.verified.threadId}` : ''
        }.`,
      ),
    );
  } else {
    lines.push(paint(color, 'yellow', 'The message was sent but could not be read back to confirm where it landed.'));
  }
  if (result.note) lines.push(paint(color, 'yellow', `Note: ${result.note}.`));
  return lines.join('\n');
}

export function renderApprovals(list: ApprovalList, color: boolean): string {
  const unsent = renderUnsent(list.unsent, color);
  const approvals = approvalsTable(list.approvals, color);
  return unsent === '' ? approvals : `${approvals}\n\n${unsent}`;
}

function approvalsTable(records: ApprovalView[], color: boolean): string {
  if (records.length === 0) return 'No approvals waiting.';
  // Every form: what a record has of these columns, and a dash for what it has not — a stub has only its id, and
  // `corrupt` with the reason as its state.
  return table(
    [
      ['APPROVAL', 'INBOX', 'STATE', 'DRAFT', 'TO', 'EXPIRES'],
      ...records.map((record) => [
        record.approvalId,
        record.inbox ?? '—',
        record.state === 'corrupt'
          ? `corrupt (${record.reason})`
          : record.legacy === true
            ? `${record.state} (earlier release)`
            : record.claimable === true
              ? `${record.state}, claimable`
              : record.reason !== undefined && (record.state === 'revoked' || record.state === 'failed')
                ? `${record.state} (${record.reason})`
                : record.state,
        record.draftId ?? '—',
        record.expect?.to.join(', ') || '—',
        record.expiresAt !== undefined ? record.expiresAt.slice(11, 16) : '—',
      ]),
    ],
    color,
  );
}

/** What the scan behind an unsent finding read, in a person's words. */
const EVIDENCE_WORDS: Record<string, string> = {
  'complete-90-days': 'every approval record kept (90 days) was read',
  'last-500': 'only the 500 most recently changed approval records were read',
  indeterminate: 'what could be read cannot settle it',
};

/**
 * The unsent section of `send list` (design 2026-10-05 §D9): each draft whose last preparation expired, what the records
 * read say of it — in their exact words — what Drafts says of it now, and the command that prepares it again. Nothing
 * when there is nothing to say.
 */
function renderUnsent(section: UnsentSection, color: boolean): string {
  const cutShort = section.truncated.includes('deadline');
  if (section.rows.length === 0) {
    return cutShort
      ? paint(color, 'yellow', 'Drafts whose approvals expired could not be checked: the report deadline came first.')
      : '';
  }
  const lines = [
    paint(
      color,
      'bold',
      `Drafts whose last preparation expired, prepared in the last 7 days (${EVIDENCE_WORDS[section.evidence] ?? section.evidence}):`,
    ),
  ];
  for (const row of section.rows) lines.push(...unsentLines(row, color).map((line) => `  ${line}`));
  if (section.truncated.includes('rows')) {
    lines.push(paint(color, 'dim', 'More drafts qualified than are shown: the older ones are left out.'));
  }
  if (cutShort) {
    lines.push(
      paint(
        color,
        'yellow',
        'The report deadline stopped it early: what it could not read is indeterminate, and a look-up it did not start is not observed.',
      ),
    );
  }
  return lines.join('\n');
}

/** One unsent draft: which, to whom, what its history says, what Drafts says, and how to prepare it again. */
function unsentLines(row: UnsentDraft, color: boolean): string[] {
  const to = row.to.join(', ') || '(nobody in To)';
  const lines = [
    `${row.inbox} ${row.draftId} — to ${to}: ${row.subject || '(no subject)'}`,
    `  ${paint(color, row.status === 'unsent' ? 'yellow' : 'dim', row.said)}; ${row.drafts.said}.`,
  ];
  if (row.attachments !== null && row.attachments.length > 0) {
    lines.push(`  attached: ${row.attachments.join(', ')}`);
  }
  lines.push(
    paint(
      color,
      'dim',
      `  last prepared ${row.last.createdAt.slice(0, 16).replace('T', ' ')} (${row.last.approvalId})${
        row.last.expiredAt === undefined ? '' : `, expired ${row.last.expiredAt.slice(0, 16).replace('T', ' ')}`
      }`,
    ),
  );
  if (row.prepare !== null) {
    lines.push(
      `  ${handoffSentence(row.prepare.command, (command) => `Prepare it again with ${command}.`, {
        instead: 'Prepare it again with gmail_send_prepare from a chat.',
      })}`,
    );
  }
  return lines;
}

/**
 * How each kind of downloaded client file is named to a person.
 *
 * Shared, because two surfaces show it and they had drifted: the list you choose from called a web client "will
 * be refused" while the plan printed beside it called the same file "not usable" — two wordings for one problem,
 * reading like two problems with two different fixes. Keyed loosely because the renderer takes a plain shape and
 * an unknown kind is better described than dropped.
 */
export const CLIENT_KIND_LABEL: Record<string, string> = {
  desktop: 'Desktop app',
  web: 'Web application — will be refused',
  unreadable: 'Not a client JSON — will be refused',
};

/**
 * A sign-in `setup` hands to a person: the link they open, and the command that finishes it — this installation's own
 * `inbox add --finish`, located, or why there is none here; written out as its text with `--json`.
 */
export interface SetupHandoff {
  authUrl: string;
  finish: Handoff;
  registerWith?: RegistrationIntent | undefined;
}

/**
 * The setup, written out for somebody who cannot be prompted — an agent, a pipe, `--json`.
 *
 * Every step here needs a browser this code does not drive: the console, and Google's consent screen. So the answer for a
 * non-interactive caller is the instructions rather than a refusal, and rather than half-running something that
 * will stop at the first question.
 */
export function renderSetupPlan(
  state: {
    next: string;
    done: readonly string[];
    clients: string[];
    inboxes: string[];
    registeredWith: string[];
    clientChoice?: {
      name: string;
      organisation?: string | undefined;
      organisationLabel?: string | undefined;
    } | null;
    candidates: { path: string; kind: string; modifiedAt: string }[];
    /** What this run changed, when it was driven by flags rather than by questions. */
    did?: readonly string[] | undefined;
    /** What a step it ran had to warn about: a pin the MCP install kept, another Gmail server. */
    warnings?: readonly string[] | undefined;
    /** Why it stopped, if it did — with the preview, when what it waits for is a person approving a change. */
    blocked?:
      | { step: string; needs: string; hint?: string | undefined; preview?: string | undefined }
      | null
      | undefined;
    /**
     * The link and the command, when the only thing left is a person approving it — and the registration the finish
     * will go on to ask for, when `--mcp-client` came with the mailbox.
     */
    handoff?: SetupHandoff | null | undefined;
    /** A name the config accepts, for the examples: `acme/gmail` once names are organisation/platform. */
    nameExample?: string | undefined;
  },
  steps: readonly { title: string; url: string; why: string; actions: readonly string[]; avoid: readonly string[] }[],
  color: boolean,
  handoffs: CliHandoffs,
): string {
  const lines: string[] = [];

  // What this run actually changed, before anything about what is left. A caller that supplied flags did not ask
  // for a plan and needs to know what happened first.
  for (const action of state.did ?? []) lines.push(`${paint(color, 'green', 'done')} ${action}`);
  for (const warning of state.warnings ?? []) lines.push(paint(color, 'red', warning));
  if ((state.did ?? []).length + (state.warnings ?? []).length > 0) lines.push('');

  if (state.handoff) {
    lines.push(paint(color, 'bold', 'This step needs a browser.'));
    lines.push("Consent happens on Google's own screen, and this command cannot grant it. Show them this link:");
    lines.push('');
    lines.push(`  ${state.handoff.authUrl}`);
    lines.push('');
    lines.push('Then, once the browser flow has returned a grant:');
    lines.push(`  ${handoffText(state.handoff.finish)}`);
    // Said here because this is the step that stops before it: `--mcp-client` is not forgotten, it moves to the finish.
    if (state.handoff.registerWith) {
      lines.push(
        state.handoff.registerWith.standalone === true || state.handoff.registerWith.replace === true
          ? `Finishing it will also register the Gmail server with ${state.handoff.registerWith.client}, after the person approves the registration.`
          : `Finishing it will also put Gmail into the MCP connection of ${state.handoff.registerWith.client}, after the person approves it.`,
      );
    }
    return lines.join('\n');
  }

  /*
   * A registration waiting for a person, before "Already set up": a machine registered with one client and asked to
   * register with another is `done` by the state's count, and the one thing to say is what the person must read.
   */
  if (state.blocked?.preview) {
    lines.push(paint(color, 'bold', `Stopped at: ${state.blocked.step}`));
    lines.push(`Needs ${state.blocked.needs}.`);
    lines.push('');
    lines.push(state.blocked.preview);
    if (state.blocked.hint) lines.push('', state.blocked.hint);
    return lines.join('\n');
  }

  if (state.next === 'done') {
    lines.push('Already set up.');
    lines.push(`  mailboxes: ${state.inboxes.join(', ')}`);
    lines.push(`  registered with: ${state.registeredWith.join(', ')}`);
    return lines.join('\n').trimStart();
  }

  if (state.blocked) {
    lines.push(`${paint(color, 'bold', `Stopped at: ${state.blocked.step}`)}`);
    lines.push(`Needs ${state.blocked.needs}.`);
    if (state.blocked.hint) lines.push(paint(color, 'dim', state.blocked.hint));
    lines.push('');
  }

  lines.push(paint(color, 'bold', 'Setup, for a terminal with a person at it'));
  lines.push('');
  lines.push(
    handoffSentence(
      handoffs.own(['setup']),
      (command) => `Run ${command} where you can answer questions and open a browser — or supply the answers`,
    ),
  );
  lines.push('as flags and it will run without one, as far as the consent screen.');
  lines.push('');
  if (state.done.length > 0) lines.push(`Already done: ${state.done.join(', ')}.`);

  if (state.clientChoice?.organisation && state.clientChoice.organisationLabel) {
    lines.push('');
    lines.push(`Your organisation, ${state.clientChoice.organisationLabel}, provides the Google client.`);
  }

  if (state.next === 'client') {
    lines.push('');
    lines.push(paint(color, 'bold', 'A Google OAuth client — once per person, covers every mailbox'));
    for (const [index, step] of steps.entries()) {
      lines.push('');
      lines.push(`  ${index + 1}. ${step.title}`);
      lines.push(`     ${paint(color, 'dim', step.why)}`);
      lines.push(`     ${paint(color, 'dim', step.url)}`);
      for (const action of step.actions) lines.push(`       • ${action}`);
      for (const warning of step.avoid) lines.push(`       ! ${warning}`);
    }
    lines.push('');
    lines.push(`  Then: ${handoffTextToFill(handoffs.own(['setup', '--client-json']), ['<the downloaded JSON>'])}`);
    for (const candidate of state.candidates) {
      const note = CLIENT_KIND_LABEL[candidate.kind] ?? candidate.kind;
      lines.push(`  ${paint(color, 'dim', `found: ${candidate.path} (${note}, ${candidate.modifiedAt})`)}`);
    }
  }

  if (state.inboxes.length === 0) {
    lines.push('');
    lines.push(paint(color, 'bold', 'A mailbox'));
    // `setup`'s own flags, because this is `setup`'s own output. It named `inbox add … --start` — a real command,
    // but a different one, so the text told you to leave the thing you were running while `blocked.needs` beside
    // it correctly said `--inbox <alias>`. Two answers to one question, in the same document.
    lines.push(
      `  ${handoffText(handoffs.own(['setup', '--inbox', state.nameExample ?? 'work', '--email', 'you@example.com']))}`,
    );
    lines.push('  then run the --finish command it prints, after signing in.');
  }

  if (state.registeredWith.length === 0) {
    lines.push('');
    lines.push(paint(color, 'bold', 'The agent connection'));
    lines.push(`  ${handoffText(handoffs.own(['mcp', 'install', '--client', 'claude-code']))}`);
  }

  return lines.join('\n').trimEnd();
}

// Moved to `@agentcomms/core` when Slack needed the same renderer; re-exported so callers here are unchanged.
export { renderInstall, renderPrune } from '@agentcomms/core';
