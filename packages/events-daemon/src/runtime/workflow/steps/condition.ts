import {
  type CanonicalCondition,
  compareInstants,
  foldForComparison,
  getPointer,
  isInstant,
  type JsonValue,
  type Scalar,
  toAsciiDomain,
} from '@agentcomms/events';
import type { StepContext, StepExecutor, StepResult } from '../contracts.ts';

/*
 * The condition step (workflows design §4.1, W3): D5's deterministic tree over the run's own values — its mapped
 * fields under `/fields`, a settled step's closed output under `/steps/<step>/<output>`, a chained run's trigger under
 * `/trigger`. It has no effect and never fails: a path with nothing there is false, as D5's evaluator holds. Branches
 * turn on what it says, and its output is empty.
 */

type Leaf = Exclude<CanonicalCondition, { all: unknown } | { any: unknown } | { not: unknown }>;

function sameString(left: string, right: string, caseSensitive: boolean): boolean {
  return caseSensitive ? left === right : foldForComparison(left) === foldForComparison(right);
}

function sameScalar(value: JsonValue, wanted: Scalar, caseSensitive: boolean): boolean {
  if (typeof value === 'string' && typeof wanted === 'string') {
    if (isInstant(value) && isInstant(wanted)) return compareInstants(value, wanted) === 0;
    return sameString(value, wanted, caseSensitive);
  }
  return value === wanted;
}

function order(left: JsonValue, right: Scalar): -1 | 0 | 1 | null {
  if (typeof left === 'number' && typeof right === 'number' && Number.isFinite(left))
    return left === right ? 0 : left < right ? -1 : 1;
  if (typeof left === 'string' && typeof right === 'string' && isInstant(left) && isInstant(right))
    return compareInstants(left, right);
  return null;
}

function leaf(condition: Leaf, values: JsonValue): boolean {
  const found = getPointer(values, condition.path);
  if (condition.op === 'exists') return found.found;
  if (!found.found) return false;
  const value = found.value;
  switch (condition.op) {
    case 'equals':
      return sameScalar(value, condition.value, condition.caseSensitive);
    case 'notEquals':
      return !sameScalar(value, condition.value, condition.caseSensitive);
    case 'in':
      return condition.values.some((wanted) => sameScalar(value, wanted, true));
    case 'contains': {
      if (typeof value === 'string')
        return (
          typeof condition.value === 'string' &&
          (condition.caseSensitive
            ? value.includes(condition.value)
            : foldForComparison(value).includes(foldForComparison(condition.value)))
        );
      return Array.isArray(value) && value.some((item) => sameScalar(item, condition.value, condition.caseSensitive));
    }
    case 'startsWith':
    case 'endsWith': {
      if (typeof value !== 'string') return false;
      const left = condition.caseSensitive ? value : foldForComparison(value);
      const right = condition.caseSensitive ? condition.value : foldForComparison(condition.value);
      return condition.op === 'startsWith' ? left.startsWith(right) : left.endsWith(right);
    }
    case 'domainIs': {
      if (typeof value !== 'string') return false;
      const domain = toAsciiDomain(value.slice(value.lastIndexOf('@') + 1));
      if (!domain.ok) return false;
      return (
        domain.value === condition.value ||
        (condition.includeSubdomains && domain.value.endsWith(`.${condition.value}`))
      );
    }
    default: {
      const compared = order(value, condition.value);
      if (compared === null) return false;
      if (condition.op === 'gt') return compared > 0;
      if (condition.op === 'gte') return compared >= 0;
      if (condition.op === 'lt') return compared < 0;
      return compared <= 0;
    }
  }
}

/** Evaluates a condition step's tree over the run's values: `{ fields, steps, trigger }`. */
export function evaluateFlowCondition(condition: CanonicalCondition, values: JsonValue): boolean {
  if ('all' in condition) return condition.all.every((child) => evaluateFlowCondition(child, values));
  if ('any' in condition) return condition.any.some((child) => evaluateFlowCondition(child, values));
  if ('not' in condition) return !evaluateFlowCondition(condition.not, values);
  return leaf(condition, values);
}

function roots(condition: CanonicalCondition, into: Set<string>): Set<string> {
  if ('all' in condition) for (const child of condition.all) roots(child, into);
  else if ('any' in condition) for (const child of condition.any) roots(child, into);
  else if ('not' in condition) roots(condition.not, into);
  else into.add(condition.path.split('/')[1] ?? '');
  return into;
}

/** The run's values a condition reads, each opened only when one of its paths is under it. */
async function valuesFor(ctx: StepContext, condition: CanonicalCondition): Promise<JsonValue> {
  const read = roots(condition, new Set());
  const steps: Record<string, JsonValue> = {};
  for (const id of Object.keys(ctx.rule.flow?.steps ?? {})) {
    const output = ctx.output(id);
    if (output !== null) steps[id] = output as JsonValue;
  }
  return {
    fields: read.has('fields') ? ((await ctx.fields()) as JsonValue) : {},
    steps,
    trigger: read.has('trigger') ? (((await ctx.trigger()) ?? null) as JsonValue) : null,
  };
}

async function decide(ctx: StepContext): Promise<StepResult> {
  if (ctx.step.kind !== 'condition') return { kind: 'failed', code: 'STEP_KIND_MISMATCH' };
  const met = evaluateFlowCondition(ctx.step.when, await valuesFor(ctx, ctx.step.when));
  return { kind: 'settled', outcome: met ? 'yes' : 'no', output: {} };
}

/** The condition step's executor: `yes` or `no`, at once. */
export const conditionExecutor: StepExecutor<'condition'> = Object.freeze({
  kind: 'condition' as const,
  run: decide,
  resume: (ctx: StepContext) => decide(ctx),
});
