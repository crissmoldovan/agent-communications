// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  accountChoices,
  filterMessages,
  type JoinedMessage,
  join,
  STATUS_ORDER,
  showCounts,
  statusOf,
} from '../messages/join.ts';
import {
  type ActivityItems,
  cursorMillis,
  type HistoryLine,
  type ItemLine,
  type MessageEvent,
  readActivityItems,
  readMessageShow,
  readMessagesPage,
} from '../messages/read.ts';
import activityItems from './fixtures/activity-items.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';

/*
 * The Messages screen's join (spec 2026-10-26-owner-feedback-0320 §3.6, "the app joins them"): the event service's
 * `messages list` and core's `activity items`, for the same window, joined on the Gmail message id or the Slack
 * `<channelId>/<ts>`, and each message's status the furthest step it reached. Everything here is pure, over fixtures
 * written to the spec's shapes and lines built by hand; nothing is run.
 */

const at = (iso: string) => Date.parse(iso);

const W1 = {
  key: '3f9a1c2e7b4d5a60',
  folder: '/example/home/work/acme',
  client: { name: 'claude-code', version: '2.1.0' },
};
const W2 = { key: '7c1d2e3f4a5b6c70', folder: null, client: null };

/** An event, as `messages list` gives one, with only what a test says. */
function event(over: Partial<MessageEvent> & { eventId: string }): MessageEvent {
  return {
    openable: true,
    type: 'gmail.message.received',
    channel: 'gmail',
    accountId: 'in_01EXAMPLE0000000000000000',
    accountAlias: null,
    occurredAt: at('2026-10-25T10:00:00Z'),
    observedAt: at('2026-10-25T10:00:01Z'),
    source: { messageId: 'm1', channelId: null, ts: null },
    sourceId: 'm1',
    decisions: [],
    deliveries: [],
    queueItem: null,
    kept: null,
    ...over,
  };
}

const SLACK_MESSAGE = {
  channel: 'slack',
  type: 'slack.message.received',
  source: { messageId: null, channelId: 'C0EXAMPLE2', ts: '1792915200.000200' },
  sourceId: 'C0EXAMPLE2/1792915200.000200',
} as const;

/** An activity line, as `activity items` gives one, with only what a test says. */
function line(itemId: string, operation: string, when: string, over: Partial<ItemLine> = {}): ItemLine {
  return {
    itemId,
    session: W1,
    operation,
    channel: operation.split('.')[0] ?? '',
    at: at(when),
    outcome: 'ok',
    kind: null,
    subject: null,
    from: null,
    replyTo: null,
    thread: null,
    draftId: null,
    threadId: null,
    channelId: null,
    act: null,
    account: null,
    ...over,
  };
}

/** Lines, grouped under their items' ids, as `activity items` groups them. */
function items(...lines: ItemLine[]): ActivityItems {
  const map = new Map<string, ItemLine[]>();
  for (const each of lines) map.set(each.itemId, [...(map.get(each.itemId) ?? []), each]);
  return map;
}

function only(messages: JoinedMessage[], key: string): JoinedMessage {
  const found = messages.find((each) => each.key === key);
  if (found === undefined) throw new Error(`no ${key} in ${messages.map((each) => each.key).join(', ')}`);
  return found;
}

const OPEN_ITEM = {
  itemId: 'qi_01J9Z8QF0000000000000000AB',
  state: 'open',
  stateAt: null,
  lane: null,
  history: [],
} as const;

