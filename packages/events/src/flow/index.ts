/** A workflow's flow (workflows design §4.1): its types, `checkFlow`, and the graph its arrows draw. */
export { checkFlow } from './check.ts';
export { connectionAllowed, nextSteps, stepOrder, unreachableAfter } from './graph.ts';
export {
  type Arrows,
  FAILURE_OUTCOMES,
  FLOW_BOUNDS,
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  type FlowDocumentV1,
  type FlowEvents,
  type FlowLimits,
  type FlowOn,
  type FlowProblem,
  type FlowProblemCode,
  type FlowStep,
  type Next,
  type Place,
  RESERVED_STEP_IDS,
  type RouteCandidate,
  STEP_KINDS,
  STEP_OUTCOMES,
  type StepCommon,
  type StepId,
  type StepKind,
  type WaitOutcome,
} from './types.ts';
