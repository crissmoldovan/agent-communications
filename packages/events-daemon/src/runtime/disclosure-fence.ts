import type { DatabaseSync } from 'node:sqlite';
import {
  type ApprovalStore,
  CommsError,
  type ConfigStore,
  canonicalJson,
  type DisclosureBinding,
  sha256Hex,
} from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  activationDocumentDigest,
  type CanonicalFullRuleDocument,
  disclosureBindingFor,
  normaliseActivationDocument,
} from '../domain/activation-documents.ts';
import { classifySourceOptionChange } from '../domain/source-options.ts';
import { assertLiveEventAccount } from './account-fence.ts';

/** Every plaintext boundary declares itself so the one resolver covers source, evaluation, every webhook byte gate and terminal read. */
export type DisclosureBoundary =
  | 'activation'
  | 'recovery'
  | 'source'
  | 'evaluation'
  | 'dispatch'
  | 'webhook-dns'
  | 'webhook-tcp'
  | 'webhook-tls'
  | 'webhook-write'
  | 'read';

interface FenceCommon {
  readonly database: DatabaseSync;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly accountId: string;
  readonly boundary: DisclosureBoundary;
}

/** A live-work check after an exact or derived version has become effective. */
export interface ActiveDisclosableRequest extends FenceCommon {
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId?: string | undefined;
  readonly targetVersion?: number | undefined;
  readonly switchGeneration: number;
}

/** A claimed intent is the sole disabled-state exception: it may acquire only its already planned baseline. */
export interface RecoveryDisclosableRequest extends FenceCommon {
  readonly activationIntentId: string;
}

export type DisclosableRequest = ActiveDisclosableRequest | RecoveryDisclosableRequest;

export interface DisclosureSnapshot {
  readonly approvalId: string;
  readonly authorizationActivationId: string;
  readonly usedAt: string;
  readonly switchGeneration: number;
}

interface RuleRow {
  readonly id: string;
  readonly rule_id: string;
  readonly version: number;
  readonly document: string;
  readonly digest: string;
  readonly state: string | null;
  readonly approval_id: string | null;
  readonly authorization_activation_id: string | null;
  readonly revoked_at: number | null;
}

interface IntentRow {
  readonly id: string;
  readonly document: string;
  readonly digest: string;
  readonly kind: string;
  readonly approval_id: string | null;
  readonly status: string;
  readonly effect: string;
  readonly required_points: string;
  readonly replacement_of_version: string | null;
}

function refuse(reason: string, message: string): never {
  throw new CommsError('APPROVAL_VOID', message, { details: { reason } });
}

function sameJson(left: unknown, right: unknown): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function settings(database: DatabaseSync): { enabled: boolean; generation: number } {
  const row = database.prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1').get() as
    | { enabled: number; switch_generation: number }
    | undefined;
  if (!row) return refuse('SETTINGS_MISSING', 'the event switch is not available');
  return { enabled: row.enabled === 1, generation: row.switch_generation };
}

function intent(database: DatabaseSync, id: string): IntentRow {
  const row = database
    .prepare(
      'SELECT id, document, digest, kind, approval_id, status, effect, required_points, replacement_of_version FROM activation_intents WHERE id = ?',
    )
    .get(id) as IntentRow | undefined;
  if (!row) return refuse('ACTIVATION_LINEAGE_MISSING', 'the immutable activation record is missing');
  return row;
}

