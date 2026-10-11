import { CommsError } from '@agentcomms/core';
import { ACTIVATION_FAILURE } from '../domain/activation-failure-codes.ts';
import { normaliseSourceOptions, type SourceOptions } from '../domain/source-options.ts';
import { ImmutableVersions } from '../domain/versions.ts';
import type { B3OwnerRequest, B3OwnerService } from '../operations/b3-contract.ts';
import type { EventDatabase } from '../store/database.ts';
import type { B3ControlPorts } from './b3-control-ports.ts';
import { decideHeldUnavailable, heldListUnavailable, judgeUnavailable } from './b3-judge-unavailable.ts';
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

  constructor(input: {
    readonly store: EventDatabase;
    readonly ports: Pick<B3ControlPorts, 'quiescer' | 'withDeliveryWriteFence' | 'closeSubscriberStreams'>;
    readonly now?: (() => number) | undefined;
  }) {
    this.#store = input.store;
    this.#ports = input.ports;
    this.#now = input.now ?? Date.now;
  }

  async handle(request: B3OwnerRequest): Promise<unknown> {
    const unavailable = judgeUnavailable(request.operation, request.args);
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
      case 'heldList':
        return heldListUnavailable();
      case 'decideHeld':
        return decideHeldUnavailable();
      default:
        throw new CommsError('USAGE', `the local B3 operator control does not implement ${request.operation}`);
    }
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
        purgeRevokedRuleWork(this.#store.database, rule.rule_id, [rule.version]);
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

function voided(message: string): CommsError {
  return new CommsError('APPROVAL_VOID', message);
}
