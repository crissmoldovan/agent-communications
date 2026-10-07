/** Save-time validation and canonicalisation of D5's deterministic condition tree. */
import type { AnyEventDefinition, EventDefinition } from '../catalogue/types.ts';
import { isInstant } from '../formats/instant.ts';
import { toAsciiDomain } from '../idna/domain.ts';
import type { Issue, Result } from '../result.ts';
import { nonNull } from '../schema/describe.ts';
import { utf8ByteLength } from '../text.ts';
import {
  conditionField,
  containsArrayItem,
  foldableString,
  formatOf,
  illegal,
  invalidValue,
  matchesScalarNode,
  scalarNode,
} from './legality.ts';
import type { CanonicalCondition, Scalar } from './types.ts';

/** D5's exclusive limits: depth and nodes count the condition tree; 1 KB is UTF-8 bytes. */
export const CONDITION_LIMITS: Readonly<{
  depth: 8;
  nodes: 64;
  scalarValueBytes: 1024;
  inValues: 256;
}> = Object.freeze({ depth: 8, nodes: 64, scalarValueBytes: 1024, inValues: 256 });

type Definition = AnyEventDefinition | EventDefinition;
type ObjectValue = Readonly<Record<string, unknown>>;

const invalid = (message: string): Result<never> => ({
  ok: false,
  issues: [{ code: 'CONDITION_INVALID', message }],
});
const limited = (message: string): Result<never> => ({
  ok: false,
  issues: [{ code: 'CONDITION_LIMIT_EXCEEDED', message }],
});
const one = (issue: Issue): Result<never> => ({ ok: false, issues: [issue] });

function object(value: unknown): ObjectValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ObjectValue) : undefined;
}

function only(value: ObjectValue, keys: readonly string[]): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function optionalCase(value: ObjectValue): Result<boolean> {
  if (!Object.hasOwn(value, 'caseSensitive')) return { ok: true, value: false };
  return typeof value.caseSensitive === 'boolean'
    ? { ok: true, value: value.caseSensitive }
    : invalid('caseSensitive is a boolean when present');
}

function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

function checkStringLimit(value: Scalar): Result<void> {
  return typeof value === 'string' && utf8ByteLength(value) > CONDITION_LIMITS.scalarValueBytes
    ? limited(`a string operand has more than ${CONDITION_LIMITS.scalarValueBytes} UTF-8 bytes`)
    : { ok: true, value: undefined };
}

interface State {
  nodes: number;
}

/** Canonicalise one selected-event D5 tree, including its schema-aware operands and explicit false defaults. */
export function canonicaliseCondition(definition: Definition, authoring: unknown): Result<CanonicalCondition> {
  return visit(definition, authoring, { nodes: 0 }, 1);
}

