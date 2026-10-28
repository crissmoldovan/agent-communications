// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { type JoinedMessage, join } from '../messages/join.ts';
import { readActivityItems, readMessageShow, readMessagesPage } from '../messages/read.ts';
import {
  cardSteps,
  type Part,
  type StoryContext,
  statusLabel,
  storySummary,
  timeline,
  unknownSender,
  whereWords,
  windowsOf,
} from '../messages/story.ts';
import activityItems from './fixtures/activity-items.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';

/*
 * A message in words (spec 2026-10-26-owner-feedback-0320 §3.6, prototype row 4): the card's line of steps, the story's
 * timeline, the agent windows that touched it, and its one-line summary. Pure, over the join's fixtures; times are
 * written as UTC hours and minutes so the words are the same on every machine.
 */

const page = readMessagesPage(messagesList);
const activity = readActivityItems(activityItems);
if (page === null || activity === null) throw new Error('the fixtures are answers');
const aliases = new Map([
  ['in_01EXAMPLE0000000000000000', 'example/gmail'],
  ['acc_01EXAMPLE000000000000001', 'example/slack'],
]);
const joined = join(page.messages, activity, { aliases });

const CONTEXT: StoryContext = {
  time: (at) => new Date(at).toISOString().slice(11, 16),
  home: '/example/home',
};

function only(key: string): JoinedMessage {
  const found = joined.find((each) => each.key.startsWith(key));
  if (found === undefined) throw new Error(`no ${key}`);
  return found;
}

/** Parts as one line, a rule author's text in ⟨⟩ so a test sees which parts are whose. */
function said(parts: readonly Part[]): string {
  return parts.map((part) => ('untrusted' in part ? `⟨${part.untrusted}⟩` : part.text)).join('');
}

describe('a card', () => {
  it('Replied: the rule, the judge, the lane, the read, the reply after your approval, and done by the agent', () => {
    expect(cardSteps(only('event:e1'), CONTEXT).map(said)).toEqual([
      'Workflow ⟨invoices⟩',
      'Jev: yes',
      'Queue, lane billing',
      'Woke the agent bound to lane billing',
      'Read 11:41',
      'Reply sent 11:45, after your approval',
      'Marked done by the agent',
    ]);
    expect(statusLabel(only('event:e1').status)).toEqual({ label: 'Replied', tone: 'ok' });
  });

  it('Acknowledged: a reaction, and no reply yet', () => {
    expect(cardSteps(only('event:e2'), CONTEXT).map(said)).toEqual([
      'Workflow ⟨david-on-slack⟩',
      'Queue, lane david',
      'Woke the agent bound to lane david',
      'Read 11:32',
      'Acknowledged with a reaction',
      'No reply yet',
    ]);
    expect(statusLabel(only('event:e2').status)).toEqual({ label: 'Acknowledged', tone: 'accent' });
  });

  it('Waiting for you: in the queue, and no agent has read it', () => {
    expect(cardSteps(only('event:e3'), CONTEXT).map(said)).toEqual([
      'Workflow ⟨family-chat⟩',
      'Queue',
      'No agent has read it',
    ]);
    expect(statusLabel(only('event:e3').status)).toEqual({ label: 'Waiting for you', tone: 'warn' });
  });

  it('Read by an agent, on its own: no rule, and where the agent read it', () => {
    expect(cardSteps(only('item:18c2f0a1b2c3e000'), CONTEXT).map(said)).toEqual([
      'No workflow',
      'Read by the agent in ~/work/personal, while searching your mail',
    ]);
    expect(statusLabel(only('item:').status)).toEqual({ label: 'Read by an agent', tone: 'neutral' });
  });

  it('Not seen: no rule matched, or a dry run, and no agent has read it', () => {
    expect(cardSteps(only('event:e4'), CONTEXT).map(said)).toEqual(['No workflow matched', 'No agent has read it']);
    expect(cardSteps(only('event:e6'), CONTEXT).map(said)).toEqual([
      'Workflow ⟨newsletter-test⟩',
      'Dry run',
      'No agent has read it',
    ]);
    expect(statusLabel(only('event:e4').status)).toEqual({ label: 'Not seen', tone: 'neutral' });
  });

  it('Replied in a Slack thread, then marked done by you', () => {
    expect(cardSteps(only('event:e5'), CONTEXT).map(said)).toEqual([
      'Workflow ⟨deploys⟩',
      'Local model: yes',
      'Queue',
      'Read by the agent in ~/work/acme',
      'Replied in the thread 08:05',
      'Marked done by you',
    ]);
  });

  it('Done and Dismissed say who; where is the channel and the account, and a Slack DM says so', () => {
    expect(statusLabel({ kind: 'done', at: 1, actor: 'window' })).toEqual({ label: 'Done by an agent', tone: 'ok' });
    expect(statusLabel({ kind: 'done', at: 1, actor: 'person' })).toEqual({ label: 'Done by you', tone: 'ok' });
    expect(statusLabel({ kind: 'done', at: 1, actor: null })).toEqual({ label: 'Done', tone: 'ok' });
    expect(statusLabel({ kind: 'dismissed', at: 1, actor: 'person' })).toEqual({
      label: 'Dismissed by you',
      tone: 'neutral',
    });
    expect(statusLabel({ kind: 'dismissed', at: 1, actor: 'window' })).toEqual({
      label: 'Dismissed by an agent',
      tone: 'neutral',
    });
    expect(whereWords(only('event:e1'))).toBe('Gmail · example/gmail');
    expect(whereWords(only('event:e2'))).toBe('Slack · example/slack · direct message');
    // With no name for the account, its id.
    expect(whereWords(only('event:e3'))).toBe('WhatsApp · wa_01EXAMPLE0000000000000001');
    expect(whereWords(only('item:'))).toBe('Gmail');
  });

  it('with nothing that kept its sender, a card says so, and where to open it', () => {
    expect(unknownSender('gmail')).toBe(
      'A Gmail message. No workflow kept its sender or subject, so open it in Gmail to see it.',
    );
    expect(unknownSender('slack')).toBe(
      'A Slack message. No workflow kept its sender or subject, so open it in Slack to see it.',
    );
  });
});

