import { randomUUID } from 'node:crypto';
import type net from 'node:net';
import type tls from 'node:tls';
import { type ApprovalStore, CommsError, type ConfigStore, newBoundary, wrapUntrusted } from '@agentcomms/core';
import { representWorkflowEvent, type WorkflowCloudEventV1, workflowEventBytes } from '@agentcomms/events';
import type { SseSubscriberDocument } from '../../domain/sse-subscriber.ts';
import type { WebhookSubscriberDocument } from '../../domain/webhook-subscriber.ts';
import { canonicalSecretWebhookUrl } from '../../domain/webhook-target.ts';
import type { PinnedTcpOptions, PinnedTlsOptions } from '../../network/pinned-connection.ts';
import type { AddressResolver } from '../../network/resolver.ts';
import type { EventDatabase } from '../../store/database.ts';
import type { EventRecordCipher } from '../../store/records.ts';
import { isRemovedAccountError } from '../account-fence.ts';
import { eventStreamLocation } from '../stream-replay.ts';
import {
  postSigned,
  type WebhookFencePhase,
  type WebhookSecretMaterial,
  webhookRetryBackoffMs,
} from '../webhook-dispatcher.ts';
import { signStandardWebhook } from '../webhook-signing.ts';
import { assertEventDisclosable, type EventDisclosure, eventDisclosureIsCurrent } from './event-fence.ts';
import {
  cancelEventDeliveriesInTransaction,
  expireEventsInTransaction,
  settleFinishedEventsInTransaction,
} from './event-ledger.ts';
import type { SubscriberListeners } from './listeners.ts';
import { workflowEventLocation } from './sink.ts';

/**
 * Delivering raised events (workflows design W31–W33, W35, §9.2). `EventDispatcher` claims `event_deliveries` rows as
 * the target dispatchers claim deliveries — an attempt id, a lease token, a lease — in order per subscriber version:
 * a later event waits until the earlier one settles. Before anything leaves it fences both authorities again, after
 * opening the sealed event too; then:
 * - **to a live subscriber** it seals the frame as that subscriber may see it into `event_stream_log`, settles the
 *   delivery `delivered` in the same transaction, and pushes the frame to the listener's open streams. With no stream
 *   open it is delivered all the same: the log is its replay.
 * - **to a webhook subscriber** it posts the CloudEvent through the webhook transport, signed with the current and the
 *   overlap secret, `webhook-id` the event's id on every try, and settles, retries or dead-letters as a webhook
 *   delivery does.
 * At least once: a lease that lapses mid-attempt is claimed again. Delivery never touches the run (W33).
 */

export type EventSecretReader = (input: {
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly subscriberDigest: string;
  readonly purpose: 'webhook-signing' | 'secret-url';
}) => Promise<readonly WebhookSecretMaterial[]>;

/** Test-only points inside one attempt; production supplies none. */
export type EventDispatchPoint = 'after-claim' | 'after-fence';

export interface EventDispatcherOptions {
  readonly store: EventDatabase;
  readonly cipher: Pick<EventRecordCipher, 'encrypt' | 'decrypt'>;
  readonly approvals: Pick<ApprovalStore, 'get'>;
  readonly config: Pick<ConfigStore, 'load'>;
  readonly listeners: Pick<SubscriberListeners, 'push'>;
  readonly secretReader: EventSecretReader;
  readonly now?: (() => number) | undefined;
  readonly leaseMs?: number | undefined;
  readonly batchSize?: number | undefined;
  readonly attemptTimeoutMs?: number | undefined;
  readonly resolver?: AddressResolver | undefined;
  readonly tcpConnect?: ((options: PinnedTcpOptions) => Promise<net.Socket>) | undefined;
  readonly tlsConnect?: ((options: PinnedTlsOptions) => Promise<tls.TLSSocket>) | undefined;
  /** Test seam only: runs at a point inside an attempt, after which the attempt's own gates decide. */
  readonly testPoint?: ((point: EventDispatchPoint, claim: EventDeliveryClaim) => void | Promise<void>) | undefined;
}

/** One claimed attempt of one event's delivery to one subscriber version. */
export interface EventDeliveryClaim {
  readonly eventId: string;
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly kind: 'sse' | 'webhook';
  readonly attempts: number;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly leaseUntil: number;
}

interface DeliveryRow {
  readonly event_id: string;
  readonly subscriber_id: string;
  readonly subscriber_version: number;
  readonly kind: 'sse' | 'webhook';
  readonly state: string;
  readonly attempts: number;
  readonly next_at: number | null;
}

