import { CommsError } from '@agentcomms/core';
import { EventControlClient } from '../control/client.ts';
import { type PersonSetupApprover, type PersonSetupOrigin, personSetupApprover } from '../domain/judge-setup.ts';
import type { PendingRuleJudgeTestSelector } from '../runtime/b3-pending-rule-judge-test.ts';
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

/**
 * The B3 approval surface the desktop app's preview is (`B3_PENDING_TARGET_APPROVAL_SURFACES`): a challenge it is
 * given is a view's, answered on the app channel, as judge setup answers its enablements' (0.32.0).
 */
const APP_APPROVAL_SCREEN = 'app-approval-screen';

const APPROVAL_ID = /^ap_[0-9A-HJKMNP-TV-Z]{26}$/u;
const DIGEST = /^[0-9a-f]{64}$/u;

/** What `rule approve` answers: the rule version now on, who approved it, and the activation's own completion. */
export interface RuleAppApprovalResultV1 {
  readonly approvalId: string;
  readonly ruleId: string;
  readonly version: number;
  readonly approved: true;
  /** Where the person was, as the CLI found them: the release app, the test build, or the app unattested. */
  readonly approvedBy: Exclude<PersonSetupApprover, 'terminal'>;
  readonly completion: unknown;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * A rule's activation, approved by the person in the Agent Comms app after its preview (0.33.0 design §3.1): the
 * activation `rule enable` prepared, and nothing else — not a judge kind, a budget or `enable-all`, which have their own
 * paths. The owner's own approval view issues the challenge for exactly the digest the person saw, and it is answered
 * on the app channel at once, as judge setup answers its enablements. The CLI refuses an agent's shell, the event
 * service's MCP server and, on macOS, a process the app did not start before this is called; at a terminal the person
 * approves with `approve`, which asks for the challenge.
 */
export async function approveRuleFromApp(
  approvalId: string,
  digest: string,
  options: { readonly stateDir?: string | undefined; readonly origin: PersonSetupOrigin },
): Promise<RuleAppApprovalResultV1> {
  const approvedBy = personSetupApprover(options.origin);
  if (approvedBy === null || approvedBy === 'terminal')
    throw new CommsError(
      'USAGE',
      'at your terminal, approve a rule with approve <approval-id>, which asks for its challenge',
    );
  if (!APPROVAL_ID.test(approvalId)) throw new CommsError('USAGE', 'that is not an approval id');
  if (!DIGEST.test(digest)) throw new CommsError('USAGE', 'the digest is the 64 hex digits its preview showed');
  const client = new EventControlClient({ stateDir: options.stateDir, clientName: APP_APPROVAL_SCREEN });
  const view = await client.request('approvalView', { approvalId, digest });
  if (!isRecord(view)) throw new CommsError('BAD_DATA', 'the approval view could not be read');
  if (view.kind === 'STALE_APPROVAL')
    throw new CommsError('APPROVAL_VOID', 'this approval is no longer waiting: it was approved, cancelled or replaced');
  if (view.kind === 'DIGEST_MISMATCH')
    throw new CommsError('APPROVAL_VOID', 'the rule changed after you saw its preview: review it again');
  if (view.kind === 'CHALLENGE_EXPIRED')
    throw new CommsError('TRANSIENT', 'the approval was being opened elsewhere: try again in a moment');
  const preview = view.preview;
  const challenge = isRecord(view.challenge) ? view.challenge.challenge : undefined;
  if (view.kind !== 'READY' || !isRecord(preview) || typeof challenge !== 'string')
    throw new CommsError('BAD_DATA', 'the approval view could not be read');
  const rule = preview.kind === 'rule' && isRecord(preview.rule) ? preview.rule : null;
  if (rule === null || typeof rule.ruleId !== 'string' || typeof rule.version !== 'number')
    throw new CommsError(
      'APPROVAL_REQUIRED',
      "only a rule's activation is approved here; approve anything else at your terminal",
    );
  const completion = await client.request('approve', { approvalId, answer: challenge });
  return { approvalId, ruleId: rule.ruleId, version: rule.version, approved: true, approvedBy, completion };
}
