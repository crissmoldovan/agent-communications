import { EventControlClient } from '../control/client.ts';
import type { PauseResult } from './pause.ts';

export interface EnableAllResult extends PauseResult {
  readonly standingApprovalRequired: true;
}

/** The disclosure approval/activation route lands with the immutable activation work in Batch 3. */
export async function enableAll(options: { readonly stateDir?: string | undefined } = {}): Promise<EnableAllResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('enable-all')) as EnableAllResult;
}
