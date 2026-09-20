import { access, constants, readFile, stat } from 'node:fs/promises';
import { type CommsError, isGroupOrWorldAccessible, probeKeychain, secretsStoreOf } from '@agentcomms/core';
import { capabilitiesOf, scopesFor, TIERS, type Tier } from '../auth/scopes.ts';
import { TokenSource } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { VERSION } from '../version.ts';
import { findUngatedGmailServers, listRegisteredServers, type RegisteredServer } from './client-configs.ts';

/**
 * The version an argument pins, or null when it pins none.
 *
 * Two launchers pin, and they look nothing alike. `managed` writes a path —
 * `…/runtime/<version>/node_modules/@agentcomms/gmail/dist/cli.mjs`, matched with either separator and allowed to
 * start the string, so a relative path is not missed. `npx` writes a package spec, `@agentcomms/gmail-mcp@<version>`.
 * Reading only the first reported an `npx`-pinned install as current forever, which is the failure this check
 * exists to prevent wearing the other launcher's clothes. `local` pins nothing and is correctly ignored.
 */
const PINNED_RUNTIME = /(?:^|[/\\])runtime[/\\]([^/\\]+)[/\\]node_modules[/\\]@agentcomms[/\\]gmail[/\\]/;
const PINNED_SPEC = /^@agentcomms\/gmail(?:-mcp)?@(\d[^\s]*)$/;

function pinnedVersion(argument: string): string | null {
  return PINNED_RUNTIME.exec(argument)?.[1] ?? PINNED_SPEC.exec(argument)?.[1] ?? null;
}

/**
 * The command that re-registers *this* entry, not a default one.
 *
 * A generic `mcp install --client <c> --force` would rewrite a server registered as `work`, or scoped to one
 * mailbox, or installed `--read-only`, into the default: every mailbox, every tool, under another name. That
 * turns a staleness warning into a widening of what an agent may reach — the opposite of a repair. So the flags
 * are read back off the entry that is actually there.
 */
function repairCommand(server: RegisteredServer): string {
  // Every command this package issues targets user scope. Pointing one at a project-scoped entry would remove
  // nothing, add a second entry at user scope, and report success — with the stale one still in force for that
  // project. There is no flag that reaches it, so the honest answer is the manual one.
  if (server.scope === 'project') {
    return `remove "${server.name}" from the project entry in ${server.path} by hand, then re-run mcp install`;
  }
  const flags = [`--client ${server.client}`];
  if (server.name && server.name !== 'gmail') flags.push(`--name ${server.name}`);
  const inbox = server.args[server.args.indexOf('--inbox') + 1];
  if (server.args.includes('--inbox') && inbox) flags.push(`--inbox ${inbox}`);
  if (server.args.includes('--read-only')) flags.push('--read-only');
  if (server.args.some((argument) => PINNED_SPEC.test(argument))) flags.push('--launcher npx');
  return `agent-gmail mcp install ${flags.join(' ')} --force`;
}

import { orphanedSecretsPath } from './inboxes.ts';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface Check {
  /** Stable id, so an agent can branch on the check rather than on its wording. */
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /** One command or action that fixes it. */
  fix?: string | undefined;
  inbox?: string | undefined;
}

export interface DoctorResult {
  checks: Check[];
  summary: { ok: number; warn: number; fail: number; skipped: number };
  /** True when nothing is wrong that would stop the package working. */
  healthy: boolean;
}

const MINIMUM_NODE = [22, 12, 0];
const UNUSED_WARNING_DAYS = 150; // Google drops a refresh token unused for six months.

/**
 * A single place that answers "why doesn't it work?". Every check states what it found and the one thing to do about
 * it; nothing here changes anything.
 */
export async function doctor(
  context: GmailContext,
  options: { inbox?: string | undefined } = {},
): Promise<DoctorResult> {
  const checks: Check[] = [];
  checks.push(nodeCheck());
  checks.push(...(await directoryChecks(context)));
  checks.push(await secretStoreCheck(context));

  const config = await context.config();
  const clients = Object.entries(config.clients);
  checks.push({
    id: 'oauth-client',
    title: 'OAuth client',
    status: clients.length > 0 ? 'ok' : 'fail',
    detail:
      clients.length > 0
        ? `${clients.length} registered: ${clients.map(([name]) => name).join(', ')}`
        : 'none registered',
    // `setup`, not `client add <a file you do not have>`. This check is the first thing a new install reports,
    // and it used to answer with a command naming a downloaded JSON that only exists after five screens of Google
    // Cloud nobody had mentioned — repair advice handed to somebody who had not built the thing yet.
    fix: clients.length > 0 ? undefined : 'agent-gmail setup',
  });

  const aliases = options.inbox ? [options.inbox] : Object.keys(config.inboxes);
  if (aliases.length === 0) {
    checks.push({
      id: 'inboxes',
      title: 'Mailboxes',
      status: 'warn',
      detail: 'none connected yet',
      fix: 'agent-gmail setup',
    });
  }
  for (const alias of aliases) {
    checks.push(...(await inboxChecks(context, alias)));
  }

  checks.push(await orphanedSecretsCheck(context));
  checks.push(...(await mcpChecks(context)));

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  };
  return { checks, summary, healthy: summary.fail === 0 };
}

