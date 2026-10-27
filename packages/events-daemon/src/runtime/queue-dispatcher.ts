import { randomUUID } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import type { CanonicalFullRuleDocument, QueueTargetDocument } from '../domain/activation-documents.ts';
import { newQueueItemId, parseQueueItemContent } from '../domain/queue-target.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EncryptedRecordLocation, type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { queueDeadlines } from '../store/retention.ts';
import { assertLiveEventAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { QueueDeliveryRecord } from './deliveries.ts';
import {
  type ClaimedDelivery,
  claimDelivery,
  type DeliveryClaimResult,
  hasLiveDeliveryLineage,
  isCurrentDeliveryClaim,
  releaseDeliveryClaim,
  releaseDeliveryClaimInTransaction,
} from './delivery-claim.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatchHandler, DispatchResult } from './dispatcher.ts';
import { EventExpiry } from './expiry.ts';
import type { SessionOfferPort } from './take-offers.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';
import type { WhatsAppVisibilityFence } from './whatsapp-visibility.ts';

interface CurrentQueueDeliveryRow {
  readonly id: string;
  readonly decision_id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly expires_at: number;
  readonly switch_generation: number;
  readonly event_id: string;
  readonly occurred_at: number;
  readonly whatsapp_message_id: string | null;
}

export interface QueueDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly expiry?: EventExpiry | undefined;
  /** Production uses the shared resolver; tests inject refusal cases at the exact dispatch boundary. */
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  /** Test-only interruption point: every effect remains in one immediate transaction. */
  readonly beforeCommit?: (() => void) | undefined;
  /** The concrete D6 gate is mandatory for every WhatsApp append. */
  readonly whatsappVisibilityFence?: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
  readonly newItemId?: ((now: number) => string) | undefined;
  /** Told after an item commits, so a lane's watches and long-polls settle at once (routing §3.4); never throws. */
  readonly onAppended?: (() => void) | undefined;
  /**
   * Taking messages T4: after an item commits, and before the lane is told, a lane item's message is offered to the
   * window bound to that lane. Best-effort: an offer that cannot be written never fails the delivery.
   */
  readonly offers?: Pick<SessionOfferPort, 'offerLaneItem'> | undefined;
}

/**
 * The action queue's delivery boundary: dry-run's pattern exactly (action queue design §4.1). It claims and charges a
 * delivery, proves its authority before decrypting, seals the item for its own row outside the write transaction, then
 * — in one transaction that repeats every fence — charges the cap if the claim has not, appends the item and finishes
 * the delivery. No network I/O exists on this path.
 */
export class QueueDispatcher implements DeliveryDispatchHandler {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #expiry: EventExpiry;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #beforeCommit: (() => void) | undefined;
  readonly #whatsappVisibilityFence: Pick<WhatsAppVisibilityFence, 'withCurrentDryRunVisibility'> | undefined;
  readonly #newItemId: (now: number) => string;
  readonly #onAppended: (() => void) | undefined;
  readonly #offers: Pick<SessionOfferPort, 'offerLaneItem'> | undefined;

