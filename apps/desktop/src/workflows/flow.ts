/**
 * A workflow's flow, from `@agentcomms/events`' own source (workflows design §4.1, W20, Appendix W), as `rule-text.ts`
 * takes the text's printer and parser: the designer draws, checks and changes the very graph the event service runs,
 * with the same `checkFlow`, `connectionAllowed`, `flowOf` and step event catalogue. They have no I/O, and they load
 * only with the designer's chunk.
 */

export { outcomesOf, successors } from '../../../../packages/events/src/flow/graph.ts';
export {
  checkFlow,
  connectionAllowed,
  FLOW_BOUNDS,
  FLOW_LIMIT_CEILINGS,
  FLOW_LIMIT_DEFAULTS,
  type FlowDocumentV1,
  type FlowLimits,
  type FlowProblem,
  type FlowStep,
  flowOf,
  nextSteps,
  RESERVED_STEP_IDS,
  STEP_KINDS,
  type StepId,
  type StepKind,
  stepOrder,
} from '../../../../packages/events/src/flow/index.ts';
export { describeFlow, type FlowLine } from '../../../../packages/events/src/rules/describe-flow.ts';
export {
  eventsFor,
  RUN_EVENTS,
  STANDARD_STEP_EVENTS,
  schemaOf,
  type WorkflowEventSchema,
} from '../../../../packages/events/src/workflow-events/catalogue.ts';
export { isEventSegment, RESERVED_NAMESPACES } from '../../../../packages/events/src/workflow-events/names.ts';
