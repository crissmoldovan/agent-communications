/**
 * D3's pointer patterns: how a catalogue definition names its untrusted, content, address, handle and format fields.
 *
 * A string token is one exact object key; `{ any: true }` is one arbitrary array index. There is no wildcard inside a
 * string, so `"*"` is the literal key `*`. Against a schema description, an `any` token on an object and a string
 * token on an array are refused. For an event, a pattern expands to concrete RFC 6901 pointers: keys escaped, `any`
 * taken as every present index in order, and nothing for a property that is absent or a value that is `null` — an
 * optional property or a nullable parent contributes no pointer then (A.1), and a `null` where the pattern ends holds
 * no value of the type the pattern names.
 */
import type { JsonObject, JsonValue } from './json.ts';
import { formatPointer, isArrayIndex, parsePointer } from './pointer.ts';
import { EventsError, type Result } from './result.ts';
import type { SchemaNode } from './schema/describe.ts';
import { type Resolved, resolve } from './schema/resolve.ts';

/** One step of a pattern: an exact object key, or any array index. */
export type PointerPatternToken = string | { readonly any: true };

/** A pointer pattern, as D3 writes it: `['to', { any: true }, 'address']`. */
export type PointerPattern = readonly PointerPatternToken[];

/** Whether `token` is exactly `{ any: true }`, with nothing beside it. */
function isAny(token: unknown): token is { readonly any: true } {
  if (typeof token !== 'object' || token === null || Array.isArray(token)) return false;
  const keys = Object.keys(token);
  return keys.length === 1 && keys[0] === 'any' && (token as { any?: unknown }).any === true;
}

/** Why `pattern` is not a D3 pattern, or undefined when it is one. */
function whyMalformed(pattern: unknown): string | undefined {
  if (!Array.isArray(pattern)) return 'a pattern is a list of tokens';
  const index = pattern.findIndex((token) => typeof token !== 'string' && !isAny(token));
  if (index === -1) return undefined;
  return `token ${index} is no pattern token: a pattern token is a string or exactly { any: true }`;
}

/** `pattern`, or `EventsError` (`POINTER_MALFORMED`) when it is not one. */
function checked(pattern: PointerPattern): PointerPattern {
  const why = whyMalformed(pattern);
  if (why !== undefined) throw new EventsError('POINTER_MALFORMED', `${JSON.stringify(pattern)}: ${why}`);
  return pattern;
}

/**
 * What `pattern` names in a schema description, or the issue that refuses it: `POINTER_MALFORMED` for something
 * that is not a pattern, `POINTER_NOT_IN_SCHEMA` for a key the description does not declare, an `any` token on an
 * object, a string token on an array or a step below a scalar.
 */
export function checkPattern(root: SchemaNode, pattern: PointerPattern): Result<Resolved> {
  const why = whyMalformed(pattern);
  if (why !== undefined) {
    return { ok: false, issues: [{ code: 'POINTER_MALFORMED', message: `${JSON.stringify(pattern)}: ${why}` }] };
  }
  return resolve(root, pattern);
}

/**
 * Every concrete pointer `pattern` names in `value`, in document order and every `any` in index order. An absent
 * property and a `null` contribute nothing. Throws `EventsError`: `POINTER_MALFORMED` for something that is not a
 * pattern, and `POINTER_NOT_IN_SCHEMA` where the pattern does not fit the value's shape — a key on an array, an `any`
 * on an object, a step below a scalar — which a pattern legal for the value's schema never does.
 */
export function expandPattern(pattern: PointerPattern, value: JsonValue): readonly string[] {
  const tokens = checked(pattern);
  const found: string[] = [];
  const misfit = (index: number, why: string) =>
    new EventsError(
      'POINTER_NOT_IN_SCHEMA',
      `${JSON.stringify(pattern)} does not fit the value: token ${index} ${why}`,
    );
  const walk = (at: JsonValue, index: number, path: (string | number)[]): void => {
    if (at === null) return;
    if (index === tokens.length) {
      found.push(formatPointer(path));
      return;
    }
    const token = tokens[index];
    if (Array.isArray(at)) {
      if (typeof token === 'string') throw misfit(index, 'is a key, where the value is an array');
      const items = at as readonly JsonValue[];
      for (let item = 0; item < items.length; item += 1) {
        const element = items[item];
        if (element !== undefined) walk(element, index + 1, [...path, item]);
      }
    } else if (typeof at === 'object') {
      if (typeof token !== 'string') throw misfit(index, 'is an index, where the value is an object');
      const object = at as JsonObject;
      if (!Object.hasOwn(object, token)) return;
      const member = object[token];
      if (member !== undefined) walk(member, index + 1, [...path, token]);
    } else {
      throw misfit(index, `goes below a ${typeof at}`);
    }
  };
  walk(value, 0, []);
  return found;
}

/**
 * Whether the concrete `pointer` is one `pattern` names: as many tokens, each key equal, and an RFC 6901 index
 * wherever the pattern has `any`. Throws `EventsError` (`POINTER_MALFORMED`) for a pointer or a pattern that is
 * malformed.
 */
export function matchesPattern(pattern: PointerPattern, pointer: string): boolean {
  const tokens = checked(pattern);
  const parsed = parsePointer(pointer);
  if (!parsed.ok) throw new EventsError('POINTER_MALFORMED', parsed.issues[0]?.message ?? 'not an RFC 6901 pointer');
  const concrete = parsed.value;
  if (concrete.length !== tokens.length) return false;
  return tokens.every((token, index) => {
    const step = concrete[index] as string;
    return typeof token === 'string' ? token === step : isArrayIndex(step);
  });
}
