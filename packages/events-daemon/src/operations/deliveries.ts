import { EventControlClient } from '../control/client.ts';

import type { LaneWindowIdentity } from '../domain/lanes.ts';
import type { DeliveryShowResultV1 } from '../runtime/delivery-show.ts';

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

/**
 * One delivery's details (0.32.0, owner feedback §3.5): its row, decision, event and source ids, and target. The
 * person's view: the CLI refuses it inside an MCP server's process, and no MCP tool calls it.
 */
export async function deliveryShow(deliveryId: string, options: Options = {}): Promise<DeliveryShowResultV1> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('delivery-show', {
    deliveryId,
  })) as DeliveryShowResultV1;
}

export async function retryDelivery(deliveryId: string, options: Options = {}): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('retryDelivery', { deliveryId });
}

/**
 * Stops a delivery that will be tried again (it is cancelled at once), or drops a dead letter's retained payload. Over
 * MCP `caller` is the agent window, which cannot reach a lane target's delivery unless it is bound to that lane.
 */
export async function dropDelivery(
  deliveryId: string,
  options: Options & {
    readonly caller?: LaneWindowIdentity | undefined;
    /** The CLI runs inside an MCP server's process: like a window with no lane, it stops nothing (review 0.32.0, 4). */
    readonly insideMcpServer?: boolean | undefined;
  } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('dropDelivery', {
    deliveryId,
    ...(options.caller === undefined ? {} : { caller: options.caller }),
    ...(options.insideMcpServer === true ? { insideMcpServer: true } : {}),
  });
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
