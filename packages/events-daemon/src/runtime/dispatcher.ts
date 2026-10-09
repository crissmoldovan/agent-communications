import { randomUUID } from 'node:crypto';
import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import type { CanonicalFullRuleDocument, DryRunTargetDocument } from '../domain/activation-documents.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { dryrunDeadline } from '../store/retention.ts';
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
import { EventExpiry } from './expiry.ts';
import { newLocalResetBarrier } from './reset.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';

interface CurrentDeliveryRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly encrypted_record: Uint8Array | null;
  readonly expires_at: number;
  readonly state: string;
  readonly switch_generation: number;
  readonly lease_until: number | null;
  readonly attempt_id: string | null;
  readonly lease_token: string | null;
  readonly event_id: string;
}

export interface DryRunLogEntry {
  readonly deliveryId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly targetId: string;
  readonly targetVersion: number;
  readonly eventId: string;
  readonly accountId: string;
  readonly deliveredAt: number;
  readonly expiresAt: number;
}

export interface DryRunRecord extends DryRunLogEntry {
  readonly record: DeliveryRecord;
}

export interface DryRunSummary {
  readonly retainedRecords: number;
  readonly earliestExpiry: number | null;
}

export type DispatchResult =
  | { readonly state: 'delivered'; readonly deliveryId: string }
  | { readonly state: 'issued'; readonly deliveryId: string }
  | {
      readonly state:
        | 'waiting-cap'
        | 'waiting-reset'
        | 'waiting-order'
        | 'paused'
        | 'busy'
        | 'missing'
        | 'terminal'
        | 'expired'
        | 'unreadable';
      readonly deliveryId: string;
    };

/** One target-kind handler; each adapter owns its own boundary and may return the common delivery state. */
export interface DeliveryDispatchHandler {
  dispatch(deliveryId: string): Promise<DispatchResult>;
}

export interface DeliveryDispatcherOptions {
  readonly store: EventDatabase;
  readonly dryrun: DeliveryDispatchHandler;
  readonly webhook: DeliveryDispatchHandler;
  readonly sse: DeliveryDispatchHandler;
  readonly now?: (() => number) | undefined;
}

/**
 * The owner/scheduler-facing routing facade. It selects only from the closed B2 target-kind set and leaves every
 * target representation opaque to the selected adapter, so dispatch can never rebuild a prepared CloudEvent.
 */
export class DeliveryDispatcher {
  readonly #store: EventDatabase;
  readonly #dryrun: DeliveryDispatchHandler;
  readonly #webhook: DeliveryDispatchHandler;
  readonly #sse: DeliveryDispatchHandler;
  readonly #now: () => number;

  constructor(options: DeliveryDispatcherOptions) {
    this.#store = options.store;
    this.#dryrun = options.dryrun;
    this.#webhook = options.webhook;
    this.#sse = options.sse;
    this.#now = options.now ?? Date.now;
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    const row = this.#store.database.prepare('SELECT target_key FROM deliveries WHERE id = ?').get(deliveryId) as
      | { target_key: string }
      | undefined;
    if (row === undefined) return { state: 'missing', deliveryId };
    return this.#handler(row.target_key).dispatch(deliveryId);
  }

  /** Recovery uses the same kind router, so a later adapter cannot be claimed by the dry-run path. */
  async recoverLeases(): Promise<readonly DispatchResult[]> {
    const ids = this.#store.database
      .prepare("SELECT id FROM deliveries WHERE state = 'disclosing' AND lease_until <= ? ORDER BY id")
      .all(this.#now()) as Array<{ id: string }>;
    return Promise.all(ids.map(({ id }) => this.dispatch(id)));
  }

  #handler(targetKey: string): DeliveryDispatchHandler {
    if (targetKey.startsWith('dryrun:')) return this.#dryrun;
    if (targetKey.startsWith('webhook:')) return this.#webhook;
    if (targetKey.startsWith('sse:')) return this.#sse;
    throw new CommsError('BAD_DATA', 'the persisted delivery has an unknown target kind');
  }
}

export interface DryRunDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly expiry?: EventExpiry | undefined;
  /** Production uses the shared resolver; tests inject refusal cases at the exact dispatch/read boundary. */
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  /** Test-only interruption point: every effect remains in one immediate transaction. */
  readonly beforeCommit?: (() => void) | undefined;
}

