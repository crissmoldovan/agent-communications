import type { DatabaseSync } from 'node:sqlite';
import { CommsError } from '@agentcomms/core';
import { canonicalSubscriber } from '../../domain/activation-documents.ts';
import type { EventSubscriptionV1 } from '../../domain/event-subscription.ts';
import { cancelEventDeliveriesInTransaction, settleFinishedEventsInTransaction } from './event-ledger.ts';

/**
 * The person's view and controls of subscribers' event deliveries (workflows design §9.2, plan I6): `subscribers list`'s
 * second entry, the event rows `deliveries list` adds, and `delivery retry|drop <event-id>:<subscriber-id>`. Content-
 * free: ids, closed words, counts and times.
 */

/** Where a live subscriber's listener is, or why it is not listening; null for one the owner has not started. */
export interface SubscriberListening {
  readonly listening: { readonly host: string; readonly port: number } | null;
  readonly listenError: 'PORT_IN_USE' | null;
}

/** One subscriber version, as `subscribers list --json` gives it from 0.36.0 (plan I6). */
export interface SubscriberEntryV2 {
  readonly subscriberId: string;
  readonly version: number;
  readonly digest: string;
  readonly revokedAt: number | null;
  readonly kind: 'sse' | 'webhook';
  readonly events: EventSubscriptionV1 | null;
  readonly state: 'inert' | 'active' | 'superseded' | null;
  readonly listening: { readonly host: string; readonly port: number } | null;
  readonly listenError: 'PORT_IN_USE' | null;
  /** Undelivered events: queued, waiting for a retry, or being sent. */
  readonly backlog: number;
  readonly lastDeliveredAt: number | null;
}

/** One subscriber's delivery of one raised event, in `deliveries list` beside the target deliveries. */
export interface EventDeliveryListRowV1 {
  readonly kind: 'event';
  /** `<event id>:<subscriber id>`, the key `delivery retry` and `delivery drop` take. */
  readonly deliveryId: string;
  readonly eventId: string;
  readonly eventType: string;
  readonly runId: string;
  readonly accountId: string;
  readonly ruleId: string;
  readonly ruleVersion: number;
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly subscriberKind: 'sse' | 'webhook';
  readonly attempts: number;
  readonly nextAt: number | null;
  readonly expiresAt: number;
  readonly state: string;
  readonly lastErrorCode: string | null;
  readonly lastStatus: number | null;
  readonly deliveredAt: number | null;
  readonly deadLetterExpiresAt: number | null;
}

/** Every subscriber version with what it receives, its state, its listener and its backlog. */
export function subscriberEntries(
  database: DatabaseSync,
  listening: (subscriberId: string, version: number) => SubscriberListening = () => ({
    listening: null,
    listenError: null,
  }),
): readonly SubscriberEntryV2[] {
  const rows = database
    .prepare(
      `SELECT subscriber.subscriber_id, subscriber.version, subscriber.document, subscriber.digest,
              subscriber.revoked_at, subscriber.state,
              (SELECT COUNT(*) FROM event_deliveries AS delivery
                WHERE delivery.subscriber_id = subscriber.subscriber_id
                  AND delivery.subscriber_version = subscriber.version
                  AND delivery.state IN ('queued', 'retryable', 'disclosing')) AS backlog,
              (SELECT MAX(delivered_at) FROM event_deliveries AS delivery
                WHERE delivery.subscriber_id = subscriber.subscriber_id
                  AND delivery.subscriber_version = subscriber.version) AS last_delivered_at
         FROM subscriber_versions AS subscriber
        ORDER BY subscriber.subscriber_id, subscriber.version`,
    )
    .all() as Array<{
    subscriber_id: string;
    version: number;
    document: string;
    digest: string;
    revoked_at: number | null;
    state: 'inert' | 'active' | 'superseded' | null;
    backlog: number;
    last_delivered_at: number | null;
  }>;
  return rows.map((row) => {
    let kind: 'sse' | 'webhook' = 'sse';
    let events: EventSubscriptionV1 | null = null;
    try {
      const document = canonicalSubscriber(JSON.parse(row.document));
      kind = document.kind;
      events = document.events ?? null;
    } catch {
      // A damaged immutable row is listed by its identity alone, never as a permissive document.
    }
    const status = row.revoked_at === null ? listening(row.subscriber_id, row.version) : undefined;
    return {
      subscriberId: row.subscriber_id,
      version: row.version,
      digest: row.digest,
      revokedAt: row.revoked_at,
      kind,
      events,
      state: row.state,
      listening: status?.listening ?? null,
      listenError: status?.listenError ?? null,
      backlog: row.backlog,
      lastDeliveredAt: row.last_delivered_at,
    };
  });
}

