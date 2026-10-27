import { canonicalJson } from '@agentcomms/core';
import { canonicalEventPattern, isEventSegment, matchesEventPattern, RESERVED_NAMESPACES } from '@agentcomms/events';
import { EventDomainError } from './lifecycle.ts';

/**
 * What a subscriber is given (workflows design W29, W30, §4.2): namespaces, the patterns that match inside them, and
 * whether it may receive what a sender wrote. One canonical form, stored in the subscriber version and bound by its
 * digest, so the person's approval of a subscription names exactly these words.
 */
export interface EventSubscriptionV1 {
  /** 1–8, sorted, unique, never a reserved namespace. */
  readonly namespaces: readonly string[];
  /** 1–32, sorted, unique: four segments each, a literal segment or `*`, the first one of `namespaces` or `*`. */
  readonly patterns: readonly string[];
  /** `enveloped`: a Raise step's declared fields reach it, inside the untrusted-content envelope (W27). */
  readonly content: 'none' | 'enveloped';
}

const NAMESPACES_MAX = 8;
const PATTERNS_MAX = 32;
const KEYS: readonly string[] = ['content', 'namespaces', 'patterns'];

function fail(message: string): never {
  throw new EventDomainError('VERSION_DOCUMENT_INVALID', message);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sortedUnique(values: readonly string[], name: string): readonly string[] {
  const sorted = [...values].sort(compareText);
  if (new Set(sorted).size !== sorted.length) return fail(`${name} has no duplicate values`);
  return sorted;
}

/**
 * Canonicalises a subscription: closed keys, namespaces that are event segments and not reserved, patterns checked
 * by `canonicalEventPattern` against those namespaces (a literal namespace not given is refused), all sorted and
 * unique. A value that is not a literal string is never a namespace or a pattern.
 */
export function canonicalEventSubscription(value: unknown): EventSubscriptionV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail("a subscriber's events are an object");
  let subscription: Record<string, unknown>;
  try {
    subscription = JSON.parse(canonicalJson(value as never)) as Record<string, unknown>;
  } catch {
    return fail("a subscriber's events are canonical JSON");
  }
  for (const key of Object.keys(subscription))
    if (!KEYS.includes(key)) return fail(`a subscriber's events have no field ${key}`);
  const rawNamespaces = subscription.namespaces;
  if (!Array.isArray(rawNamespaces) || rawNamespaces.length < 1 || rawNamespaces.length > NAMESPACES_MAX)
    return fail(`a subscriber is given 1 to ${NAMESPACES_MAX} namespaces`);
  const namespaces = sortedUnique(
    rawNamespaces.map((namespace) => {
      if (!isEventSegment(namespace))
        return fail('a namespace is a lowercase segment of 1 to 32 letters, digits, _ and -, starting with a letter');
      if ((RESERVED_NAMESPACES as readonly string[]).includes(namespace))
        return fail(`the namespace ${namespace} is reserved for Agent Comms`);
      return namespace;
    }),
    "a subscriber's namespaces",
  );
  const rawPatterns = subscription.patterns;
  if (!Array.isArray(rawPatterns) || rawPatterns.length < 1 || rawPatterns.length > PATTERNS_MAX)
    return fail(`a subscriber has 1 to ${PATTERNS_MAX} patterns`);
  const patterns = sortedUnique(
    rawPatterns.map((pattern) => {
      const checked = canonicalEventPattern(pattern, namespaces);
      if (!checked.ok) return fail(`a subscriber's pattern is refused: ${checked.message}`);
      return checked.pattern;
    }),
    "a subscriber's patterns",
  );
  if (subscription.content !== 'none' && subscription.content !== 'enveloped')
    return fail("a subscriber's content is none or enveloped");
  return { namespaces, patterns, content: subscription.content };
}

/** Whether an event named `type` reaches this subscription: one of its patterns, inside its namespaces (W30). */
export function subscriptionMatches(subscription: EventSubscriptionV1, type: string): boolean {
  return subscription.patterns.some((pattern) => matchesEventPattern(type, pattern, subscription.namespaces));
}

/** "a, b and c": a closed list as a person reads it. */
function wordsList(values: readonly string[]): string {
  if (values.length <= 1) return values.join('');
  return `${values.slice(0, -1).join(', ')} and ${values[values.length - 1]}`;
}

/**
 * The subscription's approval words (W29): what it receives, in which namespaces, whether it gets what senders wrote,
 * and where it goes. Every value is the document's own closed words: namespaces and patterns are event segments, an
 * address is loopback or the approved URL's public authority, an origin is an exact http(s) origin.
 */
export function describeSubscription(input: {
  readonly subscriberId: string;
  readonly events: EventSubscriptionV1;
  readonly where:
    | { readonly kind: 'sse'; readonly host: string; readonly port: number; readonly origins: readonly string[] }
    | { readonly kind: 'webhook'; readonly authority: string; readonly secret: boolean };
}): string {
  const { events } = input;
  const namespaces = `${events.namespaces.length === 1 ? 'the namespace' : 'the namespaces'} ${wordsList(events.namespaces)}`;
  const where =
    input.where.kind === 'sse'
      ? `live on this Mac at ${input.where.host === '::1' ? `[::1]` : input.where.host}:${input.where.port}, ${
          input.where.origins.length === 0
            ? 'from no browser page'
            : `from ${input.where.origins.length === 1 ? 'the page at' : 'the pages at'} ${wordsList(input.where.origins)}`
        }`
      : `by signed webhook to ${input.where.authority}${input.where.secret ? ' (a URL kept secret)' : ''}`;
  const content =
    events.content === 'none'
      ? 'Nothing a sender wrote.'
      : "With what senders wrote, where a workflow's Raise step declares it, inside the untrusted-content envelope.";
  return `${input.subscriberId} receives ${wordsList(events.patterns)} in ${namespaces}, ${where}. ${content}`;
}
