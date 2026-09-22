import { paint, stripInvisible } from '@agentcomms/core';
import type { DoctorResult } from '../operations/doctor.ts';
import type { StartedSignIn } from '../operations/signin.ts';
import type { WorkspaceView } from '../operations/workspaces.ts';

/**
 * Turning results into something to read at a terminal.
 *
 * Every string a workspace controls has already been neutralised by the operation that produced it, and
 * `stripInvisible` removes escape sequences, lone carriage returns and zero-width characters — so none of that
 * is this layer's job. What is left to do here is the part `stripInvisible` deliberately does not do.
 */

/**
 * One value, safe to put in a row.
 *
 * `stripInvisible` keeps tab and newline on purpose: they are legitimate in a message body, which is what it was
 * written for. They are not legitimate in a table cell. A workspace named `"Acme\nchannels:history, chat:write"`
 * would otherwise print a second line that looks exactly like the scopes row beneath it, in a list whose whole
 * job is to say what each workspace is allowed to do.
 *
 * Bounded for the same reason: a five-hundred-character name is not an attack, but it is a row nobody can read.
 */
function cell(value: string, width = 40): string {
  const { text } = stripInvisible(value);
  const flat = text.replace(/[\t\n]+/g, ' ').trim();
  return flat.length > width ? `${flat.slice(0, width - 1)}…` : flat;
}

export function renderWorkspaces(workspaces: readonly WorkspaceView[], color: boolean): string {
  if (workspaces.length === 0) {
    return [
      'No workspace connected yet.',
      '',
      'Create the Slack app:   agent-slack manifest --port 51234',
      'Then connect it:        agent-slack workspace add <name> --client-id <id> --port 51234',
    ].join('\n');
  }
  return workspaces
    .map((workspace) => {
      const name = workspace.workspaceName ? ` — ${cell(workspace.workspaceName)}` : '';
      return `${paint(color, 'bold', workspace.alias)}${name}\n  ${workspace.mode} · ${workspace.workspaceId} · ${
        workspace.grantedScopes.length
      } scopes`;
    })
    .join('\n');
}

export function renderWorkspace(workspace: WorkspaceView, color: boolean): string {
  const rows: [string, string][] = [
    ['workspace', `${workspace.workspaceId}${workspace.workspaceName ? ` (${cell(workspace.workspaceName)})` : ''}`],
    ['acting as', workspace.userId],
    ['access', workspace.mode],
    ['scopes', workspace.grantedScopes.join(', ')],
    ['connected', workspace.createdAt],
  ];
  if (workspace.oauthClientId) {
    rows.push(['slack app', `${workspace.appId ?? 'unknown'} (client ${workspace.oauthClientId})`]);
  }
  const width = Math.max(...rows.map(([label]) => label.length));
  return [
    paint(color, 'bold', workspace.alias),
    ...rows.map(([label, value]) => `  ${label.padEnd(width)}  ${value}`),
  ].join('\n');
}

/**
 * What was connected, said only once the exchange has happened.
 *
 * The browser page deliberately cannot name the account — at that moment nothing has been exchanged. This can,
 * and it is the only place that should: naming the workspace and the person is what turns a sign-in somebody
 * clicked through into one they can check.
 */
export function renderConnected(workspace: WorkspaceView, reauth: boolean, color: boolean): string {
  const what = workspace.workspaceName
    ? `${cell(workspace.workspaceName)} (${workspace.workspaceId})`
    : workspace.workspaceId;
  return [
    `${paint(color, 'green', '✓')} ${reauth ? 'Re-authorised' : 'Connected'} "${workspace.alias}" — ${what}, as ${workspace.userId}.`,
    '',
    renderWorkspace(workspace, color),
    '',
    paint(color, 'dim', `Access is "${workspace.mode}". Check everything with: agent-slack doctor`),
  ].join('\n');
}