describe('reading the three answers', () => {
  it('messages list: each event with its source id, decisions, deliveries, queue item and kept sender', () => {
    const page = readMessagesPage(messagesList);
    expect(page).not.toBeNull();
    if (page === null) return;
    expect(page.messages.map((each) => each.eventId)).toEqual([
      'e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1',
      'e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2',
      'e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3',
      'e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4',
      'e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5',
      'e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6',
    ]);
    const [gmail, slack, whatsapp] = page.messages;
    expect(gmail?.sourceId).toBe('18c2f0a1b2c3d4e5');
    expect(slack?.sourceId).toBe('D0EXAMPLE1/1792927860.000100');
    // WhatsApp's events name no message the activity log does.
    expect(whatsapp?.sourceId).toBeNull();
    expect(gmail?.decisions).toEqual([
      {
        ruleId: 'invoices',
        ruleVersion: 1,
        outcome: 'matched',
        judge: {
          id: null,
          kind: 'typesafe',
          answer: 'yes',
          confidence: 0.86,
          question: null,
          uncalibrated: false,
        },
        at: null,
      },
    ]);
    // A judge's number that is no probability says so: `calibrated: false`.
    expect(page.messages[4]?.decisions[0]?.judge).toMatchObject({ kind: 'local-endpoint', uncalibrated: true });
    expect(gmail?.deliveries[0]).toMatchObject({ targetKind: 'queue', lane: 'billing', state: 'delivered' });
    expect(gmail?.queueItem?.history.map((each) => each.kind)).toEqual(['woken', 'read', 'done']);
    expect(gmail?.queueItem?.history[0]?.windowKey).toBe('3f9a1c2e7b4d5a60');
    // The kept sender and subject stay inside their envelopes: the screen marks them From outside.
    expect(gmail?.kept?.subject).toContain('<untrusted-content boundary="m5gT2kQa" field="subject">');
    expect(gmail?.kept?.name).toContain('David Example');
    expect(page.before).toBeNull();
    expect(page.more).toBe(false);
  });

  it('messages list: the cursor is passed on as it came, or a time; one the app cannot page by still says there are more', () => {
    const base = { messages: [] };
    // The event service's own: `<observedAt ms>:<eventId>`.
    const cursor = '1792900000000:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
    expect(readMessagesPage({ ...base, next: cursor })).toEqual({ messages: [], before: cursor, more: true });
    expect(cursorMillis(cursor)).toBe(1792900000000);
    expect(cursorMillis(1792900000000)).toBe(1792900000000);
    expect(readMessagesPage({ ...base, next: 1792900000000 })).toEqual({
      messages: [],
      before: 1792900000000,
      more: true,
    });
    expect(readMessagesPage({ ...base, next: '1792900000000' })).toEqual({
      messages: [],
      before: 1792900000000,
      more: true,
    });
    expect(readMessagesPage({ ...base, next: 'opaque-cursor' })).toEqual({ messages: [], before: null, more: true });
    expect(readMessagesPage({ ...base, next: null })).toEqual({ messages: [], before: null, more: false });
    for (const wrong of [null, [], 'messages', { items: [] }, { messages: {} }])
      expect(readMessagesPage(wrong)).toBeNull();
  });

  it('messages list: an entry with no id is left out, and an id message show does not take cannot be opened', () => {
    const page = readMessagesPage({
      messages: [{ channel: 'gmail' }, { eventId: 'not-hex', channel: 'gmail', source: { messageId: 'm1' } }],
      next: null,
    });
    expect(page?.messages.map((each) => [each.eventId, each.openable])).toEqual([['not-hex', false]]);
  });

  it('message show: `{ message }`, as the event service answers, or the entry itself', () => {
    expect(readMessageShow(messageShow)?.queueItem?.history).toHaveLength(4);
    expect(readMessageShow(messageShow.message)?.eventId).toBe('e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1');
    expect(readMessageShow({ messages: [] })).toBeNull();
  });

  it('activity items: each line under its item, oldest first, with its window and the ids that link a reply', () => {
    const read = readActivityItems(activityItems);
    expect(read).not.toBeNull();
    if (read === null) return;
    expect([...read.keys()].sort()).toEqual([
      '18c2f0a1b2c3d4e5',
      '18c2f0a1b2c3d4f0',
      '18c2f0a1b2c3e000',
      'C0EXAMPLE2/1792915200.000200',
      'C0EXAMPLE2/1792915500.000300',
      'D0EXAMPLE1/1792927860.000100',
      'r-2000000000000000001',
    ]);
    const draft = read.get('r-2000000000000000001')?.[0];
    expect(draft).toMatchObject({
      operation: 'gmail.draft.reply',
      channel: 'gmail',
      at: at('2026-10-25T11:43:30Z'),
      replyTo: { messageId: '18c2f0a1b2c3d4e5', threadId: '18c2f0a1b2c3d4e5' },
      draftId: 'r-2000000000000000001',
      session: { key: '3f9a1c2e7b4d5a60', folder: '/example/home/work/acme' },
    });
    // An acknowledgement says what it did: a reply or a reaction; a word that is neither is none.
    expect(read.get('D0EXAMPLE1/1792927860.000100')?.[1]).toMatchObject({ operation: 'slack.ack', act: 'reaction' });
    const odd = readActivityItems({
      items: { m1: [{ session: W1, operation: 'slack.ack', at: '2026-10-25T10:00:00.000Z', act: 'delete' }] },
    });
    expect(odd?.get('m1')?.[0]?.act).toBeNull();
    // A post names the thread it went into as the message it is: `<channelId>/<ts>`.
    expect(read.get('C0EXAMPLE2/1792915500.000300')?.[0]).toMatchObject({ thread: 'C0EXAMPLE2/1792915200.000200' });
    // A line is listed under every item it names: the reply draft under the message it answers, too.
    expect(read.get('18c2f0a1b2c3d4e5')?.map((line) => line.operation)).toEqual([
      'gmail.message.read',
      'gmail.draft.reply',
      'gmail.send.prepare',
      'gmail.thread.read',
    ]);
  });

  it('activity items: a line with no window key core makes, or no time, is left out', () => {
    const read = readActivityItems({
      items: {
        m1: [
          { session: { key: 'not-a-key' }, operation: 'gmail.message.read', at: '2026-10-25T10:00:00.000Z' },
          { session: W1, operation: 'gmail.message.read', at: 'yesterday' },
          { session: W1, operation: 'gmail.message.read', at: '2026-10-25T10:00:00.000Z' },
        ],
        m2: [{ session: W1, at: '2026-10-25T10:00:00.000Z' }],
      },
    });
    expect(read?.get('m1')).toHaveLength(1);
    expect(read?.has('m2')).toBe(false);
    for (const wrong of [null, [], { items: [] }, { lines: [] }]) expect(readActivityItems(wrong)).toBeNull();
  });
});

