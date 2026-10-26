import { CommsError } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';
import type { PersonSetupOrigin } from '../domain/judge-setup.ts';
import type { PendingRuleJudgeTestSelector } from '../runtime/b3-pending-rule-judge-test.ts';
import type { RuleApprovalResultV1 } from '../runtime/judge-setup.ts';
import type { B3PendingTargetSelectorV1 } from './b3-contract.ts';

export interface TerminalApprovalStart {
  readonly challenge: string;
  readonly pendingTargetSelectors: readonly B3PendingTargetSelectorV1[];
  readonly pendingRuleJudgeTestSelectors: readonly PendingRuleJudgeTestSelector[];
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
    !Array.isArray((result as { readonly pendingTargetSelectors?: unknown }).pendingTargetSelectors) ||
    !Array.isArray((result as { readonly pendingRuleJudgeTestSelectors?: unknown }).pendingRuleJudgeTestSelectors)
  )
    throw new TypeError('the terminal approval start is malformed');
  return result as TerminalApprovalStart;
}

/** Internal terminal-flow step: only the terminal-approved sidecar can carry this selector. */
export async function pendingRuleJudgeTest(
  selector: PendingRuleJudgeTestSelector,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return terminalApprovalClient(options).request('judgeTest', { ...selector });
}

/** Internal terminal-flow step: it forwards the owner-built selector unchanged over the terminal approval surface. */
export async function pendingTargetTest(
  selector: B3PendingTargetSelectorV1,
  options: { readonly stateDir?: string | undefined } = {},
): Promise<unknown> {
  return terminalApprovalClient(options).request('targetTest', { ...selector });
}

const APPROVAL_ID = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

export type { RuleApprovalResultV1 } from '../runtime/judge-setup.ts';

/**
 * A rule's activation, approved by the person in the Agent Comms app after its preview (0.33.0 design §3.1): the owner's
 * `rule-approve` wire, from the origin the CLI found, which approves the activation `rule enable` prepared — and
 * nothing else — for exactly the digest the person saw, on the app channel, as judge setup approves its enablements.
 * The CLI refuses an agent's shell, the event service's MCP server and, on macOS, a process the app did not start
 * before this is called, and a word that is not an approval id or a digest is refused here; the owner refuses every
 * origin but the app's. At a terminal the person approves with `approve`, which asks for the challenge.
 */
export async function approveRuleFromApp(
  approvalId: string,
  digest: string,
  options: { readonly stateDir?: string | undefined; readonly origin: PersonSetupOrigin },
): Promise<RuleApprovalResultV1> {
  if (!APPROVAL_ID.test(approvalId)) throw new CommsError('USAGE', 'that is not an approval id');
  if (!DIGEST.test(digest)) throw new CommsError('USAGE', 'the digest is the 64 hex digits its preview showed');
  return (await new EventControlClient({ stateDir: options.stateDir, clientName: options.origin }).request(
    'rule-approve',
    { approvalId, digest },
  )) as RuleApprovalResultV1;
}
