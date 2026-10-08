import { EventControlClient } from '../control/client.ts';
import type { PauseResult } from './pause.ts';

export async function disableAll(options: { readonly stateDir?: string | undefined } = {}): Promise<PauseResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('disable-all')) as PauseResult;
}
