import { randomUUID } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import { canonicalSseSubscriber } from '../domain/sse-subscriber.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EncryptedRecordLocation, EventRecordCipher } from '../store/records.ts';
import { sseReplayDeadline } from '../store/retention.ts';
import { assertLiveGmailAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { DeliveryRecord } from './deliveries.ts';
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
import type { DSourceRetentionHooks, SseFrameVisibilityGate } from './phase-d-whatsapp-seam.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

export interface SealedSseFrameWrite {
  readonly frame: string;
  readonly accountId: string;
  readonly whatsappMessageId: string | null;
  readonly visibilityGate: SseFrameVisibilityGate;
  /** Only D's production owner composition may turn this on for persisted WhatsApp tuples. */
  readonly hasConcreteWhatsAppVisibilityFence: boolean;
  readonly writeFrame: (frame: string) => void;
}

export interface CurrentSseDelivery {
  readonly id: string;
  readonly decision_id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly subscriber_id: string | null;
  readonly subscriber_version: number | null;
  readonly target_kind: string;
  readonly encrypted_record: Uint8Array | null;
  readonly expires_at: number;
  readonly switch_generation: number;
  readonly event_id: string;
}

export interface SseDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly visibilityGate?: SseFrameVisibilityGate | undefined;
  readonly hasConcreteWhatsAppVisibilityFence?: boolean | undefined;
  readonly retentionHooks?: DSourceRetentionHooks | undefined;
}

/**
 * The durable SSE delivery boundary. It claims ordinary work, encrypts the stream copy before entering the write
 * transaction, then appends that copy and settles the exact lease together. HTTP listener and socket writes remain
 * Task 9 work; this class deliberately exposes no new operation or control surface.
 */
export class SseDispatcher implements DeliveryDispatchHandler {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #visibilityGate: SseFrameVisibilityGate | undefined;
  readonly #hasConcreteWhatsAppVisibilityFence: boolean;
  readonly #retentionHooks: DSourceRetentionHooks | undefined;

  constructor(options: SseDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#fence = options.fence ?? assertDisclosable;
    this.#visibilityGate = options.visibilityGate;
    this.#hasConcreteWhatsAppVisibilityFence = options.hasConcreteWhatsAppVisibilityFence ?? false;
    this.#retentionHooks = options.retentionHooks;
  }

