/** The public deterministic-condition and static-agentic-condition API. */
export { canonicaliseAgenticCondition } from './agentic.ts';
export { CONDITION_LIMITS, canonicaliseCondition } from './canonicalise.ts';
export { conditionPointers, describeCondition } from './describe.ts';
export { evaluateCondition } from './evaluate.ts';
export type { AgenticConditionV1, AuthoringCondition, CanonicalCondition, Scalar } from './types.ts';
