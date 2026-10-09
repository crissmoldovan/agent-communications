import { canonicalJson } from '@agentcomms/core';
import type { DeliveryTarget } from '../runtime/target-delivery.ts';
import { EventDomainError } from './lifecycle.ts';

export interface SseSubscriberDocument {
  readonly subscriberId: string;
  readonly version: number;
  readonly kind: 'sse';
  readonly authority: { readonly host: '127.0.0.1' | '::1'; readonly port: number };
  readonly origins: readonly string[];
  readonly retentionMs: number;
}

export interface SseTargetDocument {
  readonly targetId: string;
  readonly version: number;
  readonly kind: 'sse';
  readonly subscriberId: string;
  readonly subscriberVersion: number;
  readonly representation: 'plain' | 'enveloped';
}

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return fail(`${name} is an object`);
  try {
    return JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  } catch {
    return fail(`${name} is canonical JSON`);
  }
}

function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) return fail(`${name} is a non-empty string`);
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return fail(`${name} is a positive safe integer`);
  return value as number;
}

function canonicalOrigin(value: unknown): string {
  const origin = text(value, 'an SSE allowed Origin');
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    return fail('an SSE allowed Origin is a URL origin');
  }
  if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || parsed.origin !== origin) {
    return fail('an SSE allowed Origin is an exact http or https origin');
  }
  return origin;
}

/** Canonicalises listener authority, exact browser origins and replay retention; bearer bytes are absent. */
export function canonicalSseSubscriber(value: unknown): SseSubscriberDocument {
  const subscriber = record(value, 'an SSE subscriber document');
  if (subscriber.kind !== 'sse') return fail('an SSE subscriber document has kind sse');
  const authority = record(subscriber.authority, 'an SSE subscriber authority');
  const host = text(authority.host, 'an SSE subscriber authority host');
  if (host !== '127.0.0.1' && host !== '::1') return fail('an SSE subscriber authority host is literal loopback');
  const origins = Array.isArray(subscriber.origins)
    ? subscriber.origins.map(canonicalOrigin)
    : fail('SSE allowed Origins are an array');
  if (
    origins.length === 0 ||
    new Set(origins).size !== origins.length ||
    [...origins].sort().some((origin, index) => origin !== origins[index])
  ) {
    return fail('SSE allowed Origins are non-empty, sorted and duplicate-free');
  }
  const retentionMs = positiveInteger(subscriber.retentionMs, 'SSE replay retention');
  if (retentionMs > 604_800_000) return fail('SSE replay retention is at most seven days');
  const port = positiveInteger(authority.port, 'an SSE subscriber authority port');
  if (port > 65_535) return fail('an SSE subscriber authority port is at most 65535');
  return {
    subscriberId: text(subscriber.subscriberId, 'an SSE subscriber id'),
    version: positiveInteger(subscriber.version, 'an SSE subscriber version'),
    kind: 'sse',
    authority: { host, port },
    origins,
    retentionMs,
  };
}

/** Canonicalises a target's immutable binding to an SSE subscriber version. */
export function canonicalSseTarget(value: unknown): SseTargetDocument {
  const target = record(value, 'an SSE target document');
  if (target.kind !== 'sse') return fail('an SSE target document has kind sse');
  if (target.representation !== 'plain' && target.representation !== 'enveloped') {
    return fail('an SSE target representation is plain or enveloped');
  }
  return {
    targetId: text(target.targetId, 'an SSE target id'),
    version: positiveInteger(target.version, 'an SSE target version'),
    kind: 'sse',
    subscriberId: text(target.subscriberId, 'an SSE target subscriber id'),
    subscriberVersion: positiveInteger(target.subscriberVersion, 'an SSE target subscriber version'),
    representation: target.representation,
  };
}

/** Maps an exact target/subscriber binding to Task 2's closed delivery union. */
export function sseDeliveryTarget(input: {
  readonly targetId: string;
  readonly version: number;
  readonly subscriber: SseSubscriberDocument;
  readonly representation: 'plain' | 'enveloped';
}): DeliveryTarget {
  return {
    kind: 'sse',
    targetId: input.targetId,
    targetVersion: input.version,
    subscriberId: input.subscriber.subscriberId,
    subscriberVersion: input.subscriber.version,
    representation: input.representation,
  };
}
