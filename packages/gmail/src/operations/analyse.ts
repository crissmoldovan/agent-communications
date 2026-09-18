import type { GmailContext } from '../context.ts';
import { buildTimeline, renderTimelineMarkdown, renderTimelineMermaid, type Timeline } from '../domain/timeline.ts';
import { type ReadOptions, readThread } from './read.ts';

/**
 * Thread analysis that a model may rely on: every fact here is computed from headers and dates. A skill can add
 * judgement on top — who owes what, whether the tone changed — but it has to say that it is judgement, and the facts
 * it builds on are not its own.
 */

export interface TimelineResult {
  timeline: Timeline;
  /** Renderings, so a caller need not rebuild them: JSON is the timeline itself. */
  markdown: string;
  mermaid: string;
}

/** The addresses that count as "us" for this mailbox: its own, plus every verified send-as alias. */
export async function ownAddresses(context: GmailContext, alias: string): Promise<string[]> {
  const { inbox } = await context.inbox(alias);
  const addresses = new Set<string>([inbox.email.toLowerCase()]);
  try {
    const transport = await context.transport(alias);
    for (const sendAs of await transport.listSendAs()) {
      if (sendAs.sendAsEmail) addresses.add(sendAs.sendAsEmail.toLowerCase());
    }
  } catch {
    // Send-as needs one more call and one more permission; without it the mailbox's own address still identifies us.
  }
  return [...addresses];
}

export async function threadTimeline(
  context: GmailContext,
  alias: string,
  threadId: string,
  options: ReadOptions & { businessHours?: boolean | undefined; maxThreadChars?: number | undefined } = {},
): Promise<TimelineResult> {
  // The bodies are not part of a timeline, so they are read at their smallest: the headers carry every fact used.
  const thread = await readThread(context, alias, threadId, { ...options, maxChars: options.maxChars ?? 1 });
  const timeline = buildTimeline(
    { threadId: thread.threadId, inbox: alias, messages: thread.messages },
    { ownAddresses: await ownAddresses(context, alias), businessHours: options.businessHours ?? false },
  );
  return {
    timeline,
    markdown: renderTimelineMarkdown(timeline),
    mermaid: renderTimelineMermaid(timeline),
  };
}

export interface LabelSummary {
  id: string;
  name: string;
  type: 'system' | 'user';
  messagesTotal?: number | undefined;
  messagesUnread?: number | undefined;
}

export async function listLabels(context: GmailContext, alias: string): Promise<LabelSummary[]> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  return (await transport.listLabels()).sort((a, b) => a.name.localeCompare(b.name));
}

export interface SendAsSummary {
  email: string;
  displayName: string;
  isDefault: boolean;
  isPrimary: boolean;
  verificationStatus: string | undefined;
  /** Whether a signature is set; the signature itself is HTML and is not returned here. */
  hasSignature: boolean;
}

export async function listSendAs(context: GmailContext, alias: string): Promise<SendAsSummary[]> {
  const resolved = await context.inbox(alias);
  await context.requireCapability(resolved, 'read');
  const transport = await context.transport(alias);
  return (await transport.listSendAs()).map((entry) => ({
    email: entry.sendAsEmail,
    displayName: entry.displayName,
    isDefault: entry.isDefault,
    isPrimary: entry.isPrimary,
    verificationStatus: entry.verificationStatus,
    hasSignature: Boolean(entry.signature && entry.signature.trim().length > 0),
  }));
}
