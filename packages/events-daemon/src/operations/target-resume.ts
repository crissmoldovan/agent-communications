import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/** Reopens only an exact degraded terminal reset record; normal delivery retry remains a separate operation. */
export async function targetResume(targetId: string, targetVersion: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('targetResume', { targetId, targetVersion });
}
