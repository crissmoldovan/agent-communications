import { isCommsError } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';
import { requireSupportedNode } from '../runtime/sqlite.ts';

export interface EventsDaemonStatus {
  readonly owner: 'not-running' | 'running';
  readonly enabled?: boolean;
  readonly paused?: boolean;
  readonly switchGeneration?: number;
}

/** Reports an owner through its authenticated control boundary, without opening its SQLite database in the client. */
export async function status(options: { readonly stateDir?: string | undefined } = {}): Promise<EventsDaemonStatus> {
  requireSupportedNode();
  try {
    return (await new EventControlClient({ stateDir: options.stateDir }).request('status')) as EventsDaemonStatus;
  } catch (error) {
    if (isCommsError(error) && error.code === 'NOT_FOUND') return { owner: 'not-running' };
    throw error;
  }
}
