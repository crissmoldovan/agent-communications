import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { type ApprovalStore, CommsError, type ConfigStore, sha256Hex } from '@agentcomms/core';
import {
  canonicalSecretWebhookUrl,
  canonicalWebhookTarget,
  type WebhookTargetDocument,
} from '../domain/webhook-target.ts';
import {
  addressSetDigest,
  connectPinnedTcp,
  connectPinnedTls,
  type PinnedTcpOptions,
  type PinnedTlsOptions,
  preparePinnedConnection,
  requestBytesForPinnedConnection,
} from '../network/pinned-connection.ts';
import type { AddressResolver } from '../network/resolver.ts';
import type { EventDatabase } from '../store/database.ts';
import type { EventRecordCipher } from '../store/records.ts';
import { assertLiveGmailAccount, isRemovedAccountError, purgeRemovedAccountWork } from './account-fence.ts';
import type { DeliveryRecord } from './deliveries.ts';
import {
  type ClaimedDelivery,
  claimDelivery,
  type DeliveryClaimResult,
  hasLiveDeliveryLineage,
  isCurrentDeliveryClaim,
  releaseDeliveryClaimInTransaction,
} from './delivery-claim.ts';
import type { ActiveDisclosableRequest } from './disclosure-fence.ts';
import { assertDisclosable } from './disclosure-fence.ts';
import type { DeliveryDispatchHandler, DispatchResult } from './dispatcher.ts';
import { purgeUnreferencedSystemTargets, removeRetainedDeliveryTargetReference } from './target-version-references.ts';
import { signStandardWebhook } from './webhook-signing.ts';

export type WebhookFencePhase = 'dns' | 'tcp' | 'tls' | 'write';

/** Test-only durable-boundary interruption points. They are constructor seams, never configuration or a public surface. */
export type WebhookCrashPoint =
  | 'before-claim'
  | 'after-claim'
  | 'after-dns'
  | 'after-tcp'
  | 'after-tls'
  | 'after-write'
  | 'after-response'
  | 'after-outcome';

export interface WebhookSecretMaterial {
  readonly generation: number;
  readonly lifecycle: 'current' | 'overlap';
  readonly secretDigest: string;
  readonly material: string;
}

export type WebhookSecretReader = (input: {
  readonly targetId: string;
  readonly targetVersion: number;
  readonly targetDigest: string;
  readonly purpose: 'secret-url' | 'webhook-signing';
}) => Promise<readonly WebhookSecretMaterial[]>;

/** Content-free network fact handed to Task 7's durable outcome/recovery owner. */
export type WebhookOutcome =
  | { readonly kind: 'response'; readonly status: number; readonly success: boolean }
  | { readonly kind: 'network' };

/** A 3xx is deliberately an ordinary non-success response: webhook transport never follows a Location. */
export function classifyWebhookResponseStatus(status: number): Extract<WebhookOutcome, { readonly kind: 'response' }> {
  return { kind: 'response', status, success: status >= 200 && status < 300 };
}

export interface WebhookDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly secretReader: WebhookSecretReader;
  readonly resolver?: AddressResolver | undefined;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  readonly fence?: ((request: ActiveDisclosableRequest) => Promise<unknown>) | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  /** Task 7 supplies the durable settlement; this adapter passes only a content-free outcome after bytes leave. */
  readonly onOutcome?: ((claim: ClaimedDelivery, outcome: WebhookOutcome) => Promise<void>) | undefined;
  /** Test-only point before a gate; production supplies no hook. */
  readonly beforeGate?: ((phase: WebhookFencePhase, claim: ClaimedDelivery) => void | Promise<void>) | undefined;
  /** Test-only interruption seam. It cannot be enabled through a target, config, CLI or MCP input. */
  readonly testFailpoint?: ((point: WebhookCrashPoint, claim?: ClaimedDelivery) => void) | undefined;
}

interface LoadedTarget {
  readonly document: WebhookTargetDocument;
  readonly digest: string;
  readonly url: string;
  readonly signing: readonly WebhookSecretMaterial[];
  readonly urlSecrets: readonly WebhookSecretMaterial[];
}