async function usedBinding(
  approvals: Pick<ApprovalStore, 'get'>,
  intentRow: IntentRow,
): Promise<{
  readonly document: ActivationDocumentV1;
  readonly binding: DisclosureBinding;
  readonly approvalId: string;
  readonly usedAt: string;
}> {
  if (!intentRow.approval_id)
    return refuse('ACTIVATION_LINEAGE_MISSING', 'the activation has no attached disclosure approval');
  let document: ActivationDocumentV1;
  try {
    document = normaliseActivationDocument(JSON.parse(intentRow.document));
  } catch {
    return refuse('ACTIVATION_DOCUMENT_INVALID', 'the immutable activation document is not valid');
  }
  const binding = disclosureBindingFor(intentRow.id, document);
  if (
    document.kind !== intentRow.kind ||
    binding.digest !== intentRow.digest ||
    activationDocumentDigest(document) !== intentRow.digest
  ) {
    return refuse('ACTIVATION_DIGEST_DRIFT', 'the immutable activation document does not match its digest');
  }
  const approval = await approvals.get(intentRow.approval_id);
  if (approval?.form !== 'v2' || approval.record.kind !== 'disclosure' || approval.record.state !== 'used') {
    return refuse('DISCLOSURE_NOT_USED', 'the standing disclosure approval is not used');
  }
  if (approval.record.usedAt === undefined || !sameJson(approval.record.disclosure, binding)) {
    return refuse('DISCLOSURE_BINDING_DRIFT', 'the used disclosure record no longer matches its activation');
  }
  return { document, binding, approvalId: intentRow.approval_id, usedAt: approval.record.usedAt };
}

function storedDocument(
  database: DatabaseSync,
  table: 'rule_versions' | 'target_versions' | 'subscriber_versions' | 'judge_versions',
  column: 'rule_id' | 'target_id' | 'subscriber_id' | 'judge_id',
  id: string,
  version: number,
  embedded: unknown,
  revocable: boolean,
): void {
  const row = database
    .prepare(`SELECT document, digest, revoked_at FROM ${table} WHERE ${column} = ? AND version = ?`)
    .get(id, version) as { document: string; digest: string; revoked_at: number | null } | undefined;
  if (!row || row.document !== canonicalJson(embedded) || sha256Hex(row.document) !== row.digest) {
    refuse('IMMUTABLE_VERSION_DRIFT', 'a named immutable version no longer matches its stored digest');
  }
  if (!revocable) return;
  const revoked = database
    .prepare('SELECT 1 AS present FROM object_revocations WHERE kind = ? AND object_id = ? AND version = ?')
    .get(table === 'target_versions' ? 'target' : 'judge', id, version);
  if (row.revoked_at !== null || revoked !== undefined)
    refuse('BOUND_OBJECT_REVOKED', 'a version bound into this authorisation has been revoked');
}

function verifyRuleVersions(database: DatabaseSync, rule: CanonicalFullRuleDocument): void {
  storedDocument(database, 'rule_versions', 'rule_id', rule.ruleId, rule.version, rule, false);
  for (const target of rule.targets)
    storedDocument(database, 'target_versions', 'target_id', target.targetId, target.version, target, true);
  for (const subscriber of rule.subscribers)
    storedDocument(
      database,
      'subscriber_versions',
      'subscriber_id',
      subscriber.subscriberId,
      subscriber.version,
      subscriber,
      false,
    );
  for (const judge of rule.judges)
    storedDocument(database, 'judge_versions', 'judge_id', judge.judgeId, judge.version, judge, true);
}

function versionRow(database: DatabaseSync, ruleId: string, version: number): RuleRow {
  const row = database
    .prepare(
      `SELECT id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, revoked_at FROM rule_versions WHERE rule_id = ? AND version = ?`,
    )
    .get(ruleId, version) as RuleRow | undefined;
  if (!row || row.revoked_at !== null || row.state === 'revoked')
    return refuse('RULE_REVOKED', 'the exact rule version is no longer authorised');
  if (!['active', 'superseded'].includes(row.state ?? ''))
    return refuse('RULE_LIFECYCLE', 'the exact rule version is not active or retained superseded work');
  return row;
}

function ruleDocument(row: RuleRow): CanonicalFullRuleDocument {
  let rule: CanonicalFullRuleDocument;
  try {
    const document = normaliseActivationDocument({ documentVersion: 1, kind: 'rule', rule: JSON.parse(row.document) });
    if (document.kind !== 'rule')
      return refuse('IMMUTABLE_VERSION_DRIFT', 'the exact rule version is not a rule document');
    rule = document.rule;
  } catch {
    return refuse('IMMUTABLE_VERSION_DRIFT', 'the exact rule version is not a canonical document');
  }
  if (sha256Hex(row.document) !== row.digest)
    return refuse('IMMUTABLE_VERSION_DRIFT', 'the exact rule version digest is invalid');
  return rule;
}

