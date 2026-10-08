import { EventControlClient } from '../control/client.ts';
export interface EnableAllResult {
  readonly intentId: string;
  readonly approvalId: string;
  readonly kind: 'enable-all';
  readonly status: 'pending';
}

/** The disclosure approval/activation route lands with the immutable activation work in Batch 3. */
export async function enableAll(options: { readonly stateDir?: string | undefined } = {}): Promise<EnableAllResult> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('enable-all')) as EnableAllResult;
}
