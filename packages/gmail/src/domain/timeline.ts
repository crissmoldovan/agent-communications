import { canonicalAddress } from '@agent-communications/core';
import type { ReadMessageResult } from '../operations/read.ts';

/**
 * What happened in a thread, computed rather than judged.
 *
 * Every fact here comes from headers and dates: who wrote when, who was added or dropped, what was attached, how long
 * each reply took, and who is being waited on now. A model may interpret this afterwards — but the facts it
 * interprets are not its own guesses, and a skill that layers judgement on top has to label it as such.
 */

export type Direction = 'in' | 'out';

export interface TimelineEvent {
  index: number;
  messageId: string;
  at: string | null;
  from: string | null;
  fromName: string;
  direction: Direction;
  to: string[];
  cc: string[];
  isDraft: boolean;
  attachments: Array<{ filename: string; size: number; riskFlags: string[] }>;
  subjectChanged: boolean;
  /** Hours since the previous message in the thread; null for the first. */
  gapHours: number | null;
  /** Participants who appear for the first time in this message. */
  participantsAdded: string[];
  /** Participants who were on the previous message and are not on this one. */
  participantsDropped: string[];
  /** The subject looks like a forward, or the sender is new to the thread and quotes it. */
  forwardedIn: boolean;
}

export interface WaitingOn {
  /** Who owes a reply: `them` when the last message was inbound, `us` when we sent last. */
  party: 'us' | 'them' | 'nobody';
  sinceHours: number | null;
  since: string | null;
}

export interface Timeline {
  threadId: string;
  inbox: string;
  subject: string;
  messageCount: number;
  participants: string[];
  events: TimelineEvent[];
  /** The longest gap between consecutive messages, in hours. */
  longestWaitHours: number | null;
  waitingOn: WaitingOn;
  firstAt: string | null;
  lastAt: string | null;
}

export interface TimelineOptions {
  /** Addresses that count as "us": the inbox address and its send-as aliases. */
  ownAddresses: readonly string[];
  /** Count only Monday–Friday, 09:00–17:00 in the given offset, so a weekend is not reported as a delay. */
  businessHours?: boolean | undefined;
}

const HOUR = 3_600_000;

/** Whole business hours between two instants: weekdays only, 09:00–17:00 UTC. */
export function businessHoursBetween(from: Date, to: Date): number {
  if (to <= from) return 0;
  let hours = 0;
  const cursor = new Date(from.getTime());
  cursor.setUTCMinutes(0, 0, 0);
  while (cursor < to) {
    const day = cursor.getUTCDay();
    const hour = cursor.getUTCHours();
    if (day >= 1 && day <= 5 && hour >= 9 && hour < 17) hours += 1;
    cursor.setUTCHours(cursor.getUTCHours() + 1);
  }
  return hours;
}

