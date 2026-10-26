import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { COPY } from '../copy.ts';
import type { Call, Installation } from '../ipc.ts';
import { MESSAGES_COPY, MESSAGES_LIMIT, MESSAGES_WINDOW_MS } from '../screens/Messages.tsx';
import { createFakeBridge, EXAMPLE_INSTALLATION, type FakeBridge, type Fixture, failed } from './fake-bridge.ts';
import activityItems from './fixtures/activity-items.json';
import messageShow from './fixtures/message-show.json';
import messagesList from './fixtures/messages-list.json';
import { renderApp } from './render.tsx';

/*
 * The Messages screen (spec 2026-10-26-owner-feedback-0320 §3.6, prototype row 4): each message that came in, with
 * how far it got, from the event service's `messages list` and core's `activity items` joined in the app. Against the
 * fake bridge and fixtures written to the spec's shapes: nothing runs, and nothing reaches a CLI, Gmail or Slack.
 */

/** A screen that reads under a loaded machine: each test is given room. */
const SLOW = { timeout: 30_000 };

const main = (): HTMLElement => screen.getByRole('main');

/** Every product at `version`: core's, and each `--version`. */
const at = (version: string): Installation => ({ ...EXAMPLE_INSTALLATION, version });

const MESSAGES_FIXTURES: Partial<Record<Call['kind'], Fixture>> = {
  eventsMessagesList: messagesList,
  eventsMessageShow: messageShow,
  activityItems,
  approvalsFinished: [],
};

/**
 * A bridge with core and the events service at `version` (0.32.0 by default, the first with Messages), answering from
 * the Messages fixtures over `fixtures`, with any command replaced by `handlers`.
 */
function bridgeAt(
  version = '0.32.0',
  fixtures: Partial<Record<Call['kind'], Fixture>> = {},
  handlers: Parameters<typeof createFakeBridge>[0] = {},
): FakeBridge {
  return createFakeBridge(
    { installation: async () => at(version), ...handlers },
    { ...MESSAGES_FIXTURES, version, ...fixtures },
  );
}

const MESSAGE_KINDS: readonly string[] = ['eventsMessagesList', 'eventsMessageShow', 'activityItems'];

/** Every Messages call made, in order. */
const messageCalls = (bridge: FakeBridge): Call[] =>
  bridge.calls
    .filter((call) => call.command === 'cli')
    .map((call) => call.args as Call)
    .filter((call) => MESSAGE_KINDS.includes(call.kind));

/** The cards shown, once there are any. */
async function cards(): Promise<HTMLElement[]> {
  await waitFor(() => expect(main().querySelector('li[data-message]')).not.toBeNull());
  return Array.from(main().querySelectorAll<HTMLElement>('li[data-message]'));
}

function card(key: string): HTMLElement {
  const found = main().querySelector<HTMLElement>(`li[data-message^="${key}"]`);
  if (found === null) throw new Error(`no card for ${key}`);
  return found;
}

/** The Messages screen, opened, once its cards are there. */
async function opened(bridge: FakeBridge): Promise<HTMLElement[]> {
  renderApp(bridge, { screen: 'messages' });
  await screen.findByRole('heading', { level: 1, name: 'Messages' });
  return cards();
}

/** Chooses `option` in the select named `name`, as a pointer does. */
async function choose(name: string, option: string): Promise<void> {
  fireEvent.click(within(main()).getByRole('combobox', { name }));
  const item = await screen.findByRole('option', { name: option });
  fireEvent.pointerMove(item);
  fireEvent.mouseMove(item);
  fireEvent.click(item);
  await waitFor(() => expect(within(main()).getByRole('combobox', { name }).textContent).toContain(option));
}

const keys = (list: HTMLElement[]) => list.map((each) => each.dataset.message?.slice(0, 8));

