import type { AnyEventDefinition } from '../catalogue/types.ts';
import { canonicalJson, isJsonValue, type JsonValue } from '../json.ts';
import { resolvePointer } from '../pointer.ts';
import { EventsError, type Result } from '../result.ts';
import { utf8ByteLength } from '../text.ts';
import type { CompiledMapping, MissingPolicy } from './types.ts';

/** D6's mapping-template limits, all inclusive. */
export const MAPPING_LIMITS = { leaves: 200, constantBytes: 4096, mappedBytes: 262_144 } as const;

const issue = (pointer: string, message: string) => ({ code: 'MAPPING_INVALID' as const, pointer, message });

const pointerAt = (parent: string, token: string | number): string =>
  `${parent}/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`;

function missingPolicy(value: unknown, at: string): MissingPolicy {
  if (value === undefined) return 'reject';
  if (value === 'reject' || value === 'null' || value === 'omit') return value;
  throw new EventsError('MAPPING_INVALID', `the missing policy at ${at} is not reject, null or omit`, at);
}

/** Check D6's JSON template grammar against one source definition. */
export function compileMapping(definition: AnyEventDefinition, template: unknown): Result<CompiledMapping> {
  if (!isJsonValue(template)) return { ok: false, issues: [issue('', 'a mapping template is a JSON value')] };
  let leaves = 0;
  const compile = (
    value: JsonValue,
    at: string,
    placement: 'root' | 'object' | 'array',
  ): import('./types.ts').CompiledNode => {
    if (value === null || typeof value !== 'object') {
      leaves += 1;
      if (utf8ByteLength(canonicalJson(value)) > MAPPING_LIMITS.constantBytes) {
        throw new EventsError(
          'MAPPING_LIMIT_EXCEEDED',
          `the constant at ${at || '(root)'} exceeds 4096 UTF-8 bytes`,
          at,
        );
      }
      return { kind: 'constant', value };
    }
    if (Array.isArray(value)) {
      if (value.length === 0) leaves += 1;
      return { kind: 'array', items: value.map((item, index) => compile(item, pointerAt(at, index), 'array')) };
    }
    const object = value as Readonly<Record<string, JsonValue>>;
    if (Object.hasOwn(object, '$path')) {
      const keys = Object.keys(object);
      if (keys.some((key) => key !== '$path' && key !== 'missing')) {
        throw new EventsError('MAPPING_INVALID', `a $path object at ${at || '(root)'} has only $path and missing`, at);
      }
      const path = object.$path;
      if (typeof path !== 'string')
        throw new EventsError('MAPPING_INVALID', `the $path at ${at || '(root)'} is a string`, at);
      const missing = missingPolicy(object.missing, at);
      if (missing === 'omit' && placement !== 'object') {
        throw new EventsError('MAPPING_INVALID', 'omit is legal only for an object property', at);
      }
      const internal = definition as unknown as { description: import('../schema/describe.ts').ObjectNode };
      const resolved = resolvePointer(internal.description, path);
      if (!resolved.ok) {
        const first = resolved.issues[0];
        return fail(first?.message ?? `the $path ${JSON.stringify(path)} is not in the source schema`, at);
      }
      leaves += 1;
      return { kind: 'reference', pointer: path, missing, node: resolved.value.node };
    }
    const entries = Object.entries(object);
    if (entries.length === 0) leaves += 1;
    return {
      kind: 'object',
      properties: entries.map(([key, member]) => ({ key, node: compile(member, pointerAt(at, key), 'object') })),
    };
  };
  const fail = (message: string, at: string): never => {
    throw new EventsError('MAPPING_INVALID', message, at);
  };
  try {
    const root = compile(template, '', 'root');
    if (leaves > MAPPING_LIMITS.leaves) {
      return {
        ok: false,
        issues: [issue('', `the mapping has ${leaves} leaves; D6 allows at most ${MAPPING_LIMITS.leaves}`)],
      };
    }
    return { ok: true, value: { definition, root, leaves } };
  } catch (error) {
    if (error instanceof EventsError) {
      return {
        ok: false,
        issues: [
          error.pointer === undefined
            ? { code: error.code, message: error.message }
            : { code: error.code, pointer: error.pointer, message: error.message },
        ],
      };
    }
    throw error;
  }
}
