import type { JsonObject, JsonValue } from '../json.ts';
import { canonicalJson } from '../json.ts';
import { setOwn } from '../own-property.ts';
import { formatPointer, getPointer, parsePointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import { utf8ByteLength } from '../text.ts';
import { MAPPING_LIMITS } from './compile.ts';
import type { CompiledMapping, MappedValue, Provenance } from './types.ts';

const OMIT = Symbol('omit');

const append = (pointer: string, token: string | number): string => {
  const parsed = parsePointer(pointer);
  if (!parsed.ok) throw new EventsError('POINTER_MALFORMED', parsed.issues[0]?.message ?? 'not a pointer');
  return formatPointer([...parsed.value, token]);
};

function clone(value: JsonValue): JsonValue {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  const result: Record<string, JsonValue> = {};
  for (const [key, member] of Object.entries(value as JsonObject)) setOwn(result, key, clone(member as JsonValue));
  return result;
}

function recordCopied(value: JsonValue, output: string, source: string, into: Provenance[]): void {
  into.push({ kind: 'source', output, source });
  if (value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const item = value[index];
      if (item !== undefined) recordCopied(item, append(output, index), append(source, index), into);
    }
    return;
  }
  for (const [key, member] of Object.entries(value as JsonObject)) {
    recordCopied(member as JsonValue, append(output, key), append(source, key), into);
  }
}

/** Evaluate a checked mapping against a validated source event. */
export function evaluateMapping(mapping: CompiledMapping, event: unknown): MappedValue {
  const sourceEvent = event as JsonValue;
  const provenance: Provenance[] = [];
  const evaluate = (node: import('./types.ts').CompiledNode, output: string): JsonValue | typeof OMIT => {
    switch (node.kind) {
      case 'constant':
        provenance.push({ kind: 'constant', output });
        return clone(node.value);
      case 'reference': {
        const source = getPointer(sourceEvent, node.pointer);
        if (!source.found) {
          if (node.missing === 'omit') return OMIT;
          if (node.missing === 'null') {
            provenance.push({ kind: 'missing-null', output });
            return null;
          }
          throw new EventsError(
            'MAPPING_PATH_MISSING',
            `the source path ${JSON.stringify(node.pointer)} is absent for output ${JSON.stringify(output)}`,
            output,
          );
        }
        const copied = clone(source.value);
        recordCopied(copied, output, node.pointer, provenance);
        return copied;
      }
      case 'array': {
        const values: JsonValue[] = [];
        for (let index = 0; index < node.items.length; index += 1) {
          const item = node.items[index];
          if (item === undefined) continue;
          const result = evaluate(item, append(output, index));
          if (result === OMIT)
            throw new EventsError('MAPPING_INVALID', 'omit is not legal at an array element', append(output, index));
          values.push(result);
        }
        return values;
      }
      case 'object': {
        const object: Record<string, JsonValue> = {};
        for (const property of node.properties) {
          const result = evaluate(property.node, append(output, property.key));
          if (result !== OMIT) setOwn(object, property.key, result);
        }
        return object;
      }
    }
  };
  const data = evaluate(mapping.root, '');
  if (data === OMIT) throw new EventsError('MAPPING_INVALID', 'a mapping root cannot be omitted');
  checkMappedSize(data);
  return { data, provenance };
}

/** Refuse an encoded mapping whose canonical JSON exceeds D6's 256 KiB maximum. */
export function checkMappedSize(data: JsonValue): void {
  const bytes = utf8ByteLength(canonicalJson(data));
  if (bytes > MAPPING_LIMITS.mappedBytes) {
    throw new EventsError(
      'MAPPING_LIMIT_EXCEEDED',
      `the mapped event is ${bytes} UTF-8 bytes; D6 allows at most ${MAPPING_LIMITS.mappedBytes}`,
    );
  }
}