/** Compares dotted version numbers left to right: the first difference decides. */
function atLeast(version: string, minimum: readonly number[]): boolean {
  const parts = version.split('.').map((part) => Number.parseInt(part, 10) || 0);
  for (const [index, floor] of minimum.entries()) {
    const part = parts[index] ?? 0;
    if (part > floor) return true;
    if (part < floor) return false;
  }
  return true;
}

function nodeCheck(): Check {
  const enough = atLeast(process.versions.node, MINIMUM_NODE);
  return {
    id: 'node-version',
    title: 'Node.js',
    status: enough ? 'ok' : 'fail',
    detail: `v${process.versions.node}`,
    fix: enough ? undefined : `Install Node ${MINIMUM_NODE.join('.')} or newer.`,
  };
}

async function directoryChecks(context: GmailContext): Promise<Check[]> {
  const checks: Check[] = [];
  for (const [id, path] of [
    ['config-dir', context.core.paths.configDir],
    ['state-dir', context.core.paths.stateDir],
    // The one that actually holds refresh tokens, and the one that was not checked. It sits inside the config
    // directory today, so its mode was right by inheritance rather than by anybody having looked.
    ['secrets-dir', context.core.paths.secretsDir],
  ] as const) {
    try {
      await stat(path);
    } catch {
      checks.push({ id, title: `Directory ${path}`, status: 'ok', detail: 'not created yet' });
      continue;
    }
    const loose = await isGroupOrWorldAccessible(path);
    checks.push({
      id,
      title: `Directory ${path}`,
      status: loose ? 'warn' : 'ok',
      detail: loose ? 'readable by other users on this machine' : 'owner-only',
      fix: loose ? `chmod 700 ${path}` : undefined,
    });
  }
  return checks;
}

async function secretStoreCheck(context: GmailContext): Promise<Check> {
  const config = await context.config();
  const kind = secretsStoreOf(config);
  if (kind === 'file') {
    return {
      id: 'secret-store',
      title: 'Secret store',
      status: 'ok',
      detail: 'owner-only files in the config directory',
    };
  }
  const probe = await probeKeychain();
  return {
    id: 'secret-store',
    title: 'Secret store',
    status: probe.ok ? 'ok' : 'fail',
    detail: probe.ok ? 'the system keychain answers' : `the system keychain cannot be used: ${probe.reason}`,
    fix: probe.ok ? undefined : 'agentcomms secrets migrate --to file',
  };
}

async function inboxChecks(context: GmailContext, alias: string): Promise<Check[]> {
  const checks: Check[] = [];
  const config = await context.config();
  const inbox = config.inboxes[alias];
  if (!inbox) {
    return [
      {
        id: 'inbox-known',
        title: `Mailbox ${alias}`,
        status: 'fail',
        detail: 'no such mailbox',
        fix: `agent-gmail inbox add ${alias} --start`,
        inbox: alias,
      },
    ];
  }

  // Scopes first: it needs no network, and explains most "it stopped working" reports.
  const granted = capabilitiesOf(inbox.grantedScopes);
  const wanted = scopesFor(
    (TIERS as readonly string[]).includes(inbox.tier) ? (inbox.tier as Tier) : 'organize',
    inbox.contacts,
  );
  const missing = wanted.filter((scope) => !inbox.grantedScopes.includes(scope));
  checks.push({
    id: 'inbox-scopes',
    title: `Permissions for ${alias}`,
    status: missing.length === 0 ? 'ok' : 'warn',
    detail: missing.length === 0 ? `${[...granted].join(', ')}` : `missing: ${missing.join(', ')}`,
    fix: missing.length === 0 ? undefined : `agent-gmail inbox reauth ${alias}`,
    inbox: alias,
  });

  const client = config.clients[inbox.client];
  if (!client) {
    checks.push({
      id: 'inbox-client',
      title: `OAuth client for ${alias}`,
      status: 'fail',
      detail: `"${inbox.client}" is not registered`,
      fix: 'agent-gmail client add <client_secret.json>',
      inbox: alias,
    });
    return checks;
  }

  let tokenOk = false;
  try {
    const source = new TokenSource({ core: context.core, endpoints: context.endpoints, inbox, client, alias });
    await source.accessToken();
    tokenOk = true;
    checks.push({
      id: 'inbox-token',
      title: `Sign-in for ${alias}`,
      status: 'ok',
      detail: 'Google renewed the access token',
      inbox: alias,
    });
  } catch (error) {
    const failure = error as CommsError;
    checks.push({
      id: 'inbox-token',
      title: `Sign-in for ${alias}`,
      status: 'fail',
      detail: failure.message,
      fix: failure.hint ?? `agent-gmail inbox reauth ${alias}`,
      inbox: alias,
    });
  }

  if (tokenOk) {
    try {
      const transport = await context.transport(alias);
      const profile = await transport.getProfile();
      const matches = profile.emailAddress.toLowerCase() === inbox.email.toLowerCase();
      checks.push({
        id: 'inbox-profile',
        title: `Mailbox ${alias}`,
        status: matches ? 'ok' : 'warn',
        detail: matches ? profile.emailAddress : `recorded as ${inbox.email}, but Google says ${profile.emailAddress}`,
        fix: matches ? undefined : `agent-gmail inbox reauth ${alias}`,
        inbox: alias,
      });
    } catch (error) {
      const failure = error as CommsError;
      checks.push({
        id: 'inbox-profile',
        title: `Mailbox ${alias}`,
        status: 'fail',
        detail: failure.message,
        fix: failure.hint,
        inbox: alias,
      });
    }
  }

  const state = await context.core.states.get(inbox.id);
  const lastUsed = state.lastUsedAt ?? state.lastRefreshOkAt;
  if (lastUsed) {
    const days = (context.now().getTime() - Date.parse(lastUsed)) / 86_400_000;
    if (days >= UNUSED_WARNING_DAYS) {
      checks.push({
        id: 'inbox-idle',
        title: `Last used: ${alias}`,
        status: 'warn',
        detail: `${Math.floor(days)} days ago; Google drops a token unused for six months`,
        fix: `agent-gmail whoami --inbox ${alias}`,
        inbox: alias,
      });
    }
  }
  return checks;
}

