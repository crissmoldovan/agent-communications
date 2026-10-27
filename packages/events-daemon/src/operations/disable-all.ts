import { EventControlClient } from '../control/client.ts';
import type { PauseResult } from './pause.ts';

/**
 * What `disable-all` did, in the person's words (0.34.0 design B4, Events → Service → Switch off). The owner does all of
 * it in one transaction, from any caller, at once: it switches collection off and advances the global generation, which
 * ends every lane's binding; cancels deliveries not yet sent and drops what failed ones kept; empties the Queue and the
 * dry-run log; and cancels activations still waiting for approval. Active rule versions keep their pointers, and pause
 * is left as it was.
 */
export const DISABLE_ALL_SAID: string =
  "Switched off: the event service is still running but no longer watches your accounts, so no workflow does anything. Your workflows are kept. Cleared: deliveries not yet sent and what failed ones kept, the Queue's items, the dry-run log and approvals not yet given; each lane's window is unbound. Switching on again needs your approval.";

export interface DisableAllResult extends PauseResult {
  /** What it did, in plain words. */
  readonly said: string;
}

/** Switches collection off at once — a tightening, from anywhere — and says what that did. */
export async function disableAll(options: { readonly stateDir?: string | undefined } = {}): Promise<DisableAllResult> {
  const status = (await new EventControlClient({ stateDir: options.stateDir }).request('disable-all')) as PauseResult;
  return { ...status, said: DISABLE_ALL_SAID };
}
