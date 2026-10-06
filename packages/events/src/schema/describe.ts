/**
 * The schema description: each catalogue event is described once, in these node kinds, and everything else is
 * compiled from that one description — the Zod schema (`to-zod.ts`), the JSON Schema 2020-12 (`to-json-schema.ts`) and
 * the node at a path (`resolve.ts`) (events phase A plan, decision 5). Zod's own JSON Schema output cannot be that
 * source: its shape is zod's to change, it writes `integer` where Appendix A wants `number` with `multipleOf: 1`, and
 * its string lengths count UTF-16 code units where Appendix A counts code points.
 *
 * The kinds are exactly what Appendix A's notation needs (A.1; decision 6): strings with their lengths, pattern and
 * format; `integer(minimum: …)`; booleans; literals; string enums; the one string union (`WhatsAppMessageKindV1`);
 * `T | null`; arrays, duplicate-free or not; strict objects, with optional properties and `dependentRequired`. One
 * thing here is not a JSON Schema keyword: `sorted`, an array in raw UTF-8 order, which is one of decision 7's named
 * invariants. Zod checks it and the JSON Schema says nothing of it.
 */
import { EventsError } from '../result.ts';

/** The semantic formats Appendix A names (A.1), `uuid` included (decision 10). */
export type SchemaFormat = 'date-time' | 'email' | 'domain' | 'uri' | 'uuid';

const FORMATS: ReadonlySet<string> = new Set<SchemaFormat>(['date-time', 'email', 'domain', 'uri', 'uuid']);

/** A JSON string. Lengths count code points. A pattern is a literal with exactly the `u` flag, as ajv reads it. */
export interface StringNode {
  readonly kind: 'string';
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly pattern?: RegExp;
  readonly format?: SchemaFormat;
}

/** `integer(minimum: …)`: a JSON number that is a whole number, which JSON Schema says as `multipleOf: 1`. */
export interface IntegerNode {
  readonly kind: 'integer';
  readonly minimum?: number;
}

export interface BooleanNode {
  readonly kind: 'boolean';
}

/** A literal: the `type` and `version` of an event, its `account.channel`, WhatsApp's `fromMe`. */
export interface ConstNode {
  readonly kind: 'const';
  readonly value: string | number | boolean;
}

/** A union of string literals, kept in Appendix A's order. */
export interface EnumNode {
  readonly kind: 'enum';
  readonly values: readonly string[];
}

/** A union of string nodes, as `WhatsAppMessageKindV1` is its enum or the `unknown:<n>` pattern. */
export interface UnionNode {
  readonly kind: 'union';
  readonly of: readonly (StringNode | EnumNode)[];
}

/**
 * An array. `uniqueItems` is Appendix A's "duplicate-free"; `sorted` is its "raw-UTF-8 sorted" and "canonical-sorted",
 * for arrays of strings only, and says nothing of duplicates.
 */
export interface ArrayNode {
  readonly kind: 'array';
  readonly items: SchemaNode;
  readonly uniqueItems?: true;
  readonly sorted?: true;
}

/** A property whose name ends in `?`: it may be absent, and when present it is never implicitly nullable. */
export interface OptionalNode {
  readonly kind: 'optional';
  readonly of: SchemaNode;
}

/** What an object's property is: a node, required, or an optional one. */
export type PropertyNode = SchemaNode | OptionalNode;

/** A strict object: no property but those declared. Every property not marked optional is required. */
export interface ObjectNode {
  readonly kind: 'object';
  readonly properties: Readonly<Record<string, PropertyNode>>;
  /** JSON Schema's `dependentRequired`: when the key is present, so is each property it names. */
  readonly dependentRequired?: Readonly<Record<string, readonly string[]>>;
}

/** `T | null`, for a scalar or an object alike: the only nullable form (A.1). */
export interface NullableNode {
  readonly kind: 'nullable';
  readonly of: NonNullNode;
}

/** Every node but a nullable one. */
export type NonNullNode =
  | StringNode
  | IntegerNode
  | BooleanNode
  | ConstNode
  | EnumNode
  | UnionNode
  | ArrayNode
  | ObjectNode;

/** A node of a schema description. */
export type SchemaNode = NonNullNode | NullableNode;

/** The node a value meets once a nullable node's `null` is set aside. */
export function nonNull(node: SchemaNode): NonNullNode {
  return node.kind === 'nullable' ? node.of : node;
}

