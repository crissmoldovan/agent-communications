// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { eyesLine } from '../messages/eyes.ts';
import {
  filterMessages,
  isHandedBack,
  type JoinedMessage,
  join,
  notTakenOf,
  showCounts,
  TAKING_SHOWS,
  takeContext,
} from '../messages/join.ts';
import {
  type ActivityItems,
  type MessageEvent,
  readTakesList,
  readTaking,
  type TakeView,
  type TakingSettingView,
} from '../messages/read.ts';
import {
  cardSteps,
  type Part,
  type StoryContext,
  statusLabel,
  storySummary,
  timeline,
  whoHasIt,
  windowsOf,
} from '../messages/story.ts';
import takesList from './fixtures/takes-list.json';
import taking from './fixtures/taking.json';

/*
 * Taking messages in the app (design 2026-10-26-taking-messages §9): core's `takes list` and `taking`, read; each take's
 * lines as a message's steps; the statuses Taken, Handed back and Nobody took it in their order; the two filters; and
 * the words of a card, a story and Who has it. Pure, over fixtures written to core's shapes and events built by hand.
 * Times are written as UTC hours and minutes so the words are the same on every machine.
 */

const at = (iso: string) => Date.parse(iso);
const CONTEXT: StoryContext = { time: (when) => new Date(when).toISOString().slice(11, 16), home: '/example/home' };
const GMAIL = 'in_01EXAMPLE0000000000000000';
const SLACK = 'acc_01EXAMPLE000000000000001';
const ALIASES = new Map([
  [GMAIL, 'example/gmail'],
  [SLACK, 'example/slack'],
]);
const NO_ACTIVITY: ActivityItems = new Map();

const read = readTakesList(takesList);
const settings = readTaking(taking);
if (read === null || settings === null) throw new Error('the fixtures are answers');

/** An event, as `messages list` gives one: a rule matched it and put it in a lane. */
function event(over: Partial<MessageEvent> & { eventId: string }): MessageEvent {
  return {
    openable: true,
    type: 'gmail.message.received',
    channel: 'gmail',
    accountId: GMAIL,
    accountAlias: null,
    occurredAt: at('2026-10-25T10:00:00Z'),
    observedAt: at('2026-10-25T10:00:01Z'),
    source: { messageId: '18c2f0a1b2c3d400', channelId: null, ts: null },
    sourceId: '18c2f0a1b2c3d400',
    decisions: [{ ruleId: 'invoices', ruleVersion: 1, outcome: 'matched', judge: null, at: null }],
    deliveries: [
      { deliveryId: 'd1', targetKind: 'queue', targetId: 'billing-q', lane: 'billing', state: 'delivered', at: null },
    ],
    queueItem: null,
    kept: null,
    ...over,
  };
}

/** A take record by hand, over the fixture's first, with only what a test says. */
function take(over: Partial<TakeView>): TakeView {
  return { ...(read?.takes[0] as TakeView), history: [], offer: null, ...over };
}

const SETTING = settings.accounts.find((each) => each.account === 'example/gmail') as TakingSettingView;

function joined(events: MessageEvent[], takes: TakeView[], now: string, list = settings?.accounts ?? []) {
  return join(events, NO_ACTIVITY, { aliases: ALIASES, takes: takeContext(takes, list, at(now)) });
}

function only(messages: JoinedMessage[], key: string): JoinedMessage {
  const found = messages.find((each) => each.key.startsWith(key));
  if (found === undefined) throw new Error(`no ${key} in ${messages.map((each) => each.key).join(', ')}`);
  return found;
}

/** Parts as one line, an agent's or a rule author's text in ⟨⟩ so a test sees which parts are whose. */
const said = (parts: readonly Part[] | null) =>
  (parts ?? []).map((part) => ('untrusted' in part ? `⟨${part.untrusted}⟩` : part.text)).join('');

