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
async function migrateSecrets(
  core: Core,
  to: SecretStoreKind,
): Promise<{ from: SecretStoreKind; to: SecretStoreKind; moved: number }> {
  const config = await core.config.load();
  const from = secretsStoreOf(config);
  if (from === to) return { from, to, moved: 0 };
  const source = await core.secrets(from);
  const target = await openSecretStore(to, {
    // `paths.secretsDir`, never a path rebuilt from `configDir`. On Windows the two are deliberately different:
    // `resolvePaths` puts the file secret store under `%LOCALAPPDATA%` while config stays in `%APPDATA%`, because
    // the roaming profile is copied between machines by a domain and refresh tokens are exactly what must not
    // travel that way. Rebuilding the path here sent every migrated token into the roaming profile, deleted the
    // originals, and left the runtime — which reads `paths.secretsDir` — finding nothing at all.
    secretsDir: core.paths.secretsDir,
    namespace: keychainNamespace(core.paths.configDir),
  });
  const refs = secretRefsOf(config);
  let moved = 0;
  for (const ref of refs) {
    const value = await source.get(ref);
    if (value === null) continue;
    await target.set(ref, value);
    if ((await target.get(ref)) !== value)
      throw new CommsError('CONFIG', `could not verify a migrated secret (${ref})`);
    moved += 1;
  }
  await core.config.update((current) => ({ ...current, secrets: { store: to } }));
  for (const ref of refs) await source.delete(ref).catch(() => false);
  return { from, to, moved };
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
