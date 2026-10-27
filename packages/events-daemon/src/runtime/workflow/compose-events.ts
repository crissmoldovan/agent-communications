import { createWorkflowEventSink, type WorkflowEventSinkDeps } from '../events/sink.ts';
import type { WorkflowComposition } from './contracts.ts';
import { raiseExecutor } from './steps/raise.ts';

/**
 * Track D's part of the workflow engine (plan I4): the Raise step's executor and the event sink every transition goes
 * through. The owner hands it to `composeWorkflows` with the other tracks' parts.
 */
export function composeWorkflowEvents(deps: WorkflowEventSinkDeps): WorkflowComposition {
  return { executors: [raiseExecutor], sink: createWorkflowEventSink(deps) };
}
