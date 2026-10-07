/** A deterministic D5 condition sentence; scalar operands are always canonical JSON text. */
import { canonicalJson } from '../json.ts';
import type { CanonicalCondition } from './types.ts';

/** Every concrete source pointer a tree references, in tree order. */
export function conditionPointers(condition: CanonicalCondition): readonly string[] {
  if ('all' in condition) return condition.all.flatMap(conditionPointers);
  if ('any' in condition) return condition.any.flatMap(conditionPointers);
  if ('not' in condition) return conditionPointers(condition.not);
  return [condition.path];
}

/** Render a saved condition without treating any operand as prose or instructions. */
export function describeCondition(condition: CanonicalCondition): string {
  if ('all' in condition) return `all of (${condition.all.map(describeCondition).join('; ')})`;
  if ('any' in condition) return `any of (${condition.any.map(describeCondition).join('; ')})`;
  if ('not' in condition) return `not (${describeCondition(condition.not)})`;
  if (condition.op === 'exists') return `${condition.path} exists`;
  if (condition.op === 'equals')
    return `${condition.path} equals ${canonicalJson(condition.value)}${caseText(condition.caseSensitive)}`;
  if (condition.op === 'notEquals')
    return `${condition.path} does not equal ${canonicalJson(condition.value)}${caseText(condition.caseSensitive)}`;
  if (condition.op === 'contains')
    return `${condition.path} contains ${canonicalJson(condition.value)}${caseText(condition.caseSensitive)}`;
  if (condition.op === 'startsWith')
    return `${condition.path} starts with ${canonicalJson(condition.value)}${caseText(condition.caseSensitive)}`;
  if (condition.op === 'endsWith')
    return `${condition.path} ends with ${canonicalJson(condition.value)}${caseText(condition.caseSensitive)}`;
  if (condition.op === 'in') return `${condition.path} is one of ${canonicalJson(condition.values)}`;
  if (condition.op === 'gt') return `${condition.path} is greater than ${canonicalJson(condition.value)}`;
  if (condition.op === 'gte') return `${condition.path} is at least ${canonicalJson(condition.value)}`;
  if (condition.op === 'lt') return `${condition.path} is less than ${canonicalJson(condition.value)}`;
  if (condition.op === 'lte') return `${condition.path} is at most ${canonicalJson(condition.value)}`;
  if (condition.op === 'domainIs') {
    return `${condition.path} is ${condition.value}${condition.includeSubdomains ? ' or a subdomain' : ''}`;
  }
  return `${condition.path} has an unknown condition operator`;
}

const caseText = (caseSensitive: boolean) => (caseSensitive ? ' (case-sensitive)' : '');
