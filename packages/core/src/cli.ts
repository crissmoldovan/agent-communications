#!/usr/bin/env node
import { randomBytes } from 'node:crypto';
import { access, constants, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { publicView } from './approvals.ts';
import { beginChangeApproval, finishChangeApproval, recordChangeApprovalRefused, revokeChange } from './changes.ts';
import {
  agentMarker,
  canPrompt,
  colorEnabled,
  defaultStreams,
  type OutputOptions,
  paint,
  refuseUnlessPerson,
  requirePerson,
  runCommand,
  type Streams,
  writeError,
  writeResult,
} from './cli-runtime.ts';
import { type Config, classifyChange, emptyConfig, type LooseningConsent, secretsStoreOf } from './config.ts';
import { type Core, openCore } from './core.ts';
import { CommsError } from './errors.ts';
import { isGroupOrWorldAccessible } from './fs.ts';
import { APPROVAL_KEY_REF } from './keys.ts';
import { withCredentialsLock } from './lock.ts';
import {
  migrateNames,
  type NamesMigrationRow,
  type NotApplicableRename,
  planNamesMigration,
  resolveName,
} from './names.ts';
import {
  keychainNamespace,
  loadKeyringModule,
  openSecretStore,
  probeKeychain,
  type SecretStore,
  type SecretStoreKind,
} from './secrets.ts';
import { VERSION } from './version.ts';

/**
 * `agentcomms` — the provider-neutral command: where things live, whether this machine is healthy, what was written
 * to mailboxes, which approvals exist, and moving secrets between backends. Provider commands live in their own
 * binaries (`agent-gmail`).
 */

const HELP = `agentcomms ${VERSION} — agent-communications core

Usage:
  agentcomms paths                         where config, state, data and downloads live
  agentcomms doctor                        check this machine: Node, directories, secret store
  agentcomms audit tail [--inbox <alias>] [--since <ISO time>] [--limit <n>]
  agentcomms approvals list [--inbox <alias>] [--state <state>]
  agentcomms approvals revoke <approvalId>
  agentcomms approve <approvalId>          approve a configuration change at this terminal: read it, type the code
  agentcomms secrets migrate --to keychain|file
  agentcomms names migrate [--rename <old>=<new>] [--dry-run] [--yes]

Options:
  --json        print the versioned JSON envelope
  --no-color    disable colour (also NO_COLOR, TERM=dumb)
  -h, --help    show this help
  -v, --version show the version

Exit codes: 0 ok · 1 unexpected · 10 approval required · 64 usage · 65 bad data · 66 not found
            69 provider unavailable · 75 transient · 77 auth or scope missing · 78 config error
`;

function usage(message: string): CommsError {
  return new CommsError('USAGE', message, { hint: 'Run `agentcomms --help`.' });
}

function inboxIdFor(config: Config, alias: string | undefined): string | undefined {
  if (!alias) return undefined;
  return resolveName(config, 'inbox', alias, () => new CommsError('NOT_FOUND', `no inbox called "${alias}"`)).inbox.id;
}

interface Check {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

async function doctor(core: Core): Promise<{ checks: Check[]; ok: boolean }> {
  const checks: Check[] = [];
  const [major = 0, minor = 0] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 12);
  checks.push({
    name: 'node',
    ok: nodeOk,
    detail: `Node ${process.versions.node} at ${process.execPath}`,
    ...(nodeOk ? {} : { fix: 'Install Node 22.12 or newer.' }),
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
        ...(loose ? { fix: `chmod 700 ${dir}` } : {}),
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
      fix: 'Fix or restore config.json.',
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
  const toMigrate = readable && config.version === 1;
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
          fix: 'See what they would become with `agentcomms names migrate --dry-run`, once everything sharing this config is on 0.2.0 or later.',
        }
      : {}),
  });

  const keyring = await loadKeyringModule();
  const probe = await probeKeychain(keyring, keychainNamespace(core.paths.configDir));
  const usesKeychain = secretsStoreOf(config) === 'keychain';
  checks.push({
    name: 'system keychain',
    ok: probe.ok || !usesKeychain,
    detail: probe.ok ? 'readable and writable' : `unavailable: ${probe.reason}`,
    ...(probe.ok || !usesKeychain
      ? {}
      : { fix: 'Unlock the keychain, or move secrets to files: `agentcomms secrets migrate --to file`.' }),
  });
  checks.push({
    name: 'secret backend',
    ok: true,
    detail: config.secrets?.store ?? 'not chosen yet (keychain by default)',
  });
  return { checks, ok: checks.every((c) => c.ok) };
}

