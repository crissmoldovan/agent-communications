import { EventControlClient } from '../control/client.ts';

export interface PauseResult {
  readonly enabled: boolean;
  readonly paused: boolean;
  readonly switchGeneration: number;
}

export async function pause(options: { readonly stateDir?: string | undefined } = {}): Promise<PauseResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('pause')) as PauseResult;
}

export async function resume(options: { readonly stateDir?: string | undefined } = {}): Promise<PauseResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('resume')) as PauseResult;
}