describe('Messages', () => {
  it(
    'sits after Queue with a New tag, and an older core gets the update line and none of its calls',
    SLOW,
    async () => {
      const bridge = bridgeAt('0.31.0');
      renderApp(bridge);
      const navigation = await screen.findByRole('navigation', { name: 'Sections' });
      const labels = Array.from(navigation.querySelectorAll('[data-slot="sidebar-item-label"]')).map(
        (label) => label.textContent,
      );
      expect(labels.slice(0, 3)).toEqual(['Overview', 'Queue', 'Messages']);
      const entry = within(navigation).getByRole('button', { name: /^Messages/ });
      expect(entry.querySelector('[data-slot="section-new"]')?.textContent?.trim()).toBe('New');
      expect(entry.textContent).toBe('Messages New');
      fireEvent.click(entry);
      expect(await screen.findByRole('heading', { level: 1, name: 'Messages' })).toBeTruthy();
      expect(entry.getAttribute('aria-current')).toBe('page');
      expect(await within(main()).findByText(COPY.updateToUse)).toBeTruthy();
      expect(within(main()).getByText('Needs 0.32.0 or later; this machine has 0.31.0.')).toBeTruthy();
      expect(messageCalls(bridge)).toEqual([]);
    },
  );

  it('reads the event service’s messages and core’s activity for the same 30 days', SLOW, async () => {
    const bridge = bridgeAt();
    const before = Date.now();
    await opened(bridge);
    const calls = messageCalls(bridge);
    expect(calls.map((call) => call.kind)).toEqual(['eventsMessagesList', 'activityItems']);
    const [list, activity] = calls as [
      Extract<Call, { kind: 'eventsMessagesList' }>,
      Extract<Call, { kind: 'activityItems' }>,
    ];
    expect(list).toEqual({ kind: 'eventsMessagesList', since: activity.since, limit: MESSAGES_LIMIT });
    expect(activity).toEqual({ kind: 'activityItems', since: list.since });
    expect(list.since).toBeGreaterThanOrEqual(before - MESSAGES_WINDOW_MS);
    expect(list.since).toBeLessThanOrEqual(Date.now() - MESSAGES_WINDOW_MS);
    expect(MESSAGES_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
    // Read again asks both once more.
    fireEvent.click(within(main()).getByRole('button', { name: MESSAGES_COPY.refresh }));
    await waitFor(() => expect(messageCalls(bridge)).toHaveLength(4));
  });

  it(
    'each message newest first, with its channel and account, its status, its sender as outside text and its steps',
    SLOW,
    async () => {
      const shown = await opened(bridgeAt());
      expect(keys(shown)).toEqual(['event:e1', 'event:e2', 'item:18c', 'event:e4', 'event:e5', 'event:e6', 'event:e3']);
      expect(shown.map((each) => each.dataset.status)).toEqual([
        'replied',
        'acknowledged',
        'read',
        'not-seen',
        'replied',
        'not-seen',
        'waiting',
      ]);
      const invoice = card('event:e1');
      expect(within(invoice).getByText('Gmail · example/gmail')).toBeTruthy();
      expect(invoice.querySelector('[data-slot="message-status"]')?.textContent).toBe('Replied');
      // Who it is from and what it is about are the sender's: each in a From outside box, as text.
      const boxes = Array.from(invoice.querySelectorAll('[data-slot="from-outside"]')).map((box) => box.textContent);
      expect(boxes).toEqual([
        'From outside: David Example',
        'From outside: david@example.com',
        'From outside: Can you send the March invoice?',
      ]);
      expect(within(invoice).getByText(COPY.fromOutside)).toBeTruthy();
      const steps = Array.from(invoice.querySelectorAll('[data-slot="message-step"]')).map((step) => step.textContent);
      expect(steps.slice(0, 3)).toEqual(['Rule invoices', 'Jev: yes', 'Queue, lane billing']);
      expect(steps).toContain('Marked done by the agent');
      expect(steps.some((step) => /^Reply sent .+, after your approval$/.test(step ?? ''))).toBe(true);
      // A Slack direct message says so; an account with no name the app read shows its id.
      expect(within(card('event:e2')).getByText('Slack · example/slack · direct message')).toBeTruthy();
      expect(within(card('event:e3')).getByText('WhatsApp · wa_01EXAMPLE0000000000000001')).toBeTruthy();
      // Nothing kept its sender: what it is, and where to see it, with no From outside mark.
      const unseen = card('event:e4');
      expect(
        within(unseen).getByText('A Gmail message. No rule kept its sender or subject, so open it in Gmail to see it.'),
      ).toBeTruthy();
      expect(unseen.querySelector('[data-slot="from-outside"]')).toBeNull();
      expect(within(unseen).queryByText(COPY.fromOutside)).toBeNull();
      // A sender's markup is text: nothing of it is read as markup.
      expect(within(card('event:e5')).getByText('<img src=x onerror=alert(1)> Is the deploy done?')).toBeTruthy();
      expect(main().querySelector('img')).toBeNull();
      // What the screen shows, and what it cannot.
      expect(within(main()).getByText(MESSAGES_COPY.footnote)).toBeTruthy();
    },
  );

  it(
    'the filters: all, waiting for you, handled by an agent, no agent has seen, each with its count; and the account',
    SLOW,
    async () => {
      await opened(bridgeAt());
      const show = within(main()).getByRole('group', { name: MESSAGES_COPY.show });
      expect(
        within(show)
          .getAllByRole('button')
          .map((button) => [button.textContent, button.getAttribute('aria-pressed')]),
      ).toEqual([
        ['All', 'true'],
        ['Waiting for you 1', 'false'],
        ['Handled by an agent 4', 'false'],
        ['No agent has seen 3', 'false'],
      ]);
      fireEvent.click(within(show).getByRole('button', { name: /^Waiting for you/ }));
      await waitFor(async () => expect(keys(await cards())).toEqual(['event:e3']));
      fireEvent.click(within(show).getByRole('button', { name: /^Handled by an agent/ }));
      await waitFor(async () => expect(keys(await cards())).toEqual(['event:e1', 'event:e2', 'item:18c', 'event:e5']));
      fireEvent.click(within(show).getByRole('button', { name: /^No agent has seen/ }));
      await waitFor(async () => expect(keys(await cards())).toEqual(['event:e4', 'event:e6', 'event:e3']));
      fireEvent.click(within(show).getByRole('button', { name: /^All/ }));
      await choose(MESSAGES_COPY.account, 'example/slack');
      await waitFor(async () => expect(keys(await cards())).toEqual(['event:e2', 'event:e5']));
      expect(within(show).getByRole('button', { name: /^Waiting for you/ }).textContent).toBe('Waiting for you 0');
      // Nothing waits in that account: the view says so.
      fireEvent.click(within(show).getByRole('button', { name: /^Waiting for you/ }));
      expect(await within(main()).findByText(MESSAGES_COPY.noMatch)).toBeTruthy();
    },
  );

  it('older events page by the cursor, and a message only an agent read waits for its page', SLOW, async () => {
    const [first, ...rest] = messagesList.messages;
    // The event service's cursor: where the page ended, `<observedAt ms>:<eventId>`.
    const cursor = '1792928402000:e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1e1';
    const bridge = bridgeAt('0.32.0', {
      eventsMessagesList: (call: Call) =>
        (call as Extract<Call, { kind: 'eventsMessagesList' }>).before === undefined
          ? { messages: [first], next: cursor }
          : { messages: rest, next: null },
    });
    const shown = await opened(bridge);
    // Only the first page's event: the agent-only receipt (10:55) is older than its last event (11:40), so it waits.
    expect(keys(shown)).toEqual(['event:e1']);
    expect(within(main()).getByText(MESSAGES_COPY.moreOlder)).toBeTruthy();
    fireEvent.click(within(main()).getByRole('button', { name: MESSAGES_COPY.older }));
    await waitFor(async () => expect(keys(await cards())).toHaveLength(7));
    const lists = messageCalls(bridge).filter((call) => call.kind === 'eventsMessagesList');
    expect(lists).toHaveLength(2);
    expect(lists[1]).toEqual({ ...lists[0], before: cursor });
    expect(within(main()).queryByRole('button', { name: MESSAGES_COPY.older })).toBeNull();
  });

  it('with no event service, only what an agent read is shown, and the screen says why', SLOW, async () => {
    const bridge = bridgeAt(
      '0.32.0',
      {},
      {
        installation: async () => ({ ...at('0.32.0'), present: ['core', 'gmail', 'slack'] }),
      },
    );
    const shown = await opened(bridge);
    expect(within(main()).getByText(MESSAGES_COPY.noEventService)).toBeTruthy();
    expect(messageCalls(bridge).map((call) => call.kind)).toEqual(['activityItems']);
    expect(shown.every((each) => each.dataset.message?.startsWith('item:'))).toBe(true);
    expect(shown.map((each) => each.dataset.message)).toContain('item:18c2f0a1b2c3e000');
  });

  it('an event service older than 0.32.0 is not asked, and the screen says to update it', SLOW, async () => {
    const bridge = bridgeAt('0.32.0', {
      version: (call: Call) =>
        (call as Extract<Call, { kind: 'version' }>).product === 'events-daemon' ? '0.31.0' : '0.32.0',
    });
    await opened(bridge);
    expect(within(main()).getByText(MESSAGES_COPY.olderEventService)).toBeTruthy();
    expect(messageCalls(bridge).map((call) => call.kind)).toEqual(['activityItems']);
  });

  it('a read that fails says what went wrong, and shows no list half-joined', SLOW, async () => {
    const bridge = bridgeAt(
      '0.32.0',
      {},
      {
        cli: async (call) =>
          call.kind === 'eventsMessagesList'
            ? failed('EVENTS_NOT_RUNNING', 'The event service is not running.')
            : createFakeBridge({}, { ...MESSAGES_FIXTURES, version: '0.32.0' }).cli(call),
      },
    );
    renderApp(bridge, { screen: 'messages' });
    await screen.findByRole('heading', { level: 1, name: 'Messages' });
    expect(await within(main()).findByText('The event service is not running.')).toBeTruthy();
    expect(main().querySelector('li[data-message]')).toBeNull();
  });
});