function hoursBetween(from: string | null, to: string | null, businessOnly: boolean): number | null {
  if (!from || !to) return null;
  const start = new Date(from);
  const end = new Date(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return null;
  if (businessOnly) return businessHoursBetween(start, end);
  return Math.round(((end.getTime() - start.getTime()) / HOUR) * 10) / 10;
}

function normaliseSubject(subject: string): string {
  return subject
    .replace(/^((re|fwd?|aw|sv|vs|rv)\s*(\[\d+\])?\s*:\s*)+/i, '')
    .trim()
    .toLowerCase();
}

function isForward(subject: string): boolean {
  return /^\s*(fwd?|tr|wg)\s*:/i.test(subject);
}

/** Builds the timeline from messages already read (chronological, oldest first). */
export function buildTimeline(
  thread: { threadId: string; inbox: string; messages: readonly ReadMessageResult[] },
  options: TimelineOptions,
): Timeline {
  const own = new Set(options.ownAddresses.map(canonicalAddress));
  const events: TimelineEvent[] = [];
  let previousParticipants = new Set<string>();
  let previousAt: string | null = null;
  const baseSubject = normaliseSubject(thread.messages[0]?.subject ?? '');
  const seenSenders = new Set<string>();

  for (const [index, message] of thread.messages.entries()) {
    const from = message.from?.address ?? null;
    const to = message.to.map((entry) => entry.address);
    const cc = message.cc.map((entry) => entry.address);
    const participants = new Set([...(from ? [from] : []), ...to, ...cc]);
    const isDraft = message.labels.includes('DRAFT');

    const direction: Direction = from && own.has(from) ? 'out' : message.labels.includes('SENT') ? 'out' : 'in';
    const gapHours = hoursBetween(previousAt, message.date, options.businessHours ?? false);

    events.push({
      index,
      messageId: message.messageId,
      at: message.date,
      from,
      fromName: message.from?.name ?? '',
      direction,
      to,
      cc,
      isDraft,
      attachments: message.attachments
        .filter((attachment) => !attachment.inline)
        .map((attachment) => ({
          filename: attachment.filename,
          size: attachment.size,
          riskFlags: attachment.riskFlags,
        })),
      subjectChanged: index > 0 && normaliseSubject(message.subject) !== baseSubject,
      gapHours,
      participantsAdded: [...participants].filter((address) => !previousParticipants.has(address) && index > 0),
      participantsDropped: [...previousParticipants].filter((address) => !participants.has(address) && index > 0),
      forwardedIn: index > 0 && (isForward(message.subject) || Boolean(from && !seenSenders.has(from))),
    });

    if (from) seenSenders.add(from);
    for (const address of participants) seenSenders.add(address);
    previousParticipants = participants;
    // A draft is not part of the conversation's rhythm: it has not been sent, so nobody is waiting because of it.
    if (!isDraft) previousAt = message.date;
  }

  const sent = events.filter((event) => !event.isDraft);
  const last = sent.at(-1);
  const now = new Date();
  const waitingOn: WaitingOn = last
    ? {
        party: last.direction === 'in' ? 'us' : 'them',
        sinceHours: hoursBetween(last.at, now.toISOString(), options.businessHours ?? false),
        since: last.at,
      }
    : { party: 'nobody', sinceHours: null, since: null };

  const gaps = sent.map((event) => event.gapHours).filter((gap): gap is number => gap !== null);

  return {
    threadId: thread.threadId,
    inbox: thread.inbox,
    subject: thread.messages[0]?.subject ?? '',
    messageCount: thread.messages.length,
    participants: [...new Set(events.flatMap((event) => [event.from, ...event.to, ...event.cc]))].filter(
      (address): address is string => Boolean(address),
    ),
    events,
    longestWaitHours: gaps.length > 0 ? Math.max(...gaps) : null,
    waitingOn,
    firstAt: sent[0]?.at ?? null,
    lastAt: last?.at ?? null,
  };
}

function shortDate(at: string | null): string {
  if (!at) return '—';
  return at.replace('T', ' ').replace(/:\d{2}\.\d{3}Z$/, '');
}

/** A table a person can read at a glance. Display names are sender-controlled, so only addresses are shown. */
export function renderTimelineMarkdown(timeline: Timeline): string {
  const lines = [
    `**${timeline.subject}** — ${timeline.messageCount} messages in ${timeline.inbox}`,
    '',
    '| # | when | direction | from | waited | attachments | changes |',
    '|---|---|---|---|---|---|---|',
  ];
  for (const event of timeline.events) {
    const changes = [
      event.participantsAdded.length ? `+${event.participantsAdded.join(' +')}` : '',
      event.participantsDropped.length ? `−${event.participantsDropped.join(' −')}` : '',
      event.subjectChanged ? 'subject changed' : '',
      event.forwardedIn ? 'forwarded in' : '',
      event.isDraft ? 'draft (not sent)' : '',
    ]
      .filter(Boolean)
      .join(', ');
    lines.push(
      `| ${event.index + 1} | ${shortDate(event.at)} | ${event.direction === 'in' ? 'received' : 'sent'} | ${
        event.from ?? '—'
      } | ${event.gapHours === null ? '—' : `${event.gapHours}h`} | ${
        event.attachments.map((attachment) => attachment.filename).join(', ') || '—'
      } | ${changes || '—'} |`,
    );
  }
  lines.push('');
  if (timeline.longestWaitHours !== null) lines.push(`Longest wait: ${timeline.longestWaitHours}h.`);
  if (timeline.waitingOn.party !== 'nobody') {
    lines.push(
      `Waiting on: ${timeline.waitingOn.party === 'us' ? 'us' : 'them'}, for ${timeline.waitingOn.sinceHours ?? '—'}h.`,
    );
  }
  return lines.join('\n');
}

/** A Mermaid timeline, which renders in Markdown viewers that support it. */
export function renderTimelineMermaid(timeline: Timeline): string {
  const lines = ['timeline', `    title ${timeline.subject.replace(/[\n\r]/g, ' ').slice(0, 80) || 'Thread'}`];
  for (const event of timeline.events) {
    const label = `${event.direction === 'in' ? 'from' : 'to'} ${event.from ?? 'unknown'}${
      event.attachments.length ? ` (${event.attachments.length} attached)` : ''
    }`;
    // Mermaid treats `:` as a separator, so it cannot appear in either half.
    lines.push(`    ${shortDate(event.at).replace(/:/g, '.')} : ${label.replace(/:/g, ' ')}`);
  }
  return lines.join('\n');
}
