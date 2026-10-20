import { CommsError } from '@agentcomms/core';
import { ACTIVATION_FAILURE } from '../domain/activation-failure-codes.ts';
import { canonicalJudge, canonicalJudgeBudget, JUDGE_BUDGET_ID, JUDGE_KIND_DEFINITIONS } from '../domain/judges.ts';
import {
  JUDGE_KIND_LAYA,
  type JUDGE_KIND_LOCAL_ENDPOINT,
  JUDGE_KIND_TYPESAFE,
  JUDGE_KINDS,
  type JudgeKind,
} from '../domain/lifecycle.ts';
import { normaliseSourceOptions, type SourceOptions } from '../domain/source-options.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { B3OwnerRequest, B3OwnerService } from '../operations/b3-contract.ts';
import type { EventDatabase } from '../store/database.ts';
import type { ActivationRuntime } from './activations.ts';
import type { B3ControlPorts } from './b3-control-ports.ts';
import { judgeUnavailable } from './b3-judge-unavailable.ts';
import type { HoldResolver } from './holds.ts';
import { JudgeKinds } from './judge-kinds.ts';
import { JudgePurgeParticipant } from './judge-purge.ts';
import type { JudgeTestControl } from './judge-test.ts';
import type { LayaArtifactManager } from './laya/manager.ts';
import { purgeRevokedRuleWork } from './replacements.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface SubscriberMetadata {
  readonly subscriberId: string;
  readonly version: number;
  readonly digest: string;
  readonly revokedAt: number | null;
}

/**
 * Owner-only Task 4 control implementation.  CLI and MCP adapters added by
 * Task 5 can only send typed requests to this service; this module never
 * opens a provider, local endpoint, worker or model runtime.
 */
export class B3OperatorControl implements B3OwnerService {
  readonly #store: EventDatabase;
  readonly #ports: Pick<B3ControlPorts, 'quiescer' | 'withDeliveryWriteFence' | 'closeSubscriberStreams'>;
  readonly #now: () => number;
  readonly #activations:
    | Pick<
        ActivationRuntime,
        | 'prepareJudgeBudget'
        | 'prepareJudgeKind'
        | 'cancelForJudgeKindInTransaction'
        | 'cancelForRevocationInTransaction'
      >
    | undefined;
  readonly #judgeTest: Pick<JudgeTestControl, 'test'> | undefined;
  readonly #holdResolver: Pick<HoldResolver, 'resolve'> | undefined;
  /**
   * E2's artifact manager. When the owner composes it, every Laya operation answers with the real model state and a
   * Laya judge is created and listed like any other (B3 control v3, which keeps v2's answers); without it this control
   * keeps B3 v1's frozen typed `E2_REQUIRED` answers and v1's judge documents, which have no Laya variant.
   */
  readonly #laya: LayaArtifactManager | undefined;

  constructor(input: {
    readonly store: EventDatabase;
    readonly ports: Pick<B3ControlPorts, 'quiescer' | 'withDeliveryWriteFence' | 'closeSubscriberStreams'>;
    readonly now?: (() => number) | undefined;
    readonly activations?:
      | Pick<
          ActivationRuntime,
          | 'prepareJudgeBudget'
          | 'prepareJudgeKind'
          | 'cancelForJudgeKindInTransaction'
          | 'cancelForRevocationInTransaction'
        >
      | undefined;
    readonly judgeTest?: Pick<JudgeTestControl, 'test'> | undefined;
    readonly holdResolver?: Pick<HoldResolver, 'resolve'> | undefined;
    readonly laya?: LayaArtifactManager | undefined;
  }) {
    this.#store = input.store;
    this.#ports = input.ports;
    this.#now = input.now ?? Date.now;
    this.#activations = input.activations;
    this.#judgeTest = input.judgeTest;
    this.#holdResolver = input.holdResolver;
    this.#laya = input.laya;
  }

