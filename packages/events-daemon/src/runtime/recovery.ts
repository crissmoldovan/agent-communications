import type { ActivationRuntime } from './activations.ts';
import type { DeliveryDispatcher, DispatchResult } from './dispatcher.ts';

/** One explicit startup hook keeps recovery on the same activation runtime and its live approval checks. */
export async function recoverActivations(runtime: ActivationRuntime): Promise<void> {
  await runtime.recover();
}

/** Startup and ticks share this one recovery entry: the dispatcher routes each expired lease through its target kind. */
export async function recoverDeliveryLeases(
  dispatcher: Pick<DeliveryDispatcher, 'recoverLeases'>,
): Promise<readonly DispatchResult[]> {
  return dispatcher.recoverLeases();
}