describe('a story', () => {
  // The story reads `message show`, whose history is whole.
  const shown = readMessageShow(messageShow);
  if (shown === null) throw new Error('the fixture is an answer');
  const invoice = join([shown], activity, { aliases }).find(
    (each) => each.key === 'event:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
  );
  if (invoice === undefined) throw new Error('the invoice joins');

  it('the timeline: arrived, matched, judged, queued, woke a window, read, a reply prepared, approved, sent, done', () => {
    const approvedAt = new Map([['r-2000000000000000001', Date.parse('2026-10-25T11:45:12Z')]]);
    const entries = timeline(invoice, { ...CONTEXT, approvedAt });
    expect(
      entries.map((entry) => [entry.at === null ? '' : CONTEXT.time(entry.at), said(entry.what), entry.tone]),
    ).toEqual([
      ['11:40', 'Arrived in example/gmail', 'idle'],
      ['', 'Matched the workflow ⟨invoices⟩', 'accent'],
      ['', 'Jev said yes, 0.86 sure', 'accent'],
      ['', 'Put in the Queue, lane billing', 'accent'],
      ['11:40', 'Woke the agent window bound to billing', 'accent'],
      ['11:41', 'An agent read it from the Queue', 'accent'],
      ['11:41', 'An agent read it', 'accent'],
      ['11:43', 'An agent drafted a reply', 'accent'],
      ['11:43', 'It asked to send the reply', 'warn'],
      ['11:44', 'An agent read it from the Queue', 'accent'],
      ['11:45', 'You approved the reply', 'ok'],
      ['11:45', 'The reply was sent', 'ok'],
      ['11:45', 'The agent marked it done in the Queue', 'ok'],
      ['11:46', 'An agent read its thread', 'accent'],
    ]);
    // Each says where: the event service, the judge's question as the rule's author wrote it, and the window.
    expect(said(entries[0]?.sub ?? [])).toBe('Seen by the event service');
    // The event service gives no judge's question: none is shown (one that comes is the rule author's; below).
    expect(entries[2]?.sub).toBeNull();
    expect(said(entries[3]?.sub ?? [])).toBe('For the agent bound to billing');
    expect(said(entries[4]?.sub ?? [])).toBe('~/work/acme · claude-code 2.1.0');
    expect(said(entries[6]?.sub ?? [])).toBe('~/work/acme · claude-code 2.1.0 · through Agent Comms Gmail');
  });

  it('a judge’s question, when the answer carries one, is the rule author’s words, in quotes', () => {
    const event = invoice.event;
    if (event === null) throw new Error('the invoice has its event');
    const decision = event.decisions[0];
    if (decision === undefined || decision.judge === null) throw new Error('the invoice was judged');
    const asked = {
      ...invoice,
      event: {
        ...event,
        decisions: [{ ...decision, judge: { ...decision.judge, question: 'Is this <b>urgent</b>?' } }],
      },
    };
    expect(said(timeline(asked, CONTEXT)[2]?.sub ?? [])).toBe('“⟨Is this <b>urgent</b>?⟩”');
  });

  it('a hold that ran out, or was cancelled, says so in words, never the outcome’s own word', () => {
    const event = invoice.event;
    if (event === null) throw new Error('the invoice has its event');
    const decision = event.decisions[0];
    if (decision === undefined) throw new Error('the invoice was decided');
    const ended = {
      ...invoice,
      event: {
        ...event,
        deliveries: [],
        decisions: [
          { ...decision, ruleId: 'invoices', outcome: 'hold-expired', judge: null },
          { ...decision, ruleId: 'mail-subject', outcome: 'cancelled', judge: null },
        ],
      },
    };
    expect(cardSteps(ended, CONTEXT).map(said).slice(0, 2)).toEqual([
      'Workflow ⟨invoices⟩: its judge did not answer in time',
      'Workflow ⟨mail-subject⟩: its hold was cancelled',
    ]);
    const told = timeline(ended, CONTEXT).map((entry) => said(entry.what));
    expect(told.slice(1, 3)).toEqual([
      'The judge of the workflow ⟨invoices⟩ did not answer in time',
      'The hold of the workflow ⟨mail-subject⟩ was cancelled',
    ]);
    expect(told.join('\n')).not.toMatch(/hold-expired|: cancelled/);
  });

  it('without the approval’s time, the send says it came after your approval', () => {
    const entries = timeline(invoice, CONTEXT);
    expect(entries.some((entry) => said(entry.what) === 'You approved the reply')).toBe(false);
    const sent = entries.find((entry) => said(entry.what) === 'The reply was sent');
    expect(said(sent?.sub ?? [])).toBe('After your approval, through Agent Comms Gmail');
  });

  it('a message only an agent read says the event service did not see it arrive', () => {
    const entries = timeline(only('item:'), CONTEXT);
    expect(entries.map((entry) => said(entry.what))).toEqual([
      "The event service didn't see it arrive",
      'An agent saw it while searching your mail',
    ]);
    expect(entries[0]?.at).toBeNull();
  });

  it('no rule matched, a dry run, and a Slack thread reply, each in its words', () => {
    expect(timeline(only('event:e4'), CONTEXT).map((entry) => said(entry.what))).toEqual([
      'Arrived in example/gmail',
      'No workflow matched',
    ]);
    const dry = timeline(only('event:e6'), CONTEXT);
    expect(dry.map((entry) => said(entry.what))).toEqual([
      'Arrived in example/gmail',
      'Matched the workflow ⟨newsletter-test⟩',
      'Logged as a dry run',
    ]);
    expect(said(dry[2]?.sub ?? [])).toBe('Nothing was sent anywhere');
    expect(timeline(only('event:e5'), CONTEXT).map((entry) => said(entry.what))).toEqual([
      'Arrived in example/slack',
      'Matched the workflow ⟨deploys⟩',
      'Local model said yes, 0.71, uncalibrated',
      'Put in the Queue',
      'An agent read its thread',
      'An agent replied in the thread',
      'You marked it done in the Queue',
    ]);
  });

  it('the agent windows that touched it, each with what it did', () => {
    expect(windowsOf(invoice, CONTEXT)).toEqual([
      {
        key: '3f9a1c2e7b4d5a60',
        folder: '~/work/acme',
        initial: 'C',
        line: 'claude-code 2.1.0 · bound to lane billing · was woken for it, read it 4 times, sent one reply, marked it done',
      },
    ]);
    expect(windowsOf(only('event:e3'), CONTEXT)).toEqual([]);
    expect(windowsOf(only('item:'), CONTEXT)).toEqual([
      { key: '9a8b7c6d5e4f3a20', folder: '~/work/personal', initial: 'C', line: 'codex 0.9.0 · read it once' },
    ]);
  });

  it('the summary, in one line, by how far it got', () => {
    expect(storySummary(invoice, CONTEXT)).toBe(
      "An agent replied in the same thread at 11:45, after you approved the reply. It's done in the Queue.",
    );
    expect(storySummary(only('event:e2'), CONTEXT)).toBe(
      'An agent acknowledged it with a reaction at 11:32. No reply was sent through Agent Comms.',
    );
    expect(storySummary(only('event:e3'), CONTEXT)).toBe("It's waiting in the Queue. No agent has read it.");
    expect(storySummary(only('item:'), CONTEXT)).toBe(
      'An agent read it at 10:55. No reply was sent through Agent Comms.',
    );
    expect(storySummary(only('event:e4'), CONTEXT)).toBe('No agent has read it through Agent Comms.');
    expect(storySummary(only('event:e5'), CONTEXT)).toBe(
      "An agent replied in the thread at 08:05. It's done in the Queue.",
    );
  });
});
