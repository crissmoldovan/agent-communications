import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import {
  type CliHandoffs,
  type CommsError,
  type Config,
  expandHome,
  externalCommand,
  findById,
  findUngatedGmailServers,
  formerNameRefusal,
  handoffSentence,
  handoffTextToFill,
  hasNames,
  homeDirectory,
  type InboxConfig,
  isGroupOrWorldAccessible,
  isProductServer,
  listRegisteredServers,
  lookupName,
  missingEntryFile,
  probeKeychain,
  type RegisteredServer,
  type Remedy,
  registrationVersion,
  remedy,
  secretsStoreOf,
  UNSENT_ROWS,
  UNSENT_WORDS,
  type UnsentReport,
  unsentReport,
} from '@agentcomms/core';
import { capabilitiesOf, scopesFor, TIERS, type Tier } from '../auth/scopes.ts';
import { TokenSource } from '../auth/session.ts';
import type { GmailContext } from '../context.ts';
import { GMAIL_MCP } from '../mcp/install.ts';
import { VERSION } from '../version.ts';
import { orphanedSecretsPath } from './inboxes.ts';

/*
 * Which version a registered entry runs is read with core's `registrationVersion`, the same code that knows how the
 * installer lays a runtime out, and which release a stable launcher's pointer names. This file used to carry its own pattern for `runtime/<version>/…`; when the
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
function repairCommand(server: RegisteredServer, handoffs: CliHandoffs): Remedy {
  // Every command this package issues targets user scope. Pointing one at a project-scoped entry would remove
  // nothing, add a second entry at user scope, and report success — with the stale one still in force for that
  // project. There is no flag that reaches it, so the honest answer is the manual one.
  if (server.scope === 'project') {
    return remedy(`remove "${server.name}" from the project entry in ${server.path} by hand, then re-run mcp install`);
  }
  // An entry of its own, repaired as one: `mcp install` alone puts Gmail into the app's connection (D17).
  const words = ['mcp', 'install', '--client', server.client, '--standalone'];
  if (server.name && server.name !== 'gmail') words.push('--name', server.name);
  const inbox = server.args[server.args.indexOf('--inbox') + 1];
  if (server.args.includes('--inbox') && inbox) words.push('--inbox', inbox);
  if (server.args.includes('--read-only')) words.push('--read-only');
  if (server.args.some((argument) => argument.startsWith(`${GMAIL_MCP.npxPackage}@`))) {
    words.push('--launcher', 'npx');
  }
  words.push('--force');
  // This installation's own `mcp install`, located — the one that writes this release — or why there is none here.
  return remedy(handoffs.own(words));
}

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skipped';

export interface Check {
  /** Stable id, so an agent can branch on the check rather than on its wording. */
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  /**
   * What fixes it, a step a line: this installation's own commands, core's through Gmail's dependency on it, another
   * program's — each located, or why there is none here — and the words around them (`remedy`).
   */
  fix?: Remedy | undefined;
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
 * A single place that answers "why doesn't it work?". Every check states what it found and what to do about it;
 * nothing here changes anything.
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
  /*
   * One mailbox asked about — `--inbox`, or a server pinned to one — scopes every check that would otherwise describe
   * the others: the OAuth client is the one it signs in through, the tokens left behind are its own, and an MCP
   * registration pinned to another mailbox is that mailbox's business. Pinned, this listed every client on the
   * machine by name, and repair commands for registrations pinned elsewhere, which name those mailboxes.
   */
  const scope: Scope | undefined =
    options.inbox === undefined
      ? undefined
      : { name: options.inbox, inbox: lookupName(config, 'inbox', options.inbox) };
  checks.push(clientCheck(config, scope, context.handoffs));

  const aliases = options.inbox ? [options.inbox] : Object.keys(config.inboxes);
  if (aliases.length === 0) {
    checks.push({
      id: 'inboxes',
      title: 'Mailboxes',
      status: 'warn',
      detail: 'none connected yet',
      fix: remedy(context.handoffs.own(['setup'])),
    });
  }
  for (const alias of aliases) {
    checks.push(...(await inboxChecks(context, alias)));
  }

  checks.push(await orphanedSecretsCheck(context, scope));
  // Scoped like everything else here: `--inbox`, and a pinned server, report their own mailbox's folders only.
  const folders = scope && !scope.inbox ? null : await formerFoldersCheck(context, config, scope?.inbox?.id);
  if (folders) checks.push(folders);
  // A name that is no mailbox's has no drafts to count; `inbox-known` already says so.
  if (!scope || scope.inbox) checks.push(await unsentCheck(context, scope));
  checks.push(...(await mcpChecks(context, scope)));

  const summary = {
    ok: checks.filter((check) => check.status === 'ok').length,
    warn: checks.filter((check) => check.status === 'warn').length,
    fail: checks.filter((check) => check.status === 'fail').length,
    skipped: checks.filter((check) => check.status === 'skipped').length,
  };
  return { checks, summary, healthy: summary.fail === 0 };
}