/**
 * Every secret reference a configuration owns.
 *
 * Its own function, and exported, because the bug it exists to prevent is an omission — and an omission inside a
 * larger function is invisible until a migration has already deleted the originals. It listed `clients` and
 * `inboxes` and not `accounts`, so migrating a backend would have carried the mail credentials across and left
 * every Slack workspace token on the old one: a total loss for one platform, found on the next call.
 *
 * Deduplicated, because two entries may legitimately share a ref and moving one twice would report it twice.
 */
export function secretRefsOf(config: Config): string[] {
  return [
    ...new Set([
      ...Object.values(config.clients).map((client) => client.secretRef),
      ...Object.values(config.inboxes).map((inbox) => inbox.secretRef),
      ...Object.values(config.accounts).map((account) => account.secretRef),
      APPROVAL_KEY_REF,
    ]),
  ];
}

/** Copies every secret the config references to another backend, verifies each, then records the new backend. */
/** A credential this command put somewhere it did not mean to leave it, and could not take back. */
export interface MigrationLeftover {
  readonly backend: SecretStoreKind;
  readonly ref: string;
}

export interface MigrationResult {
  readonly from: SecretStoreKind;
  readonly to: SecretStoreKind;
  readonly moved: number;
  /** Credentials still sitting in a backend nothing reads from. Empty is the only clean outcome. */
  readonly leftovers: readonly MigrationLeftover[];
}

/**
 * Deletes each reference from `store`, once more on failure, and returns the ones that would not go.
 *
 * A `false` from `delete` means nothing was there, which is the outcome wanted.
 */
async function takeBack(
  store: SecretStore,
  backend: SecretStoreKind,
  refs: readonly string[],
): Promise<MigrationLeftover[]> {
  const leftovers: MigrationLeftover[] = [];
  for (const ref of refs) {
    let gone = false;
    for (let attempt = 0; attempt < 2 && !gone; attempt++) {
      gone = await store.delete(ref).then(
        () => true,
        () => false,
      );
    }
    if (!gone) leftovers.push({ backend, ref });
  }
  return leftovers;
}

/**
 * Copies every credential to another backend, verifies each, switches, then removes the originals.
 *
 * Every copy is tracked **before** it is written, not after. A keychain write can report a timeout and land
 * anyway, so "the write threw" does not mean "nothing was written", and a copy tracked only once `set` returned
 * was a copy nobody would ever clean up. Everything up to and including the switch sits inside one boundary that
 * takes those copies back; and anything that will not go — a copy after a failed switch, an original after a
 * successful one — is **reported**, rather than swallowed by a `catch(() => false)` under a result that said the
 * migration had simply worked.
 *
 * `stores` exists for the tests. The only other backend is the real keychain, and a test must never write to it.
 *
 * Moving out of the keychain is a loosening — the credentials go from the operating system's store to files — so
 * the switch needs `consent` for `secrets.store`, which only the command gets, from a person at a terminal. Without
 * it the switch is refused and the copies are taken back, as for any other failure before the switch.
 */
