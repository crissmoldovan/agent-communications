import { paint, stripInvisible } from '@agentcomms/core';
import type { AppCreated, AppUpdated } from '../operations/app.ts';
import type { DoctorResult } from '../operations/doctor.ts';
import type { DeletedDraft } from '../operations/drafts.ts';
import type { ModeReport } from '../operations/mode.ts';
import type {
  ChannelsResult,
  FilesResult,
  HistoryResult,
  PeopleResult,
  ReadRow,
  SearchResult,
  ThreadResult,
} from '../operations/read.ts';
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

/** What `draft delete` removed — and, for a draft nobody could read, that what it said is gone unseen. */
export function renderDeletedDraft(deleted: DeletedDraft): string {
  if (!deleted.unreadable) return `Deleted ${deleted.draftId}.`;
  return deleted.workspaceConfirmed
    ? `Deleted ${deleted.draftId}. It could not be read, so what it said was never shown and is gone now.`
    : `Deleted ${deleted.draftId}. It could not be read and did not say which workspace it belonged to, so it was removed on its id alone; what it said is gone.`;
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
/** A workspace's mode, what its recorded grant can do, and what moving it either way takes. */
export function renderMode(report: ModeReport, color: boolean): string {
  const lines = [
    `${paint(color, 'bold', report.alias)} is connected in ${paint(color, 'bold', report.mode)} mode.`,
    report.canActOutward
      ? `The grant recorded at sign-in can act in Slack: ${report.outwardScopes.join(', ')}.`
      : 'The grant recorded at sign-in cannot post, upload or react — Slack refuses it.',
  ];
  const steps = (title: string, list: readonly string[]) =>
    list.length === 0 ? [] : ['', title, ...list.map((step, i) => `  ${i + 1}. ${step}`)];
  lines.push(...steps('To let it post (a person does this; an agent cannot):', report.toSend));
  lines.push(...steps('To take posting away again:', report.toRead));
  return lines.join('\n');
}

export function renderSteps(title: string, steps: readonly string[], color: boolean): string {
  return [paint(color, 'bold', title), ...steps.map((step, i) => `  ${i + 1}. ${step}`)].join('\n');
}

export function renderManifestHelp(
  mode: string,
  port: number,
  color: boolean,
  target: { workspace: string | null; manifestUrl: string | null } = { workspace: null, manifestUrl: null },
): string {
  /*
   * For a workspace already connected, the app to change is the one it signed in through — so the steps are to edit
   * that app, never to create one. A new app is a new installation, and the workspace would go on behaving exactly as
   * before under the old one.
   */
  const steps =
    target.workspace === null
      ? [
          '1. Open https://api.slack.com/apps and choose "Create New App" → "From a manifest".',
          '   (Changing the mode of a workspace already connected? Open its existing app → "App Manifest" instead,',
          '   replace the manifest with the JSON below and save — the same app, not a new one.)',
          '2. Pick your workspace, then paste the JSON below.',
          '3. Create the app. On "Basic Information", copy the Client ID.',
          '',
          paint(color, 'dim', 'The Client ID is the only thing you need from that page. It is not a secret, and there'),
          paint(color, 'dim', 'is no client secret to copy: this signs in with PKCE, which replaces one.'),
          '',
          'Then connect it:',
          `  agent-slack workspace add <name> --client-id <the Client ID> --port ${port}`,
        ]
      : [
          target.manifestUrl === null
            ? `1. Open https://api.slack.com/apps and the app "${target.workspace}" was connected through → "App Manifest". (It signed in before its app was recorded, so there is no direct link.)`
            : `1. Open ${target.manifestUrl} — the manifest of the app "${target.workspace}" was connected through.`,
          '2. Replace the manifest there with the JSON below, and save — the same app, not a new one.',
        ];
  return [
    paint(color, 'bold', `A Slack app for "${mode}" access`),
    '',
    ...steps,
    '',
    paint(color, 'dim', `Keep --port ${port}: Slack matches the redirect URL in this manifest exactly.`),
    '',
    mode === 'read'
      ? paint(
          color,
          'dim',
          `This app can read, search and draft, and Slack itself refuses it any post. For one that can post after your approval, print \`agent-slack manifest --mode send --port ${port}\` — and for a workspace already connected, update this same app with it first: a token can only be granted what its app offers.`,
        )
      : paint(
          color,
          'dim',
          `This app can post, upload and react, each only after your approval. \`agent-slack manifest --mode read --port ${port}\` prints one that cannot post at all. To move an existing workspace from read, update its app with this manifest first, then run \`agent-slack workspace mode ${target.workspace ?? '<name>'} send --port ${port}\`.`,
        ),
  ].join('\n');
}

// ── The app itself ───────────────────────────────────────────────────────────────────────────────────────────

/**
 * What `app update` did, and — first, before the next step — what it did not do.
 *
 * The line people misread is the one about the token: an app updated to `send` sounds like a workspace that can
 * post, and it is not one until a person signs in again. So that is said in words, with the workspace's actual mode.
 */
export function renderAppUpdated(result: AppUpdated, color: boolean): string {
  const lines = [
    `${paint(color, 'green', '✓')} Slack app ${result.appId} now carries the ${paint(color, 'bold', result.mode)} manifest for "${result.alias}".`,
    `  redirect  ${result.redirectUrl}`,
    `  manifest  ${result.manifestPage}`,
  ];
  if (result.permissionsUpdated !== undefined) {
    lines.push(
      `  Slack reports ${result.permissionsUpdated ? 'that its permissions changed' : 'no change to its permissions'}.`,
    );
  }
  lines.push(
    '',
    `This changes what the app may ask for, not what any token already issued can do: "${result.alias}" is still in ${paint(color, 'bold', result.workspaceMode)} mode.`,
  );
  if (result.next.length === 0) {
    lines.push(paint(color, 'dim', 'Nothing else to do.'));
  } else {
    lines.push('', 'Next:', ...result.next.map((step, i) => `  ${i + 1}. ${step}`));
  }
  return lines.join('\n');
}

/** What `app create` made, the one command to run next, and which of Slack's secrets were dropped unseen. */
export function renderAppCreated(result: AppCreated, color: boolean): string {
  const lines = [
    `${paint(color, 'green', '✓')} Created Slack app ${result.appId} from the ${paint(color, 'bold', result.mode)} manifest.`,
    `  Client ID  ${result.clientId}  ${paint(color, 'dim', '(not a secret)')}`,
    `  redirect   ${result.redirectUrl}`,
    `  manifest   ${result.manifestPage}`,
  ];
  if (result.secretsDiscarded.length > 0) {
    lines.push(
      '',
      paint(
        color,
        'dim',
        `Slack also returned its ${result.secretsDiscarded.join(', ')}. None was kept or shown: signing in with PKCE needs none of them.`,
      ),
    );
  }
  lines.push('', 'Connect a workspace through it:', `  ${result.next}`);
  if (result.mode === 'send') {
    lines.push(paint(color, 'dim', 'That asks you to type a code: a workspace that can post is a person’s decision.'));
  }
  lines.push(
    '',
    paint(color, 'dim', `Keep --port ${result.port}: Slack matches the redirect URL in this app exactly.`),
  );
  return lines.join('\n');
}

// ── Reading ──────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A read, printed.
 *
 * Two things are non-negotiable in everything below. The bound is always stated — a list that stopped early says
 * so, because "nothing else was said" and "nothing else was read" look identical in a terminal and only one of
 * them is usually true. And a message whose two halves disagree is marked where it is shown, not in a footnote:
 * that mismatch is the shape an instruction takes when it is meant for a model and not for the room.
 */

export function renderChannels(result: ChannelsResult, color: boolean): string {
  if (result.channels.length === 0) {
    return paint(color, 'dim', 'No channels. `agent-slack channels --all` includes ones you are not in.');
  }
  const lines = [paint(color, 'bold', `${'CHANNEL'.padEnd(30)} ${'KIND'.padEnd(9)} MEMBERS  TOPIC`)];
  for (const channel of result.channels) {
    const kind = channel.isIm ? 'dm' : channel.isMpim ? 'group dm' : channel.isPrivate ? 'private' : 'public';
    const name = channel.isIm ? `(dm ${channel.withUserId ?? '?'})` : `#${channel.name?.text ?? channel.id}`;
    const members = channel.memberCount === undefined ? '' : String(channel.memberCount);
    lines.push(
      `${cell(name, 30).padEnd(30)} ${kind.padEnd(9)} ${members.padStart(7)}  ${cell(channel.topic?.text ?? '', 40)}`,
    );
  }
  if (!result.complete) lines.push('', paint(color, 'dim', 'More remain. Ask for a larger --limit to see further.'));
  return lines.join('\n');
}

function renderRow(row: ReadRow, color: boolean): string {
  const who =
    row.author?.displayName?.text ?? row.author?.realName?.text ?? row.message.userId ?? row.message.botId ?? 'unknown';
  const head = `${paint(color, 'bold', cell(who, 24))}  ${paint(color, 'dim', row.message.ts)}`;
  const marks: string[] = [];
  if (row.message.mismatch) marks.push(paint(color, 'yellow', 'text and blocks disagree'));
  if (row.message.unrenderable) marks.push(paint(color, 'yellow', 'part of this message could not be shown'));
  if (row.message.attribution.app) {
    const app = row.message.attribution.appName?.text ?? row.message.attribution.botId ?? 'an app';
    const chosen = row.message.attribution.chosenName?.text;
    marks.push(paint(color, 'yellow', chosen ? `posted by ${app}, under the name “${chosen}”` : `posted by ${app}`));
  }
  if (row.message.attribution.external) marks.push(paint(color, 'yellow', 'from outside this workspace'));
  if (row.message.tokensNeutralised > 0) {
    marks.push(paint(color, 'yellow', `${row.message.tokensNeutralised} token(s) defused`));
  }
  if (row.message.truncated) marks.push(paint(color, 'dim', 'truncated'));
  if (row.message.editedTs) marks.push(paint(color, 'dim', 'edited'));
  const body = row.message.enveloped
    .split('\n')
    .map((line: string) => `  ${cell(line, 110)}`)
    .join('\n');
  const parts = [`${head}${marks.length > 0 ? `  ${marks.join(' · ')}` : ''}`, body];
  if (row.message.mismatch && row.message.fallback) {
    parts.push(paint(color, 'dim', `  notification said: ${cell(row.message.fallback, 100)}`));
  }
  for (const unfurl of row.message.unfurls) {
    parts.push(
      paint(
        color,
        'dim',
        `  ↳ unfurled from ${cell(unfurl.url, 60)}: ${cell(unfurl.title?.text ?? unfurl.text?.text ?? '', 60)}`,
      ),
    );
  }
  if (row.message.replyCount)
    parts.push(
      paint(color, 'dim', `  ${row.message.replyCount} repl${row.message.replyCount === 1 ? 'y' : 'ies'} in thread`),
    );
  return parts.join('\n');
}

export function renderHistory(result: HistoryResult, color: boolean): string {
  const name = result.channel?.name?.text ? `#${result.channel.name.text}` : (result.channel?.id ?? 'channel');
  const window = [
    `newest ${result.rows.length} of up to ${result.window.limit}`,
    result.window.oldest ? `since ${result.window.oldest}` : null,
    result.window.latest ? `until ${result.window.latest}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
  const lines = [paint(color, 'bold', `${name} · ${window}`), ''];
  if (result.rows.length === 0) lines.push(paint(color, 'dim', 'Nothing in the window read.'));
  lines.push(...result.rows.map((row) => renderRow(row, color)));
  if (!result.complete) {
    lines.push('', paint(color, 'dim', 'More remain beyond this window — this is not the whole channel.'));
  }
  return lines.join('\n\n');
}

export function renderThread(result: ThreadResult, color: boolean): string {
  const lines: string[] = [];
  if (result.parent) lines.push(renderRow(result.parent, color));
  lines.push(paint(color, 'dim', `— ${result.replies.length} repl${result.replies.length === 1 ? 'y' : 'ies'} —`));
  lines.push(...result.replies.map((row) => renderRow(row, color)));
  if (!result.complete) lines.push(paint(color, 'dim', 'More replies remain.'));
  return lines.join('\n\n');
}

export function renderSearch(result: SearchResult, color: boolean): string {
  const head = paint(
    color,
    'bold',
    `${result.hits.length} shown${result.total === undefined ? '' : ` of about ${result.total}`} · ${cell(result.query, 60)}`,
  );
  if (result.hits.length === 0) {
    return [head, paint(color, 'dim', 'Nothing matched the query as Slack read it.')].join('\n');
  }
  const lines = [head, ''];
  for (const hit of result.hits) {
    lines.push(`${paint(color, 'dim', `#${hit.channelName ?? hit.channelId ?? '?'}`)}\n${renderRow(hit, color)}`);
  }
  if (!result.complete) lines.push('', paint(color, 'dim', 'More pages remain.'));
  return lines.join('\n\n');
}

export function renderPeople(result: PeopleResult, color: boolean): string {
  const lines = [paint(color, 'bold', `${'NAME'.padEnd(28)} ${'REAL NAME'.padEnd(28)} KIND`)];
  for (const person of result.people) {
    const kind = person.deleted ? 'deactivated' : person.isBot ? 'bot' : person.isAdmin ? 'admin' : 'member';
    lines.push(
      `${cell(person.displayName?.text ?? person.id, 28).padEnd(28)} ${cell(person.realName?.text ?? '', 28).padEnd(28)} ${kind}`,
    );
  }
  if (!result.complete) lines.push('', paint(color, 'dim', 'More remain.'));
  return lines.join('\n');
}

export function renderFiles(result: FilesResult, color: boolean): string {
  if (result.files.length === 0) return paint(color, 'dim', 'No files this account can see.');
  const lines = [paint(color, 'bold', `${'NAME'.padEnd(36)} ${'TYPE'.padEnd(24)} SIZE      ID`)];
  for (const file of result.files) {
    const size = file.size === undefined ? '' : `${Math.ceil(file.size / 1024)} KB`;
    const shared = file.publicUrlShared ? paint(color, 'yellow', ' · public link') : '';
    lines.push(
      `${cell(file.name ?? file.title ?? file.id, 36).padEnd(36)} ${cell(file.mimetype ?? '', 24).padEnd(24)} ${size.padStart(8)}  ${file.id}${shared}`,
    );
  }
  if (!result.complete) lines.push('', paint(color, 'dim', `More remain — ask for page ${result.page}.`));
  return lines.join('\n');
}

// Shared with the Gmail package, from core: one renderer for one result shape.
export { renderInstall } from '@agentcomms/core';
