import { type ApprovalStore, CommsError, type ConfigStore } from '@agentcomms/core';
import type { CanonicalFullRuleDocument, DryRunTargetDocument } from '../domain/activation-documents.ts';
import type { EventDatabase } from '../store/database.ts';
import { type EventRecordCipher, RecordStorageError } from '../store/records.ts';
import { dryrunDeadline } from '../store/retention.ts';
import { isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { DeliveryRecord } from './deliveries.ts';
import { type ActiveDisclosableRequest, assertDisclosable } from './disclosure-fence.ts';
import { EventExpiry } from './expiry.ts';
import { newLocalResetBarrier } from './reset.ts';

type DeliveryState = 'queued' | 'retryable' | 'disclosing' | 'delivered' | 'retention-expired' | 'cancelled';

interface DeliveryRow {
  readonly id: string;
  readonly decision_id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly encrypted_record: Uint8Array | null;
  readonly expires_at: number;
  readonly state: DeliveryState;
  readonly switch_generation: number;
  readonly lease_until: number | null;
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
  | {
      readonly state: 'waiting-cap' | 'waiting-reset' | 'busy' | 'missing' | 'terminal' | 'expired' | 'unreadable';
      readonly deliveryId: string;
    };

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
 * The sole B1 plaintext-to-local-record boundary.  It claims a delivery, proves its exact authority before decrypting,
 * encrypts the retained presentation outside its write transaction, then atomically charges, appends and settles.
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
    const claimed = this.#claim(deliveryId);
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    if (this.#barrierClosed(claimed.row)) {
      this.#release(claimed.row);
      return { state: 'waiting-reset', deliveryId };
    }
    let rule: CanonicalFullRuleDocument;
    let target: DryRunTargetDocument;
    try {
      rule = ruleFor(this.#store, claimed.row.rule_id, claimed.row.rule_version);
      target = dryRunTarget(rule, claimed.row.target_id, claimed.row.target_version);
      await this.#fence(this.#fenceRequest(claimed.row));
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, claimed.row.account_id, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      this.#release(claimed.row);
      throw error;
    }

    let plaintext: Buffer;
    try {
      plaintext = await this.#cipher.decrypt(deliveryLocation(claimed.row.id), claimed.row.encrypted_record);
    } catch (error) {
      if (error instanceof RecordStorageError) {
        this.#markUnreadable(claimed.row, true);
        return { state: 'unreadable', deliveryId };
      }
      this.#release(claimed.row);
      throw error;
    }
    if (!isDeliveryRecord(plaintext)) {
      this.#markUnreadable(claimed.row, true);
      return { state: 'unreadable', deliveryId };
    }

    // encrypt opens its own nonce reservation transaction.  It must precede this boundary's immediate transaction.
    const localRecord = await this.#cipher.encrypt(dryRunLocation(claimed.row.id), plaintext);
    return this.#append(claimed.row, target, localRecord);
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
    try {
      await this.#fence({
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
      });
    } catch (error) {
      if (isRemovedAccountError(error))
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, String(row.account_id), this.#now()));
      throw error;
    }
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

  #fenceRequest(row: DeliveryRow): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: row.account_id,
      boundary: 'dispatch',
      ruleId: row.rule_id,
      ruleVersion: row.rule_version,
      targetId: row.target_id,
      targetVersion: row.target_version,
      switchGeneration: row.switch_generation,
    };
  }

  #claim(
    deliveryId: string,
  ):
    | { readonly kind: Exclude<DispatchResult['state'], 'delivered' | 'unreadable'> }
    | { readonly kind: 'claimed'; readonly row: DeliveryRow } {
    return this.#store.immediate(() => {
      const row = deliveryById(this.#store, deliveryId);
      if (!row) return { kind: 'missing' };
      const now = this.#now();
      if (row.expires_at <= now) {
        if (['queued', 'retryable', 'disclosing'].includes(row.state)) this.#expire(row.id);
        return { kind: 'expired' };
      }
      if (!['queued', 'retryable', 'disclosing'].includes(row.state)) return { kind: 'terminal' };
      if (row.state === 'disclosing' && (row.lease_until ?? 0) > now) return { kind: 'busy' };
      const leaseUntil = now + this.#leaseMs;
      this.#store.database
        .prepare(
          "UPDATE deliveries SET state = 'disclosing', lease_until = ?, attempts = attempts + 1 WHERE id = ? AND state IN ('queued', 'retryable', 'disclosing')",
        )
        .run(leaseUntil, row.id);
      return { kind: 'claimed', row: { ...row, state: 'disclosing', lease_until: leaseUntil } };
    });
  }

  #append(row: DeliveryRow, target: DryRunTargetDocument, encryptedRecord: Buffer): DispatchResult {
    const now = this.#now();
    return this.#store.immediate(() => {
      const current = deliveryById(this.#store, row.id);
      if (current?.state !== 'disclosing' || current.lease_until !== row.lease_until)
        return { state: 'terminal', deliveryId: row.id };
      if (current.expires_at <= now) {
        this.#expire(current.id);
        return { state: 'expired', deliveryId: row.id };
      }
      const setting = this.#store.database
        .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
        .get() as { enabled: number; switch_generation: number } | undefined;
      if (setting?.enabled !== 1 || setting.switch_generation !== current.switch_generation) {
        this.#cancel(current.id);
        return { state: 'terminal', deliveryId: row.id };
      }
      const barrier = this.#store.database
        .prepare(
          `SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1`,
        )
        .get(current.target_id, current.target_version) as { state: string } | undefined;
      if (barrier && barrier.state !== 'open') {
        this.#release(current);
        return { state: 'waiting-reset', deliveryId: row.id };
      }
      // The rolling window belongs to the rule, not to one version: a tightening that lowers the cap starts no fresh
      // window, so every charge any version of this rule made in the last hour counts against this version's cap (D2:
      // "no new cap charge can exceed the lower rolling-window limit").
      const since = now - 60 * 60 * 1000;
      const cap = this.#store.database
        .prepare('SELECT count(*) AS count FROM delivery_cap_charges WHERE rule_id = ? AND charged_at > ?')
        .get(current.rule_id, since) as { count: number };
      const rule = ruleFor(this.#store, current.rule_id, current.rule_version);
      if (cap.count >= rule.deliveryRateCap) {
        this.#release(current);
        return { state: 'waiting-cap', deliveryId: row.id };
      }
      const logExpiresAt = dryrunDeadline(now, target.retentionMs);
      this.#beforeCommit?.();
      this.#store.database
        .prepare(
          'INSERT INTO delivery_cap_charges (delivery_id, rule_id, rule_version, charged_at) VALUES (?, ?, ?, ?)',
        )
        .run(current.id, current.rule_id, current.rule_version, now);
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
      this.#store.database
        .prepare(
          "UPDATE deliveries SET state = 'delivered', encrypted_record = NULL, cap_charged_at = ?, lease_until = NULL WHERE id = ?",
        )
        .run(now, current.id);
      return { state: 'delivered', deliveryId: row.id };
    });
  }

  #release(row: DeliveryRow): void {
    this.#store.database
      .prepare(
        "UPDATE deliveries SET state = 'queued', lease_until = NULL WHERE id = ? AND state = 'disclosing' AND lease_until = ?",
      )
      .run(row.id, row.lease_until);
  }

  #cancel(deliveryId: string): void {
    this.#store.database
      .prepare("UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL WHERE id = ?")
      .run(deliveryId);
  }

  #expire(deliveryId: string): void {
    this.#store.database
      .prepare(
        "UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL WHERE id = ?",
      )
      .run(deliveryId);
  }

  #barrierClosed(row: Pick<DeliveryRow, 'target_id' | 'target_version'>): boolean {
    const barrier = this.#store.database
      .prepare(
        `SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1`,
      )
      .get(row.target_id, row.target_version) as { state: string } | undefined;
    return barrier !== undefined && barrier.state !== 'open';
  }

  #markUnreadable(row: DeliveryRow, reset: boolean): void {
    this.#store.immediate(() => {
      this.#store.database.prepare('DELETE FROM dryrun_log WHERE delivery_id = ?').run(row.id);
      this.#store.database
        .prepare(
          "UPDATE deliveries SET state = 'content-unreadable', encrypted_record = NULL, lease_until = NULL WHERE id = ?",
        )
        .run(row.id);
    });
    if (reset) newLocalResetBarrier(this.#store, row.target_id, row.target_version);
  }
}

function deliveryById(store: EventDatabase, id: string): DeliveryRow | undefined {
  return store.database
    .prepare(
      `SELECT d.id, d.decision_id, d.account_id, d.rule_id, d.rule_version, d.target_id, d.target_version,
              d.encrypted_record, d.expires_at, d.state, d.switch_generation, d.lease_until, decision.event_id
       FROM deliveries d JOIN decisions decision ON decision.id = d.decision_id WHERE d.id = ?`,
    )
    .get(id) as DeliveryRow | undefined;
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
