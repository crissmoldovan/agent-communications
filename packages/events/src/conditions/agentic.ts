/** Decision 20's pure, save-time agentic condition form. Judge execution belongs to phase E. */
import type { AnyEventDefinition, EventDefinition } from '../catalogue/types.ts';
import { matchesPattern } from '../pattern.ts';
import type { Result } from '../result.ts';
import { conditionPointers } from './describe.ts';
import { conditionField } from './legality.ts';
import type { AgenticConditionV1, CanonicalCondition } from './types.ts';

type Definition = AnyEventDefinition | EventDefinition;
type ObjectValue = Readonly<Record<string, unknown>>;

const invalid = (message: string): Result<never> => ({
  ok: false,
  issues: [{ code: 'AGENTIC_CONDITION_INVALID', message }],
});

function object(value: unknown): ObjectValue | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as ObjectValue) : undefined;
}

/** Validate the static D5 record and make its `onUncertain: "no-match"` default explicit. */
export function canonicaliseAgenticCondition(
  definition: Definition,
  prefilter: CanonicalCondition,
  authoring: unknown,
): Result<AgenticConditionV1> {
  const value = object(authoring);
  if (value === undefined) return invalid('an agentic condition is an object');
  const allowed = ['judgeId', 'judgeVersion', 'question', 'inputs', 'threshold', 'onUncertain'];
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    return invalid('an agentic condition has no unknown properties');
  if (typeof value.judgeId !== 'string') return invalid('judgeId is a string');
  if (typeof value.judgeVersion !== 'number' || !Number.isInteger(value.judgeVersion) || value.judgeVersion <= 0) {
    return invalid('judgeVersion is a positive integer');
  }
  if (typeof value.question !== 'string') return invalid('question is a string');
  if (!Array.isArray(value.inputs) || value.inputs.some((pointer) => typeof pointer !== 'string')) {
    return invalid('inputs is an array of concrete JSON Pointers');
  }
  for (const pointer of value.inputs) {
    const resolved = conditionField(definition, pointer as string);
    if (!resolved.ok) return resolved;
  }
  if (
    typeof value.threshold !== 'number' ||
    !Number.isFinite(value.threshold) ||
    value.threshold < 0 ||
    value.threshold > 1
  ) {
    return invalid('threshold is a finite number from 0 through 1');
  }
  const onUncertain = value.onUncertain === undefined ? 'no-match' : value.onUncertain;
  if (onUncertain !== 'no-match' && onUncertain !== 'hold') return invalid('onUncertain is no-match or hold');
  const content = definition.content;
  if (!conditionPointers(prefilter).some((pointer) => content.some((pattern) => matchesPattern(pattern, pointer)))) {
    return {
      ok: false,
      issues: [
        { code: 'AGENTIC_PREFILTER_INVALID', message: 'the deterministic prefilter names no catalogue content field' },
      ],
    };
  }
  return {
    ok: true,
    value: {
      judgeId: value.judgeId,
      judgeVersion: value.judgeVersion,
      question: value.question,
      inputs: value.inputs as readonly string[],
      threshold: value.threshold,
      onUncertain,
    },
  };
}