function completedIntent(database: DatabaseSync, row: RuleRow): IntentRow | null {
  if (!row.authorization_activation_id || !row.approval_id) return null;
  const activation = database
    .prepare(
      'SELECT id, document, digest, kind, approval_id, status, effect, required_points, replacement_of_version FROM activation_intents WHERE id = ?',
    )
    .get(row.authorization_activation_id) as IntentRow | undefined;
  if (!activation) return null;
  if (activation.approval_id !== row.approval_id || activation.status !== 'completed')
    return refuse('ACTIVATION_LINEAGE_MISSING', 'the rule does not match its completed activation');
  return activation;
}

type RuleField = 'targets' | 'mapping' | 'deliveryRateCap' | 'retention' | 'source';

/** The rule without its version and the one field an edge may change: everything else must be byte-identical. */
function restOf(rule: CanonicalFullRuleDocument, field: RuleField): string {
  const { version: _version, [field]: _changed, ...rest } = rule;
  return canonicalJson(rest);
}

function isMappingObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !Object.hasOwn(value, '$path');
}

/**
 * How many output fields `child` removes from `parent`, or null when it changes anything else. Only a property of an
 * output object may go; a `$path` reference, a constant and an array position stay exactly as they were.
 */
function removedOutputFields(parent: unknown, child: unknown): number | null {
  if (sameJson(parent, child)) return 0;
  if (!isMappingObject(parent) || !isMappingObject(child)) return null;
  let removed = 0;
  for (const key of Object.keys(parent)) if (!Object.hasOwn(child, key)) removed += 1;
  for (const key of Object.keys(child)) {
    if (!Object.hasOwn(parent, key)) return null;
    const nested = removedOutputFields(parent[key], child[key]);
    if (nested === null) return null;
    removed += nested;
  }
  return removed;
}

/** Whether `child` keeps `parent`'s targets in order, minus at least one, and adds or changes none. */
function removesTargets(parent: CanonicalFullRuleDocument, child: CanonicalFullRuleDocument): boolean {
  if (child.targets.length >= parent.targets.length) return false;
  let at = 0;
  for (const target of child.targets) {
    while (at < parent.targets.length && !sameJson(parent.targets[at], target)) at += 1;
    if (at === parent.targets.length) return false;
    at += 1;
  }
  return true;
}

/**
 * D2's whitelist of no-approval tightenings, checked mechanically: an edge of each kind changes exactly its own field,
 * strictly narrower, and leaves every other part of the rule byte-identical. Anything else needs a fresh approval.
 */
export function isWhitelistedTightening(
  parent: CanonicalFullRuleDocument,
  child: CanonicalFullRuleDocument,
  editKind: string,
): boolean {
  if (parent.ruleId !== child.ruleId || child.version <= parent.version) return false;
  switch (editKind) {
    case 'remove-target':
      return restOf(parent, 'targets') === restOf(child, 'targets') && removesTargets(parent, child);
    case 'remove-output-field': {
      const removed = removedOutputFields(parent.mapping, child.mapping);
      return restOf(parent, 'mapping') === restOf(child, 'mapping') && removed !== null && removed > 0;
    }
    case 'lower-rate-cap':
      return (
        restOf(parent, 'deliveryRateCap') === restOf(child, 'deliveryRateCap') &&
        child.deliveryRateCap < parent.deliveryRateCap
      );
    case 'shorten-retention': {
      const keys = Object.keys(parent.retention) as (keyof typeof parent.retention)[];
      return (
        restOf(parent, 'retention') === restOf(child, 'retention') &&
        sameJson(Object.keys(child.retention).sort(), [...keys].sort()) &&
        keys.every((key) => child.retention[key] <= parent.retention[key]) &&
        keys.some((key) => child.retention[key] < parent.retention[key])
      );
    }
    case 'narrow-source-options':
      return (
        restOf(parent, 'source') === restOf(child, 'source') &&
        parent.source.channel === child.source.channel &&
        sameJson(parent.source.accountIds, child.source.accountIds) &&
        classifySourceOptionChange(parent.source.options, child.source.options) === 'tightening'
      );
    default:
      return false;
  }
}

