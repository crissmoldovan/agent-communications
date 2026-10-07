/**
 * The test-only oracle for the schema description (events phase A plan, decision 5): ajv, reading the generated JSON
 * Schema 2020-12, against the Zod schema compiled from the same description. Everything Zod accepts or refuses, ajv
 * must too, except decision 7's named invariants, which no 2020-12 keyword states.
 *
 * Kept here rather than in one test file because the catalogue's tests (Task 11) run the same corpus over every
 * example: `mutationCorpus` walks a description and a valid value together and makes, at every position the value
 * reaches, each change the description forbids — and the freedom it allows — so a validator wrong in one place cannot
 * hide.
 */
import { Ajv2020 } from 'ajv/dist/2020.js';
import { canonicalJson, type JsonValue } from '../../src/index.ts';
import type { SchemaFormat, SchemaNode, StringNode } from '../../src/schema/describe.ts';

/**
 * Stand-ins for the five semantic formats, until Task 11 wires in Task 7's: shape checks only, the same function on
 * both sides, so Zod and ajv are compared on everything but the formats' own rules.
 */
export const STUB_FORMATS: Readonly<Record<SchemaFormat, (value: string) => boolean>> = {
  'date-time': (value) =>
    /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]+)?(Z|[+-][0-9]{2}:[0-9]{2})$/u.test(value),
  email: (value) => /^[^@\s]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(value),
  domain: (value) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(value),
  uri: (value) => /^[a-z][a-z0-9+.-]*:[^\s]*$/u.test(value),
  uuid: (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value),
};

/** The stub formats as the Zod compiler takes them. */
export const checkStubFormat = (format: SchemaFormat, value: string): boolean => STUB_FORMATS[format](value);

/**
 * ajv for draft 2020-12, strict, with the stub formats and decision 17's annotation keyword registered. A schema it
 * compiles has passed the 2020-12 meta-schema and used no keyword ajv does not know. Compiling a schema does not
 * register its `$id`, so the same schema can be compiled again.
 */
export function ajvOracle(): Ajv2020 {
  const ajv = new Ajv2020({ strict: true, strictTypes: true, allErrors: true, addUsedSchema: false });
  for (const [name, validate] of Object.entries(STUB_FORMATS)) ajv.addFormat(name, { type: 'string', validate });
  ajv.addKeyword({ keyword: 'x-agentcomms-untrusted', schemaType: 'string' });
  return ajv;
}

/**
 * What a mutation must do: `refused` by both validators; `accepted` by both; `zod-only`, refused by Zod and accepted by
 * ajv, for a named invariant JSON Schema has no keyword for (decision 7).
 */
export type Expectation = 'refused' | 'accepted' | 'zod-only';

export interface Mutation {
  /** Where, as an RFC 6901 pointer, and what was done there. */
  readonly name: string;
  /** The keyword or rule the mutation breaks, or the freedom it uses. */
  readonly rule: string;
  readonly value: unknown;
  readonly expect: Expectation;
}

type Path = readonly (string | number)[];

const pointerOf = (path: Path): string =>
  path.map((token) => `/${String(token).replaceAll('~', '~0').replaceAll('/', '~1')}`).join('');

const clone = (value: JsonValue): JsonValue => JSON.parse(JSON.stringify(value));

/** A copy of `root` with `change` applied to the container holding the last token of `path`. */
function edit(
  root: JsonValue,
  path: Path,
  change: (container: Record<string | number, unknown>, last: string | number) => void,
): unknown {
  const copy = clone(root);
  if (path.length === 0) throw new Error('edit needs a path below the root');
  let at = copy as unknown as Record<string | number, unknown>;
  for (const token of path.slice(0, -1)) at = at[token] as Record<string | number, unknown>;
  change(at, path[path.length - 1] as string | number);
  return copy;
}

/** `root` with the value at `path` replaced; the root itself when `path` is empty. */
function replaced(root: JsonValue, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  return edit(root, path, (container, last) => {
    container[last] = value;
  });
}

/** `root` without the property at `path`. */
const removed = (root: JsonValue, path: Path): unknown =>
  edit(root, path, (container, last) => {
    delete container[last];
  });

/** A different value of the same JSON type as `value`. */
function sameTypeOther(value: string | number | boolean): string | number | boolean {
  if (typeof value === 'string') return `${value}x`;
  if (typeof value === 'number') return value + 1;
  return !value;
}

