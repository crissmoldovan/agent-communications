/**
 * A schema description compiled to JSON Schema 2020-12, in exactly decision 6's shape (events phase A plan), because
 * §5 and A.8 compare the generated schema with a transcription of Appendix A byte for byte:
 *
 * - an object is `type`, `properties`, `required` and `additionalProperties: false`, plus `dependentRequired` when it
 *   has one; `required` lists every property not marked optional, sorted by raw UTF-8 bytes, and is there even empty;
 * - a string is `type: "string"` with whichever of `minLength`, `maxLength`, `pattern` and `format` it has;
 * - `integer(minimum: …)` is `type: "number"`, `multipleOf: 1` and the minimum — never `type: "integer"`;
 * - a literal is `const` alone, with no `type`; an enum is `type: "string"` and `enum`, in the description's order;
 * - `T | null` is `anyOf` the node and `{ "type": "null" }`, for scalars and objects alike; the string union is
 *   `anyOf` its members;
 * - an array is `type: "array"` and `items`, plus `uniqueItems: true` where duplicate-free. `sorted` adds nothing: no
 *   2020-12 keyword says it (decision 7).
 *
 * Every node is inline: no `$defs`, `$ref`, `title` or `description`.
 */
import type { JsonValue } from '../json.ts';
import { compareUtf8 } from '../text.ts';
import { checkDescription, type ObjectNode, type SchemaNode } from './describe.ts';

/** A JSON Schema, as JSON. */
export interface JsonSchema {
  readonly [keyword: string]: JsonValue;
}

/** The draft every generated schema names at its root. */
export const JSON_SCHEMA_DRAFT = 'https://json-schema.org/draft/2020-12/schema';

/** `node` as JSON Schema 2020-12. Throws `EventsError` (`SCHEMA_DESCRIPTION_INVALID`) for a description it refuses. */
export function toJsonSchema(node: SchemaNode): JsonSchema {
  checkDescription(node);
  return compile(node);
}

/** A whole schema: `$schema`, then `$id`, then the object's own keywords. */
export function toRootJsonSchema(node: ObjectNode, id: string): JsonSchema {
  return { $schema: JSON_SCHEMA_DRAFT, $id: id, ...toJsonSchema(node) };
}

function compile(node: SchemaNode): JsonSchema {
  switch (node.kind) {
    case 'string': {
      const schema: Record<string, JsonValue> = { type: 'string' };
      if (node.minLength !== undefined) schema.minLength = node.minLength;
      if (node.maxLength !== undefined) schema.maxLength = node.maxLength;
      if (node.pattern !== undefined) schema.pattern = node.pattern.source;
      if (node.format !== undefined) schema.format = node.format;
      return schema;
    }
    case 'integer':
      return node.minimum === undefined
        ? { type: 'number', multipleOf: 1 }
        : { type: 'number', multipleOf: 1, minimum: node.minimum };
    case 'boolean':
      return { type: 'boolean' };
    case 'const':
      return { const: node.value };
    case 'enum':
      return { type: 'string', enum: [...node.values] };
    case 'union':
      return { anyOf: node.of.map(compile) };
    case 'nullable':
      return { anyOf: [compile(node.of), { type: 'null' }] };
    case 'array':
      return node.uniqueItems === true
        ? { type: 'array', items: compile(node.items), uniqueItems: true }
        : { type: 'array', items: compile(node.items) };
    case 'object': {
      const entries = Object.entries(node.properties);
      // `fromEntries` makes own properties, so even a key named `__proto__` stays a key.
      const properties = Object.fromEntries(
        entries.map(([key, property]) => [key, compile(property.kind === 'optional' ? property.of : property)]),
      );
      const required = entries
        .filter(([, property]) => property.kind !== 'optional')
        .map(([key]) => key)
        .sort(compareUtf8);
      const schema: Record<string, JsonValue> = { type: 'object', properties, required, additionalProperties: false };
      if (node.dependentRequired !== undefined) {
        schema.dependentRequired = Object.fromEntries(
          Object.entries(node.dependentRequired).map(([key, needs]) => [key, [...needs]]),
        );
      }
      return schema;
    }
  }
}