/** The one mailbox a doctor was asked about, by the name it was given and the mailbox that name holds now. */
interface Scope {
  name: string;
  /** Undefined when the name is no mailbox's; `inbox-known` says so, and nothing else is reported for it. */
  inbox: InboxConfig | undefined;
}

/**
 * Whether an OAuth client is registered — every client, or only the one a scoped mailbox signs in through.
 *
 * `setup`, not `client add <a file you do not have>`, when there is none at all. This check is the first thing a new
 * install reports, and it used to answer with a command naming a downloaded JSON that only exists after five screens
 * of Google Cloud nobody had mentioned — repair advice handed to somebody who had not built the thing yet.
 */
function clientCheck(config: Config, scope: Scope | undefined, handoffs: CliHandoffs): Check {
  const clients = Object.keys(config.clients);
  const base = { id: 'oauth-client', title: 'OAuth client' };
  if (scope?.inbox) {
    const name = scope.inbox.client;
    const registered = Object.hasOwn(config.clients, name);
    return {
      ...base,
      status: registered ? 'ok' : 'fail',
      detail: `"${name}", which ${scope.name} signs in through${registered ? '' : ', is not registered'}`,
      fix: registered ? undefined : addClient(handoffs),
    };
  }
  return {
    ...base,
    status: clients.length > 0 ? 'ok' : 'fail',
    detail:
      clients.length === 0
        ? 'none registered'
        : // Scoped to a name that is no mailbox's: how many, but not whose.
          scope
          ? `${clients.length} registered`
          : `${clients.length} registered: ${clients.join(', ')}`,
    fix: clients.length > 0 ? undefined : remedy(handoffs.own(['setup'])),
  };
}

/** "Add the client": this installation's own `client add`, the file for the person to fill in. */
function addClient(handoffs: CliHandoffs): Remedy {
  return remedy(handoffTextToFill(handoffs.own(['client', 'add']), ['<client_secret.json>']));
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
    fix: enough ? undefined : remedy(`Install Node ${MINIMUM_NODE.join('.')} or newer.`),
  };
}

/**
 * How to make a directory its owner's alone: `chmod 700`, the system's own command, so an external one. A directory
 * inside one of this suite's packages — a development checkout's — is refused there, as a path that could start a
 * product is, and is said in words instead.
 */
