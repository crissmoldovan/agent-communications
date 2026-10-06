/**
 * What a schema description declares at a path (events phase A plan, decision 5): what pointer validation, operator
 * legality and delivery-schema generation ask of the catalogue, answered from the same description the Zod and JSON
 * Schema compilers read.
 *
 * A path is a list of tokens: a string is one exact object key, a number one array index, and `{ any: true }` any
 * array index, as a D3 pointer pattern writes it. An object takes only its own declared keys, so `constructor` or
 * `__proto__` are never found by inheritance; an array takes only an index; nothing goes below a scalar. A nullable
 * node is passed through to the node it makes nullable, because a pattern such as `['from', 'address']` names a value
 * under a parent that may be null — and a value there, when there is one, is that node's.
 */
import type { Result } from '../result.ts';
import { nonNull, type SchemaNode } from './describe.ts';

/** One step of a path: an object key, an array index, or any array index. */
export type PathToken = string | number | { readonly any: true };

/** The node at a path, as declared — a nullable node still nullable — and whether its property is optional. */
export interface Resolved {
  readonly node: SchemaNode;
  readonly optional: boolean;
}

const ARTICLE: Readonly<Record<string, string>> = {
  string: 'a string',
  integer: 'an integer',
  boolean: 'a boolean',
  const: 'a const',
  enum: 'an enum',
  union: 'a union',
};

/** Whether `token` is exactly `{ any: true }`, with nothing beside it. */
function isAny(token: unknown): token is { readonly any: true } {
  if (typeof token !== 'object' || token === null || Array.isArray(token)) return false;
  const keys = Object.keys(token);
  return keys.length === 1 && keys[0] === 'any' && (token as { any?: unknown }).any === true;
}

/**
 * The node `path` names in `root`, or one issue (`POINTER_NOT_IN_SCHEMA`) saying which step the description does not
 * declare.
 */
export function resolve(root: SchemaNode, path: readonly PathToken[]): Result<Resolved> {
  let node = root;
  let optional = false;
  for (let index = 0; index < path.length; index += 1) {
    const token: unknown = path[index];
    const where = `at step ${index} of ${JSON.stringify(path)}`;
    const refuse = (why: string): Result<Resolved> => ({
      ok: false,
      issues: [{ code: 'POINTER_NOT_IN_SCHEMA', message: `${why}, ${where}` }],
    });
    const here = nonNull(node);
    const isIndex = typeof token === 'number' || isAny(token);
    if (typeof token !== 'string' && !isIndex) return refuse('a path token is a string, a number or { any: true }');
    if (here.kind === 'object') {
      if (typeof token !== 'string') return refuse('an index on an object');
      if (!Object.hasOwn(here.properties, token)) {
        return refuse(`the schema declares no property ${JSON.stringify(token)}`);
      }
      const property = here.properties[token];
      if (property === undefined) return refuse(`the schema declares no property ${JSON.stringify(token)}`);
      optional = property.kind === 'optional';
      node = property.kind === 'optional' ? property.of : property;
    } else if (here.kind === 'array') {
      if (typeof token === 'string') return refuse(`a key on an array, ${JSON.stringify(token)}`);
      if (typeof token === 'number' && !(Number.isSafeInteger(token) && token >= 0)) {
        return refuse(`${token} is not an array index`);
      }
      optional = false;
      node = here.items;
    } else {
      return refuse(`a step below ${ARTICLE[here.kind] ?? here.kind}`);
    }
  }
  return { ok: true, value: { node, optional } };
}
