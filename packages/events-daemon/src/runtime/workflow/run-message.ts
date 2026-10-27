import { TAKE_ID_PATTERN } from '@agentcomms/core';
import type { FlowDocumentV1 } from '@agentcomms/events';
import type { CanonicalFullRuleDocument } from '../../domain/activation-documents.ts';
import type { RunMessage } from './contracts.ts';

/**
 * The message a run is about, kept for "find the session that took this conversation" (workflows design W36): only
 * for a flow with a `{ thread: true }` place, and only the channel's own ids — the message's id as a take names it, and
 * its thread. The rule's projection keeps the thread's id for such a flow (`threadPointers`), the evaluator seals the
 * result into the run's record (`runMessageOf`), and the find-session step reads it there. A sender's words never
 * enter it: Gmail's thread id and Slack's `threadTs` are the provider's ids.
 */

const MESSAGE_TS = /^[0-9]{1,16}\.[0-9]{1,16}$/u;

/** Whether a workflow's flow looks for the session that took the conversation. */
export function findsByThread(rule: CanonicalFullRuleDocument): boolean {
  const flow = (rule as { readonly flow?: FlowDocumentV1 }).flow;
  if (flow === undefined) return false;
  return Object.values(flow.steps).some((step) => step.kind === 'find-session' && 'thread' in step.in);
}

/** The event fields a projection keeps, besides its rule's own, so the run knows its thread: for such a flow only. */
export function threadPointers(rule: CanonicalFullRuleDocument): readonly string[] {
  if (!findsByThread(rule)) return [];
  switch (rule.event.type) {
    case 'gmail.message.received':
    case 'gmail.message.sent':
      return ['/threadId'];
    case 'slack.message.posted':
      return ['/threadTs'];
    default:
      return [];
  }
}

function id(value: unknown): string | null {
  return typeof value === 'string' && TAKE_ID_PATTERN.test(value) ? value : null;
}

/**
 * The message and thread of a projected event, as core's take store names them — for a flow that finds by thread;
 * undefined otherwise, and for an event no take is about.
 */
export function runMessageOf(
  rule: CanonicalFullRuleDocument,
  event: Readonly<Record<string, unknown>>,
): RunMessage | undefined {
  if (!findsByThread(rule)) return undefined;
  switch (rule.event.type) {
    case 'gmail.message.received':
    case 'gmail.message.sent': {
      const message = id(event.messageId);
      return message === null ? undefined : { id: message, thread: id(event.threadId) };
    }
    case 'slack.message.posted': {
      const channel = (event.channel as { readonly id?: unknown } | null | undefined)?.id;
      const ts = event.ts;
      if (typeof channel !== 'string' || typeof ts !== 'string' || !MESSAGE_TS.test(ts)) return undefined;
      const message = id(`${channel}/${ts}`);
      const parent = event.threadTs;
      const thread = typeof parent === 'string' && MESSAGE_TS.test(parent) ? id(`${channel}/${parent}`) : null;
      return message === null ? undefined : { id: message, thread };
    }
    case 'resend.email.received': {
      const message = id(event.emailId);
      return message === null ? undefined : { id: message, thread: null };
    }
    default:
      return undefined;
  }
}
