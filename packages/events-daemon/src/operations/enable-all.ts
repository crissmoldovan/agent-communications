import type { DisclosureBinding } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';

/**
 * What `enable-all` prepares (0.34.0 design B4): the standing approval that starts collection, waiting for the person.
 * The app shows its preview and, when the person approves, sends `collection approve <approvalId> --digest
 * <binding.digest>`; at a terminal the person runs `approve <approvalId>`, which asks for its challenge.
 */
export interface EnableAllResult {
  readonly intentId: string;
  readonly approvalId: string;
  /** What the approval is bound to: `digest` is the fingerprint its preview shows and the app's approval names. */
  readonly binding: DisclosureBinding;
  readonly kind: 'enable-all';
  readonly status: 'pending';
}

/** Prepares the standing approval that switches collection on; it approves nothing. */
export async function enableAll(options: { readonly stateDir?: string | undefined } = {}): Promise<EnableAllResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('enable-all')) as EnableAllResult;
}