  async handle(request: B3OwnerRequest): Promise<unknown> {
    // B3 v1's unavailable variants remain the closed E2 seam for a control without E2's artifact manager. Phase E
    // replaces only the available judge producer; it never makes Laya download/model operations callable early.
    const unavailable =
      this.#laya === undefined &&
      (request.operation === 'judgeModelStatus' ||
        request.operation === 'removeJudgeModel' ||
        ((request.operation === 'enableJudgeKind' || request.operation === 'disableJudgeKind') &&
          request.args.kind === JUDGE_KIND_LAYA))
        ? judgeUnavailable(request.operation, request.args)
        : undefined;
    if (unavailable !== undefined) return unavailable;
    switch (request.operation) {
      case 'subscribersList':
        return this.subscribersList();
      case 'addSubscriber':
      case 'updateSubscriber':
        return this.#ports.quiescer.withShared(async () =>
          this.#store.immediate(() =>
            new ImmutableVersions(this.#store.database).createSubscriber(request.args.document as never),
          ),
        );
      case 'removeSubscriber':
        return this.#ports.quiescer.withShared(async () =>
          this.removeSubscriber(requiredText(request.args.subscriberId, 'subscriber id')),
        );
      case 'deliveriesList':
        return this.deliveriesList();
      case 'retryDelivery':
        return this.#ports.quiescer.withShared(async () =>
          this.retryDelivery(requiredText(request.args.deliveryId, 'delivery id')),
        );
      case 'dropDelivery':
        return this.#ports.quiescer.withShared(async () =>
          this.dropDelivery(requiredText(request.args.deliveryId, 'delivery id')),
        );
      case 'judgesList':
        return this.judgesList();
      case 'addJudge':
      case 'updateJudge':
        return this.#ports.quiescer.withShared(async () =>
          this.#store.immediate(() => this.#judgeVersions().createJudge(request.args.document)),
        );
      case 'removeJudge':
        return this.removeJudge(requiredText(request.args.judgeId, 'judge id'));
      case 'judgeTest':
        if (this.#judgeTest === undefined)
          throw new CommsError('CONFIG', 'judge test is not composed for this operator control');
        return this.#judgeTest.test({
          judgeId: requiredText(request.args.judgeId, 'judge id'),
          version: requiredVersion(request.args.version, 'judge version'),
        });
      case 'budgetShow':
        return this.budgetShow();
      case 'updateBudget':
        return this.updateBudget(request.args.document);
      case 'judgeKindsList':
        return this.judgeKindsList();
      case 'enableJudgeKind':
        return this.enableJudgeKind(requiredText(request.args.kind, 'judge kind'));
      case 'disableJudgeKind':
        return this.disableJudgeKind(requiredText(request.args.kind, 'judge kind'));
      case 'judgeModelStatus':
        return this.requireLaya().status();
      case 'removeJudgeModel':
        return this.requireLaya().remove();
      case 'heldList':
        return this.heldList();
      case 'decideHeld':
        if (this.#holdResolver === undefined)
          throw new CommsError('CONFIG', 'held resolution has not been composed for this operator control');
        return this.#holdResolver.resolve({
          decisionId: requiredText(request.args.decisionId, 'held decision id'),
          decision: heldDecision(request.args.decision),
        });
      default:
        throw new CommsError('USAGE', `the local B3 operator control does not implement ${request.operation}`);
    }
  }

  /** The judge documents this control answers: B3 v3's with E2's artifact manager, B3 v1's without it. */
  #judgeVersions(): ImmutableVersions {
    return this.#laya === undefined
      ? new ImmutableVersions(this.#store.database)
      : ImmutableVersions.forJudgeContract(this.#store.database, 'b3-control-v3');
  }

  private requireLaya(): LayaArtifactManager {
    if (this.#laya === undefined)
      throw new CommsError('CONFIG', 'the Laya artifact manager is not composed for this operator control');
    return this.#laya;
  }

  private requireActivations(): Pick<
    ActivationRuntime,
    'prepareJudgeBudget' | 'prepareJudgeKind' | 'cancelForJudgeKindInTransaction'
  > {
    if (this.#activations === undefined)
      throw new CommsError('CONFIG', 'judge activation is not composed for this operator control');
    return this.#activations;
  }

  budgetShow(): {
    readonly activeVersion: number | null;
    readonly versions: readonly {
      readonly budgetId: typeof JUDGE_BUDGET_ID;
      readonly version: number;
      readonly global: {
        readonly callsPerRollingHour: number;
        readonly inputTokensPerRolling30Days: number;
        readonly concurrency: number;
      };
      readonly providers: readonly {
        readonly provider: string;
        readonly callsPerRollingHour: number;
        readonly inputTokensPerRolling30Days: number;
        readonly concurrency: number;
      }[];
      readonly revokedAt: number | null;
    }[];
  } {
    const active = new ImmutableVersions(this.#store.database).activeVersion('judge-budget', JUDGE_BUDGET_ID);
    const versions = (
      this.#store.database
        .prepare('SELECT version, document, revoked_at FROM judge_budget_versions ORDER BY version')
        .all() as Array<{ version: number; document: string; revoked_at: number | null }>
    ).flatMap((row) => {
      try {
        const budget = canonicalJudgeBudget(JSON.parse(row.document));
        return [{ ...budget, revokedAt: row.revoked_at }];
      } catch {
        return [];
      }
    });
    return { activeVersion: active?.version ?? null, versions };
  }

  judgeKindsList(): readonly (
    | {
        readonly kind: typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LOCAL_ENDPOINT;
        readonly state: 'disabled' | 'enabled';
        readonly version: number | null;
      }
    | { readonly kind: typeof JUDGE_KIND_LAYA; readonly state: 'unavailable'; readonly code: 'E2_REQUIRED' }
    | ReturnType<LayaArtifactManager['kindEntry']>
  )[] {
    return JUDGE_KINDS.map((kind) => {
      if (kind === JUDGE_KIND_LAYA && this.#laya !== undefined) return this.#laya.kindEntry();
      const definition = JUDGE_KIND_DEFINITIONS.find((entry) => entry.kind === kind);
      if (definition?.availability === 'unavailable')
        return { kind: JUDGE_KIND_LAYA, state: 'unavailable' as const, code: 'E2_REQUIRED' as const };
      const active = new ImmutableVersions(this.#store.database).activeVersion('judge-kind', kind);
      return {
        kind: kind as typeof JUDGE_KIND_TYPESAFE | typeof JUDGE_KIND_LOCAL_ENDPOINT,
        state: active === null ? ('disabled' as const) : ('enabled' as const),
        version: active?.version ?? null,
      };
    });
  }

  async updateBudget(document: unknown): Promise<unknown> {
    const activations = this.requireActivations();
    const pending = await this.#ports.quiescer.withShared(async () =>
      this.#store.immediate(() => new ImmutableVersions(this.#store.database).createJudgeBudget(document)),
    );
    return activations.prepareJudgeBudget({ version: pending.version });
  }

  async enableJudgeKind(kind: string): Promise<unknown> {
    const activations = this.requireActivations();
    if (kind === JUDGE_KIND_LAYA && this.#laya !== undefined) {
      // Laya prepares only this release's reviewed document; an unavailable machine or the placeholder lock refuses
      // with its closed reason before any version, intent, approval or file exists.
      const prepared = this.#laya.enablementVersion();
      if (!('version' in prepared)) return prepared;
      return new JudgeKinds({ store: this.#store, now: this.#now, activations }).prepareEnable({
        kind: JUDGE_KIND_LAYA,
        version: prepared.version,
      });
    }
    const available = availableJudgeKind(kind);
    const version = this.#store.immediate(() => {
      const latest = this.#store.database
        .prepare('SELECT max(version) AS version FROM judge_kind_versions WHERE kind = ? AND revoked_at IS NULL')
        .get(available) as { version: number | null };
      if (latest.version !== null) return latest.version;
      const document =
        available === JUDGE_KIND_TYPESAFE
          ? { id: 'judge-kind:typesafe', kind: available, version: 1, endpoint: 'https://api.typesafe.ai/v1/systemone' }
          : { id: 'judge-kind:local-endpoint', kind: available, version: 1 };
      return new ImmutableVersions(this.#store.database).createJudgeKind(document).version;
    });
    // This is deliberately preparation only. The shared activation runtime remains the sole human approval/claim and
    // final-pointer path, so an MCP repeat cannot make a kind live.
    return new JudgeKinds({ store: this.#store, now: this.#now, activations }).prepareEnable({
      kind: available,
      version,
    });
  }

  disableJudgeKind(kind: string): Promise<unknown> {
    const activations = this.requireActivations();
    // E's one disable transaction — its full purge and enable-all cancellation included — is unchanged; for Laya the
    // artifact manager wraps it so a download is cancelled and its partial tree deleted.
    return new JudgeKinds({ store: this.#store, now: this.#now, activations, artifacts: this.#laya }).disableKind(kind);
  }

  async removeJudge(judgeId: string): Promise<{ readonly judgeId: string; readonly removed: true }> {
    return this.#store.immediate(() => {
      const rows = this.#store.database
        .prepare('SELECT version FROM judge_versions WHERE judge_id = ? AND revoked_at IS NULL ORDER BY version')
        .all(judgeId) as Array<{ version: number }>;
      if (rows.length === 0) throw new CommsError('NOT_FOUND', 'the judge has no live version to remove');
      this.#activations?.cancelForRevocationInTransaction({ judgeId });
      const revokedAt = this.#now();
      const removedVersions = new Set(rows.map((row) => row.version));
      for (const row of rows) {
        this.#store.database
          .prepare('UPDATE judge_versions SET revoked_at = ? WHERE judge_id = ? AND version = ? AND revoked_at IS NULL')
          .run(revokedAt, judgeId, row.version);
        this.#store.database
          .prepare(
            'INSERT OR REPLACE INTO object_revocations (kind, object_id, version, revoked_at) VALUES (?, ?, ?, ?)',
          )
          .run('judge', judgeId, row.version, revokedAt);
      }
      new JudgePurgeParticipant({ database: this.#store.database, now: () => revokedAt }).judge({
        judgeId,
        versions: [...removedVersions],
      });
      const bound = this.#store.database
        .prepare("SELECT rule_id, version, document FROM rule_versions WHERE state IN ('active', 'superseded')")
        .all() as Array<{ rule_id: string; version: number; document: string }>;
      for (const rule of bound) {
        if (!ruleReferencesJudge(rule.document, judgeId, removedVersions)) continue;
        this.#store.database
          .prepare(
            `UPDATE rule_versions SET state = 'revoked', revoked_at = ?
              WHERE rule_id = ? AND version = ? AND state IN ('active', 'superseded')`,
          )
          .run(revokedAt, rule.rule_id, rule.version);
        purgeRevokedRuleWork(this.#store.database, rule.rule_id, [rule.version], revokedAt);
        this.#store.database
          .prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = ?")
          .run(rule.rule_id, rule.version);
      }
      return { judgeId, removed: true };
    });
  }

  /** The held listing is metadata-only; ciphertext, event projection and model response never leave the resolver. */
  heldList(): {
    readonly kind: 'held-list';
    readonly decisions: readonly {
      readonly decisionId: string;
      readonly accountId: string;
      readonly ruleId: string;
      readonly ruleVersion: number;
      readonly holdExpiresAt: number | null;
      readonly holdBoundBy: 'hold-window' | 'ingest-retention' | null;
    }[];
  } {
    const decisions = this.#store.database
      .prepare(
        `SELECT id, account_id, rule_id, rule_version, hold_expires_at, hold_bound_by
           FROM decisions WHERE outcome = 'hold' ORDER BY hold_expires_at, id`,
      )
      .all() as Array<{
      id: string;
      account_id: string;
      rule_id: string;
      rule_version: number;
      hold_expires_at: number | null;
      hold_bound_by: string | null;
    }>;
    return {
      kind: 'held-list',
      decisions: decisions.flatMap((row) =>
        row.hold_bound_by === null || row.hold_bound_by === 'hold-window' || row.hold_bound_by === 'ingest-retention'
          ? [
              {
                decisionId: row.id,
                accountId: row.account_id,
                ruleId: row.rule_id,
                ruleVersion: row.rule_version,
                holdExpiresAt: row.hold_expires_at,
                holdBoundBy: row.hold_bound_by,
              },
            ]
          : [],
      ),
    };
  }

  /** Content-free immutable judge inventory; prompts, endpoint credentials and secret state never cross this surface. */
  judgesList(): readonly {
    readonly judgeId: string;
    readonly version: number;
    readonly kind: JudgeKind;
    readonly provider: string;
    readonly model: string;
    readonly revokedAt: number | null;
  }[] {
    return (
      this.#store.database
        .prepare('SELECT judge_id, version, document, revoked_at FROM judge_versions ORDER BY judge_id, version')
        .all() as Array<{ judge_id: string; version: number; document: string; revoked_at: number | null }>
    ).flatMap((row) => {
      try {
        const judge = canonicalJudge(JSON.parse(row.document));
        const entry = {
          judgeId: row.judge_id,
          version: row.version,
          kind: judge.kind,
          provider: judge.provider,
          model: judge.model,
          revokedAt: row.revoked_at,
        };
        // B3 v3, answered with E2's artifact manager, lists a Laya judge as it lists every other: its model is the
        // reviewed manifest id.
        if (this.#laya !== undefined) return [entry];
        // B3 v1's inventory has no Laya variant; a Laya judge is listed only by the contract version that adds one.
        if (judge.kind === JUDGE_KIND_LAYA) return [];
        return [entry];
      } catch {
        // A damaged immutable row must not become a permissive/free-form control result.
        return [];
      }
    });
  }

  subscribersList(): readonly SubscriberMetadata[] {
    return (
      this.#store.database
        .prepare(
          `SELECT subscriber_id, version, digest, revoked_at
             FROM subscriber_versions
            ORDER BY subscriber_id, version`,
        )
        .all() as Array<{ subscriber_id: string; version: number; digest: string; revoked_at: number | null }>
    ).map((row) => ({
      subscriberId: row.subscriber_id,
      version: row.version,
      digest: row.digest,
      revokedAt: row.revoked_at,
    }));
  }

  deliveriesList(): readonly Record<string, unknown>[] {
    return this.#store.database
      .prepare(
        `SELECT id, account_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
                attempts, next_at, expires_at, state, switch_generation, dead_letter_expires_at
           FROM deliveries
          ORDER BY id`,
      )
      .all()
      .map((row) => ({
        deliveryId: (row as { id: string }).id,
        accountId: (row as { account_id: string }).account_id,
        ruleId: (row as { rule_id: string }).rule_id,
        ruleVersion: (row as { rule_version: number }).rule_version,
        targetId: (row as { target_id: string }).target_id,
        targetVersion: (row as { target_version: number }).target_version,
        subscriberId: (row as { subscriber_id: string | null }).subscriber_id,
        subscriberVersion: (row as { subscriber_version: number | null }).subscriber_version,
        attempts: (row as { attempts: number }).attempts,
        nextAt: (row as { next_at: number | null }).next_at,
        expiresAt: (row as { expires_at: number }).expires_at,
        state: (row as { state: string }).state,
        switchGeneration: (row as { switch_generation: number }).switch_generation,
        deadLetterExpiresAt: (row as { dead_letter_expires_at: number | null }).dead_letter_expires_at,
      }));
  }

  async retryDelivery(deliveryId: string): Promise<{
    readonly kind: 'delivery-retried';
    readonly deliveryId: string;
    readonly nextAt: number;
  }> {
    const candidate = this.#deliveryRow(deliveryId);
    // The fence owns the one IMMEDIATE transaction: it re-checks every live authority, then runs this work inside it.
    return this.#withDeliveryWriteFence(candidate, 'retry', () => {
      const row = this.#deliveryRow(deliveryId);
      this.#assertRetryable(row);
      const nextAt = this.#now();
      const changed = this.#store.database
        .prepare(
          `UPDATE deliveries
              SET next_at = ?
            WHERE id = ? AND state = ? AND attempts = ? AND expires_at = ? AND switch_generation = ?`,
        )
        .run(nextAt, row.id, row.state, row.attempts, row.expires_at, row.switch_generation).changes;
      if (changed !== 1) throw voided('the delivery changed before its retry could be scheduled');
      return { kind: 'delivery-retried', deliveryId, nextAt };
    });
  }

  removeSubscriber(subscriberId: string): { readonly subscriberId: string; readonly removed: true } {
    const closeSubscriberStreams = this.#ports.closeSubscriberStreams;
    if (closeSubscriberStreams === undefined)
      throw new CommsError('CONFIG', 'subscriber removal requires the owner SSE stream-registry port');
    return this.#store.immediate(() => {
      const versions = this.#store.database
        .prepare('SELECT version FROM subscriber_versions WHERE subscriber_id = ? AND revoked_at IS NULL')
        .all(subscriberId) as Array<{ version: number }>;
      if (versions.length === 0) throw new CommsError('NOT_FOUND', 'the subscriber has no live version to remove');
      const now = this.#now();
      const removedVersions = new Set(versions.map((row) => row.version));
      for (const row of versions) {
        this.#store.database
          .prepare(
            `UPDATE subscriber_versions
                SET revoked_at = ?
              WHERE subscriber_id = ? AND version = ? AND revoked_at IS NULL`,
          )
          .run(now, subscriberId, row.version);
        this.#store.database
          .prepare(
            `UPDATE event_secret_generations SET lifecycle = 'retired', expires_at = ?
              WHERE owner_kind = 'subscriber' AND owner_id = ? AND owner_version = ?
                AND lifecycle IN ('current', 'overlap')`,
          )
          .run(now, subscriberId, row.version);
      }
      this.#cancelSubscriberActivationIntents(subscriberId, removedVersions, now);
      const bound = this.#store.database
        .prepare("SELECT rule_id, version, document FROM rule_versions WHERE state IN ('active', 'superseded')")
        .all() as Array<{ rule_id: string; version: number; document: string }>;
      for (const rule of bound) {
        if (!ruleReferencesSubscriber(rule.document, subscriberId, removedVersions)) continue;
        this.#store.database
          .prepare(
            `UPDATE rule_versions SET state = 'revoked', revoked_at = ?
              WHERE rule_id = ? AND version = ? AND state IN ('active', 'superseded')`,
          )
          .run(now, rule.rule_id, rule.version);
        purgeRevokedRuleWork(this.#store.database, rule.rule_id, [rule.version], now);
        this.#store.database
          .prepare("DELETE FROM active_versions WHERE kind = 'rule' AND object_id = ? AND version = ?")
          .run(rule.rule_id, rule.version);
      }
      for (const version of removedVersions) {
        this.#store.database
          .prepare('DELETE FROM stream_log WHERE subscriber_id = ? AND subscriber_version = ?')
          .run(subscriberId, version);
        closeSubscriberStreams({ subscriberId, subscriberVersion: version });
      }
      return { subscriberId, removed: true };
    });
  }

  async dropDelivery(deliveryId: string): Promise<{ readonly kind: 'delivery-dropped'; readonly deliveryId: string }> {
    const candidate = this.#deliveryRow(deliveryId);
    return this.#withDeliveryWriteFence(candidate, 'drop', () => {
      const row = this.#deliveryRow(deliveryId);
      if (row.state !== 'dead-lettered') throw voided('only a dead-letter delivery can be dropped');
      const changed = this.#store.database
        .prepare(
          `UPDATE deliveries
              SET encrypted_record = NULL, next_at = NULL, lease_until = NULL
            WHERE id = ? AND state = 'dead-lettered'`,
        )
        .run(row.id).changes;
      if (changed !== 1) throw voided('the delivery changed before its retained payload could be dropped');
      this.#store.database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(row.id);
      this.#store.database.prepare('DELETE FROM stream_log WHERE delivery_id = ?').run(row.id);
      for (const target of removeRetainedDeliveryTargetReference(this.#store.database, row.id))
        purgeUnreferencedSystemTargets(this.#store.database, { ...target, now: this.#now() });
      return { kind: 'delivery-dropped', deliveryId };
    });
  }

  #withDeliveryWriteFence<T>(row: DeliveryFenceRow, operation: 'retry' | 'drop', work: () => T): Promise<T> {
    const fence = this.#ports.withDeliveryWriteFence;
    if (fence === undefined)
      return Promise.reject(new CommsError('CONFIG', 'delivery control requires the owner disclosure/write fence'));
    return fence(
      {
        operation,
        deliveryId: row.id,
        accountId: row.account_id,
        source: sourceFromRule(row.rule_document),
        ruleId: row.rule_id,
        ruleVersion: row.rule_version,
        targetId: row.target_id,
        targetVersion: row.target_version,
        subscriberId: row.subscriber_id,
        subscriberVersion: row.subscriber_version,
        whatsappMessageId: row.whatsapp_message_id,
        switchGeneration: row.switch_generation,
      },
      work,
    );
  }

  #deliveryRow(deliveryId: string): DeliveryFenceRow {
    const row = this.#store.database
      .prepare(
        `SELECT delivery.id, delivery.account_id, delivery.rule_id, delivery.rule_version, delivery.target_id,
                delivery.target_version, delivery.subscriber_id, delivery.subscriber_version, delivery.attempts,
                delivery.expires_at, delivery.state, delivery.switch_generation, delivery.whatsapp_message_id,
                rule.document AS rule_document,
                target.document AS target_document
           FROM deliveries AS delivery
           JOIN rule_versions AS rule ON rule.rule_id = delivery.rule_id AND rule.version = delivery.rule_version
           JOIN target_versions AS target ON target.target_id = delivery.target_id AND target.version = delivery.target_version
          WHERE delivery.id = ?`,
      )
      .get(deliveryId) as DeliveryFenceRow | undefined;
    if (!row) throw new CommsError('NOT_FOUND', 'the delivery does not exist');
    return row;
  }

  #assertRetryable(row: DeliveryFenceRow): void {
    if (row.state !== 'retryable') throw voided('only a retryable delivery may be scheduled again');
    if (row.attempts >= retryLimit(row.target_document))
      throw voided('the delivery has reached its original attempt limit');
    if (row.expires_at <= this.#now()) throw voided('the delivery retention deadline has passed');
  }

  #cancelSubscriberActivationIntents(subscriberId: string, removedVersions: ReadonlySet<number>, now: number): void {
    const intents = this.#store.database
      .prepare(
        "SELECT id, document FROM activation_intents WHERE status IN ('pending', 'pending-completion') ORDER BY id",
      )
      .all() as Array<{ id: string; document: string }>;
    for (const intent of intents) {
      if (!activationIntentReferencesSubscriber(this.#store.database, intent.document, subscriberId, removedVersions))
        continue;
      this.#store.database
        .prepare("UPDATE activation_intents SET status = 'cancelled', failure_code = ?, updated_at = ? WHERE id = ?")
        .run(ACTIVATION_FAILURE.AUTHORIZATION_REVOKED, now, intent.id);
      this.#store.database.prepare('DELETE FROM activation_baselines WHERE intent_id = ?').run(intent.id);
      this.#store.database.prepare('DELETE FROM replacement_drains WHERE intent_id = ?').run(intent.id);
      this.#store.database.prepare('DELETE FROM slack_reply_drains WHERE intent_id = ?').run(intent.id);
    }
  }
}

interface DeliveryFenceRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly subscriber_id: string | null;
  readonly subscriber_version: number | null;
  readonly whatsapp_message_id: string | null;
  readonly attempts: number;
  readonly expires_at: number;
  readonly state: string;
  readonly switch_generation: number;
  readonly rule_document: string;
  readonly target_document: string;
}

function sourceFromRule(document: string): SourceOptions['channel'] {
  try {
    const source = (JSON.parse(document) as { source?: { options?: unknown } }).source;
    if (source === undefined) throw new Error('source is absent');
    return normaliseSourceOptions(source.options).channel;
  } catch {
    throw voided('the delivery rule has no recognised source scope');
  }
}

function exactSubscriberReference(value: unknown, subscriberId: string, versions: ReadonlySet<number>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { subscriberId?: unknown }).subscriberId === subscriberId &&
    typeof (value as { version?: unknown }).version === 'number' &&
    versions.has((value as { version: number }).version)
  );
}