const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_ATTEMPT_TIMEOUT_MS = 20_000;
const LEASE_MARGIN_MS = 2_000;
const STREAM_RETENTION_MAX_MS = 604_800_000;
const DEFAULT_DEAD_LETTER_MS = 604_800_000;

function reasonOf(error: unknown): string {
  if (error instanceof CommsError) {
    const reason = error.details?.reason;
    return typeof reason === 'string' ? reason : error.code;
  }
  return 'AUTHORITY_LOST';
}

export class EventDispatcher {
  readonly #options: EventDispatcherOptions;
  readonly #now: () => number;

  constructor(options: EventDispatcherOptions) {
    this.#options = options;
    this.#now = options.now ?? Date.now;
  }

  /**
   * One pass: settles what time ended and recovers lapsed leases, then attempts the head delivery of each subscriber
   * version that is due. Returns how many attempts it made.
   */
  async tick(): Promise<number> {
    const store = this.#options.store;
    store.immediate(() => {
      const now = this.#now();
      expireEventsInTransaction(store.database, now);
      // A lease that lapsed is an attempt that may or may not have reached the subscriber: at least once, so again.
      store.database
        .prepare(
          `UPDATE event_deliveries
              SET state = 'retryable', next_at = ?, lease_until = NULL, attempt_id = NULL, lease_token = NULL,
                  last_error_code = COALESCE(last_error_code, 'LEASE_EXPIRED')
            WHERE state = 'disclosing' AND lease_until <= ?`,
        )
        .run(now, now);
    });
    const due = this.#due();
    let attempted = 0;
    for (const row of due) {
      try {
        if (await this.#attempt(row)) attempted += 1;
      } catch {
        // One delivery's failure is its own: it is retried, or settled, by its next claim; the others go on.
      }
    }
    return attempted;
  }

  /** The head of each subscriber version's queue, when it is due: strict order, a later one waits for the first. */
  #due(): readonly DeliveryRow[] {
    const now = this.#now();
    const heads = this.#options.store.database
      .prepare(
        `SELECT delivery.event_id, delivery.subscriber_id, delivery.subscriber_version, delivery.kind, delivery.state,
                delivery.attempts, delivery.next_at
           FROM event_deliveries AS delivery
          WHERE delivery.state IN ('queued', 'retryable', 'disclosing')
            AND delivery.ordering_sequence = (
              SELECT MIN(head.ordering_sequence) FROM event_deliveries AS head
               WHERE head.subscriber_id = delivery.subscriber_id
                 AND head.subscriber_version = delivery.subscriber_version
                 AND head.state IN ('queued', 'retryable', 'disclosing'))
          ORDER BY delivery.subscriber_id, delivery.subscriber_version
          LIMIT ?`,
      )
      .all(this.#options.batchSize ?? 64) as unknown as DeliveryRow[];
    return heads.filter(
      (row) => row.state === 'queued' || (row.state === 'retryable' && (row.next_at === null || row.next_at <= now)),
    );
  }

  #claim(row: DeliveryRow): EventDeliveryClaim | null {
    const now = this.#now();
    const claim: EventDeliveryClaim = {
      eventId: row.event_id,
      subscriberId: row.subscriber_id,
      subscriberVersion: row.subscriber_version,
      kind: row.kind,
      attempts: row.attempts + 1,
      attemptId: randomUUID(),
      leaseToken: randomUUID(),
      leaseUntil: now + (this.#options.leaseMs ?? DEFAULT_LEASE_MS),
    };
    const changed = this.#options.store.immediate(
      () =>
        this.#options.store.database
          .prepare(
            `UPDATE event_deliveries
                SET state = 'disclosing', attempts = ?, attempt_id = ?, lease_token = ?, lease_until = ?, next_at = NULL
              WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ?
                AND state IN ('queued', 'retryable') AND attempts = ?`,
          )
          .run(
            claim.attempts,
            claim.attemptId,
            claim.leaseToken,
            claim.leaseUntil,
            claim.eventId,
            claim.subscriberId,
            claim.subscriberVersion,
            row.attempts,
          ).changes,
    );
    return changed === 1 ? claim : null;
  }