describe('reading core’s takes and settings', () => {
  it('takes list: each record by its message key, its holder’s folder and client, its lines oldest first', () => {
    expect(read.takes.map((each) => [each.key, each.state])).toEqual([
      [`gmail:${GMAIL}:18c2f0a1b2c3d4e5`, 'done'],
      [`slack:${SLACK}:D0EXAMPLE1/1792927860.000100`, 'taken'],
      [`gmail:${GMAIL}:18c2f0a1b2c3d400`, 'open'],
      [`slack:${SLACK}:C0EXAMPLE9/1792930000.000100`, 'taken'],
    ]);
    const first = read.takes[0] as TakeView;
    expect(first.holder).toEqual({
      key: '3f9a1c2e7b4d5a60',
      sessionId: '0f8b6c2e-4d1a-4b7e-9c3f-2a5d8e1f6b70',
      folder: '/example/home/work/acme',
      client: { name: 'claude-code', version: '2.1.0' },
    });
    expect(first.account).toBe('example/gmail');
    // A note stays enveloped, as core wrote it: the screen shows it only through UntrustedText.
    expect(first.history[1]?.note).toMatch(/^<untrusted-content boundary="tk0001" field="take-note">\n/);
    expect(read.takes[3]?.holder).toBe('person');
    expect(read.takes[3]?.history[0]?.terminal).toEqual({ folder: '/', ancestors: ['agentcomms-desktop', 'launchd'] });
    // A record without a message, a state or an account is left out, not guessed at.
    expect(
      readTakesList({ takes: [{ state: 'taken' }, { message: { channel: 'whatsapp', accountId: 'a', id: 'b' } }] }),
    ).toEqual({ takes: [], unreadable: 0 });
    expect(readTakesList({ nope: [] })).toBeNull();
  });

  it('taking: each account’s settings; a value it cannot read counts as the stricter one', () => {
    expect(settings.accounts.map((each) => [each.account, each.required, each.acknowledge])).toEqual([
      ['example/gmail', true, 'nothing'],
      ['example/resend', false, 'nothing'],
      ['example/slack', true, 'eyes'],
    ]);
    expect(readTaking({ accounts: [{ account: 'x/slack', channel: 'slack', required: 'maybe' }] })?.accounts).toEqual([
      {
        account: 'x/slack',
        channel: 'slack',
        required: true,
        acknowledge: 'nothing',
        unclaimed: { afterMinutes: 5, notify: true },
        stored: false,
      },
    ]);
  });
});

