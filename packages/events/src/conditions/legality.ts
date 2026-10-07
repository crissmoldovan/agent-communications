/** Schema-aware condition legality shared by canonicalisation and evaluation. */
import type { AnyEventDefinition, EventDefinition } from '../catalogue/types.ts';
import { isFormat } from '../formats/index.ts';
import { resolvePointer } from '../pointer.ts';
import type { Issue, Result } from '../result.ts';
import { nonNull, type SchemaNode } from '../schema/describe.ts';
import type { Resolved } from '../schema/resolve.ts';
import type { Scalar } from './types.ts';

type InternalDefinition = EventDefinition & { readonly description?: SchemaNode };

/** The description a catalogue definition owns, or the issue for a non-catalogue definition. */
export function definitionDescription(definition: AnyEventDefinition | EventDefinition): Result<SchemaNode> {
  const description = (definition as InternalDefinition).description;
  return description === undefined
    ? {
        ok: false,
        issues: [{ code: 'DEFINITION_INVALID', message: 'conditions require a definition made by the catalogue' }],
      }
    : { ok: true, value: description };
}

/** Resolve one concrete condition pointer in its selected catalogue event schema. */
export function conditionField(definition: AnyEventDefinition | EventDefinition, path: string): Result<Resolved> {
  const description = definitionDescription(definition);
  return description.ok ? resolvePointer(description.value, path) : description;
}

/** Whether `node` admits null, before its non-null branch is considered. */
const nullable = (node: SchemaNode): boolean => node.kind === 'nullable';

/** Whether `node` is one of D5's scalar schema values. */
export function scalarNode(node: SchemaNode): boolean {
  const kind = nonNull(node).kind;
  return (
    kind === 'string' ||
    kind === 'integer' ||
    kind === 'boolean' ||
    kind === 'const' ||
    kind === 'enum' ||
    kind === 'union'
  );
}

/** The format a string node carries, if any. */
export function formatOf(node: SchemaNode): string | undefined {
  const inner = nonNull(node);
  return inner.kind === 'string' ? inner.format : undefined;
}

/** Whether every non-null value of `node` is a string, including Appendix A's string enums and literals. */
function stringValued(node: SchemaNode): boolean {
  const inner = nonNull(node);
  return (
    inner.kind === 'string' ||
    inner.kind === 'enum' ||
    inner.kind === 'union' ||
    (inner.kind === 'const' && typeof inner.value === 'string')
  );
}

/** Whether a condition may use string folding at `node`: string values except D5's instant fields. */
export function foldableString(node: SchemaNode): boolean {
  return stringValued(node) && formatOf(node) !== 'date-time';
}

/** Whether a condition's `contains` may compare an array item: D5 has scalar values, never objects. */
export function containsArrayItem(node: SchemaNode): SchemaNode | undefined {
  const inner = nonNull(node);
  return inner.kind === 'array' && scalarNode(inner.items) ? inner.items : undefined;
}

/** Whether an operand has a field's scalar schema type, format/pattern/enum/const and number constraints, not length. */
export function matchesScalarNode(node: SchemaNode, value: unknown): value is Scalar {
  if (value === null) return nullable(node);
  const inner = nonNull(node);
  switch (inner.kind) {
    case 'string':
      return (
        typeof value === 'string' &&
        (inner.pattern === undefined || inner.pattern.test(value)) &&
        (inner.format === undefined || isFormat(inner.format, value))
      );
    case 'integer':
      return (
        typeof value === 'number' &&
        Number.isFinite(value) &&
        Number.isInteger(value) &&
        (inner.minimum === undefined || value >= inner.minimum)
      );
    case 'boolean':
      return typeof value === 'boolean';
    case 'const':
      return value === inner.value;
    case 'enum':
      return typeof value === 'string' && inner.values.includes(value);
    case 'union':
      return inner.of.some((member) => matchesScalarNode(member, value));
    default:
      return false;
  }
}

/** The one stable issue shape used when an otherwise valid condition asks for an illegal D5 pairing. */
export function illegal(message: string, pointer?: string): Issue {
  return pointer === undefined
    ? { code: 'CONDITION_OPERATOR_INVALID', message }
    : { code: 'CONDITION_OPERATOR_INVALID', pointer, message };
}

/** The issue for a value that is not valid for a condition's field/operator. */
export function invalidValue(message: string, pointer?: string): Issue {
  return pointer === undefined
    ? { code: 'CONDITION_VALUE_INVALID', message }
    : { code: 'CONDITION_VALUE_INVALID', pointer, message };
}
