import { access, constants, stat } from 'node:fs/promises';
import { type PublicApprovalView, publicApproval } from '../approval-outcome.ts';
import { integrityRefusal, kindOf, type StoredApproval } from '../approval-stored.ts';
import type { ApprovalState } from '../approvals.ts';
import type { AuditRecord } from '../audit.ts';
import { behaviourAccountsOf, readBehaviourSettings } from '../behaviour.ts';
import { revokeChange } from '../changes.ts';
import { type Channel, type ServerId, serverFacts } from '../channel-servers.ts';
import { listed, manifestOf } from '../channel-words.ts';
import { stripInvisible } from '../chars.ts';
import { inlineCommand } from '../cli-runtime.ts';
import { externalCommand } from '../command-brands.ts';
import { type Config, emptyConfig, hasNames, secretsStoreOf } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { isGroupOrWorldAccessible } from '../fs.ts';
import {
  type CliHandoffs,
  handoffSentence,
  handoffSentenceToFill,
  isCommand,
  type Remedy,
  remedy,
  requireHandoffs,
} from '../handoffs.ts';
import { launcherCanStartSync, launcherExists, launcherName, launcherPaths, readPointer } from '../launcher.ts';
import { inspectManagedShim, managedShimsSupported, managedShimUnsupportedNotice } from '../managed-shims.ts';
import { managedRuntimeEntry } from '../mcp-install.ts';
import { findById, resolveName } from '../names.ts';
import { nodeProgram } from '../node-program.ts';
import { compareVersions } from '../npm.ts';
import {
  ignoredListOf,
  ignoredOf,
  notAppliedDetail,
  organisationDrift,
  organisationsOf,
  orphanMarkedRows,
  shownPath,
  shownText,
} from '../organisations.ts';
import type { ResolvedPaths } from '../paths.ts';
import type { SearchDeps } from '../search/indexer.ts';
import { type KeyringModule, keychainNamespace, loadKeyringModule, probeKeychain } from '../secrets.ts';
import { endStanding } from '../standing-flow.ts';
import { readTakingSettings } from '../taking.ts';
import { newBoundary, wrapUntrusted } from '../untrusted.ts';
import { inspectUpdateJob, type UpdateJobDeps, updateJobContext, updateJobHealth } from '../update-job.ts';
import {
  countedLatest,
  effectiveUpdates,
  localStamp,
  pauseEnd,
  readUpdateCheck,
  securityRelease,
  updateVerdict,
} from '../update-state.ts';
import { VERSION } from '../version.ts';
import { activityDoctorCheck } from './activity.ts';
import { orphanedBehaviourRules } from './behaviour.ts';
import { searchDoctorCheck } from './search.ts';
import { connectionList } from './connections.ts';
import { type ChannelRegistration, CLIENTS, channelsAvailable } from './servers.ts';
import { type StandingReport, standingReport } from './standing.ts';

/**
 * The core's own read-only and housekeeping operations: where things live, whether this machine is healthy, what the
 * audit log says, and which approvals exist.
 *
 * Each is one function that `agentcomms` and the core MCP server both call, so a command and its tool cannot drift in
 * what they return or what they refuse. They lived inside the CLI until the server needed them, and the CLI is the one
 * module a library may never import: it starts `main()` when the running script is called `cli.mjs`, which is also
 * what every product's CLI is called.
 */

export function corePaths(core: Core): ResolvedPaths {
  return core.paths;
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  /**
   * Something to look at rather than a failure: a channel with accounts that no client starts, a client config that
   * cannot be read. `ok` stays true, and so does the report's — a doctor that failed on a machine used only from a
   * terminal would be failing on nothing. Present only on such a check, so every other reads as it always did.
   */
  warn?: true;
  detail: string;
  /** What fixes it, a step a line: commands — located, or why there is none here — and the words around them. */
  fix?: Remedy;
}

export interface DoctorReport {
  checks: DoctorCheck[];
  ok: boolean;
}

export interface DoctorOptions {
  /**
   * The keychain module to probe, for a test: the real one writes, reads and deletes an item in the login keychain,
   * and a test must never touch it. `null` is a machine without the module. Left out, the real module is loaded.
   */
  keyring?: KeyringModule | null | undefined;
  /** The shell the commands it prints are quoted for: this machine's, unless a test asks for another by name. */
  platform?: NodeJS.Platform | undefined;
  /** For a test: the runner the background update job's scheduler is asked through, so none is real. */
  updateJob?: UpdateJobDeps | undefined;
  /**
   * False when an organisation profile here says `updates.background: false` (design 2026-10-16 U8). Left out, read
   * from the configuration's organisations, as the notice reads them (`effectiveUpdates`); a test hands it in.
   */
  background?: boolean | undefined;
  /** For a test: the clock whether the background job has run lately is read on. */
  now?: (() => Date) | undefined;
  /** For a test: Search's stand-ins — its secret store, the loopback model server, `tmutil` and `fdesetup`. */
  search?: SearchDeps | undefined;
}

/**
 * How to make a directory its owner's alone: `chmod 700`, the system's own command, so an external one. A directory
 * inside one of this suite's packages — a development checkout's — is refused there, as a path that could start a
 * product is, and is said in words instead.
 */
function ownerOnly(dir: string, platform: NodeJS.Platform): Remedy {
  try {
    return remedy(
      externalCommand(
        ['chmod', '700', dir],
        'chmod is the system command that makes a directory private to its owner',
        platform,
      ),
    );
  } catch {
    return remedy(`make ${dir} readable and writable by its owner alone (mode 700)`);
  }
}

/**
 * Whether this machine is healthy. `env` is where the MCP clients' configs are found — the one `agentcomms` runs with,
 * or the core server's — as `agentcomms channels` finds them.
 */
