import { randomBytes } from 'node:crypto';
import type { GatedChange } from '../change-flow.ts';
import type { ChangeSurface } from '../changes.ts';
import { type Config, classifyChange, type LooseningConsent, secretsStoreOf } from '../config.ts';
import type { Core } from '../core.ts';
import { CommsError } from '../errors.ts';
import { APPROVAL_KEY_REF } from '../keys.ts';
import { withCredentialsLock } from '../lock.ts';
import { keychainNamespace, openSecretStore, type SecretStore, type SecretStoreKind } from '../secrets.ts';

/**
 * Moving every credential from one secret backend to the other: `agentcomms secrets migrate` and
 * `comms_secrets_migrate`, one operation.
 *
 * It lived inside the CLI, which no library module may import; the core server needed it, so it is here and the CLI
 * calls it too.
 */

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

export interface MigrationOptions {
  /** Where the call came from, for the audit trail. */
  surface?: ChangeSurface | undefined;
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
 * the switch needs `consent` for `secrets.store`, which comes from a change approval (`secretsMigration`). Without
 * it the switch is refused and the copies are taken back, as for any other failure before the switch.
 */
export async function migrateSecrets(
  core: Core,
  to: SecretStoreKind,
  stores: { source?: SecretStore; target?: SecretStore } = {},
  consent?: LooseningConsent,
  options: MigrationOptions = {},
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
  return withCredentialsLock(core.paths.configDir, () =>
    migrateUnderLock(core, to, stores, consent, options.surface ?? 'cli'),
  );
}

/**
 * One line in the audit log for a credential migration.
 *
 * Machine-wide, so no inbox, as `confirm-clients` records its changes. Where every credential lives is a safety
 * setting, and out of the keychain is a loosening the design says leaves an audit entry.
 */
function recordMigration(
  core: Core,
  surface: ChangeSurface,
  migration: string,
  outcome: 'started' | 'ok' | 'failed',
  reason: string,
  options: { durable?: boolean } = {},
): Promise<unknown> {
  return core.audit.append(
    { inboxId: '', operation: 'secrets.migrate', outcome, surface, reason, ids: { migration } },
    options,
  );
}

async function migrateUnderLock(
  core: Core,
  to: SecretStoreKind,
  stores: { source?: SecretStore; target?: SecretStore },
  consent: LooseningConsent | undefined,
  surface: ChangeSurface,
): Promise<MigrationResult> {
  const config = await core.config.load();
  const from = secretsStoreOf(config);
  if (from === to) return { from, to, moved: 0, leftovers: [] };
  /*
   * Consent is checked again here, under the lock, before any store is opened.
   *
   * The caller decides whether to ask from a read made before this lock was taken. If a credential appeared in
   * between, that read said "nothing to loosen" and nobody was asked — and without this, the copy would begin, the
   * keychain would be read, and only the final switch would refuse. The refusal belongs before the first secret moves.
   */
  if (
    classifyChange(config, { ...config, secrets: { store: to } }).loosened.includes('secrets.store') &&
    !consent?.paths.includes('secrets.store')
  ) {
    throw new CommsError(
      'LOOSENING_REFUSED',
      'moving credentials out of the system keychain needs a person to approve it',
      {
        hint: `Run \`agentcomms secrets migrate --to ${to}\`, or call comms_secrets_migrate, and approve the change it shows.`,
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
      surface,
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
    await recordMigration(core, surface, migration, 'started', `${from} → ${to}: switching, ${moved} copied`, {
      durable: true,
    });
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
        surface,
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
      await recordMigration(core, surface, migration, 'failed', `${from} → ${to}: not switched${tail}`).catch(
        () => undefined,
      );
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

const STORE_WORDS: Readonly<Record<SecretStoreKind, string>> = {
  keychain: 'the system keychain',
  file: 'files on this disk',
};

/**
 * The migration as a change a person approves: `agentcomms secrets migrate` and `comms_secrets_migrate` both run it
 * through the change flow.
 *
 * Out of the keychain loosens `secrets.store`, which `classifyChange` already finds. In either direction it also
 * deletes the originals once they are copied, which cannot be taken back, so it is an effect of its own and needs an
 * approval even into the keychain (design §3.1, "destructive"). A configuration that names no credential moves
 * nothing of anybody's, and choosing its backend loosens nothing either — the same judgement `ConfigStore.update`
 * makes — so that is applied at once, as it always was.
 */
export function secretsMigration(
  core: Core,
  to: SecretStoreKind,
  options: { stores?: { source?: SecretStore; target?: SecretStore }; surface: ChangeSurface },
): GatedChange<MigrationResult> {
  return {
    plan: (config) => {
      const from = secretsStoreOf(config);
      const after: Config = from === to ? config : { ...config, secrets: { store: to } };
      // The approval key is this machine's own, and is re-created if it is lost; what a person is asked about is
      // their accounts' credentials.
      const named = secretRefsOf(config).filter((ref) => ref !== APPROVAL_KEY_REF).length;
      const effects =
        from === to || named === 0
          ? []
          : [
              `copies the ${named} credential${named === 1 ? '' : 's'} this configuration names from ${STORE_WORDS[from]} to ${STORE_WORDS[to]}, and then deletes the originals from ${STORE_WORDS[from]}`,
            ];
      return {
        before: config,
        after,
        effects,
        summary: from === to ? `Credentials already use ${STORE_WORDS[to]}` : `Keep credentials in ${STORE_WORDS[to]}`,
      };
    },
    apply: (consent) => migrateSecrets(core, to, options.stores ?? {}, consent, { surface: options.surface }),
  };
}