function ownerOnly(path: string, platform: NodeJS.Platform | undefined): Remedy {
  try {
    return remedy(
      externalCommand(
        ['chmod', '700', path],
        'chmod is the system command that makes a directory private to its owner',
        platform,
      ),
    );
  } catch {
    return remedy(`make ${path} readable and writable by its owner alone (mode 700)`);
  }
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
      fix: loose ? ownerOnly(path, context.platform) : undefined,
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
  const probe = await probeKeychain(null, 'probe', context.handoffs);
  return {
    id: 'secret-store',
    title: 'Secret store',
    status: probe.ok ? 'ok' : 'fail',
    detail: probe.ok ? 'the system keychain answers' : `the system keychain cannot be used: ${probe.reason}`,
    // Core's own command, located through Gmail's dependency on core — or why there is none here.
    fix: probe.ok ? undefined : remedy(context.handoffs.core(['secrets', 'migrate', '--to', 'file'])),
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
        fix: remedy(
          context.handoffs.own(current ? ['doctor', '--inbox', current] : ['inbox', 'add', alias, '--start']),
        ),
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
    fix: missing.length === 0 ? undefined : remedy(context.handoffs.own(['inbox', 'reauth', alias])),
    inbox: alias,
  });

  const client = config.clients[inbox.client];
  if (!client) {
    checks.push({
      id: 'inbox-client',
      title: `OAuth client for ${alias}`,
      status: 'fail',
      detail: `"${inbox.client}" is not registered`,
      fix: addClient(context.handoffs),
      inbox: alias,
    });
    return checks;
  }

  let tokenOk = false;
  try {
    const source = new TokenSource({
      core: context.core,
      endpoints: context.endpoints,
      inbox,
      client,
      alias,
      handoffs: context.handoffs,
    });
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
      fix: remedy(failure.hint ?? context.handoffs.own(['inbox', 'reauth', alias])),
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
        fix: matches ? undefined : remedy(context.handoffs.own(['inbox', 'reauth', alias])),
        inbox: alias,
      });
    } catch (error) {
      const failure = error as CommsError;
      checks.push({
        id: 'inbox-profile',
        title: `Mailbox ${alias}`,
        status: 'fail',
        detail: failure.message,
        fix: failure.hint === undefined ? undefined : remedy(failure.hint),
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
        fix: remedy(context.handoffs.own(['whoami', '--inbox', alias])),
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
async function orphanedSecretsCheck(context: GmailContext, scope: Scope | undefined): Promise<Check> {
  let lines: string[] = [];
  try {
    lines = (await readFile(orphanedSecretsPath(context), 'utf8')).split('\n').filter((line) => line.trim());
  } catch {
    // Nothing recorded: nothing was ever left behind.
  }
  const entries = lines.map((line): { secretRef?: unknown; inboxId?: unknown } => {
    try {
      const parsed: unknown = JSON.parse(line);
      return parsed !== null && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  });
  // Scoped to one mailbox: only what was recorded against it. A line that cannot be read belongs to no mailbox
  // that can be named, so it is left to the unscoped doctor.
  const mine = scope
    ? entries.filter((entry) => scope.inbox !== undefined && entry.inboxId === scope.inbox.id)
    : entries;
  const refs = mine.map((entry) => entry.secretRef);
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
      fix: remedy(
        handoffSentence(
          context.handoffs.own(['doctor']),
          (command) => `Run ${command} again once the configuration can be read. Delete nothing until then.`,
        ),
      ),
    };
  }
  return {
    id: 'orphaned-secrets',
    title: 'Tokens left behind',
    status: 'warn',
    detail: `${unreferenced.length} stored token(s) could not be deleted when an inbox was removed, and nothing uses them`,
    fix: remedy(
      `Remove ${unreferenced.join(', ')} from the secret store by hand, then delete ${orphanedSecretsPath(context)}`,
    ),
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
  if (!hasNames(config)) return null;
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
    fix: remedy('Nothing was moved. Move them into the new folders yourself if you want them together.'),
  };
}

/**
 * Drafts prepared in the last seven days whose last preparation expired with nothing sent (design 2026-10-05 §D9): the
 * unsent report's count, said as what it is. Exact only when every retained record was read and every qualifying draft
 * counted; a count over the newest 500 records, over the first 20 drafts, or beside a draft that could not be settled
 * is a lower bound; and one from a scan with a record that could not be read, one that was busy, or one cut short by
 * its deadline is no count at all. Each points to the list, which says what each draft's records say. Reads only.
 */
async function unsentCheck(context: GmailContext, scope: Scope | undefined): Promise<Check> {
  const base = { id: 'unsent-drafts', title: 'Prepared sends that expired (last 7 days)', inbox: scope?.name };
  const list = remedy([
    'See each, what its records say and the call that prepares it again, with ',
    context.handoffs.own(['send', 'list', ...(scope ? ['--inbox', scope.name] : [])]),
    ' (gmail_send_list from a chat).',
  ]);
  let report: UnsentReport;
  try {
    report = await unsentReport(context.core, {
      channel: 'gmail',
      ...(scope?.inbox ? { owner: scope.inbox.id } : {}),
    });
  } catch (error) {
    return { ...base, status: 'warn', detail: `could not be counted: ${(error as Error).message}` };
  }
  const unsent = report.rows.filter((row) => row.status === 'unsent').length;
  const drafts = (count: number) => `${count} draft${count === 1 ? '' : 's'}`;
  // A gap anywhere in what was read: the count would be a guess.
  if (report.evidence === 'indeterminate' || report.scanned.busy.length > 0) {
    const why = report.truncated.includes('deadline')
      ? UNSENT_WORDS.deadline
      : report.scanned.unreadable.length > 0
        ? UNSENT_WORDS.unreadable
        : UNSENT_WORDS.busy;
    return { ...base, status: 'warn', detail: `the count is ${why}`, fix: list };
  }
  const bounds = [
    ...(report.evidence === 'last-500' ? ['only the 500 most recently changed approval records were read'] : []),
    ...(report.truncated.includes('rows') ? [`only the newest ${UNSENT_ROWS} drafts were counted`] : []),
    ...(report.rows.some((row) => row.status === 'indeterminate') ? ['a draft could not be settled either way'] : []),
  ];
  if (bounds.length > 0) {
    return {
      ...base,
      status: unsent > 0 ? 'warn' : 'ok',
      detail: `${unsent > 0 ? `at least ${drafts(unsent)} not sent` : 'none found unsent'} — a lower bound: ${bounds.join('; ')}`,
      fix: list,
    };
  }
  return unsent === 0
    ? { ...base, status: 'ok', detail: 'none: no draft prepared in the last 7 days expired unsent' }
    : {
        ...base,
        status: 'warn',
        detail: `${drafts(unsent)} prepared in the last 7 days ${unsent === 1 ? 'was' : 'were'} ${UNSENT_WORDS.complete}`,
        fix: list,
      };
}

function referencedSecrets(config: Config): Set<string> {
  return new Set([
    ...Object.values(config.inboxes).map((inbox) => inbox.secretRef),
    ...Object.values(config.accounts).map((account) => account.secretRef),
    ...Object.values(config.clients).map((client) => client.secretRef),
  ]);
}

async function mcpChecks(context: GmailContext, scope: Scope | undefined): Promise<Check[]> {
  const servers = await listRegisteredServers(context.env);
  const checks: Check[] = [];
  // Every other product's Gmail server, whatever the scope: an ungated send path undoes this mailbox's safety too.
  const ungated = findUngatedGmailServers(servers, context.platform);
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
    fix: ungated.length === 0 ? undefined : remedy(...ungated.map((finding) => finding.removal)),
  });

  /*
   * A registered entry names an exact version — `runtime/<version>-gmail/…`, pinned so that upgrading the package
   * elsewhere on the machine cannot change what an agent runs underneath you. That is the right trade, but it has
   * a silent half: publishing a new version does nothing for an already-registered client, and nothing anywhere
   * said so. A release once sat unused on a machine through two versions because the only symptom was a fixed bug
   * that was still happening.
   */
  /*
   * Our own registrations, scoped: one serving every mailbox serves this one too, and one pinned to it is its own; one
   * pinned to another mailbox is not, and its name and repair command name that mailbox.
   */
  const ours = servers.filter((server) => {
    if (!scope) return true;
    const at = server.args.indexOf('--inbox');
    return at === -1 || server.args[at + 1] === undefined || server.args[at + 1] === scope.name;
  });

  const registered = ours.filter((entry) => isProductServer(entry, GMAIL_MCP));
  const stale = ours
    .map((server) => {
      // What it pins, or — for the stable launcher — the release its pointer names (design 2026-10-16, U6).
      const pin = registrationVersion(server, GMAIL_MCP);
      return pin ? { server, version: pin } : null;
    })
    .filter((entry): entry is { server: RegisteredServer; version: string } => entry !== null)
    .filter((entry) => entry.version !== VERSION);

  /*
   * Nothing registered is not "this release". With no entry at all nothing was stale, so the check said ok — "this
   * release, 0.7.1" — on a machine where no client could reach the server, and people read that as "ours is
   * registered". So it says what it found, as something to look at rather than a fault: the server can be started by
   * a plugin or an extension this scan of config files cannot see, and a machine used only from the command line
   * needs no registration at all.
   */
  checks.push(
    registered.length === 0 && stale.length === 0
      ? {
          id: 'registered-server-version',
          title: 'Registered server version',
          status: 'warn',
          detail: `${
            scope
              ? `none registered that serves ${scope.name}: no MCP client's config file starts one that reaches it`
              : "none registered: no MCP client's config file starts this server"
          } (one a plugin or an extension starts is not visible from here)`,
          fix: remedy(context.handoffs.own(['mcp', 'install', '--help'], { uses: [] })),
        }
      : {
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
          fix:
            stale.length === 0
              ? undefined
              : remedy(...stale.map((entry) => repairCommand(entry.server, context.handoffs))),
        },
  );

  /*
   * Whether each of our entries still starts. Matched with the installer's own idea of "ours": this looked for
   * `agent-gmail` in the command line, which neither a managed nor an npx entry contains, so the check skipped
   * every real registration and could only ever pass.
   */
  for (const server of registered) {
    const missing = await missingEntryFile(server);
    checks.push({
      id: 'mcp-command',
      title: `MCP entry "${server.name}" (${server.client})`,
      status: missing ? 'fail' : 'ok',
      detail: missing ? `${missing} is not there any more` : server.command,
      fix: missing ? repairCommand(server, context.handoffs) : undefined,
    });
  }
  return checks;
}