export async function migrateSecrets(
  core: Core,
  to: SecretStoreKind,
  stores: { source?: SecretStore; target?: SecretStore } = {},
  consent?: LooseningConsent,
): Promise<MigrationResult> {
  /*
   * The whole migration under one lock — reading the configuration included.
   *
   * Two opposite migrations used to interleave: one copied into a backend while the other was cleaning that same
   * backend out, and the credential ended up in neither. Everything this does is a sequence of steps that are
   * each correct alone and wrong in combination, so no finer lock would do. The configuration is read inside
   * the lock as well, so a migration that waited sees the backend the previous one left, rather than the one it
   * saw before it queued.
   */
  return withCredentialsLock(core.paths.configDir, () => migrateUnderLock(core, to, stores, consent));
}

/**
 * One line in the audit log for a credential migration.
 *
 * Machine-wide, so no inbox, as `confirm-clients` records its changes. Where every credential lives is a safety
 * setting, and out of the keychain is a loosening the design says leaves an audit entry.
 */
function recordMigration(
  core: Core,
  migration: string,
  outcome: 'started' | 'ok' | 'failed',
  reason: string,
  options: { durable?: boolean } = {},
): Promise<unknown> {
  return core.audit.append(
    { inboxId: '', operation: 'secrets.migrate', outcome, surface: 'cli', reason, ids: { migration } },
    options,
  );
}