interface DeliveryRow {
  readonly id: string;
  readonly account_id: string;
  readonly rule_id: string;
  readonly rule_version: number;
  readonly target_id: string;
  readonly target_version: number;
  readonly encrypted_record: Uint8Array | null;
  readonly expires_at: number;
  readonly switch_generation: number;
  readonly target_key: string;
}

/**
 * The network half of webhook delivery. Its default outcome seam durably settles retry, dead-letter and stale-owner
 * completion; a test or future owner may replace that seam while keeping the exact claim disclosing after bytes cross
 * the wire.
 */
export class WebhookDispatcher implements DeliveryDispatchHandler {
  readonly #store: EventDatabase;
  readonly #cipher: Pick<EventRecordCipher, 'decrypt'>;
  readonly #approvals: Pick<ApprovalStore, 'get'>;
  readonly #config: Pick<ConfigStore, 'load'>;
  readonly #secretReader: WebhookSecretReader;
  readonly #resolver: AddressResolver | undefined;
  readonly #now: () => number;
  readonly #leaseMs: number;
  readonly #fence: (request: ActiveDisclosableRequest) => Promise<unknown>;
  readonly #tcpConnect: (options: PinnedTcpOptions) => Promise<net.Socket>;
  readonly #tlsConnect: (options: PinnedTlsOptions) => Promise<tls.TLSSocket>;
  readonly #onOutcome: ((claim: ClaimedDelivery, outcome: WebhookOutcome) => Promise<void>) | undefined;
  readonly #beforeGate: ((phase: WebhookFencePhase, claim: ClaimedDelivery) => void | Promise<void>) | undefined;
  readonly #testFailpoint: ((point: WebhookCrashPoint, claim?: ClaimedDelivery) => void) | undefined;

  constructor(options: WebhookDispatcherOptions) {
    this.#store = options.store;
    this.#cipher = options.cipher;
    this.#approvals = options.approvals;
    this.#config = options.config;
    this.#secretReader = options.secretReader;
    this.#resolver = options.resolver;
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 30_000;
    this.#fence = options.fence ?? assertDisclosable;
    this.#tcpConnect = options.tcpConnect ?? connectPinnedTcp;
    this.#tlsConnect = options.tlsConnect ?? connectPinnedTls;
    this.#onOutcome = options.onOutcome ?? ((claim, outcome) => this.#settleOutcome(claim, outcome));
    this.#beforeGate = options.beforeGate;
    this.#testFailpoint = options.testFailpoint;
  }