/** A value of another JSON type than any `node` accepts. */
function wrongType(node: SchemaNode): JsonValue {
  const inner = node.kind === 'nullable' ? node.of : node;
  switch (inner.kind) {
    case 'string':
    case 'enum':
    case 'union':
      return 0;
    case 'integer':
      return '0';
    case 'boolean':
      return 'true';
    case 'const':
      return typeof inner.value === 'string' ? 0 : String(inner.value);
    case 'array':
      return {};
    case 'object':
      return [];
  }
}

/** A string `count` code points long, every one of them astral: two UTF-16 code units each. */
const astral = (count: number): string => '\u{1F600}'.repeat(count);

/** A string the pattern refuses, made from the valid one. */
function breakPattern(pattern: RegExp, valid: string): string {
  const candidate = [`${valid}!`, `!${valid}`, '', ' '].find((text) => !pattern.test(text));
  if (candidate === undefined) throw new Error(`no string breaks ${pattern}`);
  return candidate;
}

/** Whether `value` is refused by every branch a union's string node offers; undefined when a branch takes any string. */
function refusedByString(node: StringNode, value: string): boolean | undefined {
  if (node.pattern !== undefined) return !node.pattern.test(value);
  if (node.format !== undefined) return !STUB_FORMATS[node.format](value);
  return undefined;
}

/**
 * Every mutation of `valid` the description `root` decides, at every position `valid` reaches: each required property
 * removed and each extra property added, at every object; `null` where it is not allowed; another JSON type; a value
 * outside a `const` or an enum; one code point past a length limit; a broken pattern or format; a fraction or a step
 * below the minimum; a duplicate where `uniqueItems`; an orphan under `dependentRequired`; a reversed `sorted` array.
 * And what is allowed: an optional property absent, `null` where nullable, and the unconstrained values A.1 permits.
 */
