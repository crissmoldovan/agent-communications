/** D5's pure deterministic evaluator. It receives a saved condition and an already-validated source event. */
import type { AnyEventDefinition, EventDefinition } from '../catalogue/types.ts';
import { compareInstants, isInstant } from '../formats/instant.ts';
import type { JsonValue } from '../json.ts';
import { getPointer } from '../pointer.ts';
import { EventsError } from '../result.ts';
import { foldForComparison } from '../unicode/fold.ts';
import { conditionField, containsArrayItem, foldableString, formatOf } from './legality.ts';
import type { CanonicalCondition, Scalar } from './types.ts';

type Definition = AnyEventDefinition | EventDefinition;

function field(definition: Definition, path: string) {
  const found = conditionField(definition, path);
  if (found.ok) return found.value;
  const issue = found.issues[0];
  throw new EventsError(
    issue?.code ?? 'DEFINITION_INVALID',
    issue?.message ?? 'the condition path is invalid',
    issue?.pointer,
  );
}

function sameString(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive ? left === right : foldForComparison(left) === foldForComparison(right);
}

function sameScalar(value: JsonValue, wanted: Scalar, dateTime: boolean, caseSensitive: boolean): boolean {
  if (dateTime && typeof value === 'string' && typeof wanted === 'string') {
    return isInstant(value) && isInstant(wanted) && compareInstants(value, wanted) === 0;
  }
  return typeof value === 'string' && typeof wanted === 'string'
    ? sameString(value, wanted, caseSensitive)
    : value === wanted;
}

function stringValue(value: JsonValue, caseSensitive: boolean): string | undefined {
  if (typeof value !== 'string') return undefined;
  return caseSensitive ? value : foldForComparison(value);
}

/** Evaluate a canonical tree against its catalogue definition and source event. Missing leaves are always false. */
export function evaluateCondition(definition: Definition, condition: CanonicalCondition, event: JsonValue): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateCondition(definition, child, event));
  if ('any' in condition) return condition.any.some((child) => evaluateCondition(definition, child, event));
  if ('not' in condition) return !evaluateCondition(definition, condition.not, event);

  const found = getPointer(event, condition.path);
  if (condition.op === 'exists') return found.found;
  if (!found.found) return false;
  const resolved = field(definition, condition.path);
  const dateTime = formatOf(resolved.node) === 'date-time';

  if (condition.op === 'equals') return sameScalar(found.value, condition.value, dateTime, condition.caseSensitive);
  if (condition.op === 'notEquals') {
    if (dateTime && found.value !== null && (typeof found.value !== 'string' || !isInstant(found.value))) return false;
    return !sameScalar(found.value, condition.value, dateTime, condition.caseSensitive);
  }
  if (condition.op === 'in') return condition.values.some((value) => sameScalar(found.value, value, dateTime, true));
  if (condition.op === 'contains') {
    if (typeof found.value === 'string') {
      if (typeof condition.value !== 'string') return false;
      const target = stringValue(found.value, condition.caseSensitive);
      return target?.includes(condition.caseSensitive ? condition.value : foldForComparison(condition.value)) ?? false;
    }
    if (!Array.isArray(found.value)) return false;
    const items = containsArrayItem(resolved.node);
    const stringItems = items !== undefined && foldableString(items);
    return found.value.some((item) => {
      if (stringItems && typeof item === 'string' && typeof condition.value === 'string') {
        return sameString(item, condition.value, condition.caseSensitive);
      }
      return item === condition.value;
    });
  }
  if (condition.op === 'startsWith' || condition.op === 'endsWith') {
    if (typeof found.value !== 'string') return false;
    const left = condition.caseSensitive ? found.value : foldForComparison(found.value);
    const right = condition.caseSensitive ? condition.value : foldForComparison(condition.value);
    return condition.op === 'startsWith' ? left.startsWith(right) : left.endsWith(right);
  }
  if (condition.op === 'domainIs') {
    if (typeof found.value !== 'string') return false;
    const format = formatOf(resolved.node);
    const domain = format === 'email' ? found.value.slice(found.value.lastIndexOf('@') + 1) : found.value;
    return domain === condition.value || (condition.includeSubdomains && domain.endsWith(`.${condition.value}`));
  }
  if (dateTime) {
    if (typeof found.value !== 'string' || typeof condition.value !== 'string' || !isInstant(found.value)) return false;
    const order = compareInstants(found.value, condition.value);
    return compare(order, condition.op);
  }
  if (typeof found.value !== 'number' || typeof condition.value !== 'number' || !Number.isFinite(found.value))
    return false;
  return compare(found.value === condition.value ? 0 : found.value < condition.value ? -1 : 1, condition.op);
}

function compare(order: -1 | 0 | 1, op: 'gt' | 'gte' | 'lt' | 'lte'): boolean {
  if (op === 'gt') return order > 0;
  if (op === 'gte') return order >= 0;
  if (op === 'lt') return order < 0;
  return order <= 0;
}
