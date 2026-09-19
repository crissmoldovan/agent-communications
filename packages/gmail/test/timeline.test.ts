import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildTimeline,
  businessHoursBetween,
  renderTimelineMarkdown,
  renderTimelineMermaid,
} from '../src/domain/timeline.ts';
import type { ReadMessageResult } from '../src/operations/read.ts';

/** A message result with only the fields a timeline reads. */
function message(options: {
  id: string;
  at: string;
  from: string;
  to?: string[];
  cc?: string[];
  subject?: string;
  labels?: string[];
  attachments?: Array<{ filename: string; size: number; inline?: boolean; riskFlags?: string[] }>;
}): ReadMessageResult {
  return {
    inbox: 'work',
    messageId: options.id,
    threadId: 't1',
    date: options.at,
    from: { name: '', address: options.from },
    replyTo: [],
    to: (options.to ?? ['jo@example.test']).map((address) => ({ name: '', address })),
    cc: (options.cc ?? []).map((address) => ({ name: '', address })),
    subject: options.subject ?? 'Phase 2 plan',
    labels: options.labels ?? [],
    unread: false,
    auth: { evaluatedBy: null, spf: null, dkim: null, dkimDomain: null, dmarc: null, aligned: null, ignoredHeaders: 0 },
    sender: { replyToDiffers: false, replyToDomains: [], displayNameContainsOtherAddress: false, fromDomain: null },
    attachments: (options.attachments ?? []).map((attachment, index) => ({
      partId: String(index),
      attachmentId: `att-${index}`,
      filename: attachment.filename,
      mimeType: 'application/pdf',
      size: attachment.size,
      inline: attachment.inline ?? false,
      riskFlags: attachment.riskFlags ?? [],
    })),
    sanitisation: {
      hiddenElements: 0,
      hiddenChars: 0,
      unreadableHidingRules: 0,
      sameColorElements: 0,
      invisibleCharsRemoved: 0,
      links: [],
      imagesNotLoaded: 0,
      plainHtmlMismatch: undefined,
      charsetOverridden: false,
    },
    body: {
      enveloped: '',
      source: 'html',
      truncated: false,
      nextOffset: undefined,
      totalChars: 0,
      quotedLinesOmitted: 0,
    },
    webLink: '',
  };
}

const OWN = ['jo@example.test'];

test('every turn is measured: direction, who was added, and how long each reply took', () => {
  const timeline = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: '2026-09-15T09:00:00.000Z', from: 'sam@partner.test' }),
        message({
          id: 'm2',
          at: '2026-09-15T15:00:00.000Z',
          from: 'jo@example.test',
          to: ['sam@partner.test'],
          cc: ['ana@partner.test'],
          attachments: [{ filename: 'plan.pdf', size: 412_000 }],
        }),
        message({
          id: 'm3',
          at: '2026-09-17T09:00:00.000Z',
          from: 'sam@partner.test',
          to: ['jo@example.test'],
          subject: 'Re: Phase 2 plan — revised',
        }),
      ],
    },
    { ownAddresses: OWN },
  );

  assert.deepEqual(
    timeline.events.map((event) => event.direction),
    ['in', 'out', 'in'],
  );
  assert.equal(timeline.events[0]?.gapHours, null, 'the first message waited for nothing');
  assert.equal(timeline.events[1]?.gapHours, 6);
  assert.equal(timeline.events[2]?.gapHours, 42);
  assert.equal(timeline.longestWaitHours, 42);

  assert.deepEqual(timeline.events[1]?.participantsAdded, ['ana@partner.test']);
  assert.deepEqual(timeline.events[2]?.participantsDropped, ['ana@partner.test']);
  assert.deepEqual(timeline.events[1]?.attachments, [{ filename: 'plan.pdf', size: 412_000, riskFlags: [] }]);
  assert.equal(timeline.events[2]?.subjectChanged, true);

  // The last message came in, so the reply is owed by us.
  assert.equal(timeline.waitingOn.party, 'us');
  assert.equal(timeline.waitingOn.since, '2026-09-17T09:00:00.000Z');
});

