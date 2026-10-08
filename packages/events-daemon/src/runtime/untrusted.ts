import { neutralise, TaintCollector, type TaintExclusions, type TaintStore } from '@agentcomms/core';
import {
  type AnyEventDefinition,
  expandPattern,
  getPointer,
  type JsonValue,
  type MappedClassification,
  parsePointer,
} from '@agentcomms/events';

export interface EventTaintInput {
  readonly eventId: string;
  readonly accountId: string;
  readonly classification: MappedClassification;
}

export interface EventTaintRecorder {
  record(input: EventTaintInput): Promise<void>;
}

function setStringAt(target: Record<string, unknown>, pointer: string, value: string): void {
  const parsed = parsePointer(pointer);
  if (!parsed.ok || parsed.value.length === 0) return;
  let current: Record<string, unknown> | unknown[] = target;
  for (const token of parsed.value.slice(0, -1)) {
    const key = String(token);
    const next = Array.isArray(current) ? current[Number(key)] : current[key];
    if (next === null || typeof next !== 'object') return;
    current = next as Record<string, unknown> | unknown[];
  }
  const final = String(parsed.value.at(-1));
  if (Array.isArray(current)) current[Number(final)] = value;
  else current[final] = value;
}

/** Re-applies core's sender-text neutraliser to every catalogue-declared untrusted field before mapping or retention. */
export function sanitiseSenderFields(
  definition: AnyEventDefinition,
  event: Record<string, unknown>,
): Record<string, unknown> {
  const result = JSON.parse(JSON.stringify(event)) as Record<string, unknown>;
  for (const pattern of definition.untrusted) {
    for (const pointer of expandPattern(pattern, result as JsonValue)) {
      const found = getPointer(result as JsonValue, pointer);
      if (found.found && typeof found.value === 'string') setStringAt(result, pointer, neutralise(found.value).text);
    }
  }
  return result;
}

/** Records exact target-specific D3 provenance as event-origin taint before any durable delivery is created. */
export async function recordEventTaint(
  store: TaintStore,
  exclusions: TaintExclusions,
  input: EventTaintInput,
): Promise<void> {
  const collector = new TaintCollector(input.accountId, input.eventId);
  collector.observeHeaders(
    input.classification.addresses.map((entry) => entry.address),
    'event',
  );
  for (const entry of input.classification.untrusted) collector.observeText(entry.text, 'event');
  collector.observeHandles(
    input.classification.handles.map((entry) => ({ platform: 'gmail', scope: entry.workspace, id: entry.id })),
    'body',
    'event',
  );
  await collector.flush(store, exclusions);
}
