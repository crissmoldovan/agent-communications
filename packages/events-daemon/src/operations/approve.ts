import { EventControlClient } from '../control/client.ts';
import type { B3PendingTargetSelectorV1 } from './b3-contract.ts';

export interface TerminalApprovalStart {
  readonly challenge: string;
  readonly pendingTargetSelectors: readonly B3PendingTargetSelectorV1[];
}

function terminalApprovalClient(options: { readonly stateDir?: string | undefined }): EventControlClient {
  return new EventControlClient({ stateDir: options.stateDir, clientName: 'terminal-approval' });
}

/** Terminal-only disclosure approval; MCP deliberately has no wrapper or tool for this capability. */
export async function approve(
  approvalId: string,
  answer: string,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return terminalApprovalClient(options).request('approve', { approvalId, answer });
}

/** Internal terminal flow step, not an exposed capability: it obtains the challenge the person must type back. */
export async function disclosureChallenge(
  approvalId: string,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<TerminalApprovalStart> {
  const result = await terminalApprovalClient(options).request('approve-challenge', {
    approvalId,
  });
  if (
    typeof result !== 'object' ||
    result === null ||
    Array.isArray(result) ||
    typeof (result as { readonly challenge?: unknown }).challenge !== 'string' ||
    !Array.isArray((result as { readonly pendingTargetSelectors?: unknown }).pendingTargetSelectors)
  )
    throw new TypeError('the terminal approval start is malformed');
  return result as TerminalApprovalStart;
}

/** Internal terminal-flow step: it forwards the owner-built selector unchanged over the terminal approval surface. */
export async function pendingTargetTest(
  selector: B3PendingTargetSelectorV1,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return terminalApprovalClient(options).request('targetTest', { ...selector });
}
