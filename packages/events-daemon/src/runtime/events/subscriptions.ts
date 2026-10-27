import type { DatabaseSync } from 'node:sqlite';
import { CommsError, sha256Hex } from '@agentcomms/core';
import {
  type ActivationDocumentV1,
  canonicalSubscriber,
  type SubscriberDocument,
} from '../../domain/activation-documents.ts';
import { describeSubscription, type EventSubscriptionV1 } from '../../domain/event-subscription.ts';
import { webhookSubscriberAuthority } from '../../domain/webhook-subscriber.ts';
import { cancelEventDeliveriesInTransaction } from './event-ledger.ts';

/**
 * Subscribers' approved subscriptions (workflows design W29, W35): which subscriber versions the person approved to
 * receive workflow events, read by the sink when it raises an event and by the dispatcher before each delivery.
 */

/** One active subscription: the subscriber version, its kind, what it is given, and its canonical document. */
export interface ActiveSubscription {
  readonly subscriberId: string;
  readonly version: number;
  readonly kind: 'sse' | 'webhook';
  readonly events: EventSubscriptionV1;
  readonly document: SubscriberDocument;
  readonly digest: string;
}

interface SubscriberRow {
  readonly subscriber_id: string;
  readonly version: number;
  readonly document: string;
  readonly digest: string;
}

function subscriptionOf(row: SubscriberRow): ActiveSubscription | null {
  if (sha256Hex(row.document) !== row.digest) return null;
  let document: SubscriberDocument;
  try {
    document = canonicalSubscriber(JSON.parse(row.document));
  } catch {
    return null;
  }
  if (document.subscriberId !== row.subscriber_id || document.version !== row.version) return null;
  const events = document.events;
  if (events === undefined) return null;
  return {
    subscriberId: row.subscriber_id,
    version: row.version,
    kind: document.kind,
    events,
    document,
    digest: row.digest,
  };
}

/**
 * Every active, unrevoked subscription whose stored document still matches its digest, in subscriber order. A damaged
 * row is left out: it can prove nothing, so it receives nothing.
 */
export function activeSubscriptions(database: DatabaseSync): readonly ActiveSubscription[] {
  const rows = database
    .prepare(
      `SELECT subscriber_id, version, document, digest FROM subscriber_versions
        WHERE state = 'active' AND revoked_at IS NULL ORDER BY subscriber_id, version`,
    )
    .all() as unknown as SubscriberRow[];
  return rows.flatMap((row) => {
    const subscription = subscriptionOf(row);
    return subscription === null ? [] : [subscription];
  });
}

/** The one subscription of an exact version, when it is active and unrevoked; null otherwise. Synchronous. */
export function activeSubscription(
  database: DatabaseSync,
  subscriberId: string,
  version: number,
): ActiveSubscription | null {
  const row = database
    .prepare(
      `SELECT subscriber_id, version, document, digest FROM subscriber_versions
        WHERE subscriber_id = ? AND version = ? AND state = 'active' AND revoked_at IS NULL`,
    )
    .get(subscriberId, version) as SubscriberRow | undefined;
  return row === undefined ? null : subscriptionOf(row);
}

/**
 * A subscription's completion, inside the activation's pointer transaction: the version becomes the subscriber's one
 * active version, and the one it replaces superseded — whose undelivered events are cancelled at once, since it no
 * longer has the person's approval to receive them.
 */
export function activateSubscriptionInTransaction(
  database: DatabaseSync,
  input: {
    readonly subscriberId: string;
    readonly version: number;
    readonly approvalId: string | null;
    readonly at: number;
    readonly now: number;
  },
): void {
  const previous = database
    .prepare("SELECT version FROM subscriber_versions WHERE subscriber_id = ? AND state = 'active'")
    .all(input.subscriberId) as Array<{ version: number }>;
  for (const row of previous) {
    database
      .prepare(
        `UPDATE subscriber_versions SET state = 'superseded', superseded_at = ?
          WHERE subscriber_id = ? AND version = ? AND state = 'active'`,
      )
      .run(input.now, input.subscriberId, row.version);
    cancelEventDeliveriesInTransaction(
      database,
      { subscriberId: input.subscriberId, subscriberVersion: row.version },
      input.now,
    );
  }
  const changed = database
    .prepare(
      `UPDATE subscriber_versions SET state = 'active', approval_id = ?, activated_at = ?
        WHERE subscriber_id = ? AND version = ? AND state = 'inert' AND revoked_at IS NULL`,
    )
    .run(input.approvalId, input.at, input.subscriberId, input.version).changes;
  if (changed !== 1)
    throw new CommsError(
      'APPROVAL_VOID',
      'the subscriber version left its inert state before its subscription completed',
    );
}

/** What a subscription's approval shows beside its document: the subscriber version it names, and W29's words. */
export interface SubscriptionPreviewV1 {
  readonly subscriber: SubscriberDocument;
  readonly words: string;
}

/**
 * The subscription preview for an approval view (W29): the exact subscriber version the activation names, read back and
 * checked against its digest, and the sentence that says what it receives, in which namespaces, where it goes and
 * whether it gets what senders wrote. Undefined for any other activation; a version that no longer matches its digest
 * has no preview, and its approval cannot complete.
 */
export function subscriptionPreviewFor(
  database: DatabaseSync,
  document: ActivationDocumentV1,
): SubscriptionPreviewV1 | undefined {
  if (document.kind !== 'subscription') return undefined;
  const row = database
    .prepare(
      'SELECT subscriber_id, version, document, digest FROM subscriber_versions WHERE subscriber_id = ? AND version = ?',
    )
    .get(document.subscription.subscriberId, document.subscription.version) as SubscriberRow | undefined;
  if (row === undefined || row.digest !== document.subscription.digest || sha256Hex(row.document) !== row.digest)
    return undefined;
  let subscriber: SubscriberDocument;
  try {
    subscriber = canonicalSubscriber(JSON.parse(row.document));
  } catch {
    return undefined;
  }
  if (subscriber.events === undefined) return undefined;
  const words = describeSubscription({
    subscriberId: subscriber.subscriberId,
    events: subscriber.events,
    where:
      subscriber.kind === 'sse'
        ? { kind: 'sse', host: subscriber.authority.host, port: subscriber.authority.port, origins: subscriber.origins }
        : {
            kind: 'webhook',
            authority: webhookSubscriberAuthority(subscriber),
            secret: subscriber.url.kind === 'secret',
          },
  });
  return { subscriber, words };
}
