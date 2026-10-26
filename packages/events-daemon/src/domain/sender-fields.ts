import {
  catalogueEntry,
  formatPointer,
  getPointer,
  type JsonValue,
  matchesPattern,
  type PointerPattern,
  parsePointer,
} from '@agentcomms/events';
import { queueSenderSources } from './queue-target.ts';

/**
 * What a sender controls in an event of this type (review of 0.32.0, finding 2): the catalogue's untrusted fields and
 * its addresses — a From, Reply-To, To or Cc address is the sender's even after a format check — and every source field
 * the queue shows from the sender, from the queue's own field plan. One list, for the dry-run log and the queue alike.
 */
export function senderWrittenSources(eventType: string, eventVersion: number): readonly PointerPattern[] {
  const entry = catalogueEntry(eventType, eventVersion);
  const catalogued = entry.ok ? [...entry.value.untrusted, ...entry.value.addresses] : [];
  const queued = queueSenderSources(eventType).flatMap((pointer) => {
    const tokens = parsePointer(pointer);
    return tokens.ok ? [tokens.value as PointerPattern] : [];
  });
  return [...catalogued, ...queued];
}

/** Each `{ "$path": … }` reference of a mapping template, with the output it fills, in template order. */
function references(template: unknown, output: readonly string[], found: [readonly string[], string][]): void {
  if (template === null || typeof template !== 'object') return;
  if (Array.isArray(template)) {
    template.forEach((item, index) => {
      references(item, [...output, String(index)], found);
    });
    return;
  }
  const object = template as Readonly<Record<string, unknown>>;
  if (Object.hasOwn(object, '$path') && typeof object.$path === 'string') {
    found.push([output, object.$path]);
    return;
  }
  for (const [key, value] of Object.entries(object)) references(value, [...output, key], found);
}

/** Every string under `value`, by its tokens below it; own properties only. */
function stringLeaves(value: unknown, below: readonly string[], found: (readonly string[])[]): void {
  if (typeof value === 'string') {
    found.push(below);
    return;
  }
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      stringLeaves(item, [...below, String(index)], found);
    });
    return;
  }
  for (const key of Object.keys(value)) stringLeaves((value as Record<string, unknown>)[key], [...below, key], found);
}

/**
 * The pointers into a delivery's mapped `data` that hold what the sender controls: each string the rule's mapping
 * copied from one of `senderWrittenSources`, whatever key the mapping gave it. A mapping is constants, containers and
 * whole-subtree references (D6), so where each output came from is exact.
 */
export function senderWrittenDataPointers(input: {
  readonly eventType: string;
  readonly eventVersion: number;
  readonly mapping: unknown;
  readonly data: JsonValue;
}): readonly string[] {
  const patterns = senderWrittenSources(input.eventType, input.eventVersion);
  const found: [readonly string[], string][] = [];
  references(input.mapping, [], found);
  const pointers = new Set<string>();
  for (const [output, source] of found) {
    const sourceTokens = parsePointer(source);
    if (!sourceTokens.ok) continue;
    const at = getPointer(input.data, formatPointer(output));
    if (!at.found) continue;
    const leaves: (readonly string[])[] = [];
    stringLeaves(at.value, [], leaves);
    for (const below of leaves) {
      const from = formatPointer([...sourceTokens.value, ...below]);
      if (patterns.some((pattern) => matchesPattern(pattern, from))) pointers.add(formatPointer([...output, ...below]));
    }
  }
  return [...pointers];
}

/** Every string of `data`, by its pointer: what is wrapped when the rule that made it can no longer be read. */
export function allStringPointers(data: JsonValue): readonly string[] {
  const leaves: (readonly string[])[] = [];
  stringLeaves(data, [], leaves);
  return leaves.map((tokens) => formatPointer(tokens));
}