async function migrateUnderLock(
  core: Core,
  to: SecretStoreKind,
  stores: { source?: SecretStore; target?: SecretStore },
  consent: LooseningConsent | undefined,
): Promise<MigrationResult> {
  const config = await core.config.load();
  const from = secretsStoreOf(config);
  if (from === to) return { from, to, moved: 0, leftovers: [] };
  /*
   * Consent is checked again here, under the lock, before any store is opened.
   *
   * The command decides whether to ask from a read made before this lock was taken. If a credential appeared in
   * between, that read said "nothing to loosen" and nobody was asked — and without this, the copy would begin, the
   * keychain would be read, and only the final switch would refuse. The refusal belongs before the first secret moves.
   */
  if (
    classifyChange(config, { ...config, secrets: { store: to } }).loosened.includes('secrets.store') &&
    !consent?.paths.includes('secrets.store')
  ) {
    throw new CommsError(
      'LOOSENING_REFUSED',
      'moving credentials out of the system keychain needs a person to confirm it',
      {
        hint: `Run \`agentcomms secrets migrate --to ${to}\` in a terminal.`,
      },
    );
  }
  const source = stores.source ?? (await core.secrets(from));
  const target =
    stores.target ??
    (await openSecretStore(to, {
      // `paths.secretsDir`, never a path rebuilt from `configDir`. On Windows the two are deliberately different:
      // `resolvePaths` puts the file secret store under `%LOCALAPPDATA%` while config stays in `%APPDATA%`,
      // because the roaming profile is copied between machines by a domain and refresh tokens are exactly what
      // must not travel that way. Rebuilding the path here sent every migrated token into the roaming profile,
      // deleted the originals, and left the runtime — which reads `paths.secretsDir` — finding nothing at all.
      secretsDir: core.paths.secretsDir,
      namespace: keychainNamespace(core.paths.configDir),
    }));
  const refs = secretRefsOf(config);
  const attempted: string[] = [];
  let moved = 0;
  let announced = false;
  // Ties the records of one migration together: two can run one after another, and their lines interleave with
  // anything else in the log.
  const migration = `mg_${randomBytes(8).toString('hex')}`;
  /*
   * How a switched migration ended, recorded under the lock — so nothing can come between it and the record that
   * announced it — and best-effort: the switch is already recorded, durably, and a failure to write this line
   * changes nothing that happened.
   */
  const finished = async (leftovers: MigrationLeftover[]): Promise<MigrationResult> => {
    const left = leftovers.length;
    await recordMigration(
      core,
      migration,
      left === 0 ? 'ok' : 'failed',
      `${from} → ${to}: ${moved} moved${left === 0 ? '' : `, ${left} left behind in a backend nothing reads`}`,
    ).catch(() => undefined);
    return { from, to, moved, leftovers };
  };
  try {
    for (const ref of refs) {
      const value = await source.get(ref);
      if (value === null) continue;
      attempted.push(ref);
      await target.set(ref, value);
      if ((await target.get(ref)) !== value)
        throw new CommsError('CONFIG', `could not verify a migrated secret (${ref})`);
      moved += 1;
    }
    /*
     * Recorded before the switch, and required.
     *
     * Written after it, a failure to append left the migration done and the command reporting failure — and a retry
     * then found the backend already switched and returned early, so the move was never recorded at all. Here, a
     * record that cannot be written stops the migration before anything is switched, and the copies are taken back
     * below; a switch that then fails is recorded as failed. Nothing can be switched without a line saying so.
     */
    await recordMigration(core, migration, 'started', `${from} → ${to}: switching, ${moved} copied`, { durable: true });
    announced = true;
    await core.config.update(
      (current) => {
        // Under the lock, where it holds. See `migrationConflict`.
        const conflict = migrationConflict(current, from, refs);
        if (conflict) throw new CommsError('TRANSIENT', conflict, { hint: 'Nothing was switched. Run it again.' });
        return { ...current, secrets: { store: to } };
      },
      consent ? { consent } : {},
    );
  } catch (error) {
    /*
     * Whether anything was switched is read, not assumed.
     *
     * `ConfigStore.update` writes atomically and releases its lock afterwards, in a `finally`; a release that
     * throws rejects the whole call with the switch already committed. Taking the copies back then would delete
     * the credentials the runtime now reads. So: switched means finish the job; not switched means take the
     * copies back; and a configuration that cannot be read means touch nothing and say so, because either
     * deletion could be the wrong one.
     */
    let switched: boolean | undefined;
    try {
      switched = secretsStoreOf(await core.config.load()) === to;
    } catch {
      switched = undefined;
    }
    if (switched === true) {
      const leftovers = await takeBack(source, from, attempted);
      return finished(leftovers);
    }
    if (switched === undefined) {
      await recordMigration(
        core,
        migration,
        'failed',
        `${from} → ${to}: whether the switch happened could not be confirmed`,
      ).catch(() => undefined);
      const base = error instanceof CommsError ? error : new CommsError('UNEXPECTED', String(error));
      throw new CommsError(base.code, base.message, {
        hint:
          `${base.hint ? `${base.hint} ` : ''}Whether the backend was switched could not be confirmed, so nothing ` +
          `was deleted from either. Run \`agentcomms secrets migrate --to ${to}\` again once the configuration is readable.`,
        details: { unconfirmed: true, copiedToTarget: attempted.map((ref) => ({ backend: to, ref })) },
        cause: error,
      });
    }
    // Not switched, so every copy is a duplicate of a secret still in the source — a live credential in a backend
    // nothing reads from. Take them back, and name any that will not go.
    const leftovers = await takeBack(target, to, attempted);
    // A failure the log already heard about — the switch was announced — or one that left copies behind is recorded.
    // One that stopped before either changed nothing, and says nothing.
    if (announced || leftovers.length > 0) {
      const tail = leftovers.length > 0 ? `, ${leftovers.length} copies left in ${to}` : '';
      await recordMigration(core, migration, 'failed', `${from} → ${to}: not switched${tail}`).catch(() => undefined);
    }
    if (leftovers.length === 0) throw error;
    const base = error instanceof CommsError ? error : new CommsError('UNEXPECTED', String(error));
    throw new CommsError(base.code, base.message, {
      hint: `${base.hint ? `${base.hint} ` : ''}Copies were left in ${to}: ${leftovers.map((l) => l.ref).join(', ')}.`,
      details: { leftovers },
      cause: error,
    });
  }
  // Switched. The originals are now the duplicates, in the backend nothing reads. Only the references that were
  // actually copied have an original to remove — the rest held nothing, and "could not delete nothing" reported a
  // credential left behind that never existed.
  const leftovers = await takeBack(source, from, attempted);
  return finished(leftovers);
}

