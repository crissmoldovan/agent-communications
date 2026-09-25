import { access, constants, stat } from 'node:fs/promises';
import { type ApprovalRecord, type ApprovalState, approvalKind, publicView } from '../approvals.ts';
import type { AuditRecord } from '../audit.ts';
import { revokeChange } from '../changes.ts';
import { type Config, emptyConfig, secretsStoreOf } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { isGroupOrWorldAccessible } from '../fs.ts';
import { resolveName } from '../names.ts';
import type { ResolvedPaths } from '../paths.ts';
import { type KeyringModule, keychainNamespace, loadKeyringModule, probeKeychain } from '../secrets.ts';

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
  detail: string;
  fix?: string;
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
}

export async function doctor(core: Core, options: DoctorOptions = {}): Promise<DoctorReport> {
  const checks: DoctorCheck[] = [];
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

  const keyring = options.keyring !== undefined ? options.keyring : await loadKeyringModule();
  // `probeKeychain` loads the real module when handed none, so a machine without it is answered here instead.
  const probe = keyring
    ? await probeKeychain(keyring, keychainNamespace(core.paths.configDir))
    : { ok: false, reason: 'the optional @napi-rs/keyring package is not installed for this platform' };
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
  return core.audit.tail({
    limit,
    ...(inboxId ? { inbox: inboxId } : {}),
    ...(options.since ? { since: options.since } : {}),
  });
}

export const APPROVAL_STATES: readonly ApprovalState[] = Object.freeze([
  'pending',
  'approved',
  'sending',
  'used',
  'failed',
  'unknown',
  'expired',
  'revoked',
]);

export type ApprovalView = Omit<ApprovalRecord, 'challengeHash'>;

export async function listApprovals(
  core: Core,
  options: { inbox?: string | undefined; state?: string | undefined } = {},
): Promise<ApprovalView[]> {
  // A state that does not exist matched nothing, and read as "no approvals" — the one answer that is never a
  // reason to look again.
  if (options.state !== undefined && !(APPROVAL_STATES as readonly string[]).includes(options.state)) {
    throw new CommsError('USAGE', `"${options.state}" is not an approval state`, {
      hint: `One of: ${APPROVAL_STATES.join(', ')}.`,
    });
  }
  const inboxId = inboxIdFor(await core.config.load(), options.inbox);
  const records = await core.approvals.list({
    ...(inboxId ? { inboxId } : {}),
    ...(options.state ? { states: [options.state as ApprovalState] } : {}),
  });
  return records.map(publicView);
}

/**
 * Revokes an approval of either kind. Refusing is never the dangerous direction, so this asks nobody.
 *
 * A change approval is revoked through `revokeChange`, which records it in the audit log as every other step of a
 * change approval is; a send approval as it always was.
 */
export async function revokeApproval(core: Core, approvalId: string, surface: 'cli' | 'mcp'): Promise<ApprovalView> {
  const existing = await core.approvals.get(approvalId);
  const reason = 'revoked by the user';
  const record =
    existing && approvalKind(existing) === 'change'
      ? await revokeChange(core, approvalId, reason, { surface })
      : await core.approvals.revoke(approvalId, reason);
  return publicView(record);
}