async function resolveLineage(
  database: DatabaseSync,
  approvals: Pick<ApprovalStore, 'get'>,
  initial: RuleRow,
): Promise<{
  readonly root: IntentRow;
  readonly approvalId: string;
  readonly usedAt: string;
  readonly rule: CanonicalFullRuleDocument;
}> {
  const rule = ruleDocument(initial);
  verifyRuleVersions(database, rule);
  const direct = completedIntent(database, initial);
  if (direct) {
    const used = await usedBinding(approvals, direct);
    if (used.document.kind !== 'rule' || !sameJson(used.document.rule, rule))
      return refuse('ACTIVATION_LINEAGE_MISMATCH', 'the activation does not name this exact rule version');
    return { root: direct, approvalId: used.approvalId, usedAt: used.usedAt, rule };
  }
  if (!initial.approval_id || !initial.authorization_activation_id)
    return refuse('RULE_LINEAGE_MISSING', 'the rule version has no immutable disclosure lineage');
  const visited = new Set<string>();
  let child = initial;
  let childRule = rule;
  for (;;) {
    if (visited.has(child.id)) return refuse('DERIVATION_CYCLE', 'the rule derivation lineage contains a cycle');
    visited.add(child.id);
    // D2: a derived version is its own authorisation-activation id, and carries the root approval unchanged.
    if (child.authorization_activation_id !== child.id || child.approval_id !== initial.approval_id)
      return refuse(
        'DERIVATION_EDGE_INVALID',
        'a derived rule version does not carry its own lineage id and root approval',
      );
    const edge = database
      .prepare(
        'SELECT parent_approval_id, parent_version_id, edit_kind FROM derived_authorizations WHERE version_id = ?',
      )
      .get(child.id) as { parent_approval_id: string; parent_version_id: string; edit_kind: string } | undefined;
    if (!edge || edge.parent_approval_id !== initial.approval_id)
      return refuse('DERIVATION_EDGE_INVALID', 'the rule derivation edge is missing or has the wrong approval');
    const parent = database
      .prepare(
        'SELECT id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, revoked_at FROM rule_versions WHERE id = ?',
      )
      .get(edge.parent_version_id) as RuleRow | undefined;
    if (!parent || parent.rule_id !== initial.rule_id || parent.version >= child.version)
      return refuse('DERIVATION_PARENT_INVALID', 'the rule derivation edge names an invalid parent version');
    const parentRule = ruleDocument(parent);
    verifyRuleVersions(database, parentRule);
    if (!isWhitelistedTightening(parentRule, childRule, edge.edit_kind))
      return refuse('DERIVATION_NOT_TIGHTENING', 'the rule derivation is not an allowed narrowing');
    const root = completedIntent(database, parent);
    if (root) {
      const used = await usedBinding(approvals, root);
      if (
        used.approvalId !== initial.approval_id ||
        used.document.kind !== 'rule' ||
        !sameJson(used.document.rule, parentRule)
      )
        return refuse('DERIVATION_ROOT_INVALID', 'the rule derivation does not terminate at its used approval');
      return { root, approvalId: used.approvalId, usedAt: used.usedAt, rule };
    }
    child = parent;
    childRule = parentRule;
  }
}

