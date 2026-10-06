/**
 * JSON values, and canonical JSON: the library's own, byte-identical to `@agentcomms/core`'s `canonicalJson`
 * (`packages/core/src/digest.ts`), which the library cannot import because core's digest imports Node's crypto
 * module (events phase A plan, decision 11).
 *
 * Object keys are sorted by UTF-16 code units — ECMAScript's `<`, as core sorts them — and `undefined` members are
 * dropped; every scalar and key is written by `JSON.stringify`. Where core would write something for a value that is
 * not JSON — `undefined` in an array, a non-finite number, a `Map`, a class instance — this refuses it instead.
 * Arrays the catalogue and the wire call "sorted by raw UTF-8 bytes" are sorted with `compareUtf8`; that is a
 * different order, and not this one.
 */
import { EventsError } from './result.ts';

/** A JSON value. */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** A JSON object. A member may be `undefined`, which is the same as absent: canonical JSON drops it. */
export interface JsonObject {
  readonly [key: string]: JsonValue | undefined;
}

/** An RFC 6901 pointer token: `~` and `/` escaped. */
const token = (key: string | number): string => String(key).replaceAll('~', '~0').replaceAll('/', '~1');

/**
 * Whether `value` is an object JSON could have made: its prototype is an `Object.prototype` (of any realm) or null.
 * A `Map`, a `Date`, a class instance or an object made from another prototype is not.
 */
function isPlainObject(value: object): boolean {
  const prototype = Object.getPrototypeOf(value) as object | null;
  if (prototype === null) return true;
  return Object.getPrototypeOf(prototype) === null && Object.prototype.toString.call(value) === '[object Object]';
}

/** Why `value` is not JSON, as `[pointer, what]`, or null when it is. */
function notJson(value: unknown, at: string, ancestors: object[]): [string, string] | null {
  if (value === null) return null;
  switch (typeof value) {
    case 'boolean':
    case 'string':
      return null;
    case 'number':
      return Number.isFinite(value) ? null : [at, 'a non-finite number'];
    case 'object':
      break;
    default:
      return [at, typeof value === 'undefined' ? 'undefined' : `a ${typeof value}`];
  }
  if (ancestors.includes(value)) return [at, 'a cycle: the value contains itself'];
  ancestors.push(value);
  try {
    if (Array.isArray(value)) {
      for (let index = 0; index < value.length; index += 1) {
        // A hole reads as undefined, and is refused as one.
        const found = notJson(value[index], `${at}/${index}`, ancestors);
        if (found !== null) return found;
      }
      return null;
    }
    if (!isPlainObject(value)) return [at, 'not a plain object'];
    for (const [key, member] of Object.entries(value)) {
      if (member === undefined) continue;
      const found = notJson(member, `${at}/${token(key)}`, ancestors);
      if (found !== null) return found;
    }
    return null;
  } finally {
    ancestors.pop();
  }
}

/** Whether `value` is a JSON value canonical JSON can write: what `canonicalJson` accepts, it accepts. */
export function isJsonValue(value: unknown): value is JsonValue {
  return notJson(value, '', []) === null;
}

/** Writes an already-checked JSON value. */
function write(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(write).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, member]) => member !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, member]) => `${JSON.stringify(key)}:${write(member)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Deterministic JSON text for `value`: keys sorted by UTF-16 code units at every level, `undefined` members dropped,
 * exactly as core writes it. Throws `EventsError` (`NOT_JSON`, with a pointer to the place) for anything that is not
 * JSON.
 */
export function canonicalJson(value: unknown): string {
  const found = notJson(value, '', []);
  if (found !== null) {
    const [pointer, what] = found;
    throw new EventsError('NOT_JSON', `${pointer === '' ? 'the value' : pointer} is ${what}, not JSON`, pointer);
  }
  return write(value);
}