test('a draft changes nothing: nobody is waiting because of a message that was never sent', () => {
  const timeline = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: '2026-09-15T09:00:00.000Z', from: 'sam@partner.test' }),
        message({ id: 'm2', at: '2026-09-16T09:00:00.000Z', from: 'jo@example.test', labels: ['DRAFT'] }),
      ],
    },
    { ownAddresses: OWN },
  );
  assert.equal(timeline.events[1]?.isDraft, true);
  assert.equal(timeline.waitingOn.party, 'us', 'the unsent draft does not discharge the reply we owe');
  assert.equal(timeline.lastAt, '2026-09-15T09:00:00.000Z');
});

test('direction follows the account, not the sender’s claim about itself', () => {
  const timeline = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        // Sent from an alias of this mailbox.
        message({ id: 'm1', at: '2026-09-15T09:00:00.000Z', from: 'jo.alias@example.test', labels: ['SENT'] }),
        // A stranger spoofing our address in From: still arrives as inbound, because it is not in SENT.
        message({ id: 'm2', at: '2026-09-15T10:00:00.000Z', from: 'someone@evil.test' }),
      ],
    },
    { ownAddresses: [...OWN, 'jo.alias@example.test'] },
  );
  assert.deepEqual(
    timeline.events.map((event) => event.direction),
    ['out', 'in'],
  );
});

test('a new sender partway through the thread reads as forwarded in', () => {
  const timeline = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: '2026-09-15T09:00:00.000Z', from: 'sam@partner.test' }),
        message({ id: 'm2', at: '2026-09-15T12:00:00.000Z', from: 'new@third.test', subject: 'Fwd: Phase 2 plan' }),
      ],
    },
    { ownAddresses: OWN },
  );
  assert.equal(timeline.events[0]?.forwardedIn, false);
  assert.equal(timeline.events[1]?.forwardedIn, true);
});

test('business hours skip the weekend, so a Friday-to-Monday reply is not a four-day delay', () => {
  // Friday 16:00 to Monday 10:00 UTC.
  const friday = new Date('2026-09-18T16:00:00Z');
  const monday = new Date('2026-09-21T10:00:00Z');
  assert.equal(friday.getUTCDay(), 5);
  assert.equal(monday.getUTCDay(), 1);
  assert.equal(businessHoursBetween(friday, monday), 2, 'one hour on Friday, one on Monday');

  const wall = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: friday.toISOString(), from: 'sam@partner.test' }),
        message({ id: 'm2', at: monday.toISOString(), from: 'jo@example.test' }),
      ],
    },
    { ownAddresses: OWN },
  );
  assert.equal(wall.events[1]?.gapHours, 66);

  const business = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: friday.toISOString(), from: 'sam@partner.test' }),
        message({ id: 'm2', at: monday.toISOString(), from: 'jo@example.test' }),
      ],
    },
    { ownAddresses: OWN, businessHours: true },
  );
  assert.equal(business.events[1]?.gapHours, 2);
});

test('the renderings state the same facts, and cannot be broken by a subject', () => {
  const timeline = buildTimeline(
    {
      threadId: 't1',
      inbox: 'work',
      messages: [
        message({ id: 'm1', at: '2026-09-15T09:00:00.000Z', from: 'sam@partner.test', subject: 'Plan: phase 2\nX' }),
        message({
          id: 'm2',
          at: '2026-09-15T15:00:00.000Z',
          from: 'jo@example.test',
          attachments: [{ filename: 'plan.pdf', size: 1 }],
        }),
      ],
    },
    { ownAddresses: OWN },
  );

  const markdown = renderTimelineMarkdown(timeline);
  assert.match(markdown, /\| 1 \| 2026-09-15 09:00 \| received \| sam@partner\.test \| — \|/);
  assert.match(markdown, /plan\.pdf/);
  assert.match(markdown, /Waiting on: them/);

  const mermaid = renderTimelineMermaid(timeline);
  assert.match(mermaid, /^timeline\n {4}title Plan/);
  // A subject with a newline or a colon would otherwise break the diagram.
  assert.equal(mermaid.split('\n').length, 4);
  for (const line of mermaid.split('\n').slice(2)) assert.equal(line.split(':').length, 2);
});

test('an empty thread is a timeline with nothing in it, not a crash', () => {
  const timeline = buildTimeline({ threadId: 't1', inbox: 'work', messages: [] }, { ownAddresses: OWN });
  assert.equal(timeline.messageCount, 0);
  assert.equal(timeline.waitingOn.party, 'nobody');
  assert.equal(timeline.longestWaitHours, null);
  assert.match(renderTimelineMarkdown(timeline), /0 messages/);
});