/** The one live disclosure fence; all branches re-read SQLite, core approval state and configuration at this boundary. */
export async function assertDisclosable(request: DisclosableRequest): Promise<DisclosureSnapshot> {
  const live = settings(request.database);
  if ('activationIntentId' in request) {
    const pending = intent(request.database, request.activationIntentId);
    if (!['pending', 'pending-completion'].includes(pending.status))
      return refuse('ACTIVATION_NOT_RESUMABLE', 'the activation is no longer pending completion');
    const used = await usedBinding(request.approvals, pending);
    const plannedSources = (() => {
      try {
        // A point written before Phase D carries no source; B1's only source was Gmail, so that is what it means.
        const points = JSON.parse(pending.required_points) as Array<{ accountId?: unknown; source?: unknown }>;
        return [
          ...new Set(
            points
              .filter((point) => point.accountId === request.accountId)
              .map((point) => (point.source === undefined ? 'gmail' : point.source)),
          ),
        ];
      } catch {
        return [];
      }
    })();
    const accountIsPlanned = plannedSources.length > 0;
    const effect = JSON.parse(pending.effect) as { switchGeneration?: unknown };
    if (effect.switchGeneration !== live.generation || !accountIsPlanned)
      return refuse('STALE_GENERATION', 'the activation is no longer at its prepared global generation');
    if (used.document.kind === 'rule') {
      if (!used.document.rule.source.accountIds.includes(request.accountId)) {
        if (!pending.replacement_of_version)
          return refuse('ACCOUNT_NOT_BOUND', 'the account is not bound into this exact rule version');
        const old = request.database
          .prepare(
            `SELECT id, rule_id, version, document, digest, state, approval_id, authorization_activation_id, revoked_at
             FROM rule_versions WHERE id = ?`,
          )
          .get(pending.replacement_of_version) as RuleRow | undefined;
        if (old?.state !== 'active' || old.revoked_at !== null)
          return refuse('REPLACEMENT_PARENT_INVALID', 'the old replacement rule is no longer eligible to drain');
        const oldLineage = await resolveLineage(request.database, request.approvals, old);
        if (!oldLineage.rule.source.accountIds.includes(request.accountId))
          return refuse('ACCOUNT_NOT_BOUND', 'the account is not bound into the old replacement rule');
      }
      verifyRuleVersions(request.database, used.document.rule);
    } else if (used.document.kind === 'enable-all') {
      // Each rule enable-all names must still be a live version whose own lineage ends at its own used approval.
      for (const entry of used.document.ruleVersions) {
        await resolveLineage(
          request.database,
          request.approvals,
          versionRow(request.database, entry.ruleId, entry.ruleVersion),
        );
      }
    } else {
      return refuse('ACTIVATION_KIND_UNSUPPORTED', 'this activation has no Gmail baseline');
    }
    if (used.document.kind === 'rule') {
      await assertLiveEventAccount(request.config, {
        source: used.document.rule.source.channel,
        accountId: request.accountId,
      });
    } else {
      // Enable-all spans every registered source: the account is live for each source its planned points name.
      for (const source of plannedSources) {
        if (source !== 'gmail' && source !== 'slack' && source !== 'resend' && source !== 'whatsapp')
          return refuse('ACCOUNT_NOT_BOUND', 'the planned activation point names an unknown source');
        await assertLiveEventAccount(request.config, { source, accountId: request.accountId });
      }
    }
    return {
      approvalId: used.approvalId,
      authorizationActivationId: pending.id,
      usedAt: used.usedAt,
      switchGeneration: live.generation,
    };
  }
  if (!live.enabled || live.generation !== request.switchGeneration)
    return refuse('STALE_GENERATION', 'the event switch is not enabled at this work generation');
  const row = versionRow(request.database, request.ruleId, request.ruleVersion);
  const lineage = await resolveLineage(request.database, request.approvals, row);
  if (!lineage.rule.source.accountIds.includes(request.accountId))
    return refuse('ACCOUNT_NOT_BOUND', 'the account is not bound into this exact rule version');
  if ((request.targetId === undefined) !== (request.targetVersion === undefined))
    return refuse('BOUND_OBJECT_REVOKED', 'a disclosure target boundary needs its exact id and version');
  if (
    request.targetId !== undefined &&
    !lineage.rule.targets.some(
      (target) => target.targetId === request.targetId && target.version === request.targetVersion,
    )
  )
    return refuse('BOUND_OBJECT_REVOKED', 'the exact target version is not bound into this rule');
  await assertLiveEventAccount(request.config, {
    source: lineage.rule.source.channel,
    accountId: request.accountId,
  });
  return {
    approvalId: lineage.approvalId,
    authorizationActivationId: lineage.root.id,
    usedAt: lineage.usedAt,
    switchGeneration: live.generation,
  };
}