  async dispatch(deliveryId: string): Promise<DispatchResult> {
    this.#testFailpoint?.('before-claim');
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
      const row = delivery(this.#store, deliveryId);
      if (row !== undefined && isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, row.account_id, this.#now()));
        return { state: 'terminal', deliveryId };
      }
      throw error;
    }
    if (claimed.kind !== 'claimed') return { state: claimed.kind, deliveryId };
    const claim = claimed.claim;
    this.#testFailpoint?.('after-claim', claim);
    let record: DeliveryRecord;
    try {
      record = parseDeliveryRecord(await this.#cipher.decrypt(deliveryLocation(claim.id), claim.encryptedRecord));
    } catch (error) {
      this.#release(claim);
      throw error;
    }
    let target: LoadedTarget;
    try {
      target = await this.#loadTarget(claim);
    } catch (error) {
      this.#release(claim);
      throw error;
    }
    const preparedDns = await this.#prepareGate(claim, target, 'dns');
    if (preparedDns !== null) return preparedDns;
    const gateDns = this.#finalGate(claim, target);
    if (gateDns !== null) return gateDns;
    const connection = await preparePinnedConnection({
      url: target.url,
      approvedAddressSet: target.document.approvedAddressSet,
      approvedAddressSetDigest: addressSetDigest(target.document.approvedAddressSet),
      ...(this.#resolver === undefined ? {} : { resolver: this.#resolver }),
    });
    this.#testFailpoint?.('after-dns', claim);
    const preparedTcp = await this.#prepareGate(claim, target, 'tcp');
    if (preparedTcp !== null) return preparedTcp;
    const gateTcp = this.#finalGate(claim, target);
    if (gateTcp !== null) return gateTcp;
    const tcp = await this.#tcpConnect({ host: connection.address, port: connection.port });
    this.#testFailpoint?.('after-tcp', claim);
    let socket: net.Socket | tls.TLSSocket = tcp;
    if (connection.useTls) {
      const preparedTls = await this.#prepareGate(claim, target, 'tls');
      if (preparedTls !== null) {
        tcp.destroy();
        return preparedTls;
      }
      const gateTls = this.#finalGate(claim, target);
      if (gateTls !== null) {
        tcp.destroy();
        return gateTls;
      }
      socket = await this.#tlsConnect({ socket: tcp, ...connection.tls });
      this.#testFailpoint?.('after-tls', claim);
    }
    const current = target.signing.find((secret) => secret.lifecycle === 'current');
    if (current === undefined) {
      socket.destroy();
      this.#release(claim);
      throw new CommsError('APPROVAL_VOID', 'the webhook target has no current signing generation');
    }
    const headers = signStandardWebhook({
      id: claim.id,
      timestamp: Math.floor(this.#now() / 1000),
      body: record.cloudEventBytes,
      current: current.material,
      overlap: target.signing.filter((secret) => secret.lifecycle === 'overlap').map((secret) => secret.material),
    });
    const request = requestBytesForPinnedConnection(connection, 'POST', Buffer.from(record.cloudEventBytes, 'utf8'), {
      'Content-Type': 'application/cloudevents+json; charset=utf-8',
      ...headers,
    });
    const preparedWrite = await this.#prepareGate(claim, target, 'write');
    if (preparedWrite !== null) {
      socket.destroy();
      return preparedWrite;
    }
    const gateWrite = this.#finalGate(claim, target);
    if (gateWrite !== null) {
      socket.destroy();
      return gateWrite;
    }
    // The write is deliberately synchronous with its immediately preceding gate: no callback or await may intervene.
    socket.write(request);
    this.#testFailpoint?.('after-write', claim);
    const outcome = await responseStatus(socket)
      .then(classifyWebhookResponseStatus)
      .catch((): WebhookOutcome => ({ kind: 'network' }));
    this.#testFailpoint?.('after-response', claim);
    await this.#onOutcome?.(claim, outcome);
    this.#testFailpoint?.('after-outcome', claim);
    return { state: 'issued', deliveryId: claim.id };
  }

  /**
   * Completion runs after an await for the network response. Re-read account authority before the database transaction;
   * the transaction then compares the exact lease ownership, generation, lineage and deadline before it can retry.
   */
  async #settleOutcome(claim: ClaimedDelivery, outcome: WebhookOutcome): Promise<void> {
    try {
      await this.#fence(this.#fenceRequest(claim));
      await assertLiveGmailAccount(this.#config, claim.accountId);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, claim.accountId, this.#now()));
      }
      settleWebhookOutcome({ store: this.#store, claim, outcome, now: this.#now(), authorityLost: true });
      return;
    }
    settleWebhookOutcome({ store: this.#store, claim, outcome, now: this.#now() });
  }

  async #loadTarget(claim: ClaimedDelivery): Promise<LoadedTarget> {
    const row = this.#store.database
      .prepare('SELECT document, digest, revoked_at FROM target_versions WHERE target_id = ? AND version = ?')
      .get(claim.targetId, claim.targetVersion) as
      | { document: string; digest: string; revoked_at: number | null }
      | undefined;
    if (!row || row.revoked_at !== null) throw new CommsError('APPROVAL_VOID', 'the webhook target is no longer live');
    let document: WebhookTargetDocument;
    try {
      document = canonicalWebhookTarget(JSON.parse(row.document));
    } catch {
      throw new CommsError('APPROVAL_VOID', 'the stored webhook target is invalid');
    }
    if (
      document.targetId !== claim.targetId ||
      document.version !== claim.targetVersion ||
      sha256Hex(row.document) !== row.digest
    )
      throw new CommsError('APPROVAL_VOID', 'the stored webhook target no longer has its immutable binding');
    const signing = await this.#secretReader({
      targetId: claim.targetId,
      targetVersion: claim.targetVersion,
      targetDigest: row.digest,
      purpose: 'webhook-signing',
    });
    let url: string;
    let urlSecrets: readonly WebhookSecretMaterial[] = [];
    if (document.url.kind === 'plain') {
      url = document.url.value;
    } else {
      const references = await this.#secretReader({
        targetId: claim.targetId,
        targetVersion: claim.targetVersion,
        targetDigest: row.digest,
        purpose: 'secret-url',
      });
      const current = references.find((secret) => secret.lifecycle === 'current');
      if (current === undefined) throw new CommsError('APPROVAL_VOID', 'the webhook URL secret is unavailable');
      const canonical = canonicalSecretWebhookUrl(current.material);
      if (
        canonical.descriptor.scheme !== document.url.scheme ||
        canonical.descriptor.host !== document.url.host ||
        canonical.descriptor.port !== document.url.port ||
        canonical.descriptor.sha256 !== document.url.sha256
      ) {
        throw new CommsError('APPROVAL_VOID', 'the webhook URL secret does not match its immutable target');
      }
      url = canonical.value;
      urlSecrets = [current];
    }
    if (signing.filter((secret) => secret.lifecycle === 'current').length !== 1)
      throw new CommsError('APPROVAL_VOID', 'the webhook target has no unique current signing generation');
    return { document, digest: row.digest, url, signing, urlSecrets };
  }

  /** Performs the await-capable policy reads; #finalGate must directly precede the physical phase. */
  async #prepareGate(
    claim: ClaimedDelivery,
    target: LoadedTarget,
    phase: WebhookFencePhase,
  ): Promise<DispatchResult | null> {
    await this.#beforeGate?.(phase, claim);
    try {
      await this.#fence(this.#fenceRequest(claim, `webhook-${phase}`));
      await assertLiveGmailAccount(this.#config, claim.accountId);
    } catch (error) {
      if (isRemovedAccountError(error)) {
        this.#store.immediate(() => purgeRemovedAccountWork(this.#store.database, claim.accountId, this.#now()));
        return { state: 'terminal', deliveryId: claim.id };
      }
      const stable = this.#store.immediate(() => this.#gateState(claim, target));
      if (stable !== null) return stable;
      throw error;
    }
    return null;
  }

  /**
   * Re-reads every mutable fact in one immediate transaction. Callers invoke the physical DNS/TCP/TLS/write action in
   * the next synchronous statement, so no await can place a revocation or replacement between this check and bytes.
   */
  #finalGate(claim: ClaimedDelivery, target: LoadedTarget): DispatchResult | null {
    return this.#store.immediate(() => this.#gateState(claim, target));
  }

