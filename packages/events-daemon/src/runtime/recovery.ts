import type { ActivationRuntime } from './activations.ts';

/** One explicit startup hook keeps recovery on the same activation runtime and its live approval checks. */
export async function recoverActivations(runtime: ActivationRuntime): Promise<void> {
  await runtime.recover();
}
