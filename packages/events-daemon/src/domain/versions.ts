import type { DatabaseSync } from 'node:sqlite';
import { canonicalJson, sha256Hex } from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  type CanonicalFullRuleDocument,
  canonicalFullRuleDocument,
  canonicalSubscriber,
  canonicalTarget,
  normaliseActivationDocument,
  type SubscriberDocument,
  type TargetDocument,
} from './activation-documents.ts';
import {
  type CanonicalJudgeBudgetDocument,
  type CanonicalJudgeDocument,
  type CanonicalJudgeKindEnablementDocument,
  canonicalJudge,
  canonicalJudgeBudget,
  canonicalJudgeKindEnablement,
  judgeKindDefinition,
} from './judges.ts';
import { assertJudgeKindEnabled, EventDomainError, isJudgeKind } from './lifecycle.ts';

export type ActiveVersionKind = 'rule' | 'judge-budget' | 'judge-kind';

export interface PendingVersion {
  readonly id: string;
  readonly kind: 'rule' | 'target' | 'subscriber' | 'judge' | 'judge-budget' | 'judge-kind';
  readonly objectId: string;
  readonly version: number;
  readonly document: Record<string, unknown>;
  readonly digest: string;
  readonly state: null;
}

function versionId(objectId: string, version: number): string {
  return `${objectId}@${version}`;
}

function documentRecord(value: unknown): Record<string, unknown> {
  return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
}

/** SQLite repository for D2's immutable, initially inert version rows. */
export class ImmutableVersions {
  readonly #database: DatabaseSync;

  constructor(database: DatabaseSync) {
    this.#database = database;
  }

  createRule(input: unknown): PendingVersion {
    const document = canonicalFullRuleDocument(input);
    this.assertEmbeddedVersions(document);
    return this.insert('rule_versions', 'rule', document.ruleId, document.version, document);
  }

  createTarget(input: unknown): PendingVersion {
    const document = canonicalTarget(input);
    if (document.kind === 'webhook' && document.url.kind === 'secret') {
      throw new EventDomainError(
        'VERSION_DOCUMENT_INVALID',
        'a secret webhook URL is completed only by the internal human-secret factory',
      );
    }
    return this.insertTarget(document);
  }

  /** Internal B2 factory seam for a version whose complete URL is written only through the secret store. */
  createInternalTarget(input: unknown): PendingVersion {
    return this.insertTarget(canonicalTarget(input));
  }

  private insertTarget(document: TargetDocument): PendingVersion {
    return this.insert('target_versions', 'target', document.targetId, document.version, document);
  }

  createSubscriber(input: SubscriberDocument): PendingVersion {
    const document = canonicalSubscriber(input);
    return this.insert('subscriber_versions', 'subscriber', document.subscriberId, document.version, document);
  }

  /** Validates a dormant judge version; this deliberately does not require an enabled kind. */
  prepareJudge(input: unknown): CanonicalJudgeDocument {
    return canonicalJudge(input);
  }

  createJudge(input: unknown): PendingVersion {
    const document = this.prepareJudge(input);
    return this.insert('judge_versions', 'judge', document.judgeId, document.version, document);
  }

  prepareBudget(input: unknown): CanonicalJudgeBudgetDocument {
    return canonicalJudgeBudget(input);
  }

  /** The sole digest-verifying loader for an immutable budget document. */
  loadJudgeBudget(version: number): CanonicalJudgeBudgetDocument {
    const row = this.#database
      .prepare('SELECT document, digest FROM judge_budget_versions WHERE version = ? AND revoked_at IS NULL')
      .get(version) as { document: string; digest: string } | undefined;
    if (row === undefined)
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the requested judge budget version does not exist');
    let budget: CanonicalJudgeBudgetDocument;
    try {
      budget = canonicalJudgeBudget(JSON.parse(row.document));
    } catch {
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the stored judge budget document is invalid');
    }
    if (sha256Hex(canonicalJson(budget)) !== row.digest)
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the stored judge budget document digest has drifted');
    return budget;
  }

