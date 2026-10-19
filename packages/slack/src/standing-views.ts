import { type ApprovalRecord, CommsError, type PreparedStanding } from '@agentcomms/core';
import type { SlackContext } from './context.ts';

/**
 * How a standing approval prepared in Slack is reported (design 2026-10-19-standing-approvals, S8): by the tool, as
 * `approvalRequired` with its preview, as a change waiting for a person is; by the command line, where no person sits at
 * the terminal, as APPROVAL_PENDING, exit 10. Presentation only: `prepareStandingAdd` decides everything.
 */

/** What a narrowing applied at once is reported as: which standing approval, and what it now holds. */
export function standingNarrowedView(record: ApprovalRecord): {
  narrowed: true;
  standingId: string;
  state: ApprovalRecord['state'];
  narrowing: ApprovalRecord['narrowed'] | null;
} {
  return { narrowed: true, standingId: record.approvalId, state: record.state, narrowing: record.narrowed ?? null };
}

/** What a tool returns for a standing approval prepared and waiting for the person's code at their terminal. */
export function standingPreparedView(prepared: PreparedStanding): Record<string, unknown> {
  return {
    approvalRequired: true,
    approvalId: prepared.approvalId,
    summary: prepared.summary,
    preview: prepared.preview,
    expiresAt: prepared.expiresAt,
    next: prepared.next,
    warnings: prepared.warnings,
    approval: prepared.approval,
  };
}

/**
 * The command line's refusal for a standing approval prepared where no person is at the terminal: APPROVAL_PENDING,
 * exit 10, with the preview and the command the person runs — as a change waiting for a person is (§8.1).
 */
export function standingPending(context: SlackContext, prepared: PreparedStanding): CommsError {
  const approve = context.handoffs.own(['approve', prepared.approvalId]);
  return new CommsError(
    'APPROVAL_PENDING',
    `this standing approval needs the person's code first: ${prepared.summary}`,
    {
      hint: prepared.next,
      details: {
        approvalId: prepared.approvalId,
        preview: prepared.preview,
        expiresAt: prepared.expiresAt,
        warnings: prepared.warnings,
        approval: prepared.approval,
        command: approve,
      },
    },
  );
}