/**
 * Why a secret-store migration can no longer switch backends, or `null` when it still can.
 *
 * The copy runs outside the config lock, because it can take as long as the keychain takes. So by the time the
 * switch happens, the configuration may not be the one that was copied from: a sign-in may have stored a new
 * credential in the *old* backend, or a removal may have deleted one the copy already duplicated. Switching then
 * points the runtime at a backend missing the new credential, or holding one nothing names.
 *
 * Checked against the configuration read inside the lock: the backend must still be the one copied from, and the
 * set of credentials the configuration names must still be exactly the set that was copied.
 */
export function migrationConflict(
  current: Config,
  from: SecretStoreKind,
  copiedRefs: readonly string[],
): string | null {
  if (secretsStoreOf(current) !== from) return 'the secret store was changed by something else while migrating';
  const now = new Set(secretRefsOf(current));
  const then = new Set(copiedRefs);
  if (now.size !== then.size || [...now].some((ref) => !then.has(ref))) {
    return 'a credential was added or removed while migrating';
  }
  return null;
}

function parse(argv: string[]) {
  return parseArgs({
    args: argv,
    allowPositionals: true,
    strict: true,
    options: {
      json: { type: 'boolean', default: false },
      'no-color': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
      inbox: { type: 'string' },
      since: { type: 'string' },
      limit: { type: 'string' },
      state: { type: 'string' },
      to: { type: 'string' },
      rename: { type: 'string', multiple: true },
      'dry-run': { type: 'boolean', default: false },
      yes: { type: 'boolean', default: false },
    },
  });
}

