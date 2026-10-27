import { canonicalJson } from '@agentcomms/core';
import { canonicalEventSubscription, type EventSubscriptionV1 } from './event-subscription.ts';
import { EventDomainError } from './lifecycle.ts';
import {
  canonicalAddressSet,
  canonicalUrlDescriptor,
  hasApprovedNetworkAuthority,
  type PlainWebhookUrl,
  type SecretWebhookUrl,
} from './webhook-target.ts';

/**
 * A subscriber off this Mac (workflows design W29, W32, §4.2): a signed webhook at a URL, with a webhook target's
 * network authority and retry limit, and the events it is given. It has no representation: what a sender wrote reaches
 * it only as its subscription's `content` allows, inside the envelope. Its signing secret and a secret URL are the
 * person's, made at the terminal (`subscriber secret create|rotate`, `subscriber url set`), never in this document.
 */
export interface WebhookSubscriberDocument {
  readonly subscriberId: string;
  readonly version: number;
  readonly kind: 'webhook';
  readonly url: PlainWebhookUrl | SecretWebhookUrl;
  readonly approvedAddressSet: readonly string[];
  readonly signing: 'standard-webhooks';
  readonly retryLimit: number;
  readonly events: EventSubscriptionV1;
}

const KEYS: readonly string[] = [
  'approvedAddressSet',
  'events',
  'kind',
  'retryLimit',
  'signing',
  'subscriberId',
  'url',
  'version',
];

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${name} is a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${name} is a positive safe integer`);
  return value as number;
}

/** Canonicalises a webhook subscriber: closed keys, a webhook target's URL and address rules, and its events. */
export function canonicalWebhookSubscriber(value: unknown): WebhookSubscriberDocument {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('a webhook subscriber document is an object');
  let subscriber: Record<string, unknown>;
  try {
    subscriber = JSON.parse(canonicalJson(value as never)) as Record<string, unknown>;
  } catch {
    return fail('a webhook subscriber document is canonical JSON');
  }
  if (subscriber.kind !== 'webhook') return fail('a webhook subscriber document has kind webhook');
  for (const key of Object.keys(subscriber))
    if (!KEYS.includes(key)) return fail(`a webhook subscriber document has no field ${key}`);
  if (subscriber.signing !== 'standard-webhooks') return fail('a webhook subscriber uses standard-webhooks signing');
  const retryLimit = positiveInteger(subscriber.retryLimit, 'a webhook subscriber retry limit');
  if (retryLimit > 20) return fail('a webhook subscriber retry limit is at most 20');
  if (subscriber.events === undefined) return fail('a webhook subscriber is given events');
  const url = canonicalUrlDescriptor(subscriber.url);
  const approvedAddressSet = canonicalAddressSet(subscriber.approvedAddressSet);
  if (!hasApprovedNetworkAuthority(url, approvedAddressSet))
    return fail('a webhook subscriber has an approved network authority');
  return {
    subscriberId: text(subscriber.subscriberId, 'a webhook subscriber id'),
    version: positiveInteger(subscriber.version, 'a webhook subscriber version'),
    kind: 'webhook',
    url,
    approvedAddressSet,
    signing: 'standard-webhooks',
    retryLimit,
    events: canonicalEventSubscription(subscriber.events),
  };
}

/** The public authority a webhook subscriber posts to, as its preview names it: never a secret URL's path or query. */
export function webhookSubscriberAuthority(document: WebhookSubscriberDocument): string {
  if (document.url.kind === 'plain') {
    const parsed = new URL(document.url.value);
    return `${parsed.protocol}//${parsed.host}`;
  }
  const host = document.url.host.includes(':') ? `[${document.url.host}]` : document.url.host;
  return `${document.url.scheme}://${host}:${document.url.port}`;
}
