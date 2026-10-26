import { EventControlClient } from '../control/client.ts';

import type { LaneWindowIdentity } from '../domain/lanes.ts';

type Options = { readonly stateDir?: string | undefined };

/**
 * Content-free delivery metadata. `caller` is the agent window an MCP call comes from: the owner then leaves out every
 * lane target's deliveries but those of the lane that window is bound to (routing B4). The CLI passes none.
 */
export async function deliveriesList(
  options: Options & { readonly caller?: LaneWindowIdentity | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request(
    'deliveriesList',
    options.caller === undefined ? {} : { caller: options.caller },
  );
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
  return new EventControlClient({ stateDir: options.stateDir, clientName: 'interactive-terminal' }).request(
    'decideHeld',
    {
      decisionId,
      decision,
    },
  );
}