export async function main(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    const json = argv.includes('--json');
    return writeError(usage(error instanceof Error ? error.message : String(error)), { json, color: false });
  }
  const { values, positionals } = parsed;
  const output: OutputOptions = {
    json: values.json,
    color: colorEnabled(env, process.stdout, values['no-color'] ? false : undefined),
  };
  if (values.version) {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    process.stdout.write(HELP);
    return 0;
  }
  const core = openCore({ env });
  const [command, sub, arg] = positionals;

  return runCommand(output, async () => {
    switch (command) {
      case 'paths':
        writeResult(core.paths, output, (p) =>
          Object.entries(p)
            .map(([k, v]) => `${k.padEnd(13)} ${v}`)
            .join('\n'),
        );
        return;
      case 'doctor': {
        const report = await doctor(core);
        writeResult(report, output, (r) =>
          r.checks
            .map(
              (c) => `${c.ok ? 'ok  ' : 'FAIL'} ${c.name.padEnd(16)} ${c.detail}${c.fix ? `\n     fix: ${c.fix}` : ''}`,
            )
            .join('\n'),
        );
        if (!report.ok)
          throw new CommsError('CONFIG', 'doctor found problems', { hint: 'Apply the fixes listed above.' });
        return;
      }
      case 'audit': {
        if (sub !== 'tail') throw usage('usage: agentcomms audit tail');
        const config = await core.config.load();
        const inboxId = inboxIdFor(config, values.inbox);
        const limit = values.limit ? Number.parseInt(values.limit, 10) : 50;
        if (!Number.isInteger(limit) || limit < 1) throw usage('--limit must be a positive whole number');
        // The inbox filter goes INTO the scan, not after it. `tail` applies it while counting toward `limit`;
        // filtering the returned array instead meant a quiet inbox's history was read as empty whenever a
        // busier one had produced `limit` records since — and raising `--limit` changed the answer, which is
        // the tell. This is the command someone runs to ask what was sent from a mailbox.
        const records = await core.audit.tail({
          limit,
          ...(inboxId ? { inbox: inboxId } : {}),
          ...(values.since ? { since: values.since } : {}),
        });
        writeResult(records, output, (rs) =>
          rs.length
            ? rs
                .map(
                  (r) =>
                    `${r.at}  ${r.alias ?? r.inboxId}  ${r.operation}  ${r.outcome}${r.reason ? `  (${r.reason})` : ''}`,
                )
                .join('\n')
            : 'no audit records',
        );
        return;
      }
      case 'approvals': {
        const config = await core.config.load();
        if (sub === 'list') {
          const inboxId = inboxIdFor(config, values.inbox);
          const states = values.state ? [values.state as never] : undefined;
          const records = (
            await core.approvals.list({ ...(inboxId ? { inboxId } : {}), ...(states ? { states } : {}) })
          ).map(publicView);
          writeResult(records, output, (rs) =>
            rs.length
              ? rs.map((r) => `${r.approvalId}  ${r.state.padEnd(8)}  ${r.policy}  expires ${r.expiresAt}`).join('\n')
              : 'no approvals',
          );
          return;
        }
        if (sub === 'revoke') {
          if (!arg) throw usage('usage: agentcomms approvals revoke <approvalId>');
          const record = publicView(await core.approvals.revoke(arg, 'revoked by the user'));
          writeResult(record, output, (r) => `${r.approvalId} is ${r.state}`);
          return;
        }
        throw usage('usage: agentcomms approvals list|revoke');
      }
      case 'approve': {
        if (!sub || arg !== undefined) throw usage('usage: agentcomms approve <approvalId>');
        const result = await approveChangeAtTerminal(core, sub, env, output);
        writeResult(result, output, (r) =>
          r.state === 'approved'
            ? 'Approved. The agent can make the change now — this command approves; it changes nothing itself.'
            : 'Cancelled. Nothing was changed.',
        );
        return;
      }
      case 'names': {
        if (sub !== 'migrate') {
          throw usage('usage: agentcomms names migrate [--rename <old>=<new>] [--dry-run] [--yes]');
        }
        const plan = planNamesMigration(await core.config.load(), values.rename ?? []);
        if (plan.status === 'already-migrated') {
          writeResult(
            { status: 'already-migrated' as const },
            output,
            () => 'Names are already organisation/platform.',
          );
          return;
        }
        if (values['dry-run']) {
          writeResult(
            { status: 'dry-run' as const, rows: plan.rows, notApplicable: plan.notApplicable },
            output,
            (data) =>
              `${renderMapping(data.rows, data.notApplicable)}\n\nNothing was changed. Run the same command without --dry-run to apply it.`,
          );
          return;
        }
        /*
         * The mapping is shown before anything is written, whoever is running it.
         *
         * `--yes` answers the question; it does not skip showing what was answered. A person who passes it still
         * reads what happened above the result line, and an agent's transcript carries it — which is the only
         * record of what the old names were once the file no longer holds them. It goes to stderr so `--json`
         * keeps its one envelope on stdout.
         */
        defaultStreams.stderr.write(`${renderMapping(plan.rows, plan.notApplicable)}\n`);
        /*
         * A person at a terminal confirms; anything else passes `--yes`.
         *
         * Not a typed challenge: a rename grants nothing and takes nothing away, and the classifier agrees — it
         * matches accounts by their immutable ids, so renaming every key loosens nothing. What this asks for is
         * deliberateness, because the old names stop working the moment it is done.
         */
        if (!values.yes) {
          if (needsYes(env, defaultStreams, { json: values.json })) {
            throw new CommsError('USAGE', 'this would rename every account, so it needs --yes or a terminal', {
              hint: 'See the mapping first with `agentcomms names migrate --dry-run`, then add `--yes`.',
            });
          }
          await confirm(defaultStreams);
        }
        const result = await migrateNames(core.config, plan);
        writeResult(
          { status: result.status, rows: plan.rows, notApplicable: plan.notApplicable, backup: result.backup ?? null },
          output,
          (data) =>
            data.status === 'already-migrated'
              ? 'Names are already organisation/platform.'
              : [
                  `Renamed ${data.rows.length} account(s). The old names no longer work; anything that uses one is told what it is called now.`,
                  ...(data.backup ? [`The configuration as it was is saved at ${data.backup}.`] : []),
                ].join('\n'),
        );
        return;
      }
      case 'secrets': {
        if (sub !== 'migrate' || (values.to !== 'keychain' && values.to !== 'file')) {
          throw usage('usage: agentcomms secrets migrate --to keychain|file');
        }
        /*
         * Out of the keychain is a loosening, and a loosening is a person's to make.
         *
         * `doctor` recommends exactly this command when the keychain is unavailable, and until now it could never
         * work: the switch was refused as unconsented every time, after copying every credential and before taking
         * the copies back. Asked here, before the migration takes its lock — nothing waits for a person while
         * holding one. Into the keychain tightens, and needs nobody; and a configuration with nothing stored yet
         * loosens nothing by choosing files, so it is not asked either — the same judgement `ConfigStore.update`
         * will make, because it is the same function making it.
         */
        const current = await core.config.load();
        const loosens = classifyChange(current, { ...current, secrets: { store: values.to } }).loosened.includes(
          'secrets.store',
        );
        const consent = loosens
          ? await confirmLoosening(env, { json: values.json, color: output.color }, 'secrets.store', {
              prompt: 'This moves every credential out of the system keychain and into files on this disk.',
              command: 'agentcomms secrets migrate --to file',
            })
          : undefined;
        const result = await migrateSecrets(core, values.to, {}, consent);
        /*
         * One document, whichever way it went.
         *
         * Switched but not tidy is reported as an error, not as a success with a footnote — and *instead of* the
         * success result, not after it: `--json` promises exactly one envelope on stdout, and printing a result and
         * then throwing puts two there.
         */
        if (result.leftovers.length > 0) {
          throw new CommsError(
            'CONFIG',
            `moved ${result.moved} secrets from ${result.from} to ${result.to}, but ${result.leftovers.length} original(s) could not be removed from ${result.from}`,
            {
              hint: `The new backend is in use. Delete these references from ${result.from}: ${result.leftovers.map((l) => l.ref).join(', ')}.`,
              details: { ...result },
            },
          );
        }
        writeResult(result, output, (r) =>
          r.moved === 0 && r.from === r.to
            ? `secrets already use ${r.to}`
            : `moved ${r.moved} secrets from ${r.from} to ${r.to}`,
        );
        return;
      }
      default:
        throw usage(`unknown command "${command}"`);
    }
  });
}

