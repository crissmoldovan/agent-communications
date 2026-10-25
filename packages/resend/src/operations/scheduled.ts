import { CommsError, type GatedChange, toCommsError } from '@agentcomms/core';
import { keyPermissionOf } from '../accounts.ts';
import { recorded } from '../activity.ts';
import { resendRequest } from '../api/client.ts';
import { closedPermit, spendOn } from '../api/guard.ts';
import { SendRecords } from '../compose/store.ts';
import type { ResendContext } from '../context.ts';
import { resendId } from './read.ts';

/**
 * Cancelling a scheduled email.
 *
 * Cancelling only reduces who gets mail, so it loosens nothing (contract: "no loosening, but audited"). It cannot be
 * taken back, though — Resend will not reschedule a cancelled email — so one rule is added on top: an email this
 * machine scheduled is cancelled at once; one scheduled by anything else (the team's own production code, say) is a
 * change a person approves, through the same change flow as every other irreversible act. Rescheduling is not
 * offered: a new time is a new send, prepared and approved again.
 */

export interface CancelledEmail {
  account: string;
  id: string;
  cancelled: true;
  /** Whether this machine had scheduled it. */
  fromThisMachine: boolean;
  recipients: number;
  /**
   * What this machine could not write after Resend confirmed the cancellation — its send record, its audit — when
   * anything (design 2026-10-05 §D8). The cancellation stands; only its bookkeeping is missing.
   */
  hint?: string | undefined;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Cancelling one scheduled email, as a change the shared change flow plans and applies. Recorded in the activity log
 * as the write it is — the email's id, and how many recipients it had — when it is applied, or when the look before it
 * refuses; a call that only prepares the change's approval writes nothing to the account, and the approval store keeps
 * it.
 */
export function cancelScheduledChange(context: ResendContext, name: string, id: unknown): GatedChange<CancelledEmail> {
  const change = cancelChange(context, name, id);
  return {
    ...change,
    plan: async (config) => {
      try {
        return await change.plan(config);
      } catch (error) {
        // The look refused it, or failed: the same line a refused cancel records, then the same error on.
        await recorded(
          context,
          'resend.scheduled.cancel',
          'write',
          name,
          () => Promise.reject(error),
          () => ({}),
        ).catch(() => undefined);
        throw error;
      }
    },
    apply: (consent, request) =>
      recorded(
        context,
        'resend.scheduled.cancel',
        'write',
        name,
        () => change.apply(consent, request),
        (cancelled) => ({ items: [{ id: cancelled.id }], counts: { recipients: cancelled.recipients } }),
      ),
  };
}

function cancelChange(context: ResendContext, name: string, id: unknown): GatedChange<CancelledEmail> {
  const emailId = resendId(id, 'email id');
  const look = async () => {
    const named = await context.accounts.require(name);
    if (named.account.mode !== 'send') {
      throw new CommsError('SCOPE_MISSING', `"${name}" is in read mode, so it changes nothing at Resend`, {
        hint: 'Cancelling needs an account in send mode.',
      });
    }
    if (keyPermissionOf(named.account) !== 'full_access') {
      throw new CommsError('SCOPE_MISSING', 'a sending-only key cannot look up or cancel a scheduled email', {
        hint: 'Cancel it in the Resend dashboard, or use a full-access account.',
      });
    }
    const transport = await context.transport(named);
    const email = await resendRequest<Record<string, unknown>>(transport, 'GET', `/emails/${emailId}`);
    if (email.last_event !== 'scheduled') {
      throw new CommsError(
        'BAD_DATA',
        `email ${emailId} is not scheduled (its last event is ${String(email.last_event)})`,
        {
          hint: 'Only an email still waiting to go can be cancelled.',
        },
      );
    }
    const count = new Set(
      [email.to, email.cc, email.bcc].flatMap((value) =>
        Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [],
      ),
    ).size;
    const ours = await new SendRecords(context.core.paths.stateDir, context.now).byResendId(named.account.id, emailId);
    return { named, count, ours };
  };
  return {
    plan: async (config) => {
      const { named, count, ours } = await look();
      return {
        // About this account, so its own change policy — when it sets one — decides how the cancel is approved.
        account: named.name,
        summary: `Cancel the scheduled email ${emailId} from ${name}`,
        before: config,
        after: config,
        effects: ours
          ? []
          : [
              `cancels the scheduled email ${emailId} to ${count} recipient(s), which was not scheduled from this machine; a cancelled email cannot be rescheduled`,
            ],
      };
    },
    apply: async () => {
      const { named, count, ours } = await look();
      const permit = closedPermit();
      const transport = await context.transport(named, permit);
      const reason = ours ? 'scheduled from this machine' : 'scheduled elsewhere; approved as a change';
      try {
        await spendOn(permit, emailId, 'emails.cancel', () =>
          resendRequest(transport, 'POST', `/emails/${emailId}/cancel`),
        );
      } catch (error) {
        // Audited whatever happened: a cancel whose outcome is unknown may have taken effect, and one Resend refused
        // is still an attempt somebody approved. The cancel's own error is what the caller hears, even if this fails.
        const failure = toCommsError(error);
        const unknown = failure.details?.outcome !== 'not-sent';
        await context.core.audit
          .append({
            inboxId: named.account.id,
            alias: name,
            operation: 'resend.scheduled.cancel',
            outcome: 'failed',
            surface: context.surface,
            ids: { emailIds: [emailId] },
            reason: `${unknown ? 'outcome unknown' : 'not cancelled'}: ${failure.message.slice(0, 200)} (${reason})`,
          })
          .catch(() => undefined);
        throw error;
      }
      /*
       * Resend confirmed it: the cancellation is done, whatever follows (design 2026-10-05 §D8). This machine's send
       * record and its audit are each attempted, neither skipping the other, and one that cannot be written is a gap in
       * the bookkeeping, said in the hint of a successful result — never a failed cancellation. Without the send
       * record, nothing here proves this machine cancelled it, so a later status says only what Resend reports.
       */
      const gaps: string[] = [];
      if (ours) {
        try {
          await new SendRecords(context.core.paths.stateDir, context.now).record(named.account.id, {
            approvalId: ours.approvalId,
            event: 'cancelled',
            resendId: emailId,
          });
        } catch (error) {
          gaps.push(
            `this machine’s send record could not record it (${messageOf(error)}), so its status will say Resend reports it cancelled`,
          );
        }
      }
      try {
        await context.core.audit.append({
          inboxId: named.account.id,
          alias: name,
          operation: 'resend.scheduled.cancel',
          outcome: 'ok',
          surface: context.surface,
          ids: { emailIds: [emailId] },
          reason,
        });
      } catch (error) {
        gaps.push(`the audit log could not record it (${messageOf(error)})`);
      }
      return {
        account: name,
        id: emailId,
        cancelled: true,
        fromThisMachine: ours !== null,
        recipients: count,
        ...(gaps.length === 0
          ? {}
          : { hint: `Resend confirmed the cancellation; what could not be written here: ${gaps.join('; ')}.` }),
      };
    },
  };
}
