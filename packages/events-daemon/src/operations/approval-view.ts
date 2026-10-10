import { EventControlClient } from '../control/client.ts';

/** Returns the daemon-authoritative preview and fresh challenge; it never claims an approval. */
export async function approvalView(
  approvalId: string,
  digest: string,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('approvalView', { approvalId, digest });
}