/**
 * The sole B1 plaintext-to-local-record boundary. It atomically claims and charges a delivery, proves its exact
 * authority before decrypting, encrypts the retained presentation outside its write transaction, then appends and
 * settles only the exact current claim.
 */
export class DryRunDispatcher {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #expiry: EventExpiry;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #beforeCommit: (() => void) | undefined;

  constructor(options: DryRunDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#expiry = options.expiry ?? new EventExpiry(options.store, options.now ?? Date.now);
    this.#fence = options.fence ?? assertDisclosable;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#beforeCommit = options.beforeCommit;
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
        assertAccountLive: (accountId) => assertLiveGmailAccount(this.#config, accountId),
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
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, candidate.account_id, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const row = claimed.claim;
    let rule: CanonicalFullRuleDocument;
    let target: DryRunTargetDocument;
    try {
      rule = ruleFor(this.#store, row.ruleId, row.ruleVersion);
      target = dryRunTarget(rule, row.targetId, row.targetVersion);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.accountId, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }

    let plaintext: Buffer;
    try {
      plaintext = await this.#cipher.decrypt(deliveryLocation(row.id), row.encryptedRecord);
    } catch (error) {
      if (error instanceof RecordStorageError) {
        this.#markUnreadable(row, true);
        return { state: 'unreadable', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }
    if (!isDeliveryRecord(plaintext)) {
      this.#markUnreadable(row, true);
      return { state: 'unreadable', deliveryId };
    }

    // encrypt opens its own nonce reservation transaction.  It must precede this boundary's immediate transaction.
    const localRecord = await this.#cipher.encrypt(dryRunLocation(row.id), plaintext);
    // D9: the account is read again immediately before the append; one removed during decryption or encryption is
    // purged here, and nothing is appended for it.
    try {
      await this.#fence(this.#fenceRequest(row));
      await assertLiveGmailAccount(this.#config, row.accountId);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.accountId, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      releaseDeliveryClaim(this.#store, row);
      throw error;
    }
    return this.#append(row, target, localRecord);
  }

  list(): readonly DryRunLogEntry[] {
    this.#expiry.sweep();
    return this.#store.database
      .prepare(
        `SELECT delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, delivered_at, expires_at
         FROM dryrun_log ORDER BY delivered_at DESC, delivery_id DESC`,
      )
      .all()
      .map((row) => entry(row as Record<string, unknown>));
  }

  /** Content-free diagnostics for doctor/status surfaces. */
  summary(): DryRunSummary {
    this.#expiry.sweep();
    const row = this.#store.database
      .prepare('SELECT count(*) AS retained_records, min(expires_at) AS earliest_expiry FROM dryrun_log')
      .get() as { retained_records: number; earliest_expiry: number | null };
    return { retainedRecords: row.retained_records, earliestExpiry: row.earliest_expiry };
  }

  async read(deliveryId: string): Promise<DryRunRecord> {
    this.#expiry.sweep();
    const row = this.#store.database
      .prepare(
        `SELECT l.delivery_id, l.rule_id, l.rule_version, l.target_id, l.target_version, l.event_id, l.account_id,
                l.encrypted_record, l.delivered_at, l.expires_at, d.switch_generation
         FROM dryrun_log l JOIN deliveries d ON d.id = l.delivery_id WHERE l.delivery_id = ?`,
      )
      .get(deliveryId) as
      | (Record<string, unknown> & { encrypted_record: Uint8Array; switch_generation: number })
      | undefined;
    if (!row) throw new CommsError('NOT_FOUND', 'the retained local record does not exist');
    if (Number(row.expires_at) <= this.#now()) {
      this.#store.immediate(() => {
        this.#store.database
          .prepare('DELETE FROM dryrun_log WHERE delivery_id = ? AND expires_at <= ?')
          .run(deliveryId, this.#now());
      });
      throw new CommsError('NOT_FOUND', 'the retained local record has expired');
    }
    const rule = ruleFor(this.#store, String(row.rule_id), Number(row.rule_version));
    dryRunTarget(rule, String(row.target_id), Number(row.target_version));
    const readFence: ActiveDisclosableRequest = {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: String(row.account_id),
      boundary: 'read',
      ruleId: String(row.rule_id),
      ruleVersion: Number(row.rule_version),
      targetId: String(row.target_id),
      targetVersion: Number(row.target_version),
      switchGeneration: Number(row.switch_generation),
    };
    const fenced = async (): Promise<void> => {
      try {
        await this.#fence(readFence);
      } catch (error) {
        if (isRemovedAccountError(error))
          this.#store.immediate(() =>
            purgeRemovedAccountWork(this.#store.database, String(row.account_id), this.#now()),
          );
        throw error;
      }
    };
    await fenced();
    let plaintext: Buffer;
    try {
      plaintext = await this.#cipher.decrypt(dryRunLocation(deliveryId), row.encrypted_record);
    } catch (error) {
      if (error instanceof RecordStorageError) {
        this.#store.immediate(() => {
          this.#store.database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(deliveryId);
        });
        newLocalResetBarrier(this.#store, String(row.target_id), Number(row.target_version));
        throw new CommsError('BAD_DATA', 'the retained local record is unreadable and was purged');
      }
      throw error;
    }
    if (!isDeliveryRecord(plaintext)) {
      this.#store.immediate(() => {
        this.#store.database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(deliveryId);
      });
      throw new CommsError('BAD_DATA', 'the retained local record is malformed and was purged');
    }
    // The decryption awaited: a disable, a revocation or an account removal may have purged this record meanwhile.
    // The fence runs again and the record must still be there before any of its content is returned.
    await fenced();
    const still = this.#store.database
      .prepare('SELECT 1 AS present FROM dryrun_log WHERE delivery_id = ?')
      .get(deliveryId);
    if (still === undefined) throw new CommsError('NOT_FOUND', 'the retained local record no longer exists');
    return { ...entry(row), record: JSON.parse(plaintext.toString('utf8')) as DeliveryRecord };
  }

  /** Claims interrupted local work again; a committed append is already terminal and is never charged twice. */
  async recoverLeases(): Promise<readonly DispatchResult[]> {
    const now = this.#now();
    const ids = this.#store.database
      .prepare("SELECT id FROM deliveries WHERE state = 'disclosing' AND lease_until <= ? ORDER BY id")
      .all(now) as Array<{ id: string }>;
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

  #append(row: ClaimedDelivery, target: DryRunTargetDocument, encryptedRecord: Buffer): DispatchResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const current = deliveryById(this.#store, row.id);
      if (current === undefined || !isCurrentDeliveryClaim(this.#store.database, row))
        return { state: 'terminal', deliveryId: row.id };
      if (current.expires_at <= now) {
        this.#expire(row);
        return { state: 'expired', deliveryId: row.id };
      }
      if (!hasLiveDeliveryLineage(this.#store.database, current)) {
        this.#cancel(row);
        return { state: 'terminal', deliveryId: row.id };
      }
      const setting = this.#store.database
        .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
      if (setting?.enabled !== 1 || setting.switch_generation !== current.switch_generation) {
        this.#cancel(row);
        return { state: 'terminal', deliveryId: row.id };
      }
      // A pause that began after the claim still wins: the work waits, encrypted, for a resume.
      if (setting.paused === 1) {
        releaseDeliveryClaimInTransaction(this.#store.database, row);
        return { state: 'paused', deliveryId: row.id };
      }
      const barrier = this.#store.database
        .prepare(
          `SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1`,
        )
        .get(current.target_id, current.target_version) as { state: string } | undefined;
      if (barrier && barrier.state !== 'open') {
        releaseDeliveryClaimInTransaction(this.#store.database, row);
        return { state: 'waiting-reset', deliveryId: row.id };
      }
      const logExpiresAt = dryrunDeadline(now, target.retentionMs);
      this.#beforeCommit?.();
      this.#store.database
        .prepare(
          `INSERT INTO dryrun_log (delivery_id, rule_id, rule_version, target_id, target_version, event_id, account_id, encrypted_record, delivered_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          current.id,
          current.rule_id,
          current.rule_version,
          current.target_id,
          current.target_version,
          current.event_id,
          current.account_id,
          encryptedRecord,
          now,
          logExpiresAt,
        );
      const settled = this.#store.database
        .prepare(
          `UPDATE deliveries SET state = 'delivered', encrypted_record = NULL, lease_until = NULL
           WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
      if (settled !== 1) return { state: 'terminal', deliveryId: row.id };
      this.#dropRetainedTargetReference(row.id, now);
      return { state: 'delivered', deliveryId: row.id };
    });
  }

  #cancel(row: ClaimedDelivery): void {
    const changed = this.#store.database
      .prepare(
        `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
    if (changed === 1) this.#dropRetainedTargetReference(row.id, this.#now());
  }

  #expire(row: ClaimedDelivery): void {
    const changed = this.#store.database
      .prepare(
        `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL
         WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
    if (changed === 1) this.#dropRetainedTargetReference(row.id, this.#now());
  }

  #markUnreadable(row: ClaimedDelivery, reset: boolean): void {
    const marked = this.#store.immediate(() => {
      this.#store.database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(row.id);
      const changed = this.#store.database
        .prepare(
          `UPDATE deliveries SET state = 'content-unreadable', encrypted_record = NULL, lease_until = NULL
           WHERE id = ? AND state = 'disclosing' AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(row.id, row.attemptId, row.leaseToken, row.leaseUntil).changes;
      if (changed === 1) this.#dropRetainedTargetReference(row.id, this.#now());
      return changed === 1;
    });
    if (reset && marked) newLocalResetBarrier(this.#store, row.targetId, row.targetVersion);
  }

  #dropRetainedTargetReference(deliveryId: string, now: number): void {
    for (const target of removeRetainedDeliveryTargetReference(this.#store.database, deliveryId))
      purgeUnreferencedSystemTargets(this.#store.database, { ...target, now });
  }
}

function deliveryById(store: EventDatabase, id: string): CurrentDeliveryRow | undefined {
  return store.database
    .prepare(
      `SELECT d.id, d.decision_id, d.account_id, d.rule_id, d.rule_version, d.target_id, d.target_version,
              d.encrypted_record, d.expires_at, d.state, d.switch_generation, d.lease_until, d.attempt_id,
              d.lease_token, decision.event_id
       FROM deliveries d JOIN decisions decision ON decision.id = d.decision_id WHERE d.id = ?`,
    )
    .get(id) as CurrentDeliveryRow | undefined;
}

function ruleFor(store: EventDatabase, ruleId: string, ruleVersion: number): CanonicalFullRuleDocument {
  const row = store.database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as { document: string } | undefined;
  if (!row) throw new CommsError('APPROVAL_VOID', 'the exact rule for this retained delivery is missing');
  try {
    return JSON.parse(row.document) as CanonicalFullRuleDocument;
  } catch {
    throw new CommsError('APPROVAL_VOID', 'the exact rule for this retained delivery is invalid');
  }
}

function dryRunTarget(rule: CanonicalFullRuleDocument, targetId: string, targetVersion: number): DryRunTargetDocument {
  const target = rule.targets.find(
    (candidate) => candidate.targetId === targetId && candidate.version === targetVersion,
  );
  if (target?.kind !== 'dry-run')
    throw new CommsError('APPROVAL_VOID', 'the retained delivery does not name an authorised local target');
  return target;
}

function deliveryLocation(id: string) {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function dryRunLocation(id: string) {
  return { table: 'dryrun_log', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function isDeliveryRecord(value: Buffer): boolean {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<DeliveryRecord>;
    return (
      typeof parsed.cloudEventBytes === 'string' &&
      Array.isArray(parsed.untrusted) &&
      parsed.untrusted.every((pointer) => typeof pointer === 'string') &&
      parsed.representation === 'plain'
    );
  } catch {
    return false;
  }
}

function entry(row: Record<string, unknown>): DryRunLogEntry {
  return {
    deliveryId: String(row.delivery_id),
    ruleId: String(row.rule_id),
    ruleVersion: Number(row.rule_version),
    targetId: String(row.target_id),
    targetVersion: Number(row.target_version),
    eventId: String(row.event_id),
    accountId: String(row.account_id),
    deliveredAt: Number(row.delivered_at),
    expiresAt: Number(row.expires_at),
  };
}
