import { CommsError } from '@agentcomms/core';
import { WORKFLOW_EVENT_CATALOGUE_V1, type WorkflowEventSchema } from '@agentcomms/events';

/**
 * The step event catalogue as the person and an agent read it (workflows design W25, Appendix W.3): content-free, so
 * `workflow-events list|show` is on the CLI and MCP alike. It is `@agentcomms/events`' own data, never a copy.
 */

/** One schema's words and closed outputs. */
export interface WorkflowEventSchemaEntryV1 {
  readonly schema: WorkflowEventSchema;
  readonly standard: readonly string[];
  readonly own: readonly string[];
  readonly outputs: readonly string[];
}

/** `workflow-events list --json`: the whole catalogue, version 1, in Appendix W.3's order. */
export interface WorkflowEventsListResultV1 {
  readonly catalogueVersion: 1;
  readonly schemas: readonly WorkflowEventSchemaEntryV1[];
}

/** `workflow-events show <schema> --json`: one schema of it. */
export interface WorkflowEventsShowResultV1 extends WorkflowEventSchemaEntryV1 {
  readonly catalogueVersion: 1;
}

function entry(schema: WorkflowEventSchema): WorkflowEventSchemaEntryV1 {
  const known = WORKFLOW_EVENT_CATALOGUE_V1[schema];
  return { schema, standard: [...known.standard], own: [...known.own], outputs: [...known.outputs] };
}

export function workflowEventsListResult(): WorkflowEventsListResultV1 {
  return {
    catalogueVersion: 1,
    schemas: (Object.keys(WORKFLOW_EVENT_CATALOGUE_V1) as WorkflowEventSchema[]).map(entry),
  };
}

export function workflowEventsShowResult(schema: unknown): WorkflowEventsShowResultV1 {
  if (typeof schema !== 'string' || schema.length === 0) throw new CommsError('USAGE', 'the schema is required');
  if (!Object.hasOwn(WORKFLOW_EVENT_CATALOGUE_V1, schema))
    throw new CommsError('NOT_FOUND', 'that is not a step event schema: workflow-events list names each one');
  return { catalogueVersion: 1, ...entry(schema as WorkflowEventSchema) };
}
