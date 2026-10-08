import { EventControlClient } from '../control/client.ts';

export interface StopResult {
  readonly stopping: true;
}

/** Requests a clean foreground-owner shutdown through the authenticated local control protocol. */
export async function stop(options: { readonly stateDir?: string | undefined } = {}): Promise<StopResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('stop')) as StopResult;
}