function exactSubscriberTargetReference(value: unknown, subscriberId: string, versions: ReadonlySet<number>): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { subscriberId?: unknown }).subscriberId === subscriberId &&
    typeof (value as { subscriberVersion?: unknown }).subscriberVersion === 'number' &&
    versions.has((value as { subscriberVersion: number }).subscriberVersion)
  );
}

function ruleReferencesSubscriber(document: string, subscriberId: string, versions: ReadonlySet<number>): boolean {
  try {
    const rule = JSON.parse(document) as { subscribers?: unknown; targets?: unknown };
    return (
      (Array.isArray(rule.subscribers) &&
        rule.subscribers.some((subscriber) => exactSubscriberReference(subscriber, subscriberId, versions))) ||
      (Array.isArray(rule.targets) &&
        rule.targets.some((target) => exactSubscriberTargetReference(target, subscriberId, versions)))
    );
  } catch {
    // A damaged live document is incapable of proving it does not bind the revoked subscriber.
    return true;
  }
}

function ruleReferencesJudge(document: string, judgeId: string, versions: ReadonlySet<number>): boolean {
  try {
    const rule = JSON.parse(document) as { agentic?: { judge?: { judgeId?: unknown; version?: unknown } } };
    const judge = rule.agentic?.judge;
    return judge?.judgeId === judgeId && typeof judge.version === 'number' && versions.has(judge.version);
  } catch {
    // A damaged live rule cannot prove that it is safe to leave active after the bound authority is revoked.
    return true;
  }
}