  /** Whether this attempt still owns its lease: checked in the transaction before each write and each send. */
  #isCurrent(claim: EventDeliveryClaim): boolean {
    return (
      this.#options.store.database
        .prepare(
          `SELECT 1 AS present FROM event_deliveries
            WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state = 'disclosing'
              AND attempt_id = ? AND lease_token = ? AND lease_until = ? AND lease_until > ?`,
        )
        .get(
          claim.eventId,
          claim.subscriberId,
          claim.subscriberVersion,
          claim.attemptId,
          claim.leaseToken,
          claim.leaseUntil,
          this.#now(),
        ) !== undefined
    );
  }

  /** Settles this attempt's delivery, only while it still owns the lease; then settles its event if it is final. */
  #settle(
    claim: EventDeliveryClaim,
    state: 'delivered' | 'retryable' | 'dead-lettered' | 'cancelled',
    fields: { readonly code?: string | null; readonly status?: number | null; readonly nextAt?: number | null } = {},
  ): boolean {
    const store = this.#options.store;
    return store.immediate(() => {
      const now = this.#now();
      const deadLetterMs = state === 'dead-lettered' ? this.#deadLetterMs(claim.eventId) : null;
      const changed = store.database
        .prepare(
          `UPDATE event_deliveries
              SET state = ?, lease_until = NULL, attempt_id = NULL, lease_token = NULL, next_at = ?,
                  last_error_code = ?, last_status = COALESCE(?, last_status),
                  delivered_at = CASE WHEN ? = 'delivered' THEN ? ELSE delivered_at END,
                  dead_letter_expires_at = CASE WHEN ? = 'dead-lettered' THEN ? ELSE dead_letter_expires_at END
            WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state = 'disclosing'
              AND attempt_id = ? AND lease_token = ? AND lease_until = ?`,
        )
        .run(
          state,
          fields.nextAt ?? null,
          fields.code ?? null,
          fields.status ?? null,
          state,
          now,
          state,
          deadLetterMs === null ? null : now + deadLetterMs,
          claim.eventId,
          claim.subscriberId,
          claim.subscriberVersion,
          claim.attemptId,
          claim.leaseToken,
          claim.leaseUntil,
        ).changes;
      if (changed === 1) settleFinishedEventsInTransaction(store.database, [claim.eventId], now);
      return changed === 1;
    });
  }

  #deadLetterMs(eventId: string): number {
    const row = this.#options.store.database
      .prepare(
        `SELECT rule.document FROM workflow_events AS event
           JOIN rule_versions AS rule ON rule.rule_id = event.rule_id AND rule.version = event.rule_version
          WHERE event.id = ?`,
      )
      .get(eventId) as { document: string } | undefined;
    try {
      const value = (JSON.parse(row?.document ?? '{}') as { retention?: { deadLetterMs?: unknown } }).retention
        ?.deadLetterMs;
      return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_DEAD_LETTER_MS;
    } catch {
      return DEFAULT_DEAD_LETTER_MS;
    }
  }

  /**
   * The fence's refusal settles the attempt: nothing was sent, and nothing will be (W35). Anything that is not a
   * refusal — a store that could not be read just now — lets the claim go, to be tried again.
   */
  #refuse(claim: EventDeliveryClaim, error: unknown): void {
    if (error instanceof CommsError && (error.code === 'TRANSIENT' || error.code === 'UNEXPECTED')) {
      this.#settle(claim, 'retryable', {
        code: reasonOf(error),
        nextAt: this.#now() + webhookRetryBackoffMs(claim.attempts, claim.eventId),
      });
      return;
    }
    const store = this.#options.store;
    if (isRemovedAccountError(error)) {
      const account = store.database
        .prepare('SELECT account_id FROM workflow_events WHERE id = ?')
        .get(claim.eventId) as { account_id: string } | undefined;
      if (account !== undefined)
        store.immediate(() =>
          cancelEventDeliveriesInTransaction(
            store.database,
            { accountId: account.account_id },
            this.#now(),
            'ACCOUNT_REMOVED',
          ),
        );
      return;
    }
    this.#settle(claim, 'cancelled', { code: reasonOf(error) });
  }

  async #fence(claim: EventDeliveryClaim, boundary: 'dispatch' | 'webhook-write'): Promise<EventDisclosure> {
    return assertEventDisclosable({
      database: this.#options.store.database,
      approvals: this.#options.approvals,
      config: this.#options.config,
      eventId: claim.eventId,
      subscriberId: claim.subscriberId,
      subscriberVersion: claim.subscriberVersion,
      boundary,
    });
  }

  /** The event as this subscriber may see it: its approved content decides whether a Raise step's fields reach it. */
  async #represented(claim: EventDeliveryClaim, disclosure: EventDisclosure): Promise<string> {
    const row = this.#options.store.database
      .prepare("SELECT encrypted_record FROM workflow_events WHERE id = ? AND state = 'open'")
      .get(claim.eventId) as { encrypted_record: Uint8Array | null } | undefined;
    if (row === undefined || row.encrypted_record === null)
      throw new CommsError('APPROVAL_VOID', 'the raised event is no longer kept', {
        details: { reason: 'EVENT_GONE' },
      });
    const event = JSON.parse(
      (await this.#options.cipher.decrypt(workflowEventLocation(claim.eventId), row.encrypted_record)).toString('utf8'),
    ) as WorkflowCloudEventV1;
    if (event.id !== claim.eventId || event.type !== disclosure.type)
      throw new CommsError('APPROVAL_VOID', 'the sealed event does not match its ledger row', {
        details: { reason: 'EVENT_DRIFT' },
      });
    const boundary = newBoundary();
    const represented = representWorkflowEvent(event, disclosure.subscription.events.content, (text, pointer) =>
      wrapUntrusted(text, { field: pointer, id: claim.eventId }, boundary),
    );
    return workflowEventBytes(represented);
  }

  async #attempt(row: DeliveryRow): Promise<boolean> {
    const claim = this.#claim(row);
    if (claim === null) return false;
    await this.#options.testPoint?.('after-claim', claim);
    let disclosure: EventDisclosure;
    let text: string;
    try {
      disclosure = await this.#fence(claim, 'dispatch');
      text = await this.#represented(claim, disclosure);
      // W35, after decryption too: a revocation that won while the record was opened stops it here.
      disclosure = await this.#fence(claim, 'dispatch');
    } catch (error) {
      this.#refuse(claim, error);
      return true;
    }
    await this.#options.testPoint?.('after-fence', claim);
    if (claim.kind === 'sse') await this.#deliverLive(claim, disclosure, text);
    else await this.#deliverWebhook(claim, disclosure, text);
    return true;
  }

  async #deliverLive(claim: EventDeliveryClaim, disclosure: EventDisclosure, text: string): Promise<void> {
    const store = this.#options.store;
    const document = disclosure.subscription.document as SseSubscriberDocument;
    const id = randomUUID();
    // The nonce reservation is its own transaction, so the frame is sealed before the append-and-settle one.
    const sealed = await this.#options.cipher.encrypt(eventStreamLocation(id), Buffer.from(text, 'utf8'));
    const appended = store.immediate(() => {
      if (!this.#isCurrent(claim) || !eventDisclosureIsCurrent(store.database, disclosure)) return false;
      const now = this.#now();
      store.database
        .prepare(
          `INSERT INTO event_stream_log
             (id, event_id, subscriber_id, subscriber_version, encrypted_record, delivered_at, expires_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          claim.eventId,
          claim.subscriberId,
          claim.subscriberVersion,
          sealed,
          now,
          now + Math.min(document.retentionMs, STREAM_RETENTION_MAX_MS),
        );
      const settled = store.database
        .prepare(
          `UPDATE event_deliveries
              SET state = 'delivered', delivered_at = ?, lease_until = NULL, attempt_id = NULL, lease_token = NULL,
                  next_at = NULL, last_error_code = NULL
            WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state = 'disclosing'
              AND attempt_id = ? AND lease_token = ?`,
        )
        .run(
          now,
          claim.eventId,
          claim.subscriberId,
          claim.subscriberVersion,
          claim.attemptId,
          claim.leaseToken,
        ).changes;
      if (settled !== 1) throw new CommsError('APPROVAL_VOID', 'the event delivery lease changed before it settled');
      settleFinishedEventsInTransaction(store.database, [claim.eventId], now);
      return true;
    });
    if (!appended) {
      this.#settle(claim, 'cancelled', { code: 'AUTHORITY_LOST' });
      return;
    }
    // Delivered into the log; the open streams get it now, each through the listener's own gate.
    await this.#options.listeners.push(claim.subscriberId, claim.subscriberVersion, { eventStreamLogId: id });
  }

  async #deliverWebhook(claim: EventDeliveryClaim, disclosure: EventDisclosure, text: string): Promise<void> {
    const store = this.#options.store;
    const document = disclosure.subscription.document as WebhookSubscriberDocument;
    let url: string;
    let signing: readonly WebhookSecretMaterial[];
    let urlSecrets: readonly WebhookSecretMaterial[] = [];
    try {
      signing = await this.#options.secretReader({
        subscriberId: claim.subscriberId,
        subscriberVersion: claim.subscriberVersion,
        subscriberDigest: disclosure.subscription.digest,
        purpose: 'webhook-signing',
      });
      if (document.url.kind === 'plain') url = document.url.value;
      else {
        urlSecrets = await this.#options.secretReader({
          subscriberId: claim.subscriberId,
          subscriberVersion: claim.subscriberVersion,
          subscriberDigest: disclosure.subscription.digest,
          purpose: 'secret-url',
        });
        const current = urlSecrets.find((secret) => secret.lifecycle === 'current');
        if (current === undefined) throw new CommsError('APPROVAL_VOID', 'the webhook URL secret is unavailable');
        const canonical = canonicalSecretWebhookUrl(current.material);
        if (canonical.descriptor.sha256 !== document.url.sha256)
          throw new CommsError('APPROVAL_VOID', 'the webhook URL secret does not match its subscriber version');
        url = canonical.value;
      }
    } catch (error) {
      this.#settle(claim, 'cancelled', { code: reasonOf(error) });
      return;
    }
    const current = signing.filter((secret) => secret.lifecycle === 'current');
    if (current.length !== 1) {
      // No signing secret yet: nothing is sent unsigned. It waits for the person's `subscriber secret create`.
      this.#settle(claim, 'retryable', {
        code: 'SIGNING_SECRET_MISSING',
        nextAt: this.#now() + webhookRetryBackoffMs(claim.attempts, claim.eventId),
      });
      return;
    }
    const headers = {
      'Content-Type': 'application/cloudevents+json; charset=utf-8',
      ...signStandardWebhook({
        id: claim.eventId,
        timestamp: Math.floor(this.#now() / 1000),
        body: text,
        current: (current[0] as WebhookSecretMaterial).material,
        overlap: signing.filter((secret) => secret.lifecycle === 'overlap').map((secret) => secret.material),
      }),
    };
    const deadline = Math.min(
      Date.now() + (this.#options.attemptTimeoutMs ?? DEFAULT_ATTEMPT_TIMEOUT_MS),
      Date.now() + (claim.leaseUntil - this.#now()) - LEASE_MARGIN_MS,
    );
    const secretsLive = () => this.#secretsLive(claim, disclosure.subscription.digest, [...signing, ...urlSecrets]);
    const result = await postSigned({
      url,
      approvedAddressSet: document.approvedAddressSet,
      body: text,
      headers,
      deadline,
      prepare: async (phase: WebhookFencePhase) => {
        try {
          disclosure = await this.#fence(claim, phase === 'write' ? 'webhook-write' : 'dispatch');
          return true;
        } catch {
          return false;
        }
      },
      // Directly before each physical step, in one transaction: the lease, both authorities and the secrets.
      gate: () =>
        store.immediate(
          () => this.#isCurrent(claim) && eventDisclosureIsCurrent(store.database, disclosure) && secretsLive(),
        ),
      ...(this.#options.resolver === undefined ? {} : { resolver: this.#options.resolver }),
      ...(this.#options.tcpConnect === undefined ? {} : { tcpConnect: this.#options.tcpConnect }),
      ...(this.#options.tlsConnect === undefined ? {} : { tlsConnect: this.#options.tlsConnect }),
    });
    if (result.kind === 'stopped') {
      this.#settle(claim, 'cancelled', { code: 'AUTHORITY_LOST' });
      return;
    }
    if (result.kind === 'response' && result.success) {
      this.#settle(claim, 'delivered', { status: result.status });
      return;
    }
    const code = result.kind === 'response' ? 'HTTP_NON_SUCCESS' : 'NETWORK';
    const status = result.kind === 'response' ? result.status : null;
    if (claim.attempts >= document.retryLimit) {
      this.#settle(claim, 'dead-lettered', { code, status });
      return;
    }
    this.#settle(claim, 'retryable', {
      code,
      status,
      nextAt: this.#now() + webhookRetryBackoffMs(claim.attempts, claim.eventId),
    });
  }

  /** The secrets read before the gate are still the live generations of this exact subscriber version. */
  #secretsLive(claim: EventDeliveryClaim, digest: string, secrets: readonly WebhookSecretMaterial[]): boolean {
    for (const secret of secrets) {
      const row = this.#options.store.database
        .prepare(
          `SELECT owner_digest, secret_digest, lifecycle, expires_at FROM event_secret_generations
            WHERE owner_kind = 'subscriber' AND owner_id = ? AND owner_version = ? AND secret_digest = ?
              AND lifecycle = ?`,
        )
        .get(claim.subscriberId, claim.subscriberVersion, secret.secretDigest, secret.lifecycle) as
        | { owner_digest: string; secret_digest: string; lifecycle: string; expires_at: number | null }
        | undefined;
      if (
        row === undefined ||
        row.owner_digest !== digest ||
        (row.lifecycle === 'overlap' && (row.expires_at === null || row.expires_at <= this.#now()))
      )
        return false;
    }
    return true;
  }
}