  #gateState(claim: ClaimedDelivery, target: LoadedTarget): DispatchResult | null {
    const row = delivery(this.#store, claim.id);
    if (row === undefined || !isCurrentDeliveryClaim(this.#store.database, claim))
      return { state: 'terminal', deliveryId: claim.id };
    if (row.expires_at <= this.#now()) return { state: 'expired', deliveryId: claim.id };
    const setting = this.#store.database
      .prepare('SELECT enabled, paused, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; paused: number; switch_generation: number } | undefined;
    if (
      setting?.enabled !== 1 ||
      setting.switch_generation !== claim.switchGeneration ||
      !hasLiveDeliveryLineage(this.#store.database, row)
    )
      return { state: 'terminal', deliveryId: claim.id };
    if (setting.paused === 1) {
      releaseDeliveryClaimInTransaction(this.#store.database, claim);
      return { state: 'paused', deliveryId: claim.id };
    }
    const barrier = this.#store.database
      .prepare(
        `SELECT state FROM reset_barriers WHERE target_id = ? AND target_version = ? ORDER BY reset_epoch DESC LIMIT 1`,
      )
      .get(claim.targetId, claim.targetVersion) as { state: string } | undefined;
    if (barrier && barrier.state !== 'open') {
      releaseDeliveryClaimInTransaction(this.#store.database, claim);
      return { state: 'waiting-reset', deliveryId: claim.id };
    }
    const stored = this.#store.database
      .prepare('SELECT document, digest, revoked_at FROM target_versions WHERE target_id = ? AND version = ?')
      .get(claim.targetId, claim.targetVersion) as
      | { document: string; digest: string; revoked_at: number | null }
      | undefined;
    if (
      stored?.revoked_at !== null ||
      stored?.digest !== target.digest ||
      sha256Hex(stored?.document ?? '') !== target.digest
    )
      return { state: 'terminal', deliveryId: claim.id };
    if (!this.#secretGenerationsRemainLive(claim, target)) return { state: 'terminal', deliveryId: claim.id };
    return null;
  }

  /** The materials were read before this gate; this synchronous ledger reread proves their exact generations still live. */
  #secretGenerationsRemainLive(claim: ClaimedDelivery, target: LoadedTarget): boolean {
    for (const [purpose, generations] of [
      ['webhook-signing', target.signing],
      ['secret-url', target.urlSecrets],
    ] as const) {
      for (const secret of generations) {
        const row = this.#store.database
          .prepare(
            `SELECT owner_digest, secret_digest, lifecycle, expires_at
             FROM event_secret_generations
             WHERE owner_kind = 'target' AND owner_id = ? AND owner_version = ? AND purpose = ? AND generation = ?`,
          )
          .get(claim.targetId, claim.targetVersion, purpose, secret.generation) as
          | { owner_digest: string; secret_digest: string; lifecycle: string; expires_at: number | null }
          | undefined;
        if (
          row === undefined ||
          row.owner_digest !== target.digest ||
          row.secret_digest !== secret.secretDigest ||
          row.lifecycle !== secret.lifecycle ||
          (row.lifecycle === 'overlap' && (row.expires_at === null || row.expires_at <= this.#now()))
        ) {
          return false;
        }
      }
    }
    return true;
  }

  #fenceRequest(
    claim: Pick<
      ClaimedDelivery,
      'accountId' | 'ruleId' | 'ruleVersion' | 'targetId' | 'targetVersion' | 'switchGeneration'
    >,
    boundary: ActiveDisclosableRequest['boundary'] = 'dispatch',
  ): ActiveDisclosableRequest {
    return {
      database: this.#store.database,
      approvals: this.#approvals,
      config: this.#config,
      accountId: claim.accountId,
      boundary,
      ruleId: claim.ruleId,
      ruleVersion: claim.ruleVersion,
      targetId: claim.targetId,
      targetVersion: claim.targetVersion,
      switchGeneration: claim.switchGeneration,
    };
  }

  #release(claim: ClaimedDelivery): void {
    this.#store.immediate(() => releaseDeliveryClaimInTransaction(this.#store.database, claim));
  }
}

const DEFAULT_DEAD_LETTER_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_RETRY_BACKOFF_MS = 60 * 60 * 1000;

/**
 * Settles one issued webhook attempt. The exact owner predicate is deliberately the first durable decision: a late
 * response can add a content-free discarded marker, but cannot overwrite a recovered lease, a purge or a winner.
 */
export function settleWebhookOutcome(input: {
  readonly store: EventDatabase;
  readonly claim: ClaimedDelivery;
  readonly outcome: WebhookOutcome;
  readonly now: number;
  /** A just-reread asynchronous fence refused; its exact owner may only terminalise, never retry. */
  readonly authorityLost?: boolean | undefined;
}): boolean {
  return input.store.immediate(() => {
    const database = input.store.database;
    const row = database
      .prepare(
        `SELECT id, rule_id, rule_version, target_id, target_version, encrypted_record, attempts, expires_at, state,
                switch_generation, attempt_id, lease_token, lease_until
         FROM deliveries WHERE id = ?`,
      )
      .get(input.claim.id) as
      | {
          id: string;
          rule_id: string;
          rule_version: number;
          target_id: string;
          target_version: number;
          encrypted_record: Uint8Array | null;
          attempts: number;
          expires_at: number;
          state: string;
          switch_generation: number;
          attempt_id: string | null;
          lease_token: string | null;
          lease_until: number | null;
        }
      | undefined;
    if (
      row === undefined ||
      row.state !== 'disclosing' ||
      row.switch_generation !== input.claim.switchGeneration ||
      row.attempt_id !== input.claim.attemptId ||
      row.lease_token !== input.claim.leaseToken ||
      row.lease_until !== input.claim.leaseUntil
    ) {
      recordDiscardedWebhookOutcome(database, input.claim, input.now);
      return false;
    }

    if (input.authorityLost) {
      const cancelled = database
        .prepare(
          `UPDATE deliveries SET state = 'cancelled', encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
        ).changes;
      if (cancelled === 1) dropRetainedTargetReference(database, input.claim.id, input.now);
      recordDiscardedWebhookOutcome(database, input.claim, input.now);
      return false;
    }

    if (row.expires_at <= input.now) {
      const expired = database
        .prepare(
          `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?
             AND expires_at <= ?`,
        )
        .run(
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
          input.now,
        ).changes;
      if (expired === 1) dropRetainedTargetReference(database, input.claim.id, input.now);
      recordDiscardedWebhookOutcome(database, input.claim, input.now);
      return false;
    }

    const setting = database
      .prepare('SELECT enabled, switch_generation FROM event_settings WHERE singleton = 1')
      .get() as { enabled: number; switch_generation: number } | undefined;
    if (
      setting?.enabled !== 1 ||
      setting.switch_generation !== input.claim.switchGeneration ||
      !hasLiveDeliveryLineage(database, row)
    ) {
      const terminal = setting?.enabled === 1 ? 'cancelled' : 'in-flight-at-disable';
      const cancelled = database
        .prepare(
          `UPDATE deliveries SET state = ?, encrypted_record = NULL, lease_until = NULL, next_at = NULL
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          terminal,
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
        ).changes;
      if (cancelled === 1) dropRetainedTargetReference(database, input.claim.id, input.now);
      recordDiscardedWebhookOutcome(database, input.claim, input.now);
      return false;
    }

    if (input.outcome.kind === 'response' && input.outcome.success) {
      const delivered = database
        .prepare(
          `UPDATE deliveries
           SET state = 'delivered', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
               last_error_code = NULL, last_status = ?
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          input.outcome.status,
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
        ).changes;
      if (delivered === 1) dropRetainedTargetReference(database, input.claim.id, input.now);
      return delivered === 1;
    }

    const status = input.outcome.kind === 'response' ? input.outcome.status : null;
    const errorCode = input.outcome.kind === 'response' ? 'HTTP_NON_SUCCESS' : 'NETWORK';
    const retryLimit = retryLimitFor(database, row.target_id, row.target_version);
    if (row.attempts >= retryLimit) {
      const deadLettered = database
        .prepare(
          `UPDATE deliveries
           SET state = 'dead-lettered', lease_until = NULL, next_at = NULL, last_error_code = ?, last_status = ?,
               dead_lettered_at = COALESCE(dead_lettered_at, ?),
               dead_letter_expires_at = COALESCE(dead_letter_expires_at, ?)
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          errorCode,
          status,
          input.now,
          input.now + deadLetterRetentionFor(database, row.rule_id, row.rule_version),
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
        ).changes;
      return deadLettered === 1;
    }

    const nextAt = input.now + retryBackoffMs(row.attempts, row.id);
    if (nextAt >= row.expires_at) {
      const expired = database
        .prepare(
          `UPDATE deliveries SET state = 'retention-expired', encrypted_record = NULL, lease_until = NULL, next_at = NULL,
             last_error_code = ?, last_status = ?
           WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
             AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          errorCode,
          status,
          input.claim.id,
          input.claim.switchGeneration,
          input.claim.attemptId,
          input.claim.leaseToken,
          input.claim.leaseUntil,
        ).changes;
      if (expired === 1) dropRetainedTargetReference(database, input.claim.id, input.now);
      return expired === 1;
    }
    const retried = database
      .prepare(
        `UPDATE deliveries
         SET state = 'retryable', lease_until = NULL, next_at = ?, last_error_code = ?, last_status = ?
         WHERE id = ? AND state = 'disclosing' AND switch_generation = ?
           AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
      )
      .run(
        nextAt,
        errorCode,
        status,
        input.claim.id,
        input.claim.switchGeneration,
        input.claim.attemptId,
        input.claim.leaseToken,
        input.claim.leaseUntil,
      ).changes;
    return retried === 1;
  });
}

function recordDiscardedWebhookOutcome(database: EventDatabase['database'], claim: ClaimedDelivery, now: number): void {
  const id = `webhook-outcome:${sha256Hex(`${claim.id}:${claim.attemptId}:${claim.leaseToken}`)}`;
  database
    .prepare(
      `INSERT OR IGNORE INTO work_attempts (id, work_id, switch_generation, code, created_at)
       VALUES (?, ?, ?, 'external-outcome-unrecalled-discarded', ?)`,
    )
    .run(id, claim.id, claim.switchGeneration, now);
}

function dropRetainedTargetReference(database: EventDatabase['database'], deliveryId: string, now: number): void {
  for (const target of removeRetainedDeliveryTargetReference(database, deliveryId)) {
    purgeUnreferencedSystemTargets(database, { ...target, now });
  }
}

function retryLimitFor(database: EventDatabase['database'], targetId: string, targetVersion: number): number {
  const row = database
    .prepare('SELECT document FROM target_versions WHERE target_id = ? AND version = ?')
    .get(targetId, targetVersion) as { document: string } | undefined;
  if (row === undefined) return 20;
  try {
    return canonicalWebhookTarget(JSON.parse(row.document)).retryLimit;
  } catch {
    return 20;
  }
}

function deadLetterRetentionFor(database: EventDatabase['database'], ruleId: string, ruleVersion: number): number {
  const row = database
    .prepare('SELECT document FROM rule_versions WHERE rule_id = ? AND version = ?')
    .get(ruleId, ruleVersion) as { document: string } | undefined;
  try {
    const value = (JSON.parse(row?.document ?? '{}') as { retention?: { deadLetterMs?: unknown } }).retention
      ?.deadLetterMs;
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
      ? value
      : DEFAULT_DEAD_LETTER_RETENTION_MS;
  } catch {
    return DEFAULT_DEAD_LETTER_RETENTION_MS;
  }
}

/**
 * A stable, bounded jitter keeps a crashed attempt's recovery deterministic without allowing a retry storm to align.
 * The id is already content-free and never leaves the daemon.
 */
function retryBackoffMs(attempts: number, deliveryId: string): number {
  const exponential = Math.min(1_000 * 2 ** Math.max(0, attempts - 1), MAX_RETRY_BACKOFF_MS);
  const jitterRange = Math.max(1, Math.floor(exponential / 4));
  const entropy = Number.parseInt(sha256Hex(`${deliveryId}:${attempts}`).slice(0, 8), 16);
  return Math.min(exponential + (entropy % jitterRange), MAX_RETRY_BACKOFF_MS);
}

function delivery(store: EventDatabase, id: string): DeliveryRow | undefined {
  return store.database
    .prepare(
      `SELECT id, account_id, rule_id, rule_version, target_id, target_version, encrypted_record, expires_at,
              switch_generation, target_key FROM deliveries WHERE id = ?`,
    )
    .get(id) as DeliveryRow | undefined;
}

function deliveryLocation(id: string) {
  return { table: 'deliveries', column: 'encryptedRecord', key: [{ type: 'text' as const, value: id }] };
}

function parseDeliveryRecord(value: Buffer): DeliveryRecord {
  try {
    const parsed = JSON.parse(value.toString('utf8')) as Partial<DeliveryRecord>;
    if (
      typeof parsed.cloudEventBytes !== 'string' ||
      !Array.isArray(parsed.untrusted) ||
      !parsed.untrusted.every((entry) => typeof entry === 'string') ||
      (parsed.representation !== 'plain' && parsed.representation !== 'enveloped')
    ) {
      throw new Error('invalid');
    }
    return parsed as DeliveryRecord;
  } catch {
    throw new CommsError('BAD_DATA', 'the retained webhook delivery record is invalid');
  }
}

function responseStatus(socket: net.Socket | tls.TLSSocket): Promise<number> {
  return new Promise((resolve, reject) => {
    let received = '';
    const finish = () => {
      const match = /^HTTP\/1\.[01] (\d{3})\b/.exec(received);
      if (match?.[1] === undefined) reject(new Error('webhook peer returned no HTTP status'));
      else resolve(Number(match[1]));
    };
    socket.once('error', reject);
    socket.on('data', (chunk: Buffer) => {
      received += chunk.toString('ascii');
      if (received.includes('\r\n')) finish();
    });
    socket.once('end', () => {
      if (!received.includes('\r\n')) finish();
    });
  });
}
