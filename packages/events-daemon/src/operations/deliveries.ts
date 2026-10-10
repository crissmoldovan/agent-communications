import { EventControlClient } from '../control/client.ts';

type Options = { readonly stateDir?: string | undefined };

export async function deliveriesList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('deliveriesList');
}

export async function retryDelivery(deliveryId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('retryDelivery', { deliveryId });
}

export async function dropDelivery(deliveryId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('dropDelivery', { deliveryId });
}

export async function heldList(options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('heldList');
}

/** Terminal/app-only operation; Task 5 intentionally provides no MCP adapter. */
export async function decideHeld(
  decisionId: string,
  decision: 'accept' | 'reject',
  options: Options = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('decideHeld', { decisionId, decision });
}