function activationIntentReferencesSubscriber(
  database: EventDatabase['database'],
  document: string,
  subscriberId: string,
  versions: ReadonlySet<number>,
): boolean {
  try {
    const intent = JSON.parse(document) as {
      kind?: unknown;
      rule?: unknown;
      ruleVersions?: Array<{ ruleId?: unknown; ruleVersion?: unknown }>;
    };
    if (intent.kind === 'rule') {
      const rule = JSON.stringify(intent.rule);
      return rule === undefined || ruleReferencesSubscriber(rule, subscriberId, versions);
    }
    if (intent.kind !== 'enable-all' || !Array.isArray(intent.ruleVersions)) return false;
    return intent.ruleVersions.some((entry) => {
      if (typeof entry.ruleId !== 'string' || !Number.isSafeInteger(entry.ruleVersion)) return true;
      const ruleVersion = entry.ruleVersion as number;
      const row = database
        .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
        .get(entry.ruleId, ruleVersion) as { document: string } | undefined;
      return row === undefined || ruleReferencesSubscriber(row.document, subscriberId, versions);
    });
  } catch {
    // Pending and claimed malformed intent documents are unsafe once the subscriber has been revoked.
    return true;
  }
}

function retryLimit(document: string): number {
  const retryLimit = (JSON.parse(document) as { retryLimit?: unknown }).retryLimit;
  if (!Number.isSafeInteger(retryLimit) || (retryLimit as number) < 1) throw voided('the target has no retry limit');
  return retryLimit as number;
}

function requiredText(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new CommsError('USAGE', `${name} is required`);
  return value;
}

function requiredVersion(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new CommsError('USAGE', `${name} is a positive integer`);
  return value as number;
}

function heldDecision(value: unknown): 'accept' | 'reject' {
  if (value !== 'accept' && value !== 'reject') throw new CommsError('USAGE', 'held decision is accept or reject');
  return value;
}

function availableJudgeKind(kind: string): Exclude<JudgeKind, typeof JUDGE_KIND_LAYA> {
  if (!(JUDGE_KINDS as readonly string[]).includes(kind))
    throw new CommsError('BAD_DATA', 'the judge kind is not recognised');
  if (kind === JUDGE_KIND_LAYA) throw new CommsError('BAD_DATA', 'laya is unavailable until E2');
  return kind as Exclude<JudgeKind, typeof JUDGE_KIND_LAYA>;
}

function voided(message: string): CommsError {
  return new CommsError('APPROVAL_VOID', message);
}