describe('a message’s take, joined', () => {
  const messages = joined(
    [
      event({ eventId: 'e4', type: 'gmail.message.received' }),
      event({
        eventId: 'e2',
        type: 'slack.message.posted',
        channel: 'slack',
        accountId: SLACK,
        source: { messageId: null, channelId: 'D0EXAMPLE1', ts: '1792927860.000100' },
        sourceId: 'D0EXAMPLE1/1792927860.000100',
      }),
      event({
        eventId: 'e1',
        source: { messageId: '18c2f0a1b2c3d4e5', channelId: null, ts: null },
        sourceId: '18c2f0a1b2c3d4e5',
      }),
    ],
    read.takes,
    '2026-10-25T12:10:00Z',
  );

  it('finds each take by its message key, and lists a message only a take names', () => {
    expect(messages.map((each) => each.key)).toEqual([
      `take:slack:${SLACK}:C0EXAMPLE9/1792930000.000100`,
      'event:e1',
      'event:e2',
      'event:e4',
    ]);
    const kept = only(messages, 'take:');
    expect(kept).toMatchObject({ event: null, channel: 'slack', accountAlias: 'example/slack', sender: null });
    expect(kept.status).toEqual({ kind: 'taken', at: at('2026-10-25T12:07:00Z'), by: 'person', window: null });
    // The person's keep, from this app: its process is among the call's ancestors.
    expect(kept.touches.map((touch) => [touch.kind, touch.actor, touch.take?.from])).toEqual([
      ['kept', 'person', 'app'],
    ]);
  });

  it('Taken by an agent, with the 👀 it posted; done by its holder is Done by an agent', () => {
    const slack = only(messages, 'event:e2');
    expect(slack.status).toMatchObject({ kind: 'taken', by: 'window' });
    expect(statusLabel(slack.status)).toEqual({ label: 'Taken by an agent', tone: 'accent' });
    expect(slack.touches.map((touch) => [touch.kind, touch.take?.eyes])).toEqual([['taken', true]]);
    expect(cardSteps(slack, CONTEXT).map(said)).toEqual([
      'Workflow ⟨invoices⟩',
      'Queue, lane billing',
      'Taken by the agent in ~/work/acme (👀)',
    ]);
    const done = only(messages, 'event:e1');
    expect(done.status).toEqual({ kind: 'done', at: at('2026-10-25T11:46:00Z'), actor: 'window' });
    expect(statusLabel(done.status)).toEqual({ label: 'Done by an agent', tone: 'ok' });
  });

  it('Handed back, by two sessions: their reasons, the note through the agent’s words, and who has it now', () => {
    const back = only(messages, 'event:e4');
    expect(back.status).toEqual({
      kind: 'handed-back',
      at: at('2026-10-25T10:31:00Z'),
      reason: 'needs-the-person',
      sessions: 2,
    });
    expect(isHandedBack(back.take)).toBe(true);
    expect(statusLabel(back.status)).toEqual({ label: 'Handed back', tone: 'warn' });
    expect(storySummary(back, CONTEXT)).toBe('Two sessions handed it back; nobody has it.');
    expect(cardSteps(back, CONTEXT).map(said)).toEqual([
      'Workflow ⟨invoices⟩',
      'Queue, lane billing',
      'Taken by the agent in ~/work/billing',
      'Handed back: not mine',
      'Taken by the agent in ~/work/docs',
      'Handed back: it needs you',
      'Nobody took it',
    ]);
    // The timeline names each window by its folder and client — the person's view — and the note is the agent's.
    const lines = timeline(back, CONTEXT).map((entry) => [said(entry.what), said(entry.sub)]);
    expect(lines).toContainEqual([
      'The agent in ~/work/billing handed it back: not mine',
      `~/work/billing · codex · ⟨${read.takes[2]?.history[1]?.note}⟩`,
    ]);
    expect(lines).toContainEqual([
      'The agent in ~/work/docs took it',
      '~/work/docs · claude-code 2.1.0 · From then on only this session may act on it',
    ]);
    // A hand-back that needs the person counts as not taken at once.
    expect(back.notTaken).toEqual({
      since: at('2026-10-25T10:31:00Z'),
      due: at('2026-10-25T10:31:00Z'),
      why: 'needs-the-person',
    });
    expect(lines).toContainEqual(['Nobody took it', 'A session handed it back saying it needs you']);
    expect(windowsOf(back, CONTEXT).map((window) => [window.folder, window.line])).toEqual([
      ['~/work/billing', 'codex · took it, handed it back: not mine'],
      ['~/work/docs', 'claude-code 2.1.0 · took it, handed it back: it needs you'],
    ]);
    expect(whoHasIt(back, CONTEXT)).toEqual({
      state: 'nobody',
      title: 'Nobody has it',
      line: 'A session handed it back: it needs you. Any session may take it again, or you can give it to one.',
    });
  });

  it('the filters: Nobody took it and Handed back, counted with the four', () => {
    expect(TAKING_SHOWS).toEqual(['all', 'waiting', 'handled', 'unseen', 'not-taken', 'handed-back']);
    expect(filterMessages(messages, { show: 'handed-back', account: null }).map((each) => each.key)).toEqual([
      'event:e4',
    ]);
    expect(filterMessages(messages, { show: 'not-taken', account: null }).map((each) => each.key)).toEqual([
      'event:e4',
    ]);
    expect(showCounts(messages, 'example/gmail')).toMatchObject({ all: 2, 'not-taken': 1, 'handed-back': 1 });
  });

  it('who has it, and the story’s summary, while an agent window holds it', () => {
    const slack = only(messages, 'event:e2');
    expect(whoHasIt(slack, CONTEXT)).toEqual({
      state: 'window',
      title: 'The agent in ~/work/acme has it',
      line: 'Since 11:31 · claude-code 2.1.0 · Only this session may act on it. Its take runs out at 12:31 unless it acts on it again',
    });
    expect(storySummary(slack, CONTEXT)).toBe('The agent in ~/work/acme has it since 11:31.');
    expect(windowsOf(slack, CONTEXT).map((window) => window.line)).toEqual(['claude-code 2.1.0 · took it']);
  });
});

