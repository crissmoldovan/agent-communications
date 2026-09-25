import type { GatedChange } from '../change-flow.ts';
import type { Config } from '../config.ts';
import type { Core } from '../core.ts';
import {
  migrateNames,
  type NamesMigrationPlan,
  type NamesMigrationRow,
  type NotApplicableRename,
  planNamesMigration,
} from '../names.ts';

/**
 * Renaming every account to `organisation/platform`: `agentcomms names migrate` and `comms_names_migrate`, one
 * operation. A dry run changes nothing and needs nobody; applying it is a change a person approves.
 */

export type NamesDryRun =
  | { status: 'already-migrated' }
  | { status: 'dry-run'; rows: NamesMigrationRow[]; notApplicable: NotApplicableRename[] };

export type NamesMigrationResult =
  | { status: 'already-migrated' }
  | {
      status: 'migrated' | 'already-migrated';
      rows: NamesMigrationRow[];
      notApplicable: NotApplicableRename[];
      backup: string | null;
    };

/** What the migration would do, from the configuration as it is: the mapping, and the renames that match nothing. */
export function namesDryRun(config: Config, renames: readonly string[] = []): NamesDryRun {
  const plan = planNamesMigration(config, renames);
  if (plan.status === 'already-migrated') return { status: 'already-migrated' };
  return { status: 'dry-run', rows: plan.rows, notApplicable: plan.notApplicable };
}

const kindWord = (row: NamesMigrationRow) => (row.kind === 'inbox' ? 'mailbox' : 'workspace');

/**
 * The migration as a change: every rename is one effect, so the approval is bound to exactly this mapping.
 *
 * It loosens nothing — the classifier matches accounts by their immutable ids, so renaming every key grants nothing —
 * but the old names stop working the moment it is done, which is why the design lists it with the changes that cannot
 * be taken back (§3.1). A mapping that differs when it is claimed — a `--rename` left off the second call, an account
 * added in between — is a different list of effects, and the claim refuses it.
 *
 * The plan is made again from the configuration on every call, and the one the approval was claimed against is the
 * one applied: `migrateNames` then refuses it too if the file moves before its locks are taken.
 */
export function namesMigration(core: Core, renames: readonly string[] = []): GatedChange<NamesMigrationResult> {
  let planned: NamesMigrationPlan | undefined;
  return {
    plan: (config) => {
      planned = planNamesMigration(config, renames);
      if (planned.status === 'already-migrated') {
        return { before: config, after: config, summary: 'Names are already organisation/platform' };
      }
      const { rows, notApplicable } = planned;
      return {
        before: config,
        after: config,
        effects: [
          ...rows.map((row) => `renames ${kindWord(row)} "${row.from}" to "${row.to}"`),
          ...(notApplicable.length > 0
            ? [
                `leaves out ${notApplicable.map((skipped) => `--rename ${skipped.rename}`).join(', ')}, which name${notApplicable.length === 1 ? 's' : ''} nothing on this computer`,
              ]
            : []),
          'the old names stop working; anything that uses one is told what it is called now',
          'saves the configuration as it was beside it first',
        ],
        summary: `Rename ${rows.length} account${rows.length === 1 ? '' : 's'} to organisation/platform names`,
      };
    },
    apply: async () => {
      if (!planned || planned.status === 'already-migrated') return { status: 'already-migrated' as const };
      const result = await migrateNames(core.config, planned);
      return {
        status: result.status,
        rows: planned.rows,
        notApplicable: planned.notApplicable,
        backup: result.backup ?? null,
      };
    },
  };
}