export async function doctor(core: Core, env: NodeJS.ProcessEnv, options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
  const platform = options.platform ?? process.platform;
  // Every repair below is a command to run: this installation's own, or another product's where it is registered.
  const handoffs = await requireHandoffs(core, platform).registered();
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  // The Node as a command names it — a link on PATH stays the link — and, when that is a link, the file it is (CUE-492).
  const node = nodeProgram(env);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `Node ${process.versions.node} at ${node}${node === process.execPath ? '' : `, which resolves to ${process.execPath}`}`,
    ...(nodeOk ? {} : { fix: remedy('Install Node 22.12 or newer.') }),
  });

  for (const [name, dir] of [
    ['config dir', core.paths.configDir],
    ['state dir', core.paths.stateDir],
  ] as const) {
    try {
      await access(dir, constants.R_OK | constants.W_OK);
      const loose = await isGroupOrWorldAccessible(dir);
      checks.push({
        name,
        ok: !loose,
        detail: dir,
        ...(loose ? { fix: ownerOnly(dir, platform) } : {}),
      });
    } catch {
      checks.push({ name, ok: true, detail: `${dir} (not created yet — created on first use)` });
    }
  }

  let config: Config = emptyConfig();
  let readable = true;
  try {
    config = await core.config.load();
    const exists = await stat(core.config.path).then(
      () => true,
      () => false,
    );
    checks.push({ name: 'config', ok: true, detail: exists ? core.config.path : 'no config yet' });
  } catch (error) {
    readable = false;
    checks.push({
      name: 'config',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: remedy('Fix or restore config.json.'),
    });
  }

  /*
   * The one thing on this machine that nothing else announces.
   *
   * A version-1 config is not broken — every command reads and writes it unchanged — so this never fails. It is
   * here because the migration has no symptom until an old name is used somewhere that has already moved on, and
   * because the release requirement is the part people get wrong: one config is shared by everything on a machine,
   * and a program older than 0.2.0 refuses the migrated file outright.
   */
  const toMigrate = readable && !hasNames(config);
  checks.push({
    name: 'account names',
    ok: true,
    // `config` falls back to an empty one when the file could not be read, and an empty one is version 2 — which
    // would announce a migration that may not have happened. The check above already says the file is unreadable.
    detail: !readable
      ? 'unknown — the configuration could not be read'
      : toMigrate
        ? 'the old flat names, which still work'
        : 'organisation/platform',
    ...(toMigrate
      ? {
          fix: remedy(
            handoffSentence(
              handoffs.core(['names', 'migrate', '--dry-run']),
              (command) =>
                `See what they would become with ${command}, once everything sharing this config is on 0.2.0 or later.`,
            ),
          ),
        }
      : {}),
  });

  if (readable) checks.push(...organisationChecks(config, handoffs));
  if (readable) checks.push(...behaviourChecks(config, handoffs));
  if (readable) checks.push(...takingChecks(config, handoffs));

  /*
   * Approval records that cannot be used (design 2026-10-05 §D2): a file that cannot be read, or a record whose binding
   * does not verify, so whose it is cannot be trusted. Never used, never rewritten, and never shown but as a stub —
   * counted here, by kind of fault, and nothing of what they hold. Something to look at, not a failure.
   */
  if (readable) {
    const stubs = await core.approvals.list().then(
      (records) =>
        records.filter(
          (stored) =>
            stored.form === 'unreadable' || (stored.form === 'corrupt' && stored.attribution === 'unverifiable'),
        ),
      () => [],
    );
    if (stubs.length > 0) {
      const unreadable = stubs.filter((stored) => stored.form === 'unreadable').length;
      const unverified = stubs.length - unreadable;
      checks.push({
        name: 'approvals',
        ok: true,
        warn: true,
        detail: `${stubs.length} approval record${stubs.length === 1 ? '' : 's'} cannot be used: ${unreadable} could not be read, ${unverified} failed ${unverified === 1 ? 'its' : 'their'} integrity check. None is ever used, and nothing in them is shown`,
        fix: remedy(
          handoffSentence(
            handoffs.core(['approvals', 'list', '--state', 'corrupt']),
            (command) => `${command} names them by id. Prepare again whatever they were for.`,
          ),
        ),
      });
    }
  }

  /*
   * An open legacy drain (design 2026-10-05 §D1): approvals an earlier release prepared, still being retired. Not a
   * fault — the next send prepare, claim or approval retries each — but no send policy can be loosened until it
   * closes, and a record it could not revoke is one an earlier release still running could use.
   */
  if (readable && config.version === 3 && config.legacyDrain !== undefined) {
    const tracked = Object.entries(config.legacyDrain.tracked);
    const open = tracked.filter(([, status]) => status === 'open').map(([approvalId]) => approvalId);
    // What an earlier release's send it had already admitted reached — under way, unknown, or finished — as the drain
    // reports it: never revoked, and named so that window is never silent.
    const inFlight = tracked
      .filter(([, status]) => ['sending', 'unknown', 'used', 'failed'].includes(status))
      .map(([approvalId]) => approvalId);
    checks.push({
      name: 'earlier-release approvals',
      ok: true,
      warn: true,
      detail: `being retired since ${config.legacyDrain.since}: ${tracked.length} tracked, ${open.length} still open${open.length > 0 ? ` (${open.join(', ')})` : ''}${inFlight.length > 0 ? `, ${inFlight.length} reached by an earlier release's send (${inFlight.join(', ')})` : ''}`,
      fix: remedy(
        'Nothing to do: the next send prepare, claim or approval retries them. Until they are retired, no send policy can be loosened.',
      ),
    });
  }

  checks.push(await standingCheck(core, readable, handoffs));
  checks.push(...(await standingLedgerChecks(core, readable ? config : null, handoffs)));

  const keyring = options.keyring !== undefined ? options.keyring : await loadKeyringModule();
  // `probeKeychain` loads the real module when handed none, so a machine without it is answered here instead.
  const probe = keyring
    ? await probeKeychain(keyring, keychainNamespace(core.paths.configDir), handoffs)
    : { ok: false, reason: 'the optional @napi-rs/keyring package is not installed for this platform' };
  const usesKeychain = secretsStoreOf(config) === 'keychain';
  checks.push({
    name: 'system keychain',
    ok: probe.ok || !usesKeychain,
    detail: probe.ok ? 'readable and writable' : `unavailable: ${probe.reason}`,
    ...(probe.ok || !usesKeychain
      ? {}
      : {
          fix: remedy(
            handoffSentence(
              handoffs.core(['secrets', 'migrate', '--to', 'file']),
              (command) => `Unlock the keychain, or move secrets to files: ${command}.`,
            ),
          ),
        }),
  });
  checks.push({
    name: 'secret backend',
    ok: true,
    detail: config.secrets?.store ?? 'not chosen yet (keychain by default)',
  });
  // The activity log (design 2026-10-25-activity §4.6): recording, private, writable, retention in force, last failure.
  checks.push(await activityDoctorCheck(core, platform));
  // Content-free: on or off, counts, size, the model's state, backups, FileVault (design 2026-10-26-local-search §7).
  checks.push(
    await searchDoctorCheck(core, { env, ...(options.search === undefined ? {} : { deps: options.search }) }),
  );
  checks.push(await updateCheckLine(core, env, handoffs, (options.now ?? (() => new Date()))()));
  checks.push(...(await updateJobLines(core, env, handoffs, platform, options)));
  checks.push(...(await registrationChecks(core, env, readable ? config : null, handoffs, platform)));
  if (readable) checks.push(...(await connectionChecks(core, env)));
  return { checks, ok: checks.every((c) => c.ok) };
}