  constructor(options: QueueDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#expiry = options.expiry ?? new EventExpiry(options.store, options.now ?? Date.now);
    this.#fence = options.fence ?? assertDisclosable;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#beforeCommit = options.beforeCommit;
    this.#whatsappVisibilityFence = options.whatsappVisibilityFence;
    this.#newItemId = options.newItemId ?? newQueueItemId;
    this.#onAppended = options.onAppended;
    this.#offers = options.offers;
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    this.#expiry.sweep();
    let claimed: DeliveryClaimResult;
    try {
      claimed = await claimDelivery({
        store: this.#store,
        deliveryId,
        now: this.#now(),
        leaseMs: this.#leaseMs,
        newAttemptId: randomUUID,
        newLeaseToken: randomUUID,
        assertAccountLive: (accountId) => {
          const candidate = deliveryById(this.#store, deliveryId);
          return assertLiveEventAccount(this.#config, {
            source: sourceOf(this.#store, candidate?.rule_id, candidate?.rule_version),
            accountId,
          });
        },
        preflight: async (row) => {
          await this.#fence({
            database: this.#store.database,
            approvals: this.#approvals,
            config: this.#config,
            accountId: row.accountId,
            boundary: 'dispatch',
            ruleId: row.ruleId,
            ruleVersion: row.ruleVersion,
            targetId: row.targetId,
            targetVersion: row.targetVersion,
            switchGeneration: row.switchGeneration,
          });
        },
      });
    } catch (error) {
      const candidate = deliveryById(this.#store, deliveryId);
      if (candidate !== undefined && isRemovedAccountError(error)) {
        this.#purgeAccount(sourceOf(this.#store, candidate.rule_id, candidate.rule_version), candidate.account_id);
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const row = claimed.claim;
    let rule: CanonicalFullRuleDocument;
    let target: QueueTargetDocument;
    try {
      rule = ruleFor(this.#store, row.ruleId, row.ruleVersion);
      target = queueTarget(rule, row.targetId, row.targetVersion);
    } catch (error) {
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }

    let plaintext: Buffer;
    try {
      plaintext = await this.#cipher.decrypt(deliveryLocation(row.id), row.encryptedRecord);
    } catch (error) {
      if (error instanceof RecordStorageError) {
        this.#markUnreadable(row);
        return { state: 'unreadable', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }
    const record = queueDeliveryRecord(plaintext);
    if (record === null) {
      this.#markUnreadable(row);
      return { state: 'unreadable', deliveryId };
    }

    // The item id is part of its AAD, so it is chosen before sealing; sealing opens its own nonce transaction and must
    // precede the boundary's immediate transaction.
    const itemId = this.#newItemId(this.#now());
    const sealed = await this.#cipher.encrypt(queueItemLocation(itemId), Buffer.from(JSON.stringify(record.item)));
    try {
      await this.#fence(this.#fenceRequest(row));
      await assertLiveEventAccount(this.#config, { source: rule.source.channel, accountId: row.accountId });
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#purgeAccount(rule.source.channel, row.accountId);
        return { state: 'terminal', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }
    // A WhatsApp row appends only inside D's live-list gate (D6); a newly hidden row is never appended.
    let appended: DispatchResult | undefined;
    try {
      appended = await this.#withWhatsAppVisibility(
        row.accountId,
        deliveryById(this.#store, row.id)?.whatsapp_message_id ?? null,
        async () => {
          await this.#fence(this.#fenceRequest(row));
          await assertLiveEventAccount(this.#config, { source: rule.source.channel, accountId: row.accountId });
        },
        () => this.#append(row, rule, target, itemId, sealed, record.released),
      );
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#purgeAccount(rule.source.channel, row.accountId);
        return { state: 'terminal', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }
    if (appended?.state === 'delivered') {
      // The offer is written once the item is committed, and before the lane's window is woken for it (taking §8).
      await this.#offers?.offerLaneItem(deliveryId).catch(() => undefined);
      try {
        this.#onAppended?.();
      } catch {
        // A lane's wake is told again on its next look; the committed item is unaffected.
      }
    }
    return appended ?? { state: 'terminal', deliveryId };
  }

  /** Claims interrupted local work again; a committed append is already terminal and is never charged twice. */
  async recoverLeases(): Promise<readonly DispatchResult[]> {
    const ids = this.#store.database
      .prepare(
        "SELECT id FROM deliveries WHERE state = 'disclosing' AND lease_until <= ? AND target_key GLOB 'queue:*' ORDER BY id",
      )
      .all(this.#now()) as Array<{ id: string }>;
    return Promise.all(ids.map(({ id }) => this.dispatch(id)));
  }

  #fenceRequest(row: ClaimedDelivery): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: row.accountId,
      boundary: 'dispatch',
      ruleId: row.ruleId,
      ruleVersion: row.ruleVersion,
      targetId: row.targetId,
      targetVersion: row.targetVersion,
      switchGeneration: row.switchGeneration,
    };
  }

  #append(
    row: ClaimedDelivery,
    rule: CanonicalFullRuleDocument,
    target: QueueTargetDocument,
    itemId: string,
    sealed: Buffer,
    released: boolean,
  ): DispatchResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const database = this.#store.database;
      const current = deliveryById(this.#store, row.id);
      if (current === undefined || !isCurrentDeliveryClaim(database, row))
        return { state: 'terminal', deliveryId: row.id };
      if (current.expires_at <= now) {
        this.#settle(row, 'retention-expired');
        return { state: 'expired', deliveryId: row.id };
      }
      if (!hasLiveDeliveryLineage(database, current)) {
        this.#settle(row, 'cancelled');
        return { state: 'terminal', deliveryId: row.id };
      }
      const setting = database
        .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
      if (setting?.enabled !== 1 || setting.switch_generation !== current.switch_generation) {
        this.#settle(row, 'cancelled');
        return { state: 'terminal', deliveryId: row.id };
      }
      // A pause that began after the claim still wins: the work waits, encrypted, for a resume.
      if (setting.paused === 1) {
        releaseDeliveryClaimInTransaction(database, row);
        return { state: 'paused', deliveryId: row.id };
      }
      const barrier = database
        .prepare(
          'SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1',
        )
        .get(current.target_id, current.target_version) as { state: string } | undefined;
      if (barrier && barrier.state !== 'open') {
        releaseDeliveryClaimInTransaction(database, row);
        return { state: 'waiting-reset', deliveryId: row.id };
      }
      const queueMs = rule.retention.queueMs;
      if (queueMs === undefined)
        throw new CommsError('APPROVAL_VOID', 'the workflow of this queue delivery has no approved queue retention');
      const deadlines = queueDeadlines(now, queueMs, target.retentionMs);
      this.#beforeCommit?.();
      // D8: the append transaction charges the cap if the claim has not already, so the charge, the item and the
      // finished delivery are one commit. The claim normally charged it; this never charges a second time.
      database
        .prepare(
          'INSERT OR IGNORE INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at) VALUES (?, ?, ?, ?)',
        )
        .run(current.id, current.rule_id, current.rule_version, now);
      database
        .prepare(
          `INSERT INTO queue_items
            (id, delivery_id, decision_id, event_id, rule_id, rule_version, target_id, target_version, account_id,
             channel, whatsapp_message_id, state, state_at, arrived_at, appended_at, retention_ms, expires_at,
             row_expires_at, released, encrypted_record)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          itemId,
          current.id,
          current.decision_id,
          current.event_id,
          current.rule_id,
          current.rule_version,
          current.target_id,
          current.target_version,
          current.account_id,
          rule.source.channel,
          current.whatsapp_message_id,
          now,
          current.occurred_at,
          now,
          deadlines.retentionMs,
          deadlines.expiresAt,
          deadlines.rowExpiresAt,
          released ? 1 : 0,
          sealed,
        );
      const settled = database
        .prepare(
          `UPDATE deliveries SET state = 'delivered', encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
      if (settled !== 1) throw new CommsError('APPROVAL_VOID', 'the queue delivery changed before its item committed');
      this.#dropRetainedTargetReference(row.id, now);
      return { state: 'delivered', deliveryId: row.id };
    });
  }

  #settle(row: ClaimedDelivery, state: 'cancelled' | 'retention-expired'): void {
    const changed = this.#store.database
      .prepare(
        `UPDATE deliveries SET state = ?, encrypted_record = NULL, lease_until = NULL, next_at = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(state, row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
    if (changed === 1) this.#dropRetainedTargetReference(row.id, this.#now());
  }

  /**
   * D8: content that cannot be authenticated or read ends its own work, terminal `content-unreadable`, with its record
   * purged. Unlike dry-run, it closes no reset barrier: nothing in production reopens a local barrier, and one bad
   * record must not stop every later match from reaching the person's queue. Doctor counts these deliveries.
   */
  #markUnreadable(row: ClaimedDelivery): void {
    this.#store.immediate(() => {
      const changed = this.#store.database
        .prepare(
          `UPDATE deliveries SET state = 'content-unreadable', encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
      if (changed === 1) this.#dropRetainedTargetReference(row.id, this.#now());
    });
  }

  #purgeAccount(source: CanonicalFullRuleDocument['source']['channel'], accountId: string): void {
    this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, { source, accountId }, this.#now()));
  }

  #dropRetainedTargetReference(deliveryId: string, now: number): void {
    for (const target of removeRetainedDeliveryTargetReference(this.#store.database, deliveryId))
      purgeUnreferencedSystemTargets(this.#store.database, { ...target, now });
  }

  async #withWhatsAppVisibility<T>(
    accountId: string,
    whatsappMessageId: string | null,
    recheck: () => Promise<void>,
    commit: () => T,
  ): Promise<T | undefined> {
    if (whatsappMessageId === null) return commit();
    if (this.#whatsappVisibilityFence === undefined)
      throw new CommsError(
        'WHATSAPP_VISIBILITY_SEAM_REQUIRED',
        'a WhatsApp queue boundary requires the concrete visibility fence',
      );
    return this.#whatsappVisibilityFence.withCurrentDryRunVisibility({ accountId, whatsappMessageId }, recheck, commit);
  }
}

function deliveryById(store: EventDatabase, id: string): CurrentQueueDeliveryRow | undefined {
  return store.database
    .prepare(
      `SELECT d.id, d.decision_id, d.account_id, d.rule_id, d.rule_version, d.target_id, d.target_version, d.expires_at,
              d.switch_generation, decision.event_id, ingest.occurred_at, d.whatsapp_message_id
       FROM deliveries d
       JOIN decisions decision ON decision.id = d.decision_id
       JOIN ingest ON ingest.event_id = decision.event_id
       WHERE d.id = ?`,
    )
    .get(id) as CurrentQueueDeliveryRow | undefined;
}

/** The source a delivery's exact rule version reads; account liveness and purge are always source-specific. */
function sourceOf(
  store: EventDatabase,
  ruleId: string | undefined,
  ruleVersion: number | undefined,
): CanonicalFullRuleDocument['source']['channel'] {
  if (ruleId === undefined || ruleVersion === undefined)
    throw new CommsError('APPROVAL_VOID', 'the exact workflow for this queue delivery is missing');
  return ruleFor(store, ruleId, ruleVersion).source.channel;
}

export function ruleFor(store: EventDatabase, ruleId: string, ruleVersion: number): CanonicalFullRuleDocument {
  const row = store.database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as { document: string } | undefined;
  if (!row) throw new CommsError('APPROVAL_VOID', 'the exact workflow for this queue item is missing');
  try {
    return JSON.parse(row.document) as CanonicalFullRuleDocument;
  } catch {
    throw new CommsError('APPROVAL_VOID', 'the exact workflow for this queue item is invalid');
  }
}

export function queueTarget(
  rule: CanonicalFullRuleDocument,
  targetId: string,
  targetVersion: number,
): QueueTargetDocument {
  const target = rule.targets.find(
    (candidate) => candidate.targetId === targetId && candidate.version === targetVersion,
  );
  if (target?.kind !== 'queue')
    throw new CommsError('APPROVAL_VOID', 'the delivery does not name an authorised queue target');
  return target;
}

function deliveryLocation(id: string) {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

/** An item's AAD location: its table, its one encrypted column and its primary key (D8). */
export function queueItemLocation(id: string): EncryptedRecordLocation {
  return { table: 'queue_items', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function queueDeliveryRecord(value: Buffer): QueueDeliveryRecord | null {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<QueueDeliveryRecord>;
    if (parsed.kind !== 'queue-item' || typeof parsed.released !== 'boolean') return null;
    const item = parseQueueItemContent(parsed.item);
    return item === null ? null : { kind: 'queue-item', item, released: parsed.released };
  } catch {
    return null;
  }
}