function visit(definition: Definition, input: unknown, state: State, depth: number): Result<CanonicalCondition> {
  if (depth > CONDITION_LIMITS.depth) return limited(`a condition is deeper than ${CONDITION_LIMITS.depth}`);
  state.nodes += 1;
  if (state.nodes > CONDITION_LIMITS.nodes) return limited(`a condition has more than ${CONDITION_LIMITS.nodes} nodes`);
  const value = object(input);
  if (value === undefined) return invalid('a condition is an object');

  if (Object.hasOwn(value, 'all') || Object.hasOwn(value, 'any')) {
    const key = Object.hasOwn(value, 'all') ? 'all' : 'any';
    if (!only(value, [key])) return invalid(`${key} is the condition object's only key`);
    const children = value[key];
    if (!Array.isArray(children) || children.length === 0) return invalid(`${key} is a non-empty array of conditions`);
    const canonical: CanonicalCondition[] = [];
    for (const child of children) {
      const found = visit(definition, child, state, depth + 1);
      if (!found.ok) return found;
      canonical.push(found.value);
    }
    return key === 'all'
      ? { ok: true, value: { all: canonical as [CanonicalCondition, ...CanonicalCondition[]] } }
      : { ok: true, value: { any: canonical as [CanonicalCondition, ...CanonicalCondition[]] } };
  }
  if (Object.hasOwn(value, 'not')) {
    if (!only(value, ['not'])) return invalid("not is the condition object's only key");
    const child = visit(definition, value.not, state, depth + 1);
    return child.ok ? { ok: true, value: { not: child.value } } : child;
  }

  if (typeof value.path !== 'string' || typeof value.op !== 'string') {
    return invalid('a condition leaf has a string path and operator');
  }
  const resolved = conditionField(definition, value.path);
  if (!resolved.ok) return resolved;
  const node = resolved.value.node;
  const format = formatOf(node);
  const op = value.op;

  if (op === 'exists') {
    return only(value, ['path', 'op'])
      ? { ok: true, value: { path: value.path, op } }
      : invalid('exists has only path and op');
  }
  if (op === 'equals' || op === 'notEquals') {
    if (!only(value, ['path', 'op', 'value', 'caseSensitive']))
      return invalid(`${op} has path, op, value and caseSensitive only`);
    if (!scalarNode(node) || !scalar(value.value) || !matchesScalarNode(node, value.value)) {
      return one(invalidValue(`${op} has no value of this field's schema type`, value.path));
    }
    const limit = checkStringLimit(value.value as Scalar);
    if (!limit.ok) return limit;
    const caseSensitive = optionalCase(value);
    if (!caseSensitive.ok) return caseSensitive;
    if (caseSensitive.value && !foldableString(node)) {
      return one(illegal(`caseSensitive is true only for non-date string fields`, value.path));
    }
    return {
      ok: true,
      value: { path: value.path, op, value: value.value as Scalar, caseSensitive: caseSensitive.value },
    };
  }
  if (op === 'in') {
    if (!only(value, ['path', 'op', 'values'])) return invalid('in has only path, op and values');
    if (!scalarNode(node) || !Array.isArray(value.values) || value.values.length === 0) {
      return invalid('in has a non-empty array of values for a scalar field');
    }
    if (value.values.length > CONDITION_LIMITS.inValues) {
      return limited(`in has more than ${CONDITION_LIMITS.inValues} values`);
    }
    const values: Scalar[] = [];
    for (const candidate of value.values) {
      if (!scalar(candidate) || !matchesScalarNode(node, candidate)) {
        return one(invalidValue("in has a value outside this field's schema", value.path));
      }
      const limit = checkStringLimit(candidate);
      if (!limit.ok) return limit;
      values.push(candidate);
    }
    return { ok: true, value: { path: value.path, op, values: values as [Scalar, ...Scalar[]] } };
  }
  if (op === 'contains') {
    if (!only(value, ['path', 'op', 'value', 'caseSensitive']))
      return invalid('contains has path, op, value and caseSensitive only');
    const item = containsArrayItem(node);
    const string = foldableString(node);
    if (!string && item === undefined)
      return one(illegal('contains is for a non-date string or an array of scalars', value.path));
    const operandNode = item ?? node;
    const validOperand = string
      ? typeof value.value === 'string'
      : scalar(value.value) && matchesScalarNode(operandNode, value.value);
    if (!validOperand) {
      return one(invalidValue('contains has no value of this field or array item type', value.path));
    }
    const limit = checkStringLimit(value.value as Scalar);
    if (!limit.ok) return limit;
    const caseSensitive = optionalCase(value);
    if (!caseSensitive.ok) return caseSensitive;
    if (caseSensitive.value && !(string || (item !== undefined && foldableString(item)))) {
      return one(illegal('caseSensitive is true only for string comparisons', value.path));
    }
    return {
      ok: true,
      value: { path: value.path, op, value: value.value as Scalar, caseSensitive: caseSensitive.value },
    };
  }
  if (op === 'startsWith' || op === 'endsWith') {
    if (!only(value, ['path', 'op', 'value', 'caseSensitive']))
      return invalid(`${op} has path, op, value and caseSensitive only`);
    if (!foldableString(node) || typeof value.value !== 'string') {
      return one(illegal(`${op} is for non-date string fields`, value.path));
    }
    const limit = checkStringLimit(value.value);
    if (!limit.ok) return limit;
    const caseSensitive = optionalCase(value);
    if (!caseSensitive.ok) return caseSensitive;
    return { ok: true, value: { path: value.path, op, value: value.value, caseSensitive: caseSensitive.value } };
  }
  if (op === 'gt' || op === 'gte' || op === 'lt' || op === 'lte') {
    if (!only(value, ['path', 'op', 'value'])) return invalid(`${op} has only path, op and value`);
    if (format === 'date-time') {
      if (typeof value.value !== 'string' || !isInstant(value.value)) {
        return one(invalidValue(`${op} has an RFC 3339 instant for a date-time field`, value.path));
      }
      return { ok: true, value: { path: value.path, op, value: value.value } };
    }
    if (nonNull(node).kind !== 'integer' || typeof value.value !== 'number' || !Number.isFinite(value.value)) {
      return one(illegal(`${op} is for numbers or date-time fields`, value.path));
    }
    return { ok: true, value: { path: value.path, op, value: value.value } };
  }
  if (op === 'domainIs') {
    if (!only(value, ['path', 'op', 'value', 'includeSubdomains']))
      return invalid('domainIs has path, op, value and includeSubdomains only');
    if ((format !== 'email' && format !== 'domain') || typeof value.value !== 'string') {
      return one(illegal('domainIs is for email and domain fields', value.path));
    }
    if (typeof value.includeSubdomains !== 'boolean') return invalid('includeSubdomains is a boolean');
    const limit = checkStringLimit(value.value);
    if (!limit.ok) return limit;
    const domain = toAsciiDomain(value.value);
    if (!domain.ok) return domain;
    return {
      ok: true,
      value: { path: value.path, op, value: domain.value, includeSubdomains: value.includeSubdomains },
    };
  }
  return one(illegal(`the condition operator ${JSON.stringify(op)} is not in D5`, value.path));
}
