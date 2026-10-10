import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

/** The owner constructs the fixed synthetic payload; callers name only the exact immutable target version. */
export async function targetTest(targetId: string, targetVersion: number, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('targetTest', { targetId, targetVersion });
}