/**
 * The mapping, one line per account, old name on the left — then any `--rename` that matched nothing here.
 *
 * Those are listed rather than dropped silently: one mapping is meant to run on every computer, so a source this one
 * lacks is normal, but a misspelt source looks exactly the same, and the account it meant would take its default.
 */
function renderMapping(rows: readonly NamesMigrationRow[], notApplicable: readonly NotApplicableRename[] = []): string {
  const width = Math.max(...rows.map((row) => row.from.length), 0);
  const kind = (row: NamesMigrationRow) => (row.kind === 'inbox' ? 'mailbox  ' : 'workspace');
  return [
    `${rows.length} account(s) will be renamed:`,
    '',
    ...rows.map((row) => `  ${kind(row)}  ${row.from.padEnd(width)}  →  ${row.to}`),
    ...(notApplicable.length > 0
      ? [
          '',
          `Not applicable here — nothing on this computer is called that, so ${notApplicable.length === 1 ? 'this rename changes' : 'these renames change'} nothing:`,
          '',
          ...notApplicable.map((skipped) => `  --rename ${skipped.rename}`),
        ]
      : []),
  ].join('\n');
}

/**
 * Whether this run has to pass `--yes` rather than being asked.
 *
 * An agent is not asked even where it has a terminal: it can answer its own question, so the answer would mean
 * nothing. Exported so the rule can be tested directly — a subprocess test cannot hand the CLI a terminal, and a
 * rule that only ever runs without one is a rule nobody has checked.
 */
/**
 * A person's typed consent to one loosening, or a refusal saying who has to give it.
 *
 * Agents are refused outright — the challenge is a speed bump for a person, never a security boundary, and an agent
 * that can run commands can type an answer — and so is anything with no terminal to ask at.
 */
