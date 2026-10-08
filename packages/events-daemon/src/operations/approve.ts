import { EventControlClient } from '../control/client.ts';

/** Terminal-only disclosure approval; MCP deliberately has no wrapper or tool for this capability. */
export async function approve(
  approvalId: string,
  answer: string,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return new EventControlClient({ stateDir: options.stateDir }).request('approve', { approvalId, answer });
}

/** Internal terminal flow step, not an exposed capability: it obtains the challenge the person must type back. */
export async function disclosureChallenge(
  approvalId: string,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<string> {
  return (await new EventControlClient({ stateDir: options.stateDir }).request('approve-challenge', {
    approvalId,
  })) as string;
}