describe('the join, over the fixtures', () => {
  const page = readMessagesPage(messagesList);
  const activity = readActivityItems(activityItems);
  if (page === null || activity === null) throw new Error('the fixtures are answers');
  const joined = join(page.messages, activity);

  it('every event, and the one message only an agent read, newest first; never an agent’s own draft, send or post', () => {
    expect(joined.map((each) => [each.key, each.status.kind])).toEqual([
      ['event:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1', 'replied'],
      ['event:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2', 'acknowledged'],
      ['item:18c2f0a1b2c3e000', 'read'],
      ['event:e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4', 'not-seen'],
      ['event:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5', 'replied'],
      ['event:e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6e6', 'not-seen'],
      ['event:e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3', 'waiting'],
    ]);
  });

  it('a Gmail reply joins through its draft: the reply draft names the message, and the send names the draft', () => {
    const invoice = only(joined, 'event:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1');
    expect(invoice.status).toEqual({ kind: 'replied', at: at('2026-10-25T11:45:13Z'), via: 'gmail' });
    expect(invoice.touches.map((each) => [each.kind, new Date(each.at).toISOString()])).toEqual([
      ['woken', '2026-10-25T11:40:05.000Z'],
      ['read', '2026-10-25T11:41:00.000Z'],
      ['read', '2026-10-25T11:41:10.000Z'],
      ['drafted', '2026-10-25T11:43:30.000Z'],
      ['prepared', '2026-10-25T11:43:40.000Z'],
      ['sent', '2026-10-25T11:45:13.000Z'],
      ['done', '2026-10-25T11:45:20.000Z'],
      ['read', '2026-10-25T11:46:00.000Z'],
    ]);
    // The queue's lines name the window by its key; the activity's window is the same one, with its folder.
    expect(invoice.touches[0]?.window?.folder).toBe('/example/home/work/acme');
    expect(invoice.agentSeen).toBe(true);
    expect(invoice.accountId).toBe('in_01EXAMPLE0000000000000000');
    expect(invoice.sender?.subject).toContain('Can you send the March invoice?');
  });

  it('a Slack reply joins by its thread: a post whose thread is the message’s ts, in its conversation', () => {
    const deploy = only(joined, 'event:e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5e5');
    expect(deploy.status).toEqual({ kind: 'replied', at: at('2026-10-25T08:05:00Z'), via: 'slack-thread' });
  });

  it('an acknowledgement by reaction is Acknowledged, above the open item an agent read', () => {
    const david = only(joined, 'event:e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2e2');
    expect(david.status).toEqual({ kind: 'acknowledged', at: at('2026-10-25T11:32:40Z') });
    expect(david.touches.find((each) => each.kind === 'acknowledged')?.replied).toBe(false);
  });

  it('a message only an agent read, with no event, is there: its sender from the line, its time the read’s', () => {
    const receipt = only(joined, 'item:18c2f0a1b2c3e000');
    expect(receipt.event).toBeNull();
    expect(receipt.channel).toBe('gmail');
    expect(receipt.at).toBe(at('2026-10-25T10:55:00Z'));
    expect(receipt.sender?.subject).toContain('Your receipt #1042');
    expect(receipt.sender?.name).toContain('Receipts');
    expect(receipt.status).toEqual({ kind: 'read', at: at('2026-10-25T10:55:00Z') });
    expect(receipt.touches[0]?.operation).toBe('gmail.search');
  });

  it('an event no activity names takes its status from the queue alone', () => {
    const mum = only(joined, 'event:e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3e3');
    expect(mum.status).toEqual({ kind: 'waiting' });
    expect(mum.touches).toEqual([]);
    expect(mum.agentSeen).toBe(false);
    expect(only(joined, 'event:e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4e4').status).toEqual({ kind: 'not-seen' });
  });

  it('the filters: waiting for you, handled by an agent, no agent has seen; and the account picker', () => {
    const keys = (list: JoinedMessage[]) => list.map((each) => each.key.slice(0, 8));
    expect(keys(filterMessages(joined, { show: 'waiting', account: null }))).toEqual(['event:e3']);
    expect(keys(filterMessages(joined, { show: 'handled', account: null }))).toEqual([
      'event:e1',
      'event:e2',
      'item:18c',
      'event:e5',
    ]);
    expect(keys(filterMessages(joined, { show: 'unseen', account: null }))).toEqual([
      'event:e4',
      'event:e6',
      'event:e3',
    ]);
    expect(showCounts(joined, null)).toEqual({ all: 7, waiting: 1, handled: 4, unseen: 3 });
    const aliases = new Map([
      ['in_01EXAMPLE0000000000000000', 'example/gmail'],
      ['acc_01EXAMPLE000000000000001', 'example/slack'],
    ]);
    const named = join(page.messages, activity, { aliases });
    expect(accountChoices(named)).toEqual(['example/gmail', 'example/slack', 'wa_01EXAMPLE0000000000000001']);
    expect(keys(filterMessages(named, { show: 'all', account: 'example/gmail' }))).toEqual([
      'event:e1',
      'event:e4',
      'event:e6',
    ]);
    expect(showCounts(named, 'example/slack')).toEqual({ all: 2, waiting: 0, handled: 2, unseen: 0 });
  });
});

