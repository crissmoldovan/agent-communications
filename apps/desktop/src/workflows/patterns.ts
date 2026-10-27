/**
 * The step event names and subscribers' patterns, from `@agentcomms/events`' own source (workflows design W24, W30), as
 * `flow.ts` takes the flow: a pattern is checked in the app with the very function the event service checks it with,
 * as the person types it. Only the small names module loads here, never the flow's graph.
 */
export {
  canonicalEventPattern,
  isEventSegment,
  matchesEventPattern,
  RESERVED_NAMESPACES,
} from '../../../../packages/events/src/workflow-events/names.ts';