export async function confirmLoosening(
  env: NodeJS.ProcessEnv,
  output: { json?: boolean | undefined; color?: boolean | undefined },
  path: string,
  ask: { prompt: string; command: string },
  streams: Streams = defaultStreams,
): Promise<LooseningConsent> {
  await requirePerson(env, streams, {
    refusedToAgent: `${ask.prompt.replace(/\.$/, '')} — that is not an agent's to do`,
    refusedWithoutTerminal: 'this loosens how credentials are kept, so it needs a terminal',
    command: ask.command,
    prompt: ask.prompt,
    color: output.color ?? colorEnabled(env, streams.stderr),
    json: output.json,
  });
  return { kind: 'loosening-consent', paths: [path] };
}

export function needsYes(env: NodeJS.ProcessEnv, streams: Streams, options: { json?: boolean }): boolean {
  return agentMarker(env) !== null || !canPrompt(env, streams, options);
}

/**
 * Approves a configuration change at a terminal, the way a person approves a send: read the preview, type the code.
 *
 * Under the `confirm` change policy this is what "a person approved it" means, so it is the one command here an agent
 * may not run for the user, and it is refused by the same gate every other loosening goes through. A shell agent can
 * get past that gate — `script -q /dev/null` makes any command see a terminal — so it is a speed bump against the
 * ordinary case, as it is for every approval, not a boundary.
 *
 * It approves and changes nothing. What prepared the change makes it, by claiming the approval once; and a refusal to
 * even ask is recorded, so the audit trail shows an agent that tried.
 *
 * Exported so the whole command can be tested with streams that are a terminal: a subprocess test cannot have one.
 */
export async function approveChangeAtTerminal(
  core: Core,
  approvalId: string,
  env: NodeJS.ProcessEnv,
  output: { json?: boolean | undefined; color: boolean },
  streams: Streams = defaultStreams,
): Promise<{ approvalId: string; state: 'approved' | 'cancelled' }> {
  try {
    refuseUnlessPerson(env, streams, {
      refusedToAgent: 'only a person can approve a change, not an agent',
      refusedWithoutTerminal: 'approving a change needs an interactive terminal',
      command: `agentcomms approve ${approvalId}`,
      color: output.color,
      json: output.json,
    });
  } catch (error) {
    await recordChangeApprovalRefused(core, approvalId, error, { surface: 'cli' });
    throw error;
  }
  const prompt = await beginChangeApproval(core, approvalId, { surface: 'cli' });
  streams.stdout.write(`${prompt.preview}\n\n`);
  const answer = await ask(
    streams,
    `Type ${paint(output.color, 'bold', prompt.challenge)} to approve this change, or press Enter to cancel: `,
  );
  if (!answer.trim()) {
    await revokeChange(core, approvalId, 'cancelled at the terminal', { surface: 'cli' });
    return { approvalId, state: 'cancelled' };
  }
  await finishChangeApproval(core, approvalId, answer, { surface: 'cli' });
  return { approvalId, state: 'approved' };
}

/** Asks one question at the terminal and returns what was typed. */
async function ask(streams: Streams, question: string): Promise<string> {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({
    input: streams.stdin as NodeJS.ReadableStream,
    output: streams.stderr as NodeJS.WritableStream,
  });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** A plain yes/no, for a change that is deliberate rather than dangerous. */
async function confirm(streams: Streams): Promise<void> {
  const answer = await ask(streams, 'Rename them? [y/N] ');
  if (!/^y(es)?$/i.test(answer.trim())) {
    throw new CommsError('USAGE', 'nothing was renamed');
  }
}

const invokedDirectly =
  process.argv[1] !== undefined && /(?:^|[/\\])(?:cli\.(?:mjs|ts)|agentcomms)$/.test(process.argv[1]);
if (invokedDirectly) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      process.stderr.write(`agentcomms: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 64;
    },
  );
}