/**
 * The standing approvals in force (design 2026-10-19-standing-approvals, S10): each one, its workspace and when it
 * ends — or `none`. Something to know, never a fault, and read here, from the records and the configuration, rather
 * than from anything the agent that uses them says. One waiting for its code, or ended, is not in force.
 */
async function standingCheck(core: Core, readable: boolean, handoffs: CliHandoffs): Promise<DoctorCheck> {
  const name = 'standing approvals';
  if (!readable) return { name, ok: true, detail: 'unknown — the configuration could not be read' };
  let report: StandingReport;
  try {
    report = await standingReport(core);
  } catch (error) {
    return {
      name,
      ok: true,
      warn: true,
      detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const active = report.approvals.filter((view) => view.state === 'active');
  if (active.length === 0) return { name, ok: true, detail: 'none' };
  const list = handoffSentence(handoffs.core(['standing', 'list']), (command) => `${command} shows what each covers`);
  return {
    name,
    ok: true,
    detail: `${active.length} in force, each letting an agent acknowledge without asking: ${active
      .map((view) => `${view.id} on ${shownText(view.workspace, 64)} until ${view.expiresAt}`)
      .join('; ')}`,
    fix: remedy(
      handoffSentence(handoffs.core(['standing', 'off']), (command) => `${list}; ${command} ends every one at once.`, {
        instead: `${list}.`,
      }),
    ),
  };
}

/**
 * Each account's acknowledgement ledger that holds a line this release cannot read (design
 * 2026-10-19-standing-approvals, the lead's call after review): a row each, naming the account, its lines and where
 * the file is. While one does, no standing approval of that account can be used — its counts cannot be known, and a
 * count is never guessed downwards — and nothing but this says why. Something to put right, not a fault of the
 * machine, so a warning. The way back is the person's: end that account's standing approvals, then move the file
 * aside; a new one starts empty. Nothing at all when every ledger reads whole.
 */
async function standingLedgerChecks(core: Core, config: Config | null, handoffs: CliHandoffs): Promise<DoctorCheck[]> {
  let found: Awaited<ReturnType<Core['acks']['unreadable']>>;
  try {
    found = await core.acks.unreadable();
  } catch (error) {
    return [
      {
        name: 'standing ledger',
        ok: true,
        warn: true,
        detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  return found.map(({ accountId, path, lines }) => {
    const account = config === null ? undefined : findById(config, 'account', accountId)?.alias;
    const named = account === undefined ? accountId : `${shownText(account, 64)} (${accountId})`;
    const which =
      lines.length === 1
        ? `line ${lines[0]}`
        : `lines ${lines.slice(0, 10).join(', ')}${lines.length > 10 ? ', …' : ''}`;
    const end = handoffSentence(
      handoffs.core(['standing', 'off']),
      (off) =>
        `End ${account === undefined ? "this account's" : `${shownText(account, 64)}'s`} standing approvals — ${off}, or standing revoke for each`,
      { instead: "End this account's standing approvals with standing off, or standing revoke for each" },
    );
    return {
      name: 'standing ledger',
      ok: true,
      warn: true,
      detail: `${named}: ${which} of its acknowledgement ledger cannot be read, so none of its standing approvals can be used until it reads whole — ${shownPath(path)}`,
      fix: remedy(
        `${end}; then move the file aside (rename it, or move it out of its folder): ${shownPath(path)}. A new ledger starts empty, and its counts start again.`,
      ),
    };
  });
}

/**
 * What would keep a behaviour rule from holding as the person meant it (design 2026-10-19-agent-behaviour-rules, B3):
 *
 *  - a rule this release cannot read holds its account — or, naming none, every account — to nothing, so nothing can be
 *    done there until it is corrected: a failure;
 *  - a rule whose account is not connected now still holds, by name, whatever account takes that name: safe, since a
 *    restriction held more widely is, but something to look at.
 *
 * Nothing at all on a machine with no rule, so every other doctor reads as it always did. The third row, servers that
 * enforce no rule, is read with the registrations (`registrationChecks`).
 */
/**
 * Taking messages (design 2026-10-26-taking-messages §4): a value in `taking` this release cannot read counts as the
 * stricter one — a take required — and is said here, so the person knows why a session is refused.
 */
function takingChecks(config: Config, handoffs: CliHandoffs): DoctorCheck[] {
  const { problems } = readTakingSettings(config);
  if (problems.length === 0) return [];
  const listing = handoffSentence(handoffs.core(['taking']), (command) => ` ${command} shows what applies.`);
  return [
    {
      name: 'taking messages',
      ok: false,
      detail: `${problems.map((problem) => shownText(problem, 240)).join('; ')} — until it is corrected`,
      fix: remedy(
        `Correct taking.accounts in config.json — or, if a later release wrote it, update agent-communications.${listing}`,
      ),
    },
  ];
}

function behaviourChecks(config: Config, handoffs: CliHandoffs): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  const listing = handoffSentence(handoffs.core(['behaviour']), (command) => ` ${command} lists every rule.`);
  const { unreadable } = readBehaviourSettings(config);
  if (unreadable.length > 0) {
    // Its reason is fixed words; the account is the file's, shown made safe.
    const held = unreadable.map(
      (entry) =>
        `${entry.reason}, so ${entry.account === null ? 'every account' : shownText(entry.account, 64)} allows nothing`,
    );
    checks.push({
      name: 'behaviour rules',
      ok: false,
      detail: `${held.join('; ')} until it is corrected`,
      fix: remedy(
        `Correct or remove ${unreadable.length === 1 ? 'it' : 'them'} in behaviour.rules in config.json — or, if a later release wrote ${unreadable.length === 1 ? 'it' : 'them'}, update agent-communications.${listing}`,
      ),
    });
  }
  const orphans = orphanedBehaviourRules(config);
  if (orphans.length > 0) {
    const names = new Set(behaviourAccountsOf(config).map((account) => account.account));
    const held = orphans.map((rule) => {
      const account = shownText(rule.account, 64);
      const place = rule.conversation === undefined ? account : `${account} in ${shownText(rule.conversation, 64)}`;
      return names.has(rule.account)
        ? `${place} applies by name to ${account}, the account connected under that name now`
        : `${place} applies to no account connected now, and will to one connected under that name`;
    });
    checks.push({
      name: 'orphaned behaviour rules',
      ok: true,
      warn: true,
      detail: `${orphans.length === 1 ? 'a rule whose account is' : 'rules whose account is'} not connected now still ${orphans.length === 1 ? 'holds' : 'hold'}, by name — a restriction held more widely is safe: ${held.join('; ')}`,
      fix: remedy(
        handoffSentenceToFill(
          handoffs.core(['behaviour', 'allow']),
          ['<account>', '<act,…|none>'],
          (command) =>
            `To bind one to the account connected under its name now, set it again for that account: ${command}.${listing}`,
        ),
      ),
    });
  }
  return checks;
}

/**
 * Organisation profiles against the configuration (design 2026-10-02 §D4): one line per profile, and one per drift
 * with the command that puts it right.
 *
 * Older releases share this file and know nothing of a profile's rules — one can `client remove` a row a profile owns
 * — and the daily update check that keeps mixed releases short-lived can be turned off, so nothing here assumes the
 * record is intact. What `org update` repairs fails the check: it is a configuration that has drifted from what was
 * approved, and new mailboxes are refused the organisation's client until it is repaired. What nothing here can rebuild
 * — an earlier client gone with its secret — is something to look at, with the way to move its mailboxes. A mark naming
 * an organisation with no record is something to look at too: the row is an ordinary client again.
 *
 * Nothing at all is said on a machine with no profile, so every other doctor reads as it always did.
 *
 * An entry of a profile's `extensions` that this release did not apply is said too, on a line of its own: information,
 * never a failure — the rest of the profile is in force, and the release that applies it is named (design 2026-10-19,
 * X7).
 */
function organisationChecks(config: Config, handoffs: CliHandoffs): DoctorCheck[] {
  const checks: DoctorCheck[] = [];
  for (const organisation of Object.keys(organisationsOf(config)).sort()) {
    const drift = organisationDrift(config, organisation, handoffs);
    const record = organisationsOf(config)[organisation];
    const active = record?.gmail?.active ?? null;
    if (drift.length === 0) {
      checks.push({
        name: `organisation ${organisation}`,
        ok: true,
        detail: `${shownText(record?.label ?? '', 64)}: ${active === null ? 'no Google client' : `new mailboxes get "${active}"`}${record?.slack ? `; Slack workspace ${shownText(record.slack.workspace, 40)}` : ''}`,
      });
    }
    for (const item of drift) {
      checks.push({
        name: `organisation ${organisation}`,
        ok: item.kind === 'report',
        ...(item.kind === 'report' ? { warn: true as const } : {}),
        detail: item.detail,
        fix: item.fix,
      });
    }
    const ignored = ignoredOf(record);
    if (ignored.length > 0) {
      checks.push({
        name: `organisation ${organisation}`,
        ok: true,
        detail: `${ignored.length} ${ignored.length === 1 ? 'extension' : 'extensions'} not applied here: ${ignored
          .map((entry) => notAppliedDetail(entry))
          .join('; ')}`,
      });
    }
    // A list of skipped entries this release cannot read in part is read without that part: nothing applies from it,
    // so the check is something to look at, not a failure, and `org update` writes the list again from the profile.
    if (ignoredListOf(record).malformed) {
      checks.push({
        name: `organisation ${organisation}`,
        ok: true,
        warn: true,
        detail:
          'its record of the extensions not applied here holds something this release cannot read, so that part is ignored; no extension applies from it',
        fix: remedy(
          handoffSentence(
            handoffs.core(['org', 'update', organisation]),
            (command) => `Run ${command} to write it again from the profile.`,
            { instead: 'Call comms_org_update from a chat to write it again from the profile.' },
          ),
        ),
      });
    }
  }
  for (const { client, organisation } of orphanMarkedRows(config)) {
    checks.push({
      name: 'organisation mark',
      ok: true,
      warn: true,
      detail: `the OAuth client "${client}" is marked as belonging to "${shownText(organisation, 40)}", which has no profile here`,
      fix: remedy(
        `It is treated as a client of your own. ${handoffSentence(
          handoffs.of('gmail', ['client', '--help'], { uses: [] }),
          (command) => `${command} shows commands that can change or remove it.`,
        )} ${handoffSentence(
          handoffs.core(['org', 'add', '--help'], { uses: [] }),
          (command) => `To give it back to the organisation, add its profile with ${command}.`,
        )}`,
      ),
    });
  }
  return checks;
}

/**
 * How this machine updates, in one line (design 2026-09-28 §4, 2026-10-16 U2 and U3): the level — and what set it — when
 * the registry was last asked, the latest release it named, the release running here, and a pause with when it ends.
 * Never a failure: an update that is out is something to look at, with the way on, and the rest is information.
 */
async function updateCheckLine(
  core: Core,
  env: NodeJS.ProcessEnv,
  handoffs: CliHandoffs,
  now: Date,
): Promise<DoctorCheck> {
  const updates = await effectiveUpdates(core, env, now);
  const record = await readUpdateCheck(core.paths.stateDir);
  // Where a cap or a profile's `background: false` comes from (design 2026-10-16, U8): the organisation and its file.
  const fromProfile = (where: { organisation: string; source: string }) =>
    `${shownText(where.organisation, 40)}’s profile, ${shownPath(where.source)}`;
  const level =
    updates.by !== 'setting'
      ? `never (${updates.by === 'CI' ? 'CI is set' : `${updates.by} is set`})`
      : updates.cap
        ? `${updates.level} (capped by ${fromProfile(updates.cap)})`
        : updates.level === 'auto' && !updates.background
          ? updates.backgroundOff
            ? `auto (a daily check with a notice: background updates off by ${fromProfile(updates.backgroundOff)})`
            : updates.jobSilent
              ? `auto (a daily check with a notice: background updates have not run since ${localStamp(new Date(updates.jobSilent.since))})`
              : updates.unreadableConfig
                ? 'auto (a daily check with a notice)'
                : 'auto (a daily check with a notice: background updates are not set up)'
          : updates.level;
  // Only ever a plain release (`readUpdateCheck`): the registry's text otherwise names none.
  const latest = countedLatest(record) ?? 'unknown';
  const pause = pauseEnd(record, now);
  const security = securityRelease(record, VERSION);
  const parts = [level, `last checked ${record.lastChecked ?? 'never'}`, `latest ${latest}`, `running ${VERSION}`];
  // An unreadable configuration lifts no cap (U8, failing closed): say what stands in for it.
  const unreadable = updates.unreadableConfig;
  if (unreadable !== undefined) {
    parts.push(
      unreadable.read > 0
        ? `config.json could not be read, so the caps of the organisation files still readable hold, and nothing installs in the background (${unreadable.reason})`
        : `config.json could not be read, and no organisation’s caps could be read in its place, so the default holds and nothing installs in the background (${unreadable.reason})`,
    );
  }
  if (updates.backgroundOff && !(updates.level === 'auto' && !updates.cap)) {
    parts.push(`background updates off by ${shownText(updates.backgroundOff.organisation, 40)}’s profile`);
  }
  if (security !== null) parts.push(`${security} fixes a security problem`);
  if (pause !== null) parts.push(`paused until ${localStamp(pause)}`);
  if (record.lastError !== null) parts.push(`the last check got no answer: ${record.lastError}`);
  // The core's server and its command, each as its own notice reads it: installed only when both would start `latest`.
  const verdict = (surface: 'server' | 'command') =>
    updates.level !== 'never' || security !== null
      ? updateVerdict(record, VERSION, { channel: 'core', surface })
      : null;
  const [asServer, asCommand] = [verdict('server'), verdict('command')];
  const pending = asServer ?? asCommand;
  return {
    name: 'update check',
    ok: true,
    ...(pending || unreadable ? { warn: true as const } : {}),
    detail: parts.join(' · '),
    ...(pending === null
      ? {}
      : {
          fix: remedy(
            asServer?.kind === 'restart' && asCommand?.kind === 'restart'
              ? `${pending.latest} is installed on this machine: restart the MCP clients, and run commands from it.`
              : handoffSentence(handoffs.core(['update']), (update) =>
                  handoffSentence(
                    handoffs.core(['update', '--pause']),
                    (later) =>
                      `Run ${update} (comms_update from a chat) when it suits you, or ${later} to hold the notice for a week.`,
                  ),
                ),
          ),
        }),
  };
}

/**
 * The background update job (design 2026-10-16 U4): installed, missing, foreign or stale, each with what fixes it — and
 * nothing at all on a machine that never set one up, so every other doctor reads as it always did.
 *
 * Read from its files on macOS and Linux, so the doctor starts no program there. On Windows the scheduler is asked
 * only when this installation recorded a job; a task another installation registered with no record here is not
 * looked for. A job that cannot be read is something to look at, never a failure: the machine works without it.
 */
async function updateJobLines(
  core: Core,
  env: NodeJS.ProcessEnv,
  handoffs: CliHandoffs,
  platform: NodeJS.Platform,
  options: DoctorOptions,
): Promise<DoctorCheck[]> {
  const name = 'background update job';
  const context = updateJobContext(core, env, { platform, deps: options.updateJob });
  let seen: Awaited<ReturnType<typeof inspectUpdateJob>>;
  try {
    seen = await inspectUpdateJob(context, { query: 'when-recorded' });
  } catch (error) {
    return [
      {
        name,
        ok: true,
        warn: true,
        detail: `could not be read: ${error instanceof Error ? error.message : String(error)}`,
      },
    ];
  }
  const on = handoffs.core(['update', '--background-job', 'on']);
  const off = handoffs.core(['update', '--background-job', 'off']);
  const since =
    seen.marker === null
      ? ''
      : ` (set up ${seen.marker.installedAt}${seen.marker.lastRun ? `, last ran ${seen.marker.lastRun}` : ''})`;
  const background = options.background ?? (await effectiveUpdates(core, env)).backgroundOff === undefined;
  // A profile that came after the job (Review focus 5): the job's next run removes it, and this says so before then.
  if (!background && (seen.state === 'installed' || seen.state === 'stale' || seen.state === 'missing')) {
    return [
      {
        name,
        ok: true,
        warn: true,
        detail: `an organisation profile turns background updates off here: ${seen.where} is still set up${since}, and its next run removes it`,
        fix: remedy(handoffSentence(off, (command) => `Remove it now with ${command}.`)),
      },
    ];
  }
  switch (seen.state) {
    case 'not-set-up':
      return [];
    case 'installed': {
      const health = await updateJobHealth(core.paths.stateDir, (options.now ?? (() => new Date()))());
      // Installed as it should be, and silent: switched off in Login Items, a timer that never fires (U4, U7).
      if (health !== null && !health.working) {
        return [
          {
            name,
            ok: true,
            warn: true,
            detail: `installed, and has not run since ${health.since}${health.marker.lastRun ? '' : ', when it was set up'}: ${seen.where} runs ${context.launcher} update --background, and nothing has run it in 48 hours, so every notice and the security line are given as though there were no job`,
            fix: remedy(
              handoffSentence(
                on,
                (again) =>
                  `${silentWhere(platform)} If it is there and allowed, set it up again with ${again}, and run the doctor tomorrow.`,
              ),
            ),
          },
        ];
      }
      return [
        { name, ok: true, detail: `installed: ${seen.where} runs ${context.launcher} update --background${since}` },
      ];
    }
    case 'missing':
      return [
        {
          name,
          ok: true,
          warn: true,
          detail: `missing: set up${since}, and ${seen.where} is gone, so nothing installs in the background`,
          fix: remedy(
            handoffSentence(on, (again) =>
              handoffSentence(off, (forget) => `Set it up again with ${again}, or forget it with ${forget}.`),
            ),
          ),
        },
      ];
    case 'foreign':
      return [
        {
          name,
          ok: true,
          warn: true,
          detail: `foreign: ${seen.where} is not this installation's — ${seen.reason}`,
          fix: remedy(
            'This installation leaves it alone. If it is not wanted, remove it with the installation that set it up, or by hand.',
          ),
        },
      ];
    case 'stale':
      return [
        {
          name,
          ok: true,
          warn: true,
          detail: `stale: ${seen.where} is this installation's, but ${seen.reason}${since}`,
          fix: remedy(
            handoffSentence(on, (again) =>
              handoffSentence(off, (remove) => `Write it again with ${again}, or remove it with ${remove}.`),
            ),
          ),
        },
      ];
  }
}

/** Where a person looks for a background job that does not run, in words: each platform's own place. */
function silentWhere(platform: NodeJS.Platform): string {
  if (platform === 'darwin') {
    return 'Check Login Items (System Settings → General → Login Items): macOS lists the job there, and it runs only while allowed.';
  }
  if (platform === 'linux') {
    return 'Check that the agentcomms-update timer is enabled for your user, and that your user’s systemd instance runs.';
  }
  return 'Check the agentcomms-update task in Task Scheduler: that it is enabled, and what its last run result was.';
}

/**
 * Each MCP connection (single-server design §9.2): its record can be read; its entry is in its app, carrying its key —
 * compared by hash, neither ever printed; each part's account is still connected; and each managed part's runtime is
 * there for its launcher to start. Something to look at rather than a failure: a connection is the person's to change.
 */
async function connectionChecks(core: Core, env: NodeJS.ProcessEnv): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];
  const { connections } = await connectionList(core, env).catch(() => ({ connections: [] }));
  for (const view of connections) {
    const name = `connection ${view.name === null ? view.id : `"${view.name}"`}`;
    const look = (detail: string, fix: string): void => {
      checks.push({ name, ok: true, warn: true, detail, fix: remedy(fix) });
    };
    if (!view.readable) {
      look(
        `it could not be read, so it serves nothing: ${view.problems.join('; ')}`,
        'Remove it with the connection command, and add it again.',
      );
      continue;
    }
    if (view.key.revoked) {
      checks.push({ name, ok: true, detail: 'cut off: it serves nothing' });
      continue;
    }
    let problems = 0;
    if (view.entry !== null && view.entry.present === false) {
      look(
        `its entry "${view.entry.name}" is not in ${view.appLabel}'s configuration any more, so ${view.appLabel} does not start it`,
        'Add the connection again, or remove it.',
      );
      problems += 1;
    } else if (view.entry !== null && view.entry.keyMatches === false) {
      look(
        `its entry in ${view.appLabel} carries a key that is not the connection's, so it serves nothing there`,
        'Replace its key with the connection command: the new one is written into the entry.',
      );
      problems += 1;
    }
    for (const part of view.parts) {
      if (!part.available) {
        look(
          `${part.label} is not started: ${part.why}`,
          'Change its parts with the connection command, keeping the part to an account that is connected.',
        );
        problems += 1;
        continue;
      }
      if (view.launcher !== 'managed') continue;
      const launcher = launcherName(serverFacts(part.server).packageName);
      const pointer = await readPointer(core.paths.dataDir, launcher).catch(() => undefined);
      if (pointer === undefined || !launcherCanStartSync(pointer.current, launcher)) {
        look(
          `${part.label}'s runtime is not installed on this machine, so the connection cannot start it`,
          'Bring everything up to date with the update command, or change the connection’s parts.',
        );
        problems += 1;
      }
    }
    if (problems === 0) {
      checks.push({
        name,
        ok: true,
        detail: `${view.appLabel}: ${view.parts.map((part) => part.text).join('; ') || 'no parts'}`,
      });
    }
  }
  return checks;
}

/**
 * Which MCP clients start each server, read the way `agentcomms channels` reads it.
 *
 * Every check above passed on a machine where an install had registered nothing: the only symptom was a client with
 * none of the tools, and the doctor said all was well. So every client config is read for every server:
 *
 *  - an entry whose command or script has gone fails, with the command that registers it again — the client starts
 *    it, it exits, and the client says only that it failed — in one row that names every problem with it;
 *  - an entry without all four folder pins (CUE-403), written before 0.13.1, still starts, so it is something to look
 *    at, with the same command, which pins them;
 *  - a channel with accounts here that no client starts is something to look at, not a failure: it may be used only
 *    from a terminal, but somebody who connected a mailbox and sees no Gmail tools has usually hit exactly this;
 *  - a client config that cannot be read is said to be unreadable, and nothing is concluded from its silence.
 *
 * `config` is null when it could not be read: the check above says so, and no channel is said to have accounts.
 */
async function registrationChecks(
  core: Core,
  env: NodeJS.ProcessEnv,
  config: Config | null,
  handoffs: CliHandoffs,
  platform: NodeJS.Platform,
): Promise<DoctorCheck[]> {
  const REGISTRATION_PATH_KEYS = ['configDir', 'stateDir', 'dataDir', 'secretsDir'] as const;
  const report = await channelsAvailable(core, env);
  const checks: DoctorCheck[] = report.unreadable.map((file) => ({
    name: 'client config',
    ok: true,
    warn: true,
    detail: `${file.path} could not be read (${file.reason}), so which servers ${file.client} starts is not known`,
    fix: remedy(`Look at ${file.path}: until it can be read, nothing here can say what it registers.`),
  }));
  const blind = report.unreadable.map((file) => file.path);
  const where = (entry: ChannelRegistration) =>
    `${entry.client} as "${entry.name}" in ${entry.path}${entry.scope === 'project' ? ' (for one project)' : ''}`;
  if (!managedShimsSupported({ platform })) {
    checks.push({
      name: 'managed CLI shims',
      ok: true,
      warn: true,
      detail: managedShimUnsupportedNotice({ platform }),
    });
  }
  const unenforced: string[] = [];
  for (const channel of report.channels) {
    const name = `${channel.channel} server`;
    if (actsOnOthers(channel.channel)) {
      for (const entry of channel.registered) {
        // A registration whose release cannot be read — none named, or not one — may be any release, an older one
        // too: it is not counted as enforcing (fail closed), and said in words of its own.
        const enforces = enforcementOf(entry.version);
        if (enforces === 'unknown') {
          unenforced.push(
            `the ${channel.label} server registered with ${where(entry)} names no release that can be read, so it may enforce no behaviour rule`,
          );
        } else if (enforces === 'older') {
          unenforced.push(
            `the ${channel.label} server registered with ${where(entry)} is ${entry.version}, which enforces no behaviour rule`,
          );
        }
      }
    }
    const latestRuntime = channel.runtimes.reduce<(typeof channel.runtimes)[number] | null>(
      (latest, runtime) =>
        latest === null || (compareVersions(runtime.version, latest.version) ?? 0) > 0 ? runtime : latest,
      null,
    );
    if (latestRuntime !== null && managedShimsSupported({ platform })) {
      /*
       * A shim starts the stable launcher once there is one (design 2026-10-16, U6), so one naming a runtime is stale;
       * before it, the newest runtime, with this Node as a command names it — a shim naming the file a link resolves to
       * is stale too (CUE-492).
       */
      const name = launcherName(channel.package);
      const expected = (await launcherExists(core.paths.dataDir, name))
        ? { expectedEntry: launcherPaths(core.paths.dataDir, name).launcher }
        : {
            expectedEntry: managedRuntimeEntry(core.paths.dataDir, channel.package, latestRuntime.version),
            expectedNode: nodeProgram(env),
          };
      const shim = await inspectManagedShim(
        { env, dataDir: core.paths.dataDir, platform },
        { binary: channel.binary, ...expected },
      );
      if (shim.status !== 'current') {
        checks.push({
          name: `CLI shim at ${shim.path}`,
          ok: true,
          warn: true,
          detail: `${shim.status}: ${shim.path}; ${shim.detail}`,
          fix: remedy(
            shim.status === 'foreign'
              ? `Confirm who owns ${shim.path}, then move it aside if this installation should provide that command. A managed install or update will create the shim without overwriting a foreign file.`
              : `Run a managed install or update for ${channel.label}; it will ${shim.status === 'missing' ? 'create' : 'repoint'} the owned shim.`,
          ),
        });
      }
    }
    for (const entry of channel.registered) {
      const missingPins = REGISTRATION_PATH_KEYS.filter((key) => entry.pathPins[key] === undefined);
      const unpinned =
        missingPins.length === 0
          ? ''
          : `its suite path pins are incomplete (missing ${missingPins.map((key) => `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`).join(', ')})`;
      if (entry.missing !== null) {
        // One row for the entry, naming every problem with it: the one command below repairs them all.
        checks.push({
          name,
          ok: false,
          detail: `registered with ${where(entry)}, but ${entry.missing} is no longer there, so ${entry.client} cannot start it${unpinned === '' ? '' : `; ${unpinned} too`}`,
          fix: registerAgain(channel.channel, entry, handoffs),
        });
        continue;
      }
      // Registered before 0.13.1, it still starts, and finds its folders as it always did: something to look at, which
      // registering it again repairs by pinning them.
      if (unpinned !== '') {
        checks.push({
          name,
          ok: true,
          warn: true,
          detail: `registered with ${where(entry)}, but ${unpinned}, so it finds its folders from whatever environment ${entry.client} starts it with`,
          fix: registerAgain(channel.channel, entry, handoffs),
        });
      }
    }
    const working = channel.registered.filter(
      (entry) => entry.missing === null && REGISTRATION_PATH_KEYS.every((key) => entry.pathPins[key] !== undefined),
    );
    if (working.length > 0) {
      checks.push({ name, ok: true, detail: `registered with ${working.map(where).join('; ')}` });
      continue;
    }
    // Registered, and every entry of it broken: the failures above say so, each with what to run.
    if (channel.registered.length > 0) continue;
    const accounts = config === null ? [] : accountsOf(config, channel.channel);
    if (accounts.length === 0) continue;
    const clients = CLIENTS.filter((client) => client !== 'json').join(', ');
    checks.push({
      name,
      ok: true,
      warn: true,
      detail: `${listed(accounts, 'and')} ${accounts.length === 1 ? 'is' : 'are'} set up here, but no MCP client${blind.length > 0 ? ' this could read' : ''} starts the ${channel.label} server${blind.length > 0 ? ` — ${listed(blind, 'and')} could not be read` : ''}`,
      // Its terminal route is its own `mcp install`, found only where it is registered — which here it is not, unless
      // with another client — so the route from a chat, which core itself takes, is said either way.
      fix: (() => {
        const install = handoffs.of(channel.channel, ['mcp', 'install', '--help'], { uses: [] });
        const fromChat = `comms_server_install with channel "${channel.channel}" from a chat`;
        return remedy(
          isCommand(install)
            ? `Register it with the client you use: ${inlineCommand(install)} (${clients}), or ${fromChat}. Used only from a terminal, it needs nothing.`
            : `Register it with ${fromChat}. ${install.message} Used only from a terminal, it needs nothing.`,
        );
      })(),
    });
  }
  // B4: a rule is enforced only by servers of 0.22.0 and later, and only once their client has started them again.
  const settings = config === null ? null : readBehaviourSettings(config);
  if (settings !== null && settings.rules.length + settings.unreadable.length > 0 && unenforced.length > 0) {
    const clients = [...new Set(report.channels.flatMap((channel) => channel.registered.map((entry) => entry.client)))];
    checks.push({
      name: 'behaviour enforcement',
      ok: true,
      warn: true,
      detail: `${unenforced.join('; ')}: an agent there may start any act, each still waiting for the person's yes`,
      fix: remedy(
        handoffSentence(
          handoffs.core(['update']),
          (command) =>
            `Bring every registration to the latest release with ${command}, then restart ${listed(clients, 'and')}: a server started before ${BEHAVIOUR_ENFORCED_SINCE} enforces no rule until its client restarts it.`,
        ),
      ),
    });
  }
  return checks;
}

/** The release whose servers enforce the behaviour rules (B4). */
const BEHAVIOUR_ENFORCED_SINCE = '0.22.0';

/**
 * Whether a registration's release enforces the behaviour rules: `older` before 0.22.0, which enforces none. A
 * prerelease of 0.22.0 or later — a branch's build — has the code that enforces them, so it is read as its release.
 * `unknown` when it names no release, or one that cannot be read: it may be an older one, so it is never counted as
 * enforcing.
 */
function enforcementOf(version: string | null): 'enforces' | 'older' | 'unknown' {
  if (version === null) return 'unknown';
  const order = compareVersions(version.replace(/[-+].*$/u, ''), BEHAVIOUR_ENFORCED_SINCE);
  return order === null ? 'unknown' : order < 0 ? 'older' : 'enforces';
}

/** A channel whose accounts can act on other people — one with a `send` mode — and so whose server enforces rules. */
function actsOnOthers(channel: Channel): boolean {
  return manifestOf(channel)?.accounts?.modes.includes('send') === true;
}

/** The names of a channel's accounts on this machine, from the map its manifest keeps them in; none for the core. */
function accountsOf(config: Config, channel: Channel): string[] {
  const accounts = manifestOf(channel)?.accounts;
  if (accounts === undefined) return [];
  if (accounts.map === 'inboxes') return Object.keys(config.inboxes).sort();
  return Object.entries(config.accounts)
    .filter(([, account]) => account.platform === channel)
    .map(([name]) => name)
    .sort();
}

/**
 * What registers a broken entry again as it was: its client, its name, its pin and `--read-only`, and its launcher —
 * the flags `mcp install`'s own hint repeats when it refuses to replace an entry without `--force`, so following it
 * narrows or widens nothing. A project's entry is not one `mcp install` writes, and is said to be where it is instead.
 */
function registerAgain(channel: ServerId, entry: ChannelRegistration, handoffs: CliHandoffs): Remedy {
  if (entry.scope === 'project') {
    return remedy(
      `It is registered for one project, in ${entry.path}, and \`mcp install\` registers at user scope only: remove it or register it again there, with ${entry.client}'s own command.`,
    );
  }
  const facts = serverFacts(channel);
  const words = ['mcp', 'install', '--client', entry.client];
  if (entry.name !== facts.defaultServerName) words.push('--name', entry.name);
  words.push(...entry.narrowing);
  if (entry.launcher === 'npx' || entry.launcher === 'local') words.push('--launcher', entry.launcher);
  words.push('--force');
  // Core's own command, located, for every server (re-review of 0.20.0, severity 3): a channel's own `mcp install`
  // registers the release that command is, and the one found here may be the old one an entry behind still starts.
  // The entry's name and pins are read from the client's file, which may hold anything: a located command shows them
  // as words to type where no Windows line is safe.
  const handoff = handoffs.core(
    channel === 'core' ? words : ['mcp', 'install', '--server', channel, ...words.slice(2)],
  );
  return remedy(handoffSentence(handoff, (command) => `Register it again: ${command}.`));
}

/** An inbox's id from its name — the current one, so a former name is answered with what it is called now. */
function inboxIdFor(config: Config, alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  return resolveName(config, 'inbox', alias, () => new CommsError('NOT_FOUND', `no inbox called "${alias}"`)).inbox.id;
}

export interface AuditTailOptions {
  inbox?: string | undefined;
  since?: string | undefined;
  limit?: number | undefined;
}

/** The same strict plain-address grammar the sending channels use for an address returned outside an envelope. */
const PLAIN_AUDIT_ADDRESS = /^[a-z0-9._%+-]{1,64}@(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$/i;

function auditRecipient(address: string, record: AuditRecord, boundary: string): string {
  if (PLAIN_AUDIT_ADDRESS.test(address)) return address;
  const text = stripInvisible(address).text.slice(0, 500);
  return wrapUntrusted(
    text,
    {
      field: 'recipient',
      inbox: record.alias || record.inboxId,
      ...(record.approvalId === undefined ? {} : { id: record.approvalId }),
    },
    boundary,
  );
}

export async function auditTail(core: Core, options: AuditTailOptions = {}): Promise<AuditRecord[]> {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new CommsError('USAGE', 'the limit must be a positive whole number');
  }
  const inboxId = inboxIdFor(await core.config.load(), options.inbox);
  // The inbox filter goes INTO the scan, not after it. `tail` applies it while counting toward `limit`; filtering
  // the returned array instead meant a quiet inbox's history was read as empty whenever a busier one had produced
  // `limit` records since — and raising `--limit` changed the answer, which is the tell. This is what someone asks
  // to find out what was sent from a mailbox.
  const records = await core.audit.tail({
    limit,
    ...(inboxId ? { inbox: inboxId } : {}),
    ...(options.since ? { since: options.since } : {}),
  });
  const boundary = newBoundary();
  return records.map((record) =>
    record.recipients === undefined
      ? record
      : { ...record, recipients: record.recipients.map((address) => auditRecipient(address, record, boundary)) },
  );
}

/** Every state a listing can be filtered by: the stored states, and `corrupt` for a record that cannot be used. */
export const APPROVAL_STATES: readonly (ApprovalState | 'corrupt')[] = Object.freeze([
  'pending',
  'approved',
  'sending',
  'used',
  'failed',
  'unknown',
  'expired',
  'revoked',
  'corrupt',
]);

/**
 * Every approval on this machine, in its public shape (`publicApproval`): a version-2 record, a record an earlier
 * release prepared, a corrupt record shown to its owner, or the stub of one that cannot be read — none of them skipped.
 *
 * `inbox` keeps the records owned by that mailbox (`ownerOf`), so a record whose owner cannot be trusted never matches
 * it; `state` keeps those in that state (`stateOf`).
 */
export async function listApprovals(
  core: Core,
  options: { inbox?: string | undefined; state?: string | undefined } = {},
): Promise<PublicApprovalView[]> {
  // A state that does not exist matched nothing, and read as "no approvals" — the one answer that is never a
  // reason to look again.
  if (options.state !== undefined && !(APPROVAL_STATES as readonly string[]).includes(options.state)) {
    throw new CommsError('USAGE', `"${options.state}" is not an approval state`, {
      hint: `One of: ${APPROVAL_STATES.join(', ')}.`,
    });
  }
  const inboxId = inboxIdFor(await core.config.load(), options.inbox);
  // Each looked at under its lock and classified, as a status is (design 2026-10-05 §D8): the public object, or a stub.
  const records = await core.approvals.inspectAll({
    ...(inboxId ? { inboxId } : {}),
    ...(options.state ? { states: [options.state as ApprovalState | 'corrupt'] } : {}),
  });
  return records.map(({ stored, outcome }) => publicApproval(stored, outcome));
}

/**
 * Revokes an approval of any kind. Refusing is never the dangerous direction, so this asks nobody.
 *
 * A change approval is revoked through `revokeChange`, which records it in the audit log as every other step of a
 * change approval is; a standing approval through `endStanding`, which ends every unused child of it with it, so none
 * minted before the revoke can still be claimed in the minutes it lasts (design 2026-10-19-standing-approvals, S8); a
 * send approval as it always was. Any from an earlier release is retired in its own shape. A corrupt or unreadable
 * record is refused, with only its stub, and nothing is written to it.
 *
 * What it returns is the record's public object, as a status shows it (`publicApproval`): what a sender wrote — the
 * recipients and subject, a question's file names — only inside the untrusted-content envelope, never the stored record.
 */
export async function revokeApproval(
  core: Core,
  approvalId: string,
  surface: 'cli' | 'mcp',
): Promise<PublicApprovalView> {
  // Looked at under its lock first, classified there: one nobody prepared is the one NOT_FOUND, and one that cannot be
  // used is refused with only its stub, before anything is written or audited.
  const { stored: existing } = await core.approvals.inspect(approvalId);
  if (existing.form === 'corrupt' || existing.form === 'unreadable') throw integrityRefusal(existing);
  const reason = 'revoked by the user';
  const kind = kindOf(existing);
  const stored: StoredApproval =
    kind === 'change'
      ? await revokeChange(core, approvalId, reason, { surface, disposition: 'person' })
      : kind === 'standing' && existing.form === 'v2'
        ? { form: 'v2', record: await endStanding(core, approvalId, reason) }
        : await core.approvals.revoke(approvalId, reason, { disposition: 'person' });
  return publicApproval(stored, await core.approvals.outcomeOf(stored));
}