/**
 * Removal says what it did *not* do.
 *
 * Disconnecting here leaves the app installed in the workspace, and somebody who believes otherwise stops
 * looking. Uninstalling it for them is not this command's to do: `apps.uninstall` is refused by the transport
 * precisely because an agent quietly removing an app for a whole workspace is not a local change.
 */
export function renderRemoved(alias: string): string {
  return [
    `Disconnected "${alias}" from this machine. The stored credential is gone.`,
    '',
    'The Slack app is still installed in your workspace. Remove it there through Slack’s own app settings —',
    'nothing here will do that for you.',
  ].join('\n');
}

const FAILED: { text: string; colour: Parameters<typeof paint>[1] } = { text: 'fail', colour: 'red' };

const MARKS: Record<string, { text: string; colour: Parameters<typeof paint>[1] }> = {
  ok: { text: 'ok  ', colour: 'green' },
  // Dim, not yellow: this is "nobody looked", and a diagnostic that warns on every healthy install is one people
  // stop reading.
  unknown: { text: '?   ', colour: 'dim' },
  warn: { text: 'warn', colour: 'yellow' },
  fail: FAILED,
};

export function renderDoctor(result: DoctorResult, color: boolean): string {
  const lines = result.checks.map((check) => {
    const mark = MARKS[check.status] ?? FAILED;
    const fix = check.fix ? `\n      ${paint(color, 'dim', `fix: ${check.fix}`)}` : '';
    return `${paint(color, mark.colour, mark.text)}  ${check.title}: ${check.detail}${fix}`;
  });
  const { ok, unknown, warn, fail } = result.summary;
  const counts = [`${ok} ok`, unknown > 0 ? `${unknown} not checked` : '', `${warn} to look at`, `${fail} broken`]
    .filter(Boolean)
    .join(' · ');
  lines.push('', counts);
  return lines.join('\n');
}

/**
 * The link, and what to do with it.
 *
 * The URL goes on its own line with nothing wrapped around it: a URL broken across two lines by a terminal is a
 * URL that does not paste. `--finish` is printed only for the detached form, because the interactive one is
 * already waiting and telling somebody to run a second command would send them to a flow this process has
 * claimed.
 */
export function renderSignInStarted(started: StartedSignIn, reauth: boolean, color: boolean): string {
  const lines = [
    paint(color, 'bold', `${reauth ? 'Re-authorise' : 'Connect'} ${started.alias} (${started.mode})`),
    '',
    'Open this and approve it in Slack:',
    '',
    `  ${started.authUrl}`,
    '',
    `It expires at ${started.expiresAt}.`,
  ];
  if (!started.listener) {
    lines.push(
      '',
      'Then finish it with:',
      `  agent-slack workspace ${reauth ? `reauth ${started.alias}` : 'add'} --finish ${started.flowId}`,
    );
  } else {
    lines.push('', paint(color, 'dim', 'Waiting for the browser…'));
  }
  return lines.join('\n');
}

/**
 * How to make the Slack app, with the port already in it.
 *
 * The port is the step people get wrong: Slack matches redirect URLs exactly, so a manifest made with one port
 * and a sign-in run with another fails at the redirect with a message about the redirect URI and no hint that two
 * numbers had to match. Printing the exact next command, port included, is the fix.
 */
export function renderManifestHelp(mode: string, port: number, color: boolean): string {
  return [
    paint(color, 'bold', `A Slack app for "${mode}" access`),
    '',
    '1. Open https://api.slack.com/apps and choose "Create New App" → "From a manifest".',
    '2. Pick your workspace, then paste the JSON below.',
    '3. Create the app. On "Basic Information", copy the Client ID.',
    '',
    paint(color, 'dim', 'The Client ID is the only thing you need from that page. It is not a secret, and there'),
    paint(color, 'dim', 'is no client secret to copy: this signs in with PKCE, which replaces one.'),
    '',
    'Then connect it:',
    `  agent-slack workspace add <name> --client-id <the Client ID> --port ${port}`,
    '',
    paint(color, 'dim', `Keep --port ${port}: Slack matches the redirect URL in this manifest exactly.`),
  ].join('\n');
}
