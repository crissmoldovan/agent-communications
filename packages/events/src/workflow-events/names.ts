/**
 * Step event names and the patterns subscribers give (workflows design W24, W30, Appendix W.1). A name is
 * `<namespace>.<workflow>.<step>.<event>`, each segment `^[a-z][a-z0-9_-]{0,31}$`, so at most 131 characters. A
 * pattern is four segments, each a literal segment or `*`, where `*` matches exactly one segment: no `**`, no partial
 * wildcard, no regular expression. Its first segment is one of the subscriber's namespaces, or `*` for any of them, so
 * nothing outside the namespaces given ever matches.
 *
 * Only literal strings are names. Text a sender wrote that happens to look like one (`acme.client-asks.issue.created`)
 * is still data wherever it travels: these functions decide nothing from anything but the strings a workflow or a
 * subscription holds.
 */
import { EventsError } from '../result.ts';

/** One segment of a step event's name (W.1). */
export const EVENT_SEGMENT: RegExp = /^[a-z][a-z0-9_-]{0,31}$/;

/** The suite's own namespace: a protocol name, never a command. */
const SUITE_NAMESPACE = 'agentcomms';

/** Namespaces no workflow may raise in: `com.agentcomms.<type>.v<n>` is today's message events' default type. */
export const RESERVED_NAMESPACES: readonly ['agentcomms', 'com'] = Object.freeze([SUITE_NAMESPACE, 'com'] as const);

/** Whether `value` is a literal string that is one segment of an event name. Anything that is not a string is not. */
export function isEventSegment(value: unknown): value is string {
  return typeof value === 'string' && EVENT_SEGMENT.test(value);
}

function reserved(namespace: string): boolean {
  return (RESERVED_NAMESPACES as readonly string[]).includes(namespace);
}

/** The namespaced name of a step's or a run's event: `acme.client-asks.issue.created`. Refuses a malformed segment. */
export function workflowEventType(namespace: string, workflow: string, step: string, event: string): string {
  for (const [what, segment] of [
    ['namespace', namespace],
    ['workflow', workflow],
    ['step', step],
    ['event', event],
  ] as const) {
    if (!isEventSegment(segment))
      throw new EventsError(
        'WORKFLOW_EVENT_INVALID',
        `an event's ${what} is a lowercase segment of 1 to 32 letters, digits, _ and -, starting with a letter`,
      );
  }
  if (reserved(namespace))
    throw new EventsError('WORKFLOW_EVENT_INVALID', `the namespace ${namespace} is reserved for Agent Comms`);
  return `${namespace}.${workflow}.${step}.${event}`;
}

/** A step event's name in its four parts, or null when it is not one: a malformed segment, or a reserved namespace. */
export function parseWorkflowEventType(
  type: string,
): { namespace: string; workflow: string; step: string; event: string } | null {
  if (typeof type !== 'string') return null;
  const segments = type.split('.');
  if (segments.length !== 4 || !segments.every(isEventSegment)) return null;
  const [namespace, workflow, step, event] = segments as [string, string, string, string];
  if (reserved(namespace)) return null;
  return { namespace, workflow, step, event };
}

/** A pattern's four segments, each a segment or `*`, or why it is not a pattern. */
function patternSegments(value: unknown): readonly string[] | string {
  if (typeof value !== 'string') return 'a pattern is text';
  const segments = value.split('.');
  if (segments.length !== 4) return 'a pattern has four segments: namespace, workflow, step and event';
  for (const segment of segments)
    if (segment !== '*' && !isEventSegment(segment))
      return `${JSON.stringify(segment)} is neither a segment nor *: a * stands alone, for exactly one segment`;
  return segments;
}

/**
 * Checks a subscriber's pattern against the namespaces it was given (W30): four segments, each a literal segment or
 * `*`, the first one of those namespaces or `*`. A reserved namespace is never given. The canonical pattern is the text
 * itself, since nothing in it folds.
 */
export function canonicalEventPattern(
  value: unknown,
  namespaces: readonly string[],
): { ok: true; pattern: string } | { ok: false; message: string } {
  const segments = patternSegments(value);
  if (typeof segments === 'string') return { ok: false, message: segments };
  const namespace = segments[0] as string;
  if (namespace !== '*') {
    if (reserved(namespace)) return { ok: false, message: `the namespace ${namespace} is reserved for Agent Comms` };
    if (!namespaces.includes(namespace))
      return { ok: false, message: `the namespace ${namespace} is not one this subscriber was given` };
  }
  return { ok: true, pattern: value as string };
}

/**
 * Whether the event named `type` matches `pattern` inside `namespaces`, segment by segment: `*` matches exactly one
 * segment and never spans a dot, and the event's namespace must be one of those given whatever the pattern says. The
 * one decision for delivery and for the subscription's preview alike.
 */
export function matchesEventPattern(type: string, pattern: string, namespaces: readonly string[]): boolean {
  const parsed = parseWorkflowEventType(type);
  if (parsed === null) return false;
  if (!namespaces.includes(parsed.namespace) || reserved(parsed.namespace)) return false;
  const segments = patternSegments(pattern);
  if (typeof segments === 'string') return false;
  const actual = [parsed.namespace, parsed.workflow, parsed.step, parsed.event];
  return segments.every((segment, index) => segment === '*' || segment === actual[index]);
}