describe('the status order, with takes', () => {
  it('a reply beats a take, a take beats a read, a read beats nobody took it', () => {
    const taken = take({ state: 'taken', holder: read.takes[0]?.holder ?? null, takenAt: at('2026-10-25T10:05:00Z') });
    const [message] = joined(
      [event({ eventId: 'a' })],
      [{ ...taken, key: `gmail:${GMAIL}:18c2f0a1b2c3d400` }],
      '2026-10-25T11:00:00Z',
    );
    expect(message?.status.kind).toBe('taken');
    const lines: ActivityItems = new Map([
      [
        '18c2f0a1b2c3d400',
        [
          {
            itemId: '18c2f0a1b2c3d400',
            session: { key: '3f9a1c2e7b4d5a60', folder: null, client: null },
            operation: 'gmail.message.read',
            channel: 'gmail',
            at: at('2026-10-25T10:20:00Z'),
            outcome: 'ok',
            kind: 'read',
            subject: null,
            from: null,
            replyTo: null,
            thread: null,
            draftId: null,
            threadId: null,
            channelId: null,
            act: null,
            account: null,
          },
        ],
      ],
    ]);
    // Read by an agent, and nobody took it within 15 minutes: Read comes first, and the filter still finds it.
    const [readOnly] = join([event({ eventId: 'b' })], lines, {
      aliases: ALIASES,
      takes: takeContext([], settings.accounts, at('2026-10-25T10:30:00Z')),
    });
    expect(readOnly?.status.kind).toBe('read');
    expect(readOnly?.notTaken?.why).toBe('waited');
    // Nobody read it, and nobody took it: Nobody took it.
    const [unread] = joined([event({ eventId: 'c' })], [], '2026-10-25T10:30:00Z');
    expect(unread?.status).toEqual({ kind: 'not-taken', since: at('2026-10-25T10:00:00Z') });
    expect(statusLabel({ kind: 'not-taken', since: 0 })).toEqual({ label: 'Nobody took it', tone: 'warn' });
    expect(storySummary(unread as JoinedMessage, CONTEXT)).toBe('Nobody took it. It has waited since 10:00.');
  });
});

describe('nobody took it (§8)', () => {
  const arrived = event({ eventId: 'n' });
  const now = (iso: string) => at(iso);

  it('counts once the account’s window has passed, only where taking is required', () => {
    expect(notTakenOf(arrived, null, SETTING, now('2026-10-25T10:14:59Z'))).toBeNull();
    expect(notTakenOf(arrived, null, SETTING, now('2026-10-25T10:15:00Z'))).toEqual({
      since: at('2026-10-25T10:00:00Z'),
      due: at('2026-10-25T10:15:00Z'),
      why: 'waited',
    });
    expect(notTakenOf(arrived, null, { ...SETTING, required: false }, now('2026-10-25T12:00:00Z'))).toBeNull();
    expect(notTakenOf(arrived, null, undefined, now('2026-10-25T12:00:00Z'))).toBeNull();
  });

  it('only for a message that came in and a rule delivered to a lane, a session or the Queue', () => {
    const late = now('2026-10-25T12:00:00Z');
    expect(notTakenOf({ ...arrived, type: 'gmail.message.sent' }, null, SETTING, late)).toBeNull();
    expect(notTakenOf({ ...arrived, decisions: [] }, null, SETTING, late)).toBeNull();
    const delivery = arrived.deliveries[0] as MessageEvent['deliveries'][number];
    expect(
      notTakenOf({ ...arrived, deliveries: [{ ...delivery, targetKind: 'dry-run' }] }, null, SETTING, late),
    ).toBeNull();
    expect(
      notTakenOf({ ...arrived, deliveries: [{ ...delivery, state: 'dead-lettered' }] }, null, SETTING, late),
    ).toBeNull();
    expect(
      notTakenOf({ ...arrived, deliveries: [{ ...delivery, targetKind: 'session' }] }, null, SETTING, late),
    ).not.toBeNull();
  });

  it('a take, a done or a live offer stops it; a hand-back, a take back or a lapse starts the clock again', () => {
    const late = now('2026-10-25T12:00:00Z');
    expect(notTakenOf(arrived, take({ state: 'taken' }), SETTING, late)).toBeNull();
    expect(notTakenOf(arrived, take({ state: 'done' }), SETTING, late)).toBeNull();
    const window = { key: '3f9a1c2e7b4d5a60', sessionId: null, folder: null, client: null };
    const offer = { to: window, until: at('2026-10-25T12:10:00Z'), rule: null, byPerson: true };
    expect(notTakenOf(arrived, take({ state: 'offered', offer }), SETTING, late)).toBeNull();
    // An offer that ran out: the window counts from when it did.
    const lapsed = take({ state: 'offered', offer: { ...offer, until: at('2026-10-25T11:50:00Z') } });
    expect(notTakenOf(arrived, lapsed, SETTING, late)).toBeNull();
    expect(notTakenOf(arrived, lapsed, SETTING, now('2026-10-25T12:05:00Z'))?.since).toBe(at('2026-10-25T11:50:00Z'));
    const released = take({
      state: 'open',
      history: [
        {
          at: at('2026-10-25T11:50:00Z'),
          kind: 'released',
          by: 'person',
          window: null,
          terminal: null,
          reason: null,
          note: null,
          ack: null,
        },
      ],
    });
    expect(notTakenOf(arrived, released, SETTING, late)).toBeNull();
    expect(notTakenOf(arrived, released, SETTING, now('2026-10-25T12:05:00Z'))).toMatchObject({
      since: at('2026-10-25T11:50:00Z'),
      why: 'waited',
    });
  });
});