  /** Loads the sole immutable budget document; callers derive its singleton identity rather than accepting one. */
  prepareJudgeBudget(version: number): Extract<ActivationDocumentV1, { kind: 'judge-budget' }> {
    const budget = this.loadJudgeBudget(version);
    return {
      documentVersion: 1,
      kind: 'judge-budget',
      budget,
    };
  }

  createJudgeBudget(input: unknown): PendingVersion {
    const document = this.prepareBudget(input);
    return this.insert('judge_budget_versions', 'judge-budget', document.budgetId, document.version, document);
  }

  prepareJudgeKindDocument(input: unknown): CanonicalJudgeKindEnablementDocument {
    return canonicalJudgeKindEnablement(input);
  }

  /** The sole digest-verifying loader for an immutable kind enablement document. */
  loadJudgeKind(kind: string, version: number): CanonicalJudgeKindEnablementDocument {
    if (isJudgeKind(kind) && judgeKindDefinition(kind).availability === 'unavailable')
      throw new EventDomainError('E2_REQUIRED', 'laya is unavailable until E2');
    const row = this.#database
      .prepare('SELECT document, digest FROM judge_kind_versions WHERE kind = ? AND version = ? AND revoked_at IS NULL')
      .get(kind, version) as { document: string; digest: string } | undefined;
    if (row === undefined)
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the requested judge kind version does not exist');
    let enablement: CanonicalJudgeKindEnablementDocument;
    try {
      enablement = canonicalJudgeKindEnablement(JSON.parse(row.document));
    } catch {
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the stored judge kind document is invalid');
    }
    if (sha256Hex(canonicalJson(enablement)) !== row.digest)
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the stored judge kind document digest has drifted');
    return enablement;
  }

  /** Loads one exact immutable kind enablement document, never inferring a default enabled state. */
  prepareJudgeKind(kind: string, version: number): Extract<ActivationDocumentV1, { kind: 'judge-kind' }> {
    const enablement = this.loadJudgeKind(kind, version);
    return {
      documentVersion: 1,
      kind: 'judge-kind',
      enablement,
    };
  }

  createJudgeKind(input: unknown): PendingVersion {
    const document = this.prepareJudgeKindDocument(input);
    return this.insert('judge_kind_versions', 'judge-kind', document.kind, document.version, document);
  }

  activeVersion(
    kind: ActiveVersionKind,
    objectId: string,
  ): { readonly version: number; readonly currentCutoverId: string | null } | null {
    const row = this.#database
      .prepare('SELECT version, current_cutover_id FROM active_versions WHERE kind = ? AND object_id = ?')
      .get(kind, objectId) as { version: number; current_cutover_id: string | null } | undefined;
    return row === undefined ? null : { version: row.version, currentCutoverId: row.current_cutover_id };
  }

  /** Plans a rule's exact activation authority without creating a pointer or provider side effect. */
  prepareRule(ruleId: string, version: number): Extract<ActivationDocumentV1, { kind: 'rule' }> {
    const row = this.#database
      .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
      .get(ruleId, version) as { document: string } | undefined;
    if (row === undefined)
      throw new EventDomainError('VERSION_DOCUMENT_INVALID', 'the requested rule version does not exist');
    const rule = canonicalFullRuleDocument(JSON.parse(row.document));
    this.assertEmbeddedVersions(rule);
    if (rule.agentic !== undefined) {
      assertJudgeKindEnabled(
        rule.agentic.judge.kind,
        this.activeVersion('judge-kind', rule.agentic.judge.kind) !== null,
      );
    }
    return normaliseActivationDocument({ documentVersion: 1, kind: 'rule', rule }) as Extract<
      ActivationDocumentV1,
      { kind: 'rule' }
    >;
  }