/** Every event delivery, newest event first: content-free. */
export function listEventDeliveryRows(database: DatabaseSync): readonly EventDeliveryListRowV1[] {
  const rows = database
    .prepare(
      `SELECT delivery.event_id, event.type, event.run_id, event.account_id, event.rule_id, event.rule_version,
              delivery.subscriber_id, delivery.subscriber_version, delivery.kind, delivery.attempts, delivery.next_at,
              event.expires_at, delivery.state, delivery.last_error_code, delivery.last_status, delivery.delivered_at,
              delivery.dead_letter_expires_at
         FROM event_deliveries AS delivery
         JOIN workflow_events AS event ON event.id = delivery.event_id
        ORDER BY event.raised_at DESC, delivery.event_id, delivery.subscriber_id, delivery.subscriber_version`,
    )
    .all() as Array<{
    event_id: string;
    type: string;
    run_id: string;
    account_id: string;
    rule_id: string;
    rule_version: number;
    subscriber_id: string;
    subscriber_version: number;
    kind: 'sse' | 'webhook';
    attempts: number;
    next_at: number | null;
    expires_at: number;
    state: string;
    last_error_code: string | null;
    last_status: number | null;
    delivered_at: number | null;
    dead_letter_expires_at: number | null;
  }>;
  return rows.map((row) => ({
    kind: 'event',
    deliveryId: `${row.event_id}:${row.subscriber_id}`,
    eventId: row.event_id,
    eventType: row.type,
    runId: row.run_id,
    accountId: row.account_id,
    ruleId: row.rule_id,
    ruleVersion: row.rule_version,
    subscriberId: row.subscriber_id,
    subscriberVersion: row.subscriber_version,
    subscriberKind: row.kind,
    attempts: row.attempts,
    nextAt: row.next_at,
    expiresAt: row.expires_at,
    state: row.state,
    lastErrorCode: row.last_error_code,
    lastStatus: row.last_status,
    deliveredAt: row.delivered_at,
    deadLetterExpiresAt: row.dead_letter_expires_at,
  }));
}

const EVENT_DELIVERY_KEY = /^(wfe_[0-9a-hjkmnp-tv-z]{26}):(.+)$/u;

/** `<event id>:<subscriber id>`, or null when the id is not an event delivery's (a target delivery's id, then). */
export function parseEventDeliveryKey(
  value: unknown,
): { readonly eventId: string; readonly subscriberId: string } | null {
  if (typeof value !== 'string') return null;
  const match = EVENT_DELIVERY_KEY.exec(value);
  if (match === null) return null;
  return { eventId: match[1] as string, subscriberId: match[2] as string };
}

interface KeyedDelivery {
  readonly event_id: string;
  readonly subscriber_id: string;
  readonly subscriber_version: number;
  readonly state: string;
  readonly attempts: number;
  readonly event_state: string;
  readonly expires_at: number;
}

function keyedDelivery(database: DatabaseSync, key: { eventId: string; subscriberId: string }): KeyedDelivery {
  const rows = database
    .prepare(
      `SELECT delivery.event_id, delivery.subscriber_id, delivery.subscriber_version, delivery.state, delivery.attempts,
              event.state AS event_state, event.expires_at
         FROM event_deliveries AS delivery JOIN workflow_events AS event ON event.id = delivery.event_id
        WHERE delivery.event_id = ? AND delivery.subscriber_id = ?
        ORDER BY delivery.subscriber_version DESC`,
    )
    .all(key.eventId, key.subscriberId) as unknown as KeyedDelivery[];
  const row = rows[0];
  if (row === undefined) throw new CommsError('NOT_FOUND', 'the delivery does not exist');
  return row;
}

function voided(message: string): CommsError {
  return new CommsError('APPROVAL_VOID', message);
}

/**
 * "Try now": a delivery waiting for its next try is due at once. Only while the subscription it goes to is still the
 * active one and its event is still kept; the dispatcher fences both workflows' authority again before anything
 * leaves. Runs in the caller's transaction.
 */
