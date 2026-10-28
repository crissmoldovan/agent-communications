import type { DatabaseSync } from 'node:sqlite';
import { canonicalFullRuleDocument } from '../domain/activation-documents.ts';
import { openQueueItemCount } from './queue-retention.ts';
import { type TighteningKind, tighteningKind } from './replacements.ts';

/** What enabling a stored, still-inert rule version will do at once, when it narrows the active one (Q6). */
export interface TighteningPreview {
  readonly editKind: TighteningKind;
  /** A tightening needs no approval: it applies, and revokes the active version, when this version is enabled. */
  readonly appliesWhen: 'rule enable';
  /** The active version's open queue items, which its revocation removes with it (D2's rules are unchanged). */
  readonly openQueueItemsRemoved: number;
  readonly notice?: string;
}

/**
 * The tightening's preview (action queue design Q6): before the person enables a tighter version, its create or update
 * result says how many open queue items under this rule enabling it will remove. A version that is not a whitelisted
 * tightening of the active one has no preview here; it waits for its own approval and removes nothing.
 */
export function tighteningPreviewFor(
  database: DatabaseSync,
  child: Readonly<Record<string, unknown>>,
): TighteningPreview | undefined {
  const document = canonicalFullRuleDocument(child);
  const active = database
    .prepare(
      `SELECT rule.version, rule.document
         FROM active_versions JOIN rule_versions AS rule
           ON rule.rule_id = active_versions.object_id AND rule.version = active_versions.version
        WHERE active_versions.kind = 'rule' AND active_versions.object_id = ?`,
    )
    .get(document.ruleId) as { version: number; document: string } | undefined;
  if (active === undefined) return undefined;
  const editKind = tighteningKind(canonicalFullRuleDocument(JSON.parse(active.document)), document);
  if (editKind === null) return undefined;
  const open = openQueueItemCount(database, { ruleId: document.ruleId, ruleVersions: [active.version] });
  return {
    editKind,
    appliesWhen: 'rule enable',
    openQueueItemsRemoved: open,
    ...(open === 0
      ? {}
      : { notice: `${open} open queue item${open === 1 ? '' : 's'} under this workflow will be removed` }),
  };
}