/** Tokens whose removal failed when an inbox was disconnected: still in the keychain, no longer referenced. */
async function orphanedSecretsCheck(context: GmailContext): Promise<Check> {
  let lines: string[] = [];
  try {
    lines = (await readFile(orphanedSecretsPath(context), 'utf8')).split('\n').filter((line) => line.trim());
  } catch {
    // Nothing recorded: nothing was ever left behind.
  }
  return {
    id: 'orphaned-secrets',
    title: 'Tokens left behind',
    status: lines.length === 0 ? 'ok' : 'warn',
    detail:
      lines.length === 0 ? 'none' : `${lines.length} stored token(s) could not be deleted when an inbox was removed`,
    fix:
      lines.length === 0
        ? undefined
        : `Remove them from the system keychain by hand, then delete ${orphanedSecretsPath(context)}`,
  };
}

async function mcpChecks(context: GmailContext): Promise<Check[]> {
  const servers = await listRegisteredServers(context.env);
  const checks: Check[] = [];
  const ungated = findUngatedGmailServers(servers);
  checks.push({
    id: 'other-gmail-servers',
    title: 'Other Gmail MCP servers',
    status: ungated.length === 0 ? 'ok' : 'fail',
    detail:
      ungated.length === 0
        ? 'none registered'
        : ungated
            .map((finding) => `${finding.name} in ${finding.path} (${finding.client}): ${finding.reason}`)
            .join('; '),
    fix: ungated.length === 0 ? undefined : ungated.map((finding) => finding.removal).join(' && '),
  });

  /*
   * A registered entry names an exact version — `runtime/<version>/…`, pinned so that upgrading the package
   * elsewhere on the machine cannot change what an agent runs underneath you. That is the right trade, but it has
   * a silent half: publishing a new version does nothing for an already-registered client, and nothing anywhere
   * said so. A release once sat unused on a machine through two versions because the only symptom was a fixed bug
   * that was still happening.
   */
  const stale = servers
    .map((server) => {
      const pin = server.args.map((arg) => pinnedVersion(arg)).find((version) => version !== null);
      return pin ? { server, version: pin } : null;
    })
    .filter((entry): entry is { server: RegisteredServer; version: string } => entry !== null)
    .filter((entry) => entry.version !== VERSION);

  checks.push({
    id: 'registered-server-version',
    title: 'Registered server version',
    status: stale.length === 0 ? 'ok' : 'warn',
    detail:
      stale.length === 0
        ? `this release, ${VERSION}`
        : stale
            .map(
              (entry) =>
                `${entry.server.client} runs ${entry.version} as "${entry.server.name}"; this release is ${VERSION}`,
            )
            .join('; '),
    fix: stale.length === 0 ? undefined : stale.map((entry) => repairCommand(entry.server)).join(' && '),
  });

  const ours = servers.filter((server) => [server.command, ...server.args].join(' ').includes('agent-gmail'));
  for (const server of ours) {
    if (!server.command || server.command === 'npx' || !server.command.includes('/')) continue;
    let runnable = true;
    try {
      await access(server.command, constants.X_OK);
    } catch {
      runnable = false;
    }
    checks.push({
      id: 'mcp-command',
      title: `MCP entry "${server.name}" (${server.client})`,
      status: runnable ? 'ok' : 'fail',
      detail: runnable ? server.command : `${server.command} is not there any more`,
      fix: runnable ? undefined : `agent-gmail mcp install --client ${server.client}`,
    });
  }
  return checks;
}