  /** Task 9 supplies a sealed synchronous ServerResponse callback to this retained-content writer. */
  writeLive(input: Omit<SealedSseFrameWrite, 'visibilityGate' | 'hasConcreteWhatsAppVisibilityFence'>): boolean {
    // Referencing the registered D hooks here makes their owner seam explicit without letting B2 register participants.
    void this.#retentionHooks;
    if (this.#visibilityGate === undefined) {
      if (input.whatsappMessageId !== null) return false;
      input.writeFrame(input.frame);
      return true;
    }
    return writeLiveSseFrame({
      ...input,
      visibilityGate: this.#visibilityGate,
      hasConcreteWhatsAppVisibilityFence: this.#hasConcreteWhatsAppVisibilityFence,
    });
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    let claimed: DeliveryClaimResult;
    try {
      claimed = await claimDelivery({
        store: this.#store,
        deliveryId,
        now: this.#now(),
        leaseMs: this.#leaseMs,
        newAttemptId: randomUUID,
        newLeaseToken: randomUUID,
        assertAccountLive: (accountId) => assertLiveGmailAccount(this.#config, accountId),
        preflight: async (row) => {
          await this.#fence(this.#fenceRequest(row));
        },
      });
    } catch (error) {
      const row = sseDelivery(this.#store, deliveryId);
      if (row !== undefined && isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.account_id, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const claim = claimed.claim;
    const row = sseDelivery(this.#store, claim.id);
    if (
      row === undefined ||
      row.target_kind !== 'sse' ||
      row.subscriber_id === null ||
      row.subscriber_version === null
    ) {
      releaseDeliveryClaim(this.#store, claim);
      throw new CommsError('BAD_DATA', 'the SSE delivery has no exact subscriber binding');
    }
    let record: DeliveryRecord;
    try {
      record = streamRecord(await this.#cipher.decrypt(deliveryLocation(claim.id), claim.encryptedRecord));
    } catch (error) {
      releaseDeliveryClaim(this.#store, claim);
      throw error;
    }
    const subscriber = subscriberFor(this.#store, row.subscriber_id, row.subscriber_version);
    // The nonce reservation has its own immediate transaction, so it must happen before the append/settle transaction.
    const encrypted = await this.#cipher.encrypt(streamLocation(claim.id), Buffer.from(record.cloudEventBytes, 'utf8'));
    try {
      await this.#fence(this.#fenceRequest(claim));
      await assertLiveGmailAccount(this.#config, claim.accountId);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, claim.accountId, this.#now()));
        return { state: 'terminal', deliveryId: claim.id };
      }
      releaseDeliveryClaim(this.#store, claim);
      throw error;
    }
    return this.#append(claim, row, subscriber.retentionMs, encrypted);
  }

  #append(
    claim: ClaimedDelivery,
    initial: CurrentSseDelivery,
    retentionMs: number,
    encryptedRecord: Buffer,
  ): DispatchResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const row = sseDelivery(this.#store, claim.id);
      if (row === undefined || !isCurrentDeliveryClaim(this.#store.database, claim))
        return { state: 'terminal', deliveryId: claim.id };
      if (row.expires_at <= now) {
        this.#expire(claim);
        return { state: 'expired', deliveryId: claim.id };
      }
      if (
        row.target_kind !== 'sse' ||
        row.subscriber_id !== initial.subscriber_id ||
        row.subscriber_version !== initial.subscriber_version ||
        !hasLiveSseLineage(this.#store, row)
      ) {
        this.#cancel(claim);
        return { state: 'terminal', deliveryId: claim.id };
      }
      const settings = this.#store.database
        .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
      if (settings?.enabled !== 1 || settings.switch_generation !== row.switch_generation) {
        this.#cancel(claim);
        return { state: 'terminal', deliveryId: claim.id };
      }
      if (settings.paused === 1) {
        releaseDeliveryClaimInTransaction(this.#store.database, claim);
        return { state: 'paused', deliveryId: claim.id };
      }
      const barrier = this.#store.database
        .prepare(
          'SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1',
        )
        .get(row.target_id, row.target_version) as { state: string } | undefined;
      if (barrier && barrier.state !== 'open') {
        releaseDeliveryClaimInTransaction(this.#store.database, claim);
        return { state: 'waiting-reset', deliveryId: claim.id };
      }
      this.#store.database
        .prepare(
          `INSERT INTO stream_log
           (id, delivery_id, rule_id, rule_version, target_id, target_version, subscriber_id, subscriber_version,
            event_id, account_id, whatsapp_message_id, whatsapp_visibility_version, encrypted_record, delivered_at,
            expires_at, switch_generation)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?)`,
        )
        .run(
          claim.id,
          claim.id,
          row.rule_id,
          row.rule_version,
          row.target_id,
          row.target_version,
          row.subscriber_id,
          row.subscriber_version,
          row.event_id,
          row.account_id,
          encryptedRecord,
          now,
          sseReplayDeadline(now, retentionMs),
          row.switch_generation,
        );
      const settled = this.#store.database
        .prepare(
          `UPDATE deliveries SET state = 'delivered', encrypted_record = NULL, lease_until = NULL
           WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
      if (settled !== 1) throw new CommsError('APPROVAL_VOID', 'the SSE delivery lease changed before it could settle');
      this.#dropRetainedReference(claim.id, now);
      return { state: 'delivered', deliveryId: claim.id };
    });
  }

  #fenceRequest(
    claim: Pick<
      ClaimedDelivery,
      'accountId' | 'ruleId' | 'ruleVersion' | 'targetId' | 'targetVersion' | 'switchGeneration'
    >,
  ): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: claim.accountId,
      boundary: 'dispatch',
      ruleId: claim.ruleId,
      ruleVersion: claim.ruleVersion,
      targetId: claim.targetId,
      targetVersion: claim.targetVersion,
      switchGeneration: claim.switchGeneration,
    };
  }

  #cancel(claim: ClaimedDelivery): void {
    const changed = this.#store.database
      .prepare(
        `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
    if (changed === 1) this.#dropRetainedReference(claim.id, this.#now());
  }

  #expire(claim: ClaimedDelivery): void {
    const changed = this.#store.database
      .prepare(
        `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(claim.id, claim.attemptId, claim.leaseToken, claim.leaseUntil).changes;
    if (changed === 1) this.#dropRetainedReference(claim.id, this.#now());
  }

  #dropRetainedReference(deliveryId: string, now: number): void {
    for (const target of removeRetainedDeliveryTargetReference(this.#store.database, deliveryId))
      purgeUnreferencedSystemTargets(this.#store.database, { ...target, now });
  }
}

function sseDelivery(store: EventDatabase, id: string): CurrentSseDelivery | undefined {
  return store.database
    .prepare(
      `SELECT d.id, d.decision_id, d.account_id, d.rule_id, d.rule_version, d.target_id, d.target_version,
              d.subscriber_id, d.subscriber_version, d.target_kind, d.encrypted_record, d.expires_at,
              d.switch_generation, decision.event_id
       FROM deliveries d JOIN decisions decision ON decision.id = d.decision_id WHERE d.id = ?`,
    )
    .get(id) as CurrentSseDelivery | undefined;
}

function subscriberFor(store: EventDatabase, subscriberId: string, subscriberVersion: number) {
  const row = store.database
    .prepare('SELECT document, revoked_at FROM subscriber_versions WHERE subscriber_id = ? AND version = ?')
    .get(subscriberId, subscriberVersion) as { document: string; revoked_at: number | null } | undefined;
  if (row === undefined || row.revoked_at !== null)
    throw new CommsError('APPROVAL_VOID', 'the SSE subscriber version is no longer live');
  try {
    return canonicalSseSubscriber(JSON.parse(row.document));
  } catch {
    throw new CommsError('APPROVAL_VOID', 'the stored SSE subscriber version is invalid');
  }
}

export function hasLiveSseLineage(store: EventDatabase, row: CurrentSseDelivery): boolean {
  if (row.subscriber_id === null || row.subscriber_version === null || !hasLiveDeliveryLineage(store.database, row))
    return false;
  return (
    store.database
      .prepare(
        `SELECT 1 AS present FROM subscriber_versions
         WHERE subscriber_id = ? AND version = ? AND revoked_at IS NULL`,
      )
      .get(row.subscriber_id, row.subscriber_version) !== undefined
  );
}

function streamRecord(value: Buffer): DeliveryRecord {
  try {
    const record = JSON.parse(value.toString('utf8')) as Partial<DeliveryRecord>;
    if (typeof record.cloudEventBytes !== 'string' || !Array.isArray(record.untrusted)) throw new Error('invalid');
    return record as DeliveryRecord;
  } catch {
    throw new CommsError('BAD_DATA', 'the persisted SSE delivery record is malformed');
  }
}

function deliveryLocation(id: string): EncryptedRecordLocation {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

export function streamLocation(id: string): EncryptedRecordLocation {
  return { table: 'stream_log', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

/**
 * Task 8's live writer seam. Task 9 supplies the sealed ServerResponse.write callback; this function owns the final
 * WhatsApp callback nesting and deliberately performs no await or scheduling between the fence and that callback.
 */
export function writeLiveSseFrame(input: SealedSseFrameWrite): boolean {
  if (input.whatsappMessageId === null) {
    input.writeFrame(input.frame);
    return true;
  }
  if (!input.hasConcreteWhatsAppVisibilityFence) return false;
  input.visibilityGate.withCurrentSseFrameVisibility(
    { accountId: input.accountId, whatsappMessageId: input.whatsappMessageId },
    () => input.writeFrame(input.frame),
  );
  return true;
}