export function retryEventDeliveryInTransaction(
  database: DatabaseSync,
  key: { readonly eventId: string; readonly subscriberId: string },
  now: number,
): { readonly kind: 'delivery-retried'; readonly deliveryId: string; readonly nextAt: number } {
  const row = keyedDelivery(database, key);
  if (row.state !== 'retryable') throw voided('only a retryable delivery may be scheduled again');
  if (row.event_state !== 'open' || row.expires_at <= now) throw voided('the delivery retention deadline has passed');
  const live = database
    .prepare(
      "SELECT 1 AS present FROM subscriber_versions WHERE subscriber_id = ? AND version = ? AND state = 'active' AND revoked_at IS NULL",
    )
    .get(row.subscriber_id, row.subscriber_version);
  if (live === undefined) throw voided('the subscriber version no longer receives events');
  const changed = database
    .prepare(
      `UPDATE event_deliveries SET next_at = ?
        WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state = 'retryable' AND attempts = ?`,
    )
    .run(now, row.event_id, row.subscriber_id, row.subscriber_version, row.attempts).changes;
  if (changed !== 1) throw voided('the delivery changed before its retry could be scheduled');
  return { kind: 'delivery-retried', deliveryId: `${key.eventId}:${key.subscriberId}`, nextAt: now };
}

/**
 * "Stop trying": a delivery that will be tried again is cancelled at once — a tightening — and a dead letter's kept
 * event is let go. One being sent is refused, as a target delivery's is. Runs in the caller's transaction.
 */
export function dropEventDeliveryInTransaction(
  database: DatabaseSync,
  key: { readonly eventId: string; readonly subscriberId: string },
  now: number,
): { readonly kind: 'delivery-dropped'; readonly deliveryId: string } {
  const row = keyedDelivery(database, key);
  const deliveryId = `${key.eventId}:${key.subscriberId}`;
  if (row.state === 'queued' || row.state === 'retryable') {
    cancelEventDeliveriesInTransaction(
      database,
      { eventId: row.event_id, subscriberId: row.subscriber_id, subscriberVersion: row.subscriber_version },
      now,
      'DROPPED',
    );
    return { kind: 'delivery-dropped', deliveryId };
  }
  if (row.state === 'disclosing')
    throw new CommsError(
      'APPROVAL_VOID',
      'the delivery is being sent right now; it can be stopped once this try ends',
      {
        hint: 'A try that fails becomes one that will be tried again, which can then be stopped.',
        details: { reason: 'DELIVERY_IN_FLIGHT' },
      },
    );
  if (row.state !== 'dead-lettered')
    throw voided('only a delivery that will be tried again, or one that failed for good, can be dropped');
  database
    .prepare(
      `UPDATE event_deliveries SET dead_letter_expires_at = ?
        WHERE event_id = ? AND subscriber_id = ? AND subscriber_version = ? AND state = 'dead-lettered'`,
    )
    .run(now, row.event_id, row.subscriber_id, row.subscriber_version);
  settleFinishedEventsInTransaction(database, [row.event_id], now);
  return { kind: 'delivery-dropped', deliveryId };
}

/**
 * An agent may not stop an event delivery that will be tried again (as a target delivery's stop is the person's,
 * review of 0.32.0, finding 4): the person drops it in the app or at their terminal. A finished one stays finished, so
 * its drop — a dead letter's kept event — goes on to the operation. Not an event delivery's key: nothing to say here.
 */
export function assertAgentMayStopEventDelivery(database: DatabaseSync, deliveryId: unknown): void {
  const key = parseEventDeliveryKey(deliveryId);
  if (key === null) return;
  const open = database
    .prepare(
      `SELECT 1 AS present FROM event_deliveries
        WHERE event_id = ? AND subscriber_id = ? AND state IN ('queued', 'retryable', 'disclosing')`,
    )
    .get(key.eventId, key.subscriberId);
  if (open === undefined) return;
  throw new CommsError(
    'APPROVAL_REQUIRED',
    'stopping an event delivery that will be tried again is for a person, at a terminal or in the app',
    {
      hint: 'The person stops it in the app (Events → Deliveries) or at their terminal.',
      details: { reason: 'PERSON_ONLY_STOP' },
    },
  );
}
