import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CommsError,
  type Config,
  expandHome,
  findById,
  findUngatedGmailServers,
  formerNameRefusal,
  homeDirectory,
  isGroupOrWorldAccessible,
  isProductServer,
  listRegisteredServers,
  lookupName,
  missingEntryFile,
  pinnedVersion,
  probeKeychain,
  type RegisteredServer,
  secretsStoreOf,
} from '@agentcomms/core';
import { capabilitiesOf, scopesFor, TIERS, type Tier } from '../auth/scopes.ts';
import { TokenSource } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { GMAIL_MCP } from '../mcp/install.ts';
import { VERSION } from '../version.ts';
import { orphanedSecretsPath } from './inboxes.ts';

/*
 * Which version a registered entry runs is read with core's `pinnedVersion`, the same code that knows how the
 * installer lays a runtime out. This file used to carry its own pattern for `runtime/<version>/…`; when the
 * installer moved to `runtime/<version>-gmail/…` the pattern captured `0.4.0-gmail`, never equal to `0.4.0`, and
 * every install made since was "stale" — with a repair that re-created the same path.
 */

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
  if (server.args.some((argument) => argument.startsWith(`${GMAIL_MCP.npxPackage}@`))) flags.push('--launcher npx');
  return `agent-gmail mcp install ${flags.join(' ')} --force`;
}

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
  // Scoped like everything else here: `--inbox`, and a pinned server, report their own mailbox's folders only.
  const scope = options.inbox ? (lookupName(config, 'inbox', options.inbox)?.id ?? null) : undefined;
  const folders = scope === null ? null : await formerFoldersCheck(context, config, scope);
  if (folders) checks.push(folders);
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
  const inbox = lookupName(config, 'inbox', alias);
  if (!inbox) {
    // A former name gets what it is called now, not "no such mailbox" and an invitation to connect it again.
    const renamed = formerNameRefusal(config, 'inbox', alias);
    const current = (renamed?.details as { currentName?: string } | undefined)?.currentName;
    return [
      {
        id: 'inbox-known',
        title: `Mailbox ${alias}`,
        status: 'fail',
        detail: renamed ? renamed.message : 'no such mailbox',
        fix: current ? `agent-gmail doctor --inbox ${current}` : `agent-gmail inbox add ${alias} --start`,
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

/**
 * Tokens whose removal failed when an inbox was disconnected: still stored, no longer referenced.
 *
 * Every recorded line is checked against the config as it is now before any deletion is advised. A line can be
 * recorded for a token whose mailbox is still connected — a removal that could not tell whether its write went through
 * keeps the token and records it as unconfirmed — and advising the person to delete that would delete a live
 * credential. A reference something configured still holds is reported as in use, and left out of the advice.
 */
async function orphanedSecretsCheck(context: GmailContext): Promise<Check> {
  let lines: string[] = [];
  try {
    lines = (await readFile(orphanedSecretsPath(context), 'utf8')).split('\n').filter((line) => line.trim());
  } catch {
    // Nothing recorded: nothing was ever left behind.
  }
  const refs = lines.map((line) => {
    try {
      return (JSON.parse(line) as { secretRef?: unknown }).secretRef;
    } catch {
      return undefined;
    }
  });
  let held: Set<string> | null = null;
  try {
    held = referencedSecrets(await context.config());
  } catch {
    // Unreadable config: nothing can be confirmed unreferenced, so nothing is advised for deletion below.
  }
  // Counted as tokens, not as lines: a removal that failed twice records the same token twice, and "2 recorded
  // tokens belong to a connected mailbox" about one token sends somebody looking for a second that is not there.
  const recorded = [...new Set(refs.filter((ref): ref is string => typeof ref === 'string'))];
  const unparseable = refs.filter((ref) => typeof ref !== 'string').length;
  const unreferenced = held === null ? [] : recorded.filter((ref) => !held.has(ref));
  const inUse = held === null ? 0 : recorded.filter((ref) => held.has(ref)).length;
  const unchecked = held === null ? recorded.length + unparseable : unparseable;

  if (unreferenced.length === 0 && unchecked === 0) {
    return {
      id: 'orphaned-secrets',
      title: 'Tokens left behind',
      status: 'ok',
      detail:
        inUse === 0 ? 'none' : `none — ${inUse} recorded token(s) belong to a connected mailbox, so nothing to do`,
    };
  }
  if (unreferenced.length === 0) {
    return {
      id: 'orphaned-secrets',
      title: 'Tokens left behind',
      status: 'warn',
      detail: `${unchecked} recorded token(s) could not be checked against the configuration`,
      fix: 'Run `agent-gmail doctor` again once the configuration can be read. Delete nothing until then.',
    };
  }
  return {
    id: 'orphaned-secrets',
    title: 'Tokens left behind',
    status: 'warn',
    detail: `${unreferenced.length} stored token(s) could not be deleted when an inbox was removed, and nothing uses them`,
    fix: `Remove ${unreferenced.join(', ')} from the secret store by hand, then delete ${orphanedSecretsPath(context)}`,
  };
}

/**
 * Downloads still sitting under a mailbox's former name, said once and never moved.
 *
 * A download lands in a folder named for the mailbox, so a rename leaves the old ones where they were. Usually that is
 * the organisation's own folder — `cue` became `cue/gmail`, so new files go to `downloads/cue/gmail/` inside the old
 * `downloads/cue/` — and what is worth saying is that the old files sit beside the new folder, not that the folder
 * exists. Nothing here moves a file: they are a person's downloads, and where they belong is theirs to decide.
 */
async function formerFoldersCheck(context: GmailContext, config: Config, onlyId?: string): Promise<Check | null> {
  if (config.version !== 2) return null;
  const configured = config.defaults.downloadsDir;
  const root = configured ? expandHome(configured, homeDirectory(context.env)) : context.core.paths.downloadsDir;
  const found: string[] = [];
  for (const [former, record] of Object.entries(config.formerNames.inboxes)) {
    if (onlyId !== undefined && record.id !== onlyId) continue;
    let children: string[];
    try {
      children = await readdir(join(root, former));
    } catch {
      continue;
    }
    // The folders the current names put inside this one are the new layout, not leftovers.
    const current = Object.keys(config.inboxes)
      .filter((name) => name.startsWith(`${former}/`))
      .map((name) => name.slice(former.length + 1).split('/')[0]);
    const leftovers = children.filter((child) => !current.includes(child));
    if (leftovers.length === 0) continue;
    const now = findById(config, 'inbox', record.id)?.alias ?? record.name;
    found.push(`${join(root, former)} (${leftovers.length} item(s) from before "${former}" became "${now}")`);
  }
  if (found.length === 0) return null;
  return {
    id: 'former-download-folders',
    title: 'Downloads under former names',
    status: 'warn',
    detail: found.join('; '),
    fix: 'Nothing was moved. Move them into the new folders yourself if you want them together.',
  };
}

function referencedSecrets(config: Config): Set<string> {
  return new Set([
    ...Object.values(config.inboxes).map((inbox) => inbox.secretRef),
    ...Object.values(config.accounts).map((account) => account.secretRef),
    ...Object.values(config.clients).map((client) => client.secretRef),
  ]);
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
   * A registered entry names an exact version — `runtime/<version>-gmail/…`, pinned so that upgrading the package
   * elsewhere on the machine cannot change what an agent runs underneath you. That is the right trade, but it has
   * a silent half: publishing a new version does nothing for an already-registered client, and nothing anywhere
   * said so. A release once sat unused on a machine through two versions because the only symptom was a fixed bug
   * that was still happening.
   */
  const stale = servers
    .map((server) => {
      const pin = server.args.map((arg) => pinnedVersion(arg, GMAIL_MCP)).find((version) => version !== null);
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

  /*
   * Whether each of our entries still starts. Matched with the installer's own idea of "ours": this looked for
   * `agent-gmail` in the command line, which neither a managed nor an npx entry contains, so the check skipped
   * every real registration and could only ever pass.
   */
  for (const server of servers.filter((entry) => isProductServer(entry, GMAIL_MCP))) {
    const missing = await missingEntryFile(server);
    checks.push({
      id: 'mcp-command',
      title: `MCP entry "${server.name}" (${server.client})`,
      status: missing ? 'fail' : 'ok',
      detail: missing ? `${missing} is not there any more` : server.command,
      fix: missing ? repairCommand(server) : undefined,
    });
  }
  return checks;
}