describe('a lane offer its window is never woken for (security review of 0.35.0, M5)', () => {
  const arrived = event({ eventId: 'w' });
  const window = { key: '3f9a1c2e7b4d5a60', sessionId: null, folder: null, client: null };
  const offeredLine = {
    at: at('2026-10-25T10:00:00Z'),
    kind: 'offered' as const,
    by: 'service' as const,
    window,
    terminal: null,
    reason: null,
    note: null,
    ack: null,
  };

  it('lapses at the account’s window after it was made, and the message counts as not taken from then', () => {
    // It waited for its window with no end time, and stopped Not taken for as long as the queue kept its item.
    const waiting = take({
      state: 'offered',
      offer: { to: window, until: null, rule: 'david-by-mail', byPerson: false },
      history: [offeredLine],
    });
    expect(notTakenOf(arrived, waiting, SETTING, at('2026-10-25T10:14:59Z'))).toBeNull();
    expect(notTakenOf(arrived, waiting, SETTING, at('2026-10-25T10:15:00Z'))).toEqual({
      since: at('2026-10-25T10:00:00Z'),
      due: at('2026-10-25T10:15:00Z'),
      why: 'waited',
    });
  });

  it('written down as lapsed, it counts from when it was offered, not from when it ran out', () => {
    const lapsed = take({
      state: 'open',
      history: [offeredLine, { ...offeredLine, at: at('2026-10-25T10:15:00Z'), kind: 'expired' }],
    });
    expect(notTakenOf(arrived, lapsed, SETTING, at('2026-10-25T10:15:00Z'))).toEqual({
      since: at('2026-10-25T10:00:00Z'),
      due: at('2026-10-25T10:15:00Z'),
      why: 'waited',
    });
    // A take that lapsed still starts the clock again from its end.
    const taken = { ...offeredLine, at: at('2026-10-25T10:01:00Z'), kind: 'taken' as const, by: 'window' as const };
    const leased = take({
      state: 'open',
      history: [offeredLine, taken, { ...offeredLine, at: at('2026-10-25T11:01:00Z'), kind: 'expired' }],
    });
    expect(notTakenOf(arrived, leased, SETTING, at('2026-10-25T11:15:59Z'))).toBeNull();
    expect(notTakenOf(arrived, leased, SETTING, at('2026-10-25T11:16:00Z'))?.since).toBe(at('2026-10-25T11:01:00Z'));
  });
});

describe('the 👀 on taking names the standing approval it would use', () => {
  const approval = {
    id: 'ap_5S6T7V8W9X0Y1Z2A3B4C5D6E7F',
    workspace: 'example/slack',
    state: 'active' as const,
    contents: [{ kind: 'reaction' as const, text: 'eyes', digest: 'd' }],
    places: { kind: 'exact' as const, places: [{ id: 'C0EXAMPLE1', name: 'general', members: 12 }] },
    limits: { perThread: 1, perHour: 10, perDay: 30, expiresDays: 7 },
    expiresAt: '2026-10-26T09:00:00.000Z',
    usesToday: 0,
  };

  it('the soonest to end, in that workspace, holding a 👀; and that it spends the thread’s one acknowledgement', () => {
    const line = eyesLine(
      [
        { ...approval, id: 'later', expiresAt: '2026-10-30T09:00:00.000Z' },
        approval,
        { ...approval, id: 'other', workspace: 'example/slack-two', expiresAt: '2026-10-25T13:00:00.000Z' },
        { ...approval, id: 'thumbs', contents: [{ kind: 'reaction', text: 'thumbsup', digest: 'e' }] },
      ],
      'example/slack',
    );
    expect(line).toMatch(/^It would use the reply you approved in advance in #general, which ends /);
    expect(line).toContain('a reply approved in advance after it is refused there, unless you allow 2 or more');
    expect(eyesLine([{ ...approval, limits: { ...approval.limits, perThread: 2 } }], 'example/slack')).not.toContain(
      'unless you allow 2',
    );
    expect(eyesLine([{ ...approval, state: 'pending' }], 'example/slack')).toBeNull();
    expect(eyesLine([], 'example/slack')).toBeNull();
  });
});
