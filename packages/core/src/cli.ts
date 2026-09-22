#!/usr/bin/env node
import { access, constants, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { publicView } from './approvals.ts';
import { colorEnabled, type OutputOptions, runCommand, writeError, writeResult } from './cli-runtime.ts';
import { type Config, emptyConfig, secretsStoreOf } from './config.ts';
import { type Core, openCore } from './core.ts';
import { CommsError } from './errors.ts';
import { isGroupOrWorldAccessible } from './fs.ts';
import { APPROVAL_KEY_REF } from './keys.ts';
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
  agentcomms secrets migrate --to keychain|file

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
  const inbox = config.inboxes[alias];
  if (!inbox) throw new CommsError('NOT_FOUND', `no inbox called "${alias}"`);
  return inbox.id;
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
  try {
    config = await core.config.load();
    const exists = await stat(core.config.path).then(
      () => true,
      () => false,
    );
    checks.push({ name: 'config', ok: true, detail: exists ? core.config.path : 'no config yet' });
  } catch (error) {
    checks.push({
      name: 'config',
      ok: false,
      detail: error instanceof Error ? error.message : String(error),
      fix: 'Fix or restore config.json.',
    });
  }

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
 */
export async function migrateSecrets(
  core: Core,
  to: SecretStoreKind,
  stores: { source?: SecretStore; target?: SecretStore } = {},
): Promise<MigrationResult> {
  const config = await core.config.load();
  const from = secretsStoreOf(config);
  if (from === to) return { from, to, moved: 0, leftovers: [] };
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
    await core.config.update((current) => {
      // Under the lock, where it holds. See `migrationConflict`.
      const conflict = migrationConflict(current, from, refs);
      if (conflict) throw new CommsError('TRANSIENT', conflict, { hint: 'Nothing was switched. Run it again.' });
      return { ...current, secrets: { store: to } };
    });
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
      return { from, to, moved, leftovers };
    }
    if (switched === undefined) {
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
  return { from, to, moved, leftovers };
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
      case 'secrets': {
        if (sub !== 'migrate' || (values.to !== 'keychain' && values.to !== 'file')) {
          throw usage('usage: agentcomms secrets migrate --to keychain|file');
        }
        const result = await migrateSecrets(core, values.to);
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