describe('the status order', () => {
  it('is Replied, Acknowledged, Done or Dismissed, Read by an agent, Waiting for you, Not seen', () => {
    expect(STATUS_ORDER).toEqual(['replied', 'acknowledged', 'done', 'dismissed', 'read', 'waiting', 'not-seen']);
  });

  it('Replied: a Gmail send whose draft answers the message; a draft alone, a failed send or another message’s is not', () => {
    const answers = { messageId: 'm1', threadId: 't1' };
    const drafted = line('r-1', 'gmail.draft.reply', '2026-10-25T10:05:00Z', { replyTo: answers, draftId: 'r-1' });
    const sent = line('s-1', 'gmail.send.execute', '2026-10-25T10:06:00Z', { draftId: 'r-1', threadId: 't1' });
    const read = line('m1', 'gmail.message.read', '2026-10-25T10:01:00Z');
    expect(join([event({ eventId: 'a' })], items(read, drafted, sent))[0]?.status).toEqual({
      kind: 'replied',
      at: at('2026-10-25T10:06:00Z'),
      via: 'gmail',
    });
    // The draft's id is its item's when its line does not repeat it.
    const bare = { ...drafted, draftId: null };
    expect(join([event({ eventId: 'a' })], items(read, bare, sent))[0]?.status.kind).toBe('replied');
    // A send prepared as a reply names the message too.
    const prepared = line('r-1', 'gmail.send.prepare', '2026-10-25T10:05:30Z', { replyTo: answers, draftId: 'r-1' });
    expect(join([event({ eventId: 'a' })], items(prepared, sent))[0]?.status.kind).toBe('replied');
    // Drafted, not sent: the reply waits, and the message is as far as its read.
    const waiting = join([event({ eventId: 'a' })], items(read, drafted))[0];
    expect(waiting?.status.kind).toBe('read');
    expect(waiting?.touches.map((each) => each.kind)).toEqual(['read', 'drafted']);
    // A send that failed sent nothing; the reply drafted to it is as far as reading it, with no read line of its own.
    expect(join([event({ eventId: 'a' })], items(drafted, { ...sent, outcome: 'failed' }))[0]?.status).toEqual({
      kind: 'read',
      at: at('2026-10-25T10:05:00Z'),
    });
    // A reply to another message is that message's.
    const other = { ...drafted, replyTo: { messageId: 'm2', threadId: 't1' } };
    expect(join([event({ eventId: 'a' })], items(read, other, sent))[0]?.status.kind).toBe('read');
  });

  it('Replied: a Slack post in the message’s thread, in its conversation; one in another conversation is not', () => {
    const post = line('C0EXAMPLE2/1792915300.000300', 'slack.post.send', '2026-10-25T08:02:00Z', {
      thread: '1792915200.000200',
      channelId: 'C0EXAMPLE2',
    });
    const slack = event({ eventId: 'b', ...SLACK_MESSAGE });
    expect(join([slack], items(post))[0]?.status).toEqual({
      kind: 'replied',
      at: at('2026-10-25T08:02:00Z'),
      via: 'slack-thread',
    });
    // The conversation is the post's item's when the line does not name it.
    expect(join([slack], items({ ...post, channelId: null }))[0]?.status.kind).toBe('replied');
    const elsewhere = { ...post, itemId: 'C0OTHER000/1792915300.000300', channelId: 'C0OTHER000' };
    expect(join([slack], items(elsewhere))[0]?.status.kind).toBe('not-seen');
    expect(join([slack], items({ ...post, thread: null }))[0]?.status.kind).toBe('not-seen');
  });

  it('Replied: a Slack acknowledgement that replied — its line under the message and its reply — and never the reply as a message', () => {
    const ack = line('C0EXAMPLE2/1792915200.000200', 'slack.ack', '2026-10-25T08:01:00Z');
    const reply = { ...ack, itemId: 'C0EXAMPLE2/1792915260.000400' };
    // A later read of the thread names the reply too: it is still the agent's own, not a message that came in.
    const later = line('C0EXAMPLE2/1792915260.000400', 'slack.thread', '2026-10-25T08:10:00Z');
    const joined = join([event({ eventId: 'b', ...SLACK_MESSAGE })], items(ack, reply, later));
    expect(joined.map((each) => each.key)).toEqual(['event:b']);
    expect(joined[0]?.status).toEqual({ kind: 'replied', at: at('2026-10-25T08:01:00Z'), via: 'slack-ack' });
    expect(joined[0]?.touches.find((each) => each.kind === 'acknowledged')?.replied).toBe(true);
    // A line that says what it did is taken at its word.
    expect(join([event({ eventId: 'b', ...SLACK_MESSAGE })], items({ ...ack, act: 'reply' }))[0]?.status.kind).toBe(
      'replied',
    );
  });

  it('an acknowledgement’s `act` says reply or reaction; where it is listed says only which message it acknowledged', () => {
    const slack = event({ eventId: 'b', ...SLACK_MESSAGE });
    const ack = line('C0EXAMPLE2/1792915200.000200', 'slack.ack', '2026-10-25T08:01:00Z');
    const reply = 'C0EXAMPLE2/1792915260.000400';
    // `act: 'reply'`, listed under the message and its reply: the earlier one is the message, and it was replied to.
    const replied = join([slack], items({ ...ack, act: 'reply' }, { ...ack, act: 'reply', itemId: reply }));
    expect(replied.map((each) => [each.key, each.status.kind])).toEqual([['event:b', 'replied']]);
    // `act: 'reaction'` is a reaction, however the line is listed: the word wins over the listing.
    const reacted = join([slack], items({ ...ack, act: 'reaction' }, { ...ack, act: 'reaction', itemId: reply }));
    expect(reacted[0]?.status).toEqual({ kind: 'acknowledged', at: at('2026-10-25T08:01:00Z') });
    // The reply, were the event service to see it come in, is not itself acknowledged: the line acknowledged the other.
    const echoed = event({
      eventId: 'c',
      ...SLACK_MESSAGE,
      source: { messageId: null, channelId: 'C0EXAMPLE2', ts: '1792915260.000400' },
      sourceId: reply,
      occurredAt: at('2026-10-25T08:01:01Z'),
    });
    const both = join([slack, echoed], items({ ...ack, act: 'reply' }, { ...ack, act: 'reply', itemId: reply }));
    expect(both.map((each) => [each.key, each.status.kind])).toEqual([
      ['event:b', 'replied'],
      ['event:c', 'not-seen'],
    ]);
    // An older line, with no `act`, is read as before: listed under two messages, it replied; under one, it reacted.
    expect(join([slack], items(ack, { ...ack, itemId: reply }))[0]?.status.kind).toBe('replied');
    expect(join([slack], items(ack))[0]?.status.kind).toBe('acknowledged');
  });

  it('a line listed under each item it names counts once: the reply draft, its prepare, its send and a thread post', () => {
    const answers = { messageId: 'm1', threadId: 't1' };
    const drafted = line('r-1', 'gmail.draft.reply', '2026-10-25T10:05:00Z', { replyTo: answers, draftId: 'r-1' });
    const prepared = line('r-1', 'gmail.send.prepare', '2026-10-25T10:05:30Z', { replyTo: answers, draftId: 'r-1' });
    const sent = line('s-1', 'gmail.send.execute', '2026-10-25T10:06:00Z', { draftId: 'r-1' });
    // As core lists them: under the draft, under the message they answer, and the send under its draft too.
    const listed = items(drafted, prepared, { ...drafted, itemId: 'm1' }, { ...prepared, itemId: 'm1' }, sent, {
      ...sent,
      itemId: 'r-1',
    });
    const joined = join([event({ eventId: 'a' })], listed)[0];
    expect(joined?.touches.map((each) => each.kind)).toEqual(['drafted', 'prepared', 'sent']);
    expect(joined?.status.kind).toBe('replied');
    // A message only an agent read and replied to is still a message that came in, and replied.
    const read = line('m1', 'gmail.message.read', '2026-10-25T10:01:00Z');
    const alone = join([], items(read, ...[...listed.values()].flat()));
    expect(alone.map((each) => [each.key, each.status.kind])).toEqual([['item:m1', 'replied']]);
    // Slack: a post names its thread as the message it is, and is listed under it too.
    const post = line('C0EXAMPLE2/1792915300.000300', 'slack.post.send', '2026-10-25T08:02:00Z', {
      thread: 'C0EXAMPLE2/1792915200.000200',
    });
    const thread = line('C0EXAMPLE2/1792915200.000200', 'slack.thread', '2026-10-25T08:01:00Z');
    const slack = join(
      [event({ eventId: 'b', ...SLACK_MESSAGE })],
      items(thread, post, { ...post, itemId: 'C0EXAMPLE2/1792915200.000200' }),
    );
    expect(slack.map((each) => each.key)).toEqual(['event:b']);
    expect(slack[0]?.touches.map((each) => each.kind)).toEqual(['read', 'sent']);
    expect(slack[0]?.status).toEqual({ kind: 'replied', at: at('2026-10-25T08:02:00Z'), via: 'slack-thread' });
  });

  it('Acknowledged: a Slack acknowledgement by reaction', () => {
    const ack = line('C0EXAMPLE2/1792915200.000200', 'slack.ack', '2026-10-25T08:01:00Z');
    const slack = event({ eventId: 'b', ...SLACK_MESSAGE });
    expect(join([slack], items(ack))[0]?.status).toEqual({ kind: 'acknowledged', at: at('2026-10-25T08:01:00Z') });
    expect(join([slack], items({ ...ack, act: 'reaction' }))[0]?.status.kind).toBe('acknowledged');
    // One that failed acknowledged nothing.
    expect(join([slack], items({ ...ack, outcome: 'failed' }))[0]?.status.kind).toBe('not-seen');
  });

  it('Done or Dismissed, with who: the window or the person, from the queue’s history; with no history, no one', () => {
    const done = (history: HistoryLine[]) =>
      event({
        eventId: 'c',
        queueItem: {
          itemId: OPEN_ITEM.itemId,
          state: 'done',
          stateAt: at('2026-10-25T10:30:00Z'),
          lane: null,
          history,
        },
      });
    expect(
      join([done([{ at: at('2026-10-25T10:30:00Z'), kind: 'done', actor: 'window', windowKey: W1.key }])], items())[0]
        ?.status,
    ).toEqual({
      kind: 'done',
      at: at('2026-10-25T10:30:00Z'),
      actor: 'window',
    });
    expect(
      join([done([{ at: at('2026-10-25T10:30:00Z'), kind: 'done', actor: 'person', windowKey: null }])], items())[0]
        ?.status,
    ).toEqual({
      kind: 'done',
      at: at('2026-10-25T10:30:00Z'),
      actor: 'person',
    });
    expect(join([done([])], items())[0]?.status).toEqual({ kind: 'done', at: at('2026-10-25T10:30:00Z'), actor: null });
    const dismissed = event({
      eventId: 'd',
      queueItem: {
        itemId: OPEN_ITEM.itemId,
        state: 'dismissed',
        stateAt: at('2026-10-25T10:40:00Z'),
        lane: null,
        history: [{ at: at('2026-10-25T10:40:00Z'), kind: 'dismissed', actor: 'person', windowKey: null }],
      },
    });
    expect(join([dismissed], items())[0]?.status).toEqual({
      kind: 'dismissed',
      at: at('2026-10-25T10:40:00Z'),
      actor: 'person',
    });
    // Done by the person, with no agent: no agent has seen it.
    expect(join([dismissed], items())[0]?.agentSeen).toBe(false);
  });

  it('each step outranks the ones after it, whatever came first', () => {
    const read = line('m1', 'gmail.message.read', '2026-10-25T10:01:00Z');
    const doneByYou = {
      itemId: OPEN_ITEM.itemId,
      state: 'done' as const,
      stateAt: at('2026-10-25T10:00:30Z'),
      lane: null,
      history: [{ at: at('2026-10-25T10:00:30Z'), kind: 'done' as const, actor: 'person' as const, windowKey: null }],
    };
    // Done outranks read, even when the read came later.
    expect(join([event({ eventId: 'a', queueItem: doneByYou })], items(read))[0]?.status.kind).toBe('done');
    // Read outranks waiting.
    expect(join([event({ eventId: 'a', queueItem: { ...OPEN_ITEM, history: [] } })], items(read))[0]?.status.kind).toBe(
      'read',
    );
    // Replied and acknowledged outrank done.
    const drafted = line('r-1', 'gmail.draft.reply', '2026-10-25T10:05:00Z', {
      replyTo: { messageId: 'm1', threadId: null },
      draftId: 'r-1',
    });
    const sent = line('s-1', 'gmail.send.execute', '2026-10-25T10:06:00Z', { draftId: 'r-1' });
    expect(join([event({ eventId: 'a', queueItem: doneByYou })], items(drafted, sent))[0]?.status.kind).toBe('replied');
    const ack = line('C0EXAMPLE2/1792915200.000200', 'slack.ack', '2026-10-25T08:01:00Z');
    expect(join([event({ eventId: 'b', ...SLACK_MESSAGE, queueItem: doneByYou })], items(ack))[0]?.status.kind).toBe(
      'acknowledged',
    );
    expect(statusOf([], null)).toEqual({ kind: 'not-seen' });
  });

  it('Read by an agent: through Agent Comms, or from its lane; a refused or failed read is none', () => {
    expect(
      join([event({ eventId: 'a' })], items(line('m1', 'gmail.thread.read', '2026-10-25T10:01:00Z')))[0]?.status,
    ).toEqual({
      kind: 'read',
      at: at('2026-10-25T10:01:00Z'),
    });
    for (const outcome of ['refused', 'failed']) {
      expect(
        join([event({ eventId: 'a' })], items(line('m1', 'gmail.message.read', '2026-10-25T10:01:00Z', { outcome })))[0]
          ?.status.kind,
      ).toBe('not-seen');
    }
    const fromLane = event({
      eventId: 'a',
      queueItem: {
        ...OPEN_ITEM,
        history: [{ at: at('2026-10-25T10:02:00Z'), kind: 'read', actor: 'window', windowKey: W2.key }],
      },
    });
    const joined = join([fromLane], items())[0];
    expect(joined?.status).toEqual({ kind: 'read', at: at('2026-10-25T10:02:00Z') });
    expect(joined?.touches[0]?.windowKey).toBe(W2.key);
    expect(joined?.touches[0]?.window).toBeNull();
  });

  it('Waiting for you: an open item no agent has read — woken is not read', () => {
    const woken = event({
      eventId: 'a',
      queueItem: {
        ...OPEN_ITEM,
        history: [{ at: at('2026-10-25T10:02:00Z'), kind: 'woken', actor: 'window', windowKey: W2.key }],
      },
    });
    const joined = join([woken], items())[0];
    expect(joined?.status).toEqual({ kind: 'waiting' });
    expect(joined?.agentSeen).toBe(false);
    // Reopened after being done: open again, and waiting.
    const reopened = event({
      eventId: 'a',
      queueItem: {
        ...OPEN_ITEM,
        history: [
          { at: at('2026-10-25T10:02:00Z'), kind: 'done', actor: 'person', windowKey: null },
          { at: at('2026-10-25T10:03:00Z'), kind: 'reopened', actor: 'person', windowKey: null },
        ],
      },
    });
    expect(join([reopened], items())[0]?.status).toEqual({ kind: 'waiting' });
  });

  it('an agent-only message: from its read, its account from the line; older than the page’s last event, not yet', () => {
    const read = line('m9', 'gmail.message.read', '2026-10-25T09:00:00Z', {
      account: { id: 'in_01EXAMPLE0000000000000000', alias: 'example/gmail' },
      subject: 'Hello',
    });
    const joined = join([], items(read));
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      key: 'item:m9',
      event: null,
      sourceId: 'm9',
      channel: 'gmail',
      accountId: 'in_01EXAMPLE0000000000000000',
      accountAlias: 'example/gmail',
      status: { kind: 'read' },
      agentSeen: true,
    });
    // An item no line read — a draft, a send, a post — is never a message that came in.
    expect(join([], items(line('r-1', 'gmail.draft.create', '2026-10-25T09:00:00Z')))).toEqual([]);
    expect(join([], items(line('s-1', 'gmail.send.execute', '2026-10-25T09:00:00Z')))).toEqual([]);
    // While older events wait on another page, an agent-only message older than this page's last is held back.
    expect(join([], items(read), { cutoff: at('2026-10-25T09:30:00Z') })).toEqual([]);
    expect(join([], items(read), { cutoff: at('2026-10-25T08:30:00Z') })).toHaveLength(1);
  });

  it('an event takes the account’s name from the answer, then from the accounts read, then from a line', () => {
    const aliases = new Map([['in_01EXAMPLE0000000000000000', 'example/gmail']]);
    expect(join([event({ eventId: 'a', accountAlias: 'named/gmail' })], items(), { aliases })[0]?.accountAlias).toBe(
      'named/gmail',
    );
    expect(join([event({ eventId: 'a' })], items(), { aliases })[0]?.accountAlias).toBe('example/gmail');
    const read = line('m1', 'gmail.message.read', '2026-10-25T10:01:00Z', {
      account: { id: 'in_01EXAMPLE0000000000000000', alias: 'from/line' },
    });
    expect(join([event({ eventId: 'a' })], items(read))[0]?.accountAlias).toBe('from/line');
    expect(join([event({ eventId: 'a' })], items())[0]?.accountAlias).toBeNull();
  });
});