  /**
   * D2: a rule embeds the immutable documents it names, so its digest covers exactly what a delivery will use. Every
   * embedded target, subscriber and judge must be a stored version, byte for byte; a rule naming a version that does
   * not exist, or carrying a different copy of one that does, is refused rather than approved as something else.
   */
  private assertEmbeddedVersions(rule: CanonicalFullRuleDocument): void {
    const embedded: Array<{
      kind: 'target' | 'subscriber' | 'judge';
      table: string;
      column: string;
      id: string;
      version: number;
      document: unknown;
    }> = [
      ...rule.targets.map((target) => ({
        kind: 'target' as const,
        table: 'target_versions',
        column: 'target_id',
        id: target.targetId,
        version: target.version,
        document: target,
      })),
      ...rule.subscribers.map((subscriber) => ({
        kind: 'subscriber' as const,
        table: 'subscriber_versions',
        column: 'subscriber_id',
        id: subscriber.subscriberId,
        version: subscriber.version,
        document: subscriber,
      })),
      ...(rule.agentic === undefined
        ? []
        : [
            {
              kind: 'judge' as const,
              table: 'judge_versions',
              column: 'judge_id',
              id: rule.agentic.judge.judgeId,
              version: rule.agentic.judge.version,
              document: rule.agentic.judge,
            },
          ]),
    ];
    for (const entry of embedded) {
      const row = this.#database
        .prepare(`SELECT document FROM ${entry.table} WHERE ${entry.column} = ? AND version = ?`)
        .get(entry.id, entry.version) as { document: string } | undefined;
      if (row === undefined) {
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the rule names ${entry.id} version ${entry.version}, which is not a stored version`,
        );
      }
      if (row.document !== canonicalJson(entry.document)) {
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the rule carries a copy of ${entry.id} version ${entry.version} that differs from the stored version`,
        );
      }
      if (entry.kind === 'judge' && this.#embeddedJudgeIsRevoked(entry.id, entry.version)) {
        throw new EventDomainError(
          'VERSION_DOCUMENT_INVALID',
          `the rule names revoked judge ${entry.id} version ${entry.version}`,
        );
      }
    }
  }

  #embeddedJudgeIsRevoked(judgeId: string, version: number): boolean {
    return (
      this.#database
        .prepare(
          `SELECT 1 AS present
             FROM judge_versions AS stored
             LEFT JOIN object_revocations AS revoked
               ON revoked.kind = 'judge'
              AND revoked.object_id = stored.judge_id
              AND revoked.version = stored.version
            WHERE stored.judge_id = ? AND stored.version = ?
              AND (stored.revoked_at IS NOT NULL OR revoked.revoked_at IS NOT NULL)`,
        )
        .get(judgeId, version) !== undefined
    );
  }

  private insert(
    table:
      | 'rule_versions'
      | 'target_versions'
      | 'subscriber_versions'
      | 'judge_versions'
      | 'judge_budget_versions'
      | 'judge_kind_versions',
    kind: PendingVersion['kind'],
    objectId: string,
    version: number,
    document: unknown,
  ): PendingVersion {
    const id = versionId(objectId, version);
    const persisted = documentRecord(document);
    const canonical = canonicalJson(persisted);
    const digest = sha256Hex(canonical);
    const objectColumn =
      table === 'rule_versions'
        ? 'rule_id'
        : table === 'target_versions'
          ? 'target_id'
          : table === 'subscriber_versions'
            ? 'subscriber_id'
            : table === 'judge_versions'
              ? 'judge_id'
              : table === 'judge_budget_versions'
                ? undefined
                : 'kind';
    if (table === 'judge_budget_versions') {
      this.#database
        .prepare(`INSERT INTO ${table} (id, version, document, digest) VALUES (?, ?, ?, ?)`)
        .run(id, version, canonical, digest);
    } else {
      this.#database
        .prepare(`INSERT INTO ${table} (id, ${objectColumn}, version, document, digest) VALUES (?, ?, ?, ?, ?)`)
        .run(id, objectId, version, canonical, digest);
    }
    return { id, kind, objectId, version, document: persisted, digest, state: null };
  }
}
