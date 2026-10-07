/**
 * RFC 6901 JSON Pointers, as D3 handles them: canonical and own-property only.
 *
 * `""` names the root; `/` names the empty key; `~0` and `~1` are `~` and `/`, and no other escape exists. On an
 * array a token is an index exactly as RFC 6901 writes one — `0`, or digits without a leading zero — so `01`, `-` and
 * any other key are refused there; on an object the same tokens are ordinary keys. A value is reached through own
 * properties only, so `__proto__`, `constructor` and `prototype` are data when an object holds them and nothing when
 * it merely inherits them.
 *
 * Schema-aware resolution — what a rule's pointer names in a catalogue type — goes through the description's resolver
 * (`schema/resolve.ts`), with the same index rule.
 */
import type { JsonObject, JsonValue } from './json.ts';
import { EventsError, type Issue, type Result } from './result.ts';
import { nonNull, type SchemaNode } from './schema/describe.ts';
import { type PathToken, type Resolved, resolve } from './schema/resolve.ts';

/** An array index as RFC 6901 writes one: `0`, or digits with no leading zero. */
const ARRAY_INDEX = /^(?:0|[1-9][0-9]*)$/;

/** Whether `token` names an array element. */
export function isArrayIndex(token: string): boolean {
  return ARRAY_INDEX.test(token);
}

const malformed = (pointer: string, why: string): Issue => ({
  code: 'POINTER_MALFORMED',
  message: `${JSON.stringify(pointer)} is not an RFC 6901 pointer: ${why}`,
});

/** The reference tokens of `pointer`, unescaped, or the issue (`POINTER_MALFORMED`) that refuses it. */
export function parsePointer(pointer: string): Result<readonly string[]> {
  if (typeof pointer !== 'string') return { ok: false, issues: [malformed(String(pointer), 'it is not a string')] };
  if (pointer === '') return { ok: true, value: [] };
  if (pointer.charAt(0) !== '/') {
    return { ok: false, issues: [malformed(pointer, 'a pointer other than the root starts with "/"')] };
  }
  const tokens: string[] = [];
  for (const raw of pointer.slice(1).split('/')) {
    let token = '';
    for (let index = 0; index < raw.length; index += 1) {
      const character = raw.charAt(index);
      if (character !== '~') {
        token += character;
        continue;
      }
      const next = raw.charAt(index + 1);
      if (next !== '0' && next !== '1') {
        const what = next === '' ? 'a "~" ends a token' : `"~${next}" is no escape`;
        return { ok: false, issues: [malformed(pointer, `${what}; only "~0" and "~1" are`)] };
      }
      token += next === '0' ? '~' : '/';
      index += 1;
    }
    tokens.push(token);
  }
  return { ok: true, value: tokens };
}

/** `pointer`'s tokens, or `EventsError` (`POINTER_MALFORMED`) for text that is not a pointer. */
function tokensOf(pointer: string): readonly string[] {
  const parsed = parsePointer(pointer);
  if (parsed.ok) return parsed.value;
  throw new EventsError('POINTER_MALFORMED', parsed.issues[0]?.message ?? 'not an RFC 6901 pointer');
}

/**
 * `tokens` written as a pointer: `~` as `~0` and `/` as `~1`, an index as its digits. Throws `EventsError`
 * (`POINTER_MALFORMED`) for a number that is not an index.
 */
export function formatPointer(tokens: readonly (string | number)[]): string {
  let pointer = '';
  for (const token of tokens) {
    if (typeof token === 'number') {
      if (!Number.isSafeInteger(token) || token < 0) {
        throw new EventsError('POINTER_MALFORMED', `${token} is not an array index`);
      }
      pointer += `/${token}`;
    } else if (typeof token === 'string') {
      pointer += `/${token.replaceAll('~', '~0').replaceAll('/', '~1')}`;
    } else {
      throw new EventsError('POINTER_MALFORMED', `a pointer token is a string or an index, not ${String(token)}`);
    }
  }
  return pointer;
}

/**
 * The value `pointer` names in `value`, by own properties only: found, or not — an absent key, an index past the end,
 * a step through `null` or below a scalar. Throws `EventsError`: `POINTER_MALFORMED` for text that is not a pointer,
 * and `POINTER_NOT_IN_SCHEMA` for a token on an array that is not an index (`01`, `-`, `length`).
 */
export function getPointer(
  value: JsonValue,
  pointer: string,
): { readonly found: true; readonly value: JsonValue } | { readonly found: false } {
  let at: JsonValue = value;
  for (const token of tokensOf(pointer)) {
    if (Array.isArray(at)) {
      if (!isArrayIndex(token)) {
        throw new EventsError(
          'POINTER_NOT_IN_SCHEMA',
          `${JSON.stringify(token)} is not an array index, in ${JSON.stringify(pointer)}`,
          pointer,
        );
      }
      const index = Number(token);
      const element = index < at.length ? (at as readonly JsonValue[])[index] : undefined;
      if (element === undefined) return { found: false };
      at = element;
    } else if (at !== null && typeof at === 'object') {
      const object = at as JsonObject;
      if (!Object.hasOwn(object, token)) return { found: false };
      const member = object[token];
      if (member === undefined) return { found: false };
      at = member;
    } else {
      return { found: false };
    }
  }
  return { found: true, value: at };
}

/**
 * How `a` stands to `b`, token by token: `equal`; `ancestor` when `a` names a value that holds `b`'s; `descendant`
 * when `b`'s holds `a`'s; otherwise `disjoint`. `/a/b` and `/a/bc` are disjoint, though one is a prefix of the other
 * as text. Throws `EventsError` (`POINTER_MALFORMED`) for text that is not a pointer.
 */
export function relatePointers(a: string, b: string): 'equal' | 'ancestor' | 'descendant' | 'disjoint' {
  const left = tokensOf(a);
  const right = tokensOf(b);
  const shared = Math.min(left.length, right.length);
  for (let index = 0; index < shared; index += 1) if (left[index] !== right[index]) return 'disjoint';
  if (left.length === right.length) return 'equal';
  return left.length < right.length ? 'ancestor' : 'descendant';
}

/**
 * What a concrete pointer names in a schema description: the node, or the issue that refuses it —
 * `POINTER_MALFORMED` for text that is not a pointer, `POINTER_NOT_IN_SCHEMA` for a key the description does not
 * declare or a token on an array that is not an index.
 */
export function resolvePointer(root: SchemaNode, pointer: string): Result<Resolved> {
  const parsed = parsePointer(pointer);
  if (!parsed.ok) return parsed;
  const path: PathToken[] = [];
  let node = root;
  for (const token of parsed.value) {
    if (nonNull(node).kind === 'array') {
      if (!isArrayIndex(token)) {
        const message = `${JSON.stringify(token)} is not an array index, in ${JSON.stringify(pointer)}`;
        return { ok: false, issues: [{ code: 'POINTER_NOT_IN_SCHEMA', message }] };
      }
      // Every index of an array has its items' node; an index past any length is still well-formed.
      path.push({ any: true });
    } else {
      path.push(token);
    }
    const step = resolve(root, path);
    if (!step.ok) return step;
    node = step.value.node;
  }
  return resolve(root, path);
}
