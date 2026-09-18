import { paint } from '@cloudpixel/comms-core';
import type { InstallResult } from '../mcp/install.ts';
import type { ClientAddResult, ClientView } from '../operations/clients.ts';
import type { ConsentResult } from '../operations/consent.ts';
import type { DoctorResult } from '../operations/doctor.ts';
import type { ImportResult } from '../operations/import-legacy.ts';
import type { InboxView, WhoamiResult } from '../operations/inboxes.ts';
import type { StartedSignIn } from '../operations/signin.ts';

/** Human renderings. `--json` prints the data itself; these exist so a person is not made to read JSON. */

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

export function renderClients(clients: ClientView[], color: boolean): string {
  if (clients.length === 0) {
    return 'No OAuth client registered yet. Add one with `agent-gmail client add <client_secret.json>`.';
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

export function renderClientAdd(result: ClientAddResult, color: boolean): string {
  const lines = [
    `Registered the OAuth client "${result.name}".`,
    `  client id: ${result.clientId}`,
    `  secrets:   ${result.store === 'keychain' ? 'the system keychain' : 'owner-only files in the config directory'}`,
  ];
  if (result.probeSkippedReason) lines.push(paint(color, 'yellow', `  note: ${result.probeSkippedReason}`));
  if (result.sourceRemoved) lines.push('  the downloaded file was deleted');
  lines.push('', 'Next: connect a mailbox with `agent-gmail inbox add <name> --start`.');
  return lines.join('\n');
}

export function renderSignInStarted(started: StartedSignIn, mode: 'add' | 'reauth', color: boolean): string {
  const finish = `agent-gmail inbox ${mode} --finish ${started.flowId} --wait 60`;
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
  ].join('\n');
}

export function renderSignedIn(result: ConsentResult, color: boolean): string {
  const lines = [
    paint(
      color,
      'green',
      result.reauthorised
        ? `Signed in again as ${result.inbox.email}.`
        : `Connected ${result.inbox.email} as "${result.alias}".`,
    ),
    `  access: ${result.inbox.tier}${result.inbox.contacts ? ' + contacts' : ''}`,
  ];
  if (result.missingScopes.length > 0) {
    lines.push(
      paint(color, 'yellow', `  not granted: ${result.missingScopes.join(', ')}`),
      `  to grant it: \`agent-gmail inbox reauth ${result.alias}\``,
    );
  }
  lines.push('', `Check it: \`agent-gmail whoami --inbox ${result.alias}\``);
  return lines.join('\n');
}

export function renderInboxList(inboxes: InboxView[], color: boolean): string {
  if (inboxes.length === 0) return 'No mailbox connected yet. Connect one with `agent-gmail inbox add <name>`.';
  return table(
    [
      ['NAME', 'ADDRESS', 'ACCESS', 'SENDING', 'HEALTH'],
      ...inboxes.map((inbox) => [
        inbox.alias,
        inbox.email,
        inbox.tier + (inbox.contacts ? '+contacts' : ''),
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
    `  client:      ${inbox.client}`,
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
    return check.fix ? `${head}\n      ${paint(color, 'dim', `fix: ${check.fix}`)}` : head;
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
    lines.push(
      paint(color, 'bold', `Add this to ${result.configPath ?? `the MCP configuration of ${result.client}`}:`),
      result.snippet.trimEnd(),
    );
  }
  lines.push(
    result.verified
      ? paint(color, 'green', `Checked: ${result.verifyDetail}`)
      : paint(color, 'yellow', `Not checked: ${result.verifyDetail ?? 'skipped'}`),
  );
  for (const warning of result.warnings) lines.push('', paint(color, 'red', warning));
  return lines.join('\n');
}
