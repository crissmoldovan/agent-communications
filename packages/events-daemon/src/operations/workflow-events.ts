import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/** The step event catalogue (W25): every schema, its standard and own words, and its closed outputs. */
export function workflowEventsList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('workflow-events-list', {});
}

/** One schema of the step event catalogue. */
export function workflowEventsShow(schema: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('workflow-events-show', { schema });
}