export function mutationCorpus(root: SchemaNode, valid: JsonValue): Mutation[] {
  const corpus: Mutation[] = [];
  const add = (path: Path, rule: string, what: string, value: unknown, expect: Expectation) =>
    corpus.push({ name: `${pointerOf(path) || '(root)'}: ${what}`, rule, value, expect });

  const walk = (node: SchemaNode, value: JsonValue | undefined, path: Path): void => {
    if (value === undefined) return;
    if (node.kind === 'nullable') {
      add(path, 'type', 'another JSON type', replaced(valid, path, wrongType(node)), 'refused');
      if (value === null) return;
      add(path, 'nullable', 'null where nullable', replaced(valid, path, null), 'accepted');
      visit(node.of, value, path);
      return;
    }
    add(path, 'null', 'null where not nullable', replaced(valid, path, null), 'refused');
    add(path, 'type', 'another JSON type', replaced(valid, path, wrongType(node)), 'refused');
    visit(node, value, path);
  };

  const visit = (node: Exclude<SchemaNode, { kind: 'nullable' }>, value: JsonValue, path: Path): void => {
    switch (node.kind) {
      case 'string': {
        const text = value as string;
        if (node.maxLength !== undefined) {
          add(
            path,
            'maxLength',
            'one code point past maxLength',
            replaced(valid, path, astral(node.maxLength + 1)),
            'refused',
          );
        }
        if (node.minLength !== undefined && node.minLength > 0) {
          add(
            path,
            'minLength',
            'one code point short of minLength',
            replaced(valid, path, astral(node.minLength - 1)),
            'refused',
          );
        }
        if (node.pattern !== undefined) {
          add(
            path,
            'pattern',
            'the pattern broken',
            replaced(valid, path, breakPattern(node.pattern, text)),
            'refused',
          );
        }
        if (node.format !== undefined) {
          const broken = `not a ${node.format}`;
          if (STUB_FORMATS[node.format](broken)) throw new Error(`the ${node.format} stub accepts "${broken}"`);
          add(path, 'format', `not a ${node.format}`, replaced(valid, path, broken), 'refused');
        }
        if (
          node.maxLength === undefined &&
          node.minLength === undefined &&
          node.pattern === undefined &&
          node.format === undefined
        ) {
          add(
            path,
            'permissive',
            '100000 code points without a maxLength',
            replaced(valid, path, astral(100_000)),
            'accepted',
          );
          add(path, 'permissive', 'an empty string without a minLength', replaced(valid, path, ''), 'accepted');
          add(
            path,
            'permissive',
            'an arbitrary unconstrained string',
            replaced(valid, path, 'permitted string'),
            'accepted',
          );
        }
        return;
      }
      case 'integer':
        // Above the minimum, so only the fraction is wrong; not the value plus a half, which past 2^53 is no fraction.
        add(path, 'multipleOf', 'a fraction', replaced(valid, path, (node.minimum ?? 0) + 0.5), 'refused');
        if (node.minimum !== undefined) {
          add(path, 'minimum', 'one below the minimum', replaced(valid, path, node.minimum - 1), 'refused');
        }
        if (node.minimum !== undefined && path.at(-1) !== 'attachmentCount') {
          add(
            path,
            'permissive',
            'a large integer without a maximum',
            replaced(valid, path, 9_007_199_254_740_991),
            'accepted',
          );
        }
        return;
      case 'boolean':
        return;
      case 'const':
        add(
          path,
          'const',
          'another value of the same type',
          replaced(valid, path, sameTypeOther(node.value)),
          'refused',
        );
        return;
      case 'enum':
        add(path, 'enum', 'a string outside the enum', replaced(valid, path, 'not-in-the-enum'), 'refused');
        return;
      case 'union': {
        const outside = 'in-no-branch';
        const every = node.of.map((branch) =>
          branch.kind === 'enum' ? !branch.values.includes(outside) : refusedByString(branch, outside),
        );
        if (every.every((refused) => refused === true)) {
          add(path, 'anyOf', 'a string in no branch', replaced(valid, path, outside), 'refused');
        }
        return;
      }
      case 'array': {
        const items = value as readonly JsonValue[];
        items.forEach((item, index) => {
          walk(node.items, item, [...path, index]);
        });
        if (node.uniqueItems === true && items.length > 0) {
          const duplicated = [items[0], ...items];
          add(path, 'uniqueItems', 'its first item twice', replaced(valid, path, duplicated), 'refused');
        }
        if (node.sorted === true && new Set(items.map((item) => canonicalJson(item))).size > 1) {
          add(path, 'sorted', 'reversed', replaced(valid, path, [...items].reverse()), 'zod-only');
        }
        if (node.uniqueItems !== true && path.at(-1) !== 'attachments') {
          add(path, 'permissive', 'an empty array without a minItems', replaced(valid, path, []), 'accepted');
          if (items.length > 0) {
            add(
              path,
              'permissive',
              'duplicate items without uniqueItems',
              replaced(valid, path, [items[0], ...items]),
              'accepted',
            );
          }
          if (items.length > 1) {
            add(
              path,
              'permissive',
              'a reverse order without sorted-utf8',
              replaced(valid, path, [...items].reverse()),
              'accepted',
            );
          }
        }
        return;
      }
      case 'object': {
        const object = value as Readonly<Record<string, JsonValue>>;
        const dependents = node.dependentRequired ?? {};
        for (const [key, property] of Object.entries(node.properties)) {
          if (!Object.hasOwn(object, key)) continue;
          const at = [...path, key];
          if (property.kind === 'optional') {
            const orphaned = Object.entries(dependents).some(
              ([holder, needs]) => holder !== key && Object.hasOwn(object, holder) && needs.includes(key),
            );
            add(
              at,
              orphaned ? 'dependentRequired' : 'optional',
              orphaned ? 'removed, orphaning a dependent' : 'an optional property absent',
              removed(valid, at),
              orphaned ? 'refused' : 'accepted',
            );
            walk(property.of, object[key], at);
          } else {
            add(at, 'required', 'a required property removed', removed(valid, at), 'refused');
            walk(property, object[key], at);
          }
        }
        let extra = 'unexpected';
        while (Object.hasOwn(node.properties, extra)) extra += '_';
        add(
          [...path, extra],
          'additionalProperties',
          'an extra property',
          replaced(valid, [...path, extra], 0),
          'refused',
        );
        // An own `__proto__`, as JSON.parse makes one: data, and undeclared.
        const withProto = clone(valid);
        Object.defineProperty(pathInto(withProto, path), '__proto__', {
          value: 0,
          enumerable: true,
          configurable: true,
          writable: true,
        });
        add([...path, '__proto__'], 'additionalProperties', 'an own __proto__ property', withProto, 'refused');
        return;
      }
    }
  };

  walk(root, valid, []);
  return corpus;
}

/** The object at `path` inside `root`. */
function pathInto(root: unknown, path: Path): object {
  let at = root as Record<string | number, unknown>;
  for (const token of path) at = at[token] as Record<string | number, unknown>;
  return at;
}
