import type { JsonObject, JsonValue } from '../json.ts';
import { parsePointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import type { MappedClassification, Representation } from './types.ts';

function clone(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const result: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value as JsonObject)) result[key] = clone(member as JsonValue);
  return result;
}

/** Apply a D3 prose representation to exactly the classified sender-controlled strings. */
export function applyRepresentation(
  data: JsonValue,
  classified: MappedClassification,
  representation: Representation,
): JsonValue {
  if (representation.kind === 'plain') return clone(data);
  let result = clone(data);
  for (const entry of classified.untrusted) {
    const parsed = parsePointer(entry.pointer);
    if (!parsed.ok) throw new EventsError('POINTER_MALFORMED', parsed.issues[0]?.message ?? 'not a pointer');
    if (parsed.value.length === 0) {
      if (typeof result !== 'string')
        throw new EventsError('MAPPING_INVALID', 'the root untrusted pointer does not hold a string');
      result = representation.envelope(result, entry.pointer);
      continue;
    }
    let parent: JsonValue = result;
    for (const token of parsed.value.slice(0, -1)) {
      if (parent === null || typeof parent !== 'object')
        throw new EventsError('MAPPING_INVALID', 'an untrusted pointer has no parent');
      parent = Array.isArray(parent)
        ? (parent[Number(token)] as JsonValue)
        : ((parent as JsonObject)[token] as JsonValue);
    }
    const last = parsed.value.at(-1);
    if (last === undefined || parent === null || typeof parent !== 'object')
      throw new EventsError('MAPPING_INVALID', 'an untrusted pointer has no value');
    const value = Array.isArray(parent) ? parent[Number(last)] : (parent as JsonObject)[last];
    if (typeof value !== 'string')
      throw new EventsError('MAPPING_INVALID', 'an untrusted pointer does not hold a string');
    if (Array.isArray(parent)) parent[Number(last)] = representation.envelope(value, entry.pointer);
    else (parent as Record<string, JsonValue>)[last] = representation.envelope(value, entry.pointer);
  }
  return result;
}