const isCount = (value: unknown): boolean => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

/** Whether every value `node` accepts is a string: what a `sorted` array may hold. */
const isStringValued = (node: SchemaNode): boolean =>
  node.kind === 'string' ||
  node.kind === 'enum' ||
  node.kind === 'union' ||
  (node.kind === 'const' && typeof node.value === 'string');

/**
 * Throws `EventsError` (`SCHEMA_DESCRIPTION_INVALID`, naming where) unless `node` is a description both compilers
 * compile to the same contract. Both call it before compiling.
 */
export function checkDescription(node: SchemaNode): void {
  check(node, '(root)');
}

function refuse(at: string, why: string): never {
  throw new EventsError('SCHEMA_DESCRIPTION_INVALID', `the schema description at ${at} ${why}`);
}

function check(node: unknown, at: string): void {
  if (typeof node !== 'object' || node === null) refuse(at, 'is not a node');
  const described = node as SchemaNode | OptionalNode;
  switch (described.kind) {
    case 'string': {
      const { minLength, maxLength, pattern, format } = described;
      if (minLength !== undefined && !isCount(minLength)) refuse(at, 'has a minLength that is not a count');
      if (maxLength !== undefined && !isCount(maxLength)) refuse(at, 'has a maxLength that is not a count');
      if (minLength !== undefined && maxLength !== undefined && minLength > maxLength) {
        refuse(at, 'has a minLength above its maxLength');
      }
      if (pattern !== undefined && (!(pattern instanceof RegExp) || pattern.flags !== 'u')) {
        refuse(at, 'has a pattern whose flags are not exactly u, as JSON Schema patterns are read');
      }
      if (format !== undefined && !FORMATS.has(format)) refuse(at, `names the unknown format ${String(format)}`);
      return;
    }
    case 'integer':
      if (described.minimum !== undefined && !Number.isFinite(described.minimum)) {
        refuse(at, 'has a minimum that is not a finite number');
      }
      return;
    case 'boolean':
      return;
    case 'const': {
      const { value } = described;
      const scalar =
        typeof value === 'string' ||
        typeof value === 'boolean' ||
        (typeof value === 'number' && Number.isFinite(value));
      if (!scalar) refuse(at, 'has a const that is not a string, a finite number or a boolean');
      return;
    }
    case 'enum': {
      const { values } = described;
      if (!Array.isArray(values) || values.length === 0 || values.some((value) => typeof value !== 'string')) {
        refuse(at, 'has an enum that is not a non-empty list of strings');
      }
      if (new Set(values).size !== values.length) refuse(at, 'has an enum that repeats a value');
      return;
    }
    case 'union':
      if (!Array.isArray(described.of) || described.of.length < 2) refuse(at, 'is a union of fewer than two nodes');
      described.of.forEach((member, index) => {
        if (member?.kind !== 'string' && member?.kind !== 'enum') refuse(at, 'is a union of something but strings');
        check(member, `${at} union member ${index}`);
      });
      return;
    case 'nullable':
      if ((described.of as SchemaNode | undefined)?.kind === 'nullable') refuse(at, 'is a nullable of a nullable');
      check(described.of, `${at} non-null`);
      return;
    case 'array':
      check(described.items, `${at} items`);
      if (described.sorted !== undefined && !isStringValued(described.items)) {
        refuse(at, 'is sorted, but its items are not all strings');
      }
      return;
    case 'object': {
      const { properties, dependentRequired } = described;
      if (typeof properties !== 'object' || properties === null) refuse(at, 'is an object with no properties record');
      for (const [key, property] of Object.entries(properties)) {
        const there = `${at}.${JSON.stringify(key)}`;
        check(property?.kind === 'optional' ? property.of : property, there);
      }
      for (const [key, needs] of Object.entries(dependentRequired ?? {})) {
        for (const name of [key, ...needs]) {
          if (!Object.hasOwn(properties, name)) {
            refuse(at, `has a dependentRequired naming ${JSON.stringify(name)}, which it does not declare`);
          }
        }
      }
      return;
    }
    case 'optional':
      refuse(at, 'is optional where only an object property can be');
      return;
    default:
      refuse(at, `has the unknown kind ${String((described as { kind?: unknown }).kind)}`);
  }
}
